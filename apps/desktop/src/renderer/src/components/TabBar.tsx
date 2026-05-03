import { startTransition, useRef, useState } from 'react';
import type { AgentId, AgentInfo } from '@tday/shared';
import { type Tab, agentTitle, agentColor } from '../types/tab';

interface TabBarProps {
  tabs: Tab[];
  activeId: string;
  dragId: string | null;
  platform: string;
  agentList: AgentInfo[];
  defaultAgentId: AgentId;
  onSetActiveId: (id: string) => void;
  onCloseTab: (id: string) => void;
  onAddTab: (agentId?: AgentId) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (overId: string) => void;
  onDragEnd: () => void;
  onOpenSettings: (section: 'providers' | 'agents' | 'usage' | 'history' | 'cron') => void;
}

export function TabBar({
  tabs, activeId, dragId, platform, agentList, defaultAgentId,
  onSetActiveId, onCloseTab, onAddTab,
  onDragStart, onDragOver, onDrop, onDragEnd,
  onOpenSettings,
}: TabBarProps) {
  const [showAgentMenu, setShowAgentMenu] = useState(false);
  const menuCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openMenu = () => {
    if (menuCloseTimer.current) { clearTimeout(menuCloseTimer.current); menuCloseTimer.current = null; }
    setShowAgentMenu(true);
  };
  const scheduleCloseMenu = () => {
    if (menuCloseTimer.current) clearTimeout(menuCloseTimer.current);
    menuCloseTimer.current = setTimeout(() => setShowAgentMenu(false), 500);
  };

  const handleAddTab = (agentId?: AgentId) => {
    setShowAgentMenu(false);
    onAddTab(agentId);
  };

  return (
    <div className={`drag flex min-h-11 items-start gap-2 bg-[#0a0a0f] py-1.5 ${platform === 'darwin' ? 'pl-20' : 'pl-4'} pr-4`}>
      <div className="flex flex-1 flex-wrap items-center gap-1">
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
                onClick={(e) => { e.stopPropagation(); onCloseTab(t.id); }}
                className="rounded px-1 text-zinc-500 opacity-0 hover:bg-zinc-700 hover:text-zinc-100 group-hover:opacity-100"
              >
                ×
              </span>
            </button>
          );
        })}

        {/* Split new-tab button with agent picker */}
        <div
          className="relative no-drag ml-1 inline-flex items-stretch"
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
              className="no-drag absolute left-0 top-full z-30 min-w-[180px] pt-1"
              onMouseEnter={openMenu}
              onMouseLeave={scheduleCloseMenu}
            >
              <div className="rounded-md border border-zinc-800 bg-zinc-950 py-1 text-xs shadow-xl">
                {([
                  'pi', 'claude-code', 'codex', 'copilot', 'opencode',
                  'gemini', 'qwen-code', 'crush', 'hermes',
                ] as AgentId[]).map((id) => {
                  const info = agentList.find((a) => a.id === id);
                  const installed = !!info?.detect.available;
                  return (
                    <button
                      key={id}
                      disabled={!installed}
                      onClick={() => handleAddTab(id)}
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
                  onClick={() => { setShowAgentMenu(false); startTransition(() => onOpenSettings('agents')); }}
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
    </div>
  );
}
