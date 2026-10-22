import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActorContext } from '@package-broker/core/authz/administration';
import { createProjectLister } from '@package-broker/core/authz/project-list';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { countCalls } from '../contract/count-calls.js';
import { createProjectRepository } from './project.js';
import {
  createReadableProjectRepository,
  listReadableProjectsStatement,
} from './project-readable.js';

const providers = [
  {
    provider: 'oidc',
    anchor: 'issuer',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const projectId = (n: number) => `01J0PR0J${String(n).padStart(18, '0')}`;
const granted = Array.from({ length: 12 }, (_, i) => (i + 1) * 400);
let database: MigratedDatabase;
let executor: SqlExecutor;
let ctx: OrgContext;
let directory: string;
let raw: DatabaseSync;
let rowReads = 0;
let trap = false;
let queries = 0;
const actor = (orgRead = false): ActorContext => ({
  kind: 'organization',
  userId: 'U',
  permissions: new Set(orgRead ? ['project:read'] : []),
  isOrganizationAdmin: false,
});
function lister() {
  return createProjectLister({
    source: createProjectRepository(executor),
    readable: createReadableProjectRepository(executor, { providerAnchors: providers }),
  });
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 't940-'));
  const file = join(directory, 'pages.sqlite');
  database = await openMigratedDatabase({ file, twoOrganizations: true });
  ctx = database.orgs!.a;
  const seed = (sql: string, ...params: Statement['params']) =>
    database.executor.all({ sql, params });
  await seed(
    "INSERT INTO user_account (id, org_id, email) VALUES ('U', ?, 'reader@example.test')",
    ctx.orgId,
  );
  await seed(
    "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'reader', 'Reader', 'project')",
    ctx.orgId,
  );
  await seed(
    "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R', 'project:read')",
    ctx.orgId,
  );
  await seed(
    "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'issuer')",
    ctx.orgId,
  );
  await seed(
    "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('I', ?, 'U', 'oidc', 'subject', 'reader@example.test', 1, ?)",
    ctx.orgId,
    new Date().toISOString(),
  );
  for (let offset = 0; offset < 5000; offset += 100) {
    await database.executor.batch(
      Array.from({ length: 100 }, (_, i) => ({
        sql: 'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        params: [projectId(offset + i + 1), ctx.orgId, `p${offset + i + 1}`, 'Project'],
      })),
    );
  }
  for (const n of granted)
    await seed(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, 'email', 'reader@example.test', 'project', ?, 'R')",
      `G${n}`,
      ctx.orgId,
      projectId(n),
    );
  raw = new DatabaseSync(file);
  raw.function('counted_status', (status) => {
    rowReads += 1;
    if (rowReads > 50) throw new Error('project read budget exceeded');
    return status;
  });
  executor = {
    ...database.executor,
    async all<R>(statement: Statement): Promise<R[]> {
      queries += 1;
      const query = trap
        ? statement.sql.replace(
            /"project" as "(pe|pg)"/g,
            '(select id, org_id, slug, name, revision, counted_status(status) as status from project) as "$1"',
          )
        : statement.sql;
      return raw.prepare(query).all(...statement.params) as R[];
    },
  };
});
afterAll(async () => {
  raw?.close();
  await database?.close();
  if (directory) rmSync(directory, { recursive: true });
});

describe('full project pages', () => {
  it('gets three sparse PAT bindings among 5000 projects in one query', async () => {
    queries = 0;
    const result = await lister().list(ctx, actor(), {
      limit: 10,
      restrictTo: [400, 2400, 4800].map(projectId),
    });
    expect(result).toMatchObject({
      ok: true,
      value: {
        items: [{ id: projectId(400) }, { id: projectId(2400) }, { id: projectId(4800) }],
        nextAfterId: null,
      },
    });
    expect(queries).toBe(1);
  });

  it('pages 25 bound ids as 10, 10, 5 and stops', async () => {
    const restrictTo = Array.from({ length: 25 }, (_, i) => projectId((i + 1) * 200));
    const sizes: number[] = [];
    let afterId: string | undefined;
    const seen: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const result = await lister().list(ctx, actor(true), {
        limit: 10,
        restrictTo,
        ...(afterId === undefined ? {} : { afterId }),
      });
      if (!result.ok) throw new Error(result.error);
      sizes.push(result.value.items.length);
      seen.push(...result.value.items.map((p) => p.id));
      if (result.value.nextAfterId === null) break;
      afterId = result.value.nextAfterId;
    }
    expect(sizes).toEqual([10, 10, 5]);
    expect(seen).toEqual(restrictTo);
  });

  it('reads grant-only pages as 10 and 2, with project row reads bounded by grants', async () => {
    trap = true;
    rowReads = 0;
    const counted = countCalls(executor);
    const service = createProjectLister({
      source: createProjectRepository(counted.executor),
      readable: createReadableProjectRepository(counted.executor, { providerAnchors: providers }),
    });
    try {
      const first = await service.list(ctx, actor(), { limit: 10 });
      expect(first).toMatchObject({
        ok: true,
        value: {
          items: granted.slice(0, 10).map((n) => ({ id: projectId(n) })),
          nextAfterId: projectId(4000),
        },
      });
      const second = await service.list(ctx, actor(), { limit: 10, afterId: projectId(4000) });
      expect(second).toMatchObject({
        ok: true,
        value: { items: granted.slice(10).map((n) => ({ id: projectId(n) })), nextAfterId: null },
      });
      expect(counted.counts()).toEqual({ all: 2, batch: 0 });
      expect(rowReads).toBeGreaterThan(0);
      expect(rowReads).toBeLessThanOrEqual(28);
      expect(() => raw.prepare('SELECT counted_status(status) FROM project').all()).toThrow(
        'project read budget exceeded',
      );
    } finally {
      trap = false;
    }
  });

  it('restricts grant lookups by bound ids even if the caller can read every project', async () => {
    await database.executor.all({
      sql: "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) SELECT 'ALL' || id, org_id, 'email', 'reader@example.test', 'project', id, 'R' FROM project WHERE org_id = ? AND NOT EXISTS (SELECT 1 FROM access_grant g WHERE g.project_id = project.id)",
      params: [ctx.orgId],
    });
    trap = true;
    rowReads = 0;
    try {
      const result = await lister().list(ctx, actor(), {
        limit: 10,
        restrictTo: [1, 2500, 5000].map(projectId),
      });
      expect(result).toMatchObject({
        ok: true,
        value: { items: [1, 2500, 5000].map((n) => ({ id: projectId(n) })), nextAfterId: null },
      });
      expect(rowReads).toBeGreaterThan(0);
      expect(rowReads).toBeLessThanOrEqual(6);
    } finally {
      trap = false;
    }
    const statement = listReadableProjectsStatement(
      ctx,
      { userId: 'U' },
      { limit: 50, status: 'active', ids: Array.from({ length: 50 }, (_, i) => projectId(i + 1)) },
      providers,
    );
    expect(statement.params.length).toBeLessThanOrEqual(100);
    const plan = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      params: statement.params,
    });
    for (const alias of ['ge', 'gg']) {
      expect(
        plan.some(
          ({ detail }) =>
            detail.includes(`SEARCH ${alias} USING INDEX access_grant_subject`) &&
            detail.includes('project_id=?'),
        ),
      ).toBe(true);
    }
  });
});
