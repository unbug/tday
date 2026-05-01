/**
 * Unit tests for discovery/index.ts
 *
 * Tests the subnet enumeration and deduplication logic without real networking.
 */

import { describe, it, expect } from 'vitest';
import { subnetHosts, localInterfaceAddresses } from '../index.js';

describe('subnetHosts', () => {
  it('generates 254 hosts for a /24 subnet', () => {
    const hosts = subnetHosts('192.168.1.42');
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe('192.168.1.1');
    expect(hosts[253]).toBe('192.168.1.254');
  });

  it('excludes .0 and .255', () => {
    const hosts = subnetHosts('10.0.0.1');
    expect(hosts).not.toContain('10.0.0.0');
    expect(hosts).not.toContain('10.0.0.255');
  });

  it('returns [] for invalid IP', () => {
    expect(subnetHosts('not-an-ip')).toEqual([]);
    expect(subnetHosts('')).toEqual([]);
  });

  it('all hosts are in the same /24', () => {
    const hosts = subnetHosts('172.16.5.100');
    for (const h of hosts) {
      expect(h.startsWith('172.16.5.')).toBe(true);
    }
  });
});

describe('localInterfaceAddresses', () => {
  it('returns an array of strings', () => {
    const addrs = localInterfaceAddresses();
    expect(Array.isArray(addrs)).toBe(true);
    for (const a of addrs) {
      expect(typeof a).toBe('string');
    }
  });

  it('does not include loopback addresses', () => {
    const addrs = localInterfaceAddresses();
    expect(addrs).not.toContain('127.0.0.1');
    expect(addrs).not.toContain('::1');
  });
});
