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

const document = '<!doctype html><title>Package Broker</title>';
const manifest = {
  version: 1,
  entry: 'index.html',
  files: { 'index.html': { contentType: 'text/html', bytes: document.length } },
};
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

describe('Worker UI mount', () => {
  it('adds only public UI routes without an organization or session requirement', async () => {
    const worker = createWorker([], { authorization: engine, log: () => undefined });
    const authEnv: Env = {
      DB: keyringOnlyD1(),
      PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
      PB_PUBLIC_URL: 'https://broker.test',
    };
    await worker.services(authEnv);
    const baseline = [...(captured.options.at(-1)?.coreRoutes ?? [])];
    const env = {
      ...authEnv,
      ASSETS: {
        fetch: async (input: Request | string) =>
          new URL(typeof input === 'string' ? input : input.url).pathname === '/manifest.json'
            ? Response.json(manifest)
            : new Response(document),
      },
    };
    await worker.services(env);
    const fetchUi = (request: Request) => worker.fetch(request, env);
    try {
      const authorizationCalls = vi.mocked(engine.authorize).mock.calls.length;
      for (const [path, expected] of [['/_pb/ui/', document]]) {
        const anonymous = await fetchUi(new Request(`https://broker.test${path}`));
        const signedIn = await fetchUi(
          new Request(`https://broker.test${path}`, {
            headers: { cookie: 'test-session=valid' },
          }),
        );
        for (const response of [anonymous, signedIn]) {
          expect(response.status, path).toBe(200);
          expect(response.headers.get('set-cookie')).toBeNull();
          expect(await response.text()).toBe(expected);
        }
        const headers = (response: Response) =>
          [...response.headers].filter(([name]) => name !== 'x-request-id');
        expect(headers(anonymous)).toEqual(headers(signedIn));
      }
      expect(vi.mocked(engine.authorize).mock.calls).toHaveLength(authorizationCalls);
      const redirect = await fetchUi(
        new Request('https://broker.test/_pb/ui?view=packages', {
          headers: { cookie: 'test-session=valid' },
        }),
      );
      expect(redirect.status).toBe(303);
      expect(redirect.headers.get('location')).toBe('/_pb/ui/?view=packages');
      expect(redirect.headers.get('cache-control')).toBe('no-store');
      expect(
        (
          await fetchUi(
            new Request('https://broker.test/_pb/projects', {
              headers: { cookie: 'test-session=valid' },
            }),
          )
        ).status,
      ).toBe(200);
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
        { method: 'GET', path: '/_pb/ui', boundary: undefined, needsOrg: false },
        { method: 'GET', path: '/_pb/ui/', boundary: undefined, needsOrg: false },
        { method: 'GET', path: '/_pb/ui/:file', boundary: undefined, needsOrg: false },
      ]);
      expect(baseline.some((route) => route.path === '/_pb/session')).toBe(true);
      const otherDocument = document.replace('Broker', 'Server');
      const otherEnv = {
        ...authEnv,
        ASSETS: {
          fetch: async (input: Request | string) =>
            new URL(typeof input === 'string' ? input : input.url).pathname === '/manifest.json'
              ? Response.json(manifest)
              : new Response(otherDocument),
        },
      };
      const other = await worker.fetch(
        new Request('https://broker.test/_pb/ui/', {
          headers: { cookie: 'test-session=valid' },
        }),
        otherEnv,
      );
      expect(other.status).toBe(200);
      expect(await other.text()).toBe(otherDocument);
    } finally {
      vi.clearAllMocks();
    }
  });
});

