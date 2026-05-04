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
  /** CoWorker id to apply — its system prompt is prepended to the agent's initial prompt. */
  coworkerId?: string;
  /** Provider profile id override for this tab — overrides the agent's default binding. */
  providerId?: string;
  /** Per-tab model override — overrides the provider profile's default model. */
  modelId?: string;
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

export const AGENT_TITLE_MAP: Record<AgentId, string> = {
  pi: 'Pi',
  'claude-code': 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  opencode: 'OpenCode',
  gemini: 'Gemini',
  'qwen-code': 'Qwen',
  crush: 'Crush',
  hermes: 'Hermes',
  'deepseek-tui': 'DeepSeekTUI',
  terminal: 'Terminal',
};

export const AGENT_COLOR_MAP: Record<AgentId, string> = {
  pi: '#a78bfa',
  'claude-code': '#f97316',
  codex: '#788bff',
  copilot: '#60a5fa',
  opencode: '#34d399',
  gemini: '#4ade80',
  'qwen-code': '#f472b6',
  crush: '#fb7185',
  hermes: '#fbbf24',
  'deepseek-tui': '#4D6BFE',
  terminal: '#6b7280',
};

/** All agent IDs usable in scheduled jobs (excludes 'terminal'). */
export const SCHEDULABLE_AGENT_IDS = (Object.keys(AGENT_TITLE_MAP) as AgentId[]).filter(
  (id) => id !== 'terminal',
);

export function agentTitle(id: AgentId): string {
  return AGENT_TITLE_MAP[id];
}

export function agentColor(id: AgentId): string {
  return AGENT_COLOR_MAP[id];
}

/** agentTitle for arbitrary string IDs — returns the raw id for unknowns. */
export function agentTitleFor(id: string): string {
  return (AGENT_TITLE_MAP as Record<string, string>)[id] ?? id;
}

/** agentColor for arbitrary string IDs — returns '#71717a' for unknowns. */
export function agentColorFor(id: string): string {
  return (AGENT_COLOR_MAP as Record<string, string>)[id] ?? '#71717a';
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
