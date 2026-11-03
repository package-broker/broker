import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { Socket, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  notificationHeaders,
  type NotificationRequest,
} from '@package-broker/core/runtime/notification-jobs';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import type { ResolvedAddress } from '../sources/dns-guard.js';
import { createGuardedFetch } from '../sources/guarded-fetch.js';
import { createNodeNotificationTransport } from './transport.js';

const HOST = 'hooks.example.com';
const URL_TEXT = `https://${HOST}/in?token=SECRET`;
const BODY = new TextEncoder().encode('{"schemaVersion":1,"id":"x"}');

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const tlsIt = hasOpenssl ? it : process.env['CI'] ? it : it.skip;

let dir: string;
let key: string;
let cert: string;

beforeAll(() => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), 'notification-transport-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '2',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-subj',
      `/CN=${HOST}`,
      '-addext',
      `subjectAltName=DNS:${HOST}`,
    ],
    { stdio: 'ignore' },
  );
  key = readFileSync(join(dir, 'key.pem'), 'utf8');
  cert = readFileSync(join(dir, 'cert.pem'), 'utf8');
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.closeAllConnections?.();
          server.close(resolve);
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

async function request(over: Partial<NotificationRequest> = {}): Promise<NotificationRequest> {
  const method = over.method ?? 'POST';
  return {
    url: URL_TEXT,
    method,
    headers: [['X-Receiver-Token', 'SECRET-HEADER']],
    signed: await notificationHeaders({
      key: new Uint8Array(32).fill(1),
      timestamp: 1_767_225_600,
      deliveryId: '01JDELIVERY00000000000000A',
      eventId: '01JEVENT0000000000000000AB',
      method,
      body: BODY,
    }),
    body: BODY,
    signal: new AbortController().signal,
    ...over,
  };
}

/** Counts sockets that actually completed a TCP connection. */
function countConnections(): { readonly count: () => number } {
  let connected = 0;
  const original = Socket.prototype.connect;
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (
    this: Socket,
    ...args: unknown[]
  ) {
    this.once('connect', () => (connected += 1));
    return (original as (...a: unknown[]) => Socket).apply(this, args);
  });
  return { count: () => connected };
}

const answers = (...addresses: string[]): ResolvedAddress[] =>
  addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));

