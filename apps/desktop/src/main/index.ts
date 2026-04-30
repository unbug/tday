import { app, BrowserWindow, ipcMain, shell, dialog, Menu } from 'electron';
import { join } from 'node:path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { spawn as spawnChild, execFileSync } from 'node:child_process';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  chmodSync,
  createWriteStream,
} from 'node:fs';
import { homedir, arch as osArch } from 'node:os';
import { request as httpsRequest } from 'node:https';

import { PiAdapter } from '@tday/adapter-pi';
import {
  IPC,
  type AgentId,
  type AgentInfo,
  type AgentInstallEvent,
  type AgentInstallSpec,
  type AgentsConfig,
  type ProvidersConfig,
  type SpawnRequest,
} from '@tday/shared';

const TDAY_DIR = join(homedir(), '.tday');

/**
 * Augment process.env.PATH with common locations where Node toolchains live
 * on macOS. When the app is launched from Finder, GUI processes inherit a
 * minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`) that misses Homebrew, nvm,
 * and the npm global prefix — so neither `npm` nor anything `npm i -g`
 * installs is reachable. We fix that here so child_process and node-pty
 * inherit a useful PATH.
 */
function augmentPath(): void {
  const home = homedir();
  const extras: string[] = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    join(home, '.npm-global/bin'),
    join(home, '.local/bin'),
    join(home, '.bun/bin'),
    join(home, '.cargo/bin'),
  ];
  // nvm: pick the highest-numbered installed node
  try {
    const nvmDir = join(home, '.nvm/versions/node');
    if (existsSync(nvmDir)) {
      const versions = readdirSync(nvmDir).sort().reverse();
      if (versions[0]) extras.unshift(join(nvmDir, versions[0], 'bin'));
    }
  } catch {
    // ignore
  }
  // npm global prefix (whichever npm we can find first)
  for (const npmBin of [
    '/opt/homebrew/bin/npm',
    '/usr/local/bin/npm',
    extras.find((p) => existsSync(join(p, 'npm')))
      ? join(extras.find((p) => existsSync(join(p, 'npm')))!, 'npm')
      : '',
  ]) {
    if (npmBin && existsSync(npmBin)) {
      try {
        const prefix = execFileSync(npmBin, ['config', 'get', 'prefix'], {
          encoding: 'utf8',
          timeout: 3_000,
        }).trim();
        if (prefix) extras.push(join(prefix, 'bin'));
      } catch {
        // ignore
      }
      break;
    }
  }

  const current = process.env.PATH ?? '';
  const seen = new Set(current.split(':').filter(Boolean));
  for (const e of extras) if (existsSync(e)) seen.add(e);
  process.env.PATH = Array.from(seen).join(':');
}

const TDAY_BIN = join(homedir(), '.tday', 'bin');

/**
 * Download `fd` (sharkdp/fd) into ~/.tday/bin if it's not already on PATH.
 *
 * Why: pi-coding-agent shells out to `fd` for fast directory listings. When
 * `fd` is missing, recent pi versions try to download it from a URL that
 * sometimes 404s (`fd not found. Downloading...Failed to download fd:
 * Failed to download: 404`), leaving every tab broken. We sidestep that by
 * pre-installing `fd` ourselves from the canonical GitHub release.
 *
 * Idempotent — does nothing on subsequent calls once fd is on PATH or in
 * ~/.tday/bin. Network failures are non-fatal: we proceed to spawn pi
 * without fd; the user can still install fd manually.
 */
