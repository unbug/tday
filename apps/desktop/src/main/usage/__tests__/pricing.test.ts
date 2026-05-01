/**
 * Unit tests for usage/pricing.ts
 */

import { describe, it, expect } from 'vitest';
import { resolvePrice, calcCost, BUILTIN_PRICING } from '../pricing.js';

describe('resolvePrice', () => {
  it('returns exact match for known models', () => {
    const p = resolvePrice('gpt-4o');
    expect(p).not.toBeNull();
    expect(p!.inputPer1k).toBeGreaterThan(0);
  });

  it('returns exact match for deepseek', () => {
    const p = resolvePrice('deepseek-v4-pro');
    expect(p).not.toBeNull();
  });

  it('prefix-matches llama variants', () => {
    const p = resolvePrice('llama3:8b');
    expect(p).not.toBeNull();
    expect(p!.inputPer1k).toBe(0);
    expect(p!.outputPer1k).toBe(0);
  });

  it('prefix-matches qwen variants', () => {
    const p = resolvePrice('qwen2.5-coder-32b-instruct');
    expect(p).not.toBeNull();
    expect(p!.inputPer1k).toBe(0);
  });

  it('returns null for unknown models', () => {
    const p = resolvePrice('totally-unknown-model-xyz');
    expect(p).toBeNull();
  });

  it('exact match beats prefix match', () => {
    const table = {
      'gpt': { inputPer1k: 0.1, outputPer1k: 0.1 },
      'gpt-4o': { inputPer1k: 0.0025, outputPer1k: 0.010 },
    };
    const p = resolvePrice('gpt-4o', table);
    expect(p!.inputPer1k).toBe(0.0025);
  });

  it('respects user overrides', () => {
    const overrides = { 'my-model': { inputPer1k: 0.5, outputPer1k: 1.0 } };
    const p = resolvePrice('my-model', { ...BUILTIN_PRICING, ...overrides });
    expect(p!.inputPer1k).toBe(0.5);
  });
});

describe('calcCost', () => {
  it('calculates cost correctly', () => {
    const p = { inputPer1k: 0.002, outputPer1k: 0.010 };
    // 1000 input + 500 output
    const cost = calcCost(1000, 500, 0, p);
    expect(cost).toBeCloseTo(0.002 + 0.005, 6);
  });

  it('includes cached token cost', () => {
    const p = { inputPer1k: 0.002, outputPer1k: 0.010, cachedPer1k: 0.001 };
    const cost = calcCost(0, 0, 2000, p);
    expect(cost).toBeCloseTo(0.002, 6);
  });

  it('returns 0 for local models', () => {
    const p = { inputPer1k: 0, outputPer1k: 0 };
    expect(calcCost(100000, 100000, 0, p)).toBe(0);
  });

  it('returns null when pricing is null', () => {
    expect(calcCost(1000, 1000, 0, null)).toBeNull();
  });
});
