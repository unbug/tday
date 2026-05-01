/**
 * Unit tests for bridge/input.ts
 */

import { describe, it, expect, vi } from 'vitest';
import {
  contentBlocksFromContent,
  toolInputFromArguments,
  appendAssistantBlock,
  appendToolResultBlock,
  convertInput,
  stripReasoningContent,
} from '../bridge/input.js';
import { ThinkingState } from '../deepseek/state.js';
import type { AMessage } from '../anthropic/types.js';

// ─── contentBlocksFromContent ─────────────────────────────────────────────────

describe('contentBlocksFromContent', () => {
  it('returns empty array for null/undefined/empty', () => {
    expect(contentBlocksFromContent(null)).toEqual([]);
    expect(contentBlocksFromContent(undefined)).toEqual([]);
    expect(contentBlocksFromContent('')).toEqual([]);
    expect(contentBlocksFromContent('   ')).toEqual([]);
  });

  it('wraps a plain string in a text block', () => {
    expect(contentBlocksFromContent('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('trims the string', () => {
    expect(contentBlocksFromContent('  hi  ')).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('converts array of strings to text blocks', () => {
    const result = contentBlocksFromContent(['foo', 'bar']);
    expect(result).toEqual([
      { type: 'text', text: 'foo' },
      { type: 'text', text: 'bar' },
    ]);
  });

  it('extracts text from input_text/text/output_text content parts', () => {
    const result = contentBlocksFromContent([
      { type: 'input_text', text: 'a' },
      { type: 'text', text: 'b' },
      { type: 'output_text', text: 'c' },
    ]);
    expect(result.map((b) => b.text)).toEqual(['a', 'b', 'c']);
  });

  it('skips parts without text', () => {
    const result = contentBlocksFromContent([{ type: 'image', url: 'x' }]);
    expect(result).toEqual([]);
  });

  it('unwraps object with text property', () => {
    expect(contentBlocksFromContent({ type: 'text', text: 'inline' })).toEqual([{ type: 'text', text: 'inline' }]);
  });
});

// ─── toolInputFromArguments ───────────────────────────────────────────────────

describe('toolInputFromArguments', () => {
  it('returns {} for falsy input', () => {
    expect(toolInputFromArguments(null)).toEqual({});
    expect(toolInputFromArguments('')).toEqual({});
    expect(toolInputFromArguments(undefined)).toEqual({});
  });

  it('passes through objects', () => {
    const obj = { key: 'val' };
    expect(toolInputFromArguments(obj)).toBe(obj);
  });

  it('parses valid JSON string', () => {
    expect(toolInputFromArguments('{"x":1}')).toEqual({ x: 1 });
  });

  it('wraps invalid JSON in {raw: ...}', () => {
    expect(toolInputFromArguments('bad json')).toEqual({ raw: 'bad json' });
  });
});

// ─── appendAssistantBlock ─────────────────────────────────────────────────────

describe('appendAssistantBlock', () => {
  it('creates a new assistant message when last role differs', () => {
    const msgs: AMessage[] = [{ role: 'user', content: [] }];
    appendAssistantBlock(msgs, { type: 'text', text: 'hi' });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe('assistant');
  });

  it('appends to existing assistant message', () => {
    const msgs: AMessage[] = [{ role: 'assistant', content: [{ type: 'text', text: 'a' }] }];
    appendAssistantBlock(msgs, { type: 'text', text: 'b' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toHaveLength(2);
  });
});

// ─── appendToolResultBlock ────────────────────────────────────────────────────

describe('appendToolResultBlock', () => {
  it('creates a new user message with the tool_result block', () => {
    const msgs: AMessage[] = [{ role: 'assistant', content: [] }];
    appendToolResultBlock(msgs, { type: 'tool_result', tool_use_id: 'id1', content: 'out' });
    expect(msgs).toHaveLength(2);
    expect(msgs[1].role).toBe('user');
  });

  it('appends to existing tool_result user message', () => {
    const msgs: AMessage[] = [{
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: '1' }],
    }];
    appendToolResultBlock(msgs, { type: 'tool_result', tool_use_id: 'y', content: '2' });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toHaveLength(2);
  });

  it('does NOT append to a regular user message (starts new message)', () => {
    const msgs: AMessage[] = [{
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }];
    appendToolResultBlock(msgs, { type: 'tool_result', tool_use_id: 'y', content: '2' });
    expect(msgs).toHaveLength(2);
  });
});

// ─── stripReasoningContent ────────────────────────────────────────────────────

describe('stripReasoningContent', () => {
  it('returns non-array input unchanged', () => {
    expect(stripReasoningContent('hello')).toBe('hello');
  });

  it('returns array unchanged when no reasoning_content fields', () => {
    const input = [{ type: 'message', content: 'hi' }];
    expect(stripReasoningContent(input)).toBe(input); // same ref (no copy)
  });

  it('removes reasoning_content from items that have it', () => {
    const input = [
      { type: 'message', content: 'hi', reasoning_content: 'thoughts' },
      { type: 'other' },
    ];
    const result = stripReasoningContent(input) as Array<Record<string, unknown>>;
    expect(result[0]).not.toHaveProperty('reasoning_content');
    expect(result[0].content).toBe('hi');
    expect(result[1]).toEqual({ type: 'other' });
  });
});

// ─── convertInput ─────────────────────────────────────────────────────────────

describe('convertInput', () => {
  it('wraps a plain string input as a single user message', () => {
    const state = new ThinkingState();
    const { messages, system } = convertInput('Hello AI', undefined, state);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'Hello AI' }] });
    expect(system).toEqual([]);
  });

  it('handles system/developer role items → system array', () => {
    const state = new ThinkingState();
    const { messages, system } = convertInput(
      [{ role: 'system', content: 'Be helpful.' }, { role: 'user', content: 'hi' }],
      undefined,
      state,
    );
    expect(system).toEqual([{ type: 'text', text: 'Be helpful.' }]);
    expect(messages[0].role).toBe('user');
  });

  it('prefixes instructions into system when priorMessages is empty', () => {
    const state = new ThinkingState();
    const { system } = convertInput([], 'Act like an expert.', state);
    expect(system[0].text).toBe('Act like an expert.');
  });

  it('converts function_call → tool_use and sets hasToolHistory', () => {
    const state = new ThinkingState();
    const { messages, hasToolHistory } = convertInput(
      [
        { type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"q":"test"}' },
        { type: 'function_call_output', call_id: 'c1', output: 'result' },
      ],
      undefined,
      state,
    );
    expect(hasToolHistory).toBe(true);
    const toolUse = messages.find((m) => m.content.some((b) => b.type === 'tool_use'));
    expect(toolUse).toBeDefined();
    const toolResult = messages.find((m) => m.content.some((b) => b.type === 'tool_result'));
    expect(toolResult).toBeDefined();
  });

  it('converts local_shell_call → tool_use with name "local_shell"', () => {
    const state = new ThinkingState();
    const { messages } = convertInput(
      [{ type: 'local_shell_call', call_id: 's1', action: { command: ['ls'] } }],
      undefined,
      state,
    );
    const block = messages.flatMap((m) => m.content).find((b) => b.type === 'tool_use');
    expect(block?.name).toBe('local_shell');
  });

  it('skips commentary and web_search_call items', () => {
    const state = new ThinkingState();
    const { messages } = convertInput(
      [
        { type: 'web_search_call' },
        { phase: 'commentary', role: 'assistant', content: 'ignored' },
        { role: 'user', content: 'visible' },
      ],
      undefined,
      state,
    );
    expect(messages).toHaveLength(1);
    expect(messages[0].content[0].text).toBe('visible');
  });

  it('produces a minimal user message when input is empty', () => {
    const state = new ThinkingState();
    const { messages } = convertInput([], undefined, state);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('user');
  });

  it('prepends thinking to assistant text when pending summary is present', () => {
    const state = new ThinkingState();
    const summaryText = 'I reasoned about it.'; // plain text (no encode needed)
    const { messages } = convertInput(
      [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: summaryText }] },
        { role: 'assistant', content: 'Sure, here is my answer.' },
      ],
      undefined,
      state,
    );
    const assistantMsg = messages.find((m) => m.role === 'assistant');
    const thinkingBlock = assistantMsg?.content.find((b) => b.type === 'thinking');
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock?.thinking).toBe(summaryText);
  });

  it('emits console.warn (but continues) when no thinking for tool call', () => {
    const state = new ThinkingState();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { messages } = convertInput(
      [{ type: 'function_call', call_id: 'no_thinking', name: 'fn', arguments: '{}' }],
      undefined,
      state,
    );
    // Should still produce a tool_use block
    const toolUse = messages.flatMap((m) => m.content).find((b) => b.type === 'tool_use');
    expect(toolUse).toBeDefined();
    warnSpy.mockRestore();
  });
});
