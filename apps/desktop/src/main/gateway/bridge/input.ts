/**
 * Input conversion: OpenAI Responses API → Anthropic Messages API.
 *
 * Also contains thinking-block helpers used during input conversion.
 */

import type { ABlock, AMessage } from '../anthropic/types.js';
import type { OReasoningSummary } from '../openai/types.js';
import type { Obj } from '../types.js';
import type { ThinkingState } from '../deepseek/state.js';
import { thinkingFromSummary, hasThinkingPayload } from '../deepseek/thinking.js';

// ─── Internal input item shape ────────────────────────────────────────────────

interface InputItem {
  type?: string;
  id?: string;
  role?: string;
  phase?: string;
  content?: unknown;
  call_id?: string;
  name?: string;
  namespace?: string;
  arguments?: string;
  input?: string;
  action?: unknown;
  summary?: OReasoningSummary[];
  output?: string;
}

// ─── Public return type ───────────────────────────────────────────────────────

export interface ConvertedInput {
  messages: AMessage[];
  system: ABlock[];
  hasToolHistory: boolean;
}

// ─── Content normalisation ────────────────────────────────────────────────────

/**
 * Normalise any OpenAI content value (string, array, or object) into an array
 * of Anthropic `ABlock`s.
 */
export function contentBlocksFromContent(content: unknown): ABlock[] {
  if (content === null || content === undefined || content === '') return [];
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return [];
    return [{ type: 'text', text: trimmed }];
  }
  if (Array.isArray(content)) {
    const blocks: ABlock[] = [];
    for (const part of content) {
      if (typeof part === 'string') {
        if (part.trim()) blocks.push({ type: 'text', text: part });
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const p = part as Obj;
      const pType = typeof p.type === 'string' ? p.type : '';
      if (pType === 'input_text' || pType === 'text' || pType === 'output_text') {
        const text = typeof p.text === 'string' ? p.text : '';
        if (text) blocks.push({ type: 'text', text });
      }
    }
    return blocks;
  }
  if (typeof content === 'object') {
    const p = content as Obj;
    const text = (p.text ?? p.output_text ?? p.input_text ?? '') as string;
    if (typeof text === 'string' && text.trim()) return [{ type: 'text', text }];
  }
  return [];
}

/** Parse an OpenAI tool-call `arguments` string into a plain object. */
export function toolInputFromArguments(args: unknown): unknown {
  if (!args) return {};
  if (typeof args === 'object') return args;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return {};
    try { return JSON.parse(trimmed) as unknown; } catch { return { raw: trimmed }; }
  }
  return {};
}

// ─── Message array builders ───────────────────────────────────────────────────

/** Append a block to the last assistant message, or start a new one. */
export function appendAssistantBlock(messages: AMessage[], block: ABlock): void {
  const last = messages[messages.length - 1];
  if (last?.role === 'assistant') {
    last.content.push(block);
  } else {
    messages.push({ role: 'assistant', content: [block] });
  }
}

/**
 * Append a tool_result block to the last user message (if it contains only
 * tool_result blocks) or start a new user message.
 */
export function appendToolResultBlock(messages: AMessage[], block: ABlock): void {
  const last = messages[messages.length - 1];
  if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) {
    last.content.push(block);
  } else {
    messages.push({ role: 'user', content: [block] });
  }
}

// ─── Thinking block prepend helpers ──────────────────────────────────────────

function hasThinkingBlock(blocks: ABlock[]): boolean {
  return blocks.some((b) => b.type === 'thinking');
}

function buildThinkingBlock(entry: { thinking: string; signature: string }): ABlock {
  const b: ABlock = { type: 'thinking', thinking: entry.thinking };
  if (entry.signature) b.signature = entry.signature;
  return b;
}

function prependThinkingForToolUse(messages: AMessage[], entry: { thinking: string; signature: string }): boolean {
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant') return false;
  if (hasThinkingBlock(last.content)) return false;
  last.content = [buildThinkingBlock(entry), ...last.content];
  return true;
}

function prependThinkingForAssistantText(
  blocks: ABlock[],
  entry: { thinking: string; signature: string },
): [ABlock[], boolean] {
  if (hasThinkingBlock(blocks)) return [blocks, false];
  return [[buildThinkingBlock(entry), ...blocks], true];
}

/** Resolve thinking for a tool-use item: summary → cache → empty fallback. */
export function resolveThinkingForToolUse(
  messages: AMessage[],
  toolCallId: string,
  pendingSummary: OReasoningSummary[] | undefined,
  state: ThinkingState,
): void {
  if (pendingSummary) {
    const entry = thinkingFromSummary(pendingSummary);
    if (entry) { prependThinkingForToolUse(messages, entry); return; }
  }
  const cached = state.getCachedForToolCall(toolCallId);
  if (cached) { prependThinkingForToolUse(messages, cached); return; }
  console.warn('[tday] DeepSeek thinking: no cached block for tool_call_id', toolCallId, '— using empty fallback');
  prependThinkingForToolUse(messages, { thinking: '', signature: '' });
}

