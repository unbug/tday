/**
 * Streaming response conversion: Anthropic SSE events → OpenAI Responses API SSE.
 *
 * The converter is stateful and must be used for a single stream, in order:
 *   1. `processEvent(event)` for each Anthropic SSE event
 *   2. `finish()` once the stream is done
 */

import type { AStreamEvent } from '../anthropic/types.js';
import type { OOutputItem } from '../openai/types.js';
import type { Obj } from '../types.js';
import type { ThinkingState } from '../deepseek/state.js';
import { baseResponse } from '../openai/types.js';
import { encodeThinkingSummary, hasThinkingPayload } from '../deepseek/thinking.js';

/** Pick the first non-empty value from a list. */
function firstNonEmpty(...values: (string | undefined | null)[]): string {
  for (const v of values) { if (v) return v; }
  return '';
}

export class AnthropicStreamConverter {
  private seq = 0;
  // ── per-index text accumulation ──
  private contentText = new Map<number, string>();
  private toolArguments = new Map<number, string>();
  private toolCallInfo = new Map<number, { id: string; name: string; outputIndex: number; itemId: string }>();
  // ── output item tracking ──
  private outputItems: OOutputItem[] = [];
  private outputIndexes = new Map<number, number>();
  private outputText = '';
  // ── thinking stream state ──
  private ssThinkingText = new Map<number, string>();
  private ssThinkingSignature = new Map<number, string>();
  private ssToolCallIds: string[] = [];
  private ssCompletedThinking = '';
  private ssCompletedSignature = '';
  // ── pending reasoning emission ──
  private pendingReasoningText = '';
  private pendingReasoningEmitted = false;

  constructor(
    private readonly responseId: string,
    private readonly model: unknown,
    private readonly state: ThinkingState,
    private readonly hasToolHistory: boolean,
  ) {}

  /** Monotonically increasing sequence number for SSE events. */
  next(): number { return ++this.seq; }

