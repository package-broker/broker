import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { resolvedPackageOf } from '@package-broker/core/kernel/package-context';
import { definePlugin, SUPPORTED_PLUGIN_API } from '@package-broker/core/plugin';
import type { PluginDefinition, RequestContext } from '@package-broker/core/plugin';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createWorker, type Env } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const PUBLIC_URL = 'https://broker.test';
const PASSWORD = 'correct horse battery staple 42';
const EMAIL = 'admin@example.test';
const HOUR = 3_600_000;

const bindings = Array.from({ length: 8 }, (_, index) => `CWDB${index}`);
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

async function migrationSources(): Promise<MigrationSource[]> {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
}

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`${PUBLIC_URL}${path}`, init);
}

function post(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: PUBLIC_URL, ...headers },
    body: JSON.stringify(body),
  });
}

const admissionHandler = vi.fn((ctx: RequestContext) =>
  Response.json({ admission: resolvedPackageOf(ctx) }),
);
const plainHandler = vi.fn(() => Response.json({ plain: true }));

const plugin: PluginDefinition = definePlugin({
  id: 'probe',
  package: '@test/probe',
  apiVersion: SUPPORTED_PLUGIN_API[0],
  platforms: ['cloudflare'],
  register(registry) {
    registry.route({
      method: 'GET',
      path: '/probe/:project/packages/:name',
      permission: 'project:packages:read',
      boundary: 'package',
      package: { ecosystem: 'composer', name: (params) => params.name ?? null },
      handler: () => Response.json({ ok: true }),
    });
    registry.route({
      method: 'GET',
      path: '/probe/:project/admit/:name',
      permission: 'project:packages:read',
      boundary: 'package',
      package: {
        ecosystem: 'composer',
        name: (params) => params.name ?? null,
        fetchOnAdmission: true,
      },
      handler: admissionHandler,
    });
    registry.route({
      method: 'GET',
      path: '/probe/:project/plain/:name',
      permission: 'project:packages:read',
      boundary: 'package',
      package: { ecosystem: 'composer', name: (params) => params.name ?? null },
      handler: plainHandler,
    });
  },
});

async function boot() {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const raw = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(raw);
  await migrate(executor, await migrationSources(), { holder: 'catalogue-wiring-test' });
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
  const seed = async (sql: string, params: (string | number | null)[]) => {
    const results = await executor.batch([{ sql, params }]);
    if (/^INSERT INTO project_package \(/i.test(sql)) expect(results[0]?.changes).toBe(1);
    return results;
  };
  await seed('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
    'P1',
    orgId,
    'p1',
    'P1',
  ]);
  await seed(
    'INSERT INTO source (id, org_id, project_id, name, ecosystem, type, removal_policy) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    ['S1', orgId, 'S1', 'composer', 'composer_repository', 'flag'],
  );
  await seed(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    [orgId, 'P1', 'S1', 100],
  );
  await seed(
    'INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)',
    ['K1', orgId, 'S1', 'composer', 'acme/lib'],
  );
  await seed(
    'INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) SELECT input.org_id, input.project_id, input.package_id, input.origin, p.ecosystem, p.name FROM (SELECT ? AS org_id, ? AS project_id, ? AS package_id, ? AS origin) AS input JOIN package AS p ON p.org_id = input.org_id AND p.id = input.package_id',
    [orgId, 'P1', 'K1', 'subscription'],
  );
  await seed(
    `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
                          published_at_basis, metadata_json)
     VALUES ('V1', ?, 'K1', '1.0.0', '1.0.0', '2020-01-01T00:00:00.000Z', 'import_time', '{}')`,
    [orgId],
  );
  await seed(
    'INSERT INTO source (id, org_id, project_id, name, ecosystem, type, removal_policy) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    ['PX1', orgId, 'PX1', 'composer', 'packagist_proxy', 'flag'],
  );
  await seed(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
    [orgId, 'P1', 'PX1', 1000],
  );
  await seed('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
    'P2',
    orgId,
    'p2',
    'P2',
  ]);
  const environment = { DB: raw, PB_MASTER_KEY: KEY, PB_PUBLIC_URL: PUBLIC_URL } as unknown as Env;
  const worker = createWorker([plugin], { log: () => undefined });
  const fetch = (input: Request) => worker.fetch(input, environment);

  const started = await fetch(post('/_pb/auth/local/setup/start', { token }));
  const { secret } = (await started.json()) as { secret: string };
  const totpSecret = base32Decode(secret);
  const step = Math.floor(Date.now() / 30_000);
  await fetch(
    post('/_pb/auth/local/setup/finish', {
      token,
      password: PASSWORD,
      code: await totpCode(totpSecret, step - 1),
    }),
  );
  const login = await fetch(
    post('/_pb/auth/local/login', {
      email: EMAIL,
      password: PASSWORD,
      code: await totpCode(totpSecret, step),
    }),
  );
  const cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .join('; ');
  return { worker, environment, fetch, cookie, orgId };
}

