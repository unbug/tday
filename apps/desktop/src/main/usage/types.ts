/**
 * Token usage tracking types.
 *
 * Records are persisted to ~/.tday/usage.jsonl (newline-delimited JSON).
 * Each line is one UsageRecord.
 */

import type { AgentId } from '@tday/shared';

/** A single LLM request's token counts (mirrors OpenAI/Anthropic usage). */
export interface UsageRecord {
  /** Unix timestamp (ms) when the response completed. */
  ts: number;
  /** Which agent ran the request. */
  agentId: AgentId | string;
  /** Provider profile id. */
  providerId: string;
  /** Exact model string used. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Cached/read tokens from prompt cache (0 if provider doesn't report). */
  cachedTokens: number;
}

/**
 * Aggregated stats for a time window.
 * `costUsd` is `null` when no pricing is configured for that model.
 */
export interface UsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  costUsd: number | null;
  /** Breakdown by model. */
  byModel: Record<string, ModelUsage>;
  /** Breakdown by agent. */
  byAgent: Record<string, AgentUsage>;
  /** Daily bucketed data for the chart (ISO date string → counts). */
  daily: DailyStat[];
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number | null;
}

export interface AgentUsage {
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number | null;
}

export interface DailyStat {
  date: string; // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number | null;
}

/**
 * Per-model pricing table (USD per 1 000 tokens).
 * Populated from well-known public pricing at packaging time.
 * Users can override via ~/.tday/pricing.json.
 */
export interface ModelPricing {
  /** Price per 1k input tokens in USD. */
  inputPer1k: number;
  /** Price per 1k output tokens in USD. */
  outputPer1k: number;
  /** Price per 1k cached/read tokens (0 if not applicable). */
  cachedPer1k?: number;
}
