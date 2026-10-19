import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { orgContext, type SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import type { NodeAccessServices, NodeBroker } from './index.js';
import { startNode } from './startup.js';

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
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const HOUR = 3_600_000;

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function migrationSources(): Promise<MigrationSource[]> {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] as string)
    .join('; ');
}

describe('step 5 release gate on the node runtime', () => {
  let directory: string;
  let path: string;
  let services: NodeAccessServices | null;
  let reached: string[];
  const running: NodeBroker[] = [];

  const plugin: PluginDefinition = {
    id: 'probe',
    package: '@test/probe',
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
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
          );
          if (!principal.ok) return Response.json({ error: principal.error }, { status: 409 });
          const issued = await services.serviceTokens.issue(
            ctx.org,
            session,
            actor,
            mutationFence(authenticated, {}),
            {
              servicePrincipalId: principal.value.id,
              name: 'ci',
              scope: 'read',
              expiresAt: new Date(Date.now() + 30 * 24 * HOUR).toISOString(),
            },
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
          );
          return Response.json(revoked);
        },
      });
    },
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-step5-gate-'));
    path = join(directory, 'broker.sqlite');
    services = null;
    reached = [];
    engineDeps.seen.length = 0;
  });

  afterEach(async () => {
    for (const broker of running.splice(0)) await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function boot(): Promise<string> {
    const broker = await startNode({
      plugins: [plugin],
      migrations: await migrationSources(),
      env: {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: KEY,
        PB_PUBLIC_URL: 'http://127.0.0.1',
      },
    });
    running.push(broker);
    services = (await broker.services()).access;
    await new Promise<void>((resolve) => broker.server.listen(0, '127.0.0.1', resolve));
    const { port } = broker.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async function sql<T extends object = object>(
    statement: string,
    params: readonly SqlValue[] = [],
  ): Promise<T[]> {
    const opened = openBetterSqliteExecutor(path);
    try {
      return await opened.executor.all<T>({ sql: statement, params: [...params] });
    } finally {
      await opened.close();
    }
  }

  async function seedAdmin(): Promise<string> {
    const opened = openBetterSqliteExecutor(path);
    try {
      const org = await createOrganizationBootstrap(opened.executor).findSingleton();
      if (org === null) throw new Error('organization missing');
      const token = randomBytes(32).toString('base64url');
      const roleIds = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, ulid()])) as Record<
        DefaultRoleKey,
        string
      >;
      const now = new Date();
      await bootstrapAdmin(opened.executor, orgContext(org.id), {
        email: EMAIL,
        userId: ulid(),
        setupHash: createHash('sha256').update(token).digest('hex'),
        setupExpiresAt: new Date(now.getTime() + HOUR).toISOString(),
        grantId: ulid(),
        roleIds,
        opId: ulid(),
        now: now.toISOString(),
      });
      return token;
    } finally {
      await opened.close();
    }
  }

  function post(
    base: string,
    route: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1', ...headers },
      body: JSON.stringify(body),
    });
  }

  async function loginAdmin(base: string): Promise<string> {
    const token = await seedAdmin();
    const started = await post(base, '/_pb/auth/local/setup/start', { token });
    const { secret } = (await started.json()) as { secret: string };
    const totpSecret = base32Decode(secret);
    const serverStep = (response: Response): number => {
      const timestamp = Date.parse(response.headers.get('date') ?? '');
      expect(Number.isFinite(timestamp)).toBe(true);
      return Math.floor(timestamp / 30_000);
    };
    const postTotp = async (
      previous: Response,
      offset: number,
      route: string,
      body: Record<string, string>,
      headers: Record<string, string> = {},
    ): Promise<Response> => {
      const step = serverStep(previous);
      const send = (codeStep: number) =>
        totpCode(totpSecret, codeStep).then((code) =>
          post(base, route, { ...body, code }, headers),
        );
      const response = await send(step + offset);
      if (response.status === 401 && serverStep(response) === step + 1) {
        await response.arrayBuffer();
        return send(step + offset + 1);
      }
      return response;
    };
    const finished = await postTotp(started, -1, '/_pb/auth/local/setup/finish', {
      token,
      password: PASSWORD,
    });
    expect(finished.status).toBe(204);
    const login = await postTotp(finished, 0, '/_pb/auth/local/login', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(login.status).toBe(204);
    const cookie = cookieHeader(login);
    const csrf = /__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
    const reauth = await postTotp(
      login,
      1,
      '/_pb/auth/local/reauth',
      { password: PASSWORD },
      { cookie, 'x-csrf-token': csrf },
    );
    expect(reauth.status).toBe(204);
    return cookie;
  }

  interface Fixture {
    readonly cookie: string;
    readonly alphaId: string;
    readonly betaId: string;
    readonly pat: { readonly id: string; readonly headers: Record<string, string> };
    readonly readPat: { readonly id: string; readonly headers: Record<string, string> };
    readonly svc: { readonly id: string; readonly headers: Record<string, string> };
    get(route: string, headers?: Record<string, string>): Promise<Response>;
  }

  async function assemble(): Promise<Fixture> {
    const base = await boot();
    const cookie = await loginAdmin(base);
    const get = (route: string, headers: Record<string, string> = {}) =>
      fetch(`${base}${route}`, { headers });
    const json = async <T>(route: string): Promise<T> => {
      const response = await get(route, { cookie });
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    };
    const alpha = await json<{ id: string }>('/probe/make-project?slug=alpha');
    const beta = await json<{ id: string }>('/probe/make-project?slug=beta');
    const token = async (route: string) => {
      const { id, plaintext } = await json<{ id: string; plaintext: string }>(route);
      return { id, plaintext, headers: { authorization: `Bearer ${plaintext}` } };
    };
    const pat = await token('/probe/make-token?scope=full');
    const readPat = await token('/probe/make-token?scope=read');
    const svc = await token(`/probe/make-service-token?project=${alpha.id}`);
    expect(pat.plaintext).toMatch(/^pb_pat_/);
    expect(svc.plaintext).toMatch(/^pb_svc_/);
    reached.length = 0;
    return {
      cookie,
      alphaId: alpha.id,
      betaId: beta.id,
      pat: { id: pat.id, headers: pat.headers },
      readPat: { id: readPat.id, headers: readPat.headers },
      svc: { id: svc.id, headers: svc.headers },
      get,
    };
  }

  async function code(response: Response): Promise<string> {
    return ((await response.json()) as { error: { code: string } }).error.code;
  }

  it('composes the engine with the token-use gate and the PAT validation gate and resolves every service', async () => {
    const fixture = await assemble();
    expect(fixture.alphaId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    const names = Object.keys(services ?? {}).sort();
    expect(names).toEqual([
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
    const org = await get('/probe/org', svc.headers);
    expect([403, 404]).toContain(org.status);
    expect((await get('/probe/org-write', svc.headers)).status).not.toBe(200);
    expect(reached).toEqual([]);
  });

  it('refuses a revoked personal token and a revoked service token with the uniform 401', async () => {
    const { cookie, pat, svc, get } = await assemble();
    const anonymous = await get('/probe/project/alpha');
    expect(anonymous.status).toBe(401);
    const anonymousBody = await anonymous.text();

    for (const token of [pat, svc]) {
      expect((await get('/probe/project/alpha', token.headers)).status).toBe(200);
      const revoked = await get(`/probe/revoke-token?id=${token.id}`, { cookie });
      expect(await revoked.json()).toEqual({ ok: true, value: { revoked: true } });
      reached.length = 0;
      const refused = await get('/probe/project/alpha', token.headers);
      expect(refused.status).toBe(401);
      expect((await refused.text()).replace(/"requestId":"[^"]*"/, '')).toBe(
        anonymousBody.replace(/"requestId":"[^"]*"/, ''),
      );
      expect(reached).toEqual([]);
    }
  });

  it('refuses a personal token past the 24 hour validation gate while a service token is unaffected', async () => {
    const { pat, svc, get } = await assemble();
    expect((await get('/probe/org', pat.headers)).status).toBe(200);
    await sql('UPDATE local_login SET last_login_at = ?', [
      new Date(Date.now() - 25 * HOUR).toISOString(),
    ]);
    reached.length = 0;

    expect((await get('/probe/org', pat.headers)).status).toBe(401);
    expect((await get('/probe/project/alpha', pat.headers)).status).toBe(401);
    expect(reached).toEqual([]);
    expect((await get('/probe/project/alpha', svc.headers)).status).toBe(200);
  });

  it('records last use through the token-use gate off the response path', async () => {
    const { pat, get } = await assemble();
    const used = () =>
      sql<{ last_used_at: string | null }>('SELECT last_used_at FROM token WHERE id = ?', [pat.id]);
    expect(await used()).toEqual([{ last_used_at: null }]);

    expect((await get('/probe/org', pat.headers)).status).toBe(200);
    await vi.waitFor(async () => {
      const [row] = await used();
      expect(row?.last_used_at).not.toBeNull();
    });
  });
});
