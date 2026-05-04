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
 * Convert a GitHub /blob/ URL to a raw.githubusercontent.com URL.
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
 * Build an ordered list of raw URLs to try for a given coworker URL.
 * - Specific /blob/ URLs → single raw URL.
 * - Bare repo URLs (github.com/owner/repo) → try SKILL.md / AGENT.md on main then master.
 * - Already raw or non-GitHub → returned as-is.
 */
function buildFetchUrls(url: string): string[] {
  const trimmed = url.trim();
  const blobRe = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/.+$/;
  if (blobRe.test(trimmed)) return [normalizeGitHubUrl(trimmed)];

  if (trimmed.includes('raw.githubusercontent.com') || !trimmed.includes('github.com')) {
    return [trimmed];
  }

  // Bare repo URL: try common skill/agent file locations across main and master
  const repoRe = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/;
  const m = trimmed.match(repoRe);
  if (m) {
    const base = `https://raw.githubusercontent.com/${m[1]}/${m[2]}`;
    return [
      `${base}/main/SKILL.md`,
      `${base}/master/SKILL.md`,
      `${base}/main/AGENT.md`,
      `${base}/master/AGENT.md`,
    ];
  }
  return [trimmed];
}

/**
 * Fetch a GitHub (or raw) URL, write content to the local cache, return content.
 * For bare repo URLs, automatically tries multiple candidate file paths in order.
 */
