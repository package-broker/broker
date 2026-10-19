import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newSessionSecrets } from '@package-broker/core/auth/session';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import {
  accessContextOf,
  authenticatedActorOf,
  organizationActorOf,
} from '@package-broker/core/authz/access-context';
import { mutationFence } from '@package-broker/core/authz/fence';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import type { DependencyClosureReport } from '@package-broker/core/catalogue/closure-report';
import type { DistRequest } from '@package-broker/core/catalogue/package-access';
import type { ProjectActor } from '@package-broker/core/authz/project-actor';
import type { ApiCall } from '@package-broker/core/api/idempotency';
import { orgContext, type SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { resolvedPackageOf } from '@package-broker/core/kernel/package-context';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import type { NodeAccessServices, NodeBroker, NodeCatalogueServices } from './index.js';
import { startNode } from './startup.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const OWNER_EMAIL = 'owner@example.test';
const HOUR = 3_600_000;
const ANCHOR = 'oidc:https://idp.example.test';
const PUBLISHED = '2026-01-01T00:00:00.000Z';

const digest = (label: string) => createHash('sha256').update(label).digest('hex');

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

function auditCall(requestId: string): ApiCall {
  return { audit: { opId: ulid(), requestId, sourceIp: null, tokenSelector: null } };
}

describe('step 6 release gate on the node runtime', () => {
  let directory: string;
  let path: string;
  let access: NodeAccessServices | null;
  let packages: NodeCatalogueServices | null;
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
        displayName: 'Fixture',
        trustAnchor: ANCHOR,
        policy: {
          verifiedDomains: ['example.test'],
          emailAuthoritativeDomains: ['example.test'],
          autoJoin: false,
        },
        supportsReauth: false,
        start: () => Promise.resolve({ kind: 'direct' }),
        finish: () => Promise.resolve({ ok: false, reason: 'provider_error' }),
      },
    ],
    register(registry) {
      registry.route({
        method: 'GET',
        path: '/probe/make-project',
        permission: 'org:projects:create',
        boundary: 'organization',
        handler: async (ctx) => {
          const viewed = organizationActorOf(ctx);
          const authenticated = authenticatedActorOf(ctx);
          if (viewed === null || authenticated === null || ctx.org === null || access === null) {
            return new Response(null, { status: 500 });
          }
          const slug = new URL(ctx.request.url).searchParams.get('slug') ?? 'alpha';
          const created = await access.projects.createProject(
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
        path: '/probe/visibility/:project',
        permission: 'project:read',
        boundary: 'project',
        handler: async (ctx) => {
          const actor = authenticatedActorOf(ctx);
          if (actor === null || ctx.org === null || packages === null) {
            return new Response(null, { status: 500 });
          }
          const query = new URL(ctx.request.url).searchParams;
          const operation = query.get('op') as 'attachSource';
          const input = JSON.parse(query.get('input') ?? '{}') as {
            projectId: string;
            sourceId: string;
          };
          return Response.json(
            await packages.visibility[operation](ctx.org, mutationFence(actor, {}), input),
          );
        },
      });
      registry.route({
        method: 'GET',
        path: '/probe/:project/catalogue/:name',
        permission: 'project:packages:read',
        boundary: 'project',
        handler: async (ctx) => {
          const snapshot = accessContextOf(ctx);
          if (
            ctx.org === null ||
            ctx.projectId === null ||
            snapshot?.actor == null ||
            packages === null
          ) {
            return new Response(null, { status: 500 });
          }
          const actor: ProjectActor = {
            kind: 'project',
            userId: snapshot.actor.user.id,
            orgId: ctx.org.orgId,
            projectId: ctx.projectId,
            permissions: new Set([
              ...snapshot.actor.organizationPermissions,
              ...snapshot.actor.projectPermissions,
            ]),
          };
          const name = ctx.params['name'] ?? '';
          if (name === 'closure') {
            return Response.json(
              await packages.closureReport(
                actor,
                new Set(snapshot.actor.organizationPermissions),
                'composer',
              ),
            );
          }
          const input = JSON.parse(
            new URL(ctx.request.url).searchParams.get('input') ?? '{}',
          ) as DistRequest;
          const result =
            new URL(ctx.request.url).searchParams.get('surface') === 'version' &&
            input.by === 'version'
              ? await packages.packageAccess.version(
                  actor,
                  'composer',
                  name,
                  input.versionNormalized,
                )
              : await packages.packageAccess.dist(actor, 'composer', name, input);
          return result === null ? new Response(null, { status: 404 }) : Response.json(result);
        },
      });
      for (const mode of ['read', 'fetch']) {
        registry.route({
          method: 'GET',
          path: `/probe/:project/${mode}/:name`,
          permission: 'project:packages:read',
          boundary: 'package',
          package: {
            ecosystem: 'composer',
            name: (params) => params['name'] ?? null,
            fetchOnAdmission: mode === 'fetch',
          },
          handler: (ctx) => Response.json(resolvedPackageOf(ctx)),
        });
      }
    },
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-step6-gate-'));
    path = join(directory, 'broker.sqlite');
    access = null;
    packages = null;
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
    const services = await broker.services();
    access = services.access;
    packages = services.packages;
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

  async function seedProjectOwner(orgId: string, projectId: string): Promise<string> {
    const userId = ulid();
    const secrets = await newSessionSecrets();
    const now = new Date().toISOString();
    const [role] = await sql<{ id: string }>(
      "SELECT id FROM role WHERE org_id = ? AND key = 'project_owner'",
      [orgId],
    );
    await sql('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', [
      userId,
      orgId,
      OWNER_EMAIL,
    ]);
    await sql('INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)', [
      orgId,
      'oidc',
      ANCHOR,
    ]);
    await sql(
      'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
      [ulid(), orgId, userId, 'oidc', 'owner', OWNER_EMAIL, now],
    );
    await sql(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, 'email', ?, 'project', ?, ?)",
      [ulid(), orgId, OWNER_EMAIL, projectId, role?.id ?? ''],
    );
    await sql(
      'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        ulid(),
        orgId,
        userId,
        secrets.secretHash,
        secrets.csrfHash,
        new Date(Date.now() + HOUR).toISOString(),
      ],
    );
    return `__Host-pb_session=${secrets.secret}; __Host-pb_csrf=${secrets.csrf}`;
  }

  async function seedSource(
    orgId: string,
    name: string,
    type: string,
    projectId: string | null = null,
  ): Promise<string> {
    const id = ulid();
    await sql(
      'INSERT INTO source (id, org_id, project_id, name, ecosystem, type) VALUES (?, ?, ?, ?, ?, ?)',
      [id, orgId, projectId, name, 'composer', type],
    );
    return id;
  }

  async function seedPackage(
    orgId: string,
    sourceId: string,
    name: string,
    version: string,
    options: { flag?: 0 | 1; requires?: Record<string, string> } = {},
  ): Promise<{ packageId: string; versionId: string; sha256: string }> {
    const packageId = ulid();
    const versionId = ulid();
    const blobId = ulid();
    const sha256 = digest(`${sourceId}/${name}/${version}`);
    await sql(
      'INSERT INTO package (id, org_id, source_id, ecosystem, name, visible_to_new_projects) VALUES (?, ?, ?, ?, ?, ?)',
      [packageId, orgId, sourceId, 'composer', name, options.flag ?? 1],
    );
    await sql(
      'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
      [blobId, orgId, sha256, `blob/${sha256}`],
    );
    await sql(
      `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
         published_at_basis, blob_id, dist_type, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, 'import_time', ?, 'zip', ?)`,
      [
        versionId,
        orgId,
        packageId,
        version,
        version,
        PUBLISHED,
        blobId,
        JSON.stringify({ require: options.requires ?? {} }),
      ],
    );
    return { packageId, versionId, sha256 };
  }

  it('assembles the catalogue, the project subset and default visibility through public entry points', async () => {
    const base = await boot();
    const cookie = await loginAdmin(base);
    const call = (route: string, headers: Record<string, string> = { cookie }) =>
      fetch(`${base}${route}`, { headers });
    const json = async <T>(route: string): Promise<T> => {
      const response = await call(route);
      expect(response.status).toBe(200);
      return (await response.json()) as T;
    };
    const visibility = async (
      slug: string,
      headers: Record<string, string>,
      op: string,
      input: object,
    ) =>
      (await (
        await call(
          `/probe/visibility/${slug}?op=${op}&input=${encodeURIComponent(JSON.stringify(input))}`,
          headers,
        )
      ).json()) as { ok: boolean; error?: string };
    const [{ id: orgId }] = (await sql<{ id: string }>('SELECT id FROM organization')) as [
      { id: string },
    ];
    const epoch = async () =>
      (
        await sql<{ version: string }>('SELECT version FROM cache_epoch WHERE org_id = ?', [orgId])
      )[0]?.version;
    const catalogue = packages as NodeCatalogueServices;
    const actorFor = (projectId: string): ProjectActor => ({
      kind: 'project',
      userId: ulid(),
      orgId: orgContext(orgId).orgId,
      projectId,
      permissions: new Set(['project:packages:read']),
    });
    const resolve = (slug: string, name: string, mode = 'read') =>
      call(`/probe/${slug}/${mode}/${encodeURIComponent(name)}`);

    const a = (await json<{ id: string }>('/probe/make-project?slug=alpha')).id;
    const priv = await seedSource(orgId, 'private', 'composer_repository');
    const proxy = await seedSource(orgId, 'proxy', 'packagist_proxy');
    const own = await seedSource(orgId, 'alpha-own', 'composer_repository', a);
    const privX = await seedPackage(orgId, priv, 'acme/x', '1.0.0', {
      requires: { 'vendor/missing': '^1' },
    });
    const hidden = await seedPackage(orgId, priv, 'acme/hidden', '1.0.0', { flag: 0 });
    const proxyX = await seedPackage(orgId, proxy, 'acme/x', '9.0.0');
    const ownX = await seedPackage(orgId, own, 'acme/x', '2.0.0');
    const ownOnly = await seedPackage(orgId, own, 'acme/a-only', '1.0.0', {
      requires: { 'acme/a-secret': '^1' },
    });
    for (const sourceId of [priv, proxy, own]) {
      expect(
        await visibility('alpha', { cookie }, 'attachSource', { projectId: a, sourceId }),
      ).toEqual(expect.objectContaining({ ok: true }));
    }
    const b = (await json<{ id: string }>('/probe/make-project?slug=beta')).id;
    expect(
      await sql(
        'SELECT source_id, precedence FROM project_source WHERE org_id = ? AND project_id = ?',
        [orgId, b],
      ),
    ).toEqual(
      expect.arrayContaining([
        { source_id: priv, precedence: 100 },
        { source_id: proxy, precedence: 1000 },
      ]),
    );
    const actorA = actorFor(a);
    const actorB = actorFor(b);

    const winnerA = await resolve('alpha', 'acme/x');
    expect(await winnerA.json()).toMatchObject({ kind: 'visible', pkg: { sourceId: own } });
    const winnerB = await resolve('beta', 'acme/x', 'fetch');
    expect(await winnerB.json()).toMatchObject({ kind: 'visible', pkg: { sourceId: priv } });
    const versionsB = await catalogue.packageAccess.versions(actorB, 'composer', 'acme/x', {
      limit: 10,
    });
    expect(
      versionsB !== null && 'versions' in versionsB && versionsB.versions.map((v) => v.version),
    ).toEqual(['1.0.0']);
    expect(proxyX.packageId).not.toBe(privX.packageId);

    const distA = await catalogue.packageAccess.dist(actorA, 'composer', 'acme/x', {
      by: 'version',
      versionNormalized: '2.0.0',
    });
    expect(distA?.blob?.sha256).toBe(ownX.sha256);
    const distB = await catalogue.packageAccess.dist(actorB, 'composer', 'acme/x', {
      by: 'version',
      versionNormalized: '1.0.0',
    });
    expect(distB?.blob?.sha256).toBe(privX.sha256);
    for (const request of [
      { by: 'version', versionNormalized: '2.0.0' },
      { by: 'id', versionId: ownX.versionId, revision: 1 },
      { by: 'id', versionId: proxyX.versionId, revision: 1 },
    ] as const) {
      expect(await catalogue.packageAccess.dist(actorB, 'composer', 'acme/x', request)).toBeNull();
    }
    expect(
      await catalogue.packageAccess.dist(actorA, 'composer', 'acme/x', {
        by: 'version',
        versionNormalized: '1.0.0',
      }),
    ).toBeNull();
    expect(
      await catalogue.packageAccess.dist(actorA, 'composer', 'acme/x', {
        by: 'version',
        versionNormalized: '2.0.0',
        expect: { versionId: ownX.versionId, revision: 99 },
      }),
    ).toBeNull();

    const distRoute = (slug: string, request: DistRequest) =>
      `/probe/${slug}/catalogue/${encodeURIComponent('acme/x')}?input=${encodeURIComponent(JSON.stringify(request))}`;
    const publicDistA = await call(
      distRoute('alpha', { by: 'id', versionId: ownX.versionId, revision: 1 }),
    );
    expect(publicDistA.status).toBe(200);
    expect(await publicDistA.json()).toMatchObject({ blob: { sha256: ownX.sha256 } });
    for (const request of [
      { by: 'id', versionId: ownX.versionId, revision: 1 },
      { by: 'id', versionId: proxyX.versionId, revision: 1 },
      {
        by: 'version',
        versionNormalized: '1.0.0',
        expect: { versionId: privX.versionId, revision: 99 },
      },
    ] as const) {
      expect((await call(distRoute('beta', request))).status).toBe(404);
    }

    const refused = await resolve('beta', 'acme/hidden', 'fetch');
    expect(refused.status).toBe(404);
    const missing = await resolve('beta', 'acme/never-seen');
    expect(missing.status).toBe(404);
    const strip = async (response: Response) =>
      (await response.text()).replace(/"requestId":"[^"]*"/, '');
    expect(await strip(refused)).toBe(await strip(missing));
    expect(await catalogue.packageAccess.resolve(actorB, 'composer', 'acme/hidden')).toEqual({
      kind: 'absent',
    });
    const admitted = await resolve('beta', 'acme/fresh', 'fetch');
    expect(await admitted.json()).toMatchObject({ kind: 'proxy_admissible', sourceIds: [proxy] });

    const extra = await seedSource(orgId, 'extra', 'composer_repository');
    const owner = { cookie: await seedProjectOwner(orgId, b) };
    expect(
      await visibility('beta', owner, 'attachSource', { projectId: b, sourceId: extra }),
    ).toEqual({
      ok: false,
      error: 'not_found',
    });
    expect(
      await sql(
        'SELECT 1 FROM project_source WHERE org_id = ? AND project_id = ? AND source_id = ?',
        [orgId, b, extra],
      ),
    ).toEqual([]);
    expect(
      await visibility('beta', owner, 'addExplicit', { projectId: b, packageId: hidden.packageId }),
    ).toEqual({ ok: false, error: 'forbidden' });
    expect(
      await visibility('beta', owner, 'addPattern', {
        projectId: b,
        sourceId: priv,
        pattern: 'acme/hidden',
        effect: 'include',
      }),
    ).toEqual(expect.objectContaining({ ok: true }));
    expect((await resolve('beta', 'acme/hidden')).status).toBe(404);
    expect(
      await visibility('beta', owner, 'removePattern', {
        projectId: b,
        sourceId: priv,
        pattern: 'acme/hidden',
      }),
    ).toEqual(expect.objectContaining({ ok: true }));
    expect((await resolve('beta', 'acme/x')).status).toBe(200);

    const publicClosure = await call('/probe/beta/catalogue/closure', owner);
    expect(publicClosure.status).toBe(200);
    const publicReportB = (await publicClosure.json()) as DependencyClosureReport;
    expect(publicReportB.missing.map((entry) => [entry.name, entry.status])).toEqual([
      ['vendor/missing', 'not_available'],
    ]);
    expect(JSON.stringify(publicReportB)).not.toMatch(/a-only|a-secret/);
    const reportB = await catalogue.closureReport(actorB, new Set(), 'composer');
    expect(reportB.missing.map((entry) => [entry.name, entry.status])).toEqual([
      ['vendor/missing', 'not_available'],
    ]);
    expect(JSON.stringify(reportB)).not.toMatch(/a-only|a-secret/);
    const reportA = await catalogue.closureReport(actorA, new Set(), 'composer');
    expect(reportA.missing.map((entry) => entry.name)).toContain('acme/a-secret');

    const before = await epoch();
    expect(
      await visibility('beta', owner, 'addPattern', {
        projectId: b,
        sourceId: priv,
        pattern: 'acme/x',
        effect: 'exclude',
      }),
    ).toEqual(expect.objectContaining({ ok: true }));
    expect(await epoch()).not.toBe(before);
    expect((await resolve('beta', 'acme/x')).status).toBe(404);
    expect(await catalogue.packageAccess.resolve(actorB, 'composer', 'acme/x')).toEqual({
      kind: 'absent',
    });
    expect((await resolve('alpha', 'acme/x')).status).toBe(200);

    expect(
      (await catalogue.packageAccess.version(actorA, 'composer', 'acme/a-only', '1.0.0'))?.version
        .versionId,
    ).toBe(ownOnly.versionId);
    const quarantineRoute = (surface: 'version' | 'dist') =>
      `/probe/alpha/catalogue/${encodeURIComponent('acme/a-only')}?surface=${surface}&input=${encodeURIComponent(JSON.stringify({ by: 'version', versionNormalized: '1.0.0' }))}`;
    const publicVersion = await call(quarantineRoute('version'));
    expect(publicVersion.status).toBe(200);
    expect(await publicVersion.json()).toMatchObject({ version: { versionId: ownOnly.versionId } });
    const publicDist = await call(quarantineRoute('dist'));
    expect(publicDist.status).toBe(200);
    expect(await publicDist.json()).toMatchObject({ blob: { sha256: ownOnly.sha256 } });
    const beforeQuarantine = await epoch();
    expect(
      await visibility('alpha', { cookie }, 'quarantineVersion', {
        versionId: ownOnly.versionId,
        reason: 'admin_quarantine',
      }),
    ).toEqual(expect.objectContaining({ ok: true }));
    expect(await epoch()).not.toBe(beforeQuarantine);
    expect((await call(quarantineRoute('version'))).status).toBe(404);
    expect((await call(quarantineRoute('dist'))).status).toBe(404);
    expect(
      await catalogue.packageAccess.version(actorA, 'composer', 'acme/a-only', '1.0.0'),
    ).toBeNull();
    expect(
      await catalogue.packageAccess.dist(actorA, 'composer', 'acme/a-only', {
        by: 'version',
        versionNormalized: '1.0.0',
      }),
    ).toBeNull();
  });
});
