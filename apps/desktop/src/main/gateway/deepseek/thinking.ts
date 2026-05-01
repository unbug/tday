/**
 * DeepSeek V4 thinking encoding / decoding utilities.
 *
 * When the upstream returns a `thinking` block we need to round-trip it through
 * the OpenAI `reasoning` summary field so the next turn can re-attach it.  The
 * encoding strategy:
 *
 *   • If thinking text is non-empty  → store it verbatim (it's the human-readable
 *     inner monologue, no lossless signature needed on the wire to Codex).
 *   • If thinking is empty but signature is present → base64url-encode a JSON
 *     payload `{thinking, signature}` with a well-known prefix so we can detect
 *     and recover it later.
 */

import type { OReasoningSummary } from '../openai/types.js';

/** The unique prefix we embed in base64-encoded payloads. */
export const THINKING_PREFIX = 'tday:deepseek_thinking:v1:';

export interface ThinkingEntry {
  thinking: string;
  signature: string;
}

interface ThinkingBlock {
  thinking: string;
  signature: string;
}

/**
 * Encode a (thinking, signature) pair into a single string that can be stored
 * as a reasoning summary item.
 *
 * If `thinking` is non-empty it is returned as-is.
 * Otherwise, if `signature` is non-empty, a prefixed base64url payload is returned.
 * If both are empty the empty string is returned.
 */
export function encodeThinkingSummary(thinking: string, signature: string): string {
  if (thinking) return thinking;
  if (!signature) return '';
  const payload = JSON.stringify({ thinking, signature } as ThinkingBlock);
  return THINKING_PREFIX + Buffer.from(payload).toString('base64url');
}

/**
 * Decode a string produced by {@link encodeThinkingSummary} back to a
 * `{thinking, signature}` pair.  Returns `null` if the result is empty /
 * meaningless.
 */
export function decodeThinkingSummary(text: string): ThinkingEntry | null {
  if (!text) return null;
  if (!text.startsWith(THINKING_PREFIX)) {
    return { thinking: text, signature: '' };
  }
  const encoded = text.slice(THINKING_PREFIX.length);
  try {
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    const decoded = JSON.parse(payload) as ThinkingBlock;
    if (!decoded.thinking && !decoded.signature) return null;
    return decoded;
  } catch {
    return { thinking: text, signature: '' };
  }
}

/** Returns true if either field carries meaningful thinking data. */
export function hasThinkingPayload(thinking: string, signature: string): boolean {
  return !!(thinking || signature);
}

/**
 * Extract the first meaningful {@link ThinkingEntry} from an OpenAI reasoning
 * summary array.
 */
export function thinkingFromSummary(summary: OReasoningSummary[]): ThinkingEntry | null {
  for (const item of summary) {
    if (item.type !== 'summary_text') continue;
    const decoded = decodeThinkingSummary(item.text);
    if (decoded && hasThinkingPayload(decoded.thinking, decoded.signature)) return decoded;
  }
  return null;
}
