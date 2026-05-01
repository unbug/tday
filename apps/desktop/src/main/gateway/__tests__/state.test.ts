/**
 * Unit tests for deepseek/state.ts
 */

import { describe, it, expect } from 'vitest';
import { ThinkingState } from '../deepseek/state.js';
import type { ABlock } from '../anthropic/types.js';

const entry = { thinking: 'deep thoughts', signature: 'sig-abc' };

describe('ThinkingState.rememberForToolCalls', () => {
  it('stores thinking for a tool call id', () => {
    const s = new ThinkingState();
    s.rememberForToolCalls(['call_1'], entry.thinking, entry.signature);
    expect(s.getCachedForToolCall('call_1')).toEqual(entry);
  });

  it('does nothing when toolCallIds is empty', () => {
    const s = new ThinkingState();
    s.rememberForToolCalls([], entry.thinking, entry.signature);
    expect(s.getCachedForToolCall('')).toBeUndefined();
  });

  it('does nothing when both thinking and signature are empty', () => {
    const s = new ThinkingState();
    s.rememberForToolCalls(['call_1'], '', '');
    expect(s.getCachedForToolCall('call_1')).toBeUndefined();
  });

  it('stores for multiple ids', () => {
    const s = new ThinkingState();
    s.rememberForToolCalls(['a', 'b', 'c'], entry.thinking, entry.signature);
    expect(s.getCachedForToolCall('b')).toEqual(entry);
    expect(s.getCachedForToolCall('c')).toEqual(entry);
  });
});

describe('ThinkingState.rememberForAssistantText', () => {
  it('stores thinking for assistant text', () => {
    const s = new ThinkingState();
    s.rememberForAssistantText('hello world', entry.thinking, entry.signature);
    expect(s.getCachedForAssistantText('hello world')).toEqual(entry);
  });

  it('returns undefined for unknown text', () => {
    const s = new ThinkingState();
    expect(s.getCachedForAssistantText('unknown')).toBeUndefined();
  });

  it('does nothing for empty text', () => {
    const s = new ThinkingState();
    s.rememberForAssistantText('', entry.thinking, entry.signature);
    expect(s.getCachedForAssistantText('')).toBeUndefined();
  });
});

describe('ThinkingState.rememberFromContent', () => {
  it('extracts thinking from content blocks and caches for tool use ids', () => {
    const s = new ThinkingState();
    const blocks: ABlock[] = [
      { type: 'thinking', thinking: 'thought', signature: 'sig' },
      { type: 'tool_use', id: 'call_42', name: 'fn', input: {} },
    ];
    s.rememberFromContent(blocks);
    expect(s.getCachedForToolCall('call_42')).toEqual({ thinking: 'thought', signature: 'sig' });
  });

  it('caches for assistant text', () => {
    const s = new ThinkingState();
    const blocks: ABlock[] = [
      { type: 'thinking', thinking: 'thought', signature: 'sig' },
      { type: 'text', text: 'assistant reply' },
    ];
    s.rememberFromContent(blocks);
    expect(s.getCachedForAssistantText('assistant reply')).toEqual({ thinking: 'thought', signature: 'sig' });
  });

  it('handles reasoning_content blocks (DeepSeek compat)', () => {
    const s = new ThinkingState();
    const blocks: ABlock[] = [
      { type: 'reasoning_content', text: 'deep reason' },
      { type: 'tool_use', id: 'call_rs', name: 'fn', input: {} },
    ];
    s.rememberFromContent(blocks);
    const cached = s.getCachedForToolCall('call_rs');
    expect(cached?.thinking).toBe('deep reason');
  });
});

describe('ThinkingState.rememberStreamResult', () => {
  it('associates thinking with tool call ids when provided', () => {
    const s = new ThinkingState();
    s.rememberStreamResult('stream thought', 'stream sig', ['t1', 't2'], 'text output');
    expect(s.getCachedForToolCall('t1')).toEqual({ thinking: 'stream thought', signature: 'stream sig' });
    expect(s.getCachedForToolCall('t2')).toEqual({ thinking: 'stream thought', signature: 'stream sig' });
  });

  it('associates thinking with output text when no tool call ids', () => {
    const s = new ThinkingState();
    s.rememberStreamResult('stream thought', 'stream sig', [], 'output text here');
    expect(s.getCachedForAssistantText('output text here')).toEqual({ thinking: 'stream thought', signature: 'stream sig' });
  });

  it('does nothing when thinking is empty', () => {
    const s = new ThinkingState();
    s.rememberStreamResult('', '', ['call_1'], 'output');
    expect(s.getCachedForToolCall('call_1')).toBeUndefined();
  });
});

describe('ThinkingState LRU eviction', () => {
  it('evicts oldest entries when limit is exceeded', () => {
    const limit = 3;
    const s = new ThinkingState(limit);
    s.rememberForToolCalls(['a'], 'ta', 'sa');
    s.rememberForToolCalls(['b'], 'tb', 'sb');
    s.rememberForToolCalls(['c'], 'tc', 'sc');
    s.rememberForToolCalls(['d'], 'td', 'sd'); // should evict 'a'
    expect(s.getCachedForToolCall('a')).toBeUndefined();
    expect(s.getCachedForToolCall('d')).toEqual({ thinking: 'td', signature: 'sd' });
  });
});