describe('Node notification transport (production guarded connector)', () => {
  it.each([
    ['a private answer', ['10.0.0.7']],
    ['loopback', ['127.0.0.1']],
    ['mixed public and private answers', ['93.184.216.34', '192.168.1.5']],
    ['an IPv4-mapped private answer', ['::ffff:10.0.0.1']],
    ['a NAT64 private answer', ['64:ff9b::a00:1']],
    ['a 6to4 private answer', ['2002:a00:1::1']],
    ['a link-local metadata answer', ['169.254.169.254']],
    ['a unique-local IPv6 answer', ['fd00::1']],
  ])('refuses %s without opening a connection', async (_, addresses) => {
    const sockets = countConnections();
    const resolver = vi.fn(async () => answers(...addresses));
    const transport = createNodeNotificationTransport({ selfOrigins: [], resolver });
    expect(await transport.send(await request())).toMatchObject({ kind: 'refused' });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(sockets.count()).toBe(0);
  });

  it('treats a failed or slow resolution as a network outcome within the connect budget', async () => {
    const failing = createNodeNotificationTransport({
      selfOrigins: [],
      resolver: async () => {
        throw new Error('SERVFAIL');
      },
    });
    expect((await failing.send(await request())).kind).toBe('network');
    const empty = createNodeNotificationTransport({ selfOrigins: [], resolver: async () => [] });
    expect((await empty.send(await request())).kind).toBe('network');
    const hanging = createNodeNotificationTransport({
      selfOrigins: [],
      resolver: () => new Promise<never>(() => undefined),
      timeoutMs: 60_000,
    });
    const started = Date.now();
    expect((await hanging.send(await request())).kind).toBe('network');
    expect(Date.now() - started).toBeLessThan(4500);
  });

  it('resolves again on every attempt, so a host that rebinds to a private address is refused', async () => {
    const resolver = vi
      .fn<(host: string) => Promise<readonly ResolvedAddress[]>>()
      .mockResolvedValueOnce(answers('10.1.1.1'))
      .mockResolvedValueOnce(answers('172.16.0.9'));
    const transport = createNodeNotificationTransport({ selfOrigins: [], resolver });
    expect(transport.allows(URL_TEXT)).toBe(true);
    expect(resolver).not.toHaveBeenCalled();
    expect((await transport.send(await request())).kind).toBe('refused');
    expect((await transport.send(await request())).kind).toBe('refused');
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('refuses self origins, direct IP literals and private names before resolving', async () => {
    const resolver = vi.fn(async () => answers('93.184.216.34'));
    const transport = createNodeNotificationTransport({
      selfOrigins: ['https://broker.example.org'],
      resolver,
    });
    for (const url of [
      'https://broker.example.org/hook',
      'https://93.184.216.34/hook',
      'https://[2606:2800:220:1::1]/hook',
      'https://intranet/hook',
      'https://printer.local/hook',
      'https://hooks..example.com/hook',
    ])
      expect((await transport.send(await request({ url }))).kind).toBe('refused');
    expect(resolver).not.toHaveBeenCalled();
  });

  it('has no private-host exception even for a host an operator allowlisted for sources', async () => {
    const sockets = countConnections();
    const resolver = vi.fn(async () => answers('127.0.0.1'));
    const sourcesPolicy = createOutboundPolicy({
      allowPrivateHosts: [HOST],
      runtime: 'node',
      selfOrigins: [],
    });
    expect(sourcesPolicy.allowPrivateHosts).toEqual([HOST]);
    const transport = createNodeNotificationTransport({ selfOrigins: [], resolver });
    expect((await transport.send(await request())).kind).toBe('refused');
    expect(sockets.count()).toBe(0);
  });
});

describe('Node notification transport (connector injected for a loopback receiver)', () => {
  function injected(port: number) {
    const guarded = createGuardedFetch(
      createOutboundPolicy({
        allowPrivateHosts: [`${HOST}:${port}`],
        runtime: 'node',
        selfOrigins: [],
      }),
      { tls: { ca: cert }, resolver: async () => answers('127.0.0.1') },
    );
    return createNodeNotificationTransport({
      selfOrigins: [],
      connector: (input, init) =>
        guarded(String(input).replace(`https://${HOST}/`, `https://${HOST}:${port}/`), init),
      timeoutMs: 2000,
    });
  }

  tlsIt('delivers a PUT with the exact body bytes and the signed headers', async () => {
    const received: { method?: string; body?: Buffer; headers?: Record<string, unknown> } = {};
    const server = createHttpsServer({ key, cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.method = req.method ?? '';
        received.body = Buffer.concat(chunks);
        received.headers = req.headers;
        res.writeHead(204).end();
      });
    });
    const port = await listen(server);
    const result = await injected(port).send(await request({ method: 'PUT' }));
    expect(result).toMatchObject({ kind: 'response', status: 204 });
    expect(received.method).toBe('PUT');
    expect([...received.body!]).toEqual([...BODY]);
    expect(received.headers).toMatchObject({
      'content-type': 'application/json',
      'x-receiver-token': 'SECRET-HEADER',
      'idempotency-key': '01JDELIVERY00000000000000A',
    });
    expect(received.headers?.['cookie']).toBeUndefined();
  });

  tlsIt('returns a redirect status without following it', async () => {
    let requests = 0;
    const server = createHttpsServer({ key, cert }, (_, res) => {
      requests += 1;
      res.writeHead(307, { location: `https://${HOST}/elsewhere` }).end('moved SECRET');
    });
    const port = await listen(server);
    const result = await injected(port).send(await request());
    expect(result).toMatchObject({ kind: 'response', status: 307 });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(requests).toBe(1);
  });

  tlsIt('closes the connection to a receiver whose body never ends', async () => {
    let closed: () => void = () => undefined;
    const socketClosed = new Promise<void>((resolve) => (closed = resolve));
    const server = createHttpsServer({ key, cert }, (req, res) => {
      res.writeHead(200);
      res.write('partial');
      req.socket.on('close', closed);
    });
    const port = await listen(server);
    const started = Date.now();
    expect((await injected(port).send(await request())).kind).toBe('response');
    await socketClosed;
    expect(Date.now() - started).toBeLessThan(2000);
  });

  tlsIt('times out a receiver that never sends headers', async () => {
    const server = createHttpsServer({ key, cert }, () => undefined);
    const port = await listen(server);
    const guarded = createGuardedFetch(
      createOutboundPolicy({
        allowPrivateHosts: [`${HOST}:${port}`],
        runtime: 'node',
        selfOrigins: [],
      }),
      { tls: { ca: cert }, resolver: async () => answers('127.0.0.1') },
    );
    const transport = createNodeNotificationTransport({
      selfOrigins: [],
      connector: (input, init) =>
        guarded(String(input).replace(`https://${HOST}/`, `https://${HOST}:${port}/`), init),
      timeoutMs: 100,
    });
    const started = Date.now();
    expect((await transport.send(await request())).kind).toBe('timeout');
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
