/**
 * Agent History Session Manager panel.
 *
 * Full-featured replacement for the old HistoryPanel. Displays ALL session
 * history from every agent's native session files (plus Tday-tracked fallback).
 *
 * Features:
 *   - Agent filter sidebar (All + per-agent)
 *   - Time grouping: Today / Yesterday / This Week / This Month / Older
 *   - Search by title or cwd
 *   - Soft-delete (hide) entries from the index
 *   - Click to restore session
 *   - Source badge: 'native' sessions show the agent icon; 'tday' shows a bookmark
 */

import { useState, useMemo, useRef, useEffect } from 'react';
import type { AgentHistoryEntry } from '@tday/shared';
import { agentTitleFor, agentColorFor } from './types/tab';

// ── Agent metadata ────────────────────────────────────────────────────────────

function agentLabel(id: string): string {
  return agentTitleFor(id);
}

function agentColor(id: string): string {
  return agentColorFor(id);
}

// ── Time grouping ─────────────────────────────────────────────────────────────

type TimeGroup = 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'Older';

function getTimeGroup(ts: number): TimeGroup {
  const now = new Date();
  const d = new Date(ts);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfWeek = startOfToday - (now.getDay() || 7) * 86_400_000 + 86_400_000; // Mon
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

  if (d.getTime() >= startOfToday) return 'Today';
  if (d.getTime() >= startOfYesterday) return 'Yesterday';
  if (d.getTime() >= startOfWeek) return 'This Week';
  if (d.getTime() >= startOfMonth) return 'This Month';
  return 'Older';
}

const TIME_GROUP_ORDER: TimeGroup[] = [
  'Today',
  'Yesterday',
  'This Week',
  'This Month',
  'Older',
];

