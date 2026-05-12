/**
 * Computer Use — MCP server injection for agent harnesses.
 *
 * Injects `tday-nativecore` as an MCP server into each agent's config
 * before spawn and cleans up after the PTY exits.
 *
 * Supported agents:
 *  - claude-code  : per-session temp settings file (already managed by index.ts)
 *  - gemini       : ~/.gemini/settings.json  mcpServers  (ref-counted)
 *  - opencode     : {XDG_CONFIG_HOME}/opencode/opencode.json  mcp.servers  (ref-counted)
 *
 * Settings key:  'tday:computerUseEnabled'  →  boolean
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import * as http from 'node:http';
import * as https from 'node:https';
import { app } from 'electron';
import type { AgentId } from '@tday/shared';

// ── Public constants ──────────────────────────────────────────────────────────

/** Key used to enable/disable Computer Use in tday settings. */
export const COMPUTER_USE_SETTING_KEY = 'tday:computerUseEnabled';

/** Name under which we register the injected MCP server in each agent. */
export const MCP_SERVER_KEY = 'tday-computer-use';

/** Agents that support Computer Use injection. */
export const COMPUTER_USE_AGENTS: AgentId[] = ['claude-code', 'gemini', 'opencode', 'codex', 'pi'];

// ── Skill content ────────────────────────────────────────────────────────────

/**
 * Instruction injected into every agent when Computer Use is enabled.
 * Tells the agent what MCP tools exist and how to use them.
 */
export const COMPUTER_USE_SKILL = `\
You have computer use capabilities via the \`${MCP_SERVER_KEY}\` MCP server.
These tools let you control the desktop, browsers, and Android devices on macOS, Windows, and Linux.

## Decision tree — pick the right approach first

\`\`\`
Need to READ all text from a document/page/terminal?
  └─ get_page_content   ← fastest: Select-All + Copy, zero permissions, any app

Need to CLICK a labelled button/link/item?
  └─ click_text {text}  ← single call, finds + clicks in one step (AX → OCR fallback)

Need to TYPE into a text field?
  ├─ If the field is already focused:
  │    ax_focused → ax_set_value {uid, value}      ← cheapest: no tree walk
  ├─ If you know the label of the field:
  │    ax_find {text: "label", role: "textfield"}  ← targeted search, no full dump
  │    → ax_set_value / ax_click on returned uid
  └─ Fallback: type_text {text, x, y, clear: true}

Need to interact with a specific element in a running app?
  ├─ 1st — ax_find {text?, role?}   ← targeted AX search; far smaller than full snapshot
  │         Returns only matching elements with UIDs ready for ax_click / ax_set_value
  │
  ├─ 2nd — ax_focused               ← if element is already focused; 1-node response
  │
  ├─ 3rd — take_ax_snapshot {max_depth: 3}  ← shallow first look (fast); re-run without max_depth only if needed
  │         Then: ax_click / ax_set_value / ax_select / ax_perform_action
  │
  ├─ 4th — Visual + Mouse/Keyboard (universal fallback when AX gives empty tree):
  │         find_text → click / type_text / shortcut / scroll / drag
  │         Use when: AX unsupported, canvas/game/image-based UI
  │
  └─ LAST RESORT — CDP (only Chrome/Electron web content, AX+Visual both failed):
       probe_app → cdp_connect → cdp_find_elements / cdp_fill / cdp_click
\`\`\`

> ⚠️ **Avoid calling \`take_screenshot\` as a first step.** Screenshots are slow, require
> Screen Recording permission on macOS, and usually aren't needed — use \`find_text\`,
> \`ax_find\`, or \`get_page_content\` instead.
>
> ⚠️ **Prefer \`ax_find\` over \`take_ax_snapshot\`** when you know what you're looking for.
> \`ax_find\` stops walking as soon as \`max_results\` is reached; \`take_ax_snapshot\` always
> traverses the full tree (up to 10,000 nodes).  If you must snapshot an unknown UI,
> start with \`max_depth: 3\` and drill deeper only when needed.

## Core tools reference

### Text reading (no screenshot needed)
| Tool | When to use |
|------|-------------|
| \`get_page_content\` | **Fastest text extraction** — Select-All+Copy. Read entire document, terminal, browser page. No permissions needed. Works on all platforms. |
| \`find_text\` | Locate specific text on screen by AX tree search (OCR fallback). Returns \`{x,y,bounds}\` without screenshot. |

### Accessibility (AX) — preferred for all native and Electron apps
| Tool | Cost | When to use |
|------|------|-------------|
| \`ax_focused\` | **Cheapest** (1 element) | Interact with currently focused element — active text field, button, etc. |
| \`ax_find\` | **Targeted** (matching elements only, early-exit walk) | Find specific buttons/fields/items by text or role. Much smaller than full snapshot. |
| \`take_ax_snapshot\` | **Full tree** (up to 10k nodes) | Explore unknown UI structure when you don't know what's there. Use \`max_depth: 3\` first for a quick overview. |
| \`ax_click\` | — | Click element by uid from ax_find / ax_focused / snapshot |
| \`ax_set_value\` | — | Type into text field by uid (no coordinates needed) |
| \`ax_select\` | — | Select/open menu item, tab, or list row by uid |
| \`ax_perform_action\` | — | Run any AX action: \`"AXPress"\`, \`"AXIncrement"\`, \`"AXShowMenu"\`, etc. |

### Mouse & Keyboard
| Tool | Notes |
|------|-------|
| \`click_text\` | **Find + click in one call** — no need to extract coordinates. AX → OCR fallback. |
| \`click\` | Click at \`(x,y)\`. \`button\`: left/right/middle. \`click_count: 2\` = double-click |
| \`type_text\` | Set \`x,y\` to click-to-focus first. \`clear: true\` replaces existing text. \`press_enter: true\` submits. |
| \`shortcut\` | e.g. \`"command+c"\`, \`"ctrl+shift+s"\`, \`"return"\` — always prefer this over press_key for combos |
| \`scroll\` | Use \`direction\` + \`wheel_times\` (preferred) over raw \`delta_x/delta_y\` |
| \`drag\` | Drag-and-drop, slider adjustment, list reordering |

### App management
| Tool | Notes |
|------|-------|
| \`list_apps\` | Check what's running before launching |
| \`launch_app\` | Open by display name. Returns PID |
| \`focus_window\` | Bring a window to front (use \`list_windows\` to get \`window_id\`) |
| \`resize_window\` | Position/size a window by app name |
| \`quit_app\` | \`force: true\` = SIGKILL equivalent |

### Screen & Vision (use only as fallback)
| Tool | When to use |
|------|-------------|
| \`take_screenshot\` | **Last resort** — only when AX gives empty tree AND find_text fails (canvas, game, PDF, fully custom-drawn UI). Never use as a routine first step. |
| \`find_image\` | Match a template sub-image to locate icons/buttons visually |
| \`element_at_point\` | Identify the AX element at given screen coords |

### CDP — Chrome/Electron apps (last resort)
| Tool | Notes |
|------|-------|
| \`probe_app\` | Returns \`{kind: "Electron"|"Chrome"|"Native"}\` and debug port. Run this first |
| \`cdp_connect\` | Connect to the debug port returned by probe_app |
| \`cdp_find_elements\` | Text/CSS-like query search. Returns elements with \`uid\` values |
| \`cdp_click\` | Click element by \`uid\`. More reliable than pixel coords in web UIs |
| \`cdp_fill\` | Fill an input field by \`uid\` |
| \`cdp_evaluate_script\` | Run arbitrary JS in the page |

### System utilities
| Tool | Notes |
|------|-------|
| \`execute_command\` | Run shell commands (\`mode: "shell"\`) or AppleScript (\`mode: "osascript"\`) |
| \`clipboard\` | \`mode: "get"\` / \`mode: "set"\` — read or write clipboard text (macOS, Windows, Linux) |
| \`sys_process\` | List/kill processes |
| \`filesystem\` | Read, write, list, search files — use instead of shell when the path is known |
| \`scrape\` | Fetch a URL and return its body as text |
| \`sys_wait\` | Pause between actions. Use after launching apps or triggering animations (\`duration: 0.5\`–\`2\`) |

### Android (requires connected device via ADB)
Use \`android_list_devices\` first, then \`android_connect\`.
Tools: \`android_screenshot\`, \`android_click\`, \`android_type_text\`, \`android_find_text\`, \`android_launch_app\`.

## Common task patterns

**Read full content of current document/page**
\`\`\`
get_page_content {}
// → { text: "...all text...", length: N }
// Fastest: Select-All + Copy. No screenshot, no OCR, no AX traversal.
\`\`\`

**Click a button or link by its label (simplest)**
\`\`\`
click_text {text: "Submit"}          // find + click in one call
click_text {text: "OK", button: "left", click_count: 1}
\`\`\`

**Type into the currently focused text field**
\`\`\`
ax_focused {}
// → { focused: { uid: "a0g3", role: "AXTextField", ... } }
ax_set_value { uid: "a0g3", value: "hello world" }
\`\`\`

**Find and fill a specific text field**
\`\`\`
ax_find { text: "Search", role: "textfield" }
// → { elements: [{ uid: "a5g3", role: "AXTextField", label: "Search" }], ... }
ax_set_value { uid: "a5g3", value: "my query" }
\`\`\`

**Open an app and interact with it**
\`\`\`
1. list_apps                               // check if already running
2. launch_app {app_name}                   // if not running
3. sys_wait {duration: 1}                  // let the window appear
4. ax_find {role: "button", text: "Login"} // targeted search — NOT full snapshot
   OR click_text {text: "Login"}           // even simpler
5. ax_click {uid}  OR  click_text          // interact
6. verify cheaply: find_text {text: "..."} // NOT a full screenshot
\`\`\`

**Fill a web form in Chrome/Electron**
\`\`\`
1. probe_app {app_name}               // get debug port
2. cdp_connect {port}                 // establish CDP session
3. cdp_find_elements {query: "..."}   // locate input fields
4. cdp_fill {uid, value}              // fill each field
5. cdp_click {uid}                    // submit
6. find_text {text: "success"}        // verify — avoid screenshot
\`\`\`

**Keyboard shortcut / menu action**
\`\`\`
shortcut {shortcut: "command+s"}          // Save (macOS)
shortcut {shortcut: "ctrl+s"}             // Save (Windows/Linux)
shortcut {shortcut: "command+shift+p"}    // VS Code command palette
\`\`\`

**Explore unknown UI structure (when ax_find / click_text are not enough)**
\`\`\`
// Step 1 — shallow snapshot first: fast, small response
take_ax_snapshot { max_depth: 3 }
// → tree with ~3 levels; identify the region / container you need

// Step 2 — if you found the element → act immediately
ax_click { uid: "a7g3" }
// OR if the subtree is still incomplete, narrow down and go deeper:

// Step 3 — try ax_find on what you found
ax_find { text: "Save", role: "button" }
// → only returns matching nodes, much smaller than full tree

// Step 4 — full snapshot only if absolutely necessary
take_ax_snapshot {}          // no max_depth → full tree (up to 10k nodes)
\`\`\`

## Reliability rules
- **\`get_page_content\` to read text** — fastest, zero permissions, works in any app.
- **\`click_text\` to click by label** — single call, no need to look up coordinates first.
- **\`ax_focused\` or \`ax_find\` before \`take_ax_snapshot\`** — always try targeted queries first; if you must snapshot use \`max_depth: 3\` first, then remove the limit only when you need to go deeper.
- **Never screenshot as first step** — use \`find_text\`, \`ax_find\`, or \`get_page_content\` first.
- **Verify cheaply** — check with \`find_text\` or an AX value query. Only escalate to screenshot if needed.
- **Prefer uid-based AX actions over pixel clicks** — AX uids survive window moves; coordinates don't.
- **Use \`sys_wait\`** after launching apps, opening dialogs, or triggering animations before the next action.
- **If \`take_screenshot\` returns black/blank**: Screen Recording permission is missing. Direct the user to: System Settings → Privacy & Security → Screen Recording.
`.trim();


