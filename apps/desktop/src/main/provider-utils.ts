/**
 * Provider profile normalization utilities.
 */

import type { ProviderProfile, ProvidersConfig } from '@tday/shared';

export function normalizeProviderProfile(provider: ProviderProfile): ProviderProfile {
  const apiStyle = provider.apiStyle ?? 'openai';
  if (
    provider.kind === 'deepseek' &&
    apiStyle === 'openai' &&
    provider.baseUrl?.replace(/\/$/, '') === 'https://api.deepseek.com/v1'
  ) {
    return { ...provider, apiStyle, baseUrl: 'https://api.deepseek.com' };
  }
  return provider.apiStyle ? provider : { ...provider, apiStyle };
}

export function normalizeProvidersConfig(config: ProvidersConfig): ProvidersConfig {
  return {
    ...config,
    profiles: config.profiles.map(normalizeProviderProfile),
  };
}

/**
 * Append hosts to NO_PROXY / no_proxy environment variables (both canonical
 * and lowercase forms) without creating duplicates.
 */
export function appendNoProxy(env: Record<string, string>, hosts: string[]): void {
  const existing = new Set(
    `${env.NO_PROXY ?? ''},${env.no_proxy ?? ''}`
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean),
  );
  for (const host of hosts) existing.add(host);
  const value = Array.from(existing).join(',');
  env.NO_PROXY = value;
  env.no_proxy = value;
}
