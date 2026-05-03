/**
 * Agent detection, specification, and launch-argument utilities.
 *
 * Contains:
 *  - INSTALL_SPECS: per-agent npm package metadata
 *  - detectGeneric(): check if a binary is on PATH + get its version
 *  - resolveExecutable(): resolve a binary name to its absolute path
 *  - semverAtLeast(): semver comparison helper
 *  - normalizeLaunchCwd(): validate/normalize a working directory
 *  - opencodeProviderId(): map ProviderKind → opencode provider id
 *  - modelFlagsFor(): per-agent CLI flag conventions for model override
 *  - envKeyForKind(): map provider kind → API key env var name
 */

import { isAbsolute, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { PATH_SEP } from './path-utils.js';
import type { AgentId, AgentInstallSpec } from '@tday/shared';

// ── Version helpers ───────────────────────────────────────────────────────────

/**
 * Returns true if semver string `v` is >= `major.minor.patch`.
 * Accepts formats like "0.128.0", "v0.128.0", "0.128.0-beta.1".
 */
export function semverAtLeast(v: string, major: number, minor: number, patch: number): boolean {
  const m = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return false;
  const [, ma, mi, pa] = m.map(Number);
  if (ma !== major) return ma > major;
  if (mi !== minor) return mi > minor;
  return pa >= patch;
}

// ── Install specifications ────────────────────────────────────────────────────

/**
 * Auto-install registry. Pi gets a real npm installer; the other harnesses
 * are detected on PATH but installed by the user.
 */
export const INSTALL_SPECS: Record<AgentId, AgentInstallSpec | undefined> = {
  pi: {
    agentId: 'pi',
    displayName: 'Pi',
    description: 'badlogic/pi-mono coding agent (npm: @mariozechner/pi-coding-agent)',
    npmPackage: '@mariozechner/pi-coding-agent',
    bin: 'pi',
  },
  'claude-code': {
    agentId: 'claude-code',
    displayName: 'Claude Code',
    description: "Anthropic's official CLI (npm: @anthropic-ai/claude-code)",
    npmPackage: '@anthropic-ai/claude-code',
    bin: 'claude',
  },
  codex: {
    agentId: 'codex',
    displayName: 'Codex CLI',
    description: "OpenAI's coding agent (npm: @openai/codex)",
    npmPackage: '@openai/codex',
    bin: 'codex',
  },
  copilot: {
    agentId: 'copilot',
    displayName: 'Copilot CLI',
    description: "GitHub's terminal coding agent (npm: @github/copilot)",
    npmPackage: '@github/copilot',
    bin: 'copilot',
  },
  opencode: {
    agentId: 'opencode',
    displayName: 'OpenCode',
    description: 'sst/opencode terminal agent (npm: opencode-ai)',
    npmPackage: 'opencode-ai',
    bin: 'opencode',
  },
  gemini: {
    agentId: 'gemini',
    displayName: 'Gemini CLI',
    description: "Google's coding agent (npm: @google/gemini-cli)",
    npmPackage: '@google/gemini-cli',
    bin: 'gemini',
  },
  'qwen-code': {
    agentId: 'qwen-code',
    displayName: 'Qwen Code',
    description: "Alibaba's coding agent (npm: @qwen-code/qwen-code)",
    npmPackage: '@qwen-code/qwen-code',
    bin: 'qwen',
  },
  crush: {
    agentId: 'crush',
    displayName: 'Crush',
    description: 'charm.land terminal coding agent (npm: @charmland/crush)',
    npmPackage: '@charmland/crush',
    bin: 'crush',
  },
  hermes: {
    agentId: 'hermes',
    displayName: 'Hermes',
    description: 'Hermes coding agent — install manually and ensure `hermes` is on PATH',
    bin: 'hermes',
  },
};

// ── Detection ─────────────────────────────────────────────────────────────────

/**
 * Generic detect: which $bin + try --version with a short timeout.
 */
export function detectGeneric(bin: string): { available: boolean; version?: string; error?: string } {
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const path = execFileSync(whichCmd, [bin], { encoding: 'utf8' }).split(/\r?\n/)[0].trim();
    if (!path) return { available: false };
    let version: string | undefined;
    try {
      version = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 2_000 }).trim();
    } catch {
      // version is optional
    }
    return { available: true, version };
  } catch {
    return { available: false };
  }
}

// ── Executable resolution ─────────────────────────────────────────────────────

export function resolveExecutable(
  bin: string,
  env: NodeJS.ProcessEnv,
): { requested: string; resolved: string | null } {
  if (isAbsolute(bin)) {
    return { requested: bin, resolved: existsSync(bin) ? bin : null };
  }

  const suffixes = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];

  for (const dir of (env.PATH ?? '').split(PATH_SEP)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, bin + suffix);
      if (existsSync(candidate)) {
        return { requested: bin, resolved: candidate };
      }
    }
  }

  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    const resolved = execFileSync(whichCmd, [bin], {
      encoding: 'utf8',
      env,
      timeout: 2_000,
    }).split(/\r?\n/)[0].trim();
    return { requested: bin, resolved: resolved || null };
  } catch {
    return { requested: bin, resolved: null };
  }
}

