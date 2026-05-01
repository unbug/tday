/**
 * Unit tests for usage/store.ts
 *
 * Uses a temp file so no real ~/.tday is touched.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';

// We need to override the home dir used inside store.ts.
// The simplest approach: mock `node:os` homedir before importing the module.
const tmpHome = mkdtempSync(join(tmpdir(), 'tday-usage-test-'));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => tmpHome };
});

// Dynamic import after mock is set up
const { appendUsage, queryUsage } = await import('../store.js');

afterEach(() => {
  // Remove usage.jsonl between tests
  const usageFile = join(tmpHome, '.tday', 'usage.jsonl');
  if (existsSync(usageFile)) rmSync(usageFile);
});

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

const baseRecord = () => ({
  ts: Date.now(),
  agentId: 'codex' as const,
  providerId: 'test',
  model: 'deepseek-v4-pro',
  inputTokens: 100,
  outputTokens: 50,
  cachedTokens: 0,
});

describe('appendUsage + queryUsage', () => {
  it('starts empty', () => {
    const s = queryUsage();
    expect(s.totalRequests).toBe(0);
    expect(s.totalInputTokens).toBe(0);
  });

  it('accumulates records', () => {
    appendUsage(baseRecord());
    appendUsage(baseRecord());
    const s = queryUsage();
    expect(s.totalRequests).toBe(2);
    expect(s.totalInputTokens).toBe(200);
    expect(s.totalOutputTokens).toBe(100);
  });

  it('filters by fromTs / toTs', () => {
    const now = Date.now();
    appendUsage({ ...baseRecord(), ts: now - 10_000 }); // old
    appendUsage({ ...baseRecord(), ts: now });           // recent
    const s = queryUsage({ fromTs: now - 1_000 });
    expect(s.totalRequests).toBe(1);
  });

  it('filters by agentId', () => {
    appendUsage({ ...baseRecord(), agentId: 'codex' });
    appendUsage({ ...baseRecord(), agentId: 'pi' });
    const s = queryUsage({ agentId: 'codex' });
    expect(s.totalRequests).toBe(1);
  });

  it('filters by providerId', () => {
    appendUsage({ ...baseRecord(), providerId: 'p1' });
    appendUsage({ ...baseRecord(), providerId: 'p2' });
    const s = queryUsage({ providerId: 'p2' });
    expect(s.totalRequests).toBe(1);
  });

  it('groups by model', () => {
    appendUsage({ ...baseRecord(), model: 'deepseek-v4-pro' });
    appendUsage({ ...baseRecord(), model: 'gpt-4o' });
    appendUsage({ ...baseRecord(), model: 'gpt-4o' });
    const s = queryUsage();
    expect(s.byModel['deepseek-v4-pro']?.requests).toBe(1);
    expect(s.byModel['gpt-4o']?.requests).toBe(2);
  });

  it('groups by agent', () => {
    appendUsage({ ...baseRecord(), agentId: 'codex' });
    appendUsage({ ...baseRecord(), agentId: 'codex' });
    appendUsage({ ...baseRecord(), agentId: 'pi' });
    const s = queryUsage();
    expect(s.byAgent['codex']?.requests).toBe(2);
    expect(s.byAgent['pi']?.requests).toBe(1);
  });

  it('produces daily stats', () => {
    const today = new Date().toISOString().slice(0, 10);
    appendUsage(baseRecord());
    appendUsage(baseRecord());
    const s = queryUsage();
    expect(s.daily).toHaveLength(1);
    expect(s.daily[0].date).toBe(today);
    expect(s.daily[0].requests).toBe(2);
  });

  it('calculates cost for known models', () => {
    // deepseek-v4-pro: 0.00027/1k input, 0.0011/1k output
    appendUsage({ ...baseRecord(), model: 'deepseek-v4-pro', inputTokens: 1000, outputTokens: 1000 });
    const s = queryUsage();
    expect(s.costUsd).not.toBeNull();
    expect(s.costUsd!).toBeGreaterThan(0);
  });

  it('costUsd is 0 for local models', () => {
    appendUsage({ ...baseRecord(), model: 'llama3:8b', inputTokens: 10000, outputTokens: 5000 });
    const s = queryUsage();
    expect(s.costUsd).toBe(0);
  });

  it('costUsd is null when any model has unknown pricing', () => {
    appendUsage({ ...baseRecord(), model: 'deepseek-v4-pro' });
    appendUsage({ ...baseRecord(), model: 'totally-unknown-model-xyz' });
    const s = queryUsage();
    expect(s.costUsd).toBeNull();
  });

  it('survives malformed lines in the JSONL file', async () => {
    // Write a bad line directly
    const { appendFileSync } = await import('node:fs');
    const usageFile = join(tmpHome, '.tday', 'usage.jsonl');
    appendUsage(baseRecord()); // creates dir + file
    appendFileSync(usageFile, 'not-json\n', 'utf8');
    appendUsage(baseRecord());
    const s = queryUsage();
    expect(s.totalRequests).toBe(2); // bad line skipped
  });
});
