/**
 * CronJob scheduler for Tday.
 *
 * Parses standard 5-field cron expressions ("min hour dom month dow"),
 * computes the next fire time, and triggers a callback when the time arrives.
 * Statistics (lastRunAt, nextRunAt, runCount) are persisted to settings-store.
 *
 * Storage keys:
 *   tday:cron-jobs  → CronJob[]
 *   tday:cron-stats → Record<jobId, CronJobStats>
 */

import type { CronJob, CronJobStats, AgentId } from '@tday/shared';
import { getSetting, setSetting } from './settings-store.js';

const JOBS_KEY = 'tday:cron-jobs';
const STATS_KEY = 'tday:cron-stats';

// ── Cron expression parser ────────────────────────────────────────────────────

/**
 * Returns true if `value` satisfies the cron `field` with the given min/max
 * domain. Supports: `*`, `n`, `n,m,...`, `n-m`, `*\/n`, `n-m\/n`.
 */
export function matchesCronField(value: number, field: string, _min: number, _max: number): boolean {
  const parts = field.split(',');
  for (const part of parts) {
    if (part === '*') return true;
    // step: */n or range/n
    if (part.includes('/')) {
      const [rangePart, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;
      if (rangePart === '*') {
        if ((value - _min) % step === 0) return true;
      } else if (rangePart.includes('-')) {
        const [lo, hi] = rangePart.split('-').map(Number);
        if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      }
      continue;
    }
    // range: n-m
    if (part.includes('-')) {
      const [lo, hi] = part.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
      continue;
    }
    // literal
    const n = parseInt(part, 10);
    if (!isNaN(n) && n === value) return true;
  }
  return false;
}

/**
 * Compute the next Date when the given 5-field cron expression will fire,
 * starting from `from` (exclusive — always at least 1 minute in the future).
 *
 * Iterates minute-by-minute, capped at 366 days.
 * Throws if no match is found within the search horizon.
 */
export function nextRunTime(schedule: string, from: Date = new Date()): Date {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron expression (need 5 fields): "${schedule}"`);
  const [minF, hourF, domF, monthF, dowF] = fields;

  const domStar = domF === '*' || domF === '?';
  const dowStar = dowF === '*' || dowF === '?';

  const candidate = new Date(from);
  // Advance to the start of the next minute.
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const maxIter = 366 * 24 * 60; // ~1 year in minutes
  for (let i = 0; i < maxIter; i++) {
    const month = candidate.getMonth() + 1; // 1-12
    const dom = candidate.getDate();        // 1-31
    const hour = candidate.getHours();      // 0-23
    const min = candidate.getMinutes();     // 0-59
    const dow = candidate.getDay();         // 0-6 (Sun=0)

    const monthOk = matchesCronField(month, monthF, 1, 12);
    if (!monthOk) {
      // Jump to 1st of next month at midnight.
      candidate.setDate(1);
      candidate.setHours(0, 0, 0, 0);
      candidate.setMonth(candidate.getMonth() + 1);
      continue;
    }

    // DOM/DOW logic: if both are restricted, either matching is enough.
    let dayOk: boolean;
    if (!domStar && !dowStar) {
      dayOk = matchesCronField(dom, domF, 1, 31) || matchesCronField(dow, dowF, 0, 6);
    } else if (!domStar) {
      dayOk = matchesCronField(dom, domF, 1, 31);
    } else if (!dowStar) {
      dayOk = matchesCronField(dow, dowF, 0, 6);
    } else {
      dayOk = true;
    }

    if (!dayOk) {
      // Jump to next day at midnight.
      candidate.setHours(0, 0, 0, 0);
      candidate.setDate(candidate.getDate() + 1);
      continue;
    }

    const hourOk = matchesCronField(hour, hourF, 0, 23);
    if (!hourOk) {
      // Jump to next hour at minute 0.
      candidate.setMinutes(0, 0, 0);
      candidate.setHours(candidate.getHours() + 1);
      continue;
    }

    const minOk = matchesCronField(min, minF, 0, 59);
    if (minOk) return candidate;

    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  throw new Error(`Could not compute next run time for schedule: "${schedule}"`);
}

// ── Storage helpers ───────────────────────────────────────────────────────────

export function loadCronJobs(): CronJob[] {
  try {
    const raw = getSetting(JOBS_KEY, [] as import('./settings-store.js').JsonValue);
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).filter(
      (j): j is CronJob =>
        !!j &&
        typeof j === 'object' &&
        typeof (j as CronJob).id === 'string' &&
        typeof (j as CronJob).schedule === 'string',
    );
  } catch {
    return [];
  }
}

export function saveCronJobs(jobs: CronJob[]): void {
  setSetting(JOBS_KEY, jobs as unknown as import('./settings-store.js').JsonValue);
}

export function loadCronStats(): Record<string, CronJobStats> {
  try {
    const raw = getSetting(STATS_KEY, {} as import('./settings-store.js').JsonValue);
    return (raw ?? {}) as unknown as Record<string, CronJobStats>;
  } catch {
    return {};
  }
}

export function saveCronStats(stats: Record<string, CronJobStats>): void {
  setSetting(STATS_KEY, stats as unknown as import('./settings-store.js').JsonValue);
}

export function updateJobStats(
  jobId: string,
  patch: Partial<CronJobStats>,
): CronJobStats {
  const all = loadCronStats();
  const existing = all[jobId] ?? {
    jobId,
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    lastStatus: null,
  };
  const updated = { ...existing, ...patch };
  all[jobId] = updated;
  saveCronStats(all);
  return updated;
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

export type CronFireCallback = (job: CronJob) => void;

export class CronScheduler {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private onFire: CronFireCallback;

  constructor(onFire: CronFireCallback) {
    this.onFire = onFire;
  }

  /** Schedule all enabled jobs. Replaces any existing schedules. */
  scheduleAll(jobs: CronJob[]): void {
    // Tear down everything first.
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();

    for (const job of jobs) {
      if (job.enabled) this.scheduleOne(job);
    }
  }

  /** Schedule (or re-schedule) a single job. */
  scheduleOne(job: CronJob): void {
    // Remove any existing timer for this job.
    const old = this.timers.get(job.id);
    if (old !== undefined) {
      clearTimeout(old);
      this.timers.delete(job.id);
    }

    if (!job.enabled) return;

    let nextDate: Date;
    try {
      nextDate = nextRunTime(job.schedule);
    } catch (err) {
      console.error(`[cron] invalid schedule for "${job.name}":`, err);
      return;
    }

    const delay = nextDate.getTime() - Date.now();
    updateJobStats(job.id, { nextRunAt: nextDate.getTime() });

    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      this.fireFn(job);
      // Immediately reschedule for the next occurrence.
      this.scheduleOne(job);
    }, Math.max(0, delay));

    this.timers.set(job.id, timer);
  }

  /** Remove a job's timer without rescheduling. */
  unschedule(jobId: string): void {
    const t = this.timers.get(jobId);
    if (t !== undefined) {
      clearTimeout(t);
      this.timers.delete(jobId);
    }
  }

  /** Fire a job immediately (manual trigger) without affecting the schedule. */
  triggerNow(job: CronJob): void {
    this.fireFn(job);
  }

  destroy(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  // ── private ────────────────────────────────────────────────────────────────

  private fireFn(job: CronJob): void {
    try {
      // Update stats before invoking callback so renderer sees fresh data.
      updateJobStats(job.id, {
        lastRunAt: Date.now(),
        lastStatus: 'ok',
        runCount: (loadCronStats()[job.id]?.runCount ?? 0) + 1,
      });
      this.onFire(job);
    } catch (err) {
      console.error(`[cron] error firing job "${job.name}":`, err);
      updateJobStats(job.id, { lastStatus: 'error' });
    }
  }
}

// ── Prompt formatting ─────────────────────────────────────────────────────────

/**
 * Format the prompt for the given agent.
 * - codex: use `/goal <prompt>` (slash-command for autonomous mode)
 * Returns the prompt as-is (agent-specific formatting is handled by the agent itself).
 */
export function formatPromptForAgent(_agentId: AgentId, prompt: string): string {
  return prompt;
}
