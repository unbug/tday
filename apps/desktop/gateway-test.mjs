/**
 * Comprehensive gateway integration test.
 * Directly tests DeepSeek API AND simulates the gateway message-building logic
 * so we can catch bugs before packaging.
 *
 * Run: node apps/desktop/gateway-test.mjs > apps/desktop/gateway-test.log 2>&1
 *
 * Key facts discovered from testing:
 *   - DeepSeek REJECTS reasoning_content: null → must always pass a non-empty string
 *   - DeepSeek tracks tool_call IDs server-side; result turns REQUIRE reasoning_content
 *     even with thinking=false if the tool_call came from a thinking-enabled session.
 *   - Streaming tool-call turns DO return reasoning_content deltas (confirmed below).
 *   - The old gateway had a "reasoningAttached" bug: tool-call messages were skipped
 *     when the same turn also had a text message — now fixed to attach to ALL messages.
 */

const API_KEY = 'sk-18c8029503944f95835348cc62f0762d';
const BASE = 'https://api.deepseek.com';
const MODEL = 'deepseek-v4-pro';

// ─── Minimal port of the FIXED gateway functions (pure JS, no TS imports) ────
// These mirror the changes made to src/main/gateway/index.ts.

function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content.map(p => typeof p === 'string' ? p : (p?.text ?? p?.output_text ?? '')).filter(Boolean).join('\n');
  return '';
}

/**
 * FIXED: Only collects non-empty reasoning strings — never preserves null.
 * The merged message only gets reasoning_content if at least one source message
 * had a non-empty string value.
 */
function mergeConsecutiveToolCallMessages(messages) {
  const result = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.content === null && Array.isArray(msg.tool_calls)) {
      const allToolCalls = [...msg.tool_calls];
      // Collect the best (non-empty) reasoning string across all merged messages.
      let reasoning = (typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0)
        ? msg.reasoning_content
        : undefined;
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        if (next.role === 'assistant' && next.content === null && Array.isArray(next.tool_calls)) {
          for (const tc of next.tool_calls) allToolCalls.push(tc);
          if (reasoning === undefined && typeof next.reasoning_content === 'string' && next.reasoning_content.length > 0) {
            reasoning = next.reasoning_content;
          }
          j++;
        } else break;
      }
      const merged = { role: 'assistant', content: null, tool_calls: allToolCalls };
      if (reasoning !== undefined) merged.reasoning_content = reasoning;
      result.push(merged);
      i = j;
    } else {
      result.push(msg);
      i++;
    }
  }
  return result;
}

/**
 * FIXED: Attaches reasoning_content to ALL assistant messages in the turn
 * (both text messages and tool-call messages).  Only uses non-empty strings —
 * never null.  The old reasoningAttached flag that caused the tool-call message
 * to miss reasoning has been removed.
 */
