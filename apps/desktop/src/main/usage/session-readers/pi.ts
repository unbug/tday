/**
 * Reads token usage directly from pi's native session JSONL files.
 *
 * Session files are stored at:
 *   ~/.pi/agent/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl
 *
 * Each file is newline-delimited JSON. Records of `type: "message"` with
 * `message.role === "assistant"` carry a `message.usage` block with per-request
 * token counts, `message.model` and `message.provider`. Deduplicate by record `id`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageRecord } from '../types.js';

interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: { total?: number };
}

interface PiMessage {
  role?: string;
  api?: string;
  provider?: string;
  model?: string;
  usage?: PiUsage;
}

interface PiRecord {
  type?: string;
  id?: string;
  timestamp?: string;
  message?: PiMessage;
}

export function scanPiSessions(fromTs?: number, toTs?: number): UsageRecord[] {
  const sessionsDir = join(homedir(), '.pi', 'agent', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const records: UsageRecord[] = [];
  const seenIds = new Set<string>();

  for (const cwd of cwdDirs) {
    const cwdPath = join(sessionsDir, cwd);
    let files: string[];
    try {
      files = readdirSync(cwdPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(cwdPath, file);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: PiRecord;
        try {
          obj = JSON.parse(trimmed) as PiRecord;
        } catch {
          continue;
        }

        if (obj.type !== 'message') continue;

        const msg = obj.message;
        if (!msg || msg.role !== 'assistant') continue;

        const usage = msg.usage;
        if (!usage || typeof usage !== 'object') continue;

        // Deduplicate by record id
        const recId = obj.id;
        if (recId) {
          if (seenIds.has(recId)) continue;
          seenIds.add(recId);
        }

        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();
        if (fromTs !== undefined && ts < fromTs) continue;
        if (toTs !== undefined && ts >= toTs) continue;

        const inputTokens = usage.input ?? 0;
        const outputTokens = usage.output ?? 0;
        const cachedTokens = usage.cacheRead ?? 0;

        if (inputTokens === 0 && outputTokens === 0) continue;

        records.push({
          ts,
          agentId: 'pi',
          providerId: msg.provider ?? 'pi',
          model: msg.model ?? '',
          inputTokens,
          outputTokens,
          cachedTokens,
        });
      }
    }
  }

  return records;
}
