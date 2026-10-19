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
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import {
  authenticatedActorOf,
  organizationActorOf,
} from '@package-broker/core/authz/access-context';
import { mutationFence } from '@package-broker/core/authz/fence';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import type { Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { RouteDefinition } from '@package-broker/core/plugin';
import { definePlugin, SUPPORTED_PLUGIN_API } from '@package-broker/core/plugin';
import type { PluginDefinition } from '@package-broker/core/plugin';
import type { Keyring } from '@package-broker/core/secrets/keyring';
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
import {
  createWorker,
  type Env,
  type ExecutionContextLike,
  type WorkerAccessServices,
} from './index.js';

const faults = vi.hoisted(() => ({
  access: false,
  tokenReader: false,
  projectRepository: false,
  pepper: false,
}));
const kernels = vi.hoisted(() => ({ coreRoutes: [] as unknown[][] }));

vi.mock('@package-broker/db-sqlite/repositories/access', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@package-broker/db-sqlite/repositories/access')>();
  return {
    ...actual,
    createAccessRepository: (...args: Parameters<typeof actual.createAccessRepository>) =>
      faults.access ? undefined : actual.createAccessRepository(...args),
  };
});

vi.mock('@package-broker/db-sqlite/repositories/token-read', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@package-broker/db-sqlite/repositories/token-read')>();
  return {
    ...actual,
    createTokenReader: (...args: Parameters<typeof actual.createTokenReader>) =>
      faults.tokenReader ? undefined : actual.createTokenReader(...args),
  };
});

vi.mock('@package-broker/db-sqlite/repositories/project', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@package-broker/db-sqlite/repositories/project')>();
  return {
    ...actual,
    createProjectRepository: (...args: Parameters<typeof actual.createProjectRepository>) =>
      faults.projectRepository ? undefined : actual.createProjectRepository(...args),
  };
});

vi.mock('@package-broker/core/secrets/keyring', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@package-broker/core/secrets/keyring')>();
  return {
    ...actual,
    createKeyring: (...args: Parameters<typeof actual.createKeyring>): Keyring => {
      const real = actual.createKeyring(...args);
      return {
        ...real,
        currentVersion: real.currentVersion,
        versions: real.versions,
        aesKey: real.aesKey.bind(real),
        hmacKey: (purpose, version) =>
          faults.pepper && purpose === 'token-pepper'
            ? Promise.reject(new Error('no pepper'))
            : real.hmacKey(purpose, version),
      };
    },
  };
});

vi.mock('@package-broker/core/kernel/kernel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@package-broker/core/kernel/kernel')>();
  return {
    ...actual,
    createKernel: (options: Parameters<typeof actual.createKernel>[0]) => {
      kernels.coreRoutes.push([...(options.coreRoutes ?? [])]);
      return actual.createKernel(options);
    },
  };
});

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PUBLIC_URL = 'https://broker.test';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const ANCHOR = 'oidc:https://idp.example.test';
const HOUR = 3_600_000;

const bindings = Array.from({ length: 16 }, (_, index) => `ACDB${index}`);
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

