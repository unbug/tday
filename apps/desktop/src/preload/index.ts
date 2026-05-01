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
} from '@tday/shared';

const api = {
  homeDir: () => ipcRenderer.invoke(IPC.homeDir) as Promise<string>,
  pickDir: (defaultPath?: string) =>
    ipcRenderer.invoke(IPC.pickDir, defaultPath) as Promise<string | null>,
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
};

contextBridge.exposeInMainWorld('tday', api);

export type TdayApi = typeof api;
