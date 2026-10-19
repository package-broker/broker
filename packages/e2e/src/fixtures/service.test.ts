import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256, tarGzip, zip } from './archives.js';
import {
  buildCorpus,
  composerCorpus,
  coreCorpus,
  gitRecording,
  ownCorpus,
  packet,
} from './corpus.js';
import { createFixtureApp, modes, startFixtureService } from './service.js';

type Service = Awaited<ReturnType<typeof startFixtureService>>;
const running: Service[] = [];
async function startHttp(options: Parameters<typeof startFixtureService>[0] = {}) {
  const service = await startFixtureService(options);
  running.push(service);
  return service;
}

type ProtocolService = Pick<Service, 'origin' | 'controlSecret' | 'webhookSecret'> & {
  app?: ReturnType<typeof createFixtureApp>['app'];
};

async function call(
  service: ProtocolService,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
    control?: boolean;
  } = {},
) {
  if (service.app) {
    const response = await service.app.request(service.origin + path, {
      method: options.method ?? 'GET',
      headers: {
        ...(options.control ? { authorization: 'Bearer ' + service.controlSecret } : {}),
        ...options.headers,
      },
      ...(options.body === undefined
        ? {}
        : { body: typeof options.body === 'string' ? options.body : new Uint8Array(options.body) }),
    });
    const body = Buffer.from(await response.arrayBuffer());
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body,
      text: body.toString(),
    };
  }
  return new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: Buffer;
    text: string;
  }>((resolve, reject) => {
    const client = request(
      service.origin + path,
      {
        method: options.method ?? 'GET',
        headers: {
          ...(options.control ? { authorization: 'Bearer ' + service.controlSecret } : {}),
          ...options.headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: response.statusCode!,
            headers: response.headers,
            body,
            text: body.toString(),
          });
        });
      },
    );
    client.on('error', reject);
    client.end(options.body);
  });
}

const control = (service: ProtocolService, mode: string) =>
  call(service, '/_control/mode', {
    method: 'POST',
    control: true,
    body: JSON.stringify({ mode }),
  });