// ── Skill file management (lifecycle: toggle on/off, not per-session) ─────────

const SKILL_MARKER = COMPUTER_USE_SETTING_KEY; // unique string for HTML comment markers

/** Write a standalone skill file. Idempotent. */
function writeSkillFile(filePath: string, dir: string, content: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, content, 'utf8');
  } catch (e) {
    console.warn(`[tday] computer-use: could not write skill file ${filePath}:`, e);
  }
}

/** Remove a skill file written by writeSkillFile. */
function removeSkillFile(filePath: string): void {
  try { rmSync(filePath); } catch { /* already gone */ }
}

/**
 * Add or remove a file path from the `instructions` array in opencode.json.
 * Opencode auto-loads every path listed in `config.instructions` as a system
 * instruction file — this is how we inject the SKILL into opencode.
 */
function patchOpencodeInstructions(configFilePath: string, skillFilePath: string, add: boolean): void {
  try {
    if (!add && !existsSync(configFilePath)) return;
    mkdirSync(dirname(configFilePath), { recursive: true });
    let doc: Record<string, unknown> = {};
    try { doc = JSON.parse(readFileSync(configFilePath, 'utf8')) as Record<string, unknown>; } catch { /* new or missing */ }
    let instructions: string[] = Array.isArray(doc['instructions']) ? (doc['instructions'] as string[]) : [];
    if (add) {
      if (!instructions.includes(skillFilePath)) {
        instructions = [...instructions, skillFilePath];
      }
    } else {
      instructions = instructions.filter(p => p !== skillFilePath);
    }
    if (instructions.length > 0) {
      doc['instructions'] = instructions;
    } else {
      delete doc['instructions'];
    }
    writeFileSync(configFilePath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.warn(`[tday] computer-use: could not patch ${configFilePath}:`, e);
  }
}

/**
 * Append a fenced block (delimited by HTML comment markers) to a Markdown
 * instructions file such as ~/.codex/instructions.md.
 * If the block is already present it is updated in-place — safe to call
 * multiple times and across restarts.
 */
function appendMarkdownBlock(filePath: string, dir: string, content: string): void {
  const open = `<!-- ${SKILL_MARKER}:start -->`;
  const close = `<!-- ${SKILL_MARKER}:end -->`;
  try {
    mkdirSync(dir, { recursive: true });
    let existing = '';
    try { existing = readFileSync(filePath, 'utf8'); } catch { /* new file */ }
    const blockRe = new RegExp(`${open}[\\s\\S]*?${close}`, 'g');
    const block = `${open}\n${content}\n${close}`;
    if (existing.includes(open)) {
      writeFileSync(filePath, existing.replace(blockRe, block), 'utf8');
    } else {
      writeFileSync(filePath, `${existing}\n\n${block}\n`, 'utf8');
    }
  } catch (e) {
    console.warn(`[tday] computer-use: could not update ${filePath}:`, e);
  }
}

/** Remove the fenced block previously written by appendMarkdownBlock. */
function removeMarkdownBlock(filePath: string): void {
  const open = `<!-- ${SKILL_MARKER}:start -->`;
  try {
    const existing = readFileSync(filePath, 'utf8');
    if (!existing.includes(open)) return;
    const close = `<!-- ${SKILL_MARKER}:end -->`;
    const blockRe = new RegExp(`\\n*${open}[\\s\\S]*?${close}\\n*`, 'g');
    const cleaned = existing.replace(blockRe, '\n').trimEnd();
    if (cleaned.trim() === '') {
      rmSync(filePath);
    } else {
      writeFileSync(filePath, `${cleaned}\n`, 'utf8');
    }
  } catch { /* file gone — nothing to do */ }
}

// ── MCP entry ─────────────────────────────────────────────────────────────────

/** Format used by claude-code and gemini. */
export interface McpEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

/** Format used by opencode (type + merged command array + enabled flag). */
export interface OpencodeMcpEntry {
  type: 'local';
  command: string[];
  enabled: boolean;
  environment?: Record<string, string>;
}

/** Returns the absolute path to the bundled `tday-nativecore` binary. */
export function devToolsBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'tday-nativecore.exe' : 'tday-nativecore';
  // `app` may be undefined when running in a Node.js test environment (vitest).
  if (typeof app !== 'undefined' && app?.isPackaged) {
    return join(process.resourcesPath, exe);
  }
  // Dev: cargo build output relative to the monorepo root
  return join(__dirname, '../../../../crates/tday-nativecore/target/release', exe);
}

