/**
 * Per-agent session scanners for the Agent History Session Manager.
 *
 * Each scanner reads the agent's native session files and extracts
 * AgentHistoryEntry metadata (title, cwd, timestamps, message count).
 *
 * Supported agents and storage:
 *   claude-code  ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 *   codex        ~/.codex/sessions/YYYY/MM/DD/*.jsonl
 *   opencode     ~/.local/share/opencode/opencode.db  (SQLite)
 *   gemini       ~/.gemini/tmp/<proj>/chats/session-*.jsonl
 *   pi           ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl
 *
 * ACP protocol note: When a running agent exposes an ACP-compatible HTTP
 * endpoint for session management, we can supplement file-based discovery
 * with live API queries. The architecture here is designed to be extended
 * with ACP-based scanners (e.g. acpScanRunningAgents()) without changing
 * the core merge logic in index.ts.
 *
 * Performance: Each scanner reads the first MAX_TITLE_SCAN_LINES lines of a
 * session file to extract the title — stopping early to avoid loading large
 * session histories into memory.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AgentHistoryEntry } from '@tday/shared';

/** Maximum lines scanned per file to extract the title. */
const MAX_TITLE_SCAN_LINES = 150;

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncateTitle(s: string, max = 80): string {
  if (!s) return '(new conversation)';
  const trimmed = s.trim().replace(/\s+/g, ' ');
  return trimmed.length > max ? trimmed.slice(0, max) + '…' : trimmed;
}

function safeStatMtime(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/** Recursively collect .jsonl file paths up to maxDepth levels. */
export function collectJsonlPaths(dir: string, maxDepth: number): string[] {
  const out: string[] = [];
  function walk(d: string, depth: number): void {
    if (depth <= 0 || !existsSync(d)) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(d, e);
      try {
        const s = statSync(full);
        if (s.isDirectory()) {
          walk(full, depth - 1);
        } else if (e.endsWith('.jsonl')) {
          out.push(full);
        }
      } catch {
        continue;
      }
    }
  }
  walk(dir, maxDepth);
  return out;
}

// ── claude-code ───────────────────────────────────────────────────────────────
// Sessions: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
// Encoding: replace '/' → '-', strip leading '-'
// Decoding is best-effort (lossy for paths containing '-').

function decodeClaudeCwd(encoded: string): string {
  return '/' + encoded.replace(/-/g, '/');
}

export function scanClaudeHistory(): AgentHistoryEntry[] {
  const projectsDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(projectsDir)) return [];

  let projDirs: string[];
  try {
    projDirs = readdirSync(projectsDir);
  } catch {
    return [];
  }

  const entries: AgentHistoryEntry[] = [];

  for (const proj of projDirs) {
    const projPath = join(projectsDir, proj);
    let files: string[];
    try {
      if (!statSync(projPath).isDirectory()) continue;
      files = readdirSync(projPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    const cwd = decodeClaudeCwd(proj);

    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, '');
      const filePath = join(projPath, file);
      const mtime = safeStatMtime(filePath);
      if (!mtime) continue;

      let title = '(new conversation)';
      let startedAt = mtime;
      let messageCount = 0;

      try {
        const content = readFileSync(filePath, 'utf8');
        let lineIdx = 0;
        for (const line of content.split('\n')) {
          if (lineIdx++ > MAX_TITLE_SCAN_LINES) break;
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as {
              type?: string;
              timestamp?: string;
              message?: {
                role?: string;
                content?: string | Array<{ type?: string; text?: string }>;
              };
            };
            // First record timestamp is the session start
            if (lineIdx === 1 && obj.timestamp) {
              startedAt = new Date(obj.timestamp).getTime() || mtime;
            }
            if (obj.type === 'user' || obj.type === 'assistant') {
              messageCount++;
              if (obj.type === 'user' && title === '(new conversation)') {
                const c = obj.message?.content;
                if (typeof c === 'string' && c.trim()) {
                  title = truncateTitle(c);
                } else if (Array.isArray(c)) {
                  const text = c
                    .filter((b) => b.type === 'text')
                    .map((b) => b.text ?? '')
                    .join('')
                    .trim();
                  if (text) title = truncateTitle(text);
                }
              }
            }
          } catch {
            continue;
          }
        }
      } catch {
        // Use defaults
      }

      entries.push({
        id: `claude-code:${sessionId}`,
        agentId: 'claude-code',
        sessionId,
        title,
        cwd,
        startedAt,
        updatedAt: mtime,
        messageCount,
        source: 'native',
      });
    }
  }

  return entries;
}

