/**
 * Unit tests for the CronJob scheduler module.
 *
 * Uses a temporary home directory so no real ~/.tday is touched.
 */

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ── Shared temp home ──────────────────────────────────────────────────────────

const tmpHome = mkdtempSync(join(tmpdir(), 'tday-cron-test-'));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => tmpHome };
});

// Import AFTER mock is set up.
const {
  matchesCronField,
  nextRunTime,
  loadCronJobs,
  saveCronJobs,
  loadCronStats,
  updateJobStats,
  CronScheduler,
  formatPromptForAgent,
} = await import('../cron.js');

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── matchesCronField ──────────────────────────────────────────────────────────

describe('matchesCronField', () => {
  it('* matches anything', () => {
    expect(matchesCronField(0, '*', 0, 59)).toBe(true);
    expect(matchesCronField(59, '*', 0, 59)).toBe(true);
  });

  it('exact value matches', () => {
    expect(matchesCronField(5, '5', 0, 59)).toBe(true);
    expect(matchesCronField(4, '5', 0, 59)).toBe(false);
  });

  it('comma-separated list', () => {
    expect(matchesCronField(1, '1,3,5', 0, 6)).toBe(true);
    expect(matchesCronField(3, '1,3,5', 0, 6)).toBe(true);
    expect(matchesCronField(2, '1,3,5', 0, 6)).toBe(false);
  });

  it('range n-m', () => {
    expect(matchesCronField(3, '1-5', 0, 6)).toBe(true);
    expect(matchesCronField(5, '1-5', 0, 6)).toBe(true);
    expect(matchesCronField(6, '1-5', 0, 6)).toBe(false);
  });

  it('step */n', () => {
    // Every 15 minutes starting from 0: 0, 15, 30, 45
    expect(matchesCronField(0, '*/15', 0, 59)).toBe(true);
    expect(matchesCronField(15, '*/15', 0, 59)).toBe(true);
    expect(matchesCronField(30, '*/15', 0, 59)).toBe(true);
    expect(matchesCronField(7, '*/15', 0, 59)).toBe(false);
  });

  it('range with step n-m/n', () => {
    // 1-5/2 → 1, 3, 5
    expect(matchesCronField(1, '1-5/2', 1, 5)).toBe(true);
    expect(matchesCronField(3, '1-5/2', 1, 5)).toBe(true);
    expect(matchesCronField(5, '1-5/2', 1, 5)).toBe(true);
    expect(matchesCronField(2, '1-5/2', 1, 5)).toBe(false);
  });
});

// ── nextRunTime ───────────────────────────────────────────────────────────────

