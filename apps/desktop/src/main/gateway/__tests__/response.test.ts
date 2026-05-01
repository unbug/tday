/**
 * Unit tests for bridge/response.ts
 */

import { describe, it, expect } from 'vitest';
import {
  convertAnthropicResponse,
  buildStoredMessages,
  buildStoredMessagesFromStream,
  normalizeUsage,
} from '../bridge/response.js';
import { ThinkingState } from '../deepseek/state.js';
import { encodeThinkingSummary } from '../deepseek/thinking.js';
import type { AResponse } from '../anthropic/types.js';

function makeResponse(content: AResponse['content'], usage?: Partial<AResponse['usage']>): AResponse {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5, ...usage },
  };
}

// ─── convertAnthropicResponse ─────────────────────────────────────────────────

describe('convertAnthropicResponse', () => {
  it('converts a text block to a message output item', () => {
    const state = new ThinkingState();
    const resp = makeResponse([{ type: 'text', text: 'Hello!' }]);
    const { output, outputText } = convertAnthropicResponse(resp, state, 'resp_1');
    expect(outputText).toBe('Hello!');
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe('message');
    expect(output[0].status).toBe('completed');
    expect(output[0].content?.[0].text).toBe('Hello!');
  });

  it('converts a thinking block to a reasoning output item', () => {
    const state = new ThinkingState();
    const resp = makeResponse([{ type: 'thinking', thinking: 'deep thought', signature: 'sig' }]);
    const { output } = convertAnthropicResponse(resp, state, 'resp_2');
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe('reasoning');
    expect(output[0].summary?.[0].type).toBe('summary_text');
    // The summary text should be the thinking text (non-empty thinking = verbatim)
    expect(output[0].summary?.[0].text).toBe('deep thought');
  });

  it('converts a tool_use block to a function_call output item', () => {
    const state = new ThinkingState();
    const resp = makeResponse([{
      type: 'tool_use',
      id: 'call_abc',
      name: 'search',
      input: { query: 'test' },
    }]);
    const { output } = convertAnthropicResponse(resp, state, 'resp_3');
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe('function_call');
    expect(output[0].name).toBe('search');
    expect(output[0].call_id).toBe('call_abc');
    expect(JSON.parse(output[0].arguments!)).toEqual({ query: 'test' });
  });

  it('produces reasoning + text items in the correct order', () => {
    const state = new ThinkingState();
    const resp = makeResponse([
      { type: 'thinking', thinking: 'I think...', signature: '' },
      { type: 'text', text: 'My answer.' },
    ]);
    const { output } = convertAnthropicResponse(resp, state, 'resp_4');
    expect(output[0].type).toBe('reasoning');
    expect(output[1].type).toBe('message');
  });

  it('stores thinking in state for subsequent turns', () => {
    const state = new ThinkingState();
    const resp = makeResponse([
      { type: 'thinking', thinking: 'cached thought', signature: 'sig_x' },
      { type: 'tool_use', id: 'call_stored', name: 'fn', input: {} },
    ]);
    convertAnthropicResponse(resp, state, 'resp_5');
    expect(state.getCachedForToolCall('call_stored')).toEqual({ thinking: 'cached thought', signature: 'sig_x' });
  });

  it('omits reasoning item when thinking is empty and signature is empty', () => {
    const state = new ThinkingState();
    const resp = makeResponse([{ type: 'thinking', thinking: '', signature: '' }]);
    const { output } = convertAnthropicResponse(resp, state, 'resp_6');
    expect(output).toHaveLength(0);
  });
});

// ─── buildStoredMessages ──────────────────────────────────────────────────────

describe('buildStoredMessages', () => {
  it('returns empty array for empty content', () => {
    expect(buildStoredMessages([])).toEqual([]);
  });

  it('retains text and tool_use and thinking blocks', () => {
    const stored = buildStoredMessages([
      { type: 'thinking', thinking: 't', signature: 's' },
      { type: 'text', text: 'response' },
      { type: 'tool_use', id: 'x', name: 'fn', input: {} },
    ]);
    expect(stored).toHaveLength(1);
    expect(stored[0].role).toBe('assistant');
    expect(stored[0].content).toHaveLength(3);
  });

  it('filters out unknown block types', () => {
    const stored = buildStoredMessages([
      { type: 'unknown_block' },
      { type: 'text', text: 'kept' },
    ]);
    expect(stored[0].content).toHaveLength(1);
    expect(stored[0].content[0].type).toBe('text');
  });
});

// ─── buildStoredMessagesFromStream ────────────────────────────────────────────

describe('buildStoredMessagesFromStream', () => {
  it('returns empty array when output is empty and no reasoning', () => {
    expect(buildStoredMessagesFromStream([], '')).toEqual([]);
  });

  it('reconstructs thinking block from completedReasoningText', () => {
    const thinkingText = 'streamed thoughts';
    const encoded = encodeThinkingSummary(thinkingText, '');
    const stored = buildStoredMessagesFromStream([], encoded);
    expect(stored[0].content[0].type).toBe('thinking');
    expect(stored[0].content[0].thinking).toBe(thinkingText);
  });

  it('reconstructs text block from message output items', () => {
    const output = [{
      type: 'message',
      id: 'msg_1',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'streamed answer' }],
    }];
    const stored = buildStoredMessagesFromStream(output, '');
    const textBlock = stored[0].content.find((b) => b.type === 'text');
    expect(textBlock?.text).toBe('streamed answer');
  });

  it('reconstructs function_call from function_call output items', () => {
    const output = [{
      type: 'function_call',
      id: 'fc_call_1',
      call_id: 'call_1',
      name: 'fn',
      arguments: '{"x":1}',
      status: 'completed',
    }];
    const stored = buildStoredMessagesFromStream(output, '');
    const toolUse = stored[0].content.find((b) => b.type === 'tool_use');
    expect(toolUse?.name).toBe('fn');
    expect(toolUse?.input).toEqual({ x: 1 });
  });
});

// ─── normalizeUsage ───────────────────────────────────────────────────────────

describe('normalizeUsage', () => {
  it('returns empty object for undefined usage', () => {
    expect(normalizeUsage(undefined)).toEqual({});
  });

  it('maps tokens correctly', () => {
    const result = normalizeUsage({ input_tokens: 100, output_tokens: 50 });
    expect(result.input_tokens).toBe(100);
    expect(result.output_tokens).toBe(50);
    expect(result.total_tokens).toBe(150);
  });

  it('includes cached token count', () => {
    const result = normalizeUsage({ input_tokens: 200, output_tokens: 80, cache_read_input_tokens: 30 });
    expect((result.input_tokens_details as { cached_tokens: number }).cached_tokens).toBe(30);
  });
});