  /**
   * Process one Anthropic SSE event and return zero or more OpenAI SSE
   * `{event, data}` pairs to emit downstream.
   */
  processEvent(event: AStreamEvent): Array<{ event: string; data: Obj }> {
    const emit: Array<{ event: string; data: Obj }> = [];

    switch (event.type) {
      // ── message_start ────────────────────────────────────────────────────
      case 'message_start': {
        const resp = baseResponse(this.responseId, this.model, 'in_progress');
        emit.push(
          { event: 'response.created',     data: { type: 'response.created',     sequence_number: this.next(), response: resp } },
          { event: 'response.in_progress', data: { type: 'response.in_progress', sequence_number: this.next(), response: resp } },
        );
        break;
      }

      // ── content_block_start ───────────────────────────────────────────────
      case 'content_block_start': {
        const idx = event.index ?? 0;
        const block = event.content_block;
        if (!block) break;

        // Reset per-block state
        this.contentText.delete(idx);
        this.toolArguments.delete(idx);
        this.ssThinkingText.delete(idx);
        this.ssThinkingSignature.delete(idx);

        if (block.type === 'thinking' || block.type === 'reasoning_content') {
          this.ssThinkingText.set(idx, firstNonEmpty(block.thinking, block.text));
          this.ssThinkingSignature.set(idx, block.signature ?? '');
        } else if (block.type === 'text') {
          this.contentText.set(idx, '');
        } else if (block.type === 'tool_use') {
          const callId = block.id ?? `call_${this.responseId}_${idx}`;
          const name = block.name ?? '';
          const outputIndex = this.outputItems.length;
          const itemId = `fc_${callId}`;
          this.toolCallInfo.set(idx, { id: callId, name, outputIndex, itemId });
          this.outputIndexes.set(idx, outputIndex);
          this.ssToolCallIds.push(callId);
          this.toolArguments.set(idx, '');
          // Emit any pending reasoning before the tool call item
          emit.push(...this.emitPendingReasoning());
          const item: OOutputItem = { type: 'function_call', id: itemId, status: 'in_progress', call_id: callId, name, arguments: '' };
          this.outputItems.push(item);
          emit.push({
            event: 'response.output_item.added',
            data: { type: 'response.output_item.added', sequence_number: this.next(), output_index: outputIndex, item },
          });
        }
        break;
      }

      // ── content_block_delta ───────────────────────────────────────────────
      case 'content_block_delta': {
        const idx = event.index ?? 0;
        const delta = event.delta;
        if (!delta) break;

        // Thinking delta
        if (delta.type === 'thinking_delta' || delta.type === 'reasoning_content_delta') {
          this.ssThinkingText.set(idx, (this.ssThinkingText.get(idx) ?? '') + firstNonEmpty(delta.thinking, delta.text));
          break;
        }

        // Signature delta
        if (delta.type === 'signature_delta') {
          this.ssThinkingSignature.set(idx, (this.ssThinkingSignature.get(idx) ?? '') + firstNonEmpty(delta.signature, delta.text));
          break;
        }

        // Text delta
        if (delta.type === 'text_delta' && delta.text) {
          this.contentText.set(idx, (this.contentText.get(idx) ?? '') + delta.text);

          if (!this.outputIndexes.has(idx)) {
            // First text delta: emit pending reasoning if we have tool history
            if (this.hasToolHistory) emit.push(...this.emitPendingReasoning());

            const outputIndex = this.outputItems.length;
            this.outputIndexes.set(idx, outputIndex);
            const itemId = `msg_${this.responseId}`;
            const item: OOutputItem = { type: 'message', id: itemId, status: 'in_progress', role: 'assistant', content: [] };
            this.outputItems.push(item);
            emit.push(
              { event: 'response.output_item.added',   data: { type: 'response.output_item.added',   sequence_number: this.next(), output_index: outputIndex, item } },
              { event: 'response.content_part.added',  data: { type: 'response.content_part.added',  sequence_number: this.next(), item_id: itemId, output_index: outputIndex, content_index: 0, part: { type: 'output_text', text: '' } } },
            );
          }

          const oi = this.outputIndexes.get(idx)!;
          const itemId = this.outputItems[oi]?.id ?? `msg_${this.responseId}`;
          emit.push({
            event: 'response.output_text.delta',
            data: { type: 'response.output_text.delta', sequence_number: this.next(), item_id: itemId, output_index: oi, content_index: 0, delta: delta.text },
          });
        }

        // Tool-argument delta
        if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
          this.toolArguments.set(idx, (this.toolArguments.get(idx) ?? '') + delta.partial_json);
          const info = this.toolCallInfo.get(idx);
          if (info) {
            emit.push({
              event: 'response.function_call_arguments.delta',
              data: { type: 'response.function_call_arguments.delta', sequence_number: this.next(), item_id: info.itemId, output_index: info.outputIndex, delta: delta.partial_json },
            });
          }
        }
        break;
      }

      // ── content_block_stop ────────────────────────────────────────────────
      case 'content_block_stop': {
        const idx = event.index ?? 0;

        // Thinking block done
        if (this.ssThinkingText.has(idx)) {
          const thinking = this.ssThinkingText.get(idx) ?? '';
          const sig = this.ssThinkingSignature.get(idx) ?? '';
          this.ssCompletedThinking = thinking;
          this.ssCompletedSignature = sig;
          const summaryText = encodeThinkingSummary(thinking, sig);
          if (summaryText) this.pendingReasoningText = summaryText;
          this.ssThinkingText.delete(idx);
          this.ssThinkingSignature.delete(idx);
          break;
        }

        // Text block done
        if (this.contentText.has(idx)) {
          const text = this.contentText.get(idx) ?? '';
          this.outputText += text;
          const oi = this.outputIndexes.get(idx);
          if (oi !== undefined) {
            const itemId = this.outputItems[oi]?.id ?? `msg_${this.responseId}`;
            const item: OOutputItem = { type: 'message', id: itemId, status: 'completed', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
            this.outputItems[oi] = item;
            emit.push(
              { event: 'response.output_text.done',    data: { type: 'response.output_text.done',    sequence_number: this.next(), item_id: itemId, output_index: oi, content_index: 0, text, logprobs: [] } },
              { event: 'response.content_part.done',   data: { type: 'response.content_part.done',   sequence_number: this.next(), item_id: itemId, output_index: oi, content_index: 0, part: { type: 'output_text', text, annotations: [] } } },
              { event: 'response.output_item.done',    data: { type: 'response.output_item.done',    sequence_number: this.next(), output_index: oi, item } },
            );
          }
          this.contentText.delete(idx);
          break;
        }

        // Tool-use block done
        if (this.toolArguments.has(idx)) {
          const args = this.toolArguments.get(idx) ?? '';
          const info = this.toolCallInfo.get(idx);
          if (info) {
            const item: OOutputItem = { type: 'function_call', id: info.itemId, status: 'completed', call_id: info.id, name: info.name, arguments: args };
            this.outputItems[info.outputIndex] = item;
            emit.push(
              { event: 'response.function_call_arguments.done', data: { type: 'response.function_call_arguments.done', sequence_number: this.next(), item_id: info.itemId, output_index: info.outputIndex, arguments: args } },
              { event: 'response.output_item.done',             data: { type: 'response.output_item.done',             sequence_number: this.next(), output_index: info.outputIndex, item } },
            );
          }
          this.toolArguments.delete(idx);
          break;
        }
        break;
      }
    }

    return emit;
  }

  /**
   * Emit a buffered reasoning output item (deferred until we know whether a
   * tool-use or text block follows the thinking block).
   */
  private emitPendingReasoning(): Array<{ event: string; data: Obj }> {
    if (!this.pendingReasoningText || this.pendingReasoningEmitted) return [];
    this.pendingReasoningEmitted = true;
    const oi = this.outputItems.length;
    const item: OOutputItem = {
      type: 'reasoning',
      id: `rs_${this.responseId}_${oi}`,
      summary: [{ type: 'summary_text', text: this.pendingReasoningText }],
    };
    this.outputItems.push(item);
    return [
      { event: 'response.output_item.added', data: { type: 'response.output_item.added', sequence_number: this.next(), output_index: oi, item } },
      { event: 'response.output_item.done',  data: { type: 'response.output_item.done',  sequence_number: this.next(), output_index: oi, item } },
    ];
  }

  /**
   * Finalise the stream.  Persists thinking to the session state and returns
   * the accumulated output, output text, and encoded reasoning text for storage.
   */
  finish(): { output: OOutputItem[]; outputText: string; completedReasoningText: string } {
    this.state.rememberStreamResult(
      this.ssCompletedThinking,
      this.ssCompletedSignature,
      this.ssToolCallIds,
      this.outputText,
    );
    const completedReasoningText = hasThinkingPayload(this.ssCompletedThinking, this.ssCompletedSignature)
      ? encodeThinkingSummary(this.ssCompletedThinking, this.ssCompletedSignature)
      : '';
    return {
      output: [...this.outputItems],
      outputText: this.outputText,
      completedReasoningText,
    };
  }
}
