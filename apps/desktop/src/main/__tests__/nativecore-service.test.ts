/**
 * Tests for NativecoreService — the shared HTTP nativecore process manager.
 *
 * These tests mock `child_process.spawn` so they don't require the actual
 * `tday-nativecore` binary to be present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

// ── Mock child_process.spawn ──────────────────────────────────────────────────

/** A fake ChildProcess that we can control from tests. */
class FakeProcess extends EventEmitter {
  stdin  = null;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(): void {
    this.killed = true;
    this.emit('exit', 0, null);
  }

  /** Simulate the nativecore announcing its port. */
  announcePort(port: number): void {
    (this.stdout as NodeJS.EventEmitter).emit('data', Buffer.from(`NATIVECORE_PORT:${port}\n`));
  }

  /** Simulate the process crashing. */
  crash(code = 1): void {
    this.emit('exit', code, null);
  }
}

let lastFakeProc: FakeProcess | null = null;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => {
    lastFakeProc = new FakeProcess();
    return lastFakeProc;
  }),
}));

// Mock computer-use so we don't need the binary path to resolve.
vi.mock('../computer-use.js', () => ({
  devToolsBinaryPath: () => '/fake/path/tday-nativecore',
}));

// ── Import after mocks are set up ─────────────────────────────────────────────

// We need to import the module fresh for each test group since it holds
// internal singleton state.  Use vi.resetModules() + dynamic import.

