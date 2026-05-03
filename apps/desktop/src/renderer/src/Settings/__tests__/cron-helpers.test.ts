import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  parseCronSchedule,
  buildCronExpr,
  describeCronExpr,
  fmtCronTime,
} from '../cron-helpers';
import { DEFAULT_SCHED } from '../types';

// ── parseCronSchedule ────────────────────────────────────────────────────────

describe('parseCronSchedule', () => {
  describe('interval mode', () => {
    it('parses every N minutes: */30 * * * *', () => {
      const s = parseCronSchedule('*/30 * * * *');
      expect(s.mode).toBe('interval');
      expect(s.intervalUnit).toBe('min');
      expect(s.intervalVal).toBe(30);
    });

    it('parses every 1 minute: */1 * * * *', () => {
      const s = parseCronSchedule('*/1 * * * *');
      expect(s.mode).toBe('interval');
      expect(s.intervalVal).toBe(1);
      expect(s.intervalUnit).toBe('min');
    });

    it('parses every N hours: 0 */2 * * *', () => {
      const s = parseCronSchedule('0 */2 * * *');
      expect(s.mode).toBe('interval');
      expect(s.intervalUnit).toBe('hour');
      expect(s.intervalVal).toBe(2);
    });

    it('parses every N days: 0 0 */3 * *', () => {
      const s = parseCronSchedule('0 0 */3 * *');
      expect(s.mode).toBe('interval');
      expect(s.intervalUnit).toBe('day');
      expect(s.intervalVal).toBe(3);
    });
  });

  describe('at-time mode', () => {
    it('parses daily: 0 9 * * *', () => {
      const s = parseCronSchedule('0 9 * * *');
      expect(s.mode).toBe('at');
      expect(s.atHour).toBe(9);
      expect(s.atMin).toBe(0);
      expect(s.atRepeat).toBe('daily');
    });

    it('parses daily with minutes: 30 14 * * *', () => {
      const s = parseCronSchedule('30 14 * * *');
      expect(s.mode).toBe('at');
      expect(s.atHour).toBe(14);
      expect(s.atMin).toBe(30);
      expect(s.atRepeat).toBe('daily');
    });

    it('parses weekdays: 0 9 * * 1-5', () => {
      const s = parseCronSchedule('0 9 * * 1-5');
      expect(s.mode).toBe('at');
      expect(s.atRepeat).toBe('weekdays');
      expect(s.atHour).toBe(9);
    });

    it('parses weekly on Wednesday: 0 10 * * 3', () => {
      const s = parseCronSchedule('0 10 * * 3');
      expect(s.mode).toBe('at');
      expect(s.atRepeat).toBe('weekly');
      expect(s.atWeekday).toBe(3);
      expect(s.atHour).toBe(10);
    });

    it('parses weekly on Sunday (0): 0 8 * * 0', () => {
      const s = parseCronSchedule('0 8 * * 0');
      expect(s.mode).toBe('at');
      expect(s.atRepeat).toBe('weekly');
      expect(s.atWeekday).toBe(0);
    });

    it('parses monthly on day 15: 0 8 15 * *', () => {
      const s = parseCronSchedule('0 8 15 * *');
      expect(s.mode).toBe('at');
      expect(s.atRepeat).toBe('monthly');
      expect(s.atMonthDay).toBe(15);
      expect(s.atHour).toBe(8);
    });

    it('parses monthly on day 1: 0 0 1 * *', () => {
      const s = parseCronSchedule('0 0 1 * *');
      expect(s.mode).toBe('at');
      expect(s.atRepeat).toBe('monthly');
      expect(s.atMonthDay).toBe(1);
    });
  });

  describe('cron (custom) mode fallback', () => {
    it('falls back for comma-separated dom: 0 9 1,15 * *', () => {
      const s = parseCronSchedule('0 9 1,15 * *');
      expect(s.mode).toBe('cron');
      expect(s.customExpr).toBe('0 9 1,15 * *');
    });

    it('falls back for wrong field count', () => {
      const s = parseCronSchedule('not-valid');
      expect(s.mode).toBe('cron');
    });

    it('falls back for empty string', () => {
      const s = parseCronSchedule('');
      expect(s.mode).toBe('cron');
    });

    it('preserves the original expression as customExpr', () => {
      const expr = '0 9 1 1 *';
      const s = parseCronSchedule(expr);
      if (s.mode === 'cron') {
        expect(s.customExpr).toBe(expr);
      }
    });
  });
});

// ── buildCronExpr ────────────────────────────────────────────────────────────

