import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import type { KernelOptions } from '@package-broker/core/kernel/kernel';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';

const captured = vi.hoisted(() => ({ options: [] as KernelOptions[] }));
vi.mock('@package-broker/core/kernel/kernel', async (original) => {
  const actual = await original<typeof import('@package-broker/core/kernel/kernel')>();
  return {
    ...actual,
    createKernel: (options: KernelOptions) => {
      captured.options.push(options);
      return actual.createKernel(options);
    },
  };
});
vi.mock('@package-broker/core/kernel/org', async (original) => {
  const actual = await original<typeof import('@package-broker/core/kernel/org')>();
  return { ...actual, createOrgResolver: () => async () => orgContext('org-ui') };
});

const engine: AuthorizationEngine = {
  authorize: vi.fn(async ({ request }) =>
    request.headers.get('cookie') === 'test-session=valid'
      ? {
          allow: true as const,
          principal: { kind: 'user' as const, id: 'user-ui' },
          projectId: null,
        }
      : { allow: false as const, status: 401 as const },
  ),
};

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { parseUiManifest } from '@package-broker/core/platform/ui-manifest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeServer } from './index.js';

const fixture = vi.hoisted(() => ({ root: '' }));
const listener = vi.hoisted(() => ({
  fetch: undefined as ((request: Request) => Promise<Response>) | undefined,
}));
vi.mock('@hono/node-server', async (original) => {
  const actual = await original<typeof import('@hono/node-server')>();
  return {
    ...actual,
    getRequestListener: (...args: Parameters<typeof actual.getRequestListener>) => {
      listener.fetch = args[0] as (request: Request) => Promise<Response>;
      return actual.getRequestListener(...args);
    },
  };
});
vi.mock('./assets.js', async (original) => {
  const actual = await original<typeof import('./assets.js')>();
  return { createNodeAssets: () => actual.createNodeAssets(fixture.root) };
});

