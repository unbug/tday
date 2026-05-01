#!/usr/bin/env node
/**
 * Gateway test — pure CommonJS, writes results to file via fs module
 * Works regardless of shell redirect issues.
 *
 * Usage: node apps/desktop/gateway-test-cjs.cjs
 */

'use strict';

const fs = require('fs');
const LOG = '/Users/unbug/Workspace/tday/apps/desktop/gw-results.log';
const lines = [];

function log(...args) {
  const s = args.join(' ');
  lines.push(s);
  process.stdout.write(s + '\n');
  // flush to file on every log
  fs.writeFileSync(LOG, lines.join('\n') + '\n');
}

const API_KEY = 'sk-18c8029503944f95835348cc62f0762d';
const BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-v4-pro';

// ── Port of gateway functions ────────────────────────────────────────────────

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map(p => typeof p === 'string' ? p : (p?.text ?? p?.output_text ?? '')).filter(Boolean).join('\n');
  return '';
}

function mergeConsecutiveToolCallMessages(messages) {
  const result = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.content === null && Array.isArray(msg.tool_calls)) {
      const allToolCalls = [...msg.tool_calls];
      let hasReasoningProp = Object.prototype.hasOwnProperty.call(msg, 'reasoning_content');
      let reasoning = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : null;
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        if (next.role === 'assistant' && next.content === null && Array.isArray(next.tool_calls)) {
          for (const tc of next.tool_calls) allToolCalls.push(tc);
          if (Object.prototype.hasOwnProperty.call(next, 'reasoning_content')) {
            hasReasoningProp = true;
            if (reasoning == null && typeof next.reasoning_content === 'string') reasoning = next.reasoning_content;
          }
          j++;
        } else break;
      }
      const merged = { role: 'assistant', content: null, tool_calls: allToolCalls };
      if (hasReasoningProp) merged.reasoning_content = reasoning;
      result.push(merged);
      i = j;
    } else {
      result.push(msg);
      i++;
    }
  }
  return result;
}

function responseOutputToChatMessages(output, reasoningContent) {
  const messages = [];
  const toolCalls = [];
  let reasoningAttached = false;
  for (const item of output) {
    if (item.type === 'message') {
      const text = contentToText(item.content);
      if (text) {
        const msg = { role: 'assistant', content: text };
        if (reasoningContent !== undefined && !reasoningAttached) {
          msg.reasoning_content = reasoningContent;
          reasoningAttached = true;
        }
        messages.push(msg);
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: 'function',
        function: { name: item.name, arguments: item.arguments ?? '{}' },
      });
    }
  }
  if (toolCalls.length) {
    const msg = { role: 'assistant', content: null, tool_calls: toolCalls };
    if (reasoningContent !== undefined && !reasoningAttached) msg.reasoning_content = reasoningContent;
    messages.push(msg);
  }
  return messages;
}

function shouldEnableThinking(messages, model) {
  const isKnownThinkingModel = /deepseek-v4/i.test(String(model ?? ''));
  const assistantMsgs = messages.filter(m => m.role === 'assistant');
  if (assistantMsgs.length === 0) return isKnownThinkingModel;
  return assistantMsgs.every(m => Object.prototype.hasOwnProperty.call(m, 'reasoning_content'));
}

// ── API helper ───────────────────────────────────────────────────────────────

function chatRequest(messages, opts) {
  opts = opts || {};
  const body = JSON.stringify(
    Object.assign({ model: MODEL, messages, stream: false },
      opts.tools ? { tools: opts.tools } : {},
      opts.thinking ? { thinking: { type: 'enabled' } } : {})
  );

  return new Promise((resolve, reject) => {
    const https = require('https');
    const url = new URL(`${BASE}/chat/completions`);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json: j });
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}. Body: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}

async function chat(label, messages, opts) {
  try {
    const { status, ok, json } = await chatRequest(messages, opts);
    const msg = json.choices && json.choices[0] && json.choices[0].message || {};
    const rc = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : null;
    const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    const rcHasProp = Object.prototype.hasOwnProperty.call(msg, 'reasoning_content');
    const err = json.error && json.error.message;

    log(`${ok ? '✅' : '❌'} [${status}] ${label}`);
    if (err) log(`   ERROR: ${String(err).slice(0, 300)}`);
    if (rc) log(`   reasoning_content(${rc.length}): "${rc.slice(0, 60)}..."`);
    else if (opts && opts.thinking) log(`   reasoning_content: null (thinking enabled, model returned null or missing)`);
    if (msg.content && !tcs.length) log(`   content: "${String(msg.content).slice(0, 80)}"`);
    if (tcs.length) log(`   tool_calls: ${tcs.map(t => `${t.function && t.function.name}(${t.id})`).join(', ')}`);

    return { ok, msg, rc, tcs, rcHasProp, status };
  } catch (e) {
    log(`❌ [ERR] ${label}: ${e.message}`);
    return { ok: false, msg: {}, rc: null, tcs: [], rcHasProp: false, status: 0 };
  }
}

