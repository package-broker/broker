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
import type {
  AuthorizationEngineDeps,
  createAuthorizationEngine as CreateAuthorizationEngine,
} from '@package-broker/core/authz/engine';
import { mutationFence } from '@package-broker/core/authz/fence';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import type { ApiCall } from '@package-broker/core/api/idempotency';
import { ulid } from '@package-broker/core/ids';
import { definePlugin, SUPPORTED_PLUGIN_API } from '@package-broker/core/plugin';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createWorker, type Env, type WorkerAccessServices } from './index.js';

const engineDeps = vi.hoisted(() => ({ seen: [] as unknown[] }));

vi.mock('@package-broker/core/authz/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@package-broker/core/authz/engine')>();
  return {
    ...actual,
    createAuthorizationEngine: (deps: AuthorizationEngineDeps) => {
      engineDeps.seen.push(deps);
      return actual.createAuthorizationEngine(deps);
    },
  };
});

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PUBLIC_URL = 'https://broker.test';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const HOUR = 3_600_000;

const bindings = Array.from({ length: 8 }, (_, index) => `S5DB${index}`);
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

function auditCall(requestId: string): ApiCall {
  return { audit: { opId: ulid(), requestId, sourceIp: null, tokenSelector: null } };
}

describe('step 5 release gate on Miniflare D1', () => {
  let services: WorkerAccessServices | null;
  let reached: string[];

  const plugin: PluginDefinition = definePlugin({
    id: 'probe',
    package: '@test/probe',
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['cloudflare'],
    register(registry) {
      const mark = (name: string, body: Record<string, unknown> = {}) => {
        reached.push(name);
        return Response.json({ ok: true, ...body });
      };
      registry.route({
        method: 'GET',
        path: '/probe/org',
        permission: 'org:read',
        boundary: 'organization',
        handler: () => mark('org'),
      });
      registry.route({
        method: 'GET',
        path: '/probe/org-write',
        permission: 'org:projects:create',
        boundary: 'organization',
        handler: () => mark('org-write'),
      });
      registry.route({
        method: 'GET',
        path: '/probe/project/:project',
        permission: 'project:read',
        boundary: 'project',
        handler: (ctx) => mark('project', { projectId: ctx.projectId }),
      });
      registry.route({
        method: 'GET',
        path: '/probe/settings/:project',
        permission: 'project:settings:write',
        boundary: 'project',
        handler: (ctx) => mark('settings', { projectId: ctx.projectId }),
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
          const slug = new URL(ctx.request.url).searchParams.get('slug') ?? 'alpha';
          const created = await services.projects.createProject(
            ctx.org,
            { ...viewed, permissions: new Set(viewed.permissions) },
            mutationFence(authenticated, {}),
            { slug, name: slug },
            auditCall(ctx.requestId),
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
            auditCall(ctx.requestId),
          );
          if (!issued.ok) return Response.json({ error: issued.error }, { status: 409 });
          return Response.json({ id: issued.value.id, plaintext: issued.value.plaintext });
        },
      });
      registry.route({
        method: 'GET',
        path: '/probe/make-service-token',
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
          const projectId = new URL(ctx.request.url).searchParams.get('project') ?? '';
          const actor = { ...viewed, permissions: new Set(viewed.permissions) };
          const principal = await services.servicePrincipals.create(
            ctx.org,
            actor,
            mutationFence(authenticated, {}),
            { name: 'deploy', projectId },
            auditCall(ctx.requestId),
          );
          if (!principal.ok) return Response.json({ error: principal.error }, { status: 409 });
          const issued = await services.serviceTokens.issue(
            ctx.org,
            session,
            actor,
            mutationFence(authenticated, {}),
            {
              servicePrincipalId: principal.value.id,
              routeProjectId: projectId,
              name: 'ci',
              scope: 'read',
              expiresAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
            },
            auditCall(ctx.requestId),
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
              via: 'organization',
            },
            auditCall(ctx.requestId),
          );
          return Response.json(revoked);
        },
      });
    },
  });

  beforeEach(() => {
    services = null;
    reached = [];
    engineDeps.seen.length = 0;
  });

  interface Booted {
    readonly fetch: (
      request: Request,
      ctx?: { waitUntil(promise: Promise<unknown>): void },
    ) => Promise<Response>;
    readonly raw: D1DatabaseLike;
    readonly orgId: string;
    readonly token: string;
  }

  async function boot(): Promise<Booted> {
    const binding = bindings[next];
    next += 1;
    if (binding === undefined) throw new Error('out of D1 bindings');
    const raw = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
    const executor = createD1Executor(raw);
    await migrate(executor, await migrationSources(), { holder: 'step5-gate-test' });
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
    const environment = {
      DB: raw,
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

  interface Fixture {
    readonly booted: Booted;
    readonly cookie: string;
    readonly pat: { readonly id: string; readonly headers: Record<string, string> };
    readonly readPat: { readonly id: string; readonly headers: Record<string, string> };
    readonly svc: { readonly id: string; readonly headers: Record<string, string> };
    get(path: string, headers?: Record<string, string>): Promise<Response>;
  }

  async function assemble(): Promise<Fixture> {
    const booted = await boot();
    const cookie = await loginAdmin(booted);
    const send = (path: string, headers: Record<string, string> = {}) =>
      booted.fetch(get(path, headers));
    const json = async <T>(path: string): Promise<T> => {
      const response = await send(path, { cookie });
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    };
    const alpha = await json<{ id: string }>('/probe/make-project?slug=alpha');
    await json<{ id: string }>('/probe/make-project?slug=beta');
    const token = async (path: string) => {
      const { id, plaintext } = await json<{ id: string; plaintext: string }>(path);
      return { id, plaintext, headers: { authorization: `Bearer ${plaintext}` } };
    };
    const pat = await token('/probe/make-token?scope=full');
    const readPat = await token('/probe/make-token?scope=read');
    const svc = await token(`/probe/make-service-token?project=${alpha.id}`);
    expect(pat.plaintext).toMatch(/^pb_pat_/);
    expect(svc.plaintext).toMatch(/^pb_svc_/);
    reached.length = 0;
    return {
      booted,
      cookie,
      pat: { id: pat.id, headers: pat.headers },
      readPat: { id: readPat.id, headers: readPat.headers },
      svc: { id: svc.id, headers: svc.headers },
      get: send,
    };
  }

  async function code(response: Response): Promise<string> {
    return ((await response.json()) as { error: { code: string } }).error.code;
  }

  it('composes the engine with the token-use gate and the PAT validation gate and resolves every service', async () => {
    await assemble();

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
    for (const value of Object.values(services ?? {})) {
      expect(typeof value).toBe('object');
      expect(value).not.toBeNull();
    }
    expect(typeof services?.engine.authorize).toBe('function');

    expect(engineDeps.seen).toHaveLength(1);
    const deps = engineDeps.seen[0] as AuthorizationEngineDeps;
    const { patValidationGate } = await import('@package-broker/core/authz/engine');
    expect(deps.patValidation).toBe(patValidationGate);
    expect(typeof deps.tokenUse.dispatch).toBe('function');
    expect(typeof deps.tokenUse.nowMs).toBe('function');
    expect(deps.tokenUse.keyring).toBeDefined();

    const { createAuthorizationEngine } = await vi.importActual<{
      createAuthorizationEngine: typeof CreateAuthorizationEngine;
    }>('@package-broker/core/authz/engine');
    const withoutUse = { ...deps, tokenUse: undefined };
    expect(() =>
      createAuthorizationEngine(withoutUse as unknown as AuthorizationEngineDeps),
    ).toThrow(/token-use gate/);
    const withoutPat = { ...deps, patValidation: undefined };
    expect(() =>
      createAuthorizationEngine(withoutPat as unknown as AuthorizationEngineDeps),
    ).toThrow(/PAT validation gate/);
    expect(() =>
      createAuthorizationEngine({
        ...deps,
        patValidation: { decide: () => ({ allowed: true }) } as never,
      }),
    ).toThrow();
  });

  it('serves and refuses a session on the organization and the project boundary', async () => {
    const { cookie, get } = await assemble();
    expect((await get('/probe/org', { cookie })).status).toBe(200);
    expect((await get('/probe/project/alpha', { cookie })).status).toBe(200);
    expect((await get('/probe/org-write', { cookie })).status).toBe(200);
    expect(reached).toEqual(['org', 'project', 'org-write']);
    reached.length = 0;

    const org = await get('/probe/org', { cookie: '__Host-pb_session=nope' });
    expect(org.status).toBe(401);
    expect(await code(org)).toBe('unauthorized');
    expect((await get('/probe/project/alpha')).status).toBe(401);
    expect((await get('/probe/project/ghost', { cookie })).status).toBe(404);
    expect(reached).toEqual([]);
  });

  it('serves and refuses a personal token on the organization and the project boundary', async () => {
    const { pat, readPat, get } = await assemble();
    expect((await get('/probe/org', pat.headers)).status).toBe(200);
    expect((await get('/probe/project/alpha', pat.headers)).status).toBe(200);
    expect((await get('/probe/project/beta', pat.headers)).status).toBe(200);
    expect(reached).toEqual(['org', 'project', 'project']);
    reached.length = 0;

    expect((await get('/probe/org-write', pat.headers)).status).toBe(403);
    expect((await get('/probe/org-write', readPat.headers)).status).toBe(403);
    expect((await get('/probe/settings/alpha', readPat.headers)).status).toBe(403);
    expect((await get('/probe/project/ghost', pat.headers)).status).toBe(404);
    const altered = (pat.headers.authorization ?? '').replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect((await get('/probe/org', { authorization: altered })).status).toBe(401);
    expect(reached).toEqual([]);
  });

  it('serves and refuses a service token on the project boundary and keeps it out of other boundaries', async () => {
    const { svc, get } = await assemble();
    expect((await get('/probe/project/alpha', svc.headers)).status).toBe(200);
    expect(reached).toEqual(['project']);
    reached.length = 0;

    expect((await get('/probe/project/beta', svc.headers)).status).toBe(404);
    expect((await get('/probe/settings/alpha', svc.headers)).status).toBe(403);
    expect([403, 404]).toContain((await get('/probe/org', svc.headers)).status);
    expect((await get('/probe/org-write', svc.headers)).status).not.toBe(200);
    expect(reached).toEqual([]);
  });

  it('refuses a revoked personal token and a revoked service token with the uniform 401', async () => {
    const { cookie, pat, svc, get } = await assemble();
    const anonymous = await get('/probe/project/alpha');
    expect(anonymous.status).toBe(401);
    const anonymousBody = (await anonymous.text()).replace(/"requestId":"[^"]*"/, '');

    for (const token of [pat, svc]) {
      expect((await get('/probe/project/alpha', token.headers)).status).toBe(200);
      const revoked = await get(`/probe/revoke-token?id=${token.id}`, { cookie });
      expect(await revoked.json()).toEqual({ ok: true, value: { revoked: true } });
      reached.length = 0;
      const refused = await get('/probe/project/alpha', token.headers);
      expect(refused.status).toBe(401);
      expect((await refused.text()).replace(/"requestId":"[^"]*"/, '')).toBe(anonymousBody);
      expect(reached).toEqual([]);
    }
  });

  it('refuses a personal token past the 24 hour validation gate while a service token is unaffected', async () => {
    const { booted, pat, svc, get } = await assemble();
    expect((await get('/probe/org', pat.headers)).status).toBe(200);
    await createD1Executor(booted.raw).all({
      sql: 'UPDATE local_login SET last_login_at = ? WHERE org_id = ?',
      params: [new Date(Date.now() - 25 * HOUR).toISOString(), booted.orgId],
    });
    reached.length = 0;

    expect((await get('/probe/org', pat.headers)).status).toBe(401);
    expect((await get('/probe/project/alpha', pat.headers)).status).toBe(401);
    expect(reached).toEqual([]);
    expect((await get('/probe/project/alpha', svc.headers)).status).toBe(200);
  });

  it('records last use through the token-use gate inside waitUntil', async () => {
    const { booted, pat } = await assemble();
    const executor = createD1Executor(booted.raw);
    const used = () =>
      executor.all<{ last_used_at: string | null }>({
        sql: 'SELECT last_used_at FROM token WHERE id = ?',
        params: [pat.id],
      });
    expect(await used()).toEqual([{ last_used_at: null }]);

    const kept: Promise<unknown>[] = [];
    const response = await booted.fetch(get('/probe/org', pat.headers), {
      waitUntil: (promise) => void kept.push(promise),
    });
    expect(response.status).toBe(200);
    expect(kept).toHaveLength(1);
    await Promise.all(kept);
    const [row] = await used();
    expect(row?.last_used_at).not.toBeNull();
  });
});