/** Returns the MCP server definition for tday-nativecore (claude-code / gemini format). */
export function buildMcpEntry(): McpEntry {
  return { command: devToolsBinaryPath(), args: [] };
}

/** Returns the MCP server definition for tday-nativecore (opencode format). */
export function buildOpencodeMcpEntry(): OpencodeMcpEntry {
  return { type: 'local', command: [devToolsBinaryPath()], enabled: true };
}

// ── URL-based MCP entry types (for HTTP / streamable-http transport) ──────────

/**
 * MCP entry used when the nativecore is running as a shared HTTP server.
 * Claude Code uses the MCP spec field name `type` (not `transport`) to
 * identify streamable-HTTP servers.  Passing `transport` causes claude-code
 * to fall back to the stdio schema and report
 * "command: expected string, received undefined".
 */
export interface McpEntryUrl {
  url: string;
  type: 'http';
  headers?: Record<string, string>;
}

/**
 * Gemini CLI only accepts `{ url }` — any extra key (type, transport, …)
 * triggers "Unrecognized key(s)" validation errors.  Keep this type separate
 * from McpEntryUrl so callers can't accidentally mix them up.
 */
export interface GeminiMcpEntryUrl {
  url: string;
  headers?: Record<string, string>;
}

/** opencode format for a remote MCP server. */
export interface OpencodeMcpEntryUrl {
  type: 'remote';
  url: string;
  enabled: boolean;
  headers?: Record<string, string>;
}

/**
 * Returns a URL-based MCP entry for claude-code settings (streamable HTTP).
 * Uses `type: 'http'` per the MCP spec — claude-code requires this exact key.
 * Do NOT use this for Gemini; Gemini requires a different format (url only).
 */
export function buildMcpEntryUrl(url: string, authToken?: string | null): McpEntryUrl {
  if (authToken) {
    return { type: 'http', url, headers: { Authorization: `Bearer ${authToken}` } };
  }
  return { type: 'http', url };
}

/**
 * Returns a URL-based MCP entry for Gemini CLI settings.
 * Gemini only accepts `{ url }` — any extra key causes a validation error.
 */
export function buildGeminiMcpEntryUrl(url: string, authToken?: string | null): GeminiMcpEntryUrl {
  if (authToken) {
    return { url, headers: { Authorization: `Bearer ${authToken}` } };
  }
  return { url };
}

/** Returns a URL-based MCP entry for opencode (remote server). */
export function buildOpencodeMcpEntryUrl(url: string, authToken?: string | null): OpencodeMcpEntryUrl {
  if (authToken) {
    return { type: 'remote', url, enabled: true, headers: { Authorization: `Bearer ${authToken}` } };
  }
  return { type: 'remote', url, enabled: true };
}

/**
 * Returns the codex `-c` args to configure a remote MCP server by URL.
 * Includes an Authorization header if an auth token is provided.
 */
export function codexMcpCliArgsUrl(url: string, authToken?: string | null): string[] {
  const args = ['-c', `mcp_servers.${MCP_SERVER_KEY}.url=${url}`];
  if (authToken) {
    args.push('-c', `mcp_servers.${MCP_SERVER_KEY}.headers.Authorization=Bearer ${authToken}`);
  }
  return args;
}

// ── claude-code injection (per-session, no cleanup needed) ───────────────────

/**
 * Mutates a claude-code session-settings object to include the MCP server.
 * Called just before we write the per-session temp settings file in index.ts.
 *
 * Also injects ANTHROPIC_BETA so the Anthropic SDK allows image content in
 * tool_result blocks (required for screenshot-based Computer Use).
 *
 * @param isAnthropicBackend  Pass false when the effective provider is NOT
 *   Anthropic (e.g. LM Studio, Ollama, …).  In that case we skip the beta
 *   flag because non-Anthropic backends don't support the native
 *   `computer_use_20250124` tool type and will reject the request.
 */
export function applyClaudeCodeMcp(sessionSettings: Record<string, unknown>, isAnthropicBackend = true): void {
  const existing = (sessionSettings.mcpServers as Record<string, unknown>) ?? {};
  sessionSettings.mcpServers = { ...existing, [MCP_SERVER_KEY]: buildMcpEntry() };

  // Inject skill as custom instructions so the agent knows about the tools.
  const existingInstructions = typeof sessionSettings.customInstructions === 'string'
    ? sessionSettings.customInstructions : '';
  if (!existingInstructions.includes(MCP_SERVER_KEY)) {
    sessionSettings.customInstructions = existingInstructions
      ? `${existingInstructions}\n\n${COMPUTER_USE_SKILL}`
      : COMPUTER_USE_SKILL;
  }

  // Auto-allow all computer-use tool calls to avoid per-call approval prompts.
  const existingPerms = (sessionSettings.permissions as { allow?: string[]; deny?: string[] } | undefined) ?? {};
  const allowList = existingPerms.allow ?? [];
  const toolGlob = `mcp__${MCP_SERVER_KEY}__*`;
  if (!allowList.includes(toolGlob)) {
    sessionSettings.permissions = { ...existingPerms, allow: [...allowList, toolGlob] };
  }

  // Enable the computer-use beta so image tool_results are accepted by the API.
  // Skip for non-Anthropic backends: they don't understand computer_use_20250124
  // tool types and reject the request with "tools.N.type invalid_string".
  if (isAnthropicBackend) {
    const env = (sessionSettings.env as Record<string, string>) ?? {};
    const existingBeta = env['ANTHROPIC_BETA'] ?? '';
    const betaFlag = 'computer-use-2025-01-30';
    if (!existingBeta.split(',').map((s) => s.trim()).includes(betaFlag)) {
      env['ANTHROPIC_BETA'] = existingBeta ? `${existingBeta},${betaFlag}` : betaFlag;
    }
    sessionSettings.env = env;
  }
}

/**
 * URL variant of applyClaudeCodeMcp — uses an HTTP transport MCP entry.
 * Call this when NativecoreService is running in HTTP mode.
 */
export function applyClaudeCodeMcpUrl(
  sessionSettings: Record<string, unknown>,
  url: string,
  isAnthropicBackend = true,
  authToken?: string | null,
): void {
  const existing = (sessionSettings.mcpServers as Record<string, unknown>) ?? {};
  sessionSettings.mcpServers = { ...existing, [MCP_SERVER_KEY]: buildMcpEntryUrl(url, authToken) };

  // Inject skill as custom instructions.
  const existingInstructions = typeof sessionSettings.customInstructions === 'string'
    ? sessionSettings.customInstructions : '';
  if (!existingInstructions.includes(MCP_SERVER_KEY)) {
    sessionSettings.customInstructions = existingInstructions
      ? `${existingInstructions}\n\n${COMPUTER_USE_SKILL}`
      : COMPUTER_USE_SKILL;
  }

  // Auto-allow all computer-use tool calls.
  const existingPerms = (sessionSettings.permissions as { allow?: string[]; deny?: string[] } | undefined) ?? {};
  const allowList = existingPerms.allow ?? [];
  const toolGlob = `mcp__${MCP_SERVER_KEY}__*`;
  if (!allowList.includes(toolGlob)) {
    sessionSettings.permissions = { ...existingPerms, allow: [...allowList, toolGlob] };
  }

  if (isAnthropicBackend) {
    const env = (sessionSettings.env as Record<string, string>) ?? {};
    const existingBeta = env['ANTHROPIC_BETA'] ?? '';
    const betaFlag = 'computer-use-2025-01-30';
    if (!existingBeta.split(',').map((s) => s.trim()).includes(betaFlag)) {
      env['ANTHROPIC_BETA'] = existingBeta ? `${existingBeta},${betaFlag}` : betaFlag;
    }
    sessionSettings.env = env;
  }
}

