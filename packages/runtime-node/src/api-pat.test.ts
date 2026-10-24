import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import type { NodeBroker } from './index.js';
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

describe('Node management API personal access token lifecycle', () => {
  let directory: string;
  let path: string;
  const running: NodeBroker[] = [];

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'pb-api-pat-'));
    path = join(directory, 'broker.sqlite');
  });

  afterEach(async () => {
    for (const broker of running.splice(0)) await broker.close();
    await rm(directory, { recursive: true, force: true });
  });

  async function start(): Promise<string> {
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const broker = await startNode({
      plugins: [],
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
    await new Promise<void>((resolve) => broker.server.listen(port, '127.0.0.1', resolve));
    return base;
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

  async function login(base: string): Promise<{ cookie: string; csrf: string }> {
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
    const signedIn = await post(base, '/_pb/auth/local/login', {
      email: EMAIL,
      password: PASSWORD,
      code: await totpCode(totpSecret, step),
    });
    expect(signedIn.status).toBe(204);
    const cookie = cookieHeader([signedIn]);
    const csrf = /__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
    const reauth = await fetch(`${base}/_pb/auth/local/reauth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie, 'x-csrf-token': csrf },
      body: JSON.stringify({ password: PASSWORD, code: await totpCode(totpSecret, step + 1) }),
    });
    expect(reauth.status).toBe(204);
    return { cookie, csrf };
  }

  async function pendingActions(): Promise<string[]> {
    const opened = openBetterSqliteExecutor(path);
    try {
      const rows = await opened.executor.all<{ action: string }>({
        sql: 'SELECT action FROM audit_pending ORDER BY created_at',
        params: [],
      });
      return rows.map((row) => row.action);
    } finally {
      await opened.close();
    }
  }

  it('issues a token, uses it on a management route, revokes it and then gets 401', async () => {
    const base = await start();
    const { cookie, csrf } = await login(base);

    const issued = await fetch(`${base}/_pb/me/tokens`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: base,
        cookie,
        'x-csrf-token': csrf,
        'idempotency-key': ulid(),
      },
      body: JSON.stringify({ name: 'laptop', scope: 'read', projectMode: 'all', projectIds: [] }),
    });
    expect(issued.status).toBe(201);
    const { id, token: plaintext } = (await issued.json()) as { id: string; token: string };
    expect(plaintext).toMatch(/^pb_pat_/);
    const bearer = { authorization: `Bearer ${plaintext}` };

    const used = await fetch(`${base}/_pb/projects`, { headers: bearer });
    expect(used.status).toBe(200);

    expect(await pendingActions()).toEqual([
      'setup.complete',
      'session.login',
      'session.reauth',
      'token.issue',
    ]);

    const revoked = await fetch(`${base}/_pb/me/tokens/${id}`, {
      method: 'DELETE',
      headers: { cookie, origin: base, 'x-csrf-token': csrf },
    });
    expect(revoked.status).toBe(204);

    const after = await fetch(`${base}/_pb/projects`, { headers: bearer });
    expect(after.status).toBe(401);
    expect(await pendingActions()).toEqual([
      'setup.complete',
      'session.login',
      'session.reauth',
      'token.issue',
      'token.revoke',
    ]);
  });
  it('reorders the real attachment set while a project-owned source stays unattached', async () => {
    const base = await start();
    const { cookie, csrf } = await login(base);
    const write = {
      cookie,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      origin: base,
    };
    const created = await fetch(`${base}/_pb/projects`, {
      method: 'POST',
      headers: write,
      body: JSON.stringify({ slug: 'alpha', name: 'Alpha' }),
    });
    expect(created.status).toBe(201);
    const { id: projectId } = (await created.json()) as { id: string };

    const [first, second, owned] = [ulid(), ulid(), ulid()];
    const opened = openBetterSqliteExecutor(path);
    try {
      const org = await createOrganizationBootstrap(opened.executor).findSingleton();
      const orgId = org?.id ?? '';
      const rows: [string, string | null][] = [
        [first, null],
        [second, null],
        [owned, projectId],
      ];
      await opened.executor.batch([
        ...rows.map(([id, owner]) => ({
          sql: "INSERT INTO source (id, org_id, name, ecosystem, type, project_id) VALUES (?, ?, ?, 'composer', 'composer_repository', ?)",
          params: [id, orgId, id, owner],
        })),
        ...[first, second].map((id, precedence) => ({
          sql: 'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, ?)',
          params: [orgId, projectId, id, precedence],
        })),
      ]);
    } finally {
      await opened.close();
    }

    const read = await fetch(`${base}/_pb/projects/alpha`, { headers: { cookie } });
    expect(read.status).toBe(200);
    const etag = read.headers.get('etag') ?? '';
    expect(etag).not.toBe('');

    const reordered = await fetch(`${base}/_pb/projects/alpha/sources/order`, {
      method: 'PUT',
      headers: { ...write, 'if-match': etag },
      body: JSON.stringify({ sourceIds: [second, first] }),
    });
    expect(reordered.status).toBe(204);
  });
  it('attaches and detaches an organization source over the real store with audit rows', async () => {
    const base = await start();
    const { cookie, csrf } = await login(base);
    const write = {
      cookie,
      'x-csrf-token': csrf,
      'content-type': 'application/json',
      origin: base,
    };
    const created = await fetch(`${base}/_pb/projects`, {
      method: 'POST',
      headers: write,
      body: JSON.stringify({ slug: 'alpha', name: 'Alpha' }),
    });
    expect(created.status).toBe(201);
    const [source, foreign] = [ulid(), ulid()];
    const beta = await fetch(`${base}/_pb/projects`, {
      method: 'POST',
      headers: write,
      body: JSON.stringify({ slug: 'beta', name: 'Beta' }),
    });
    expect(beta.status).toBe(201);
    const { id: betaId } = (await beta.json()) as { id: string };
    const opened = openBetterSqliteExecutor(path);
    try {
      const org = await createOrganizationBootstrap(opened.executor).findSingleton();
      const orgId = org?.id ?? '';
      await opened.executor.batch(
        (
          [
            [source, null],
            [foreign, betaId],
          ] as [string, string | null][]
        ).map(([id, owner]) => ({
          sql: "INSERT INTO source (id, org_id, name, ecosystem, type, project_id) VALUES (?, ?, ?, 'composer', 'composer_repository', ?)",
          params: [id, orgId, id, owner],
        })),
      );
    } catch (error) {
      await opened.close();
      throw error;
    }
    await opened.close();

    const url = (id: string) => `${base}/_pb/projects/alpha/sources/${id}/attachment`;
    const listed = async () =>
      (
        (await (
          await fetch(`${base}/_pb/projects/alpha/sources`, { headers: { cookie } })
        ).json()) as {
          items: { id: string }[];
        }
      ).items.map((item) => item.id);
    expect(await listed()).not.toContain(source);

    const attached = await fetch(url(source), { method: 'PUT', headers: write, body: '{}' });
    expect(attached.status).toBe(204);
    expect(await listed()).toContain(source);
    const again = await fetch(url(source), { method: 'PUT', headers: write, body: '{}' });
    expect(again.status).toBe(204);
    expect((await fetch(url(foreign), { method: 'PUT', headers: write, body: '{}' })).status).toBe(
      404,
    );

    const detached = await fetch(url(source), { method: 'DELETE', headers: write });
    expect(detached.status).toBe(204);
    expect(await listed()).not.toContain(source);
    expect((await fetch(url(source), { method: 'DELETE', headers: write })).status).toBe(404);

    const actions = await pendingActions();
    expect(actions.filter((action) => action === 'source.attach')).toHaveLength(1);
    expect(actions.filter((action) => action === 'source.detach')).toHaveLength(1);
  });
});
