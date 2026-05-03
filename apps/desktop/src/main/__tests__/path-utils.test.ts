import { describe, it, expect } from 'vitest';

import {
  PATH_SEP,
  augmentPath,
} from '../path-utils.js';

describe('PATH_SEP', () => {
  it('is ";" on Windows and ":" otherwise', () => {
    const expected = process.platform === 'win32' ? ';' : ':';
    expect(PATH_SEP).toBe(expected);
  });
});

describe('augmentPath', () => {
  it('runs without error', () => {
    expect(() => augmentPath()).not.toThrow();
  });

  it('adds entries to process.env.PATH', () => {
    const before = process.env.PATH ?? '';
    augmentPath();
    const after = process.env.PATH ?? '';
    // PATH should still be a string
    expect(typeof after).toBe('string');
    // Should be at least as long (we only add, never remove)
    expect(after.length).toBeGreaterThanOrEqual(before.length);
  });

  it('deduplicates PATH entries', () => {
    augmentPath();
    augmentPath(); // second call should be idempotent
    const parts = (process.env.PATH ?? '').split(PATH_SEP).filter(Boolean);
    const unique = new Set(parts);
    expect(parts.length).toBe(unique.size);
  });
});
