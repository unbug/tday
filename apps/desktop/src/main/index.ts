import { app, BrowserWindow, ipcMain, shell, dialog, Menu, powerSaveBlocker } from 'electron';
import { isAbsolute, join } from 'node:path';
import { electronApp, optimizer, is } from '@electron-toolkit/utils';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { spawn as spawnChild, execFileSync, exec as execAsync } from 'node:child_process';
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
  type ProviderProfile,
  type ProvidersConfig,
  type SpawnRequest,
  type UsageRecord,
  type UsageFilter,
} from '@tday/shared';
import { createLocalGatewayManager } from './gateway';
import { discoverLocalServices } from './discovery/index.js';
import { probeBaseUrl } from './discovery/probe.js';
import { appendUsage, loadUsageRecords, computeUsageSummary } from './usage/store.js';
import { SESSION_FILE_AGENTS } from './usage/session-readers/index.js';
import { loadCachedSessionRecords, triggerSessionCacheRefresh } from './usage/session-cache.js';

const TDAY_DIR = join(homedir(), '.tday');
const localGatewayManager = createLocalGatewayManager();

/**
 * Augment process.env.PATH with common locations where Node toolchains live.
 *
 * macOS: GUI apps launched from Finder inherit a minimal PATH that misses
 * Homebrew, nvm, and the npm global prefix.
 * Windows: The Electron process may not inherit the full user PATH if started
 * from an icon shortcut, and npm/node global paths need explicit addition.
 *
 * We fix this so child_process and node-pty inherit a useful PATH.
 */
const PATH_SEP = process.platform === 'win32' ? ';' : ':';

function augmentPath(): void {
  const home = homedir();
  const extras: string[] = [];

  if (process.platform === 'win32') {
    // Windows: add common node/npm/scoop/fnm global locations
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    extras.push(
      join(appData, 'npm'),                          // npm global bin
      join(home, 'scoop', 'shims'),                  // Scoop
      join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
      join(home, '.cargo', 'bin'),                   // Rust/cargo
      join(home, '.bun', 'bin'),                     // Bun
      join(localAppData, 'fnm_multishells'),          // fnm (Node version manager)
      'C:\\Program Files\\nodejs',                   // standard Node.js install
      'C:\\Program Files (x86)\\nodejs',
    );
    // fnm: pick the active node version
    try {
      const fnmDir = join(localAppData, 'fnm', 'node-versions');
      if (existsSync(fnmDir)) {
        const versions = readdirSync(fnmDir).sort().reverse();
        if (versions[0]) extras.unshift(join(fnmDir, versions[0], 'installation'));
      }
    } catch { /* ignore */ }
  } else {
    // macOS / Linux
    extras.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      join(home, '.npm-global', 'bin'),
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.cargo', 'bin'),
    );
    // nvm: pick the highest-numbered installed node
    try {
      const nvmDir = join(home, '.nvm', 'versions', 'node');
      if (existsSync(nvmDir)) {
        const versions = readdirSync(nvmDir).sort().reverse();
        if (versions[0]) extras.unshift(join(nvmDir, versions[0], 'bin'));
      }
    } catch { /* ignore */ }
  }

  // npm global prefix detection (cross-platform)
  const npmCandidates = process.platform === 'win32'
    ? [join('C:\\Program Files\\nodejs', 'npm.cmd'), join(process.env.APPDATA ?? '', 'npm', 'npm.cmd')]
    : ['/opt/homebrew/bin/npm', '/usr/local/bin/npm'];
  for (const npmBin of npmCandidates) {
    if (npmBin && existsSync(npmBin)) {
      try {
        const prefix = execFileSync(npmBin, ['config', 'get', 'prefix'], {
          encoding: 'utf8',
          timeout: 3_000,
        }).trim();
        if (prefix) {
          extras.push(process.platform === 'win32' ? prefix : join(prefix, 'bin'));
        }
      } catch { /* ignore */ }
      break;
    }
  }

  const current = process.env.PATH ?? '';
  const seen = new Set(current.split(PATH_SEP).filter(Boolean));
  for (const e of extras) if (existsSync(e)) seen.add(e);
  process.env.PATH = Array.from(seen).join(PATH_SEP);
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
  // The fd binary name: `fd` on Unix, `fd.exe` on Windows.
  const fdBin = process.platform === 'win32' ? 'fd.exe' : 'fd';
  // Already on PATH? bail.
  for (const dir of (env.PATH ?? '').split(PATH_SEP)) {
    if (dir && existsSync(join(dir, fdBin))) return;
  }
  const target = join(TDAY_BIN, fdBin);
  if (existsSync(target)) {
    env.PATH = `${TDAY_BIN}${PATH_SEP}${env.PATH ?? ''}`;
    return;
  }

  const version = 'v10.2.0';
  let archive: string;
  let url: string;

  if (process.platform === 'darwin') {
    const arch = osArch() === 'arm64' ? 'aarch64' : 'x86_64';
    archive = `fd-${version}-${arch}-apple-darwin.tar.gz`;
    url = `https://github.com/sharkdp/fd/releases/download/${version}/${archive}`;
  } else if (process.platform === 'win32') {
    archive = `fd-${version}-x86_64-pc-windows-msvc.zip`;
    url = `https://github.com/sharkdp/fd/releases/download/${version}/${archive}`;
  } else {
    // Linux users almost always have fd via package manager — leave them to it.
    return;
  }

  const archivePath = join(TDAY_BIN, archive);

  try {
    if (!existsSync(TDAY_BIN)) mkdirSync(TDAY_BIN, { recursive: true });
    console.log('[tday] downloading fd:', url);
    await downloadFollowingRedirects(url, archivePath);
    if (process.platform === 'win32') {
      // Windows: use Node's built-in unzip (available in Node 18+ via child_process + PowerShell)
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${TDAY_BIN}" -Force`,
      ], { stdio: 'ignore', timeout: 30_000 });
    } else {
      // macOS: tar extract
      execFileSync('tar', ['-xzf', archivePath, '-C', TDAY_BIN, '--strip-components=1'], {
        stdio: 'ignore',
      });
      chmodSync(target, 0o755);
    }
    env.PATH = `${TDAY_BIN}${PATH_SEP}${env.PATH ?? ''}`;
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
  copilot: {
    agentId: 'copilot',
    displayName: 'Copilot CLI',
    description: "GitHub's terminal coding agent (npm: @github/copilot)",
    npmPackage: '@github/copilot',
    bin: 'copilot',
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
    // `where` on Windows, `which` on POSIX
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const path = execFileSync(whichCmd, [bin], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
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

function resolveExecutable(
  bin: string,
  env: NodeJS.ProcessEnv,
): { requested: string; resolved: string | null } {
  if (isAbsolute(bin)) {
    return { requested: bin, resolved: existsSync(bin) ? bin : null };
  }

  // On Windows executables may need .exe or .cmd suffix.
  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];

  for (const dir of (env.PATH ?? '').split(PATH_SEP)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, bin + suffix);
      if (existsSync(candidate)) {
        return { requested: bin, resolved: candidate };
      }
    }
  }

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const resolved = execFileSync(whichCmd, [bin], {
      encoding: 'utf8',
      env,
      timeout: 2_000,
    }).split(/\r?\n/)[0].trim();
    return { requested: bin, resolved: resolved || null };
  } catch {
    return { requested: bin, resolved: null };
  }
}

