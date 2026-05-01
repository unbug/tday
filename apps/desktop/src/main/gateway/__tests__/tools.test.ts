/**
 * Unit tests for bridge/tools.ts
 */

import { describe, it, expect } from 'vitest';
import { convertTools, convertToolChoice, mutateDsRequest } from '../bridge/tools.js';
import type { ARequest } from '../anthropic/types.js';

// ─── convertTools ─────────────────────────────────────────────────────────────

describe('convertTools', () => {
  it('returns undefined for non-array input', () => {
    expect(convertTools(null)).toBeUndefined();
    expect(convertTools('string')).toBeUndefined();
    expect(convertTools({})).toBeUndefined();
  });

  it('returns undefined for empty array', () => {
    expect(convertTools([])).toBeUndefined();
  });

  it('converts a function tool', () => {
    const result = convertTools([{
      type: 'function',
      name: 'get_weather',
      description: 'Get weather data',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    }]);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe('get_weather');
    expect(result![0].description).toBe('Get weather data');
    expect(result![0].input_schema).toMatchObject({ type: 'object', properties: { city: { type: 'string' } } });
  });

  it('skips function tools without a name', () => {
    const result = convertTools([{ type: 'function', description: 'no name' }]);
    expect(result).toBeUndefined();
  });

  it('converts local_shell tool', () => {
    const result = convertTools([{ type: 'local_shell' }]);
    expect(result).toHaveLength(1);
    expect(result![0].name).toBe('local_shell');
    expect(result![0].input_schema?.required).toContain('command');
  });

  it('expands namespace tool into qualified functions', () => {
    const result = convertTools([{
      type: 'namespace',
      name: 'fs',
      tools: [
        { type: 'function', name: 'read', description: 'Read file', parameters: {} },
        { type: 'function', name: 'write', description: 'Write file', parameters: {} },
      ],
    }]);
    expect(result).toHaveLength(2);
    expect(result!.map((t) => t.name)).toEqual(['fs_read', 'fs_write']);
  });

  it('skips unsupported tool types silently', () => {
    const result = convertTools([{ type: 'file_search' }, { type: 'web_search' }]);
    expect(result).toBeUndefined();
  });

  it('mixes different tool types correctly', () => {
    const result = convertTools([
      { type: 'function', name: 'fn1', parameters: {} },
      { type: 'local_shell' },
    ]);
    expect(result).toHaveLength(2);
    expect(result!.map((t) => t.name)).toContain('fn1');
    expect(result!.map((t) => t.name)).toContain('local_shell');
  });
});

// ─── convertToolChoice ────────────────────────────────────────────────────────

describe('convertToolChoice', () => {
  it('returns undefined for falsy', () => {
    expect(convertToolChoice(null)).toBeUndefined();
    expect(convertToolChoice(undefined)).toBeUndefined();
    expect(convertToolChoice('')).toBeUndefined();
  });

  it('maps "auto" → {type: "auto"}', () => {
    expect(convertToolChoice('auto')).toEqual({ type: 'auto' });
  });

  it('maps "none" → {type: "none"}', () => {
    expect(convertToolChoice('none')).toEqual({ type: 'none' });
  });

  it('maps "required" → {type: "any"} (Anthropic equivalent)', () => {
    expect(convertToolChoice('required')).toEqual({ type: 'any' });
  });

  it('returns undefined for unknown strings', () => {
    expect(convertToolChoice('unknown')).toBeUndefined();
  });

  it('maps object with type "required" → {type: "any"}', () => {
    expect(convertToolChoice({ type: 'required' })).toEqual({ type: 'any' });
  });

  it('maps object with name → {type: "tool", name}', () => {
    expect(convertToolChoice({ type: 'tool', name: 'my_fn' })).toEqual({ type: 'tool', name: 'my_fn' });
  });

  it('extracts name from {function: {name}} shape', () => {
    expect(convertToolChoice({ type: 'function', function: { name: 'my_fn' } })).toEqual({ type: 'tool', name: 'my_fn' });
  });
});

// ─── mutateDsRequest ──────────────────────────────────────────────────────────

describe('mutateDsRequest', () => {
  function makeReq(extra: object = {}): ARequest {
    return {
      model: 'deepseek-v4-pro',
      max_tokens: 1024,
      messages: [],
      ...extra,
    };
  }

  it('removes temperature and top_p', () => {
    const req = { ...makeReq(), temperature: 0.7, top_p: 0.9 } as ARequest & Record<string, unknown>;
    mutateDsRequest(req, undefined);
    expect(req.temperature).toBeUndefined();
    expect(req.top_p).toBeUndefined();
  });

  it('does not set output_config when reasoning is absent', () => {
    const req = makeReq();
    mutateDsRequest(req, undefined);
    expect(req.output_config).toBeUndefined();
  });

  it('maps effort "high" → output_config.effort "high"', () => {
    const req = makeReq();
    mutateDsRequest(req, { effort: 'high' });
    expect(req.output_config).toEqual({ effort: 'high' });
  });

  it('maps effort "xhigh" → output_config.effort "max"', () => {
    const req = makeReq();
    mutateDsRequest(req, { effort: 'xhigh' });
    expect(req.output_config).toEqual({ effort: 'max' });
  });

  it('maps effort "max" → output_config.effort "max"', () => {
    const req = makeReq();
    mutateDsRequest(req, { effort: 'max' });
    expect(req.output_config).toEqual({ effort: 'max' });
  });

  it('ignores unknown effort values', () => {
    const req = makeReq();
    mutateDsRequest(req, { effort: 'low' });
    expect(req.output_config).toBeUndefined();
  });

  it('handles case-insensitive effort', () => {
    const req = makeReq();
    mutateDsRequest(req, { effort: 'HIGH' });
    expect(req.output_config).toEqual({ effort: 'high' });
  });
});
