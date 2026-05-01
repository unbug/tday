/**
 * Reads token usage directly from codex's native session JSONL files.
 *
 * Session files are stored at:
 *   ~/.codex/sessions/YYYY/MM/DD/<session-name>.jsonl
 *
 * Each file is newline-delimited JSON. Relevant record types:
 *
 *   - `session_meta` — carries the session start timestamp and `model_provider`
 *   - `turn_context` — carries `payload.model` (the actual model id used, e.g.
 *     "qwen/qwen3.6-35b-a3b"); the LAST one wins for the session model
 *   - `event_msg` with `payload.type == "token_count"` — carries
 *     `payload.info.total_token_usage` which is **cumulative** for the entire
 *     session. We take the LAST such event as the definitive total.
 *
 * One UsageRecord is emitted per session file.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageRecord } from '../types.js';

/** Recursively collect .jsonl files up to `maxDepth` levels deep. */
function collectJsonlFiles(dir: string, maxDepth: number, out: string[]): void {
  if (maxDepth <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    try {
      const stat = statSync(full);
      if (stat.isDirectory()) {
        collectJsonlFiles(full, maxDepth - 1, out);
      } else if (entry.endsWith('.jsonl')) {
        out.push(full);
      }
    } catch {
      continue;
    }
  }
}

interface TokenCount {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

export function scanCodexSessions(fromTs?: number, toTs?: number): UsageRecord[] {
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  const files: string[] = [];
  collectJsonlFiles(sessionsDir, 5, files);

  const records: UsageRecord[] = [];

  for (const filePath of files) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    let sessionTs: number | undefined;
    let model: string | undefined;
    let modelProvider: string | undefined;
    let lastTokenCount: TokenCount | null = null;

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = obj['type'] as string | undefined;
      const timestamp = obj['timestamp'] as string | undefined;

      if (type === 'session_meta') {
        const payload = obj['payload'] as Record<string, unknown> | undefined;
        const ts = timestamp ?? (payload?.['timestamp'] as string | undefined);
        if (ts) sessionTs = new Date(ts).getTime();
        if (payload) modelProvider = payload['model_provider'] as string | undefined;
      }

      if (type === 'turn_context') {
        const payload = obj['payload'] as Record<string, unknown> | undefined;
        if (payload) {
          const m = payload['model'] as string | undefined;
          if (m) model = m;
          if (!sessionTs && timestamp) sessionTs = new Date(timestamp).getTime();
        }
      }

      if (type === 'event_msg') {
        const payload = obj['payload'] as Record<string, unknown> | undefined;
        if (payload?.['type'] === 'token_count') {
          const info = payload['info'] as Record<string, unknown> | undefined;
          const tu = info?.['total_token_usage'] as TokenCount | undefined;
          if (tu) lastTokenCount = tu;
        }
      }
    }

    if (!lastTokenCount) continue;

    const ts = sessionTs ?? Date.now();
    if (fromTs !== undefined && ts < fromTs) continue;
    if (toTs !== undefined && ts >= toTs) continue;

    const inputTokens = lastTokenCount.input_tokens ?? 0;
    const cachedTokens = lastTokenCount.cached_input_tokens ?? 0;
    const outputTokens = lastTokenCount.output_tokens ?? 0;

    if (inputTokens === 0 && outputTokens === 0) continue;

    records.push({
      ts,
      agentId: 'codex',
      providerId: modelProvider ?? 'codex',
      model: model ?? 'unknown',
      inputTokens,
      outputTokens,
      cachedTokens,
    });
  }

  return records;
}