describe('Node UI mount', () => {
  it('adds only UI routes and requires the engine authenticated boundary', async () => {
    const auth = {
      keyring: createKeyring([
        parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
      ]),
      publicOrigin: 'https://broker.test',
      env: {},
    };
    const withoutAssets = createNodeServer([], {
      auth,
      authorization: engine,
      log: () => undefined,
    });
    const baseline = [...(await withoutAssets.ready()).coreRoutes];
    await withoutAssets.close();
    fixture.root = await mkdtemp(join(tmpdir(), 'pb-ui-mount-'));
    const fixtureDocument =
      '<!doctype html><title>Package Broker</title><script src="app.fixture.js"></script>';
    const fixtureAsset = 'console.log("Package Broker");';
    await Promise.all([
      writeFile(join(fixture.root, 'index.html'), fixtureDocument),
      writeFile(join(fixture.root, 'app.fixture.js'), fixtureAsset),
      writeFile(
        join(fixture.root, 'manifest.json'),
        JSON.stringify({
          version: 1,
          entry: 'index.html',
          files: {
            'index.html': { contentType: 'text/html', bytes: Buffer.byteLength(fixtureDocument) },
            'app.fixture.js': {
              contentType: 'text/javascript',
              bytes: Buffer.byteLength(fixtureAsset),
            },
          },
        }),
      ),
    ]);
    const manifest = parseUiManifest(await readFile(join(fixture.root, 'manifest.json'), 'utf8'));
    const document = await readFile(join(fixture.root, manifest.entry), 'utf8');
    const referencedAsset = /<script[^>]+src="([^"]+)"/.exec(document)?.[1];
    expect(referencedAsset).toBeDefined();
    const assetUrl = new URL(referencedAsset!, 'https://broker.test/_pb/ui/');
    const broker = createNodeServer([], { auth, authorization: engine, log: () => undefined });
    await broker.ready();
    const fetchUi = (request: Request) => listener.fetch!(request);
    try {
      for (const path of ['/_pb/ui/', '/_pb/ui', '/_pb/ui/manifest.json', assetUrl.pathname]) {
        const anonymous = await fetchUi(new Request(`https://broker.test${path}`));
        expect(anonymous.status, `anonymous ${path}`).toBe(401);
      }
      for (const [path, expected] of [
        ['/_pb/ui/', document],
        ['/_pb/ui/manifest.json', JSON.stringify(manifest)],
      ]) {
        const response = await fetchUi(
          new Request(`https://broker.test${path}`, {
            headers: { cookie: 'test-session=valid' },
          }),
        );
        expect(response.status, path).toBe(200);
        expect(await response.text()).toBe(expected);
      }
      const headers = { cookie: 'test-session=valid' };
      const canonical = await fetchUi(
        new Request('https://broker.test/_pb/ui?view=packages', { headers }),
      );
      expect(canonical.status).toBe(303);
      expect(canonical.headers.get('location')).toBe('/_pb/ui/?view=packages');
      const asset = await fetchUi(new Request(assetUrl, { headers }));
      expect(asset.status).toBe(200);
      expect(asset.headers.get('content-type')).toBe(manifest.files[referencedAsset!]!.contentType);
      expect(new Uint8Array(await asset.arrayBuffer())).toEqual(
        new Uint8Array(await readFile(join(fixture.root, referencedAsset!))),
      );
      for (const path of ['/_pb/ui/unknown.js', '/_pb/ui/index.html']) {
        const missing = await fetchUi(new Request(`https://broker.test${path}`, { headers }));
        expect(missing.status).toBe(404);
        expect(missing.headers.get('content-type')).toContain('application/json');
        expect(await missing.json()).toEqual({
          error: {
            code: 'not_found',
            message: 'Route not found',
            requestId: expect.any(String),
          },
        });
      }
      expect(
        (
          await fetchUi(
            new Request('https://broker.test/_pb/projects', {
              headers: { cookie: 'test-session=valid' },
            }),
          )
        ).status,
      ).toBe(404);
      const routes = captured.options.at(-1)?.coreRoutes ?? [];

      expect(
        routes
          .filter(
            (route) =>
              !baseline.some(
                (previous) => previous.method === route.method && previous.path === route.path,
              ),
          )
          .map((route) => ({
            method: route.method,
            path: route.path,
            boundary: route.boundary,
            needsOrg: route.needsOrg,
          })),
      ).toEqual([
        { method: 'GET', path: '/_pb/ui/setup/document', boundary: undefined, needsOrg: false },
        { method: 'GET', path: '/_pb/ui/setup/assets/:file', boundary: undefined, needsOrg: false },
        { method: 'GET', path: '/_pb/ui', boundary: 'authenticated', needsOrg: true },
        { method: 'GET', path: '/_pb/ui/:file', boundary: 'authenticated', needsOrg: true },
      ]);
      expect(baseline.some((route) => route.path === '/_pb/session')).toBe(true);
    } finally {
      await broker.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

describe('Node UI mount from staged assets', () => {
  const auth = {
    keyring: createKeyring([
      parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
    ]),
    publicOrigin: 'https://broker.test',
    env: {},
  };
  const session = { cookie: 'test-session=valid' };
  const script = 'console.log("Package Broker");';
  const style = 'body{margin:0}';
  const document =
    '<!doctype html><title>Package Broker</title>' +
    '<link rel="stylesheet" href="app.0123456789ab.css"><script src="app.0123456789ab.js"></script>';
  const staged = {
    'index.html': ['text/html', document],
    'app.0123456789ab.js': ['text/javascript', script],
    'app.0123456789ab.css': ['text/css', style],
  } as const;
  const fetchUi = (request: Request) => listener.fetch!(request);

  async function stage(
    manifestBody?: string,
  ): Promise<{ root: string; manifest: Record<string, unknown> }> {
    const outer = await mkdtemp(join(tmpdir(), 'pb-ui-staged-'));
    const root = join(outer, 'assets');
    await mkdir(root);
    const manifest = {
      version: 1,
      entry: 'index.html',
      files: Object.fromEntries(
        Object.entries(staged).map(([name, [contentType, body]]) => [
          name,
          { contentType, bytes: Buffer.byteLength(body) },
        ]),
      ),
    };
    await Promise.all([
      writeFile(join(root, 'manifest.json'), manifestBody ?? JSON.stringify(manifest)),
      writeFile(join(outer, 'secret.txt'), 'outside'),
      ...Object.entries(staged).map(([name, [, body]]) => writeFile(join(root, name), body)),
    ]);
    fixture.root = root;
    return { root, manifest };
  }

  it('serves every script and stylesheet the document references with the manifest type and length', async () => {
    const { root, manifest } = await stage();
    const broker = createNodeServer([], { auth, authorization: engine, log: () => undefined });
    await broker.ready();
    try {
      const entry = await fetchUi(new Request('https://broker.test/_pb/ui', { headers: session }));
      expect(entry.status).toBe(303);
      const documentUrl = new URL(entry.headers.get('location')!, 'https://broker.test');
      const page = await fetchUi(new Request(documentUrl, { headers: session }));
      expect(page.status).toBe(200);
      const html = await page.text();
      const urls = [
        ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]!),
        ...[...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
          (match) => match[1]!,
        ),
      ].map((reference) => new URL(reference, documentUrl));
      expect(urls.map((url) => url.pathname).sort()).toEqual([
        '/_pb/ui/app.0123456789ab.css',
        '/_pb/ui/app.0123456789ab.js',
      ]);
      for (const url of urls) {
        const name = url.pathname.split('/').at(-1)!;
        const declared = (
          manifest['files'] as Record<string, { contentType: string; bytes: number }>
        )[name]!;
        expect((await fetchUi(new Request(url))).status, `anonymous ${name}`).toBe(401);
        const response = await fetchUi(new Request(url, { headers: session }));
        expect(response.status, name).toBe(200);
        expect(response.headers.get('content-type')).toBe(declared.contentType);
        expect(response.headers.get('content-length')).toBe(String(declared.bytes));
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          new Uint8Array(await readFile(join(root, name))),
        );
      }
    } finally {
      await broker.close();
      await rm(join(root, '..'), { recursive: true, force: true });
    }
  });

  it('never serves a path outside the staged asset set', async () => {
    const { root } = await stage();
    const broker = createNodeServer([], { auth, authorization: engine, log: () => undefined });
    await broker.ready();
    try {
      for (const path of [
        '/_pb/ui/..%2Fsecret.txt',
        '/_pb/ui/%2e%2e%2fsecret.txt',
        '/_pb/ui/../secret.txt',
        '/_pb/ui/secret.txt',
        '/_pb/ui/%252e%252e%252fsecret.txt',
        '/_pb/ui/..%5Csecret.txt',
        '/_pb/ui/%2Fetc%2Fpasswd',
        '/_pb/ui/secret.txt%00.js',
        '/_pb/ui/assets/app.0123456789ab.js',
        '/_pb/ui/index.html',
      ]) {
        const response = await fetchUi(
          new Request(`https://broker.test${path}`, { headers: session }),
        );
        expect(response.status, path).toBe(404);
        expect(await response.text()).not.toContain('outside');
      }
    } finally {
      await broker.close();
      await rm(join(root, '..'), { recursive: true, force: true });
    }
  });

  it('logs one info line and mounts no UI when the assets directory is absent', async () => {
    const { root } = await stage();
    const outer = join(root, '..');
    fixture.root = join(outer, 'missing');
    const baselineServer = createNodeServer([], {
      auth,
      authorization: engine,
      log: () => undefined,
    });
    const baseline = [...(await baselineServer.ready()).coreRoutes];
    await baselineServer.close();
    const entries: Record<string, unknown>[] = [];
    const broker = createNodeServer([], {
      auth,
      authorization: engine,
      log: (entry) => entries.push({ ...entry }),
    });
    try {
      await broker.ready();
      expect(
        (captured.options.at(-1)?.coreRoutes ?? []).filter((route) =>
          route.path.startsWith('/_pb/ui'),
        ),
      ).toEqual([]);
      expect(captured.options.at(-1)?.coreRoutes).toHaveLength(baseline.length);
      expect(
        entries.filter((entry) => typeof entry['event'] === 'string' && /ui/.test(entry['event'])),
      ).toEqual([expect.objectContaining({ level: 'info' })]);
      const response = await fetchUi(
        new Request('https://broker.test/_pb/ui/', { headers: session }),
      );
      expect(response.status).toBe(404);
    } finally {
      await broker.close();
      await rm(outer, { recursive: true, force: true });
    }
  });

  it('fails startup with a fixed message when the manifest is invalid', async () => {
    const { root } = await stage('{"version":1,"entry":"../x","files":{}}');
    const broker = createNodeServer([], { auth, authorization: engine, log: () => undefined });
    try {
      await expect(broker.ready()).rejects.toThrow('UI manifest is invalid');
    } finally {
      await broker.close();
      await rm(join(root, '..'), { recursive: true, force: true });
    }
  });
});
