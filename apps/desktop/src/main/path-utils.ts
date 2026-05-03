/**
 * PATH augmentation utilities.
 *
 * macOS GUI apps and Windows shortcut-launched Electron apps inherit a minimal
 * PATH that misses Homebrew, nvm, npm-global, and other toolchains. This
 * module patches process.env.PATH so child_process and node-pty spawns can
 * find executables like `npm`, `pi`, `claude`, `codex`, etc.
 *
 * All Windows-specific augmentation is guarded by `process.platform === 'win32'`
 * and never affects macOS or Linux behaviour.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/**
 * Augment process.env.PATH with common locations where Node toolchains live.
 *
 * On Windows, runs `npm config get prefix` via `cmd.exe /c` because the npm
 * global binary is a .cmd wrapper that CreateProcess cannot execute directly.
 */
export function augmentPath(): void {
  const home = homedir();
  const extras: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const progFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const userProfile = process.env.USERPROFILE ?? home;

    extras.push(
      // npm global binaries
      join(appData, 'npm'),
      join(localAppData, 'npm-cache'),
      // Scoop
      join(home, 'scoop', 'shims'),
      join(home, 'scoop', 'apps', 'nodejs', 'current'),
      // WinGet
      join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
      // Rust / Cargo
      join(home, '.cargo', 'bin'),
      // Bun
      join(home, '.bun', 'bin'),
      // fnm
      join(localAppData, 'fnm_multishells'),
      // Node.js official installers
      join(progFiles, 'nodejs'),
      join(progFilesX86, 'nodejs'),
      // Volta
      join(home, '.volta', 'bin'),
      // Chocolatey
      join(progFiles, 'chocolatey', 'bin'),
      // Pipx (Python global tools, may include coding agents)
      join(userProfile, '.local', 'bin'),
      // Yarn (classic)
      join(progFiles, 'Yarn', 'bin'),
      // MSYS2 / Git Bash
      join(progFiles, 'Git', 'cmd'),
      join(progFiles, 'Git', 'bin'),
      join(progFiles, 'Git', 'usr', 'bin'),
      // Deno
      join(home, '.deno', 'bin'),
      // pnpm (global store bin)
      join(localAppData, 'pnpm'),
    );

    // fnm — probe latest installed Node version
    try {
      const fnmDir = join(localAppData, 'fnm', 'node-versions');
      if (existsSync(fnmDir)) {
        const versions = readdirSync(fnmDir).sort().reverse();
        if (versions[0]) extras.unshift(join(fnmDir, versions[0], 'installation'));
      }
    } catch { /* ignore */ }

    // nvm-windows
    try {
      const nvmHome = process.env.NVM_HOME ?? join(appData, 'nvm');
      const nvmSymlink = process.env.NVM_SYMLINK;
      if (nvmSymlink && existsSync(nvmSymlink)) {
        extras.unshift(nvmSymlink);
      } else if (existsSync(nvmHome)) {
        const nvmVersions = readdirSync(nvmHome).filter((v) => /^v?\d/.test(v)).sort().reverse();
        if (nvmVersions[0]) extras.unshift(join(nvmHome, nvmVersions[0]));
      }
    } catch { /* ignore */ }
  } else {
    // macOS / Linux
    extras.push(
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      '/usr/local/sbin',
      join(home, '.npm-global', 'bin'),
      join(home, '.local', 'bin'),
      join(home, '.bun', 'bin'),
      join(home, '.cargo', 'bin'),
    );
    try {
      const nvmDir = join(home, '.nvm', 'versions', 'node');
      if (existsSync(nvmDir)) {
        const versions = readdirSync(nvmDir).sort().reverse();
        if (versions[0]) extras.unshift(join(nvmDir, versions[0], 'bin'));
      }
    } catch { /* ignore */ }
  }

  const isWin = process.platform === 'win32';
  const npmBinName = isWin ? 'npm.cmd' : 'npm';
  const npmCandidates: string[] = isWin
    ? [
        join('C:\\Program Files\\nodejs', npmBinName),
        join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm', npmBinName),
      ]
    : ['/opt/homebrew/bin/npm', '/usr/local/bin/npm'];

  // Try to find npm on the current PATH
  try {
    const whichCmd = isWin ? 'where' : 'which';
    const found = execFileSync(whichCmd, [npmBinName], {
      encoding: 'utf8',
      timeout: 3_000,
    }).split(/\r?\n/)[0].trim();
    if (found) npmCandidates.unshift(found);
  } catch { /* ignore */ }

  for (const npmBin of npmCandidates) {
    if (npmBin && existsSync(npmBin)) {
      try {
        // On Windows, npm is a .cmd wrapper — use cmd.exe /c to run it.
        let prefix: string;
        if (isWin) {
          prefix = execFileSync('cmd.exe', ['/c', npmBin, 'config', 'get', 'prefix'], {
            encoding: 'utf8',
            timeout: 3_000,
          }).trim();
        } else {
          prefix = execFileSync(npmBin, ['config', 'get', 'prefix'], {
            encoding: 'utf8',
            timeout: 3_000,
          }).trim();
        }
        if (prefix) {
          extras.push(isWin ? prefix : join(prefix, 'bin'));
        }
      } catch { /* ignore */ }
      break;
    }
  }

  const current = process.env.PATH ?? '';
  const seen = new Set(current.split(PATH_SEP).filter(Boolean));
  for (const e of extras) if (existsSync(e)) seen.add(e);
  process.env.PATH = Array.from(seen).join(PATH_SEP);
}
