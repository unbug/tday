import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  histAgentLabel,
  histAgentColor,
  histTimeGroup,
  histRelative,
  HIST_AGENT_LABEL,
  HIST_AGENT_COLOR,
} from '../history-helpers';
import { fmtNum } from '../shared';

// ── histAgentLabel ───────────────────────────────────────────────────────────

describe('histAgentLabel', () => {
  it('returns known label for claude-code', () => {
    expect(histAgentLabel('claude-code')).toBe('Claude');
  });

  it('returns known label for pi', () => {
    expect(histAgentLabel('pi')).toBe('Pi');
  });

  it('returns known label for all defined agents', () => {
    for (const [id, label] of Object.entries(HIST_AGENT_LABEL)) {
      expect(histAgentLabel(id)).toBe(label);
    }
  });

  it('returns the raw id for an unknown agent', () => {
    expect(histAgentLabel('unknown-agent')).toBe('unknown-agent');
  });

  it('returns the raw id for an empty string', () => {
    expect(histAgentLabel('')).toBe('');
  });
});

// ── histAgentColor ───────────────────────────────────────────────────────────

describe('histAgentColor', () => {
  it('returns known color for pi', () => {
    expect(histAgentColor('pi')).toBe('#a78bfa');
  });

  it('returns fallback grey for unknown agent', () => {
    expect(histAgentColor('no-such-agent')).toBe('#71717a');
  });

  it('returns known color for all defined agents', () => {
    for (const [id, color] of Object.entries(HIST_AGENT_COLOR)) {
      expect(histAgentColor(id)).toBe(color);
    }
  });
});

// ── histTimeGroup ────────────────────────────────────────────────────────────

describe('histTimeGroup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const setNow = (isoDate: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(isoDate));
  };

  it('classifies timestamp from today as "Today"', () => {
    setNow('2026-05-21T12:00:00');
    const todayMorning = new Date('2026-05-21T08:00:00').getTime();
    expect(histTimeGroup(todayMorning)).toBe('Today');
  });

  it('classifies timestamp from yesterday as "Yesterday"', () => {
    setNow('2026-05-21T12:00:00');
    const yesterday = new Date('2026-05-20T15:00:00').getTime();
    expect(histTimeGroup(yesterday)).toBe('Yesterday');
  });

  it('classifies a timestamp earlier this week as "This Week"', () => {
    // Use May 21 (Thursday) as "now" → weekStart = May 18 (Monday)
    // May 19 (Tuesday) is in the same week
    setNow('2026-05-21T12:00:00');
    const earlier = new Date('2026-05-19T10:00:00').getTime();
    expect(histTimeGroup(earlier)).toBe('This Week');
  });

  it('classifies a timestamp earlier this month as "This Month"', () => {
    // Use May 21 (Thursday) as "now" → weekStart = May 18 (Monday)
    // May 7 is in the same month but before weekStart → "This Month"
    setNow('2026-05-21T12:00:00');
    const earlierMonth = new Date('2026-05-07T06:00:00').getTime();
    expect(histTimeGroup(earlierMonth)).toBe('This Month');
  });

  it('classifies an old timestamp as "Older"', () => {
    setNow('2026-05-21T12:00:00');
    const old = new Date('2026-01-15T10:00:00').getTime();
    expect(histTimeGroup(old)).toBe('Older');
  });
});

// ── histRelative ─────────────────────────────────────────────────────────────

describe('histRelative', () => {
  it('returns a non-empty string', () => {
    const ts = new Date('2026-04-15T09:30:00').getTime();
    const result = histRelative(ts);
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('includes the year in the output', () => {
    const ts = new Date('2026-04-15T09:30:00').getTime();
    const result = histRelative(ts);
    expect(result).toContain('2026');
  });
});

// ── fmtNum ───────────────────────────────────────────────────────────────────

describe('fmtNum', () => {
  it('formats numbers below 1000 as plain strings', () => {
    expect(fmtNum(0)).toBe('0');
    expect(fmtNum(999)).toBe('999');
    expect(fmtNum(42)).toBe('42');
  });

  it('formats thousands with K suffix', () => {
    expect(fmtNum(1000)).toBe('1.0K');
    expect(fmtNum(1500)).toBe('1.5K');
    expect(fmtNum(999_999)).toBe('1000.0K');
  });

  it('formats millions with M suffix', () => {
    expect(fmtNum(1_000_000)).toBe('1.0M');
    expect(fmtNum(2_500_000)).toBe('2.5M');
  });

  it('handles large numbers', () => {
    expect(fmtNum(10_000_000)).toBe('10.0M');
  });
});