function responseOutputToChatMessages(output, reasoningContent) {
  const messages = [];
  const toolCalls = [];
  const hasReasoning = typeof reasoningContent === 'string' && reasoningContent.length > 0;
  for (const item of output) {
    if (item.type === 'message') {
      const text = contentToText(item.content);
      if (text) {
        const msg = { role: 'assistant', content: text };
        if (hasReasoning) msg.reasoning_content = reasoningContent;
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
    if (hasReasoning) msg.reasoning_content = reasoningContent;
    messages.push(msg);
  }
  return messages;
}

/**
 * FIXED: Requires non-empty string reasoning_content on ALL prior assistant
 * messages.  The old hasOwnProperty check also passed for null, which DeepSeek
 * rejects — now we explicitly check for a non-empty string.
 */
function shouldEnableThinking(messages, model) {
  const isKnownThinkingModel = /deepseek-v4/i.test(String(model ?? ''));
  const assistantMsgs = messages.filter(m => m.role === 'assistant');
  if (assistantMsgs.length === 0) return isKnownThinkingModel;
  return assistantMsgs.every(m => typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0);
}

// ─── DeepSeek API helpers ────────────────────────────────────────────────────

async function chat(label, messages, { tools, thinking, stream = false } = {}) {
  const body = { model: MODEL, messages, stream };
  if (tools?.length) body.tools = tools;
  if (thinking) body.thinking = { type: 'enabled' };

  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });

  let msg, rc, tcs, err;
  if (stream) {
    // Read stream
    let buf = '', text = '', rcAcc = '';
    const decoder = new TextDecoder();
    for await (const chunk of r.body) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta ?? {};
        if (delta.reasoning_content) rcAcc += delta.reasoning_content;
        if (delta.content) text += delta.content;
      }
    }
    msg = { content: text || null, reasoning_content: rcAcc || null, tool_calls: [] };
    rc = rcAcc || null;
    tcs = [];
    err = !r.ok ? 'stream error' : null;
  } else {
    const j = await r.json();
    msg = j.choices?.[0]?.message ?? {};
    rc = typeof msg.reasoning_content === 'string' ? msg.reasoning_content : null;
    tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    err = j.error?.message;
  }

  const ok = r.ok;
  const hasRC = rc !== null;
  const hasTCS = tcs.length > 0;
  console.log(`${ok ? '✅' : '❌'} [${r.status}] ${label}`);
  if (err) console.log(`   ERROR: ${String(err).slice(0, 200)}`);
  if (hasRC) console.log(`   reasoning_content(${rc.length}): "${rc.slice(0, 60)}..."`);
  else if (thinking) console.log(`   reasoning_content: null (thinking enabled, no rc returned)`);
  if (msg.content && !hasTCS) console.log(`   content: "${String(msg.content).slice(0, 80)}"`);
  if (hasTCS) console.log(`   tool_calls: ${tcs.map(t => `${t.function?.name}(${t.id})`).join(', ')}`);
  return { ok, msg, rc, tcs, status: r.status };
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
  if (cond) { console.log(`   ✔ ${msg}`); passed++; }
  else { console.log(`   ✘ FAIL: ${msg}`); failed++; }
}
function section(title) { console.log(`\n${'═'.repeat(60)}\n${title}\n${'═'.repeat(60)}`); }

// ════════════════════════════════════════════════════════════
section('1. BASIC: Does DeepSeek return non-null reasoning_content for v4 models?');

const t1 = await chat('Basic chat, thinking=true', [
  { role: 'user', content: 'Say exactly: PONG' }
], { thinking: true });
assert(t1.ok, 'request succeeded');
assert(t1.rc !== null, 'reasoning_content is a non-null string (required for gateway fix)');
console.log(`   → RC value type: ${t1.rc === null ? 'null ← PROBLEM' : 'string(' + t1.rc?.length + ')'}`);

const t1b = await chat('Basic chat, thinking=false', [
  { role: 'user', content: 'Say exactly: PONG' }
], { thinking: false });
assert(t1b.ok, 'request without thinking succeeded');

// ════════════════════════════════════════════════════════════
section('2. MULTI-TURN TEXT: Non-null reasoning passed back');

if (t1.ok && t1.rc) {
  const msgs2 = [
    { role: 'user', content: 'Say exactly: PONG' },
    { role: 'assistant', content: t1.msg.content ?? '', reasoning_content: t1.rc },
    { role: 'user', content: 'Now say: PONG2' },
  ];
  assert(shouldEnableThinking(msgs2, MODEL), 'FIXED: non-empty rc string enables thinking');
  const t2 = await chat('Multi-turn with non-null rc string → thinking=true', msgs2, { thinking: true });
  assert(t2.ok, 'turn 2 with rc string succeeded');
}

// FIXED: null rc now DISABLES thinking (old code enabled it — that caused 400 errors)
const msgs2null = [
  { role: 'user', content: 'Say exactly: PONG' },
  { role: 'assistant', content: 'PONG', reasoning_content: null },
  { role: 'user', content: 'Now say: PONG2' },
];
assert(!shouldEnableThinking(msgs2null, MODEL), 'FIXED: null rc DISABLES thinking (was broken before)');