// ── Global config file injection (ref-counted) ────────────────────────────────

/**
 * Tracks active injections per config file path.
 * count > 0 means the file is currently patched.
 */
const activeInjections = new Map<string, { count: number; original: string | null }>();

/**
 * Patch a JSON config file to add the MCP server entry at the given key path
 * (dot-separated, e.g. 'mcpServers' or 'mcp.servers').
 * Uses ref-counting so concurrent tabs don't clobber each other.
 * Returns a cleanup function that restores the original content when the last
 * session using this file exits.
 */
function injectMcpToFile(
  filePath: string,
  dir: string,
  keyPath: string,
  entry: Record<string, unknown> = buildMcpEntry() as unknown as Record<string, unknown>,
): () => void {
  const existing = activeInjections.get(filePath);

  if (existing && existing.count > 0) {
    // File is already patched — just increment the ref count.
    existing.count++;
    return makeCleanup(filePath);
  }

  // First injection: capture original and write patched content.
  let original: string | null = null;
  try {
    mkdirSync(dir, { recursive: true });
    try { original = readFileSync(filePath, 'utf8'); } catch { original = null; }

    const doc: Record<string, unknown> = original ? (JSON.parse(original) as Record<string, unknown>) : {};
    setNestedKey(doc, keyPath, (cur: Record<string, unknown>) => ({
      ...cur,
      [MCP_SERVER_KEY]: entry,
    }));
    writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
    activeInjections.set(filePath, { count: 1, original });
  } catch (e) {
    console.warn(`[tday] computer-use: could not patch ${filePath}:`, e);
    // Return no-op cleanup — we didn't successfully inject so nothing to restore.
    return () => { /* no-op */ };
  }

  return makeCleanup(filePath);
}

function makeCleanup(filePath: string): () => void {
  return () => {
    const entry = activeInjections.get(filePath);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count > 0) return; // other sessions still active

    activeInjections.delete(filePath);
    try {
      if (entry.original === null) {
        // File didn't exist before — remove only our key to avoid losing
        // any settings the agent may have written during its session.
        try {
          const cur = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
          // Walk all top-level mcp-like keys and remove our server key.
          removeServerKey(cur);
          writeFileSync(filePath, JSON.stringify(cur, null, 2), 'utf8');
        } catch { /* ignore — best effort */ }
      } else {
        writeFileSync(filePath, entry.original, 'utf8');
      }
    } catch (e) {
      console.warn(`[tday] computer-use: could not restore ${filePath}:`, e);
    }
  };
}

/** Recursively remove MCP_SERVER_KEY from any nested dict. */
function removeServerKey(obj: Record<string, unknown>): void {
  for (const k of Object.keys(obj)) {
    if (k === MCP_SERVER_KEY) {
      delete obj[k];
    } else if (obj[k] !== null && typeof obj[k] === 'object' && !Array.isArray(obj[k])) {
      removeServerKey(obj[k] as Record<string, unknown>);
    }
  }
}

/**
 * Navigate to the nested key described by a dot-separated path, creating
 * intermediate objects as needed, then apply `update` to the leaf object.
 */
function setNestedKey(
  doc: Record<string, unknown>,
  keyPath: string,
  update: (current: Record<string, unknown>) => Record<string, unknown>,
): void {
  const parts = keyPath.split('.');
  let obj: Record<string, unknown> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj[parts[i]] === null || typeof obj[parts[i]] !== 'object' || Array.isArray(obj[parts[i]])) {
      obj[parts[i]] = {};
    }
    obj = obj[parts[i]] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  const current = (obj[leaf] !== null && typeof obj[leaf] === 'object' && !Array.isArray(obj[leaf]))
    ? (obj[leaf] as Record<string, unknown>)
    : {};
  obj[leaf] = update(current);
}

// ── Per-agent public injection functions ─────────────────────────────────────

/**
 * Inject MCP into `~/.gemini/settings.json`.
 * Returns a cleanup function; must be called when the PTY exits.
 */
export function injectGeminiMcp(home?: string): () => void {
  const dir = join(home ?? homedir(), '.gemini');
  const filePath = join(dir, 'settings.json');
  return injectMcpToFile(filePath, dir, 'mcpServers');
}

/**
 * Inject a URL-based (HTTP transport) MCP entry into `~/.gemini/settings.json`.
 * Use this when NativecoreService is running in HTTP mode.
 * Returns a cleanup function; must be called when the PTY exits.
 */
export function injectGeminiMcpUrl(url: string, home?: string, authToken?: string | null): () => void {
  const dir = join(home ?? homedir(), '.gemini');
  const filePath = join(dir, 'settings.json');
  // Gemini CLI only accepts { url } — no type/transport field allowed.
  return injectMcpToFile(filePath, dir, 'mcpServers', buildGeminiMcpEntryUrl(url, authToken) as unknown as Record<string, unknown>);
}

/**
 * Inject MCP into opencode's config file.
 * Path: $XDG_CONFIG_HOME/opencode/opencode.json  (default: ~/.config/opencode/opencode.json)
 * Returns a cleanup function; must be called when the PTY exits.
 */
export function injectOpencodeMcp(home?: string): () => void {
  const xdgBase = process.env['XDG_CONFIG_HOME'] ?? join(home ?? homedir(), '.config');
  const dir = join(xdgBase, 'opencode');
  const filePath = join(dir, 'opencode.json');
  // opencode schema: { mcp: { "<name>": { type: "local", command: [...], enabled: true } } }
  return injectMcpToFile(
    filePath,
    dir,
    'mcp',
    buildOpencodeMcpEntry() as unknown as Record<string, unknown>,
  );
}

/**
 * Inject a URL-based MCP entry into opencode's config file (remote server).
 * Use this when NativecoreService is running in HTTP mode.
 * Returns a cleanup function; must be called when the PTY exits.
 */
export function injectOpencodeMcpUrl(url: string, home?: string, authToken?: string | null): () => void {
  const xdgBase = process.env['XDG_CONFIG_HOME'] ?? join(home ?? homedir(), '.config');
  const dir = join(xdgBase, 'opencode');
  const filePath = join(dir, 'opencode.json');
  // opencode schema (remote): { mcp: { "<name>": { type: "remote", url: "...", enabled: true } } }
  return injectMcpToFile(
    filePath,
    dir,
    'mcp',
    buildOpencodeMcpEntryUrl(url, authToken) as unknown as Record<string, unknown>,
  );
}

/**
 * Return the `-c` args needed to inject the Computer Use MCP server into a
 * codex invocation.  Codex supports arbitrary config overrides via
 * `-c key=value` (dotted TOML path).  Using CLI args instead of writing to
 * `~/.codex/config.toml` means the config is ephemeral — it only applies to
 * the spawned process and never persists when Tday is closed or crashes.
 */
export function codexMcpCliArgs(): string[] {
  const binaryPath = devToolsBinaryPath();
  // codex splits the key by '.'; hyphens are valid in bare TOML keys.
  return ['-c', `mcp_servers.${MCP_SERVER_KEY}.command=${JSON.stringify(binaryPath)}`];
}

