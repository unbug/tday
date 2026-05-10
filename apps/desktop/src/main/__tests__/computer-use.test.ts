import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import * as http from 'node:http';

import {
  buildMcpEntry,
  buildOpencodeMcpEntry,
  buildMcpEntryUrl,
  buildGeminiMcpEntryUrl,
  buildOpencodeMcpEntryUrl,
  codexMcpCliArgs,
  codexMcpCliArgsUrl,
  applyClaudeCodeMcp,
  applyClaudeCodeMcpUrl,
  injectGeminiMcp,
  injectGeminiMcpUrl,
  injectOpencodeMcp,
  injectOpencodeMcpUrl,
  injectPiMcp,
  injectPiMcpUrl,
  startCodexApiProxy,
  startMcpSessionProxy,
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

function listenOnLocalhost(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve(address.port);
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
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

  it('documents canonical nativecore tool names, not stale aliases', () => {
    expect(COMPUTER_USE_SKILL).toContain('sys_process');
    expect(COMPUTER_USE_SKILL).toContain('sys_wait');
    expect(COMPUTER_USE_SKILL).toContain('cdp_evaluate_script');
    expect(COMPUTER_USE_SKILL).not.toContain('| `process` |');
    expect(COMPUTER_USE_SKILL).not.toContain('| `wait` |');
    expect(COMPUTER_USE_SKILL).not.toContain('`cdp_evaluate`');
    expect(COMPUTER_USE_SKILL).not.toContain('cdp_fill {id, value}');
    expect(COMPUTER_USE_SKILL).not.toContain('cdp_click {submit button id}');
  });
});

// ── URL-based MCP entry builders ──────────────────────────────────────────────

const TEST_URL = 'http://127.0.0.1:54321/mcp';

describe('buildMcpEntryUrl', () => {
  it('returns url and type:http (claude-code format)', () => {
    const entry = buildMcpEntryUrl(TEST_URL);
    expect(entry.url).toBe(TEST_URL);
    expect(entry.type).toBe('http');
  });

  it('is serialisable to JSON without loss', () => {
    const entry = buildMcpEntryUrl(TEST_URL);
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
  });
});

describe('buildGeminiMcpEntryUrl', () => {
  it('returns url only — no type or transport (Gemini format)', () => {
    const entry = buildGeminiMcpEntryUrl(TEST_URL);
    expect(entry.url).toBe(TEST_URL);
    // Gemini rejects any extra key — must have ONLY url
    expect(Object.keys(entry)).toEqual(['url']);
  });
});

describe('buildOpencodeMcpEntryUrl', () => {
  it('returns type remote with url and enabled=true', () => {
    const entry = buildOpencodeMcpEntryUrl(TEST_URL);
    expect(entry.type).toBe('remote');
    expect(entry.url).toBe(TEST_URL);
    expect(entry.enabled).toBe(true);
  });
});

describe('codexMcpCliArgsUrl', () => {
  it('returns -c flag with mcp_servers.<key>.url=URL', () => {
    const args = codexMcpCliArgsUrl(TEST_URL);
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain(`mcp_servers.${MCP_SERVER_KEY}.url=`);
    expect(args[1]).toContain(TEST_URL);
  });
});

describe('codexMcpCliArgs (command-based, regression)', () => {
  it('returns -c flag with mcp_servers.<key>.command=', () => {
    const args = codexMcpCliArgs();
    expect(args[0]).toBe('-c');
    expect(args[1]).toContain(`mcp_servers.${MCP_SERVER_KEY}.command=`);
  });
});

// ── Codex namespace proxy ────────────────────────────────────────────────────

