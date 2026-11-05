import { createGuardedFetch, createAuditGuardedFetch } from './sources/guarded-fetch.js';
import { describe, it, expect } from 'vitest';
import { createDnsGuard, createAuditDnsGuard } from './sources/dns-guard.js';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';

const policy = createOutboundPolicy({ runtime: 'node', allowPrivateHosts: [], selfOrigins: [] });
describe('Node audit connection policy', () => {
  it('checks subsequent DNS resolutions and refuses a public name rebound to a private address', async () => {
    let calls = 0;
    const guard = createAuditDnsGuard(policy, {
      allowPrivate: false,
      resolver: async () => [{ address: calls++ === 0 ? '93.184.216.34' : '127.0.0.1', family: 4 }],
    });
    const target = guard.forTarget('archive.example.test', 443, 'https');
    await expect(target.resolve()).resolves.toMatchObject({
      addresses: [{ address: '93.184.216.34', family: 4 }],
    });
    await expect(target.resolve()).rejects.toMatchObject({ reason: 'blocked_address' });
  });
  it('refuses cleartext when a private hostname resolves to a public address', async () => {
    const guard = createAuditDnsGuard(policy, {
      allowPrivate: true,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    await expect(guard.forTarget('archive.local', 80, 'http').resolve()).rejects.toMatchObject({
      reason: 'scheme',
    });
  });
  it.each(['127.0.0.1', '10.0.0.1'])('allows an opted-in private address %s', async (address) => {
    const guard = createAuditDnsGuard(policy, {
      allowPrivate: true,
      resolver: async () => [{ address, family: 4 }],
    });
    await expect(
      guard.forTarget('archive.example.test', 80, 'http').resolve(),
    ).resolves.toMatchObject({ addresses: [{ address, family: 4 }] });
  });
  it.each(['169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1'])(
    'refuses %s even with private egress enabled',
    async (address) => {
      const guard = createAuditDnsGuard(policy, {
        allowPrivate: true,
        resolver: async () => [{ address, family: 4 }],
      });
      await expect(
        guard.forTarget('archive.example.test', 443, 'https').resolve(),
      ).rejects.toMatchObject({ reason: 'blocked_address' });
    },
  );
  it('checks every answer, including an IPv4-mapped IPv6 private answer', async () => {
    const guard = createAuditDnsGuard(policy, {
      allowPrivate: false,
      resolver: async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '::ffff:7f00:1', family: 6 },
      ],
    });
    await expect(
      guard.forTarget('archive.example.test', 443, 'https').resolve(),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
  });
});

it.each([
  '169.254.1.1',
  '169.254.170.2',
  '169.254.170.23',
  '[fe80::1]',
  '[febf::1]',
  '[fd00:ec2::23]',
  '[::ffff:169.254.170.2]',
  '[64:ff9b::a9fe:a9fe]',
])('denies sink address %s directly and through DNS, including mixed answers', async (host) => {
  const address = host.replace(/^\[|\]$/g, '');
  const family = address.includes(':') ? (6 as const) : (4 as const);
  for (const mixed of [false, true]) {
    const guard = createAuditDnsGuard(policy, {
      allowPrivate: true,
      resolver: async () => [
        ...(mixed ? [{ address: '93.184.216.34', family: 4 as const }] : []),
        { address, family },
      ],
    });
    await expect(
      guard.forTarget(mixed ? 'archive.example.test' : host, 443, 'https').resolve(),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
  }
});

it('checks later DNS connections for metadata even with private egress enabled', async () => {
  let count = 0;
  const guard = createAuditDnsGuard(policy, {
    allowPrivate: true,
    resolver: async () => [{ address: count++ === 0 ? '10.0.0.1' : '169.254.170.23', family: 4 }],
  });
  const target = guard.forTarget('archive.local', 80, 'http');
  await expect(target.resolve()).resolves.toBeDefined();
  await expect(target.resolve()).rejects.toMatchObject({ reason: 'blocked_address' });
});

it('allows bracketed IPv6 loopback only with private egress enabled', async () => {
  for (const allowPrivate of [false, true]) {
    const target = createAuditDnsGuard(policy, {
      allowPrivate,
      resolver: async (host) => {
        expect(host).toBe('::1');
        return [{ address: '::1', family: 6 }];
      },
    }).forTarget('[::1]', 80, 'http');
    if (allowPrivate)
      await expect(target.resolve()).resolves.toMatchObject({
        addresses: [{ address: '::1', family: 6 }],
      });
    else await expect(target.resolve()).rejects.toBeDefined();
  }
});

it('refuses http fetches before connecting unless audit private egress is enabled', async () => {
  const resolver = async () => [{ address: '127.0.0.1', family: 4 as const }];
  for (const fetch of [
    createGuardedFetch(policy, { resolver }),
    createAuditGuardedFetch(policy, { resolver }),
  ]) {
    await expect(fetch('http://127.0.0.1')).rejects.toMatchObject({ cause: { reason: 'scheme' } });
  }
});
it.each([
  ['archive.example.test', 443],
  ['archive.local', 80],
] as const)('keeps the source http guard for %s:%s', async (host, port) => {
  const guard = createDnsGuard(
    createOutboundPolicy({
      runtime: 'node',
      allowPrivateHosts: ['archive.local:80'],
      selfOrigins: [],
    }),
    { resolver: async () => [{ address: '93.184.216.34', family: 4 }] },
  );
  await expect(guard.forTarget(host, port, 'http').resolve()).rejects.toMatchObject({
    reason: 'scheme',
  });
});
