import { startTransition, useEffect, useRef, useState } from 'react';
import type { AgentId, AgentInfo, TabHistoryEntry, AgentHistoryEntry, CronFireEvent } from '@tday/shared';
import { Terminal } from './Terminal';
import { Logo } from './Logo';
import { Settings } from './Settings';
import type { TdayApi } from '../../preload';

declare global {
  interface Window {
    tday: TdayApi;
  }
  // Injected by electron-vite at build time from apps/desktop/package.json.
  const __APP_VERSION__: string;
}

interface Tab {
  id: string;
  /**
   * Bumped whenever the tab needs to restart (e.g. cwd commit). The Terminal
   * is keyed on `${id}:${epoch}` so a new mount kills the previous PTY and
   * spawns a fresh one in the new directory.
   */
  epoch: number;
  title: string;
  agentId: AgentId;
  cwd: string;
  /** What's in the cwd input right now — only commits to `cwd` on Enter/Browse. */
  cwdDraft: string;
  /** Agent-native session ID (UUID etc.) — used for --resume / --session on restore. */
  agentSessionId?: string;
  /** If set, sent to the PTY automatically once the agent finishes spawning. */
  initialPrompt?: string;
}

let nextId = 1;
const newTab = (cwd: string, agentId: AgentId = 'pi', title?: string): Tab => ({
  id: `t${nextId++}`,
  epoch: 0,
  title: title ?? agentTitle(agentId),
  agentId,
  cwd,
  cwdDraft: cwd,
});

function agentTitle(id: AgentId): string {
  switch (id) {
    case 'pi':        return 'Pi';
    case 'claude-code': return 'Claude';
    case 'codex':     return 'Codex';
    case 'copilot':   return 'Copilot';
    case 'opencode':  return 'OpenCode';
    case 'gemini':    return 'Gemini';
    case 'qwen-code': return 'Qwen';
    case 'crush':     return 'Crush';
    case 'hermes':    return 'Hermes';
  }
}

// Distinct accent color per agent — used for tab dot + active text
function agentColor(id: AgentId): string {
  switch (id) {
    case 'pi':          return '#a78bfa'; // violet
    case 'claude-code': return '#f97316'; // orange  (Anthropic brand)
    case 'codex':       return '#22d3ee'; // cyan    (OpenAI green-adjacent)
    case 'copilot':     return '#60a5fa'; // blue
    case 'opencode':    return '#34d399'; // emerald
    case 'gemini':      return '#4ade80'; // green   (Google)
    case 'qwen-code':   return '#f472b6'; // pink
    case 'crush':       return '#fb7185'; // rose
    case 'hermes':      return '#fbbf24'; // amber
  }
}

// ── Persistent settings keys ─────────────────────────────────────────────────
// Settings are stored natively at ~/.tday/settings.json via IPC, not in
// localStorage. Keys are kept as-is for backward-compat (migration is done
// automatically when the main process reads from the new store).
const LAST_CWD_KEY = 'tday:lastCwd';
const TABS_STATE_KEY = 'tday:tabs';
const ACTIVE_TAB_KEY = 'tday:activeTab';
const KEEP_AWAKE_KEY = 'tday:keep-awake';
const LOGO_HINTED_KEY = 'tday:logo-menu-hinted';

// Module-level lastCwd cache — populated from settings at startup so sync
// callers (addTab, newTab) always get a value without an async IPC round-trip.
let _lastCwdCache = '';

/** Persisted tab record. Epoch is intentionally dropped — every restored
 *  tab gets a fresh epoch=0 because there's no live PTY to be in sync with. */
interface PersistedTab {
  id: string;
  title: string;
  agentId: AgentId;
  cwd: string;
  agentSessionId?: string;
}

function loadPersistedTabsFromRaw(raw: unknown): PersistedTab[] {
  try {
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).filter(
      (t): t is PersistedTab =>
        !!t && typeof t === 'object' && typeof (t as PersistedTab).id === 'string',
    );
  } catch {
    return [];
  }
}

