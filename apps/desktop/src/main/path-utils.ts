/**
 * PATH augmentation utilities.
 *
 * macOS GUI apps and Windows shortcut-launched Electron apps inherit a minimal
 * PATH that misses Homebrew, nvm, npm-global, and other toolchains. This
 * module patches process.env.PATH so child_process and node-pty spawns can
 * find executables like `npm`, `pi`, `claude`, `codex`, etc.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

export const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/**
 * Augment process.env.PATH with common locations where Node toolchains live.
 */
export function augmentPath(): void {
  const home = homedir();
  const extras: string[] = [];

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    extras.push(
      join(appData, 'npm'),
      join(home, 'scoop', 'shims'),
      join(localAppData, 'Microsoft', 'WinGet', 'Packages'),
      join(home, '.cargo', 'bin'),
      join(home, '.bun', 'bin'),
      join(localAppData, 'fnm_multishells'),
      'C:\\Program Files\\nodejs',
      'C:\\Program Files (x86)\\nodejs',
    );
    extras.push(join(home, '.volta', 'bin'));
    try {
      const fnmDir = join(localAppData, 'fnm', 'node-versions');
      if (existsSync(fnmDir)) {
        const versions = readdirSync(fnmDir).sort().reverse();
        if (versions[0]) extras.unshift(join(fnmDir, versions[0], 'installation'));
      }
    } catch { /* ignore */ }
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
  const npmCandidates: string[] = isWin
    ? [join('C:\\Program Files\\nodejs', 'npm.cmd'), join(process.env.APPDATA ?? '', 'npm', 'npm.cmd')]
    : ['/opt/homebrew/bin/npm', '/usr/local/bin/npm'];
  try {
    const whichCmd = isWin ? 'where' : 'which';
    const found = execFileSync(whichCmd, [isWin ? 'npm.cmd' : 'npm'], {
      encoding: 'utf8',
      timeout: 3_000,
    }).split(/\r?\n/)[0].trim();
    if (found) npmCandidates.unshift(found);
  } catch { /* ignore */ }
  for (const npmBin of npmCandidates) {
    if (npmBin && existsSync(npmBin)) {
      try {
        const prefix = execFileSync(npmBin, ['config', 'get', 'prefix'], {
          encoding: 'utf8',
          timeout: 3_000,
        }).trim();
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