async function freshService() {
  vi.resetModules();
  const mod = await import('../nativecore-service.js');
  return mod.NativecoreService;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NativecoreService', () => {
  beforeEach(() => {
    lastFakeProc = null;
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Kill any lingering fake process to avoid cross-test interference.
    lastFakeProc?.kill();
  });

  // ── addRef / getUrl ─────────────────────────────────────────────────────────

  it('starts the process and resolves getUrl() after addRef()', async () => {
    const svc = await freshService();
    expect(svc.status).toBe('stopped');
    const addRefPromise = svc.addRef();
    // Simulate port announcement from process stdout.
    setTimeout(() => lastFakeProc?.announcePort(12345), 10);
    await addRefPromise;

    expect(svc.getUrl()).toBe('http://127.0.0.1:12345/mcp');
    expect(svc.isRunning).toBe(true);
    expect(svc.status).toBe('ready');
    expect(svc.lastError).toBeNull();
    svc.release();
  });

  it('getUrl() throws when service has not been started', async () => {
    const svc = await freshService();
    expect(() => svc.getUrl()).toThrow();
  });

  it('concurrent addRef() calls share one start promise', async () => {
    const svc = await freshService();
    const p1 = svc.addRef();
    const p2 = svc.addRef();
    setTimeout(() => lastFakeProc?.announcePort(11111), 10);
    await Promise.all([p1, p2]);

    // Only one spawn should have been called.
    const { spawn } = await import('node:child_process');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(svc.refCount).toBe(2);
    svc.release();
    svc.release();
  });

  // ── release / ref counting ──────────────────────────────────────────────────

  it('keeps the process alive while refCount > 0', async () => {
    const svc = await freshService();
    const p1 = svc.addRef();
    const p2 = svc.addRef();
    setTimeout(() => lastFakeProc?.announcePort(22222), 10);
    await Promise.all([p1, p2]);

    svc.release();
    expect(svc.isRunning).toBe(true); // still one ref
    expect(lastFakeProc?.killed).toBeFalsy();

    svc.release();
    // Process should be killed now.
    expect(svc.refCount).toBe(0);
  });

  it('kills process after the lazy-kill grace period', async () => {
    vi.useFakeTimers();
    const svc = await freshService();
    const p = svc.addRef();
    lastFakeProc?.announcePort(33333);
    await p;
    const proc = lastFakeProc!;
    svc.release();
    expect(proc.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(proc.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(proc.killed).toBe(true);
    vi.useRealTimers();
  });

  it('release() is safe when refCount is already 0', async () => {
    const svc = await freshService();
    expect(() => svc.release()).not.toThrow();
    expect(svc.refCount).toBe(0);
  });

  // ── error handling ──────────────────────────────────────────────────────────

  it('rejects addRef() if process crashes before announcing port', async () => {
    const svc = await freshService();
    const p = svc.addRef();
    setTimeout(() => lastFakeProc?.crash(1), 10);
    await expect(p).rejects.toThrow();
    expect(svc.isRunning).toBe(false);
  });

  it('addRef() rolls back refCount on failure — no leak', async () => {
    // This is the critical refCount-leak regression test.
    // Scenario: first addRef() fails (binary crashes before announcing port).
    // The caller does NOT call release() (correct — it never acquired a ref).
    // A subsequent successful addRef() + release() must still kill the process.
    const svc = await freshService();

    // First attempt — fails.
    const p1 = svc.addRef();
    setTimeout(() => lastFakeProc?.crash(1), 10);
    await expect(p1).rejects.toThrow();
    // refCount must be 0, not 1.
    expect(svc.refCount).toBe(0);

    // Second attempt — succeeds.
    const p2 = svc.addRef();
    setTimeout(() => lastFakeProc?.announcePort(77777), 10);
    await p2;
    expect(svc.refCount).toBe(1);

    // Releasing the one successful ref must schedule and eventually kill the process.
    vi.useFakeTimers();
    const proc = lastFakeProc!;
    svc.release();
    expect(proc.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(proc.killed).toBe(true);
    expect(svc.refCount).toBe(0);
    vi.useRealTimers();
  });

  it('clears startPromise after crash so next addRef() retries', async () => {
    const svc = await freshService();

    // First attempt — crash before announcing.
    const p1 = svc.addRef();
    setTimeout(() => lastFakeProc?.crash(1), 10);
    await expect(p1).rejects.toThrow();

    // Second attempt — succeeds.
    const p2 = svc.addRef();
    setTimeout(() => lastFakeProc?.announcePort(44444), 10);
    await p2;
    expect(svc.isRunning).toBe(true);
    svc.release();
  });

  it('marks the service degraded if the process exits while refs are active', async () => {
    const svc = await freshService();
    const p = svc.addRef();
    setTimeout(() => lastFakeProc?.announcePort(88888), 10);
    await p;
    expect(svc.status).toBe('ready');

    lastFakeProc?.crash(9);

    expect(svc.isRunning).toBe(false);
    expect(svc.refCount).toBe(1);
    expect(svc.status).toBe('degraded');
    expect(svc.lastError).toContain('Process exited');
    expect(() => svc.getUrl()).toThrow();

    svc.release();
    expect(svc.status).toBe('stopped');
  });

  it('can start a fresh process after a degraded runtime crash', async () => {
    const svc = await freshService();
    const p1 = svc.addRef();
    setTimeout(() => lastFakeProc?.announcePort(9001), 10);
    await p1;
    lastFakeProc?.crash(1);
    expect(svc.status).toBe('degraded');

    const p2 = svc.addRef();
    setTimeout(() => lastFakeProc?.announcePort(9002), 10);
    await p2;

    expect(svc.status).toBe('ready');
    expect(svc.getUrl()).toBe('http://127.0.0.1:9002/mcp');
    expect(svc.refCount).toBe(2);
    svc.release();
    svc.release();
  });

  // ── getUrl format ───────────────────────────────────────────────────────────

  it('getUrl() always returns http://127.0.0.1:<port>/mcp', async () => {
    const svc = await freshService();
    const p = svc.addRef();
    setTimeout(() => lastFakeProc?.announcePort(55555), 10);
    await p;

    const url = svc.getUrl();
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(url).toContain('55555');
    svc.release();
  });

  // ── isRunning ───────────────────────────────────────────────────────────────

  it('isRunning is false before start and after the lazy stop', async () => {
    vi.useFakeTimers();
    const svc = await freshService();
    expect(svc.isRunning).toBe(false);

    const p = svc.addRef();
    lastFakeProc?.announcePort(66666);
    await p;
    expect(svc.isRunning).toBe(true);

    svc.release();
    expect(svc.isRunning).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(svc.isRunning).toBe(false);
    vi.useRealTimers();
  });
});
