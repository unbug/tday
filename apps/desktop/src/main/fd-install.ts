/**
 * Automatic `fd` binary installation.
 *
 * Pi coding agent shells out to `fd` (sharkdp/fd) for fast directory
 * listings. When `fd` is missing, Pi tries to download it from a URL that
 * sometimes 404s. We pre-install it from the canonical GitHub release.
 *
 * Idempotent — does nothing once fd is on PATH or in ~/.tday/bin.
 * Network failures are non-fatal.
 */

import { join } from 'node:path';
import { homedir, arch as osArch } from 'node:os';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { PATH_SEP } from './path-utils.js';

export const TDAY_BIN = join(homedir(), '.tday', 'bin');

export function downloadFollowingRedirects(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const get = (u: string, hops: number) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      const req = httpsRequest(u, { method: 'GET' }, (res) => {
        const code = res.statusCode ?? 0;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          get(new URL(res.headers.location, u).toString(), hops + 1);
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`download ${u} → HTTP ${code}`));
          return;
        }
        const out = createWriteStream(dest);
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve()));
        out.on('error', reject);
      });
      req.on('error', reject);
      req.end();
    };
    get(url, 0);
  });
}

/**
 * Download `fd` (sharkdp/fd) into ~/.tday/bin if it's not already on PATH.
 * Idempotent and non-fatal on network errors.
 */
export async function ensureFd(env: Record<string, string | undefined>): Promise<void> {
  const fdBin = process.platform === 'win32' ? 'fd.exe' : 'fd';
  for (const dir of (env.PATH ?? '').split(PATH_SEP)) {
    if (dir && existsSync(join(dir, fdBin))) return;
  }
  const target = join(TDAY_BIN, fdBin);
  if (existsSync(target)) {
    env.PATH = `${TDAY_BIN}${PATH_SEP}${env.PATH ?? ''}`;
    return;
  }

  const version = 'v10.2.0';
  let archive: string;
  let url: string;

  if (process.platform === 'darwin') {
    const arch = osArch() === 'arm64' ? 'aarch64' : 'x86_64';
    archive = `fd-${version}-${arch}-apple-darwin.tar.gz`;
    url = `https://github.com/sharkdp/fd/releases/download/${version}/${archive}`;
  } else if (process.platform === 'win32') {
    archive = `fd-${version}-x86_64-pc-windows-msvc.zip`;
    url = `https://github.com/sharkdp/fd/releases/download/${version}/${archive}`;
  } else {
    return; // Linux users almost always have fd via package manager
  }

  const archivePath = join(TDAY_BIN, archive);

  try {
    if (!existsSync(TDAY_BIN)) mkdirSync(TDAY_BIN, { recursive: true });
    console.log('[tday] downloading fd:', url);
    await downloadFollowingRedirects(url, archivePath);
    if (process.platform === 'win32') {
      execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        `Expand-Archive -Path "${archivePath}" -DestinationPath "${TDAY_BIN}" -Force`,
      ], { stdio: 'ignore', timeout: 30_000 });
    } else {
      execFileSync('tar', ['-xzf', archivePath, '-C', TDAY_BIN, '--strip-components=1'], {
        stdio: 'ignore',
      });
      chmodSync(target, 0o755);
    }
    env.PATH = `${TDAY_BIN}${PATH_SEP}${env.PATH ?? ''}`;
    console.log('[tday] fd installed at', target);
  } catch (err) {
    console.error('[tday] fd auto-install failed (non-fatal):', err);
  }
}
