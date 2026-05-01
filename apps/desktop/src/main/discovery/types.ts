/**
 * Local / LAN AI service discovery types.
 */

import type { ProviderKind } from '@tday/shared';

/** A single discovered local AI service endpoint. */
export interface DiscoveredService {
  /** What kind of service this is. */
  kind: ProviderKind;
  /** Human-readable name. */
  label: string;
  /** Base URL for the OpenAI-compatible API, e.g. http://192.168.1.5:11434 */
  baseUrl: string;
  /** Models reported by /api/tags or /v1/models (may be empty if listing failed). */
  models: string[];
  /** milliseconds the health check round-trip took */
  latencyMs: number;
}

/**
 * Well-known service definitions. Each entry declares how to detect one
 * class of local inference server.
 */
export interface ServiceSpec {
  kind: ProviderKind;
  label: string;
  /** Ports to probe on each host. */
  ports: number[];
  /**
   * HTTP path that returns 200 (or any non-connection-refused) when the
   * service is up. We do a lightweight HEAD/GET to this path.
   */
  healthPath: string;
  /**
   * Optional path to list available models.
   * Response must be JSON with a `models` array or `data` array of objects
   * with a `.id` or `.name` field.
   */
  modelsPath?: string;
  /** OpenAI-compatible base URL suffix (appended after host:port). */
  baseSuffix: string;
}

export interface DiscoveryOptions {
  /** Extra IPs/hostnames to probe in addition to localhost. */
  extraHosts?: string[];
  /** Probe the local subnet (/24) in parallel. Default false. */
  scanSubnet?: boolean;
  /**
   * Timeout in ms for each individual TCP probe. Default 400 ms — fast
   * enough to scan 254 subnet hosts in a couple of seconds with concurrency.
   */
  probeTimeoutMs?: number;
  /** Maximum parallel probes. Default 50. */
  concurrency?: number;
}
