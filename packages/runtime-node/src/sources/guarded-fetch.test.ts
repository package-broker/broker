import { execFileSync, spawnSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { createPolicyFetch, UpstreamError } from '@package-broker/core/sources/policy-fetch';
import { createGuardedFetch } from './guarded-fetch.js';
import type { ResolvedAddress } from './dns-guard.js';

const policy = (allowPrivateHosts: string[] = []) =>
  createOutboundPolicy({ allowPrivateHosts, runtime: 'node', selfOrigins: [] });

const loopback: ResolvedAddress = { address: '127.0.0.1', family: 4 };
const HOST = 'registry.test';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const requireOpenssl = !hasOpenssl && Boolean(process.env['CI']);
const tlsIt = hasOpenssl
  ? it
  : requireOpenssl
    ? (name: string) =>
        it(name, () => {
          throw new Error('openssl is required on CI');
        })
    : it.skip;
if (!hasOpenssl && !requireOpenssl) console.warn('openssl not found: TLS tests are skipped');

let dir: string;
let key: string;
let cert: string;

beforeAll(() => {
  if (!hasOpenssl) return;
  dir = mkdtempSync(join(tmpdir(), 'guarded-fetch-'));
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
      `subjectAltName=DNS:${HOST},IP:127.0.0.1`,
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
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise((r) => {
          (s as Server).closeAllConnections?.();
          s.close(r);
        }),
    ),
  );
});

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return (server.address() as AddressInfo).port;
}

