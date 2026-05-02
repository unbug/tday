#!/usr/bin/env node
// Bumps patch versions in root + workspace packages, then runs the package script.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const targets = [
  'package.json',
  'apps/desktop/package.json',
  'packages/shared/package.json',
  'packages/adapters/pi/package.json',
];

function bump(v) {
  const [maj, min, patch] = v.split('.').map(Number);
  return `${maj}.${min}.${patch + 1}`;
}

let next = null;
for (const rel of targets) {
  const p = join(root, rel);
  const json = JSON.parse(readFileSync(p, 'utf8'));
  next ??= bump(json.version);
  json.version = next;
  writeFileSync(p, JSON.stringify(json, null, 2) + '\n');
  console.log(`[release] ${rel} -> ${next}`);
}

console.log(`[release] typechecking...`);
execSync('pnpm --filter @tday/desktop typecheck', { stdio: 'inherit', cwd: root });
console.log(`[release] building Tday v${next}`);
execSync('pnpm --filter @tday/desktop build', { stdio: 'inherit', cwd: root });
execSync('pnpm --filter @tday/desktop package:mac', { stdio: 'inherit', cwd: root });

// Commit bumped versions and create a git tag so CI can associate the build
console.log(`[release] tagging v${next}`);
execSync('git add ' + targets.map(t => JSON.stringify(t)).join(' '), { stdio: 'inherit', cwd: root });
execSync(`git commit -m "chore: release v${next}"`, { stdio: 'inherit', cwd: root });
execSync(`git tag v${next}`, { stdio: 'inherit', cwd: root });
console.log(`[release] pushing v${next} to origin...`);
execSync('git push origin main --tags', { stdio: 'inherit', cwd: root });
console.log(`[release] done — GitHub Actions will pick up tag v${next}`);
console.log(`[release] artifacts: apps/desktop/release/${next}/`);
