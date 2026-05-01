/**
 * Comprehensive test for the new Anthropic-endpoint gateway.
 *
 * Tests two layers:
 *   1. DeepSeek Anthropic endpoint directly  (real API calls)
 *   2. Unit tests of inlined gateway logic functions
 *
 * Run: node apps/desktop/gateway-test-anthropic.mjs
 */

import { createHash } from 'node:crypto';

const API_KEY = 'sk-18c8029503944f95835348cc62f0762d';
const ANTHROPIC_URL = 'https://api.deepseek.com/anthropic/v1/messages';
const MODEL = 'deepseek-v4-pro';
const ANTHROPIC_VERSION = '2023-06-01';

// ─── Test harness ────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const errors = [];

function assert(condition, msg) {
  if (!condition) {
    failed++;
    errors.push(`  FAIL: ${msg}`);
    console.log(`  ✗ ${msg}`);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function assertEq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (!ok) {
    failed++;
    const err = `  FAIL: ${msg}\n      got:      ${JSON.stringify(a)}\n      expected: ${JSON.stringify(b)}`;
    errors.push(err);
    console.log(err);
  } else {
    passed++;
    console.log(`  ✓ ${msg}`);
  }
}

function section(name) {
  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`  ${name}`);
  console.log(`══════════════════════════════════════════════════════════`);
}