// ── Global skill file management (called on toggle, not per-session) ──────────

/**
 * Write skill/instruction files for all agents that benefit from persistent context.
 * Call this when Computer Use is enabled (app startup or toggle on).
 * All writes are idempotent — safe to call repeatedly.
 */
export function writeComputerUseSkillFiles(home?: string): void {
  const h = home ?? homedir();

  // gemini: ~/.gemini/skills/<name>/SKILL.md  (auto-discovered by gemini-cli)
  const geminiSkillDir = join(h, '.gemini', 'skills', MCP_SERVER_KEY);
  writeSkillFile(
    join(geminiSkillDir, 'SKILL.md'),
    geminiSkillDir,
    `---\nname: ${MCP_SERVER_KEY}\ndescription: "Control native desktop apps, browsers and GUI elements via screenshots, click, type, AX dispatch and CDP."\n---\n\n${COMPUTER_USE_SKILL}\n`,
  );

  // opencode: write skill to ~/.config/opencode/<name>.md and register it in
  // opencode.json `instructions` array so opencode actually loads it.
  const xdgBase = process.env['XDG_CONFIG_HOME'] ?? join(h, '.config');
  const opencodeDir = join(xdgBase, 'opencode');
  const opencodeSkillPath = join(opencodeDir, `${MCP_SERVER_KEY}.md`);
  writeSkillFile(opencodeSkillPath, opencodeDir, `${COMPUTER_USE_SKILL}\n`);
  patchOpencodeInstructions(join(opencodeDir, 'opencode.json'), opencodeSkillPath, true);

  // codex: append a fenced block to ~/.codex/instructions.md
  const codexDir = join(h, '.codex');
  appendMarkdownBlock(join(codexDir, 'instructions.md'), codexDir, COMPUTER_USE_SKILL);

  // pi: ~/.pi/agent/skills/<name>/SKILL.md (auto-discovered by pi; name must match parent dir)
  const piSkillDir = join(h, '.pi', 'agent', 'skills', MCP_SERVER_KEY);
  writeSkillFile(
    join(piSkillDir, 'SKILL.md'),
    piSkillDir,
    `---\nname: ${MCP_SERVER_KEY}\ndescription: "Control native desktop apps, browsers and GUI elements via screenshots, click, type, AX dispatch and CDP."\n---\n\n${COMPUTER_USE_SKILL}\n`,
  );
}

/**
 * Remove all skill/instruction files written by writeComputerUseSkillFiles.
 * Call this when Computer Use is disabled (toggle off).
 */
export function removeComputerUseSkillFiles(home?: string): void {
  const h = home ?? homedir();

  // gemini
  removeSkillFile(join(h, '.gemini', 'skills', MCP_SERVER_KEY, 'SKILL.md'));

  // opencode: remove skill file and unregister from opencode.json instructions
  const xdgBase = process.env['XDG_CONFIG_HOME'] ?? join(h, '.config');
  const opencodeDir2 = join(xdgBase, 'opencode');
  const opencodeSkillPath2 = join(opencodeDir2, `${MCP_SERVER_KEY}.md`);
  removeSkillFile(opencodeSkillPath2);
  patchOpencodeInstructions(join(opencodeDir2, 'opencode.json'), opencodeSkillPath2, false);

  // codex
  removeMarkdownBlock(join(h, '.codex', 'instructions.md'));

  // pi
  removeSkillFile(join(h, '.pi', 'agent', 'skills', MCP_SERVER_KEY, 'SKILL.md'));
}

// ── Pi MCP bridge injection ───────────────────────────────────────────────────

/** Absolute path to the pi MCP bridge extension TypeScript file. */
function bridgeExtensionPath(): string {
  if (typeof app !== 'undefined' && app?.isPackaged) {
    return join(process.resourcesPath, 'pi-computer-use-bridge.ts');
  }
  // Dev / test environment: source tree relative to the compiled main output directory
  return join(__dirname, '../../resources/pi-computer-use-bridge.ts');
}

/**
 * Returns the `--extension` path and the required env var for pi Computer Use.
 * Call when spawning pi with Computer Use enabled; the returned cleanup is a no-op
 * (no external config file is mutated — the bridge is an ephemeral extension arg).
 *
 * Stdio fallback: the bridge spawns its own private nativecore process.
 */
export function injectPiMcp(): { extensionPath: string; env: Record<string, string>; cleanup: () => void } {
  return {
    extensionPath: bridgeExtensionPath(),
    env: { TDAY_DEVTOOLS_BIN: devToolsBinaryPath() },
    cleanup: () => { /* no persistent mutation — no cleanup needed */ },
  };
}

/**
 * URL variant of injectPiMcp — uses the shared HTTP nativecore server.
 * The bridge reads TDAY_DEVTOOLS_URL and connects over HTTP instead of
 * spawning its own stdio process, so all pi sessions share the global RwLock.
 *
 * Cleanup is a no-op here; the caller in index.ts calls NativecoreService.release().
 */
export function injectPiMcpUrl(url: string, authToken?: string | null): { extensionPath: string; env: Record<string, string> } {
  const env: Record<string, string> = { TDAY_DEVTOOLS_URL: url };
  if (authToken) {
    env['TDAY_DEVTOOLS_AUTH_TOKEN'] = authToken;
  }
  return {
    extensionPath: bridgeExtensionPath(),
    env,
  };
}

// ── Helper: check if Computer Use is enabled for an agent ────────────────────

/**
 * Returns `true` if Computer Use should be activated for the given agent
 * in this spawn, based on the tday settings map and whether the agent
 * supports injection.
 */
export function isComputerUseEnabled(
  settings: Record<string, unknown>,
  agentId: AgentId,
): boolean {
  if (!settings[COMPUTER_USE_SETTING_KEY]) return false;
  return (COMPUTER_USE_AGENTS as string[]).includes(agentId);
}

// ── Codex namespace-tool proxy ────────────────────────────────────────────────
//
// Codex always groups MCP tools as type:"namespace" in the Responses API request,
// but third-party providers (DeepSeek, LM Studio, etc.) only support type:"function".
//
// This proxy:
//   REQUEST  side: expands each namespace spec into individual function specs so
//                  providers that don't support the namespace type can still call them.
//   RESPONSE side: converts the flat `mcp__ns__tool` function-call names back to
//                  the `{namespace, name}` split that codex uses for MCP routing.
//
// Short-name fallback: the model may call tools by their bare names (e.g. "list_apps")
// instead of the fully-qualified flat name ("mcp__tday_computer_use__list_apps").
// We build a shortName→flatName map while expanding namespace tools and use it on
// the response side to resolve bare names into the namespace+name split that codex
// expects for routing.

/**
 * Persistent map from bare tool name (e.g. "list_apps") to the fully-qualified
 * flat MCP name (e.g. "mcp__tday_computer_use__list_apps").  Populated by
 * expandNamespaceTools on every request that carries namespace tool definitions.
 * The proxy is long-lived and the tool list is stable, so a module-level map works.
 */
const shortToFlatMcpName = new Map<string, string>();

/**
 * Transform a parsed request body: expand `type:"namespace"` tool entries into
 * individual flat `type:"function"` entries.  All non-namespace entries pass through.
 * As a side-effect, populates `shortToFlatMcpName` so that the response side can
 * resolve bare tool names (used by the model when following SKILL-text instructions)
 * back to their fully-qualified flat names.
 */
