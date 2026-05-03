import { useCallback, useRef, useState } from 'react';
import type { AgentId, AgentInfo } from '@tday/shared';
import { KEEP_AWAKE_KEY } from '../types/tab';

export interface AgentInstallHook {
  installing: boolean;
  installPct: number;
  installStatus: string;
  installLog: string;
  refreshAgents: (setAgentList: (list: AgentInfo[]) => void) => Promise<boolean>;
  installPi: (setAgentList: (list: AgentInfo[]) => void) => Promise<void>;
  /**
   * Call once after initial agentList + settings are loaded to auto-install if needed.
   * Only attempts to auto-install Pi when it is the configured default agent.
   * Pass `defaultAgentId` so that other agents' startup logic is not affected.
   */
  maybeAutoInstall: (home: string, agentList: AgentInfo[], setAgentList: (list: AgentInfo[]) => void, defaultAgentId?: AgentId) => void;
}

export function useAgentInstall(): AgentInstallHook {
  const [installing, setInstalling] = useState(false);
  const [installPct, setInstallPct] = useState(0);
  const [installStatus, setInstallStatus] = useState('starting');
  const [installLog, setInstallLog] = useState<string>('');
  const checkedRef = useRef(false);

  const refreshAgents = useCallback(async (setAgentList: (list: AgentInfo[]) => void): Promise<boolean> => {
    const list = (await window.tday.listAgents()) as AgentInfo[];
    setAgentList(list);
    return !!(list.find((a: AgentInfo) => a.id === 'pi')?.detect?.available);
  }, []);

  const installPi = useCallback(async (setAgentList: (list: AgentInfo[]) => void): Promise<void> => {
    setInstalling(true);
    setInstallLog('');
    setInstallPct(0);
    setInstallStatus('starting');
    const off = window.tday.onInstallProgress((e) => {
      if (e.agentId !== 'pi') return;
      if (e.kind === 'progress') {
        if (typeof e.percent === 'number') setInstallPct(e.percent);
        if (e.status) setInstallStatus(e.status);
      } else if (e.data) {
        setInstallLog((s) => (s + e.data).slice(-4_000));
      }
      if (e.kind === 'done') {
        setInstallPct(100);
        setInstallStatus('done');
      } else if (e.kind === 'error') {
        setInstallStatus('error');
      }
    });
    try {
      const res = await window.tday.installAgent('pi');
      if (res.ok) await refreshAgents(setAgentList);
    } finally {
      off();
      setTimeout(() => setInstalling(false), 600);
    }
  }, [refreshAgents]);

  const maybeAutoInstall = useCallback((
    home: string,
    agentList: AgentInfo[],
    setAgentList: (list: AgentInfo[]) => void,
    defaultAgentId: AgentId = 'pi',
  ): void => {
    if (checkedRef.current) return;
    if (!home || home === '~') return;
    checkedRef.current = true;

    // If the configured default agent is already available, nothing to do.
    if (agentList.find((a: AgentInfo) => a.id === defaultAgentId)?.detect?.available) return;

    // Only auto-install Pi when Pi is the configured (or implicit) default.
    // If the user has explicitly chosen another agent, respect that and do not
    // touch anything — they should install their chosen agent themselves.
    if (defaultAgentId !== 'pi') return;

    // Even when Pi is the configured default, skip the auto-install if any
    // other agent is already available on the system. initDefaultConfigs()
    // normally handles this on first launch, but guard here too for configs
    // written before this logic was introduced.
    if (agentList.some((a: AgentInfo) => a.detect?.available)) return;

    // Nothing is installed at all: auto-install Pi (the only agent with a
    // fully automated installer inside Tday).
    void installPi(setAgentList);
  }, [installPi]);

  return { installing, installPct, installStatus, installLog, refreshAgents, installPi, maybeAutoInstall };
}

// Re-export for convenience
export { KEEP_AWAKE_KEY };

export type { AgentId, AgentInfo };
