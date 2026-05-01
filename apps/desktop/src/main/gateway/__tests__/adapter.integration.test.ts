/**
 * Integration tests for CodexDeepSeekAnthropicAdapter.
 *
 * These tests spin up the real HTTP gateway server (no mocks for the HTTP
 * layer) and send Codex-shaped POST /responses requests at it, verifying:
 *
 *   1. Streaming: SSE events arrive in MULTIPLE separate chunks over time,
 *      not all in one batch at the end.
 *   2. Non-streaming: a well-formed JSON response is returned synchronously.
 *   3. `stream: false` (Codex default when not configured) still works.
 *   4. The `stream: true` path actually streams (events arrive before the
 *      connection closes).
 *
 * The upstream Anthropic call is intercepted via a mock HTTP server so no
 * real API key is needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { CodexDeepSeekAnthropicAdapter } from '../adapter.js';

// Prevent integration tests from writing to the real ~/.tday/usage.jsonl
vi.mock('../../usage/store.js', () => ({ appendUsage: vi.fn() }));

import type { GatewayAdapterContext } from '../types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Bind a server to a random port and return its URL. */
async function bindServer(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return reject(new Error('bind failed'));
      resolve(`http://127.0.0.1:${addr.port}`);
    });
  });
}

/** Collect all SSE events from a fetch Response that has `body` as a ReadableStream. */
async function collectSseEvents(
  res: Response,
): Promise<{ events: Array<{ event: string; data: string }>; timing: number[] }> {
  const events: Array<{ event: string; data: string }> = [];
  const timing: number[] = []; // milliseconds since first chunk
  const decoder = new TextDecoder();
  let buf = '';
  let eventName = '';
  const t0 = Date.now();

  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    timing.push(Date.now() - t0);
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith('event:')) { eventName = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data && data !== '[DONE]') {
          events.push({ event: eventName, data });
          eventName = '';
        }
      }
    }
  }
  return { events, timing };
}

// ─── Mock upstream Anthropic server ──────────────────────────────────────────

/**
 * Build a minimal Anthropic SSE stream that emits a two-word text response
 * ("Hello world") across separate SSE frames, with artificial per-event
 * delays so we can assert that events arrive incrementally.
 */
function buildAnthropicSseBody(delayMs = 0): string {
  const events = [
    { type: 'message_start', payload: { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], model: 'mock', stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } } },
    { type: 'content_block_start', payload: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { type: 'content_block_delta', payload: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
    { type: 'content_block_delta', payload: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } } },
    { type: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
    { type: 'message_delta', payload: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } } },
    { type: 'message_stop', payload: { type: 'message_stop' } },
  ];
  // Return them all as one string (delay is handled by the mock server response writing)
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`).join('');
}

function buildAnthropicJsonBody(): object {
  return {
    id: 'm1',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'Hello world' }],
    model: 'mock',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 5, output_tokens: 2 },
  };
}

/**
 * Create a mock Anthropic server.
 * - If the request body asks for `stream: true`, responds with SSE,
 *   flushing each event separately with a small delay.
 * - Otherwise responds with JSON.
 */
function createMockAnthropicServer(perEventDelayMs = 10): Server {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean };

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const events = [
        { type: 'message_start', payload: { type: 'message_start', message: { id: 'm1', role: 'assistant', content: [], model: 'mock', stop_reason: null, usage: { input_tokens: 5, output_tokens: 0 } } } },
        { type: 'content_block_start', payload: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
        { type: 'content_block_delta', payload: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } },
        { type: 'content_block_delta', payload: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' world' } } },
        { type: 'content_block_stop', payload: { type: 'content_block_stop', index: 0 } },
        { type: 'message_delta', payload: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } } },
        { type: 'message_stop', payload: { type: 'message_stop' } },
      ];
      // Write each event separately with a delay — simulates real LLM token-by-token delivery
      for (const e of events) {
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e.payload)}\n\n`);
        await new Promise((r) => setTimeout(r, perEventDelayMs));
      }
      res.end();
    } else {
      const json = JSON.stringify(buildAnthropicJsonBody());
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(json)) });
      res.end(json);
    }
  });
}