describe('buildCronExpr', () => {
  it('builds interval every 15 min', () => {
    expect(
      buildCronExpr({ ...DEFAULT_SCHED, mode: 'interval', intervalVal: 15, intervalUnit: 'min' }),
    ).toBe('*/15 * * * *');
  });

  it('builds interval every 6 hours', () => {
    expect(
      buildCronExpr({ ...DEFAULT_SCHED, mode: 'interval', intervalVal: 6, intervalUnit: 'hour' }),
    ).toBe('0 */6 * * *');
  });

  it('builds interval every 2 days', () => {
    expect(
      buildCronExpr({ ...DEFAULT_SCHED, mode: 'interval', intervalVal: 2, intervalUnit: 'day' }),
    ).toBe('0 0 */2 * *');
  });

  it('clamps interval to minimum 1', () => {
    expect(
      buildCronExpr({ ...DEFAULT_SCHED, mode: 'interval', intervalVal: 0, intervalUnit: 'min' }),
    ).toBe('*/1 * * * *');
  });

  it('builds daily at 9:00', () => {
    expect(
      buildCronExpr({ ...DEFAULT_SCHED, mode: 'at', atHour: 9, atMin: 0, atRepeat: 'daily' }),
    ).toBe('00 9 * * *');
  });

  it('builds daily at 14:30', () => {
    expect(
      buildCronExpr({ ...DEFAULT_SCHED, mode: 'at', atHour: 14, atMin: 30, atRepeat: 'daily' }),
    ).toBe('30 14 * * *');
  });

  it('builds weekdays', () => {
    expect(
      buildCronExpr({ ...DEFAULT_SCHED, mode: 'at', atHour: 9, atMin: 0, atRepeat: 'weekdays' }),
    ).toBe('00 9 * * 1-5');
  });

  it('builds weekly on Friday', () => {
    expect(
      buildCronExpr({
        ...DEFAULT_SCHED,
        mode: 'at',
        atHour: 10,
        atMin: 0,
        atRepeat: 'weekly',
        atWeekday: 5,
      }),
    ).toBe('00 10 * * 5');
  });

  it('builds monthly on day 1', () => {
    expect(
      buildCronExpr({
        ...DEFAULT_SCHED,
        mode: 'at',
        atHour: 8,
        atMin: 0,
        atRepeat: 'monthly',
        atMonthDay: 1,
      }),
    ).toBe('00 8 1 * *');
  });

  it('returns customExpr for cron mode', () => {
    expect(
      buildCronExpr({ ...DEFAULT_SCHED, mode: 'cron', customExpr: '0 0 1 * *' }),
    ).toBe('0 0 1 * *');
  });
});

// ── describeCronExpr ─────────────────────────────────────────────────────────

describe('describeCronExpr', () => {
  it('describes every 30 minutes', () => {
    expect(describeCronExpr('*/30 * * * *')).toBe('Every 30 min');
  });

  it('describes every 1 minute', () => {
    expect(describeCronExpr('*/1 * * * *')).toBe('Every 1 min');
  });

  it('describes every 2 hours', () => {
    expect(describeCronExpr('0 */2 * * *')).toBe('Every 2 hr');
  });

  it('describes every 1 day', () => {
    expect(describeCronExpr('0 0 */1 * *')).toBe('Every 1 day');
  });

  it('describes every 3 days (plural)', () => {
    expect(describeCronExpr('0 0 */3 * *')).toBe('Every 3 days');
  });

  it('describes daily at 9:00', () => {
    expect(describeCronExpr('0 9 * * *')).toBe('Daily at 09:00');
  });

  it('describes weekdays at 9:00', () => {
    expect(describeCronExpr('0 9 * * 1-5')).toBe('Weekdays at 09:00');
  });

  it('describes weekly on Wednesday', () => {
    expect(describeCronExpr('0 10 * * 3')).toBe('Every Wed at 10:00');
  });

  it('describes monthly on day 15', () => {
    expect(describeCronExpr('0 8 15 * *')).toBe('Monthly on day 15 at 08:00');
  });

  it('returns raw expression for complex cron', () => {
    const expr = '0 9 1,15 * *';
    expect(describeCronExpr(expr)).toBe(expr);
  });
});

// ── fmtCronTime ──────────────────────────────────────────────────────────────

describe('fmtCronTime', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "—" for null', () => {
    expect(fmtCronTime(null)).toBe('—');
  });

  it('returns "—" for 0', () => {
    expect(fmtCronTime(0)).toBe('—');
  });

  it('returns "in <1 min" for <2 min future', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    expect(fmtCronTime(now + 30_000)).toBe('in <1 min');
  });

  it('returns "in N min" for minutes-away future', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    expect(fmtCronTime(now + 5 * 60_000)).toBe('in 5 min');
  });

  it('returns "in Nh" for hours-away future', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    expect(fmtCronTime(now + 3 * 3600_000)).toBe('in 3h');
  });

  it('returns locale string for past timestamps', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const past = now - 2 * 3600_000;
    const result = fmtCronTime(past);
    // Should be a non-empty locale string
    expect(result.length).toBeGreaterThan(0);
    expect(result).not.toBe('—');
  });
});
