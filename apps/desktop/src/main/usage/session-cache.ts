/**
 * Persistent incremental cache for session-file usage records.
 *
 * Problem: scanning all agent session files (claude-code, codex, opencode, pi,
 * gemini) on every usageQuery is slow — it reads and parses potentially hundreds
 * of JSONL files synchronously on the main process.
 *
 * Solution:
 *   Cache file  ~/.tday/session-cache.jsonl  — all scanned UsageRecords (JSONL)
 *   Index file  ~/.tday/session-index.json   — per-agent dirty-check watermarks
 *
 * Fast path (usageQuery):
 *   1. Read from hot in-memory cache (populated from file on first access).
 *   2. Trigger a background incremental refresh via setImmediate so the IPC
 *      response is sent before any file I/O starts.
 *
 * Background refresh (incremental):
 *   1. Stat-walk each agent's session directory (metadata only, no file reads).
 *   2. Compare current file count + max-mtime against the stored index.
 *   3. For dirty agents only: call the existing scan*() function, replace that
 *      agent's records in the cache, update the index.
 *   4. Write cache atomically (temp file + rename) and invalidate hot cache.
 *
 * This means subsequent queries are O(cache-file-read) rather than
 * O(sum of all session files). The background refresh is O(stat × files) for
 * clean agents and O(full-scan) only for agents with new/changed files.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { UsageRecord } from './types.js';
import type { UsageFilter } from './store.js';
import { scanClaudeCodeSessions } from './session-readers/claude-code.js';
import { scanCodexSessions } from './session-readers/codex.js';
import { scanOpencodeDB } from './session-readers/opencode.js';
import { scanPiSessions } from './session-readers/pi.js';
import { scanGeminiSessions } from './session-readers/gemini.js';

const TDAY_DIR = join(homedir(), '.tday');
const CACHE_FILE = join(TDAY_DIR, 'session-cache.jsonl');
const CACHE_TMP = join(TDAY_DIR, 'session-cache.tmp.jsonl');
const INDEX_FILE = join(TDAY_DIR, 'session-index.json');

// ── Index types ──────────────────────────────────────────────────────────────

interface AgentIndexEntry {
  /** Unix ms timestamp of the last completed scan for this agent. */
  lastScanTs: number;
  /** Number of session files seen during last scan. */
  fileCount: number;
  /** Newest file mtime (ms) seen during last scan. */
  maxMtime: number;
}

interface SessionIndex {
  version: 1;
  agents: Partial<Record<string, AgentIndexEntry>>;
}

// ── Agent watcher definitions ────────────────────────────────────────────────

interface AgentWatcher {
  agentId: string;
  /**
   * Collect absolute paths of all session files for this agent.
   * Uses only directory listings and stat — no file content reads.
   */
  collectFiles(): string[];
  /**
   * Full scan: return all UsageRecords for this agent (no time filter).
   * Only called when the agent is detected as dirty.
   */
  scan(): UsageRecord[];
}

/** Recursively collect files with the given extension up to maxDepth levels. */
function collectFilesUnder(dir: string, ext: string, maxDepth: number): string[] {
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
        const st = statSync(full);
        if (st.isDirectory()) {
          walk(full, depth - 1);
        } else if (e.endsWith(ext)) {
          out.push(full);
        }
      } catch {
        /* ignore */
      }
    }
  }
  walk(dir, maxDepth);
  return out;
}

