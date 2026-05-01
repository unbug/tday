import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import type { AgentId, ProviderProfile } from '@tday/shared';

type JsonObject = Record<string, unknown>;

interface LocalProxy {
  server: Server;
  baseUrl: string;
}

export interface GatewayResolution {
  baseUrl: string;
  noProxyHosts?: string[];
}

interface GatewayProviderCapabilities {
  supportsResponses: boolean;
  supportsChatCompletions: boolean;
  acceptedChatRoles: ReadonlySet<string>;
  supportsReasoning: boolean;
}

interface GatewayAdapterContext {
  agentId: AgentId;
  provider: ProviderProfile;
}

interface GatewayAdapter {
  readonly name: string;
  readonly capabilities: GatewayProviderCapabilities;
  matches(ctx: GatewayAdapterContext): boolean;
  resolve(ctx: GatewayAdapterContext): Promise<GatewayResolution>;
  close(): void;
}

const DEEPSEEK_CAPABILITIES: GatewayProviderCapabilities = {
  supportsResponses: false,
  supportsChatCompletions: true,
  acceptedChatRoles: new Set(['system', 'user', 'assistant', 'tool', 'latest_reminder']),
  supportsReasoning: true,
};

function readRequestJson(req: IncomingMessage): Promise<JsonObject> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? (JSON.parse(raw) as JsonObject) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const p = part as JsonObject;
        const text = p.text ?? p.input_text ?? p.output_text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (content && typeof content === 'object') {
    const p = content as JsonObject;
    const text = p.text ?? p.input_text ?? p.output_text;
    return typeof text === 'string' ? text : '';
  }
  return '';
}

function normalizeChatRole(
  role: string | undefined,
  capabilities: GatewayProviderCapabilities,
): string {
  if (role && capabilities.acceptedChatRoles.has(role)) return role;
  switch (role) {
    case 'developer':
      return capabilities.acceptedChatRoles.has('system') ? 'system' : 'user';
    default:
      return 'user';
  }
}

function responsesInputToMessages(
  input: unknown,
  instructions: unknown,
  capabilities: GatewayProviderCapabilities,
  lookupCallReasoning?: (callId: string) => string | undefined,
): JsonObject[] {
  const messages: JsonObject[] = [];
  if (typeof instructions === 'string' && instructions.trim()) {
    messages.push({
      role: normalizeChatRole('system', capabilities),
      content: instructions,
    });
  }

  const addMessage = (role: string, content: unknown) => {
    const text = contentToText(content);
    if (text) messages.push({ role: normalizeChatRole(role, capabilities), content: text });
  };

  const visit = (item: unknown) => {
    if (typeof item === 'string') {
      addMessage('user', item);
      return;
    }
    if (!item || typeof item !== 'object') return;
    const obj = item as JsonObject;
    const type = typeof obj.type === 'string' ? obj.type : undefined;
    const role = typeof obj.role === 'string' ? obj.role : undefined;

    if (type === 'function_call') {
      const callId = String(obj.call_id ?? obj.id ?? `call_${messages.length}`);
      const name = String(obj.name ?? 'tool');
      const args =
        typeof obj.arguments === 'string'
          ? obj.arguments
          : JSON.stringify(obj.arguments ?? {});
      const msg: JsonObject = {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: callId, type: 'function', function: { name, arguments: args } }],
      };
      // Inject reasoning_content for multi-turn when client sends full history in input.
      // Only set when we have an actual non-empty string — DeepSeek rejects null values.
      const callReasoning = lookupCallReasoning?.(callId);
      if (typeof callReasoning === 'string' && callReasoning.length > 0) {
        msg.reasoning_content = callReasoning;
      }
      messages.push(msg);
      return;
    }

    // LiteLLM treats function_call_output, web_search_call, computer_call_output
    // and tool_result all as tool-call result messages.
    if (
      type === 'function_call_output' ||
      type === 'web_search_call' ||
      type === 'computer_call_output' ||
      type === 'tool_result'
    ) {
      messages.push({
        role: 'tool',
        tool_call_id: String(obj.call_id ?? obj.id ?? `call_${messages.length}`),
        content: contentToText(obj.output ?? obj.content ?? obj.result ?? ''),
      });
      return;
    }

    if (type === 'message' || role) {
      const resolvedRole = role ?? 'user';
      const text = contentToText(obj.content ?? obj.input ?? obj.output);
      if (text) {
        const msg: JsonObject = {
          role: normalizeChatRole(resolvedRole, capabilities),
          content: text,
        };
        // Inject reasoning_content for prior assistant messages sent back in input.
        // Only set when we have an actual non-empty string — DeepSeek rejects null values.
        if (resolvedRole === 'assistant' && typeof obj.id === 'string') {
          const itemReasoning = lookupCallReasoning?.(obj.id);
          if (typeof itemReasoning === 'string' && itemReasoning.length > 0) {
            msg.reasoning_content = itemReasoning;
          }
        }
        messages.push(msg);
      }
      return;
    }
  };

  if (Array.isArray(input)) input.forEach(visit);
  else visit(input);

  if (messages.length === 0) messages.push({ role: 'user', content: '' });
  return messages;
}

