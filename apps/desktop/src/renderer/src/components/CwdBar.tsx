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
  if (!activeTab) return null;

  const homeShort = (p: string) => (home && p.startsWith(home) ? '~' + p.slice(home.length) : p);
  const cwdDirty = activeTab.cwdDraft !== activeTab.cwd;

  return (
    <div className="no-drag flex items-center gap-2 rounded-md border border-zinc-800/60 bg-zinc-900/40 px-3 py-1.5 text-[11px] text-zinc-300">
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
      {coworkers.length > 0 && onSetTabCoworker && (
        <>
          <div className="h-3 w-px bg-zinc-700/60" />
          <select
            className="cursor-pointer border-none bg-transparent text-[11px] text-zinc-400 outline-none hover:text-zinc-200"
            value={activeTab.coworkerId ?? ''}
            title="CoWorker"
            onChange={(e) => onSetTabCoworker(activeTab.id, e.target.value || undefined)}
          >
            <option value="">CoWorker: None</option>
            {coworkers.map((cw) => (
              <option key={cw.id} value={cw.id}>{cw.emoji} {cw.name}</option>
            ))}
          </select>
        </>
      )}
    </div>
  );
}
