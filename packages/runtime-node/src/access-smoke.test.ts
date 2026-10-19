import type { ApiCall } from '@package-broker/core/api/idempotency';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import {
  authenticatedActorOf,
  organizationActorOf,
} from '@package-broker/core/authz/access-context';
import { mutationFence } from '@package-broker/core/authz/fence';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext, type SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { DENIAL_MESSAGE } from '@package-broker/core/kernel/denial-page';
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

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const HOUR = 3_600_000;

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

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0] as string)
    .join('; ');
}

interface Snapshot {
  readonly status: number;
  readonly type: string | null;
  readonly body: string;
}

async function snapshot(response: Response): Promise<Snapshot> {
  const body = (await response.text()).replace(/"requestId":"[^"]*"/, '"requestId":"-"');
  return { status: response.status, type: response.headers.get('content-type'), body };
}

describe('node access smoke over HTTP', () => {
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
      registry.route({
        method: 'GET',
        path: '/probe/org',
        permission: 'org:read',
        boundary: 'organization',
        handler: () => {
          reached.push('org');
          return Response.json({ ok: true });
        },
      });
      registry.route({
        method: 'GET',
        path: '/probe/project/:project',
        permission: 'project:read',
        boundary: 'project',
        handler: (ctx) => {
          reached.push('project');
          return Response.json({ projectId: ctx.projectId });
        },
      });
      registry.route({
        method: 'GET',
        path: '/probe/settings/:project',
        permission: 'project:settings:write',
        boundary: 'project',
        handler: (ctx) => {
          reached.push('settings');
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
          const authenticated = authenticatedActorOf(ctx);
          if (viewed === null || authenticated === null || ctx.org === null || services === null) {
            return new Response(null, { status: 500 });
          }
          const created = await services.projects.createProject(
            ctx.org,
            { ...viewed, permissions: new Set(viewed.permissions) },
            mutationFence(authenticated, {}),
            { slug: 'alpha', name: 'Alpha' },
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
    directory = await mkdtemp(join(tmpdir(), 'pb-access-smoke-'));
    path = join(directory, 'broker.sqlite');
    services = null;
    reached = [];
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

  async function sql(statement: string, params: readonly SqlValue[]): Promise<void> {
    const opened = openBetterSqliteExecutor(path);
    try {
      await opened.executor.all({ sql: statement, params: [...params] });
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

  interface Booted {
    readonly base: string;
    readonly cookie: string;
    get(
      route: string,
      headers?: Record<string, string>,
      method?: 'GET' | 'HEAD',
    ): Promise<Response>;
  }

  async function withProject(): Promise<Booted> {
    const base = await boot();
    const cookie = await loginAdmin(base);
    const get = (route: string, headers: Record<string, string> = {}, method = 'GET') =>
      fetch(`${base}${route}`, { method, headers });
    expect((await get('/probe/make-project', { cookie })).status).toBe(200);
    reached.length = 0;
    return { base, cookie, get };
  }

  async function issueToken(
    booted: Booted,
    scope: 'read' | 'full',
  ): Promise<{ id: string; headers: Record<string, string> }> {
    const issued = await booted.get(`/probe/make-token?scope=${scope}`, { cookie: booted.cookie });
    expect(issued.status).toBe(200);
    const { id, plaintext } = (await issued.json()) as { id: string; plaintext: string };
    expect(plaintext).toMatch(/^pb_pat_/);
    reached.length = 0;
    return { id, headers: { authorization: `Bearer ${plaintext}` } };
  }

  async function unauthorized(booted: Booted): Promise<Snapshot> {
    const anonymous = await snapshot(await booted.get('/probe/project/alpha'));
    expect(anonymous.status).toBe(401);
    expect(anonymous.type).toBe('application/json');
    expect(JSON.parse(anonymous.body)).toMatchObject({ error: { code: 'unauthorized' } });
    return anonymous;
  }

  it('serves an allowed session request and an allowed personal token request', async () => {
    const booted = await withProject();
    const { headers } = await issueToken(booted, 'full');
    const { cookie } = booted;

    expect((await booted.get('/probe/org', { cookie })).status).toBe(200);
    const bySession = await booted.get('/probe/project/alpha', { cookie });
    expect(bySession.status).toBe(200);
    const projectId = ((await bySession.json()) as { projectId: string }).projectId;
    expect(projectId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await booted.get('/probe/org', headers)).status).toBe(200);
    const byToken = await booted.get('/probe/project/alpha', headers);
    expect(await byToken.json()).toEqual({ projectId });
    expect(reached).toEqual(['org', 'project', 'org', 'project']);
  });

  it('refuses anonymous, malformed and unknown credentials with one 401 envelope', async () => {
    const booted = await withProject();
    const anonymous = await unauthorized(booted);
    for (const authorization of ['Bearer pb_pat_bogus', 'Bearer nonsense', 'Basic Zm9vOmJhcg==']) {
      expect(await snapshot(await booted.get('/probe/project/alpha', { authorization }))).toEqual(
        anonymous,
      );
    }
    expect(
      await snapshot(await booted.get('/probe/org', { cookie: '__Host-pb_session=nope' })),
    ).toEqual(anonymous);
    expect(
      await snapshot(
        await booted.get('/probe/org', {
          cookie: booted.cookie,
          authorization: 'Bearer pb_pat_bogus',
        }),
      ),
    ).toEqual(anonymous);
    expect(reached).toEqual([]);
  });

  it('refuses a personal token past the 24 hour validation gate with the uniform 401', async () => {
    const booted = await withProject();
    const { headers } = await issueToken(booted, 'full');
    expect((await booted.get('/probe/project/alpha', headers)).status).toBe(200);
    const anonymous = await unauthorized(booted);
    reached.length = 0;

    await sql('UPDATE local_login SET last_login_at = ?', [
      new Date(Date.now() - 25 * HOUR).toISOString(),
    ]);
    expect(await snapshot(await booted.get('/probe/project/alpha', headers))).toEqual(anonymous);
    expect(await snapshot(await booted.get('/probe/org', headers))).toEqual(anonymous);
    expect(reached).toEqual([]);
  });

  it('refuses a revoked personal token with the uniform 401', async () => {
    const booted = await withProject();
    const { id, headers } = await issueToken(booted, 'full');
    expect((await booted.get('/probe/project/alpha', headers)).status).toBe(200);
    const anonymous = await unauthorized(booted);

    const revoked = await booted.get(`/probe/revoke-token?id=${id}`, { cookie: booted.cookie });
    expect(await revoked.json()).toEqual({ ok: true, value: { revoked: true } });
    reached.length = 0;
    expect(await snapshot(await booted.get('/probe/project/alpha', headers))).toEqual(anonymous);
    expect(reached).toEqual([]);
  });

  it('answers a missing project with the uniform 404 and an insufficient scope with 403', async () => {
    const booted = await withProject();
    const { headers } = await issueToken(booted, 'read');
    const { cookie } = booted;

    const missing = await booted.get('/probe/nowhere', { cookie });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toBe('application/json');
    expect(await missing.clone().json()).toEqual({
      error: {
        code: 'not_found',
        message: 'Route not found',
        requestId: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
      },
    });
    const unknownRoute = await snapshot(missing);
    expect(await snapshot(await booted.get('/probe/project/ghost', headers))).toEqual(unknownRoute);
    expect(await snapshot(await booted.get('/probe/project/ghost', { cookie }))).toEqual(
      unknownRoute,
    );

    const forbidden = await snapshot(
      await booted.get('/probe/settings/alpha', { ...headers, accept: 'application/json' }),
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.type).toBe('application/json');
    expect(JSON.parse(forbidden.body)).toMatchObject({ error: { code: 'forbidden' } });
    expect(forbidden.body).not.toContain('alpha');
    expect(reached).toEqual([]);

    expect((await booted.get('/probe/settings/alpha', { cookie })).status).toBe(200);
    expect(reached).toEqual(['settings']);
  });

  it('returns the static denial page for an HTML acceptance on 403 and the envelope otherwise', async () => {
    const booted = await withProject();
    const { headers } = await issueToken(booted, 'read');
    const browser = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

    const page = await booted.get('/probe/settings/alpha', { ...headers, accept: browser });
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('vary')).toBe('Accept');
    const html = await page.text();
    expect(html).toContain(DENIAL_MESSAGE);
    expect(html).not.toContain('alpha');
    expect(html).not.toContain(EMAIL);

    const api = await booted.get('/probe/settings/alpha', headers);
    expect(api.status).toBe(403);
    expect(api.headers.get('content-type')).toBe('application/json');

    const anonymous = await booted.get('/probe/settings/alpha', { accept: browser });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('content-type')).toBe('application/json');
    expect(reached).toEqual([]);
  });

  it('answers HEAD with the GET status, no body and no authorization bypass', async () => {
    const booted = await withProject();
    const { headers } = await issueToken(booted, 'read');
    const { cookie } = booted;
    const html = { accept: 'text/html' };
    const cases: ReadonlyArray<readonly [string, Record<string, string>, number]> = [
      ['/probe/project/alpha', { cookie }, 200],
      ['/probe/project/alpha', headers, 200],
      ['/probe/project/alpha', {}, 401],
      ['/probe/project/alpha', { authorization: 'Bearer pb_pat_bogus' }, 401],
      ['/probe/settings/alpha', headers, 403],
      ['/probe/settings/alpha', { ...headers, ...html }, 403],
      ['/probe/project/ghost', headers, 404],
    ];
    for (const [route, requestHeaders, status] of cases) {
      const get = await booted.get(route, requestHeaders);
      expect(get.status).toBe(status);
      await get.arrayBuffer();
      reached.length = 0;

      const head = await booted.get(route, requestHeaders, 'HEAD');
      expect(head.status).toBe(status);
      expect(head.headers.get('content-type')).toBe(get.headers.get('content-type'));
      expect(await head.text()).toBe('');
      expect(reached).toEqual(status === 200 ? ['project'] : []);
      reached.length = 0;
    }
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