export async function refreshCoworkerUrlCache(id: string, url: string): Promise<string> {
  const candidates = buildFetchUrls(url);
  let lastErr: Error | undefined;
  for (const rawUrl of candidates) {
    const res = await fetch(rawUrl);
    if (res.ok) {
      const content = await res.text();
      const cachePath = getUrlCachePath(id);
      mkdirSync(dirname(cachePath), { recursive: true });
      writeFileSync(cachePath, content, 'utf8');
      return content;
    }
    lastErr = new Error(`HTTP ${res.status}: ${rawUrl}`);
  }
  throw lastErr ?? new Error(`Failed to fetch: ${url}`);
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
    // Refresh registry (CoWorkers.md)
    try { await refreshCoworkersRegistry(); } catch { /* silently skip */ }
    // Refresh user-added online coworkers
    const online = loadOnlineCoworkers().filter((c) => !getPresetOnlineMap().has(c.id));
    for (const cw of online) {
      if (!cw.url) continue;
      const mtime = getUrlCacheMtime(cw.id);
      if (mtime && Date.now() - mtime < CACHE_STALE_MS) continue;
      try { await refreshCoworkerUrlCache(cw.id, cw.url); } catch { /* silently skip */ }
    }
    // Refresh preset online coworkers (use URL override from store if present)
    const onlineStore = loadOnlineCoworkers();
    for (const cw of getPresetOnlineCoworkers()) {
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
  // ── Thinking Frameworks ──────────────────────────────────────────────────
  {
    id: 'online:elon-musk',
    name: 'Elon Musk.skill',
    emoji: '🚀',
    description: 'First-principles thinking: rebuild problems from ground-up assumptions',
    isPreset: true,
    category: 'Thinking Frameworks',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/alchaincyf/elon-musk-skill',
  },
  {
    id: 'online:steve-jobs',
    name: 'Steve Jobs.skill',
    emoji: '🍎',
    description: 'Product/design/strategy thinking: radical simplicity and user experience',
    isPreset: true,
    category: 'Thinking Frameworks',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/alchaincyf/steve-jobs-skill',
  },
  {
    id: 'online:munger',
    name: 'Charlie Munger.skill',
    emoji: '🦉',
    description: 'Mental models and inversion: multi-disciplinary decision frameworks',
    isPreset: true,
    category: 'Thinking Frameworks',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/alchaincyf/munger-skill',
  },
  {
    id: 'online:feynman',
    name: 'Feynman.skill',
    emoji: '🔬',
    description: 'Feynman technique: truth-seeking through explanation and first-hand understanding',
    isPreset: true,
    category: 'Thinking Frameworks',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/alchaincyf/feynman-skill',
  },
  // ── Investment & Business ────────────────────────────────────────────────
  {
    id: 'online:buffett',
    name: 'Buffett OS',
    emoji: '💎',
    description: 'Warren Buffett investment framework: moats, margin of safety, long-term compounding',
    isPreset: true,
    category: 'Investment & Business',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/will2025btc/buffett-perspective',
  },
  {
    id: 'online:naval',
    name: 'Naval.skill',
    emoji: '⚡',
    description: 'Wealth creation, leverage, and life philosophy distilled from Naval Ravikant',
    isPreset: true,
    category: 'Investment & Business',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/alchaincyf/naval-skill',
  },
  {
    id: 'online:paul-graham',
    name: 'Paul Graham.skill',
    emoji: '🌱',
    description: 'Startup thinking from the YC founder: 0-to-1 and product intuition',
    isPreset: true,
    category: 'Investment & Business',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/alchaincyf/paul-graham-skill',
  },
  // ── AI & Engineering ─────────────────────────────────────────────────────
  {
    id: 'online:karpathy',
    name: 'Karpathy.skill',
    emoji: '🧠',
    description: 'Think before coding, simplicity first, surgical changes, goal-driven execution',
    isPreset: true,
    category: 'AI & Engineering',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/forrestchang/andrej-karpathy-skills/blob/main/skills/karpathy-guidelines/SKILL.md',
  },
  {
    id: 'online:devin-planner',
    name: 'Devin-style Planner',
    emoji: '🤖',
    description: 'Automated planning, self-evolving scratchpad, agentic multi-step execution',
    isPreset: true,
    category: 'AI & Engineering',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/grapeot/devin.cursorrules/blob/master/.cursorrules',
  },
  // ── Investment Analysis ──────────────────────────────────────────────────
  {
    id: 'online:earnings-analyst',
    name: 'Earnings Call Analyst',
    emoji: '📈',
    description: 'Equity analyst: decode earnings calls, detect management tone shifts and red flags',
    isPreset: true,
    category: 'Investment Analysis',
    kind: 'online',
    systemPrompt: '',
    url: 'https://github.com/danielmiessler/fabric/blob/main/data/patterns/concall_summary/system.md',
  },
];

// ── CoWorkers registry (CoWorkers.md from GitHub, bundled as fallback) ────────

const REGISTRY_URL =
  'https://raw.githubusercontent.com/unbug/tday/main/CoWorkers.md';

/**
 * Derive a stable, unique ID slug for a registry entry from its URL.
 * - GitHub /blob/ URLs: `repo-pathdiscriminator` (parent dir for generic filenames, filename otherwise)
 * - Bare repo URLs: just the repo name
 */
function deriveRegistrySlug(url: string): string {
  const blobMatch = url.match(/^https?:\/\/github\.com\/[^/]+\/([^/]+)\/blob\/[^/]+\/(.+)$/);
  if (blobMatch) {
    const repo = blobMatch[1];
    const filePath = blobMatch[2];
    const segments = filePath.split('/').filter(Boolean);
    // Root-level file (e.g. SKILL.md, .cursorrules) — repo name is sufficient
    if (segments.length === 1) {
      return repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    }
    // Multi-segment: use parent dir as discriminator for generic leaf names
    const leaf = decodeURIComponent(segments[segments.length - 1]).replace(/^\./, '').replace(/\.[^.]+$/, '').toLowerCase();
    const parent = decodeURIComponent(segments[segments.length - 2]).toLowerCase();
    const genericLeaves = ['system', 'index', 'readme', 'prompt', 'cursorrules', 'skill', 'agent', ''];
    const discriminator = genericLeaves.includes(leaf) ? parent : leaf;
    const cleanRepo = repo.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const cleanDisc = discriminator.replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return cleanDisc ? `${cleanRepo}-${cleanDisc}` : cleanRepo;
  }
  const repoMatch = url.match(/^https?:\/\/(?:github\.com|raw\.githubusercontent\.com)\/[^/]+\/([^/?#]+)/);
  if (repoMatch) {
    return repoMatch[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  }
  return url.replace(/\/$/, '').split('/').pop()!.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/** Path to the locally cached registry file. */
function getRegistryCachePath(): string {
  return join(homedir(), '.tday', 'coworkers', 'registry.md');
}

/** Path to the bundled fallback registry file shipped with the app. */
function getBundledRegistryPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'CoWorkers.md');
  return join(app.getAppPath(), 'resources', 'CoWorkers.md');
}

/**
 * Parse the CoWorkers.md registry format.
 * Supports both plain pipe-separated lines and Markdown table rows.
 * Header rows (starting with '#', containing 'category', or separator rows like |---|) are skipped.
 * Each data line must have 5 fields: category|emoji|name|description|url
 * Returns an array of CoWorker presets (id derived from the url slug).
 */
export function parseCoworkersRegistry(text: string): CoWorker[] {
  const results: CoWorker[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Skip Markdown table separator rows (e.g. |---|---|)
    if (/^\|[-| ]+\|$/.test(line)) continue;
    // Strip leading/trailing pipe for Markdown table rows
    const stripped = line.startsWith('|') && line.endsWith('|') ? line.slice(1, -1) : line;
    const parts = stripped.split('|');
    if (parts.length < 5) continue;
    const [category, emoji, name, description, url] = parts.map((p) => p.trim());
    // Skip header row
    if (name === 'name' || url === 'url') continue;
    if (!name || !url) continue;
    const id = `online:${deriveRegistrySlug(url)}`;
    results.push({
      id,
      name,
      emoji: emoji || '🌐',
      description: description || '',
      category: category || undefined,
      isPreset: true,
      kind: 'online',
      systemPrompt: '',
      url,
    });
  }
  return results;
}

/**
 * Load registry presets: prefer the locally cached registry (fetched at runtime),
 * fall back to the bundled copy shipped with the app.
 * Falls back to the hardcoded PRESET_ONLINE_COWORKERS list if neither is available.
 */
function loadRegistryPresets(): CoWorker[] {
  // Load both cache and bundled; use whichever has more entries.
  // This ensures a corrupted/stale cache (fewer entries) never beats the bundled file.
  let cacheEntries: CoWorker[] = [];
  let bundledEntries: CoWorker[] = [];
  const cachePath = getRegistryCachePath();
  if (existsSync(cachePath)) {
    try { cacheEntries = parseCoworkersRegistry(readFileSync(cachePath, 'utf8')); } catch { /* skip */ }
  }
  try { bundledEntries = parseCoworkersRegistry(readFileSync(getBundledRegistryPath(), 'utf8')); } catch { /* skip */ }
  // Prefer cache when it has >= bundled (more recently fetched from GitHub)
  const best = cacheEntries.length >= bundledEntries.length ? cacheEntries : bundledEntries;
  if (best.length > 0) return applyStarsCache(best);
  return applyStarsCache(PRESET_ONLINE_COWORKERS);
}

// ── GitHub stars cache ────────────────────────────────────────────────────────

const STARS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface StarsCacheEntry { stars: number; fetchedAt: number }
type StarsCache = Record<string, StarsCacheEntry>;

function getStarsCachePath(): string {
  return join(homedir(), '.tday', 'coworkers', 'stars.json');
}

function loadStarsCache(): StarsCache {
  try {
    const text = readFileSync(getStarsCachePath(), 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as StarsCache;
  } catch { /* fall through */ }
  return {};
}

function writeStarsCache(cache: StarsCache): void {
  try {
    const p = getStarsCachePath();
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/** Extract `owner/repo` from a github.com URL. Returns undefined for non-GitHub URLs. */
function extractRepoSlug(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/^https?:\/\/(?:github\.com|raw\.githubusercontent\.com)\/([^/]+)\/([^/?#]+)/);
  if (!m) return undefined;
  return `${m[1]}/${m[2]}`;
}

/** Mutate-and-return a list with githubStars filled in from the on-disk cache. */
function applyStarsCache(list: CoWorker[]): CoWorker[] {
  const cache = loadStarsCache();
  return list.map((c) => {
    const slug = extractRepoSlug(c.url);
    if (!slug) return c;
    const entry = cache[slug];
    if (!entry) return c;
    return { ...c, githubStars: entry.stars };
  });
}

/**
 * Refresh GitHub star counts for all unique repos in the current registry.
 * Stale entries (>TTL) are re-fetched in parallel from the public GitHub API.
 * Updates `_registryPresets` in place so cards reflect fresh numbers.
 */
async function refreshGitHubStars(): Promise<void> {
  const cache = loadStarsCache();
  const slugs = new Set<string>();
  for (const c of _registryPresets) {
    const slug = extractRepoSlug(c.url);
    if (slug) slugs.add(slug);
  }
  const now = Date.now();
  const stale = [...slugs].filter((slug) => {
    const e = cache[slug];
    return !e || now - e.fetchedAt > STARS_CACHE_TTL_MS;
  });
  if (stale.length === 0) {
    // Still apply current cache to in-memory list
    _registryPresets = applyStarsCache(_registryPresets);
    _registryMap = new Map(_registryPresets.map((c) => [c.id, c]));
    return;
  }
  const headers: Record<string, string> = { 'User-Agent': 'tday-app' };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  await Promise.all(stale.map(async (slug) => {
    try {
      const res = await fetch(`https://api.github.com/repos/${slug}`, { headers });
      if (!res.ok) return;
      const json = await res.json() as { stargazers_count?: number };
      if (typeof json.stargazers_count === 'number') {
        cache[slug] = { stars: json.stargazers_count, fetchedAt: now };
      }
    } catch { /* skip on failure */ }
  }));
  writeStarsCache(cache);
  _registryPresets = applyStarsCache(_registryPresets);
  _registryMap = new Map(_registryPresets.map((c) => [c.id, c]));
}

/**
 * Fetch the latest CoWorkers.md registry from GitHub and cache it locally.
 * On success, reloads the in-memory preset list so the next listAllCoworkers()
 * call reflects the fresh data without requiring an app restart.
 */
export async function refreshCoworkersRegistry(): Promise<void> {
  const res = await fetch(REGISTRY_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${REGISTRY_URL}`);
  const text = await res.text();
  const parsed = parseCoworkersRegistry(text);
  if (parsed.length === 0) return; // don't overwrite with an empty/broken list
  const cachePath = getRegistryCachePath();
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, text, 'utf8');
  // Hot-reload in-memory presets (with stars from cache)
  _registryPresets = applyStarsCache(parsed);
  _registryMap = new Map(_registryPresets.map((c) => [c.id, c]));
  // Also refresh stars in the background (non-blocking for the registry refresh).
  await refreshGitHubStars();
}

/**
 * Force-reload the in-memory registry from the bundled CoWorkers.md file,
 * bypassing the runtime cache. Used as fallback when GitHub is unavailable.
 */
export function reloadRegistryFromBundled(): void {
  try {
    const text = readFileSync(getBundledRegistryPath(), 'utf8');
    const parsed = parseCoworkersRegistry(text);
    if (parsed.length > 0) {
      _registryPresets = applyStarsCache(parsed);
      _registryMap = new Map(_registryPresets.map((c) => [c.id, c]));
    }
  } catch { /* ignore */ }
}

// In-memory registry state (mutable, updated by refreshCoworkersRegistry)
let _registryPresets: CoWorker[] = loadRegistryPresets();
let _registryMap: Map<string, CoWorker> = new Map(_registryPresets.map((c) => [c.id, c]));

/** Returns the current in-memory preset online coworkers (registry-backed). */
function getPresetOnlineCoworkers(): CoWorker[] { return _registryPresets; }
/** Returns the current in-memory preset online map. */
function getPresetOnlineMap(): Map<string, CoWorker> { return _registryMap; }


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
  const presetOnline = getPresetOnlineCoworkers().map((cw) => {
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
    .filter((c) => !getPresetOnlineMap().has(c.id))
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
  if (getPresetOnlineMap().has(id)) return; // preset online coworkers cannot be deleted
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
  const preset = getPresetOnlineMap().get(id);
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
