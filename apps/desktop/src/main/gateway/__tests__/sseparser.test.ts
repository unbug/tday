/**
 * Unit tests for SseParser — incremental SSE parsing (real-time streaming).
 */

import { describe, it, expect } from 'vitest';
import { SseParser } from '../anthropic/client.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Split a raw SSE string into byte-level chunks of the given size. */
function chunkBy(s: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/** Feed all chunks into the parser and collect every event it emits. */
function feedAll(parser: SseParser, chunks: string[]) {
  const events: ReturnType<SseParser['push']> = [];
  for (const c of chunks) events.push(...parser.push(c));
  events.push(...parser.end());
  return events;
}

// ─── Raw SSE fixtures ─────────────────────────────────────────────────────────

const ONE_EVENT =
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n';

const TWO_EVENTS =
  'event: message_start\n' +
  'data: {"type":"message_start"}\n\n' +
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n';

const NO_EVENT_LINE =
  'data: {"type":"message_stop"}\n\n';

const MULTI_DATA_LINE =
  'event: content_block_delta\n' +
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta",' +
  '"text":"split"}}\n\n';

// ─── Basic parsing ────────────────────────────────────────────────────────────

describe('SseParser: complete chunks', () => {
  it('parses one event from a single push', () => {
    const p = new SseParser();
    const events = p.push(ONE_EVENT);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('content_block_delta');
  });

  it('parses two events from a single push', () => {
    const p = new SseParser();
    const events = p.push(TWO_EVENTS);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('content_block_delta');
  });

  it('uses event: line as type when data json has no type', () => {
    const p = new SseParser();
    const raw = 'event: message_start\ndata: {}\n\n';
    const events = p.push(raw);
    expect(events[0].type).toBe('message_start');
  });

  it('parses event without event: line', () => {
    const p = new SseParser();
    const events = p.push(NO_EVENT_LINE);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_stop');
  });

  it('ignores malformed data line', () => {
    const p = new SseParser();
    const events = p.push('data: not-json\n\n');
    expect(events).toHaveLength(0);
  });
});

// ─── Incremental / byte-by-byte chunking ─────────────────────────────────────

describe('SseParser: incremental chunking', () => {
  it('emits nothing until a complete event is received', () => {
    const p = new SseParser();
    // Feed partial line — no \n\n yet
    const partial = 'event: message_start\ndata: {"type":"message_sta';
    expect(p.push(partial)).toHaveLength(0);
  });

  it('correctly parses event split across exactly 1-byte chunks', () => {
    const p = new SseParser();
    const events = feedAll(p, chunkBy(ONE_EVENT, 1));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('content_block_delta');
    const delta = (events[0] as { delta?: { text?: string } }).delta;
    expect(delta?.text).toBe('Hello');
  });

  it('correctly parses TWO_EVENTS split into 4-byte chunks', () => {
    const p = new SseParser();
    const events = feedAll(p, chunkBy(TWO_EVENTS, 4));
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('content_block_delta');
  });

  it('correctly parses TWO_EVENTS split into 7-byte chunks', () => {
    const p = new SseParser();
    const events = feedAll(p, chunkBy(TWO_EVENTS, 7));
    expect(events).toHaveLength(2);
  });

  it('emits event as soon as the double-newline arrives, not later', () => {
    const p = new SseParser();
    const raw = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    // Feed everything except the final \n
    expect(p.push(raw.slice(0, -1))).toHaveLength(0);
    // Now feed the last byte — event should fire
    const events = p.push('\n');
    expect(events).toHaveLength(1);
  });

  it('emits first event before second event data arrives', () => {
    const p = new SseParser();
    // Feed only the first event + start of second
    const first = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const secondPartial = 'event: content_block_delta\n';
    const firstEvents = p.push(first + secondPartial);
    expect(firstEvents).toHaveLength(1);
    expect(firstEvents[0].type).toBe('message_start');
    // Now complete the second
    const rest = 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"x"}}\n\n';
    const secondEvents = p.push(rest);
    expect(secondEvents).toHaveLength(1);
    expect(secondEvents[0].type).toBe('content_block_delta');
  });
});

// ─── end() flush ─────────────────────────────────────────────────────────────

describe('SseParser: end() flush', () => {
  it('flushes a trailing event that has no trailing newline', () => {
    const p = new SseParser();
    const noTrailingNl = 'data: {"type":"message_stop"}';
    p.push(noTrailingNl);
    const events = p.end();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('message_stop');
  });

  it('returns empty array if nothing is buffered', () => {
    const p = new SseParser();
    p.push(ONE_EVENT); // fully consumed
    expect(p.end()).toHaveLength(0);
  });
});

// ─── Stream ordering ─────────────────────────────────────────────────────────

