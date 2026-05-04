/**
 * ClaudeCodeLocalAdapter
 *
 * Local HTTP proxy that bridges claude-code (Anthropic Messages API) to local
 * OpenAI-compatible servers (LM Studio, Ollama, LiteLLM, vLLM, SGLang …).
 *
 * Flow:
 *   claude-code  →  POST /v1/messages (Anthropic)
 *               →  [this proxy]
 *               →  POST /v1/chat/completions (OpenAI Chat)
 *               →  lmstudio / ollama / …
 *               ←  OpenAI response (streaming or not)
 *               ←  [this proxy translates back to Anthropic]
 *   claude-code  ←  Anthropic Messages API response
 *
 * Protocol references
 *   Anthropic: https://docs.anthropic.com/en/api/messages
 *   OpenAI:    https://platform.openai.com/docs/api-reference/chat/create
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { GatewayAdapter, GatewayAdapterContext, GatewayResolution, Obj } from './types.js';
import { sendJson, readRequestJson } from './adapter.js';

const LOCAL_OPENAI_COMPAT = new Set(['ollama', 'lmstudio', 'litellm', 'vllm', 'sglang']);

// ─── Request translation: Anthropic Messages → OpenAI Chat Completions ────────

function anthropicContentToOai(content: unknown): string | null {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b: Obj) => {
        if (b.type === 'text') return typeof b.text === 'string' ? b.text : '';
        if (b.type === 'tool_use') return `[tool_use: ${b.name}]`;
        if (b.type === 'tool_result') {
          const c = b.content;
          if (typeof c === 'string') return c;
          if (Array.isArray(c)) return c.map((x: Obj) => x.text ?? '').join('');
          return '';
        }
        return '';
      })
      .join('')
      .trim() || null;
  }
  return null;
}

function buildOaiToolFromAnthropic(tool: Obj): Obj {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.input_schema ?? { type: 'object', properties: {} },
    },
  };
}

function buildOaiToolChoice(choice: Obj | undefined): unknown {
  if (!choice) return undefined;
  if (choice.type === 'none') return 'none';
  if (choice.type === 'any') return 'required';
  if (choice.type === 'auto') return 'auto';
  if (choice.type === 'tool') return { type: 'function', function: { name: choice.name } };
  return undefined;
}

function anthropicToOaiRequest(body: Obj, model: string): Obj {
  const messages: Obj[] = [];

  // System prompt(s)
  const system = body.system;
  if (system) {
    let systemText = '';
    if (typeof system === 'string') {
      systemText = system;
    } else if (Array.isArray(system)) {
      systemText = system.map((b: Obj) => (b.type === 'text' ? (b.text ?? '') : '')).join('\n').trim();
    }
    if (systemText) messages.push({ role: 'system', content: systemText });
  }

  // Conversation messages
  const anthropicMessages = Array.isArray(body.messages) ? (body.messages as Obj[]) : [];
  for (const msg of anthropicMessages) {
    const role = msg.role === 'assistant' ? 'assistant' : 'user';
    const textContent = anthropicContentToOai(msg.content);

    // Handle tool_use blocks from assistant (→ assistant message with tool_calls)
    if (role === 'assistant' && Array.isArray(msg.content)) {
      const toolUseBlocks = (msg.content as Obj[]).filter((b) => b.type === 'tool_use');
      const textBlocks = (msg.content as Obj[]).filter((b) => b.type === 'text');
      if (toolUseBlocks.length > 0) {
        messages.push({
          role: 'assistant',
          content: textBlocks.length ? textBlocks.map((b: Obj) => b.text).join('') : null,
          tool_calls: toolUseBlocks.map((b: Obj, i: number) => ({
            id: typeof b.id === 'string' ? b.id : `call_${i}`,
            type: 'function',
            function: {
              name: b.name,
              arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}),
            },
          })),
        });
        continue;
      }
    }

    // Handle tool_result blocks from user (→ tool messages)
    if (role === 'user' && Array.isArray(msg.content)) {
      const toolResultBlocks = (msg.content as Obj[]).filter((b) => b.type === 'tool_result');
      if (toolResultBlocks.length > 0) {
        for (const b of toolResultBlocks) {
          const content = anthropicContentToOai(b.content) ?? '';
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id ?? '', content });
        }
        continue;
      }
    }

    if (textContent !== null) {
      messages.push({ role, content: textContent });
    }
  }

  const oaiBody: Obj = { model, messages, stream: body.stream ?? false };
  if (body.max_tokens) oaiBody.max_tokens = body.max_tokens;
  if (body.temperature != null) oaiBody.temperature = body.temperature;
  if (body.top_p != null) oaiBody.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length)
    oaiBody.stop = body.stop_sequences;

  const tools = Array.isArray(body.tools) ? (body.tools as Obj[]) : [];
  if (tools.length) {
    oaiBody.tools = tools.map(buildOaiToolFromAnthropic);
    const tc = buildOaiToolChoice(body.tool_choice as Obj | undefined);
    if (tc !== undefined) oaiBody.tool_choice = tc;
  }

  if (body.stream) {
    // Request usage in final stream chunk so we can populate Anthropic usage
    oaiBody.stream_options = { include_usage: true };
  }

  return oaiBody;
}

// ─── Response translation: OpenAI Chat Completions → Anthropic Messages ───────

function oaiFinishReasonToAnthropic(reason: string | null): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'length') return 'max_tokens';
  return 'end_turn';
}

function oaiToAnthropicResponse(oaiBody: Obj, reqModel: string): Obj {
  const choice = (Array.isArray(oaiBody.choices) ? oaiBody.choices[0] : undefined) as Obj | undefined;
  const message = (choice?.message ?? {}) as Obj;
  const usage = (oaiBody.usage ?? {}) as Obj;
  const finishReason = (choice?.finish_reason as string | null) ?? null;

  const content: Obj[] = [];
  const msgContent = message.content;
  if (typeof msgContent === 'string' && msgContent.trim()) {
    content.push({ type: 'text', text: msgContent });
  }
  const toolCalls = Array.isArray(message.tool_calls) ? (message.tool_calls as Obj[]) : [];
  for (const tc of toolCalls) {
    const fn = (tc.function ?? {}) as Obj;
    let input: unknown = {};
    try { input = JSON.parse(typeof fn.arguments === 'string' ? fn.arguments : '{}') as unknown; } catch { /* ignore */ }
    content.push({
      type: 'tool_use',
      id: typeof tc.id === 'string' ? tc.id : `call_${Math.random().toString(36).slice(2)}`,
      name: fn.name,
      input,
    });
  }

  return {
    id: typeof oaiBody.id === 'string' ? oaiBody.id.replace(/^chatcmpl-/, 'msg_') : `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: reqModel,
    content,
    stop_reason: oaiFinishReasonToAnthropic(finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      output_tokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
    },
  };
}

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function writeSseEvent(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ─── Streaming translation ────────────────────────────────────────────────────

async function streamOaiToAnthropic(
  oaiStream: NodeJS.ReadableStream,
  res: ServerResponse,
  msgId: string,
  model: string,
): Promise<void> {
  // Emit Anthropic preamble
  writeSseEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  writeSseEvent(res, 'content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text', text: '' },
  });
  writeSseEvent(res, 'ping', { type: 'ping' });

  let buffer = '';
  let finishReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCallIndex = -1;
  // Track open tool_use blocks: index → anthropic_id
  const toolCallIds = new Map<number, string>();

  await new Promise<void>((resolve, reject) => {
    oaiStream.on('data', (chunk: Buffer | string) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        let event: Obj;
        try { event = JSON.parse(payload) as Obj; } catch { continue; }

        const choice = (Array.isArray(event.choices) ? event.choices[0] : undefined) as Obj | undefined;
        if (!choice) {
          // Usage-only chunk (stream_options)
          const u = event.usage as Obj | undefined;
          if (u) {
            inputTokens = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : inputTokens;
            outputTokens = typeof u.completion_tokens === 'number' ? u.completion_tokens : outputTokens;
          }
          continue;
        }

        const delta = (choice.delta ?? {}) as Obj;
        if (choice.finish_reason) finishReason = choice.finish_reason as string;

        // Text content
        const text = delta.content;
        if (typeof text === 'string' && text) {
          writeSseEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          });
        }

        // Tool calls
        const toolCalls = Array.isArray(delta.tool_calls) ? (delta.tool_calls as Obj[]) : [];
        for (const tc of toolCalls) {
          const idx = typeof tc.index === 'number' ? tc.index : 0;
          const anthropicBlockIdx = idx + 1; // text is block 0, tools start at 1

          if (!toolCallIds.has(idx)) {
            // First chunk for this tool call
            const id = typeof tc.id === 'string' ? tc.id : `call_${idx}`;
            const fn = (tc.function ?? {}) as Obj;
            const name = typeof fn.name === 'string' ? fn.name : '';
            toolCallIds.set(idx, id);
            toolCallIndex = anthropicBlockIdx;

            writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
            writeSseEvent(res, 'content_block_start', {
              type: 'content_block_start',
              index: anthropicBlockIdx,
              content_block: { type: 'tool_use', id, name, input: {} },
            });
          }

          const fn = (tc.function ?? {}) as Obj;
          const args = fn.arguments;
          if (typeof args === 'string' && args) {
            writeSseEvent(res, 'content_block_delta', {
              type: 'content_block_delta',
              index: anthropicBlockIdx,
              delta: { type: 'input_json_delta', partial_json: args },
            });
          }
        }
      }
    });
    oaiStream.on('end', resolve);
    oaiStream.on('error', reject);
  });

  // Close last open block
  const lastBlockIdx = toolCallIndex >= 0 ? toolCallIndex : 0;
  writeSseEvent(res, 'content_block_stop', { type: 'content_block_stop', index: lastBlockIdx });

  writeSseEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: oaiFinishReasonToAnthropic(finishReason), stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  writeSseEvent(res, 'message_stop', { type: 'message_stop' });
  res.write('data: [DONE]\n\n');
}

// ─── Adapter class ────────────────────────────────────────────────────────────

export class ClaudeCodeLocalAdapter implements GatewayAdapter {
  private readonly proxies = new Map<string, { server: Server; baseUrl: string }>();

  matches(ctx: GatewayAdapterContext): boolean {
    return ctx.agentId === 'claude-code' && LOCAL_OPENAI_COMPAT.has(ctx.provider.kind ?? '');
  }

  async resolve(ctx: GatewayAdapterContext): Promise<GatewayResolution> {
    const key = JSON.stringify({ id: ctx.provider.id, baseUrl: ctx.provider.baseUrl });
    const existing = this.proxies.get(key);
    if (existing) {
      return { baseUrl: existing.baseUrl, noProxyHosts: ['127.0.0.1', 'localhost', '::1'] };
    }

    const targetBase = (ctx.provider.baseUrl ?? 'http://localhost:1234/v1').replace(/\/$/, '');
    const targetApiKey = ctx.provider.apiKey ?? 'no-key';
    // The model the user picked, stripped of any provider/ prefix
    const targetModel = (ctx.provider.model ?? '').replace(/^[^/]+\//, '');

    const server = createServer((req, res) => {
      void this.handleRequest(req, res, targetBase, targetApiKey, targetModel).catch((err: unknown) => {
        console.error('[tday/claude-local] proxy error:', err);
        if (!res.headersSent) {
          sendJson(res, 502, { type: 'error', error: { type: 'proxy_error', message: String(err) } });
        } else {
          res.end();
        }
      });
    });

    const baseUrl = await new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') { reject(new Error('failed to bind claude-local proxy')); return; }
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    this.proxies.set(key, { server, baseUrl });
    return { baseUrl, noProxyHosts: ['127.0.0.1', 'localhost', '::1'] };
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    targetBase: string,
    targetApiKey: string,
    defaultModel: string,
  ): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    // Health check / model listing (pass through unchanged)
    if (req.method === 'GET') {
      const fetched = await fetch(`${targetBase}${url.pathname}${url.search}`, {
        headers: { Authorization: `Bearer ${targetApiKey}`, Accept: 'application/json' },
      });
      res.writeHead(fetched.status, { 'content-type': 'application/json' });
      res.end(await fetched.text());
      return;
    }

    // Only handle POST /v1/messages
    const isMsgs = req.method === 'POST' && url.pathname.replace(/\/$/, '').endsWith('/messages');
    if (!isMsgs) {
      sendJson(res, 404, { type: 'error', error: { type: 'not_found', message: 'not found' } });
      return;
    }

    const body = await readRequestJson(req) as Obj;
    const isStream = body.stream === true;

    // Use the model from the body if it looks bare (no slash), otherwise use provider's model
    const rawModel = typeof body.model === 'string' ? body.model : defaultModel;
    const resolvedModel = rawModel.includes('/') ? rawModel.replace(/^[^/]+\//, '') : rawModel || defaultModel;
    const oaiBody = anthropicToOaiRequest(body, resolvedModel || defaultModel);

    const msgId = `msg_${Date.now().toString(36)}`;

    const upstream = await fetch(`${targetBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${targetApiKey}`,
        Accept: isStream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify(oaiBody),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = upstream.body ? await upstream.text() : 'empty body';
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'upstream_error', message: errText } }));
      return;
    }

    if (isStream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      // Convert the response body (WHATWG ReadableStream) to a Node.js Readable
      const nodeStream = upstream.body as unknown as NodeJS.ReadableStream;
      await streamOaiToAnthropic(nodeStream, res, msgId, resolvedModel || defaultModel);
      res.end();
    } else {
      const oaiResp = await upstream.json() as Obj;
      const anthropicResp = oaiToAnthropicResponse(oaiResp, resolvedModel || defaultModel);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(anthropicResp));
    }
  }

  close(): void {
    for (const p of this.proxies.values()) { try { p.server.close(); } catch { /* ok */ } }
    this.proxies.clear();
  }
}
