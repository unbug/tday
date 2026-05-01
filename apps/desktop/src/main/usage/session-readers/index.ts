/**
 * Session reader coordinator.
 *
 * Aggregates token-usage data from the native session files written by each
 * supported agent CLI. Unlike proxy / OTel / PTY-scraping approaches, this
 * reads structured data that the agents already persist to disk — no
 * interception required.
 *
 * Supported agents and their storage:
 *   claude-code  ~/.claude/projects/**\/*.jsonl          (JSONL per session)
 *   codex        ~/.codex/sessions/YYYY/MM/DD/*.jsonl    (JSONL per session)
 *   opencode     ~/.local/share/opencode/opencode.db     (SQLite)
 *
 * Can be called at any time — whether or not the agent is currently running,
 * and whether or not Tday is open.
 */

import { scanClaudeCodeSessions } from './claude-code.js';
import { scanCodexSessions } from './codex.js';
import { scanOpencodeDB } from './opencode.js';
import { scanPiSessions } from './pi.js';
import { scanGeminiSessions } from './gemini.js';
import type { UsageRecord } from '../types.js';
import type { UsageFilter } from '../store.js';

/** Agent ids whose usage comes from session files (not usage.jsonl). */
export const SESSION_FILE_AGENTS = new Set(['claude-code', 'codex', 'opencode', 'pi', 'gemini']);

/**
 * Scan all supported agents' session files and return the combined list of
 * usage records, filtered by the given criteria.
 *
 * Records for agents not listed in SESSION_FILE_AGENTS (e.g. `pi`) are NOT
 * included here — they continue to be tracked via the existing usage.jsonl
 * append mechanism.
 */
export function scanAllSessions(filter: UsageFilter = {}): UsageRecord[] {
  const { fromTs, toTs, agentId } = filter;
  const results: UsageRecord[] = [];

  if (!agentId || agentId === 'claude-code') {
    results.push(...scanClaudeCodeSessions(fromTs, toTs));
  }
  if (!agentId || agentId === 'codex') {
    results.push(...scanCodexSessions(fromTs, toTs));
  }
  if (!agentId || agentId === 'opencode') {
    results.push(...scanOpencodeDB(fromTs, toTs));
  }
  if (!agentId || agentId === 'pi') {
    results.push(...scanPiSessions(fromTs, toTs));
  }
  if (!agentId || agentId === 'gemini') {
    results.push(...scanGeminiSessions(fromTs, toTs));
  }

  // Apply providerId filter if requested
  if (filter.providerId) {
    return results.filter((r) => r.providerId === filter.providerId);
  }

  return results;
}