async function ensureFd(env: Record<string, string | undefined>): Promise<void> {
  // Already on PATH? bail.
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir && existsSync(join(dir, 'fd'))) return;
  }
  const target = join(TDAY_BIN, 'fd');
  if (existsSync(target)) {
    env.PATH = `${TDAY_BIN}:${env.PATH ?? ''}`;
    return;
  }

  if (process.platform !== 'darwin') {
    // Linux/win32 users almost always have fd via package manager — leave
    // them to it rather than ship arbitrary binaries.
    return;
  }

  const arch = osArch() === 'arm64' ? 'aarch64' : 'x86_64';
  const version = 'v10.2.0';
  const archive = `fd-${version}-${arch}-apple-darwin.tar.gz`;
  const url = `https://github.com/sharkdp/fd/releases/download/${version}/${archive}`;
  const tgz = join(TDAY_BIN, archive);

  try {
    if (!existsSync(TDAY_BIN)) mkdirSync(TDAY_BIN, { recursive: true });
    console.log('[tday] downloading fd:', url);
    await downloadFollowingRedirects(url, tgz);
    // Extract just the fd binary (works without a `tar` flag dance).
    execFileSync('tar', ['-xzf', tgz, '-C', TDAY_BIN, '--strip-components=1'], {
      stdio: 'ignore',
    });
    chmodSync(target, 0o755);
    env.PATH = `${TDAY_BIN}:${env.PATH ?? ''}`;
    console.log('[tday] fd installed at', target);
  } catch (err) {
    console.error('[tday] fd auto-install failed (non-fatal):', err);
  }
}

function downloadFollowingRedirects(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = (u: string, hops: number) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      const req = httpsRequest(u, { method: 'GET' }, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          get(new URL(res.headers.location, u).toString(), hops + 1);
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`download ${u} \u2192 HTTP ${code}`));
          return;
        }
        const out = createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    };
    get(url, 0);
  });
}

/**
 * Auto-install registry. Pi gets a real npm installer; the other harnesses
 * are detected on PATH but installed by the user (each vendor publishes its
 * own installer / Homebrew formula / npm package, and we don't second-guess
 * which one the user wants).
 */
const INSTALL_SPECS: Record<AgentId, AgentInstallSpec | undefined> = {
  pi: {
    agentId: 'pi',
    displayName: 'Pi',
    description: 'badlogic/pi-mono coding agent (npm: @mariozechner/pi-coding-agent)',
    npmPackage: '@mariozechner/pi-coding-agent',
    bin: 'pi',
  },
  'claude-code': {
    agentId: 'claude-code',
    displayName: 'Claude Code',
    description: "Anthropic's official CLI (npm: @anthropic-ai/claude-code)",
    npmPackage: '@anthropic-ai/claude-code',
    bin: 'claude',
  },
  codex: {
    agentId: 'codex',
    displayName: 'Codex CLI',
    description: "OpenAI's coding agent (npm: @openai/codex)",
    npmPackage: '@openai/codex',
    bin: 'codex',
  },
  opencode: {
    agentId: 'opencode',
    displayName: 'OpenCode',
    description: 'sst/opencode terminal agent (npm: opencode-ai)',
    npmPackage: 'opencode-ai',
    bin: 'opencode',
  },
  gemini: {
    agentId: 'gemini',
    displayName: 'Gemini CLI',
    description: "Google's coding agent (npm: @google/gemini-cli)",
    npmPackage: '@google/gemini-cli',
    bin: 'gemini',
  },
  'qwen-code': {
    agentId: 'qwen-code',
    displayName: 'Qwen Code',
    description: "Alibaba's coding agent (npm: @qwen-code/qwen-code)",
    npmPackage: '@qwen-code/qwen-code',
    bin: 'qwen',
  },
  crush: {
    agentId: 'crush',
    displayName: 'Crush',
    description: 'charm.land terminal coding agent (npm: @charmland/crush)',
    npmPackage: '@charmland/crush',
    bin: 'crush',
  },
  hermes: {
    agentId: 'hermes',
    displayName: 'Hermes',
    description: 'Hermes coding agent — install manually and ensure `hermes` is on PATH',
    bin: 'hermes',
  },
};

/**
 * Generic detect: which $bin + try --version with a short timeout. Used for
 * harnesses we don't have a dedicated adapter for yet.
 */
function detectGeneric(bin: string): { available: boolean; version?: string; error?: string } {
  try {
    const path = execFileSync('which', [bin], { encoding: 'utf8' }).trim();
    if (!path) return { available: false };
    let version: string | undefined;
    try {
      version = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 2_000 }).trim();
    } catch {
      // optional
    }
    return { available: true, version };
  } catch {
    return { available: false };
  }
}