/**
 * Merge consecutive assistant messages that contain only `tool_calls` (no
 * `content`) into a single message.  This is necessary when Codex sends the
 * full conversation history in `input` (stateless mode): each `function_call`
 * item becomes its own assistant message via `visit()`, but the OpenAI /
 * DeepSeek chat-completions API requires that all tool calls from a single
 * model turn live in ONE assistant message — a second assistant message
 * immediately after a tool-calls message triggers the error
 * "An assistant message with 'tool_calls' must be followed by tool messages".
 */
function mergeConsecutiveToolCallMessages(messages: JsonObject[]): JsonObject[] {
  const result: JsonObject[] = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === 'assistant' && msg.content === null && Array.isArray(msg.tool_calls)) {
      const allToolCalls: JsonObject[] = [...(msg.tool_calls as JsonObject[])];
      // Collect the best (non-empty) reasoning string across all merged messages.
      // DeepSeek rejects null — only preserve a concrete string value.
      let reasoning: string | undefined =
        typeof msg.reasoning_content === 'string' && msg.reasoning_content.length > 0
          ? msg.reasoning_content
          : undefined;
      let j = i + 1;
      while (j < messages.length) {
        const next = messages[j];
        if (next.role === 'assistant' && next.content === null && Array.isArray(next.tool_calls)) {
          for (const tc of next.tool_calls as JsonObject[]) allToolCalls.push(tc);
          // Prefer the first non-empty reasoning string found across all merged messages.
          if (
            reasoning === undefined &&
            typeof next.reasoning_content === 'string' &&
            next.reasoning_content.length > 0
          ) {
            reasoning = next.reasoning_content;
          }
          j++;
        } else {
          break;
        }
      }
      const merged: JsonObject = { role: 'assistant', content: null, tool_calls: allToolCalls };
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

function responsesToolsToChatTools(tools: unknown): JsonObject[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const converted = tools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') return null;
      const obj = tool as JsonObject;
      // LiteLLM only converts tools with type === "function" to chat completion
      // tools. Built-in types like "web_search_preview", "web_search",
      // "file_search", "computer_use_preview", "code_interpreter" are either
      // extracted as provider options or dropped — they must never be forwarded
      // as function tools because downstream providers reject them or reject
      // their null/missing schemas.
      const toolType = typeof obj.type === 'string' ? obj.type : undefined;
      if (toolType && toolType !== 'function') return null;
      // Use obj.name only (not obj.type as fallback) — function tools must have
      // an explicit name.
      const name = obj.name;
      if (typeof name !== 'string' || !name) return null;
      // Normalise parameters to a valid JSON Schema object. Some tools supply
      // null or a schema with `type: null`; force `type: "object"` as LiteLLM
      // does so that all downstream chat-completions endpoints accept the call.
      const rawParams = obj.parameters;
      const parameters: JsonObject =
        rawParams && typeof rawParams === 'object' && !Array.isArray(rawParams)
          ? { ...(rawParams as JsonObject), type: 'object' }
          : { type: 'object', properties: {} };
      const fn: JsonObject = { name, description: obj.description, parameters };
      if (obj.strict !== undefined) fn.strict = obj.strict;
      return { type: 'function', function: fn };
    })
    .filter(Boolean) as JsonObject[];
  return converted.length ? converted : undefined;
}

function responsesToolChoiceToChatToolChoice(toolChoice: unknown): unknown {
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice;
  const choice = toolChoice as JsonObject;
  const name = choice.name ?? choice.type;
  if (typeof name === 'string' && !['auto', 'none', 'required'].includes(name)) {
    return { type: 'function', function: { name } };
  }
  return toolChoice;
}

