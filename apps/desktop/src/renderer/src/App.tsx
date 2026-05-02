import { useEffect, useRef, useState } from 'react';
import type { AgentId, AgentInfo, TabHistoryEntry } from '@tday/shared';
import { Terminal } from './Terminal';
import { Logo } from './Logo';
import { Settings } from './Settings';
import { HistoryPanel } from './HistoryPanel';
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

const LAST_CWD_KEY = 'tday:lastCwd';
const TABS_ORDER_KEY = 'tday:tabsOrder';
const TABS_STATE_KEY = 'tday:tabs';

/** Persisted tab record. Epoch is intentionally dropped — every restored
 *  tab gets a fresh epoch=0 because there's no live PTY to be in sync with. */
interface PersistedTab {
  id: string;
  title: string;
  agentId: AgentId;
  cwd: string;
  agentSessionId?: string;
}

function loadPersistedTabs(): PersistedTab[] {
  try {
    const raw = localStorage.getItem(TABS_STATE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is PersistedTab =>
        !!t && typeof t === 'object' && typeof (t as PersistedTab).id === 'string',
    );
  } catch {
    return [];
  }
}

function savePersistedTabs(tabs: Tab[]): void {
  try {
    const data: PersistedTab[] = tabs.map((t) => ({
      id: t.id,
      title: t.title,
      agentId: t.agentId,
      cwd: t.cwd,
      agentSessionId: t.agentSessionId,
    }));
    localStorage.setItem(TABS_STATE_KEY, JSON.stringify(data));
  } catch {
    // quota / storage disabled — ignore
  }
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
  const [settingsSection, setSettingsSection] = useState<'providers' | 'agents' | 'usage'>('providers');
  const [keepAwakeId, setKeepAwakeId] = useState<number | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [agentList, setAgentList] = useState<AgentInfo[]>([]);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [tabHistory, setTabHistory] = useState<TabHistoryEntry[]>([]);
  const [showLogoMenu, setShowLogoMenu] = useState(false);
  const logoMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoMenuRef = useRef<HTMLDivElement>(null);
  const [showHistorySubmenu, setShowHistorySubmenu] = useState(false);
  const historySubmenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openLogoMenu = () => {
    if (logoMenuTimer.current) { clearTimeout(logoMenuTimer.current); logoMenuTimer.current = null; }
    setShowLogoMenu(true);
  };
  const closeLogoMenu = () => {
    if (logoMenuTimer.current) clearTimeout(logoMenuTimer.current);
    logoMenuTimer.current = setTimeout(() => {
      setShowLogoMenu(false);
      setShowHistorySubmenu(false);
    }, 260);
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
    menuCloseTimer.current = setTimeout(() => setShowAgentMenu(false), 220);
  };
  const checkedRef = useRef(false);
  const defaultAgentId: AgentId =
    (agentList.find((a) => a.isDefault)?.id as AgentId | undefined) ?? 'pi';

  const lastCwd = (): string => {
    try {
      return localStorage.getItem(LAST_CWD_KEY) || '';
    } catch {
      return '';
    }
  };
  const rememberCwd = (cwd: string) => {
    try {
      if (cwd) localStorage.setItem(LAST_CWD_KEY, cwd);
    } catch {
      // ignore quota errors
    }
  };

  useEffect(() => {
    void (async () => {
      const h = await window.tday.homeDir();
      setHome(h);
      // Pull defaults so newly-created tabs use the configured default agent.
      const list = (await window.tday.listAgents()) as AgentInfo[];
      setAgentList(list);
      const def = (list.find((a) => a.isDefault)?.id as AgentId | undefined) ?? 'pi';
      // Restore previously-open tabs (each spawns a fresh PTY on mount).
      const persisted = loadPersistedTabs();
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
        setTabs(restored);
        setActiveId(restored[0].id);
      } else {
        const start = lastCwd() || h;
        const t = newTab(start, def);
        setTabs([t]);
        setActiveId(t.id);
      }
      // Load tab history for the history panel.
      const hist = await window.tday.listTabHistory();
      setTabHistory(hist);
      // Briefly show the logo menu on first-ever launch so users discover it.
      const seenKey = 'tday:logo-menu-hinted';
      if (!localStorage.getItem(seenKey)) {
        localStorage.setItem(seenKey, '1');
        setTimeout(() => {
          setShowLogoMenu(true);
          setTimeout(() => setShowLogoMenu(false), 3500);
        }, 800);
      }
    })();
  }, []);

  // Persist whenever the tab set / order / cwds change.
  useEffect(() => {
    if (tabs.length > 0) savePersistedTabs(tabs);
  }, [tabs]);

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
      try {
        localStorage.setItem(TABS_ORDER_KEY, JSON.stringify(next.map((t) => t.id)));
      } catch {
        // ignore
      }
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
          {tabs.map((t) => (
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
              {t.title}
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
          ))}
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
                className="absolute left-0 top-full z-30 min-w-[180px] pt-2"
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
                  onClick={() => { setShowAgentMenu(false); setSettingsSection('agents'); setSettingsOpen(true); }}
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
            className="no-drag group flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-zinc-900"
            aria-label="Tday menu"
          >
            {/* Gear icon */}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className="text-zinc-600 transition-colors group-hover:text-zinc-400">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <Logo size={24} />
          </button>

          {/* Dropdown */}
          {showLogoMenu && (
            <div
              className="absolute right-0 top-full z-30 pt-1.5"
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
                    historySubmenuTimer.current = setTimeout(() => setShowHistorySubmenu(false), 180);
                  }}
                >
                  <div className={`flex w-full cursor-default items-center gap-3 px-3 py-2 text-left text-zinc-300 ${showHistorySubmenu ? 'bg-zinc-800 text-zinc-100' : 'hover:bg-zinc-800 hover:text-zinc-100'}`}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zinc-500">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                    <span className="flex-1">History</span>
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="text-zinc-600">
                      <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" transform="rotate(-90 5 5)" />
                    </svg>
                  </div>

                  {/* History submenu — opens to the left */}
                  {showHistorySubmenu && (
                    <div
                      className="absolute right-full top-0 pr-1"
                      onMouseEnter={() => {
                        if (historySubmenuTimer.current) { clearTimeout(historySubmenuTimer.current); historySubmenuTimer.current = null; }
                      }}
                      onMouseLeave={() => {
                        if (historySubmenuTimer.current) clearTimeout(historySubmenuTimer.current);
                        historySubmenuTimer.current = setTimeout(() => setShowHistorySubmenu(false), 180);
                      }}
                    >
                      <div className="w-80 rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-2xl text-xs">
                        {tabHistory.length === 0 ? (
                          <div className="px-3 py-3 text-center text-zinc-600">No closed tabs</div>
                        ) : (
                          <>
                            {tabHistory.slice(0, 15).map((entry) => (
                              <button
                                key={entry.histId}
                                onClick={() => {
                                  restoreTabFromHistory(entry);
                                  void window.tday.deleteTabHistory(entry.histId).then(() =>
                                    setTabHistory((prev) => prev.filter((e) => e.histId !== entry.histId))
                                  );
                                  setShowHistorySubmenu(false);
                                  setShowLogoMenu(false);
                                }}
                                className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-800"
                              >
                                <span
                                  className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                                  style={{ background: agentColor(entry.agentId) }}
                                />
                                <div className="min-w-0 flex-1">
                                  <div className="flex items-center gap-1.5">
                                    <span className="shrink-0 text-[10px] font-medium" style={{ color: agentColor(entry.agentId) }}>{agentTitle(entry.agentId)}</span>
                                    <span className="truncate text-zinc-200">{entry.title}</span>
                                  </div>
                                  <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-600">
                                    <span className="min-w-0 flex-1 truncate" title={entry.cwd}>{entry.cwd.replace(/^.*[\/\\](.+[\/\\].+)$/, '…/$1').replace(/\\/g, '/')}</span>
                                    <span className="shrink-0">
                                      {(() => {
                                        const diff = Date.now() - entry.closedAt;
                                        const m = Math.floor(diff / 60000);
                                        if (m < 1) return 'just now';
                                        if (m < 60) return `${m}m ago`;
                                        const h = Math.floor(m / 60);
                                        if (h < 24) return `${h}h ago`;
                                        return `${Math.floor(h / 24)}d ago`;
                                      })()}
                                    </span>
                                  </div>
                                </div>
                              </button>
                            ))}
                            {tabHistory.length > 12 && (
                              <div className="px-3 py-1 text-center text-zinc-600">
                                +{tabHistory.length - 12} more
                              </div>
                            )}
                            <div className="my-1 border-t border-zinc-800/60" />
                            <button
                              onClick={() => { setShowHistoryPanel(true); setShowLogoMenu(false); setShowHistorySubmenu(false); }}
                              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                            >
                              <span className="flex-1">Show all…</span>
                            </button>
                          </>
                        )}
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
                    } else {
                      const { id } = await window.tday.powerBlockerStart();
                      setKeepAwakeId(id);
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
                  onClick={() => { setSettingsSection('usage'); setSettingsOpen(true); setShowLogoMenu(false); }}
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
                  onClick={() => { setSettingsSection('providers'); setSettingsOpen(true); setShowLogoMenu(false); }}
                  className="flex w-full items-center gap-3 px-3 py-2 text-left text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zinc-500">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  <span className="flex-1">Settings</span>
                  <span className="text-[10px] text-zinc-600">⌘,</span>
                </button>

                {/* Version */}
                <div className="px-3 pb-1 pt-0.5 text-[10px] text-zinc-600 select-text">
                  Tday v{__APP_VERSION__}
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
            {tabs.map((t) => (
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

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        initialSection={settingsSection}
        onSaved={() => {
          // Refresh agent list so default-agent / install-state changes take
          // effect on the next "+" click without an app restart.
          void refreshPi();
        }}
      />
      {showHistoryPanel && (
        <HistoryPanel
          entries={tabHistory}
          onRestore={(entry) => {
            restoreTabFromHistory(entry);
            // Keep history entry so user can restore again; they can delete manually.
          }}
          onDelete={(histId) => {
            void window.tday.deleteTabHistory(histId).then(() =>
              window.tday.listTabHistory().then(setTabHistory),
            );
          }}
          onClose={() => setShowHistoryPanel(false)}
        />
      )}
    </div>
  );
}
