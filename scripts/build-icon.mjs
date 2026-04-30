#!/usr/bin/env node
// Renders apps/desktop/build/icon.svg into a Mac .icns using rsvg-convert + iconutil.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const buildDir = join(here, '..', 'apps', 'desktop', 'build');
const svg = join(buildDir, 'icon.svg');
const iconset = join(buildDir, 'icon.iconset');
const icns = join(buildDir, 'icon.icns');

if (!existsSync(svg)) {
  console.error(`[icon] missing ${svg}`);
  process.exit(1);
}

if (existsSync(iconset)) rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset, { recursive: true });

const sizes = [
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
];

for (const [name, size] of sizes) {
  const out = join(iconset, name);
  execSync(`rsvg-convert -w ${size} -h ${size} -o "${out}" "${svg}"`, { stdio: 'inherit' });
}

execSync(`iconutil -c icns -o "${icns}" "${iconset}"`, { stdio: 'inherit' });
console.log(`[icon] wrote ${icns}`);
