/**
 * CoWorker storage and prompt-injection helpers for the main process.
 *
 * Architecture:
 *   • Preset files    — apps/desktop/resources/CoWorkers/*.md  (bundled with app)
 *   • User overrides  — ~/.tday/coworkers/{id}.md              (created when user edits a preset)
 *   • Online cache    — ~/.tday/coworkers/online-cache/{id}.md (fetched from GitHub URLs)
 *   • Custom roles    — settings-store 'tday:coworkers'        (user-created roles)
 *   • Online roles    — settings-store 'tday:coworkers:online' (URL-backed live roles)
 *
 * Reading priority for built-ins: user override → preset file → hardcoded fallback
 * Reading priority for online/url: cache file → empty (fetched on background refresh)
 */

import { app } from 'electron';
import type { CoWorker } from '@tday/shared';
import {
  readFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
  statSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { getSetting, setSetting } from './settings-store.js';
import type { JsonValue } from './settings-store.js';

const COWORKERS_KEY = 'tday:coworkers';
const ONLINE_COWORKERS_KEY = 'tday:coworkers:online';
const CACHE_STALE_MS = 6 * 60 * 60 * 1000; // 6 hours

// ── Preset file mapping ───────────────────────────────────────────────────────

const BUILTIN_PRESET_FILES: Record<string, string> = {
  'builtin:qa':        'test-engineer-AGENT.md',
  'builtin:security':  'security-auditor-AGENT.md',
  'builtin:reviewer':  'code-reviewer-AGENT.md',
  'builtin:devops':    'devops-engineer-AGENT.md',
  'builtin:frontend':  'frontend-engineer-AGENT.md',
  'builtin:backend':   'backend-engineer-AGENT.md',
  'builtin:techlead':  'tech-lead-AGENT.md',
  'builtin:data':      'data-engineer-AGENT.md',
};

/** Directory of bundled preset AGENT.md files. */
function getPresetDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'CoWorkers');
  }
  return join(app.getAppPath(), 'resources', 'CoWorkers');
}

/** Path to the user's local override file for a built-in. */
function getUserOverridePath(id: string): string {
  const safeId = id.replace('builtin:', '').replace(/[^a-z0-9-]/g, '-');
  return join(homedir(), '.tday', 'coworkers', `${safeId}.md`);
}

// ── Online / URL cache helpers ────────────────────────────────────────────────

/** Root directory for URL content cache files. */
function getUrlCacheDir(): string {
  return join(homedir(), '.tday', 'coworkers', 'online-cache');
}

/** Path to the cached content file for a URL-backed coworker (online or custom-url). */
function getUrlCachePath(id: string): string {
  const safeId = id.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').toLowerCase();
  return join(getUrlCacheDir(), `${safeId}.md`);
}

/** Epoch ms of last write to the URL cache file. Returns undefined on miss. */
function getUrlCacheMtime(id: string): number | undefined {
  try { return statSync(getUrlCachePath(id)).mtimeMs; } catch { return undefined; }
}

/** Read cached markdown content for a URL-backed coworker. Returns '' on miss. */
function readUrlCacheContent(id: string): string {
  try {
    const p = getUrlCachePath(id);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  } catch {}
  return '';
}

/**
 * Convert a GitHub page URL to a raw.githubusercontent.com URL.
 * Handles /blob/ URLs; leaves raw / other URLs unchanged.
 */
export function normalizeGitHubUrl(url: string): string {
  const blobRe = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/;
  if (blobRe.test(url)) {
    return url
      .replace('github.com', 'raw.githubusercontent.com')
      .replace('/blob/', '/');
  }
  return url;
}

/**
 * Fetch a GitHub (or raw) URL, write content to the local cache, return content.
 * Works for both `online:*` and `custom:*` URL-backed coworkers.
 */
