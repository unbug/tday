/**
 * High-level discovery orchestrator.
 *
 * Scans:
 *   1. localhost / 127.0.0.1
 *   2. Any extra hosts the caller provides (e.g. saved hosts from settings)
 *   3. Optionally the local /24 subnet (enabled by `scanSubnet: true`)
 *
 * All probes are run concurrently (up to `concurrency` at a time) so even a
 * full /24 scan (254 hosts × ~6 ports) completes in a few seconds.
 */

import { networkInterfaces } from 'node:os';
import type { DiscoveredService, DiscoveryOptions } from './types.js';
import { SPECS } from './specs.js';
import { probeService } from './probe.js';

/** Return the IPv4 addresses of all non-loopback LAN interfaces. */
export function localInterfaceAddresses(): string[] {
  const addrs: string[] = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    if (!ifaces) continue;
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addrs.push(iface.address);
      }
    }
  }
  return addrs;
}

/**
 * Enumerate all /24 host addresses for a given network interface IP.
 * E.g. "192.168.1.42" → ["192.168.1.1", ..., "192.168.1.254"] (excl. .0 / .255)
 */
export function subnetHosts(ifaceAddr: string): string[] {
  const parts = ifaceAddr.split('.');
  if (parts.length !== 4) return [];
  const prefix = parts.slice(0, 3).join('.');
  const hosts: string[] = [];
  for (let i = 1; i <= 254; i++) {
    hosts.push(`${prefix}.${i}`);
  }
  return hosts;
}

/**
 * Simple async concurrency limiter.
 * Runs `tasks` with at most `limit` in flight simultaneously.
 */
async function runConcurrent<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = [];
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Discover all local AI services.
 *
 * @param opts  Fine-tuning options (extra hosts, subnet scan, timeouts).
 * @returns     Deduplicated list of discovered services, ordered by latency.
 */
export async function discoverLocalServices(
  opts: DiscoveryOptions = {},
): Promise<DiscoveredService[]> {
  const {
    extraHosts = [],
    scanSubnet = false,
    probeTimeoutMs = 400,
    concurrency = 50,
  } = opts;

  // Collect all candidate hosts
  const hostsSet = new Set<string>(['127.0.0.1', 'localhost', '::1']);
  for (const h of extraHosts) if (h.trim()) hostsSet.add(h.trim());

  if (scanSubnet) {
    for (const ifAddr of localInterfaceAddresses()) {
      for (const h of subnetHosts(ifAddr)) hostsSet.add(h);
    }
  }

  const hosts = Array.from(hostsSet);

  // Build probe tasks: each host × each spec port
  const tasks: Array<() => Promise<DiscoveredService | null>> = [];
  for (const host of hosts) {
    for (const spec of SPECS) {
      for (const port of spec.ports) {
        tasks.push(() => probeService(host, port, spec, probeTimeoutMs));
      }
    }
  }

  const rawResults = await runConcurrent(tasks, concurrency);

  // Deduplicate by baseUrl (same service reachable via localhost AND 127.0.0.1)
  const seen = new Map<string, DiscoveredService>();
  for (const r of rawResults) {
    if (!r) continue;
    const existing = seen.get(r.baseUrl);
    if (!existing || r.latencyMs < existing.latencyMs) {
      seen.set(r.baseUrl, r);
    }
  }

  // Sort by latency ascending
  return Array.from(seen.values()).sort((a, b) => a.latencyMs - b.latencyMs);
}