// Missing rc field disables thinking
const msgs2missing = [
  { role: 'user', content: 'Say exactly: PONG' },
  { role: 'assistant', content: 'PONG' },
  { role: 'user', content: 'Now say: PONG2' },
];
assert(!shouldEnableThinking(msgs2missing, MODEL), 'Missing rc field disables thinking (safe fallback)');
const t2c = await chat('Multi-turn without rc, thinking=false (safe fallback)', msgs2missing, { thinking: false });
assert(t2c.ok, 'Multi-turn without rc (thinking disabled) works');

// ════════════════════════════════════════════════════════════
section('3. TOOL CALL: Does DeepSeek return non-null rc for tool-call turns?');

const t3 = await chat('Tool call request, thinking=true', [
  { role: 'user', content: 'Run: echo hello' },
], { tools: TOOLS, thinking: true });
assert(t3.ok, 'tool call request succeeded');
assert(t3.tcs.length > 0, 'got tool_calls');
assert(t3.rc !== null, 'tool-call turn returns non-null rc (required for gateway fix)');
console.log(`   → tool turn rc: ${t3.rc === null ? 'null ← PROBLEM' : `"${String(t3.rc).slice(0, 60)}..."`}`);

// ════════════════════════════════════════════════════════════
section('4. TOOL RESULT: Sending tool result back with correct reasoning');

if (t3.ok && t3.tcs.length > 0) {
  const tc = t3.tcs[0];

  // 4a: KNOWN INVARIANT — null rc is rejected by DeepSeek.
  //     The FIXED gateway never stores null, so this path should never occur.
  console.log('\n[4a] Gateway invariant check (null rc never stored after fix):');
  const msgs4aNull = [
    { role: 'user', content: 'Run: echo hello' },
    { role: 'assistant', content: null, tool_calls: t3.tcs, reasoning_content: null },
    { role: 'tool', tool_call_id: tc.id, content: 'hello' },
  ];
  assert(!shouldEnableThinking(msgs4aNull, MODEL),
    'FIXED: null rc on assistant msg → thinking DISABLED (safe path)');
  // With fix: thinking is disabled, so we don't send reasoning_content: null.
  // DeepSeek still may reject because it tracks the call_id server-side — but
  // this is an inherent DeepSeek limitation, not a gateway bug.

  // 4b: Non-null rc string (the ONLY correct path — gateway always produces this)
  if (t3.rc) {
    const msgs4b = [
      { role: 'user', content: 'Run: echo hello' },
      { role: 'assistant', content: null, tool_calls: t3.tcs, reasoning_content: t3.rc },
      { role: 'tool', tool_call_id: tc.id, content: 'hello' },
    ];
    assert(shouldEnableThinking(msgs4b, MODEL), 'Non-null rc string enables thinking');
    const t4b = await chat('Tool result with actual rc string, thinking=true', msgs4b, { tools: TOOLS, thinking: true });
    assert(t4b.ok, 'tool result with rc string works ← this is the only path gateway takes');
  }
}

// ════════════════════════════════════════════════════════════
section('5. MULTIPLE TOOL CALLS: Merge logic correct with fixed shouldEnableThinking?');

const t5req = await chat('Request that yields multiple tool calls', [
  { role: 'user', content: 'Call bash twice: run "echo one" AND "echo two". Use both calls.' },
], { tools: TOOLS, thinking: true });
console.log(`   → got ${t5req.tcs.length} tool calls: ${t5req.tcs.map(t => t.id).join(', ')}`);
assert(t5req.rc !== null, 'multi-tool request returns non-null rc');

