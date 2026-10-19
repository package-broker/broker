import type { ApiCall } from '@package-broker/core/api/idempotency';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import { createKeyring, type Keyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { runEntry } from './entry.js';
import { createNodeServer, type NodeAccessServices, type NodeBroker } from './index.js';
import { startNode } from './startup.js';

const hooks = vi.hoisted(() => ({
  before: undefined as ((sql: string) => Promise<void> | undefined) | undefined,
  seen: [] as string[],
}));
const faults = vi.hoisted(() => ({
  access: false,
  tokenReader: false,
  projectRepository: false,
}));

vi.mock('./db/better-sqlite3-executor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db/better-sqlite3-executor.js')>();
  return {
    ...actual,
    openBetterSqliteExecutor: (path: string, options?: { readonly busyTimeoutMs?: number }) => {
      const opened = actual.openBetterSqliteExecutor(path, options);
      const inner = opened.executor;
      return {
        close: opened.close,
        executor: {
          ...inner,
          all: async (statement: Statement) => {
            hooks.seen.push(statement.sql);
            await hooks.before?.(statement.sql);
            return inner.all(statement);
          },
          batch: inner.batch.bind(inner),
        },
      };
    },
  };
});

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

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const ANCHOR = 'oidc:https://idp.example.test';
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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
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

