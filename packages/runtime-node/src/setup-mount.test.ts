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

const ORIGIN = 'https://broker.test';
const auth = {
  keyring: createKeyring([
    parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
  ]),
  publicOrigin: ORIGIN,
  env: {},
};
const session = { cookie: 'test-session=valid' };
const staged = {
  'index.html': [
    'text/html',
    '<!doctype html><link rel="stylesheet" href="app.0123456789ab.css"><script src="app.0123456789ab.js"></script>',
  ],
  'app.0123456789ab.js': ['text/javascript', 'console.log("app")'],
  'app.0123456789ab.css': ['text/css', 'body{margin:0}'],
  'setup.html': [
    'text/html',
    '<!doctype html><link rel="stylesheet" href="/_pb/ui/setup/assets/app.0123456789ab.css"><script type="module" src="/_pb/ui/setup/assets/setup.0123456789ab.js"></script>',
  ],
  'setup.0123456789ab.js': ['text/javascript', 'console.log("setup")'],
} as const;
const SETUP_ASSETS = ['app.0123456789ab.css', 'setup.0123456789ab.js'];

async function stage(): Promise<string> {
  const outer = await mkdtemp(join(tmpdir(), 'pb-setup-mount-'));
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
    writeFile(join(root, 'manifest.json'), JSON.stringify(manifest)),
    writeFile(join(outer, 'secret.txt'), 'outside'),
    ...Object.entries(staged).map(([name, [, body]]) => writeFile(join(root, name), body)),
  ]);
  fixture.root = root;
  return root;
}

const fetchUi = (request: Request) => listener.fetch!(request);
const anonymous = (path: string, init?: RequestInit) =>
  fetchUi(new Request(`${ORIGIN}${path}`, init));

describe('Node setup mount', () => {
  it('serves the setup document and only its referenced assets without a session', async () => {
    const root = await stage();
    const broker = createNodeServer([], { auth, authorization: engine, log: () => undefined });
    await broker.ready();
    try {
      const page = await anonymous('/_pb/ui/setup');
      expect(page.status).toBe(200);
      expect(await page.text()).toBe(staged['setup.html'][1]);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(page.headers.get('set-cookie')).toBeNull();
      for (const name of SETUP_ASSETS) {
        const response = await anonymous(`/_pb/ui/setup/assets/${name}`);
        expect(response.status, name).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(
          new Uint8Array(await readFile(join(root, name))),
        );
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      }
      for (const path of [
        '/_pb/ui/setup/assets/app.0123456789ab.js',
        '/_pb/ui/setup/assets/index.html',
        '/_pb/ui/setup/assets/setup.html',
        '/_pb/ui/setup/assets/manifest.json',
        '/_pb/ui/setup/assets/..%2Fsecret.txt',
        '/_pb/ui/setup/assets/%2e%2e%2fsecret.txt',
        '/_pb/ui/setup/assets/..%5Csecret.txt',
        '/_pb/ui/setup/assets/secret.txt',
        '/_pb/ui/setup/assets/',
        '/_pb/ui/setup/assets',
        '/_pb/ui/setup/document',
        '/_pb/ui/setup/',
      ]) {
        const response = await anonymous(path);
        expect(response.status, path).toBe(404);
        expect(await response.text()).not.toContain('outside');
      }
    } finally {
      await broker.close();
      await rm(join(root, '..'), { recursive: true, force: true });
    }
  });

  it('keeps the ordinary UI public after the setup routes mount', async () => {
    const root = await stage();
    const broker = createNodeServer([], { auth, authorization: engine, log: () => undefined });
    await broker.ready();
    try {
      for (const path of [
        '/_pb/ui/',
        '/_pb/ui/app.0123456789ab.js',
        '/_pb/ui/app.0123456789ab.css',
        '/_pb/ui/setup.html',
        '/_pb/ui/setup.0123456789ab.js',
      ]) {
        expect((await anonymous(path)).status, `anonymous ${path}`).toBe(200);
      }
      expect((await anonymous('/_pb/ui')).status).toBe(303);
      expect((await anonymous('/_pb/ui/manifest.json')).status).toBe(404);
      for (const path of ['/_pb/ui/', '/_pb/ui/app.0123456789ab.js']) {
        expect((await anonymous(path, { headers: session })).status, path).toBe(200);
      }
      expect((await anonymous('/_pb/ui/setup', { headers: session })).status).toBe(200);
    } finally {
      await broker.close();
      await rm(join(root, '..'), { recursive: true, force: true });
    }
  });

  it('mounts the setup routes ahead of the public UI routes', async () => {
    const root = await stage();
    const broker = createNodeServer([], { auth, authorization: engine, log: () => undefined });
    await broker.ready();
    try {
      const ui = (captured.options.at(-1)?.coreRoutes ?? [])
        .filter((route) => route.path.startsWith('/_pb/ui'))
        .map((route) => ({
          method: route.method,
          path: route.path,
          permission: route.permission,
          boundary: route.boundary,
          needsOrg: route.needsOrg,
        }));
      expect(ui).toEqual([
        {
          method: 'GET',
          path: '/_pb/ui/setup/document',
          permission: null,
          boundary: undefined,
          needsOrg: false,
        },
        {
          method: 'GET',
          path: '/_pb/ui/setup/assets/:file',
          permission: null,
          boundary: undefined,
          needsOrg: false,
        },
        {
          method: 'GET',
          path: '/_pb/ui',
          permission: null,
          boundary: undefined,
          needsOrg: false,
        },
        {
          method: 'GET',
          path: '/_pb/ui/:file',
          permission: null,
          boundary: undefined,
          needsOrg: false,
        },
      ]);
    } finally {
      await broker.close();
      await rm(join(root, '..'), { recursive: true, force: true });
    }
  });

  it('refuses writes to the setup paths and does not expose the internal document route', async () => {
    const root = await stage();
    const broker = createNodeServer([], { auth, authorization: engine, log: () => undefined });
    await broker.ready();
    try {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const response = await anonymous('/_pb/ui/setup', {
          method,
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: '{}',
        });
        expect(response.status, method).toBeGreaterThanOrEqual(400);
      }
      const forged = await anonymous('/_pb/ui/setup/document', {
        headers: { 'x-pb-setup-ui': 'guess' },
      });
      expect(forged.status).toBe(404);
    } finally {
      await broker.close();
      await rm(join(root, '..'), { recursive: true, force: true });
    }
  });

  it('mounts no setup routes when the assets directory is absent', async () => {
    const root = await stage();
    fixture.root = join(root, '..', 'missing');
    const broker = createNodeServer([], { auth, authorization: engine, log: () => undefined });
    try {
      await broker.ready();
      expect(
        (captured.options.at(-1)?.coreRoutes ?? []).filter((route) =>
          route.path.startsWith('/_pb/ui'),
        ),
      ).toEqual([]);
      expect((await anonymous('/_pb/ui/setup')).status).toBe(404);
    } finally {
      await broker.close();
      await rm(join(root, '..'), { recursive: true, force: true });
    }
  });
});
