import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { sourceNameRoutes } from '@package-broker/core/api/routes/source-names';
import { fixedClock, ulid } from '@package-broker/core/ids';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createSourceService } from '@package-broker/core/sources/source-service';
import { createRegisteredNameRepository } from '@package-broker/db-sqlite/repositories/registered-name';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { countCalls } from '@package-broker/db-sqlite/contract/count-calls';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import {
  createSourceRepository,
  pauseSourceStatement,
} from '@package-broker/db-sqlite/repositories/source';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

let mf: Miniflare;
let executor: SqlExecutor;
let a: OrgContext;
let b: OrgContext;

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['SOURCE'],
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  executor = createD1Executor((await mf.getD1Database('SOURCE')) as unknown as D1DatabaseLike);
  const sources = await Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
  await migrate(executor, sources, { holder: 'source-lookup-test' });
  ({ a, b } = await seedTwoOrganizations(executor));
});

afterEach(async () => {
  await mf.dispose();
});

describe('source repository lookup', () => {
  async function insert(
    id: string,
    configJson = JSON.stringify({ provider: 'github', repository: 'Acme/Widget' }),
    options: { org?: OrgContext; projectId?: string; type?: string } = {},
  ) {
    await executor.batch([
      stmt(
        `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, config_json)
         VALUES (?, ?, ?, ?, 'composer', ?, ?)`,
        id,
        (options.org ?? a).orgId,
        options.projectId ?? null,
        id,
        options.type ?? 'vcs',
        configJson,
      ),
    ]);
  }

  async function lookup(repositoryName = 'acme/widget', provider = 'github') {
    const counted = countCalls(executor);
    const result = await createSourceRepository(counted.executor).findByRepository(a, {
      provider,
      repository: repositoryName,
    });
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    return result;
  }

  it('finds the stored id with either repository case and compares providers exactly', async () => {
    await insert('LOOKUP-ORG');
    expect(await lookup()).toEqual(await createSourceRepository(executor).get(a, 'LOOKUP-ORG'));
    expect((await lookup('ACME/WIDGET'))?.id).toBe('LOOKUP-ORG');
    expect(await lookup('acme/widget', 'git')).toBeNull();
    expect(await lookup('acme/widget', 'GitHub')).toBeNull();
    expect(await lookup('acme/missing')).toBeNull();
  });

  it('does not find a matching source of another real organization', async () => {
    await insert('LOOKUP-FOREIGN', undefined, { org: b });
    expect(await lookup()).toBeNull();
  });

  it('ignores non-vcs, malformed and non-object configurations without throwing', async () => {
    await insert('LOOKUP-NON-VCS', undefined, { type: 'composer_repository' });
    await executor.all(stmt('PRAGMA ignore_check_constraints = ON'));
    for (const [index, config] of ['{broken', 'null', '[]', '"Acme/Widget"', '42'].entries()) {
      await insert(`LOOKUP-INVALID-${String(index)}`, config);
    }
    await executor.all(stmt('PRAGMA ignore_check_constraints = OFF'));
    expect(await lookup()).toBeNull();
    await insert('LOOKUP-VALID');
    expect((await lookup())?.id).toBe('LOOKUP-VALID');
  });

  it('finds project and organization sources and returns the lower id regardless of insertion order', async () => {
    const projectId = 'LOOKUP-PROJECT';
    await executor.batch([
      stmt(
        'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        projectId,
        a.orgId,
        'lookup-project',
        'Lookup',
      ),
    ]);
    await insert('LOOKUP-Z-PROJECT', undefined, { projectId });
    expect(await lookup()).toMatchObject({ id: 'LOOKUP-Z-PROJECT', projectId });
    await insert('LOOKUP-A-ORG');
    expect(await lookup()).toMatchObject({ id: 'LOOKUP-A-ORG', projectId: null });
    await insert('LOOKUP-0-PROJECT', undefined, { projectId });
    expect(await lookup()).toMatchObject({ id: 'LOOKUP-0-PROJECT', projectId });
  });
});

