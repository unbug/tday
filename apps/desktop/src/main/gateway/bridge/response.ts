/**
 * Non-streaming response conversion + stored-message builders.
 */

import type { ABlock, AMessage, AResponse, AUsage } from '../anthropic/types.js';
import type { OOutputItem } from '../openai/types.js';
import type { Obj } from '../types.js';
import type { ThinkingState } from '../deepseek/state.js';
import { encodeThinkingSummary, decodeThinkingSummary, hasThinkingPayload } from '../deepseek/thinking.js';

// ─── Response conversion ──────────────────────────────────────────────────────

export interface ConvertedResponse {
  output: OOutputItem[];
  outputText: string;
}

/**
 * Convert a non-streaming Anthropic `MessageResponse` into the OpenAI Responses
 * API `output` array.
 *
 * - thinking / reasoning_content → reasoning item with encoded summary
 * - text → message item
 * - tool_use → function_call item
 */
export function convertAnthropicResponse(
  response: AResponse,
  state: ThinkingState,
  responseId: string,
): ConvertedResponse {
  // Persist any thinking we find for use in subsequent turns
  state.rememberFromContent(response.content);

  const output: OOutputItem[] = [];
  let outputText = '';
  let pendingContent: Array<{ type: string; text: string; annotations?: unknown[] }> = [];

  const flushText = (idx: number) => {
    if (!pendingContent.length) return;
    outputText += pendingContent.map((c) => c.text).join('');
    output.push({
      type: 'message',
      id: `msg_item_${idx}`,
      status: 'completed',
      role: 'assistant',
      content: [...pendingContent],
    });
    pendingContent = [];
  };

  for (let i = 0; i < response.content.length; i++) {
    const b = response.content[i];

    if (b.type === 'thinking' || b.type === 'reasoning_content') {
      const thinking = b.type === 'thinking' ? (b.thinking ?? '') : (b.text ?? '');
      const sig = b.signature ?? '';
      const summaryText = encodeThinkingSummary(thinking, sig);
      if (summaryText) {
        output.push({
          type: 'reasoning',
          id: `rs_${responseId}_${i}`,
          summary: [{ type: 'summary_text', text: summaryText }],
        });
      }
    } else if (b.type === 'text') {
      pendingContent.push({ type: 'output_text', text: b.text ?? '', annotations: [] });
    } else if (b.type === 'tool_use') {
      flushText(i);
      const callId = b.id ?? `call_${responseId}_${i}`;
      output.push({
        type: 'function_call',
        id: `fc_${callId}`,
        status: 'completed',
        call_id: callId,
        name: b.name ?? '',
        arguments: b.input !== undefined ? JSON.stringify(b.input) : '{}',
      });
    }
  }
  flushText(response.content.length);
  return { output, outputText };
}

// ─── Stored-message builders ──────────────────────────────────────────────────

/**
 * Build the Anthropic messages to store for the next turn, given the content
 * blocks from a non-streaming response.
 * Only text, tool_use, and thinking blocks are carried forward.
 */
export function buildStoredMessages(responseContent: ABlock[]): AMessage[] {
  const blocks = responseContent.filter(
    (b) => b.type === 'text' || b.type === 'tool_use' || b.type === 'thinking',
  );
  if (!blocks.length) return [];
  return [{ role: 'assistant', content: blocks }];
}

/**
 * Reconstruct Anthropic messages from streaming output items and the completed
 * reasoning text, for storage and use in the next turn.
 */
export function buildStoredMessagesFromStream(
  output: OOutputItem[],
  completedReasoningText: string,
): AMessage[] {
  const blocks: ABlock[] = [];

  if (completedReasoningText) {
    const decoded = decodeThinkingSummary(completedReasoningText);
    if (decoded && hasThinkingPayload(decoded.thinking, decoded.signature)) {
      const b: ABlock = { type: 'thinking', thinking: decoded.thinking };
      if (decoded.signature) b.signature = decoded.signature;
      blocks.push(b);
    }
  }

  for (const item of output) {
    if (item.type === 'message' && item.content) {
      for (const c of item.content) {
        if (c.type === 'output_text') blocks.push({ type: 'text', text: c.text });
      }
    } else if (item.type === 'function_call') {
      let input: unknown = {};
      try { input = JSON.parse(item.arguments ?? '{}') as unknown; } catch { /* keep {} */ }
      blocks.push({
        type: 'tool_use',
        id: item.call_id ?? '',
        name: item.name ?? '',
        input,
      });
    }
  }

  if (!blocks.length) return [];
  return [{ role: 'assistant', content: blocks }];
}

// ─── Usage normalisation ──────────────────────────────────────────────────────

/**
 * Convert Anthropic usage counters to the OpenAI usage shape emitted in our
 * response envelope.
 */
export function normalizeUsage(usage: AUsage | undefined): Obj {
  if (!usage) return {};
  return {
    input_tokens: usage.input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    total_tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    input_tokens_details: { cached_tokens: usage.cache_read_input_tokens ?? 0 },
  };
}
