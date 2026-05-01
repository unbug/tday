/**
 * Gateway public API.
 *
 * Internal implementation is split across:
 *   anthropic/   — Anthropic API types + HTTP client
 *   openai/      — OpenAI output types
 *   deepseek/    — Thinking encoding/decoding + ThinkingState cache
 *   bridge/      — Input/output/stream conversion between the two APIs
 *   adapter.ts   — Local HTTP proxy server (CodexDeepSeekAnthropicAdapter)
 */

export type { GatewayResolution, LocalGatewayManager } from './types.js';
import type { LocalGatewayManager, GatewayAdapter } from './types.js';
import { CodexDeepSeekAnthropicAdapter } from './adapter.js';

/** Create and return a LocalGatewayManager instance. */
export function createLocalGatewayManager(): LocalGatewayManager {
  const adapters: GatewayAdapter[] = [new CodexDeepSeekAnthropicAdapter()];
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