function expandNamespaceTools(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const req = body as Record<string, unknown>;
  if (!Array.isArray(req.tools)) return req;

  const flat: unknown[] = [];
  for (const tool of req.tools as Array<Record<string, unknown>>) {
    if (tool.type === 'namespace') {
      // Namespace name ends with `__` (e.g. "mcp__tday_computer_use__").
      // Each sub-tool's flat name is simply the namespace concatenated with its name.
      const nsName = (tool.name as string) ?? '';
      const subTools = (tool.tools as Array<Record<string, unknown>>) ?? [];
      for (const sub of subTools) {
        if (sub.type === 'function') {
          const shortName = sub.name as string;
          const flatName  = `${nsName}${shortName}`;
          flat.push({ ...sub, name: flatName });
          // Remember bare name → flat name so patchFunctionCallItem can resolve it.
          shortToFlatMcpName.set(shortName, flatName);
        } else {
          flat.push({ ...sub });
        }
      }
    } else {
      flat.push(tool);
    }
  }
  return { ...req, tools: flat };
}

/**
 * Given a flat function-call name like "mcp__tday_computer_use__take_screenshot",
 * returns { namespace: "mcp__tday_computer_use__", name: "take_screenshot" } when
 * the name starts with "mcp__" and contains at least two "__" separators.
 *
 * Also handles bare tool names (e.g. "take_screenshot") that the model may produce
 * when following SKILL-text instructions instead of the tool definitions: resolves
 * them via `shortToFlatMcpName` and then splits the resulting flat name.
 *
 * Returns null for names that cannot be resolved (they pass through unchanged).
 */
function splitFlatMcpName(flatName: string): { namespace: string; name: string } | null {
  if (!flatName.startsWith('mcp__')) {
    // Bare name fallback: look up in the short→flat map built from namespace tools.
    const resolved = shortToFlatMcpName.get(flatName);
    if (!resolved) return null;
    return splitFlatMcpName(resolved); // recurse with the fully-qualified name
  }
  const lastDunder = flatName.lastIndexOf('__');
  if (lastDunder <= 4) return null;          // nothing after the first "mcp__"
  const namespace = flatName.substring(0, lastDunder + 2); // include trailing __
  const toolName  = flatName.substring(lastDunder + 2);
  if (!toolName) return null;
  return { namespace, name: toolName };
}

/** Patch a single output item if it's a flat MCP function_call. */
function patchFunctionCallItem(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type !== 'function_call') return item;
  const flat = splitFlatMcpName((item.name as string) ?? '');
  if (!flat) return item;
  const { namespace, name } = flat;
  return { ...item, namespace, name };
}

/**
 * Transform a parsed SSE data event: patch any function_call items whose name
 * encodes both namespace and tool name in the flat `mcp__ns__tool` format.
 */
function patchResponseEvent(data: unknown): unknown {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
  const ev = data as Record<string, unknown>;

  // response.output_item.added / response.output_item.done  →  ev.item
  if (ev.item && typeof ev.item === 'object') {
    const patched = patchFunctionCallItem(ev.item as Record<string, unknown>);
    if (patched !== ev.item) return { ...ev, item: patched };
  }

  // response.done SSE event  →  ev.response.output[]
  if (ev.response && typeof ev.response === 'object') {
    const resp = ev.response as Record<string, unknown>;
    if (Array.isArray(resp.output)) {
      const patchedOutput = resp.output.map((item: unknown) =>
        patchFunctionCallItem(item as Record<string, unknown>));
      const changed = patchedOutput.some((item, i) => item !== (resp.output as unknown[])[i]);
      if (changed) return { ...ev, response: { ...resp, output: patchedOutput } };
    }
  }

  // Non-streaming full Responses API body  →  ev.output[]
  // (gateway returns {output:[...]} when stream:false)
  if (Array.isArray(ev.output)) {
    const patchedOutput = ev.output.map((item: unknown) =>
      patchFunctionCallItem(item as Record<string, unknown>));
    const changed = patchedOutput.some((item, i) => item !== (ev.output as unknown[])[i]);
    if (changed) return { ...ev, output: patchedOutput };
  }

  return data;
}

/** Cache of running proxy instances keyed by realBaseUrl — shared across tabs. */
const codexProxyCache = new Map<string, {
  proxyBaseUrl: string;
  refCount: number;
  server: http.Server;
  upstreamOrigin: string;
}>();

/** Per-origin keepalive agents so the proxy reuses TCP connections to LM Studio / DeepSeek. */
type ProxyAgent = http.Agent | https.Agent;
const proxyAgents = new Map<string, { agent: ProxyAgent; refCount: number }>();
const CODEX_PROXY_HEADERS_TIMEOUT_MS = 30_000;
const CODEX_PROXY_SSE_IDLE_TIMEOUT_MS = 90_000;
const CODEX_PROXY_JSON_TIMEOUT_MS = 120_000;

function acquireProxyAgent(origin: string): ProxyAgent {
  const cached = proxyAgents.get(origin);
  if (cached) {
    cached.refCount++;
    return cached.agent;
  }
  const agent = origin.startsWith('https')
    ? new https.Agent({ keepAlive: true, maxSockets: 4 })
    : new http.Agent({ keepAlive: true, maxSockets: 4 });
  proxyAgents.set(origin, { agent, refCount: 1 });
  return agent;
}

function releaseProxyAgent(origin: string): void {
  const entry = proxyAgents.get(origin);
  if (!entry) return;
  entry.refCount--;
  if (entry.refCount > 0) return;
  proxyAgents.delete(origin);
  entry.agent.destroy();
}

function writeProxyError(
  clientRes: http.ServerResponse,
  status: number,
  phase: string,
  message: string,
  retryable = true,
): void {
  if (clientRes.writableEnded) return;
  if (!clientRes.headersSent) {
    clientRes.writeHead(status, { 'content-type': 'application/json' });
    clientRes.end(JSON.stringify({ error: message, phase, retryable }));
  } else {
    clientRes.end();
  }
}

// ── MCP Session-Keepalive Proxy (for codex HTTP MCP) ─────────────────────────
//
// Codex's Rust rmcp HTTP client (≤ v0.130.x) does not reliably carry the
// Mcp-Session-Id header across tool calls.  This proxy sits between codex
// and the shared NativecoreService HTTP server and fixes the problem
// transparently:
//
//   1. Intercepts the MCP initialize handshake, caches the assigned session ID.
//   2. On every subsequent POST request lacking Mcp-Session-Id: injects it.
//   3. On HTTP 422 from nativecore (session expired / process restarted):
//      re-initializes the session then replays the original request — codex
//      never sees the error.
//
// Each codex session gets its own proxy instance so session IDs are isolated.

/**
 * Start a per-session MCP session-keepalive proxy for codex.
 *
 * @param nativecoreOrigin - HTTP origin of the shared nativecore,
 *   e.g. "http://127.0.0.1:8765" (no path).
 * @returns proxyBaseUrl (e.g. "http://127.0.0.1:PROXY_PORT") and stop().
 *   Pass `proxyBaseUrl + "/mcp"` to codexMcpCliArgsUrl().
 */
