import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { ActorContext } from '@package-broker/core/authz/administration';
import { createProjectLister } from '@package-broker/core/authz/project-list';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { countCalls } from '@package-broker/db-sqlite/contract/count-calls';
import { createProjectRepository } from '@package-broker/db-sqlite/repositories/project';
import { createReadableProjectRepository } from '@package-broker/db-sqlite/repositories/project-readable';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['PAGES'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
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
let executor: SqlExecutor;
let ctx: OrgContext;
const actor = (orgRead = false): ActorContext => ({
  kind: 'organization',
  userId: 'U',
  permissions: new Set(orgRead ? ['project:read'] : []),
  isOrganizationAdmin: false,
});
function lister(target = executor) {
  return createProjectLister({
    source: createProjectRepository(target),
    readable: createReadableProjectRepository(target, { providerAnchors: providers }),
  });
}
beforeAll(async () => {
  executor = createD1Executor((await mf.getD1Database('PAGES')) as unknown as D1DatabaseLike);
  await migrate(executor, await discoveredMigrations(), { holder: 'project-pages' });
  ctx = (await seedTwoOrganizations(executor)).a;
  const seed = (sql: string, ...params: Statement['params']) => executor.all({ sql, params });
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
    await executor.batch(
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
});
afterAll(() => mf.dispose());
describe('D1 full project pages', () => {
  it('returns three sparse bound projects in one read', async () => {
    const counted = countCalls(executor);
    const result = await lister(counted.executor).list(ctx, actor(), {
      limit: 10,
      restrictTo: [400, 2400, 4800].map(projectId),
    });
    expect(result).toMatchObject({
      ok: true,
      value: { items: [400, 2400, 4800].map((n) => ({ id: projectId(n) })), nextAfterId: null },
    });
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
  });
  it('returns 25 bound projects as 10, 10, 5', async () => {
    const restrictTo = Array.from({ length: 25 }, (_, i) => projectId((i + 1) * 200));
    const sizes: number[] = [];
    const seen: string[] = [];
    let afterId: string | undefined;
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
  it('returns 12 grants as 10 and 2 with one indexed query per page', async () => {
    const counted = countCalls(executor);
    const service = lister(counted.executor);
    expect(await service.list(ctx, actor(), { limit: 10 })).toMatchObject({
      ok: true,
      value: {
        items: granted.slice(0, 10).map((n) => ({ id: projectId(n) })),
        nextAfterId: projectId(4000),
      },
    });
    expect(await service.list(ctx, actor(), { limit: 10, afterId: projectId(4000) })).toMatchObject(
      {
        ok: true,
        value: { items: granted.slice(10).map((n) => ({ id: projectId(n) })), nextAfterId: null },
      },
    );
    expect(counted.counts()).toEqual({ all: 2, batch: 0 });
  });
});