export async function refreshCoworkerUrlCache(id: string, url: string): Promise<string> {
  const rawUrl = normalizeGitHubUrl(url.trim());
  const res = await fetch(rawUrl);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${rawUrl}`);
  const content = await res.text();
  const cachePath = getUrlCachePath(id);
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, content, 'utf8');
  return content;
}

// ── Online coworker store ─────────────────────────────────────────────────────

export function loadOnlineCoworkers(): CoWorker[] {
  try {
    const raw = getSetting(ONLINE_COWORKERS_KEY, [] as JsonValue);
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).filter(
      (c): c is CoWorker =>
        !!c && typeof c === 'object' &&
        typeof (c as CoWorker).id === 'string' &&
        typeof (c as CoWorker).name === 'string',
    );
  } catch {
    return [];
  }
}

export function saveOnlineCoworkers(list: CoWorker[]): void {
  // Strip runtime-only fields before persisting (content lives in cache files)
  const toStore = list.map(({ cachedContent: _cc, cachedAt: _ca, ...rest }) => rest);
  setSetting(ONLINE_COWORKERS_KEY, toStore as unknown as JsonValue);
}

/**
 * Schedule periodic background refresh of stale online coworker caches.
 * Should be called once when the app is ready.
 */
export function scheduleBackgroundRefresh(): void {
  const doRefresh = async () => {
    // Refresh user-added online coworkers
    const online = loadOnlineCoworkers().filter((c) => !PRESET_ONLINE_MAP.has(c.id));
    for (const cw of online) {
      if (!cw.url) continue;
      const mtime = getUrlCacheMtime(cw.id);
      if (mtime && Date.now() - mtime < CACHE_STALE_MS) continue;
      try { await refreshCoworkerUrlCache(cw.id, cw.url); } catch { /* silently skip */ }
    }
    // Refresh preset online coworkers (use URL override from store if present)
    const onlineStore = loadOnlineCoworkers();
    for (const cw of PRESET_ONLINE_COWORKERS) {
      const override = onlineStore.find((c) => c.id === cw.id);
      const effectiveUrl = override?.url ?? cw.url;
      if (!effectiveUrl) continue;
      const mtime = getUrlCacheMtime(cw.id);
      if (mtime && Date.now() - mtime < CACHE_STALE_MS) continue;
      try { await refreshCoworkerUrlCache(cw.id, effectiveUrl); } catch { /* silently skip */ }
    }
  };
  // First run 15s after startup; then every 30 min
  setTimeout(() => void doRefresh(), 15_000);
  setInterval(() => void doRefresh(), 30 * 60 * 1000);
}

/** Read content from the bundled preset file. Returns '' on failure. */
function readPresetFileContent(id: string): string {
  const filename = BUILTIN_PRESET_FILES[id];
  if (!filename) return '';
  try {
    return readFileSync(join(getPresetDir(), filename), 'utf8');
  } catch {
    return '';
  }
}

/** Read effective content for a built-in: user override → preset file → hardcoded fallback. */
function readEffectiveBuiltinContent(coworker: CoWorker): string {
  const overridePath = getUserOverridePath(coworker.id);
  if (existsSync(overridePath)) {
    try { return readFileSync(overridePath, 'utf8'); } catch {}
  }
  const preset = readPresetFileContent(coworker.id);
  if (preset) return preset;
  return coworker.systemPrompt;
}

// ── Built-in personas (metadata only — content loaded from files at runtime) ──
const BUILTIN_COWORKERS: CoWorker[] = [
  {
    id: 'builtin:qa',
    name: 'Test Engineer',
    emoji: '🧪',
    description: 'QA engineer for test strategy, writing tests, and coverage analysis',
    isBuiltIn: true,
    systemPrompt: '# Test Engineer\n\nYou are an experienced QA Engineer focused on test strategy and quality assurance.',
  },
  {
    id: 'builtin:security',
    name: 'Security Auditor',
    emoji: '🔒',
    description: 'Vulnerability detection, threat modeling, and secure coding practices',
    isBuiltIn: true,
    systemPrompt: '# Security Auditor\n\nYou are a Security Engineer conducting a security review.',
  },
  {
    id: 'builtin:reviewer',
    name: 'Code Reviewer',
    emoji: '👓',
    description: 'Senior code reviewer evaluating correctness, readability, architecture, security, and performance',
    isBuiltIn: true,
    systemPrompt: '# Senior Code Reviewer\n\nYou are a Staff Engineer conducting a thorough code review.',
  },
  {
    id: 'builtin:devops',
    name: 'DevOps Engineer',
    emoji: '🚀',
    description: 'CI/CD, infrastructure, deployments, Shift Left, Faster is Safer',
    isBuiltIn: true,
    systemPrompt: '# DevOps / Platform Engineer\n\nYou are a senior DevOps and Platform Engineer.',
  },
  {
    id: 'builtin:frontend',
    name: 'Frontend Engineer',
    emoji: '🎨',
    description: 'Component architecture, design systems, accessibility (WCAG 2.1 AA), Core Web Vitals',
    isBuiltIn: true,
    systemPrompt: '# Frontend Engineer\n\nYou are a senior Frontend Engineer focused on UX, accessibility, and performance.',
  },
  {
    id: 'builtin:backend',
    name: 'Backend Engineer',
    emoji: '⚙️',
    description: "API design, data modeling, system reliability, Hyrum's Law",
    isBuiltIn: true,
    systemPrompt: '# Backend Engineer\n\nYou are a senior Backend Engineer with expertise in API design and distributed systems.',
  },
  {
    id: 'builtin:techlead',
    name: 'Tech Lead',
    emoji: '🏗️',
    description: "Architecture decisions, ADRs, code simplification, Chesterton's Fence",
    isBuiltIn: true,
    systemPrompt: "# Tech Lead\n\nYou are a Tech Lead responsible for architectural decisions and long-term codebase health.",
  },
  {
    id: 'builtin:data',
    name: 'Data Engineer',
    emoji: '📊',
    description: 'Data pipelines, SQL optimisation, schema design, data quality',
    isBuiltIn: true,
    systemPrompt: '# Data Engineer\n\nYou are a senior Data Engineer focused on reliable, performant data pipelines.',
  },
];

const BUILTIN_MAP = new Map<string, CoWorker>(BUILTIN_COWORKERS.map((c) => [c.id, c]));

// ── Preset online coworkers (content fetched from GitHub, cached locally) ────

const PRESET_ONLINE_COWORKERS: CoWorker[] = [
  {
    id: 'online:karpathy',
    name: 'Karpathy Code Guidelines',
    emoji: '🧠',
    description: 'Think before coding, simplicity first, surgical changes, goal-driven execution',
    isPreset: true,
    kind: 'online',
    systemPrompt: '# Karpathy Code Guidelines\n\nThink before coding. Keep it simple. Make surgical changes.',
    url: 'https://github.com/forrestchang/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md',
  },
  {
    id: 'online:devin-planner',
    name: 'Devin-style Planner',
    emoji: '🤖',
    description: 'Automated planning, self-evolving scratchpad, agentic multi-step execution',
    isPreset: true,
    kind: 'online',
    systemPrompt: '# Devin-style Planner\n\nUse a scratchpad to plan steps. Self-evolve from corrections. Think before acting.',
    url: 'https://github.com/grapeot/devin.cursorrules/blob/master/.cursorrules',
  },
  {
    id: 'online:earnings-analyst',
    name: 'Earnings Call Analyst',
    emoji: '📈',
    description: 'Equity analyst: decode earnings calls, detect management tone shifts and red flags',
    isPreset: true,
    kind: 'online',
    systemPrompt: '# Earnings Call Analyst\n\nAnalyze earnings transcripts as an equity analyst. Detect red flags, tone shifts, and guidance.',
    url: 'https://github.com/danielmiessler/fabric/blob/main/data/patterns/concall_summary/system.md',
  },
];

const PRESET_ONLINE_MAP = new Map<string, CoWorker>(PRESET_ONLINE_COWORKERS.map((c) => [c.id, c]));



export function loadCustomCoworkers(): CoWorker[] {
  try {
    const raw = getSetting(COWORKERS_KEY, [] as JsonValue);
    if (!Array.isArray(raw)) return [];
    return (raw as unknown[]).filter(
      (c): c is CoWorker =>
        !!c && typeof c === 'object' &&
        typeof (c as CoWorker).id === 'string' &&
        typeof (c as CoWorker).name === 'string',
    );
  } catch {
    return [];
  }
}

export function saveCustomCoworkers(coworkers: CoWorker[]): void {
  setSetting(COWORKERS_KEY, coworkers as unknown as JsonValue);
}

/** Returns all coworkers: built-ins first, then preset online, then user online, then custom. */
export function listAllCoworkers(): CoWorker[] {
  const builtins = BUILTIN_COWORKERS.map((cw) => ({
    ...cw,
    kind: 'builtin' as const,
    systemPrompt: readEffectiveBuiltinContent(cw),
    hasUserOverride: existsSync(getUserOverridePath(cw.id)),
  }));
  const onlineStore = loadOnlineCoworkers();
  const presetOnline = PRESET_ONLINE_COWORKERS.map((cw) => {
    // Merge URL override if user has stored one
    const override = onlineStore.find((c) => c.id === cw.id);
    return {
      ...cw,
      url: override?.url ?? cw.url,
      cachedContent: readUrlCacheContent(cw.id) || undefined,
      cachedAt: getUrlCacheMtime(cw.id),
    };
  });
  const userOnline = onlineStore
    .filter((c) => !PRESET_ONLINE_MAP.has(c.id))
    .map((cw) => ({
      ...cw,
      kind: 'online' as const,
      cachedContent: readUrlCacheContent(cw.id) || undefined,
      cachedAt: getUrlCacheMtime(cw.id),
    }));
  const custom = loadCustomCoworkers().map((cw) => {
    if (!cw.url) return cw;
    return {
      ...cw,
      cachedContent: readUrlCacheContent(cw.id) || undefined,
      cachedAt: getUrlCacheMtime(cw.id),
    };
  });
  return [...builtins, ...presetOnline, ...userOnline, ...custom];
}

/**
 * Save or update a CoWorker.
 *   - Built-ins (`builtin:*`): writes user override to ~/.tday/coworkers/{id}.md
 *   - Online  (`online:*`):   persists to the online settings store
 *   - Custom  (`custom:*`):   persists to the custom settings store
 */
export function upsertCoworker(coworker: CoWorker): void {
  if (coworker.isBuiltIn || coworker.id.startsWith('builtin:')) {
    const overridePath = getUserOverridePath(coworker.id);
    const dir = dirname(overridePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(overridePath, coworker.systemPrompt, 'utf8');
    return;
  }
  if (coworker.id.startsWith('online:')) {
    const existing = loadOnlineCoworkers();
    const idx = existing.findIndex((c) => c.id === coworker.id);
    // Strip runtime-only fields before persisting
    const { cachedContent: _, cachedAt: __, ...toStore } = coworker;
    if (idx >= 0) { existing[idx] = toStore; } else { existing.push(toStore); }
    saveOnlineCoworkers(existing);
    return;
  }
  // Custom coworker
  const { cachedContent: _, cachedAt: __, ...toStore } = coworker;
  const existing = loadCustomCoworkers();
  const idx = existing.findIndex((c) => c.id === coworker.id);
  if (idx >= 0) { existing[idx] = toStore; } else { existing.push(toStore); }
  saveCustomCoworkers(existing);
}

/** Delete a non-builtin coworker by id. Also cleans up its URL cache file if present. */
export function deleteCoworker(id: string): void {
  if (BUILTIN_MAP.has(id)) return;
  if (PRESET_ONLINE_MAP.has(id)) return; // preset online coworkers cannot be deleted
  if (id.startsWith('online:')) {
    saveOnlineCoworkers(loadOnlineCoworkers().filter((c) => c.id !== id));
  } else {
    saveCustomCoworkers(loadCustomCoworkers().filter((c) => c.id !== id));
  }
  // Clean up URL cache file if present
  try { unlinkSync(getUrlCachePath(id)); } catch { /* ignore */ }
}

/** Reset a built-in to its preset by deleting the user override file. */
export function resetBuiltinCoworker(id: string): void {
  if (!BUILTIN_MAP.has(id)) return;
  const overridePath = getUserOverridePath(id);
  if (existsSync(overridePath)) {
    try { unlinkSync(overridePath); } catch {}
  }
}

/** Resolve a coworker by id (any kind), with effective content attached. */
export function resolveCoworker(id: string): CoWorker | undefined {
  const builtin = BUILTIN_MAP.get(id);
  if (builtin) {
    return {
      ...builtin,
      systemPrompt: readEffectiveBuiltinContent(builtin),
      hasUserOverride: existsSync(getUserOverridePath(id)),
    };
  }
  const preset = PRESET_ONLINE_MAP.get(id);
  if (preset) {
    // Allow URL override from the online store
    const override = loadOnlineCoworkers().find((c) => c.id === id);
    const effectiveUrl = override?.url ?? preset.url;
    return { ...preset, url: effectiveUrl, cachedContent: readUrlCacheContent(id) || undefined, cachedAt: getUrlCacheMtime(id) };
  }
  if (id.startsWith('online:')) {
    const cw = loadOnlineCoworkers().find((c) => c.id === id);
    if (!cw) return undefined;
    return { ...cw, cachedContent: readUrlCacheContent(id) || undefined, cachedAt: getUrlCacheMtime(id) };
  }
  const cw = loadCustomCoworkers().find((c) => c.id === id);
  if (!cw) return undefined;
  if (cw.url) return { ...cw, cachedContent: readUrlCacheContent(id) || undefined, cachedAt: getUrlCacheMtime(id) };
  return cw;
}

/** Strip YAML frontmatter (--- … ---) from markdown/SKILL.md content. */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return content;
  return content.slice(end + 4).trimStart();
}

/**
 * Build the effective prompt by prepending the CoWorker system prompt (if any)
 * to the user's task prompt.
 */
export function buildEffectivePrompt(coworkerId: string | undefined, taskPrompt: string): string {
  if (!coworkerId) return taskPrompt;
  const coworker = resolveCoworker(coworkerId);
  if (!coworker) return taskPrompt;
  let systemPrompt = coworker.systemPrompt;
  if (coworkerId.startsWith('online:') || coworker.url) {
    // URL-backed: prefer cached file content; strip YAML frontmatter (e.g. SKILL.md files)
    systemPrompt = stripFrontmatter(readUrlCacheContent(coworkerId) || coworker.systemPrompt || '');
  } else if (!coworker.isBuiltIn && coworker.promptFile) {
    try { systemPrompt = readFileSync(coworker.promptFile, 'utf8'); } catch { /* fall back */ }
  }
  if (!systemPrompt) return taskPrompt;
  if (!taskPrompt.trim()) return systemPrompt;
  return `${systemPrompt}\n\n---\nYour task:\n\n${taskPrompt}`;
}
