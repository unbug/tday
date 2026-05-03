// Shared types between main, preload, and renderer.

export * from './presets';

/** Stable identifier for a built-in agent harness. */
export type AgentId =
  | 'pi'
  | 'claude-code'
  | 'codex'
  | 'copilot'
  | 'opencode'
  | 'gemini'
  | 'qwen-code'
  | 'crush'
  | 'hermes';

/**
 * Provider "kind" controls how credentials are projected onto an agent.
 *
 * The list mirrors the OpenClaw provider directory
 * (https://docs.openclaw.ai/providers) — every kind here corresponds to a
 * vendor whose API is widely supported by coding-agent harnesses.
 */
export type ProviderKind =
  | 'deepseek'
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'xai'
  | 'groq'
  | 'mistral'
  | 'moonshot'
  | 'cerebras'
  | 'together'
  | 'fireworks'
  | 'zai'
  | 'qwen'
  | 'volcengine'
  | 'minimax'
  | 'stepfun'
  | 'openrouter'
  | 'ollama'
  | 'lmstudio'
  | 'vercel-ai-gateway'
  | 'litellm'
  | 'nvidia'
  | 'huggingface'
  | 'perplexity'
  | 'bedrock'
  | 'sglang'
  | 'vllm'
  | 'custom';

/**
 * Many providers expose two parallel chat APIs: one wire-compatible with
 * OpenAI, one with Anthropic (e.g. DeepSeek, Moonshot, Z.AI). The user picks
 * which dialect Tday should configure for the harness agent.
 */
export type ApiStyle = 'openai' | 'anthropic';

/** Provider profile injected into an agent at launch. */
export interface ProviderProfile {
  id: string;
  label: string;
  /** What kind of provider this is — drives env-var / CLI projection. */
  kind: ProviderKind;
  /** Which dialect of base URL to use (default 'openai'). */
  apiStyle?: ApiStyle;
  /** Base URL for the chosen apiStyle, e.g. https://api.deepseek.com. */
  baseUrl?: string;
  /** Default model name to ask the agent to use. */
  model?: string;
  /** API key (resolved from keychain in later versions; static for v0.1.x). */
  apiKey?: string;
  /** Extra env vars applied verbatim. */
  env?: Record<string, string>;
  /** Model IDs discovered by the last successful Scan, persisted across sessions. */
  discoveredModels?: string[];
}

/** What the renderer asks the main process to spawn. */
export interface SpawnRequest {
  tabId: string;
  agentId: AgentId;
  providerId?: string;
  cwd?: string;
  cols: number;
  rows: number;
  /**
   * Agent-native session identifier for conversation resumption.
   * How it's used depends on the agent:
   *   claude-code  →  `claude --resume <id>`
   *   codex        →  `codex resume <id>` (subcommand)
   *   opencode     →  `opencode --session <id>`
   */
  agentSessionId?: string;
  /**
   * Initial prompt/task to send to the agent on startup.
   * Passed as a CLI positional argument for agents that support it
   * (codex, claude-code, opencode, gemini, qwen-code).
   * For others, the main process writes it directly to the PTY after
   * the agent is ready — this works even when the screen is locked since
   * the PTY is a kernel-level resource managed entirely in the main process.
   */
  initialPrompt?: string;
  /**
   * True when this tab was opened by the cron scheduler (not manually by the
   * user).  The main process uses this to select a non-interactive "batch"
   * launch mode for each agent:
   *   claude-code → `claude -p <prompt>`   (skips workspace trust dialog, exits when done)
   *   opencode    → `opencode run <prompt>` (one-shot mode, exits on completion)
   * Agents without a dedicated batch mode are unaffected.
   */
  isCronJob?: boolean;
}

/**
 * A single turn in a restored agent conversation.
 * Returned by `readAgentSession` — tool calls, reasoning and system messages
 * are stripped; only human-readable turns are included.
 */
export interface SessionMessage {
  role: 'user' | 'assistant';
  /** Plain text (tool calls / thinking stripped). */
  text: string;
}

/**
 * A record of a closed tab, persisted to ~/.tday/tab-history.json.
 * Agent conversation history is NOT duplicated here — we only store
 * the session ID so we can pass it to the agent's resume flag.
 */
