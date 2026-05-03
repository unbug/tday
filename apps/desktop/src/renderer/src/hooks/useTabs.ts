import { useEffect, useRef, useState } from 'react';
import type { AgentId, AgentHistoryEntry, CronFireEvent, TabHistoryEntry } from '@tday/shared';
import {
  type Tab,
  type PersistedTab,
  newTab,
  resetTabCounter,
  savePersistedTabs,
  ACTIVE_TAB_KEY,
  RESUME_CAPABLE,
} from '../types/tab';

export interface TabsHook {
  tabs: Tab[];
  activeId: string;
  setActiveId: (id: string) => void;
  tabHistory: TabHistoryEntry[];
  agentHistory: AgentHistoryEntry[];
  agentHistoryLoading: boolean;
  dragId: string | null;
  closeTab: (id: string) => void;
  addTab: (agentId?: AgentId, home?: string) => void;
  restoreTab: () => void;
  restoreTabFromHistory: (entry: TabHistoryEntry) => void;
  restoreFromAgentHistory: (entry: AgentHistoryEntry) => void;
  setTabDraft: (id: string, cwd: string) => void;
  commitTabCwd: (id: string, cwd: string) => void;
  browseTabCwd: (id: string, current: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (overId: string) => void;
  onDragEnd: () => void;
  setLastCwd: (cwd: string) => void;
  updateTabSessionId: (tabId: string, sessionId: string | null) => void;
  setTabCoworker: (id: string, coworkerId: string | undefined) => void;
  removeFromAgentHistory: (id: string) => void;
  initTabs: (persisted: PersistedTab[], savedActiveId: string | null, fallbackCwd: string, defaultAgentId: AgentId) => void;
  loadDeferredData: (logoHinted: boolean, keepAwake: boolean, onLogoHint: () => void, onKeepAwake: () => void) => void;
}

export function useTabs(home: string, defaultAgentId: AgentId): TabsHook {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const tabsRef = useRef<Tab[]>([]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);

  const [tabHistory, setTabHistory] = useState<TabHistoryEntry[]>([]);
  const [agentHistory, setAgentHistory] = useState<AgentHistoryEntry[]>([]);
  const [agentHistoryLoading, setAgentHistoryLoading] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);

  const lastCwdRef = useRef<string>('');
  const setLastCwd = (cwd: string) => { lastCwdRef.current = cwd; };
  const lastCwd = () => lastCwdRef.current;

  const rememberCwd = (cwd: string) => {
    if (!cwd) return;
    lastCwdRef.current = cwd;
    void window.tday.setSetting('tday:lastCwd', cwd);
  };

  // Stash live handlers in a ref for IPC listeners
  const handlersRef = useRef<{
    addTab: () => void;
    closeTab: (id: string) => void;
    restoreTab: () => void;
    activeId: string;
  }>({ addTab: () => {}, closeTab: () => {}, restoreTab: () => {}, activeId: '' });

  // ── IPC keyboard shortcut listeners ─────────────────────────────────────────
  useEffect(() => {
    const offNew     = window.tday.onTabNew(()     => handlersRef.current.addTab());
    const offClose   = window.tday.onTabClose(()   => { const id = handlersRef.current.activeId; if (id) handlersRef.current.closeTab(id); });
    const offRestore = window.tday.onTabRestore(() => handlersRef.current.restoreTab());
    return () => { offNew(); offClose(); offRestore(); };
  }, []);

  // ── CronJob listener ─────────────────────────────────────────────────────────
  useEffect(() => {
    const offCron = window.tday.onCronFired((e: CronFireEvent) => {
      const t: Tab = {
        id: `t${Date.now()}`,
        epoch: 0,
        title: `[Cron] ${e.name}`,
        agentId: e.agentId,
        cwd: e.cwd || home,
        cwdDraft: e.cwd || home,
        initialPrompt: e.prompt,
        isCronJob: true,
      };
      setTabs((prev) => [...prev, t]);
      setActiveId(t.id);
    });
    return () => { offCron(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home]);

  // ── Persist tabs whenever they change ────────────────────────────────────────
  useEffect(() => {
    if (tabs.length > 0) savePersistedTabs(tabs);
  }, [tabs]);

  useEffect(() => {
    if (activeId) void window.tday.setSetting(ACTIVE_TAB_KEY, activeId);
  }, [activeId]);

  // ── Tab actions ───────────────────────────────────────────────────────────────

  const closeTab = (id: string) => {
    const closing = tabsRef.current.find((t) => t.id === id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const t = newTab(lastCwd() || home, defaultAgentId);
        setActiveId(t.id);
        return [t];
      }
      if (activeId === id) setActiveId(next[next.length - 1].id);
      return next;
    });

    const saveHistory = async () => {
      let sessionId = closing?.agentSessionId ?? null;
      if (closing && !sessionId && RESUME_CAPABLE.includes(closing.agentId) && closing.cwd) {
        sessionId = await window.tday.latestAgentSession(closing.agentId, closing.cwd);
      }
      void window.tday.kill(id);
      if (closing) {
        const entry: TabHistoryEntry = {
          histId: `${id}-${Date.now()}`,
          title: closing.title,
          agentId: closing.agentId,
          cwd: closing.cwd,
          closedAt: Date.now(),
          agentSessionId: sessionId ?? undefined,
        };
        await window.tday.pushTabHistory(entry);
        const updated = await window.tday.listTabHistory();
        setTabHistory(updated);
      }
    };
    void saveHistory();
  };

