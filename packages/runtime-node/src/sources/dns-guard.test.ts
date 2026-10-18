import type { LookupFunction } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import {
  createDnsGuard,
  DnsGuardError,
  type DnsGuardOptions,
  type ResolvedAddress,
} from './dns-guard.js';

const policy = (allowPrivateHosts: string[] = []) =>
  createOutboundPolicy({ allowPrivateHosts, runtime: 'node', selfOrigins: [] });

const v4 = (address: string): ResolvedAddress => ({ address, family: 4 });
const v6 = (address: string): ResolvedAddress => ({ address, family: 6 });

const HOST = 'registry.example.com';

type TestOptions = DnsGuardOptions & { port?: number };

const wrap = (pol: ReturnType<typeof policy>, options: TestOptions) => {
  const { port = 443, ...guardOptions } = options;
  const guard = createDnsGuard(pol, guardOptions);
  return {
    resolve: (host: string = HOST, hostPort: number = port) =>
      guard.forTarget(host, hostPort).resolve(),
    lookup: guard.forTarget(HOST, port).lookup,
    guard,
  };
};

const guardFor = (addresses: ResolvedAddress[], allow: string[] = [], extra: TestOptions = {}) =>
  wrap(policy(allow), { resolver: async () => addresses, ...extra });

describe('createDnsGuard', () => {
  it('refuses a host resolving to loopback', async () => {
    await expect(guardFor([v4('127.0.0.1')]).resolve(HOST)).rejects.toMatchObject({
      name: 'DnsGuardError',
      reason: 'blocked_address',
    });
  });

  it('returns the address for an allowlisted host', async () => {
    await expect(guardFor([v4('127.0.0.1')], [HOST]).resolve(HOST)).resolves.toEqual({
      host: HOST,
      addresses: [v4('127.0.0.1')],
    });
  });

  it('refuses the whole host when a later address is private', async () => {
    const guard = guardFor([v4('93.184.216.34'), v4('10.0.0.1')]);
    await expect(guard.resolve(HOST)).rejects.toBeInstanceOf(DnsGuardError);
  });

  describe('port-scoped allowlist', () => {
    it('host:port entries match only that port', async () => {
      const address = [v4('10.0.0.5')];
      await expect(guardFor(address, [`${HOST}:8080`]).resolve(HOST, 8080)).resolves.toBeDefined();
      await expect(guardFor(address, [`${HOST}:8080`]).resolve(HOST, 443)).rejects.toMatchObject({
        reason: 'blocked_address',
      });
      await expect(guardFor(address, [`${HOST}:8080`]).resolve(HOST, 9090)).rejects.toBeInstanceOf(
        DnsGuardError,
      );
    });

    it('a bare host entry admits port 443', async () => {
      const address = [v4('10.0.0.5')];
      await expect(guardFor(address, [HOST]).resolve(HOST, 443)).resolves.toBeDefined();
    });

    it('a bare host entry refuses port 80', async () => {
      await expect(guardFor([v4('10.0.0.5')], [HOST]).resolve(HOST, 80)).rejects.toMatchObject({
        reason: 'blocked_address',
      });
    });

    it('a bare host entry refuses other ports', async () => {
      await expect(guardFor([v4('10.0.0.5')], [HOST]).resolve(HOST, 8080)).rejects.toMatchObject({
        reason: 'blocked_address',
      });
    });

    it('uses the port given at creation and compares case-insensitively', async () => {
      const guard = guardFor([v4('10.0.0.5')], [`${HOST}:8080`], { port: 8080 });
      await expect(guard.resolve('Registry.Example.com')).resolves.toBeDefined();
    });

    it('matches bracketed IPv6 allowlist entries', async () => {
      const guard = guardFor([v6('::1')], ['[::1]:8080']);
      await expect(guard.resolve('::1', 8080)).resolves.toBeDefined();
      await expect(guard.resolve('::1', 443)).rejects.toBeInstanceOf(DnsGuardError);
    });
  });

  describe('scheme-scoped allowlist', () => {
    const target = (allow: string[], scheme: 'http' | 'https', port: number) =>
      createDnsGuard(policy(allow), { resolver: async () => [v4('10.0.0.5')] })
        .forTarget(HOST, port, scheme)
        .resolve();

    it('refuses http on port 443 under an explicit host:443 entry', async () => {
      await expect(target([`${HOST}:443`], 'http', 443)).rejects.toMatchObject({
        reason: 'scheme',
      });
    });

    it('allows https on port 443 under an explicit host:443 entry', async () => {
      await expect(target([`${HOST}:443`], 'https', 443)).resolves.toBeDefined();
    });

    it('refuses http on port 443 under a bare entry', async () => {
      await expect(target([HOST], 'http', 443)).rejects.toMatchObject({ reason: 'scheme' });
    });

    it('refuses http on port 80 under a bare entry', async () => {
      await expect(target([HOST], 'http', 80)).rejects.toMatchObject({
        reason: 'blocked_address',
      });
    });

    it('allows https on port 443 under a bare entry', async () => {
      await expect(target([HOST], 'https', 443)).resolves.toBeDefined();
    });

    it('allows http on port 80 under an explicit host:80 entry', async () => {
      await expect(target([`${HOST}:80`], 'http', 80)).resolves.toBeDefined();
    });

    it('refuses http on port 443 before any resolution', async () => {
      const resolver = vi.fn(async () => [v4('93.184.216.34')]);
      const guard = createDnsGuard(policy(), { resolver });
      await expect(guard.forTarget(HOST, 443, 'http').resolve()).rejects.toMatchObject({
        reason: 'scheme',
      });
      expect(resolver).not.toHaveBeenCalled();
    });

    it('refuses http on port 443 on the connect-time lookup too', async () => {
      const guard = createDnsGuard(policy([`${HOST}:443`]), {
        resolver: async () => [v4('10.0.0.5')],
      });
      const [error] = await new Promise<unknown[]>((resolve) => {
        guard.forTarget(HOST, 443, 'http').lookup(HOST, { all: true }, (...args) => resolve(args));
      });
      expect(error).toMatchObject({ name: 'DnsGuardError', reason: 'scheme' });
    });
  });

  describe('refused addresses', () => {
    const refused: Array<[string, ResolvedAddress]> = [
      ['0.0.0.0', v4('0.0.0.0')],
      ['::', v6('::')],
      ['169.254.169.254', v4('169.254.169.254')],
      ['169.254/16', v4('169.254.1.1')],
      ['fe80::/10', v6('fe80::1')],
      ['100.64/10', v4('100.64.0.1')],
      ['224/4', v4('224.0.0.1')],
      ['ff00::/8', v6('ff02::1')],
      ['64:ff9b::7f00:1', v6('64:ff9b::7f00:1')],
      ['2002:7f00:1::', v6('2002:7f00:1::')],
      ['fc00::/7', v6('fd12:3456::1')],
      ['10/8', v4('10.1.2.3')],
      ['mapped dotted', v6('::ffff:127.0.0.1')],
      ['mapped hex', v6('::ffff:7f00:1')],
      ['mapped upper case', v6('::FFFF:10.0.0.1')],
      ['mapped expanded', v6('0:0:0:0:0:ffff:7f00:1')],
      ['mapped expanded dotted', v6('0000:0000:0000:0000:0000:ffff:127.0.0.1')],
    ];
    for (const [label, address] of refused) {
      it(`refuses ${label}`, async () => {
        await expect(guardFor([address]).resolve(HOST)).rejects.toBeInstanceOf(DnsGuardError);
      });
    }

    const neverAllowed: Array<[string, ResolvedAddress]> = [
      ['0.0.0.0', v4('0.0.0.0')],
      ['0.1.2.3', v4('0.1.2.3')],
      ['::', v6('::')],
      ['224.0.0.1', v4('224.0.0.1')],
      ['ff02::1', v6('ff02::1')],
      ['169.254.169.254', v4('169.254.169.254')],
      ['fd00:ec2::254', v6('fd00:ec2::254')],
      ['mapped metadata', v6('::ffff:169.254.169.254')],
      ['zone id', v6('fe80::1%eth0')],
      ['169.254/16', v4('169.254.1.1')],
      ['fe80::/10', v6('fe80::1')],
      ['febf::1', v6('febf::1')],
      ['240/4', v4('240.0.0.1')],
      ['NAT64 zero net', v6('64:ff9b::1')],
      ['NAT64 metadata', v6('64:ff9b::a9fe:a9fe')],
      ['6to4 multicast', v6('2002:e000:1::')],
      ['6to4 link-local', v6('2002:a9fe:101::')],
      ['SIIT metadata', v6('::ffff:0:a9fe:a9fe')],
      ['IPv4-compatible metadata', v6('::a9fe:a9fe')],
    ];
    for (const [label, address] of neverAllowed) {
      it(`refuses ${label} even when the host is allowlisted`, async () => {
        await expect(guardFor([address], [HOST]).resolve(HOST)).rejects.toBeInstanceOf(
          DnsGuardError,
        );
      });
    }

    it('refuses zone ids and non-IP strings', async () => {
      await expect(guardFor([v6('fe80::1%eth0')]).resolve(HOST)).rejects.toMatchObject({
        reason: 'zone_id',
      });
      await expect(guardFor([v4('not-an-ip')]).resolve(HOST)).rejects.toBeInstanceOf(DnsGuardError);
    });

    it('never puts the address in the error message', async () => {
      const error = await guardFor([v4('10.1.2.3')])
        .resolve(HOST)
        .catch((e: unknown) => e);
      expect((error as Error).message).not.toContain('10.1.2.3');
      expect((error as Error).message).not.toContain('10.1');
    });
  });

  it('normalises mapped addresses that are public to IPv4', async () => {
    await expect(guardFor([v6('::ffff:5db8:d822')]).resolve(HOST)).resolves.toMatchObject({
      addresses: [v4('93.184.216.34')],
    });
  });

  it('canonicalises IPv6 hosts the same way for resolution and allowlisting', async () => {
    const seen: string[] = [];
    const guard = wrap(policy(['[::1]']), {
      resolver: async (host) => {
        seen.push(host);
        return [v6('::1')];
      },
    });
    for (const spelling of ['::1', '[::1]', '0:0:0:0:0:0:0:1', '[0000::0001]']) {
      await expect(guard.resolve(spelling)).resolves.toMatchObject({ host: '::1' });
    }
    expect(seen).toEqual(['::1', '::1', '::1', '::1']);
  });

  it('unmaps partially compressed and expanded mapped spellings', async () => {
    for (const spelling of [
      '0:0:0:0:0:ffff:808:808',
      '::ffff:808:808',
      '0::ffff:8.8.8.8',
      '0:0::ffff:808:808',
    ]) {
      await expect(guardFor([v6(spelling)]).resolve(HOST)).resolves.toMatchObject({
        addresses: [v4('8.8.8.8')],
      });
    }
  });

  it('allows an allowlisted private address embedded in no never-allowed range', async () => {
    await expect(guardFor([v4('10.0.0.5')], [HOST]).resolve()).resolves.toBeDefined();
    await expect(guardFor([v6('64:ff9b::a00:1')], [HOST]).resolve()).resolves.toBeDefined();
  });

  it('a target lookup refuses a different hostname', async () => {
    const guard = createDnsGuard(policy(), { resolver: async () => [v4('93.184.216.34')] });
    const target = guard.forTarget(HOST, 443);
    const [error] = await new Promise<unknown[]>((resolve) => {
      target.lookup('other.example.com', { all: true }, (...args) => resolve(args));
    });
    expect(error).toBeInstanceOf(DnsGuardError);
    const [ok] = await new Promise<unknown[]>((resolve) => {
      target.lookup('REGISTRY.example.com', { all: true }, (...args) => resolve(args));
    });
    expect(ok).toBeNull();
  });

  it('targets do not share a port or host', async () => {
    const guard = createDnsGuard(policy([`${HOST}:8080`]), {
      resolver: async () => [v4('10.0.0.5')],
    });
    await expect(guard.forTarget(HOST, 8080).resolve()).resolves.toBeDefined();
    await expect(guard.forTarget(HOST, 443).resolve()).rejects.toBeInstanceOf(DnsGuardError);
  });

  it('caps in-flight resolutions and fails fast when full', async () => {
    const never = () => new Promise<ResolvedAddress[]>(() => undefined);
    const guard = createDnsGuard(policy(), { resolver: never, timeoutMs: 30, maxInFlight: 2 });
    const first = guard.forTarget(HOST, 443).resolve();
    const second = guard.forTarget(HOST, 443).resolve();
    const started = Date.now();
    await expect(guard.forTarget(HOST, 443).resolve()).rejects.toMatchObject({
      reason: 'resolution_timeout',
    });
    expect(Date.now() - started).toBeLessThan(25);
    await expect(first).rejects.toMatchObject({ reason: 'resolution_timeout' });
    await expect(second).rejects.toMatchObject({ reason: 'resolution_timeout' });
  });

  it('releases a slot once the resolver settles', async () => {
    const guard = createDnsGuard(policy(), {
      resolver: async () => [v4('93.184.216.34')],
      maxInFlight: 1,
    });
    for (let i = 0; i < 3; i += 1) {
      await expect(guard.forTarget(HOST, 443).resolve()).resolves.toBeDefined();
    }
  });

  it('validates timeoutMs and maxInFlight', () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createDnsGuard(policy(), { timeoutMs })).toThrow(RangeError);
    }
    expect(() => createDnsGuard(policy(), { maxInFlight: 0 })).toThrow(RangeError);
  });

  it('lookup is assignable to the node:net LookupFunction', () => {
    const lookup: LookupFunction = guardFor([]).lookup;
    expect(typeof lookup).toBe('function');
  });

  it('passes the original host, trailing dot included, to the resolver', async () => {
    const seen: string[] = [];
    const guard = wrap(policy([HOST]), {
      resolver: async (host) => {
        seen.push(host);
        return [v4('10.0.0.5')];
      },
    });
    const result = await guard.resolve(`${HOST}.`);
    expect(seen).toEqual([`${HOST}.`]);
    expect(result.host).toBe(`${HOST}.`);
  });

  it('refuses an empty resolution and a resolver failure', async () => {
    await expect(guardFor([]).resolve(HOST)).rejects.toMatchObject({ reason: 'no_address' });
    const failing = wrap(policy(), {
      resolver: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    await expect(failing.resolve(HOST)).rejects.toMatchObject({ reason: 'resolution_failed' });
  });

  it('does not cache across calls', async () => {
    let calls = 0;
    const answers = [[v4('93.184.216.34')], [v4('127.0.0.1')]];
    const guard = wrap(policy(), { resolver: async () => answers[calls++] ?? [] });
    await expect(guard.resolve(HOST)).resolves.toBeDefined();
    await expect(guard.resolve(HOST)).rejects.toBeInstanceOf(DnsGuardError);
    expect(calls).toBe(2);
  });

  describe('timeout and abort', () => {
    const never = () => new Promise<ResolvedAddress[]>(() => undefined);

    it('rejects with resolution_timeout', async () => {
      const guard = wrap(policy(), { resolver: never, timeoutMs: 20 });
      await expect(guard.resolve(HOST)).rejects.toMatchObject({ reason: 'resolution_timeout' });
    });

    it('rejects when the signal aborts', async () => {
      const controller = new AbortController();
      const guard = wrap(policy(), { resolver: never, signal: controller.signal });
      const pending = guard.resolve(HOST);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ reason: 'aborted' });
    });

    it('rejects at once for an already aborted signal', async () => {
      const guard = wrap(policy(), {
        resolver: async () => [v4('93.184.216.34')],
        signal: AbortSignal.abort(),
      });
      await expect(guard.resolve(HOST)).rejects.toMatchObject({ reason: 'aborted' });
    });
  });

  describe('callback form', () => {
    const mixed = [v4('93.184.216.34'), v6('2606:2800:220:1:248:1893:25c8:1946')];
    const lookup = (guard: ReturnType<typeof guardFor>, options: object) =>
      new Promise<unknown[]>((resolve) => {
        guard.lookup(HOST, options, (...args) => resolve(args));
      });

    it('all:true returns the same list as the promise form', async () => {
      const guard = guardFor(mixed);
      const viaPromise = await guard.resolve(HOST);
      const [error, addresses] = await lookup(guard, { all: true });
      expect(error).toBeNull();
      expect(addresses).toEqual(viaPromise.addresses);
    });

    it('without all returns the first vetted address and family', async () => {
      expect(await lookup(guardFor(mixed), {})).toEqual([null, '93.184.216.34', 4]);
    });

    it('honours numeric and string family in both paths', async () => {
      const guard = guardFor(mixed);
      expect(await lookup(guard, { family: 6 })).toEqual([
        null,
        '2606:2800:220:1:248:1893:25c8:1946',
        6,
      ]);
      expect(await lookup(guard, { family: 'IPv4' })).toEqual([null, '93.184.216.34', 4]);
      expect(await lookup(guard, { family: 'IPv6', all: true })).toEqual([
        null,
        [v6('2606:2800:220:1:248:1893:25c8:1946')],
      ]);
      expect(await lookup(guard, { family: 4, all: true })).toEqual([null, [v4('93.184.216.34')]]);
    });

    it('errors when the family filter leaves nothing', async () => {
      const [error] = await lookup(guardFor([v4('93.184.216.34')]), { family: 6 });
      expect(error).toBeInstanceOf(DnsGuardError);
    });

    it('errors with no_address in all mode when the family filter leaves nothing', async () => {
      const [error, addresses] = await lookup(guardFor([v4('93.184.216.34')]), {
        family: 6,
        all: true,
      });
      expect(error).toMatchObject({ reason: 'no_address' });
      expect(addresses).toEqual([]);
    });

    it('vets every address before the family filter applies', async () => {
      const [error] = await lookup(guardFor([v4('93.184.216.34'), v6('::1')]), { family: 4 });
      expect(error).toBeInstanceOf(DnsGuardError);
    });

    it('passes the refusal as an error', async () => {
      const [error] = await lookup(guardFor([v4('127.0.0.1')]), { all: true });
      expect(error).toBeInstanceOf(DnsGuardError);
    });

    it('a throwing callback is not an unhandled rejection', async () => {
      const unhandled: unknown[] = [];
      const uncaught: unknown[] = [];
      const savedUncaught = process.listeners('uncaughtException');
      const savedRejection = process.listeners('unhandledRejection');
      process.removeAllListeners('uncaughtException');
      process.removeAllListeners('unhandledRejection');
      process.on('unhandledRejection', (reason) => unhandled.push(reason));
      process.on('uncaughtException', (error) => uncaught.push(error));
      try {
        guardFor([v4('93.184.216.34')]).lookup(HOST, { all: true }, () => {
          throw new Error('callback boom');
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        process.removeAllListeners('uncaughtException');
        process.removeAllListeners('unhandledRejection');
        for (const listener of savedUncaught) process.on('uncaughtException', listener);
        for (const listener of savedRejection) process.on('unhandledRejection', listener);
      }
      expect(unhandled).toEqual([]);
      expect(uncaught).toHaveLength(1);
    });
  });
});
