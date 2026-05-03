import { describe, it, expect } from 'vitest';
import type { ProviderProfile } from '@tday/shared';

import {
  normalizeProviderProfile,
  normalizeProvidersConfig,
  appendNoProxy,
} from '../provider-utils.js';

describe('normalizeProviderProfile', () => {
  it('adds default apiStyle=openai when missing', () => {
    const profile: ProviderProfile = { id: 'p1', label: 'Test', kind: 'openai', apiKey: 'k' };
    const result = normalizeProviderProfile(profile);
    expect(result.apiStyle).toBe('openai');
  });

  it('normalizes deepseek baseUrl with trailing /v1 to without', () => {
    const profile: ProviderProfile = {
      id: 'ds',
      label: 'DeepSeek',
      kind: 'deepseek',
      apiKey: 'k',
      apiStyle: 'openai',
      baseUrl: 'https://api.deepseek.com/v1',
    };
    const result = normalizeProviderProfile(profile);
    expect(result.baseUrl).toBe('https://api.deepseek.com');
  });

  it('does not modify non-deepseek providers', () => {
    const profile: ProviderProfile = {
      id: 'op',
      label: 'OpenAI',
      kind: 'openai',
      apiKey: 'k',
      apiStyle: 'openai',
      baseUrl: 'https://api.openai.com/v1',
    };
    const result = normalizeProviderProfile(profile);
    expect(result.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('preserves existing apiStyle', () => {
    const profile: ProviderProfile = { id: 'p', label: 'A', kind: 'anthropic', apiKey: 'k', apiStyle: 'anthropic' };
    const result = normalizeProviderProfile(profile);
    expect(result.apiStyle).toBe('anthropic');
  });
});

describe('normalizeProvidersConfig', () => {
  it('normalizes all profiles', () => {
    const config = {
      profiles: [
        { id: 'p1', label: 'A', kind: 'openai', apiKey: 'k' } as ProviderProfile,
        { id: 'p2', label: 'DS', kind: 'deepseek', apiKey: 'k', apiStyle: 'openai' as const, baseUrl: 'https://api.deepseek.com/v1' } as ProviderProfile,
      ],
    };
    const result = normalizeProvidersConfig(config);
    expect(result.profiles[0].apiStyle).toBe('openai');
    expect(result.profiles[1].baseUrl).toBe('https://api.deepseek.com');
  });

  it('returns empty profiles array unchanged', () => {
    const result = normalizeProvidersConfig({ profiles: [] });
    expect(result.profiles).toEqual([]);
  });
});

describe('appendNoProxy', () => {
  it('adds hosts to NO_PROXY and no_proxy', () => {
    const env: Record<string, string> = {};
    appendNoProxy(env, ['localhost', '127.0.0.1']);
    expect(env.NO_PROXY).toContain('localhost');
    expect(env.NO_PROXY).toContain('127.0.0.1');
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it('deduplicates hosts', () => {
    const env: Record<string, string> = { NO_PROXY: 'localhost', no_proxy: 'localhost' };
    appendNoProxy(env, ['localhost', '127.0.0.1']);
    const parts = env.NO_PROXY.split(',').filter(Boolean);
    const unique = new Set(parts);
    expect(parts.length).toBe(unique.size);
  });

  it('merges with existing NO_PROXY', () => {
    const env: Record<string, string> = { NO_PROXY: 'existing.host', no_proxy: 'existing.host' };
    appendNoProxy(env, ['new.host']);
    expect(env.NO_PROXY).toContain('existing.host');
    expect(env.NO_PROXY).toContain('new.host');
  });
});