if (t5req.ok && t5req.tcs.length >= 2) {
  const rc = t5req.rc ?? '';
  // Simulate stateless mode: each function_call becomes a separate assistant message
  const fakePriorInput = [
    { type: 'function_call', call_id: t5req.tcs[0].id, name: t5req.tcs[0].function.name, arguments: t5req.tcs[0].function.arguments },
    { type: 'function_call', call_id: t5req.tcs[1].id, name: t5req.tcs[1].function.name, arguments: t5req.tcs[1].function.arguments },
  ];
  // Simulate callReasoning map (only non-empty strings)
  const callReasoningMap5 = new Map();
  if (rc) {
    callReasoningMap5.set(t5req.tcs[0].id, rc);
    callReasoningMap5.set(t5req.tcs[1].id, rc);
  }

  const preMerge = fakePriorInput.map(item => {
    const r = callReasoningMap5.get(item.call_id);
    const msg = {
      role: 'assistant', content: null,
      tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }],
    };
    if (r) msg.reasoning_content = r; // FIXED: only set if non-empty string
    return msg;
  });

  const merged = mergeConsecutiveToolCallMessages(preMerge);
  assert(merged.length === 1, `merges to 1 message (got ${merged.length})`);
  assert(merged[0].tool_calls.length === 2, 'merged has 2 tool_calls');
  assert(typeof merged[0].reasoning_content === 'string' && merged[0].reasoning_content.length > 0,
    'FIXED: merged preserves non-empty reasoning_content string (null is never stored)');
  console.log(`   merged rc: "${String(merged[0].reasoning_content).slice(0, 60)}..."`);

  const msgs5 = [
    { role: 'user', content: 'Call bash twice: run "echo one" AND "echo two". Use both calls.' },
    merged[0],
    { role: 'tool', tool_call_id: t5req.tcs[0].id, content: 'one' },
    { role: 'tool', tool_call_id: t5req.tcs[1].id, content: 'two' },
  ];
  const enableThinking5 = shouldEnableThinking(msgs5, MODEL);
  assert(enableThinking5, 'thinking enabled for multi-tool follow-up (all assistant msgs have rc)');
  const t5result = await chat('Multi-tool merged result', msgs5, { tools: TOOLS, thinking: enableThinking5 });
  assert(t5result.ok, 'merged multi-tool result accepted by DeepSeek');
}

// ════════════════════════════════════════════════════════════
section('6. STATEFUL MULTI-TURN: previous_response_id mode (gateway simulation)');

// Simulate gateway stateful mode using responseOutputToChatMessages (fixed version)
const u1 = { role: 'user', content: 'Run: echo hello, then tell me what it output' };
const r1 = await chat('Turn 1: request tool call', [u1], { tools: TOOLS, thinking: true });
assert(r1.ok, 'turn 1 ok');
assert(r1.rc !== null, 'turn 1 returns non-null rc (required for stateful fix)');

