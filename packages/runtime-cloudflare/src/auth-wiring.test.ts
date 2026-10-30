import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES } from '@package-broker/core/authz/permissions';
import type { DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { IdentityProvider } from '@package-broker/core/identity/port';
import { definePlugin } from '@package-broker/core/plugin';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import { createWorker, publicOriginOf } from './index.js';
import type { Env } from './index.js';

const KEY_V1 = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const KEY_V2 = 'pbmk_v2_ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8';
const KEY_WEAK = `pbmk_v1_${'A'.repeat(43)}`;
const KEY_FRAGMENTS = ['AAECAwQF', 'ICEiIyQl', 'pbmk_v'];
const PUBLIC_URL = 'https://broker.test';
const ADMIN_EMAIL = 'admin@example.test';
const PASSWORD = 'correct horse battery staple';
const FACTORY_SENTINEL = 'factory-sentinel-7f3a91';
const REGISTER_SENTINEL = 'register-sentinel-5c2b40';

const bindings = Array.from({ length: 16 }, (_, index) => `AWDB${index}`);

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);
let sources: MigrationSource[] | undefined;

async function coreMigrations(): Promise<MigrationSource[]> {
  sources ??= await Promise.all(
    ['0001_init.sql'].map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
  return sources;
}

async function freshDatabase(): Promise<D1DatabaseLike> {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  await migrate(createD1Executor(db), await coreMigrations(), { holder: 'auth-wiring-test' });
  return db;
}

let shared: Promise<D1DatabaseLike> | undefined;

function sharedDatabase(): Promise<D1DatabaseLike> {
  shared ??= freshDatabase();
  return shared;
}

function roleIds(): Record<DefaultRoleKey, string> {
  const ids = {} as Record<DefaultRoleKey, string>;
  for (const { key } of DEFAULT_ROLES) ids[key] = ulid();
  return ids;
}

async function bootstrappedDatabase(): Promise<{ db: D1DatabaseLike; token: string }> {
  const db = await freshDatabase();
  const executor = createD1Executor(db);
  const orgId = ulid();
  const now = new Date();
  await createOrganizationBootstrap(executor).bootstrap({
    id: orgId,
    slug: 'acme',
    name: 'Acme',
    now: now.toISOString(),
  });
  const token = randomBytes(32).toString('base64url');
  await bootstrapAdmin(executor, orgContext(orgId), {
    email: ADMIN_EMAIL,
    userId: ulid(),
    setupHash: createHash('sha256').update(token).digest('hex'),
    setupExpiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
    grantId: ulid(),
    roleIds: roleIds(),
    opId: ulid(),
    now: now.toISOString(),
  });
  return { db, token };
}

function env(db: D1DatabaseLike, overrides: Record<string, string | undefined> = {}): Env {
  const base: Record<string, unknown> = {
    DB: db,
    PB_MASTER_KEY: KEY_V1,
    PB_PUBLIC_URL: PUBLIC_URL,
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[name];
    else base[name] = value;
  }
  return base as unknown as Env;
}

function get(path: string, headers: Record<string, string> = {}, method = 'GET'): Request {
  return new Request(`${PUBLIC_URL}${path}`, { method, headers });
}

function post(path: string, body: unknown, origin: string = PUBLIC_URL): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify(body),
  });
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
}

function step(offset = 0): number {
  return Math.floor(Date.now() / 30_000) + offset;
}

function collectLog(): {
  entries: string[];
  log: (entry: Readonly<Record<string, unknown>>) => void;
} {
  const entries: string[] = [];
  return { entries, log: (entry) => void entries.push(JSON.stringify(entry)) };
}

function leaks(text: string, extra: readonly string[] = []): string[] {
  return [...KEY_FRAGMENTS, ...extra].filter((fragment) => text.includes(fragment));
}

function idpPlugin(): PluginDefinition {
  return definePlugin({
    id: 'idp',
    package: 'test/idp',
    platforms: ['cloudflare'],
    apiVersion: 3,
    binds: ['identity'],
    identityProviders: (ctx) => {
      if (ctx.env('PB_IDP_MODE') === 'broken') throw new Error(FACTORY_SENTINEL);
      return [];
    },
  });
}

