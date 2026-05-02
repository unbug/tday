/**
 * Persistent tab history — stores metadata about closed tabs so the user can
 * restore any of them later (Chrome-style "Recently Closed" + VS Code-style
 * conversation resume).
 *
 * Stored at ~/.tday/tab-history.json. No size limit — entries are only removed
 * when the user explicitly deletes them. Agent conversation history is NOT
 * duplicated here; we only store the session ID so we can pass it to the
 * agent's own `--resume` / `--session` flag when the tab is restored.
 *
 * Session discovery per agent:
 *   claude-code  ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl   → stem UUID
 *   codex        ~/.codex/sessions/YYYY/MM/DD/*.jsonl            → payload.id
 *   opencode     ~/.local/share/opencode/opencode.db              → session.id
 *   gemini       ~/.gemini/tmp/<proj>/chats/session-*.jsonl       → sessionId field
 *   others       no session discovery
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import type { AgentId } from '@tday/shared';

const TDAY_DIR = join(homedir(), '.tday');
const HISTORY_FILE = join(TDAY_DIR, 'tab-history.json');

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single turn in a restored agent conversation. */
export interface SessionMessage {
  role: 'user' | 'assistant';
  /** Plain text content (tool calls, reasoning, system messages stripped). */
  text: string;
}

export interface TabHistoryEntry {
  /** Unique ID for this history record (for deletion). */
  histId: string;
  title: string;
  agentId: AgentId;
  cwd: string;
  closedAt: number;
  /** Agent-native session ID — passed as --resume / --session on restore. */
  agentSessionId?: string;
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

export function loadHistory(): TabHistoryEntry[] {
  try {
    if (!existsSync(HISTORY_FILE)) return [];
    const raw = readFileSync(HISTORY_FILE, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is TabHistoryEntry =>
        !!e &&
        typeof e === 'object' &&
        typeof (e as TabHistoryEntry).histId === 'string',
    );
  } catch {
    return [];
  }
}

function saveHistory(entries: TabHistoryEntry[]): void {
  try {
    if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
    writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2), 'utf8');
  } catch {
    // Ignore write failures (disk full, read-only, etc.)
  }
}

/** Prepend a new entry, deduplicating by histId. */
export function pushHistoryEntry(entry: TabHistoryEntry): void {
  const existing = loadHistory().filter((e) => e.histId !== entry.histId);
  saveHistory([entry, ...existing]);
}

/** Remove a single history entry by histId. */
export function deleteHistoryEntry(histId: string): void {
  const existing = loadHistory().filter((e) => e.histId !== histId);
  saveHistory(existing);
}

// ─── Per-agent session discovery ──────────────────────────────────────────────

/**
 * Find the most-recently-modified native session for the given agent + cwd.
 * Returns the session identifier string (to be passed as --resume / --session),
 * or null if not found / not supported.
 */
