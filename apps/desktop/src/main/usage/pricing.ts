/**
 * Built-in model pricing table (USD per 1 000 tokens).
 * Based on public pricing pages as of 2026-05.
 *
 * Keys are exact model IDs as returned by the provider's API.
 * A wildcard key like "gpt-4o*" is matched by prefix when no exact key is found.
 *
 * Users can supplement / override via ~/.tday/pricing.json using the same schema.
 */

import type { ModelPricing } from './types.js';

export const BUILTIN_PRICING: Record<string, ModelPricing> = {
  // ── OpenAI ──────────────────────────────────────────────────────────────────
  'gpt-5':           { inputPer1k: 0.015, outputPer1k: 0.060, cachedPer1k: 0.0075 },
  'gpt-5-mini':      { inputPer1k: 0.004, outputPer1k: 0.016, cachedPer1k: 0.001 },
  'gpt-5-nano':      { inputPer1k: 0.001, outputPer1k: 0.004 },
  'gpt-4.1':         { inputPer1k: 0.002, outputPer1k: 0.008, cachedPer1k: 0.0005 },
  'gpt-4o':          { inputPer1k: 0.0025, outputPer1k: 0.010, cachedPer1k: 0.00125 },
  'gpt-4o-mini':     { inputPer1k: 0.00015, outputPer1k: 0.0006 },
  'o4-mini':         { inputPer1k: 0.0011, outputPer1k: 0.0044, cachedPer1k: 0.000275 },
  'o3':              { inputPer1k: 0.002, outputPer1k: 0.008, cachedPer1k: 0.0005 },

  // ── Anthropic ────────────────────────────────────────────────────────────────
  'claude-opus-4-6':           { inputPer1k: 0.015, outputPer1k: 0.075, cachedPer1k: 0.0015 },
  'claude-opus-4-5':           { inputPer1k: 0.015, outputPer1k: 0.075, cachedPer1k: 0.0015 },
  'claude-sonnet-4-5':         { inputPer1k: 0.003, outputPer1k: 0.015, cachedPer1k: 0.0003 },
  'claude-haiku-4-5':          { inputPer1k: 0.0008, outputPer1k: 0.004, cachedPer1k: 0.00008 },
  'claude-3-5-sonnet-latest':  { inputPer1k: 0.003, outputPer1k: 0.015, cachedPer1k: 0.0003 },

  // ── DeepSeek ─────────────────────────────────────────────────────────────────
  'deepseek-v4-pro':   { inputPer1k: 0.00027, outputPer1k: 0.0011, cachedPer1k: 0.000068 },
  'deepseek-v4-flash': { inputPer1k: 0.000027, outputPer1k: 0.00011 },
  'deepseek-chat':     { inputPer1k: 0.00027, outputPer1k: 0.0011 },
  'deepseek-reasoner': { inputPer1k: 0.00055, outputPer1k: 0.00219 },

  // ── Google Gemini ─────────────────────────────────────────────────────────────
  'gemini-2.5-pro':   { inputPer1k: 0.00125, outputPer1k: 0.010, cachedPer1k: 0.0003125 },
  'gemini-2.5-flash': { inputPer1k: 0.0003, outputPer1k: 0.0025, cachedPer1k: 0.000075 },
  'gemini-2.0-flash': { inputPer1k: 0.0001, outputPer1k: 0.0004 },

  // ── xAI (Grok) ────────────────────────────────────────────────────────────────
  'grok-4':           { inputPer1k: 0.003, outputPer1k: 0.015 },
  'grok-4-fast':      { inputPer1k: 0.0005, outputPer1k: 0.0025 },
  'grok-3':           { inputPer1k: 0.003, outputPer1k: 0.015 },
  'grok-3-mini':      { inputPer1k: 0.0003, outputPer1k: 0.0005 },

  // ── Groq ─────────────────────────────────────────────────────────────────────
  'llama-4-scout-17b-16e':    { inputPer1k: 0.0002, outputPer1k: 0.0006 },
  'llama-4-maverick-17b-128e':{ inputPer1k: 0.0004, outputPer1k: 0.0008 },
  'llama-3.3-70b-versatile':  { inputPer1k: 0.00059, outputPer1k: 0.00079 },
  'qwen3-32b':                { inputPer1k: 0.00029, outputPer1k: 0.00059 },

  // ── Mistral ──────────────────────────────────────────────────────────────────
  'mistral-large-latest':  { inputPer1k: 0.002, outputPer1k: 0.006 },
  'codestral-latest':      { inputPer1k: 0.001, outputPer1k: 0.003 },
  'magistral-medium':      { inputPer1k: 0.002, outputPer1k: 0.005 },

  // ── Local models (free) ───────────────────────────────────────────────────────
  // Wildcard prefix matches: resolved by resolvePrice() below
  'llama': { inputPer1k: 0, outputPer1k: 0 },
  'qwen':  { inputPer1k: 0, outputPer1k: 0 },
  'phi':   { inputPer1k: 0, outputPer1k: 0 },
  'gemma': { inputPer1k: 0, outputPer1k: 0 },
  'mistral-7b': { inputPer1k: 0, outputPer1k: 0 },
};

/**
 * Resolve pricing for a model id.
 *
 * Resolution order:
 *   1. Exact match in `table`
 *   2. Prefix match (longest prefix wins)
 *   3. `null` — price unknown
 */
export function resolvePrice(
  model: string,
  table: Record<string, ModelPricing> = BUILTIN_PRICING,
): ModelPricing | null {
  if (table[model]) return table[model];

  // Longest prefix match
  let best: ModelPricing | null = null;
  let bestLen = 0;
  for (const key of Object.keys(table)) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = table[key];
      bestLen = key.length;
    }
  }
  return best;
}

/** Calculate USD cost for a single usage record. Returns null if price unknown. */
export function calcCost(
  inputTokens: number,
  outputTokens: number,
  cachedTokens: number,
  pricing: ModelPricing | null,
): number | null {
  if (!pricing) return null;
  return (
    (inputTokens / 1000) * pricing.inputPer1k +
    (outputTokens / 1000) * pricing.outputPer1k +
    (cachedTokens / 1000) * (pricing.cachedPer1k ?? 0)
  );
}