export interface TabHistoryEntry {
  /** Unique history record ID (for deletion). */
  histId: string;
  title: string;
  agentId: AgentId;
  cwd: string;
  closedAt: number;
  /** Agent-native session ID (UUID or similar). Null when unsupported. */
  agentSessionId?: string;
}

/** Per-agent persisted settings. */
export interface AgentSettings {
  bin?: string;
  args?: string[];
  /** id of the ProviderProfile this agent always launches with. */
  providerId?: string;
  /** override the model from the bound provider, if set. */
  model?: string;
}

/** Static config loaded from ~/.tday/agents.json. */
export interface AgentsConfig {
  /** Which agent to launch in newly-created tabs (default: 'pi'). */
  defaultAgentId?: AgentId;
  agents?: Partial<Record<AgentId, AgentSettings>>;
}

/** Returned by `agents:list` — combines static spec, install state and bindings. */
export interface AgentInfo {
  id: AgentId;
  displayName: string;
  description?: string;
  npmPackage?: string;
  detect: { available: boolean; version?: string; error?: string };
  /** Bound provider id from agents.json. */
  providerId?: string;
  /** Bound model override. */
  model?: string;
  /** True if this agent is configured as the default for new tabs. */
  isDefault?: boolean;
}

/** Static config loaded from ~/.tday/providers.json (v0.1.0). */
export interface ProvidersConfig {
  default?: string;
  profiles: ProviderProfile[];
}

/**
 * A session entry in Tday's agent history index.
 * Represents a conversation from any supported agent's native session files
 * or from Tday-tracked tab history (fallback for agents with no native files).
 */
export interface AgentHistoryEntry {
  /** Globally unique ID within Tday's index. E.g. "claude-code:<uuid>" or "tday:<histId>". */
  id: string;
  /** Agent identifier (AgentId or unknown string for future agents). */
  agentId: string;
  /** Agent-native session ID passed to --resume / --session on restore. */
  sessionId?: string;
  /** Human-readable title: first user message, or file-derived fallback. */
  title: string;
  /** Working directory when the session was created. */
  cwd: string;
  /** Unix ms: when the session started. */
  startedAt: number;
  /** Unix ms: last activity (used for sorting, grouping). */
  updatedAt: number;
  /** Approximate count of user/assistant message turns. */
  messageCount: number;
  /**
   * 'native' = discovered from agent's own session files on disk.
   * 'tday'   = only tracked via Tday tab-close events (fallback).
   */
  source: 'native' | 'tday';
  /** True when user has hidden (soft-deleted) this entry from the index. */
  hidden?: boolean;
}

/** Filter for listAgentHistory. */
export interface AgentHistoryFilter {
  agentId?: string;
  fromTs?: number;
  limit?: number;
  includeHidden?: boolean;
}

// ─── CronJob types ────────────────────────────────────────────────────────────

/**
 * A scheduled automation job that opens a new agent tab at a defined cron schedule.
 * Uses standard 5-field cron syntax: "min hour dom month dow"
 */
export interface CronJob {
  id: string;
  name: string;
  agentId: AgentId;
  /** Working directory for the agent tab. */
  cwd: string;
  /** The prompt / goal to send to the agent when the cron fires. */
  prompt: string;
  /** Standard 5-field cron expression, e.g. "0 9 * * 1-5" */
  schedule: string;
  enabled: boolean;
  createdAt: number;
}

/** Runtime statistics for a CronJob — stored separately so the job config stays clean. */
export interface CronJobStats {
  jobId: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  runCount: number;
  lastStatus: 'ok' | 'error' | null;
}

/** Event sent from main → renderer when a scheduled cron fires. */
export interface CronFireEvent {
  jobId: string;
  agentId: AgentId;
  cwd: string;
  prompt: string;
  name: string;
}

