/**
 * Reads token usage directly from gemini-cli's native session JSONL files.
 *
 * Session files are stored at:
 *   ~/.gemini/tmp/<project-id>/chats/session-<timestamp>-<shortId>.jsonl
 *
 * Each file is newline-delimited JSON. The first line is a metadata record
 * `{sessionId, projectHash, startTime, ...}`. Subsequent records are message
 * records of `type: "user"` or `type: "gemini"`. The `"gemini"` records carry
 * `tokens: {input, output, cached, thoughts, tool, total}` and `model`.
 *
 * We glob all project dirs under ~/.gemini/tmp/ and scan their chats/ dirs.
 * Deduplicate by record `id`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageRecord } from '../types.js';

interface GeminiTokens {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
}

interface GeminiRecord {
  id?: string;
  timestamp?: string;
  type?: string;
  model?: string;
  tokens?: GeminiTokens;
}

export function scanGeminiSessions(fromTs?: number, toTs?: number): UsageRecord[] {
  const tmpDir = join(homedir(), '.gemini', 'tmp');
  if (!existsSync(tmpDir)) return [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(tmpDir);
  } catch {
    return [];
  }

  const records: UsageRecord[] = [];
  const seenIds = new Set<string>();

  for (const proj of projectDirs) {
    const chatsDir = join(tmpDir, proj, 'chats');
    if (!existsSync(chatsDir)) continue;

    let files: string[];
    try {
      files = readdirSync(chatsDir).filter(
        (f) => f.startsWith('session-') && (f.endsWith('.jsonl') || f.endsWith('.json')),
      );
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(chatsDir, file);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: GeminiRecord;
        try {
          obj = JSON.parse(trimmed) as GeminiRecord;
        } catch {
          continue;
        }

        // Only process assistant (gemini) messages
        if (obj.type !== 'gemini') continue;

        const tokens = obj.tokens;
        if (!tokens || typeof tokens !== 'object') continue;

        // Deduplicate by message id
        const recId = obj.id;
        if (recId) {
          if (seenIds.has(recId)) continue;
          seenIds.add(recId);
        }

        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();
        if (fromTs !== undefined && ts < fromTs) continue;
        if (toTs !== undefined && ts >= toTs) continue;

        const inputTokens = tokens.input ?? 0;
        const outputTokens = tokens.output ?? 0;
        const cachedTokens = tokens.cached ?? 0;

        if (inputTokens === 0 && outputTokens === 0) continue;

        records.push({
          ts,
          agentId: 'gemini',
          providerId: 'google',
          model: obj.model ?? '',
          inputTokens,
          outputTokens,
          cachedTokens,
        });
      }
    }
  }

  return records;
}
