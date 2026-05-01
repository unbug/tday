/**
 * Per-agent PTY output parsers for token usage extraction.
 *
 * Each coding-agent CLI prints a usage summary somewhere in its terminal
 * output when a turn or session completes.  These parsers extract token
 * counts from that raw PTY data WITHOUT any HTTP proxying.
 *
 * Why PTY scraping?
 *   - Zero network overhead (no proxy, no port allocation)
 *   - Works for any provider the agent talks to
 *   - The data is already flowing through our onData() handler
 *
 * Caveats:
 *   - Patterns must be updated when agent CLI output format changes
 *   - ANSI escape codes are stripped before matching
 *
 * Confirmed patterns:
 *   codex  v0.x  — "Token usage: total=X input=X (+ X cached) output=X"
 *                  Source: codex-rs/tui/src/token_usage.rs TokenUsage::fmt()
 */

export interface UsageDelta {
  /** Model name if parseable from the output, otherwise empty string */
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

// ─── ANSI strip helper ───────────────────────────────────────────────────────

/** Strip ANSI escape sequences so regex patterns don't need to account for them */
const ANSI_RE = /\x1b\[[0-9;]*[mGKHFABCDJrs]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

// ─── Number parser (handles comma-separated thousands: "1,234" → 1234) ──────

function parseNum(s: string | undefined): number {
  if (!s) return 0;
  return parseInt(s.replace(/,/g, ''), 10) || 0;
}

// ─── Per-agent patterns ───────────────────────────────────────────────────────

/**
 * codex (openai/codex)
 *
 * Printed on session exit by TokenUsage::fmt() in codex-rs/tui/src/token_usage.rs:
 *
 *   "Token usage: total=1,234 input=567 (+ 123 cached) output=456 (reasoning 78)"
 *
 * The "(+ X cached)" and "(reasoning X)" parts are optional.
 */
const CODEX_RE =
  /Token\s+usage:\s+total=[\d,]+\s+input=([\d,]+)(?:\s*\(\+\s*([\d,]+)\s*cached\))?\s+output=([\d,]+)/;

function parseCodex(data: string): UsageDelta | null {
  const clean = stripAnsi(data);
  const m = CODEX_RE.exec(clean);
  if (!m) return null;
  return {
    inputTokens: parseNum(m[1]),
    cachedTokens: parseNum(m[2]),
    outputTokens: parseNum(m[3]),
  };
}

// ─── Registry ─────────────────────────────────────────────────────────────────

type AgentParser = (data: string) => UsageDelta | null;

const PARSERS: Record<string, AgentParser> = {
  codex: parseCodex,
  // claude-code: tracked via OTel receiver (see otel-receiver.ts), no PTY scraping needed
  // opencode:    TUI-based, token stats stored in internal SQLite — not easily scrapable
  // gemini:      TODO — scrape "Total tokens used: X" if present
  // copilot:     TODO — scrape usage stats line if present
};

/**
 * Try to parse a token usage event from raw PTY data for the given agent.
 *
 * Returns a UsageDelta if token counts were found in this data chunk,
 * or null if nothing matched.
 */
export function parseUsageFromPty(agentId: string, data: string): UsageDelta | null {
  return PARSERS[agentId]?.(data) ?? null;
}