/** IPC channel names. Keep in sync with preload + main. */
export const IPC = {
  ptySpawn: 'pty:spawn',
  ptyWrite: 'pty:write',
  ptyResize: 'pty:resize',
  ptyKill: 'pty:kill',
  ptyData: 'pty:data', // main -> renderer
  ptyExit: 'pty:exit', // main -> renderer
  agentsList: 'agents:list',
  agentsSave: 'agents:save', // renderer -> main: persist agents.json
  providersList: 'providers:list',
  providersSave: 'providers:save',
  agentInstall: 'agent:install',
  agentUpdate: 'agent:update',
  agentUninstall: 'agent:uninstall',
  agentInstallProgress: 'agent:install:progress',
  homeDir: 'app:home-dir', // renderer -> main: get HOME path
  pickDir: 'app:pick-dir', // renderer -> main: open folder picker
  // Local service discovery
  discoverServices: 'discovery:scan',
  probeUrl: 'discovery:probe-url',
  // Token usage statistics
  usageAppend: 'usage:append',
  usageQuery: 'usage:query',
  // Power management
  powerBlockerStart: 'power:blocker:start',
  powerBlockerStop: 'power:blocker:stop',
  // Tab history (closed tabs, restore-session)
  tabHistoryList: 'tab-history:list',
  tabHistoryPush: 'tab-history:push',
  tabHistoryDelete: 'tab-history:delete',
  latestAgentSession: 'tab-history:latest-session',
  readAgentSession: 'tab-history:read-session',
  // Agent history session manager
  agentHistoryList: 'agent-history:list',
  agentHistoryHide: 'agent-history:hide',
  agentHistoryRefresh: 'agent-history:refresh',
  // App settings — native persistent storage (replaces localStorage)
  settingsGetAll: 'settings:get-all',
  settingsSet: 'settings:set',
  // Open external URL in default browser
  openExternal: 'app:open-external',
  // CronJob management
  cronJobsList: 'cron:list',
  cronJobsSave: 'cron:save',
  cronJobsTrigger: 'cron:trigger',
  cronJobsGetStats: 'cron:stats',
  cronJobFired: 'cron:fired', // main -> renderer
} as const;

// ─── Discovery types ──────────────────────────────────────────────────────────

export interface DiscoveredService {
  kind: ProviderKind;
  label: string;
  /** OpenAI-compatible base URL, e.g. http://192.168.1.5:11434/v1 */
  baseUrl: string;
  models: string[];
  latencyMs: number;
}

export interface DiscoverServicesRequest {
  /** Additional hosts/IPs to probe beyond localhost. */
  extraHosts?: string[];
  /** Whether to scan the local /24 subnet. Default false. */
  scanSubnet?: boolean;
}

/** Result of probing a single base URL for available models. */
export interface ProbeUrlResult {
  ok: boolean;
  models: string[];
  latencyMs: number;
  error?: string;
}

// ─── Usage types ──────────────────────────────────────────────────────────────

export interface UsageRecord {
  ts: number;
  agentId: AgentId | string;
  providerId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Number of tool/function calls in this response (0 if not reported). */
  toolCalls?: number;
}

export interface UsageFilter {
  fromTs?: number;
  toTs?: number;
  agentId?: string;
  providerId?: string;
}

export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number | null;
}

export interface AgentUsage {
  agentId: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  costUsd: number | null;
}

export interface DailyStat {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  requests: number;
  costUsd: number | null;
  toolCalls: number;
}

export interface UsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  costUsd: number | null;
  /** cachedTokens / (inputTokens + cachedTokens), 0 when no input. */
  cacheHitRate: number;
  /** Total tool/function call invocations across all records. */
  totalToolCalls: number;
  /** Successful requests per active day in the queried window. */
  throughputReqPerDay: number;
  /** (input + output) tokens per minute across the actual record span. */
  throughputTokensPerMin: number;
  byModel: Record<string, ModelUsage>;
  byAgent: Record<string, AgentUsage>;
  daily: DailyStat[];
}

export interface PtyDataEvent {
  tabId: string;
  data: string;
}
export interface PtyExitEvent {
  tabId: string;
  exitCode: number | null;
  signal: number | null;
}

/** Streamed install progress for an on-demand harness install. */
export interface AgentInstallEvent {
  agentId: AgentId;
  /** 'stdout' | 'stderr' for log lines, 'progress' for percent updates,
   *  'done' on success, 'error' on failure. */
  kind: 'stdout' | 'stderr' | 'progress' | 'done' | 'error';
  data?: string;
  /** 0..100 when kind === 'progress'. */
  percent?: number;
  /** Short status label shown next to the bar. */
  status?: string;
  exitCode?: number | null;
}

/** Static metadata describing how an agent gets installed. */
export interface AgentInstallSpec {
  agentId: AgentId;
  displayName: string;
  /** Human-readable description shown to the user. */
  description: string;
  /** npm spec to globally install (e.g. "@mariozechner/pi-coding-agent"). */
  npmPackage?: string;
  /** Resulting binary expected on PATH after install. */
  bin: string;
}
