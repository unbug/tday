/**
 * NativecoreService — shared persistent `tday-nativecore` HTTP MCP server.
 *
 * Instead of spawning one `tday-nativecore` process per agent session (stdio mode),
 * Electron main spawns a single HTTP-mode nativecore process and all agent sessions
 * connect to it via URL.  This provides a global tool-call queue across all agents
 * from all tabs, eliminating AX/CoreGraphics race conditions caused by concurrent
 * parallel_tool_calls from multiple codex/gemini/opencode sessions.
 *
 * Lifecycle:
 *   1. First CU-enabled agent spawn calls `addRef()` → process started.
 *   2. Every subsequent spawn increments the ref count.
 *   3. On PTY exit, the corresponding session calls `release()`.
 *   4. When ref count reaches 0 → process killed (no leaked zombies).
 *
 * Cross-platform: the same `tday-nativecore --port 0` command works on
 * macOS, Windows, and Linux.  Port 0 asks the OS for an ephemeral port.
 * The process announces its actual port by printing `NATIVECORE_PORT:<n>` to
 * stdout before accepting any connections.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { devToolsBinaryPath } from './computer-use';

// How long to wait for the process to announce its port.
const PORT_ANNOUNCE_TIMEOUT_MS = 10_000;

// Grace period before killing the process after the last session exits.
// Keeping nativecore alive between back-to-back sessions avoids port churn:
// codex bakes the MCP URL (including port) into its -c args at spawn time, so
// a different port on the next session would only matter for the NEXT spawn —
// but rapid close/re-open cycles still benefit from skipping the ~1 s startup.
const LAZY_KILL_MS = 60_000;

export type NativecoreStatus = 'stopped' | 'starting' | 'ready' | 'degraded' | 'stopping';

class NativecoreServiceImpl {
  private proc: ChildProcess | null = null;
  private _port: number | null = null;
  private _refCount = 0;
  private _startPromise: Promise<number> | null = null;
  private _killTimer: ReturnType<typeof setTimeout> | null = null;
  private _status: NativecoreStatus = 'stopped';
  private _lastError: string | null = null;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Increment ref count and ensure the service process is running.
   * Resolves when the HTTP server is accepting connections.
   * Safe to call concurrently — all callers share one start promise.
   * Cancels any pending lazy-kill timer so a quick reuse skips restart.
   */
  async addRef(): Promise<void> {
    // Cancel a pending lazy kill: a new session is opening before the grace
    // period expired, so the existing process (same port) can be reused.
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    this._refCount++;
    if (!this._startPromise) {
      this._startPromise = this._startProcess();
    }
    try {
      await this._startPromise;
    } catch (e) {
      // Roll back the increment: this caller never acquired a successful ref,
      // so it must not call release().  Without this rollback the count would
      // be permanently inflated and the process would never be killed even
      // after all real sessions exit.
      this._refCount = Math.max(0, this._refCount - 1);
      throw e;
    }
  }

  /**
   * Decrement ref count.  Schedules a lazy kill when the count reaches zero
   * so back-to-back sessions can reuse the same process and port without
   * incurring the ~1 s restart cost.
   * Must be called exactly once for every successful `addRef()`.
   */
  release(): void {
    this._refCount = Math.max(0, this._refCount - 1);
    if (this._refCount === 0 && this.proc === null) {
      if (this._killTimer !== null) {
        clearTimeout(this._killTimer);
        this._killTimer = null;
      }
      this._status = 'stopped';
      return;
    }
    if (this._refCount === 0 && this._killTimer === null) {
      this._killTimer = setTimeout(() => {
        this._killTimer = null;
        // Double-check: a concurrent addRef() may have already incremented
        // the count before the timer fired.
        if (this._refCount === 0) this._kill();
      }, LAZY_KILL_MS);
    }
  }

  /**
   * Returns the MCP endpoint URL, e.g. `http://127.0.0.1:PORT/mcp`.
   * Throws if the service is not yet started — always call `addRef()` first.
   */
  getUrl(): string {
    if (this._port === null) {
      throw new Error('[NativecoreService] Not started — call addRef() and await it first');
    }
    return `http://127.0.0.1:${this._port}/mcp`;
  }

  /** True when the process is running and the port is known. */
  get isRunning(): boolean {
    return this.proc !== null && this._port !== null;
  }

  /** Current ref count (mainly for tests / diagnostics). */
  get refCount(): number { return this._refCount; }

  /** Lifecycle status for diagnostics and UI health reporting. */
  get status(): NativecoreStatus { return this._status; }

  /** Last startup/runtime error, if any. */
  get lastError(): string | null { return this._lastError; }

  // ── Private ────────────────────────────────────────────────────────────────

  private _startProcess(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      this._status = 'starting';
      this._lastError = null;
      let bin: string;
      try {
        bin = devToolsBinaryPath();
      } catch (e) {
        const err = new Error(`[NativecoreService] Cannot resolve binary path: ${(e as Error).message}`);
        this._status = 'stopped';
        this._lastError = err.message;
        reject(err);
        return;
      }

      const proc = spawn(bin, ['--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        // On Windows, hide the console window that would otherwise flash briefly.
        windowsHide: true,
      });
      this.proc = proc;

      let settled = false;
      let stdoutBuf = '';

      const settle = (err?: Error, port?: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          this.proc = null;
          this._port = null;
          this._startPromise = null;
          this._status = 'stopped';
          this._lastError = err.message;
          reject(err);
        } else {
          this._port = port!;
          this._status = 'ready';
          this._lastError = null;
          resolve(port!);
        }
      };

      // Read port announcement from stdout line by line.
      proc.stdout!.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const m = /NATIVECORE_PORT:(\d+)/.exec(stdoutBuf);
        if (m) {
          const port = parseInt(m[1], 10);
          settle(undefined, port);
        }
      });

      // Forward nativecore logs (stderr) to Electron's own stderr for debugging.
      proc.stderr!.on('data', (chunk: Buffer) => process.stderr.write(chunk));

      proc.on('error', (err) => {
        settle(new Error(`[NativecoreService] Spawn error: ${err.message}`));
      });

      proc.on('exit', (code, signal) => {
        const wasRunning = this._port !== null;
        const message = `[NativecoreService] Process exited (code=${code}, signal=${signal ?? 'none'})`;
        this.proc = null;
        this._port = null;
        this._startPromise = null;
        // Only reject if we haven't resolved yet (process crashed before announcing port).
        if (!wasRunning) {
          settle(new Error(
            `[NativecoreService] Process exited before announcing port (code=${code}, signal=${signal ?? 'none'})`,
          ));
        } else if (this._refCount > 0) {
          this._status = 'degraded';
          this._lastError = message;
        } else {
          this._status = 'stopped';
          this._lastError = null;
        }
      });

      const timer = setTimeout(() => {
        this._kill();
        settle(new Error(
          `[NativecoreService] Timed out waiting for NATIVECORE_PORT (${PORT_ANNOUNCE_TIMEOUT_MS}ms)`,
        ));
      }, PORT_ANNOUNCE_TIMEOUT_MS);
    });
  }

  private _kill(): void {
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer);
      this._killTimer = null;
    }
    const p = this.proc;
    if (p) {
      this.proc = null;
      this._port = null;
      this._startPromise = null;
      this._status = 'stopping';
      try { p.kill(); } catch { /* already dead */ }
      if (this._refCount === 0) {
        this._status = 'stopped';
        this._lastError = null;
      }
    } else if (this._refCount === 0) {
      this._status = 'stopped';
    }
  }
}

/** Singleton NativecoreService instance used by all agent sessions. */
export const NativecoreService = new NativecoreServiceImpl();