describe('createGuardedFetch', () => {
  it('never opens a socket to a host resolving to a private address', async () => {
    let connections = 0;
    const server = createHttpServer((_, res) => res.end('x'));
    server.on('connection', () => (connections += 1));
    const port = await listen(server);
    let lookups = 0;
    const guarded = createGuardedFetch(policy(), {
      resolver: async () => {
        lookups += 1;
        return [loopback];
      },
    });
    const error = await guarded(`http://${HOST}:${port}/`).catch((e: unknown) => e);
    expect(lookups).toBe(1);
    expect(connections).toBe(0);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).cause).toMatchObject({
      name: 'DnsGuardError',
      reason: 'blocked_address',
    });
  });

  it('never opens a socket to a private IP literal', async () => {
    let connections = 0;
    const server = createHttpServer((_, res) => res.end('x'));
    server.on('connection', () => (connections += 1));
    const port = await listen(server);
    const guarded = createGuardedFetch(policy(), {
      resolver: async (h) => [{ address: h, family: 4 }],
    });
    await expect(guarded(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({
      cause: { name: 'DnsGuardError' },
    });
    expect(connections).toBe(0);
  });

  it('connects to the vetted address and streams the body without following redirects', async () => {
    const server = createHttpServer((req, res) => {
      if (req.url === '/moved') {
        res.writeHead(302, { location: '/elsewhere' }).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain', 'x-host': req.headers.host ?? '' });
      res.end('hello');
    });
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    const ok = await guarded(`http://${HOST}:${port}/`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-host')).toBe(`${HOST}:${port}`);
    expect(await ok.text()).toBe('hello');
    const moved = await guarded(`http://${HOST}:${port}/moved`, { redirect: 'manual' });
    expect(moved.status).toBe(302);
    expect(moved.headers.get('location')).toBe('/elsewhere');
  });

  it('decodes gzip bodies', async () => {
    const server = createHttpServer((_, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip' }).end(gzipSync('zipped'));
    });
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    const response = await guarded(`http://${HOST}:${port}/`);
    expect(await response.text()).toBe('zipped');
    expect(response.headers.get('content-encoding')).toBeNull();
  });

  tlsIt('sends the original host as the TLS servername and validates against it', async () => {
    let servername: string | undefined;
    const server = createHttpsServer(
      {
        key,
        cert,
        SNICallback: (name, cb) => {
          servername = name;
          cb(null);
        },
      },
      (_, res) => res.end('secure'),
    );
    const port = await listen(server as unknown as Server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
      tls: { ca: cert },
    });
    const response = await guarded(`https://${HOST}:${port}/`);
    expect(await response.text()).toBe('secure');
    expect(servername).toBe(HOST);
  });

  tlsIt('rejects a certificate that does not match the original host', async () => {
    const server = createHttpsServer({ key, cert }, (_, res) => res.end('secure'));
    const port = await listen(server as unknown as Server);
    const guarded = createGuardedFetch(policy([`other.test:${port}`]), {
      resolver: async () => [loopback],
      tls: { ca: cert },
    });
    await expect(guarded(`https://other.test:${port}/`)).rejects.toBeInstanceOf(TypeError);
  });

  it('destroys the socket and errors the body stream when aborted mid-body', async () => {
    let closed: () => void = () => undefined;
    const socketClosed = new Promise<void>((r) => (closed = r));
    const server = createHttpServer((req, res) => {
      res.writeHead(200);
      res.write('partial');
      req.socket.on('close', closed);
    });
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    const controller = new AbortController();
    const response = await guarded(`http://${HOST}:${port}/`, { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toBeDefined();
    await socketClosed;
  });

  it('rejects before connecting when the signal is already aborted', async () => {
    let connections = 0;
    const server = createHttpServer((_, res) => res.end());
    server.on('connection', () => (connections += 1));
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    await expect(
      guarded(`http://${HOST}:${port}/`, { signal: AbortSignal.abort() }),
    ).rejects.toBeDefined();
    expect(connections).toBe(0);
  });

  it('refuses a rebind to a private address on a redirect hop and never connects', async () => {
    let connections = 0;
    const first = createHttpServer((_, res) => {
      res.writeHead(302, { location: 'https://rebind.test/' }).end();
    });
    first.on('connection', () => (connections += 1));
    const port = await listen(first);
    const seen: string[] = [];
    const pol = policy([`${HOST}:${port}`]);
    const guarded = createGuardedFetch(pol, {
      resolver: async (host) => {
        seen.push(host);
        return host === HOST ? [loopback] : [{ address: '10.0.0.1', family: 4 }];
      },
    });
    const fetcher = createPolicyFetch({ fetchImpl: guarded, policy: pol, userAgent: 'test' });
    const error = await fetcher({
      url: `http://${HOST}:${port}/`,
      method: 'GET',
      timeoutMs: 2000,
      purpose: 'metadata',
      maxBytes: 100,
    }).catch((e: unknown) => e);
    expect(seen).toEqual([HOST, 'rebind.test']);
    expect(error).toMatchObject({ code: 'refused', reason: 'blocked_address' });
    expect(connections).toBe(1);
  });

  it.each(['http://[::1]:%PORT%/', 'http://[::ffff:127.0.0.1]:%PORT%/'])(
    'refuses the IPv6 literal %s without connecting',
    async (template) => {
      let connections = 0;
      const server = createHttpServer((_, res) => res.end());
      server.on('connection', () => (connections += 1));
      const port = await listen(server);
      const guarded = createGuardedFetch(policy(), {
        resolver: async (h) => [{ address: h, family: h.includes(':') ? 6 : 4 }],
      });
      await expect(guarded(template.replace('%PORT%', String(port)))).rejects.toMatchObject({
        cause: { name: 'DnsGuardError', reason: 'blocked_address' },
      });
      expect(connections).toBe(0);
    },
  );

  tlsIt('connects over HTTPS to an allowlisted IP literal validating the IP SAN', async () => {
    const server = createHttpsServer({ key, cert }, (_, res) => res.end('literal'));
    const port = await listen(server as unknown as Server);
    const guarded = createGuardedFetch(policy([`127.0.0.1:${port}`]), {
      resolver: async (h) => [{ address: h, family: 4 }],
      tls: { ca: cert },
    });
    expect(await (await guarded(`https://127.0.0.1:${port}/`)).text()).toBe('literal');
  });

  it('refuses HTTPS to a private IP literal', async () => {
    const guarded = createGuardedFetch(policy(), {
      resolver: async (h) => [{ address: h, family: 4 }],
    });
    await expect(guarded('https://127.0.0.1:9/')).rejects.toMatchObject({
      cause: { name: 'DnsGuardError' },
    });
  });

  it('returns the abort listener count to baseline on the literal path', async () => {
    const server = createHttpServer((_, res) => res.end('ok'));
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`127.0.0.1:${port}`]), {
      resolver: async (h) => [{ address: h, family: 4 }],
    });
    const controller = new AbortController();
    const baseline = getEventListeners(controller.signal, 'abort').length;
    await (await guarded(`http://127.0.0.1:${port}/`, { signal: controller.signal })).text();
    await new Promise((r) => setTimeout(r, 20));
    expect(getEventListeners(controller.signal, 'abort').length).toBe(baseline);
  });

  it('vets each lookup: the same host rebinding to a private address on another port is refused', async () => {
    let connections = 0;
    const server = createHttpServer((_, res) => res.end('ok'));
    server.on('connection', () => (connections += 1));
    const port = await listen(server);
    let calls = 0;
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => (calls++ === 0 ? [loopback] : [{ address: '10.0.0.1', family: 4 }]),
    });
    expect(await (await guarded(`http://${HOST}:${port}/`)).text()).toBe('ok');
    expect(connections).toBe(1);
    await expect(guarded(`http://${HOST}:${port + 1}/`)).rejects.toMatchObject({
      cause: { name: 'DnsGuardError', reason: 'blocked_address' },
    });
    expect(calls).toBe(2);
    expect(connections).toBe(1);
  });

  it('does not connect when aborted while the resolution is pending', async () => {
    let connections = 0;
    const server = createHttpServer((_, res) => res.end());
    server.on('connection', () => (connections += 1));
    const port = await listen(server);
    let release: (value: ResolvedAddress[]) => void = () => undefined;
    const pending = new Promise<ResolvedAddress[]>((r) => (release = r));
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), { resolver: () => pending });
    const controller = new AbortController();
    const request = guarded(`http://${HOST}:${port}/`, { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    await expect(request).rejects.toBeDefined();
    release([loopback]);
    await new Promise((r) => setTimeout(r, 50));
    expect(connections).toBe(0);
  });

  it('survives and rejects a response with a status outside 200..599', async () => {
    const server = createNetServer((socket) => {
      socket.on('data', () => socket.end('HTTP/1.1 600 Nope\r\nContent-Length: 0\r\n\r\n'));
    });
    servers.push(server as unknown as Server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    await expect(guarded(`http://${HOST}:${port}/`)).rejects.toBeInstanceOf(TypeError);
  });

  it('rejects an HTTP 101 upgrade and destroys the socket', async () => {
    let closed: () => void = () => undefined;
    const socketClosed = new Promise<void>((r) => (closed = r));
    const server = createNetServer((socket) => {
      socket.on('close', closed);
      socket.on('data', () =>
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: x\r\nConnection: Upgrade\r\n\r\n',
        ),
      );
    });
    servers.push(server as unknown as Server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    await expect(guarded(`http://${HOST}:${port}/`)).rejects.toBeInstanceOf(TypeError);
    await socketClosed;
  });

  it('closes the server socket when a gzip body is cancelled', async () => {
    let closed: () => void = () => undefined;
    const socketClosed = new Promise<void>((r) => (closed = r));
    const server = createHttpServer((req, res) => {
      req.socket.on('close', closed);
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.write(gzipSync('x'.repeat(1000)).subarray(0, 10));
    });
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    const response = await guarded(`http://${HOST}:${port}/`);
    await response.body!.cancel();
    await socketClosed;
  });

  it('errors the stream and closes the socket on corrupt gzip', async () => {
    let closed: () => void = () => undefined;
    const socketClosed = new Promise<void>((r) => (closed = r));
    const server = createHttpServer((req, res) => {
      req.socket.on('close', closed);
      res.writeHead(200, { 'content-encoding': 'gzip' });
      res.write('this is not gzip at all');
    });
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    const response = await guarded(`http://${HOST}:${port}/`);
    await expect(response.text()).rejects.toBeDefined();
    await socketClosed;
  });

  it('returns a null body for HEAD and 204', async () => {
    const server = createHttpServer((req, res) => {
      res.writeHead(req.method === 'HEAD' ? 200 : 204, { 'content-length': '0' }).end();
    });
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    expect((await guarded(`http://${HOST}:${port}/`, { method: 'HEAD' })).body).toBeNull();
    expect((await guarded(`http://${HOST}:${port}/`)).body).toBeNull();
  });

  it('returns abort listener count to baseline with a long-lived signal', async () => {
    const server = createHttpServer((_, res) => res.end('ok'));
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    const controller = new AbortController();
    const baseline = getEventListeners(controller.signal, 'abort').length;
    for (let i = 0; i < 3; i++) {
      await (await guarded(`http://${HOST}:${port}/`, { signal: controller.signal })).text();
    }
    await new Promise((r) => setTimeout(r, 20));
    expect(getEventListeners(controller.signal, 'abort').length).toBe(baseline);
  });

  it('sends bodies from strings, bytes, buffers and URLSearchParams and refuses others', async () => {
    const received: { type: string | undefined; body: string }[] = [];
    const server = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          type: req.headers['content-type'],
          body: Buffer.concat(chunks).toString(),
        });
        res.end();
      });
    });
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    const url = `http://${HOST}:${port}/`;
    await guarded(url, { method: 'POST', body: 'text' });
    await guarded(url, { method: 'POST', body: new TextEncoder().encode('bytes') });
    await guarded(url, { method: 'POST', body: new TextEncoder().encode('buf').buffer });
    await guarded(url, { method: 'POST', body: new URLSearchParams({ a: 'b' }) });
    expect(received.map((r) => r.body)).toEqual(['text', 'bytes', 'buf', 'a=b']);
    expect(received[0]?.type).toBe('text/plain;charset=UTF-8');
    expect(received[3]?.type).toBe('application/x-www-form-urlencoded;charset=UTF-8');
    await expect(guarded(url, { method: 'POST', body: new Blob(['x']) })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('forces the host header, hides the URL in errors and refuses redirect follow', async () => {
    const server = createHttpServer((req, res) => res.end(req.headers.host ?? ''));
    const port = await listen(server);
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    const response = await guarded(`http://${HOST}:${port}/`, { headers: { host: 'evil.test' } });
    expect(await response.text()).toBe(`${HOST}:${port}`);
    const bad = await guarded('http://user:secret@[bad/').catch((e: unknown) => e);
    expect(String((bad as Error).message)).not.toContain('secret');
    expect(JSON.stringify(bad, Object.getOwnPropertyNames(bad))).not.toContain('secret');
    await expect(guarded(`http://${HOST}:${port}/`, { redirect: 'follow' })).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it('exposes only a sanitised code as the transport cause', async () => {
    const port = await new Promise<number>((r) => {
      const s = createNetServer();
      s.listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => r(p));
      });
    });
    const guarded = createGuardedFetch(policy([`${HOST}:${port}`]), {
      resolver: async () => [loopback],
    });
    const error = (await guarded(`http://${HOST}:${port}/`).catch((e: unknown) => e)) as TypeError;
    expect(error.cause).toMatchObject({ name: 'TransportError', code: 'ECONNREFUSED' });
    expect(JSON.stringify(error.cause, Object.getOwnPropertyNames(error.cause))).not.toContain(
      '127.0.0.1',
    );
  });
});

