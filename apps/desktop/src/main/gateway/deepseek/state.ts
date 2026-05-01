/**
 * ThinkingState — per-session LRU cache that maps tool-call IDs and assistant
 * text digests to their associated (thinking, signature) pairs.
 *
 * DeepSeek's extended-thinking feature requires that a `thinking` block
 * precedes every `tool_use` or assistant-text block in multi-turn
 * conversations.  Because the thinking block is never echoed back by the
 * client, we must cache it ourselves and re-inject it on subsequent turns.
 */

import { createHash } from 'node:crypto';
import type { ABlock } from '../anthropic/types.js';
import { hasThinkingPayload, type ThinkingEntry } from './thinking.js';

/** SHA-256 digest of a text string — used as the text-based cache key. */
function thinkingTextKey(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const DEFAULT_LIMIT = 1024;

export class ThinkingState {
  private readonly records = new Map<string, ThinkingEntry>();
  private readonly recordOrder: string[] = [];
  private readonly textRecords = new Map<string, ThinkingEntry>();
  private readonly textOrder: string[] = [];
  private readonly limit: number;

  constructor(limit = DEFAULT_LIMIT) {
    this.limit = limit;
  }

  // ─── Remember ─────────────────────────────────────────────────────────────

  /** Cache (thinking, signature) keyed by each tool-call id. */
  rememberForToolCalls(toolCallIds: string[], thinking: string, signature: string): void {
    if (!hasThinkingPayload(thinking, signature) || toolCallIds.length === 0) return;
    for (const id of toolCallIds) {
      if (!id) continue;
      if (!this.records.has(id)) this.recordOrder.push(id);
      this.records.set(id, { thinking, signature });
    }
    this.prune();
  }

  /** Cache (thinking, signature) keyed by a digest of the assistant text. */
  rememberForAssistantText(text: string, thinking: string, signature: string): void {
    if (!text || !hasThinkingPayload(thinking, signature)) return;
    const key = thinkingTextKey(text);
    if (!this.textRecords.has(key)) this.textOrder.push(key);
    this.textRecords.set(key, { thinking, signature });
    this.prune();
  }

  /**
   * Walk a response's content blocks and cache whatever thinking we find,
   * associated with any tool_use ids and any assistant text in the same message.
   */
  rememberFromContent(blocks: ABlock[]): void {
    let thinking = '';
    let signature = '';
    const toolCallIds: string[] = [];
    let assistantText = '';
    for (const b of blocks) {
      if (b.type === 'thinking') {
        thinking = b.thinking ?? '';
        signature = b.signature ?? '';
      } else if (b.type === 'reasoning_content') {
        thinking = b.text ?? '';
        signature = '';
      } else if (b.type === 'tool_use' && b.id) {
        toolCallIds.push(b.id);
      } else if (b.type === 'text') {
        assistantText += b.text ?? '';
      }
    }
    this.rememberForToolCalls(toolCallIds, thinking, signature);
    this.rememberForAssistantText(assistantText, thinking, signature);
  }

  /**
   * Persist stream results: associate (thinking, signature) with the tool-call
   * ids collected during streaming, or with the output text if no tool calls.
   */
  rememberStreamResult(
    completedThinking: string,
    completedSignature: string,
    toolCallIds: string[],
    outputText: string,
  ): void {
    if (!hasThinkingPayload(completedThinking, completedSignature)) return;
    if (toolCallIds.length > 0) {
      this.rememberForToolCalls(toolCallIds, completedThinking, completedSignature);
    } else {
      this.rememberForAssistantText(outputText, completedThinking, completedSignature);
    }
  }

  // ─── Retrieve ─────────────────────────────────────────────────────────────

  /** Look up a cached entry by tool-call id. */
  getCachedForToolCall(toolCallId: string): ThinkingEntry | undefined {
    return this.records.get(toolCallId);
  }

  /** Look up a cached entry by assistant text. */
  getCachedForAssistantText(text: string): ThinkingEntry | undefined {
    if (!text) return undefined;
    return this.textRecords.get(thinkingTextKey(text));
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private prune(): void {
    while (this.recordOrder.length > this.limit) {
      const id = this.recordOrder.shift()!;
      this.records.delete(id);
    }
    while (this.textOrder.length > this.limit) {
      const key = this.textOrder.shift()!;
      this.textRecords.delete(key);
    }
  }
}
