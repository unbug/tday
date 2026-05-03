import { useMemo, useRef, useState } from 'react';
import type { AgentHistoryEntry } from '@tday/shared';
import {
  histAgentLabel,
  histAgentColor,
  histTimeGroup,
  histRelative,
  HIST_TIME_ORDER,
  type HistTimeGroup,
} from './history-helpers';

export interface HistorySectionProps {
  entries: AgentHistoryEntry[];
  loading: boolean;
  onRestore: (entry: AgentHistoryEntry) => void;
  onHide: (id: string) => void;
}

export function HistorySection({ entries, loading, onRestore, onHide }: HistorySectionProps) {
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const [groupByAgent, setGroupByAgent] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const agentIds = useMemo(() => {
    const seen = new Set<string>();
    for (const e of entries) seen.add(e.agentId);
    return Array.from(seen).sort((a, b) =>
      histAgentLabel(a).localeCompare(histAgentLabel(b)),
    );
  }, [entries]);

  const filtered = useMemo(() => {
    let result = entries;
    if (agentFilter !== 'all') result = result.filter((e) => e.agentId === agentFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.cwd.toLowerCase().includes(q) ||
          histAgentLabel(e.agentId).toLowerCase().includes(q),
      );
    }
    return result;
  }, [entries, agentFilter, search]);

  const grouped = useMemo((): Array<[string, AgentHistoryEntry[]]> => {
    if (groupByAgent) {
      const map = new Map<string, AgentHistoryEntry[]>();
      for (const e of filtered) {
        const key = histAgentLabel(e.agentId);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(e);
      }
      return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
    }
    const map = new Map<HistTimeGroup, AgentHistoryEntry[]>();
    for (const e of filtered) {
      const g = histTimeGroup(e.updatedAt);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(e);
    }
    return HIST_TIME_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!]);
  }, [filtered, groupByAgent]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Agent sidebar */}
      <div className="scroll-themed flex w-40 shrink-0 flex-col overflow-y-auto border-r border-zinc-800/60 p-2 text-xs">
        {[
          { id: 'all', label: 'All' },
          ...agentIds.map((id) => ({ id, label: histAgentLabel(id) })),
        ].map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setAgentFilter(id)}
            className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${
              agentFilter === id
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:bg-zinc-900'
            }`}
          >
            {id !== 'all' && (
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: histAgentColor(id) }}
              />
            )}
            <span className="truncate">{label}</span>
            {id !== 'all' && (
              <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                {entries.filter((e) => e.agentId === id).length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Main list */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/40 px-3 py-2">
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions…"
            className="input h-7 flex-1 py-0 text-xs"
          />
          <button
            onClick={() => setGroupByAgent(false)}
            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
              !groupByAgent
                ? 'bg-fuchsia-500/20 text-fuchsia-200'
                : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            By Time
          </button>
          <button
            onClick={() => setGroupByAgent(true)}
            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
              groupByAgent
                ? 'bg-fuchsia-500/20 text-fuchsia-200'
                : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            By Agent
          </button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
            Loading history…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
            {search ? 'No matches' : 'No history yet'}
          </div>
        ) : (
          <div className="scroll-themed flex-1 overflow-y-auto">
            {grouped.map(([groupLabel, groupEntries]) => (
              <div key={groupLabel}>
                <div className="sticky top-0 z-10 bg-zinc-950/90 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  {groupLabel}
                </div>
                {groupEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="group flex items-start gap-2.5 px-3 py-2 hover:bg-zinc-900/60"
                  >
                    <button
                      onClick={() => onRestore(entry)}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                    >
                      <span
                        className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: histAgentColor(entry.agentId) }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="shrink-0 text-[10px] font-medium"
                            style={{ color: histAgentColor(entry.agentId) }}
                          >
                            {histAgentLabel(entry.agentId)}
                          </span>
                          <span className="truncate text-xs text-zinc-200">{entry.title}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-600">
                          <span
                            className="min-w-0 flex-1 truncate"
                            title={entry.cwd}
                          >
                            {entry.cwd
                              .replace(/^.*[/\\](.+[/\\].+)$/, '…/$1')
                              .replace(/\\/g, '/')}
                          </span>
                          <span className="shrink-0">{histRelative(entry.updatedAt)}</span>
                          {entry.messageCount > 0 && (
                            <span className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] text-zinc-500">
                              {entry.messageCount} msgs
                            </span>
                          )}
                          {entry.source === 'tday' && (
                            <span className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] text-zinc-600">
                              tracked
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={() => onHide(entry.id)}
                      title="Hide from history"
                      className="mt-0.5 shrink-0 rounded p-0.5 text-zinc-700 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                    >
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