// ── codex ─────────────────────────────────────────────────────────────────────
// Sessions: ~/.codex/sessions/YYYY/MM/DD/<name>.jsonl
// session_meta line: {type, timestamp, payload:{id, cwd, timestamp}}
// user turns: {type:"event_msg", payload:{type:"user_message", message:string}}

export function scanCodexHistory(): AgentHistoryEntry[] {
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  const files = collectJsonlPaths(sessionsDir, 5);
  const entries: AgentHistoryEntry[] = [];

  for (const filePath of files) {
    const mtime = safeStatMtime(filePath);
    if (!mtime) continue;

    let sessionId: string | undefined;
    let cwd = '';
    let title = '(new conversation)';
    let startedAt = mtime;
    let messageCount = 0;

    try {
      const content = readFileSync(filePath, 'utf8');
      let lineIdx = 0;
      for (const line of content.split('\n')) {
        if (lineIdx++ > MAX_TITLE_SCAN_LINES) break;
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as {
            type?: string;
            timestamp?: string;
            payload?: {
              id?: string;
              cwd?: string;
              timestamp?: string;
              type?: string;
              message?: string;
              role?: string;
            };
          };
          if (obj.type === 'session_meta' && obj.payload) {
            sessionId = obj.payload.id;
            cwd = obj.payload.cwd ?? '';
            const ts = obj.timestamp ?? obj.payload.timestamp;
            if (ts) startedAt = new Date(ts).getTime() || mtime;
          }
          if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
            messageCount++;
            if (title === '(new conversation)' && obj.payload.message) {
              title = truncateTitle(obj.payload.message);
            }
          }
          if (obj.type === 'response_item') {
            messageCount++;
          }
        } catch {
          continue;
        }
      }
    } catch {
      // Use defaults
    }

    if (!sessionId) continue;

    entries.push({
      id: `codex:${sessionId}`,
      agentId: 'codex',
      sessionId,
      title,
      cwd,
      startedAt,
      updatedAt: mtime,
      messageCount,
      source: 'native',
    });
  }

  return entries;
}

// ── opencode ──────────────────────────────────────────────────────────────────
// Sessions: ~/.local/share/opencode/opencode.db  (SQLite)
// session table: id, title, directory, time_created, time_updated

function findSqlite3(): string | null {
  const candidates = [
    '/usr/bin/sqlite3',
    '/usr/local/bin/sqlite3',
    '/opt/homebrew/bin/sqlite3',
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(whichCmd, ['sqlite3'], {
      encoding: 'utf8',
      timeout: 2_000,
    })
      .split(/\r?\n/)[0]
      .trim();
    return result || null;
  } catch {
    return null;
  }
}

interface OpenCodeSessionRow {
  id: string;
  title?: string;
  directory?: string;
  time_created?: number;
  time_updated?: number;
}

export function scanOpencodeHistory(): AgentHistoryEntry[] {
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return [];

  const sqlite3 = findSqlite3();
  if (!sqlite3) return [];

  let rows: OpenCodeSessionRow[] = [];
  try {
    const output = execFileSync(
      sqlite3,
      [
        dbPath,
        '-json',
        'SELECT id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC;',
      ],
      { encoding: 'utf8', timeout: 10_000 },
    );
    rows = JSON.parse(output.trim()) as OpenCodeSessionRow[];
  } catch {
    return [];
  }

  return rows.map(
    (row): AgentHistoryEntry => ({
      id: `opencode:${row.id}`,
      agentId: 'opencode',
      sessionId: row.id,
      title: truncateTitle(row.title ?? '(new conversation)'),
      cwd: row.directory ?? '',
      startedAt: row.time_created ?? 0,
      updatedAt: row.time_updated ?? 0,
      messageCount: 0,
      source: 'native',
    }),
  );
}

// ── gemini ────────────────────────────────────────────────────────────────────
// Sessions: ~/.gemini/tmp/<proj>/chats/session-<ts>-<id>.jsonl
// First line: {sessionId, cwd?, projectRoot?, startTime?}
// User turns: {type:"user"} — content/parts

