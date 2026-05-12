import { app, BrowserWindow, ipcMain, shell, dialog, systemPreferences, desktopCapturer } from 'electron';
import { electronApp } from '@electron-toolkit/utils';
import { spawn as spawnPty, type IPty } from 'node-pty';
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

import {
  IPC,
  type AgentId,
  type AgentInfo,
  type AgentInstallSpec,
  type AgentsConfig,
  type ProvidersConfig,
  type SpawnRequest,
  type UsageRecord,
  type UsageFilter,
  type AgentHistoryEntry,
  type AgentHistoryFilter,
} from '@tday/shared';
import type { CronJob, CronFireEvent, CronJobStats } from '@tday/shared';

import { createLocalGatewayManager } from './gateway/index.js';
import { discoverLocalServices } from './discovery/index.js';
import { probeBaseUrl } from './discovery/probe.js';
import { appendUsage, loadUsageRecords, computeUsageSummary } from './usage/store.js';
import { SESSION_FILE_AGENTS } from './usage/session-readers/index.js';
import { loadCachedSessionRecords, triggerSessionCacheRefresh } from './usage/session-cache.js';
import { loadStore as loadHistoryStore } from './agent-history/store.js';
import {
  loadHistory,
  pushHistoryEntry,
  deleteHistoryEntry,
  latestAgentSession,
  readAgentSession,
  type TabHistoryEntry,
  type SessionMessage,
} from './tab-history.js';
import {
  refreshAndListAgentHistory,
  triggerHistoryRefresh,
  hideHistoryEntry,
  mergeTabEntry,
} from './agent-history/index.js';
import { getAllSettings, setSetting, type JsonValue } from './settings-store.js';
import { loadCronJobs, saveCronJobs, loadCronStats, CronScheduler } from './cron.js';
import { listAllCoworkers, upsertCoworker, deleteCoworker, resetBuiltinCoworker, buildEffectivePrompt, normalizeGitHubUrl, refreshCoworkerUrlCache, scheduleBackgroundRefresh, resolveCoworker, refreshCoworkersRegistry, reloadRegistryFromBundled, parseCoworkersRegistry } from './coworker.js';

// Modular utilities
import { PiAdapter } from '@tday/adapter-pi';
import { PATH_SEP, augmentPath } from './path-utils.js';
import { normalizeProvidersConfig, appendNoProxy } from './provider-utils.js';
import { TDAY_DIR, loadAgents, loadProviders, initDefaultConfigs, invalidateAgentsCache, invalidateProvidersCache } from './config.js';
import {
  semverAtLeast,
  INSTALL_SPECS,
  detectGeneric,
  invalidateDetectCache,
  resolveExecutable,
  normalizeLaunchCwd,
  modelFlagsFor,
  windowsCmdWrap,
  deepseekTuiProviderEnv,
} from './agent-utils.js';
import { ensureFd } from './fd-install.js';
import { ptys, shuttingDown, setShuttingDown, killAllPtys } from './pty-manager.js';
import {
  isComputerUseEnabled,
  applyClaudeCodeMcp,
  applyClaudeCodeMcpUrl,
  injectGeminiMcp,
  injectGeminiMcpUrl,
  injectOpencodeMcp,
  injectOpencodeMcpUrl,
  codexMcpCliArgsUrl,
  injectPiMcp,
  injectPiMcpUrl,
  startCodexApiProxy,
  startMcpSessionProxy,
  writeComputerUseSkillFiles,
  removeComputerUseSkillFiles,
  COMPUTER_USE_SETTING_KEY,
} from './computer-use.js';
import { NativecoreService } from './nativecore-service.js';
import { runNpmGlobal } from './npm-installer.js';
import { setupPowerMonitor, registerPowerHandlers, stopCaffeinate } from './power-manager.js';
import { createWindow, watchWindowShortcuts, installAppMenu, mainWindow } from './window.js';

const localGatewayManager = createLocalGatewayManager();

// ── claude-code concurrent-session state ──────────────────────────────────────
// claude-code reads ~/.claude/settings.json AFTER process.env, overriding any
// env vars we inject. To allow multiple tabs to run claude-code simultaneously
// with different providers, we use this strategy:
//
//   1. Each session writes a per-session temp settings file under ~/.claude/
//      and passes "--settings <tempFile>" so its provider env takes effect.
//   2. The global ~/.claude/settings.json env section must not interfere, so
//      we clear it when the first session starts (ref count 0→1) and restore
//      the original when the last session exits (ref count 1→0).
//
// This means N concurrent claude-code tabs each get their own independent
// provider config without fighting over the single global settings.json.
const claudeSessionCount = { n: 0 };
let claudeGlobalSettingsBackup: string | null = undefined as unknown as string | null; // undefined = never read

// ── CronJob scheduler ─────────────────────────────────────────────────────────

function fireCronJob(job: CronJob): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || shuttingDown) return;
  const event: CronFireEvent = {
    jobId: job.id,
    agentId: job.agentId,
    cwd: job.cwd,
    // Prepend CoWorker system prompt if one is assigned to this job.
    prompt: buildEffectivePrompt(job.coworkerId, job.prompt),
    name: job.name,
  };

  if (job.agentId === 'codex') {
    try {
      const det = detectGeneric('codex');
      if (det.available && det.version && semverAtLeast(det.version, 0, 128, 0)) {
        spawnChild('codex', ['features', 'enable', 'goals'], {
          stdio: 'ignore',
          env: { ...process.env },
        }).on('error', () => { /* ignore */ });
        if (event.prompt) event.prompt = `/goal ${event.prompt}`;
      }
    } catch { /* ignore */ }
  }

  win.webContents.send(IPC.cronJobFired, event);
}

