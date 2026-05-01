/**
 * Anthropic Messages API types used across the local gateway.
 */

import type { Obj } from '../types.js';

// ─── Content blocks ──────────────────────────────────────────────────────────

/**
 * A single content block in an Anthropic message.
 * Covers: text, thinking, tool_use, tool_result, and reasoning_content (DeepSeek compat).
 */
export interface ABlock {
  type: string;
  /** text / reasoning_content */
  text?: string;
  /** thinking block */
  thinking?: string;
  /** thinking block signature */
  signature?: string;
  /** tool_use: unique call id */
  id?: string;
  /** tool_use: tool name */
  name?: string;
  /** tool_use: parsed input (object) */
  input?: unknown;
  /** tool_result: back-reference to the tool_use id */
  tool_use_id?: string;
  /** tool_result: content string or block array */
  content?: unknown;
  cache_control?: unknown;
}

// ─── Messages ────────────────────────────────────────────────────────────────

export interface AMessage {
  role: string;
  content: ABlock[];
}

// ─── Tools ───────────────────────────────────────────────────────────────────

export interface ATool {
  name: string;
  type?: string;
  description?: string;
  /** JSON Schema for the tool's parameters (Anthropic uses input_schema, not parameters). */
  input_schema?: Obj;
}

export interface AToolChoice {
  type: string; // "auto" | "any" | "none" | "tool"
  name?: string;
}

// ─── Request ─────────────────────────────────────────────────────────────────

export interface AOutputConfig {
  effort: string; // "high" | "max"
}

export interface ARequest {
  model: string;
  max_tokens: number;
  system?: ABlock[];
  messages: AMessage[];
  tools?: ATool[];
  tool_choice?: AToolChoice;
  stream?: boolean;
  /** DeepSeek-specific: controls extended thinking budget. */
  output_config?: AOutputConfig;
}

// ─── Response ────────────────────────────────────────────────────────────────

export interface AUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AResponse {
  id: string;
  type: string;
  role: string;
  content: ABlock[];
  stop_reason: string;
  usage: AUsage;
}

// ─── Streaming ───────────────────────────────────────────────────────────────

export interface AStreamDelta {
  type: string; // "text_delta" | "thinking_delta" | "reasoning_content_delta" | "signature_delta" | "input_json_delta"
  text?: string;
  thinking?: string;
  signature?: string;
  partial_json?: string;
  stop_reason?: string;
}

export interface AStreamEvent {
  type: string; // "message_start" | "content_block_start" | "content_block_delta" | "content_block_stop" | "message_delta" | "message_stop" | "error"
  /** message_start */
  message?: AResponse;
  /** content_block_start / content_block_stop / content_block_delta */
  index?: number;
  content_block?: ABlock;
  delta?: AStreamDelta;
  /** message_delta */
  usage?: AUsage;
  /** error */
  error?: { type: string; message: string };
}
