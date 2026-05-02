/**
 * Persistent index store for the Agent History Session Manager.
 *
 * Index file: ~/.tday/history-index.json
 *
 * Stores all discovered AgentHistoryEntry objects plus per-agent scan-state
 * watermarks used for incremental dirty-checking.
 *
 * Reads are served from an in-memory hot cache. Writes are atomic (temp + rename).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentHistoryEntry } from '@tday/shared';

const TDAY_DIR = join(homedir(), '.tday');
const INDEX_FILE = join(TDAY_DIR, 'history-index.json');
const INDEX_TMP = join(TDAY_DIR, 'history-index.tmp.json');

// ── Types ────────────────────────────────────────────────────────────────────

export interface AgentScanState {
  /** Number of session files seen during last scan. */
  fileCount: number;
  /** Newest file mtime (ms) seen during last scan. */
  maxMtime: number;
  /** When this scan completed. */
  lastScanTs: number;
}

export interface HistoryStore {
  version: 2;
  /** All discovered entries, sorted by updatedAt desc. */
  entries: AgentHistoryEntry[];
  /** Per-agent dirty-check watermarks. */
  scanState: Partial<Record<string, AgentScanState>>;
}

// ── In-memory hot cache ──────────────────────────────────────────────────────

let hotCache: HistoryStore | null = null;

function emptyStore(): HistoryStore {
  return { version: 2, entries: [], scanState: {} };
}

export function loadStore(): HistoryStore {
  if (hotCache) return hotCache;
  try {
    if (!existsSync(INDEX_FILE)) {
      hotCache = emptyStore();
      return hotCache;
    }
    const raw = readFileSync(INDEX_FILE, 'utf8');
    const parsed = JSON.parse(raw) as HistoryStore;
    if (!parsed || parsed.version !== 2 || !Array.isArray(parsed.entries)) {
      hotCache = emptyStore();
      return hotCache;
    }
    hotCache = parsed;
    return hotCache;
  } catch {
    hotCache = emptyStore();
    return hotCache;
  }
}

export function saveStore(store: HistoryStore): void {
  try {
    if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
    writeFileSync(INDEX_TMP, JSON.stringify(store, null, 2), 'utf8');
    renameSync(INDEX_TMP, INDEX_FILE);
    hotCache = store;
  } catch {
    // Ignore write failures (disk full, read-only fs, etc.)
  }
}

export function invalidateCache(): void {
  hotCache = null;
}