describe('source paginated list and pause D1 twin', () => {
  it('scopes source pages and pause statements to the organization', async () => {
    await executor.batch([
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('FOREIGN', ?, 'foreign', 'npm', 'npmjs_proxy')",
        b.orgId,
      ),
    ]);
    const repository = createSourceRepository(executor);
    expect(await repository.list(a, { projectId: null, after: null, limit: 100 })).toEqual([]);
    await executor.batch([pauseSourceStatement(a, 'FOREIGN')]);
    expect(await repository.get(b, 'FOREIGN')).toMatchObject({ status: 'active' });
  });

  it('lists owned and attached organization sources only for an active project', async () => {
    await executor.batch([
      stmt("INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'p', 'Project')", a.orgId),
      stmt(
        "INSERT INTO source (id, org_id, project_id, name, ecosystem, type) VALUES ('OWNED', ?, 'P', 'owned', 'npm', 'npmjs_proxy')",
        a.orgId,
      ),
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('SHARED', ?, 'shared', 'npm', 'npmjs_proxy'), ('HIDDEN', ?, 'hidden', 'npm', 'npmjs_proxy')",
        a.orgId,
        a.orgId,
      ),
      stmt(
        "INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, 'P', 'SHARED')",
        a.orgId,
      ),
    ]);
    const repository = createSourceRepository(executor);
    expect(
      (await repository.list(a, { projectId: 'P', after: null, limit: 100 })).map((row) => row.id),
    ).toEqual(['OWNED', 'SHARED']);
    expect(await repository.list(b, { projectId: 'P', after: null, limit: 100 })).toEqual([]);
    await executor.batch([
      stmt("UPDATE project SET status = 'archived' WHERE id = 'P' AND org_id = ?", a.orgId),
    ]);
    expect(await repository.list(a, { projectId: 'P', after: null, limit: 100 })).toEqual([]);
  });

  it('continues by id after an insert between pages', async () => {
    const repository = createSourceRepository(executor);
    async function source(id: string) {
      await executor.batch([
        stmt(
          "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, 'npm', 'npmjs_proxy')",
          id,
          a.orgId,
          id,
        ),
      ]);
    }
    await source('B');
    await source('D');
    await source('F');
    const first = await repository.list(a, { projectId: null, after: null, limit: 1 });
    expect(first.map((row) => row.id)).toEqual(['B', 'D']);
    await source('A');
    expect(
      (await repository.list(a, { projectId: null, after: first[0]!.id, limit: 1 })).map(
        (row) => row.id,
      ),
    ).toEqual(['D', 'F']);
    expect(await repository.list(b, { projectId: null, after: null, limit: 100 })).toEqual([]);
  });

  it('pauses under a live fence, audits atomically and removes the source from scheduling', async () => {
    const subject = { userId: 'U-pause', sessionId: 'SES-pause' };
    const anchors = [
      {
        provider: 'oidc',
        anchor: 'oidc:https://idp.example.test',
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ];
    const now = new Date().toISOString();
    await executor.batch([
      stmt(
        "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'pause@example.test', 'active')",
        subject.userId,
        a.orgId,
      ),
      stmt(
        "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
        subject.sessionId,
        a.orgId,
        subject.userId,
        'a'.repeat(64),
        'b'.repeat(64),
        now,
        now,
      ),
      stmt(
        "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', ?)",
        a.orgId,
        anchors[0]!.anchor,
      ),
      stmt(
        "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('I-pause', ?, ?, 'oidc', 'pause', 'pause@example.test', 1, ?)",
        a.orgId,
        subject.userId,
        now,
      ),
      stmt(
        "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('R-pause', ?, 'pause', 'Pause', 'organization', 0)",
        a.orgId,
      ),
      stmt(
        "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-pause', 'org:sources:write')",
        a.orgId,
      ),
      stmt(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('G-pause', ?, 'email', 'pause@example.test', 'organization', 'R-pause')",
        a.orgId,
      ),
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type, next_poll_at) VALUES ('PAUSE', ?, 'pause', 'npm', 'npmjs_proxy', '2000-01-01T00:00:00.000Z')",
        a.orgId,
      ),
    ]);
    const fence = mutationFence(subject as AuthenticatedActor, {});
    const repository = createSourceRepository(executor);
    expect((await repository.listDue(a, 10)).map((row) => row.id)).toEqual(['PAUSE']);
    const target = {
      id: 'PAUSE',
      providerAnchors: anchors,
      audit: {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        occurredAt: '2026-10-21T00:00:00.000Z',
        action: 'source.pause' as const,
        actor: { type: 'user' as const, id: subject.userId },
        tokenSelector: null,
        sourceIp: null,
        target: { type: 'source', id: 'PAUSE' },
        projectId: null,
        payloadJson: '{}',
      },
    };
    expect(await repository.pause(a, fence, target)).toBe('paused');
    expect(await repository.listDue(a, 10)).toEqual([]);
    expect(await executor.all(stmt('SELECT org_id, action, target_id FROM audit_pending'))).toEqual(
      [{ org_id: a.orgId, action: 'source.pause', target_id: 'PAUSE' }],
    );
    expect(await repository.pause(a, fence, { ...target, id: 'absent' })).toBe('not_found');
    expect(await repository.pause(b, fence, target)).toBe('forbidden');
  });
});

