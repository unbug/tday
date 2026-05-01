import type { ApiStyle, ProviderKind } from './index';

/**
 * Preset definition for a provider kind. Drives both the Settings UI
 * (default base URLs, model dropdowns) and the seed providers.json.
 *
 * Each preset declares up to two API dialects:
 *   - `openai`    — OpenAI-wire-compatible base URL.
 *   - `anthropic` — Anthropic-wire-compatible base URL (when published).
 *
 * Models are the latest known IDs at packaging time. The Settings UI
 * always allows freeform input, so users can ship a new model the day it
 * lands without waiting for a Tday release.
 */
export interface ProviderPreset {
  kind: ProviderKind;
  label: string;
  description?: string;
  baseUrls: Partial<Record<ApiStyle, string>>;
  defaultStyle: ApiStyle;
  models: string[];
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    kind: 'deepseek',
    label: 'DeepSeek',
    description: 'OpenAI- and Anthropic-compatible.',
    baseUrls: {
      openai: 'https://api.deepseek.com',
      anthropic: 'https://api.deepseek.com/anthropic',
    },
    defaultStyle: 'openai',
    models: ['deepseek-v4-pro', 'deepseek-v4-flash', 'deepseek-chat', 'deepseek-reasoner'],
  },
  {
    kind: 'openai',
    label: 'OpenAI',
    baseUrls: { openai: 'https://api.openai.com/v1' },
    defaultStyle: 'openai',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4.1', 'gpt-4o', 'o4-mini', 'o3'],
  },
  {
    kind: 'anthropic',
    label: 'Anthropic',
    baseUrls: { anthropic: 'https://api.anthropic.com' },
    defaultStyle: 'anthropic',
    models: [
      'claude-opus-4-6',
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-3-5-sonnet-latest',
    ],
  },
  {
    kind: 'google',
    label: 'Google Gemini',
    baseUrls: { openai: 'https://generativelanguage.googleapis.com/v1beta/openai' },
    defaultStyle: 'openai',
    models: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.0-pro'],
  },
  {
    kind: 'xai',
    label: 'xAI (Grok)',
    baseUrls: {
      openai: 'https://api.x.ai/v1',
      anthropic: 'https://api.x.ai/anthropic',
    },
    defaultStyle: 'openai',
    models: ['grok-4', 'grok-4-fast', 'grok-code-fast-1', 'grok-3', 'grok-3-mini'],
  },
  {
    kind: 'groq',
    label: 'Groq',
    description: 'LPU inference — extremely fast.',
    baseUrls: { openai: 'https://api.groq.com/openai/v1' },
    defaultStyle: 'openai',
    models: [
      'llama-4-scout-17b-16e',
      'llama-4-maverick-17b-128e',
      'llama-3.3-70b-versatile',
      'qwen3-32b',
    ],
  },
  {
    kind: 'mistral',
    label: 'Mistral',
    baseUrls: { openai: 'https://api.mistral.ai/v1' },
    defaultStyle: 'openai',
    models: ['mistral-large-latest', 'mistral-medium-latest', 'codestral-latest', 'magistral-medium'],
  },
  {
    kind: 'moonshot',
    label: 'Moonshot AI (Kimi)',
    baseUrls: {
      openai: 'https://api.moonshot.ai/v1',
      anthropic: 'https://api.moonshot.ai/anthropic',
    },
    defaultStyle: 'openai',
    models: ['kimi-k2-coder', 'kimi-k2-instruct', 'kimi-latest', 'moonshot-v1-128k'],
  },
  {
    kind: 'cerebras',
    label: 'Cerebras',
    baseUrls: { openai: 'https://api.cerebras.ai/v1' },
    defaultStyle: 'openai',
    models: ['llama-4-maverick-17b-128e', 'qwen-3-coder-480b', 'llama3.3-70b'],
  },
  {
    kind: 'together',
    label: 'Together AI',
    baseUrls: { openai: 'https://api.together.xyz/v1' },
    defaultStyle: 'openai',
    models: [
      'deepseek-ai/DeepSeek-V3',
      'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
      'Qwen/Qwen3-Coder-480B-A35B-Instruct',
    ],
  },
  {
    kind: 'fireworks',
    label: 'Fireworks',
    baseUrls: { openai: 'https://api.fireworks.ai/inference/v1' },
    defaultStyle: 'openai',
    models: [
      'accounts/fireworks/models/qwen3-coder-480b-a35b',
      'accounts/fireworks/models/deepseek-v3p1',
      'accounts/fireworks/models/kimi-k2-instruct',
    ],
  },
  {
    kind: 'zai',
    label: 'Z.AI (GLM)',
    baseUrls: {
      openai: 'https://api.z.ai/api/paas/v4',
      anthropic: 'https://api.z.ai/api/anthropic',
    },
    defaultStyle: 'anthropic',
    models: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4-flash'],
  },
  {
    kind: 'qwen',
    label: 'Qwen (DashScope)',
    baseUrls: {
      openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    },
    defaultStyle: 'openai',
    models: ['qwen3-coder-plus', 'qwen3-max', 'qwen3-235b-a22b', 'qwen-plus', 'qwen-turbo'],
  },
  {
    kind: 'volcengine',
    label: 'Volcengine (Doubao)',
    baseUrls: { openai: 'https://ark.cn-beijing.volces.com/api/v3' },
    defaultStyle: 'openai',
    models: ['doubao-seed-1-6', 'doubao-1-5-pro-256k', 'doubao-pro-32k'],
  },
  {
    kind: 'minimax',
    label: 'MiniMax',
    baseUrls: { openai: 'https://api.minimaxi.com/v1' },
    defaultStyle: 'openai',
    models: ['MiniMax-M2', 'MiniMax-Text-01', 'abab7-chat-preview'],
  },
  {
    kind: 'stepfun',
    label: 'StepFun',
    baseUrls: { openai: 'https://api.stepfun.com/v1' },
    defaultStyle: 'openai',
    models: ['step-3', 'step-2-mini', 'step-1v-flash'],
  },
  {
    kind: 'openrouter',
    label: 'OpenRouter',
    description: 'Routed access to 200+ models.',
    baseUrls: {
      openai: 'https://openrouter.ai/api/v1',
      anthropic: 'https://openrouter.ai/api/v1/anthropic',
    },
    defaultStyle: 'openai',
    models: [
      'anthropic/claude-sonnet-4.5',
      'anthropic/claude-opus-4.6',
      'openai/gpt-5',
      'deepseek/deepseek-v4-pro',
      'x-ai/grok-4',
      'google/gemini-2.5-pro',
    ],
  },
  {
    kind: 'ollama',
    label: 'Ollama (local)',
    description: 'localhost daemon — auto-detected.',
    baseUrls: { openai: 'http://localhost:11434/v1' },
    defaultStyle: 'openai',
    models: ['llama3.3', 'qwen3:32b', 'deepseek-r1:14b', 'gpt-oss:20b'],
  },
  {
    kind: 'lmstudio',
    label: 'LM Studio (local)',
    baseUrls: { openai: 'http://localhost:1234/v1' },
    defaultStyle: 'openai',
    models: [],
  },
  {
    kind: 'vercel-ai-gateway',
    label: 'Vercel AI Gateway',
    baseUrls: { openai: 'https://ai-gateway.vercel.sh/v1' },
    defaultStyle: 'openai',
    models: [],
  },
  {
    kind: 'litellm',
    label: 'LiteLLM (proxy)',
    description: 'Self-hosted unified gateway.',
    baseUrls: { openai: 'http://localhost:4000/v1' },
    defaultStyle: 'openai',
    models: [],
  },
  {
    kind: 'nvidia',
    label: 'NVIDIA NIM',
    description: 'NVIDIA cloud inference (NIM).',
    baseUrls: { openai: 'https://integrate.api.nvidia.com/v1' },
    defaultStyle: 'openai',
    models: ['nvidia/llama-3.1-nemotron-ultra-253b-v1', 'meta/llama-4-maverick-17b-128e-instruct'],
  },
  {
    kind: 'huggingface',
    label: 'Hugging Face',
    description: 'Serverless Inference API.',
    baseUrls: { openai: 'https://router.huggingface.co/hf-inference/v1' },
    defaultStyle: 'openai',
    models: ['Qwen/Qwen3-235B-A22B', 'meta-llama/Llama-3.3-70B-Instruct'],
  },
  {
    kind: 'perplexity',
    label: 'Perplexity',
    description: 'Web-grounded search models.',
    baseUrls: { openai: 'https://api.perplexity.ai' },
    defaultStyle: 'openai',
    models: ['sonar-pro', 'sonar', 'sonar-reasoning'],
  },
  {
    kind: 'bedrock',
    label: 'Amazon Bedrock',
    description: 'AWS managed AI service.',
    baseUrls: { openai: 'https://bedrock-runtime.us-east-1.amazonaws.com' },
    defaultStyle: 'openai',
    models: ['anthropic.claude-opus-4', 'anthropic.claude-sonnet-4-5', 'amazon.nova-pro-v1:0'],
  },
  {
    kind: 'sglang',
    label: 'SGLang (local)',
    description: 'localhost SGLang server — auto-detected.',
    baseUrls: { openai: 'http://localhost:30000/v1' },
    defaultStyle: 'openai',
    models: [],
  },
  {
    kind: 'vllm',
    label: 'vLLM (local)',
    description: 'localhost vLLM server — auto-detected.',
    baseUrls: { openai: 'http://localhost:8000/v1' },
    defaultStyle: 'openai',
    models: [],
  },
  {
    kind: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrls: {},
    defaultStyle: 'openai',
    models: [],
  },
];

export function presetForKind(kind: ProviderKind): ProviderPreset {
  return (
    PROVIDER_PRESETS.find((p) => p.kind === kind) ??
    PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1]
  );
}
