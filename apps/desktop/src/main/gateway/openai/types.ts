/**
 * OpenAI Responses API output types (minimal — only what this gateway emits).
 */

import type { Obj } from '../types.js';

// ─── Output item types ────────────────────────────────────────────────────────

export interface OReasoningSummary {
  type: 'summary_text';
  text: string;
}

/**
 * A single item in the `output` array of an OpenAI Responses API response.
 * Covers: message, function_call, reasoning.
 */
export interface OOutputItem {
  type: string;
  id?: string;
  status?: string;
  /** For type="message" */
  role?: string;
  content?: Array<{ type: string; text: string; annotations?: unknown[] }>;
  /** For type="function_call" */
  call_id?: string;
  name?: string;
  arguments?: string;
  /** For type="reasoning" */
  summary?: OReasoningSummary[];
}

// ─── Response envelope ────────────────────────────────────────────────────────

export interface OResponse {
  id: string;
  object: string;
  created_at: number;
  model: unknown;
  status: string;
  output: OOutputItem[];
  output_text?: string;
  usage?: Obj;
  parallel_tool_calls?: boolean;
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Build an empty/in-progress OpenAI Responses API response envelope. */
export function baseResponse(
  id: string,
  model: unknown,
  status: string,
  output: OOutputItem[] = [],
): OResponse {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output,
    parallel_tool_calls: true,
  };
}