function responsesRequestToChatRequest(
  body: JsonObject,
  priorMessages: JsonObject[],
  capabilities: GatewayProviderCapabilities,
  lookupCallReasoning?: (callId: string) => string | undefined,
): JsonObject {
  // Only inject instructions as a system message on the FIRST turn.
  // On continuation turns (priorMessages is non-empty and already contains the system
  // message from turn 1), skip instructions to avoid a duplicate system message
  // appearing mid-conversation, which causes DeepSeek to reject the request with
  // "reasoning_content in thinking mode must be passed back".
  const effectiveInstructions = priorMessages.length > 0 ? undefined : body.instructions;
  const rawMessages = [
    ...priorMessages,
    ...responsesInputToMessages(body.input, effectiveInstructions, capabilities, lookupCallReasoning),
  ];
  // Merge consecutive tool-call-only assistant messages into one (Codex stateless
  // mode sends each function_call as a separate item; DeepSeek requires them combined).
  const mergedMessages = mergeConsecutiveToolCallMessages(rawMessages);
  const chat: JsonObject = {
    model: body.model,
    messages: mergedMessages,
    stream: Boolean(body.stream),
  };
  const tools = responsesToolsToChatTools(body.tools);
  if (tools) chat.tools = tools;
  if (body.tool_choice) chat.tool_choice = responsesToolChoiceToChatToolChoice(body.tool_choice);
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;
  if (body.max_output_tokens !== undefined) chat.max_tokens = body.max_output_tokens;
  const reasoning = body.reasoning as JsonObject | undefined;
  if (capabilities.supportsReasoning && reasoning?.effort) {
    chat.reasoning_effort = reasoning.effort;
  }
  {
    // Determine whether to enable thinking mode:
    //   - First turn (no prior assistant messages): enable for known DeepSeek v4 thinking
    //     models (pro, flash, ultra, …) identified by the /deepseek-v4/ pattern.
    //   - Subsequent turns: enable only when ALL prior assistant messages (text AND
    //     tool-call) carry a non-empty `reasoning_content` string.  A null or absent
    //     field means we failed to capture it — disabling thinking prevents the 400
    //     "must be passed back" error.  DeepSeek rejects null reasoning_content values,
    //     so we only consider non-empty strings as valid captured reasoning.
    const isKnownThinkingModel = /deepseek-v4/i.test(String(body.model ?? ''));
    const msgs = chat.messages as JsonObject[];
    const assistantMsgs = msgs.filter((m) => m.role === 'assistant');
    const shouldEnableThinking =
      assistantMsgs.length === 0
        ? isKnownThinkingModel
        : assistantMsgs.every(
            (m) => typeof m.reasoning_content === 'string' && (m.reasoning_content as string).length > 0,
          );
    if (shouldEnableThinking) {
      chat.thinking = { type: 'enabled' };
    }
  }
  return chat;
}

function sendJson(res: ServerResponse, status: number, body: JsonObject): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function writeSse(res: ServerResponse, event: JsonObject): void {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function baseResponse(
  id: string,
  model: unknown,
  status: string,
  output: JsonObject[] = [],
): JsonObject {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output,
    parallel_tool_calls: true,
  };
}

/**
 * Convert response output items to chat-completions history messages.
 *
 * `reasoningContent` is only a non-empty string or undefined:
 *   - `undefined`      — thinking was NOT enabled or we failed to capture it;
 *                        do NOT add the field — enables a clean fallback next turn.
 *   - `"non-empty"`   — thinking WAS enabled and the model produced content;
 *                        add the string to EVERY assistant message in the turn.
 *
 * DeepSeek rejects `null` and rejects a missing field when thinking is active,
 * so we never store null.  Attaching reasoning to every assistant message in
 * the turn (both text messages and tool-call messages) ensures the next turn's
 * `shouldEnableThinking` check passes for all messages uniformly.
 */
