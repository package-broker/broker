import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
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

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['APDB0', 'APDB1', 'APDB2', 'APDB3'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

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

function request(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  return new Request(`${PUBLIC_URL}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      origin: PUBLIC_URL,
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function boot(binding: string) {
  const raw = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(raw);
  await migrate(executor, await migrationSources(), { holder: 'api-pat-test' });
  const orgId = ulid();
  const now = new Date();
  await createOrganizationBootstrap(executor).bootstrap({
    id: orgId,
    slug: 'acme',
    name: 'Acme',
    now: now.toISOString(),
  });
  const setup = randomBytes(32).toString('base64url');
  const roleIds = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, ulid()])) as Record<
    DefaultRoleKey,
    string
  >;
  await bootstrapAdmin(executor, orgContext(orgId), {
    email: EMAIL,
    userId: ulid(),
    setupHash: createHash('sha256').update(setup).digest('hex'),
    setupExpiresAt: new Date(now.getTime() + HOUR).toISOString(),
    grantId: ulid(),
    roleIds,
    opId: ulid(),
    now: now.toISOString(),
  });
  const env = { DB: raw, PB_MASTER_KEY: KEY, PB_PUBLIC_URL: PUBLIC_URL } as unknown as Env;
  const worker = createWorker([], { log: () => undefined });
  const call = (input: Request) => worker.fetch(input, env);

  const started = await call(
    request('/_pb/auth/local/setup/start', { method: 'POST', body: { token: setup } }),
  );
  const { secret } = (await started.json()) as { secret: string };
  const totpSecret = base32Decode(secret);
  const step = Math.floor(Date.now() / 30_000);
  const finished = await call(
    request('/_pb/auth/local/setup/finish', {
      method: 'POST',
      body: { token: setup, password: PASSWORD, code: await totpCode(totpSecret, step - 1) },
    }),
  );
  expect(finished.status).toBe(204);
  const signedIn = await call(
    request('/_pb/auth/local/login', {
      method: 'POST',
      body: { email: EMAIL, password: PASSWORD, code: await totpCode(totpSecret, step) },
    }),
  );
  expect(signedIn.status).toBe(204);
  const cookie = cookieHeader([signedIn]);
  const csrf = /__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  const reauth = await call(
    request('/_pb/auth/local/reauth', {
      method: 'POST',
      body: { password: PASSWORD, code: await totpCode(totpSecret, step + 1) },
      headers: { cookie, 'x-csrf-token': csrf },
    }),
  );
  expect(reauth.status).toBe(204);

  return { call, executor, cookie, csrf, orgId };
}

describe('Workers management API personal access token lifecycle', () => {
  it('stages a write-only Packagist bearer credential before enabling token mode', async () => {
    const { call, executor, cookie, csrf, orgId } = await boot('APDB3');
    const send = (route: string, method: string, body?: unknown) =>
      call(
        request(route, {
          method,
          body,
          headers: { cookie, 'x-csrf-token': csrf },
        }),
      );

    const created = await send('/_pb/sources', 'POST', {
      name: 'Packagist',
      ecosystem: 'composer',
      type: 'packagist_proxy',
      url: 'https://repo.packagist.org',
      config: { githubToken: false },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const target = `/_pb/sources/${id}`;
    const storedConfig = async () => {
      const rows = await executor.all<{ config_json: string }>({
        sql: 'SELECT config_json FROM source WHERE org_id = ? AND id = ?',
        params: [orgId, id],
      });
      return JSON.parse(rows[0]!.config_json) as unknown;
    };
    const enable = () => send(target, 'PATCH', { config: { githubToken: true } });
    const missing = await enable();
    expect(missing.status).toBe(400);
    const secret = 'github-token-T972-sentinel';
    const credential = (kind: string, material: unknown) =>
      send(`${target}/credential`, 'PUT', { kind, material: JSON.stringify(material) });
    const wrong = await credential('http_basic', { username: 'user', password: secret });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).not.toContain(secret);
    const afterRejectedCredential = await send('/_pb/sources', 'GET');
    expect(afterRejectedCredential.status).toBe(200);
    const unchanged = (await afterRejectedCredential.json()) as {
      items: { id: string; hasCredential: boolean }[];
    };
    expect(unchanged.items.find((item) => item.id === id)).toMatchObject({
      hasCredential: false,
    });
    const saved = await credential('bearer', { token: secret });
    expect(saved.status).toBe(204);
    expect(await saved.text()).toBe('');
    expect(await storedConfig()).toEqual({ githubToken: false });
    expect((await enable()).status).toBe(204);
    expect(await storedConfig()).toEqual({ githubToken: true });
    expect((await credential('bearer', { token: `${secret}-rotated` })).status).toBe(204);
    const listed = await send('/_pb/sources', 'GET');
    expect(listed.status).toBe(200);
    const text = await listed.text();
    expect(text).not.toContain(secret);
    const { items } = JSON.parse(text) as { items: { id: string; hasCredential: boolean }[] };
    expect(items.find((item) => item.id === id)).toMatchObject({ hasCredential: true });
    expect((await send(target, 'PATCH', { config: { githubToken: false } })).status).toBe(204);
    expect(await storedConfig()).toEqual({ githubToken: false });
    expect((await enable()).status).toBe(204);
    expect(await storedConfig()).toEqual({ githubToken: true });
  });

  it('issues a token, uses it on a management route, revokes it and then gets 401', async () => {
    const { call, executor, cookie, csrf } = await boot('APDB0');
    const issued = await call(
      request('/_pb/me/tokens', {
        method: 'POST',
        body: { name: 'laptop', scope: 'read', projectMode: 'all', projectIds: [] },
        headers: { cookie, 'x-csrf-token': csrf, 'idempotency-key': ulid() },
      }),
    );
    expect(issued.status).toBe(201);
    const { id, token } = (await issued.json()) as { id: string; token: string };
    expect(token).toMatch(/^pb_pat_/);
    const bearer = { authorization: `Bearer ${token}` };

    expect((await call(request('/_pb/projects', { headers: bearer }))).status).toBe(200);
    const pending = async () =>
      (
        await executor.all<{ action: string }>({
          sql: 'SELECT action FROM audit_pending ORDER BY created_at',
          params: [],
        })
      ).map((row) => row.action);
    expect(await pending()).toEqual([
      'setup.complete',
      'session.login',
      'session.reauth',
      'token.issue',
    ]);

    const revoked = await call(
      request(`/_pb/me/tokens/${id}`, {
        method: 'DELETE',
        headers: { cookie, 'x-csrf-token': csrf },
      }),
    );
    expect(revoked.status).toBe(204);
    expect((await call(request('/_pb/projects', { headers: bearer }))).status).toBe(401);
    expect(await pending()).toEqual([
      'setup.complete',
      'session.login',
      'session.reauth',
      'token.issue',
      'token.revoke',
    ]);
  });

  it('reorders the real attachment set while a project-owned source stays unattached', async () => {
    const { call, executor, cookie, csrf } = await boot('APDB1');
    const write = { cookie, 'x-csrf-token': csrf };
    const created = await call(
      request('/_pb/projects', {
        method: 'POST',
        body: { slug: 'alpha', name: 'Alpha' },
        headers: write,
      }),
    );
    expect(created.status).toBe(201);
    const { id: projectId } = (await created.json()) as { id: string };
    const [org] = await executor.all<{ id: string }>({
      sql: 'SELECT id FROM organization',
      params: [],
    });
    const orgId = org?.id ?? '';
    const [first, second, owned] = [ulid(), ulid(), ulid()];
    const rows: [string, string | null][] = [
      [first, null],
      [second, null],
      [owned, projectId],
    ];
    await executor.batch([
      ...rows.map(([id, owner]) => ({
        sql: "INSERT INTO source (id, org_id, name, ecosystem, type, project_id) VALUES (?, ?, ?, 'composer', 'composer_repository', ?)",
        params: [id, orgId, id, owner],
      })),
      ...[first, second].map((id, precedence) => ({
        sql: 'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
        params: [orgId, projectId, id, precedence],
      })),
    ]);
    const read = await call(request('/_pb/projects/alpha', { headers: write }));
    expect(read.status).toBe(200);
    const etag = read.headers.get('etag') ?? '';
    expect(etag).not.toBe('');
    const reordered = await call(
      request('/_pb/projects/alpha/sources/order', {
        method: 'PUT',
        body: { sourceIds: [second, first] },
        headers: { ...write, 'if-match': etag },
      }),
    );
    expect(reordered.status).toBe(204);
  });

  it('attaches and detaches an organization source over the real store with audit rows', async () => {
    const { call, executor, cookie, csrf } = await boot('APDB2');
    const write = { cookie, 'x-csrf-token': csrf };
    const slugs = ['alpha', 'beta'];
    const ids: string[] = [];
    for (const slug of slugs) {
      const created = await call(
        request('/_pb/projects', {
          method: 'POST',
          body: { slug, name: slug },
          headers: write,
        }),
      );
      expect(created.status).toBe(201);
      ids.push(((await created.json()) as { id: string }).id);
    }
    const [org] = await executor.all<{ id: string }>({
      sql: 'SELECT id FROM organization',
      params: [],
    });
    const [source, foreign] = [ulid(), ulid()];
    await executor.batch(
      (
        [
          [source, null],
          [foreign, ids[1] ?? ''],
        ] as [string, string | null][]
      ).map(([id, owner]) => ({
        sql: "INSERT INTO source (id, org_id, name, ecosystem, type, project_id) VALUES (?, ?, ?, 'composer', 'composer_repository', ?)",
        params: [id, org?.id ?? '', id, owner],
      })),
    );
    const target = (id: string) => `/_pb/projects/alpha/sources/${id}/attachment`;
    const listed = async () =>
      (
        (await (await call(request('/_pb/projects/alpha/sources', { headers: write }))).json()) as {
          items: { id: string }[];
        }
      ).items.map((item) => item.id);
    expect(await listed()).not.toContain(source);

    const put = (id: string) =>
      call(request(target(id), { method: 'PUT', body: {}, headers: write }));
    expect((await put(source)).status).toBe(204);
    expect(await listed()).toContain(source);
    expect((await put(source)).status).toBe(204);
    expect((await put(foreign)).status).toBe(404);

    const del = () => call(request(target(source), { method: 'DELETE', headers: write }));
    expect((await del()).status).toBe(204);
    expect(await listed()).not.toContain(source);
    expect((await del()).status).toBe(404);

    const actions = (
      await executor.all<{ action: string }>({
        sql: 'SELECT action FROM audit_pending ORDER BY created_at',
        params: [],
      })
    ).map((row) => row.action);
    expect(actions.filter((action) => action === 'source.attach')).toHaveLength(1);
    expect(actions.filter((action) => action === 'source.detach')).toHaveLength(1);
  });
});