describe('startCodexApiProxy', () => {
  it('expands namespace tools for upstream and patches non-streaming function calls back', async () => {
    const captured: { upstreamBody?: Record<string, unknown> } = {};
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        captured.upstreamBody = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          output: [{ type: 'function_call', name: 'mcp__tday_computer_use__click', arguments: '{}' }],
        }));
      });
    });
    const upstreamPort = await listenOnLocalhost(upstream);
    const proxy = await startCodexApiProxy(`http://127.0.0.1:${upstreamPort}/v1`);
    try {
      const resp = await fetch(`${proxy.proxyBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            type: 'namespace',
            name: 'mcp__tday_computer_use__',
            tools: [{ type: 'function', name: 'click', parameters: { type: 'object' } }],
          }],
        }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as { output: Array<Record<string, unknown>> };
      if (!captured.upstreamBody) throw new Error('upstream did not receive request body');
      const upstreamTools = captured.upstreamBody.tools as Array<Record<string, unknown>>;
      expect(upstreamTools).toHaveLength(1);
      expect(upstreamTools[0].type).toBe('function');
      expect(upstreamTools[0].name).toBe('mcp__tday_computer_use__click');
      expect(body.output[0].namespace).toBe('mcp__tday_computer_use__');
      expect(body.output[0].name).toBe('click');
    } finally {
      proxy.stop();
      await closeServer(upstream);
    }
  });

  it('patches streaming SSE function_call events back to namespace form', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({
        item: { type: 'function_call', name: 'mcp__tday_computer_use__ax_click', arguments: '{}' },
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const upstreamPort = await listenOnLocalhost(upstream);
    const proxy = await startCodexApiProxy(`http://127.0.0.1:${upstreamPort}/v1`);
    try {
      const resp = await fetch(`${proxy.proxyBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true }),
      });
      expect(resp.status).toBe(200);
      const text = await resp.text();
      expect(text).toContain('"namespace":"mcp__tday_computer_use__"');
      expect(text).toContain('"name":"ax_click"');
      expect(text).toContain('data: [DONE]');
    } finally {
      proxy.stop();
      await closeServer(upstream);
    }
  });

  it('resolves bare tool names (model follows SKILL-text) back to namespace form (non-streaming)', async () => {
    // Simulates: model calls "click" (bare name from SKILL text) instead of
    // "mcp__tday_computer_use__click" (the namespace-prefixed flat name).
    // The proxy must have already seen a namespace-tools request to populate its map.
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        // First request: seed the shortToFlatMcpName map
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        if (Array.isArray(body.tools) && (body.tools as Array<Record<string, unknown>>)[0]?.type === 'function') {
          // Second request (bare-name call) — return the function call with bare name
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            output: [{ type: 'function_call', name: 'click', arguments: '{}' }],
          }));
        } else {
          // First request (namespace-expansion) — return no-op response
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ output: [] }));
        }
      });
    });
    const upstreamPort = await listenOnLocalhost(upstream);
    const proxy = await startCodexApiProxy(`http://127.0.0.1:${upstreamPort}/v1`);
    try {
      // Step 1: send a request with namespace tools to populate the short→flat map
      await fetch(`${proxy.proxyBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            type: 'namespace',
            name: 'mcp__tday_computer_use__',
            tools: [{ type: 'function', name: 'click', parameters: { type: 'object' } }],
          }],
        }),
      });

      // Step 2: simulate model calling the tool with bare name
      const resp = await fetch(`${proxy.proxyBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tools: [{ type: 'function', name: 'click', parameters: { type: 'object' } }] }),
      });
      const body = await resp.json() as { output: Array<Record<string, unknown>> };
      // Even though the model returned bare name "click", the proxy must patch it back
      expect(body.output[0].namespace).toBe('mcp__tday_computer_use__');
      expect(body.output[0].name).toBe('click');
    } finally {
      proxy.stop();
      await closeServer(upstream);
    }
  });

  it('resolves bare tool names back to namespace form in SSE streaming', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Bare name in SSE event — model used SKILL-text short name
      res.write('data: ' + JSON.stringify({
        item: { type: 'function_call', name: 'ax_click', arguments: '{}' },
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const upstreamPort = await listenOnLocalhost(upstream);
    const proxy = await startCodexApiProxy(`http://127.0.0.1:${upstreamPort}/v1`);
    try {
      // Seed the short→flat map first
      const seedUpstream = http.createServer((_req, res) => { res.writeHead(200); res.end('{}'); });
      // Use a second call to the same proxy after seeding via expandNamespaceTools
      await fetch(`${proxy.proxyBaseUrl}/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tools: [{
            type: 'namespace',
            name: 'mcp__tday_computer_use__',
            tools: [{ type: 'function', name: 'ax_click', parameters: { type: 'object' } }],
          }],
        }),
      }).catch(() => { /* seed endpoint doesn't exist on upstream, OK */ });
      await closeServer(seedUpstream);

      const resp = await fetch(`${proxy.proxyBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stream: true }),
      });
      const text = await resp.text();
      // The bare "ax_click" must be patched to namespace form
      expect(text).toContain('"namespace":"mcp__tday_computer_use__"');
      expect(text).toContain('"name":"ax_click"');
    } finally {
      proxy.stop();
      await closeServer(upstream);
    }
  });

  it('returns structured 502 JSON when the upstream is unavailable', async () => {
    const unused = http.createServer();
    const port = await listenOnLocalhost(unused);
    await closeServer(unused);
    const proxy = await startCodexApiProxy(`http://127.0.0.1:${port}/v1`);
    try {
      const resp = await fetch(`${proxy.proxyBaseUrl}/responses`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tools: [] }),
      });
      expect(resp.status).toBe(502);
      expect(resp.headers.get('content-type')).toContain('application/json');
      const body = await resp.json() as Record<string, unknown>;
      expect(body.error).toContain('Proxy upstream error');
      expect(body.phase).toBe('upstream-connect');
      expect(body.retryable).toBe(true);
    } finally {
      proxy.stop();
    }
  });
});

