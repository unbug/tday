import type { AgentId } from '@tday/shared';

export interface Tab {
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
  /** If set, sent to the PTY automatically once the agent finishes spawning. */
  initialPrompt?: string;
  /** True when opened by the cron scheduler — agents use batch/non-interactive mode. */
  isCronJob?: boolean;
}

/** Persisted tab record. Epoch is intentionally dropped — every restored
 *  tab gets a fresh epoch=0 because there's no live PTY to be in sync with. */
export interface PersistedTab {
  id: string;
  title: string;
  agentId: AgentId;
  cwd: string;
  agentSessionId?: string;
}

// ── Persistent settings keys ──────────────────────────────────────────────────
export const LAST_CWD_KEY = 'tday:lastCwd';
export const TABS_STATE_KEY = 'tday:tabs';
export const ACTIVE_TAB_KEY = 'tday:activeTab';
export const KEEP_AWAKE_KEY = 'tday:keep-awake';
export const LOGO_HINTED_KEY = 'tday:logo-menu-hinted';

/** Agents that support native session resume. */
export const RESUME_CAPABLE: AgentId[] = ['claude-code', 'codex', 'opencode'];

let _nextId = 1;

export function resetTabCounter(n: number): void {
  _nextId = n;
}

export function newTab(cwd: string, agentId: AgentId = 'pi', title?: string): Tab {
  return {
    id: `t${_nextId++}`,
    epoch: 0,
    title: title ?? agentTitle(agentId),
    agentId,
    cwd,
    cwdDraft: cwd,
  };
}

export function agentTitle(id: AgentId): string {
  switch (id) {
    case 'pi':          return 'Pi';
    case 'claude-code': return 'Claude';
    case 'codex':       return 'Codex';
    case 'copilot':     return 'Copilot';
    case 'opencode':    return 'OpenCode';
    case 'gemini':      return 'Gemini';
    case 'qwen-code':   return 'Qwen';
    case 'crush':       return 'Crush';
    case 'hermes':      return 'Hermes';
  }
}

export function agentColor(id: AgentId): string {
  switch (id) {
    case 'pi':          return '#a78bfa'; // violet
    case 'claude-code': return '#f97316'; // orange
    case 'codex':       return '#22d3ee'; // cyan
    case 'copilot':     return '#60a5fa'; // blue
    case 'opencode':    return '#34d399'; // emerald
    case 'gemini':      return '#4ade80'; // green
    case 'qwen-code':   return '#f472b6'; // pink
    case 'crush':       return '#fb7185'; // rose
    case 'hermes':      return '#fbbf24'; // amber
  }
}

export function loadPersistedTabsFromRaw(raw: unknown): PersistedTab[] {
  try {
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).filter(
      (t): t is PersistedTab =>
        !!t && typeof t === 'object' && typeof (t as PersistedTab).id === 'string',
    );
  } catch {
    return [];
  }
}

export function savePersistedTabs(tabs: Tab[]): void {
  const data: PersistedTab[] = tabs.map((t) => ({
    id: t.id,
    title: t.title,
    agentId: t.agentId,
    cwd: t.cwd,
    agentSessionId: t.agentSessionId,
  }));
  void window.tday.setSetting(TABS_STATE_KEY, data as unknown as Record<string, unknown>[]);
}