export function latestAgentSession(agentId: AgentId, cwd: string): string | null {
  try {
    switch (agentId) {
      case 'claude-code':
        return latestClaudeSession(cwd);
      case 'codex':
        return latestCodexSession(cwd);
      case 'opencode':
        return latestOpencodeSession(cwd);
      case 'gemini':
        return latestGeminiSession(cwd);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/**
 * Read the conversation messages for a known session.
 * Returns user + assistant turns in order, with tool calls / system messages
 * stripped. Returns [] when unsupported or the session file can't be found.
 */
export function readAgentSession(
  agentId: AgentId,
  sessionId: string,
  cwd: string,
): SessionMessage[] {
  try {
    switch (agentId) {
      case 'claude-code':
        return readClaudeSession(sessionId, cwd);
      case 'codex':
        return readCodexSession(sessionId, cwd);
      case 'opencode':
        return readOpencodeSession(sessionId, cwd);
      default:
        return [];
    }
  } catch {
    return [];
  }
}

// ─── Per-agent conversation readers ───────────────────────────────────────────
// Sessions: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
// Encoding: replace all "/" with "-" and strip leading "-"

function latestClaudeSession(cwd: string): string | null {
  const encoded = cwd.replace(/\//g, '-').replace(/^-/, '');
  const projectsDir = join(homedir(), '.claude', 'projects', encoded);
  return latestJsonlStem(projectsDir);
}

// ── codex ─────────────────────────────────────────────────────────────────────
// Sessions: ~/.codex/sessions/YYYY/MM/DD/<name>.jsonl
// Session ID: payload.id field in the session_meta record
// We scan all session files, filter by cwd match, sort by mtime.

function latestCodexSession(cwd: string): string | null {
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsDir)) return null;

  const files: { path: string; mtime: number }[] = [];
  collectJsonlFiles(sessionsDir, 5, files);
  files.sort((a, b) => b.mtime - a.mtime);

  for (const { path: filePath } of files) {
    try {
      const content = readFileSync(filePath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const obj = JSON.parse(trimmed) as { type?: string; payload?: { id?: string; cwd?: string } };
        if (obj.type === 'session_meta' && obj.payload) {
          if (obj.payload.cwd === cwd && obj.payload.id) {
            return obj.payload.id;
          }
          break; // session_meta is always first line; stop scanning this file
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

function collectJsonlFiles(
  dir: string,
  maxDepth: number,
  out: { path: string; mtime: number }[],
): void {
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
      const s = statSync(full);
      if (s.isDirectory()) {
        collectJsonlFiles(full, maxDepth - 1, out);
      } else if (entry.endsWith('.jsonl')) {
        out.push({ path: full, mtime: s.mtimeMs });
      }
    } catch {
      continue;
    }
  }
}

// ── opencode ──────────────────────────────────────────────────────────────────
// Sessions: ~/.local/share/opencode/opencode.db  (SQLite)
// session table: id TEXT, directory TEXT, time_updated INTEGER

function latestOpencodeSession(cwd: string): string | null {
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return null;

  const sqlite3 = findSqlite3();
  if (!sqlite3) return null;

  try {
    const result = execFileSync(
      sqlite3,
      [
        dbPath,
        `SELECT id FROM session WHERE directory='${cwd.replace(/'/g, "''")}' ORDER BY time_updated DESC LIMIT 1;`,
      ],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim();
    return result || null;
  } catch {
    return null;
  }
}

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
    const result = execFileSync('which', ['sqlite3'], {
      encoding: 'utf8',
      timeout: 2_000,
    }).split(/\r?\n/)[0].trim();
    return result || null;
  } catch {
    return null;
  }
}

// ── gemini ────────────────────────────────────────────────────────────────────
// Sessions: ~/.gemini/tmp/<project-id>/chats/session-<ts>-<id>.jsonl
// First line contains: { sessionId, projectHash, startTime }
// gemini CLI resume flag: `gemini --resume <sessionId>` (if supported)
// NOTE: gemini-cli doesn't have a documented --resume flag yet;
// we discover the session ID but only use it if the flag exists.

function latestGeminiSession(cwd: string): string | null {
  const tmpDir = join(homedir(), '.gemini', 'tmp');
  if (!existsSync(tmpDir)) return null;

  // Encode cwd as a project hash. Gemini uses a hash of the absolute path.
  // We can find the matching project dir by reading the first line of session files.
  const files: { path: string; mtime: number }[] = [];
  let projDirs: string[];
  try {
    projDirs = readdirSync(tmpDir);
  } catch {
    return null;
  }

  for (const proj of projDirs) {
    const chatsDir = join(tmpDir, proj, 'chats');
    if (!existsSync(chatsDir)) continue;
    collectJsonlFiles(chatsDir, 2, files);
  }
  files.sort((a, b) => b.mtime - a.mtime);

  for (const { path: filePath } of files) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const firstLine = content.split('\n')[0]?.trim();
      if (!firstLine) continue;
      const obj = JSON.parse(firstLine) as { sessionId?: string; cwd?: string; projectRoot?: string };
      // Some versions store cwd, others store projectRoot
      const fileCwd = obj.cwd ?? obj.projectRoot;
      if (fileCwd === cwd && obj.sessionId) {
        return obj.sessionId;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ─── Conversation readers ──────────────────────────────────────────────────────

/**
 * claude-code: ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
 *
 * Each line is JSON. Relevant types:
 *   { type: "user",      message: { role: "user",      content: string | ContentBlock[] } }
 *   { type: "assistant", message: { role: "assistant", content: ContentBlock[] } }
 *
 * ContentBlock: { type: "text"|"thinking"|"tool_use"|..., text?: string }
 */
function readClaudeSession(sessionId: string, cwd: string): SessionMessage[] {
  const encoded = cwd.replace(/\//g, '-').replace(/^-/, '');
  const filePath = join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`);
  if (!existsSync(filePath)) return [];

  const messages: SessionMessage[] = [];
  type ContentBlock = { type?: string; text?: string };
  type Entry = {
    type?: string;
    message?: { role?: string; content?: string | ContentBlock[] };
  };

  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Entry;
      if (obj.type !== 'user' && obj.type !== 'assistant') continue;
      const msg = obj.message;
      if (!msg) continue;
      const role = msg.role as 'user' | 'assistant';
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content;
      } else if (Array.isArray(msg.content)) {
        text = msg.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text ?? '')
          .join('')
          .trim();
      }
      if (text) messages.push({ role, text });
    } catch {
      continue;
    }
  }
  return messages;
}

/**
 * codex: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * User messages: { type: "event_msg", payload: { type: "user_message", message: string } }
 * Assistant text: { type: "response_item", payload: { role: "assistant", content: [{type: "output_text", text: string}] } }
 */
function readCodexSession(sessionId: string, _cwd: string): SessionMessage[] {
  const sessionsDir = join(homedir(), '.codex', 'sessions');
  if (!existsSync(sessionsDir)) return [];

  // Find the file containing this session ID.
  const files: { path: string; mtime: number }[] = [];
  collectJsonlFiles(sessionsDir, 5, files);
  files.sort((a, b) => b.mtime - a.mtime);

  for (const { path: filePath } of files) {
    try {
      const lines = readFileSync(filePath, 'utf8').split('\n');
      // Check first line is session_meta with matching id.
      const firstLine = lines[0]?.trim();
      if (!firstLine) continue;
      const meta = JSON.parse(firstLine) as { type?: string; payload?: { id?: string } };
      if (meta.type !== 'session_meta' || meta.payload?.id !== sessionId) continue;

      // This is the right file — extract messages.
      const messages: SessionMessage[] = [];
      type CodexRecord = {
        type?: string;
        payload?: {
          type?: string;
          role?: string;
          message?: string;
          content?: Array<{ type?: string; text?: string }>;
        };
      };
      for (const line of lines.slice(1)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as CodexRecord;
          const p = obj.payload;
          if (!p) continue;
          // User message via event_msg
          if (obj.type === 'event_msg' && p.type === 'user_message' && p.message) {
            messages.push({ role: 'user', text: p.message });
          }
          // Assistant response text
          if (
            obj.type === 'response_item' &&
            p.role === 'assistant' &&
            Array.isArray(p.content)
          ) {
            const text = p.content
              .filter((c) => c.type === 'output_text')
              .map((c) => c.text ?? '')
              .join('')
              .trim();
            if (text && text.length > 2) messages.push({ role: 'assistant', text });
          }
        } catch {
          continue;
        }
      }
      return messages;
    } catch {
      continue;
    }
  }
  return [];
}

/**
 * opencode: SQLite at ~/.local/share/opencode/opencode.db
 *
 * Tables: message (id, session_id, data JSON), part (message_id, data JSON)
 * data.role = 'user' | 'assistant';  part.data.type = 'text', part.data.text = string
 */
function readOpencodeSession(sessionId: string, _cwd: string): SessionMessage[] {
  const dbPath = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return [];
  const sqlite3 = findSqlite3();
  if (!sqlite3) return [];

  try {
    // Get all messages with their text parts, ordered by creation time.
    const sql = `
      SELECT json_extract(m.data,'$.role') as role,
             group_concat(json_extract(p.data,'$.text'), char(10)) as text
      FROM message m
      JOIN part p ON p.message_id = m.id
      WHERE m.session_id = '${sessionId.replace(/'/g, "''")}'
        AND json_extract(m.data,'$.role') IN ('user','assistant')
        AND json_extract(p.data,'$.type') = 'text'
      GROUP BY m.id, m.time_created
      ORDER BY m.time_created;
    `.trim().replace(/\s+/g, ' ');

    const result = execFileSync(
      sqlite3,
      [dbPath, sql],
      { encoding: 'utf8', timeout: 5_000 },
    ).trim();

    if (!result) return [];

    const messages: SessionMessage[] = [];
    for (const line of result.split('\n')) {
      // sqlite3 default output: "role|text"
      const pipeIdx = line.indexOf('|');
      if (pipeIdx === -1) continue;
      const role = line.slice(0, pipeIdx).trim() as 'user' | 'assistant';
      const text = line.slice(pipeIdx + 1).trim();
      if (text && (role === 'user' || role === 'assistant')) {
        messages.push({ role, text });
      }
    }
    return messages;
  } catch {
    return [];
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Find the most-recently-modified .jsonl file in `dir` and return its stem
 * (filename without extension). Returns null if the directory doesn't exist or
 * is empty.
 */
function latestJsonlStem(dir: string): string | null {
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        try {
          return { name: f, mtime: statSync(join(dir, f)).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { name: string; mtime: number } => x !== null)
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    return files[0].name.replace(/\.jsonl$/, '');
  } catch {
    return null;
  }
}