export function startMcpSessionProxy(
  nativecoreOrigin: string,
  authToken?: string,
): Promise<{ proxyBaseUrl: string; stop: () => void }> {
  let sessionId: string | null = null;
  let cachedInitBody: Buffer | null = null;
  /** Body of the `notifications/initialized` message from codex — replayed after re-init. */
  let cachedInitializedBody: Buffer | null = null;

  const upstreamAgent = new http.Agent({ keepAlive: true, maxSockets: 2 });

  /**
   * Forward one buffered POST to nativecore and return the full buffered
   * response.  Used for initialize + tool-call requests where we may need
   * to re-issue on 422.
   */
  const forwardBuffered = (
    method: string,
    path: string,
    reqHeaders: Record<string, string>,
    body: Buffer,
  ): Promise<{ status: number; resHeaders: http.IncomingHttpHeaders; body: Buffer }> =>
    new Promise((resolve, reject) => {
      const targetUrl = `${nativecoreOrigin}${path}`;
      const headers: Record<string, string> = { ...reqHeaders, 'content-length': String(body.length) };
      // Inject auth header for every upstream request when a token is configured.
      if (authToken) headers['authorization'] = `Bearer ${authToken}`;
      const req = http.request(
        targetUrl,
        {
          method,
          headers,
          agent: upstreamAgent,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 200, resHeaders: res.headers, body: Buffer.concat(chunks) }),
          );
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (body.length > 0) req.write(body);
      req.end();
    });

  const server = http.createServer((clientReq, clientRes) => {
    const bodyChunks: Buffer[] = [];
    clientReq.on('data', (c: Buffer) => bodyChunks.push(c));
    clientReq.on('error', (err) => console.warn('[tday-mcp-proxy] client error:', err.message));
    clientReq.on('end', async () => {
      const rawBody = Buffer.concat(bodyChunks);
      const reqPath = clientReq.url ?? '/';
      const method = (clientReq.method ?? 'POST').toUpperCase();

      // Build forwarding headers — strip hop-by-hop headers
      const fwdHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(clientReq.headers)) {
        const lk = k.toLowerCase();
        if (['connection', 'transfer-encoding', 'upgrade', 'keep-alive', 'host'].includes(lk)) continue;
        fwdHeaders[lk] = Array.isArray(v) ? v.join(', ') : (v ?? '');
      }
      fwdHeaders['host'] = new URL(nativecoreOrigin).host;
      // Inject auth header for every upstream request when a token is configured.
      if (authToken) fwdHeaders['authorization'] = `Bearer ${authToken}`;

      // Non-POST (GET for SSE notifications, DELETE for session close): pipe directly
      if (method !== 'POST') {
        const targetUrl = `${nativecoreOrigin}${reqPath}`;
        const upReq = http.request(
          targetUrl,
          { method, headers: fwdHeaders, agent: upstreamAgent },
          (res) => {
            const outHeaders: http.OutgoingHttpHeaders = {};
            for (const [k, v] of Object.entries(res.headers)) {
              if (k !== 'transfer-encoding' && v !== undefined) outHeaders[k] = v;
            }
            clientRes.writeHead(res.statusCode ?? 200, outHeaders);
            res.pipe(clientRes);
            res.on('error', () => { if (!clientRes.writableEnded) clientRes.end(); });
          },
        );
        upReq.on('error', () => {
          if (!clientRes.headersSent) clientRes.writeHead(502);
          if (!clientRes.writableEnded) clientRes.end();
        });
        upReq.end();
        return;
      }

      // POST: detect initialize / notifications/initialized, maintain session ID, handle 422 + 401
      let isInit = false;
      let isInitializedNotification = false;
      if (rawBody.length > 0) {
        try {
          const parsed = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
          if (parsed?.method === 'initialize') {
            isInit = true;
            cachedInitBody = rawBody;
            // initialize must NOT carry a stale session ID
            delete fwdHeaders['mcp-session-id'];
          } else if (parsed?.method === 'notifications/initialized') {
            // Cache the initialized notification so we can replay it after re-init.
            isInitializedNotification = true;
            cachedInitializedBody = rawBody;
          }
        } catch { /* non-JSON body — forward as-is */ }
      }

      // Inject stored session ID into non-initialize requests that lack it
      if (!isInit && sessionId !== null && !fwdHeaders['mcp-session-id']) {
        fwdHeaders['mcp-session-id'] = sessionId;
      }

      /**
       * Perform a full re-initialization cycle:
       *   1. Send initialize (no session ID)
       *   2. Capture new session ID
       *   3. Send notifications/initialized with new session ID (required by MCP spec)
       * Returns true if re-init succeeded and fwdHeaders['mcp-session-id'] is updated.
       */
      const reInitSession = async (): Promise<boolean> => {
        if (cachedInitBody === null) return false;
        const initHeaders = { ...fwdHeaders };
        delete initHeaders['mcp-session-id'];
        const initUp = await forwardBuffered('POST', reqPath, initHeaders, cachedInitBody);
        const newSid = initUp.resHeaders['mcp-session-id'];
        if (typeof newSid !== 'string') return false;
        sessionId = newSid;
        fwdHeaders['mcp-session-id'] = newSid;
        console.log('[tday-mcp-proxy] re-initialized, new session:', newSid);
        // Send notifications/initialized to complete the MCP handshake
        if (cachedInitializedBody !== null) {
          const notifHeaders = { ...fwdHeaders };
          await forwardBuffered('POST', reqPath, notifHeaders, cachedInitializedBody)
            .catch((e: unknown) => console.warn('[tday-mcp-proxy] initialized notification error:', e));
        }
        return true;
      };

      try {
        let upstream = await forwardBuffered(method, reqPath, fwdHeaders, rawBody);

        // 422 = server rejects the message because no session context (session ID missing).
        // 401 = server rejects because the session ID is present but no longer exists
        //       (nativecore restarted and the old session was lost).
        // In both cases: re-initialize transparently and replay the original request.
        const needsReInit =
          !isInit &&
          (upstream.status === 422 || upstream.status === 401) &&
          cachedInitBody !== null;

        if (needsReInit) {
          console.log(`[tday-mcp-proxy] session error (${upstream.status}), re-initializing…`);
          const ok = await reInitSession();
          if (ok) {
            // Replay original request with refreshed session ID
            upstream = await forwardBuffered(method, reqPath, fwdHeaders, rawBody);
          }
        }

        // Capture / update session ID from any successful response
        const sid = upstream.resHeaders['mcp-session-id'];
        if (typeof sid === 'string') sessionId = sid;

        // Forward response to codex; add content-length so HTTP keep-alive works correctly
        const outHeaders: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upstream.resHeaders)) {
          if (k !== 'transfer-encoding' && k !== 'content-length' && v !== undefined) outHeaders[k] = v;
        }
        outHeaders['content-length'] = String(upstream.body.length);
        clientRes.writeHead(upstream.status, outHeaders);
        clientRes.end(upstream.body);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[tday-mcp-proxy] upstream error:', msg);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { 'content-type': 'application/json' });
        }
        if (!clientRes.writableEnded) {
          clientRes.end(JSON.stringify({ error: 'mcp-proxy-error', message: msg }));
        }
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number } | null;
      const port = addr?.port ?? 0;
      const proxyBaseUrl = `http://127.0.0.1:${port}`;
      console.log(`[tday-mcp-proxy] started on ${proxyBaseUrl} → ${nativecoreOrigin}/mcp`);
      resolve({
        proxyBaseUrl,
        stop: () => {
          server.close();
          upstreamAgent.destroy();
        },
      });
    });
  });
}

// ── Codex namespace-tool proxy ────────────────────────────────────────────────

/**
 * Start a local HTTP proxy that transforms codex namespace tools ↔ flat function
 * tools.  Returns the proxy base-URL and a `stop()` function to call when the
 * codex process exits.  Proxies are shared per realBaseUrl (ref-counted), so
 * multiple tabs reuse the same server instance.
 */