// ── applyClaudeCodeMcpUrl ─────────────────────────────────────────────────────

describe('applyClaudeCodeMcpUrl', () => {
  it('injects url-based mcpServers entry', () => {
    const settings: Record<string, unknown> = { env: {} };
    applyClaudeCodeMcpUrl(settings, TEST_URL);
    const servers = settings.mcpServers as Record<string, unknown>;
    expect(servers[MCP_SERVER_KEY]).toEqual(buildMcpEntryUrl(TEST_URL));
  });

  it('does not add command field to the entry', () => {
    const settings: Record<string, unknown> = { env: {} };
    applyClaudeCodeMcpUrl(settings, TEST_URL);
    const entry = (settings.mcpServers as Record<string, unknown>)[MCP_SERVER_KEY] as Record<string, unknown>;
    expect(entry['command']).toBeUndefined();
  });

  it('injects ANTHROPIC_BETA for Anthropic backend', () => {
    const settings: Record<string, unknown> = { env: {} };
    applyClaudeCodeMcpUrl(settings, TEST_URL, true);
    expect((settings.env as Record<string, string>)['ANTHROPIC_BETA']).toContain('computer-use-2025-01-30');
  });

  it('skips ANTHROPIC_BETA for non-Anthropic backend', () => {
    const settings: Record<string, unknown> = { env: {} };
    applyClaudeCodeMcpUrl(settings, TEST_URL, false);
    expect((settings.env as Record<string, string>)['ANTHROPIC_BETA']).toBeUndefined();
  });

  it('injects custom instructions with skill text', () => {
    const settings: Record<string, unknown> = { env: {} };
    applyClaudeCodeMcpUrl(settings, TEST_URL);
    expect(typeof settings.customInstructions).toBe('string');
    expect(settings.customInstructions as string).toContain(MCP_SERVER_KEY);
  });

  it('auto-allows tool calls', () => {
    const settings: Record<string, unknown> = { env: {} };
    applyClaudeCodeMcpUrl(settings, TEST_URL);
    const perms = settings.permissions as { allow: string[] };
    expect(perms.allow.some((g) => g.includes(MCP_SERVER_KEY))).toBe(true);
  });

  it('is idempotent when called twice', () => {
    const settings: Record<string, unknown> = { env: {} };
    applyClaudeCodeMcpUrl(settings, TEST_URL);
    applyClaudeCodeMcpUrl(settings, TEST_URL);
    const servers = settings.mcpServers as Record<string, unknown>;
    expect(Object.keys(servers).filter((k) => k === MCP_SERVER_KEY)).toHaveLength(1);
  });
});

// ── injectGeminiMcpUrl ────────────────────────────────────────────────────────

describe('injectGeminiMcpUrl', () => {
  let tmpHome: string;

  beforeEach(() => { tmpHome = makeTempHome(); });
  afterEach(() => { cleanupDir(tmpHome); });

  it('creates settings.json with url-only entry (no type/transport)', () => {
    const cleanup = injectGeminiMcpUrl(TEST_URL, tmpHome);
    const filePath = join(tmpHome, '.gemini', 'settings.json');
    const doc = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const entry = (doc.mcpServers as Record<string, unknown>)[MCP_SERVER_KEY] as Record<string, unknown>;
    expect(entry['url']).toBe(TEST_URL);
    // Gemini CLI rejects 'transport' and 'type' keys — must not be present
    expect(entry['transport']).toBeUndefined();
    expect(entry['type']).toBeUndefined();
    expect(entry['command']).toBeUndefined();
    cleanup();
  });

  it('restores original content after cleanup', () => {
    const geminiDir = join(tmpHome, '.gemini');
    mkdirSync(geminiDir, { recursive: true });
    const filePath = join(geminiDir, 'settings.json');
    const original = { theme: 'dark' };
    writeFileSync(filePath, JSON.stringify(original), 'utf8');

    const cleanup = injectGeminiMcpUrl(TEST_URL, tmpHome);
    cleanup();

    const restored = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(restored['theme']).toBe('dark');
    expect((restored.mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER_KEY]).toBeUndefined();
  });

  it('ref-counts concurrent URL injections', () => {
    const cleanup1 = injectGeminiMcpUrl(TEST_URL, tmpHome);
    const cleanup2 = injectGeminiMcpUrl(TEST_URL, tmpHome);
    cleanup1();
    const filePath = join(tmpHome, '.gemini', 'settings.json');
    const stillPatched = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect((stillPatched.mcpServers as Record<string, unknown>)[MCP_SERVER_KEY]).toBeDefined();
    cleanup2();
    try {
      const doc = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      expect((doc.mcpServers as Record<string, unknown> | undefined)?.[MCP_SERVER_KEY]).toBeUndefined();
    } catch { /* file removed — also ok */ }
  });
});

