import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
