import type { TabHistoryEntry } from '@tday/shared';
import type { AgentId } from '@tday/shared';

interface Props {
  entries: TabHistoryEntry[];
  onRestore: (entry: TabHistoryEntry) => void;
  onDelete: (histId: string) => void;
  onClose: () => void;
}

function agentLabel(id: AgentId): string {
  switch (id) {
    case 'pi': return 'Pi';
    case 'claude-code': return 'Claude';
    case 'codex': return 'Codex';
    case 'copilot': return 'Copilot';
    case 'opencode': return 'OpenCode';
    case 'gemini': return 'Gemini';
    case 'qwen-code': return 'Qwen';
    case 'crush': return 'Crush';
    case 'hermes': return 'Hermes';
    case 'terminal': return 'Terminal';
  }
}

const AGENT_COLORS: Record<AgentId, string> = {
  pi: 'bg-fuchsia-500',
  'claude-code': 'bg-orange-500',
  codex: 'bg-blue-500',
  copilot: 'bg-sky-500',
  opencode: 'bg-emerald-500',
  gemini: 'bg-purple-500',
  'qwen-code': 'bg-red-500',
  crush: 'bg-pink-500',
  hermes: 'bg-amber-500',
  terminal: 'bg-zinc-500',
};

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
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function shortCwd(cwd: string): string {
  // Show just the last 2 path segments for readability.
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `…/${parts.slice(-2).join('/')}`;
}

export function HistoryPanel({ entries, onRestore, onDelete, onClose }: Props) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

      <div
        className="relative z-10 flex w-full max-w-xl flex-col rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">Recently Closed Tabs</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              {entries.length === 0 ? 'No history yet' : `${entries.length} session${entries.length !== 1 ? 's' : ''}`}
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100"
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 2L12 12M12 2L2 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* List */}
        <div className="max-h-[60vh] overflow-y-auto">
          {entries.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-600">
              Close a tab to save it to history
            </div>
          ) : (
            <ul className="divide-y divide-zinc-900">
              {entries.map((entry) => (
                <li key={entry.histId} className="group flex items-stretch">
                  <button
                    className="flex min-w-0 flex-1 items-start gap-3 px-4 py-3 text-left hover:bg-zinc-900"
                    onClick={() => { onRestore(entry); onClose(); }}
                    title={`Restore — ${entry.agentSessionId ? 'will resume conversation' : 'new conversation'}`}
                  >
                    {/* Agent badge */}
                    <span
                      className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[9px] font-bold text-white ${AGENT_COLORS[entry.agentId] ?? 'bg-zinc-600'}`}
                    >
                      {agentLabel(entry.agentId)[0]}
                    </span>

                    <div className="min-w-0 flex-1">
                      {/* Title row */}
                      <div className="flex items-baseline gap-2">
                        <span className="truncate text-sm font-medium text-zinc-100">
                          {entry.title}
                        </span>
                        <span className="shrink-0 text-[10px] text-zinc-500">
                          {agentLabel(entry.agentId)}
                        </span>
                      </div>
                      {/* Cwd row */}
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-zinc-500">
                        <span className="truncate font-mono" title={entry.cwd}>
                          {shortCwd(entry.cwd)}
                        </span>
                        <span className="shrink-0">·</span>
                        <span
                          className="shrink-0"
                          title={formatAbsolute(entry.closedAt)}
                        >
                          {formatRelative(entry.closedAt)}
                        </span>
                        {entry.agentSessionId && (
                          <>
                            <span className="shrink-0">·</span>
                            <span className="shrink-0 text-fuchsia-400">resumes</span>
                          </>
                        )}
                      </div>
                    </div>
                  </button>

                  {/* Delete button — only visible on hover */}
                  <button
                    onClick={() => onDelete(entry.histId)}
                    className="flex items-center px-3 text-zinc-700 opacity-0 hover:bg-zinc-900 hover:text-zinc-400 group-hover:opacity-100"
                    title="Remove from history"
                    aria-label="Remove from history"
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                      <path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Footer hint */}
        {entries.length > 0 && (
          <div className="border-t border-zinc-900 px-4 py-2 text-[10px] text-zinc-600">
            ⌘⇧T to restore most recent · Click entry to restore · Sessions marked "resumes" will continue the conversation
          </div>
        )}
      </div>
    </div>
  );
}
