/**
 * Unit tests for deepseek/thinking.ts
 */

import { describe, it, expect } from 'vitest';
import {
  encodeThinkingSummary,
  decodeThinkingSummary,
  hasThinkingPayload,
  thinkingFromSummary,
  THINKING_PREFIX,
} from '../deepseek/thinking.js';

describe('encodeThinkingSummary', () => {
  it('returns thinking text as-is when non-empty', () => {
    expect(encodeThinkingSummary('hello thoughts', 'sig123')).toBe('hello thoughts');
  });

  it('returns empty string when both thinking and signature are empty', () => {
    expect(encodeThinkingSummary('', '')).toBe('');
  });

  it('base64url-encodes payload when thinking is empty but signature present', () => {
    const result = encodeThinkingSummary('', 'abc-sig');
    expect(result.startsWith(THINKING_PREFIX)).toBe(true);
    // The prefix is followed by non-empty base64url content
    const encoded = result.slice(THINKING_PREFIX.length);
    expect(encoded.length).toBeGreaterThan(0);
  });

  it('round-trips: encode then decode produces original values (thinking non-empty)', () => {
    const thinking = 'I should answer with care.';
    const signature = 'Abc123==';
    const encoded = encodeThinkingSummary(thinking, signature);
    const decoded = decodeThinkingSummary(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.thinking).toBe(thinking);
    // When thinking is non-empty, signature is not stored in the payload
    // (the text is returned verbatim, no base64 wrapper)
    expect(decoded!.signature).toBe('');
  });

  it('round-trips: encode then decode produces original values (signature only)', () => {
    const thinking = '';
    const signature = 'my-signature-payload';
    const encoded = encodeThinkingSummary(thinking, signature);
    const decoded = decodeThinkingSummary(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded!.thinking).toBe(thinking);
    expect(decoded!.signature).toBe(signature);
  });
});

describe('decodeThinkingSummary', () => {
  it('returns null for empty string', () => {
    expect(decodeThinkingSummary('')).toBeNull();
  });

  it('treats plain text (no prefix) as thinking with empty signature', () => {
    const result = decodeThinkingSummary('just a thought');
    expect(result).toEqual({ thinking: 'just a thought', signature: '' });
  });

  it('returns null for prefix-bearing payload that decodes to empty thinking and signature', () => {
    const encoded = THINKING_PREFIX + Buffer.from(JSON.stringify({ thinking: '', signature: '' })).toString('base64url');
    expect(decodeThinkingSummary(encoded)).toBeNull();
  });

  it('falls back gracefully on corrupt base64', () => {
    const corrupt = THINKING_PREFIX + '!!!invalid-base64!!!';
    const result = decodeThinkingSummary(corrupt);
    // Should fall back to treating the entire string as thinking text
    expect(result).not.toBeNull();
  });
});

describe('hasThinkingPayload', () => {
  it('returns true when thinking is non-empty', () => {
    expect(hasThinkingPayload('some thought', '')).toBe(true);
  });

  it('returns true when signature is non-empty', () => {
    expect(hasThinkingPayload('', 'sig')).toBe(true);
  });

  it('returns false when both empty', () => {
    expect(hasThinkingPayload('', '')).toBe(false);
  });
});

describe('thinkingFromSummary', () => {
  it('returns null for empty summary array', () => {
    expect(thinkingFromSummary([])).toBeNull();
  });

  it('returns null when no summary_text items', () => {
    expect(thinkingFromSummary([{ type: 'summary_text', text: '' }])).toBeNull();
  });

  it('returns decoded entry for a valid summary_text item', () => {
    const thinking = 'I am thinking deeply.';
    const text = encodeThinkingSummary(thinking, '');
    const result = thinkingFromSummary([{ type: 'summary_text', text }]);
    expect(result).not.toBeNull();
    expect(result!.thinking).toBe(thinking);
  });

  it('skips non-summary_text items', () => {
    const result = thinkingFromSummary([
      { type: 'other_type' as 'summary_text', text: 'ignored' },
      { type: 'summary_text', text: encodeThinkingSummary('real thought', '') },
    ]);
    expect(result!.thinking).toBe('real thought');
  });
});
