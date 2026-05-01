/**
 * HTTP adapter: local HTTP server that proxies Codex → DeepSeek Anthropic endpoint.
 *
 * Wires together all bridge modules and implements the `GatewayAdapter` interface.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ProviderProfile } from '@tday/shared';
import type { Obj, GatewayAdapter, GatewayAdapterContext, GatewayResolution } from './types.js';
import type { AMessage, ARequest } from './anthropic/types.js';
import { callAnthropic, SseParser } from './anthropic/client.js';
import type { AResponse } from './anthropic/types.js';
import { baseResponse } from './openai/types.js';
import { ThinkingState } from './deepseek/state.js';
import { convertInput } from './bridge/input.js';
import { convertTools, convertToolChoice, mutateDsRequest } from './bridge/tools.js';
import { convertAnthropicResponse, buildStoredMessages, buildStoredMessagesFromStream, normalizeUsage } from './bridge/response.js';
import { AnthropicStreamConverter } from './bridge/stream.js';
import { appendUsage } from '../usage/store.js';

// ─── HTTP utilities ───────────────────────────────────────────────────────────

export function sendJson(res: ServerResponse, status: number, body: Obj): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function writeSse(res: ServerResponse, event: string, data: Obj): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Flush the kernel socket buffer immediately so each SSE event is delivered
  // to the client as soon as it is written, rather than being batched by the
  // TCP Nagle algorithm or Node.js's internal write queue.
  (res.socket as { flush?: () => void } | null)?.flush?.();
}

export function readRequestJson(req: IncomingMessage): Promise<Obj> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as Obj) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/** Extract a session key from well-known request headers. */
export function sessionKeyFromRequest(req: IncomingMessage): string {
  const sid = (req.headers['session_id'] ?? req.headers['x-session-id'] ?? '') as string;
  if (sid.trim()) return 'session:' + sid.trim();
  const wid = (req.headers['x-codex-window-id'] ?? '') as string;
  if (wid.trim()) return 'codex-window:' + wid.trim();
  return '';
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export class CodexDeepSeekAnthropicAdapter implements GatewayAdapter {
  private readonly proxies = new Map<string, { server: Server; baseUrl: string }>();
  private readonly conversations = new Map<string, AMessage[]>();
  private readonly thinkingStates = new Map<string, ThinkingState>();

  matches(ctx: GatewayAdapterContext): boolean {
    return ctx.agentId === 'codex' && ctx.provider.kind === 'deepseek';
  }

  async resolve(ctx: GatewayAdapterContext): Promise<GatewayResolution> {
    const key = JSON.stringify({
      id: ctx.provider.id,
      baseUrl: ctx.provider.baseUrl,
      apiKey: ctx.provider.apiKey,
    });
    const existing = this.proxies.get(key);
    if (existing) {
      return { baseUrl: existing.baseUrl, noProxyHosts: ['127.0.0.1', 'localhost', '::1'] };
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname.replace(/\/$/, '') === '/responses') {
        void this.handleResponses(req, res, ctx.provider, ctx.agentId).catch((err: unknown) => {
          console.error('[tday] gateway error:', err);
          if (!res.headersSent) {
            sendJson(res, 500, { error: { message: String(err), type: 'gateway_error' } });
          } else {
            res.end();
          }
        });
        return;
      }
      sendJson(res, 404, { error: { message: 'Not found', type: 'not_found' } });
    });

    const baseUrl = await new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('failed to bind gateway'));
          return;
        }
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });

    this.proxies.set(key, { server, baseUrl });
    return { baseUrl, noProxyHosts: ['127.0.0.1', 'localhost', '::1'] };
  }

  close(): void {
    for (const p of this.proxies.values()) { try { p.server.close(); } catch { /* ok */ } }
    this.proxies.clear();
    this.conversations.clear();
    this.thinkingStates.clear();
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private getThinkingState(req: IncomingMessage): ThinkingState {
    const key = sessionKeyFromRequest(req);
    if (!key) return new ThinkingState();
    let s = this.thinkingStates.get(key);
    if (!s) { s = new ThinkingState(); this.thinkingStates.set(key, s); }
    return s;
  }

  private anthropicUrl(provider: ProviderProfile): string {
    const base = (provider.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '');
    const anthropicBase = base.endsWith('/anthropic') ? base : base + '/anthropic';
    return anthropicBase + '/v1/messages';
  }

  private resolveApiKey(req: IncomingMessage, provider: ProviderProfile): string {
    const auth = req.headers.authorization ?? '';
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
    return provider.apiKey ?? '';
  }

  private async handleResponses(
    req: IncomingMessage,
    res: ServerResponse,
    provider: ProviderProfile,
    agentId: string,
  ): Promise<void> {
    const body = await readRequestJson(req);
    const responseId = `resp_tday_${Date.now().toString(36)}`;
    const thinkingState = this.getThinkingState(req);

    // Retrieve prior conversation context
    const priorMessages: AMessage[] =
      typeof body.previous_response_id === 'string'
        ? (this.conversations.get(body.previous_response_id) ?? [])
        : [];

    const { messages: newMessages, system, hasToolHistory: newToolHistory } = convertInput(
      body.input,
      priorMessages.length === 0 ? body.instructions : undefined,
      thinkingState,
    );

    const priorHasToolHistory = priorMessages.some(
      (m) => m.content.some((b) => b.type === 'tool_use' || b.type === 'tool_result'),
    );
    const hasToolHistory = newToolHistory || priorHasToolHistory;
    const allMessages = [...priorMessages, ...newMessages];

    // Build Anthropic request
    const anthropicReq: ARequest = {
      model: typeof body.model === 'string' ? body.model : '',
      max_tokens: typeof body.max_output_tokens === 'number' ? body.max_output_tokens : 32768,
      messages: allMessages,
      stream: Boolean(body.stream),
    };
    if (system.length) anthropicReq.system = system;
    const tools = convertTools(body.tools);
    if (tools?.length) anthropicReq.tools = tools;
    const toolChoice = convertToolChoice(body.tool_choice);
    if (toolChoice) anthropicReq.tool_choice = toolChoice;

    mutateDsRequest(anthropicReq, body.reasoning as Obj | undefined);

    // Call upstream
    const upstream = await callAnthropic(
      this.anthropicUrl(provider),
      this.resolveApiKey(req, provider),
      provider.env?.['ANTHROPIC_VERSION'] ?? '2023-06-01',
      anthropicReq,
    );

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      sendJson(res, upstream.status || 502, {
        error: { message: text || `upstream error: ${upstream.status}`, type: 'upstream_error' },
      });
      return;
    }

    // ── Non-streaming ──────────────────────────────────────────────────────
    if (!body.stream) {
      const json = await upstream.json() as AResponse;
      const { output, outputText } = convertAnthropicResponse(json, thinkingState, responseId);
      this.conversations.set(responseId, [...allMessages, ...buildStoredMessages(json.content)]);
      appendUsage({
        ts: Date.now(),
        agentId,
        providerId: provider.id,
        model: typeof body.model === 'string' ? body.model : '',
        inputTokens: json.usage?.input_tokens ?? 0,
        outputTokens: json.usage?.output_tokens ?? 0,
        cachedTokens: json.usage?.cache_read_input_tokens ?? 0,
      });
      sendJson(res, 200, {
        ...baseResponse(responseId, body.model, 'completed', output),
        output_text: outputText,
        usage: normalizeUsage(json.usage),
      });
      return;
    }

    // ── Streaming ──────────────────────────────────────────────────────────
    // Disable Nagle's algorithm so each SSE chunk is sent immediately without
    // waiting to be coalesced with subsequent writes.
    res.socket?.setNoDelay(true);
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    // Flush the 200 + headers to the client right away.  Without this the
    // headers stay in Node.js's internal buffer until the first res.write(),
    // delaying stream start on the Codex side.
    res.flushHeaders();

    const converter = new AnthropicStreamConverter(responseId, body.model, thinkingState, hasToolHistory);
    const parser = new SseParser();
    const decoder = new TextDecoder();
    let streamInputTokens = 0;
    let streamOutputTokens = 0;
    let streamCachedTokens = 0;

    /**
     * Forward converted SSE events to the client, one character at a time.
     *
     * Two levels of pacing:
     *
     * 1. **Character-level** — `response.output_text.delta` events are split
     *    into individual Unicode codepoints, each written in its own socket
     *    write with a `setImmediate` yield between them.  DeepSeek often packs
     *    several tokens into a single `text_delta` SSE event; without this
     *    split, Codex would receive a multi-character burst rather than the
     *    character-by-character trickle that creates the "streaming" feel.
     *
     * 2. **Event-level** — when an upstream TCP packet carries multiple
     *    Anthropic SSE events, a `setImmediate` yield between consecutive
     *    events ensures each gets its own libuv `write()` call (and therefore
     *    its own TCP segment, given `setNoDelay(true)`).
     */
    const emitEvents = async (events: ReturnType<typeof parser.push>) => {
      for (let i = 0; i < events.length; i++) {
        // Capture usage from message_start (input) and message_delta (output)
        const ev = events[i];
        if (ev.type === 'message_start' && ev.message?.usage) {
          streamInputTokens = ev.message.usage.input_tokens ?? 0;
          streamCachedTokens = ev.message.usage.cache_read_input_tokens ?? 0;
        } else if (ev.type === 'message_delta' && ev.usage) {
          streamOutputTokens = ev.usage.output_tokens ?? 0;
        }
        for (const { event: evName, data } of converter.processEvent(events[i])) {
          if (evName === 'response.output_text.delta') {
            // Spread into Unicode codepoints so multi-byte / emoji chars are
            // kept whole while we still iterate character-by-character.
            const chars = [...((data as { delta?: string }).delta ?? '')];
            for (let c = 0; c < chars.length; c++) {
              writeSse(res, evName, { ...(data as Obj), delta: chars[c] });
              if (c < chars.length - 1) await new Promise<void>((r) => setImmediate(r));
            }
          } else {
            writeSse(res, evName, data);
          }
        }
        if (i < events.length - 1) {
          await new Promise<void>((r) => setImmediate(r));
        }
      }
    };

    for await (const chunk of upstream.body as AsyncIterable<Uint8Array>) {
      await emitEvents(parser.push(decoder.decode(chunk, { stream: true })));
    }
    // Flush any data remaining after the stream closes
    await emitEvents(parser.end());

    const { output, outputText, completedReasoningText } = converter.finish();
    writeSse(res, 'response.completed', {
      type: 'response.completed',
      sequence_number: converter.next(),
      response: {
        ...baseResponse(responseId, body.model, 'completed', output),
        output_text: outputText,
      },
    });
    this.conversations.set(
      responseId,
      [...allMessages, ...buildStoredMessagesFromStream(output, completedReasoningText)],
    );
    appendUsage({
      ts: Date.now(),
      agentId,
      providerId: provider.id,
      model: typeof body.model === 'string' ? body.model : '',
      inputTokens: streamInputTokens,
      outputTokens: streamOutputTokens,
      cachedTokens: streamCachedTokens,
    });
    res.write('data: [DONE]\n\n');
    res.end();
  }
}
