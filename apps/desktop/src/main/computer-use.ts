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
import { join } from 'node:path';
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

User request involves interacting with a running app?
  ├─ 1st choice — AX (most reliable; no Screen Recording needed; survives window moves):
  │    take_ax_snapshot → ax_click / ax_set_value / ax_select / ax_perform_action
  │    Works for: all native macOS apps, most Electron apps (non-web-content areas)
  │
  ├─ 2nd choice — Visual + Mouse/Keyboard (universal fallback):
  │    take_screenshot → find_text / ocr_screenshot → click / type_text / shortcut / scroll / drag
  │    Use when: AX returns empty tree, element has no UID, or the UI is canvas/game/image-based
  │
  └─ LAST RESORT — CDP (only Chrome/Electron web content, and only if AX+Visual both fail):
       probe_app → cdp_connect → cdp_find_elements / cdp_fill / cdp_click
       Use when: form fields or buttons are inside a web page and can't be found by find_text
\`\`\`

> **Always try AX first** — it is pixel-perfect, doesn't need Screen Recording permission,
> and survives window moves/resizes. Drop to Visual when AX has no coverage.
> CDP is powerful but brittle (port changes, page reloads, CSP) — use it only as a last resort.

## Core tools reference

### Screen & Vision
| Tool | When to use |
|------|-------------|
| \`take_screenshot\` | **Last resort visual fallback** — only when AX and find_text give no useful result (canvas, game, PDF, fully custom-drawn UI). Avoid calling it as a routine step. |
| \`find_text\` | **Preferred** for locating on-screen text — uses AX tree first, OCR fallback. Returns \`{x,y}\` without a full screenshot. |
| \`find_image\` | Match a template sub-image to locate icons/buttons visually |
| \`element_at_point\` | Identify the AX element at given screen coords |

### Mouse & Keyboard
| Tool | Notes |
|------|-------|
| \`click\` | \`button\`: left/right/middle. \`click_count: 2\` = double-click |
| \`type_text\` | Set \`x,y\` to click-to-focus first. Set \`clear: true\` to replace existing text. \`press_enter: true\` to submit |
| \`shortcut\` | e.g. \`"command+c"\`, \`"ctrl+shift+s"\`, \`"return"\` — always prefer this over press_key for multi-key combos |
| \`scroll\` | Use \`direction\` + \`wheel_times\` (preferred) rather than raw \`delta_x/delta_y\` |
| \`drag\` | Drag-and-drop, slider adjustment, reordering list items |

### App management
| Tool | Notes |
|------|-------|
| \`list_apps\` | Check what's running before launching |
| \`launch_app\` | Open by display name. Returns PID |
| \`focus_window\` | Bring a window to front (use \`list_windows\` to get \`window_id\`) |
| \`resize_window\` | Position/size a window by app name |
| \`quit_app\` | \`force: true\` = SIGKILL equivalent |

### macOS Accessibility (AX) — preferred for native apps
| Tool | Notes |
|------|-------|
| \`take_ax_snapshot\` | Returns a tree of \`{uid, role, name, value, children}\` nodes |
| \`ax_click\` | Click by uid from the snapshot — pixel-perfect, survives window moves |
| \`ax_set_value\` | Type into text fields without needing coordinates |
| \`ax_select\` | Select/open menu items, tabs, list rows |
| \`ax_perform_action\` | Run any AX action (\`"AXPress"\`, \`"AXIncrement"\`, etc.) |

### CDP — Chrome/Electron apps
| Tool | Notes |
|------|-------|
| \`probe_app\` | Returns \`{kind: "Electron"\|"Chrome"\|"Native"}\` and debug port. Run this first |
| \`cdp_connect\` | Connect to the debug port returned by probe_app |
| \`cdp_find_elements\` | CSS selector / text search. Returns \`[{id, tag, text, rect}]\` |
| \`cdp_click\` | Click element by id. More reliable than pixel coords in web UIs |
| \`cdp_fill\` | Fill an input field by element id |
| \`cdp_evaluate\` | Run arbitrary JS in the page |

### System utilities
| Tool | Notes |
|------|-------|
| \`execute_command\` | Run shell commands (\`mode: "shell"\`) or AppleScript (\`mode: "osascript"\`) |
| \`clipboard\` | \`mode: "get"\` / \`mode: "set"\` — read or write clipboard text (macOS, Windows, Linux) |
| \`get_page_content\` | **Fastest text extraction** — Select-All + Copy + read clipboard. Use to read full content of a document, terminal, or page without screenshot/OCR. Automatically restores the original clipboard. Works on macOS (Cmd+A/C), Windows and Linux (Ctrl+A/C). |
| \`process\` | List/kill processes. Useful to check if an app is already running |
| \`filesystem\` | Read, write, list, search files — use instead of shell when the path is known |
| \`scrape\` | Fetch a URL and return its body as text |
| \`wait\` | Pause between actions. Use after launching apps or triggering animations (\`duration: 0.5\`–\`2\`) |

### Android (requires connected device via ADB)
Use \`android_list_devices\` first to confirm a device is connected, then \`android_connect\`.
Tools mirror the macOS set: \`android_screenshot\`, \`android_click\`, \`android_type_text\`, \`android_find_text\`, \`android_launch_app\`.

## Common task patterns

**Read full content of current document/page (fastest)**
\`\`\`
get_page_content {}
// → { text: "...all text in the focused window...", length: N }
// Use when: reading a document, terminal output, text editor, or browser page.
// Advantages over screenshot+OCR or AX tree: zero permissions needed, works
// in any app, returns clean text in milliseconds.
// Tip: call focus_window / take_ax_snapshot first if the target window is
// not already focused.
\`\`\`

**Open an app and interact with it**
\`\`\`
1. list_apps                          // check if already running
2. launch_app {app_name}              // if not running
3. wait {duration: 1}                 // let the window appear
4. take_ax_snapshot {app_name}        // preferred: structured, no screen recording needed
   OR probe_app → cdp_connect         // for Chrome/Electron web content
5. interact via ax_click / ax_set_value / cdp_fill
6. verify cheaply: find_text or check AX value — NOT a full screenshot
\`\`\`

**Fill a web form in Chrome/Electron**
\`\`\`
1. probe_app {app_name}               // get debug port
2. cdp_connect {port}                 // establish CDP session
3. cdp_find_elements {selector/text}  // locate input fields
4. cdp_fill {id, value}               // fill each field
5. cdp_click {submit button id}       // submit
6. take_screenshot                    // verify
\`\`\`

**Click something you can see on screen**
\`\`\`
1. find_text {text}                   // get {x,y} directly — no screenshot needed
   OR take_ax_snapshot → ax_click     // even better: uid-based, survives window moves
2. click {x, y}
3. verify: find_text or check AX value (avoid a full screenshot if possible)
\`\`\`

**Type into a text field**
\`\`\`
// Visual approach:
type_text {text, x, y, clear: true}

// AX approach (more reliable for native apps):
take_ax_snapshot → find the TextField uid → ax_set_value {uid, value}
\`\`\`

**Keyboard shortcut / menu action**
\`\`\`
shortcut {shortcut: "command+s"}          // Save
shortcut {shortcut: "command+shift+p"}    // VS Code command palette
shortcut {shortcut: "ctrl+a"}             // Select all (Linux/Windows apps)
\`\`\`

## Reliability rules
- **Use \`get_page_content\` to read text** — fastest, zero permissions, works in any app. Prefer it over screenshot+OCR or full AX tree traversal when you just need the text.
- **Start with AX, not screenshots** — \`take_ax_snapshot\` and \`find_text\` work without Screen Recording permission and are faster. Use \`take_screenshot\` only when the UI is non-standard (canvas, game, PDF, custom-drawn).
- **Verify cheaply after actions** — check with \`find_text\` or an AX value query first. Only escalate to \`take_screenshot\` if the cheap check is insufficient.
- **Prefer AX/CDP over pixel clicks** — coordinates break if the window moves; uid-based AX clicks do not.
- **Use \`wait\`** after launching apps, opening dialogs, or triggering animations before the next action.
- **Use \`find_text\` or \`take_ax_snapshot\`** rather than hardcoding coordinates from memory.
- **If \`take_screenshot\` returns a black/blank image**: macOS Screen Recording permission is missing. Direct the user to: System Settings → Privacy & Security → Screen Recording → enable the terminal app.
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
function devToolsBinaryPath(): string {
  const exe = process.platform === 'win32' ? 'tday-nativecore.exe' : 'tday-nativecore';
  if (app.isPackaged) {
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
 * Inject MCP into codex's config (~/.codex/config.toml).
 * Format: [mcp_servers.<name>]  /  command = "<path>"
 * Returns a cleanup function; must be called when the PTY exits.
 */
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
  if (app.isPackaged) {
    return join(process.resourcesPath, 'pi-computer-use-bridge.ts');
  }
  // Dev: source tree relative to the compiled main output directory
  return join(__dirname, '../../resources/pi-computer-use-bridge.ts');
}

/**
 * Returns the `--extension` path and the required env var for pi Computer Use.
 * Call when spawning pi with Computer Use enabled; the returned cleanup is a no-op
 * (no external config file is mutated — the bridge is an ephemeral extension arg).
 */
export function injectPiMcp(): { extensionPath: string; env: Record<string, string>; cleanup: () => void } {
  return {
    extensionPath: bridgeExtensionPath(),
    env: { TDAY_DEVTOOLS_BIN: devToolsBinaryPath() },
    cleanup: () => { /* no persistent mutation — no cleanup needed */ },
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

/**
 * Transform a parsed request body: expand `type:"namespace"` tool entries into
 * individual flat `type:"function"` entries.  All non-namespace entries pass through.
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
          flat.push({ ...sub, name: `${nsName}${sub.name as string}` });
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
 * Returns null for all other names (they pass through unchanged).
 */
function splitFlatMcpName(flatName: string): { namespace: string; name: string } | null {
  if (!flatName.startsWith('mcp__')) return null;
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

  // response.done  →  ev.response.output[]
  if (ev.response && typeof ev.response === 'object') {
    const resp = ev.response as Record<string, unknown>;
    if (Array.isArray(resp.output)) {
      const patchedOutput = resp.output.map((item: unknown) =>
        patchFunctionCallItem(item as Record<string, unknown>));
      const changed = patchedOutput.some((item, i) => item !== (resp.output as unknown[])[i]);
      if (changed) return { ...ev, response: { ...resp, output: patchedOutput } };
    }
  }

  return data;
}

/** Cache of running proxy instances keyed by realBaseUrl — shared across tabs. */
const codexProxyCache = new Map<string, {
  proxyBaseUrl: string;
  refCount: number;
  server: http.Server;
}>();

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

      const proxyReq = transport.request(targetUrl, {
        method: clientReq.method,
        headers: forwardHeaders,
      }, (proxyRes) => {
        const responseHeaders = { ...proxyRes.headers };
        delete responseHeaders['content-length']; // length may change after transform
        delete responseHeaders['transfer-encoding'];
        clientRes.writeHead(proxyRes.statusCode ?? 200, responseHeaders);

        const contentType = (proxyRes.headers['content-type'] ?? '').toString();

        if (contentType.includes('text/event-stream')) {
          // Stream SSE line-by-line and patch function_call events
          let sseBuffer = '';
          proxyRes.on('data', (chunk: Buffer) => {
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
            if (sseBuffer) clientRes.write(sseBuffer);
            clientRes.end();
          });
        } else {
          // Buffer full response, patch JSON, forward
          const respChunks: Buffer[] = [];
          proxyRes.on('data', (chunk: Buffer) => respChunks.push(chunk));
          proxyRes.on('end', () => {
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
          console.warn('[tday-codex-proxy] upstream error:', err.message);
          if (!clientRes.writableEnded) clientRes.end();
        });
      });

      proxyReq.on('error', (err) => {
        console.warn('[tday-codex-proxy] request error:', err.message);
        if (!clientRes.headersSent) clientRes.writeHead(502);
        if (!clientRes.writableEnded) clientRes.end('Proxy error: ' + err.message);
      });

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
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number } | null;
      const port = address?.port ?? 0;
      // Mirror the same path prefix as the real base URL so codex constructs
      // the identical request path (e.g. /v1/responses or /responses).
      const proxyBaseUrl = `http://127.0.0.1:${port}${realBasePath}`;
      console.log(`[tday-codex-proxy] started on ${proxyBaseUrl}, forwarding to ${realBaseUrl}`);
      codexProxyCache.set(realBaseUrl, { proxyBaseUrl, refCount: 1, server });
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
    console.log(`[tday-codex-proxy] stopped proxy for ${realBaseUrl}`);
  };
}