export function normalizeLaunchCwd(cwd: string | undefined): string {
  if (cwd && existsSync(cwd)) return cwd;
  return homedir();
}

// ── Provider ID mapping ───────────────────────────────────────────────────────

/**
 * Map our internal `ProviderKind` to the provider id that opencode uses
 * internally (https://opencode.ai/docs/providers/).
 */
export function opencodeProviderId(kind: string | undefined): string {
  switch (kind) {
    case 'anthropic':   return 'anthropic';
    case 'google':      return 'google';
    case 'openrouter':  return 'openrouter';
    case 'groq':        return 'groq';
    case 'xai':         return 'xai';
    case 'mistral':     return 'mistral';
    case 'deepseek':    return 'deepseek';
    case 'fireworks':   return 'fireworks-ai';
    case 'together':    return 'togetherai';
    case 'cerebras':    return 'cerebras';
    case 'ollama':      return 'ollama';
    case 'lmstudio':    return 'lmstudio';
    case 'openai':
    default:            return 'openai';
  }
}

// ── API key env-var names ─────────────────────────────────────────────────────

/**
 * Map a provider kind + apiStyle to the environment variable name that holds
 * the API key. Used by Codex's `model_providers.tday.env_key` so Codex picks
 * the right key out of the environment we already populated.
 */
export function envKeyForKind(kind: string, style: 'openai' | 'anthropic' | undefined): string {
  if (style === 'anthropic') return 'ANTHROPIC_API_KEY';
  switch (kind) {
    case 'deepseek':    return 'DEEPSEEK_API_KEY';
    case 'google':      return 'GEMINI_API_KEY';
    case 'xai':         return 'XAI_API_KEY';
    case 'groq':        return 'GROQ_API_KEY';
    case 'mistral':     return 'MISTRAL_API_KEY';
    case 'moonshot':    return 'MOONSHOT_API_KEY';
    case 'cerebras':    return 'CEREBRAS_API_KEY';
    case 'together':    return 'TOGETHER_API_KEY';
    case 'fireworks':   return 'FIREWORKS_API_KEY';
    case 'zai':         return 'ZAI_API_KEY';
    case 'qwen':        return 'DASHSCOPE_API_KEY';
    case 'volcengine':  return 'ARK_API_KEY';
    case 'minimax':     return 'MINIMAX_API_KEY';
    case 'stepfun':     return 'STEPFUN_API_KEY';
    case 'openrouter':  return 'OPENROUTER_API_KEY';
    case 'anthropic':   return 'ANTHROPIC_API_KEY';
    default:            return 'OPENAI_API_KEY';
  }
}

// ── Model CLI flag conventions ────────────────────────────────────────────────

/**
 * Per-vendor CLI flag conventions for selecting the model. Projects Tday's
 * configured model onto the right command-line flag so the spawned process
 * honours Tday's choice every time.
 */
export function modelFlagsFor(
  agentId: AgentId,
  model: string | undefined,
  providerKind: string | undefined,
  apiStyle: 'openai' | 'anthropic' | undefined,
  baseUrl: string | undefined,
): string[] {
  if (!model) return [];
  switch (agentId) {
    case 'claude-code':
      return ['--model', model];
    case 'opencode': {
      const composed = model.includes('/') ? model : `${opencodeProviderId(providerKind)}/${model}`;
      return ['--model', composed];
    }
    case 'gemini':
      return ['--model', model];
    case 'qwen-code':
      return ['--model', model];
    case 'codex': {
      const args: string[] = ['--model', model];
      const envKey = providerKind ? envKeyForKind(providerKind, apiStyle) : 'OPENAI_API_KEY';
      args.push('-c', 'model_provider="tday"');
      args.push('-c', 'model_providers.tday.name="Tday"');
      if (baseUrl) {
        args.push('-c', `model_providers.tday.base_url="${baseUrl}"`);
      }
      args.push('-c', `model_providers.tday.env_key="${envKey}"`);
      args.push('-c', 'model_providers.tday.wire_api="responses"');
      args.push('-c', 'model_providers.tday.requires_openai_auth=false');
      const metaKey = `"${model.replace(/"/g, '\\"')}"`;
      args.push('-c', `model_metadata.${metaKey}.context_window=128000`);
      args.push('-c', `model_metadata.${metaKey}.max_output_tokens=8192`);
      return args;
    }
    case 'copilot':
      return ['--model', model];
    case 'crush':
    case 'hermes':
    case 'pi':
    default:
      return [];
  }
}