describe('nextRunTime', () => {
  it('throws on invalid expression', () => {
    expect(() => nextRunTime('* * *')).toThrow(/Invalid cron/);
  });

  it('* * * * * fires on the very next minute', () => {
    // Use a fixed local time: Jan 15 2025 at 10:05:30
    const now = new Date(2025, 0, 15, 10, 5, 30);
    const next = nextRunTime('* * * * *', now);
    expect(next.getMinutes()).toBe(6);
    expect(next.getHours()).toBe(10);
    expect(next.getSeconds()).toBe(0);
  });

  it('0 9 * * * fires at 9:00 the following day if past 9 am', () => {
    // Local 10:05 → next 9:00 is tomorrow
    const now = new Date(2025, 0, 15, 10, 5, 0);
    const next = nextRunTime('0 9 * * *', now);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(16);
  });

  it('0 9 * * * fires at 9:00 today if before 9 am', () => {
    // Local 08:59 → next 9:00 is today
    const now = new Date(2025, 0, 15, 8, 59, 0);
    const next = nextRunTime('0 9 * * *', now);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
    expect(next.getDate()).toBe(15);
  });

  it('*/5 * * * * fires on the next 5-minute boundary', () => {
    const now = new Date(2025, 0, 15, 10, 3, 0);
    const next = nextRunTime('*/5 * * * *', now);
    expect(next.getMinutes()).toBe(5);
  });

  it('weekday schedule 0 9 * * 1-5 skips weekends', () => {
    // Jan 18 2025 is a Saturday at 10:00 local
    const now = new Date(2025, 0, 18, 10, 0, 0);
    expect(now.getDay()).toBe(6); // Sanity: Saturday
    const next = nextRunTime('0 9 * * 1-5', now);
    // Must be Mon-Fri
    expect(next.getDay()).toBeGreaterThanOrEqual(1);
    expect(next.getDay()).toBeLessThanOrEqual(5);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it('specific month 0 0 1 3 * fires on March 1', () => {
    // Jan 1 at midnight local → next March 1
    const now = new Date(2025, 0, 1, 0, 0, 0);
    const next = nextRunTime('0 0 1 3 *', now);
    expect(next.getMonth()).toBe(2); // March = 2 (0-indexed)
    expect(next.getDate()).toBe(1);
  });
});

// ── Storage helpers ───────────────────────────────────────────────────────────

describe('CronJob storage', () => {
  beforeEach(() => {
    // Clear settings by saving empty arrays
    saveCronJobs([]);
  });

  const makeJob = (id: string): import('@tday/shared').CronJob => ({
    id,
    name: `Job ${id}`,
    agentId: 'codex',
    cwd: '/tmp',
    prompt: 'test prompt',
    schedule: '* * * * *',
    enabled: true,
    createdAt: Date.now(),
  });

  it('loads empty list when no jobs saved', () => {
    expect(loadCronJobs()).toEqual([]);
  });

  it('persists and loads cron jobs', () => {
    const jobs = [makeJob('a'), makeJob('b')];
    saveCronJobs(jobs);
    const loaded = loadCronJobs();
    expect(loaded).toHaveLength(2);
    expect(loaded[0].id).toBe('a');
    expect(loaded[1].id).toBe('b');
  });

  it('updateJobStats creates and persists stats', () => {
    const stats = updateJobStats('job1', { runCount: 5, lastStatus: 'ok', lastRunAt: 1000 });
    expect(stats.jobId).toBe('job1');
    expect(stats.runCount).toBe(5);
    expect(stats.lastStatus).toBe('ok');
    const all = loadCronStats();
    expect(all['job1']).toBeDefined();
    expect(all['job1'].runCount).toBe(5);
  });
});

// ── CronScheduler ─────────────────────────────────────────────────────────────

describe('CronScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    saveCronJobs([]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires callback when timer elapses', async () => {
    const fired: string[] = [];
    const scheduler = new CronScheduler((job) => fired.push(job.id));

    // Use a schedule that fires every minute
    const job: import('@tday/shared').CronJob = {
      id: 'test-j',
      name: 'Test',
      agentId: 'codex',
      cwd: '/tmp',
      prompt: 'hello',
      schedule: '* * * * *',
      enabled: true,
      createdAt: Date.now(),
    };

    scheduler.scheduleAll([job]);

    // Advance past 1 minute
    await vi.advanceTimersByTimeAsync(61_000);

    expect(fired).toContain('test-j');
    scheduler.destroy();
  });

  it('does not fire disabled jobs', async () => {
    const fired: string[] = [];
    const scheduler = new CronScheduler((job) => fired.push(job.id));

    const job: import('@tday/shared').CronJob = {
      id: 'disabled-j',
      name: 'Disabled',
      agentId: 'pi',
      cwd: '/tmp',
      prompt: 'hello',
      schedule: '* * * * *',
      enabled: false,
      createdAt: Date.now(),
    };

    scheduler.scheduleAll([job]);
    await vi.advanceTimersByTimeAsync(61_000);

    expect(fired).not.toContain('disabled-j');
    scheduler.destroy();
  });

  it('triggerNow fires immediately', () => {
    const fired: string[] = [];
    const scheduler = new CronScheduler((job) => fired.push(job.id));

    const job: import('@tday/shared').CronJob = {
      id: 'trigger-j',
      name: 'Trigger',
      agentId: 'codex',
      cwd: '/tmp',
      prompt: 'hi',
      schedule: '0 9 * * *', // not due for hours
      enabled: true,
      createdAt: Date.now(),
    };

    scheduler.scheduleAll([job]);
    scheduler.triggerNow(job);

    expect(fired).toContain('trigger-j');
    scheduler.destroy();
  });

  it('unschedule removes the timer', async () => {
    const fired: string[] = [];
    const scheduler = new CronScheduler((job) => fired.push(job.id));

    const job: import('@tday/shared').CronJob = {
      id: 'unsched-j',
      name: 'Unsched',
      agentId: 'codex',
      cwd: '/tmp',
      prompt: 'hi',
      schedule: '* * * * *',
      enabled: true,
      createdAt: Date.now(),
    };

    scheduler.scheduleAll([job]);
    scheduler.unschedule('unsched-j');

    await vi.advanceTimersByTimeAsync(61_000);
    expect(fired).not.toContain('unsched-j');
    scheduler.destroy();
  });

  it('destroy clears all timers', async () => {
    const fired: string[] = [];
    const scheduler = new CronScheduler((job) => fired.push(job.id));

    const jobs: import('@tday/shared').CronJob[] = ['a', 'b', 'c'].map((id) => ({
      id,
      name: id,
      agentId: 'codex' as import('@tday/shared').AgentId,
      cwd: '/tmp',
      prompt: '',
      schedule: '* * * * *',
      enabled: true,
      createdAt: Date.now(),
    }));

    scheduler.scheduleAll(jobs);
    scheduler.destroy();

    await vi.advanceTimersByTimeAsync(61_000);
    expect(fired).toHaveLength(0);
  });
});

// ── formatPromptForAgent ──────────────────────────────────────────────────────

describe('formatPromptForAgent', () => {
  it('returns raw prompt for codex (no /goal prefix)', () => {
    const result = formatPromptForAgent('codex', 'Fix all lint errors');
    expect(result).toBe('Fix all lint errors');
  });

  it('returns raw prompt for other agents', () => {
    expect(formatPromptForAgent('claude-code', 'Fix all lint errors')).toBe('Fix all lint errors');
    expect(formatPromptForAgent('pi', 'hello world')).toBe('hello world');
    expect(formatPromptForAgent('opencode', 'test')).toBe('test');
  });
});