describe('policy fetch DnsGuardError mapping', () => {
  const fetchFailing = (reason: string) => async (): Promise<Response> => {
    throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('x'), { name: 'DnsGuardError', reason }),
    });
  };
  const run = (reason: string): Promise<UpstreamError> =>
    createPolicyFetch({ fetchImpl: fetchFailing(reason), policy: policy(), userAgent: 'test' })({
      url: 'https://registry.test/',
      method: 'GET',
      timeoutMs: 2000,
      purpose: 'metadata',
      maxBytes: 100,
    }).then(
      () => {
        throw new Error('expected failure');
      },
      (e: unknown) => e as UpstreamError,
    );

  it.each(['blocked_address', 'blocked_host', 'zone_id', 'invalid_address', 'self_origin'])(
    'maps %s to refused',
    async (reason) => {
      expect(await run(reason)).toMatchObject({ code: 'refused', reason });
    },
  );

  it('maps resolution_timeout to timeout', async () => {
    expect(await run('resolution_timeout')).toMatchObject({ code: 'timeout' });
  });

  it.each(['resolution_failed', 'no_address', 'aborted', 'mystery <secret>'])(
    'maps %s to network without echoing it',
    async (reason) => {
      const error = await run(reason);
      expect(error).toMatchObject({ code: 'network' });
      expect(error.message).not.toContain('secret');
    },
  );

  it('maps a real guarded refusal to refused', async () => {
    const guarded = createGuardedFetch(policy(), { resolver: async () => [loopback] });
    const error = await createPolicyFetch({
      fetchImpl: guarded,
      policy: policy(),
      userAgent: 'test',
    })({
      url: 'https://registry.test/',
      method: 'GET',
      timeoutMs: 2000,
      purpose: 'metadata',
      maxBytes: 100,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'refused' });
  });
});
