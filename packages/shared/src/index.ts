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
  requests: number;
  costUsd: number | null;
}

export interface UsageSummary {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  costUsd: number | null;
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
