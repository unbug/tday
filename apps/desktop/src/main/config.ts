/**
 * Configuration loading and initialization.
 *
 * Handles reading/writing ~/.tday/agents.json and ~/.tday/providers.json,
 * and creating default configs on first launch.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { normalizeProvidersConfig } from './provider-utils.js';
import { detectGeneric } from './agent-utils.js';
import type { AgentsConfig, ProvidersConfig, AgentId } from '@tday/shared';

export const TDAY_DIR = join(homedir(), '.tday');

/**
 * Priority-ordered list of agents to probe on first launch.
 * The first binary found on PATH becomes the configured default.
 * Pi is intentionally last — it is the auto-install fallback for fresh
 * systems where nothing else is installed yet.
 *
 * On Windows, codex and claude-code are placed first because they have
 * the most robust Windows PATH setup and ConPTY support.
 */
const DETECT_PRIORITY: Array<{ id: AgentId; bin: string }> = [
  { id: 'codex',         bin: 'codex' },
  { id: 'claude-code',   bin: 'claude' },
  { id: 'opencode',      bin: 'opencode' },
  { id: 'gemini',        bin: 'gemini' },
  { id: 'qwen-code',     bin: 'qwen' },
  { id: 'crush',         bin: 'crush' },
  { id: 'hermes',        bin: 'hermes' },
  { id: 'deepseek-tui',  bin: 'deepseek' },
  { id: 'pi',            bin: 'pi' },
];

/**
 * Scan PATH for known agents and return the id of the first one found.
 * Falls back to 'pi' (which triggers auto-install) if nothing is detected.
 * Called only on first launch when agents.json does not exist yet.
 */
function detectBestDefaultAgent(): AgentId {
  for (const { id, bin } of DETECT_PRIORITY) {
    try {
      if (detectGeneric(bin).available) return id;
    } catch { /* ignore per-binary failures */ }
  }
  return 'pi';
}

export function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (err) {
    console.error('[tday] failed to read', path, err);
    return fallback;
  }
}

export function loadAgents(): AgentsConfig {
  return readJson<AgentsConfig>(join(TDAY_DIR, 'agents.json'), {});
}

export function loadProviders(): ProvidersConfig {
  return normalizeProvidersConfig(
    readJson<ProvidersConfig>(join(TDAY_DIR, 'providers.json'), {
      profiles: [],
    }),
  );
}

/**
 * Write default agents.json and providers.json on first launch.
 * Idempotent — does nothing if files already exist.
 */
export function initDefaultConfigs(): void {
  if (!existsSync(TDAY_DIR)) mkdirSync(TDAY_DIR, { recursive: true });

  const agentsPath = join(TDAY_DIR, 'agents.json');
  if (!existsSync(agentsPath)) {
    // Probe PATH for the best available agent so that users who already have
    // codex, claude-code, etc. installed don't get an unwanted Pi auto-install.
    const bestDefault = detectBestDefaultAgent();
    const agentsConfig: Record<string, unknown> = {
      agents: {
        pi: { bin: 'pi', args: [], providerId: 'deepseek' },
      },
    };
    // Only write the field when it's not the implicit default so existing
    // consumers that fall back to 'pi' on missing key still work.
    if (bestDefault !== 'pi') {
      agentsConfig.defaultAgentId = bestDefault;
    }
    writeFileSync(agentsPath, JSON.stringify(agentsConfig, null, 2) + '\n');
  }

  const providersPath = join(TDAY_DIR, 'providers.json');
  if (!existsSync(providersPath)) {
    writeFileSync(
      providersPath,
      JSON.stringify(
        {
          default: 'deepseek',
          profiles: [
            {
              id: 'deepseek',
              label: 'DeepSeek',
              kind: 'deepseek',
              apiStyle: 'openai',
              baseUrl: 'https://api.deepseek.com',
              model: 'deepseek-v4-pro',
              apiKey: '',
            },
            {
              id: 'openai',
              label: 'OpenAI',
              kind: 'openai',
              apiStyle: 'openai',
              baseUrl: 'https://api.openai.com/v1',
              model: 'gpt-5',
              apiKey: '',
            },
            {
              id: 'anthropic',
              label: 'Anthropic',
              kind: 'anthropic',
              apiStyle: 'anthropic',
              baseUrl: 'https://api.anthropic.com',
              model: 'claude-sonnet-4-5',
              apiKey: '',
            },
            {
              id: 'openrouter',
              label: 'OpenRouter',
              kind: 'openrouter',
              apiStyle: 'openai',
              baseUrl: 'https://openrouter.ai/api/v1',
              model: 'anthropic/claude-sonnet-4.5',
              apiKey: '',
            },
          ],
        },
        null,
        2,
      ) + '\n',
    );
  }
}
