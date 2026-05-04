/**
 * Gateway public API.
 *
 * Internal implementation is split across:
 *   anthropic/          — Anthropic API types + HTTP client
 *   openai/             — OpenAI output types
 *   deepseek/           — Thinking encoding/decoding + ThinkingState cache
 *   bridge/             — Input/output/stream conversion between the two APIs
 *   adapter.ts          — Local HTTP proxy: Codex → DeepSeek (Anthropic)
 *   claude-local-adapter.ts — Local HTTP proxy: claude-code → local OAI-compat
 */

export type { GatewayResolution, LocalGatewayManager } from './types.js';
import type { LocalGatewayManager, GatewayAdapter } from './types.js';
import { CodexDeepSeekAnthropicAdapter } from './adapter.js';
import { ClaudeCodeLocalAdapter } from './claude-local-adapter.js';

/** Create and return a LocalGatewayManager instance. */
export function createLocalGatewayManager(): LocalGatewayManager {
  const adapters: GatewayAdapter[] = [
    // Most specific matches first.
    new CodexDeepSeekAnthropicAdapter(),
    // Translate claude-code (Anthropic Messages API) ↔ local OpenAI-compat servers.
    new ClaudeCodeLocalAdapter(),
  ];
  return {
    async resolve(ctx) {
      for (const a of adapters) {
        if (a.matches(ctx)) return a.resolve(ctx);
      }
      return null;
    },
    close() {
      for (const a of adapters) a.close();
    },
  };
}
