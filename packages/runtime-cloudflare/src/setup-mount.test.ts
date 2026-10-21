import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import type { KernelOptions } from '@package-broker/core/kernel/kernel';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';

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

import { createWorker, type Env } from './index.js';

function keyringOnlyD1(): NonNullable<Env['DB']> {
  const verifier = new Map<number, string>();
  type Recorded = {
    sql: string;
    values: unknown[];
    bind: (...next: unknown[]) => Recorded;
    all: () => Promise<unknown>;
  };
  const run = (sql: string, values: unknown[]) => {
    const insert = /^\s*insert into keyring_verifier .*X'([0-9a-f]{64})'/is.exec(sql);
    if (insert !== null) {
      const version = values[0] as number;
      if (verifier.has(version)) return { results: [], meta: { changes: 0 } };
      verifier.set(version, (insert[1] as string).toUpperCase());
      return { results: [], meta: { changes: 1 } };
    }
    if (/from "keyring_verifier"/i.test(sql)) {
      return {
        results: [...verifier]
          .sort(([left], [right]) => right - left)
          .map(([key_version, mac_hex]) => ({ key_version, mac_hex })),
      };
    }
    if (/from (?:local_login|credential|token)\b/i.test(sql)) return { results: [] };
    throw new Error('unexpected SQL');
  };
  const make = (sql: string, values: unknown[]): Recorded => ({
    sql,
    values,
    bind: (...next) => make(sql, next),
    all: () => Promise.resolve(run(sql, values)),
  });
  return {
    prepare: (sql: string) => make(sql, []),
    batch: (statements: Recorded[]) =>
      Promise.resolve(statements.map((statement) => run(statement.sql, statement.values))),
  } as unknown as NonNullable<Env['DB']>;
}

const ORIGIN = 'https://broker.test';
const session = { cookie: 'test-session=valid' };
const staged: Record<string, [string, string]> = {
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
};
const SETUP_ASSETS = ['app.0123456789ab.css', 'setup.0123456789ab.js'];
const stagedManifest = {
  version: 1,
  entry: 'index.html',
  files: Object.fromEntries(
    Object.entries(staged).map(([name, [contentType, body]]) => [
      name,
      { contentType, bytes: new TextEncoder().encode(body).byteLength },
    ]),
  ),
};
const binding = {
  fetch: async (input: Request | string) => {
    const name = new URL(typeof input === 'string' ? input : input.url).pathname.slice(1);
    if (name === 'manifest.json') return new Response(JSON.stringify(stagedManifest));
    const file = staged[name];
    return file === undefined ? new Response('missing', { status: 404 }) : new Response(file[1]);
  },
};
const authEnv: Env = {
  DB: keyringOnlyD1(),
  PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  PB_PUBLIC_URL: ORIGIN,
};

function harness() {
  const worker = createWorker([], { authorization: engine, log: () => undefined });
  const env = { ...authEnv, ASSETS: binding };
  const fetchAs = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  return { worker, env, fetchAs };
}

describe('Worker setup mount', () => {
  it('serves the setup document and only its referenced assets without a session', async () => {
    const { fetchAs } = harness();
    try {
      const page = await fetchAs('/_pb/ui/setup');
      expect(page.status).toBe(200);
      expect(await page.text()).toBe(staged['setup.html']![1]);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
      expect(page.headers.get('set-cookie')).toBeNull();
      for (const name of SETUP_ASSETS) {
        const response = await fetchAs(`/_pb/ui/setup/assets/${name}`);
        expect(response.status, name).toBe(200);
        expect(await response.text()).toBe(staged[name]![1]);
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      }
      for (const path of [
        '/_pb/ui/setup/assets/app.0123456789ab.js',
        '/_pb/ui/setup/assets/index.html',
        '/_pb/ui/setup/assets/setup.html',
        '/_pb/ui/setup/assets/manifest.json',
        '/_pb/ui/setup/assets/..%2Fx',
        '/_pb/ui/setup/assets/%2e%2e%2fx',
        '/_pb/ui/setup/assets/..%5Cx',
        '/_pb/ui/setup/assets/',
        '/_pb/ui/setup/assets',
        '/_pb/ui/setup/document',
        '/_pb/ui/setup/',
      ]) {
        expect((await fetchAs(path)).status, path).toBe(404);
      }
    } finally {
      vi.clearAllMocks();
    }
  });

  it('keeps the ordinary UI behind the session after the setup routes mount', async () => {
    const { fetchAs } = harness();
    try {
      for (const path of [
        '/_pb/ui/',
        '/_pb/ui',
        '/_pb/ui/manifest.json',
        '/_pb/ui/app.0123456789ab.js',
        '/_pb/ui/app.0123456789ab.css',
        '/_pb/ui/setup.html',
        '/_pb/ui/setup.0123456789ab.js',
      ]) {
        expect((await fetchAs(path)).status, `anonymous ${path}`).toBe(401);
      }
      for (const path of ['/_pb/ui/', '/_pb/ui/app.0123456789ab.js']) {
        expect((await fetchAs(path, { headers: session })).status, path).toBe(200);
      }
    } finally {
      vi.clearAllMocks();
    }
  });

  it('adds the public document and asset routes ahead of the authenticated UI routes', async () => {
    const { worker, env } = harness();
    try {
      await worker.services(env);
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
          boundary: 'authenticated',
          needsOrg: true,
        },
        {
          method: 'GET',
          path: '/_pb/ui/:file',
          permission: null,
          boundary: 'authenticated',
          needsOrg: true,
        },
      ]);
    } finally {
      vi.clearAllMocks();
    }
  });

  it('refuses writes to the setup paths and does not expose the internal document route', async () => {
    const { fetchAs } = harness();
    try {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const response = await fetchAs('/_pb/ui/setup', {
          method,
          headers: { origin: ORIGIN, 'content-type': 'application/json' },
          body: '{}',
        });
        expect(response.status, method).toBeGreaterThanOrEqual(400);
      }
      const forged = await fetchAs('/_pb/ui/setup/document', {
        headers: { 'x-pb-setup-ui': 'guess' },
      });
      expect(forged.status).toBe(404);
    } finally {
      vi.clearAllMocks();
    }
  });

  it('mounts no setup routes without the ASSETS binding', async () => {
    const worker = createWorker([], { authorization: engine, log: () => undefined });
    try {
      await worker.services(authEnv);
      expect(
        (captured.options.at(-1)?.coreRoutes ?? []).filter((route) =>
          route.path.startsWith('/_pb/ui'),
        ),
      ).toEqual([]);
      expect((await worker.fetch(new Request(`${ORIGIN}/_pb/ui/setup`), authEnv)).status).toBe(404);
    } finally {
      vi.clearAllMocks();
    }
  });
});