/**
 * Map our internal `ProviderKind` to the provider id that opencode uses
 * internally (https://opencode.ai/docs/providers/). For unknown kinds we
 * fall through to a sensible default ("openai-compatible") which routes
 * via the OPENAI_BASE_URL/OPENAI_API_KEY env we already inject.
 */
function opencodeProviderId(kind: string | undefined): string {
  switch (kind) {
    case 'anthropic':
      return 'anthropic';
    case 'google':
      return 'google';
    case 'openrouter':
      return 'openrouter';
    case 'groq':
      return 'groq';
    case 'xai':
      return 'xai';
    case 'mistral':
      return 'mistral';
    case 'deepseek':
      return 'deepseek';
    case 'fireworks':
      return 'fireworks-ai';
    case 'together':
      return 'togetherai';
    case 'cerebras':
      return 'cerebras';
    case 'ollama':
      return 'ollama';
    case 'lmstudio':
      return 'lmstudio';
    case 'openai':
    default:
      return 'openai';
  }
}

/**
 * Per-vendor CLI flag conventions for selecting the model. Without this,
 * Codex CLI and Claude Code each fall back to their own on-disk config
 * (e.g. `~/.codex/config.toml`), so Tday's "Model override" silently has no
 * effect. We project the configured model onto the right command-line flag
 * so the spawned process honours Tday's choice every time.
 *
 * For Codex we also supply `model_provider` + a synthesised
 * `model_providers.tday` entry via repeated `-c` overrides, plus minimal
 * `model_metadata` for the chosen model — without this Codex would default
 * to its built-in OpenAI provider regardless of OPENAI_BASE_URL, and would
 * print "Model metadata for `<id>` not found" warnings for unknown ids.
 *
 * For opencode the model flag must be in `<provider>/<model>` form.
 */
function modelFlagsFor(
  agentId: AgentId,
  model: string | undefined,
  providerKind: string | undefined,
  apiStyle: 'openai' | 'anthropic' | undefined,
  baseUrl: string | undefined,
): string[] {
  if (!model) return [];
  switch (agentId) {
    case 'claude-code':
      // `claude --model <alias|id>`.
      return ['--model', model];
    case 'opencode': {
      // opencode requires `<provider>/<model>`. If the caller already wrote
      // it in slash form (e.g. "openrouter/anthropic/claude-3.5"), trust it.
      const composed = model.includes('/') ? model : `${opencodeProviderId(providerKind)}/${model}`;
      return ['--model', composed];
    }
    case 'gemini':
      return ['--model', model];
    case 'qwen-code':
      return ['--model', model];
    case 'codex': {
      const args: string[] = ['--model', model];
      // codex 0.50+ requires `wire_api = "responses"`; the legacy
      // `"chat"` value is rejected at config-load time:
      //   https://github.com/openai/codex/discussions/7782
      // We therefore *always* synthesise a Responses-API provider entry.
      // If the user binds a chat-only vendor (DeepSeek, Moonshot, Groq…)
      // codex will surface a clear 404 from the upstream endpoint — the
      // fix on the user's side is to pick a Responses-capable provider
      // (OpenAI, OpenRouter, LM Studio ≥ 0.3, Anthropic-dialect, …).
      const envKey = providerKind ? envKeyForKind(providerKind, apiStyle) : 'OPENAI_API_KEY';
      args.push('-c', 'model_provider="tday"');
      args.push('-c', 'model_providers.tday.name="Tday"');
      if (baseUrl) {
        args.push('-c', `model_providers.tday.base_url="${baseUrl}"`);
      }
      args.push('-c', `model_providers.tday.env_key="${envKey}"`);
      args.push('-c', 'model_providers.tday.wire_api="responses"');
      args.push('-c', 'model_providers.tday.requires_openai_auth=false');
      // Silence the "Model metadata for `<id>` not found" fallback warning.
      const metaKey = `"${model.replace(/"/g, '\\"')}"`;
      args.push('-c', `model_metadata.${metaKey}.context_window=128000`);
      args.push('-c', `model_metadata.${metaKey}.max_output_tokens=8192`);
      return args;
    }
    case 'crush':
    case 'hermes':
    case 'pi':
    default:
      return [];
  }
}

