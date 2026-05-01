import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createLocalGatewayManager } from '../apps/desktop/src/main/gateway/index.ts';

function onceListening(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('failed to bind test server'));
        return;
      }
      resolve(address.port);
    });
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function main() {
  let capturedRequest = null;
  const upstream = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    capturedRequest = await readJson(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        model: capturedRequest.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'gateway-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
  });

  const upstreamPort = await onceListening(upstream);
  const upstreamBaseUrl = `http://127.0.0.1:${upstreamPort}`;
  const manager = createLocalGatewayManager();

  try {
    const deepseekProvider = {
      id: 'deepseek',
      label: 'DeepSeek',
      kind: 'deepseek',
      apiStyle: 'openai',
      baseUrl: upstreamBaseUrl,
      model: 'deepseek-v4-pro',
      apiKey: 'test-key',
    };

    const gateway = await manager.resolve({
      agentId: 'codex',
      provider: deepseekProvider,
    });
    assert.ok(gateway, 'codex + deepseek should resolve a local gateway');
    assert.ok(gateway.baseUrl.startsWith('http://127.0.0.1:'), 'gateway should expose localhost baseUrl');
    assert.deepEqual(gateway.noProxyHosts, ['127.0.0.1', 'localhost', '::1']);

    const bypassCases = await Promise.all([
      manager.resolve({ agentId: 'claude-code', provider: deepseekProvider }),
      manager.resolve({
        agentId: 'codex',
        provider: { ...deepseekProvider, kind: 'openai', id: 'openai' },
      }),
      manager.resolve({
        agentId: 'codex',
        provider: { ...deepseekProvider, apiStyle: 'anthropic' },
      }),
    ]);
    assert.deepEqual(
      bypassCases,
      [null, null, null],
      'only codex + deepseek(openai-style) should be intercepted',
    );

    const response = await fetch(`${gateway.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        input: [
          { type: 'message', role: 'developer', content: 'Follow repo conventions.' },
          { type: 'message', role: 'user', content: 'Say ok' },
        ],
        stream: false,
      }),
    });

    assert.equal(response.status, 200, 'gateway response should succeed');
    const body = await response.json();
    assert.equal(body.status, 'completed');
    assert.equal(body.output?.[0]?.content?.[0]?.text, 'gateway-ok');

    assert.ok(capturedRequest, 'upstream provider should receive a transformed request');
    assert.equal(capturedRequest.model, 'deepseek-v4-pro');
    assert.equal(capturedRequest.stream, false);
    assert.equal(capturedRequest.messages?.[0]?.role, 'system');
    assert.equal(capturedRequest.messages?.[0]?.content, 'Follow repo conventions.');
    assert.equal(capturedRequest.messages?.[1]?.role, 'user');
    assert.deepEqual(capturedRequest.thinking, { type: 'enabled' });

    console.log('verify-local-gateway: ok');
  } finally {
    manager.close();
    await new Promise((resolve) => upstream.close(() => resolve()));
  }
}

await main();