describe('auth wiring on Miniflare D1', () => {
  it('calls register once per worker kernel build with auth', async () => {
    const register = vi.fn((registry: Parameters<NonNullable<PluginDefinition['register']>>[0]) => {
      registry.route({
        method: 'GET',
        path: '/registered',
        permission: null,
        needsOrg: false,
        handler: () => new Response('ok'),
      });
    });
    const worker = createWorker([
      definePlugin({
        id: 'counted',
        package: 'test/counted',
        platforms: ['cloudflare'],
        apiVersion: 3,
        register,
      }),
    ]);
    const environment = env(await sharedDatabase());

    expect((await worker.fetch(get('/registered'), environment)).status).toBe(200);
    expect(register).toHaveBeenCalledTimes(1);
    expect((await worker.fetch(get('/_pb/auth/providers'), environment)).status).toBe(200);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it('answers 503 misconfigured without leaking when a plugin register throws', async () => {
    let calls = 0;
    const failing = definePlugin({
      id: 'register-throws',
      package: 'test/register-throws',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register() {
        calls += 1;
        throw new Error(REGISTER_SENTINEL);
      },
    });
    const db: D1DatabaseLike = {
      prepare: vi.fn(() => {
        throw new Error('unexpected database query');
      }),
      batch: vi.fn(() => Promise.resolve([])),
    };
    const sink = collectLog();

    const response = await createWorker([failing], { log: sink.log }).fetch(
      get('/_pb/auth/providers'),
      env(db),
    );

    expect(response.status).toBe(503);
    const text = await response.text();
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('misconfigured');
    expect(leaks(text, [REGISTER_SENTINEL])).toEqual([]);
    expect(leaks(sink.entries.join('\n'), [REGISTER_SENTINEL])).toEqual([]);
    expect(calls).toBe(1);
  });

  it('checks the auth configuration before collecting registrations', async () => {
    let calls = 0;
    const failing = definePlugin({
      id: 'register-throws',
      package: 'test/register-throws',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register() {
        calls += 1;
        throw new Error(REGISTER_SENTINEL);
      },
    });
    const db: D1DatabaseLike = {
      prepare: vi.fn(() => {
        throw new Error('unexpected database query');
      }),
      batch: vi.fn(() => Promise.resolve([])),
    };
    const sink = collectLog();

    const response = await createWorker([failing], { log: sink.log }).fetch(
      get('/_pb/auth/providers'),
      env(db, { PB_MASTER_KEY: undefined }),
    );

    expect(response.status).toBe(503);
    expect(calls).toBe(0);
    const logged = sink.entries.join('\n');
    expect(logged).toContain('SecretsConfigError');
    expect(logged).not.toContain('KernelConfigError');
  });

  it('runs local setup and login through worker.fetch and serves the session', async () => {
    const { db, token } = await bootstrappedDatabase();
    const worker = createWorker([]);
    const environment = env(db);

    const started = await worker.fetch(post('/_pb/auth/local/setup/start', { token }), environment);
    expect(started.status).toBe(200);
    const { secret } = (await started.json()) as { secret: string };
    const key = base32Decode(secret);

    const finished = await worker.fetch(
      post('/_pb/auth/local/setup/finish', {
        token,
        password: PASSWORD,
        code: await totpCode(key, step()),
      }),
      environment,
    );
    expect(finished.status).toBe(204);

    const afterSetup = await worker.fetch(
      get('/_pb/session', { cookie: cookieHeader(finished) }),
      environment,
    );
    expect(afterSetup.status).toBe(200);
    const session = (await afterSetup.json()) as { user: { email: string } };
    expect(session.user.email).toBe(ADMIN_EMAIL);

    const loggedIn = await worker.fetch(
      post('/_pb/auth/local/login', {
        email: ADMIN_EMAIL,
        password: PASSWORD,
        code: await totpCode(key, step(1)),
      }),
      environment,
    );
    expect(loggedIn.status).toBe(204);

    const afterLogin = await worker.fetch(
      get('/_pb/session', { cookie: cookieHeader(loggedIn) }),
      environment,
    );
    expect(afterLogin.status).toBe(200);

    const anonymous = await worker.fetch(get('/_pb/session'), environment);
    expect(anonymous.status).toBe(401);
  });

  it('lists the providers and local login without an organization', async () => {
    const db = await sharedDatabase();
    const response = await createWorker([]).fetch(get('/_pb/auth/providers'), env(db));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ providers: [], local: true });
  });

  it('accepts a PB_PUBLIC_URL with a trailing slash and an uppercase host', async () => {
    const { db, token } = await bootstrappedDatabase();
    const worker = createWorker([]);
    const response = await worker.fetch(
      post('/_pb/auth/local/setup/start', { token }),
      env(db, { PB_PUBLIC_URL: 'https://Broker.Test/' }),
    );
    expect(response.status).toBe(200);
  });

  it('keeps auth routes out of the unbound path', async () => {
    const worker = createWorker([]);
    const response = await worker.fetch(get('/_pb/auth/providers'), {
      PB_MASTER_KEY: KEY_V1,
      PB_PUBLIC_URL: PUBLIC_URL,
    } as unknown as Env);
    expect(response.status).toBe(404);
  });

  it('shows plugins only the PB_IDP_ bindings', async () => {
    const db = await sharedDatabase();
    const seen: Record<string, string | undefined> = {};
    const plugin = definePlugin({
      id: 'idp-probe',
      package: 'test/idp-probe',
      platforms: ['cloudflare'],
      apiVersion: 3,
      binds: ['identity'],
      identityProviders: (ctx) => {
        for (const name of [
          'PB_MASTER_KEY',
          'PB_MASTER_KEY_PREVIOUS',
          'PB_PUBLIC_URL',
          'PB_AUTH_LOCAL',
          'DB',
          'PB_IDP_X',
        ]) {
          seen[name] = ctx.env(name);
        }
        return [];
      },
    });
    const response = await createWorker([plugin]).fetch(
      get('/_pb/auth/providers'),
      env(db, { PB_IDP_X: 'visible', PB_AUTH_LOCAL: 'enabled', PB_MASTER_KEY_PREVIOUS: undefined }),
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual({
      PB_MASTER_KEY: undefined,
      PB_MASTER_KEY_PREVIOUS: undefined,
      PB_PUBLIC_URL: undefined,
      PB_AUTH_LOCAL: undefined,
      DB: undefined,
      PB_IDP_X: 'visible',
    });
  });

  it('reads the keys once per binding and PB_* values, and again when a value changes', async () => {
    const db = await sharedDatabase();
    let builds = 0;
    const plugin = definePlugin({
      id: 'idp-count',
      package: 'test/idp-count',
      platforms: ['cloudflare'],
      apiVersion: 3,
      binds: ['identity'],
      identityProviders: () => {
        builds += 1;
        return [];
      },
    });
    const logged: unknown[] = [];
    const worker = createWorker([plugin], { log: (entry) => void logged.push(entry) });
    expect((await worker.fetch(get('/_pb/auth/providers'), env(db))).status).toBe(200);
    expect((await worker.fetch(get('/_pb/auth/providers'), env(db))).status).toBe(200);
    expect(builds).toBe(1);

    const rotated = env(db, { PB_MASTER_KEY: KEY_V2, PB_MASTER_KEY_PREVIOUS: KEY_V1 });
    expect((await worker.fetch(get('/_pb/auth/providers'), rotated)).status).toBe(200);
    expect(builds).toBe(2);

    const broken = await worker.fetch(
      get('/_pb/auth/providers'),
      env(db, { PB_MASTER_KEY: 'pbmk_v1_broken' }),
    );
    expect(broken.status).toBe(503);
    const text = await broken.text();
    expect(text).toContain('misconfigured');
    for (const fragment of [...KEY_FRAGMENTS, 'broken']) {
      expect(text).not.toContain(fragment);
      expect(JSON.stringify(logged)).not.toContain(fragment);
    }
    expect(builds).toBe(2);
  });
});

describe('local auth binding validation', () => {
  it.each(['', 'ENABLED', 'break-glass', 'credential-sentinel@example.test', null, 42, {}])(
    'fails closed for malformed binding %j without exposing its value',
    async (value) => {
      const db = await sharedDatabase();
      const sink = collectLog();
      const worker = createWorker([], { log: sink.log });
      const environment = { ...env(db), PB_AUTH_LOCAL: value } as unknown as Env;
      for (const path of ['/_pb/auth/providers', '/_pb/auth/local/login']) {
        const response = await worker.fetch(
          path.endsWith('/login') ? post(path, {}) : get(path),
          environment,
        );
        expect(response.status).toBe(503);
        const text = await response.text();
        expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('misconfigured');
        expect(text).not.toContain('credential-sentinel');
      }
      expect(sink.entries.join('\n')).toContain('auth_local_invalid');
      expect(sink.entries.join('\n')).not.toContain('credential-sentinel');
      expect((await worker.fetch(get('/_pb/auth/providers'), env(db))).status).toBe(200);
    },
  );

  it('refuses disabled with no identity plugin before serving local login', async () => {
    const db = await sharedDatabase();
    const sink = collectLog();
    const worker = createWorker([], { log: sink.log });
    const environment = env(db, { PB_AUTH_LOCAL: 'disabled' });
    for (const path of ['/_pb/auth/providers', '/_pb/auth/local/login']) {
      const response = await worker.fetch(
        path.endsWith('/login') ? post(path, {}) : get(path),
        environment,
      );
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'misconfigured',
      );
    }
    expect(sink.entries.join('\n')).toContain('auth_no_sign_in_method');
  });
});