// ── injectOpencodeMcpUrl ──────────────────────────────────────────────────────

describe('injectOpencodeMcpUrl', () => {
  let tmpHome: string;

  beforeEach(() => { tmpHome = makeTempHome(); });
  afterEach(() => { cleanupDir(tmpHome); });

  it('creates opencode.json with remote type entry', () => {
    const cleanup = injectOpencodeMcpUrl(TEST_URL, tmpHome);
    const xdgBase = join(tmpHome, '.config');
    const filePath = join(xdgBase, 'opencode', 'opencode.json');
    const doc = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    const entry = (doc.mcp as Record<string, unknown>)[MCP_SERVER_KEY] as Record<string, unknown>;
    expect(entry['type']).toBe('remote');
    expect(entry['url']).toBe(TEST_URL);
    expect(entry['enabled']).toBe(true);
    expect(entry['command']).toBeUndefined();
    cleanup();
  });
});

// ── injectPiMcp (stdio fallback) ──────────────────────────────────────────────

describe('injectPiMcp', () => {
  it('returns extensionPath pointing to bridge file', () => {
    const { extensionPath } = injectPiMcp();
    expect(extensionPath).toMatch(/pi-computer-use-bridge\.ts$/);
  });

  it('returns TDAY_DEVTOOLS_BIN env var with binary path', () => {
    const { env } = injectPiMcp();
    expect(env['TDAY_DEVTOOLS_BIN']).toMatch(/tday-nativecore(\.exe)?$/);
  });

  it('does not include TDAY_DEVTOOLS_URL', () => {
    const { env } = injectPiMcp();
    expect(env['TDAY_DEVTOOLS_URL']).toBeUndefined();
  });

  it('cleanup is a no-op and does not throw', () => {
    const { cleanup } = injectPiMcp();
    expect(() => cleanup()).not.toThrow();
  });
});

// ── injectPiMcpUrl (HTTP mode) ────────────────────────────────────────────────

describe('injectPiMcpUrl', () => {
  it('returns extensionPath pointing to bridge file', () => {
    const { extensionPath } = injectPiMcpUrl(TEST_URL);
    expect(extensionPath).toMatch(/pi-computer-use-bridge\.ts$/);
  });

  it('returns TDAY_DEVTOOLS_URL env var with the given URL', () => {
    const { env } = injectPiMcpUrl(TEST_URL);
    expect(env['TDAY_DEVTOOLS_URL']).toBe(TEST_URL);
  });

  it('does not include TDAY_DEVTOOLS_BIN', () => {
    const { env } = injectPiMcpUrl(TEST_URL);
    expect(env['TDAY_DEVTOOLS_BIN']).toBeUndefined();
  });

  it('both HTTP and stdio env vars are never present at the same time', () => {
    const httpEnv  = injectPiMcpUrl(TEST_URL).env;
    const stdioEnv = injectPiMcp().env;
    expect(Object.keys(httpEnv)).not.toContain('TDAY_DEVTOOLS_BIN');
    expect(Object.keys(stdioEnv)).not.toContain('TDAY_DEVTOOLS_URL');
  });

  it('same extension file is used in both modes', () => {
    const { extensionPath: httpPath  } = injectPiMcpUrl(TEST_URL);
    const { extensionPath: stdioPath } = injectPiMcp();
    expect(httpPath).toBe(stdioPath);
  });
});

// ── startMcpSessionProxy ──────────────────────────────────────────────────────

