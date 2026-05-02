/**
 * Agent History Session Manager — main API.
 *
 * Provides:
 *   listAgentHistory(filter?)    — fast, served from in-memory index cache
 *   triggerHistoryRefresh()      — non-blocking background incremental scan
 *   hideHistoryEntry(id)         — soft-delete from the index
 *   mergeTabEntry(entry)         — merge a Tday-closed-tab into the index
 *
 * Background refresh strategy (mirrors session-cache.ts):
 *   1. Walk each agent's session directory metadata (stat only, no file reads).
 *   2. Compare current file count + max-mtime against stored scan state.
 *   3. For dirty agents: call the scanner, replace that agent's entries.
 *   4. Prefer native entries over tday-sourced entries (same sessionId).
 *   5. Write index atomically, invalidate hot cache.
 *
 * The refresh is triggered via setImmediate so the caller (IPC handler) returns
 * before any file I/O starts — ensuring zero startup latency.
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentHistoryEntry, AgentHistoryFilter } from '@tday/shared';
import type { TabHistoryEntry } from '../tab-history.js';
import { loadStore, saveStore, type AgentScanState } from './store.js';
import {
  scanClaudeHistory,
  scanCodexHistory,
  scanOpencodeHistory,
  scanGeminiHistory,
  scanPiHistory,
  collectJsonlPaths,
} from './scanners.js';

// ── Agent watcher definitions ─────────────────────────────────────────────────

interface AgentWatcher {
  agentId: string;
  /** Collect all session file paths (stat only). */
  collectFiles(): Array<{ path: string; mtime: number }>;
  /** Full scan of this agent's session directory. Only called when dirty. */
  scan(): AgentHistoryEntry[];
}

function collectWithMtime(dir: string, ext: string, maxDepth: number): Array<{ path: string; mtime: number }> {
  const paths = collectJsonlPaths(dir, maxDepth);
  return paths.map((p) => {
    try {
      return { path: p, mtime: statSync(p).mtimeMs };
    } catch {
      return { path: p, mtime: 0 };
    }
  });
}

const AGENT_WATCHERS: AgentWatcher[] = [
  {
    agentId: 'claude-code',
    collectFiles: () =>
      collectWithMtime(join(homedir(), '.claude', 'projects'), '.jsonl', 2),
    scan: scanClaudeHistory,
  },
  {
    agentId: 'codex',
    collectFiles: () =>
      collectWithMtime(join(homedir(), '.codex', 'sessions'), '.jsonl', 5),
    scan: scanCodexHistory,
  },
  {
    agentId: 'opencode',
    collectFiles: () => {
      const p = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
      if (!existsSync(p)) return [];
      try {
        return [{ path: p, mtime: statSync(p).mtimeMs }];
      } catch {
        return [];
      }
    },
    scan: scanOpencodeHistory,
  },
  {
    agentId: 'gemini',
    collectFiles: () => {
      const base = join(homedir(), '.gemini', 'tmp');
      if (!existsSync(base)) return [];
      const out: Array<{ path: string; mtime: number }> = [];
      let projDirs: string[];
      try {
        projDirs = readdirSync(base);
      } catch {
        return [];
      }
      for (const proj of projDirs) {
        const chatsDir = join(base, proj, 'chats');
        out.push(...collectWithMtime(chatsDir, '.jsonl', 1));
      }
      return out;
    },
    scan: scanGeminiHistory,
  },
  {
    agentId: 'pi',
    collectFiles: () =>
      collectWithMtime(join(homedir(), '.pi', 'agent', 'sessions'), '.jsonl', 2),
    scan: scanPiHistory,
  },
];

// ── Dirty check ───────────────────────────────────────────────────────────────

function isDirty(
  agentId: string,
  files: Array<{ mtime: number }>,
  scanState: Partial<Record<string, AgentScanState>>,
): boolean {
  const stored = scanState[agentId];
  if (!stored) return true;
  const maxMtime = files.length > 0 ? Math.max(...files.map((f) => f.mtime)) : 0;
  return files.length !== stored.fileCount || maxMtime !== stored.maxMtime;
}

// ── Background refresh ────────────────────────────────────────────────────────

let refreshPromise: Promise<void> | null = null;