/**
 * Mirror of the env-key choices in `packages/adapters/pi`. Used by Codex's
 * `model_providers.tday.env_key` so codex picks the right key out of the
 * environment we already populated.
 */
function envKeyForKind(kind: string, style: 'openai' | 'anthropic' | undefined): string {
  if (style === 'anthropic') return 'ANTHROPIC_API_KEY';
  switch (kind) {
    case 'deepseek':
      return 'DEEPSEEK_API_KEY';
    case 'google':
      return 'GEMINI_API_KEY';
    case 'xai':
      return 'XAI_API_KEY';
    case 'groq':
      return 'GROQ_API_KEY';
    case 'mistral':
      return 'MISTRAL_API_KEY';
    case 'moonshot':
      return 'MOONSHOT_API_KEY';
    case 'cerebras':
      return 'CEREBRAS_API_KEY';
    case 'together':
      return 'TOGETHER_API_KEY';
    case 'fireworks':
      return 'FIREWORKS_API_KEY';
    case 'zai':
      return 'ZAI_API_KEY';
    case 'qwen':
      return 'DASHSCOPE_API_KEY';
    case 'volcengine':
      return 'ARK_API_KEY';
    case 'minimax':
      return 'MINIMAX_API_KEY';
    case 'stepfun':
      return 'STEPFUN_API_KEY';
    case 'openrouter':
      return 'OPENROUTER_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    default:
      return 'OPENAI_API_KEY';
  }
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    console.error('[tday] failed to read', path, err);
    return fallback;
  }
}

function loadAgents(): AgentsConfig {
  return readJson<AgentsConfig>(join(TDAY_DIR, 'agents.json'), {});
}
function loadProviders(): ProvidersConfig {
  return readJson<ProvidersConfig>(join(TDAY_DIR, 'providers.json'), {
    profiles: [],
  });
}

const ptys = new Map<string, IPty>();

/**
 * Set to `true` once the app is shutting down. node-pty fires `onData`/`onExit`
 * asynchronously after we kill the process, and if the BrowserWindow has
 * already been destroyed the call to `event.sender.send(...)` raises
 * `Object has been destroyed` — which Electron promotes to a fatal main-process
 * uncaught exception dialog. Guarding sends on this flag prevents the dialog.
 */
let shuttingDown = false;