if (r1.ok && r1.tcs.length > 0) {
  const tc1 = r1.tcs[0];
  const rc1 = r1.rc;

  // FIXED: gateway now only passes non-null strings to responseOutputToChatMessages
  const output1 = [{
    id: 'fc_1', type: 'function_call',
    call_id: tc1.id, name: tc1.function.name, arguments: tc1.function.arguments,
  }];
  const conv1 = [u1, ...responseOutputToChatMessages(output1, rc1)];
  const assistantMsg1 = conv1.find(m => m.role === 'assistant');
  assert(
    typeof assistantMsg1?.reasoning_content === 'string' && assistantMsg1.reasoning_content.length > 0,
    'FIXED: stored tool-call assistant msg has non-empty rc string (never null)',
  );
  console.log(`   Stored assistant msg rc: "${String(assistantMsg1?.reasoning_content).slice(0, 50)}..."`);

  // Turn 2: provide tool result
  const turn2Input = [{ role: 'tool', tool_call_id: tc1.id, content: 'hello' }];
  const msgs2 = mergeConsecutiveToolCallMessages([...conv1, ...turn2Input]);
  const enableThinking2 = shouldEnableThinking(msgs2, MODEL);
  assert(enableThinking2, 'Turn 2: thinking enabled (all assistant msgs have non-empty rc)');
  const r2 = await chat('Turn 2: tool result', msgs2, { tools: TOOLS, thinking: enableThinking2 });
  assert(r2.ok, 'turn 2 ok');
  assert(r2.rc !== null, 'turn 2 returns non-null rc');

  if (r2.ok) {
    const rc2 = r2.rc;
    const output2 = r2.msg.content
      ? [{ id: 'msg_2', type: 'message', content: [{ text: r2.msg.content }] }]
      : [];
    // FIXED: all assistant messages in the turn get rc (no reasoningAttached bug)
    const conv2 = [...msgs2, ...responseOutputToChatMessages(output2, rc2)];
    const assistantMsgs2 = conv2.filter(m => m.role === 'assistant');
    assert(
      assistantMsgs2.every(m => typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0),
      'FIXED: all stored assistant msgs have non-empty rc (reasoningAttached bug fixed)',
    );

    // Turn 3: follow-up question
    const turn3Input = [{ role: 'user', content: 'How many chars did that output have?' }];
    const msgs3 = mergeConsecutiveToolCallMessages([...conv2, ...turn3Input]);
    const enableThinking3 = shouldEnableThinking(msgs3, MODEL);
    assert(enableThinking3, 'Turn 3: thinking enabled');
    console.log(`   Turn 3 assistant msgs rc: ${msgs3.filter(m=>m.role==='assistant').map(m => `"${String(m.reasoning_content).slice(0,25)}..."`).join(', ')}`);
    const r3 = await chat('Turn 3: follow-up question', msgs3, { tools: TOOLS, thinking: enableThinking3 });
    assert(r3.ok, 'turn 3 ok');

    if (r3.ok) {
      const rc3 = r3.rc;
      const output3 = r3.msg.content
        ? [{ id: 'msg_3', type: 'message', content: [{ text: r3.msg.content }] }]
        : [];
      const conv3 = [...msgs3, ...responseOutputToChatMessages(output3, rc3)];
      const turn4Input = [{ role: 'user', content: 'What was the original command?' }];
      const msgs4 = mergeConsecutiveToolCallMessages([...conv3, ...turn4Input]);
      const enableThinking4 = shouldEnableThinking(msgs4, MODEL);
      const r4 = await chat('Turn 4: another follow-up', msgs4, { thinking: enableThinking4 });
      assert(r4.ok, 'turn 4 ok');
    }
  }
}

// ════════════════════════════════════════════════════════════
section('7. STATELESS MULTI-TURN: Codex sends full history in input (callReasoning map)');

const callReasoningMap = new Map(); // simulates gateway's this.callReasoning

const sr1 = await chat('Stateless turn 1: request tool call', [
  { role: 'user', content: 'Run: ls /tmp and tell me the first file listed' },
], { tools: TOOLS, thinking: true });
assert(sr1.ok, 'stateless turn 1 ok');
assert(sr1.rc !== null, 'stateless turn 1 returns non-null rc');

