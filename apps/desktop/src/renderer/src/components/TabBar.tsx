import { startTransition, useRef, useState } from 'react';
import type { AgentId, AgentInfo, ProviderProfile } from '@tday/shared';
import { presetForKind } from '@tday/shared';
import { type Tab, agentTitle, agentColor } from '../types/tab';

interface TabBarProps {
  tabs: Tab[];
  activeId: string;
  dragId: string | null;
  platform: string;
  agentList: AgentInfo[];
  defaultAgentId: AgentId;
  providersList: ProviderProfile[];
  onSetActiveId: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: (agentId?: AgentId, providerId?: string, modelId?: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (overId: string) => void;
  onDragEnd: () => void;
  onOpenSettings: (section: 'providers' | 'agents' | 'usage' | 'history' | 'cron') => void;
}

export function TabBar({
  tabs, activeId, dragId, platform, agentList, defaultAgentId, providersList,
  onSetActiveId, onCloseTab, onAddTab,
  onDragStart, onDragOver, onDrop, onDragEnd,
  onOpenSettings,
}: TabBarProps) {
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const [menuOnRight, setMenuOnRight] = useState(false);
  const [submenuOnLeft, setSubmenuOnLeft] = useState(false);
  const [hoveredAgentId, setHoveredAgentId] = useState<AgentId | null>(null);
  const [hoveredTabInfo, setHoveredTabInfo] = useState<{ tab: Tab; x: number; y: number } | null>(null);
  const menuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submenuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuContainerRef = useRef<HTMLDivElement>(null);

  const openMenu = () => {
    if (menuCloseTimer.current) { clearTimeout(menuCloseTimer.current); menuCloseTimer.current = null; }
    // Measure available space for level-2 submenu (220px wide)
    if (menuContainerRef.current) {
      const rect = menuContainerRef.current.getBoundingClientRect();
      setMenuOnRight(rect.left + 180 > window.innerWidth);
      setSubmenuOnLeft(rect.left + 180 + 220 > window.innerWidth);
    }
    setShowAgentMenu(true);
  };
  const scheduleCloseMenu = () => {
    if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current);
    menuCloseTimer.current = setTimeout(() => { setShowAgentMenu(false); setHoveredAgentId(null); }, 200);
  };

  const openSubmenu = (id: AgentId) => {
    if (submenuCloseTimer.current) { clearTimeout(submenuCloseTimer.current); submenuCloseTimer.current = null; }
    setHoveredAgentId(id);
  };
  const scheduleCloseSubmenu = () => {
    if (submenuCloseTimer.current) clearTimeout(submenuCloseTimer.current);
    submenuCloseTimer.current = setTimeout(() => setHoveredAgentId(null), 150);
  };

  const handleAddTab = (agentId?: AgentId, providerId?: string, modelId?: string) => {
    setShowAgentMenu(false);
    onAddTab(agentId, providerId, modelId);
  };

