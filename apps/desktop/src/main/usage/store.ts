/**
 * Usage store: append-only JSONL log at ~/.tday/usage.jsonl
 *
 * - `append(record)` — write one record (fire-and-forget friendly)
 * - `query(filter)`  — read + filter records, compute aggregated summary
 *
 * The file is kept small: one JSON line per request, ~100–200 bytes each.
 * 10 000 requests ≈ 1–2 MB.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageRecord, UsageSummary, ModelUsage, AgentUsage, DailyStat } from './types.js';
import { resolvePrice, calcCost, BUILTIN_PRICING } from './pricing.js';
import type { ModelPricing } from './types.js';

const TDAY_DIR = join(homedir(), '.tday');
const USAGE_FILE = join(TDAY_DIR, 'usage.jsonl');
const PRICING_FILE = join(TDAY_DIR, 'pricing.json');

function ensureDir(): void {
  if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
}

/** Load user-supplied pricing overrides (silent if file missing / invalid). */
function loadUserPricing(): Record<string, ModelPricing> {
  try {
    if (existsSync(PRICING_FILE)) {
      return JSON.parse(readFileSync(PRICING_FILE, 'utf8')) as Record<string, ModelPricing>;
    }
  } catch {
    // ignore
  }
  return {};
}

function mergedPricing(): Record<string, ModelPricing> {
  return { ...BUILTIN_PRICING, ...loadUserPricing() };
}

/** Append one usage record to the JSONL log. Non-throwing. */
export function appendUsage(record: UsageRecord): void {
  try {
    ensureDir();
    appendFileSync(USAGE_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    console.error('[tday] usage append failed:', err);
  }
}

export interface UsageFilter {
  /** Only include records at or after this timestamp (ms). */
  fromTs?: number;
  /** Only include records before this timestamp (ms). */
  toTs?: number;
  /** Filter by agent id. */
  agentId?: string;
  /** Filter by provider id. */
  providerId?: string;
}

/** Read all records and compute a UsageSummary for the given filter. */
export function queryUsage(filter: UsageFilter = {}): UsageSummary {
  const pricing = mergedPricing();
  const records = loadRecords(filter);

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCachedTokens = 0;
  let totalCostUsd: number | null = 0;
  const byModel: Record<string, ModelUsage> = {};
  const byAgent: Record<string, AgentUsage> = {};
  const dailyMap: Record<string, DailyStat> = {};

  for (const r of records) {
    const p = resolvePrice(r.model, pricing);
    const cost = calcCost(r.inputTokens, r.outputTokens, r.cachedTokens, p);

    totalInputTokens += r.inputTokens;
    totalOutputTokens += r.outputTokens;
    totalCachedTokens += r.cachedTokens;
    if (cost !== null && totalCostUsd !== null) {
      totalCostUsd += cost;
    } else if (cost === null) {
      totalCostUsd = null; // unknown pricing → mark whole total as unknown
    }

    // Per-model
    if (!byModel[r.model]) {
      byModel[r.model] = { model: r.model, inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 };
    }
    const mm = byModel[r.model]!;
    mm.inputTokens += r.inputTokens;
    mm.outputTokens += r.outputTokens;
    mm.requests += 1;
    if (cost !== null && mm.costUsd !== null) mm.costUsd += cost;
    else mm.costUsd = null;

    // Per-agent
    if (!byAgent[r.agentId]) {
      byAgent[r.agentId] = { agentId: r.agentId, inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 };
    }
    const am = byAgent[r.agentId]!;
    am.inputTokens += r.inputTokens;
    am.outputTokens += r.outputTokens;
    am.requests += 1;
    if (cost !== null && am.costUsd !== null) am.costUsd += cost;
    else am.costUsd = null;

    // Daily
    const date = new Date(r.ts).toISOString().slice(0, 10);
    if (!dailyMap[date]) dailyMap[date] = { date, inputTokens: 0, outputTokens: 0, requests: 0, costUsd: 0 };
    const dm = dailyMap[date]!;
    dm.inputTokens += r.inputTokens;
    dm.outputTokens += r.outputTokens;
    dm.requests += 1;
    if (cost !== null && dm.costUsd !== null) dm.costUsd += cost;
    else dm.costUsd = null;
  }

  const daily = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalRequests: records.length,
    totalInputTokens,
    totalOutputTokens,
    totalCachedTokens,
    costUsd: totalCostUsd,
    byModel,
    byAgent,
    daily,
  };
}

function loadRecords(filter: UsageFilter): UsageRecord[] {
  if (!existsSync(USAGE_FILE)) return [];
  const lines = readFileSync(USAGE_FILE, 'utf8').split('\n').filter(Boolean);
  const records: UsageRecord[] = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line) as UsageRecord;
      if (filter.fromTs !== undefined && r.ts < filter.fromTs) continue;
      if (filter.toTs !== undefined && r.ts >= filter.toTs) continue;
      if (filter.agentId && r.agentId !== filter.agentId) continue;
      if (filter.providerId && r.providerId !== filter.providerId) continue;
      records.push(r);
    } catch {
      // skip malformed lines
    }
  }
  return records;
}
