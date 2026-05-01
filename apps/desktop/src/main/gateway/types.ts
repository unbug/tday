/**
 * Shared gateway interfaces.
 */

import type { AgentId, ProviderProfile } from '@tday/shared';

/** A generic string-keyed record, used throughout for unknown JSON objects. */
export type Obj = Record<string, unknown>;

/** The resolution result returned by the gateway manager. */
export interface GatewayResolution {
  baseUrl: string;
  noProxyHosts?: string[];
}

/** Context passed to each adapter when resolving a provider. */
export interface GatewayAdapterContext {
  agentId: AgentId;
  provider: ProviderProfile;
}

/** An internal adapter that handles a specific (agentId, provider.kind) pair. */
export interface GatewayAdapter {
  matches(ctx: GatewayAdapterContext): boolean;
  resolve(ctx: GatewayAdapterContext): Promise<GatewayResolution>;
  close(): void;
}

/** The public API exported from this package. */
export interface LocalGatewayManager {
  resolve(ctx: GatewayAdapterContext): Promise<GatewayResolution | null>;
  close(): void;
}
