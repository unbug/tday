/**
 * Power management — Keep Awake feature.
 *
 * On macOS, Electron's powerSaveBlocker('prevent-app-suspension') only
 * prevents idle timeout sleep (NoIdleSleepAssertion). To also prevent
 * lid-close sleep on AC power we additionally spawn `caffeinate -si`.
 *
 * On Windows / Linux, powerSaveBlocker alone is sufficient.
 */

import { spawn as spawnChild } from 'node:child_process';
import { powerSaveBlocker, powerMonitor, ipcMain } from 'electron';
import { IPC } from '@tday/shared';

/** caffeinate(8) child process used for lid-close sleep prevention on macOS. */
let caffeinateProc: ReturnType<typeof spawnChild> | null = null;

/** Whether Keep Awake is intentionally active (survives sleep/wake cycles). */
let keepAwakeActive = false;

export function spawnCaffeinate(): void {
  if (process.platform !== 'darwin' || caffeinateProc) return;
  caffeinateProc = spawnChild('caffeinate', ['-si'], { stdio: 'ignore' });
  caffeinateProc.on('exit', () => { caffeinateProc = null; });
}

export function stopCaffeinate(): void {
  if (caffeinateProc) {
    caffeinateProc.kill();
    caffeinateProc = null;
  }
}

export function isKeepAwakeActive(): boolean {
  return keepAwakeActive;
}

/**
 * Set up powerMonitor listeners and the heartbeat timer.
 * Must be called after the Electron `ready` event.
 */
export function setupPowerMonitor(): void {
  // After any sleep/wake cycle macOS may have dropped our power assertion.
  // Re-spawn caffeinate if Keep Awake is still supposed to be active.
  powerMonitor.on('resume', () => {
    if (keepAwakeActive && !caffeinateProc) spawnCaffeinate();
  });

  // Heartbeat: `resume` only fires on full system suspend/wake, not on
  // display-only sleep. Poll every 30 s as a belt-and-suspenders guard.
  setInterval(() => {
    if (keepAwakeActive && !caffeinateProc) spawnCaffeinate();
  }, 30_000);
}

/** Register all power-management IPC handlers. */
export function registerPowerHandlers(): void {
  ipcMain.handle(IPC.powerBlockerStart, () => {
    keepAwakeActive = true;
    const id = powerSaveBlocker.start('prevent-app-suspension');
    spawnCaffeinate();
    return { id };
  });

  ipcMain.handle(IPC.powerBlockerStop, (_e, id: number) => {
    keepAwakeActive = false;
    if (typeof id === 'number' && powerSaveBlocker.isStarted(id)) {
      powerSaveBlocker.stop(id);
    }
    stopCaffeinate();
  });
}
