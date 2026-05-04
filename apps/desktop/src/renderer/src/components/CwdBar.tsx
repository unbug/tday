import { useRef, useState } from 'react';
import type { CoWorker } from '@tday/shared';
import type { Tab } from '../types/tab';

interface CwdBarProps {
  activeTab: Tab | undefined;
  home: string;
  coworkers?: CoWorker[];
  onSetTabDraft: (id: string, cwd: string) => void;
  onCommitTabCwd: (id: string, cwd: string) => void;
  onBrowseTabCwd: (id: string, current: string) => void;
  onSetTabCoworker?: (id: string, coworkerId: string | undefined) => void;
}

export function CwdBar({ activeTab, home, coworkers = [], onSetTabDraft, onCommitTabCwd, onBrowseTabCwd, onSetTabCoworker }: CwdBarProps) {
  const [showCwMenu, setShowCwMenu] = useState(false);
  const cwMenuTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openCwMenu = () => {
    if (cwMenuTimer.current) { clearTimeout(cwMenuTimer.current); cwMenuTimer.current = null; }
    setShowCwMenu(true);
  };
  const closeCwMenu = () => {
    cwMenuTimer.current = setTimeout(() => setShowCwMenu(false), 300);
  };

  if (!activeTab) return null;

  const homeShort = (p: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);
  const cwdDirty = activeTab.cwdDraft !== activeTab.cwd;

  return (
    <div className="no-drag relative z-10 flex items-center gap-2 rounded-md border border-zinc-800/60 bg-zinc-900/40 px-3 py-1.5 text-[11px] text-zinc-300">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zinc-500">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">cwd</span>
      <input
        key={activeTab.id}
        className="flex-1 border-none bg-transparent text-zinc-100 outline-none placeholder:text-zinc-600"
        value={activeTab.cwdDraft}
        onChange={(e) => onSetTabDraft(activeTab.id, e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onCommitTabCwd(activeTab.id, activeTab.cwdDraft);
          if (e.key === 'Escape') onSetTabDraft(activeTab.id, activeTab.cwd);
        }}
        spellCheck={false}
        placeholder={home}
      />
      <span className="hidden text-zinc-500 sm:inline">{homeShort(activeTab.cwd)}</span>
      {cwdDirty ? (
        <button
          onClick={() => onCommitTabCwd(activeTab.id, activeTab.cwdDraft)}
          className="rounded bg-fuchsia-500/90 px-2 py-0.5 text-[10px] font-medium text-white hover:bg-fuchsia-500"
          title="Apply (restarts the tab)"
        >
          Apply ↵
        </button>
      ) : null}
      <button
        onClick={() => onBrowseTabCwd(activeTab.id, activeTab.cwdDraft)}
        className="rounded px-2 py-0.5 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
        title="Choose folder"
      >
        Browse…
      </button>
      {coworkers.length > 0 && onSetTabCoworker && (() => {
        const builtins = coworkers.filter((c) => c.isBuiltIn || c.id.startsWith('builtin:'));
        const onlinePresets = coworkers.filter((c) => (c.isPreset ?? false) && c.id.startsWith('online:'));
        const userOnline = coworkers.filter((c) => !(c.isPreset ?? false) && c.id.startsWith('online:'));
        const customCws = coworkers.filter(
          (c) => !c.isBuiltIn && !c.id.startsWith('builtin:') && !c.id.startsWith('online:'),
        );
        const onlineCats = Array.from(
          new Set(onlinePresets.map((c) => c.category).filter(Boolean) as string[]),
        );
        const activeCw = coworkers.find((c) => c.id === activeTab.coworkerId);

        const MenuItem = ({ cw }: { cw: CoWorker }) => (
          <button
            key={cw.id}
            onClick={() => { onSetTabCoworker(activeTab.id, cw.id); setShowCwMenu(false); }}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
              activeTab.coworkerId === cw.id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-300 hover:bg-zinc-800/70'
            }`}
          >
            <span className="shrink-0 text-sm leading-none">{cw.emoji}</span>
            <span className="truncate text-[11px]">{cw.name}</span>
          </button>
        );

        const GroupLabel = ({ label }: { label: string }) => (
          <p className="px-3 pb-0.5 pt-2 text-[9px] font-semibold uppercase tracking-wider text-zinc-600 first:pt-1">
            {label}
          </p>
        );

        return (
          <>
            <div className="h-3 w-px bg-zinc-700/60" />
            <div
              className="relative"
              onMouseEnter={openCwMenu}
              onMouseLeave={closeCwMenu}
            >
              <button
                className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-zinc-400 transition-colors hover:bg-zinc-800/60 hover:text-zinc-200"
                onClick={() => setShowCwMenu((v) => !v)}
              >
                {activeCw
                  ? <><span>{activeCw.emoji}</span><span className="max-w-[120px] truncate">{activeCw.name}</span></>
                  : <span>CoWorker: None</span>
                }
                <svg width="8" height="8" viewBox="0 0 8 8" className="shrink-0 text-zinc-600" fill="currentColor">
                  <path d="M1 2.5L4 5.5L7 2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" fill="none"/>
                </svg>
              </button>

              {showCwMenu && (
                <div
                  className="no-drag absolute top-full right-0 z-50 mt-1 w-56"
                  onMouseEnter={openCwMenu}
                  onMouseLeave={closeCwMenu}
                >
                  <div className="rounded-md border border-zinc-800 bg-zinc-900/70 py-1 text-xs shadow-2xl backdrop-blur-md max-h-[36rem] overflow-y-auto">
                    <button
                      onClick={() => { onSetTabCoworker(activeTab.id, undefined); setShowCwMenu(false); }}
                      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors ${
                        !activeTab.coworkerId ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-800/70'
                      }`}
                    >
                      <span className="shrink-0 text-sm leading-none">—</span>
                      <span className="text-[11px]">None</span>
                    </button>
                    {builtins.length > 0 && (
                      <>
                        <GroupLabel label="Built-in" />
                        {builtins.map((cw) => <MenuItem key={cw.id} cw={cw} />)}
                      </>
                    )}
                    {onlineCats.map((cat) => {
                      const items = onlinePresets.filter((c) => c.category === cat);
                      return (
                        <div key={cat}>
                          <GroupLabel label={`Online · ${cat}`} />
                          {items.map((cw) => <MenuItem key={cw.id} cw={cw} />)}
                        </div>
                      );
                    })}
                    {userOnline.length > 0 && (
                      <>
                        <GroupLabel label="Online · My CoWorkers" />
                        {userOnline.map((cw) => <MenuItem key={cw.id} cw={cw} />)}
                      </>
                    )}
                    {customCws.length > 0 && (
                      <>
                        <GroupLabel label="Custom" />
                        {customCws.map((cw) => <MenuItem key={cw.id} cw={cw} />)}
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}
