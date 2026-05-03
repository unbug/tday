/**
 * npm global package installer / updater / uninstaller.
 *
 * Wraps npm install/update/uninstall with streaming progress events sent
 * back to the renderer via the IPC event sender.
 */

import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawn as spawnChild } from 'node:child_process';
import { PATH_SEP } from './path-utils.js';
import { shuttingDown } from './pty-manager.js';
import type { AgentId, AgentInstallEvent, AgentInstallSpec } from '@tday/shared';
import { IPC } from '@tday/shared';

export type NpmAction = 'install' | 'update' | 'uninstall';

const INSTALL_PROGRESS_STAGES: Array<{ pct: number; status: string; matchers: RegExp[] }> = [
  { pct: 5,  status: 'starting',    matchers: [/./] },
  { pct: 15, status: 'resolving',   matchers: [/idealtree|resolve|reify/i] },
  { pct: 35, status: 'fetching',    matchers: [/fetch|http|tarball|GET\s+200/i] },
  { pct: 60, status: 'extracting',  matchers: [/extract|unpack/i] },
  { pct: 80, status: 'linking',     matchers: [/link|symlink|bin\s/i] },
  { pct: 92, status: 'finalizing',  matchers: [/audit|cleanup|prepare/i] },
];

export async function runNpmGlobal(
  event: Electron.IpcMainInvokeEvent,
  agentId: AgentId,
  action: NpmAction,
  spec: AgentInstallSpec | undefined,
): Promise<{ ok: boolean; exitCode: number | null }> {
  const send = (e: AgentInstallEvent) =>
    !shuttingDown && !event.sender.isDestroyed() && event.sender.send(IPC.agentInstallProgress, e);

  if (!spec || !spec.npmPackage) {
    send({ agentId, kind: 'error', data: `no installer registered for agent "${agentId}"` });
    return { ok: false, exitCode: null };
  }

  const npmArgs =
    action === 'uninstall'
      ? ['uninstall', '-g', spec.npmPackage]
      : action === 'update'
        ? ['install', '-g', `${spec.npmPackage}@latest`, '--loglevel=info']
        : ['install', '-g', spec.npmPackage, '--loglevel=info'];

  let stageIdx = 0;
  const advance = (line: string) => {
    while (stageIdx < INSTALL_PROGRESS_STAGES.length - 1) {
      const next = INSTALL_PROGRESS_STAGES[stageIdx + 1];
      if (next.matchers.some((rx) => rx.test(line))) {
        stageIdx += 1;
        send({ agentId, kind: 'progress', percent: next.pct, status: next.status });
      } else {
        break;
      }
    }
  };

  const npmBin = resolveNpmBin();
  if (!npmBin) {
    send({
      agentId,
      kind: 'error',
      data: 'npm not found on PATH. Install Node.js (https://nodejs.org) and relaunch Tday.',
    });
    return { ok: false, exitCode: null };
  }

  const first = INSTALL_PROGRESS_STAGES[0];
  send({ agentId, kind: 'stdout', data: `[tday] using ${npmBin}\r\n` });
  send({ agentId, kind: 'stdout', data: `[tday] ${action} ${spec.npmPackage}…\r\n` });
  send({ agentId, kind: 'progress', percent: first.pct, status: first.status });

  return await new Promise<{ ok: boolean; exitCode: number | null }>((resolve) => {
    const child = spawnChild(npmBin, npmArgs, {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const onLine = (kind: 'stdout' | 'stderr', b: Buffer) => {
      const text = b.toString();
      send({ agentId, kind, data: text });
      for (const line of text.split('\n')) advance(line);
    };
    child.stdout?.on('data', (b: Buffer) => onLine('stdout', b));
    child.stderr?.on('data', (b: Buffer) => onLine('stderr', b));
    child.on('error', (err) => {
      send({ agentId, kind: 'error', data: String(err) });
      resolve({ ok: false, exitCode: null });
    });
    child.on('close', (code) => {
      if (code === 0) {
        send({ agentId, kind: 'progress', percent: 100, status: 'done' });
        send({ agentId, kind: 'done', exitCode: 0 });
        resolve({ ok: true, exitCode: 0 });
      } else {
        send({
          agentId,
          kind: 'error',
          data: `npm ${action} exited with code ${code}`,
          exitCode: code,
        });
        resolve({ ok: false, exitCode: code });
      }
    });
  });
}

function resolveNpmBin(): string | null {
  const npmNames = process.platform === 'win32' ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'];
  const extraCandidates = process.platform === 'win32'
    ? []
    : ['/opt/homebrew/bin/npm', '/usr/local/bin/npm'];
  for (const npmName of npmNames) {
    const fromPath = (process.env.PATH ?? '').split(PATH_SEP)
      .map((p) => join(p, npmName))
      .find((c) => c && existsSync(c));
    if (fromPath) return fromPath;
  }
  for (const c of extraCandidates) if (c && existsSync(c)) return c;
  return null;
}