function projectId(n: number): string {
  return `01J0PR0J${String(n).padStart(18, '0')}`;
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

describe('cloudflare access wiring on Miniflare D1', () => {
  let services: WorkerAccessServices | null;
  let events: string[];
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
        handler: () => {
          events.push('handler');
          return Response.json({ ok: true });
        },
      });
      registry.route({
        method: 'GET',
        path: '/probe/project/:project',
        permission: 'project:read',
        boundary: 'project',
        handler: (ctx) => {
          events.push('handler');
          return Response.json({ projectId: ctx.projectId });
        },
      });
      registry.route({
        method: 'GET',
        path: '/probe/make-project',
        permission: 'org:projects:create',
        boundary: 'organization',
        handler: async (ctx) => {
          const viewed = organizationActorOf(ctx);
          const actor =
            viewed === null ? null : { ...viewed, permissions: new Set(viewed.permissions) };
          const authenticated = authenticatedActorOf(ctx);
          if (actor === null || authenticated === null || ctx.org === null || services === null) {
            return new Response(null, { status: 500 });
          }
          const created = await services.projects.createProject(
            ctx.org,
            actor,
            mutationFence(authenticated, {}),
            { slug: 'alpha', name: 'Alpha' },
            call,
          );
          if (!created.ok) return Response.json({ error: created.error }, { status: 409 });
          const listed = await services.projectList.list(ctx.org, actor, { limit: 10 });
          return Response.json({
            created: created.value,
            listed: listed.ok ? listed.value.items.map((item) => item.slug) : listed.error,
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
              scope: 'full',
              expiresAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
              projectMode: 'all',
              projectIds: [],
            },
            apiCall,
          );
          if (!issued.ok) return Response.json({ error: issued.error }, { status: 409 });
          const own = await services.tokenList.listOwn(ctx.org, authenticated.userId, {
            after: null,
            limit: 10,
            now: new Date().toISOString(),
          });
          return Response.json({
            id: issued.value.id,
            plaintext: issued.value.plaintext,
            listed: own.items.map((item) => item.name),
          });
        },
      });
      registry.route({
        method: 'GET',
        path: '/probe/administer',
        permission: 'org:read',
        boundary: 'organization',
        handler: async (ctx) => {
          const viewed = organizationActorOf(ctx);
          const authenticated = authenticatedActorOf(ctx);
          if (viewed === null || authenticated === null || ctx.org === null || services === null) {
            return new Response(null, { status: 500 });
          }
          const session = await services.sessions.authenticate(ctx.org, ctx.request);
          if (session === null) return new Response(null, { status: 401 });
          const query = new URL(ctx.request.url).searchParams;
          const project = query.get('project') ?? '';
          const actor = { ...viewed, permissions: new Set(viewed.permissions) };
          const granted = await services.projectGrants.grant(
            ctx.org,
            {
              kind: 'project',
              userId: actor.userId,
              orgId: ctx.org.orgId,
              projectId: project,
              permissions: actor.permissions,
            },
            mutationFence(authenticated, {}),
            project,
            {
              subject: { type: 'email', value: 'member@example.test' },
              roleId: query.get('role') ?? '',
            },
            call,
          );
          const principal = await services.servicePrincipals.create(
            ctx.org,
            session,
            actor,
            mutationFence(authenticated, {}),
            { name: 'deploy', projectId: project },
            apiCall,
          );
          const issued = principal.ok
            ? await services.serviceTokens.issue(
                ctx.org,
                session,
                actor,
                mutationFence(authenticated, {}),
                {
                  servicePrincipalId: principal.value.id,
                  routeProjectId: project,
                  name: 'ci',
                  scope: 'read',
                  expiresAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
                },
                apiCall,
              )
            : null;
          return Response.json({ granted, principal, issued });
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
              via: 'own',
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
    events = [];
    hooks = { before: undefined, seen: [] };
    faults.access = false;
    faults.tokenReader = false;
    faults.projectRepository = false;
    faults.pepper = false;
    kernels.coreRoutes.length = 0;
  });

  async function database(): Promise<{ raw: D1DatabaseLike; orgId: string; token: string }> {
    const binding = bindings[next];
    next += 1;
    if (binding === undefined) throw new Error('out of D1 bindings');
    const raw = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
    const executor = createD1Executor(raw);
    await migrate(executor, await migrationSources(), { holder: 'access-wiring-test' });
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
    readonly fetch: (request: Request, ctx?: ExecutionContextLike) => Promise<Response>;
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
    return {
      fetch: (request, ctx) => worker.fetch(request, environment, ctx),
      raw,
      orgId,
      token,
    };
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

  it('boots with the engine and every service and serves a protected route through them', async () => {
    const booted = await boot();
    const cookie = await loginAdmin(booted);

    expect((await booted.fetch(get('/probe/org'))).status).toBe(401);
    expect(
      (await booted.fetch(get('/probe/org', { authorization: 'Bearer pb_pat_bogus' }))).status,
    ).toBe(401);
    const allowed = await booted.fetch(get('/probe/org', { cookie }));
    expect(allowed.status).toBe(200);
    expect(events).toEqual(['handler']);

    expect(Object.keys(services ?? {}).sort()).toEqual([
      'engine',
      'personalTokens',
      'projectGrants',
      'projectList',
      'projects',
      'servicePrincipals',
      'serviceTokens',
      'sessions',
      'tokenList',
      'tokenRevoke',
    ]);
    for (const service of Object.values(services ?? {})) expect(service).toBeTypeOf('object');
  });

  it('runs the access lookup on the D1 binding, with foreign keys enforced', async () => {
    const booted = await boot();
    const cookie = await loginAdmin(booted);
    hooks.seen.length = 0;
    expect((await booted.fetch(get('/probe/org', { cookie }))).status).toBe(200);
    expect(hooks.seen.some((sql) => /\baccess_grant\b/.test(sql))).toBe(true);

    const failure = await rejection(
      createD1Executor(booted.raw).all({
        sql: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [
          ulid(),
          booted.orgId,
          'email',
          'x@example.test',
          null,
          'organization',
          null,
          ulid(),
        ],
      }),
    );
    expect(failure).toBeInstanceOf(Error);
  });

  it('assembles the catalogue resolver over the D1 database', async () => {
    const { raw, orgId } = await database();
    const worker = createWorker([plugin], { log: () => undefined });
    const { catalogue } = await worker.services({
      DB: raw,
      PB_MASTER_KEY: KEY,
      PB_PUBLIC_URL: PUBLIC_URL,
    } as unknown as Env);
    expect(
      await catalogue.resolveVersions(orgContext(orgId), {
        projectId: projectId(1),
        ecosystem: 'composer',
        key: 'acme/missing',
        limit: 10,
      }),
    ).toBeNull();
  });

  it('resolves project and token services with a real fence and authenticates the PAT', async () => {
    const booted = await boot();
    const cookie = await loginAdmin(booted);

    const made = await booted.fetch(get('/probe/make-project', { cookie }));
    expect(made.status).toBe(200);
    expect(((await made.json()) as { listed: string[] }).listed).toEqual(['alpha']);

    const issued = await booted.fetch(get('/probe/make-token', { cookie }));
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { plaintext: string; listed: string[] };
    expect(body.listed).toEqual(['probe']);
    expect(body.plaintext).toMatch(/^pb_pat_/);
    events.length = 0;
    const served = await booted.fetch(
      get('/probe/project/alpha', { authorization: `Bearer ${body.plaintext}` }),
    );
    expect(served.status).toBe(200);
    expect(events).toEqual(['handler']);
  });

  it('revokes an own personal token through the assembled revoke service', async () => {
    const booted = await boot();
    const cookie = await loginAdmin(booted);
    await booted.fetch(get('/probe/make-project', { cookie }));
    const issued = await booted.fetch(get('/probe/make-token', { cookie }));
    const { id, plaintext } = (await issued.json()) as { id: string; plaintext: string };
    const bearer = { authorization: `Bearer ${plaintext}` };
    expect((await booted.fetch(get('/probe/project/alpha', bearer))).status).toBe(200);

    const revoked = await booted.fetch(get(`/probe/revoke-token?id=${id}`, { cookie }));
    expect(await revoked.json()).toEqual({ ok: true, value: { revoked: true } });
    const again = await booted.fetch(get(`/probe/revoke-token?id=${id}`, { cookie }));
    expect(await again.json()).toEqual({ ok: true, value: { revoked: false } });
    expect((await booted.fetch(get('/probe/project/alpha', bearer))).status).toBe(401);
  });

  it('administers grants, service principals and service tokens, then authenticates the service token', async () => {
    const booted = await boot();
    const cookie = await loginAdmin(booted);
    const made = await booted.fetch(get('/probe/make-project', { cookie }));
    const { created } = (await made.json()) as { created: { id: string } };
    const executor = createD1Executor(booted.raw);
    const [role] = await executor.all<{ id: string }>({
      sql: "SELECT id FROM role WHERE scope = 'project' ORDER BY key LIMIT 1",
      params: [],
    });
    if (role === undefined) throw new Error('no project role');

    const response = await booted.fetch(
      get(`/probe/administer?project=${created.id}&role=${role.id}`, { cookie }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      granted: { ok: boolean; value?: { id: string } };
      principal: { ok: boolean; value?: { id: string; permissions: string[] } };
      issued: { ok: boolean; value?: { id: string; plaintext: string } } | null;
    };
    expect(body.granted.ok).toBe(true);
    expect(body.principal.ok).toBe(true);
    expect(body.principal.value?.permissions).toContain('project:read');
    expect(body.issued?.ok).toBe(true);

    expect(
      await executor.all({
        sql: "SELECT id, role_id FROM access_grant WHERE project_id = ? AND subject_type = 'email' AND subject_value = ?",
        params: [created.id, 'member@example.test'],
      }),
    ).toEqual([{ id: body.granted.value?.id, role_id: role.id }]);
    expect(
      await executor.all({
        sql: 'SELECT project_id, status FROM service_principal WHERE id = ?',
        params: [body.principal.value?.id ?? null],
      }),
    ).toEqual([{ project_id: created.id, status: 'active' }]);
    const stored = await executor.all<{ permission: string }>({
      sql: 'SELECT permission FROM service_principal_permission WHERE service_principal_id = ? ORDER BY permission',
      params: [body.principal.value?.id ?? null],
    });
    expect(stored.map((row) => row.permission)).toEqual(body.principal.value?.permissions);
    expect(
      await executor.all({
        sql: 'SELECT kind, service_principal_id, project_id, revoked_at FROM token WHERE id = ?',
        params: [body.issued?.value?.id ?? null],
      }),
    ).toEqual([
      {
        kind: 'svc',
        service_principal_id: body.principal.value?.id,
        project_id: created.id,
        revoked_at: null,
      },
    ]);

    const plaintext = body.issued?.value?.plaintext ?? '';
    expect(plaintext).toMatch(/^pb_svc_/);
    events.length = 0;
    const served = await booted.fetch(
      get('/probe/project/alpha', { authorization: `Bearer ${plaintext}` }),
    );
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ projectId: created.id });
    expect(events).toEqual(['handler']);
  });

  it('registers no step 5 HTTP resource', async () => {
    await boot();
    const [routes] = kernels.coreRoutes as RouteDefinition[][];
    expect(
      (routes ?? [])
        .map((route) => `${route.method} ${route.path}`)
        .filter((route) => !route.includes('/_pb/auth/')),
    ).toEqual(['GET /_pb/session']);
  });

  it('keeps the token telemetry write off the response and inside waitUntil', async () => {
    const booted = await boot();
    const cookie = await loginAdmin(booted);
    await booted.fetch(get('/probe/make-project', { cookie }));
    const issued = await booted.fetch(get('/probe/make-token', { cookie }));
    const { plaintext } = (await issued.json()) as { plaintext: string };
    events.length = 0;

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.before = (sql) => {
      if (/update\s+"?token"?/i.test(sql) && sql.includes('last_used_at')) {
        events.push('touch-start');
        return gate;
      }
      return undefined;
    };
    const kept: Promise<unknown>[] = [];
    const response = await booted.fetch(
      get('/probe/project/alpha', { authorization: `Bearer ${plaintext}` }),
      { waitUntil: (promise) => void kept.push(promise) },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projectId: expect.any(String) });
    expect(events).toContain('handler');
    expect(events).toContain('touch-start');
    expect(kept).toHaveLength(1);
    let settled = false;
    void Promise.all(kept).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    release();
    await Promise.all(kept);
    expect(settled).toBe(true);
  });

  describe('start-up refusals', () => {
    async function broken(): Promise<unknown> {
      const { raw } = await database();
      const worker = createWorker([plugin], { log: () => undefined });
      const environment = {
        DB: raw,
        PB_MASTER_KEY: KEY,
        PB_PUBLIC_URL: PUBLIC_URL,
      } as unknown as Env;
      const failure = await rejection(worker.services(environment));
      const response = await worker.fetch(get('/_pb/session'), environment);
      expect(response.status).toBeGreaterThanOrEqual(500);
      return failure;
    }

    it('refuses a keyring that cannot derive the token pepper', async () => {
      faults.pepper = true;
      expect(await broken()).toBeInstanceOf(Error);
    });

    it('refuses a missing access repository', async () => {
      faults.access = true;
      expect(await broken()).toBeInstanceOf(Error);
    });

    it('refuses a missing service dependency', async () => {
      faults.tokenReader = true;
      expect(await broken()).toBeInstanceOf(Error);
    });

    it('refuses a missing project repository', async () => {
      faults.projectRepository = true;
      expect(await broken()).toBeInstanceOf(Error);
    });
  });

  it('lists a project granted only through a project grant on project 2501 on the first page', async () => {
    const booted = await boot();
    const org = booted.orgId;
    const userId = ulid();
    const roleId = ulid();
    const stamp = new Date(Date.now() - HOUR).toISOString();
    const seed: Statement[] = [
      {
        sql: 'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
        params: [userId, org, 'reader@example.test', 'active'],
      },
      {
        sql: 'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        params: [org, 'oidc', ANCHOR],
      },
      {
        sql: 'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [ulid(), org, userId, 'oidc', 'reader', 'reader@example.test', 1, stamp],
      },
      {
        sql: 'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
        params: [roleId, org, 'viewer-probe', 'Viewer', 'project'],
      },
      {
        sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        params: [org, roleId, 'project:read'],
      },
    ];
    // Generate the rows inside D1 to avoid thousands of Miniflare prepare/bind RPCs.
    seed.push({
      sql: `WITH RECURSIVE projects(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM projects WHERE n < 2501
      )
      INSERT INTO project (id, org_id, slug, name)
      SELECT '01J0PR0J' || printf('%018d', n), ?, 'p' || n, 'Project ' || n
      FROM projects`,
      params: [org],
    });
    seed.push({
      sql: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      params: [
        ulid(),
        org,
        'email',
        'reader@example.test',
        null,
        'project',
        projectId(2501),
        roleId,
      ],
    });
    const executor = createD1Executor(booted.raw);
    await executor.batch(seed);

    const listed = await services?.projectList.list(
      orgContext(org),
      { kind: 'organization', userId, permissions: new Set(), isOrganizationAdmin: false },
      { limit: 50 },
    );
    expect(listed).toEqual({
      ok: true,
      value: { items: [expect.objectContaining({ slug: 'p2501' })], nextAfterId: null },
    });
  }, 60_000);
});

const apiCall: ApiCall = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};
