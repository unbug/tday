import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type AgentId,
  type AgentInstallEvent,
  type AgentsConfig,
  type ProvidersConfig,
  type SpawnRequest,
  type PtyDataEvent,
  type PtyExitEvent,
  type DiscoveredService,
  type DiscoverServicesRequest,
  type ProbeUrlResult,
  type UsageRecord,
  type UsageFilter,
  type UsageSummary,
  type TabHistoryEntry,
  type SessionMessage,
  type AgentHistoryEntry,
  type AgentHistoryFilter,
  type CronJob,
  type CronJobStats,
  type CronFireEvent,
  type CoWorker,
} from '@tday/shared';

const api = {
  platform: process.platform,
  homeDir: () => ipcRenderer.invoke(IPC.homeDir) as Promise<string>,
  pickDir: (defaultPath?: string) =>
    ipcRenderer.invoke(IPC.pickDir, defaultPath) as Promise<string | null>,
  pickFile: (opts?: { filters?: { name: string; extensions: string[] }[]; defaultPath?: string }) =>
    ipcRenderer.invoke(IPC.pickFile, opts) as Promise<string | null>,
  listAgents: () => ipcRenderer.invoke(IPC.agentsList),
  saveAgents: (cfg: AgentsConfig) => ipcRenderer.invoke(IPC.agentsSave, cfg),
  listProviders: () => ipcRenderer.invoke(IPC.providersList),
  saveProviders: (cfg: ProvidersConfig) => ipcRenderer.invoke(IPC.providersSave, cfg),
  spawn: (req: SpawnRequest) => ipcRenderer.invoke(IPC.ptySpawn, req),
  write: (tabId: string, data: string) => ipcRenderer.invoke(IPC.ptyWrite, tabId, data),
  resize: (tabId: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC.ptyResize, tabId, cols, rows),
  kill: (tabId: string) => ipcRenderer.invoke(IPC.ptyKill, tabId),
  installAgent: (agentId: AgentId) => ipcRenderer.invoke(IPC.agentInstall, agentId),
  updateAgent: (agentId: AgentId) => ipcRenderer.invoke(IPC.agentUpdate, agentId),
  uninstallAgent: (agentId: AgentId) => ipcRenderer.invoke(IPC.agentUninstall, agentId),
  onData: (cb: (e: PtyDataEvent) => void) => {
    const fn = (_: unknown, e: PtyDataEvent) => cb(e);
    ipcRenderer.on(IPC.ptyData, fn);
    return () => ipcRenderer.off(IPC.ptyData, fn);
  },
  onExit: (cb: (e: PtyExitEvent) => void) => {
    const fn = (_: unknown, e: PtyExitEvent) => cb(e);
    ipcRenderer.on(IPC.ptyExit, fn);
    return () => ipcRenderer.off(IPC.ptyExit, fn);
  },
  onInstallProgress: (cb: (e: AgentInstallEvent) => void) => {
    const fn = (_: unknown, e: AgentInstallEvent) => cb(e);
    ipcRenderer.on(IPC.agentInstallProgress, fn);
    return () => ipcRenderer.off(IPC.agentInstallProgress, fn);
  },
  onTabNew: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('tab:new', fn);
    return () => ipcRenderer.off('tab:new', fn);
  },
  onTabClose: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('tab:close', fn);
    return () => ipcRenderer.off('tab:close', fn);
  },
  onTabRestore: (cb: () => void) => {
    const fn = () => cb();
    ipcRenderer.on('tab:restore', fn);
    return () => ipcRenderer.off('tab:restore', fn);
  },
  // ── Local service discovery ────────────────────────────────────────────────
  discoverServices: (req: DiscoverServicesRequest = {}) =>
    ipcRenderer.invoke(IPC.discoverServices, req) as Promise<DiscoveredService[]>,
  probeUrl: (url: string) =>
    ipcRenderer.invoke(IPC.probeUrl, url) as Promise<ProbeUrlResult>,
  // ── Token usage statistics ─────────────────────────────────────────────────
  appendUsage: (record: UsageRecord) =>
    ipcRenderer.invoke(IPC.usageAppend, record) as Promise<void>,
  queryUsage: (filter: UsageFilter = {}) =>
    ipcRenderer.invoke(IPC.usageQuery, filter) as Promise<UsageSummary>,
  // ── Power management ────────────────────────────────────────────────────────
  powerBlockerStart: () =>
    ipcRenderer.invoke(IPC.powerBlockerStart) as Promise<{ id: number }>,
  powerBlockerStop: (id: number) =>
    ipcRenderer.invoke(IPC.powerBlockerStop, id) as Promise<void>,
  // ── Tab history ─────────────────────────────────────────────────────────────
  listTabHistory: () =>
    ipcRenderer.invoke(IPC.tabHistoryList) as Promise<TabHistoryEntry[]>,
  pushTabHistory: (entry: TabHistoryEntry) =>
    ipcRenderer.invoke(IPC.tabHistoryPush, entry) as Promise<void>,
  deleteTabHistory: (histId: string) =>
    ipcRenderer.invoke(IPC.tabHistoryDelete, histId) as Promise<void>,
  latestAgentSession: (agentId: AgentId, cwd: string) =>
    ipcRenderer.invoke(IPC.latestAgentSession, agentId, cwd) as Promise<string | null>,
  readAgentSession: (agentId: AgentId, sessionId: string, cwd: string) =>
    ipcRenderer.invoke(IPC.readAgentSession, agentId, sessionId, cwd) as Promise<SessionMessage[]>,
  // ── Agent History Session Manager ────────────────────────────────────────────
  listAgentHistory: (filter?: AgentHistoryFilter) =>
    ipcRenderer.invoke(IPC.agentHistoryList, filter) as Promise<AgentHistoryEntry[]>,
  hideAgentHistory: (id: string) =>
    ipcRenderer.invoke(IPC.agentHistoryHide, id) as Promise<void>,
  refreshAgentHistory: () =>
    ipcRenderer.invoke(IPC.agentHistoryRefresh) as Promise<void>,
  // ── App Settings (native persistent storage, replaces localStorage) ──────────
  getAllSettings: () =>
    ipcRenderer.invoke(IPC.settingsGetAll) as Promise<Record<string, unknown>>,
  setSetting: (key: string, value: unknown) =>
    ipcRenderer.invoke(IPC.settingsSet, key, value) as Promise<void>,
  openExternal: (url: string) =>
    ipcRenderer.invoke(IPC.openExternal, url) as Promise<void>,
  // ── CronJob management ──────────────────────────────────────────────────────
  listCronJobs: () =>
    ipcRenderer.invoke(IPC.cronJobsList) as Promise<CronJob[]>,
  saveCronJobs: (jobs: CronJob[]) =>
    ipcRenderer.invoke(IPC.cronJobsSave, jobs) as Promise<void>,
  triggerCronJob: (jobId: string) =>
    ipcRenderer.invoke(IPC.cronJobsTrigger, jobId) as Promise<void>,
  getCronStats: () =>
    ipcRenderer.invoke(IPC.cronJobsGetStats) as Promise<Record<string, CronJobStats>>,
  onCronFired: (cb: (e: CronFireEvent) => void) => {
    const fn = (_: unknown, e: CronFireEvent) => cb(e);
    ipcRenderer.on(IPC.cronJobFired, fn);
    return () => ipcRenderer.off(IPC.cronJobFired, fn);
  },
  // ── CoWorker management ───────────────────────────────────────────────────────
  listCoworkers: () =>
    ipcRenderer.invoke(IPC.coworkerList) as Promise<CoWorker[]>,
  saveCoworker: (coworker: CoWorker) =>
    ipcRenderer.invoke(IPC.coworkerSave, coworker) as Promise<void>,
  deleteCoworker: (id: string) =>
    ipcRenderer.invoke(IPC.coworkerDelete, id) as Promise<void>,
  resetCoworker: (id: string) =>
    ipcRenderer.invoke(IPC.coworkerReset, id) as Promise<void>,
  fetchCoworkerUrl: (url: string) =>
    ipcRenderer.invoke(IPC.coworkerFetchUrl, url) as Promise<string>,
  refreshCoworkerCache: (id: string) =>
    ipcRenderer.invoke(IPC.coworkerRefreshCache, id) as Promise<void>,
  refreshCoworkerRegistry: () =>
    ipcRenderer.invoke(IPC.coworkerRefreshRegistry) as Promise<CoWorker[]>,
};

contextBridge.exposeInMainWorld('tday', api);

export type TdayApi = typeof api;