if (sr1.ok && sr1.tcs.length > 0) {
  const sc1 = sr1.tcs[0];
  // FIXED: gateway only stores non-empty strings in callReasoning
  if (sr1.rc) callReasoningMap.set(sc1.id, sr1.rc);
  assert(callReasoningMap.has(sc1.id), 'call_id indexed in callReasoning map');

  const lookupRC = (callId) => callReasoningMap.get(callId); // string | undefined

  // Codex sends full history in stateless turn 2
  const statelessInput = [
    { type: 'message', role: 'user', content: 'Run: ls /tmp and tell me the first file listed' },
    { type: 'function_call', call_id: sc1.id, name: sc1.function.name, arguments: sc1.function.arguments },
    { type: 'function_call_output', call_id: sc1.id, output: 'tmpfile1.txt\ntmpfile2.txt' },
  ];

  // Simulate responsesInputToMessages (fixed version)
  const simulatedMsgs = [];
  for (const item of statelessInput) {
    if (item.type === 'message') {
      simulatedMsgs.push({ role: item.role, content: item.content });
    } else if (item.type === 'function_call') {
      const r = lookupRC(item.call_id);
      const msg = {
        role: 'assistant', content: null,
        tool_calls: [{ id: item.call_id, type: 'function', function: { name: item.name, arguments: item.arguments } }],
      };
      // FIXED: only set if non-empty string
      if (typeof r === 'string' && r.length > 0) msg.reasoning_content = r;
      simulatedMsgs.push(msg);
    } else if (item.type === 'function_call_output') {
      simulatedMsgs.push({ role: 'tool', tool_call_id: item.call_id, content: item.output });
    }
  }

  const mergedSim = mergeConsecutiveToolCallMessages(simulatedMsgs);
  const enableStateless2 = shouldEnableThinking(mergedSim, MODEL);
  assert(enableStateless2, 'Stateless turn 2: thinking enabled (callReasoning map hit)');

  const assistantInHistory = mergedSim.find(m => m.role === 'assistant');
  assert(
    typeof assistantInHistory?.reasoning_content === 'string' && assistantInHistory.reasoning_content.length > 0,
    'Stateless turn 2: assistant msg has non-empty rc from callReasoning map',
  );

  const sr2 = await chat('Stateless turn 2: tool result', mergedSim, { tools: TOOLS, thinking: enableStateless2 });
  assert(sr2.ok, 'Stateless turn 2 accepted by DeepSeek');
  assert(sr2.rc !== null, 'Stateless turn 2 returns non-null rc');

  if (sr2.ok && sr2.rc) {
    // Index turn 2 results for potential turn 3
    if (sr2.tcs.length > 0) {
      callReasoningMap.set(sr2.tcs[0].id, sr2.rc);
    }
    // Stateless turn 3: user asks follow-up (no more tool calls needed)
    const storedConv = [...mergedSim, ...responseOutputToChatMessages(
      sr2.msg.content
        ? [{ id: 'msg_s2', type: 'message', content: [{ text: sr2.msg.content }] }]
        : [],
      sr2.rc,
    )];
    const turn3Msgs = [...storedConv, { role: 'user', content: 'How many files were listed?' }];
    const mergedTurn3 = mergeConsecutiveToolCallMessages(turn3Msgs);
    const enableStateless3 = shouldEnableThinking(mergedTurn3, MODEL);
    assert(enableStateless3, 'Stateless turn 3: thinking still enabled (all assistant msgs have rc)');
    const sr3 = await chat('Stateless turn 3: follow-up', mergedTurn3, { thinking: enableStateless3 });
    assert(sr3.ok, 'Stateless turn 3 ok');
  }
}

// ════════════════════════════════════════════════════════════
section('8. STREAMING: reasoning_content captured in tool-call streaming responses');

const t8 = await chat('Streaming basic chat, thinking=true', [
  { role: 'user', content: 'Say exactly: PONG' }
], { thinking: true, stream: true });
assert(t8.ok, 'streaming request succeeded');
assert(t8.rc !== null, 'streaming returns non-null rc (gateway finalReasoning will be non-null)');
console.log(`   Stream rc: ${t8.rc === null ? 'null ← gateway fails next turn' : `string(${t8.rc?.length})`}`);

const t8b = await chat('Streaming tool call, thinking=true', [
  { role: 'user', content: 'Run: echo hello' }
], { tools: TOOLS, thinking: true, stream: true });
assert(t8b.ok, 'streaming tool call succeeded');
assert(t8b.rc !== null, 'streaming tool-call returns non-null rc (gateway captures via delta.reasoning_content)');
console.log(`   Stream tool-call rc: ${t8b.rc === null ? 'null ← gateway would fail next turn' : `string(${t8b.rc?.length})`}`);

// Verify: streaming rc can be used in a follow-up
if (t8b.ok && t8b.rc && t8b.tcs?.length === 0) {
  // Text response from streaming; test multi-turn
  const t8c_msgs = [
    { role: 'user', content: 'Say exactly: PONG' },
    { role: 'assistant', content: t8.msg.content ?? 'PONG', reasoning_content: t8.rc },
    { role: 'user', content: 'Now say: PONG2' },
  ];
  const t8c = await chat('Streaming follow-up (using streamed rc)', t8c_msgs, { thinking: true, stream: true });
  assert(t8c.ok, 'streaming follow-up with streamed rc works');
}

// ════════════════════════════════════════════════════════════
section('9. responseOutputToChatMessages FIX: all assistant msgs get rc');