describe('misconfigured environment', () => {
  const cases: ReadonlyArray<{
    name: string;
    plugins: () => PluginDefinition[];
    bad: Record<string, string | undefined>;
    fixed: Record<string, string | undefined>;
  }> = [
    { name: 'missing master key', plugins: () => [], bad: { PB_MASTER_KEY: undefined }, fixed: {} },
    {
      name: 'malformed master key',
      plugins: () => [],
      bad: { PB_MASTER_KEY: 'pbmk_v1_short' },
      fixed: {},
    },
    { name: 'weak master key', plugins: () => [], bad: { PB_MASTER_KEY: KEY_WEAK }, fixed: {} },
    {
      name: 'previous key newer than the current one',
      plugins: () => [],
      bad: { PB_MASTER_KEY_PREVIOUS: KEY_V2 },
      fixed: { PB_MASTER_KEY_PREVIOUS: undefined },
    },
    { name: 'missing public url', plugins: () => [], bad: { PB_PUBLIC_URL: undefined }, fixed: {} },
    {
      name: 'http public url',
      plugins: () => [],
      bad: { PB_PUBLIC_URL: 'http://broker.test' },
      fixed: {},
    },
    { name: 'empty public url', plugins: () => [], bad: { PB_PUBLIC_URL: '' }, fixed: {} },
    {
      name: 'public url with credentials',
      plugins: () => [],
      bad: { PB_PUBLIC_URL: 'https://u:p@broker.test' },
      fixed: {},
    },
    {
      name: 'public url with a query',
      plugins: () => [],
      bad: { PB_PUBLIC_URL: 'https://broker.test/?x=1' },
      fixed: {},
    },
    {
      name: 'public url with a path',
      plugins: () => [],
      bad: { PB_PUBLIC_URL: 'https://broker.test/app' },
      fixed: {},
    },
    {
      name: 'public url that is not a url',
      plugins: () => [],
      bad: { PB_PUBLIC_URL: 'broker' },
      fixed: {},
    },
    {
      name: 'provider factory that throws',
      plugins: () => [idpPlugin()],
      bad: { PB_IDP_MODE: 'broken' },
      fixed: { PB_IDP_MODE: 'ok' },
    },
  ];

  it.each(cases)('answers 503 misconfigured for $name until the env is fixed', async (item) => {
    const db = await sharedDatabase();
    const sink = collectLog();
    const worker = createWorker(item.plugins(), { log: sink.log });

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await worker.fetch(get('/_pb/auth/providers'), env(db, item.bad));
      expect(response.status).toBe(503);
      const text = await response.text();
      expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe('misconfigured');
      expect(leaks(text, [FACTORY_SENTINEL])).toEqual([]);
    }
    expect(leaks(sink.entries.join('\n'), [FACTORY_SENTINEL])).toEqual([]);
    expect(sink.entries.length).toBeGreaterThan(0);

    const recovered = await worker.fetch(get('/_pb/auth/providers'), env(db, item.fixed));
    expect(recovered.status).toBe(200);
  });

  it.each(cases)('answers HEAD for $name with 503 and no body', async (item) => {
    const db = await sharedDatabase();
    const worker = createWorker(item.plugins(), { log: () => undefined });
    const response = await worker.fetch(get('/_pb/auth/providers', {}, 'HEAD'), env(db, item.bad));
    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).not.toBeNull();
    expect(await response.text()).toBe('');
  });

  it('answers HEAD with no body when the kernel build fails unexpectedly', async () => {
    const db = await sharedDatabase();
    const failing = definePlugin({
      id: 'failing',
      package: 'test/failing',
      platforms: ['cloudflare'],
      apiVersion: 3,
      init() {
        throw new Error('init failed');
      },
    });
    const response = await createWorker([failing], { log: () => undefined }).fetch(
      get('/health/live', {}, 'HEAD'),
      env(db),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('');
  });
});