function normalizeLaunchCwd(cwd: string | undefined): string {
  if (cwd && existsSync(cwd)) return cwd;
  return homedir();
}

function appendNoProxy(env: Record<string, string>, hosts: string[]): void {
  const existing = new Set(
    `${env.NO_PROXY ?? ''},${env.no_proxy ?? ''}`
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  );
  for (const host of hosts) existing.add(host);
  const value = Array.from(existing).join(',');
  env.NO_PROXY = value;
  env.no_proxy = value;
}

function normalizeProviderProfile(provider: ProviderProfile): ProviderProfile {
  const apiStyle = provider.apiStyle ?? 'openai';
  if (
    provider.kind === 'deepseek' &&
    apiStyle === 'openai' &&
    provider.baseUrl?.replace(/\/$/, '') === 'https://api.deepseek.com/v1'
  ) {
    return { ...provider, apiStyle, baseUrl: 'https://api.deepseek.com' };
  }
  return provider.apiStyle ? provider : { ...provider, apiStyle };
}

function normalizeProvidersConfig(config: ProvidersConfig): ProvidersConfig {
  return {
    ...config,
    profiles: config.profiles.map(normalizeProviderProfile),
  };
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
      // `"chat"` value is rejected at config-load time. For chat-only
      // vendors that we know how to adapt, the caller passes a local
      // Responses-compatible proxy URL as `baseUrl`.
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
    case 'copilot':
      return ['--model', model];
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
  return normalizeProvidersConfig(
    readJson<ProvidersConfig>(join(TDAY_DIR, 'providers.json'), {
      profiles: [],
    }),
  );
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
    const normalized = normalizeProvidersConfig(next);
    writeFileSync(
      join(TDAY_DIR, 'providers.json'),
      JSON.stringify(normalized, null, 2) + '\n',
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
    const cwd = normalizeLaunchCwd(req.cwd);
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
      launchCwd = normalizeLaunchCwd(launch.cwd);
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
      const gatewayResolution =
        effectiveProvider
          ? await localGatewayManager.resolve({
              agentId: req.agentId,
              provider: effectiveProvider,
            })
          : null;
      const modelArgs = modelFlagsFor(
        req.agentId,
        effectiveProvider?.model,
        effectiveProvider?.kind,
        effectiveProvider?.apiStyle,
        gatewayResolution?.baseUrl ?? effectiveProvider?.baseUrl,
      );
      args = [...modelArgs, ...userArgs];
      env = piLike.env;
      if (gatewayResolution?.noProxyHosts?.length) {
        appendNoProxy(env, gatewayResolution.noProxyHosts);
      }
      launchCwd = normalizeLaunchCwd(piLike.cwd);
    }

    const resolved = resolveExecutable(cmd, env);
    if (!resolved.resolved) {
      const pathPreview = (env.PATH ?? '').split(':').filter(Boolean).slice(0, 8).join(':');
      throw new Error(
        `executable not found: ${resolved.requested}\n` +
          `cwd: ${launchCwd}\n` +
          `PATH: ${pathPreview}${(env.PATH ?? '').includes(':') ? ':…' : ''}`,
      );
    }

    const pty = spawnPty(resolved.resolved, args, {
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
      if (ptys.get(req.tabId) === pty) {
        ptys.delete(req.tabId);
      }
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

  // ── Local service discovery ────────────────────────────────────────────────
  ipcMain.handle(IPC.discoverServices, (_e, req: { extraHosts?: string[]; scanSubnet?: boolean } = {}) =>
    discoverLocalServices({ extraHosts: req.extraHosts, scanSubnet: req.scanSubnet }),
  );

  ipcMain.handle(IPC.probeUrl, (_e, url: string) => probeBaseUrl(url));

  // ── Token usage statistics ─────────────────────────────────────────────────
  ipcMain.handle(IPC.usageAppend, (_e, record: UsageRecord) => {
    appendUsage(record);
  });
  ipcMain.handle(IPC.usageQuery, (_e, filter: UsageFilter = {}) => {
    // Trigger a background incremental refresh (non-blocking — returns before
    // any file I/O starts). The next query will get fresher data.
    triggerSessionCacheRefresh();

    // Fast path: serve from the persistent on-disk cache (in-memory hot cache).
    const sessionRecords = loadCachedSessionRecords(filter);
    const jsonlRecords = loadUsageRecords(filter).filter(
      (r) => !SESSION_FILE_AGENTS.has(r.agentId),
    );
    return computeUsageSummary([...jsonlRecords, ...sessionRecords]);
  });

  // ── Power management ───────────────────────────────────────────────────────
  ipcMain.handle(IPC.powerBlockerStart, () => {
    // prevent-app-suspension: keeps system awake but allows display to sleep.
    const id = powerSaveBlocker.start('prevent-app-suspension');
    // On macOS immediately dim the display via pmset.
    if (process.platform === 'darwin') {
      execAsync('pmset displaysleepnow', () => { /* ignore errors */ });
    }
    return { id };
  });
  ipcMain.handle(IPC.powerBlockerStop, (_e, id: number) => {
    if (typeof id === 'number' && powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id);
    }
  });
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
    // On Windows npm may be `npm.cmd` (a wrapper batch file).
    const npmNames = process.platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
    const extraCandidates = process.platform === 'win32'
      ? []
      : ['/opt/homebrew/bin/npm', '/usr/local/bin/npm'];
    for (const npmName of npmNames) {
      const fromPath = (process.env.PATH ?? '').split(PATH_SEP)
        .map((p) => join(p, npmName))
        .find((c) => c && existsSync(c));
      if (fromPath) return fromPath;
    }
    for (const c of extraCandidates) if (c && existsSync(c)) return c;
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
  // On Windows, verify that Node.js and npm are available on PATH.  If they
  // are missing, agents cannot be installed and the app will silently fail.
  // Show a friendly dialog instead of letting the user debug env issues.
  if (process.platform === 'win32') {
    const nodeOk = Boolean(
      (process.env.PATH ?? '').split(PATH_SEP).find((d) => d && existsSync(join(d, 'node.exe'))),
    );
    if (!nodeOk) {
      // Show after window is created so it has a parent.
      app.once('browser-window-created', (_, win) => {
        void dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Node.js not found',
          message: 'Tday requires Node.js to install and run AI coding agents.',
          detail:
            'Node.js was not found on your PATH.\n\n' +
            '1. Download and install Node.js (LTS) from https://nodejs.org\n' +
            '2. Restart Tday after installation.\n\n' +
            'Without Node.js, agents like Codex, Claude Code and others cannot be installed.',
          buttons: ['Open nodejs.org', 'Continue without Node.js'],
          defaultId: 0,
        }).then(({ response }) => {
          if (response === 0) {
            void shell.openExternal('https://nodejs.org/en/download');
          }
        });
      });
    }
  }

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
  // Warm the session usage cache in the background so the first usageQuery
  // is served from cache rather than triggering a cold full scan.
  triggerSessionCacheRefresh();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  shuttingDown = true;
  localGatewayManager.close();
  killAllPtys();
});

app.on('window-all-closed', () => {
  shuttingDown = true;
  killAllPtys();
  if (process.platform !== 'darwin') app.quit();
});
