import { execFileSync } from 'node:child_process';
import type { ProviderProfile } from '@tday/shared';

export interface PiLaunchContext {
  bin?: string;
  extraArgs?: string[];
  provider?: ProviderProfile;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface BuiltLaunch {
  cmd: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

/**
 * Pi adapter — v0.1.0.
 *
 * "Pi" here is a generic stand-in for any CLI-based coding-agent harness whose
 * command is `pi` (or whatever path the user configures in
 * ~/.tday/agents.json). We deliberately keep this adapter minimal so it
 * works regardless of which `pi` binary the user has installed; we only own
 * env-var injection and process supervision.
 */
export const PiAdapter = {
  id: 'pi' as const,
  displayName: 'Pi',

  detect(bin = 'pi'): { available: boolean; version?: string; path?: string } {
    try {
      const path = execFileSync('which', [bin], { encoding: 'utf8' }).trim();
      let version: string | undefined;
      try {
        version = execFileSync(path, ['--version'], {
          encoding: 'utf8',
          timeout: 2_000,
        }).trim();
      } catch {
        // --version may not exist; that's fine.
      }
      return { available: Boolean(path), version, path };
    } catch {
      return { available: false };
    }
  },

  buildLaunch(ctx: PiLaunchContext): BuiltLaunch {
    const cmd = ctx.bin ?? 'pi';
    const args = [...(ctx.extraArgs ?? [])];

    const env: Record<string, string> = { ...(ctx.env as Record<string, string>) };
    const p = ctx.provider;
    if (p) {
      const style = p.apiStyle ?? 'openai';

      // Native vendor env-var conventions; OpenAI/Anthropic dialect URLs are
      // applied below depending on apiStyle.
      switch (p.kind) {
        case 'deepseek':
          if (p.apiKey) env.DEEPSEEK_API_KEY = p.apiKey;
          break;
        case 'google':
          if (p.apiKey) {
            env.GEMINI_API_KEY = p.apiKey;
            env.GOOGLE_API_KEY = p.apiKey;
          }
          break;
        case 'xai':
          if (p.apiKey) env.XAI_API_KEY = p.apiKey;
          break;
        case 'groq':
          if (p.apiKey) env.GROQ_API_KEY = p.apiKey;
          break;
        case 'mistral':
          if (p.apiKey) env.MISTRAL_API_KEY = p.apiKey;
          break;
        case 'moonshot':
          if (p.apiKey) env.MOONSHOT_API_KEY = p.apiKey;
          break;
        case 'cerebras':
          if (p.apiKey) env.CEREBRAS_API_KEY = p.apiKey;
          break;
        case 'together':
          if (p.apiKey) env.TOGETHER_API_KEY = p.apiKey;
          break;
        case 'fireworks':
          if (p.apiKey) env.FIREWORKS_API_KEY = p.apiKey;
          break;
        case 'zai':
          if (p.apiKey) env.ZAI_API_KEY = p.apiKey;
          break;
        case 'qwen':
          if (p.apiKey) env.DASHSCOPE_API_KEY = p.apiKey;
          break;
        case 'volcengine':
          if (p.apiKey) env.ARK_API_KEY = p.apiKey;
          break;
        case 'minimax':
          if (p.apiKey) env.MINIMAX_API_KEY = p.apiKey;
          break;
        case 'stepfun':
          if (p.apiKey) env.STEPFUN_API_KEY = p.apiKey;
          break;
        case 'openrouter':
          if (p.apiKey) env.OPENROUTER_API_KEY = p.apiKey;
          break;
        case 'openai':
        case 'anthropic':
        case 'ollama':
        case 'lmstudio':
        case 'vercel-ai-gateway':
        case 'litellm':
        case 'custom':
        default:
          // dialect helpers below cover the URL/key projection.
          break;
      }

      if (style === 'anthropic') {
        if (p.apiKey) env.ANTHROPIC_API_KEY = p.apiKey;
        if (p.baseUrl) {
          env.ANTHROPIC_BASE_URL = p.baseUrl;
          env.ANTHROPIC_API_URL = p.baseUrl;
        }
      } else {
        if (p.apiKey) env.OPENAI_API_KEY = p.apiKey;
        if (p.baseUrl) {
          env.OPENAI_BASE_URL = p.baseUrl;
          env.OPENAI_API_BASE = p.baseUrl;
        }
      }

      // Tell pi which provider/model to start with — non-fatal if pi ignores
      // these (older versions used env-only).
      if (p.kind && p.kind !== 'custom') {
        args.push('--provider', p.kind);
      }
      if (p.model) {
        args.push('--model', p.model);
      }

      Object.assign(env, p.env ?? {});
    }

    return { cmd, args, env, cwd: ctx.cwd };
  },
};