const PRODUCTION_PBKDF2_CAP = 100_000;

function capDeriveBits(): void {
  const original = crypto.subtle.deriveBits.bind(crypto.subtle);
  vi.spyOn(crypto.subtle, 'deriveBits').mockImplementation((algorithm, ...rest) => {
    const iterations = (algorithm as { iterations?: number }).iterations;
    if (typeof iterations === 'number' && iterations > PRODUCTION_PBKDF2_CAP) {
      return Promise.reject(new Error('iteration count above the runtime limit'));
    }
    return original(algorithm, ...rest);
  });
}

describe('password hashing self-test', () => {
  it('builds the kernel on a runtime that caps PBKDF2 at 100 000 iterations', async () => {
    const db = await sharedDatabase();
    capDeriveBits();
    const response = await createWorker([]).fetch(get('/_pb/auth/providers'), env(db));
    expect(response.status).toBe(200);
  });

  it('fails closed with 503 misconfigured when the real self-test is rejected by the runtime, then recovers', async () => {
    const db = await sharedDatabase();
    const sink = collectLog();
    const spy = vi
      .spyOn(crypto.subtle, 'deriveBits')
      .mockRejectedValue(new Error('runtime rejected the derivation'));
    const worker = createWorker([], { log: sink.log });

    const response = await worker.fetch(get('/_pb/auth/providers'), env(db));
    expect(spy).toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'misconfigured',
    );
    expect(sink.entries.length).toBeGreaterThan(0);
    expect(leaks(sink.entries.join('\n'), ['runtime rejected'])).toEqual([]);

    spy.mockRestore();
    const recovered = await worker.fetch(get('/_pb/auth/providers'), env(db));
    expect(recovered.status).toBe(200);
  });

  it('fails closed with 503 misconfigured for a configured count of 100 001, then recovers', async () => {
    const db = await sharedDatabase();
    const sink = collectLog();
    const configured = { count: 100_001 };
    vi.resetModules();
    vi.doMock('@package-broker/core/auth/password', async (importOriginal) => {
      const original = await importOriginal<typeof import('@package-broker/core/auth/password')>();
      const { SecretsConfigError } = await import('@package-broker/core/secrets/master-key');
      return {
        ...original,
        async selfTestPasswordHashing(keyring: Keyring): Promise<void> {
          try {
            const pepper = await keyring.hmacKey('password-pepper', keyring.currentVersion);
            const input = await crypto.subtle.sign('HMAC', pepper, new Uint8Array(1));
            const base = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, [
              'deriveBits',
            ]);
            await crypto.subtle.deriveBits(
              {
                name: 'PBKDF2',
                hash: 'SHA-256',
                salt: new Uint8Array(16),
                iterations: configured.count,
              },
              base,
              256,
            );
          } catch {
            throw new SecretsConfigError('malformed', 'PASSWORD_ITERATIONS');
          }
        },
      };
    });
    try {
      capDeriveBits();
      const { createWorker: createSeamWorker } = await import('./index.js');
      const worker = createSeamWorker([], { log: sink.log });

      const response = await worker.fetch(get('/_pb/auth/providers'), env(db));
      expect(response.status).toBe(503);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        'misconfigured',
      );
      expect(sink.entries.length).toBeGreaterThan(0);
      expect(leaks(sink.entries.join('\n'), ['above the runtime limit'])).toEqual([]);

      configured.count = PRODUCTION_PBKDF2_CAP;
      const recovered = await worker.fetch(get('/_pb/auth/providers'), env(db));
      expect(recovered.status).toBe(200);
    } finally {
      vi.doUnmock('@package-broker/core/auth/password');
      vi.resetModules();
    }
  });
});