async function d1NameWrite(
  method: 'POST' | 'DELETE',
  state: 'active' | 'archive-at-write' | 'delete-at-write',
) {
  const projectId = ulid();
  const sourceId = ulid();
  const nameId = ulid();
  const ctx = a;
  const query = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
  const batch = (...queries: Statement[]) => executor.batch(queries);
  const now = new Date().toISOString();
  const origin = 'https://broker.test';
  const csrf = 'B'.repeat(43);
  const anchors = [
    {
      provider: 'oidc',
      anchor: 'oidc:https://idp.example.test',
      emailAuthoritative: true,
      emailAuthoritativeDomains: ['example.test'],
    },
  ];
  await batch(
    query(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('writer', ?, 'writer', 'Writer', 'organization', 0)",
      ctx.orgId,
    ),
    query(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'writer', 'org:sources:write')",
      ctx.orgId,
    ),
    query(
      "INSERT INTO user_account (id, org_id, email) VALUES ('writer', ?, 'writer@example.test')",
      ctx.orgId,
    ),
    query(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.example.test')",
      ctx.orgId,
    ),
    query(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'writer', 'oidc', 'writer', 'writer@example.test', 1, ?)",
      ctx.orgId,
      now,
    ),
    query(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'writer', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
      ctx.orgId,
      'a'.repeat(64),
      await sha256Hex(csrf),
      now,
      now,
    ),
    query(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'writer@example.test', 'organization', 'writer')",
      ctx.orgId,
    ),
    query(
      "INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, 'owner', 'Owner', 'active')",
      projectId,
      ctx.orgId,
    ),
    query(
      "INSERT INTO source (id, org_id, project_id, name, ecosystem, type, url, config_json, status) VALUES (?, ?, ?, 'private', 'composer', 'composer_repository', 'https://repo.example.test', '{}', 'active')",
      sourceId,
      ctx.orgId,
      projectId,
    ),
    query(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'composer', 'vendor/*')",
      nameId,
      ctx.orgId,
      sourceId,
    ),
  );
  const sources = createSourceRepository(executor);
  let raced = false;
  const writer: SqlExecutor = {
    driver: executor.driver,
    all: (statement) => executor.all(statement),
    async batch(statements) {
      if (!raced && (state === 'archive-at-write' || state === 'delete-at-write')) {
        raced = true;
        await batch(
          state === 'archive-at-write'
            ? query(
                "UPDATE project SET status = 'archived' WHERE org_id = ? AND id = ?",
                ctx.orgId,
                projectId,
              )
            : query('DELETE FROM source WHERE org_id = ? AND id = ?', ctx.orgId, sourceId),
        );
      }
      return executor.batch(statements);
    },
  };
  const registeredNames = createRegisteredNameRepository(writer);
  const write =
    method === 'POST' ? vi.spyOn(registeredNames, 'add') : vi.spyOn(registeredNames, 'remove');
  const ids = { ulid };
  const clock = fixedClock(now);
  const logs: string[] = [];
  const log = (entry: unknown) => logs.push(JSON.stringify(entry));
  const service = createSourceService({
    sources,
    registeredNames,
    ids,
    log,
    providerAnchors: anchors,
    credentials: {
      prepare: async () => {
        throw new Error('unused');
      },
    },
    credentialRepository: { get: async () => null },
    organizations: { get: async () => null },
    catalogue: { previewWinners: async () => [] },
    policy: { runtime: 'node', allowPrivateHosts: [], selfOrigins: [origin] },
  });
  const app = await createKernel({
    platform: 'node',
    plugins: [],
    coreRoutes: sourceNameRoutes({
      service,
      sources,
      registeredNames,
      ids,
      clock,
      clientIp: () => '192.0.2.1',
      visibility: {
        setOrder: async () => {
          throw new Error('unused');
        },
      },
      projectSources: { list: async () => [] },
      projects: { get: async () => null },
    }),
    ports: { organizations: { get: async () => null }, ids, clock },
    resolveOrg: async () => ctx,
    health: async () => true,
    log,
    authorization: createAuthorizationEngine({
      access: {
        lookupSession: async () => ({
          session: { id: 'session', csrfHash: await sha256Hex(csrf) },
          user: { id: 'writer' },
          identity: null,
          protectedHolder: false,
          project: null,
          organizationPermissions: ['org:sources:write'],
          projectPermissions: [],
        }),
        lookupToken: async () => null,
        touchSession: async () => true,
        touchToken: async () => true,
      },
      tokenUse: {
        keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
        nowMs: () => clock.now().getTime(),
        dispatch: (run) => {
          void run();
        },
        log,
      },
      patValidation: patValidationGate,
      publicOrigin: origin,
      providerAnchors: async () => anchors,
    }),
  });
  const snapshot = async () => ({
    names: await executor.all(
      query('SELECT * FROM registered_name WHERE org_id = ? ORDER BY id', ctx.orgId),
    ),
    sources: await executor.all(
      query('SELECT * FROM source WHERE org_id = ? ORDER BY id', ctx.orgId),
    ),
    audit: await executor.all(
      query('SELECT * FROM audit_pending WHERE org_id = ? ORDER BY id', ctx.orgId),
    ),
    epoch: await executor.all(query('SELECT * FROM cache_epoch WHERE org_id = ?', ctx.orgId)),
  });
  const request = (id: string) =>
    app.fetch(
      new Request(
        origin + '/_pb/sources/' + id + '/names' + (method === 'DELETE' ? '/' + nameId : ''),
        {
          method,
          headers: {
            origin,
            'content-type': 'application/json',
            cookie: SESSION_COOKIE + '=' + 'A'.repeat(43),
            'x-csrf-token': csrf,
          },
          ...(method === 'POST' ? { body: JSON.stringify({ pattern: 'other/*' }) } : {}),
        },
      ),
    );
  const normalize = async (response: Response) => {
    const text = await response.text();
    const body = (text === '' ? null : JSON.parse(text)) as {
      error?: { requestId?: string };
    } | null;
    if (body?.error) delete body.error.requestId;
    return {
      status: response.status,
      body,
      headers: [...response.headers].filter(([key]) => key !== 'x-request-id'),
    };
  };
  const before = await snapshot();
  const response = await normalize(await request(sourceId));
  const after = await snapshot();
  const absent = await normalize(await request(ulid()));
  return { before, after, response, absent, logs, writeCalls: write.mock.calls.length };
}