/** Resolve thinking for an assistant-text message: summary → cache → empty fallback. */
export function resolveThinkingForAssistantText(
  blocks: ABlock[],
  pendingSummary: OReasoningSummary[] | undefined,
  state: ThinkingState,
): ABlock[] {
  if (pendingSummary) {
    const entry = thinkingFromSummary(pendingSummary);
    if (entry) { const [r] = prependThinkingForAssistantText(blocks, entry); return r; }
  }
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
  const cached = text ? state.getCachedForAssistantText(text) : undefined;
  if (cached) { const [r] = prependThinkingForAssistantText(blocks, cached); return r; }
  const [result, inserted] = prependThinkingForAssistantText(blocks, { thinking: '', signature: '' });
  if (inserted) console.warn('[tday] DeepSeek thinking: no cached block for assistant text — using empty fallback');
  return result;
}

// ─── StripReasoningContent ────────────────────────────────────────────────────

/**
 * Remove `reasoning_content` fields from OpenAI input items before conversion.
 */
export function stripReasoningContent(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  const str = JSON.stringify(input);
  if (!str.includes('reasoning_content')) return input;
  return input.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const obj = item as Obj;
    if (!('reasoning_content' in obj)) return item;
    const { reasoning_content: _drop, ...rest } = obj;
    return rest;
  });
}

// ─── Main conversion ──────────────────────────────────────────────────────────

/**
 * Convert an OpenAI Responses API `input` array (plus optional `instructions`)
 * into the Anthropic Messages API `messages` + `system` arrays.
 *
 * Port of: internal/protocol/bridge/request.go::convertInput  +
 *          internal/extension/codex/input.go
 */
export function convertInput(
  rawInput: unknown,
  instructions: unknown,
  thinkingState: ThinkingState,
): ConvertedInput {
  const input = stripReasoningContent(rawInput);
  const messages: AMessage[] = [];
  const system: ABlock[] = [];

  if (typeof instructions === 'string' && instructions.trim()) {
    system.push({ type: 'text', text: instructions });
  }

  let pendingSummary: OReasoningSummary[] | undefined;
  let hasToolHistory = false;

  const items: InputItem[] = Array.isArray(input)
    ? (input as InputItem[])
    : typeof input === 'string' && input
    ? [{ role: 'user', content: input }]
    : [];

  for (const item of items) {
    const type = item.type ?? '';
    const role = item.role ?? '';

    // Skip commentary and web-search events — they have no Anthropic equivalent
    if (item.phase === 'commentary' || type === 'web_search_call') continue;

    // Reasoning items carry the thinking summary from a previous turn
    if (type === 'reasoning') {
      pendingSummary = item.summary;
      continue;
    }

    // function_call → tool_use
    if (type === 'function_call') {
      hasToolHistory = true;
      const callId = item.call_id ?? item.id ?? `call_${messages.length}`;
      appendAssistantBlock(messages, {
        type: 'tool_use',
        id: callId,
        name: item.name ?? 'tool',
        input: toolInputFromArguments(item.arguments ?? item.input),
      });
      resolveThinkingForToolUse(messages, callId, pendingSummary, thinkingState);
      pendingSummary = undefined;
      continue;
    }

    // local_shell_call → tool_use with name "local_shell"
    if (type === 'local_shell_call') {
      hasToolHistory = true;
      const callId = item.call_id ?? item.id ?? `call_${messages.length}`;
      appendAssistantBlock(messages, {
        type: 'tool_use',
        id: callId,
        name: 'local_shell',
        input: item.action ?? {},
      });
      resolveThinkingForToolUse(messages, callId, pendingSummary, thinkingState);
      pendingSummary = undefined;
      continue;
    }

    // function_call_output / local_shell_call_output / tool_result → tool_result
    if (type === 'function_call_output' || type === 'local_shell_call_output' || type === 'tool_result') {
      hasToolHistory = true;
      appendToolResultBlock(messages, {
        type: 'tool_result',
        tool_use_id: item.call_id ?? item.id ?? '',
        content: typeof item.output === 'string' ? item.output : '',
      });
      pendingSummary = undefined;
      continue;
    }

    // system / developer → system array
    if (role === 'system' || role === 'developer') {
      system.push(...contentBlocksFromContent(item.content));
      pendingSummary = undefined;
      continue;
    }

    // assistant → inject thinking if needed
    if (role === 'assistant') {
      let blocks = contentBlocksFromContent(item.content);
      if (blocks.length === 0) { pendingSummary = undefined; continue; }
      if (pendingSummary || hasToolHistory) {
        blocks = resolveThinkingForAssistantText(blocks, pendingSummary, thinkingState);
      }
      messages.push({ role: 'assistant', content: blocks });
      pendingSummary = undefined;
      continue;
    }

    // user (or anything else with content)
    {
      const r = role || 'user';
      const blocks = contentBlocksFromContent(item.content);
      if (blocks.length === 0) { pendingSummary = undefined; continue; }
      messages.push({ role: r, content: blocks });
      pendingSummary = undefined;
    }
  }

  // Anthropic requires at least one message
  if (messages.length === 0) {
    messages.push({ role: 'user', content: [{ type: 'text', text: ' ' }] });
  }

  // Ensure the conversation alternates roles (Anthropic requirement)
  // We trust the caller's input to be well-formed — no additional merge here.

  return { messages, system, hasToolHistory };
}

// Re-export for convenience
export { hasThinkingPayload };