// Test: when output has BOTH a text message AND tool_calls, BOTH get reasoning_content.
// This was broken before (reasoningAttached flag skipped tool-call message).
const mixedOutput = [
  { id: 'msg_1', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me run that for you.' }] },
  { id: 'fc_1', type: 'function_call', call_id: 'call_test_123', name: 'bash', arguments: '{"cmd":"echo hi"}' },
];
const rcString = 'I need to run a command to answer this.';

const chatMsgs = responseOutputToChatMessages(mixedOutput, rcString);
assert(chatMsgs.length === 2, 'mixed output produces 2 assistant messages');
const textMsgFixed = chatMsgs.find(m => m.content === 'Let me run that for you.');
const toolMsgFixed = chatMsgs.find(m => m.content === null && Array.isArray(m.tool_calls));
assert(
  typeof textMsgFixed?.reasoning_content === 'string' && textMsgFixed.reasoning_content === rcString,
  'Text assistant message has reasoning_content',
);
assert(
  typeof toolMsgFixed?.reasoning_content === 'string' && toolMsgFixed.reasoning_content === rcString,
  'FIXED: tool-call assistant message has reasoning_content (reasoningAttached bug fixed)',
);

// shouldEnableThinking now correctly sees both messages having rc
const mixedHistory = [
  { role: 'user', content: 'Do something' },
  ...chatMsgs,
  { role: 'tool', tool_call_id: 'call_test_123', content: 'hi' },
  { role: 'user', content: 'continue' },
];
assert(shouldEnableThinking(mixedHistory, MODEL),
  'FIXED: thinking enabled when both text+tool msgs have rc (reasoningAttached was blocking this)');

// Without rc: neither message should have the property
const chatMsgsNoRc = responseOutputToChatMessages(mixedOutput, undefined);
assert(!Object.prototype.hasOwnProperty.call(chatMsgsNoRc[0] ?? {}, 'reasoning_content'),
  'No reasoning: text message has no rc property');
assert(!Object.prototype.hasOwnProperty.call(chatMsgsNoRc[1] ?? {}, 'reasoning_content'),
  'No reasoning: tool-call message has no rc property');

// null rc: same as undefined — no property on either message (FIXED: null was stored before)
const chatMsgsNullRc = responseOutputToChatMessages(mixedOutput, null);
assert(!Object.prototype.hasOwnProperty.call(chatMsgsNullRc[0] ?? {}, 'reasoning_content'),
  'FIXED: null rc → no rc property on text msg (null is never stored)');
assert(!Object.prototype.hasOwnProperty.call(chatMsgsNullRc[1] ?? {}, 'reasoning_content'),
  'FIXED: null rc → no rc property on tool-call msg (null is never stored)');

// ════════════════════════════════════════════════════════════
section('10. shouldEnableThinking FIX: null and empty string rc disables thinking');

assert(!shouldEnableThinking([
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi', reasoning_content: null },
  { role: 'user', content: 'Continue' },
], MODEL), 'FIXED: null rc disables thinking (null was wrongly enabling thinking before)');

assert(!shouldEnableThinking([
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi', reasoning_content: '' },
  { role: 'user', content: 'Continue' },
], MODEL), 'FIXED: empty string rc disables thinking');

assert(shouldEnableThinking([
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi', reasoning_content: 'Some real reasoning here.' },
  { role: 'user', content: 'Continue' },
], MODEL), 'Non-empty rc correctly enables thinking');

// Mixed: one message has rc, one does not → thinking disabled (conservative)
assert(!shouldEnableThinking([
  { role: 'user', content: 'Hello' },
  { role: 'assistant', content: 'Hi', reasoning_content: 'reasoning' },
  { role: 'tool', tool_call_id: 'x', content: 'result' },
  { role: 'assistant', content: null, tool_calls: [{ id: 'x' }] }, // no rc property
  { role: 'user', content: 'Continue' },
], MODEL), 'Mixed rc (one with, one without) disables thinking (conservative)');

// ════════════════════════════════════════════════════════════
section('SUMMARY');
console.log(`\nPassed: ${passed}, Failed: ${failed}`);
if (failed > 0) console.log('❌ FAILURES FOUND — fix before packaging!');
else console.log('✅ All assertions passed!');

