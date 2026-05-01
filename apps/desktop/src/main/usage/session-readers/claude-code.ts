/**
 * Reads token usage directly from claude-code's native session JSONL files.
 *
 * Session files are stored at:
 *   ~/.claude/projects/<encoded-path>/<session-uuid>.jsonl
 *
 * Each file is newline-delimited JSON. Records of `type: "assistant"` carry
 * a `message.usage` block with per-request token counts and `message.model`
 * with the model identifier. The same `message.id` can appear twice (an
 * optimistic record before streaming and a final record after), so we
 * deduplicate by `message.id`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageRecord } from '../types.js';

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ClaudeMessage {
  id?: string;
  type?: string;
  model?: string;
  usage?: ClaudeUsage;
  content?: Array<{ type?: string }>;
}

interface ClaudeRecord {
  type?: string;
  uuid?: string;
  timestamp?: string;
  sessionId?: string;
  message?: ClaudeMessage;
}

export function scanClaudeCodeSessions(fromTs?: number, toTs?: number): UsageRecord[] {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsDir);
  } catch {
    return [];
  }

  const records: UsageRecord[] = [];
  // Deduplicate by message.id — the same API response can appear twice in the JSONL
  const seenMsgIds = new Set<string>();

  for (const proj of projectDirs) {
    const projPath = join(projectsDir, proj);
    let files: string[];
    try {
      files = readdirSync(projPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(projPath, file);
      let content: string;
      try {
        content = readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }

      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let obj: ClaudeRecord;
        try {
          obj = JSON.parse(trimmed) as ClaudeRecord;
        } catch {
          continue;
        }

        if (obj.type !== 'assistant') continue;

        const msg = obj.message;
        if (!msg || typeof msg !== 'object') continue;

        const usage = msg.usage;
        if (!usage || typeof usage !== 'object') continue;

        // Deduplicate by message.id
        const msgId = msg.id;
        if (msgId) {
          if (seenMsgIds.has(msgId)) continue;
          seenMsgIds.add(msgId);
        }

        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();
        if (fromTs !== undefined && ts < fromTs) continue;
        if (toTs !== undefined && ts >= toTs) continue;

        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const cachedTokens = usage.cache_read_input_tokens ?? 0;

        // Skip empty / synthetic records
        if (inputTokens === 0 && outputTokens === 0) continue;

        const content = msg.content;
        const toolCalls = Array.isArray(content)
          ? content.filter((b) => b?.type === 'tool_use').length
          : 0;

        records.push({
          ts,
          agentId: 'claude-code',
          providerId: 'claude-code',
          model: msg.model ?? '',
          inputTokens,
          outputTokens,
          cachedTokens,
          toolCalls: toolCalls > 0 ? toolCalls : undefined,
        });
      }
    }
  }

  return records;
}
