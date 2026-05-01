/**
 * Unit tests for bridge/stream.ts
 */

import { describe, it, expect } from 'vitest';
import { AnthropicStreamConverter } from '../bridge/stream.js';
import { ThinkingState } from '../deepseek/state.js';
import { encodeThinkingSummary } from '../deepseek/thinking.js';
import type { AStreamEvent } from '../anthropic/types.js';

function makeConverter(hasToolHistory = false) {
  return new AnthropicStreamConverter('resp_test', 'deepseek-v4-pro', new ThinkingState(), hasToolHistory);
}

// ─── message_start ────────────────────────────────────────────────────────────

describe('processEvent: message_start', () => {
  it('emits response.created and response.in_progress', () => {
    const conv = makeConverter();
    const events = conv.processEvent({ type: 'message_start' } as AStreamEvent);
    const types = events.map((e) => e.event);
    expect(types).toContain('response.created');
    expect(types).toContain('response.in_progress');
  });

  it('assigns increasing sequence numbers', () => {
    const conv = makeConverter();
    const events = conv.processEvent({ type: 'message_start' } as AStreamEvent);
    expect(events[0].data.sequence_number).toBe(1);
    expect(events[1].data.sequence_number).toBe(2);
  });
});

// ─── text block ───────────────────────────────────────────────────────────────

describe('processEvent: text block', () => {
  it('emits output_item.added and text delta events', () => {
    const conv = makeConverter();
    const eventsStart = conv.processEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    const eventsDelta = conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } });
    const eventsStop = conv.processEvent({ type: 'content_block_stop', index: 0 });

    const allEvents = [...eventsStart, ...eventsDelta, ...eventsStop].map((e) => e.event);
    expect(allEvents).toContain('response.output_item.added');
    expect(allEvents).toContain('response.output_text.delta');
    expect(allEvents).toContain('response.output_text.done');
    expect(allEvents).toContain('response.output_item.done');
  });

  it('accumulates text across multiple deltas', () => {
    const conv = makeConverter();
    conv.processEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } });
    conv.processEvent({ type: 'content_block_stop', index: 0 });
    const { outputText } = conv.finish();
    expect(outputText).toBe('Hello');
  });
});

// ─── tool_use block ───────────────────────────────────────────────────────────

describe('processEvent: tool_use block', () => {
  it('emits function_call output item events', () => {
    const conv = makeConverter();
    const eventsStart = conv.processEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'call_1', name: 'search' },
    });
    const eventsDelta = conv.processEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"q":' },
    });
    const eventsDelta2 = conv.processEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"test"}' },
    });
    const eventsStop = conv.processEvent({ type: 'content_block_stop', index: 0 });

    const allEvents = [...eventsStart, ...eventsDelta, ...eventsDelta2, ...eventsStop].map((e) => e.event);
    expect(allEvents).toContain('response.output_item.added');
    expect(allEvents).toContain('response.function_call_arguments.delta');
    expect(allEvents).toContain('response.function_call_arguments.done');
    expect(allEvents).toContain('response.output_item.done');
  });

  it('stores tool call id for thinking state', () => {
    const state = new ThinkingState();
    const conv = new AnthropicStreamConverter('r', 'm', state, false);
    // First: thinking block
    conv.processEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I think' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } });
    conv.processEvent({ type: 'content_block_stop', index: 0 });
    // Then: tool_use
    conv.processEvent({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_t1', name: 'fn' } });
    conv.processEvent({ type: 'content_block_stop', index: 1 });
    conv.finish();
    expect(state.getCachedForToolCall('call_t1')).toEqual({ thinking: 'I think', signature: 'sig123' });
  });
});

// ─── thinking block ───────────────────────────────────────────────────────────

