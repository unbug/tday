/**
 * Automatic `fd` binary installation.
 *
 * Pi coding agent shells out to `fd` (sharkdp/fd) for fast directory
 * listings. When `fd` is missing, Pi tries to download it from a URL that
 * sometimes 404s. We pre-install it from the canonical GitHub release.
 *
 * Idempotent — does nothing once fd is on PATH or in ~/.tday/bin.
 * Network failures are non-fatal.
 *
 * Windows notes
 * -------------
 * - npm global binaries and PowerShell are .cmd / .ps1 wrappers that
 *   CreateProcess cannot execute directly.  We run them via cmd.exe /c.
 * - Expand-Archive may not be available on older PowerShell (pre-5.0); we
 *   fall back to .NET's System.IO.Compression.ZipFile if Expand-Archive
 *   is absent.
 * - After expanding the zip, fd.exe lives inside a subfolder
 *   (fd-<version>-x86_64-pc-windows-msvc/); we copy it to ~/.tday/bin/.
 */

import { join } from 'node:path';
import { homedir, arch as osArch } from 'node:os';
import { existsSync, mkdirSync, chmodSync, copyFileSync, rmSync, readdirSync } from 'node:fs';
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
 * Try to find an executable on PATH or in TDAY_BIN.
 */
function findOnPath(fdBin: string, env: Record<string, string | undefined>): string | null {
  for (const dir of (env.PATH ?? '').split(PATH_SEP)) {
    if (dir && existsSync(join(dir, fdBin))) {
      return join(dir, fdBin);
    }
  }
  return null;
}

/**
 * Copy `fd.exe` out of the extracted zip subfolder into ~/.tday/bin/.
 *
 * GitHub's `fd` release zip archives contain a single subdirectory like
 * `fd-v10.2.0-x86_64-pc-windows-msvc/fd.exe`.  Expand-Archive preserves
 * this structure, so we traverse the extract root to find fd.exe.
 */
function moveFdFromExtract(extractDir: string, target: string): boolean {
  // Walk one level deep
  let entries: string[];
  try {
    entries = readdirSync(extractDir);
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = join(extractDir, entry);
    if (existsSync(full)) {
      // Check if entry itself is fd.exe
      if (entry.toLowerCase() === 'fd.exe') {
        copyFileSync(full, target);
        return true;
      }
      // Check if entry is a subdirectory containing fd.exe
      const nested = join(full, 'fd.exe');
      if (existsSync(nested)) {
        copyFileSync(nested, target);
        return true;
      }
    }
  }
  return false;
}

/**
 * Download `fd` (sharkdp/fd) into ~/.tday/bin if it's not already on PATH.
 * Idempotent and non-fatal on network errors.
 *
 * On Windows, uses PowerShell's Expand-Archive or falls back to
 * a cmd.exe + .NET helper if PowerShell is missing or old.
 */
export async function ensureFd(env: Record<string, string | undefined>): Promise<void> {
  const fdBin = process.platform === 'win32' ? 'fd.exe' : 'fd';

  // Already on PATH — nothing to do.
  if (findOnPath(fdBin, env)) return;

  const target = join(TDAY_BIN, fdBin);

  // Already downloaded in ~/.tday/bin — add to PATH and return.
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
      // Create a temp extraction directory next to the zip
      const extractDir = join(TDAY_BIN, `_extract_${Date.now()}`);
      mkdirSync(extractDir, { recursive: true });

      try {
        // Try PowerShell's Expand-Archive first
        execFileSync(
          'cmd.exe',
          [
            '/c',
            'powershell',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractDir}" -Force`,
          ],
          { stdio: 'ignore', timeout: 30_000 },
        );

        // Locate fd.exe inside the extracted subfolder and copy it out
        if (!moveFdFromExtract(extractDir, target)) {
          // Fallback: try .NET ZipFile.ExtractToDirectory (available on .NET 4.5+)
          execFileSync(
            'cmd.exe',
            [
              '/c',
              'powershell',
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
              `[System.IO.Compression.ZipFile]::ExtractToDirectory('${archivePath}', '${extractDir}')`,
            ],
            { stdio: 'ignore', timeout: 30_000 },
          );
          moveFdFromExtract(extractDir, target);
        }
      } finally {
        // Clean up temp extraction directory
        try { rmSync(extractDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    } else {
      // macOS / Linux: tar with strip-components
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
