/**
 * Reads token usage directly from opencode's SQLite database.
 *
 * The database lives at:
 *   ~/.local/share/opencode/opencode.db
 *
 * The `message` table stores one JSON blob per `data` column. Assistant
 * messages carry:
 *   - `data.modelID`    — model identifier, e.g. "deepseek-v4-pro"
 *   - `data.providerID` — provider, e.g. "deepseek"
 *   - `data.tokens`     — { input, output, cache: { read, write } }
 *   - `data.time`       — { created: <unix ms> }
 *
 * Because Electron 33 embeds Node 20 (before the experimental `node:sqlite`
 * module was introduced in Node 22), we shell out to the system `sqlite3`
 * CLI. The function silently returns an empty array when sqlite3 is not
 * available (e.g. on Windows without extra tooling).
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { UsageRecord } from '../types.js';

/** Locate the sqlite3 CLI binary. Returns null if not found. */
function findSqlite3(): string | null {
  const candidates = [
    '/usr/bin/sqlite3',
    '/usr/local/bin/sqlite3',
    '/opt/homebrew/bin/sqlite3',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  // Try PATH lookup as a last resort
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(whichCmd, ['sqlite3'], {
      encoding: 'utf8',
      timeout: 2_000,
    }).split(/\r?\n/)[0].trim();
    return result || null;
  } catch {
    return null;
  }
}

interface OpenCodeTokens {
  input?: number;
  output?: number;
  cache?: { read?: number; write?: number };
}

interface OpenCodeMessage {
  role?: string;
  modelID?: string;
  providerID?: string;
  tokens?: OpenCodeTokens;
  time?: { created?: number };
}

export function scanOpencodeDB(fromTs?: number, toTs?: number): UsageRecord[] {
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return [];

  const sqlite3 = findSqlite3();
  if (!sqlite3) return [];

  let output: string;
  try {
    output = execFileSync(
      sqlite3,
      [
        dbPath,
        // Output raw values (no header, no column separators other than newlines)
        '-json',
        "SELECT data FROM message WHERE json_extract(data, '$.role') = 'assistant';",
      ],
      { encoding: 'utf8', timeout: 15_000 },
    );
  } catch {
    return [];
  }

  // sqlite3 -json returns a JSON array
  let rows: Array<{ data: string }>;
  try {
    rows = JSON.parse(output.trim()) as Array<{ data: string }>;
  } catch {
    return [];
  }

  const records: UsageRecord[] = [];
  for (const row of rows) {
    let msg: OpenCodeMessage;
    try {
      msg = JSON.parse(row.data) as OpenCodeMessage;
    } catch {
      continue;
    }

    const tokens = msg.tokens;
    if (!tokens) continue;

    const ts = msg.time?.created ?? Date.now();
    if (fromTs !== undefined && ts < fromTs) continue;
    if (toTs !== undefined && ts >= toTs) continue;

    const inputTokens = tokens.input ?? 0;
    const outputTokens = tokens.output ?? 0;
    const cachedTokens = tokens.cache?.read ?? 0;

    if (inputTokens === 0 && outputTokens === 0) continue;

    records.push({
      ts,
      agentId: 'opencode',
      providerId: msg.providerID ?? 'opencode',
      model: msg.modelID ?? 'unknown',
      inputTokens,
      outputTokens,
      cachedTokens,
    });
  }

  return records;
}
