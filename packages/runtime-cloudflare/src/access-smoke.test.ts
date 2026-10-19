const call = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};
import type { ApiCall } from '@package-broker/core/api/idempotency';
import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import {
  authenticatedActorOf,
  organizationActorOf,
} from '@package-broker/core/authz/access-context';
import { mutationFence } from '@package-broker/core/authz/fence';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { DbError } from '@package-broker/core/db/errors';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { definePlugin, SUPPORTED_PLUGIN_API } from '@package-broker/core/plugin';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import {
  createD1Executor,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
} from './db/d1-executor.js';
import { createWorker, type Env, type WorkerAccessServices } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PUBLIC_URL = 'https://broker.test';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const ANCHOR = 'oidc:https://idp.example.test';
const HOUR = 3_600_000;

const bindings = Array.from({ length: 8 }, (_, index) => `ASDB${index}`);
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

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);
let sources: Promise<MigrationSource[]> | undefined;

function migrationSources(): Promise<MigrationSource[]> {
  sources ??= (async () => {
    const names = (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    return Promise.all(
      names.map(async (name) =>
        loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
      ),
    );
  })();
  return sources;
}

interface Hooks {
  before: ((sql: string) => Promise<void> | undefined) | undefined;
  readonly seen: string[];
}

function observed(db: D1DatabaseLike, hooks: Hooks): D1DatabaseLike {
  const real = new WeakMap<object, D1PreparedStatementLike>();
  const wrap = (sql: string, statement: D1PreparedStatementLike): D1PreparedStatementLike => {
    const wrapper: D1PreparedStatementLike = {
      bind: (...values) => wrap(sql, statement.bind(...values)),
      all: (async () => {
        hooks.seen.push(sql);
        await hooks.before?.(sql);
        return statement.all();
      }) as D1PreparedStatementLike['all'],
    };
    real.set(wrapper, statement);
    return wrapper;
  };
  return {
    prepare: (sql) => wrap(sql, db.prepare(sql)),
    batch: ((statements: D1PreparedStatementLike[]) =>
      db.batch(
        statements.map((statement) => real.get(statement) ?? statement),
      )) as D1DatabaseLike['batch'],
  };
}

function cookieHeader(responses: readonly Response[]): string {
  const jar = new Map<string, string>();
  for (const response of responses) {
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0] as string;
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, { headers });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL, ...headers },
    body: JSON.stringify(body),
  });
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe('cloudflare access smoke on Miniflare D1', () => {
  let services: WorkerAccessServices | null;
  let hooks: Hooks;

  const plugin: PluginDefinition = definePlugin({
    id: 'probe',
    package: '@test/probe',
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['cloudflare'],
    binds: ['identity'],
    identityProviders: () => [
      {
        id: 'oidc',
        kind: 'oidc',
        displayName: 'Example',
        trustAnchor: ANCHOR,
        policy: {
          verifiedDomains: ['example.test'],
          emailAuthoritativeDomains: ['example.test'],
          autoJoin: false,
        },
        supportsReauth: true,
        start: () => Promise.resolve({ kind: 'direct' }),
        finish: () => Promise.resolve({ ok: false, reason: 'invalid_token' }),
      },
    ],
    register(registry) {
      registry.route({
        method: 'GET',
        path: '/probe/org',
        permission: 'org:read',
        boundary: 'organization',
        handler: () => Response.json({ ok: true }),
      });
      registry.route({
        method: 'GET',
        path: '/probe/project/:project',
        permission: 'project:read',
        boundary: 'project',
        handler: (ctx) => Response.json({ projectId: ctx.projectId }),
      });
      registry.route({
        method: 'GET',
        path: '/probe/settings/:project',
        permission: 'project:settings:write',
        boundary: 'project',
        handler: (ctx) => Response.json({ projectId: ctx.projectId }),
      });
      registry.route({
        method: 'GET',
        path: '/probe/make-project',
        permission: 'org:projects:create',
        boundary: 'organization',
        handler: async (ctx) => {
          const viewed = organizationActorOf(ctx);
          const authenticated = authenticatedActorOf(ctx);
          if (viewed === null || authenticated === null || ctx.org === null || services === null) {
            return new Response(null, { status: 500 });
          }
          const created = await services.projects.createProject(
            ctx.org,
            { ...viewed, permissions: new Set(viewed.permissions) },
            mutationFence(authenticated, {}),
            { slug: 'alpha', name: 'Alpha' },
            call,
          );
          return Response.json(created.ok ? { id: created.value.id } : { error: created.error }, {
            status: created.ok ? 200 : 409,
          });
        },
      });
      registry.route({
        method: 'GET',
        path: '/probe/make-token',
        permission: 'org:read',
        boundary: 'organization',
        handler: async (ctx) => {
          const authenticated = authenticatedActorOf(ctx);
          if (authenticated === null || ctx.org === null || services === null) {
            return new Response(null, { status: 500 });
          }
          const session = await services.sessions.authenticate(ctx.org, ctx.request);
          if (session === null) return new Response(null, { status: 401 });
          const issued = await services.personalTokens.issue(
            ctx.org,
            session,
            mutationFence(authenticated, {}),
            {
              name: 'probe',
              scope:
                new URL(ctx.request.url).searchParams.get('scope') === 'read' ? 'read' : 'full',
              expiresAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
              projectMode: 'all',
              projectIds: [],
            },
            apiCall,
          );
          if (!issued.ok) return Response.json({ error: issued.error }, { status: 409 });
          return Response.json({ id: issued.value.id, plaintext: issued.value.plaintext });
        },
      });
      registry.route({
        method: 'GET',
        path: '/probe/revoke-token',
        permission: 'org:read',
        boundary: 'organization',
        handler: async (ctx) => {
          const authenticated = authenticatedActorOf(ctx);
          if (authenticated === null || ctx.org === null || services === null) {
            return new Response(null, { status: 500 });
          }
          const session = await services.sessions.authenticate(ctx.org, ctx.request);
          if (session === null) return new Response(null, { status: 401 });
          const revoked = await services.tokenRevoke.revoke(
            ctx.org,
            session,
            mutationFence(authenticated, {}),
            {
              tokenId: new URL(ctx.request.url).searchParams.get('id') ?? '',
              routeProjectId: null,
            },
            apiCall,
          );
          return Response.json(revoked);
        },
      });
    },
  });

  beforeEach(() => {
    services = null;
    hooks = { before: undefined, seen: [] };
  });

  async function database(): Promise<{ raw: D1DatabaseLike; orgId: string; token: string }> {
    const binding = bindings[next];
    next += 1;
    if (binding === undefined) throw new Error('out of D1 bindings');
    const raw = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
    const executor = createD1Executor(raw);
    await migrate(executor, await migrationSources(), { holder: 'access-smoke-test' });
    const orgId = ulid();
    const now = new Date();
    await createOrganizationBootstrap(executor).bootstrap({
      id: orgId,
      slug: 'acme',
      name: 'Acme',
      now: now.toISOString(),
    });
    const token = randomBytes(32).toString('base64url');
    const roleIds = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, ulid()])) as Record<
      DefaultRoleKey,
      string
    >;
    await bootstrapAdmin(executor, orgContext(orgId), {
      email: EMAIL,
      userId: ulid(),
      setupHash: createHash('sha256').update(token).digest('hex'),
      setupExpiresAt: new Date(now.getTime() + HOUR).toISOString(),
      grantId: ulid(),
      roleIds,
      opId: ulid(),
      now: now.toISOString(),
    });
    return { raw, orgId, token };
  }

  interface Booted {
    readonly fetch: (request: Request) => Promise<Response>;
    readonly raw: D1DatabaseLike;
    readonly orgId: string;
    readonly token: string;
  }

  async function boot(): Promise<Booted> {
    const { raw, orgId, token } = await database();
    const environment = {
      DB: observed(raw, hooks),
      PB_MASTER_KEY: KEY,
      PB_PUBLIC_URL: PUBLIC_URL,
    } as unknown as Env;
    const worker = createWorker([plugin], { log: () => undefined });
    services = (await worker.services(environment)).access;
    return { fetch: (request) => worker.fetch(request, environment), raw, orgId, token };
  }

  async function loginAdmin(booted: Booted): Promise<string> {
    const { token } = booted;
    const started = await booted.fetch(post('/_pb/auth/local/setup/start', { token }));
    const { secret } = (await started.json()) as { secret: string };
    const totpSecret = base32Decode(secret);
    const step = Math.floor(Date.now() / 30_000);
    const finished = await booted.fetch(
      post('/_pb/auth/local/setup/finish', {
        token,
        password: PASSWORD,
        code: await totpCode(totpSecret, step - 1),
      }),
    );
    expect(finished.status).toBe(204);
    const login = await booted.fetch(
      post('/_pb/auth/local/login', {
        email: EMAIL,
        password: PASSWORD,
        code: await totpCode(totpSecret, step),
      }),
    );
    expect(login.status).toBe(204);
    const cookie = cookieHeader([login]);
    const csrf = /__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
    const reauth = await booted.fetch(
      post(
        '/_pb/auth/local/reauth',
        { password: PASSWORD, code: await totpCode(totpSecret, step + 1) },
        { cookie, 'x-csrf-token': csrf },
      ),
    );
    expect(reauth.status).toBe(204);
    return cookie;
  }

  async function issueToken(
    booted: Booted,
    cookie: string,
    scope: 'read' | 'full',
  ): Promise<{ id: string; headers: Record<string, string> }> {
    const issued = await booted.fetch(get(`/probe/make-token?scope=${scope}`, { cookie }));
    expect(issued.status).toBe(200);
    const { id, plaintext } = (await issued.json()) as { id: string; plaintext: string };
    expect(plaintext).toMatch(/^pb_pat_/);
    return { id, headers: { authorization: `Bearer ${plaintext}` } };
  }

  async function withProject(): Promise<{ booted: Booted; cookie: string }> {
    const booted = await boot();
    const cookie = await loginAdmin(booted);
    expect((await booted.fetch(get('/probe/make-project', { cookie }))).status).toBe(200);
    return { booted, cookie };
  }

  async function snapshot(response: Response): Promise<{ status: number; body: string }> {
    const body = (await response.text()).replace(/"requestId":"[^"]*"/, '"requestId":"-"');
    return { status: response.status, body };
  }

  it('serves an allowed session request and an allowed personal token request', async () => {
    const { booted, cookie } = await withProject();
    const { headers } = await issueToken(booted, cookie, 'full');

    expect((await booted.fetch(get('/probe/org', { cookie }))).status).toBe(200);
    expect((await booted.fetch(get('/probe/project/alpha', { cookie }))).status).toBe(200);
    expect((await booted.fetch(get('/probe/org', headers))).status).toBe(200);
    expect((await booted.fetch(get('/probe/project/alpha', headers))).status).toBe(200);
  });

  it('refuses a stale personal token with the uniform 401 envelope', async () => {
    const { booted, cookie } = await withProject();
    const { headers } = await issueToken(booted, cookie, 'full');
    expect((await booted.fetch(get('/probe/project/alpha', headers))).status).toBe(200);

    const bogus = await snapshot(
      await booted.fetch(get('/probe/project/alpha', { authorization: 'Bearer pb_pat_bogus' })),
    );
    expect(bogus.status).toBe(401);

    const stale = new Date(Date.now() - 2 * 24 * HOUR).toISOString();
    await createD1Executor(booted.raw).all({
      sql: 'UPDATE local_login SET last_login_at = ? WHERE org_id = ?',
      params: [stale, booted.orgId],
    });
    expect(await snapshot(await booted.fetch(get('/probe/project/alpha', headers)))).toEqual(bogus);
    expect(await snapshot(await booted.fetch(get('/probe/org', headers)))).toEqual(bogus);
  });

  it('refuses a revoked token with the uniform 401 envelope', async () => {
    const { booted, cookie } = await withProject();
    const { id, headers } = await issueToken(booted, cookie, 'full');
    expect((await booted.fetch(get('/probe/project/alpha', headers))).status).toBe(200);

    const revoked = await booted.fetch(get(`/probe/revoke-token?id=${id}`, { cookie }));
    expect(await revoked.json()).toEqual({ ok: true, value: { revoked: true } });

    const bogus = await snapshot(
      await booted.fetch(get('/probe/project/alpha', { authorization: 'Bearer pb_pat_bogus' })),
    );
    expect(await snapshot(await booted.fetch(get('/probe/project/alpha', headers)))).toEqual(bogus);
    expect(bogus.status).toBe(401);
  });

  it('refuses anonymous, malformed and unknown credentials with one 401 envelope', async () => {
    const { booted } = await withProject();
    const anonymous = await snapshot(await booted.fetch(get('/probe/org')));
    expect(anonymous.status).toBe(401);
    for (const authorization of ['Bearer pb_pat_bogus', 'Bearer nonsense', 'Basic Zm9vOmJhcg==']) {
      expect(await snapshot(await booted.fetch(get('/probe/org', { authorization })))).toEqual(
        anonymous,
      );
    }
    expect(
      await snapshot(await booted.fetch(get('/probe/org', { cookie: '__Host-pb_session=nope' }))),
    ).toEqual(anonymous);
  });

  it('answers a missing project with the uniform 404 and an insufficient scope with 403', async () => {
    const { booted, cookie } = await withProject();
    const { headers } = await issueToken(booted, cookie, 'read');

    const missing = await snapshot(await booted.fetch(get('/probe/project/ghost', headers)));
    expect(missing.status).toBe(404);
    expect(
      await snapshot(await booted.fetch(get('/probe/project/other-ghost', { cookie }))),
    ).toEqual(missing);

    const forbidden = await snapshot(await booted.fetch(get('/probe/settings/alpha', headers)));
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).not.toContain('alpha');
    expect((await booted.fetch(get('/probe/settings/alpha', { cookie }))).status).toBe(200);
  });

  it('runs the access lookup on the D1 binding, with foreign keys enforced', async () => {
    const { booted, cookie } = await withProject();
    const { headers } = await issueToken(booted, cookie, 'full');
    hooks.seen.length = 0;
    expect((await booted.fetch(get('/probe/project/alpha', headers))).status).toBe(200);
    expect(hooks.seen.some((sql) => /\baccess_grant\b/.test(sql))).toBe(true);
    expect(hooks.seen.some((sql) => /\btoken\b/.test(sql))).toBe(true);

    const executor = createD1Executor(booted.raw);
    const insert = (roleId: string) =>
      executor.all({
        sql: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [
          ulid(),
          booted.orgId,
          'email',
          'x@example.test',
          null,
          'organization',
          null,
          roleId,
        ],
      });
    const failure = await rejection(insert(ulid()));
    expect(failure).toBeInstanceOf(DbError);
    expect((failure as DbError).kind).toBe('foreign_key');
    const [role] = await executor.all<{ id: string }>({
      sql: "SELECT id FROM role WHERE org_id = ? AND scope = 'organization' LIMIT 1",
      params: [booted.orgId],
    });
    if (role === undefined) throw new Error('no organization role');
    await expect(insert(role.id)).resolves.toBeDefined();
  });
});

const apiCall: ApiCall = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};
