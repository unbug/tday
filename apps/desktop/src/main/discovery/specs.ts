/**
 * Well-known local AI service specs.
 *
 * For each service we know:
 *   - the default ports it listens on
 *   - a lightweight health-check path (returns 200 when up)
 *   - an optional model-listing path
 *   - the base URL suffix to use when constructing the OpenAI-compat URL
 *
 * Adding a new service is just one entry in SPECS.
 */

import type { ServiceSpec } from './types.js';

export const SPECS: ServiceSpec[] = [
  {
    kind: 'ollama',
    label: 'Ollama',
    ports: [11434],
    healthPath: '/api/version',
    modelsPath: '/api/tags',
    baseSuffix: '/v1',
  },
  {
    kind: 'lmstudio',
    label: 'LM Studio',
    ports: [1234],
    healthPath: '/v1/models',
    modelsPath: '/v1/models',
    baseSuffix: '/v1',
  },
  {
    kind: 'vllm',
    label: 'vLLM',
    ports: [8000],
    healthPath: '/health',
    modelsPath: '/v1/models',
    baseSuffix: '/v1',
  },
  {
    kind: 'sglang',
    label: 'SGLang',
    ports: [30000],
    healthPath: '/health',
    modelsPath: '/v1/models',
    baseSuffix: '/v1',
  },
  {
    kind: 'custom',
    label: 'llama.cpp',
    ports: [8080],
    healthPath: '/health',
    modelsPath: '/v1/models',
    baseSuffix: '/v1',
  },
  {
    kind: 'custom',
    label: 'LocalAI',
    ports: [8080],
    healthPath: '/readyz',
    modelsPath: '/v1/models',
    baseSuffix: '/v1',
  },
  {
    kind: 'custom',
    label: 'Jan',
    ports: [1337],
    healthPath: '/v1/models',
    modelsPath: '/v1/models',
    baseSuffix: '/v1',
  },
];