const TOOLS = [{
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a shell command',
    parameters: { type: 'object', properties: { cmd: { type: 'string' } }, required: ['cmd'] },
  },
}];

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { log(`   ✔ ${msg}`); passed++; }
  else { log(`   ✘ FAIL: ${msg}`); failed++; }
}
function section(title) { log(`\n${'═'.repeat(60)}\n${title}\n${'═'.repeat(60)}`); }

// ── Main test runner (callback style to avoid top-level await issues) ─────────

(async function main() {
  log(`START gateway test — ${new Date().toISOString()}`);

  // ── Test 1: Basic thinking ────────────────────────────────────────────────
  section('1. BASIC: Does DeepSeek return reasoning_content for v4 models?');
  const t1 = await chat('Basic chat, thinking=true', [
    { role: 'user', content: 'Reply with just the word: PONG' }
  ], { thinking: true });
  assert(t1.ok, 'request succeeded');
  assert(t1.rcHasProp, 'reasoning_content property present on response');
  log(`   → RC type: ${t1.rc === null ? 'null' : 'string('+t1.rc.length+')'}`);

  // ── Test 2a: Multi-turn with rc=null passes DeepSeek ────────────────────
  section('2. MULTI-TURN: Does passing reasoning_content=null work?');
  const msgs2a = [
    { role: 'user', content: 'Reply with just: PONG' },
    { role: 'assistant', content: 'PONG', reasoning_content: null },
    { role: 'user', content: 'Now say: PONG2' },
  ];
  assert(shouldEnableThinking(msgs2a, MODEL), 'gateway enables thinking when rc=null present');
  const t2a = await chat('Multi-turn with rc=null, thinking=true', msgs2a, { thinking: true });
  log(`   → rc=null accepted by DeepSeek: ${t2a.ok} [${t2a.status}]`);
  if (!t2a.ok) log(`   → IMPORTANT: DeepSeek rejects rc=null! Must use different approach.`);

  // ── Test 2b: Multi-turn with rc=string ───────────────────────────────────
  if (t1.rc) {
    const msgs2b = [
      { role: 'user', content: 'Reply with just: PONG' },
      { role: 'assistant', content: t1.msg.content || 'PONG', reasoning_content: t1.rc },
      { role: 'user', content: 'Now say: PONG2' },
    ];
    const t2b = await chat('Multi-turn with rc=string, thinking=true', msgs2b, { thinking: true });
    assert(t2b.ok, 'rc=string turn 2 succeeded');
  }

  // ── Test 2c: Turn 2 with no rc field → thinking disabled ─────────────────
  const msgs2c = [
    { role: 'user', content: 'Reply with just: PONG' },
    { role: 'assistant', content: 'PONG' },  // no reasoning_content property
    { role: 'user', content: 'Now say: PONG2' },
  ];
  assert(!shouldEnableThinking(msgs2c, MODEL), 'gateway disables thinking when rc field absent');
  const t2c = await chat('Multi-turn, NO rc field, thinking=false (safe)', msgs2c, { thinking: false });
  assert(t2c.ok, 'Turn 2 without rc (thinking disabled) works');

  // ── Test 3: Tool call turn ────────────────────────────────────────────────
  section('3. TOOL CALL: What does DeepSeek return for tool-call turns?');
  const t3 = await chat('Tool call request, thinking=true', [
    { role: 'user', content: 'Run: echo hello' },
  ], { tools: TOOLS, thinking: true });
  assert(t3.ok, 'tool call request succeeded');
  if (t3.ok) {
    assert(t3.tcs.length > 0, 'got tool_calls in response');
    log(`   → tool turn reasoning_content value: ${JSON.stringify(t3.rc)}`);
    log(`   → reasoning_content hasOwnProperty: ${t3.rcHasProp}`);
  }

  // ── Test 4: Tool result with rc=null ─────────────────────────────────────
  section('4. TOOL RESULT: What messages does DeepSeek accept after tool call?');
  if (t3.ok && t3.tcs.length > 0) {
    const tc = t3.tcs[0];

    // 4a: rc=null on tool-call assistant message
    const msgs4a = [
      { role: 'user', content: 'Run: echo hello' },
      { role: 'assistant', content: null, tool_calls: t3.tcs, reasoning_content: null },
      { role: 'tool', tool_call_id: tc.id, content: 'hello' },
    ];
    assert(shouldEnableThinking(msgs4a, MODEL), 'gateway enables thinking (rc=null present)');
    const t4a = await chat('Tool result with rc=null on assistant, thinking=true', msgs4a, { tools: TOOLS, thinking: true });
    log(`   → rc=null on tool-calls msg accepted: ${t4a.ok} [${t4a.status}]`);
    if (!t4a.ok) {
      const errMsg = t4a.msg && t4a.msg.error ? String(t4a.msg.error.message) : 'unknown';
      log(`   → ERROR: ${errMsg.slice(0, 200)}`);
      log(`   → IMPORTANT: DeepSeek rejects rc=null on tool-calls msg!`);
    }

    // 4b: without rc field (thinking disabled)
    const msgs4c = [
      { role: 'user', content: 'Run: echo hello' },
      { role: 'assistant', content: null, tool_calls: t3.tcs },
      { role: 'tool', tool_call_id: tc.id, content: 'hello' },
    ];
    assert(!shouldEnableThinking(msgs4c, MODEL), 'gateway disables thinking (rc field absent)');
    const t4c = await chat('Tool result without rc, thinking=false (fallback)', msgs4c, { tools: TOOLS, thinking: false });
    assert(t4c.ok, 'tool result without rc, thinking=false works');
  }

  // ── Test 5: Multiple tool calls merge ────────────────────────────────────
  section('5. MULTIPLE TOOL CALLS: Merge logic and rc preservation correct?');

  // Unit test mergeConsecutiveToolCallMessages with rc=null
  const premerge = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }], reasoning_content: null },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{}' } }], reasoning_content: null },
  ];
  const merged = mergeConsecutiveToolCallMessages(premerge);
  assert(merged.length === 1, `merges 2 tool-call msgs into 1 (got ${merged.length})`);
  assert(merged[0].tool_calls.length === 2, 'merged has 2 tool_calls');
  assert(Object.prototype.hasOwnProperty.call(merged[0], 'reasoning_content'), 'merged preserves reasoning_content property');
  assert(merged[0].reasoning_content === null, 'merged reasoning_content is null (not dropped)');
  log(`   → merged.reasoning_content: ${JSON.stringify(merged[0].reasoning_content)}`);

  // Unit test with mixed rc (one null, one string)
  const premerge2 = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{}' } }], reasoning_content: 'I am thinking...' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{}' } }], reasoning_content: null },
  ];
  const merged2 = mergeConsecutiveToolCallMessages(premerge2);
  assert(Object.prototype.hasOwnProperty.call(merged2[0], 'reasoning_content'), 'mixed rc merge preserves property');
  assert(typeof merged2[0].reasoning_content === 'string', 'mixed rc merge takes string value');

  // ── Test 6: Full multi-turn simulation ────────────────────────────────────
  section('6. FULL MULTI-TURN: Simulate previous_response_id mode');

  const u1 = { role: 'user', content: 'Run: echo hello, then tell me what it output' };
  const r1 = await chat('Turn 1: request tool call', [u1], { tools: TOOLS, thinking: true });
  assert(r1.ok, 'turn 1 ok');

  if (r1.ok && r1.tcs.length > 0) {
    const tc1 = r1.tcs[0];
    const storedRC1 = r1.rc !== null ? r1.rc : null; // null because thinking was enabled
    const output1 = [{ id: 'fc_1', type: 'function_call', call_id: tc1.id, name: tc1.function.name, arguments: tc1.function.arguments }];
    const conv1 = [u1, ...responseOutputToChatMessages(output1, storedRC1)];
    const assistantMsg1 = conv1.find(m => m.role === 'assistant');
    log(`   Stored assistant msg: rc=${JSON.stringify(assistantMsg1 ? assistantMsg1.reasoning_content : undefined)}, hasOwnProp=${assistantMsg1 ? Object.prototype.hasOwnProperty.call(assistantMsg1, 'reasoning_content') : false}`);

    // Turn 2: provide tool result
    const turn2Input = [{ role: 'tool', tool_call_id: tc1.id, content: 'hello' }];
    const msgs2 = mergeConsecutiveToolCallMessages([...conv1, ...turn2Input]);
    const enableThinking2 = shouldEnableThinking(msgs2, MODEL);
    log(`   Turn 2 shouldEnableThinking: ${enableThinking2}`);
    const r2 = await chat('Turn 2: tool result', msgs2, { tools: TOOLS, thinking: enableThinking2 });
    assert(r2.ok, 'turn 2 ok');

    if (r2.ok) {
      const storedRC2 = r2.rc !== null ? r2.rc : (enableThinking2 ? null : undefined);
      const output2 = r2.msg.content
        ? [{ id: 'msg_2', type: 'message', content: [{ text: r2.msg.content }] }]
        : r2.tcs.length
          ? r2.tcs.map((t, i) => ({ id: `fc_2_${i}`, type: 'function_call', call_id: t.id, name: t.function.name, arguments: t.function.arguments }))
          : [];
      const conv2 = [...msgs2, ...responseOutputToChatMessages(output2, storedRC2)];

      // Turn 3: follow-up
      const turn3Input = [{ role: 'user', content: 'How many characters did it output?' }];
      const msgs3 = mergeConsecutiveToolCallMessages([...conv2, ...turn3Input]);
      const enableThinking3 = shouldEnableThinking(msgs3, MODEL);
      log(`   Turn 3 shouldEnableThinking: ${enableThinking3}`);
      log(`   Turn 3 assistant msgs: ${JSON.stringify(msgs3.filter(m => m.role === 'assistant').map(m => ({ hasRC: Object.prototype.hasOwnProperty.call(m, 'reasoning_content'), rcVal: JSON.stringify(m.reasoning_content).slice(0, 30) })))}`);
      const r3 = await chat('Turn 3: follow-up', msgs3, { tools: TOOLS, thinking: enableThinking3 });
      assert(r3.ok, 'turn 3 ok');

      if (r3.ok) {
        const storedRC3 = r3.rc !== null ? r3.rc : (enableThinking3 ? null : undefined);
        const output3 = r3.msg.content
          ? [{ id: 'msg_3', type: 'message', content: [{ text: r3.msg.content }] }]
          : [];
        const conv3 = [...msgs3, ...responseOutputToChatMessages(output3, storedRC3)];
        const turn4Input = [{ role: 'user', content: 'What was the original command I asked you to run?' }];
        const msgs4 = mergeConsecutiveToolCallMessages([...conv3, ...turn4Input]);
        const enableThinking4 = shouldEnableThinking(msgs4, MODEL);
        const r4 = await chat('Turn 4: another follow-up', msgs4, { thinking: enableThinking4 });
        assert(r4.ok, 'turn 4 ok');
        if (r4.ok) log(`   Turn 4 response: "${String(r4.msg.content || '').slice(0, 100)}"`);
      }
    }
  }

  // ── Test 7: shouldEnableThinking edge cases ───────────────────────────────
  section('7. UNIT: shouldEnableThinking edge cases');
  assert(shouldEnableThinking([], MODEL), 'empty msgs → thinking enabled for known model');
  assert(!shouldEnableThinking([{ role: 'assistant', content: 'hi' }], MODEL), 'assistant without rc → thinking disabled');
  assert(shouldEnableThinking([{ role: 'assistant', content: 'hi', reasoning_content: null }], MODEL), 'assistant with rc=null → thinking enabled');
  assert(shouldEnableThinking([{ role: 'assistant', content: 'hi', reasoning_content: 'think' }], MODEL), 'assistant with rc=string → thinking enabled');
  assert(shouldEnableThinking([
    { role: 'assistant', content: null, tool_calls: [], reasoning_content: null },
    { role: 'assistant', content: 'reply', reasoning_content: 'think' },
  ], MODEL), 'mixed null+string → thinking enabled (all have property)');
  assert(!shouldEnableThinking([
    { role: 'assistant', content: null, tool_calls: [], reasoning_content: null },
    { role: 'assistant', content: 'reply' }, // NO rc property
  ], MODEL), 'mixed with missing → thinking disabled');

  // ── Summary ───────────────────────────────────────────────────────────────
  section('SUMMARY');
  log(`Passed: ${passed}, Failed: ${failed}`);
  log(failed > 0 ? '❌ FAILURES FOUND — fix before packaging!' : '✅ All assertions passed!');
  log(`END ${new Date().toISOString()}`);
  log(`Results written to: ${LOG}`);
})().catch(err => {
  log(`FATAL: ${err.message}\n${err.stack}`);
});