describe('SseParser: ordering guarantee', () => {
  it('preserves event order across arbitrary chunk sizes', () => {
    const types = ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'];
    const raw = types
      .map((t) => `event: ${t}\ndata: {"type":"${t}"}\n\n`)
      .join('');

    // Test multiple chunk sizes
    for (const size of [1, 2, 3, 5, 13, 50, raw.length]) {
      const p = new SseParser();
      const events = feedAll(p, chunkBy(raw, size));
      expect(events.map((e) => e.type)).toEqual(types);
    }
  });
});

// ─── Integration: SseParser + AnthropicStreamConverter ───────────────────────

import { AnthropicStreamConverter } from '../bridge/stream.js';
import { ThinkingState } from '../deepseek/state.js';

describe('SseParser + AnthropicStreamConverter: end-to-end streaming', () => {
  /**
   * Simulate a full Anthropic SSE stream for a simple text response,
   * split into small chunks to mirror real network delivery.
   * Verify that:
   *   1. OpenAI SSE events are emitted BEFORE the stream ends (real streaming).
   *   2. response.output_text.delta events carry the correct incremental text.
   *   3. response.completed fires exactly once at the end.
   */
  it('emits delta events incrementally, not all at once', () => {
    const sseStream =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hel"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"lo"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    const chunks = chunkBy(sseStream, 20); // 20-byte chunks
    const parser = new SseParser();
    const converter = new AnthropicStreamConverter('resp_1', 'deepseek-v4-pro', new ThinkingState(), false);

    const emittedByChunk: Array<{ chunkIndex: number; events: string[] }> = [];
    let deltasSeen = 0;
    let createdSeen = false;

    for (let i = 0; i < chunks.length; i++) {
      const parsed = parser.push(chunks[i]);
      const out: string[] = [];
      for (const event of parsed) {
        for (const { event: evName } of converter.processEvent(event)) {
          out.push(evName);
          if (evName === 'response.output_text.delta') deltasSeen++;
          if (evName === 'response.created') createdSeen = true;
        }
      }
      if (out.length) emittedByChunk.push({ chunkIndex: i, events: out });
    }
    // Flush
    for (const event of parser.end()) {
      for (const { event: evName } of converter.processEvent(event)) {
        emittedByChunk.push({ chunkIndex: -1, events: [evName] });
      }
    }

    // Events were emitted across MULTIPLE chunks (not all at the end)
    expect(emittedByChunk.length).toBeGreaterThan(1);
    // response.created came early (not last chunk)
    expect(createdSeen).toBe(true);
    // Both delta chunks arrived
    expect(deltasSeen).toBe(2);

    // The chunks that carried delta events must not be the last chunk
    const deltaChunkIndices = emittedByChunk
      .filter((c) => c.events.includes('response.output_text.delta'))
      .map((c) => c.chunkIndex);
    expect(Math.min(...deltaChunkIndices)).toBeLessThan(chunks.length - 1);
  });

  it('accumulates full text correctly across incremental delivery', () => {
    const words = ['The ', 'quick ', 'brown ', 'fox'];
    let sseStream =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m2","usage":{}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n';
    for (const w of words) {
      sseStream += `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":${JSON.stringify(w)}}}\n\n`;
    }
    sseStream +=
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":4}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    const parser = new SseParser();
    const converter = new AnthropicStreamConverter('resp_2', 'deepseek-v4-pro', new ThinkingState(), false);

    for (const event of feedAll(parser, chunkBy(sseStream, 3))) {
      converter.processEvent(event);
    }
    const { outputText } = converter.finish();
    expect(outputText).toBe('The quick brown fox');
  });

  it('handles tool_use block streamed in small chunks', () => {
    const sseStream =
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m3","usage":{}}}\n\n' +
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"tu1","name":"bash"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\\"cmd\\\":"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\\""}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"}"}}\n\n' +
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}\n\n' +
      'event: message_stop\ndata: {"type":"message_stop"}\n\n';

    const parser = new SseParser();
    const converter = new AnthropicStreamConverter('resp_3', 'deepseek-v4-pro', new ThinkingState(), false);
    const allEmitted: string[] = [];

    for (const event of feedAll(parser, chunkBy(sseStream, 5))) {
      for (const { event: evName } of converter.processEvent(event)) {
        allEmitted.push(evName);
      }
    }
    const { output } = converter.finish();

    expect(allEmitted).toContain('response.output_item.added');
    expect(allEmitted).toContain('response.function_call_arguments.delta');
    expect(allEmitted).toContain('response.function_call_arguments.done');
    const toolItem = output.find((o) => o.type === 'function_call');
    expect(toolItem).toBeDefined();
    expect((toolItem as { arguments?: string }).arguments).toBe('{"cmd":"ls"}');
  });
});
