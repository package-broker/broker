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

import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
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
    await cp(new URL('../../ui/dist/assets/', import.meta.url), fixture.root, { recursive: true });
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
