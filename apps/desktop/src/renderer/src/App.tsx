import { useEffect, useRef, useState } from 'react';
import type { AgentId, AgentInfo } from '@tday/shared';
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
    case 'pi':
      return 'Pi';
    case 'claude-code':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'copilot':
      return 'Copilot';
    case 'opencode':
      return 'OpenCode';
    case 'gemini':
      return 'Gemini';
    case 'qwen-code':
      return 'Qwen';
    case 'crush':
      return 'Crush';
    case 'hermes':
      return 'Hermes';
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
  const [installing, setInstalling] = useState(false);
  const [installPct, setInstallPct] = useState(0);
  const [installStatus, setInstallStatus] = useState('starting');
  const [installLog, setInstallLog] = useState<string>('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [agentList, setAgentList] = useState<AgentInfo[]>([]);
  const [showAgentMenu, setShowAgentMenu] = useState(false);
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
        }));
        setTabs(restored);
        setActiveId(restored[0].id);
      } else {
        const start = lastCwd() || h;
        const t = newTab(start, def);
        setTabs([t]);
        setActiveId(t.id);
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
  const handlersRef = useRef<{ addTab: () => void; closeTab: (id: string) => void; activeId: string }>({
    addTab: () => {},
    closeTab: () => {},
    activeId: '',
  });
  useEffect(() => {
    const offNew = window.tday.onTabNew(() => handlersRef.current.addTab());
    const offClose = window.tday.onTabClose(() => {
      const id = handlersRef.current.activeId;
      if (id) handlersRef.current.closeTab(id);
    });
    return () => {
      offNew();
      offClose();
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

  const closeTab = (id: string) => {
    void window.tday.kill(id);
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
  };

  const addTab = (agentId: AgentId = defaultAgentId) => {
    const t = newTab(lastCwd() || home, agentId);
    setTabs((prev) => [...prev, t]);
    setActiveId(t.id);
    setShowAgentMenu(false);
  };

  // Keep the keyboard-shortcut ref pointed at the latest handlers.
  handlersRef.current = { addTab, closeTab, activeId };

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
      <div className="drag flex min-h-11 items-start gap-2 border-b border-zinc-800/60 bg-[#0a0a0f] py-1.5 pl-20 pr-4">
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
              <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-400/80" />
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
              className="rounded-l-md px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              title={`New ${agentTitle(defaultAgentId)} tab`}
            >
              +
            </button>
            <button
              onClick={() => setShowAgentMenu((v) => !v)}
              className="rounded-r-md px-1.5 py-1 text-[10px] leading-none text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
              title="Choose agent"
              aria-label="Choose agent"
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
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
                </div>
              </div>
            ) : null}
          </div>
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          className="no-drag ml-1 rounded-md px-2 py-1 text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
          title="Settings"
          aria-label="Settings"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <span className="no-drag ml-2 flex items-center">
          <Logo size={24} />
        </span>
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
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      <Settings
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={() => {
          // Refresh agent list so default-agent / install-state changes take
          // effect on the next "+" click without an app restart.
          void refreshPi();
        }}
      />
    </div>
  );
}