export function scanGeminiHistory(): AgentHistoryEntry[] {
  const tmpDir = join(homedir(), '.gemini', 'tmp');
  if (!existsSync(tmpDir)) return [];

  let projDirs: string[];
  try {
    projDirs = readdirSync(tmpDir);
  } catch {
    return [];
  }

  const entries: AgentHistoryEntry[] = [];

  for (const proj of projDirs) {
    const chatsDir = join(tmpDir, proj, 'chats');
    if (!existsSync(chatsDir)) continue;

    let files: string[];
    try {
      files = readdirSync(chatsDir).filter(
        (f) =>
          f.startsWith('session-') && (f.endsWith('.jsonl') || f.endsWith('.json')),
      );
    } catch {
      continue;
    }

    for (const file of files) {
      const filePath = join(chatsDir, file);
      const mtime = safeStatMtime(filePath);
      if (!mtime) continue;

      let sessionId: string | undefined;
      let cwd = '';
      let title = '(new conversation)';
      let startedAt = mtime;
      let messageCount = 0;

      try {
        const content = readFileSync(filePath, 'utf8');
        let lineIdx = 0;
        for (const line of content.split('\n')) {
          if (lineIdx++ > MAX_TITLE_SCAN_LINES) break;
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as {
              sessionId?: string;
              cwd?: string;
              projectRoot?: string;
              startTime?: string | number;
              type?: string;
              content?: string;
              parts?: Array<{ text?: string }>;
            };
            // First line is session metadata
            if (lineIdx === 1) {
              sessionId = obj.sessionId;
              cwd = obj.cwd ?? obj.projectRoot ?? '';
              if (obj.startTime) {
                startedAt =
                  typeof obj.startTime === 'number'
                    ? obj.startTime
                    : new Date(obj.startTime).getTime() || mtime;
              }
              continue;
            }
            if (obj.type === 'user' || obj.type === 'human') {
              messageCount++;
              if (title === '(new conversation)') {
                const text =
                  obj.content ??
                  (obj.parts?.map((p) => p.text ?? '').join('') ?? '');
                if (text.trim()) title = truncateTitle(text);
              }
            } else if (
              obj.type === 'gemini' ||
              obj.type === 'assistant' ||
              obj.type === 'model'
            ) {
              messageCount++;
            }
          } catch {
            continue;
          }
        }
      } catch {
        // Use defaults
      }

      if (!sessionId) continue;

      entries.push({
        id: `gemini:${sessionId}`,
        agentId: 'gemini',
        sessionId,
        title,
        cwd,
        startedAt,
        updatedAt: mtime,
        messageCount,
        source: 'native',
      });
    }
  }

  return entries;
}

// ── pi ────────────────────────────────────────────────────────────────────────
// Sessions: ~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl
// Encoding: replace '/' → '--' (double-dash).
// First line: {type:"session",id:"<uuid>",timestamp:"...",cwd:"..."}
// Records: {type:"message", message:{role:"user"|"assistant", content:...}}

export function scanPiHistory(): AgentHistoryEntry[] {
  const sessionsDir = join(homedir(), '.pi', 'agent', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  let cwdDirs: string[];
  try {
    cwdDirs = readdirSync(sessionsDir);
  } catch {
    return [];
  }

  const entries: AgentHistoryEntry[] = [];

  for (const cwdDir of cwdDirs) {
    const cwdPath = join(sessionsDir, cwdDir);
    let files: string[];
    try {
      if (!statSync(cwdPath).isDirectory()) continue;
      files = readdirSync(cwdPath).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }

    for (const file of files) {
      const sessionId = file.replace(/\.jsonl$/, '');
      const filePath = join(cwdPath, file);
      const mtime = safeStatMtime(filePath);
      if (!mtime) continue;

      let title = '(new conversation)';
      let startedAt = mtime;
      let messageCount = 0;
      let cwd = '';

      try {
        const content = readFileSync(filePath, 'utf8');
        let lineIdx = 0;
        for (const line of content.split('\n')) {
          if (lineIdx++ > MAX_TITLE_SCAN_LINES) break;
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj = JSON.parse(trimmed) as {
              type?: string;
              id?: string;
              timestamp?: string;
              cwd?: string;
              message?: {
                role?: string;
                content?: string | Array<{ type?: string; text?: string }>;
              };
            };
            // First line: {type:"session", cwd, timestamp}
            if (obj.type === 'session') {
              cwd = obj.cwd ?? '';
              if (obj.timestamp) startedAt = new Date(obj.timestamp).getTime() || mtime;
              continue;
            }
            if (obj.type === 'message') {
              const role = obj.message?.role;
              if (role === 'user' || role === 'assistant') {
                messageCount++;
                if (role === 'user' && title === '(new conversation)') {
                  const c = obj.message?.content;
                  if (typeof c === 'string' && c.trim()) {
                    title = truncateTitle(c);
                  } else if (Array.isArray(c)) {
                    const text = c
                      .filter((b) => b.type === 'text')
                      .map((b) => b.text ?? '')
                      .join('')
                      .trim();
                    if (text) title = truncateTitle(text);
                  }
                }
              }
            }
          } catch {
            continue;
          }
        }
      } catch {
        // Use defaults
      }

      entries.push({
        id: `pi:${sessionId}`,
        agentId: 'pi',
        sessionId,
        title,
        cwd,
        startedAt,
        updatedAt: mtime,
        messageCount,
        source: 'native',
      });
    }
  }

  return entries;
}
