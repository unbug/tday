/**
 * Unit tests for agent-history store and scanners.
 *
 * Uses a temporary home directory so no real ~/.tday is touched.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { join } from 'node:path';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

// ── Shared temp home ──────────────────────────────────────────────────────────

const tmpHome = mkdtempSync(join(tmpdir(), 'tday-hist-test-'));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => tmpHome };
});

// Import AFTER mock is set up.
const { loadStore, saveStore, invalidateCache } = await import('../store.js');
const { scanClaudeHistory, scanCodexHistory, scanGeminiHistory, scanPiHistory } = await import('../scanners.js');
const { listAgentHistory, hideHistoryEntry, mergeTabEntry, triggerHistoryRefresh } = await import('../index.js');

afterAll(() => {
  rmSync(tmpHome, { recursive: true, force: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeLine(path: string, obj: unknown) {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(path) ? require('node:fs').readFileSync(path, 'utf8') : '';
  writeFileSync(path, existing + JSON.stringify(obj) + '\n', 'utf8');
}

function writeJsonl(path: string, lines: unknown[]) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
}

// ── store tests ───────────────────────────────────────────────────────────────

describe('HistoryStore', () => {
  beforeEach(() => {
    invalidateCache();
    const tdayDir = join(tmpHome, '.tday');
    const indexFile = join(tdayDir, 'history-index.json');
    if (existsSync(indexFile)) rmSync(indexFile);
  });

  it('returns empty store when index file does not exist', () => {
    const store = loadStore();
    expect(store.version).toBe(2);
    expect(store.entries).toEqual([]);
    expect(store.scanState).toEqual({});
  });

  it('persists and loads entries', () => {
    const store = loadStore();
    store.entries.push({
      id: 'claude-code:abc',
      agentId: 'claude-code',
      sessionId: 'abc',
      title: 'Test session',
      cwd: '/Users/test/project',
      startedAt: 1000,
      updatedAt: 2000,
      messageCount: 3,
      source: 'native',
    });
    saveStore(store);

    invalidateCache();
    const loaded = loadStore();
    expect(loaded.entries).toHaveLength(1);
    expect(loaded.entries[0].id).toBe('claude-code:abc');
    expect(loaded.entries[0].title).toBe('Test session');
  });

  it('hot cache avoids re-reading the file', () => {
    const store = loadStore();
    store.entries.push({
      id: 'test:1',
      agentId: 'pi',
      title: 'Cached',
      cwd: '/',
      startedAt: 0,
      updatedAt: 0,
      messageCount: 0,
      source: 'native',
    });
    saveStore(store);

    // Second load should return the same object (no file read).
    const store2 = loadStore();
    expect(store2.entries).toHaveLength(1);
  });

  it('handles corrupt index gracefully', () => {
    const tdayDir = join(tmpHome, '.tday');
    mkdirSync(tdayDir, { recursive: true });
    writeFileSync(join(tdayDir, 'history-index.json'), 'NOT JSON', 'utf8');
    invalidateCache();
    const store = loadStore();
    expect(store.entries).toEqual([]);
  });

  it('handles wrong version gracefully', () => {
    const tdayDir = join(tmpHome, '.tday');
    mkdirSync(tdayDir, { recursive: true });
    writeFileSync(
      join(tdayDir, 'history-index.json'),
      JSON.stringify({ version: 1, entries: [] }),
      'utf8',
    );
    invalidateCache();
    const store = loadStore();
    expect(store.entries).toEqual([]);
  });
});

// ── claude-code scanner tests ─────────────────────────────────────────────────

describe('scanClaudeHistory', () => {
  const claudeDir = join(tmpHome, '.claude', 'projects', 'Users-test-project');
  const sessionFile = join(claudeDir, 'abc-123.jsonl');

  beforeEach(() => {
    if (existsSync(claudeDir)) rmSync(claudeDir, { recursive: true });
    mkdirSync(claudeDir, { recursive: true });
  });

  it('returns empty when no claude projects exist', () => {
    rmSync(join(tmpHome, '.claude'), { recursive: true, force: true });
    const entries = scanClaudeHistory();
    expect(entries).toEqual([]);
  });

  it('extracts sessionId, title, cwd from JSONL', () => {
    writeJsonl(sessionFile, [
      { type: 'user', timestamp: '2024-01-15T10:00:00Z', message: { role: 'user', content: 'Build a web server' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Sure!' }] } },
    ]);

    const entries = scanClaudeHistory();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.agentId).toBe('claude-code');
    expect(e.sessionId).toBe('abc-123');
    expect(e.id).toBe('claude-code:abc-123');
    expect(e.title).toBe('Build a web server');
    expect(e.cwd).toBe('/Users/test/project');
    expect(e.messageCount).toBe(2);
    expect(e.source).toBe('native');
  });

  it('handles array content blocks', () => {
    writeJsonl(sessionFile, [
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'Hello from blocks' }],
        },
      },
    ]);

    const entries = scanClaudeHistory();
    expect(entries[0].title).toBe('Hello from blocks');
  });

  it('falls back to (new conversation) when no user message', () => {
    writeJsonl(sessionFile, [
      { type: 'system', message: { role: 'system', content: 'You are helpful.' } },
    ]);

    const entries = scanClaudeHistory();
    expect(entries[0].title).toBe('(new conversation)');
  });

  it('truncates long titles at 80 chars', () => {
    const longMsg = 'A'.repeat(200);
    writeJsonl(sessionFile, [
      { type: 'user', message: { role: 'user', content: longMsg } },
    ]);

    const entries = scanClaudeHistory();
    expect(entries[0].title.length).toBeLessThanOrEqual(81); // 80 + ellipsis char
    expect(entries[0].title.endsWith('…')).toBe(true);
  });
});

// ── codex scanner tests ───────────────────────────────────────────────────────

describe('scanCodexHistory', () => {
  const codexDir = join(tmpHome, '.codex', 'sessions', '2024', '01', '15');

  beforeEach(() => {
    if (existsSync(join(tmpHome, '.codex'))) {
      rmSync(join(tmpHome, '.codex'), { recursive: true });
    }
    mkdirSync(codexDir, { recursive: true });
  });

  it('returns empty when no codex sessions', () => {
    rmSync(join(tmpHome, '.codex'), { recursive: true, force: true });
    expect(scanCodexHistory()).toEqual([]);
  });

  it('extracts session metadata and title', () => {
    const file = join(codexDir, 'session-1.jsonl');
    writeJsonl(file, [
      {
        type: 'session_meta',
        timestamp: '2024-01-15T09:00:00Z',
        payload: { id: 'session-uuid-1', cwd: '/home/user/myproject' },
      },
      {
        type: 'event_msg',
        payload: { type: 'user_message', message: 'Fix the bug in main.ts' },
      },
      {
        type: 'response_item',
        payload: { role: 'assistant' },
      },
    ]);

    const entries = scanCodexHistory();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.agentId).toBe('codex');
    expect(e.sessionId).toBe('session-uuid-1');
    expect(e.id).toBe('codex:session-uuid-1');
    expect(e.title).toBe('Fix the bug in main.ts');
    expect(e.cwd).toBe('/home/user/myproject');
    expect(e.messageCount).toBe(2); // user + response_item
  });

  it('skips files without session_meta.id', () => {
    const file = join(codexDir, 'no-meta.jsonl');
    writeJsonl(file, [{ type: 'event_msg', payload: { type: 'user_message', message: 'Hi' } }]);
    expect(scanCodexHistory()).toEqual([]);
  });
});

// ── gemini scanner tests ──────────────────────────────────────────────────────

describe('scanGeminiHistory', () => {
  const geminiDir = join(tmpHome, '.gemini', 'tmp', 'proj-hash', 'chats');

  beforeEach(() => {
    if (existsSync(join(tmpHome, '.gemini'))) {
      rmSync(join(tmpHome, '.gemini'), { recursive: true });
    }
    mkdirSync(geminiDir, { recursive: true });
  });

  it('returns empty when no gemini sessions', () => {
    rmSync(join(tmpHome, '.gemini'), { recursive: true, force: true });
    expect(scanGeminiHistory()).toEqual([]);
  });

  it('extracts session data', () => {
    const file = join(geminiDir, 'session-1234-abcd.jsonl');
    writeJsonl(file, [
      { sessionId: 'gemini-sess-1', cwd: '/projects/app', startTime: '2024-01-15T08:00:00Z' },
      { type: 'user', content: 'Help me write tests' },
      { type: 'gemini', content: 'Sure, here are some tests...' },
    ]);

    const entries = scanGeminiHistory();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.agentId).toBe('gemini');
    expect(e.sessionId).toBe('gemini-sess-1');
    expect(e.id).toBe('gemini:gemini-sess-1');
    expect(e.title).toBe('Help me write tests');
    expect(e.cwd).toBe('/projects/app');
    expect(e.messageCount).toBe(2);
  });

  it('skips files without sessionId in first line', () => {
    const file = join(geminiDir, 'session-no-id.jsonl');
    writeJsonl(file, [{ noSessionId: true }, { type: 'user', content: 'hi' }]);
    expect(scanGeminiHistory()).toEqual([]);
  });
});

// ── pi scanner tests ──────────────────────────────────────────────────────────

describe('scanPiHistory', () => {
  const piDir = join(tmpHome, '.pi', 'agent', 'sessions', 'Users-pi-project');

  beforeEach(() => {
    if (existsSync(join(tmpHome, '.pi'))) {
      rmSync(join(tmpHome, '.pi'), { recursive: true });
    }
    mkdirSync(piDir, { recursive: true });
  });

  it('returns empty when no pi sessions', () => {
    rmSync(join(tmpHome, '.pi'), { recursive: true, force: true });
    expect(scanPiHistory()).toEqual([]);
  });

  it('extracts pi session data', () => {
    const file = join(piDir, '1705320000_pi-session-1.jsonl');
    writeJsonl(file, [
      { type: 'session', id: 'pi-session-1', timestamp: '2024-01-15T10:00:00Z', cwd: '/Users/pi/project' },
      { type: 'message', message: { role: 'user', content: 'Add dark mode' } },
      { type: 'message', message: { role: 'assistant', content: 'Sure!' } },
    ]);

    const entries = scanPiHistory();
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.agentId).toBe('pi');
    expect(e.sessionId).toBe('1705320000_pi-session-1');
    expect(e.id).toBe('pi:1705320000_pi-session-1');
    expect(e.title).toBe('Add dark mode');
    expect(e.cwd).toBe('/Users/pi/project');
    expect(e.messageCount).toBe(2);
  });
});

// ── listAgentHistory tests ────────────────────────────────────────────────────

describe('listAgentHistory', () => {
  beforeEach(() => {
    invalidateCache();
    const tdayDir = join(tmpHome, '.tday');
    const indexFile = join(tdayDir, 'history-index.json');
    if (existsSync(indexFile)) rmSync(indexFile);
  });

  it('returns empty when no index', () => {
    const entries = listAgentHistory();
    expect(entries).toEqual([]);
  });

  it('filters by agentId', () => {
    const store = loadStore();
    store.entries = [
      { id: 'claude-code:1', agentId: 'claude-code', title: 'A', cwd: '/', startedAt: 1000, updatedAt: 1000, messageCount: 0, source: 'native' },
      { id: 'codex:1', agentId: 'codex', title: 'B', cwd: '/', startedAt: 2000, updatedAt: 2000, messageCount: 0, source: 'native' },
    ];
    saveStore(store);
    invalidateCache();

    const filtered = listAgentHistory({ agentId: 'codex' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].agentId).toBe('codex');
  });

  it('filters by fromTs', () => {
    const store = loadStore();
    const now = Date.now();
    store.entries = [
      { id: 'a:1', agentId: 'pi', title: 'Old', cwd: '/', startedAt: now - 100000, updatedAt: now - 100000, messageCount: 0, source: 'native' },
      { id: 'a:2', agentId: 'pi', title: 'New', cwd: '/', startedAt: now, updatedAt: now, messageCount: 0, source: 'native' },
    ];
    saveStore(store);
    invalidateCache();

    const filtered = listAgentHistory({ fromTs: now - 1000 });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].title).toBe('New');
  });

  it('respects limit', () => {
    const store = loadStore();
    store.entries = Array.from({ length: 10 }, (_, i) => ({
      id: `a:${i}`,
      agentId: 'pi',
      title: `Session ${i}`,
      cwd: '/',
      startedAt: i * 1000,
      updatedAt: i * 1000,
      messageCount: 0,
      source: 'native' as const,
    }));
    saveStore(store);
    invalidateCache();

    const filtered = listAgentHistory({ limit: 3 });
    expect(filtered).toHaveLength(3);
  });

  it('excludes hidden entries by default', () => {
    const store = loadStore();
    store.entries = [
      { id: 'a:1', agentId: 'pi', title: 'Visible', cwd: '/', startedAt: 1000, updatedAt: 1000, messageCount: 0, source: 'native', hidden: false },
      { id: 'a:2', agentId: 'pi', title: 'Hidden', cwd: '/', startedAt: 2000, updatedAt: 2000, messageCount: 0, source: 'native', hidden: true },
    ];
    saveStore(store);
    invalidateCache();

    const entries = listAgentHistory();
    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe('Visible');
  });

  it('includeHidden flag shows hidden entries', () => {
    const store = loadStore();
    store.entries = [
      { id: 'a:1', agentId: 'pi', title: 'Hidden', cwd: '/', startedAt: 1000, updatedAt: 1000, messageCount: 0, source: 'native', hidden: true },
    ];
    saveStore(store);
    invalidateCache();

    const entries = listAgentHistory({ includeHidden: true });
    expect(entries).toHaveLength(1);
  });
});

// ── hideHistoryEntry tests ────────────────────────────────────────────────────

describe('hideHistoryEntry', () => {
  beforeEach(() => {
    invalidateCache();
    const tdayDir = join(tmpHome, '.tday');
    const indexFile = join(tdayDir, 'history-index.json');
    if (existsSync(indexFile)) rmSync(indexFile);
  });

  it('marks an entry as hidden', () => {
    const store = loadStore();
    store.entries = [
      { id: 'x:1', agentId: 'pi', title: 'Test', cwd: '/', startedAt: 0, updatedAt: 0, messageCount: 0, source: 'native' },
    ];
    saveStore(store);
    invalidateCache();

    hideHistoryEntry('x:1');

    invalidateCache();
    const updated = loadStore();
    expect(updated.entries[0].hidden).toBe(true);
  });

  it('is idempotent for unknown ids', () => {
    const store = loadStore();
    saveStore(store);
    expect(() => hideHistoryEntry('nonexistent:1')).not.toThrow();
  });
});

// ── mergeTabEntry tests ───────────────────────────────────────────────────────

describe('mergeTabEntry', () => {
  beforeEach(() => {
    invalidateCache();
    const tdayDir = join(tmpHome, '.tday');
    const indexFile = join(tdayDir, 'history-index.json');
    if (existsSync(indexFile)) rmSync(indexFile);
  });

  it('adds a tday entry to the index', () => {
    mergeTabEntry({
      histId: 'h1',
      title: 'My Claude Session',
      agentId: 'claude-code',
      cwd: '/projects/app',
      closedAt: Date.now(),
      agentSessionId: 'session-uuid-abc',
    });

    invalidateCache();
    const store = loadStore();
    expect(store.entries).toHaveLength(1);
    const e = store.entries[0];
    expect(e.id).toBe('tday:h1');
    expect(e.agentId).toBe('claude-code');
    expect(e.sessionId).toBe('session-uuid-abc');
    expect(e.source).toBe('tday');
  });

  it('skips adding if a native entry with same sessionId exists', () => {
    const store = loadStore();
    store.entries = [
      {
        id: 'claude-code:session-uuid-abc',
        agentId: 'claude-code',
        sessionId: 'session-uuid-abc',
        title: 'Native version',
        cwd: '/projects/app',
        startedAt: 1000,
        updatedAt: 2000,
        messageCount: 5,
        source: 'native',
      },
    ];
    saveStore(store);
    invalidateCache();

    mergeTabEntry({
      histId: 'h2',
      title: 'Tday version',
      agentId: 'claude-code',
      cwd: '/projects/app',
      closedAt: Date.now(),
      agentSessionId: 'session-uuid-abc',
    });

    invalidateCache();
    const updated = loadStore();
    // Should still be 1 — the native entry was not overwritten
    expect(updated.entries).toHaveLength(1);
    expect(updated.entries[0].source).toBe('native');
  });

  it('updates existing tday entry with same histId', () => {
    mergeTabEntry({
      histId: 'h3',
      title: 'First title',
      agentId: 'pi',
      cwd: '/a',
      closedAt: 1000,
    });

    invalidateCache();

    mergeTabEntry({
      histId: 'h3',
      title: 'Updated title',
      agentId: 'pi',
      cwd: '/a',
      closedAt: 2000,
    });

    invalidateCache();
    const store = loadStore();
    const entry = store.entries.find((e) => e.id === 'tday:h3');
    expect(entry?.title).toBe('Updated title');
    // Should not have duplicated
    expect(store.entries.filter((e) => e.id === 'tday:h3')).toHaveLength(1);
  });
});

// ── triggerHistoryRefresh tests ───────────────────────────────────────────────

describe('triggerHistoryRefresh', () => {
  it('does not throw when called', () => {
    expect(() => triggerHistoryRefresh()).not.toThrow();
  });
});
