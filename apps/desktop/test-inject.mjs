/**
 * Standalone smoke-test for Computer Use MCP injection.
 * Uses a temp home dir so real config files are never touched.
 *
 *   node apps/desktop/test-inject.mjs
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, mkdtempSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Inline the injectable logic (mirrors computer-use.ts, no electron dep) ──

const MCP_SERVER_KEY = 'tday-computer-use';
const SKILL_MARKER   = 'tday:computerUseEnabled';
const DEV_BINARY     = join(__dirname, '../../crates/tday-devtools/target/release/tday-devtools');

const activeInjections = new Map();

function devToolsBinaryPath() { return DEV_BINARY; }

function buildMcpEntry() { return { command: devToolsBinaryPath(), args: [] }; }
function buildOpencodeMcpEntry() { return { type: 'local', command: [devToolsBinaryPath()], enabled: true }; }

function setNestedKey(doc, keyPath, update) {
  const parts = keyPath.split('.');
  let obj = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    if (obj[parts[i]] == null || typeof obj[parts[i]] !== 'object' || Array.isArray(obj[parts[i]])) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  const cur = (obj[leaf] != null && typeof obj[leaf] === 'object' && !Array.isArray(obj[leaf])) ? obj[leaf] : {};
  obj[leaf] = update(cur);
}

function removeServerKey(obj) {
  for (const k of Object.keys(obj)) {
    if (k === MCP_SERVER_KEY) delete obj[k];
    else if (obj[k] != null && typeof obj[k] === 'object' && !Array.isArray(obj[k])) removeServerKey(obj[k]);
  }
}

function injectMcpToFile(filePath, dir, keyPath, entry = buildMcpEntry()) {
  const existing = activeInjections.get(filePath);
  if (existing && existing.count > 0) { existing.count++; return makeCleanup(filePath); }
  let original = null;
  try {
    mkdirSync(dir, { recursive: true });
    try { original = readFileSync(filePath, 'utf8'); } catch { original = null; }
    const doc = original ? JSON.parse(original) : {};
    setNestedKey(doc, keyPath, cur => ({ ...cur, [MCP_SERVER_KEY]: entry }));
    writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf8');
    activeInjections.set(filePath, { count: 1, original });
  } catch (e) { console.warn('inject failed', e); return () => {}; }
  return makeCleanup(filePath);
}

function makeCleanup(filePath) {
  return () => {
    const entry = activeInjections.get(filePath);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count > 0) return;
    activeInjections.delete(filePath);
    try {
      if (entry.original !== null) writeFileSync(filePath, entry.original, 'utf8');
      else {
        try {
          const cur = JSON.parse(readFileSync(filePath, 'utf8'));
          removeServerKey(cur);
          writeFileSync(filePath, JSON.stringify(cur, null, 2), 'utf8');
        } catch {}
      }
    } catch (e) { console.warn('cleanup failed', e); }
  };
}

function injectGeminiMcp(home) {
  const dir = join(home, '.gemini');
  return injectMcpToFile(join(dir, 'settings.json'), dir, 'mcpServers');
}

function injectOpencodeMcp(home) {
  const dir = join(home, '.config', 'opencode');
  return injectMcpToFile(join(dir, 'opencode.json'), dir, 'mcp', buildOpencodeMcpEntry());
}

function injectCodexMcp(home) {
  const dir = join(home, '.codex');
  const filePath = join(dir, 'config.toml');
  const sectionHeader = `[mcp_servers.${MCP_SERVER_KEY}]`;
  const existing = activeInjections.get(filePath);
  if (existing && existing.count > 0) { existing.count++; return makeCodexCleanup(filePath, sectionHeader); }
  let original = null;
  try {
    mkdirSync(dir, { recursive: true });
    try { original = readFileSync(filePath, 'utf8'); } catch { original = null; }
    const content = original ?? '';
    if (!content.includes(sectionHeader)) {
      const block = `\n[mcp_servers.${MCP_SERVER_KEY}]\ncommand = ${JSON.stringify(devToolsBinaryPath())}\n`;
      writeFileSync(filePath, content + block, 'utf8');
    }
    activeInjections.set(filePath, { count: 1, original });
  } catch (e) { console.warn('codex inject failed', e); return () => {}; }
  return makeCodexCleanup(filePath, sectionHeader);
}

function makeCodexCleanup(filePath, sectionHeader) {
  return () => {
    const entry = activeInjections.get(filePath);
    if (!entry) return;
    entry.count = Math.max(0, entry.count - 1);
    if (entry.count > 0) return;
    activeInjections.delete(filePath);
    try {
      if (entry.original !== null) writeFileSync(filePath, entry.original, 'utf8');
      else {
        try {
          const cur = readFileSync(filePath, 'utf8');
          const escaped = sectionHeader.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const cleaned = cur.replace(new RegExp(`\\n?${escaped}\\n[^\\[]*`, 'g'), '');
          if (cleaned.trim()) writeFileSync(filePath, cleaned, 'utf8'); else rmSync(filePath);
        } catch {}
      }
    } catch (e) { console.warn('codex cleanup failed', e); }
  };
}

function appendMarkdownBlock(filePath, dir, content) {
  const open = `<!-- ${SKILL_MARKER}:start -->`;
  const close = `<!-- ${SKILL_MARKER}:end -->`;
  try {
    mkdirSync(dir, { recursive: true });
    let existing = '';
    try { existing = readFileSync(filePath, 'utf8'); } catch {}
    const blockRe = new RegExp(`${open}[\\s\\S]*?${close}`, 'g');
    const block = `${open}\n${content}\n${close}`;
    if (existing.includes(open)) writeFileSync(filePath, existing.replace(blockRe, block), 'utf8');
    else writeFileSync(filePath, `${existing}\n\n${block}\n`, 'utf8');
  } catch (e) { console.warn(`appendMarkdown failed ${filePath}:`, e); }
}

function patchOpencodeInstructions(configFilePath, skillFilePath, add) {
  try {
    let doc = {};
    try { doc = JSON.parse(readFileSync(configFilePath, 'utf8')); } catch {}
    let instructions = Array.isArray(doc.instructions) ? doc.instructions : [];
    if (add) { if (!instructions.includes(skillFilePath)) instructions = [...instructions, skillFilePath]; }
    else instructions = instructions.filter(p => p !== skillFilePath);
    if (instructions.length > 0) doc.instructions = instructions; else delete doc.instructions;
    writeFileSync(configFilePath, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch (e) { console.warn(`patchOpencodeInstructions failed:`, e); }
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;
function ok(label, cond, detail = '') {
  if (cond) { console.log(`  ✅  ${label}`); passed++; }
  else { console.error(`  ❌  ${label}${detail ? '  →  ' + detail : ''}`); failed++; }
}

function testAgent(name, fn) {
  console.log(`\n──── ${name} ────`);
  try { fn(); } catch(e) { console.error('  THREW:', e.message); failed++; }
}

// ── per-agent tests ───────────────────────────────────────────────────────────

testAgent('gemini', () => {
  const home = mkdtempSync(join(tmpdir(), 'tday-gemini-'));
  // Pre-existing file
  const dir = join(home, '.gemini');
  mkdirSync(dir, { recursive: true });
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }, null, 2), 'utf8');

  const cleanup = injectGeminiMcp(home);
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  ok('mcpServers key exists', !!after.mcpServers, JSON.stringify(after));
  ok('tday-computer-use entry added', !!after.mcpServers[MCP_SERVER_KEY]);
  ok('command points to binary', after.mcpServers[MCP_SERVER_KEY].command === DEV_BINARY,
     after.mcpServers[MCP_SERVER_KEY].command);
  ok('existing theme preserved', after.theme === 'dark');

  cleanup();
  const restored = JSON.parse(readFileSync(settingsPath, 'utf8'));
  ok('cleanup restores original', JSON.stringify(restored) === JSON.stringify({ theme: 'dark' }));

  // Test: no pre-existing file
  const home2 = mkdtempSync(join(tmpdir(), 'tday-gemini2-'));
  const dir2 = join(home2, '.gemini');
  const settingsPath2 = join(dir2, 'settings.json');
  const cleanup2 = injectGeminiMcp(home2);
  const after2 = JSON.parse(readFileSync(settingsPath2, 'utf8'));
  ok('creates file from scratch', !!after2.mcpServers?.[MCP_SERVER_KEY]);
  cleanup2();
  ok('cleanup removes our key from new file', !JSON.parse(readFileSync(settingsPath2, 'utf8')).mcpServers?.[MCP_SERVER_KEY]);

  rmSync(home, { recursive: true }); rmSync(home2, { recursive: true });
});

testAgent('opencode (MCP + instructions)', () => {
  const home = mkdtempSync(join(tmpdir(), 'tday-opencode-'));
  const cfgDir = join(home, '.config', 'opencode');
  const cfgFile = join(cfgDir, 'opencode.json');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(cfgFile, JSON.stringify({ '$schema': 'https://opencode.ai/config.json' }, null, 2), 'utf8');

  // MCP injection
  const cleanup = injectOpencodeMcp(home);
  const after = JSON.parse(readFileSync(cfgFile, 'utf8'));
  ok('mcp key exists', !!after.mcp);
  ok('tday-computer-use added to mcp', !!after.mcp[MCP_SERVER_KEY]);
  ok('type=local', after.mcp[MCP_SERVER_KEY].type === 'local');
  ok('command array contains binary', after.mcp[MCP_SERVER_KEY].command?.[0] === DEV_BINARY,
     JSON.stringify(after.mcp[MCP_SERVER_KEY].command));
  ok('enabled=true', after.mcp[MCP_SERVER_KEY].enabled === true);
  ok('schema preserved', after['$schema'] === 'https://opencode.ai/config.json');

  cleanup();
  const restored = JSON.parse(readFileSync(cfgFile, 'utf8'));
  ok('cleanup removes mcp entry', !restored.mcp?.[MCP_SERVER_KEY]);

  // instructions injection (skill file)
  const skillPath = join(cfgDir, `${MCP_SERVER_KEY}.md`);
  writeFileSync(skillPath, 'SKILL CONTENT\n', 'utf8');
  patchOpencodeInstructions(cfgFile, skillPath, true);
  const withInstr = JSON.parse(readFileSync(cfgFile, 'utf8'));
  ok('instructions array contains skill path', Array.isArray(withInstr.instructions) && withInstr.instructions.includes(skillPath),
     JSON.stringify(withInstr.instructions));

  patchOpencodeInstructions(cfgFile, skillPath, false);
  const noInstr = JSON.parse(readFileSync(cfgFile, 'utf8'));
  ok('instructions array cleaned after remove', !noInstr.instructions || !noInstr.instructions.includes(skillPath));

  rmSync(home, { recursive: true });
});

testAgent('codex (TOML + instructions.md)', () => {
  const home = mkdtempSync(join(tmpdir(), 'tday-codex-'));
  const dir = join(home, '.codex');

  // Fresh install (no pre-existing toml)
  const cleanup1 = injectCodexMcp(home);
  const toml1 = readFileSync(join(dir, 'config.toml'), 'utf8');
  ok('section header written', toml1.includes(`[mcp_servers.${MCP_SERVER_KEY}]`));
  ok('command line written', toml1.includes(`command = `));
  ok('binary path in command', toml1.includes(DEV_BINARY));

  cleanup1();
  ok('file removed after cleanup (was empty)', !existsSync(join(dir, 'config.toml')));

  // Pre-existing toml
  mkdirSync(dir, { recursive: true });
  const existingToml = `model = "gpt-4o"\napproval_policy = "never"\n`;
  writeFileSync(join(dir, 'config.toml'), existingToml, 'utf8');
  const cleanup2 = injectCodexMcp(home);
  const toml2 = readFileSync(join(dir, 'config.toml'), 'utf8');
  ok('appended to existing toml', toml2.includes('model = "gpt-4o"') && toml2.includes(`[mcp_servers.${MCP_SERVER_KEY}]`));

  cleanup2();
  const restored = readFileSync(join(dir, 'config.toml'), 'utf8');
  ok('cleanup restores original toml', restored === existingToml);

  // codex instructions.md block
  const instrFile = join(dir, 'instructions.md');
  appendMarkdownBlock(instrFile, dir, 'SKILL CONTENT');
  const instr = readFileSync(instrFile, 'utf8');
  ok('skill block written to instructions.md', instr.includes(`<!-- ${SKILL_MARKER}:start -->`));
  ok('skill content inside block', instr.includes('SKILL CONTENT'));

  // Re-running appendMarkdownBlock is idempotent
  appendMarkdownBlock(instrFile, dir, 'SKILL CONTENT v2');
  const instr2 = readFileSync(instrFile, 'utf8');
  ok('idempotent update (no duplicate blocks)',
     (instr2.match(new RegExp(`<!-- ${SKILL_MARKER}:start -->`, 'g')) || []).length === 1);
  ok('content updated in-place', instr2.includes('SKILL CONTENT v2'));

  rmSync(home, { recursive: true });
});

testAgent('pi (extension path only — no persistent config)', () => {
  // pi injection just returns the bridge file path + env var; no config file
  // In dev mode, compiled main is at dist/main/, so bridge is at ../../resources relative to it.
  // The test file is at apps/desktop/, so relative path is just resources/
  const bridgeDev = join(__dirname, 'resources/pi-computer-use-bridge.ts');
  ok('bridge file exists in resources/', existsSync(bridgeDev), bridgeDev);
  ok('TDAY_DEVTOOLS_BIN points to real binary', existsSync(DEV_BINARY), DEV_BINARY);

  // Skill file
  const home = mkdtempSync(join(tmpdir(), 'tday-pi-'));
  const skillDir = join(home, '.pi', 'agent', 'skills');
  const skillFile = join(skillDir, `${MCP_SERVER_KEY}.md`);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, 'SKILL\n', 'utf8');
  ok('pi skill file writable', existsSync(skillFile));
  rmSync(home, { recursive: true });
});

testAgent('claude-code (session settings + customInstructions)', () => {
  // Simulate what index.ts does: build session settings object and apply MCP
  // COMPUTER_USE_SKILL contains MCP_SERVER_KEY in its content (tool names reference tday-computer-use)
  const FAKE_SKILL = `Use \`mcp__${MCP_SERVER_KEY}__take_screenshot\` to take screenshots.`;
  function applyClaudeCodeMcp(sessionSettings) {
    const existing = sessionSettings.mcpServers ?? {};
    sessionSettings.mcpServers = { ...existing, [MCP_SERVER_KEY]: buildMcpEntry() };
    const existingInstr = typeof sessionSettings.customInstructions === 'string' ? sessionSettings.customInstructions : '';
    if (!existingInstr.includes(MCP_SERVER_KEY))
      sessionSettings.customInstructions = existingInstr ? `${existingInstr}\n\n${FAKE_SKILL}` : FAKE_SKILL;
    const existingPerms = sessionSettings.permissions ?? {};
    const allowList = existingPerms.allow ?? [];
    const toolGlob = `mcp__${MCP_SERVER_KEY}__*`;
    if (!allowList.includes(toolGlob)) sessionSettings.permissions = { ...existingPerms, allow: [...allowList, toolGlob] };
    const env = sessionSettings.env ?? {};
    const betaFlag = 'computer-use-2025-01-30';
    const existingBeta = env.ANTHROPIC_BETA ?? '';
    if (!existingBeta.split(',').map(s => s.trim()).includes(betaFlag))
      env.ANTHROPIC_BETA = existingBeta ? `${existingBeta},${betaFlag}` : betaFlag;
    sessionSettings.env = env;
  }

  const settings = { model: { provider: 'anthropic', modelId: 'claude-opus-4-5' } };
  applyClaudeCodeMcp(settings);

  ok('mcpServers.tday-computer-use added', !!settings.mcpServers[MCP_SERVER_KEY]);
  ok('command points to binary', settings.mcpServers[MCP_SERVER_KEY].command === DEV_BINARY);
  ok('customInstructions injected', settings.customInstructions?.includes(MCP_SERVER_KEY));
  ok('permissions.allow includes mcp glob', settings.permissions?.allow?.includes(`mcp__${MCP_SERVER_KEY}__*`));
  ok('ANTHROPIC_BETA set', settings.env?.ANTHROPIC_BETA?.includes('computer-use-2025-01-30'));
  ok('model preserved', settings.model?.provider === 'anthropic');

  // Idempotent — second call must not duplicate the skill block
  applyClaudeCodeMcp(settings);
  const mcpOccurrences = (settings.customInstructions?.match(new RegExp(MCP_SERVER_KEY, 'g')) || []).length;
  ok('customInstructions not duplicated', mcpOccurrences === 1, `found ${mcpOccurrences} occurrences`);
  ok('permissions.allow no duplicate glob',
     (settings.permissions?.allow?.filter(x => x === `mcp__${MCP_SERVER_KEY}__*`) || []).length === 1);
});

testAgent('ref-count: concurrent sessions same agent', () => {
  const home = mkdtempSync(join(tmpdir(), 'tday-refcount-'));
  const dir = join(home, '.gemini');
  const settingsPath = join(dir, 'settings.json');

  const c1 = injectGeminiMcp(home);
  const c2 = injectGeminiMcp(home);   // second session
  const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
  ok('still injected after 2 sessions', !!after.mcpServers?.[MCP_SERVER_KEY]);

  c1();  // first session ends
  ok('still injected after 1st cleanup', !!JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers?.[MCP_SERVER_KEY]);

  c2();  // second session ends
  ok('key removed after last cleanup', !JSON.parse(readFileSync(settingsPath, 'utf8')).mcpServers?.[MCP_SERVER_KEY]);

  rmSync(home, { recursive: true });
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