describe('Worker UI mount from the ASSETS binding', () => {
  const session = { cookie: 'test-session=valid' };
  const script = 'console.log("Package Broker");';
  const style = 'body{margin:0}';
  const html =
    '<!doctype html><title>Package Broker</title>' +
    '<link rel="stylesheet" href="app.0123456789ab.css"><script src="app.0123456789ab.js"></script>';
  const staged: Record<string, [string, string]> = {
    'index.html': ['text/html', html],
    'app.0123456789ab.js': ['text/javascript', script],
    'app.0123456789ab.css': ['text/css', style],
  };
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
  const bindingFor = (manifestBody: string) => ({
    fetch: async (input: Request | string) => {
      const name = new URL(typeof input === 'string' ? input : input.url).pathname.slice(1);
      if (name === 'manifest.json') return new Response(manifestBody);
      const file = staged[name];
      return file === undefined ? new Response('missing', { status: 404 }) : new Response(file[1]);
    },
  });
  const authEnv: Env = {
    DB: keyringOnlyD1(),
    PB_MASTER_KEY: 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
    PB_PUBLIC_URL: 'https://broker.test',
  };

  it('serves every script and stylesheet the document references at the document-relative URL', async () => {
    const worker = createWorker([], { authorization: engine, log: () => undefined });
    const env = { ...authEnv, ASSETS: bindingFor(JSON.stringify(stagedManifest)) };
    const fetchUi = (request: Request) => worker.fetch(request, env);
    try {
      const entry = await fetchUi(new Request('https://broker.test/_pb/ui', { headers: session }));
      expect(entry.status).toBe(303);
      const documentUrl = new URL(entry.headers.get('location')!, 'https://broker.test');
      const page = await fetchUi(new Request(documentUrl, { headers: session }));
      expect(page.status).toBe(200);
      const text = await page.text();
      const urls = [
        ...[...text.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]!),
        ...[...text.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
          (match) => match[1]!,
        ),
      ].map((reference) => new URL(reference, documentUrl));
      expect(urls.map((url) => url.pathname).sort()).toEqual([
        '/_pb/ui/app.0123456789ab.css',
        '/_pb/ui/app.0123456789ab.js',
      ]);
      for (const url of urls) {
        const name = url.pathname.split('/').at(-1)!;
        const declared = stagedManifest.files[name as keyof typeof stagedManifest.files]!;
        const authorizationCalls = vi.mocked(engine.authorize).mock.calls.length;
        const anonymous = await fetchUi(new Request(url));
        const response = await fetchUi(new Request(url, { headers: session }));
        expect(response.status, name).toBe(200);
        expect(anonymous.status, `anonymous ${name}`).toBe(200);
        expect(response.headers.get('set-cookie')).toBeNull();
        expect(anonymous.headers.get('set-cookie')).toBeNull();
        const headers = (response: Response) =>
          [...response.headers].filter(([name]) => name !== 'x-request-id');
        expect(headers(anonymous)).toEqual(headers(response));
        expect(await anonymous.arrayBuffer()).toEqual(await response.clone().arrayBuffer());
        expect(vi.mocked(engine.authorize).mock.calls).toHaveLength(authorizationCalls);
        expect(response.headers.get('content-type')).toBe(declared.contentType);
        expect(response.headers.get('content-length')).toBe(String(declared.bytes));
        expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
        expect(await response.text()).toBe(staged[name]![1]);
      }
      for (const path of [
        '/_pb/ui/index.html',
        '/_pb/ui/manifest.json',
        '/index.html',
        '/manifest.json',
        '/app.0123456789ab.js',
        '/_pb/ui/unknown.js',
        '/_pb/ui/..%2Fx',
        '/_pb/ui/%252e%252e%252fsecret.txt',
        '/_pb/ui/..%5Csecret.txt',
        '/_pb/ui/%2Fetc%2Fpasswd',
        '/_pb/ui/secret.txt%00.js',
      ]) {
        const missing = await fetchUi(new Request(`https://broker.test${path}`));
        expect(missing.status, path).toBe(404);
        expect(await missing.json()).toEqual({
          error: { code: 'not_found', message: 'Route not found', requestId: expect.any(String) },
        });
      }
    } finally {
      vi.clearAllMocks();
    }
  });

  it('answers 404, not 500, when the binding holds an invalid manifest', async () => {
    const worker = createWorker([], { authorization: engine, log: () => undefined });
    const env = { ...authEnv, ASSETS: bindingFor('{"version":1,"entry":"../x","files":{}}') };
    try {
      for (const path of ['/_pb/ui/', '/_pb/ui', '/_pb/ui/manifest.json', '/_pb/ui/index.html']) {
        const response = await worker.fetch(new Request(`https://broker.test${path}`), env);
        expect(response.status, path).toBe(404);
        expect(await response.json()).toMatchObject({ error: { code: 'not_found' } });
      }
    } finally {
      vi.clearAllMocks();
    }
  });

  it('logs a fixed warning for an invalid manifest and retries on the next request', async () => {
    const entries: Record<string, unknown>[] = [];
    const worker = createWorker([], {
      authorization: engine,
      log: (entry) => entries.push({ ...entry }),
    });
    let body = '{"version":1,"entry":"../x","files":{}}';
    const env = {
      ...authEnv,
      ASSETS: {
        fetch: (input: Request | string) => bindingFor(body).fetch(input),
      },
    };
    const get = () =>
      worker.fetch(new Request('https://broker.test/_pb/ui/', { headers: session }), env);
    try {
      expect((await get()).status).toBe(404);
      expect(entries).toContainEqual({ level: 'warn', event: 'ui.manifest_invalid' });
      body = JSON.stringify(stagedManifest);
      expect((await get()).status).toBe(200);
    } finally {
      vi.clearAllMocks();
    }
  });

  it('mounts no UI routes without the binding', async () => {
    const worker = createWorker([], { authorization: engine, log: () => undefined });
    try {
      await worker.services(authEnv);
      expect(
        (captured.options.at(-1)?.coreRoutes ?? []).filter((route) =>
          route.path.startsWith('/_pb/ui'),
        ),
      ).toEqual([]);
      const response = await worker.fetch(
        new Request('https://broker.test/_pb/ui/', { headers: session }),
        authEnv,
      );
      expect(response.status).toBe(404);
    } finally {
      vi.clearAllMocks();
    }
  });
});
