import { AGENT_TITLE_MAP, AGENT_COLOR_MAP, agentTitleFor, agentColorFor } from '../types/tab';

export const HIST_AGENT_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_TITLE_MAP).filter(([id]) => id !== 'terminal'),
);

export const HIST_AGENT_COLOR: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_COLOR_MAP).filter(([id]) => id !== 'terminal'),
);

export function histAgentLabel(id: string): string {
  return agentTitleFor(id);
}

export function histAgentColor(id: string): string {
  return agentColorFor(id);
}

export type HistTimeGroup = 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'Older';

export const HIST_TIME_ORDER: HistTimeGroup[] = [
  'Today',
  'Yesterday',
  'This Week',
  'This Month',
  'Older',
];

/** Classify a Unix timestamp into a human time bucket. */
export function histTimeGroup(ts: number): HistTimeGroup {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86_400_000;
  const weekStart = today - ((now.getDay() || 7) - 1) * 86_400_000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (ts >= today) return 'Today';
  if (ts >= yesterday) return 'Yesterday';
  if (ts >= weekStart) return 'This Week';
  if (ts >= monthStart) return 'This Month';
  return 'Older';
}

/** Format a Unix timestamp as a locale date+time string. */
export function histRelative(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
