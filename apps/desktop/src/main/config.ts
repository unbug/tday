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
import type { AgentsConfig, ProvidersConfig } from '@tday/shared';

export const TDAY_DIR = join(homedir(), '.tday');

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
    writeFileSync(
      agentsPath,
      JSON.stringify(
        {
          agents: {
            pi: { bin: 'pi', args: [], providerId: 'deepseek' },
          },
        },
        null,
        2,
      ) + '\n',
    );
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
