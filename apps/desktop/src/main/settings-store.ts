/**
 * Native persistent settings store for Tday.
 *
 * Replaces localStorage / sessionStorage so settings survive across app updates,
 * profile migrations, and anything that clears browser storage.
 *
 * Storage: ~/.tday/settings.json
 * Strategy:
 *   - Hot in-memory cache (loaded once, kept current)
 *   - Debounced (100 ms) atomic write: temp file → rename — same pattern as the
 *     history index, safe against power-loss mid-write.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { rename as renameAsync, writeFile as writeFileAsync } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const TDAY_DIR = join(homedir(), '.tday');
const SETTINGS_FILE = join(TDAY_DIR, 'settings.json');

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [k: string]: JsonValue };

export type SettingsMap = Record<string, JsonValue>;

// ── In-memory cache ───────────────────────────────────────────────────────────

let hotCache: SettingsMap | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function ensureDir(): void {
  if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });
}

function loadSettings(): SettingsMap {
  if (hotCache !== null) return hotCache;
  try {
    if (existsSync(SETTINGS_FILE)) {
      const raw = readFileSync(SETTINGS_FILE, 'utf8');
      hotCache = JSON.parse(raw) as SettingsMap;
    } else {
      hotCache = {};
    }
  } catch {
    hotCache = {};
  }
  return hotCache;
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistSettings(snapshot: SettingsMap): Promise<void> {
  ensureDir();
  const tmp = join(TDAY_DIR, `.settings-${randomUUID()}.tmp`);
  try {
    await writeFileAsync(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
    await renameAsync(tmp, SETTINGS_FILE);
  } catch {
    // Fallback: direct write (non-atomic but better than nothing)
    try {
      writeFileSync(SETTINGS_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
    } catch { /* ignore */ }
  }
}

function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  // Snapshot current state so late mutations in the same tick don't race.
  const snapshot = { ...hotCache! };
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistSettings(snapshot);
  }, 100);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Returns a shallow copy of all settings. */
export function getAllSettings(): SettingsMap {
  return { ...loadSettings() };
}

/** Returns the value for `key`, or `fallback` if not set. */
export function getSetting<T extends JsonValue>(key: string, fallback: T): T {
  const settings = loadSettings();
  return key in settings ? (settings[key] as T) : fallback;
}

/** Writes a single key. Triggers a debounced atomic persist. */
export function setSetting(key: string, value: JsonValue): void {
  const settings = loadSettings();
  settings[key] = value;
  schedulePersist();
}

/** Merges multiple keys at once. Triggers a single debounced write. */
export function setSettings(patch: SettingsMap): void {
  const settings = loadSettings();
  Object.assign(settings, patch);
  schedulePersist();
}