export function startCodexApiProxy(realBaseUrl: string): Promise<{ proxyBaseUrl: string; stop: () => void }> {
  // Return existing proxy for the same destination (just bump the ref count).
  const cached = codexProxyCache.get(realBaseUrl);
  if (cached) {
    cached.refCount++;
    console.log(`[tday-codex-proxy] reusing proxy on ${cached.proxyBaseUrl} (refCount=${cached.refCount})`);
    return Promise.resolve({
      proxyBaseUrl: cached.proxyBaseUrl,
      stop: makeProxyStop(realBaseUrl),
    });
  }

  // The proxy must preserve the path prefix of realBaseUrl so that codex
  // constructs the same request URL structure:
  //   realBaseUrl = "http://host:port/v1"  → proxyBaseUrl = "http://127.0.0.1:P/v1"
  //   realBaseUrl = "http://host:port"     → proxyBaseUrl = "http://127.0.0.1:P"
  let realOrigin: string;
  let realBasePath: string;
  try {
    const u = new URL(realBaseUrl);
    realOrigin = u.origin;                             // e.g. "http://192.168.1.19:1234"
    realBasePath = u.pathname.replace(/\/+$/, '');     // e.g. "/v1" or ""
  } catch {
    realOrigin = realBaseUrl;
    realBasePath = '';
  }

  const upstreamAgent = acquireProxyAgent(realOrigin);

  const server = http.createServer((clientReq, clientRes) => {
    let bodyChunks: Buffer[] = [];
    clientReq.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
    clientReq.on('end', () => {
      const rawBody = Buffer.concat(bodyChunks);
      let forwardBody: Buffer = rawBody;

      if (clientReq.method === 'POST' && rawBody.length > 0) {
        try {
          const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
          const transformed = expandNamespaceTools(parsed);
          if (transformed !== parsed) {
            forwardBody = Buffer.from(JSON.stringify(transformed), 'utf8');
          }
        } catch { /* non-JSON body — forward as-is */ }
      }

      const targetPath = clientReq.url ?? '/';
      const targetUrl = `${realOrigin}${targetPath}`;

      const isHttps = targetUrl.startsWith('https');
      const transport: typeof http | typeof https = isHttps ? https : http;

      const forwardHeaders: http.OutgoingHttpHeaders = {
        ...clientReq.headers,
        host: new URL(targetUrl).host,
        'content-length': String(forwardBody.length),
      };
      // Remove hop-by-hop headers
      delete forwardHeaders['transfer-encoding'];
      delete forwardHeaders['connection'];

      let upstreamEnded = false;
      let headersReceived = false;

      const proxyReq = transport.request(targetUrl, {
        method: clientReq.method,
        headers: forwardHeaders,
        agent: upstreamAgent,
      }, (proxyRes) => {
        headersReceived = true;
        clearTimeout(headersTimer);
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders['content-length']; // length may change after transform
        delete responseHeaders['transfer-encoding'];
        clientRes.writeHead(proxyRes.statusCode ?? 200, responseHeaders);

        const contentType = (proxyRes.headers['content-type'] ?? '').toString();

        let idleTimer: ReturnType<typeof setTimeout> | null = null;
        const clearIdleTimer = () => {
          if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
          }
        };
        const refreshIdleTimer = (timeoutMs: number, phase: string) => {
          clearIdleTimer();
          idleTimer = setTimeout(() => {
            proxyReq.destroy(new Error(`Upstream ${phase} idle timeout after ${timeoutMs}ms`));
          }, timeoutMs);
        };

        if (contentType.includes('text/event-stream')) {
          // Stream SSE line-by-line and patch function_call events
          let sseBuffer = '';
          refreshIdleTimer(CODEX_PROXY_SSE_IDLE_TIMEOUT_MS, 'sse');
          proxyRes.on('data', (chunk: Buffer) => {
            refreshIdleTimer(CODEX_PROXY_SSE_IDLE_TIMEOUT_MS, 'sse');
            sseBuffer += chunk.toString('utf8');
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() ?? '';
            for (const line of lines) {
              if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                try {
                  const evData: unknown = JSON.parse(line.slice(6));
                  const patched = patchResponseEvent(evData);
                  clientRes.write('data: ' + JSON.stringify(patched) + '\n');
                } catch {
                  clientRes.write(line + '\n');
                }
              } else {
                clientRes.write(line + '\n');
              }
            }
          });
          proxyRes.on('end', () => {
            upstreamEnded = true;
            clearIdleTimer();
            // Flush any partial line left in the buffer (should be empty for
            // well-formed SSE but guard against truncated upstream responses).
            if (sseBuffer.trim()) clientRes.write(sseBuffer + '\n');
            clientRes.end();
          });
        } else {
          // Buffer full response, patch JSON, forward
          const respChunks: Buffer[] = [];
          refreshIdleTimer(CODEX_PROXY_JSON_TIMEOUT_MS, 'json');
          proxyRes.on('data', (chunk: Buffer) => {
            refreshIdleTimer(CODEX_PROXY_JSON_TIMEOUT_MS, 'json');
            respChunks.push(chunk);
          });
          proxyRes.on('end', () => {
            upstreamEnded = true;
            clearIdleTimer();
            const raw = Buffer.concat(respChunks);
            let out = raw;
            if (contentType.includes('application/json') && raw.length > 0) {
              try {
                const parsed: unknown = JSON.parse(raw.toString('utf8'));
                const patched = patchResponseEvent(parsed);
                if (patched !== parsed) out = Buffer.from(JSON.stringify(patched), 'utf8');
              } catch { /* non-JSON — forward as-is */ }
            }
            clientRes.write(out);
            clientRes.end();
          });
        }

        proxyRes.on('error', (err) => {
          upstreamEnded = true;
          clearIdleTimer();
          console.warn('[tday-codex-proxy] upstream error:', err.message);
          writeProxyError(clientRes, 502, 'upstream-response', `Proxy upstream response error: ${err.message}`);
        });
      });

      const abortUpstream = () => {
        if (!upstreamEnded && !proxyReq.destroyed) {
          proxyReq.destroy(new Error('Client disconnected before upstream completed'));
        }
      };
      clientReq.once('aborted', abortUpstream);
      clientRes.once('close', abortUpstream);

      const headersTimer = setTimeout(() => {
        if (!headersReceived && !proxyReq.destroyed) {
          proxyReq.destroy(new Error(`Upstream headers timeout after ${CODEX_PROXY_HEADERS_TIMEOUT_MS}ms`));
        }
      }, CODEX_PROXY_HEADERS_TIMEOUT_MS);

      proxyReq.on('error', (err) => {
        clearTimeout(headersTimer);
        upstreamEnded = true;
        // Ignore destroy-triggered errors when the client already disconnected.
        if (clientRes.destroyed || clientRes.writableEnded) return;
        console.warn('[tday-codex-proxy] request error:', err.message);
        writeProxyError(clientRes, 502, headersReceived ? 'upstream-stream' : 'upstream-connect', `Proxy upstream error: ${err.message}`);
      });

      proxyReq.on('close', () => clearTimeout(headersTimer));

      proxyReq.write(forwardBody);
      proxyReq.end();
    });

    clientReq.on('error', (err) => {
      console.warn('[tday-codex-proxy] client error:', err.message);
    });
  });

  // Bind to a random available port on localhost; read back the actual port
  // only after the 'listening' event fires (server.address() returns null before then).
  return new Promise<{ proxyBaseUrl: string; stop: () => void }>((resolve, reject) => {
    server.once('error', (err) => {
      releaseProxyAgent(realOrigin);
      reject(err);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number } | null;
      const port = address?.port ?? 0;
      // Mirror the same path prefix as the real base URL so codex constructs
      // the identical request path (e.g. /v1/responses or /responses).
      const proxyBaseUrl = `http://127.0.0.1:${port}${realBasePath}`;
      console.log(`[tday-codex-proxy] started on ${proxyBaseUrl}, forwarding to ${realBaseUrl}`);
      codexProxyCache.set(realBaseUrl, { proxyBaseUrl, refCount: 1, server, upstreamOrigin: realOrigin });
      resolve({ proxyBaseUrl, stop: makeProxyStop(realBaseUrl) });
    });
  });
}

function makeProxyStop(realBaseUrl: string): () => void {
  return () => {
    const entry = codexProxyCache.get(realBaseUrl);
    if (!entry) return;
    entry.refCount--;
    if (entry.refCount > 0) {
      console.log(`[tday-codex-proxy] released ref for ${realBaseUrl} (refCount=${entry.refCount})`);
      return;
    }
    codexProxyCache.delete(realBaseUrl);
    entry.server.close();
    releaseProxyAgent(entry.upstreamOrigin);
    console.log(`[tday-codex-proxy] stopped proxy for ${realBaseUrl}`);
  };
}
