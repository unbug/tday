/**
 * PTY process map and lifecycle management.
 *
 * Centralises the shared `ptys` map and the `shuttingDown` flag so that
 * IPC handlers (pty spawn, pty write, kill, etc.) and the main app lifecycle
 * can share them without circular imports.
 */

import type { IPty } from 'node-pty';

/** Live PTY processes keyed by tabId. */
export const ptys = new Map<string, IPty>();

/**
 * Set to `true` once the app is shutting down. node-pty fires
 * `onData`/`onExit` asynchronously after we kill the process, and if the
 * BrowserWindow has already been destroyed the call to
 * `event.sender.send(...)` raises `Object has been destroyed` — which
 * Electron promotes to a fatal uncaught-exception dialog. Guarding sends on
 * this flag prevents the dialog.
 */
export let shuttingDown = false;
export function setShuttingDown(value: boolean): void {
  shuttingDown = value;
}

export function killAllPtys(): void {
  for (const p of ptys.values()) {
    try { p.kill(); } catch { /* already dead */ }
  }
  ptys.clear();
}