  return (
    <div className={`drag flex min-h-11 items-center gap-1 bg-[#0a0a0f] py-1.5 ${platform === 'darwin' ? 'pl-20' : 'pl-4'} pr-4`}>
      {/* Tab list — natural width, shrinks when space is tight */}
      <div className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
        {tabs.map((t) => {
          const fullTitle = t.title === agentTitle(t.agentId)
            ? t.title
            : `${agentTitle(t.agentId)}: ${t.title}`;
          return (
            <button
              key={t.id}
              onClick={() => onSetActiveId(t.id)}
              draggable
              onDragStart={() => onDragStart(t.id)}
              onDragOver={onDragOver}
              onDrop={() => onDrop(t.id)}
              onDragEnd={onDragEnd}
              onMouseEnter={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHoveredTabInfo({ tab: t, x: r.left, y: r.bottom }); }}
              onMouseLeave={() => setHoveredTabInfo(null)}
              className={`no-drag group relative inline-flex min-w-0 shrink items-center gap-2 rounded-full px-3 py-1 text-xs ${
                t.id === activeId
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900'
              } ${dragId === t.id ? 'opacity-50' : ''}`}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: agentColor(t.agentId) }}
              />
              <span className="min-w-0 flex-1 overflow-hidden whitespace-nowrap">
                {fullTitle}
              </span>
              <span
                onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
                className="shrink-0 rounded px-1 text-zinc-500 opacity-0 hover:bg-zinc-700 hover:text-zinc-100 group-hover:opacity-100"
              >
                ×
              </span>

            </button>
          );
        })}
      </div>

      {/* Tab hover card — rendered outside overflow-hidden via fixed positioning */}
      {hoveredTabInfo && (() => {
        const t = hoveredTabInfo.tab;
        return (
          <div
            className="no-drag pointer-events-none fixed z-50 w-64 rounded-xl border border-zinc-700/50 bg-zinc-950/95 px-3.5 py-2.5 shadow-xl backdrop-blur-sm"
            style={{ left: hoveredTabInfo.x, top: hoveredTabInfo.y + 6 }}
          >
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: agentColor(t.agentId) }} />
              <span className="text-[11px] font-semibold text-zinc-300">{agentTitle(t.agentId)}</span>
            </div>
            {t.title !== agentTitle(t.agentId) && (
              <div className="mt-1.5 text-xs leading-snug text-zinc-100">{t.title}</div>
            )}
            <div className="mt-2 flex items-start gap-1.5 border-t border-zinc-800/60 pt-2">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0 text-zinc-600">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
              <span className="break-all font-mono text-[10px] leading-relaxed text-zinc-500">{t.cwd}</span>
            </div>
          </div>
        );
      })()}

      {/* New-tab button — right after tabs */}
      <div
        ref={menuContainerRef}
        className="relative no-drag shrink-0 inline-flex items-stretch"
        onMouseEnter={openMenu}
        onMouseLeave={scheduleCloseMenu}
      >
          <button
            onClick={() => handleAddTab()}
            className="rounded-md px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-zinc-100"
            title={`New ${agentTitle(defaultAgentId)} tab (hover to pick agent)`}
          >
            +
          </button>
          {showAgentMenu ? (
            <div
              className={`no-drag absolute top-full z-30 min-w-[180px] pt-1 ${menuOnRight ? 'right-0' : 'left-0'}`}
              onMouseEnter={openMenu}
              onMouseLeave={scheduleCloseMenu}
            >
              <div className="rounded-md border border-zinc-800 bg-zinc-900 py-1 text-xs shadow-xl">
                {agentList.filter((a) => a.id !== 'terminal').map((info) => {
                  const id = info.id as AgentId;
                  const installed = !!info.detect.available;
                  const hasProviders = installed && providersList.length > 0;
                  const submenuOpen = hoveredAgentId === id;
                  return (
                    <div
                      key={id}
                      className="relative"
                      onMouseEnter={() => { if (hasProviders) openSubmenu(id); }}
                      onMouseLeave={() => { if (hasProviders) scheduleCloseSubmenu(); }}
                    >
                      <button
                        disabled={!installed}
                        onClick={() => handleAddTab(id)}
                        className={`flex w-full items-center justify-between px-3 py-1.5 text-left ${
                          installed
                            ? 'text-zinc-200 hover:bg-zinc-800'
                            : 'cursor-not-allowed text-zinc-600'
                        }`}
                      >
                        <span>{info.displayName}</span>
                        <span className="ml-3 flex items-center gap-1 text-[10px] text-zinc-500">
                          {id === defaultAgentId ? 'default' : installed ? '' : 'not installed'}
                          {hasProviders ? <span className="text-zinc-600">›</span> : null}
                        </span>
                      </button>
                      {/* Level 2: provider + models, positioned left or right */}
                      {hasProviders && submenuOpen ? (
                        <div
                          className={`absolute top-0 z-40 min-w-[220px] ${submenuOnLeft ? 'right-full pr-0.5' : 'left-full pl-0.5'}`}
                          onMouseEnter={() => openSubmenu(id)}
                          onMouseLeave={scheduleCloseSubmenu}
                        >
                          <div className="scroll-themed max-h-72 overflow-y-auto rounded-md border border-zinc-800 bg-zinc-900 py-1 text-xs shadow-xl">
                            {providersList.map((p) => {
                              const models = [
                                ...(presetForKind(p.kind)?.models ?? []),
                                ...(p.discoveredModels ?? []),
                                ...(p.extraModels ?? []),
                              ].filter(Boolean);
                              const uniqueModels = [...new Set(models)];
                              const activeModel = p.model;
                              const sortedModels = activeModel
                                ? [activeModel, ...uniqueModels.filter((m) => m !== activeModel)]
                                : uniqueModels;
                              return (
                                <div key={p.id}>
                                  <div className="mt-1 flex items-center gap-1.5 px-3 pb-0.5 pt-1">
                                    <span className="font-medium text-zinc-300">{p.label}</span>
                                    {activeModel ? (
                                      <span className="font-mono text-[10px] text-zinc-500">{activeModel}</span>
                                    ) : null}
                                  </div>
                                  {sortedModels.length > 0 ? (
                                    sortedModels.map((m) => (
                                      <button
                                        key={m}
                                        onClick={() => handleAddTab(id, p.id, m)}
                                        className="flex w-full items-center gap-2 py-1 pl-6 pr-3 text-left text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                                      >
                                        <span className="truncate font-mono text-[10px]">{m}</span>
                                        {m === activeModel ? (
                                          <span className="ml-auto shrink-0 text-[9px] text-zinc-600">✓</span>
                                        ) : null}
                                      </button>
                                    ))
                                  ) : (
                                    <button
                                      onClick={() => handleAddTab(id, p.id)}
                                      className="flex w-full items-center py-1 pl-6 pr-3 text-left text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                                    >
                                      <span className="text-[10px]">open with {p.label}</span>
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                <div className="my-1 border-t border-zinc-800/60" />
                <div className="flex items-center">
                  <button
                    onClick={() => { setShowAgentMenu(false); startTransition(() => onOpenSettings('agents')); }}
                    className="flex flex-1 items-center gap-2 px-3 py-1.5 text-left text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                    <span>Agents</span>
                  </button>
                  <div className="mx-1 h-3.5 w-px bg-zinc-700/60" />
                  <button
                    onClick={() => handleAddTab('terminal')}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
                  >
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="4 17 10 11 4 5" />
                      <line x1="12" y1="19" x2="20" y2="19" />
                    </svg>
                    <span>Terminal</span>
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      {/* Spacer — pushes LogoMenu to the right */}
      <div className="flex-1" />
    </div>
  );
}