function responseOutputToChatMessages(
  output: JsonObject[],
  reasoningContent?: string,
): JsonObject[] {
  const messages: JsonObject[] = [];
  const toolCalls: JsonObject[] = [];
  const hasReasoning = typeof reasoningContent === 'string' && reasoningContent.length > 0;
  for (const item of output) {
    if (item.type === 'message') {
      const text = contentToText(item.content);
      if (text) {
        const msg: JsonObject = { role: 'assistant', content: text };
        if (hasReasoning) msg.reasoning_content = reasoningContent;
        messages.push(msg);
      }
    } else if (item.type === 'function_call') {
      toolCalls.push({
        id: item.call_id ?? item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments:
            typeof item.arguments === 'string'
              ? item.arguments
              : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }
  if (toolCalls.length) {
    const msg: JsonObject = { role: 'assistant', content: null, tool_calls: toolCalls };
    if (hasReasoning) msg.reasoning_content = reasoningContent;
    messages.push(msg);
  }
  return messages;
}

function normalizeUpstreamError(status: number, text: string): JsonObject {
  return {
    error: {
      message: text || `upstream error: ${status}`,
      type: 'upstream_error',
      status,
    },
  };
}

class CodexDeepSeekResponsesAdapter implements GatewayAdapter {
  readonly name = 'codex-deepseek-responses';
  readonly capabilities = DEEPSEEK_CAPABILITIES;

  private readonly proxies = new Map<string, LocalProxy>();
  private readonly conversations = new Map<string, JsonObject[]>();
  /** Maps tool call_id → reasoning_content so subsequent turns can inject it even
   *  when the client sends the full history in `input` without `previous_response_id`. */
  /**
   * Maps call_id / message-id → reasoning_content captured from the upstream
   * DeepSeek response.  Only non-empty strings are stored — null is never used
   * because DeepSeek rejects null reasoning_content values with a 400 error.
   * Keys whose thinking state is unknown (or reasoning was not captured) are
   * absent from the map, which triggers thinking to be disabled next turn.
   */
  private readonly callReasoning = new Map<string, string>();

  matches(ctx: GatewayAdapterContext): boolean {
    return (
      ctx.agentId === 'codex' &&
      ctx.provider.kind === 'deepseek' &&
      (ctx.provider.apiStyle ?? 'openai') === 'openai'
    );
  }

  async resolve(ctx: GatewayAdapterContext): Promise<GatewayResolution> {
    const key = JSON.stringify({
      id: ctx.provider.id,
      baseUrl: ctx.provider.baseUrl,
      apiKey: ctx.provider.apiKey,
    });
    const existing = this.proxies.get(key);
    if (existing) {
      return {
        baseUrl: existing.baseUrl,
        noProxyHosts: ['127.0.0.1', 'localhost', '::1'],
      };
    }

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname.replace(/\/$/, '') === '/responses') {
        void this.handleResponses(req, res, ctx.provider).catch((err: unknown) => {
          console.error('[tday] gateway adapter error:', this.name, err);
          if (!res.headersSent) {
            sendJson(res, 500, {
              error: { message: String(err), type: 'gateway_adapter_error' },
            });
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
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('failed to bind local gateway adapter'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}`);
      });
    });

    this.proxies.set(key, { server, baseUrl });
    return {
      baseUrl,
      noProxyHosts: ['127.0.0.1', 'localhost', '::1'],
    };
  }

  close(): void {
    for (const proxy of this.proxies.values()) {
      try {
        proxy.server.close();
      } catch {
        // already closed
      }
    }
    this.proxies.clear();
    this.conversations.clear();
    this.callReasoning.clear();
  }

  private indexCallReasoning(output: JsonObject[], reasoning: string | undefined): void {
    // Only index non-empty strings.  DeepSeek rejects null reasoning_content,
    // so we never store null — an absent map entry means thinking was not
    // captured and the next turn will safely disable thinking mode.
    if (typeof reasoning !== 'string' || reasoning.length === 0) return;
    for (const item of output) {
      // Index function_call items by call_id
      if (item.type === 'function_call' && typeof item.call_id === 'string') {
        this.callReasoning.set(item.call_id, reasoning);
      }
      // Index message items by id so subsequent turns can inject reasoning_content
      // when Codex sends prior assistant messages back in the input array
      if (item.type === 'message' && typeof item.id === 'string') {
        this.callReasoning.set(item.id, reasoning);
      }
    }
  }

  private async handleResponses(
    req: IncomingMessage,
    res: ServerResponse,
    provider: ProviderProfile,
  ): Promise<void> {
    const body = await readRequestJson(req);
    const responseId = `resp_tday_${Date.now().toString(36)}`;
    const priorMessages =
      typeof body.previous_response_id === 'string'
        ? (this.conversations.get(body.previous_response_id) ?? [])
        : [];
    const chatBody = responsesRequestToChatRequest(
      body,
      priorMessages,
      this.capabilities,
      (callId) => this.callReasoning.get(callId),
    );
    const requestMessages = Array.isArray(chatBody.messages)
      ? (chatBody.messages as JsonObject[])
      : [];
    const target = new URL('/chat/completions', provider.baseUrl ?? 'https://api.deepseek.com');
    const auth =
      req.headers.authorization ?? (provider.apiKey ? `Bearer ${provider.apiKey}` : undefined);

    const upstream = await fetch(target, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(auth ? { authorization: auth } : {}),
      },
      body: JSON.stringify(chatBody),
    });

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      sendJson(res, upstream.status || 502, normalizeUpstreamError(upstream.status || 502, text));
      return;
    }

    if (!body.stream) {
      const json = (await upstream.json()) as JsonObject;
      const choice = Array.isArray(json.choices) ? (json.choices[0] as JsonObject | undefined) : undefined;
      const message = (choice?.message as JsonObject | undefined) ?? {};
      const text = contentToText(message.content);
      const rawToolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      // Capture reasoning_content only when it is a non-empty string.
      // DeepSeek rejects null values — if the model did not produce reasoning
      // (e.g. the model doesn't support thinking, or this turn had no thoughts),
      // store undefined so the next turn's shouldEnableThinking check correctly
      // disables thinking rather than sending an invalid null back.
      const upstreamReasoningContent: string | undefined =
        typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0
          ? message.reasoning_content
          : undefined;

      const output: JsonObject[] = [];
      if (text) {
        output.push({
          id: `msg_${responseId}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        });
      }
      for (let i = 0; i < rawToolCalls.length; i++) {
        const tc = rawToolCalls[i] as JsonObject;
        const fn = (tc.function as JsonObject | undefined) ?? {};
        const callId = String(tc.id ?? `call_${responseId}_${i}`);
        output.push({
          id: `fc_${responseId}_${i}`,
          type: 'function_call',
          status: 'completed',
          call_id: callId,
          name: String(fn.name ?? ''),
          arguments:
            typeof fn.arguments === 'string'
              ? fn.arguments
              : JSON.stringify(fn.arguments ?? {}),
        });
      }

      this.conversations.set(responseId, [
        ...requestMessages,
        ...responseOutputToChatMessages(output, upstreamReasoningContent),
      ]);
      this.indexCallReasoning(output, upstreamReasoningContent);
      sendJson(res, 200, baseResponse(responseId, body.model, 'completed', output));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    writeSse(res, {
      type: 'response.created',
      sequence_number: 0,
      response: baseResponse(responseId, body.model, 'in_progress'),
    });
    writeSse(res, {
      type: 'response.in_progress',
      sequence_number: 1,
      response: baseResponse(responseId, body.model, 'in_progress'),
    });

    const decoder = new TextDecoder();
    let buffer = '';
    let sequence = 2;
    let messageStarted = false;
    let text = '';
    let streamReasoningContent = '';
    const toolCalls = new Map<
      number,
      { itemId: string; callId: string; name: string; arguments: string; outputIndex: number }
    >();

    const emitMessageStart = () => {
      if (messageStarted) return;
      messageStarted = true;
      writeSse(res, {
        type: 'response.output_item.added',
        sequence_number: sequence++,
        output_index: 0,
        item: {
          id: `msg_${responseId}`,
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      });
      writeSse(res, {
        type: 'response.content_part.added',
        sequence_number: sequence++,
        item_id: `msg_${responseId}`,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
      });
    };

    const emitToolStart = (index: number, callId: string, name: string) => {
      const existing = toolCalls.get(index);
      if (existing) return existing;
      const outputIndex = toolCalls.size + (messageStarted ? 1 : 0);
      const itemId = `fc_${responseId}_${index}`;
      const next = { itemId, callId, name, arguments: '', outputIndex };
      toolCalls.set(index, next);
      writeSse(res, {
        type: 'response.output_item.added',
        sequence_number: sequence++,
        output_index: outputIndex,
        item: {
          id: itemId,
          type: 'function_call',
          status: 'in_progress',
          call_id: callId,
          name,
          arguments: '',
        },
      });
      return next;
    };

    const flushLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') return;
      const chunk = JSON.parse(data) as JsonObject;
      const choice = Array.isArray(chunk.choices) ? (chunk.choices[0] as JsonObject | undefined) : undefined;
      const delta = (choice?.delta as JsonObject | undefined) ?? {};
      const reasoningDelta = delta.reasoning_content;
      if (typeof reasoningDelta === 'string' && reasoningDelta) {
        streamReasoningContent += reasoningDelta;
      }
      const content = delta.content;
      if (typeof content === 'string' && content) {
        emitMessageStart();
        text += content;
        writeSse(res, {
          type: 'response.output_text.delta',
          sequence_number: sequence++,
          item_id: `msg_${responseId}`,
          output_index: 0,
          content_index: 0,
          delta: content,
        });
      }
      const rawToolCalls = delta.tool_calls;
      if (Array.isArray(rawToolCalls)) {
        for (const raw of rawToolCalls) {
          if (!raw || typeof raw !== 'object') continue;
          const tool = raw as JsonObject;
          const index = typeof tool.index === 'number' ? tool.index : 0;
          const fn = (tool.function as JsonObject | undefined) ?? {};
          const call = emitToolStart(
            index,
            String(tool.id ?? `call_${responseId}_${index}`),
            String(fn.name ?? toolCalls.get(index)?.name ?? 'tool'),
          );
          const argDelta = typeof fn.arguments === 'string' ? fn.arguments : '';
          if (argDelta) {
            call.arguments += argDelta;
            writeSse(res, {
              type: 'response.function_call_arguments.delta',
              sequence_number: sequence++,
              item_id: call.itemId,
              output_index: call.outputIndex,
              delta: argDelta,
            });
          }
        }
      }
    };

    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) flushLine(line);
    }
    if (buffer) flushLine(buffer);

    if (messageStarted) {
      writeSse(res, {
        type: 'response.output_text.done',
        sequence_number: sequence++,
        item_id: `msg_${responseId}`,
        output_index: 0,
        content_index: 0,
        text,
        logprobs: [],
      });
      writeSse(res, {
        type: 'response.content_part.done',
        sequence_number: sequence++,
        item_id: `msg_${responseId}`,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text, annotations: [] },
      });
      writeSse(res, {
        type: 'response.output_item.done',
        sequence_number: sequence++,
        output_index: 0,
        item: {
          id: `msg_${responseId}`,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text, annotations: [] }],
        },
      });
    }

    for (const call of toolCalls.values()) {
      writeSse(res, {
        type: 'response.function_call_arguments.done',
        sequence_number: sequence++,
        item_id: call.itemId,
        output_index: call.outputIndex,
        name: call.name,
        arguments: call.arguments,
      });
      writeSse(res, {
        type: 'response.output_item.done',
        sequence_number: sequence++,
        output_index: call.outputIndex,
        item: {
          id: call.itemId,
          type: 'function_call',
          status: 'completed',
          call_id: call.callId,
          name: call.name,
          arguments: call.arguments,
        },
      });
    }

    const output: JsonObject[] = [];
    if (messageStarted) {
      output.push({
        id: `msg_${responseId}`,
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      });
    }
    for (const call of toolCalls.values()) {
      output.push({
        id: call.itemId,
        type: 'function_call',
        status: 'completed',
        call_id: call.callId,
        name: call.name,
        arguments: call.arguments,
      });
    }
    writeSse(res, {
      type: 'response.completed',
      sequence_number: sequence++,
      response: baseResponse(responseId, body.model, 'completed', output),
    });
    // Only persist a non-empty reasoning string.  Never use null — DeepSeek
    // rejects null reasoning_content values.  An absent map entry means
    // thinking was not captured; the next turn will disable thinking mode.
    const finalReasoning: string | undefined =
      streamReasoningContent.length > 0 ? streamReasoningContent : undefined;
    this.conversations.set(responseId, [
      ...requestMessages,
      ...responseOutputToChatMessages(output, finalReasoning),
    ]);
    this.indexCallReasoning(output, finalReasoning);
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

export interface LocalGatewayManager {
  resolve(ctx: GatewayAdapterContext): Promise<GatewayResolution | null>;
  close(): void;
}

export function createLocalGatewayManager(): LocalGatewayManager {
  const adapters: GatewayAdapter[] = [new CodexDeepSeekResponsesAdapter()];
  return {
    async resolve(ctx) {
      for (const adapter of adapters) {
        if (adapter.matches(ctx)) return await adapter.resolve(ctx);
      }
      return null;
    },
    close() {
      for (const adapter of adapters) adapter.close();
    },
  };
}