describe('startMcpSessionProxy', () => {
  it('proxies a basic POST request to nativecore and returns the response', async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-abc' });
      res.end(JSON.stringify({ jsonrpc: '2.0', result: 'ok', id: 1 }));
    });
    const upstreamPort = await listenOnLocalhost(upstream);
    const proxy = await startMcpSessionProxy(`http://127.0.0.1:${upstreamPort}`);
    try {
      const resp = await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      expect(body.result).toBe('ok');
    } finally {
      proxy.stop();
      await closeServer(upstream);
    }
  });

  it('injects stored Mcp-Session-Id into subsequent requests that lack it', async () => {
    const receivedHeaders: string[] = [];
    const upstream = http.createServer((req, res) => {
      receivedHeaders.push(req.headers['mcp-session-id'] as string ?? '');
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-xyz' });
      res.end(JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }));
    });
    const upstreamPort = await listenOnLocalhost(upstream);
    const proxy = await startMcpSessionProxy(`http://127.0.0.1:${upstreamPort}`);
    try {
      // 1st request: initialize — establishes session ID
      await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      // 2nd request: tool call without Mcp-Session-Id header
      await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 2, params: { name: 'click' } }),
      });
      // Upstream should have received the session ID on the 2nd request
      expect(receivedHeaders[1]).toBe('sess-xyz');
    } finally {
      proxy.stop();
      await closeServer(upstream);
    }
  });

  it('re-initializes transparently on 422 and replays the original request', async () => {
    let requestCount = 0;
    let toolCallAttempts = 0;
    const upstream = http.createServer((req, res) => {
      requestCount++;
      const body: Buffer[] = [];
      req.on('data', (c: Buffer) => body.push(c));
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(body).toString('utf8')) as { method?: string };
        if (parsed.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-new' });
          res.end(JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }));
        } else if (parsed.method === 'notifications/initialized') {
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end('');
        } else if (parsed.method === 'tools/call') {
          toolCallAttempts++;
          if (toolCallAttempts === 1) {
            // First tool call: simulate session expiry (422)
            res.writeHead(422, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'Unexpected message, expect initialize' }));
          } else {
            // Replayed tool call (after re-init): succeed
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', result: { content: [] }, id: 2 }));
          }
        } else {
          res.writeHead(400);
          res.end('unexpected method');
        }
      });
    });
    const upstreamPort = await listenOnLocalhost(upstream);
    const proxy = await startMcpSessionProxy(`http://127.0.0.1:${upstreamPort}`);
    try {
      // Initialize to prime session ID
      await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      // Send notifications/initialized (so proxy caches it for replay)
      await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      // Tool call that triggers 422 → proxy should re-init + replay transparently
      const resp = await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 2, params: { name: 'click' } }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      expect((body.result as Record<string, unknown>).content).toBeDefined();
      // Calls: init(1) + notif(2) + tool→422(3) + re-init(4) + notif-replay(5) + tool-replay(6)
      expect(requestCount).toBe(6);
    } finally {
      proxy.stop();
      await closeServer(upstream);
    }
  });

  it('re-initializes transparently on 401 (session not found) and replays', async () => {
    let requestCount = 0;
    let toolCallAttempts = 0;
    const upstream = http.createServer((req, res) => {
      requestCount++;
      const body: Buffer[] = [];
      req.on('data', (c: Buffer) => body.push(c));
      req.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(body).toString('utf8')) as { method?: string };
        if (parsed.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-renewed' });
          res.end(JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }));
        } else if (parsed.method === 'notifications/initialized') {
          res.writeHead(202);
          res.end('');
        } else if (parsed.method === 'tools/call') {
          toolCallAttempts++;
          if (toolCallAttempts === 1) {
            // Simulate session eviction (nativecore restarted) — 401 Unauthorized
            res.writeHead(401, { 'content-type': 'text/plain' });
            res.end('Unauthorized: Session not found');
          } else {
            // Replayed tool call after re-init — succeed
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ jsonrpc: '2.0', result: { ok: true }, id: 2 }));
          }
        } else {
          res.writeHead(400);
          res.end('unexpected method');
        }
      });
    });
    const upstreamPort = await listenOnLocalhost(upstream);
    const proxy = await startMcpSessionProxy(`http://127.0.0.1:${upstreamPort}`);
    try {
      await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      });
      await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      const resp = await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 2, params: { name: 'click' } }),
      });
      expect(resp.status).toBe(200);
      const body = await resp.json() as Record<string, unknown>;
      expect((body.result as Record<string, unknown>).ok).toBe(true);
      // init(1) + notif(2) + tool→401(3) + re-init(4) + notif-replay(5) + tool-replay(6)
      expect(requestCount).toBe(6);
    } finally {
      proxy.stop();
      await closeServer(upstream);
    }
  });

  it('returns 502 when nativecore is unreachable', async () => {
    const unused = http.createServer(() => { /* never used */ });
    const port = await listenOnLocalhost(unused);
    await closeServer(unused);
    const proxy = await startMcpSessionProxy(`http://127.0.0.1:${port}`);
    try {
      const resp = await fetch(`${proxy.proxyBaseUrl}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: {} }),
      });
      expect(resp.status).toBe(502);
    } finally {
      proxy.stop();
    }
  });
});