describe('processEvent: thinking block', () => {
  it('does not emit events during thinking accumulation', () => {
    const conv = makeConverter();
    const eventsStart = conv.processEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'thinking' },
    });
    const eventsDelta = conv.processEvent({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'deep thought' },
    });
    const eventsStop = conv.processEvent({ type: 'content_block_stop', index: 0 });
    // No output items emitted yet (reasoning is buffered until tool_use or text)
    expect([...eventsStart, ...eventsDelta, ...eventsStop]).toHaveLength(0);
  });

  it('emits reasoning item when followed by tool_use block', () => {
    const conv = makeConverter();
    conv.processEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'my thought' } });
    conv.processEvent({ type: 'content_block_stop', index: 0 });
    const toolStartEvents = conv.processEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'call_1', name: 'fn' },
    });
    const allEvents = toolStartEvents.map((e) => e.event);
    expect(allEvents).toContain('response.output_item.added');
    const reasoningItem = toolStartEvents.find((e) => e.data.item && (e.data.item as { type: string }).type === 'reasoning');
    expect(reasoningItem).toBeDefined();
  });

  it('emits reasoning item when followed by text block (hasToolHistory=true)', () => {
    const conv = makeConverter(true); // hasToolHistory=true
    conv.processEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'tool history thought' } });
    conv.processEvent({ type: 'content_block_stop', index: 0 });
    conv.processEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text' } });
    const textDeltaEvents = conv.processEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Answer' } });
    // emitPendingReasoning fires on first text_delta when hasToolHistory=true
    const reasoningEmit = textDeltaEvents.find((e) => {
      const item = e.data.item as { type?: string } | undefined;
      return item?.type === 'reasoning';
    });
    expect(reasoningEmit).toBeDefined();
  });

  it('accumulates signature via signature_delta', () => {
    const state = new ThinkingState();
    const conv = new AnthropicStreamConverter('r', 'm', state, false);
    conv.processEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'part1' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'part2' } });
    conv.processEvent({ type: 'content_block_stop', index: 0 });
    conv.processEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text' } });
    conv.processEvent({ type: 'content_block_stop', index: 1 });
    const { completedReasoningText } = conv.finish();
    // Since thinking is empty but signature is 'part1part2', it's base64-encoded
    expect(completedReasoningText).not.toBe('');
  });
});

// ─── finish() ────────────────────────────────────────────────────────────────

describe('AnthropicStreamConverter.finish', () => {
  it('returns output and outputText from accumulated items', () => {
    const conv = makeConverter();
    conv.processEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done!' } });
    conv.processEvent({ type: 'content_block_stop', index: 0 });
    const { output, outputText } = conv.finish();
    expect(outputText).toBe('Done!');
    expect(output[0].type).toBe('message');
  });

  it('returns empty completedReasoningText when no thinking occurred', () => {
    const conv = makeConverter();
    const { completedReasoningText } = conv.finish();
    expect(completedReasoningText).toBe('');
  });

  it('returns encoded completedReasoningText when thinking was streamed', () => {
    const conv = makeConverter();
    conv.processEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } });
    conv.processEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I thought hard' } });
    conv.processEvent({ type: 'content_block_stop', index: 0 });
    conv.processEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text' } });
    conv.processEvent({ type: 'content_block_stop', index: 1 });
    const { completedReasoningText } = conv.finish();
    // Non-empty thinking → returned verbatim
    expect(completedReasoningText).toBe('I thought hard');
  });
});

// ─── anthropic/client SSE parser ─────────────────────────────────────────────

describe('parseAnthropicSseEvents', () => {
  it('parses a well-formed Anthropic SSE stream', async () => {
    const { parseAnthropicSseEvents } = await import('../anthropic/client.js');
    const raw = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m1","type":"message","role":"assistant","content":[],"stop_reason":null,"usage":{"input_tokens":10,"output_tokens":0}}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
    ].join('\n');

    const events = parseAnthropicSseEvents(raw);
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0].type).toBe('message_start');
    expect(events[1].type).toBe('content_block_start');
    expect(events[2].type).toBe('content_block_delta');
    expect(events[3].type).toBe('content_block_stop');
  });

  it('handles stream without trailing empty line', async () => {
    const { parseAnthropicSseEvents } = await import('../anthropic/client.js');
    const raw = 'event: message_stop\ndata: {"type":"message_stop"}';
    const events = parseAnthropicSseEvents(raw);
    expect(events[0].type).toBe('message_stop');
  });

  it('skips malformed data lines', async () => {
    const { parseAnthropicSseEvents } = await import('../anthropic/client.js');
    const raw = 'data: not valid json\n\ndata: {"type":"ok"}\n\n';
    const events = parseAnthropicSseEvents(raw);
    // First block is malformed (skipped), second is valid
    expect(events.some((e) => e.type === 'ok')).toBe(true);
  });
});
