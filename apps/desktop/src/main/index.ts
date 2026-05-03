import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { electronApp } from '@electron-toolkit/utils';
import { spawn as spawnPty } from 'node-pty';
import { spawn as spawnChild } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

// Modular utilities
import { PiAdapter } from '@tday/adapter-pi';
import { PATH_SEP, augmentPath } from './path-utils.js';
import { normalizeProvidersConfig, appendNoProxy } from './provider-utils.js';
import { TDAY_DIR, loadAgents, loadProviders, initDefaultConfigs } from './config.js';
import {
  semverAtLeast,
  INSTALL_SPECS,
  detectGeneric,
  resolveExecutable,
  normalizeLaunchCwd,
  modelFlagsFor,
  windowsCmdWrap,
} from './agent-utils.js';
import { ensureFd } from './fd-install.js';
import { ptys, shuttingDown, setShuttingDown, killAllPtys } from './pty-manager.js';
import { runNpmGlobal } from './npm-installer.js';
import { setupPowerMonitor, registerPowerHandlers, stopCaffeinate } from './power-manager.js';
import { createWindow, watchWindowShortcuts, installAppMenu, mainWindow } from './window.js';

const localGatewayManager = createLocalGatewayManager();

// ── CronJob scheduler ─────────────────────────────────────────────────────────

function fireCronJob(job: CronJob): void {
  const win = mainWindow;
  if (!win || win.isDestroyed() || shuttingDown) return;
  const event: CronFireEvent = {
    jobId: job.id,
    agentId: job.agentId,
    cwd: job.cwd,
    prompt: job.prompt,
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
    return { ok: true };
  });

  ipcMain.handle(IPC.providersList, () => loadProviders());

  ipcMain.handle(IPC.providersSave, (_e, next: ProvidersConfig) => {
    if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
    const normalized = normalizeProvidersConfig(next);
    writeFileSync(join(TDAY_DIR, 'providers.json'), JSON.stringify(normalized, null, 2) + '\n');
    return { ok: true };
  });

  // PTY spawn
  ipcMain.handle(IPC.ptySpawn, async (event, req: SpawnRequest) => {
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
      provider && agentConf.model ? { ...provider, model: agentConf.model } : provider;

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
      // For cron jobs pass the prompt as a positional CLI arg (same pattern as other agents)
      if (req.isCronJob && req.initialPrompt?.trim()) {
        args = [...args, req.initialPrompt.trim()];
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
          ? await localGatewayManager.resolve({ agentId: req.agentId, provider: effectiveProvider })
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
          case 'claude-code': args = ['--resume', req.agentSessionId, ...args]; break;
          case 'codex':       args = ['resume', req.agentSessionId]; break;
          case 'opencode':    args = ['--session', req.agentSessionId, ...args]; break;
          default: break;
        }
      }

      const initialPrompt = req.initialPrompt?.trim();
      if (req.isCronJob && req.agentId === 'opencode' && !req.agentSessionId) {
        args = ['run', ...args];
      }

      const CLI_PROMPT_AGENTS: AgentId[] = [
        'codex', 'claude-code', 'gemini', 'qwen-code',
        ...(req.isCronJob ? (['opencode'] as AgentId[]) : []),
      ];
      const sentViaCliArg = !!(
        initialPrompt && !req.agentSessionId && CLI_PROMPT_AGENTS.includes(req.agentId)
      );
      if (sentViaCliArg && initialPrompt) args = [...args, initialPrompt];

      env = piLike.env;
      if (gatewayResolution?.noProxyHosts?.length) appendNoProxy(env, gatewayResolution.noProxyHosts);
      launchCwd = normalizeLaunchCwd(piLike.cwd);
    }

    env.COLUMNS = String(req.cols);
    env.LINES = String(req.rows);

    const resolved = resolveExecutable(cmd, env);
    if (!resolved.resolved) {
      const pathParts = (env.PATH ?? '').split(PATH_SEP).filter(Boolean);
      const pathPreview = pathParts.slice(0, 8).join(PATH_SEP);
      throw new Error(
        `executable not found: ${resolved.requested}\ncwd: ${launchCwd}\nPATH: ${pathPreview}${pathParts.length > 8 ? `${PATH_SEP}…` : ''}`,
      );
    }

    // On Windows, node-pty (ConPTY / CreateProcess) cannot execute .cmd
    // or .bat files directly — wrap them in cmd.exe /c if needed.
    const { file: spawnFile, args: spawnArgs } = windowsCmdWrap(resolved.resolved, args);

    const pty = spawnPty(spawnFile, spawnArgs, {
      name: 'xterm-256color',
      cols: req.cols,
      rows: req.rows,
      cwd: launchCwd,
      env,
    });

    ptys.set(req.tabId, pty);

    const initialPromptForPty = req.initialPrompt?.trim();
    const _cliAgents: AgentId[] = [
      'codex', 'claude-code', 'gemini', 'qwen-code',
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
  ipcMain.handle(IPC.agentInstall,   (event, agentId: AgentId) => runNpmGlobal(event, agentId, 'install',   INSTALL_SPECS[agentId]));
  ipcMain.handle(IPC.agentUpdate,    (event, agentId: AgentId) => runNpmGlobal(event, agentId, 'update',    INSTALL_SPECS[agentId]));
  ipcMain.handle(IPC.agentUninstall, (event, agentId: AgentId) => runNpmGlobal(event, agentId, 'uninstall', INSTALL_SPECS[agentId]));

  // Local service discovery
  ipcMain.handle(IPC.discoverServices, (_e, req: { extraHosts?: string[]; scanSubnet?: boolean } = {}) =>
    discoverLocalServices({ extraHosts: req.extraHosts, scanSubnet: req.scanSubnet }),
  );
  ipcMain.handle(IPC.probeUrl, (_e, url: string) => probeBaseUrl(url));

  // Token usage statistics
  ipcMain.handle(IPC.usageAppend, (_e, record: UsageRecord) => { appendUsage(record); });
  ipcMain.handle(IPC.usageQuery, (_e, filter: UsageFilter = {}) => {
    triggerSessionCacheRefresh();
    const sessionRecords = loadCachedSessionRecords(filter);
    const jsonlRecords = loadUsageRecords(filter).filter((r) => !SESSION_FILE_AGENTS.has(r.agentId));
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
  });

  // Open external URL (https only)
  ipcMain.handle(IPC.openExternal, (_e, url: unknown) => {
    const safe = String(url);
    if (/^https:\/\//.test(safe)) void shell.openExternal(safe);
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
}

// ── App lifecycle ─────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  augmentPath();

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
  killAllPtys();
  if (process.platform !== 'darwin') app.quit();
});
