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
  /** Number of tool/function calls in this response (0 if not reported). */
  toolCalls?: number;
  /** Working directory of the session that generated this request. */
  cwd?: string;
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
  /** cachedTokens / (inputTokens + cachedTokens), 0 when no input. */
  cacheHitRate: number;
  /** Total tool/function call invocations across all records. */
  totalToolCalls: number;
  /** Successful requests per active day in the queried window. */
  throughputReqPerDay: number;
  /** (input + output) tokens per minute across the actual record span. */
  throughputTokensPerMin: number;
  /** Breakdown by model. */
  byModel: Record<string, ModelUsage>;
  /** Breakdown by agent. */
  byAgent: Record<string, AgentUsage>;
  /** Breakdown by project (cwd basename). Only populated when records include cwd. */
  byProject: Record<string, ProjectUsage>;
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

export interface ProjectUsage {
  project: string;
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
  cachedTokens: number;
  requests: number;
  costUsd: number | null;
  toolCalls: number;
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