  const addTab = (agentId: AgentId = defaultAgentId, _home?: string) => {
    const t = newTab(lastCwd() || _home || home, agentId);
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
  };

  const restoreTabFromHistory = (entry: TabHistoryEntry) => {
    const t: Tab = {
      id: `t${Date.now()}`,
      epoch: 0,
      title: entry.title,
      agentId: entry.agentId,
      cwd: entry.cwd,
      cwdDraft: entry.cwd,
      agentSessionId: entry.agentSessionId,
    };
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
  };

  const restoreFromAgentHistory = (entry: AgentHistoryEntry) => {
    const t: Tab = {
      id: `t${Date.now()}`,
      epoch: 0,
      title: entry.title,
      agentId: (entry.agentId as AgentId) ?? 'pi',
      cwd: entry.cwd || home,
      cwdDraft: entry.cwd || home,
      agentSessionId: entry.sessionId,
    };
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
  };

  const restoreTab = () => {
    const [most, ...rest] = tabHistory;
    if (!most) return;
    restoreTabFromHistory(most);
    void window.tday.deleteTabHistory(most.histId).then(() => setTabHistory(rest));
  };

  const setTabDraft = (id: string, cwd: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, cwdDraft: cwd } : t)));
  };

  const commitTabCwd = (id: string, cwd: string) => {
    if (!cwd) return;
    rememberCwd(cwd);
    setTabs((prev) =>
      prev.map((t) => t.id === id ? { ...t, cwd, cwdDraft: cwd, epoch: t.epoch + 1 } : t),
    );
  };

  const browseTabCwd = async (id: string, current: string) => {
    const picked = await window.tday.pickDir(current || home);
    if (picked) commitTabCwd(id, picked);
  };

  const updateTabSessionId = (tabId: string, sessionId: string | null) => {
    setTabs((prev) =>
      prev.map((t) => t.id === tabId ? { ...t, agentSessionId: sessionId ?? undefined } : t),
    );
  };

  const removeFromAgentHistory = (id: string) => {
    setAgentHistory((prev) => prev.filter((e) => e.id !== id));
  };

  const setTabCoworker = (id: string, coworkerId: string | undefined) => {
    setTabs((prev) => prev.map((t) => t.id === id ? { ...t, coworkerId } : t));
  };

  // ── Drag-to-reorder ───────────────────────────────────────────────────────────
  const onDragStart = (id: string) => setDragId(id);
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };
  const onDrop = (overId: string) => {
    if (!dragId || dragId === overId) return setDragId(null);
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === dragId);
      const to = prev.findIndex((t) => t.id === overId);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setDragId(null);
  };
  const onDragEnd = () => setDragId(null);

  // ── Init from persisted settings (called by App.tsx startup effect) ───────────
  const initTabs = (
    persisted: PersistedTab[],
    savedActiveId: string | null,
    fallbackCwd: string,
    initDefaultAgentId: AgentId,
  ) => {
    if (persisted.length > 0) {
      const max = persisted.reduce((m, t) => {
        const n = Number(t.id.replace(/^t/, '')) || 0;
        return n > m ? n : m;
      }, 0);
      resetTabCounter(max + 1);
      const restored: Tab[] = persisted.map((p) => ({
        id: p.id, epoch: 0, title: p.title, agentId: p.agentId,
        cwd: p.cwd, cwdDraft: p.cwd, agentSessionId: p.agentSessionId,
      }));
      const activeTabId =
        savedActiveId && restored.some((t) => t.id === savedActiveId)
          ? savedActiveId
          : restored[0].id;
      setTabs(restored);
      setActiveId(activeTabId);
    } else {
      const t = newTab(fallbackCwd, initDefaultAgentId);
      setTabs([t]);
      setActiveId(t.id);
    }
  };

  const loadDeferredData = (
    logoHinted: boolean,
    keepAwake: boolean,
    onLogoHint: () => void,
    onKeepAwake: () => void,
  ) => {
    const idle = (fn: () => void) => {
      if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
      else setTimeout(fn, 0);
    };
    idle(() => { void window.tday.listTabHistory().then((h) => setTabHistory(h)); });
    if (!logoHinted) {
      idle(() => {
        void window.tday.setSetting('tday:logo-menu-hinted', true);
        onLogoHint();
      });
    }
    if (keepAwake) {
      idle(onKeepAwake);
    }
    idle(() => {
      setAgentHistoryLoading(true);
      void window.tday.listAgentHistory().then((h) => {
        setAgentHistory(h);
        setAgentHistoryLoading(false);
      });
    });
  };

  // Keep handlersRef up-to-date
  handlersRef.current = { addTab, closeTab, restoreTab, activeId };

  return {
    tabs, activeId, setActiveId,
    tabHistory, agentHistory, agentHistoryLoading,
    dragId,
    closeTab, addTab, restoreTab, restoreTabFromHistory, restoreFromAgentHistory,
    setTabDraft, commitTabCwd, browseTabCwd, updateTabSessionId, setTabCoworker, removeFromAgentHistory,
    onDragStart, onDragOver, onDrop, onDragEnd,
    setLastCwd, initTabs, loadDeferredData,
  };
}