describe('node access wiring', () => {
  let directory: string;
  let path: string;
  let services: NodeAccessServices | null;
  let events: string[];
  const running: NodeBroker[] = [];

  const plugin: PluginDefinition = {
    id: 'probe',
    package: '@test/probe',
    apiVersion: SUPPORTED_PLUGIN_API[0],
    platforms: ['node'],
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
          const fence = mutationFence(authenticated, {});
          const created = await services.projects.createProject(ctx.org, actor, fence, {
            slug: 'alpha',
            name: 'Alpha',
          });
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
          const projectId = query.get('project') ?? '';
          const actor = { ...viewed, permissions: new Set(viewed.permissions) };
          const granted = await services.projectGrants.grant(
            ctx.org,
            {
              kind: 'project',
              userId: actor.userId,
              orgId: ctx.org.orgId,
              projectId,
              permissions: actor.permissions,
            },
            mutationFence(authenticated, {}),
            projectId,
            {
              subject: { type: 'email', value: 'member@example.test' },
              roleId: query.get('role') ?? '',
            },
          );
          const principal = await services.servicePrincipals.create(
            ctx.org,
            actor,
            mutationFence(authenticated, {}),
            { name: 'deploy', projectId },
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
                  routeProjectId: projectId,
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
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-access-wiring-'));
    path = join(directory, 'broker.sqlite');
    services = null;
    events = [];
    hooks.before = undefined;
    hooks.seen.length = 0;
    faults.access = false;
    faults.tokenReader = false;
    faults.projectRepository = false;
  });

  afterEach(async () => {
    hooks.before = undefined;
    for (const broker of running.splice(0)) await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function start(port: number): Promise<{ broker: NodeBroker; base: string }> {
    const base = `http://127.0.0.1:${port}`;
    const broker = await startNode({
      plugins: [plugin],
      migrations: await migrationSources(),
      env: {
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: KEY,
        PB_PUBLIC_URL: base,
      },
    });
    running.push(broker);
    services = (await broker.services()).access;
    await new Promise<void>((resolve) => broker.server.listen(port, '127.0.0.1', resolve));
    return { broker, base };
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

  function post(base: string, route: string, body: unknown): Promise<Response> {
    return fetch(`${base}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify(body),
    });
  }

  async function loginAdmin(base: string): Promise<string> {
    const token = await seedAdmin();
    const started = await post(base, '/_pb/auth/local/setup/start', { token });
    const { secret } = (await started.json()) as { secret: string };
    const totpSecret = base32Decode(secret);
    const step = Math.floor(Date.now() / 30_000);
    const finished = await post(base, '/_pb/auth/local/setup/finish', {
      token,
      password: PASSWORD,
      code: await totpCode(totpSecret, step - 1),
    });
    expect(finished.status).toBe(204);
    const login = await post(base, '/_pb/auth/local/login', {
      email: EMAIL,
      password: PASSWORD,
      code: await totpCode(totpSecret, step),
    });
    expect(login.status).toBe(204);
    const cookie = cookieHeader([login]);
    const csrf = /__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
    const reauth = await fetch(`${base}/_pb/auth/local/reauth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ password: PASSWORD, code: await totpCode(totpSecret, step + 1) }),
    });
    expect(reauth.status).toBe(204);
    return cookie;
  }

  async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it('boots with the engine and every service and serves a protected route through them', async () => {
    const { base } = await start(await freePort());
    const cookie = await loginAdmin(base);

    expect((await fetch(`${base}/probe/org`)).status).toBe(401);
    const allowed = await fetch(`${base}/probe/org`, { headers: { cookie } });
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

  it('assembles the catalogue resolver over the runtime database', async () => {
    const { broker } = await start(await freePort());
    const { catalogue } = await broker.services();
    const opened = openBetterSqliteExecutor(path);
    const org = await createOrganizationBootstrap(opened.executor).findSingleton();
    await opened.close();
    if (org === null) throw new Error('organization missing');

    expect(
      await catalogue.resolveVersions(orgContext(org.id), {
        projectId: projectId(1),
        ecosystem: 'composer',
        key: 'acme/missing',
        limit: 10,
      }),
    ).toBeNull();
  });

  it('revokes an own personal token through the assembled revoke service', async () => {
    const { base } = await start(await freePort());
    const cookie = await loginAdmin(base);
    await fetch(`${base}/probe/make-project`, { headers: { cookie } });
    const issued = await fetch(`${base}/probe/make-token`, { headers: { cookie } });
    const { id, plaintext } = (await issued.json()) as { id: string; plaintext: string };
    const bearer = { authorization: `Bearer ${plaintext}` };
    expect((await fetch(`${base}/probe/project/alpha`, { headers: bearer })).status).toBe(200);

    const revoked = await fetch(`${base}/probe/revoke-token?id=${id}`, { headers: { cookie } });
    expect(await revoked.json()).toEqual({ ok: true, value: { revoked: true } });
    const again = await fetch(`${base}/probe/revoke-token?id=${id}`, { headers: { cookie } });
    expect(await again.json()).toEqual({ ok: true, value: { revoked: false } });
    expect((await fetch(`${base}/probe/project/alpha`, { headers: bearer })).status).toBe(401);
  });

  it('serves the protected route through the engine from the source entry in process (runEntry + startNode)', async () => {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const exits: number[] = [];
    const errors: string[] = [];
    let started: NodeBroker | undefined;
    await runEntry(
      Promise.resolve({ plugins: [plugin], migrations: await migrationSources() }),
      {
        PORT: String(port),
        PB_SQLITE_PATH: path,
        PB_ORG_SLUG: 'acme',
        PB_ORG_NAME: 'Acme',
        PB_MASTER_KEY: KEY,
        PB_PUBLIC_URL: base,
      },
      {
        start: async (options) => {
          started = await startNode(options);
          running.push(started);
          return started;
        },
        exit: (code) => exits.push(code),
        error: (message) => errors.push(message),
        onSignal: () => undefined,
      },
    );
    expect(errors).toEqual([]);
    expect(exits).toEqual([]);
    await vi.waitFor(() => expect(started?.server.listening).toBe(true));
    services = (await (started as NodeBroker).services()).access;

    expect((await fetch(`${base}/health/ready`)).status).toBe(200);
    expect((await fetch(`${base}/_pb/auth/providers`)).status).toBe(200);
    expect((await fetch(`${base}/_pb/session`)).status).toBe(401);
    const anonymous = await fetch(`${base}/probe/org`);
    expect(anonymous.status).toBe(401);
    expect(
      (await fetch(`${base}/probe/org`, { headers: { authorization: 'Bearer pb_pat_bogus' } }))
        .status,
    ).toBe(401);
    const cookie = await loginAdmin(base);
    expect((await fetch(`${base}/probe/org`, { headers: { cookie } })).status).toBe(200);
    await fetch(`${base}/probe/make-project`, { headers: { cookie } });
    const issued = await fetch(`${base}/probe/make-token`, { headers: { cookie } });
    const { plaintext } = (await issued.json()) as { plaintext: string };
    expect(
      (
        await fetch(`${base}/probe/project/alpha`, {
          headers: { authorization: `Bearer ${plaintext}` },
        })
      ).status,
    ).toBe(200);
    expect(events.filter((event) => event === 'handler')).toHaveLength(2);
  });

  it('resolves project and token services from the runtime with a real fence', async () => {
    const { base } = await start(await freePort());
    const cookie = await loginAdmin(base);

    const made = await fetch(`${base}/probe/make-project`, { headers: { cookie } });
    expect(made.status).toBe(200);
    expect(((await made.json()) as { listed: string[] }).listed).toEqual(['alpha']);

    const issued = await fetch(`${base}/probe/make-token`, { headers: { cookie } });
    expect(issued.status).toBe(200);
    const body = (await issued.json()) as { plaintext: string; listed: string[] };
    expect(body.listed).toEqual(['probe']);
    expect(body.plaintext).toMatch(/^pb_pat_/);
  });

  it('administers project grants, service principals and service tokens through real fences', async () => {
    const { base } = await start(await freePort());
    const cookie = await loginAdmin(base);
    const made = await fetch(`${base}/probe/make-project`, { headers: { cookie } });
    const { created } = (await made.json()) as { created: { id: string } };
    let issuedPlaintext: string;
    const opened = openBetterSqliteExecutor(path);
    try {
      const [role] = await opened.executor.all<{ id: string }>({
        sql: "SELECT id FROM role WHERE scope = 'project' ORDER BY key LIMIT 1",
        params: [],
      });
      if (role === undefined) throw new Error('no project role');

      const response = await fetch(
        `${base}/probe/administer?project=${created.id}&role=${role.id}`,
        { headers: { cookie } },
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
      issuedPlaintext = body.issued?.value?.plaintext ?? '';

      const grants = await opened.executor.all<{ id: string; role_id: string }>({
        sql: "SELECT id, role_id FROM access_grant WHERE project_id = ? AND subject_type = 'email' AND subject_value = ?",
        params: [created.id, 'member@example.test'],
      });
      expect(grants).toEqual([{ id: body.granted.value?.id, role_id: role.id }]);
      const principals = await opened.executor.all<{ project_id: string; status: string }>({
        sql: 'SELECT project_id, status FROM service_principal WHERE id = ?',
        params: [body.principal.value?.id ?? null],
      });
      expect(principals).toEqual([{ project_id: created.id, status: 'active' }]);
      const stored = await opened.executor.all<{ permission: string }>({
        sql: 'SELECT permission FROM service_principal_permission WHERE service_principal_id = ? ORDER BY permission',
        params: [body.principal.value?.id ?? null],
      });
      expect(stored.map((row) => row.permission)).toEqual(body.principal.value?.permissions);
      const tokens = await opened.executor.all<{
        kind: string;
        service_principal_id: string;
        project_id: string;
        revoked_at: string | null;
      }>({
        sql: 'SELECT kind, service_principal_id, project_id, revoked_at FROM token WHERE id = ?',
        params: [body.issued?.value?.id ?? null],
      });
      expect(tokens).toEqual([
        {
          kind: 'svc',
          service_principal_id: body.principal.value?.id,
          project_id: created.id,
          revoked_at: null,
        },
      ]);
    } finally {
      await opened.close();
    }

    const plaintext = issuedPlaintext;
    expect(plaintext).toMatch(/^pb_svc_/);
    events.length = 0;
    const served = await fetch(`${base}/probe/project/alpha`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(served.status).toBe(200);
    expect(await served.json()).toEqual({ projectId: created.id });
    expect(events).toEqual(['handler']);
  });

  it('registers no step 5 HTTP resource', async () => {
    const { broker } = await start(await freePort());
    const kernel = await broker.ready();

    const routes = [...kernel.coreRoutes, ...kernel.registration.routes].map(
      (route) => `${route.method} ${route.path}`,
    );
    expect(
      routes.filter((route) => !route.includes('/_pb/auth/') && !route.includes('/probe/')),
    ).toEqual(['GET /_pb/session']);
  });

  it('does not block the response on the token telemetry write', async () => {
    const { base } = await start(await freePort());
    const cookie = await loginAdmin(base);
    await fetch(`${base}/probe/make-project`, { headers: { cookie } });
    const issued = await fetch(`${base}/probe/make-token`, { headers: { cookie } });
    const { plaintext } = (await issued.json()) as { plaintext: string };
    events.length = 0;
    hooks.seen.length = 0;

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    hooks.before = (sql) => {
      if (/update\s+"token"/i.test(sql) && sql.includes('last_used_at')) {
        events.push('touch-start');
        return gate;
      }
      return undefined;
    };

    const response = await fetch(`${base}/probe/project/alpha`, {
      headers: { authorization: `Bearer ${plaintext}` },
    });
    expect(response.status).toBe(200);
    expect(events[0]).toBe('handler');
    await vi.waitFor(() => expect(events).toContain('touch-start'));
    release();
  });

  describe('start-up refusals', () => {
    async function broken(keyring: Keyring): Promise<unknown> {
      const opened = openBetterSqliteExecutor(path);
      const broker = createNodeServer([], {
        executor: opened.executor,
        closeDatabase: opened.close,
        log: () => undefined,
        auth: { keyring, publicOrigin: 'http://127.0.0.1', env: {} },
      });
      running.push(broker);
      return rejection(broker.ready());
    }

    const keyring = (): Keyring => createKeyring([parseMasterKey(KEY, 'PB_MASTER_KEY')]);

    it('refuses a keyring that cannot derive the token pepper', async () => {
      const real = keyring();
      const failure = await broken({
        ...real,
        currentVersion: real.currentVersion,
        versions: real.versions,
        aesKey: real.aesKey.bind(real),
        hmacKey: (purpose, version) =>
          purpose === 'token-pepper'
            ? Promise.reject(new Error('no pepper'))
            : real.hmacKey(purpose, version),
      });
      expect(failure).toBeInstanceOf(Error);
    });

    it('refuses a missing access repository', async () => {
      faults.access = true;
      expect(await broken(keyring())).toBeInstanceOf(Error);
    });

    it('refuses a missing service dependency', async () => {
      faults.tokenReader = true;
      expect(await broken(keyring())).toBeInstanceOf(Error);
    });

    it('refuses a missing project repository', async () => {
      faults.projectRepository = true;
      expect(await broken(keyring())).toBeInstanceOf(Error);
    });
  });

  it('lists a project granted only through a project grant on project 2501 on the first page', async () => {
    const { base } = await start(await freePort());
    await loginAdmin(base);
    const opened = openBetterSqliteExecutor(path);
    try {
      const org = await createOrganizationBootstrap(opened.executor).findSingleton();
      if (org === null) throw new Error('organization missing');
      const ctx = orgContext(org.id);
      const userId = ulid();
      const identityId = ulid();
      const roleId = ulid();
      const stamp = new Date(Date.now() - HOUR).toISOString();
      const seed: Statement[] = [
        {
          sql: 'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
          params: [userId, org.id, 'reader@example.test', 'active'],
        },
        {
          sql: 'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
          params: [org.id, 'oidc', ANCHOR],
        },
        {
          sql: 'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          params: [identityId, org.id, userId, 'oidc', 'reader', 'reader@example.test', 1, stamp],
        },
        {
          sql: 'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
          params: [roleId, org.id, 'viewer-probe', 'Viewer', 'project'],
        },
        {
          sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          params: [org.id, roleId, 'project:read'],
        },
      ];
      for (let n = 1; n <= 2501; n += 1) {
        seed.push({
          sql: 'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
          params: [projectId(n), org.id, `p${n}`, `Project ${n}`],
        });
      }
      seed.push({
        sql: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [
          ulid(),
          org.id,
          'email',
          'reader@example.test',
          null,
          'project',
          projectId(2501),
          roleId,
        ],
      });
      for (let i = 0; i < seed.length; i += 500)
        await opened.executor.batch(seed.slice(i, i + 500));

      const listed = await services?.projectList.list(
        ctx,
        { kind: 'organization', userId, permissions: new Set(), isOrganizationAdmin: false },
        { limit: 50 },
      );
      expect(listed).toEqual({
        ok: true,
        value: { items: [expect.objectContaining({ slug: 'p2501' })], nextAfterId: null },
      });
    } finally {
      await opened.close();
    }
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