for (const method of ['POST', 'DELETE'] as const) {
  it.each(['archive-at-write', 'delete-at-write'] as const)(
    `refuses a D1-backed ${method} name write when visibility changes at the batch: %s`,
    async (state) => {
      const result = await d1NameWrite(method, state);
      expect(result.response.status).toBe(404);
      expect(result.response).toEqual(result.absent);
      expect(result.writeCalls).toBe(1);
      expect(result.after.audit).toEqual(result.before.audit);
      expect(result.after.epoch).toEqual(result.before.epoch);
      if (state === 'archive-at-write') expect(result.after).toEqual(result.before);
      else {
        expect(result.after.names).toEqual([]);
        expect(result.after.sources).toEqual([]);
      }
    },
  );

  it(`allows a D1-backed ${method} name write for an active owning project`, async () => {
    const result = await d1NameWrite(method, 'active');
    expect(result.response.status).toBe(method === 'POST' ? 201 : 200);
    expect(result.writeCalls).toBe(1);
    expect(result.after).toMatchObject({
      names:
        method === 'POST'
          ? expect.arrayContaining([
              expect.objectContaining({ pattern: 'vendor/*' }),
              expect.objectContaining({ pattern: 'other/*' }),
            ])
          : [],
      sources: [expect.objectContaining({ status: method === 'POST' ? 'active' : 'paused' })],
    });
  });
}