const cronScheduler = new CronScheduler(fireCronJob);

// ── IPC registration ──────────────────────────────────────────────────────────

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

  ipcMain.handle(IPC.pickFile, async (event, opts?: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string }) => {
    const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const res = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: opts?.filters ?? [{ name: 'Markdown', extensions: ['md', 'txt'] }],
      defaultPath: opts?.defaultPath || homedir(),
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  // Agent list & config
  ipcMain.handle(IPC.agentsList, (): AgentInfo[] => {
    const agents = loadAgents();
    const defaultId = agents.defaultAgentId ?? 'pi';
    const out: AgentInfo[] = [];
    for (const [id, spec] of Object.entries(INSTALL_SPECS) as Array<[AgentId, AgentInstallSpec | undefined]>) {
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
    writeFileSync(join(TDAY_DIR, 'agents.json'), JSON.stringify(next, null, 2) + '\n');
    invalidateAgentsCache();
    return { ok: true };
  });

  ipcMain.handle(IPC.providersList, () => loadProviders());

  ipcMain.handle(IPC.providersSave, (_e, next: ProvidersConfig) => {
    if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
    const normalized = normalizeProvidersConfig(next);
    writeFileSync(join(TDAY_DIR, 'providers.json'), JSON.stringify(normalized, null, 2) + '\n');
    invalidateProvidersCache();
    return { ok: true };
  });

  // PTY spawn
  ipcMain.handle(IPC.ptySpawn, async (event, req: SpawnRequest) => {
    // Validate tabId early — it is used to construct file paths and must not
    // contain path-traversal sequences (e.g. '../', '/', null bytes).
    if (!/^[\w-]+$/.test(req.tabId)) {
      throw new Error(`[tday] Invalid tabId — must match [a-zA-Z0-9_-]: "${req.tabId}"`);
    }

    const existing = ptys.get(req.tabId);
    if (existing) {
      try { existing.kill(); } catch { /* already dead */ }
      ptys.delete(req.tabId);
    }

    const agents = loadAgents();
    const providers = loadProviders();
    const agentConf = agents.agents?.[req.agentId] ?? {};
    const providerId = req.providerId ?? agentConf.providerId ?? providers.default;
    const provider = providers.profiles.find((p) => p.id === providerId) ?? providers.profiles[0];
    const effectiveProvider =
      provider && (req.modelId ?? agentConf.model)
        ? { ...provider, model: req.modelId ?? agentConf.model }
        : provider;

    // Apply CoWorker system prompt if one is selected for this tab
    if (req.coworkerId) {
      req = { ...req, initialPrompt: buildEffectivePrompt(req.coworkerId, req.initialPrompt ?? '') };
    }

    const cwd = normalizeLaunchCwd(req.cwd);
    const baseEnv = { ...process.env };
    await ensureFd(baseEnv);

    // Plain terminal: skip agent spawn, use login shell directly
    if (req.agentId === 'terminal') {
      const shell = process.env.SHELL ?? (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
      baseEnv.COLUMNS = String(req.cols);
      baseEnv.LINES = String(req.rows);
      const pty = spawnPty(shell, [], {
        name: 'xterm-256color',
        cols: req.cols,
        rows: req.rows,
        cwd,
        env: baseEnv as Record<string, string>,
      });
      ptys.set(req.tabId, pty);
      pty.onData((data) => {
        if (shuttingDown || event.sender.isDestroyed()) return;
        event.sender.send(IPC.ptyData, { tabId: req.tabId, data });
      });
      pty.onExit(({ exitCode, signal }) => {
        if (!shuttingDown && !event.sender.isDestroyed()) {
          event.sender.send(IPC.ptyExit, { tabId: req.tabId, exitCode, signal: signal ?? null });
        }
        ptys.delete(req.tabId);
      });
      return { tabId: req.tabId };
    }

    const spec = INSTALL_SPECS[req.agentId];
    const bin = agentConf.bin ?? spec?.bin ?? req.agentId;

    let cmd: string;
    let args: string[];
    let env: Record<string, string>;
    let launchCwd: string;
    let claudeSettingsRestore: (() => void) | null = null;
    let computerUseCleanup: (() => void) | null = null;

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
      // For cron jobs pass the prompt as a positional CLI arg (same pattern as other agents)
      if (req.isCronJob && req.initialPrompt?.trim()) {
        args = [...args, req.initialPrompt.trim()];
      }
      // Computer Use: inject bridge extension + env
      // Prefer the shared HTTP server (global RwLock across all agents);
      // fall back to spawning a private stdio process.
      if (isComputerUseEnabled(getAllSettings(), 'pi')) {
        let piCuUrl: string | null = null;
        try {
          await NativecoreService.addRef();
          piCuUrl = NativecoreService.getUrl();
        } catch (e) {
          console.warn('[tday] NativecoreService unavailable for pi, falling back to stdio:', e);
        }
        if (piCuUrl) {
          const piAuthToken = NativecoreService.getAuthToken();
          const { extensionPath, env: cuEnv } = injectPiMcpUrl(piCuUrl, piAuthToken);
          Object.assign(env, cuEnv);
          args = [...args, '--extension', extensionPath];
          computerUseCleanup = () => NativecoreService.release();
        } else {
          const { extensionPath, env: cuEnv, cleanup } = injectPiMcp();
          Object.assign(env, cuEnv);
          args = [...args, '--extension', extensionPath];
          computerUseCleanup = cleanup;
        }
      }
    } else {
      const piLike = PiAdapter.buildLaunch({
        bin,
        extraArgs: agentConf.args,
        provider: effectiveProvider,
        cwd,
        env: baseEnv,
      });
      cmd = piLike.cmd;
      const userArgs = (agentConf.args ?? []).slice();
      const gatewayResolution =
        effectiveProvider
          ? await localGatewayManager.resolve({ agentId: req.agentId, provider: effectiveProvider, cwd: req.cwd })
          : null;
      const modelArgs = modelFlagsFor(
        req.agentId,
        effectiveProvider?.model,
        effectiveProvider?.kind,
        effectiveProvider?.apiStyle,
        gatewayResolution?.baseUrl ?? effectiveProvider?.baseUrl,
      );
      args = [...modelArgs, ...userArgs];

      if (req.agentSessionId) {
        switch (req.agentId) {
          case 'claude-code':   args = ['--resume', req.agentSessionId, ...args]; break;
          case 'codex':         args = ['resume', req.agentSessionId]; break;
          case 'opencode':      args = ['--session', req.agentSessionId, ...args]; break;
          case 'deepseek-tui':  args = ['resume', req.agentSessionId, ...args]; break;
          default: break;
        }
      }

      const initialPrompt = req.initialPrompt?.trim();
      if (req.isCronJob && req.agentId === 'opencode' && !req.agentSessionId) {
        args = ['run', ...args];
      }

      const CLI_PROMPT_AGENTS: AgentId[] = [
        'codex', 'claude-code', 'gemini', 'qwen-code', 'deepseek-tui',
        ...(req.isCronJob ? (['opencode'] as AgentId[]) : []),
      ];
      const sentViaCliArg = !!(
        initialPrompt && !req.agentSessionId && CLI_PROMPT_AGENTS.includes(req.agentId)
      );
      if (sentViaCliArg && initialPrompt) args = [...args, initialPrompt];

      env = piLike.env;

      // ── claude-code provider override ─────────────────────────────────────
      // claude-code reads ~/.claude/settings.json env section AFTER process.env,
      // silently overriding whatever we inject. We handle this with two layers:
      //
      //   Layer 1 — per-session temp settings file:
      //     Write our provider env to a per-session temp file
      //     (~/.claude/tday-session-<tabId>.json) and pass --settings <file>.
      //     This file is deleted when the PTY exits.
      //
      //   Layer 2 — global env section cleared (ref-counted):
      //     The global settings.json env section must not interfere with the
      //     per-session temp file. On the first concurrent claude-code session
      //     (ref count 0→1) we blank the env keys in the global file and save
      //     the original. On the last session exit (ref count 1→0) we restore
      //     the original. Multiple concurrent tabs are each isolated via their
      //     own temp file while the global env stays silent.
      if (req.agentId === 'claude-code' && effectiveProvider) {
        const cp = effectiveProvider;
        // Resolve the correct Anthropic-compatible base URL per provider kind.
        // - LM Studio/Ollama: strip /v1 (native Anthropic endpoint at root)
        // - DeepSeek: strip /v1 then append /anthropic
        // - Others: use as-is (cloud providers already point to the right base)
        const LOCAL_OAI_COMPAT = new Set(['ollama', 'lmstudio', 'litellm', 'vllm', 'sglang']);
        const rawUrl = cp.baseUrl ?? '';
        let resolvedUrl: string;
        if (LOCAL_OAI_COMPAT.has(cp.kind ?? '')) {
          resolvedUrl = rawUrl.replace(/\/v1\/?$/, '');
        } else if (cp.kind === 'deepseek') {
          const base = rawUrl.replace(/\/$/, '').replace(/\/v1\/?$/, '');
          resolvedUrl = base.endsWith('/anthropic') ? base : `${base}/anthropic`;
        } else {
          resolvedUrl = rawUrl;
        }
        const apiKey = cp.apiKey ?? 'no-key-required';

        // Env overrides for this session. Model keys are cleared so a stale
        // model name in the user's global settings won't take effect.
        const envPatch: Record<string, string> = {
          ANTHROPIC_MODEL: '',
          ANTHROPIC_DEFAULT_OPUS_MODEL: '',
          ANTHROPIC_DEFAULT_SONNET_MODEL: '',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
          CLAUDE_CODE_SUBAGENT_MODEL: '',
          ANTHROPIC_SMALL_FAST_MODEL: '',
        };
        if (resolvedUrl) {
          envPatch.ANTHROPIC_BASE_URL = resolvedUrl;
          envPatch.ANTHROPIC_API_URL  = resolvedUrl;
        }
        if (apiKey) {
          envPatch.ANTHROPIC_API_KEY   = apiKey;
          envPatch.ANTHROPIC_AUTH_TOKEN = apiKey;
        }

        const claudeDir = join(homedir(), '.claude');
        const globalSettingsPath = join(claudeDir, 'settings.json');

        // Per-session temp settings file — unique per tab, never collides.
        const sessionSettingsPath = join(claudeDir, `tday-session-${req.tabId}.json`);
        // Separate MCP config file passed via --mcp-config (mcpServers in --settings is ignored by claude-code).
        const mcpConfigPath = join(claudeDir, `tday-mcp-${req.tabId}.json`);

        try {
          mkdirSync(claudeDir, { recursive: true });

          // ── Layer 1: write per-session temp file ──────────────────────────
          const sessionSettings: Record<string, unknown> = { env: envPatch };
          if (isComputerUseEnabled(getAllSettings(), 'claude-code')) {
            // Only inject ANTHROPIC_BETA for real Anthropic backends; local
            // OAI-compat servers (LM Studio, Ollama…) reject computer_use_20250124.
            const isAnthropicBackend = cp.kind === 'anthropic';
            // Prefer HTTP service when available; fall back to stdio command.
            let cuNativecoreUrl: string | null = null;
            try {
              await NativecoreService.addRef();
              cuNativecoreUrl = NativecoreService.getUrl();
            } catch (e) {
              console.warn('[tday] NativecoreService unavailable for claude-code, falling back to stdio:', e);
            }
            if (cuNativecoreUrl) {
              const ccAuthToken = NativecoreService.getAuthToken();
              applyClaudeCodeMcpUrl(sessionSettings, cuNativecoreUrl, isAnthropicBackend, ccAuthToken);
              computerUseCleanup = () => NativecoreService.release();
            } else {
              applyClaudeCodeMcp(sessionSettings, isAnthropicBackend);
            }
            // MCP servers must be passed via --mcp-config (not --settings) for
            // claude-code to register them before the session starts.
            const mcpServers = sessionSettings.mcpServers;
            delete sessionSettings.mcpServers;
            if (mcpServers) {
              writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), 'utf8');
              args = ['--mcp-config', mcpConfigPath, ...args];
            }
          }
          writeFileSync(sessionSettingsPath, JSON.stringify(sessionSettings, null, 2), 'utf8');
          // Instruct claude-code to load this file (merged with global).
          args = ['--settings', sessionSettingsPath, ...args];

          // ── Layer 2: blank global env (ref-counted) ───────────────────────
          if (claudeSessionCount.n === 0) {
            // First session: capture the true original and clear global env.
            try { claudeGlobalSettingsBackup = readFileSync(globalSettingsPath, 'utf8'); }
            catch { claudeGlobalSettingsBackup = null; }

            const existing: Record<string, unknown> =
              claudeGlobalSettingsBackup
                ? (JSON.parse(claudeGlobalSettingsBackup) as Record<string, unknown>)
                : {};
            const neutralized = { ...existing, env: {} };
            writeFileSync(globalSettingsPath, JSON.stringify(neutralized, null, 2), 'utf8');
          }
          claudeSessionCount.n += 1;
        } catch (e) {
          console.warn('[tday] could not set up claude-code session settings:', e);
        }

        // Restore callback: clean up temp file and (last session) restore global.
        claudeSettingsRestore = () => {
          try {
            try { unlinkSync(sessionSettingsPath); } catch { /* ok */ }
            try { unlinkSync(mcpConfigPath); } catch { /* ok */ }
            claudeSessionCount.n = Math.max(0, claudeSessionCount.n - 1);
            if (claudeSessionCount.n === 0) {
              // Last session done — restore global settings.json.
              if (claudeGlobalSettingsBackup === null) {
                // File didn't exist before; remove what we created.
                try { unlinkSync(globalSettingsPath); } catch { /* ok */ }
              } else if (claudeGlobalSettingsBackup !== undefined) {
                writeFileSync(globalSettingsPath, claudeGlobalSettingsBackup, 'utf8');
              }
              claudeGlobalSettingsBackup = undefined as unknown as string | null;
            }
          } catch (e) {
            console.warn('[tday] could not restore claude-code settings:', e);
          }
        };

        // Also inject into process env for completeness.
        Object.assign(env, envPatch);
      }

      // Computer Use for claude-code when no effectiveProvider is configured:
      // The provider block above is skipped, but MCP injection must still happen.
      if (req.agentId === 'claude-code' && !effectiveProvider && isComputerUseEnabled(getAllSettings(), 'claude-code')) {
        const claudeDir = join(homedir(), '.claude');
        const sessionSettingsPath = join(claudeDir, `tday-session-${req.tabId}.json`);
        const mcpConfigPath = join(claudeDir, `tday-mcp-${req.tabId}.json`);
        try {
          mkdirSync(claudeDir, { recursive: true });
          const sessionSettings: Record<string, unknown> = {};
          // No effectiveProvider: default Anthropic backend.
          // Prefer HTTP service; fall back to stdio command.
          let cuUrl: string | null = null;
          try {
            await NativecoreService.addRef();
            cuUrl = NativecoreService.getUrl();
          } catch (e) {
            console.warn('[tday] NativecoreService unavailable for claude-code (no provider), falling back to stdio:', e);
          }
          if (cuUrl) {
            const ccAuthToken2 = NativecoreService.getAuthToken();
            applyClaudeCodeMcpUrl(sessionSettings, cuUrl, true, ccAuthToken2);
            computerUseCleanup = () => NativecoreService.release();
          } else {
            applyClaudeCodeMcp(sessionSettings, true);
          }
          // MCP servers via --mcp-config; rest (permissions, env, customInstructions) via --settings.
          const mcpServers = sessionSettings.mcpServers;
          delete sessionSettings.mcpServers;
          if (mcpServers) {
            writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }, null, 2), 'utf8');
            args = ['--mcp-config', mcpConfigPath, ...args];
          }
          writeFileSync(sessionSettingsPath, JSON.stringify(sessionSettings, null, 2), 'utf8');
          args = ['--settings', sessionSettingsPath, ...args];
          const cuCleanup = computerUseCleanup;
          claudeSettingsRestore = () => {
            try { unlinkSync(mcpConfigPath); } catch { /* ok */ }
            try { unlinkSync(sessionSettingsPath); } catch { /* ok */ }
            cuCleanup?.();
            computerUseCleanup = null;
          };
        } catch (e) {
          console.warn('[tday] could not set up claude-code Computer Use session settings:', e);
        }
      }

      if (req.agentId === 'deepseek-tui' && effectiveProvider) {
        Object.assign(env, deepseekTuiProviderEnv(effectiveProvider.kind, effectiveProvider.apiKey, effectiveProvider.baseUrl));
      }

      // ── Computer Use: inject MCP for agents with global config files ──────
      if (isComputerUseEnabled(getAllSettings(), req.agentId)) {
        if (req.agentId === 'gemini') {
          // Prefer shared HTTP service; fall back to per-session stdio spawn.
          let cuUrl: string | null = null;
          try {
            await NativecoreService.addRef();
            cuUrl = NativecoreService.getUrl();
          } catch (e) {
            console.warn('[tday] NativecoreService unavailable for gemini, falling back to stdio:', e);
          }
          if (cuUrl) {
            const geminiAuthToken = NativecoreService.getAuthToken();
            const cleanup = injectGeminiMcpUrl(cuUrl, undefined, geminiAuthToken);
            computerUseCleanup = () => { cleanup(); NativecoreService.release(); };
          } else {
            computerUseCleanup = injectGeminiMcp();
          }
        } else if (req.agentId === 'opencode') {
          // Prefer shared HTTP service; fall back to per-session stdio spawn.
          let cuUrl: string | null = null;
          try {
            await NativecoreService.addRef();
            cuUrl = NativecoreService.getUrl();
          } catch (e) {
            console.warn('[tday] NativecoreService unavailable for opencode, falling back to stdio:', e);
          }
          if (cuUrl) {
            const opencodeAuthToken = NativecoreService.getAuthToken();
            const cleanup = injectOpencodeMcpUrl(cuUrl, undefined, opencodeAuthToken);
            computerUseCleanup = () => { cleanup(); NativecoreService.release(); };
          } else {
            computerUseCleanup = injectOpencodeMcp();
          }
        } else if (req.agentId === 'codex') {
          // codex wraps MCP tools as type:"namespace" which third-party providers
          // (DeepSeek, LM Studio, …) don't support.  When a base URL is configured
          // we insert a local proxy that expands namespace tools → flat functions
          // on the request path and converts flat function-call names back to the
          // namespace+name split on the response path.
          //
          // MCP transport: shared HTTP NativecoreService + per-session
          // MCP session-keepalive proxy.  The proxy transparently maintains the
          // Mcp-Session-Id that codex's rmcp client drops, so codex always sees
          // a healthy session.  Falls back to stdio if the shared service fails.
          let mcpProxyStop: (() => void) | undefined;
          try {
            await NativecoreService.addRef();
            const nativecoreUrl = NativecoreService.getUrl();
            const codexAuthToken = NativecoreService.getAuthToken();
            if (!nativecoreUrl) throw new Error('NativecoreService not ready');
            const mcpProxy = await startMcpSessionProxy(nativecoreUrl, codexAuthToken ?? undefined);
            mcpProxyStop = mcpProxy.stop;
            // codex MCP URL = proxy base + the /mcp path that nativecore serves
            args.push(...codexMcpCliArgsUrl(mcpProxy.proxyBaseUrl + '/mcp'));
            computerUseCleanup = () => { mcpProxyStop?.(); NativecoreService.release(); };
          } catch (e) {
            console.warn('[tday] NativecoreService/MCP proxy unavailable for codex, falling back to stdio:', e);
            // stdio fallback: private nativecore per session, no session management needed
            const { codexMcpCliArgs } = await import('./computer-use.js');
            args.push(...codexMcpCliArgs());
            computerUseCleanup = () => { /* stdio process exits with codex */ };
          }
          // Exclude loopback from system proxy (Clash, VPN, etc.) so codex's
          // reqwest client reaches the local proxies directly.
          appendNoProxy(env, ['127.0.0.1', 'localhost', '::1']);

          const cuBaseUrl = gatewayResolution?.baseUrl ?? effectiveProvider?.baseUrl;
          if (cuBaseUrl) {
            try {
              const apiProxy = await startCodexApiProxy(cuBaseUrl);
              const apiProxyStop = apiProxy.stop;
              // Replace the base_url in the already-built args so codex hits the proxy.
              for (let i = 0; i < args.length - 1; i++) {
                if (args[i] === '-c' && (args[i + 1] as string).startsWith('model_providers.tday.base_url=')) {
                  args[i + 1] = `model_providers.tday.base_url="${apiProxy.proxyBaseUrl}"`;
                  break;
                }
              }
              const prevCleanup = computerUseCleanup;
              computerUseCleanup = () => { prevCleanup?.(); apiProxyStop(); };
            } catch (e) {
              console.warn('[tday] could not start codex namespace-tool proxy:', e);
            }
          }
        }
        // claude-code is handled above inside the per-session settings block
      }

      if (gatewayResolution?.noProxyHosts?.length) appendNoProxy(env, gatewayResolution.noProxyHosts);
      launchCwd = normalizeLaunchCwd(piLike.cwd);
    }

    env.COLUMNS = String(req.cols);
    env.LINES = String(req.rows);

    const resolved = resolveExecutable(cmd, env);

    const isWin = process.platform === 'win32';
    // cmd.exe path used for Windows fallback (interactive shell approach).
    const comSpec = isWin
      ? process.env.ComSpec ?? join(process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows', 'System32', 'cmd.exe')
      : null;
    // Pre-build cmd.exe-safe command line string so it is available for both
    // "resolveExecutable failed" and "spawn threw" fallback paths.
    const windowsFallbackCmdLine = isWin
      ? [cmd, ...args].map((a) => (/[\s"&|<>^()]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a)).join(' ')
      : null;

    let spawnFile: string;
    let spawnArgs: string[];

    if (!resolved.resolved) {
      if (isWin) {
        // resolveExecutable could not locate the binary — go straight to
        // interactive cmd.exe (plan B).
        spawnFile = comSpec!;
        spawnArgs = [];
      } else {
        const pathParts = (env.PATH ?? '').split(PATH_SEP).filter(Boolean);
        const pathPreview = pathParts.slice(0, 8).join(PATH_SEP);
        throw new Error(
          `executable not found: ${resolved.requested}\ncwd: ${launchCwd}\nPATH: ${pathPreview}${pathParts.length > 8 ? `${PATH_SEP}…` : ''}`,
        );
      }
    } else {
      // On Windows, node-pty (ConPTY / CreateProcess) cannot execute .cmd
      // or .bat files directly — wrap them in cmd.exe /c if needed.
      ({ file: spawnFile, args: spawnArgs } = windowsCmdWrap(resolved.resolved, args));
    }

    // Plan A: spawn the resolved binary (or cmd.exe /c wrapper for .cmd files).
    // Plan B (Windows only): if spawn itself throws (e.g. binary was moved/deleted
    //   after resolution, or PATH still wrong at CreateProcess level), automatically
    //   retry with an interactive cmd.exe session and write the command as PTY input.
    let pty: IPty;
    let usingInteractiveFallback = isWin && !resolved.resolved; // already on plan B
    try {
      pty = spawnPty(spawnFile, spawnArgs, {
        name: 'xterm-256color',
        cols: req.cols,
        rows: req.rows,
        cwd: launchCwd,
        env,
      });
    } catch (spawnErr) {
      if (isWin && comSpec && windowsFallbackCmdLine) {
        // Plan A spawn failed — fall back to interactive cmd.exe automatically.
        pty = spawnPty(comSpec, [], {
          name: 'xterm-256color',
          cols: req.cols,
          rows: req.rows,
          cwd: launchCwd,
          env,
        });
        usingInteractiveFallback = true;
      } else {
        throw spawnErr;
      }
    }

    ptys.set(req.tabId, pty);

    // Windows interactive fallback: wait for cmd.exe prompt (~600 ms), then type
    // the agent command — exactly as if the user had opened cmd.exe and typed it.
    if (usingInteractiveFallback && windowsFallbackCmdLine) {
      const tabId = req.tabId;
      const cmdLine = windowsFallbackCmdLine;
      setTimeout(() => { ptys.get(tabId)?.write(cmdLine + '\r'); }, 600);
    }

    const initialPromptForPty = req.initialPrompt?.trim();
    const _cliAgents: AgentId[] = [
      'codex', 'claude-code', 'gemini', 'qwen-code', 'deepseek-tui',
      // For cron jobs: opencode uses 'run' subcommand, pi uses positional arg — both skip PTY write
      ...(req.isCronJob ? (['opencode', 'pi'] as AgentId[]) : []),
    ];
    const needsPtyWrite =
      initialPromptForPty && !req.agentSessionId && !_cliAgents.includes(req.agentId);
    if (needsPtyWrite && initialPromptForPty) {
      const sanitized = initialPromptForPty
        .replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
        .replace(/ {2,}/g, ' ');
      const bracketedPayload = `\x1b[200~${sanitized}\x1b[201~\r`;
      const tabId = req.tabId;
      const graceMs = req.agentId === 'opencode' ? 8000 : 3500;
      setTimeout(() => { ptys.get(tabId)?.write(bracketedPayload); }, graceMs);
    }

    pty.onData((data) => {
      if (shuttingDown || event.sender.isDestroyed()) return;
      event.sender.send(IPC.ptyData, { tabId: req.tabId, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      if (!shuttingDown && !event.sender.isDestroyed()) {
        event.sender.send(IPC.ptyExit, { tabId: req.tabId, exitCode, signal: signal ?? null });
      }
      if (ptys.get(req.tabId) === pty) ptys.delete(req.tabId);
      // Restore ~/.claude/settings.json to its pre-launch state.
      claudeSettingsRestore?.();
      // Restore any computer-use MCP config that was injected for this session.
      computerUseCleanup?.();
    });

    return { pid: pty.pid };
  });

  ipcMain.handle(IPC.ptyWrite,  (_e, tabId: string, data: string) => { ptys.get(tabId)?.write(data); });
  ipcMain.handle(IPC.ptyResize, (_e, tabId: string, cols: number, rows: number) => {
    try { ptys.get(tabId)?.resize(cols, rows); } catch { /* ignore */ }
  });
  ipcMain.handle(IPC.ptyKill, (_e, tabId: string) => {
    const p = ptys.get(tabId);
    if (p) {
      try { p.kill(); } catch { /* already dead */ }
      ptys.delete(tabId);
    }
  });

  // Agent install / update / uninstall
  ipcMain.handle(IPC.agentInstall,   (event, agentId: AgentId) => runNpmGlobal(event, agentId, 'install',   INSTALL_SPECS[agentId]).then((r) => { invalidateDetectCache(); invalidateAgentsCache(); return r; }));
  ipcMain.handle(IPC.agentUpdate,    (event, agentId: AgentId) => runNpmGlobal(event, agentId, 'update',    INSTALL_SPECS[agentId]).then((r) => { invalidateDetectCache(); invalidateAgentsCache(); return r; }));
  ipcMain.handle(IPC.agentUninstall, (event, agentId: AgentId) => runNpmGlobal(event, agentId, 'uninstall', INSTALL_SPECS[agentId]).then((r) => { invalidateDetectCache(); invalidateAgentsCache(); return r; }));

  // Local service discovery
  ipcMain.handle(IPC.discoverServices, (_e, req: { extraHosts?: string[]; scanSubnet?: boolean } = {}) =>
    discoverLocalServices({ extraHosts: req.extraHosts, scanSubnet: req.scanSubnet }),
  );
  ipcMain.handle(IPC.probeUrl, (_e, url: string) => probeBaseUrl(url));

  // Token usage statistics
  ipcMain.handle(IPC.usageAppend, (_e, record: UsageRecord) => { appendUsage(record); });
  ipcMain.handle(IPC.usageQuery, (_e, filter: UsageFilter = {}) => {
    triggerSessionCacheRefresh();
    let sessionRecords = loadCachedSessionRecords(filter);
    let jsonlRecords = loadUsageRecords(filter).filter((r) => !SESSION_FILE_AGENTS.has(r.agentId));
    // Enrich records without cwd by joining with history-index entries
    const historyEntries = loadHistoryStore().entries;
    if (historyEntries.length > 0) {
      const enrich = <T extends { agentId: string; ts: number; cwd?: string }>(r: T): T => {
        if (r.cwd) return r;
        const match = historyEntries.find(
          (e) => e.agentId === r.agentId && e.startedAt <= r.ts && e.updatedAt >= r.ts,
        );
        return match ? { ...r, cwd: match.cwd } : r;
      };
      jsonlRecords = jsonlRecords.map(enrich);
      sessionRecords = sessionRecords.map(enrich);
    }
    return computeUsageSummary([...jsonlRecords, ...sessionRecords]);
  });

  // Power management
  registerPowerHandlers();

  // Tab history
  ipcMain.handle(IPC.tabHistoryList, (): TabHistoryEntry[] => loadHistory());
  ipcMain.handle(IPC.tabHistoryPush, (_e, entry: TabHistoryEntry): void => {
    pushHistoryEntry(entry);
    mergeTabEntry(entry);
  });
  ipcMain.handle(IPC.tabHistoryDelete, (_e, histId: string): void => { deleteHistoryEntry(histId); });
  ipcMain.handle(IPC.latestAgentSession, (_e, agentId: AgentId, cwd: string): string | null =>
    latestAgentSession(agentId, cwd),
  );
  ipcMain.handle(IPC.readAgentSession, (_e, agentId: AgentId, sessionId: string, cwd: string): SessionMessage[] =>
    readAgentSession(agentId, sessionId, cwd),
  );

  // Agent History
  ipcMain.handle(IPC.agentHistoryList, async (_e, filter?: AgentHistoryFilter): Promise<AgentHistoryEntry[]> =>
    refreshAndListAgentHistory(filter),
  );
  ipcMain.handle(IPC.agentHistoryHide,    (_e, id: string): void => { hideHistoryEntry(id); });
  ipcMain.handle(IPC.agentHistoryRefresh, (): void => { triggerHistoryRefresh(); });

  // App Settings
  ipcMain.handle(IPC.settingsGetAll, () => getAllSettings());
  ipcMain.handle(IPC.settingsSet, (_e, key: string, value: unknown): void => {
    setSetting(key, value as JsonValue);
    // Sync skill/instruction files immediately when the Computer Use toggle changes.
    if (key === COMPUTER_USE_SETTING_KEY) {
      if (value) writeComputerUseSkillFiles();
      else removeComputerUseSkillFiles();
    }
  });

  // Open external URL (https only)
  ipcMain.handle(IPC.openExternal, (_e, url: unknown) => {
    const safe = String(url);
    if (/^https:\/\//.test(safe)) void shell.openExternal(safe);
  });

  // ── macOS permission management (Computer Use) ──────────────────────────────
  // Check current status of Accessibility + Screen Recording permissions.
  ipcMain.handle(IPC.permissionsCheck, () => {
    if (process.platform !== 'darwin') return { accessibility: true, screenRecording: 'granted' };
    return {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screenRecording: systemPreferences.getMediaAccessStatus('screen'),
    };
  });

  // Request a specific permission.
  // 'accessibility' → shows system AX dialog immediately.
  // 'screen'        → triggers desktopCapturer (first-time prompt); if already
  //                   denied, opens System Settings Privacy page instead.
  ipcMain.handle(IPC.permissionsRequest, async (_e, kind: 'accessibility' | 'screen') => {
    if (process.platform !== 'darwin') return true;
    if (kind === 'accessibility') {
      systemPreferences.isTrustedAccessibilityClient(true);
      return systemPreferences.isTrustedAccessibilityClient(false);
    }
    if (kind === 'screen') {
      const status = systemPreferences.getMediaAccessStatus('screen');
      if (status === 'denied') {
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
        return false;
      }
      // 'not-determined' or anything else → trigger capture to show system prompt
      try { await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } }); } catch { /* expected to fail without permission */ }
      return systemPreferences.getMediaAccessStatus('screen') === 'granted';
    }
    return false;
  });

  // Open the relevant System Settings privacy pane directly.
  ipcMain.handle(IPC.permissionsOpenSettings, (_e, kind: 'accessibility' | 'screen') => {
    if (process.platform !== 'darwin') return;
    const url = kind === 'accessibility'
      ? 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
      : 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
    void shell.openExternal(url);
  });

  // CronJob management
  ipcMain.handle(IPC.cronJobsList, (): CronJob[] => loadCronJobs());
  ipcMain.handle(IPC.cronJobsSave, (_e, jobs: CronJob[]): void => {
    saveCronJobs(jobs);
    cronScheduler.scheduleAll(jobs);
  });
  ipcMain.handle(IPC.cronJobsTrigger, (_e, jobId: string): void => {
    const job = loadCronJobs().find((j) => j.id === jobId);
    if (!job) return;
    cronScheduler.triggerNow(job);
  });
  ipcMain.handle(IPC.cronJobsGetStats, (): Record<string, CronJobStats> => loadCronStats());

  // ── CoWorker management ───────────────────────────────────────────────────
  ipcMain.handle(IPC.coworkerList, () => listAllCoworkers());
  ipcMain.handle(IPC.coworkerSave, (_e, coworker: import('@tday/shared').CoWorker) => upsertCoworker(coworker));
  ipcMain.handle(IPC.coworkerDelete, (_e, id: string) => deleteCoworker(id));
  ipcMain.handle(IPC.coworkerReset, (_e, id: string) => resetBuiltinCoworker(id));
  ipcMain.handle(IPC.coworkerFetchUrl, async (_e, rawUrl: string): Promise<string> => {
    const trimmed = rawUrl.trim();
    // Local file path: restrict reads to user-owned config/project directories.
    // Disallow absolute paths that could read arbitrary system files.
    if (trimmed.startsWith('/') || /^[A-Za-z]:[/\\]/.test(trimmed)) {
      const { readFileSync } = await import('fs');
      const { resolve: resolvePath } = await import('path');
      const { homedir } = await import('os');

      const resolved = resolvePath(trimmed);
      const home = homedir();
      // Only allow reading files inside the user's home directory to prevent
      // reading sensitive system files such as /etc/passwd or SSH keys.
      if (!resolved.startsWith(home + '/') && !resolved.startsWith(home + '\\')) {
        throw new Error(`Reading files outside the home directory is not allowed: ${resolved}`);
      }
      return readFileSync(resolved, 'utf8');
    }
    const url = normalizeGitHubUrl(trimmed);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
    return res.text();
  });
  ipcMain.handle(IPC.coworkerRefreshCache, async (_e, id: string): Promise<void> => {
    const cw = resolveCoworker(id);
    if (!cw?.url) throw new Error(`CoWorker "${id}" has no URL configured`);
    await refreshCoworkerUrlCache(id, cw.url);
  });
  ipcMain.handle(IPC.coworkerRefreshRegistry, async (): Promise<import('@tday/shared').CoWorker[]> => {
    try {
      await refreshCoworkersRegistry();
    } catch {
      // GitHub unavailable — fall back to bundled CoWorkers.md
      reloadRegistryFromBundled();
    }
    return listAllCoworkers();
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  augmentPath();

  // Start background refresh for online coworker caches
  scheduleBackgroundRefresh();

  if (process.platform === 'win32') {
    const nodeOk = Boolean(
      (process.env.PATH ?? '').split(PATH_SEP).find((d) => d && existsSync(join(d, 'node.exe'))),
    );
    if (!nodeOk) {
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
          if (response === 0) void shell.openExternal('https://nodejs.org/en/download');
        });
      });
    }
  }

  initDefaultConfigs();

  // Eagerly warm up all hot-caches so the first IPC round-trip from the
  // renderer hits memory instead of the file-system.
  // Detection (which + --version) is the real bottleneck: 9 agents × 2 execs
  // can take 200-2000 ms. Running it here moves that cost to app startup
  // (before the window is visible) instead of the first settings open.
  void (async () => {
    // File caches (fast, synchronous internally, warm them eagerly)
    const startupSettings = getAllSettings();
    // Sync Computer Use skill files so agents have context even if the app
    // was closed without toggling (e.g. after a crash or force-quit).
    if (startupSettings[COMPUTER_USE_SETTING_KEY]) writeComputerUseSkillFiles();
    loadAgents();
    loadProviders();
    // Detect all agents in parallel using Promise.all with idle scheduling
    // so the main-thread JS queue is not blocked in a tight loop.
    const bins = (Object.values(INSTALL_SPECS) as (typeof INSTALL_SPECS[keyof typeof INSTALL_SPECS])[]).flatMap(
      (spec) => (spec?.bin ? [spec.bin] : []),
    );
    await Promise.all(bins.map((bin) => new Promise<void>((resolve) => {
      setImmediate(() => { detectGeneric(bin); resolve(); });
    })));
  })();

  electronApp.setAppUserModelId('com.tday.app');
  watchWindowShortcuts();
  setupPowerMonitor();
  installAppMenu();
  registerIpc();
  cronScheduler.scheduleAll(loadCronJobs());
  triggerSessionCacheRefresh();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  setShuttingDown(true);
  cronScheduler.destroy();
  localGatewayManager.close();
  killAllPtys();
  stopCaffeinate();
});

app.on('window-all-closed', () => {
  setShuttingDown(true);
  cronScheduler.destroy();
  localGatewayManager.close();
  killAllPtys();
  if (process.platform !== 'darwin') app.quit();
});


