import { describe, it, expect } from 'vitest';

import {
  semverAtLeast,
  envKeyForKind,
  modelFlagsFor,
  normalizeLaunchCwd,
  INSTALL_SPECS,
} from '../agent-utils.js';

describe('semverAtLeast', () => {
  it('returns true when version exactly matches', () => {
    expect(semverAtLeast('0.128.0', 0, 128, 0)).toBe(true);
  });

  it('returns true for higher version', () => {
    expect(semverAtLeast('1.0.0', 0, 128, 0)).toBe(true);
    expect(semverAtLeast('0.129.0', 0, 128, 0)).toBe(true);
    expect(semverAtLeast('0.128.1', 0, 128, 0)).toBe(true);
  });

  it('returns false for lower version', () => {
    expect(semverAtLeast('0.127.9', 0, 128, 0)).toBe(false);
    expect(semverAtLeast('0.128.0', 0, 128, 1)).toBe(false);
  });

  it('strips leading "v"', () => {
    expect(semverAtLeast('v1.0.0', 0, 128, 0)).toBe(true);
    expect(semverAtLeast('v0.127.0', 0, 128, 0)).toBe(false);
  });

  it('handles pre-release suffixes', () => {
    expect(semverAtLeast('0.128.0-beta.1', 0, 128, 0)).toBe(true);
    expect(semverAtLeast('0.127.0-rc.1', 0, 128, 0)).toBe(false);
  });

  it('returns false for invalid version', () => {
    expect(semverAtLeast('invalid', 0, 0, 1)).toBe(false);
    expect(semverAtLeast('', 0, 0, 1)).toBe(false);
  });
});

describe('envKeyForKind', () => {
  it('returns ANTHROPIC_API_KEY for anthropic style', () => {
    expect(envKeyForKind('openai', 'anthropic')).toBe('ANTHROPIC_API_KEY');
  });

  it('returns correct keys for known kinds', () => {
    expect(envKeyForKind('deepseek', undefined)).toBe('DEEPSEEK_API_KEY');
    expect(envKeyForKind('google', undefined)).toBe('GEMINI_API_KEY');
    expect(envKeyForKind('xai', undefined)).toBe('XAI_API_KEY');
    expect(envKeyForKind('groq', undefined)).toBe('GROQ_API_KEY');
    expect(envKeyForKind('mistral', undefined)).toBe('MISTRAL_API_KEY');
    expect(envKeyForKind('openrouter', undefined)).toBe('OPENROUTER_API_KEY');
    expect(envKeyForKind('anthropic', undefined)).toBe('ANTHROPIC_API_KEY');
  });

  it('falls back to OPENAI_API_KEY for unknown kinds', () => {
    expect(envKeyForKind('unknown-kind', undefined)).toBe('OPENAI_API_KEY');
    expect(envKeyForKind('openai', undefined)).toBe('OPENAI_API_KEY');
  });
});

describe('modelFlagsFor', () => {
  it('returns empty array when no model', () => {
    expect(modelFlagsFor('pi', undefined, undefined, undefined, undefined)).toEqual([]);
    expect(modelFlagsFor('claude-code', undefined, undefined, undefined, undefined)).toEqual([]);
  });

  it('returns --model flag for claude-code', () => {
    expect(modelFlagsFor('claude-code', 'claude-3-5-sonnet-20241022', undefined, undefined, undefined))
      .toEqual(['--model', 'claude-3-5-sonnet-20241022']);
  });

  it('returns --model flag for gemini', () => {
    expect(modelFlagsFor('gemini', 'gemini-2.0-flash', undefined, undefined, undefined))
      .toEqual(['--model', 'gemini-2.0-flash']);
  });

  it('composes opencode model as provider/model', () => {
    const flags = modelFlagsFor('opencode', 'gpt-4o', 'openai', 'openai', undefined);
    expect(flags[0]).toBe('--model');
    expect(flags[1]).toBe('openai/gpt-4o');
  });

  it('passes through opencode model already in slash form', () => {
    const flags = modelFlagsFor('opencode', 'anthropic/claude-3-5-sonnet', 'anthropic', undefined, undefined);
    expect(flags[1]).toBe('anthropic/claude-3-5-sonnet');
  });

  it('returns empty array for pi (unsupported)', () => {
    expect(modelFlagsFor('pi', 'some-model', undefined, undefined, undefined)).toEqual([]);
  });

  it('returns --model for codex with provider config args', () => {
    const flags = modelFlagsFor('codex', 'o3', 'openai', 'openai', 'https://api.openai.com/v1');
    expect(flags).toContain('--model');
    expect(flags).toContain('o3');
    // Should include model_provider config
    const joined = flags.join(' ');
    expect(joined).toContain('model_provider="tday"');
  });
});

describe('normalizeLaunchCwd', () => {
  it('returns homedir() when cwd is undefined', () => {
    const result = normalizeLaunchCwd(undefined);
    // Should be a non-empty path (homedir)
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns homedir() when cwd does not exist', () => {
    const result = normalizeLaunchCwd('/nonexistent/path/that/does/not/exist');
    expect(result).not.toBe('/nonexistent/path/that/does/not/exist');
  });

  it('returns cwd when it exists', () => {
    const tmpDir = process.cwd(); // always exists
    expect(normalizeLaunchCwd(tmpDir)).toBe(tmpDir);
  });
});

describe('INSTALL_SPECS', () => {
  it('has entries for all known agents', () => {
    const agents = ['pi', 'claude-code', 'codex', 'copilot', 'opencode', 'gemini', 'qwen-code', 'crush', 'hermes'];
    for (const id of agents) {
      expect(id in INSTALL_SPECS).toBe(true);
    }
  });

  it('pi spec has npmPackage', () => {
    expect(INSTALL_SPECS.pi?.npmPackage).toBe('@mariozechner/pi-coding-agent');
  });
});
