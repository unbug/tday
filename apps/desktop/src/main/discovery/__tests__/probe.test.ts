/**
 * Unit tests for discovery/probe.ts
 *
 * Node built-in modules are mocked at module level (vi.mock) because their
 * exports are non-configurable in ESM and cannot be patched with vi.spyOn.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ServiceSpec } from '../types.js';

// ─── Module-level mocks for node:net and node:http ───────────────────────────
// We store the mock implementation in a mutable variable so individual tests
// can swap it without re-mocking the entire module.

type ConnectHandler = (ev: string, cb: (...args: unknown[]) => void) => unknown;
type ReqHandler = (opts: unknown, cb: unknown) => unknown;

let mockConnectImpl: ConnectHandler = () => ({});
let mockHttpRequestImpl: ReqHandler = () => ({});

vi.mock('node:net', () => ({
  createConnection: (...args: unknown[]) => {
    const sock = {
      on: (ev: string, cb: (...a: unknown[]) => void) => {
        mockConnectImpl(ev, cb);
        return sock;
      },
      destroy: vi.fn(),
    };
    return sock;
  },
}));

vi.mock('node:http', () => ({
  request: (opts: unknown, cb: unknown) => mockHttpRequestImpl(opts, cb),
}));

afterEach(() => {
  // Reset to a neutral impl that never fires any event
  mockConnectImpl = () => ({});
  mockHttpRequestImpl = () => ({ on: vi.fn().mockReturnThis(), end: vi.fn() });
});

// Import probe AFTER mocks are registered
import { tcpProbe, httpGet, parseModelList, probeService } from '../probe.js';

// ─── tcpProbe ─────────────────────────────────────────────────────────────────

describe('tcpProbe', () => {
  it('resolves true when socket connects', async () => {
    mockConnectImpl = (ev, cb) => { if (ev === 'connect') cb(); };
    const result = await tcpProbe('127.0.0.1', 11434, 200);
    expect(result).toBe(true);
  });

  it('resolves false on ECONNREFUSED', async () => {
    mockConnectImpl = (ev, cb) => { if (ev === 'error') cb(); };
    const result = await tcpProbe('127.0.0.1', 9999, 200);
    expect(result).toBe(false);
  });
});

// ─── parseModelList ───────────────────────────────────────────────────────────

describe('parseModelList', () => {
  it('parses Ollama models[].name', () => {
    const body = JSON.stringify({
      models: [{ name: 'llama3:8b' }, { name: 'mistral:7b' }],
    });
    expect(parseModelList(body)).toEqual(['llama3:8b', 'mistral:7b']);
  });

  it('parses OpenAI-compat data[].id', () => {
    const body = JSON.stringify({
      data: [{ id: 'gpt-4' }, { id: 'gpt-3.5-turbo' }],
    });
    expect(parseModelList(body)).toEqual(['gpt-4', 'gpt-3.5-turbo']);
  });

  it('parses data[].name as fallback', () => {
    const body = JSON.stringify({ data: [{ name: 'my-model' }] });
    expect(parseModelList(body)).toEqual(['my-model']);
  });

  it('returns [] for invalid JSON', () => {
    expect(parseModelList('not json')).toEqual([]);
  });

  it('returns [] for empty body', () => {
    expect(parseModelList('')).toEqual([]);
  });

  it('returns [] for unexpected shape', () => {
    expect(parseModelList(JSON.stringify({ other: 'field' }))).toEqual([]);
  });
});

// ─── httpGet ──────────────────────────────────────────────────────────────────

function makeMockHttpRes(statusCode: number, body: string) {
  const mockRes = {
    statusCode,
    on: vi.fn((ev: string, cb: (d?: Buffer) => void) => {
      if (ev === 'data') cb(Buffer.from(body));
      if (ev === 'end') cb();
      return mockRes;
    }),
  };
  return mockRes;
}

describe('httpGet', () => {
  it('returns ok:true for 200 responses', async () => {
    mockHttpRequestImpl = (_opts, cb) => {
      (cb as (r: unknown) => void)(makeMockHttpRes(200, '{"ok":true}'));
      return { on: vi.fn().mockReturnThis(), end: vi.fn() };
    };
    const result = await httpGet('http://127.0.0.1:11434/api/version', 500);
    expect(result.ok).toBe(true);
    expect(result.body).toBe('{"ok":true}');
  });

  it('returns ok:false for 404', async () => {
    mockHttpRequestImpl = (_opts, cb) => {
      (cb as (r: unknown) => void)(makeMockHttpRes(404, ''));
      return { on: vi.fn().mockReturnThis(), end: vi.fn() };
    };
    const result = await httpGet('http://127.0.0.1:11434/missing', 500);
    expect(result.ok).toBe(false);
  });
});

// ─── probeService ─────────────────────────────────────────────────────────────

const OLLAMA_SPEC: ServiceSpec = {
  kind: 'ollama',
  label: 'Ollama',
  ports: [11434],
  healthPath: '/api/version',
  modelsPath: '/api/tags',
  baseSuffix: '/v1',
};

describe('probeService', () => {
  it('returns null when TCP port is closed', async () => {
    mockConnectImpl = (ev, cb) => { if (ev === 'error') cb(); };
    const result = await probeService('127.0.0.1', 11434, OLLAMA_SPEC, 50);
    expect(result).toBeNull();
  });

  it('returns DiscoveredService when service is up', async () => {
    mockConnectImpl = (ev, cb) => { if (ev === 'connect') cb(); };
    const healthBody = JSON.stringify({ version: '0.1.0' });
    const modelsBody = JSON.stringify({ models: [{ name: 'llama3:8b' }, { name: 'phi3' }] });
    let httpCallCount = 0;
    mockHttpRequestImpl = (_opts, cb) => {
      const bodyStr = httpCallCount++ === 0 ? healthBody : modelsBody;
      (cb as (r: unknown) => void)(makeMockHttpRes(200, bodyStr));
      return { on: vi.fn().mockReturnThis(), end: vi.fn() };
    };
    const result = await probeService('127.0.0.1', 11434, OLLAMA_SPEC, 50);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe('ollama');
    expect(result!.baseUrl).toBe('http://127.0.0.1:11434/v1');
    expect(result!.models).toEqual(['llama3:8b', 'phi3']);
  });

  it('returns null when health check fails', async () => {
    mockConnectImpl = (ev, cb) => { if (ev === 'connect') cb(); };
    mockHttpRequestImpl = (_opts, cb) => {
      (cb as (r: unknown) => void)(makeMockHttpRes(503, ''));
      return { on: vi.fn().mockReturnThis(), end: vi.fn() };
    };
    const result = await probeService('127.0.0.1', 11434, OLLAMA_SPEC, 50);
    expect(result).toBeNull();
  });
});