async function anthropicCall(body) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function anthropicStream(body) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic stream error ${res.status}: ${text}`);
  }
  const text = await res.text();
  return parseAnthropicSse(text);
}

function parseAnthropicSse(text) {
  const events = [];
  const lines = text.split('\n');
  let evType = '';
  let dataLines = [];
  const flush = () => {
    if (!dataLines.length) return;
    try {
      const e = JSON.parse(dataLines.join('\n'));
      if (!e.type && evType) e.type = evType;
      events.push(e);
    } catch { /* ignore */ }
    dataLines = [];
    evType = '';
  };
  for (const line of lines) {
    if (!line) { flush(); continue; }
    if (line.startsWith('event:')) { evType = line.slice(6).trim(); continue; }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  flush();
  return events;
}

// ─── Inlined gateway logic (pure JS mirrors of the TypeScript implementation) ─

const THINKING_PREFIX = 'tday:deepseek_thinking:v1:';

function encodeThinkingSummary(thinking, signature) {
  if (thinking) return thinking;
  if (!signature) return '';
  const payload = JSON.stringify({ thinking, signature });
  return THINKING_PREFIX + Buffer.from(payload).toString('base64url');
}

function decodeThinkingSummary(text) {
  if (!text) return null;
  if (!text.startsWith(THINKING_PREFIX)) return { thinking: text, signature: '' };
  const encoded = text.slice(THINKING_PREFIX.length);
  try {
    const payload = Buffer.from(encoded, 'base64url').toString('utf8');
    const decoded = JSON.parse(payload);
    if (!decoded.thinking && !decoded.signature) return null;
    return decoded;
  } catch {
    return { thinking: text, signature: '' };
  }
}

function stripReasoningContent(input) {
  if (!Array.isArray(input)) return input;
  const str = JSON.stringify(input);
  if (!str.includes('reasoning_content')) return input;
  return input.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (!('reasoning_content' in item)) return item;
    const { reasoning_content: _drop, ...rest } = item;
    return rest;
  });
}

function contentBlocksFromContent(content) {
  if (content === null || content === undefined || content === '') return [];
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (!trimmed) return [];
    return [{ type: 'text', text: trimmed }];
  }
  if (Array.isArray(content)) {
    const blocks = [];
    for (const part of content) {
      if (typeof part === 'string') {
        if (part.trim()) blocks.push({ type: 'text', text: part });
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      const pType = part.type ?? '';
      if (pType === 'input_text' || pType === 'text' || pType === 'output_text') {
        if (part.text) blocks.push({ type: 'text', text: part.text });
      }
    }
    return blocks;
  }
  if (typeof content === 'object') {
    const text = content.text ?? content.output_text ?? content.input_text ?? '';
    if (typeof text === 'string' && text.trim()) return [{ type: 'text', text }];
  }
  return [];
}

function toolInputFromArguments(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  if (typeof args === 'string') {
    const trimmed = args.trim();
    if (!trimmed) return {};
    try { return JSON.parse(trimmed); } catch { return { raw: trimmed }; }
  }
  return {};
}

function thinkingTextKey(text) {
  return createHash('sha256').update(text).digest('hex');
}

class ThinkingState {
  records = new Map();
  recordOrder = [];
  textRecords = new Map();
  textOrder = [];
  limit = 1024;

  rememberForToolCalls(toolCallIds, thinking, signature) {
    if (!thinking && !signature) return;
    for (const id of toolCallIds) {
      if (!id) continue;
      if (!this.records.has(id)) this.recordOrder.push(id);
      this.records.set(id, { thinking, signature });
    }
  }

  rememberForAssistantText(text, thinking, signature) {
    if (!text || (!thinking && !signature)) return;
    const key = thinkingTextKey(text);
    if (!this.textRecords.has(key)) this.textOrder.push(key);
    this.textRecords.set(key, { thinking, signature });
  }

  rememberFromContent(blocks) {
    let thinking = '';
    let signature = '';
    const toolCallIds = [];
    let assistantText = '';
    for (const b of blocks) {
      if (b.type === 'thinking') { thinking = b.thinking ?? ''; signature = b.signature ?? ''; }
      else if (b.type === 'reasoning_content') { thinking = b.text ?? ''; }
      else if (b.type === 'tool_use' && b.id) toolCallIds.push(b.id);
      else if (b.type === 'text') assistantText += b.text ?? '';
    }
    this.rememberForToolCalls(toolCallIds, thinking, signature);
    this.rememberForAssistantText(assistantText, thinking, signature);
  }

  getCachedForToolCall(id) { return this.records.get(id); }
  getCachedForAssistantText(text) { return text ? this.textRecords.get(thinkingTextKey(text)) : undefined; }
}

function convertInput(rawInput, instructions, thinkingState) {
  const input = stripReasoningContent(rawInput);
  const messages = [];
  const system = [];
  if (typeof instructions === 'string' && instructions.trim()) {
    system.push({ type: 'text', text: instructions });
  }
  let pendingSummary;
  let hasToolHistory = false;

  const items = Array.isArray(input) ? input
    : typeof input === 'string' && input ? [{ role: 'user', content: input }]
    : [];

  const appendAssistant = (block) => {
    const last = messages[messages.length - 1];
    if (last?.role === 'assistant') last.content.push(block);
    else messages.push({ role: 'assistant', content: [block] });
  };
  const appendToolResult = (block) => {
    const last = messages[messages.length - 1];
    if (last?.role === 'user' && last.content.every((b) => b.type === 'tool_result')) last.content.push(block);
    else messages.push({ role: 'user', content: [block] });
  };
  const hasThinking = (blocks) => blocks.some((b) => b.type === 'thinking');
  const prependThinking = (target_messages, entry) => {
    const last = target_messages[target_messages.length - 1];
    if (!last || last.role !== 'assistant' || hasThinking(last.content)) return;
    const b = { type: 'thinking', thinking: entry.thinking };
    if (entry.signature) b.signature = entry.signature;
    last.content = [b, ...last.content];
  };
  const resolveThinkingForTool = (callId, summary) => {
    if (summary) {
      for (const item of summary) {
        if (item.type !== 'summary_text') continue;
        const decoded = decodeThinkingSummary(item.text);
        if (decoded && (decoded.thinking || decoded.signature)) {
          prependThinking(messages, decoded);
          return;
        }
      }
    }
    const cached = thinkingState?.getCachedForToolCall(callId);
    if (cached) { prependThinking(messages, cached); return; }
    prependThinking(messages, { thinking: '', signature: '' });
  };

  for (const item of items) {
    const type = item.type ?? '';
    const role = item.role ?? '';
    if (item.phase === 'commentary' || type === 'web_search_call') continue;
    if (type === 'reasoning') { pendingSummary = item.summary; continue; }
    if (type === 'function_call') {
      hasToolHistory = true;
      const callId = item.call_id ?? item.id ?? `call_${messages.length}`;
      appendAssistant({ type: 'tool_use', id: callId, name: item.name ?? 'tool', input: toolInputFromArguments(item.arguments ?? item.input) });
      resolveThinkingForTool(callId, pendingSummary);
      pendingSummary = undefined;
      continue;
    }
    if (type === 'function_call_output' || type === 'local_shell_call_output' || type === 'tool_result') {
      hasToolHistory = true;
      appendToolResult({ type: 'tool_result', tool_use_id: item.call_id ?? item.id ?? '', content: typeof item.output === 'string' ? item.output : '' });
      pendingSummary = undefined;
      continue;
    }
    if (role === 'system' || role === 'developer') {
      system.push(...contentBlocksFromContent(item.content));
      pendingSummary = undefined;
      continue;
    }
    if (role === 'assistant') {
      let blocks = contentBlocksFromContent(item.content);
      if (!blocks.length) { pendingSummary = undefined; continue; }
      if (pendingSummary || hasToolHistory) {
        if (!hasThinking(blocks)) {
          let entry = null;
          if (pendingSummary) {
            for (const s of pendingSummary) {
              if (s.type !== 'summary_text') continue;
              const d = decodeThinkingSummary(s.text);
              if (d && (d.thinking || d.signature)) { entry = d; break; }
            }
          }
          if (!entry) {
            const text = blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
            entry = thinkingState?.getCachedForAssistantText(text) ?? { thinking: '', signature: '' };
          }
          const b = { type: 'thinking', thinking: entry.thinking };
          if (entry.signature) b.signature = entry.signature;
          blocks = [b, ...blocks];
        }
      }
      messages.push({ role: 'assistant', content: blocks });
      pendingSummary = undefined;
      continue;
    }
    const blocks = contentBlocksFromContent(item.content);
    if (!blocks.length) { pendingSummary = undefined; continue; }
    messages.push({ role: role || 'user', content: blocks });
    pendingSummary = undefined;
  }

  if (!messages.length) messages.push({ role: 'user', content: [{ type: 'text', text: ' ' }] });
  return { messages, system, hasToolHistory };
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  const result = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const toolType = tool.type ?? '';
    if (toolType === 'function') {
      const name = tool.name ?? '';
      if (!name) continue;
      const schema = tool.parameters && typeof tool.parameters === 'object' && !Array.isArray(tool.parameters)
        ? { ...tool.parameters, type: 'object' }
        : { type: 'object', properties: {} };
      result.push({ name, description: tool.description, input_schema: schema });
    }
  }
  return result.length ? result : undefined;
}

function mutateDsRequest(req, reasoning) {
  delete req.temperature;
  delete req.top_p;
  const effort = typeof reasoning?.effort === 'string' ? reasoning.effort.toLowerCase().trim() : '';
  if (effort === 'high') req.output_config = { effort: 'high' };
  else if (effort === 'xhigh' || effort === 'max') req.output_config = { effort: 'max' };
}

// ─── §1  Unit: encodeThinkingSummary / decodeThinkingSummary ─────────────────

section('§1  encodeThinkingSummary / decodeThinkingSummary');

{
  const thinking = 'I should think carefully about this.';
  const signature = 'sig_abc123';

  // encode with thinking text → returns thinking text (fast path)
  const encoded1 = encodeThinkingSummary(thinking, signature);
  assertEq(encoded1, thinking, 'encode: non-empty thinking → returns thinking text as-is');

  // decode thinking text → returns thinking
  const decoded1 = decodeThinkingSummary(encoded1);
  assertEq(decoded1, { thinking, signature: '' }, 'decode: plain text → {thinking, signature:""}');

  // encode signature-only → base64url encoded
  const encoded2 = encodeThinkingSummary('', signature);
  assert(encoded2.startsWith(THINKING_PREFIX), 'encode: no thinking, only sig → prefixed base64url');
  const decoded2 = decodeThinkingSummary(encoded2);
  assertEq(decoded2, { thinking: '', signature }, 'decode: prefixed → {thinking:"", signature}');

  // encode empty/empty → empty
  const encoded3 = encodeThinkingSummary('', '');
  assertEq(encoded3, '', 'encode: empty, empty → empty string');

  // decode empty → null
  assertEq(decodeThinkingSummary(''), null, 'decode: empty → null');

  // round-trip
  const original = { thinking: 'step by step', signature: 'some_sig' };
  const rt = encodeThinkingSummary(original.thinking, original.signature);
  const rtDecoded = decodeThinkingSummary(rt);
  assertEq(rtDecoded?.thinking, original.thinking, 'round-trip thinking survives encode/decode');
}

// ─── §2  Unit: stripReasoningContent ─────────────────────────────────────────

section('§2  stripReasoningContent');

{
  // No reasoning_content → returns same reference
  const input1 = [{ role: 'user', content: 'hello' }];
  const result1 = stripReasoningContent(input1);
  assert(result1 === input1, 'no reasoning_content → same reference returned');

  // Has reasoning_content → stripped
  const input2 = [
    { role: 'assistant', content: 'hi', reasoning_content: 'some thinking' },
    { role: 'user', content: 'ok' },
  ];
  const result2 = stripReasoningContent(input2);
  assert(!('reasoning_content' in result2[0]), 'reasoning_content field stripped');
  assertEq(result2[0].content, 'hi', 'content field preserved');

  // null reasoning_content → also stripped
  const input3 = [{ role: 'assistant', content: 'hi', reasoning_content: null }];
  const result3 = stripReasoningContent(input3);
  assert(!('reasoning_content' in result3[0]), 'null reasoning_content also stripped');

  // Non-array input → unchanged
  assertEq(stripReasoningContent('hello'), 'hello', 'non-array passes through');
}

// ─── §3  Unit: contentBlocksFromContent ──────────────────────────────────────

section('§3  contentBlocksFromContent');

{
  assertEq(contentBlocksFromContent('hello'), [{ type: 'text', text: 'hello' }], 'string → text block');
  assertEq(contentBlocksFromContent(''), [], 'empty string → []');
  assertEq(contentBlocksFromContent(null), [], 'null → []');
  assertEq(
    contentBlocksFromContent([{ type: 'text', text: 'a' }, { type: 'output_text', text: 'b' }]),
    [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    'array of text parts → text blocks',
  );
  assertEq(
    contentBlocksFromContent([{ type: 'input_text', text: 'q' }]),
    [{ type: 'text', text: 'q' }],
    'input_text type normalized to text',
  );
  assertEq(contentBlocksFromContent({ text: 'hi' }), [{ type: 'text', text: 'hi' }], 'object with text → block');
}

// ─── §4  Unit: convertInput — simple user message ────────────────────────────

section('§4  convertInput — simple cases');

{
  // string input
  const { messages: m1, system: s1 } = convertInput('hello world', null, null);
  assertEq(m1[0], { role: 'user', content: [{ type: 'text', text: 'hello world' }] }, 'string input → user message');
  assertEq(s1, [], 'no instructions → empty system');

  // with instructions
  const { messages: m2, system: s2 } = convertInput([{ role: 'user', content: 'ask' }], 'You are helpful.', null);
  assertEq(s2[0], { type: 'text', text: 'You are helpful.' }, 'instructions → system block');

  // system/developer roles go to system
  const { messages: m3, system: s3 } = convertInput(
    [{ role: 'system', content: 'system prompt' }, { role: 'user', content: 'q' }],
    null, null,
  );
  assert(s3.some((b) => b.text === 'system prompt'), 'system role → system array');
  assert(m3[0]?.role === 'user', 'user message preserved');

  // reasoning item → pendingSummary, not added to messages
  const { messages: m4 } = convertInput(
    [
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking text' }] },
      { role: 'user', content: 'ok' },
    ],
    null, null,
  );
  assert(!m4.some((m) => m.type === 'reasoning'), 'reasoning items not added to Anthropic messages');
  assertEq(m4.length, 1, 'only user message added');

  // web_search_call and commentary skipped
  const { messages: m5 } = convertInput(
    [{ type: 'web_search_call', query: 'x' }, { phase: 'commentary', content: 'x' }, { role: 'user', content: 'hi' }],
    null, null,
  );
  assertEq(m5.length, 1, 'web_search_call and commentary skipped');
}

// ─── §5  Unit: convertInput — tool history ────────────────────────────────────

section('§5  convertInput — tool history (function_call / function_call_output)');

{
  const state = new ThinkingState();
  state.rememberForToolCalls(['call_001'], 'my thinking', 'sig_001');

  const input = [
    {
      type: 'function_call',
      call_id: 'call_001',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call_001',
      output: '{"temp":20}',
    },
  ];

  const { messages, hasToolHistory } = convertInput(input, null, state);
  assert(hasToolHistory, 'hasToolHistory=true for function_call items');

  // assistant message with tool_use
  const assistantMsg = messages.find((m) => m.role === 'assistant');
  assert(!!assistantMsg, 'assistant message created for function_call');
  const toolUse = assistantMsg.content.find((b) => b.type === 'tool_use');
  assert(!!toolUse, 'tool_use block created');
  assertEq(toolUse?.name, 'get_weather', 'tool_use.name set');
  assertEq(toolUse?.id, 'call_001', 'tool_use.id set');
  assertEq(toolUse?.input, { city: 'Paris' }, 'tool_use.input parsed from arguments');

  // thinking block prepended from state cache
  const thinkingBlock = assistantMsg.content.find((b) => b.type === 'thinking');
  assert(!!thinkingBlock, 'thinking block prepended from state cache');
  assertEq(thinkingBlock?.thinking, 'my thinking', 'thinking content from state');

  // tool_result message
  const userMsg = messages.find((m) => m.role === 'user');
  const toolResult = userMsg?.content.find((b) => b.type === 'tool_result');
  assert(!!toolResult, 'tool_result block created');
  assertEq(toolResult?.tool_use_id, 'call_001', 'tool_result.tool_use_id set');
  assertEq(toolResult?.content, '{"temp":20}', 'tool_result.content set');
}

// ─── §6  Unit: convertInput — reasoning summary round-trip ───────────────────

section('§6  convertInput — reasoning summary used for thinking blocks');

{
  const state = new ThinkingState();
  const thinking = 'step 1: think; step 2: act';
  const encoded = encodeThinkingSummary(thinking, '');

  const input = [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: encoded }] },
    { type: 'function_call', call_id: 'call_r1', name: 'run', arguments: '{}' },
  ];

  const { messages } = convertInput(input, null, state);
  const assistantMsg = messages.find((m) => m.role === 'assistant');
  const thinkingBlock = assistantMsg?.content.find((b) => b.type === 'thinking');
  assert(!!thinkingBlock, 'thinking block prepended from reasoning summary');
  assertEq(thinkingBlock?.thinking, thinking, 'thinking text decoded from summary');
}

// ─── §7  Unit: convertTools ───────────────────────────────────────────────────

section('§7  convertTools');

{
  const tools = [
    { type: 'function', name: 'add', description: 'Add two numbers', parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
    { type: 'web_search' }, // should be skipped
    { type: 'function', name: '' }, // no name, should be skipped
  ];
  const result = convertTools(tools);
  assertEq(result?.length, 1, 'only valid function tools included');
  assertEq(result?.[0].name, 'add', 'tool name preserved');
  assert('input_schema' in result[0], 'input_schema used (not parameters)');
  assertEq(result[0].input_schema.type, 'object', 'input_schema.type = object');

  assertEq(convertTools([]), undefined, 'empty tools → undefined');
  assertEq(convertTools(null), undefined, 'null → undefined');
}

// ─── §8  Unit: mutateDsRequest ────────────────────────────────────────────────

section('§8  mutateDsRequest');

{
  const req1 = { model: 'm', max_tokens: 100, messages: [], temperature: 0.7, top_p: 0.9 };
  mutateDsRequest(req1, { effort: 'high' });
  assert(!('temperature' in req1), 'temperature removed');
  assert(!('top_p' in req1), 'top_p removed');
  assertEq(req1.output_config, { effort: 'high' }, 'output_config.effort = high');

  const req2 = { model: 'm', max_tokens: 100, messages: [] };
  mutateDsRequest(req2, { effort: 'xhigh' });
  assertEq(req2.output_config, { effort: 'max' }, 'xhigh → max');

  const req3 = { model: 'm', max_tokens: 100, messages: [] };
  mutateDsRequest(req3, undefined);
  assert(!req3.output_config, 'no reasoning → no output_config');

  const req4 = { model: 'm', max_tokens: 100, messages: [], temperature: 1 };
  mutateDsRequest(req4, { effort: 'MAX' });
  assertEq(req4.output_config?.effort, 'max', 'MAX (uppercase) normalized to max');
}

// ─── §9  Unit: ThinkingState ──────────────────────────────────────────────────

section('§9  ThinkingState');

{
  const s = new ThinkingState();

  // rememberForToolCalls
  s.rememberForToolCalls(['call_1', 'call_2'], 'thinking-1', 'sig-1');
  assertEq(s.getCachedForToolCall('call_1'), { thinking: 'thinking-1', signature: 'sig-1' }, 'cached for tool call 1');
  assertEq(s.getCachedForToolCall('call_2'), { thinking: 'thinking-1', signature: 'sig-1' }, 'cached for tool call 2');
  assertEq(s.getCachedForToolCall('call_99'), undefined, 'unknown id → undefined');

  // rememberForAssistantText
  s.rememberForAssistantText('the answer is 42', 'think-42', '');
  assertEq(s.getCachedForAssistantText('the answer is 42'), { thinking: 'think-42', signature: '' }, 'cached by text');
  assertEq(s.getCachedForAssistantText('something else'), undefined, 'different text → undefined');
  assertEq(s.getCachedForAssistantText(''), undefined, 'empty text → undefined');

  // rememberFromContent
  const s2 = new ThinkingState();
  s2.rememberFromContent([
    { type: 'thinking', thinking: 'my thoughts', signature: 'sig_x' },
    { type: 'tool_use', id: 'tool_a' },
    { type: 'text', text: 'result' },
  ]);
  assertEq(s2.getCachedForToolCall('tool_a'), { thinking: 'my thoughts', signature: 'sig_x' }, 'rememberFromContent → cached for tool');
  assertEq(s2.getCachedForAssistantText('result'), { thinking: 'my thoughts', signature: 'sig_x' }, 'rememberFromContent → cached for text');

  // no-op for empty thinking
  const s3 = new ThinkingState();
  s3.rememberForToolCalls(['call_x'], '', '');
  assertEq(s3.getCachedForToolCall('call_x'), undefined, 'empty thinking not cached');
}

// ─── §10  Integration: DeepSeek Anthropic endpoint — basic call ──────────────

section('§10  Integration: DeepSeek Anthropic — basic message (no thinking)');

{
  console.log('  [calling DeepSeek Anthropic endpoint]...');
  try {
    const res = await anthropicCall({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with the single word: PONG' }] }],
    });

    assert(res.type === 'message', 'response type is "message"');
    assert(Array.isArray(res.content), 'content is array');
    const text = res.content.find((b) => b.type === 'text')?.text ?? '';
    assert(text.toLowerCase().includes('pong'), `response text contains "pong" (got: "${text.slice(0, 80)}")`);
    assert(typeof res.usage?.input_tokens === 'number', 'usage.input_tokens present');
    assert(typeof res.usage?.output_tokens === 'number', 'usage.output_tokens present');
    assert(typeof res.id === 'string' && res.id.length > 0, 'response has id');
    assert(typeof res.stop_reason === 'string', 'stop_reason present');
  } catch (err) {
    assert(false, `API call failed: ${err.message}`);
  }
}

// ─── §11  Integration: DeepSeek Anthropic — thinking mode ───────────────────

section('§11  Integration: DeepSeek Anthropic — thinking mode (output_config.effort)');

{
  console.log('  [calling DeepSeek Anthropic endpoint with thinking]...');
  try {
    const res = await anthropicCall({
      model: MODEL,
      max_tokens: 1024,
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 11 * 13? Show reasoning.' }] }],
    });

    assert(res.type === 'message', 'response type is "message"');
    const thinkingBlock = res.content.find((b) => b.type === 'thinking');
    const textBlock = res.content.find((b) => b.type === 'text');
    assert(!!thinkingBlock, 'thinking block present in response');
    assert(typeof thinkingBlock?.thinking === 'string', 'thinking.thinking is string');
    assert(!!textBlock, 'text block present in response');
    assert(textBlock?.text?.includes('143'), `answer 143 present (got: "${textBlock?.text?.slice(0, 80)}")`);
    console.log(`    thinking length: ${thinkingBlock?.thinking?.length ?? 0} chars`);

    // Thinking block has signature field
    const hasSig = 'signature' in thinkingBlock;
    console.log(`    thinking has signature: ${hasSig}`);
  } catch (err) {
    assert(false, `Thinking API call failed: ${err.message}`);
  }
}

// ─── §12  Integration: DeepSeek Anthropic — streaming ───────────────────────

section('§12  Integration: DeepSeek Anthropic — streaming response');

{
  console.log('  [calling DeepSeek Anthropic stream endpoint]...');
  try {
    const events = await anthropicStream({
      model: MODEL,
      max_tokens: 256,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly: STREAM_OK' }] }],
    });

    assert(events.length > 0, 'received SSE events');
    const msgStart = events.find((e) => e.type === 'message_start');
    assert(!!msgStart, 'message_start event received');
    assert(!!msgStart?.message?.id, 'message_start has message.id');

    const blockStart = events.find((e) => e.type === 'content_block_start');
    assert(!!blockStart, 'content_block_start event received');

    const textDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta');
    assert(textDeltas.length > 0, 'text_delta events received');

    const fullText = textDeltas.map((e) => e.delta.text).join('');
    assert(fullText.toLowerCase().includes('stream_ok'), `streamed text contains STREAM_OK (got: "${fullText.slice(0, 80)}")`);

    const msgStop = events.find((e) => e.type === 'message_stop');
    assert(!!msgStop, 'message_stop event received');

    console.log(`    events received: ${events.length}, text length: ${fullText.length}`);
  } catch (err) {
    assert(false, `Streaming call failed: ${err.message}`);
  }
}

// ─── §13  Integration: DeepSeek Anthropic — streaming with thinking ───────────

section('§13  Integration: DeepSeek Anthropic — streaming with thinking');

{
  console.log('  [streaming with thinking mode]...');
  try {
    const events = await anthropicStream({
      model: MODEL,
      max_tokens: 512,
      output_config: { effort: 'high' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What is 7 * 8?' }] }],
    });

    const thinkingStart = events.find((e) => e.type === 'content_block_start' && e.content_block?.type === 'thinking');
    assert(!!thinkingStart, 'thinking content_block_start event received');

    const thinkingDeltas = events.filter((e) => e.type === 'content_block_delta' && (e.delta?.type === 'thinking_delta' || e.delta?.type === 'reasoning_content_delta'));
    assert(thinkingDeltas.length > 0, 'thinking_delta events received');

    const textDeltas = events.filter((e) => e.type === 'content_block_delta' && e.delta?.type === 'text_delta');
    assert(textDeltas.length > 0, 'text_delta events received');

    const fullText = textDeltas.map((e) => e.delta.text).join('');
    assert(fullText.includes('56'), `answer 56 in streamed text (got: "${fullText.slice(0, 80)}")`);

    console.log(`    thinking deltas: ${thinkingDeltas.length}, text deltas: ${textDeltas.length}`);
  } catch (err) {
    assert(false, `Thinking stream call failed: ${err.message}`);
  }
}

// ─── §14  Integration: DeepSeek Anthropic — tool calling ─────────────────────

section('§14  Integration: DeepSeek Anthropic — tool calling');

{
  console.log('  [testing tool calling via Anthropic endpoint]...');
  try {
    const tools = [
      {
        name: 'get_current_time',
        description: 'Get the current time in a city',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string', description: 'City name' } },
          required: ['city'],
        },
      },
    ];

    const res = await anthropicCall({
      model: MODEL,
      max_tokens: 512,
      tools,
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What time is it in Tokyo?' }] }],
    });

    // Should call the tool
    const toolUse = res.content.find((b) => b.type === 'tool_use');
    assert(!!toolUse, 'tool_use block in response');
    assertEq(toolUse?.name, 'get_current_time', 'correct tool called');
    assert(typeof toolUse?.input?.city === 'string', 'tool input has city');
    assert(toolUse?.input?.city?.toLowerCase().includes('tokyo'), `city includes "tokyo" (got: "${toolUse?.input?.city}")`);
    assert(typeof toolUse?.id === 'string', 'tool_use has id');
    console.log(`    tool call id: ${toolUse?.id}, city: ${toolUse?.input?.city}`);
  } catch (err) {
    assert(false, `Tool call failed: ${err.message}`);
  }
}

// ─── §15  Integration: multi-turn with thinking state ────────────────────────

section('§15  Integration: multi-turn with thinking blocks in history');

{
  console.log('  [multi-turn conversation with thinking]...');
  try {
    // First turn: get a response with thinking
    const turn1 = await anthropicCall({
      model: MODEL,
      max_tokens: 512,
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'My name is Alice. Remember this.' }] },
      ],
    });

    const thinkingBlock1 = turn1.content.find((b) => b.type === 'thinking');
    const textBlock1 = turn1.content.find((b) => b.type === 'text');
    assert(!!thinkingBlock1, 'turn 1: thinking block present');
    assert(!!textBlock1, 'turn 1: text response present');
    console.log(`    turn 1 response: "${textBlock1?.text?.slice(0, 80)}"`);

    // Second turn: include the thinking block back (multi-turn with thinking)
    const turn2 = await anthropicCall({
      model: MODEL,
      max_tokens: 512,
      output_config: { effort: 'high' },
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'My name is Alice. Remember this.' }] },
        { role: 'assistant', content: turn1.content }, // Echo full content including thinking
        { role: 'user', content: [{ type: 'text', text: 'What is my name?' }] },
      ],
    });

    const textBlock2 = turn2.content.find((b) => b.type === 'text');
    assert(!!textBlock2, 'turn 2: text response present');
    assert(textBlock2?.text?.toLowerCase().includes('alice'), `turn 2: answer includes "alice" (got: "${textBlock2?.text?.slice(0, 80)}")`);
    console.log(`    turn 2 response: "${textBlock2?.text?.slice(0, 80)}"`);
  } catch (err) {
    assert(false, `Multi-turn call failed: ${err.message}`);
  }
}

// ─── §16  Integration: tool calling with thinking (multi-turn) ───────────────

section('§16  Integration: tool call + result with thinking blocks');

{
  console.log('  [tool call multi-turn with thinking]...');
  try {
    const tools = [{
      name: 'calculate',
      description: 'Evaluate a math expression',
      input_schema: {
        type: 'object',
        properties: { expression: { type: 'string' } },
        required: ['expression'],
      },
    }];

    // Turn 1: model calls calculate tool
    const turn1 = await anthropicCall({
      model: MODEL,
      max_tokens: 512,
      output_config: { effort: 'high' },
      tools,
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Calculate 123 * 456' }] }],
    });

    const thinkingBlock = turn1.content.find((b) => b.type === 'thinking');
    const toolUse = turn1.content.find((b) => b.type === 'tool_use');
    assert(!!toolUse, 'turn 1: tool_use block present');
    assert(!!thinkingBlock, 'turn 1: thinking block present');
    console.log(`    tool call: ${toolUse?.name}(${JSON.stringify(toolUse?.input)})`);

    // Turn 2: provide tool result, require thinking block in assistant history
    const turn2 = await anthropicCall({
      model: MODEL,
      max_tokens: 512,
      output_config: { effort: 'high' },
      tools,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Calculate 123 * 456' }] },
        { role: 'assistant', content: turn1.content }, // must include thinking before tool_use
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse?.id ?? '', content: '56088' }] },
      ],
    });

    const textBlock2 = turn2.content.find((b) => b.type === 'text');
    assert(!!textBlock2, 'turn 2: text response present');
    assert(textBlock2?.text?.replace(/,/g, '').includes('56088'), `turn 2: answer 56088 present (got: "${textBlock2?.text?.slice(0, 100)}")`);
    console.log(`    turn 2 answer: "${textBlock2?.text?.slice(0, 100)}"`);
  } catch (err) {
    assert(false, `Tool+thinking multi-turn failed: ${err.message}`);
  }
}

// ─── §17  Unit: convertInput — assistant message with pending reasoning ────────

section('§17  Unit: convertInput — assistant message with pending reasoning summary');

{
  const thinking = 'complex derivation steps...';
  const encoded = encodeThinkingSummary(thinking, '');
  const state = new ThinkingState();

  const input = [
    { type: 'reasoning', summary: [{ type: 'summary_text', text: encoded }] },
    { role: 'assistant', content: 'The answer is 42.' },
    { role: 'user', content: 'Why?' },
  ];

  const { messages } = convertInput(input, null, state);
  const assistantMsg = messages.find((m) => m.role === 'assistant');
  const thinkingBlock = assistantMsg?.content.find((b) => b.type === 'thinking');
  assert(!!thinkingBlock, 'thinking block prepended to assistant message from reasoning item');
  assertEq(thinkingBlock?.thinking, thinking, 'thinking text matches encoded value');
  assertEq(assistantMsg?.content.find((b) => b.type === 'text')?.text, 'The answer is 42.', 'text block preserved');
}

// ─── §18  Unit: convertInput — empty conversation edge cases ─────────────────

section('§18  Unit: convertInput — edge cases');

{
  // null/undefined input → minimal user message
  const { messages: m1 } = convertInput(null, null, null);
  assertEq(m1.length, 1, 'null input → one message');
  assertEq(m1[0].role, 'user', 'single fallback user message');

  // empty array
  const { messages: m2 } = convertInput([], null, null);
  assertEq(m2.length, 1, 'empty array → fallback message');

  // multiple tool results in one user turn
  const { messages: m3 } = convertInput([
    { type: 'function_call', call_id: 'c1', name: 'f1', arguments: '{}' },
    { type: 'function_call', call_id: 'c2', name: 'f2', arguments: '{}' },
    { type: 'function_call_output', call_id: 'c1', output: 'r1' },
    { type: 'function_call_output', call_id: 'c2', output: 'r2' },
  ], null, null);
  // Two function_calls → one assistant message with two tool_use blocks
  const assistantMsg = m3.find((m) => m.role === 'assistant');
  const toolUseBlocks = assistantMsg?.content.filter((b) => b.type === 'tool_use') ?? [];
  assertEq(toolUseBlocks.length, 2, 'two tool_use blocks in assistant message');
  // Two function_call_outputs → one user message with two tool_result blocks
  const userMsg = m3.find((m) => m.role === 'user');
  const toolResultBlocks = userMsg?.content.filter((b) => b.type === 'tool_result') ?? [];
  assertEq(toolResultBlocks.length, 2, 'two tool_result blocks in user message');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════');
console.log(`  Results: ${passed} passed, ${failed} failed`);
if (errors.length) {
  console.log('\n  Failures:');
  for (const e of errors) console.log(e);
}
console.log('══════════════════════════════════════════════════════════\n');
if (failed > 0) process.exit(1);
