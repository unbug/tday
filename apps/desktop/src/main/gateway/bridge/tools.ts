/**
 * Tool conversion: OpenAI tools → Anthropic ATool[], plus DeepSeek V4 request
 * mutation.
 */

import type { ARequest, ATool, AToolChoice } from '../anthropic/types.js';
import type { Obj } from '../types.js';

// ─── Tool conversion ──────────────────────────────────────────────────────────

/**
 * Convert an OpenAI tools array to Anthropic format.
 * Supports: `function`, `local_shell`, `namespace` (expanded as prefixed functions).
 * Unsupported built-in types (e.g. `file_search`, `web_search`) are silently
 * skipped — they have no Anthropic equivalent.
 *
 * Returns `undefined` if no convertible tools were found.
 */
export function convertTools(tools: unknown): ATool[] | undefined {
  if (!Array.isArray(tools)) return undefined;
  const result: ATool[] = [];

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const t = tool as Obj;
    const toolType = typeof t.type === 'string' ? t.type : '';

    switch (toolType) {
      case 'function': {
        const name = typeof t.name === 'string' ? t.name : '';
        if (!name) continue;
        const schema: Obj =
          t.parameters && typeof t.parameters === 'object' && !Array.isArray(t.parameters)
            ? { ...(t.parameters as Obj), type: 'object' }
            : { type: 'object', properties: {} };
        result.push({
          name,
          description: typeof t.description === 'string' ? t.description : undefined,
          input_schema: schema,
        });
        break;
      }

      case 'local_shell':
        result.push({
          name: 'local_shell',
          description: 'Run a local shell command.',
          input_schema: {
            type: 'object',
            properties: {
              command: { type: 'array', items: { type: 'string' } },
              working_directory: { type: 'string' },
              timeout_ms: { type: 'integer' },
              env: { type: 'object', additionalProperties: { type: 'string' } },
            },
            required: ['command'],
          },
        });
        break;

      case 'namespace': {
        // Expand child functions with a `<namespace>_<name>` qualified name
        const children = Array.isArray(t.tools) ? (t.tools as Obj[]) : [];
        const ns = typeof t.name === 'string' ? t.name : '';
        for (const child of children) {
          if (typeof child.type !== 'string' || child.type !== 'function') continue;
          const cName = typeof child.name === 'string' ? child.name : '';
          if (!cName) continue;
          const qualName = ns ? `${ns}_${cName}` : cName;
          const schema: Obj =
            child.parameters && typeof child.parameters === 'object' && !Array.isArray(child.parameters)
              ? { ...(child.parameters as Obj), type: 'object' }
              : { type: 'object', properties: {} };
          result.push({
            name: qualName,
            description: typeof child.description === 'string' ? child.description : undefined,
            input_schema: schema,
          });
        }
        break;
      }

      default:
        // Skip unsupported tool types (file_search, web_search, computer_use, etc.)
        break;
    }
  }

  return result.length ? result : undefined;
}

// ─── Tool-choice conversion ───────────────────────────────────────────────────

/**
 * Convert an OpenAI `tool_choice` value to the Anthropic equivalent.
 * OpenAI `"required"` maps to Anthropic `{type: "any"}`.
 */
export function convertToolChoice(toolChoice: unknown): AToolChoice | undefined {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    switch (toolChoice) {
      case 'auto':
      case 'none':
        return { type: toolChoice };
      case 'required':
        return { type: 'any' };
    }
    return undefined;
  }

  if (typeof toolChoice === 'object') {
    const tc = toolChoice as Obj;
    const name = ((tc.name ?? (tc.function as Obj | undefined)?.name ?? '') as string);
    const type = typeof tc.type === 'string' ? tc.type : '';
    if (type === 'auto' || type === 'none') return { type };
    if (type === 'required') return { type: 'any' };
    if (name) return { type: 'tool', name };
  }

  return undefined;
}

// ─── DeepSeek V4 request mutation ────────────────────────────────────────────

/**
 * Mutate an Anthropic request in-place to meet DeepSeek V4 requirements.
 *
 * - Removes `temperature` and `top_p` (unsupported by the extended-thinking
 *   endpoint).
 * - Maps OpenAI `reasoning.effort` → `output_config.effort`.
 *
 */
export function mutateDsRequest(req: ARequest, reasoning: Obj | undefined): void {
  delete (req as unknown as Obj).temperature;
  delete (req as unknown as Obj).top_p;

  const effort =
    typeof reasoning?.effort === 'string' ? reasoning.effort.toLowerCase().trim() : '';
  if (effort === 'high') {
    req.output_config = { effort: 'high' };
  } else if (effort === 'xhigh' || effort === 'max') {
    req.output_config = { effort: 'max' };
  }
}
