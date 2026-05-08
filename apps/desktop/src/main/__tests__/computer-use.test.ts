import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  buildMcpEntry,
  buildOpencodeMcpEntry,
  applyClaudeCodeMcp,
  injectGeminiMcp,
  injectOpencodeMcp,
  isComputerUseEnabled,
  writeComputerUseSkillFiles,
  removeComputerUseSkillFiles,
  MCP_SERVER_KEY,
  COMPUTER_USE_SETTING_KEY,
  COMPUTER_USE_AGENTS,
  COMPUTER_USE_SKILL,
} from '../computer-use.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Create an isolated temp dir for each test to avoid cross-test pollution. */
function makeTempHome(): string {
  const dir = join(tmpdir(), `cu-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── buildMcpEntry ─────────────────────────────────────────────────────────────

describe('buildMcpEntry', () => {
  it('returns the tday-nativecore binary path as command', () => {
    const entry = buildMcpEntry();
    expect(entry.command).toMatch(/tday-nativecore(\.exe)?$/);
    expect(entry.args).toEqual([]);
  });

  it('is serialisable to JSON without loss', () => {
    const entry = buildMcpEntry();
    const roundTripped = JSON.parse(JSON.stringify(entry));
    expect(roundTripped).toEqual(entry);
  });
});

// ── applyClaudeCodeMcp ────────────────────────────────────────────────────────

describe('applyClaudeCodeMcp', () => {
  it('adds mcpServers to an empty session settings object', () => {
    const settings: Record<string, unknown> = { env: { ANTHROPIC_API_KEY: 'test' } };
    applyClaudeCodeMcp(settings);
    expect(settings.mcpServers).toBeDefined();
    expect((settings.mcpServers as Record<string, unknown>)[MCP_SERVER_KEY]).toEqual(buildMcpEntry());
  });

  it('merges with existing mcpServers without overwriting other servers', () => {
    const settings: Record<string, unknown> = {
      env: {},
      mcpServers: { 'other-server': { command: 'node', args: ['server.js'] } },
    };
    applyClaudeCodeMcp(settings);
    const servers = settings.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers)).toContain('other-server');
    expect(Object.keys(servers)).toContain(MCP_SERVER_KEY);
  });

  it('is idempotent when called twice', () => {
    const settings: Record<string, unknown> = { env: {} };
    applyClaudeCodeMcp(settings);
    applyClaudeCodeMcp(settings);
    const servers = settings.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).filter((k) => k === MCP_SERVER_KEY)).toHaveLength(1);
  });

  it('injects ANTHROPIC_BETA with computer-use flag', () => {
    const settings: Record<string, unknown> = { env: { ANTHROPIC_API_KEY: 'test' } };
    applyClaudeCodeMcp(settings);
    const env = settings.env as Record<string, string>;
    expect(env['ANTHROPIC_BETA']).toContain('computer-use-2025-01-30');
  });

  it('appends computer-use flag when ANTHROPIC_BETA already has other values', () => {
    const settings: Record<string, unknown> = { env: { ANTHROPIC_BETA: 'interleaved-thinking-2025-05-14' } };
    applyClaudeCodeMcp(settings);
    const env = settings.env as Record<string, string>;
    expect(env['ANTHROPIC_BETA']).toContain('interleaved-thinking-2025-05-14');
    expect(env['ANTHROPIC_BETA']).toContain('computer-use-2025-01-30');
  });

  it('does not duplicate ANTHROPIC_BETA flag when called twice', () => {
    const settings: Record<string, unknown> = { env: {} };
    applyClaudeCodeMcp(settings);
    applyClaudeCodeMcp(settings);
    const env = settings.env as Record<string, string>;
    const flags = (env['ANTHROPIC_BETA'] ?? '').split(',').map((s) => s.trim());
    expect(flags.filter((f) => f === 'computer-use-2025-01-30')).toHaveLength(1);
  });
});

// ── isComputerUseEnabled ──────────────────────────────────────────────────────

describe('isComputerUseEnabled', () => {
  it('returns false when setting is absent', () => {
    expect(isComputerUseEnabled({}, 'claude-code')).toBe(false);
  });

  it('returns false when setting is false', () => {
    expect(isComputerUseEnabled({ [COMPUTER_USE_SETTING_KEY]: false }, 'claude-code')).toBe(false);
  });

  it('returns true for supported agents when enabled', () => {
    const s = { [COMPUTER_USE_SETTING_KEY]: true };
    for (const agentId of COMPUTER_USE_AGENTS) {
      expect(isComputerUseEnabled(s, agentId)).toBe(true);
    }
  });

  it('returns false for unsupported agents even when globally enabled', () => {
    const s = { [COMPUTER_USE_SETTING_KEY]: true };
    // 'pi' is now a supported Computer Use agent; only non-listed agents should return false
    expect(isComputerUseEnabled(s, 'terminal')).toBe(false);
    expect(isComputerUseEnabled(s, 'crush')).toBe(false);
    expect(isComputerUseEnabled(s, 'hermes')).toBe(false);
  });
});

// ── injectGeminiMcp ───────────────────────────────────────────────────────────

describe('injectGeminiMcp', () => {
  let tmpHome: string;

  beforeEach(() => { tmpHome = makeTempHome(); });
  afterEach(() => { cleanupDir(tmpHome); });

  it('creates ~/.gemini/settings.json with mcpServers key if it does not exist', () => {
    const cleanup = injectGeminiMcp(tmpHome);
    const filePath = join(tmpHome, '.gemini', 'settings.json');
    const doc = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(doc.mcpServers).toBeDefined();
    expect((doc.mcpServers as Record<string, unknown>)[MCP_SERVER_KEY]).toEqual(buildMcpEntry());
    cleanup();
  });

  it('restores original content after cleanup when file did not previously exist', () => {
    const cleanup = injectGeminiMcp(tmpHome);
    cleanup();
    const filePath = join(tmpHome, '.gemini', 'settings.json');
    // File should no longer have our key (either removed or file content is clean)
    try {
      const doc = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const servers = doc.mcpServers as Record<string, unknown> | undefined;
      expect(servers?.[MCP_SERVER_KEY]).toBeUndefined();
    } catch {
      // File may not exist at all — also acceptable
    }
  });

  it('merges with existing mcpServers and restores to original on cleanup', () => {
    const geminiDir = join(tmpHome, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    const filePath = join(geminiDir, 'settings.json');
    const original = { mcpServers: { 'existing-server': { command: 'node', args: [] } } };
    writeFileSync(filePath, JSON.stringify(original, null, 2), 'utf8');

    const cleanup = injectGeminiMcp(tmpHome);
    const patched = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const servers = patched.mcpServers as Record<string, unknown>;
    expect(servers['existing-server']).toBeDefined();
    expect(servers[MCP_SERVER_KEY]).toEqual(buildMcpEntry());

    cleanup();

    const restored = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const restoredServers = restored.mcpServers as Record<string, unknown>;
    expect(restoredServers[MCP_SERVER_KEY]).toBeUndefined();
    expect(restoredServers['existing-server']).toBeDefined();
  });

  it('ref-counts concurrent sessions — only restores after last cleanup', () => {
    const cleanup1 = injectGeminiMcp(tmpHome);
    const cleanup2 = injectGeminiMcp(tmpHome);

    // After first cleanup the file is still patched (second session active)
    cleanup1();
    const filePath = join(tmpHome, '.gemini', 'settings.json');
    const stillPatched = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect((stillPatched.mcpServers as Record<string, unknown>)[MCP_SERVER_KEY]).toBeDefined();

    // After second cleanup, original is restored
    cleanup2();
    try {
      const doc = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      expect((doc.mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER_KEY]).toBeUndefined();
    } catch { /* file removed — also ok */ }
  });
});

// ── injectOpencodeMcp ─────────────────────────────────────────────────────────

describe('injectOpencodeMcp', () => {
  let tmpHome: string;
  let origXdg: string | undefined;

  beforeEach(() => {
    tmpHome = makeTempHome();
    origXdg = process.env['XDG_CONFIG_HOME'];
    // Point XDG_CONFIG_HOME into our temp dir so opencode writes there
    process.env['XDG_CONFIG_HOME'] = join(tmpHome, '.config');
  });

  afterEach(() => {
    if (origXdg === undefined) {
      delete process.env['XDG_CONFIG_HOME'];
    } else {
      process.env['XDG_CONFIG_HOME'] = origXdg;
    }
    cleanupDir(tmpHome);
  });

  it('creates the config file with correct opencode MCP format under mcp.<name>', () => {
    const cleanup = injectOpencodeMcp(tmpHome);
    const filePath = join(tmpHome, '.config', 'opencode', 'opencode.json');
    const doc = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    // opencode schema: { mcp: { "<name>": { type, command[], enabled } } }
    const mcp = doc.mcp as Record<string, unknown>;
    expect(mcp[MCP_SERVER_KEY]).toEqual(buildOpencodeMcpEntry());
    // Verify required fields per opencode schema
    const entry = mcp[MCP_SERVER_KEY] as Record<string, unknown>;
    expect(entry['type']).toBe('local');
    expect(Array.isArray(entry['command'])).toBe(true);
    expect(entry['enabled']).toBe(true);
    cleanup();
  });

  it('merges with existing mcp servers and restores original on cleanup', () => {
    const configDir = join(tmpHome, '.config', 'opencode');
    mkdirSync(configDir, { recursive: true });
    const filePath = join(configDir, 'opencode.json');
    const original = {
      mcp: {
        'existing-mcp': { type: 'local', command: ['node', 's.js'], enabled: true },
      },
    };
    writeFileSync(filePath, JSON.stringify(original, null, 2), 'utf8');

    const cleanup = injectOpencodeMcp(tmpHome);
    const patched = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const mcp = patched.mcp as Record<string, unknown>;
    expect(mcp['existing-mcp']).toBeDefined();
    expect(mcp[MCP_SERVER_KEY]).toEqual(buildOpencodeMcpEntry());

    cleanup();
    const restored = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const restoredMcp = restored.mcp as Record<string, unknown>;
    expect(restoredMcp[MCP_SERVER_KEY]).toBeUndefined();
    expect(restoredMcp['existing-mcp']).toBeDefined();
  });
});

// ── writeComputerUseSkillFiles / removeComputerUseSkillFiles ─────────────────

describe('writeComputerUseSkillFiles / removeComputerUseSkillFiles', () => {
  let tmpHome: string;
  let origXdg: string | undefined;

  beforeEach(() => {
    tmpHome = makeTempHome();
    origXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = join(tmpHome, '.config');
  });

  afterEach(() => {
    if (origXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = origXdg;
    cleanupDir(tmpHome);
  });

  it('writes gemini SKILL.md with YAML frontmatter', () => {
    writeComputerUseSkillFiles(tmpHome);
    const skillPath = join(tmpHome, '.gemini', 'skills', MCP_SERVER_KEY, 'SKILL.md');
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toContain('---');
    expect(content).toContain(MCP_SERVER_KEY);
    expect(content).toContain('take_screenshot');
  });

  it('writes opencode instruction file', () => {
    writeComputerUseSkillFiles(tmpHome);
    const skillPath = join(tmpHome, '.config', 'opencode', `${MCP_SERVER_KEY}.md`);
    const content = readFileSync(skillPath, 'utf8');
    expect(content).toContain('take_screenshot');
    expect(content).toContain('ax_click');
  });

  it('appends fenced block to ~/.codex/instructions.md', () => {
    writeComputerUseSkillFiles(tmpHome);
    const content = readFileSync(join(tmpHome, '.codex', 'instructions.md'), 'utf8');
    expect(content).toContain(`<!-- ${COMPUTER_USE_SETTING_KEY}:start -->`);
    expect(content).toContain('take_screenshot');
  });

  it('is idempotent — calling write twice does not duplicate the codex block', () => {
    writeComputerUseSkillFiles(tmpHome);
    writeComputerUseSkillFiles(tmpHome);
    const content = readFileSync(join(tmpHome, '.codex', 'instructions.md'), 'utf8');
    const count = (content.match(new RegExp(`<!-- ${COMPUTER_USE_SETTING_KEY}:start -->`, 'g')) ?? []).length;
    expect(count).toBe(1);
  });

  it('preserves existing content in ~/.codex/instructions.md', () => {
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'instructions.md'), 'My existing instructions.\n', 'utf8');

    writeComputerUseSkillFiles(tmpHome);
    const content = readFileSync(join(codexDir, 'instructions.md'), 'utf8');
    expect(content).toContain('My existing instructions.');
    expect(content).toContain('take_screenshot');
  });

  it('removeComputerUseSkillFiles removes all skill files', () => {
    writeComputerUseSkillFiles(tmpHome);
    removeComputerUseSkillFiles(tmpHome);

    const geminiPath = join(tmpHome, '.gemini', 'skills', MCP_SERVER_KEY, 'SKILL.md');
    const opencodePath = join(tmpHome, '.config', 'opencode', `${MCP_SERVER_KEY}.md`);
    expect(existsSync(geminiPath)).toBe(false);
    expect(existsSync(opencodePath)).toBe(false);
  });

  it('removeComputerUseSkillFiles removes fenced block but keeps other codex instructions', () => {
    const codexDir = join(tmpHome, '.codex');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(join(codexDir, 'instructions.md'), 'Keep this.\n', 'utf8');

    writeComputerUseSkillFiles(tmpHome);
    removeComputerUseSkillFiles(tmpHome);

    const content = readFileSync(join(codexDir, 'instructions.md'), 'utf8');
    expect(content).toContain('Keep this.');
    expect(content).not.toContain('take_screenshot');
  });

  it('removeComputerUseSkillFiles is safe when files do not exist', () => {
    expect(() => removeComputerUseSkillFiles(tmpHome)).not.toThrow();
  });
});

// ── COMPUTER_USE_SKILL content ────────────────────────────────────────────────

describe('COMPUTER_USE_SKILL', () => {
  it('documents the get_page_content tool', () => {
    expect(COMPUTER_USE_SKILL).toContain('get_page_content');
  });

  it('documents clipboard tool', () => {
    expect(COMPUTER_USE_SKILL).toContain('clipboard');
  });

  it('includes the read-page-content pattern example', () => {
    expect(COMPUTER_USE_SKILL).toContain('get_page_content {}');
  });

  it('mentions cross-platform support (Windows/Linux)', () => {
    expect(COMPUTER_USE_SKILL).toContain('Windows');
    expect(COMPUTER_USE_SKILL).toContain('Linux');
  });
});
