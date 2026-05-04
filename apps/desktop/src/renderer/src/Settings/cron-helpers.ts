import type { AgentId } from '@tday/shared';
import { AGENT_TITLE_MAP, AGENT_COLOR_MAP, SCHEDULABLE_AGENT_IDS } from '../types/tab';
import { type SchedState, DEFAULT_SCHED } from './types';

export const CRON_AGENT_IDS: AgentId[] = SCHEDULABLE_AGENT_IDS;

export const CRON_AGENT_LABEL: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_TITLE_MAP).filter(([id]) => id !== 'terminal'),
);

export const CRON_AGENT_COLOR: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_COLOR_MAP).filter(([id]) => id !== 'terminal'),
);

export const WEEKDAY_LABEL = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Parse a 5-field cron expression into a structured SchedState.
 * Falls back to `mode: 'cron'` (custom) for expressions that don't match
 * the recognised interval/at-time patterns.
 */
export function parseCronSchedule(expr: string): SchedState {
  const f = (expr ?? '').trim().split(/\s+/);
  if (f.length !== 5) return { ...DEFAULT_SCHED, mode: 'cron', customExpr: expr };
  const [mf, hf, domf, , dowf] = f;

  // ── Interval patterns ────────────────────────────────────────────────────
  const mStep = mf.match(/^\*\/(\d+)$/);
  if (mStep && hf === '*' && domf === '*') {
    return { ...DEFAULT_SCHED, mode: 'interval', intervalVal: +mStep[1], intervalUnit: 'min' };
  }
  const hStep = hf.match(/^\*\/(\d+)$/);
  if (mf === '0' && hStep && domf === '*') {
    return { ...DEFAULT_SCHED, mode: 'interval', intervalVal: +hStep[1], intervalUnit: 'hour' };
  }
  const domStep = domf.match(/^\*\/(\d+)$/);
  if (mf === '0' && hf === '0' && domStep) {
    return { ...DEFAULT_SCHED, mode: 'interval', intervalVal: +domStep[1], intervalUnit: 'day' };
  }

  // ── At-time patterns ─────────────────────────────────────────────────────
  const mNum = parseInt(mf, 10);
  const hNum = parseInt(hf, 10);
  if (!isNaN(mNum) && mNum >= 0 && mNum <= 59 && !isNaN(hNum) && hNum >= 0 && hNum <= 23) {
    const base = { ...DEFAULT_SCHED, mode: 'at' as const, atHour: hNum, atMin: mNum };
    if (domf === '*' && dowf === '*') return { ...base, atRepeat: 'daily' };
    if (domf === '*' && dowf === '1-5') return { ...base, atRepeat: 'weekdays' };
    if (domf === '*' && /^\d+$/.test(dowf)) {
      const wd = parseInt(dowf, 10);
      if (wd >= 0 && wd <= 6)
        return { ...base, atRepeat: 'weekly', atWeekday: wd };
    }
    if (dowf === '*' && /^\d+$/.test(domf)) {
      const dom = parseInt(domf, 10);
      if (dom >= 1 && dom <= 31)
        return { ...base, atRepeat: 'monthly', atMonthDay: dom };
    }
  }

  return { ...DEFAULT_SCHED, mode: 'cron', customExpr: expr };
}

/** Build a 5-field cron expression from a SchedState. */
export function buildCronExpr(s: SchedState): string {
  if (s.mode === 'interval') {
    const v = Math.max(1, s.intervalVal);
    if (s.intervalUnit === 'min') return `*/${v} * * * *`;
    if (s.intervalUnit === 'hour') return `0 */${v} * * *`;
    return `0 0 */${v} * *`;
  }
  if (s.mode === 'at') {
    const m = s.atMin.toString().padStart(2, '0');
    const h = s.atHour.toString();
    if (s.atRepeat === 'daily') return `${m} ${h} * * *`;
    if (s.atRepeat === 'weekdays') return `${m} ${h} * * 1-5`;
    if (s.atRepeat === 'weekly') return `${m} ${h} * * ${s.atWeekday}`;
    if (s.atRepeat === 'monthly') return `${m} ${h} ${s.atMonthDay} * *`;
  }
  return s.customExpr;
}

/** Human-readable description of a cron expression. */
export function describeCronExpr(expr: string): string {
  const s = parseCronSchedule(expr);
  if (s.mode === 'interval') {
    const v = Math.max(1, s.intervalVal);
    if (s.intervalUnit === 'min') return `Every ${v} min`;
    if (s.intervalUnit === 'hour') return `Every ${v} hr`;
    return `Every ${v} day${v > 1 ? 's' : ''}`;
  }
  if (s.mode === 'at') {
    const t = `${s.atHour.toString().padStart(2, '0')}:${s.atMin.toString().padStart(2, '0')}`;
    if (s.atRepeat === 'daily') return `Daily at ${t}`;
    if (s.atRepeat === 'weekdays') return `Weekdays at ${t}`;
    if (s.atRepeat === 'weekly')
      return `Every ${WEEKDAY_LABEL[s.atWeekday] ?? `day ${s.atWeekday}`} at ${t}`;
    if (s.atRepeat === 'monthly') return `Monthly on day ${s.atMonthDay} at ${t}`;
  }
  return expr;
}

/**
 * Format a Unix timestamp as a relative (future) or absolute (past) string.
 * Returns '—' for falsy input.
 */
export function fmtCronTime(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  if (diff > 0) {
    const m = Math.round(diff / 60000);
    if (m < 2) return 'in <1 min';
    if (m < 60) return `in ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `in ${h}h`;
    return d.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
