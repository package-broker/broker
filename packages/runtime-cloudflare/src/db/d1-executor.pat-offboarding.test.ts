import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import {
  createPatOffboardingJob,
  type PatOffboardingCause,
} from '@package-broker/core/authz/pat-offboarding';
import type { OrgContext, SqlExecutor, SqlValue } from '@package-broker/core/db/port';
import { fixedClock, ulid } from '@package-broker/core/ids';
import type { JobContext } from '@package-broker/core/platform/jobs';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { createPatOffboardingRepository } from '@package-broker/db-sqlite/repositories/pat-offboarding';
import { discoveredMigrations } from '@package-broker/db-sqlite/testing/migrated-database';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 8 }, (_, index) => `PODB${index}`);

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

const USER = '01HZX3VQ7N5R8T2W4Y6A9B1C2D';
const OTHER_USER = '01HZX3VQ7N5R8T2W4Y6A9B1C2E';
const JOB = 'job-offboarding';
const CUTOFF = '2026-10-20T11:00:00.000Z';
const NOW = '2026-10-20T12:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

async function open() {
  const binding = bindings[next];
  next += 1;
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  const executor = createD1Executor(db);
  await migrate(executor, await discoveredMigrations(), { holder: 'pat-offboarding-test' });
  const orgs = await seedTwoOrganizations(executor);
  const run = (sql: string, ...params: SqlValue[]) => executor.batch([{ sql, params }]);
  await run(
    "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'leaver@example.test', 'suspended')",
    USER,
    orgs.a.orgId,
  );
  await run(
    "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'stays@example.test', 'active')",
    OTHER_USER,
    orgs.a.orgId,
  );
  await run(
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
     VALUES (?, ?, 'core:pat-offboarding:v1', 'key', 'running', 'worker', ?, 1)`,
    JOB,
    orgs.a.orgId,
    FUTURE,
  );
  return { executor, run, ...orgs };
}

let counter = 0;

async function token(
  run: (sql: string, ...params: SqlValue[]) => Promise<unknown>,
  org: OrgContext,
  options: {
    createdAt?: string;
    expiresAt?: string;
    revokedAt?: string | null;
    lastOpId?: string | null;
    user?: string;
  } = {},
): Promise<string> {
  counter += 1;
  const id = `01J0TOKEN${String(counter).padStart(17, '0')}`;
  await run(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only,
       user_id, created_by_user_id, expires_at, revoked_at, last_op_id, project_mode, created_at)
     VALUES (?, ?, 'pat', ?, ?, 1, ?, '["write"]', 0, ?, ?, ?, ?, ?, 'all', ?)`,
    id,
    org.orgId,
    String(counter).padStart(12, 's'),
    'a'.repeat(64),
    `name-${counter}`,
    options.user ?? USER,
    USER,
    options.expiresAt ?? '2027-01-01T00:00:00.000Z',
    options.revokedAt ?? null,
    options.lastOpId ?? null,
    options.createdAt ?? '2026-10-20T10:00:00.000Z',
  );
  return id;
}

function jobFor(executor: SqlExecutor) {
  const entries: Record<string, unknown>[] = [];
  const job = createPatOffboardingJob({
    store: createPatOffboardingRepository(executor),
    clock: fixedClock(NOW),
    ids: { ulid },
    log: (entry) => entries.push({ ...entry }),
  });
  return { job, entries };
}

function contextFor(org: OrgContext, fence = 1): JobContext {
  return {
    org,
    jobId: JOB,
    idempotencyKey: 'k',
    attempt: 1,
    fence,
    signal: new AbortController().signal,
    ports: {} as JobContext['ports'],
    observability: {} as JobContext['observability'],
  };
}

async function execute(
  executor: SqlExecutor,
  org: OrgContext,
  cause: PatOffboardingCause = 'suspended',
  fence = 1,
) {
  const { job, entries } = jobFor(executor);
  await job.definition.handler(
    job.definition.validate({ userId: USER, cause, cutoff: CUTOFF }),
    contextFor(org, fence),
  );
  return entries;
}

async function states(executor: SqlExecutor) {
  const rows = await executor.all<{
    id: string;
    revoked_at: string | null;
    last_op_id: string | null;
  }>({ sql: 'SELECT id, revoked_at, last_op_id FROM token ORDER BY id', params: [] });
  return new Map(rows.map((row) => [row.id, row]));
}

async function audited(executor: SqlExecutor): Promise<string[]> {
  const rows = await executor.all<{ target_id: string }>({
    sql: 'SELECT target_id FROM audit_pending ORDER BY target_id',
    params: [],
  });
  return rows.map((row) => row.target_id);
}

describe('personal-token offboarding on Miniflare D1', () => {
  it('1: suspended revokes live and expired tokens, spares a later and an already revoked one', async () => {
    const { executor, run, a, b } = await open();
    const live = [await token(run, a), await token(run, a), await token(run, a)];
    const expired = await token(run, a, { expiresAt: '2026-01-01T00:00:00.000Z' });
    const later = await token(run, a, { createdAt: '2026-10-20T11:00:00.001Z' });
    const done = await token(run, a, {
      revokedAt: '2026-10-01T00:00:00.000Z',
      lastOpId: 'earlier-op',
    });
    const foreign = await token(run, b);
    const other = await token(run, a, { user: OTHER_USER });

    const entries = await execute(executor, a);

    const after = await states(executor);
    for (const id of [...live, expired]) expect(after.get(id)?.revoked_at).toBe(NOW);
    expect(after.get(later)?.revoked_at).toBeNull();
    expect(after.get(done)).toMatchObject({
      revoked_at: '2026-10-01T00:00:00.000Z',
      last_op_id: 'earlier-op',
    });
    expect(after.get(foreign)?.revoked_at).toBeNull();
    expect(after.get(other)?.revoked_at).toBeNull();
    expect(await audited(executor)).toEqual([...live, expired].sort());
    expect(entries.at(-1)).toMatchObject({ event: 'token.offboarding_done', revoked: 4 });
  });

  it('4: running the job twice revokes nothing the second time and stages no second audit row', async () => {
    const { executor, run, a } = await open();
    const ids = [await token(run, a), await token(run, a)];

    await execute(executor, a);
    const first = await states(executor);
    const second = await execute(executor, a);

    expect(await states(executor)).toEqual(first);
    expect(await audited(executor)).toEqual([...ids].sort());
    expect(second.filter((entry) => entry.event === 'token.revoked')).toEqual([]);
    expect(second.at(-1)).toMatchObject({ event: 'token.offboarding_done', revoked: 0 });
  });

  it('5: a lost lease writes nothing and the handler throws the lease-lost error', async () => {
    const { executor, run, a } = await open();
    const ids = [await token(run, a), await token(run, a)];
    await run('UPDATE job SET fence = fence + 1 WHERE id = ?', JOB);

    await expect(execute(executor, a)).rejects.toMatchObject({
      name: 'JobError',
      code: 'lease_lost',
    });

    const after = await states(executor);
    for (const id of ids) expect(after.get(id)?.revoked_at).toBeNull();
    expect(await audited(executor)).toEqual([]);
  });
});