function killAllPtys(): void {
  for (const p of ptys.values()) {
    try {
      p.kill();
    } catch {
      // already dead
    }
  }
  ptys.clear();
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0a0a0f',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });

  win.on('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

function registerIpc(): void {
  ipcMain.handle(IPC.homeDir, () => homedir());

  ipcMain.handle(IPC.pickDir, async (event, defaultPath?: string) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: defaultPath || homedir(),
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle(IPC.agentsList, (): AgentInfo[] => {
    const agents = loadAgents();
    const defaultId = agents.defaultAgentId ?? 'pi';
    const out: AgentInfo[] = [];
    for (const [id, spec] of Object.entries(INSTALL_SPECS) as Array<[
      AgentId,
      AgentInstallSpec | undefined,
    ]>) {
      const settings = agents.agents?.[id] ?? {};
      const bin = settings.bin ?? spec?.bin ?? id;
      const detect = id === 'pi' ? PiAdapter.detect(bin) : detectGeneric(bin);
      out.push({
        id,
        displayName: spec?.displayName ?? id,
        description: spec?.description,
        npmPackage: spec?.npmPackage,
        detect,
        providerId: settings.providerId,
        model: settings.model,
        isDefault: id === defaultId,
      });
    }
    return out;
  });

  ipcMain.handle(IPC.agentsSave, (_e, next: AgentsConfig) => {
    if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
    writeFileSync(
      join(TDAY_DIR, 'agents.json'),
      JSON.stringify(next, null, 2) + '\n',
    );
    return { ok: true };
  });

  ipcMain.handle(IPC.providersList, () => loadProviders());

  ipcMain.handle(IPC.providersSave, (_e, next: ProvidersConfig) => {
    if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
    writeFileSync(
      join(TDAY_DIR, 'providers.json'),
      JSON.stringify(next, null, 2) + '\n',
    );
    return { ok: true };
  });

  ipcMain.handle(IPC.ptySpawn, async (event, req: SpawnRequest) => {
    // If the tab already has a PTY (e.g. user changed cwd → restart),
    // dispose the old one before spawning a fresh one.
    const existing = ptys.get(req.tabId);
    if (existing) {
      try {
        existing.kill();
      } catch {
        // already dead
      }
      ptys.delete(req.tabId);
    }

    const agents = loadAgents();
    const providers = loadProviders();
    const agentConf = agents.agents?.[req.agentId] ?? {};
    // Resolution order: spawn-request override → agent binding → providers.default
    const providerId = req.providerId ?? agentConf.providerId ?? providers.default;
    const provider =
      providers.profiles.find((p) => p.id === providerId) ?? providers.profiles[0];
    // Per-agent model override.
    const effectiveProvider =
      provider && agentConf.model ? { ...provider, model: agentConf.model } : provider;

    // Make sure pi's bundled tools (especially `fd`) won't try to download
    // from a stale URL — see ensureFd() docs.
    const cwd = req.cwd ?? homedir();
    const baseEnv = { ...process.env };
    await ensureFd(baseEnv);

    const spec = INSTALL_SPECS[req.agentId];
    const bin = agentConf.bin ?? spec?.bin ?? req.agentId;

    let cmd: string;
    let args: string[];
    let env: Record<string, string>;
    let launchCwd: string;

    if (req.agentId === 'pi') {
      const launch = PiAdapter.buildLaunch({
        bin: agentConf.bin,
        extraArgs: agentConf.args,
        provider: effectiveProvider,
        cwd,
        env: baseEnv,
      });
      cmd = launch.cmd;
      args = launch.args;
      env = launch.env;
      launchCwd = launch.cwd;
    } else {
      // Generic launch: just exec the binary with extra args; provider env
      // vars are projected through the same conventions as Pi.
      const piLike = PiAdapter.buildLaunch({
        bin,
        extraArgs: agentConf.args,
        provider: effectiveProvider,
        cwd,
        env: baseEnv,
      });
      // Drop pi-specific --provider/--model flags for non-pi harnesses, then
      // re-inject `--model <id>` per-vendor — otherwise tools like Codex CLI
      // and Claude Code silently fall back to whatever's in their own
      // config file (~/.codex/config.toml etc.) and ignore Tday's setting.
      cmd = piLike.cmd;
      const userArgs = (agentConf.args ?? []).slice();
      const modelArgs = modelFlagsFor(
        req.agentId,
        effectiveProvider?.model,
        effectiveProvider?.kind,
        effectiveProvider?.apiStyle,
        effectiveProvider?.baseUrl,
      );
      args = [...modelArgs, ...userArgs];
      env = piLike.env;
      launchCwd = piLike.cwd;
    }

    const pty = spawnPty(cmd, args, {
      name: 'xterm-256color',
      cols: req.cols,
      rows: req.rows,
      cwd: launchCwd,
      env,
    });

    ptys.set(req.tabId, pty);

    pty.onData((data) => {
      // Drop late events arriving after the window or app has gone away.
      if (shuttingDown || event.sender.isDestroyed()) return;
      event.sender.send(IPC.ptyData, { tabId: req.tabId, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      if (!shuttingDown && !event.sender.isDestroyed()) {
        event.sender.send(IPC.ptyExit, {
          tabId: req.tabId,
          exitCode,
          signal: signal ?? null,
        });
      }
      // CRITICAL: only clear the map entry if it still points to *this* PTY.
      // When a tab restarts (cwd commit) the old PTY is killed and a new one
      // is spawned under the same tabId; without this guard the stale onExit
      // would race in and delete the new PTY entry, silently breaking input.
      if (ptys.get(req.tabId) === pty) ptys.delete(req.tabId);
    });

    return { pid: pty.pid };
  });

  ipcMain.handle(IPC.ptyWrite, (_e, tabId: string, data: string) => {
    ptys.get(tabId)?.write(data);
  });
  ipcMain.handle(IPC.ptyResize, (_e, tabId: string, cols: number, rows: number) => {
    try {
      ptys.get(tabId)?.resize(cols, rows);
    } catch {
      // resize can throw if the pty already exited; ignore.
    }
  });
  ipcMain.handle(IPC.ptyKill, (_e, tabId: string) => {
    const p = ptys.get(tabId);
    if (p) {
      try {
        p.kill();
      } catch {
        // already dead
      }
      ptys.delete(tabId);
    }
  });

  ipcMain.handle(IPC.agentInstall, (event, agentId: AgentId) =>
    runNpmGlobal(event, agentId, 'install'),
  );
  ipcMain.handle(IPC.agentUpdate, (event, agentId: AgentId) =>
    runNpmGlobal(event, agentId, 'update'),
  );
  ipcMain.handle(IPC.agentUninstall, (event, agentId: AgentId) =>
    runNpmGlobal(event, agentId, 'uninstall'),
  );
}

type NpmAction = 'install' | 'update' | 'uninstall';

async function runNpmGlobal(
  event: Electron.IpcMainInvokeEvent,
  agentId: AgentId,
  action: NpmAction,
): Promise<{ ok: boolean; exitCode: number | null }> {
  const spec = INSTALL_SPECS[agentId];
  const send = (e: AgentInstallEvent) =>
    !shuttingDown && !event.sender.isDestroyed() && event.sender.send(IPC.agentInstallProgress, e);
  if (!spec || !spec.npmPackage) {
    send({ agentId, kind: 'error', data: `no installer registered for agent "${agentId}"` });
    return { ok: false, exitCode: null };
  }

  // For install we install pinned latest; update forces re-resolve to the
  // latest published version; uninstall removes the global package.
  const npmArgs =
    action === 'uninstall'
      ? ['uninstall', '-g', spec.npmPackage]
      : action === 'update'
        ? ['install', '-g', `${spec.npmPackage}@latest`, '--loglevel=info']
        : ['install', '-g', spec.npmPackage, '--loglevel=info'];

  const stages: Array<{ pct: number; status: string; matchers: RegExp[] }> = [
    { pct: 5, status: 'starting', matchers: [/./] },
    { pct: 15, status: 'resolving', matchers: [/idealtree|resolve|reify/i] },
    { pct: 35, status: 'fetching', matchers: [/fetch|http|tarball|GET\s+200/i] },
    { pct: 60, status: 'extracting', matchers: [/extract|unpack/i] },
    { pct: 80, status: 'linking', matchers: [/link|symlink|bin\s/i] },
    { pct: 92, status: 'finalizing', matchers: [/audit|cleanup|prepare/i] },
  ];
  let stageIdx = 0;
  const advance = (line: string) => {
    while (stageIdx < stages.length - 1) {
      const next = stages[stageIdx + 1];
      if (next.matchers.some((rx) => rx.test(line))) {
        stageIdx += 1;
        send({ agentId, kind: 'progress', percent: next.pct, status: next.status });
      } else {
        break;
      }
    }
  };

  const npmBin = ((): string | null => {
    const candidates = [
      ...((process.env.PATH ?? '').split(':').map((p) => join(p, 'npm'))),
      '/opt/homebrew/bin/npm',
      '/usr/local/bin/npm',
    ];
    for (const c of candidates) if (c && existsSync(c)) return c;
    return null;
  })();

  if (!npmBin) {
    send({
      agentId,
      kind: 'error',
      data: 'npm not found on PATH. Install Node.js (https://nodejs.org) and relaunch Tday.',
    });
    return { ok: false, exitCode: null };
  }

  send({ agentId, kind: 'stdout', data: `[tday] using ${npmBin}\r\n` });
  send({ agentId, kind: 'stdout', data: `[tday] ${action} ${spec.npmPackage}…\r\n` });
  send({ agentId, kind: 'progress', percent: stages[0].pct, status: stages[0].status });

  return await new Promise<{ ok: boolean; exitCode: number | null }>((resolve) => {
    const child = spawnChild(npmBin, npmArgs, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onLine = (kind: 'stdout' | 'stderr', b: Buffer) => {
      const text = b.toString();
      send({ agentId, kind, data: text });
      for (const line of text.split('\n')) advance(line);
    };
    child.stdout?.on('data', (b: Buffer) => onLine('stdout', b));
    child.stderr?.on('data', (b: Buffer) => onLine('stderr', b));
    child.on('error', (err) => {
      send({ agentId, kind: 'error', data: String(err) });
      resolve({ ok: false, exitCode: null });
    });
    child.on('close', (code) => {
      if (code === 0) {
        send({ agentId, kind: 'progress', percent: 100, status: 'done' });
        send({ agentId, kind: 'done', exitCode: 0 });
        resolve({ ok: true, exitCode: 0 });
      } else {
        send({
          agentId,
          kind: 'error',
          data: `npm ${action} exited with code ${code}`,
          exitCode: code,
        });
        resolve({ ok: false, exitCode: code });
      }
    });
  });
}

function installAppMenu(): void {
  const isMac = process.platform === 'darwin';
  const sendShortcut = (channel: 'tab:new' | 'tab:close') => () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    win?.webContents.send(channel);
  };
  const tabMenu: Electron.MenuItemConstructorOptions = {
    label: 'Tab',
    submenu: [
      {
        label: 'New Tab',
        accelerator: 'CommandOrControl+T',
        click: sendShortcut('tab:new'),
      },
      {
        label: 'Close Tab',
        accelerator: 'CommandOrControl+W',
        click: sendShortcut('tab:close'),
      },
    ],
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ] as Electron.MenuItemConstructorOptions[])
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    tabMenu,
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front' }] as Electron.MenuItemConstructorOptions[])
          : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  augmentPath();
  if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
  const agentsPath = join(TDAY_DIR, 'agents.json');
  if (!existsSync(agentsPath)) {
    writeFileSync(
      agentsPath,
      JSON.stringify(
        {
          agents: {
            pi: { bin: 'pi', args: [], providerId: 'deepseek' },
          },
        },
        null,
        2,
      ) + '\n',
    );
  }
  const providersPath = join(TDAY_DIR, 'providers.json');
  if (!existsSync(providersPath)) {
    writeFileSync(
      providersPath,
      JSON.stringify(
        {
          default: 'deepseek',
          profiles: [
            {
              id: 'deepseek',
              label: 'DeepSeek',
              kind: 'deepseek',
              apiStyle: 'openai',
              baseUrl: 'https://api.deepseek.com',
              model: 'deepseek-v4-pro',
              apiKey: '',
            },
            {
              id: 'openai',
              label: 'OpenAI',
              kind: 'openai',
              apiStyle: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              model: 'gpt-5',
              apiKey: '',
            },
            {
              id: 'anthropic',
              label: 'Anthropic',
              kind: 'anthropic',
              apiStyle: 'anthropic',
              baseUrl: 'https://api.anthropic.com',
              model: 'claude-sonnet-4-5',
              apiKey: '',
            },
            {
              id: 'openrouter',
              label: 'OpenRouter',
              kind: 'openrouter',
              apiStyle: 'openai',
              baseUrl: 'https://openrouter.ai/api/v1',
              model: 'anthropic/claude-sonnet-4.5',
              apiKey: '',
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );
  }
  electronApp.setAppUserModelId('com.tday.app');
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w));

  // Install a custom menu so Cmd/Ctrl+T (new tab) and Cmd/Ctrl+W
  // (close tab) are reserved for the renderer instead of being claimed
  // by the default "Close Window"/"New Window" application-menu items.
  installAppMenu();

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  shuttingDown = true;
  killAllPtys();
});

app.on('window-all-closed', () => {
  shuttingDown = true;
  killAllPtys();
  if (process.platform !== 'darwin') app.quit();
});