function runRefresh(): Promise<void> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
  try {
    const store = loadStore();

    // Preserve existing tday-source entries (closed tabs for agents without native files).
    const tdayEntries = store.entries.filter((e) => e.source === 'tday');

    // Preserve hidden flags so they survive a re-scan.
    const hiddenIds = new Set<string>(
      store.entries.filter((e) => e.hidden).map((e) => e.id),
    );

    // Map: agentId → native entries (replaced when dirty).
    const nativeByAgent = new Map<string, AgentHistoryEntry[]>();
    // Seed from existing store so clean agents don't lose their entries.
    for (const e of store.entries) {
      if (e.source !== 'native') continue;
      if (!nativeByAgent.has(e.agentId)) nativeByAgent.set(e.agentId, []);
      nativeByAgent.get(e.agentId)!.push(e);
    }

    let changed = false;

    for (const watcher of AGENT_WATCHERS) {
      const files = watcher.collectFiles();
      if (!isDirty(watcher.agentId, files, store.scanState)) continue;

      // This agent has new/changed files — re-scan.
      const scanned = watcher.scan();
      nativeByAgent.set(watcher.agentId, scanned);

      const maxMtime = files.length > 0 ? Math.max(...files.map((f) => f.mtime)) : 0;
      store.scanState[watcher.agentId] = {
        fileCount: files.length,
        maxMtime,
        lastScanTs: Date.now(),
      };
      changed = true;
    }

    if (!changed) return;

    // Flatten all native entries.
    const allNative: AgentHistoryEntry[] = [];
    for (const entries of nativeByAgent.values()) {
      allNative.push(...entries);
    }

    // Restore hidden flags on native entries.
    for (const e of allNative) {
      if (hiddenIds.has(e.id)) e.hidden = true;
    }

    // Filter tday entries: drop any whose sessionId now has a native counterpart.
    const nativeSessionIds = new Set<string>(
      allNative.filter((e) => e.sessionId).map((e) => e.sessionId!),
    );
    const filteredTday = tdayEntries.filter(
      (e) => !e.sessionId || !nativeSessionIds.has(e.sessionId),
    );
    // Restore hidden flags on tday entries too.
    for (const e of filteredTday) {
      if (hiddenIds.has(e.id)) e.hidden = true;
    }

    store.entries = [...allNative, ...filteredTday].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    saveStore(store);
  } catch (err) {
    console.error('[tday] history refresh failed:', err);
  } finally {
    refreshPromise = null;
  }
  })();
  return refreshPromise;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Return entries from the in-memory index cache. Zero I/O — always fast.
 * Entries are already sorted by updatedAt desc.
 */
export function listAgentHistory(filter?: AgentHistoryFilter): AgentHistoryEntry[] {
  const store = loadStore();
  let entries = store.entries.filter((e) => !e.hidden || filter?.includeHidden);
  if (filter?.agentId) {
    entries = entries.filter((e) => e.agentId === filter.agentId);
  }
  if (filter?.fromTs) {
    entries = entries.filter((e) => e.updatedAt >= (filter.fromTs ?? 0));
  }
  if (filter?.limit && filter.limit > 0) {
    entries = entries.slice(0, filter.limit);
  }
  return entries;
}

/**
 * Trigger a non-blocking incremental background refresh.
 * Returns immediately; the actual scan runs via setImmediate.
 */
export function triggerHistoryRefresh(): void {
  setImmediate(() => { void runRefresh(); });
}

/**
 * Await a full refresh then return the history.
 * Used by the IPC handler so the renderer always gets populated data.
 */
export async function refreshAndListAgentHistory(filter?: AgentHistoryFilter): Promise<AgentHistoryEntry[]> {
  await runRefresh();
  return listAgentHistory(filter);
}

/**
 * Soft-delete an entry from the index (marks hidden=true).
 * The agent's native session file is NOT deleted.
 */
export function hideHistoryEntry(id: string): void {
  const store = loadStore();
  const entry = store.entries.find((e) => e.id === id);
  if (entry) {
    entry.hidden = true;
    saveStore(store);
  }
}

/**
 * Merge a Tday-tracked tab-close event into the history index.
 * Called when a tab is closed. Skipped if a native entry already exists.
 */
export function mergeTabEntry(tabEntry: TabHistoryEntry): void {
  const store = loadStore();
  const tdayId = `tday:${tabEntry.histId}`;

  // If a native session already exists for this sessionId, don't add a duplicate.
  if (tabEntry.agentSessionId) {
    const nativeId = `${tabEntry.agentId}:${tabEntry.agentSessionId}`;
    if (store.entries.some((e) => e.id === nativeId)) return;
  }

  const entry: AgentHistoryEntry = {
    id: tdayId,
    agentId: tabEntry.agentId,
    sessionId: tabEntry.agentSessionId,
    title: tabEntry.title,
    cwd: tabEntry.cwd,
    startedAt: tabEntry.closedAt,
    updatedAt: tabEntry.closedAt,
    messageCount: 0,
    source: 'tday',
  };

  const existing = store.entries.findIndex((e) => e.id === tdayId);
  if (existing >= 0) {
    store.entries[existing] = entry;
  } else {
    store.entries.unshift(entry);
  }

  store.entries.sort((a, b) => b.updatedAt - a.updatedAt);
  saveStore(store);
}
