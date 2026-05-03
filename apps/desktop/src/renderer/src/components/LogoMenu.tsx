import { startTransition, useEffect, useRef, useState } from 'react';
import type { AgentHistoryEntry, AgentId, TabHistoryEntry } from '@tday/shared';
import { Logo } from '../Logo';
import { agentTitle, agentColor } from '../types/tab';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

interface LogoMenuProps {
  hasUpdate: boolean;
  keepAwakeId: number | null;
  tabHistory: TabHistoryEntry[];
  agentHistory: AgentHistoryEntry[];
  agentHistoryLoading: boolean;
  platform: string;
  forceOpen?: boolean;
  onToggleKeepAwake: () => Promise<void>;
  onRestoreFromAgentHistory: (entry: AgentHistoryEntry) => void;
  onOpenSettings: (section?: 'providers' | 'agents' | 'usage' | 'history' | 'cron') => void;
}

export function LogoMenu({
  hasUpdate, keepAwakeId, tabHistory: _tabHistory,
  agentHistory, agentHistoryLoading, platform, forceOpen = false,
  onToggleKeepAwake, onRestoreFromAgentHistory, onOpenSettings,
}: LogoMenuProps) {
  const [showLogoMenu, setShowLogoMenu] = useState(false);
  const [showHistorySubmenu, setShowHistorySubmenu] = useState(false);
  const [totalTokens, setTotalTokens] = useState<number | null>(null);
  const logoMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historySubmenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoMenuRef = useRef<HTMLDivElement>(null);

  // Allow parent to force-open (e.g. first-launch logo hint)
  useEffect(() => {
    if (forceOpen) setShowLogoMenu(true);
    else if (!forceOpen) setShowLogoMenu(false);
  }, [forceOpen]);

  const openLogoMenu = () => {
    if (logoMenuTimer.current) { clearTimeout(logoMenuTimer.current); logoMenuTimer.current = null; }
    setShowLogoMenu(true);
    // Fetch 30-day token total lazily each time the menu opens
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    window.tday.queryUsage({ fromTs: todayStart.getTime() })
      .then((s) => setTotalTokens(s.totalInputTokens + s.totalOutputTokens))
      .catch(() => {});
  };
  const closeLogoMenu = () => {
    if (logoMenuTimer.current) clearTimeout(logoMenuTimer.current);
    logoMenuTimer.current = setTimeout(() => {
      setShowLogoMenu(false);
      setShowHistorySubmenu(false);
    }, 500);
  };

  return (
    <div
      ref={logoMenuRef}
      className="no-drag relative ml-2 flex items-center"
      onMouseEnter={openLogoMenu}
      onMouseLeave={closeLogoMenu}
    >
      <button
        onClick={() => setShowLogoMenu((v) => !v)}
        className="no-drag group relative flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors hover:bg-zinc-900"
        aria-label="Tday menu"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          className="text-zinc-600 transition-colors group-hover:text-zinc-400">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        {hasUpdate && (
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-emerald-400 ring-1 ring-[#0a0a0f]" />
        )}
        {platform !== 'win32' && <Logo size={24} />}
      </button>

      {showLogoMenu && (
        <div
          className="no-drag absolute right-0 top-full z-30 pt-1"
          onMouseEnter={openLogoMenu}
          onMouseLeave={closeLogoMenu}
        >
          <div className="min-w-[200px] rounded-md border border-zinc-800 bg-zinc-950 py-1 shadow-2xl text-xs">
            {/* History with submenu */}
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

              {showHistorySubmenu && (
                <div
                  className="no-drag absolute right-full top-0 pr-3"
                  onMouseEnter={() => { if (historySubmenuTimer.current) { clearTimeout(historySubmenuTimer.current); historySubmenuTimer.current = null; } }}
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
                              onRestoreFromAgentHistory(entry);
                              setShowHistorySubmenu(false);
                              setShowLogoMenu(false);
                            }}
                            className="flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-zinc-800"
                          >
                            <span
                              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ background: agentColor(entry.agentId as AgentId) }}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="shrink-0 text-[10px] font-medium" style={{ color: agentColor(entry.agentId as AgentId) }}>
                                  {agentTitle(entry.agentId as AgentId)}
                                </span>
                                <span className="truncate text-zinc-200">{entry.title}</span>
                              </div>
                              <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-600">
                                <span className="min-w-0 flex-1 truncate" title={entry.cwd}>
                                  {entry.cwd.replace(/^.*[/\\](.+[/\\].+)$/, '…/$1').replace(/\\/g, '/')}
                                </span>
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
                        startTransition(() => onOpenSettings('history'));
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
              onClick={() => void onToggleKeepAwake()}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <svg width="13" height="13" viewBox="0 0 24 24"
                fill={keepAwakeId !== null ? 'currentColor' : 'none'}
                stroke={keepAwakeId !== null ? 'none' : 'currentColor'}
                strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                className={`shrink-0 ${keepAwakeId !== null ? 'text-amber-400' : 'text-zinc-500'}`}>
                <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
              </svg>
              <span className="flex-1">Keep Awake</span>
              <span className={`text-[10px] rounded px-1.5 py-0.5 ${
                keepAwakeId !== null ? 'bg-amber-400/20 text-amber-300' : 'bg-zinc-800 text-zinc-500'
              }`}>
                {keepAwakeId !== null ? 'ON' : 'OFF'}
              </span>
            </button>

            <div className="my-1 border-t border-zinc-800/60" />

            {/* Usage */}
            <button
              onClick={() => { setShowLogoMenu(false); startTransition(() => onOpenSettings('usage')); }}
              className="flex w-full items-center gap-3 px-3 py-2 text-left text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zinc-500">
                <line x1="18" y1="20" x2="18" y2="10" />
                <line x1="12" y1="20" x2="12" y2="4" />
                <line x1="6" y1="20" x2="6" y2="14" />
              </svg>
              <span className="flex-1">Usage</span>
              {totalTokens !== null && totalTokens > 0 && (
                <span className="text-[10px] text-zinc-500">{fmtTokens(totalTokens)} tok today</span>
              )}
            </button>

            {/* Settings */}
            <button
              onClick={() => { setShowLogoMenu(false); startTransition(() => onOpenSettings()); }}
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
  );
}