describe('start-up order', () => {
  it('rejects a bad PB_PUBLIC_URL before the PBKDF2 self-test runs', async () => {
    const db = await sharedDatabase();
    const spy = vi.spyOn(crypto.subtle, 'deriveBits');
    const response = await createWorker([], { log: () => undefined }).fetch(
      get('/_pb/auth/providers'),
      env(db, { PB_PUBLIC_URL: 'http://broker.test' }),
    );
    expect(response.status).toBe(503);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('publicOriginOf', () => {
  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['broker', 'malformed'],
    ['http://broker.test', 'malformed'],
    ['https://broker.test/app', 'malformed'],
    ['https://broker.test/?x=1', 'malformed'],
    ['https://broker.test/#frag', 'malformed'],
    ['https://u:p@broker.test', 'malformed'],
  ])('rejects %j as %s for PB_PUBLIC_URL', (raw, problem) => {
    try {
      publicOriginOf(raw);
      expect.unreachable('publicOriginOf accepted the value');
    } catch (error) {
      expect(error).toMatchObject({
        name: 'SecretsConfigError',
        problem,
        variable: 'PB_PUBLIC_URL',
      });
    }
  });

  it('returns the canonical origin', () => {
    expect(publicOriginOf('https://Broker.Test/')).toBe('https://broker.test');
    expect(publicOriginOf('https://broker.test:8443')).toBe('https://broker.test:8443');
  });
});

describe('plugin hooks and identity fetch', () => {
  const SUBJECT = 'access-subject-1';

  function accessProvider(): IdentityProvider {
    return {
      id: 'access',
      kind: 'cloudflare-access',
      displayName: 'Access',
      trustAnchor: `access:team.example.com/${'ab'.repeat(32)}`,
      policy: {
        verifiedDomains: ['example.test'],
        emailAuthoritativeDomains: ['example.test'],
        autoJoin: false,
      },
      supportsReauth: false,
      start: () => Promise.resolve({ kind: 'direct' }),
      finish: () =>
        Promise.resolve({
          ok: true,
          identity: {
            provider: 'access',
            subject: SUBJECT,
            email: ADMIN_EMAIL,
            emailVerified: true,
            displayName: null,
            groups: [],
            issuedAt: new Date().toISOString(),
            authTime: null,
          },
        }),
    };
  }

  function identityPlugin(): PluginDefinition {
    return definePlugin({
      id: 'access-idp',
      package: 'test/access-idp',
      platforms: ['cloudflare'],
      apiVersion: 3,
      binds: ['identity'],
      identityProviders: () => [accessProvider()],
    });
  }

  function denyPlugin(): PluginDefinition {
    return definePlugin({
      id: 'deny-login',
      package: 'test/deny-login',
      platforms: ['cloudflare'],
      apiVersion: 3,
      register(registry) {
        registry.hook('auth.resolveIdentity', () => ({ deny: true }));
      },
    });
  }

  function startLogin(): Request {
    return post('/_pb/auth/sso/access/start', { purpose: 'login' });
  }

  it('logs in through a direct provider when no hook objects', async () => {
    const { db } = await bootstrappedDatabase();
    const response = await createWorker([identityPlugin()], { log: () => undefined }).fetch(
      startLogin(),
      env(db),
    );
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie().length).toBeGreaterThan(0);
  });

  it('gives the assembled services the anchors of the providers the auth module uses', async () => {
    const { db } = await bootstrappedDatabase();
    const worker = createWorker([identityPlugin()], { log: () => undefined });
    const services = await worker.services(env(db));
    expect(await services.providerAnchors.anchors(orgContext(ulid()))).toEqual([
      {
        provider: 'access',
        anchor: accessProvider().trustAnchor,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ]);
    expect((await worker.fetch(startLogin(), env(db))).status).toBe(303);
    expect(await worker.services(env(db))).toBe(services);
  });

  it('hands the registered hooks to the auth module: a deny hook refuses the login', async () => {
    const { db } = await bootstrappedDatabase();
    const response = await createWorker([identityPlugin(), denyPlugin()], {
      log: () => undefined,
    }).fetch(startLogin(), env(db));
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('login_failed');
  });

  it('shares one registration between the auth module and the kernel', async () => {
    const { db } = await bootstrappedDatabase();
    const shared = definePlugin({
      id: 'shared-registration',
      package: 'test/shared-registration',
      platforms: ['cloudflare'],
      apiVersion: 3,
      binds: ['identity'],
      identityProviders: () => [accessProvider()],
      register(registry) {
        let runs = 0;
        registry.hook('auth.resolveIdentity', () => {
          runs += 1;
          return undefined;
        });
        registry.route({
          method: 'GET',
          path: '/hook-runs',
          permission: null,
          needsOrg: false,
          handler: () => Response.json({ runs }),
        });
      },
    });
    const worker = createWorker([shared], { log: () => undefined });

    const before = await worker.fetch(get('/hook-runs'), env(db));
    expect(await before.json()).toEqual({ runs: 0 });

    const login = await worker.fetch(startLogin(), env(db));
    expect(login.status).toBe(303);

    const after = await worker.fetch(get('/hook-runs'), env(db));
    expect(((await after.json()) as { runs: number }).runs).toBeGreaterThanOrEqual(1);
  });

  async function identityFetchOf(
    db: D1DatabaseLike,
  ): Promise<(request: Request) => Promise<Response>> {
    let captured: ((request: Request) => Promise<Response>) | undefined;
    const plugin = definePlugin({
      id: 'fetch-probe',
      package: 'test/fetch-probe',
      platforms: ['cloudflare'],
      apiVersion: 3,
      binds: ['identity'],
      identityProviders: (ctx) => {
        captured = ctx.fetch;
        return [];
      },
    });
    const response = await createWorker([plugin]).fetch(get('/_pb/auth/providers'), env(db));
    expect(response.status).toBe(200);
    if (captured === undefined) throw new Error('factory did not run');
    return captured;
  }

  function stubFetch(): { signals: AbortSignal[] } {
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal === undefined || signal === null) throw new Error('fetch without a signal');
          signals.push(signal);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }),
    );
    return { signals };
  }

  it('aborts an identity fetch after five seconds', async () => {
    const db = await sharedDatabase();
    const identityFetch = await identityFetchOf(db);
    const timeout = new AbortController();
    const requested: number[] = [];
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      requested.push(ms);
      return timeout.signal;
    });
    const { signals } = stubFetch();

    const pending = identityFetch(new Request('https://idp.test/jwks'));
    expect(requested).toEqual([5000]);
    expect(signals[0]?.aborted).toBe(false);
    timeout.abort(new DOMException('timed out', 'TimeoutError'));
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  });

  it("keeps the provider's own abort signal", async () => {
    const db = await sharedDatabase();
    const identityFetch = await identityFetchOf(db);
    const { signals } = stubFetch();
    const own = new AbortController();

    const pending = identityFetch(new Request('https://idp.test/jwks', { signal: own.signal }));
    expect(signals[0]?.aborted).toBe(false);
    own.abort(new DOMException('caller gave up', 'AbortError'));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(signals[0]?.aborted).toBe(true);
  });
});

describe('runtime error path', () => {
  it('answers HEAD without a body when the kernel rejects', async () => {
    vi.resetModules();
    vi.doMock('@package-broker/core/kernel/kernel', () => ({
      createKernel: () =>
        Promise.resolve({
          fetch: () => Promise.reject(new Error('kernel exploded')),
          registration: { routes: [], hooks: { 'access.check': [] }, bindings: new Map() },
        }),
    }));
    try {
      const { createWorker: createFailingWorker } = await import('./index.js');
      const response = await createFailingWorker([], { log: () => undefined }).fetch(
        get('/anything', {}, 'HEAD'),
      );
      expect(response.status).toBe(500);
      expect(response.headers.get('x-request-id')).not.toBeNull();
      expect(await response.text()).toBe('');
    } finally {
      vi.doUnmock('@package-broker/core/kernel/kernel');
      vi.resetModules();
    }
  });
});