function savePersistedTabs(tabs: Tab[]): void {
  const data: PersistedTab[] = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    agentId: t.agentId,
    cwd: t.cwd,
    agentSessionId: t.agentSessionId,
  }));
  void window.tday.setSetting(TABS_STATE_KEY, data as unknown as Record<string, unknown>[]);
}

export default function App() {
  const [home, setHome] = useState<string>('~');
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  // Mirror tabs in a ref so closeTab can read current state without stale closures.
  const tabsRef = useRef<Tab[]>([]);
  useEffect(() => { tabsRef.current = tabs; }, [tabs]);  const [installing, setInstalling] = useState(false);
  const [installPct, setInstallPct] = useState(0);
  const [installStatus, setInstallStatus] = useState('starting');
  const [installLog, setInstallLog] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<'providers' | 'agents' | 'usage' | 'history' | 'cron'>('providers');
  // Lazily mount Settings the first time it's opened so its mount effects
  // don't run at app startup (they trigger extra IPC calls).
  const [settingsMounted, setSettingsMounted] = useState(false);
  useEffect(() => { if (settingsOpen) setSettingsMounted(true); }, [settingsOpen]);
  const [keepAwakeId, setKeepAwakeId] = useState<number | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [agentList, setAgentList] = useState<AgentInfo[]>([]);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [tabHistory, setTabHistory] = useState<TabHistoryEntry[]>([]);
  const [agentHistory, setAgentHistory] = useState<AgentHistoryEntry[]>([]);
  const [agentHistoryLoading, setAgentHistoryLoading] = useState(false);
  const [showLogoMenu, setShowLogoMenu] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(false);
  const logoMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoMenuRef = useRef<HTMLDivElement>(null);
  const [showHistorySubmenu, setShowHistorySubmenu] = useState(false);
  const historySubmenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Check for a newer GitHub release. Runs once after 10 s, then every 30 min.
  useEffect(() => {
    const check = () => {
      fetch('https://api.github.com/repos/unbug/tday/releases/latest', { cache: 'no-store' })
        .then((r) => r.json() as Promise<{ tag_name?: string }>)
        .then(({ tag_name }) => {
          if (typeof tag_name === 'string') {
            const remote = tag_name.replace(/^v/, '');
            setHasUpdate(remote !== __APP_VERSION__);
          }
        })
        .catch(() => { /* network unavailable — silently ignore */ });
    };
    const initial = setTimeout(check, 10_000);
    const interval = setInterval(check, 30 * 60_000);
    return () => { clearTimeout(initial); clearInterval(interval); };
  }, []);
  const openLogoMenu = () => {
    if (logoMenuTimer.current) { clearTimeout(logoMenuTimer.current); logoMenuTimer.current = null; }
    setShowLogoMenu(true);
  };
  const closeLogoMenu = () => {
    if (logoMenuTimer.current) clearTimeout(logoMenuTimer.current);
    logoMenuTimer.current = setTimeout(() => {
      setShowLogoMenu(false);
      setShowHistorySubmenu(false);
    }, 500);
  };
  const menuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openMenu = () => {
    if (menuCloseTimer.current) {
      clearTimeout(menuCloseTimer.current);
      menuCloseTimer.current = null;
    }
    setShowAgentMenu(true);
  };
  const scheduleCloseMenu = () => {
    if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current);
    menuCloseTimer.current = setTimeout(() => setShowAgentMenu(false), 500);
  };
  const checkedRef = useRef(false);
  const defaultAgentId: AgentId =
    (agentList.find((a) => a.isDefault)?.id as AgentId | undefined) ?? 'pi';

  const lastCwd = (): string => _lastCwdCache;
  const rememberCwd = (cwd: string) => {
    if (!cwd) return;
    _lastCwdCache = cwd;
    void window.tday.setSetting(LAST_CWD_KEY, cwd);
  };

  useEffect(() => {
    void (async () => {
      // Fetch home dir, agents list, and all persisted settings in parallel.
      const [h, list, settings] = await Promise.all([
        window.tday.homeDir(),
        window.tday.listAgents() as Promise<AgentInfo[]>,
        window.tday.getAllSettings(),
      ]);
      setHome(h);
      setAgentList(list);
      const def = (list.find((a) => a.isDefault)?.id as AgentId | undefined) ?? 'pi';

      // Seed the sync lastCwd cache from persisted settings.
      _lastCwdCache =
        typeof settings[LAST_CWD_KEY] === 'string' ? (settings[LAST_CWD_KEY] as string) : h;

      // Restore previously-open tabs (each spawns a fresh PTY on mount).
      const persisted = loadPersistedTabsFromRaw(settings[TABS_STATE_KEY]);
      if (persisted.length > 0) {
        // Reset the global counter so future tab ids don't collide.
        const max = persisted.reduce((m, t) => {
          const n = Number(t.id.replace(/^t/, '')) || 0;
          return n > m ? n : m;
        }, 0);
        nextId = max + 1;
        const restored: Tab[] = persisted.map((p) => ({
          id: p.id,
          epoch: 0,
          title: p.title,
          agentId: p.agentId,
          cwd: p.cwd,
          cwdDraft: p.cwd,
          agentSessionId: p.agentSessionId,
        }));
        // Restore to the last-active tab, falling back to the first tab.
        const savedActiveTabId =
          typeof settings[ACTIVE_TAB_KEY] === 'string' ? (settings[ACTIVE_TAB_KEY] as string) : null;
        const activeTabId =
          savedActiveTabId && restored.some((t) => t.id === savedActiveTabId)
            ? savedActiveTabId
            : restored[0].id;
        setTabs(restored);
        setActiveId(activeTabId);
      } else {
        const start = _lastCwdCache || h;
        const t = newTab(start, def);
        setTabs([t]);
        setActiveId(t.id);
      }
      // ── Phase 2: deferred work via requestIdleCallback ──────────────────
      // Tabs are now set; everything below is non-critical for first render.
      const idle = (fn: () => void) => {
        if (typeof requestIdleCallback === 'function')
          requestIdleCallback(fn, { timeout: 2000 });
        else setTimeout(fn, 0);
      };
      // Tab history for the quick-access submenu.
      idle(() => {
        void window.tday.listTabHistory().then((h) => setTabHistory(h));
      });
      // Logo hint on first-ever launch.
      if (!settings[LOGO_HINTED_KEY]) {
        idle(() => {
          void window.tday.setSetting(LOGO_HINTED_KEY, true);
          setTimeout(() => {
            setShowLogoMenu(true);
            setTimeout(() => setShowLogoMenu(false), 3500);
          }, 800);
        });
      }
      // Keep Awake restore.
      if (settings[KEEP_AWAKE_KEY] === true) {
        idle(() => {
          void window.tday.powerBlockerStart().then(({ id }) => setKeepAwakeId(id)).catch(() => {});
        });
      }
      // Agent history (heavier I/O, lowest priority).
      idle(() => {
        void window.tday.listAgentHistory().then((h) => setAgentHistory(h));
      });
    })();
  }, []);

  // Persist whenever the tab set / order / cwds change.
  useEffect(() => {
    if (tabs.length > 0) savePersistedTabs(tabs);
  }, [tabs]);

  // Persist the active tab so we can restore it on next launch.
  useEffect(() => {
    if (activeId) void window.tday.setSetting(ACTIVE_TAB_KEY, activeId);
  }, [activeId]);

  // Cmd+T → new tab, Cmd+W → close active tab. The shortcuts are mounted
  // as menu accelerators in the main process (so they don't fight with the
  // default "Close Window" item) and dispatched here via IPC. Stash the
  // live values in a ref so the listener doesn't need to be re-bound on
  // every state change.
  const handlersRef = useRef<{ addTab: () => void; closeTab: (id: string) => void; restoreTab: () => void; activeId: string }>({
    addTab: () => {},
    closeTab: () => {},
    restoreTab: () => {},
    activeId: '',
  });
  useEffect(() => {
    const offNew = window.tday.onTabNew(() => handlersRef.current.addTab());
    const offClose = window.tday.onTabClose(() => {
      const id = handlersRef.current.activeId;
      if (id) handlersRef.current.closeTab(id);
    });
    const offRestore = window.tday.onTabRestore(() => handlersRef.current.restoreTab());
    return () => {
      offNew();
      offClose();
      offRestore();
    };
  }, []);

  // CronJob: when the scheduler fires, open a new tab and send the prompt
  // after a startup grace period so the agent has time to initialise.
  useEffect(() => {
    const offCron = window.tday.onCronFired((e: CronFireEvent) => {
      const t: Tab = {
        id: `t${nextId++}`,
        epoch: 0,
        title: `[Cron] ${e.name}`,
        agentId: e.agentId,
        cwd: e.cwd || home,
        cwdDraft: e.cwd || home,
        initialPrompt: e.prompt,
      };
      setTabs((prev) => [...prev, t]);
      setActiveId(t.id);
    });
    return () => { offCron(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home]);

  const refreshPi = async () => {
    const list = (await window.tday.listAgents()) as AgentInfo[];
    setAgentList(list);
    const pi = list.find((a) => a.id === 'pi');
    return !!pi?.detect?.available;
  };

  const installPi = async () => {
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
      if (res.ok) await refreshPi();
    } finally {
      off();
      setTimeout(() => setInstalling(false), 600);
    }
  };

  useEffect(() => {
    if (checkedRef.current) return;
    if (!home || home === '~') return;
    checkedRef.current = true;
    void (async () => {
      const ok = await refreshPi();
      if (!ok) await installPi();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [home]);

  // Agents that support native session resume.
  const RESUME_CAPABLE: AgentId[] = ['claude-code', 'codex', 'opencode'];

  const closeTab = (id: string) => {
    // Read the tab synchronously from the ref (always current).
    const closing = tabsRef.current.find((t) => t.id === id);

    // Remove the tab from UI immediately.
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

    // Async: discover session ID BEFORE killing so session files are still fresh,
    // then kill the PTY and persist the history entry.
    const saveHistory = async () => {
      let sessionId = closing?.agentSessionId ?? null;
      if (
        closing &&
        !sessionId &&
        RESUME_CAPABLE.includes(closing.agentId) &&
        closing.cwd
      ) {
        // Query the agent's native session while it's still running / just ran.
        sessionId = await window.tday.latestAgentSession(closing.agentId, closing.cwd);
      }
      // Kill AFTER querying so session files are guaranteed flushed.
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

  /** Restore a tab from history. Uses agent's own --resume / --session when available. */
  const restoreTabFromHistory = (entry: TabHistoryEntry) => {
    const t: Tab = {
      id: `t${nextId++}`,
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

  /** Restore a tab from an AgentHistoryEntry (new unified history). */
  const restoreFromAgentHistory = (entry: AgentHistoryEntry) => {
    const t: Tab = {
      id: `t${nextId++}`,
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

  /** Restore the most recently closed tab (Cmd+Shift+T). */
  const restoreTab = () => {
    const [most, ...rest] = tabHistory;
    if (!most) return;
    restoreTabFromHistory(most);
    void window.tday.deleteTabHistory(most.histId).then(() => setTabHistory(rest));
  };

  const addTab = (agentId: AgentId = defaultAgentId) => {
    const t = newTab(lastCwd() || home, agentId);
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
    setShowAgentMenu(false);
  };

  // Keep the keyboard-shortcut ref pointed at the latest handlers.
  handlersRef.current = { addTab, closeTab, restoreTab, activeId };

  // Stage cwd edit; only commit on Enter / Browse / explicit Apply.
  const setTabDraft = (id: string, cwd: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, cwdDraft: cwd } : t)));
  };

  const commitTabCwd = (id: string, cwd: string) => {
    if (!cwd) return;
    rememberCwd(cwd);
    setTabs((prev) =>
      prev.map((t) =>
        t.id === id ? { ...t, cwd, cwdDraft: cwd, epoch: t.epoch + 1 } : t,
      ),
    );
  };

  const browseTabCwd = async (id: string, current: string) => {
    const picked = await window.tday.pickDir(current || home);
    if (picked) commitTabCwd(id, picked);
  };

  // Drag-to-reorder for tabs. Plain HTML5 DnD on the buttons.
  const onDragStart = (id: string) => setDragId(id);
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (overId: string) => {
    if (!dragId || dragId === overId) return setDragId(null);
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === dragId);
      const to = prev.findIndex((t) => t.id === overId);
      if (from < 0 || to < 0) return prev;
      const next = prev.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      // Order is persisted via the savePersistedTabs effect (tabs change triggers it).
      return next;
    });
    setDragId(null);
  };

  const homeShort = (p: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);

  const activeTab = tabs.find((t) => t.id === activeId);
  const cwdDirty = !!activeTab && activeTab.cwdDraft !== activeTab.cwd;

  return (
    <div className="relative flex h-full w-full flex-col bg-[#0a0a0f]">
      {/* Title / tab bar */}
      <div className={`drag flex min-h-11 items-start gap-2 border-b border-zinc-800/60 bg-[#0a0a0f] py-1.5 ${window.tday.platform === 'darwin' ? 'pl-20' : 'pl-4'} pr-4`}>
        <div className="flex flex-1 flex-wrap items-center gap-1">
          {tabs.map((t) => {
            const fullTitle = t.title === agentTitle(t.agentId)
              ? t.title
              : `${agentTitle(t.agentId)}: ${t.title}`;
            return (
              <button
                key={t.id}
                onClick={() => setActiveId(t.id)}
                draggable
                onDragStart={() => onDragStart(t.id)}
                onDragOver={onDragOver}
                onDrop={() => onDrop(t.id)}
                onDragEnd={() => setDragId(null)}
                className={`no-drag group inline-flex items-center gap-2 rounded-md px-3 py-1 text-xs ${
                  t.id === activeId
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-900'
                } ${dragId === t.id ? 'opacity-50' : ''}`}
              >
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: agentColor(t.agentId) }}
                />
                <span title={fullTitle} className="max-w-[160px] overflow-hidden whitespace-nowrap">
                  {fullTitle}
                </span>
                <span
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(t.id);
                  }}
                  className="rounded px-1 text-zinc-500 opacity-0 hover:bg-zinc-700 hover:text-zinc-100 group-hover:opacity-100"
                >
                  ×
                </span>
              </button>
            );
          })}
          {/* Split new-tab button: click body opens the default agent.
              Hovering the chevron (or the wrapper) auto-opens the picker so the
              user doesn't have to click twice. A short close delay keeps
              the menu open while the cursor crosses the gap to it. */}
          <div
            className="relative no-drag ml-1 inline-flex items-stretch"
            onMouseEnter={openMenu}
            onMouseLeave={scheduleCloseMenu}
          >
            <button
              onClick={() => addTab()}
              className="rounded-md px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              title={`New ${agentTitle(defaultAgentId)} tab (hover to pick agent)`}
            >
              +
            </button>
            {showAgentMenu ? (
              <div
                className="no-drag absolute left-0 top-full z-30 min-w-[180px] pt-1"
                onMouseEnter={openMenu}
                onMouseLeave={scheduleCloseMenu}
              >
                <div className="rounded-md border border-zinc-800 bg-zinc-950 py-1 text-xs shadow-xl">
                {(
                  [
                    'pi',
                    'claude-code',
                    'codex',
                    'copilot',
                    'opencode',
                    'gemini',
                    'qwen-code',
                    'crush',
                    'hermes',
                  ] as AgentId[]
                ).map((id) => {
                  const info = agentList.find((a) => a.id === id);
                  const installed = !!info?.detect.available;
                  return (
                    <button
                      key={id}
                      disabled={!installed}
                      onClick={() => addTab(id)}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left ${
                        installed
                          ? 'text-zinc-200 hover:bg-zinc-800'
                          : 'cursor-not-allowed text-zinc-600'
                      }`}
                    >
                      <span>{agentTitle(id)}</span>
                      <span className="ml-3 text-[10px] text-zinc-500">
                        {id === defaultAgentId ? 'default' : installed ? '' : 'not installed'}
                      </span>
                    </button>
                  );
                })}
                <div className="my-1 border-t border-zinc-800/60" />
                <button
                  onClick={() => { setShowAgentMenu(false); startTransition(() => { setSettingsSection('agents'); setSettingsOpen(true); }); }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span>Manage Agents…</span>
                </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
        {/* ── Logo menu: history + keep-awake + settings ── */}
        <div
          ref={logoMenuRef}
          className="no-drag relative ml-2 flex items-center"
          onMouseEnter={openLogoMenu}
          onMouseLeave={closeLogoMenu}
        >
          {/* Logo trigger — hover opens menu, click also toggles */}
          <button
            onClick={() => setShowLogoMenu((v) => !v)}
            className="no-drag group relative flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-zinc-900"
            aria-label="Tday menu"
          >
            {/* Gear icon */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="text-zinc-600 transition-colors group-hover:text-zinc-400">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            {hasUpdate && (
              <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-400 ring-1 ring-[#0a0a0f]" />
            )}
            {window.tday.platform !== 'win32' && <Logo size={24} />}
          </button>

          {/* Dropdown */}
          {showLogoMenu && (
            <div
              className="no-drag absolute right-0 top-full z-30 pt-1"
              onMouseEnter={openLogoMenu}
              onMouseLeave={closeLogoMenu}
            >
              <div className="min-w-[200px] rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-2xl text-xs">
                {/* History — hover to see submenu */}
                <div
                  className="relative"
                  onMouseEnter={() => {
                    if (historySubmenuTimer.current) { clearTimeout(historySubmenuTimer.current); historySubmenuTimer.current = null; }
                    setShowHistorySubmenu(true);
                  }}
                  onMouseLeave={() => {
                    if (historySubmenuTimer.current) clearTimeout(historySubmenuTimer.current);
                    historySubmenuTimer.current = setTimeout(() => setShowHistorySubmenu(false), 350);
                  }}
                >
                  <button className={`flex w-full cursor-pointer items-center gap-3 px-3 py-2 text-left text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100 ${showHistorySubmenu ? 'bg-zinc-800 text-zinc-100' : ''}`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zinc-500">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span className="flex-1">History</span>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-zinc-600">
                      <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-90 5 5)" />
                    </svg>
                  </button>

                  {/* History submenu — opens to the left */}
                  {showHistorySubmenu && (
                    <div
                      className="no-drag absolute right-full top-0 pr-3"
                      onMouseEnter={() => {
                        if (historySubmenuTimer.current) { clearTimeout(historySubmenuTimer.current); historySubmenuTimer.current = null; }
                      }}
                      onMouseLeave={() => {
                        if (historySubmenuTimer.current) clearTimeout(historySubmenuTimer.current);
                        historySubmenuTimer.current = setTimeout(() => setShowHistorySubmenu(false), 350);
                      }}
                    >
                      <div className="w-80 rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-2xl text-xs">
                        {agentHistoryLoading ? (
                          <div className="px-3 py-3 text-center text-zinc-600">Loading…</div>
                        ) : agentHistory.length === 0 ? (
                          <div className="px-3 py-3 text-center text-zinc-600">No history</div>
                        ) : (
                          <>
                            {agentHistory.slice(0, 12).map((entry) => (
                              <button
                                key={entry.id}
                                onClick={() => {
                                  restoreFromAgentHistory(entry);
                                  setShowHistorySubmenu(false);
                                  setShowLogoMenu(false);
                                }}
                                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-800"
                              >
                                <span
                                  className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                                  style={{ background: agentColor(entry.agentId as import('@tday/shared').AgentId) }}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="shrink-0 text-[10px] font-medium" style={{ color: agentColor(entry.agentId as import('@tday/shared').AgentId) }}>{agentTitle(entry.agentId as import('@tday/shared').AgentId)}</span>
                                    <span className="truncate text-zinc-200">{entry.title}</span>
                                  </div>
                                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-600">
                                    <span className="min-w-0 flex-1 truncate" title={entry.cwd}>{entry.cwd.replace(/^.*[/\\](.+[/\\].+)$/, '…/$1').replace(/\\/g, '/')}</span>
                                    <span className="shrink-0">
                                      {new Date(entry.updatedAt).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                  </div>
                                </div>
                              </button>
                            ))}
                            {agentHistory.length > 12 && (
                              <div className="px-3 py-1 text-center text-zinc-600">
                                +{agentHistory.length - 12} more
                              </div>
                            )}
                          </>
                        )}
                        <div className="my-1 border-t border-zinc-800/60" />
                        <button
                          onClick={() => {
                            startTransition(() => { setSettingsOpen(true); setSettingsSection('history'); });
                            setShowLogoMenu(false);
                            setShowHistorySubmenu(false);
                          }}
                          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                        >
                          <span className="flex-1">Show all…</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {/* Keep Awake */}
                <button
                  onClick={async () => {
                    if (keepAwakeId !== null) {
                      await window.tday.powerBlockerStop(keepAwakeId);
                      setKeepAwakeId(null);
                      void window.tday.setSetting(KEEP_AWAKE_KEY, false);
                    } else {
                      const { id } = await window.tday.powerBlockerStart();
                      setKeepAwakeId(id);
                      void window.tday.setSetting(KEEP_AWAKE_KEY, true);
                    }
                  }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill={keepAwakeId !== null ? 'currentColor' : 'none'} stroke={keepAwakeId !== null ? 'none' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 ${keepAwakeId !== null ? 'text-amber-400' : 'text-zinc-500'}`}>
                    <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
                  </svg>
                  <span className="flex-1">Keep Awake</span>
                  <span className={`text-[10px] rounded px-1.5 py-0.5 ${
                    keepAwakeId !== null
                      ? 'bg-amber-400/20 text-amber-300'
                      : 'bg-zinc-800 text-zinc-500'
                  }`}>
                    {keepAwakeId !== null ? 'ON' : 'OFF'}
                  </span>
                </button>

                <div className="my-1 border-t border-zinc-800/60" />

                {/* Usage shortcut */}
                <button
                  onClick={() => { setShowLogoMenu(false); startTransition(() => { setSettingsSection('usage'); setSettingsOpen(true); }); }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zinc-500">
                    <line x1="18" y1="20" x2="18" y2="10" />
                    <line x1="12" y1="20" x2="12" y2="4" />
                    <line x1="6" y1="20" x2="6" y2="14" />
                  </svg>
                  <span className="flex-1">Usage</span>
                </button>

                {/* Settings */}
                <button
                  onClick={() => { setShowLogoMenu(false); startTransition(() => { setSettingsSection('providers'); setSettingsOpen(true); }); }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zinc-500">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span className="flex-1">Settings</span>
                  <span className="text-[10px] text-zinc-600">⌘,</span>
                </button>

                {/* GitHub + Version */}
                <div className="border-t border-zinc-800/60 px-1 pb-1 pt-1">
                  <button
                    onClick={() => void window.tday.openExternal('https://github.com/unbug/tday')}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
                    </svg>
                    <span className="flex-1">GitHub</span>
                  </button>
                  <button
                    onClick={() => void window.tday.openExternal('https://github.com/unbug/tday/releases')}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                      <polyline points="16 3 21 3 21 8" /><line x1="4" y1="20" x2="21" y2="3" />
                    </svg>
                    <span className="flex-1 font-mono">v{__APP_VERSION__}</span>
                    {hasUpdate && <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Install overlay */}
      {installing && (
        <div className="no-drag border-b border-zinc-800/60 bg-zinc-950/90 px-4 py-2 text-xs text-zinc-300">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-fuchsia-400" />
            <span>installing @mariozechner/pi-coding-agent</span>
            <span className="text-zinc-500">· {installStatus}</span>
            <span className="ml-auto font-mono text-zinc-400">{installPct}%</span>
          </div>
          <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
            <div
              className="h-full bg-gradient-to-r from-fuchsia-500 to-sky-400 transition-all duration-300"
              style={{ width: `${Math.max(2, Math.min(100, installPct))}%` }}
            />
          </div>
          {installLog ? (
            <pre className="mt-1 max-h-12 overflow-hidden font-mono text-[10px] text-zinc-600">
              {installLog.split('\n').slice(-3).join('\n')}
            </pre>
          ) : null}
        </div>
      )}

      <div className="relative flex flex-1 flex-col gap-2 p-3">
        {/* Per-tab CWD bar */}
        {activeTab ? (
          <div className="no-drag flex items-center gap-2 rounded-md border border-zinc-800/60 bg-zinc-900/40 px-3 py-1.5 text-[11px] text-zinc-300">
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="shrink-0 text-zinc-500"
            >
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span className="text-[10px] uppercase tracking-wider text-zinc-500">cwd</span>
            <input
              key={activeTab.id}
              className="flex-1 border-none bg-transparent text-zinc-100 outline-none placeholder:text-zinc-600"
              value={activeTab.cwdDraft}
              onChange={(e) => setTabDraft(activeTab.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitTabCwd(activeTab.id, activeTab.cwdDraft);
                if (e.key === 'Escape') setTabDraft(activeTab.id, activeTab.cwd);
              }}
              spellCheck={false}
              placeholder={home}
            />
            <span className="hidden text-zinc-500 sm:inline">{homeShort(activeTab.cwd)}</span>
            {cwdDirty ? (
              <button
                onClick={() => commitTabCwd(activeTab.id, activeTab.cwdDraft)}
                className="rounded bg-fuchsia-500/90 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-fuchsia-500"
                title="Apply (restarts the tab)"
              >
                Apply ↵
              </button>
            ) : null}
            <button
              onClick={() => browseTabCwd(activeTab.id, activeTab.cwdDraft)}
              className="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
              title="Choose folder"
            >
              Browse…
            </button>
          </div>
        ) : null}

        <div className="border-beam relative flex-1 overflow-hidden rounded-xl bg-black">
          <div className="absolute inset-[3px] overflow-hidden rounded-[10px] bg-black">
            {/* Render active tab first so its useEffect / PTY spawn gets
                first IPC priority on startup. */}
            {[...tabs].sort((a) => (a.id === activeId ? -1 : 0)).map((t) => (
              <div
                key={t.id}
                className="h-full w-full"
                style={{ display: t.id === activeId ? 'block' : 'none' }}
              >
                <Terminal
                  // restart whenever epoch bumps (cwd commit)
                  key={`${t.id}:${t.epoch}`}
                  tabId={t.id}
                  agentId={t.agentId}
                  cwd={t.cwd}
                  active={t.id === activeId}
                  agentSessionId={t.agentSessionId}
                  initialPrompt={t.initialPrompt}
                  onAgentSessionId={(id) => {
                    setTabs((prev) =>
                      prev.map((tab) =>
                        tab.id === t.id ? { ...tab, agentSessionId: id ?? undefined } : tab,
                      ),
                    );
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {settingsMounted && <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection={settingsSection}
        home={home}
        onSaved={() => {
          // Refresh agent list so default-agent / install-state changes take
          // effect on the next "+" click without an app restart.
          void refreshPi();
        }}
        agentHistory={agentHistory}
        agentHistoryLoading={agentHistoryLoading}
        onRestoreHistory={(entry) => {
          restoreFromAgentHistory(entry);
          setSettingsOpen(false);
        }}
        onHideHistory={(id) => {
          void window.tday.hideAgentHistory(id).then(() => {
            setAgentHistory((prev) => prev.filter((e) => e.id !== id));
          });
        }}
      />}
    </div>
  );
}