const AGENT_WATCHERS: AgentWatcher[] = [
  {
    agentId: 'claude-code',
    collectFiles: () =>
      collectFilesUnder(join(homedir(), '.claude', 'projects'), '.jsonl', 2),
    scan: () => scanClaudeCodeSessions(),
  },
  {
    agentId: 'codex',
    collectFiles: () =>
      collectFilesUnder(join(homedir(), '.codex', 'sessions'), '.jsonl', 5),
    scan: () => scanCodexSessions(),
  },
  {
    agentId: 'opencode',
    collectFiles: () => {
      const p = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
      return existsSync(p) ? [p] : [];
    },
    scan: () => scanOpencodeDB(),
  },
  {
    agentId: 'pi',
    collectFiles: () =>
      collectFilesUnder(join(homedir(), '.pi', 'agent', 'sessions'), '.jsonl', 2),
    scan: () => scanPiSessions(),
  },
  {
    agentId: 'gemini',
    collectFiles: () => {
      const base = join(homedir(), '.gemini', 'tmp');
      if (!existsSync(base)) return [];
      const files: string[] = [];
      try {
        for (const proj of readdirSync(base)) {
          const chatsDir = join(base, proj, 'chats');
          if (!existsSync(chatsDir)) continue;
          try {
            for (const f of readdirSync(chatsDir)) {
              if (f.startsWith('session-') && (f.endsWith('.jsonl') || f.endsWith('.json'))) {
                files.push(join(chatsDir, f));
              }
            }
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* ignore */
      }
      return files;
    },
    scan: () => scanGeminiSessions(),
  },
];

// ── Index helpers ────────────────────────────────────────────────────────────

function ensureDir(): void {
  if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
}

function loadIndex(): SessionIndex {
  try {
    if (existsSync(INDEX_FILE)) {
      return JSON.parse(readFileSync(INDEX_FILE, 'utf8')) as SessionIndex;
    }
  } catch {
    /* ignore */
  }
  return { version: 1, agents: {} };
}

function saveIndex(idx: SessionIndex): void {
  try {
    ensureDir();
    writeFileSync(INDEX_FILE, JSON.stringify(idx), 'utf8');
  } catch {
    /* ignore */
  }
}

/** Compute file-count and max-mtime for a set of file paths (stat only). */
function statFiles(files: string[]): { fileCount: number; maxMtime: number } {
  let maxMtime = 0;
  for (const f of files) {
    try {
      const ms = statSync(f).mtimeMs;
      if (ms > maxMtime) maxMtime = ms;
    } catch {
      /* ignore */
    }
  }
  return { fileCount: files.length, maxMtime };
}

/** Returns true if the agent has new or modified session files since last scan. */
function isAgentDirty(watcher: AgentWatcher, index: SessionIndex): boolean {
  const entry = index.agents[watcher.agentId];
  if (!entry) return true; // never scanned yet

  const files = watcher.collectFiles();
  const { fileCount, maxMtime } = statFiles(files);
  return fileCount !== entry.fileCount || maxMtime > entry.maxMtime;
}

// ── Cache read / write ───────────────────────────────────────────────────────

/** Read the JSONL cache file. Returns all records (no filter applied). */
function readCacheFile(): UsageRecord[] {
  if (!existsSync(CACHE_FILE)) return [];
  try {
    const records: UsageRecord[] = [];
    for (const line of readFileSync(CACHE_FILE, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try {
        records.push(JSON.parse(t) as UsageRecord);
      } catch {
        /* skip malformed */
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Atomically overwrite the cache file from a per-agent record map.
 * Writes to a .tmp file first then renames so concurrent reads are never
 * interrupted mid-write.
 */
function writeCacheFile(agentRecords: Map<string, UsageRecord[]>): void {
  try {
    ensureDir();
    const lines: string[] = [];
    for (const records of agentRecords.values()) {
      for (const r of records) {
        lines.push(JSON.stringify(r));
      }
    }
    writeFileSync(CACHE_TMP, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    renameSync(CACHE_TMP, CACHE_FILE);
  } catch {
    /* ignore */
  }
}

// ── Hot in-memory cache ──────────────────────────────────────────────────────

/** In-memory snapshot; null means not yet loaded from disk. */
let hotCache: UsageRecord[] | null = null;

function getHotCache(): UsageRecord[] {
  if (hotCache === null) {
    hotCache = readCacheFile();
  }
  return hotCache;
}

function invalidateHotCache(): void {
  hotCache = null;
}

// ── Background refresh ───────────────────────────────────────────────────────

let refreshInProgress = false;
let refreshQueued = false;

async function doRefresh(): Promise<void> {
  if (refreshInProgress) {
    refreshQueued = true;
    return;
  }
  refreshInProgress = true;

  try {
    const index = loadIndex();

    // Determine dirty agents using stat-only walk (no file reads yet).
    const dirtyWatchers = AGENT_WATCHERS.filter((w) => isAgentDirty(w, index));
    if (dirtyWatchers.length === 0) return;

    // Load existing cache grouped by agentId.
    const agentRecords = new Map<string, UsageRecord[]>();
    for (const r of readCacheFile()) {
      let list = agentRecords.get(r.agentId);
      if (!list) {
        list = [];
        agentRecords.set(r.agentId, list);
      }
      list.push(r);
    }

    // Re-scan each dirty agent.
    for (const watcher of dirtyWatchers) {
      // Yield to the event loop between agents so IPC and UI remain responsive.
      await new Promise<void>((resolve) => setImmediate(resolve));

      const freshRecords = watcher.scan();
      agentRecords.set(watcher.agentId, freshRecords);

      // Update dirty-check watermarks for this agent.
      const files = watcher.collectFiles();
      const { fileCount, maxMtime } = statFiles(files);
      index.agents[watcher.agentId] = {
        lastScanTs: Date.now(),
        fileCount,
        maxMtime,
      };
    }

    // Persist results.
    writeCacheFile(agentRecords);
    saveIndex(index);
    invalidateHotCache();
  } finally {
    refreshInProgress = false;
    if (refreshQueued) {
      refreshQueued = false;
      setImmediate(() => void doRefresh());
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Load session usage records from the persistent cache. Synchronous and fast
 * — reads the in-memory hot cache (populated from disk on first call).
 *
 * Applies the given filter criteria in-memory. Call
 * triggerSessionCacheRefresh() to schedule a background update.
 */
export function loadCachedSessionRecords(filter: UsageFilter = {}): UsageRecord[] {
  const { fromTs, toTs, agentId, providerId } = filter;
  return getHotCache().filter((r) => {
    if (fromTs !== undefined && r.ts < fromTs) return false;
    if (toTs !== undefined && r.ts >= toTs) return false;
    if (agentId && r.agentId !== agentId) return false;
    if (providerId && r.providerId !== providerId) return false;
    return true;
  });
}

/**
 * Schedule a background incremental refresh of the session cache.
 *
 * Non-blocking: returns immediately. The refresh runs asynchronously after
 * the current event loop tick completes (via setImmediate), so any pending
 * IPC response is sent before any file I/O begins.
 *
 * If a refresh is already running, the next refresh is queued and will start
 * immediately after the current one finishes.
 *
 * Safe to call on every usageQuery — the dirty-check (stat-only, no reads) is
 * cheap and the full scan is only triggered when session files have changed.
 */
export function triggerSessionCacheRefresh(): void {
  if (refreshInProgress) {
    refreshQueued = true;
    return;
  }
  setImmediate(() => void doRefresh());
}