// ── Formatting ────────────────────────────────────────────────────────────────

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function shortCwd(cwd: string): string {
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join('/')}`;
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  entries: AgentHistoryEntry[];
  onRestore: (entry: AgentHistoryEntry) => void;
  onHide: (id: string) => void;
  onClose: () => void;
  loading?: boolean;
}

type GroupMode = 'time' | 'agent';

export function AgentHistoryPanel({ entries, onRestore, onHide, onClose, loading }: Props) {
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [groupMode, setGroupMode] = useState<GroupMode>('time');
  const searchRef = useRef<HTMLInputElement>(null);

  // Auto-focus search on open
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Unique agent ids present in entries (for sidebar)
  const agentIds = useMemo(() => {
    const seen = new Set<string>();
    for (const e of entries) seen.add(e.agentId);
    return Array.from(seen).sort((a, b) => agentLabel(a).localeCompare(agentLabel(b)));
  }, [entries]);

  // Filtered entries
  const filtered = useMemo(() => {
    let result = entries;
    if (agentFilter !== 'all') {
      result = result.filter((e) => e.agentId === agentFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.cwd.toLowerCase().includes(q) ||
          agentLabel(e.agentId).toLowerCase().includes(q),
      );
    }
    return result;
  }, [entries, agentFilter, search]);

  // Grouped entries
  const grouped = useMemo(() => {
    if (groupMode === 'agent') {
      const map = new Map<string, AgentHistoryEntry[]>();
      for (const e of filtered) {
        const key = agentLabel(e.agentId);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(e);
      }
      return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
    }
    // Time grouping
    const map = new Map<TimeGroup, AgentHistoryEntry[]>();
    for (const e of filtered) {
      const g = getTimeGroup(e.updatedAt);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(e);
    }
    return TIME_GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as [string, AgentHistoryEntry[]]);
  }, [filtered, groupMode]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-12"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div
        className="relative z-10 flex h-[75vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="flex items-center gap-3 border-b border-zinc-800 px-4 py-3">
          {/* Search */}
          <div className="flex flex-1 items-center gap-2 rounded-md bg-zinc-900 px-3 py-1.5">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-zinc-500">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              ref={searchRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search sessions…"
              className="flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="text-zinc-600 hover:text-zinc-400"
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>

          {/* Group toggle */}
          <div className="flex rounded-md border border-zinc-800 text-xs">
            <button
              onClick={() => setGroupMode('time')}
              className={`px-2.5 py-1 rounded-l-md ${groupMode === 'time' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              By Time
            </button>
            <button
              onClick={() => setGroupMode('agent')}
              className={`px-2.5 py-1 rounded-r-md border-l border-zinc-800 ${groupMode === 'agent' ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'}`}
            >
              By Agent
            </button>
          </div>

          {/* Close */}
          <button
            onClick={onClose}
            className="shrink-0 rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* ── Agent sidebar ── */}
          <div className="flex w-36 shrink-0 flex-col border-r border-zinc-800 overflow-y-auto py-2">
            <button
              onClick={() => setAgentFilter('all')}
              className={`flex items-center gap-2 px-3 py-1.5 text-left text-xs ${
                agentFilter === 'all'
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
              }`}
            >
              <span className="h-2 w-2 rounded-full bg-zinc-500" />
              <span className="flex-1">All agents</span>
              <span className="text-[10px] text-zinc-600">{entries.length}</span>
            </button>
            {agentIds.map((id) => {
              const count = entries.filter((e) => e.agentId === id).length;
              return (
                <button
                  key={id}
                  onClick={() => setAgentFilter(id)}
                  className={`flex items-center gap-2 px-3 py-1.5 text-left text-xs ${
                    agentFilter === id
                      ? 'bg-zinc-800 text-zinc-100'
                      : 'text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300'
                  }`}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: agentColor(id) }}
                  />
                  <span className="flex-1 truncate">{agentLabel(id)}</span>
                  <span className="text-[10px] text-zinc-600">{count}</span>
                </button>
              );
            })}
          </div>

          {/* ── Session list ── */}
          <div className="flex-1 overflow-y-auto">
            {loading && filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center text-sm text-zinc-600">
                <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
                Loading history…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-600">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="opacity-40">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span className="text-sm">
                  {search ? 'No sessions match your search' : 'No history yet'}
                </span>
                {search && (
                  <button
                    onClick={() => setSearch('')}
                    className="text-xs text-zinc-500 underline hover:text-zinc-300"
                  >
                    Clear search
                  </button>
                )}
              </div>
            ) : (
              <div>
                {grouped.map(([groupLabel, groupEntries]) => (
                  <div key={groupLabel}>
                    {/* Group header */}
                    <div className="sticky top-0 z-10 bg-zinc-950/95 px-4 py-1.5 text-[10px] font-semibold uppercase tracking-widest text-zinc-600">
                      {groupLabel}
                      <span className="ml-2 font-normal normal-case text-zinc-700">
                        {groupEntries.length}
                      </span>
                    </div>
                    {/* Entries */}
                    {groupEntries.map((entry) => (
                      <SessionRow
                        key={entry.id}
                        entry={entry}
                        onRestore={() => { onRestore(entry); onClose(); }}
                        onHide={() => onHide(entry.id)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="border-t border-zinc-900 px-4 py-1.5 text-[10px] text-zinc-700">
          {filtered.length > 0
            ? `${filtered.length} session${filtered.length !== 1 ? 's' : ''} · ⌘⇧T to restore most recent · Click to open`
            : 'Sessions discovered from agent session files + Tday tab history'}
        </div>
      </div>
    </div>
  );
}

// ── Session row ───────────────────────────────────────────────────────────────

interface RowProps {
  entry: AgentHistoryEntry;
  onRestore: () => void;
  onHide: () => void;
}

function SessionRow({ entry, onRestore, onHide }: RowProps) {
  const color = agentColor(entry.agentId);
  const canResume = !!entry.sessionId;

  return (
    <div className="group flex items-stretch border-b border-zinc-900/60">
      <button
        className="flex min-w-0 flex-1 items-start gap-3 px-4 py-2.5 text-left hover:bg-zinc-900/60"
        onClick={onRestore}
        title={
          canResume
            ? `Open — will resume conversation (${agentLabel(entry.agentId)})`
            : `Open new ${agentLabel(entry.agentId)} session in this directory`
        }
      >
        {/* Agent dot */}
        <span
          className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
          style={{ background: color }}
        />

        <div className="min-w-0 flex-1">
          {/* Title row */}
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium text-zinc-100">
              {entry.title}
            </span>
            <span
              className="shrink-0 text-[10px] font-medium"
              style={{ color }}
            >
              {agentLabel(entry.agentId)}
            </span>
            {entry.messageCount > 0 && (
              <span className="shrink-0 text-[10px] text-zinc-600">
                {entry.messageCount} msg{entry.messageCount !== 1 ? 's' : ''}
              </span>
            )}
          </div>

          {/* Meta row */}
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500">
            {entry.cwd && (
              <span className="min-w-0 truncate font-mono" title={entry.cwd}>
                {shortCwd(entry.cwd)}
              </span>
            )}
            <span className="shrink-0">·</span>
            <span
              className="shrink-0"
              title={formatAbsolute(entry.updatedAt)}
            >
              {formatRelative(entry.updatedAt)}
            </span>
            {canResume && (
              <>
                <span className="shrink-0">·</span>
                <span className="shrink-0 text-fuchsia-400 text-[10px]">resumes</span>
              </>
            )}
            {entry.source === 'native' && (
              <>
                <span className="shrink-0">·</span>
                <span className="shrink-0 text-zinc-600 text-[10px]">native</span>
              </>
            )}
          </div>
        </div>
      </button>

      {/* Hide button */}
      <button
        onClick={(e) => { e.stopPropagation(); onHide(); }}
        className="flex items-center px-3 text-zinc-800 opacity-0 hover:bg-zinc-900 hover:text-zinc-500 group-hover:opacity-100"
        title="Remove from history (session file is kept)"
        aria-label="Hide from history"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