const hash = (algorithm: string, body: Buffer) => createHash(algorithm).update(body).digest('hex');

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('OutboundFetchForbidden');
    }),
  );
});
afterEach(async () => {
  await Promise.all(running.splice(0).map((service) => service.close()));
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('deterministic corpus', () => {
  it('rebuilds every byte and sha256 twice and checks the committed provenance manifest', () => {
    const first = buildCorpus();
    const second = buildCorpus();
    const manifest = JSON.parse(readFileSync(new URL('checksums.json', ownCorpus), 'utf8')) as {
      inputs: Record<string, string>;
      generated: Record<string, string>;
      reused: Record<string, string>;
    };
    expect(Object.fromEntries([...first].map(([name, bytes]) => [name, sha256(bytes)]))).toEqual(
      manifest.generated,
    );
    for (const [name, bytes] of first) expect(sha256(second.get(name)!)).toBe(sha256(bytes));
    for (const [path, digest] of Object.entries(manifest.reused))
      expect(sha256(readFileSync(new URL(path, coreCorpus)))).toBe(digest);
    for (const [path, digest] of Object.entries(manifest.inputs))
      expect(sha256(readFileSync(new URL(path, ownCorpus)))).toBe(digest);
    expect(Object.keys(manifest.reused).length).toBe(composerCorpus().size + 3);
  });

  it('fixes entry order, zip DOS time, tar mtime/owners and gzip mtime/OS', () => {
    const entries = [
      { name: 'b', body: Buffer.from('b') },
      { name: 'a', body: Buffer.from('a') },
    ];
    expect(zip(entries)).toEqual(zip([...entries].reverse()));
    expect(tarGzip(entries)).toEqual(tarGzip([...entries].reverse()));
    const archive = zip(entries);
    expect(archive.readUInt16LE(10)).toBe(0);
    expect(archive.readUInt16LE(12)).toBe(0x21);
    const gzip = tarGzip(entries);
    expect([...gzip.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(gzip[9]).toBe(3);
    const tar = gunzipSync(gzip);
    expect(tar.subarray(0, 1).toString()).toBe('a');
    for (const offset of [108, 116, 136])
      expect(parseInt(tar.subarray(offset, offset + 7).toString(), 8)).toBe(0);
  });
});

describe('loopback binding', () => {
  it('binds exclusively to IPv4 loopback with an independent secret per run', async () => {
    const first = await startHttp();
    const second = await startHttp();
    expect(first.address.address).toBe('127.0.0.1');
    expect(first.address.family).toBe('IPv4');
    expect(first.controlSecret).not.toBe(second.controlSecret);
    expect(first.controlSecret).not.toBe(first.webhookSecret);
    expect(
      (
        await call(first, '/_control/requests', {
          headers: { authorization: 'Bearer ' + second.controlSecret },
        })
      ).status,
    ).toBe(401);
    expect((await call(first, '/fixture-lib')).status).toBe(200);
  });
});

describe.each(['HTTP', 'Hono app'] as const)('fixture protocol contracts (%s)', (transport) => {
  const start =
    transport === 'HTTP'
      ? startHttp
      : async (options: Parameters<typeof startFixtureService>[0] = {}) =>
          createFixtureApp('http://127.0.0.1:12345', options);
  it('serves Packagist v2 metadata and a ZIP matching its advertised digest', async () => {
    const service = await start();
    const result = await call(service, '/p2/fx/lib.json');
    const metadata = JSON.parse(result.text).packages['fx/lib'][0];
    const archive = await call(service, new URL(metadata.dist.url).pathname);
    expect(result.status).toBe(200);
    expect(archive.status).toBe(200);
    expect(archive.headers['content-type']).toBe('application/zip');
    expect(hash('sha1', archive.body)).toBe(metadata.dist.shasum);
    expect(archive.body).toEqual(buildCorpus().get('lib.zip'));
    expect((await call(service, '/p2/other/lib.json')).status).toBe(404);
  });

  it('rebases the existing Composer v1 provider graph and verifies each hash and dist', async () => {
    const service = await start();
    const root = JSON.parse((await call(service, '/packages.json')).text);
    const [includePath, includeInfo] = Object.entries(root['provider-includes'])[0]! as [
      string,
      { sha256: string },
    ];
    const include = await call(service, '/' + includePath.replace('%hash%', includeInfo.sha256));
    expect(sha256(include.body)).toBe(includeInfo.sha256);
    for (const [name, info] of Object.entries(JSON.parse(include.text).providers) as [
      string,
      { sha256: string },
    ][]) {
      const provider = await call(
        service,
        new URL(root['providers-url'].replace('%package%', name).replace('%hash%', info.sha256))
          .pathname,
      );
      expect(sha256(provider.body)).toBe(info.sha256);
      for (const metadata of Object.values(JSON.parse(provider.text).packages[name]) as {
        dist?: { url: string; shasum: string };
      }[]) {
        if (!metadata.dist) continue;
        const archive = await call(service, new URL(metadata.dist.url).pathname);
        expect(archive.status).toBe(200);
        expect(hash('sha1', archive.body)).toBe(metadata.dist.shasum);
      }
    }
  });

  it('serves every checked-in Composer v1 response byte-for-byte without copying the corpus', async () => {
    const service = await start();
    for (const [path, bytes] of composerCorpus()) {
      const response = await call(service, path);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(bytes);
    }
    expect((await call(service, '/composer-v1/missing')).status).toBe(404);
    expect((await call(service, '/p/missing')).status).toBe(404);
  });

  it('serves npm metadata and the deterministic tarball with SHA-1 and SRI', async () => {
    const service = await start();
    const response = await call(service, '/fixture-lib');
    const dist = JSON.parse(response.text).versions['1.0.0'].dist;
    const archive = await call(service, new URL(dist.tarball).pathname);
    expect(hash('sha1', archive.body)).toBe(dist.shasum);
    expect('sha512-' + createHash('sha512').update(archive.body).digest('base64')).toBe(
      dist.integrity,
    );
    const tar = gunzipSync(archive.body);
    expect(tar.subarray(0, 20).toString()).toBe('package/package.json');
    expect(
      JSON.parse(
        tar
          .subarray(512, 512 + parseInt(tar.subarray(124, 135).toString(), 8))
          .toString()
          .replace(/\0+$/, ''),
      ),
    ).toEqual({ name: 'fixture-lib', version: '1.0.0' });
  });

  it('advertises Git v2 and replays both local git-http-backend recordings exactly', async () => {
    const service = await start();
    const headers = {
      'git-protocol': 'version=2',
      'content-type': 'application/x-git-upload-pack-request',
    };
    const advertisement = await call(service, '/git/lib.git/info/refs?service=git-upload-pack', {
      headers,
    });
    expect(advertisement.body).toEqual(
      Buffer.concat([
        packet('version 2\n'),
        packet('ls-refs\n'),
        packet('fetch=shallow\n'),
        Buffer.from('0000'),
      ]),
    );
    expect(advertisement.headers['content-type']).toBe(
      'application/x-git-upload-pack-advertisement',
    );
    const refs = await call(service, '/git/lib.git/git-upload-pack', {
      method: 'POST',
      headers,
      body: Buffer.concat([packet('command=ls-refs\n'), Buffer.from('00010000')]),
    });
    expect(refs.body).toEqual(
      Buffer.concat([
        ...gitRecording().call.refs.map((ref) => packet(`${ref.oid} ${ref.name}\n`)),
        Buffer.from('0000'),
      ]),
    );
    for (const filtered of [false, true]) {
      for (const exchange of gitRecording(filtered).exchanges) {
        const result = await call(service, '/git/lib.git/git-upload-pack', {
          method: 'POST',
          headers,
          body: Buffer.from(exchange.request.bodyBase64, 'base64'),
        });
        expect(result.status).toBe(exchange.response.status);
        expect(result.body).toEqual(Buffer.from(exchange.response.bodyBase64, 'base64'));
        expect(result.headers['content-type']).toBe(exchange.response.headers['content-type']);
      }
    }
    expect((await call(service, '/git/lib.git/info/refs')).status).toBe(400);
    expect(
      (
        await call(service, '/git/lib.git/git-upload-pack', {
          method: 'POST',
          headers,
          body: 'invalid',
        })
      ).status,
    ).toBe(400);
    expect((await call(service, '/git/lib.git/git-upload-pack', { method: 'POST' })).status).toBe(
      400,
    );
  });

  it.each([
    'zip-bomb.zip',
    'tar-traversal.tgz',
    'symlink-escape.tgz',
    'oversized-manifest.json',
    'oversized-manifest.zip',
    'delta.pack',
    'delta-upload-pack.bin',
    'digest-mismatch.zip',
  ])('serves the pinned hostile bytes for %s', async (name) => {
    const service = await start();
    const response = await call(service, '/hostile/' + name);
    const expected = JSON.parse(readFileSync(new URL('checksums.json', ownCorpus), 'utf8'))
      .generated[name];
    expect(response.status).toBe(200);
    expect(sha256(response.body)).toBe(expected);
    expect(response.body.equals(buildCorpus().get(name)!)).toBe(true);
  });

  it('checks the documented hostile payload structure independently of its builder', () => {
    const corpus = buildCorpus();
    const bomb = corpus.get('zip-bomb.zip')!;
    const start = 30 + bomb.readUInt16LE(26);
    const compressed = bomb.subarray(start, start + bomb.readUInt32LE(18));
    const inflated = inflateRawSync(compressed);
    expect(inflated.length).toBe(8 * 1024 * 1024);
    expect(inflated.every((byte) => byte === 65)).toBe(true);
    expect(bomb.readUInt32LE(22) / compressed.length).toBeGreaterThan(1000);
    expect(gunzipSync(corpus.get('tar-traversal.tgz')!).subarray(0, 13).toString()).toBe(
      '../escape.txt',
    );
    const symlink = gunzipSync(corpus.get('symlink-escape.tgz')!);
    expect(symlink[156]).toBe(50);
    expect(symlink.subarray(157, 170).toString()).toBe('../../outside');
    expect(symlink.subarray(512, 539).toString()).toBe('package/escape/payload.txt\0');
    expect(corpus.get('oversized-manifest.json')!.length).toBeGreaterThan(1024 * 1024);
    expect(JSON.parse(corpus.get('oversized-manifest.json')!.toString()).padding.length).toBe(
      1024 * 1024,
    );
    expect(corpus.get('delta.pack')!.subarray(0, 4).toString()).toBe('PACK');
    expect(corpus.get('delta.pack')).toEqual(
      readFileSync(new URL('src/sources/git/__fixtures__/ofs-delta.pack', coreCorpus)),
    );
  });

  it('authenticates every control route and keeps controls working during every mode', async () => {
    const service = await start({ brokerOrigin: 'http://127.0.0.1:43210' });
    for (const [path, method] of [
      ['mode', 'POST'],
      ['requests', 'GET'],
      ['reset', 'POST'],
      ['webhook', 'POST'],
    ] as const) {
      expect((await call(service, '/_control/' + path, { method })).status).toBe(401);
    }
    for (const mode of modes) {
      expect((await control(service, mode)).status).toBe(200);
      expect((await call(service, '/_control/requests', { control: true })).status).toBe(200);
      const upstream = await call(service, '/fixture-lib/-/fixture-lib-1.0.0.tgz');
      expect(upstream.status).toBe(
        mode === 'outage' ? 503 : mode.startsWith('redirect-') ? 302 : 200,
      );
      if (mode === 'redirect-private')
        expect(upstream.headers.location).toBe('http://10.0.0.1/fixture');
      if (mode === 'redirect-broker')
        expect(upstream.headers.location).toBe('http://127.0.0.1:43210');
      if (mode === 'digest-mismatch')
        expect(upstream.body).toEqual(buildCorpus().get('digest-mismatch.zip'));
    }
    expect((await control(service, 'normal')).status).toBe(200);
    expect((await call(service, '/fixture-lib')).status).toBe(200);
    expect((await control(service, 'unknown')).status).toBe(400);
    expect(
      (await call(service, '/_control/mode', { method: 'POST', control: true, body: '{' })).status,
    ).toBe(400);
    expect((await control(await start(), 'redirect-broker')).status).toBe(400);
  });

  it('returns a digest-mismatching dist through Composer v1 and v2 without changing metadata', async () => {
    const service = await start();
    const metadata = JSON.parse((await call(service, '/p2/fx/lib.json')).text).packages[
      'fx/lib'
    ][0];
    await control(service, 'digest-mismatch');
    const archive = await call(service, new URL(metadata.dist.url).pathname);
    expect(hash('sha1', archive.body)).not.toBe(metadata.dist.shasum);
    expect(archive.body).toEqual(buildCorpus().get('digest-mismatch.zip'));
    expect((await call(service, '/dists/fx/lib/1.0.0.zip')).body).toEqual(archive.body);
    const hostile = JSON.parse((await call(service, '/p2/fx/digest-mismatch.json')).text).packages[
      'fx/digest-mismatch'
    ][0];
    expect(hash('sha1', (await call(service, new URL(hostile.dist.url).pathname)).body)).not.toBe(
      hostile.dist.shasum,
    );
  });

  it('records presence and absence with exact counts and never exposes header canaries in bodies or logs', async () => {
    const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => {}),
    );
    const service = await start({
      recordedHeaders: ['Authorization', 'Cookie', 'X-Fixture-Canary'],
    });
    const canary = 'fixture-sensitive-value-847';
    const responses = [
      await call(service, '/fixture-lib', {
        headers: { authorization: canary, cookie: canary, 'x-fixture-canary': canary },
      }),
      await call(service, '/fixture-lib'),
      await call(service, '/unknown?private=' + canary, { headers: { authorization: canary } }),
      await call(service, '/_control/mode', {
        method: 'POST',
        body: canary,
        headers: { authorization: canary },
      }),
      await call(service, '/_control/mode', {
        method: 'POST',
        control: true,
        body: JSON.stringify({ mode: canary }),
      }),
      await call(service, '/_control/requests', { control: true }),
    ];
    const recorded = JSON.parse(responses.at(-1)!.text);
    expect(recorded.counts).toEqual({ 'GET npm-packument': 2, 'GET not-found': 1 });
    expect(recorded.observations.slice(0, 2)).toEqual([
      {
        route: 'GET npm-packument',
        headers: { authorization: 'present', cookie: 'present', 'x-fixture-canary': 'present' },
      },
      {
        route: 'GET npm-packument',
        headers: { authorization: 'absent', cookie: 'absent', 'x-fixture-canary': 'absent' },
      },
    ]);
    for (const response of responses) {
      expect(response.text.includes(canary)).toBe(false);
      expect(response.text.includes(service.controlSecret)).toBe(false);
    }
    for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
    await call(service, '/_control/reset', { method: 'POST', control: true });
    expect(JSON.parse((await call(service, '/_control/requests', { control: true })).text)).toEqual(
      { counts: {}, observations: [], dropped: 0 },
    );
  });

  it('prepares a GitHub push envelope whose signature covers the exact returned bytes', async () => {
    const service = await start();
    const response = await call(service, '/_control/webhook', { method: 'POST', control: true });
    const envelope = JSON.parse(response.text);
    expect(envelope.headers['x-github-event']).toBe('push');
    expect(envelope.headers['x-hub-signature-256']).toBe(
      'sha256=' + createHmac('sha256', service.webhookSecret).update(envelope.body).digest('hex'),
    );
    expect(response.text.includes(service.webhookSecret)).toBe(false);
    expect(envelope.body).not.toContain('email');
    expect(
      createHmac('sha256', service.webhookSecret)
        .update(envelope.body + ' ')
        .digest('hex'),
    ).not.toBe(envelope.headers['x-hub-signature-256'].slice(7));
  });

  it('rejects unsafe origin configuration and invalid recorder names with fixed errors', async () => {
    await expect(
      startFixtureService({ brokerOrigin: 'https://user:private@example.test' }),
    ).rejects.toThrow('InvalidFixtureOrigin');
    await expect(startFixtureService({ recordedHeaders: ['invalid\nheader'] })).rejects.toThrow(
      'InvalidFixtureHeaders',
    );
  });
});