// ─── Minimal Codex request builders ──────────────────────────────────────────

function codexStreamRequest(model = 'deepseek-v4-pro') {
  return {
    model,
    stream: true,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello.' }] }],
    max_output_tokens: 256,
  };
}

function codexNonStreamRequest(model = 'deepseek-v4-pro') {
  return { ...codexStreamRequest(model), stream: false };
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let mockAnthropicServer: Server;
let mockAnthropicUrl: string;
let adapter: CodexDeepSeekAnthropicAdapter;
let gatewayUrl: string;

beforeEach(async () => {
  // Start mock Anthropic server
  mockAnthropicServer = createMockAnthropicServer(15); // 15ms between events
  mockAnthropicUrl = await bindServer(mockAnthropicServer);

  // Start gateway adapter pointing at mock Anthropic
  adapter = new CodexDeepSeekAnthropicAdapter();
  const ctx: GatewayAdapterContext = {
    agentId: 'codex',
    provider: {
      id: 'test',
      label: 'Test',
      kind: 'deepseek',
      apiKey: 'sk-test',
      // Point gateway at our mock server
      baseUrl: mockAnthropicUrl,
      apiStyle: 'anthropic',
    },
  };
  const resolution = await adapter.resolve(ctx);
  gatewayUrl = resolution.baseUrl;
});

afterEach(() => {
  adapter.close();
  mockAnthropicServer.close();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CodexDeepSeekAnthropicAdapter: non-streaming (stream: false)', () => {
  it('returns a completed JSON response', async () => {
    const res = await fetch(`${gatewayUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(codexNonStreamRequest()),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as Record<string, unknown>;
    expect(json.object).toBe('response');
    expect(json.status).toBe('completed');
    expect(Array.isArray(json.output)).toBe(true);
    const textItem = (json.output as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>)
      .flatMap((o) => o.content ?? [])
      .find((c) => c.type === 'output_text');
    expect(textItem?.text).toBe('Hello world');
  });

  it('responds synchronously (no SSE headers)', async () => {
    const res = await fetch(`${gatewayUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(codexNonStreamRequest()),
    });
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

describe('CodexDeepSeekAnthropicAdapter: streaming (stream: true)', () => {
  it('responds with text/event-stream content-type', async () => {
    const res = await fetch(`${gatewayUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(codexStreamRequest()),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
  });

  it('emits response.created before response.completed', async () => {
    const res = await fetch(`${gatewayUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(codexStreamRequest()),
    });
    const { events } = await collectSseEvents(res);
    const names = events.map((e) => e.event);
    expect(names).toContain('response.created');
    expect(names).toContain('response.completed');
    expect(names.indexOf('response.created')).toBeLessThan(names.indexOf('response.completed'));
  });

  it('emits text delta events', async () => {
    const res = await fetch(`${gatewayUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(codexStreamRequest()),
    });
    const { events } = await collectSseEvents(res);
    const deltas = events.filter((e) => e.event === 'response.output_text.delta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);
    const fullText = deltas
      .map((e) => (JSON.parse(e.data) as { delta?: string }).delta ?? '')
      .join('');
    expect(fullText).toBe('Hello world');
  });

  it('CRITICAL: events arrive in MULTIPLE separate TCP chunks, not all at once', async () => {
    // The mock upstream sends one event every 15ms AND multiple events may
    // arrive in a single upstream chunk.  The gateway must forward each event
    // in its own socket write (via the setImmediate yield) so Codex receives
    // tokens individually rather than in a single burst.
    const res = await fetch(`${gatewayUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(codexStreamRequest()),
    });
    const { timing } = await collectSseEvents(res);
    // We expect at least 2 distinct chunk deliveries
    expect(timing.length).toBeGreaterThan(1);
    // The last chunk should arrive significantly later than the first
    // (at least 2 × delay = 30ms, allowing generous headroom for slow CI)
    const span = timing[timing.length - 1] - timing[0];
    expect(span).toBeGreaterThanOrEqual(20); // ms
  });

  it('CRITICAL: burst from upstream is spread out — not forwarded as one TCP packet', async () => {
    // Stop the default mock server and replace with one that sends ALL events
    // in a single TCP write (no delay) — simulating a fast LLM that bursts.
    adapter.close();
    mockAnthropicServer.close();

    const burstServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { stream?: boolean };
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
          // Write ALL events in a single synchronous call — one TCP segment
          const all = [
            'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{}}}\n\n',
            'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"B"}}\n\n',
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"C"}}\n\n',
            'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ].join('');
          res.write(all);
          res.end();
        } else {
          const json = JSON.stringify(buildAnthropicJsonBody());
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(json);
        }
      })();
    });
    const burstUrl = await bindServer(burstServer);

    const burstAdapter = new CodexDeepSeekAnthropicAdapter();
    const resolution = await burstAdapter.resolve({
      agentId: 'codex',
      provider: { id: 'burst', label: 'Burst', kind: 'deepseek', apiKey: 'sk-test', baseUrl: burstUrl, apiStyle: 'anthropic' },
    });

    try {
      const res2 = await fetch(`${resolution.baseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(codexStreamRequest()),
      });
      const { events, timing } = await collectSseEvents(res2);

      // The text deltas A, B, C must all be present
      const deltas = events.filter((e) => e.event === 'response.output_text.delta');
      const text = deltas.map((e) => (JSON.parse(e.data) as { delta?: string }).delta ?? '').join('');
      expect(text).toBe('ABC');

      // The gateway uses setImmediate between events so even though the
      // upstream sent everything in one TCP write, the client should receive
      // data in more than one chunk.
      expect(timing.length).toBeGreaterThan(1);
    } finally {
      burstAdapter.close();
      burstServer.close();
    }
  });

  it('ends the stream with [DONE]', async () => {
    const res = await fetch(`${gatewayUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(codexStreamRequest()),
    });
    const decoder = new TextDecoder();
    let raw = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      raw += decoder.decode(chunk, { stream: true });
    }
    expect(raw).toContain('[DONE]');
  });

  it('response.completed carries the full output text', async () => {
    const res = await fetch(`${gatewayUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(codexStreamRequest()),
    });
    const { events } = await collectSseEvents(res);
    const completed = events.find((e) => e.event === 'response.completed');
    expect(completed).toBeDefined();
    const data = JSON.parse(completed!.data) as { response?: { output_text?: string } };
    expect(data.response?.output_text).toBe('Hello world');
  });

  it('CRITICAL: each text delta contains exactly ONE character (smooth streaming)', async () => {
    // The mock sends two multi-char deltas: "Hello" and " world".
    // The gateway must split each into individual Unicode codepoints so Codex
    // can render character-by-character rather than receiving chunks.
    const res = await fetch(`${gatewayUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(codexStreamRequest()),
    });
    const { events } = await collectSseEvents(res);
    const deltas = events.filter((e) => e.event === 'response.output_text.delta');
    // Every emitted delta should be exactly 1 Unicode codepoint
    for (const d of deltas) {
      const delta = (JSON.parse(d.data) as { delta?: string }).delta ?? '';
      expect([...delta].length).toBe(1);
    }
    // Full text must be preserved
    const fullText = deltas.map((e) => (JSON.parse(e.data) as { delta?: string }).delta ?? '').join('');
    expect(fullText).toBe('Hello world');
    // We must have one event per character (11 chars in "Hello world")
    expect(deltas.length).toBe(11);
  });
});

describe('CodexDeepSeekAnthropicAdapter: unknown route', () => {
  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${gatewayUrl}/unknown`, { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