describe('cloudflare catalogue wiring on Miniflare D1', () => {
  it('exposes the catalogue services over D1 and none without a database binding', async () => {
    const { worker, environment } = await boot();
    const { packages } = await worker.services(environment);
    expect(Object.keys(packages ?? {}).sort()).toEqual([
      'closureReport',
      'packageAccess',
      'reader',
      'visibility',
      'writer',
    ]);
    expect(Object.keys(packages?.writer.statementBudget ?? {})).toContain('syncPackage');
    expect(Object.keys(packages?.visibility ?? {})).toContain('attachSource');

    const bare = createWorker([], { log: () => undefined });
    expect((await bare.services({} as Env)).packages).toBeNull();
  });

  it('serves a visible package (200)', async () => {
    const { fetch, cookie } = await boot();
    const response = await fetch(request('/probe/p1/packages/acme%2Flib', { headers: { cookie } }));
    expect(response.status).toBe(200);
  });

  it('answers invisible packages with one uniform 404', async () => {
    const { fetch, cookie } = await boot();
    const absent = await fetch(request('/probe/p1/plain/acme%2Fmissing', { headers: { cookie } }));
    const unattached = await fetch(
      request('/probe/p2/packages/acme%2Flib', { headers: { cookie } }),
    );
    const unknown = await fetch(
      request('/probe/p1/packages/acme%2Fother', { headers: { cookie } }),
    );
    expect(absent.status).toBe(404);
    const strip = async (r: Response) => (await r.text()).replace(/"requestId":"[^"]*"/, '');
    expect(await strip(unattached)).toBe(await strip(unknown));
    expect(unattached.status).toBe(404);
    expect(unknown.status).toBe(404);
  });

  it('refuses an unauthenticated request (401)', async () => {
    const { fetch } = await boot();
    expect((await fetch(request('/probe/p1/packages/acme%2Flib'))).status).toBe(401);
    expect((await fetch(request('/probe/p1/admit/acme%2Fnew'))).status).toBe(401);
  });

  it('hands an admissible unseen package to a fetchOnAdmission route and not to a plain one', async () => {
    const { fetch, cookie } = await boot();
    admissionHandler.mockClear();
    plainHandler.mockClear();
    const admitted = await fetch(request('/probe/p1/admit/acme%2Fnew', { headers: { cookie } }));
    expect(admitted.status).toBe(200);
    expect(await admitted.json()).toEqual({
      admission: {
        kind: 'proxy_admissible',
        projectId: 'P1',
        ecosystem: 'composer',
        key: 'acme/new',
        sourceIds: ['PX1'],
      },
    });
    expect(admissionHandler).toHaveBeenCalledTimes(1);
    admissionHandler.mockClear();
    expect(
      (await fetch(request('/probe/p1/plain/acme%2Fnew', { headers: { cookie } }))).status,
    ).toBe(404);
    expect(plainHandler).not.toHaveBeenCalled();
    expect(
      (await fetch(request('/probe/p2/admit/acme%2Fnew', { headers: { cookie } }))).status,
    ).toBe(404);
    expect(admissionHandler).not.toHaveBeenCalled();
  });

  it('builds the closure report from the composed reader and refuses an actor without packages:read', async () => {
    const { worker, environment, orgId } = await boot();
    const { packages } = await worker.services(environment);
    const actor = (permissions: string[]) => ({
      kind: 'project' as const,
      userId: ulid(),
      orgId: orgId as never,
      projectId: 'P1',
      permissions: new Set(permissions),
    });
    const report = await packages!.closureReport(
      actor(['project:packages:read']),
      new Set<string>(),
      'composer',
    );
    expect(report).toMatchObject({ projectId: 'P1', ecosystem: 'composer', scannedPackages: 1 });
    await expect(packages!.closureReport(actor([]), new Set<string>(), 'composer')).rejects.toThrow(
      'forbidden',
    );
  });
});
