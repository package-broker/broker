import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor, SqlValue, Statement } from '@package-broker/core/db/port';
import {
  createPatOffboardingJob,
  PAT_OFFBOARDING_JOB_TYPE,
} from '@package-broker/core/authz/pat-offboarding';
import { createPatOffboardingSweepJob } from '@package-broker/core/authz/pat-offboarding-sweep';
import type { PatOffboardingStore } from '@package-broker/core/authz/pat-offboarding';
import { fixedClock, ulid } from '@package-broker/core/ids';
import type { JobContext, Jobs } from '@package-broker/core/platform/jobs';
import { createRepositoryJobs } from '@package-broker/core/platform/jobs-port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createJobRepository } from './job.js';
import { createPatOffboardingRepository } from './pat-offboarding.js';

const USER = '01HZX3VQ7N5R8T2W4Y6A9B1C2D';
const OTHER_USER = '01HZX3VQ7N5R8T2W4Y6A9B1C2E';
const SP = '01HZX3VQ7N5R8T2W4Y6A9B1C2F';
const ROLE = '01HZX3VQ7N5R8T2W4Y6A9B1C2G';
const PROJECT = '01HZX3VQ7N5R8T2W4Y6A9B1C2H';
const JOB = 'job-offboarding';
const CUTOFF = '2026-10-20T11:00:00.000Z';
const BEFORE = '2026-10-20T10:00:00.000Z';
const AFTER = '2026-10-20T11:00:00.001Z';
const NOW = '2026-10-20T12:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const EMAIL = 'leaver@example.test';

let database: MigratedDatabase;
let executor: SqlExecutor;
let a: OrgContext;
let b: OrgContext;
let store: PatOffboardingStore;
let counter = 0;

async function run(sql: string, ...params: SqlValue[]): Promise<void> {
  await executor.batch([{ sql, params }]);
}

async function all<R>(sql: string, ...params: SqlValue[]): Promise<R[]> {
  return executor.all<R>({ sql, params });
}

function tokenId(n: number): string {
  return `01J0TOKEN${String(n).padStart(17, '0')}`;
}

interface Seed {
  org?: OrgContext;
  kind?: 'pat' | 'svc' | 'cst';
  user?: string;
  createdAt?: string;
  expiresAt?: string | null;
  revokedAt?: string | null;
  lastOpId?: string | null;
}

async function seed(options: Seed = {}): Promise<string> {
  counter += 1;
  const id = tokenId(counter);
  const kind = options.kind ?? 'pat';
  const org = options.org ?? a;
  await run(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only,
       user_id, service_principal_id, customer_id, created_by_user_id, expires_at, revoked_at,
       last_op_id, project_mode, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, '["write"]', 0, ?, ?, ?, ?, ?, ?, ?, 'all', ?)`,
    id,
    org.orgId,
    kind,
    String(counter).padStart(12, 's'),
    'a'.repeat(64),
    `name-${counter}`,
    kind === 'pat' ? (options.user ?? USER) : null,
    kind === 'svc' ? SP : null,
    kind === 'cst' ? 'cust' : null,
    USER,
    kind === 'cst'
      ? null
      : options.expiresAt === undefined
        ? '2027-01-01T00:00:00.000Z'
        : options.expiresAt,
    options.revokedAt ?? null,
    options.lastOpId ?? null,
    options.createdAt ?? BEFORE,
  );
  return id;
}

async function seedJob(id = JOB, org: OrgContext = a, fence = 1): Promise<void> {
  await run(
    `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
     VALUES (?, ?, 'core:pat-offboarding:v1', ?, 'running', 'worker', ?, ?)`,
    id,
    org.orgId,
    `key-${id}`,
    FUTURE,
    fence,
  );
}

function auditFor(id: string, opId: string, cause = 'suspended'): AuditEvent {
  const built = auditEvent({
    id: ulid(),
    now: NOW,
    action: 'token.revoke',
    actor: { type: 'system', id: null },
    context: { opId, requestId: opId, sourceIp: null, tokenSelector: null },
    target: { type: 'token', id },
    projectId: null,
    changes: { cause: { new: cause } },
  });
  if (!built.ok) throw new Error('audit event rejected');
  return built.event;
}

function page(
  ids: readonly string[],
  overrides: Partial<{
    userId: string;
    cutoff: string;
    opId: string;
    jobId: string;
    fence: number;
  }> = {},
) {
  const opId = overrides.opId ?? ulid();
  return {
    userId: overrides.userId ?? USER,
    cutoff: overrides.cutoff ?? CUTOFF,
    ids,
    now: NOW,
    opId,
    lease: { jobId: overrides.jobId ?? JOB, fence: overrides.fence ?? 1 },
    audits: ids.map((id) => auditFor(id, opId)),
  };
}

interface TokenState {
  readonly id: string;
  readonly revoked_at: string | null;
  readonly last_op_id: string | null;
}

async function states(): Promise<Map<string, TokenState>> {
  const rows = await all<TokenState>('SELECT id, revoked_at, last_op_id FROM token ORDER BY id');
  return new Map(rows.map((row) => [row.id, row]));
}

async function audited(): Promise<string[]> {
  const rows = await all<{ target_id: string }>(
    'SELECT target_id FROM audit_pending ORDER BY target_id',
  );
  return rows.map((row) => row.target_id);
}

beforeEach(async () => {
  counter = 0;
  database = await openMigratedDatabase({ twoOrganizations: true });
  executor = database.executor;
  a = database.orgs!.a;
  b = database.orgs!.b;
  store = createPatOffboardingRepository(executor);
  await run(
    "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'suspended')",
    USER,
    a.orgId,
    EMAIL,
  );
  await run(
    "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, 'other@example.test', 'active')",
    OTHER_USER,
    a.orgId,
  );
  await run(
    "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, 'viewer', 'Viewer', 'organization')",
    ROLE,
    a.orgId,
  );
  await run(
    "INSERT INTO role (id, org_id, key, name, scope) VALUES ('role-b', ?, 'viewer', 'Viewer', 'organization')",
    b.orgId,
  );
  await run(
    "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'one', 'One')",
    PROJECT,
    a.orgId,
  );
  await run(
    'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
    SP,
    a.orgId,
    'svc-one',
    PROJECT,
    USER,
  );
  await run("INSERT INTO customer (id, org_id, name) VALUES ('cust', ?, 'c')", a.orgId);
  await seedJob();
});

afterEach(async () => {
  await database.close();
});

async function grant(options: {
  type: 'email' | 'group';
  value: string;
  provider?: string | null;
  scope?: 'organization' | 'project';
  createdAt?: string;
  org?: OrgContext;
}): Promise<void> {
  counter += 1;
  const org = options.org ?? a;
  await run(
    `INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    `grant-${counter}`,
    org.orgId,
    options.type,
    options.value,
    options.type === 'group' ? (options.provider ?? 'oidc') : null,
    options.scope ?? 'organization',
    options.scope === 'project' ? PROJECT : null,
    org === a ? ROLE : 'role-b',
    options.createdAt ?? BEFORE,
  );
}

describe('candidates', () => {
  it('lists live personal tokens of the user created at or before the cutoff, ordered by id', async () => {
    const live1 = await seed();
    const atCutoff = await seed({ createdAt: CUTOFF });
    const expired = await seed({ expiresAt: '2026-01-01T00:00:00.000Z' });
    await seed({ createdAt: AFTER });
    await seed({ revokedAt: '2026-10-01T00:00:00.000Z' });

    expect(await store.candidates(a, { userId: USER, cutoff: CUTOFF, limit: 25 })).toEqual([
      live1,
      atCutoff,
      expired,
    ]);
  });

  it('never lists a service token, a customer token or another user token', async () => {
    const mine = await seed();
    await seed({ kind: 'svc' });
    await seed({ kind: 'cst' });
    await seed({ user: OTHER_USER });

    expect(await store.candidates(a, { userId: USER, cutoff: CUTOFF, limit: 25 })).toEqual([mine]);
  });

  it('does not list tokens of the same user id stored under another organization', async () => {
    await seed({ org: b });

    expect(await store.candidates(a, { userId: USER, cutoff: CUTOFF, limit: 25 })).toEqual([]);
  });

  it('honours the limit', async () => {
    const ids = [await seed(), await seed(), await seed()];

    expect(await store.candidates(a, { userId: USER, cutoff: CUTOFF, limit: 2 })).toEqual(
      ids.slice(0, 2),
    );
  });

  it.each([0, 26, 1.5, Number.NaN])('refuses the limit %s before SQL', async (limit) => {
    await expect(store.candidates(a, { userId: USER, cutoff: CUTOFF, limit })).rejects.toThrow(
      RangeError,
    );
  });
});

describe('holdsAnyGrant', () => {
  it('is false for a user with no grant', async () => {
    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(false);
  });

  it('is true for a remaining organization grant on the stored e-mail', async () => {
    await grant({ type: 'email', value: EMAIL });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(true);
  });

  it('is true for a remaining project grant on the stored e-mail', async () => {
    await grant({ type: 'email', value: EMAIL, scope: 'project' });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(true);
  });

  it('is true for a group grant while the user is a member of that group', async () => {
    await run(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'oidc', 'staff')",
      a.orgId,
      USER,
    );
    await grant({ type: 'group', value: 'staff', provider: 'oidc' });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(true);
  });

  it('is true for a project group grant while the user is a member of that group', async () => {
    await run(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'oidc', 'staff')",
      a.orgId,
      USER,
    );
    await grant({ type: 'group', value: 'staff', provider: 'oidc', scope: 'project' });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(true);
  });

  it('is false for a group grant of a group the user is not a member of', async () => {
    await run(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'oidc', 'other')",
      a.orgId,
      USER,
    );
    await grant({ type: 'group', value: 'staff', provider: 'oidc' });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(false);
  });

  it('is false for a group of another provider with the same name', async () => {
    await run(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'ldap', 'staff')",
      a.orgId,
      USER,
    );
    await grant({ type: 'group', value: 'staff', provider: 'oidc' });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(false);
  });

  it('ignores a grant created after the cutoff', async () => {
    await grant({ type: 'email', value: EMAIL, createdAt: AFTER });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(false);
  });

  it('counts a grant created exactly at the cutoff', async () => {
    await grant({ type: 'email', value: EMAIL, createdAt: CUTOFF });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(true);
  });

  it('ignores a grant of another organization on the same e-mail', async () => {
    await run(
      "INSERT INTO user_account (id, org_id, email) VALUES ('mirror', ?, ?)",
      b.orgId,
      EMAIL,
    );
    await grant({ type: 'email', value: EMAIL, org: b });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(false);
  });

  it('ignores a grant on another user e-mail', async () => {
    await grant({ type: 'email', value: 'other@example.test' });

    expect(await store.holdsAnyGrant(a, USER, CUTOFF)).toBe(false);
  });
});

describe('revokePage', () => {
  it('revokes live and expired personal tokens, spares newer and already revoked ones', async () => {
    const live = [await seed(), await seed(), await seed()];
    const expired = await seed({ expiresAt: '2026-01-01T00:00:00.000Z' });
    const newer = await seed({ createdAt: AFTER });
    const done = await seed({ revokedAt: '2026-10-01T00:00:00.000Z', lastOpId: 'earlier-op' });
    const targets = [...live, expired];

    const outcome = await store.revokePage(a, page([...targets, newer, done]));

    expect(outcome).toEqual({ status: 'ok', revoked: targets });
    const after = await states();
    for (const id of targets) {
      expect(after.get(id)?.revoked_at).toBe(NOW);
      expect(after.get(id)?.last_op_id).not.toBeNull();
    }
    expect(after.get(newer)).toMatchObject({ revoked_at: null, last_op_id: null });
    expect(after.get(done)).toMatchObject({
      revoked_at: '2026-10-01T00:00:00.000Z',
      last_op_id: 'earlier-op',
    });
    expect(await audited()).toEqual([...targets].sort());
  });

  it('stages one audit row per revoked token with the system actor and the cause', async () => {
    const id = await seed();
    const input = page([id]);

    await store.revokePage(a, input);

    const rows = await all<Record<string, unknown>>('SELECT * FROM audit_pending');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: a.orgId,
      actor_type: 'system',
      actor_id: null,
      action: 'token.revoke',
      target_type: 'token',
      target_id: id,
    });
    expect(JSON.parse(String(rows[0]?.payload_json))).toMatchObject({
      op_id: input.opId,
      changes: { cause: { new: 'suspended' } },
    });
  });

  it('leaves a service token untouched', async () => {
    const svc = await seed({ kind: 'svc' });

    expect(await store.revokePage(a, page([svc]))).toEqual({ status: 'ok', revoked: [] });
    expect((await states()).get(svc)?.revoked_at).toBeNull();
    expect(await audited()).toEqual([]);
  });

  it('leaves a customer token untouched', async () => {
    const cst = await seed({ kind: 'cst' });

    expect(await store.revokePage(a, page([cst]))).toEqual({ status: 'ok', revoked: [] });
    expect((await states()).get(cst)?.revoked_at).toBeNull();
    expect(await audited()).toEqual([]);
  });

  it('leaves another user personal token untouched', async () => {
    const other = await seed({ user: OTHER_USER });

    expect(await store.revokePage(a, page([other]))).toEqual({ status: 'ok', revoked: [] });
    expect((await states()).get(other)?.revoked_at).toBeNull();
    expect(await audited()).toEqual([]);
  });

  it('leaves the same user id in another organization untouched', async () => {
    const foreign = await seed({ org: b });
    await seedJob('job-b', b, 1);

    expect(await store.revokePage(a, page([foreign]))).toEqual({ status: 'ok', revoked: [] });
    expect(await store.revokePage(b, page([foreign], { jobId: 'job-b' }))).toEqual({
      status: 'ok',
      revoked: [foreign],
    });
    expect((await states()).get(foreign)?.revoked_at).toBe(NOW);
  });

  it('does not revoke a token of the user in the caller organization through a job of another', async () => {
    const mine = await seed();
    await seedJob('job-b', b, 1);

    expect(await store.revokePage(a, page([mine], { jobId: 'job-b' }))).toBe('lease_lost');
    expect((await states()).get(mine)?.revoked_at).toBeNull();
  });

  it('revokes nothing the second time and stages no second audit row', async () => {
    const ids = [await seed(), await seed()];

    expect(await store.revokePage(a, page(ids))).toEqual({ status: 'ok', revoked: ids });
    const first = await states();
    expect(await store.revokePage(a, page(ids))).toEqual({ status: 'ok', revoked: [] });

    expect(await states()).toEqual(first);
    expect(await audited()).toEqual([...ids].sort());
  });

  it('lets only one of two jobs for the same user revoke and audit a token', async () => {
    const id = await seed();
    await seedJob('job-2', a, 1);

    expect(await store.revokePage(a, page([id]))).toEqual({ status: 'ok', revoked: [id] });
    expect(await store.revokePage(a, page([id], { jobId: 'job-2' }))).toEqual({
      status: 'ok',
      revoked: [],
    });

    expect(await audited()).toEqual([id]);
  });

  it('skips a candidate revoked by hand before the page ran and audits it no second time', async () => {
    const first = await seed();
    const second = await seed();
    await run("UPDATE token SET revoked_at = '2026-10-20T11:30:00.000Z' WHERE id = ?", first);

    expect(await store.revokePage(a, page([first, second]))).toEqual({
      status: 'ok',
      revoked: [second],
    });

    expect((await states()).get(first)?.revoked_at).toBe('2026-10-20T11:30:00.000Z');
    expect(await audited()).toEqual([second]);
  });

  it('compares the cutoff as an instant', async () => {
    const atCutoff = await seed({ createdAt: CUTOFF });
    const late = await seed({ createdAt: AFTER });

    expect(await store.revokePage(a, page([atCutoff, late]))).toEqual({
      status: 'ok',
      revoked: [atCutoff],
    });
  });

  describe('lease', () => {
    it('writes nothing when the fence moved before the batch', async () => {
      const ids = [await seed(), await seed()];
      await run('UPDATE job SET fence = fence + 1 WHERE id = ?', JOB);

      expect(await store.revokePage(a, page(ids))).toBe('lease_lost');

      const after = await states();
      for (const id of ids) expect(after.get(id)?.revoked_at).toBeNull();
      expect(await audited()).toEqual([]);
    });

    it('writes nothing when the lease has expired', async () => {
      const id = await seed();
      await run("UPDATE job SET lease_until = '2020-01-01T00:00:00.000Z' WHERE id = ?", JOB);

      expect(await store.revokePage(a, page([id]))).toBe('lease_lost');
      expect((await states()).get(id)?.revoked_at).toBeNull();
      expect(await audited()).toEqual([]);
    });

    it('writes nothing when the job is no longer running', async () => {
      const id = await seed();
      await run(
        "UPDATE job SET state = 'succeeded', lease_owner = NULL, lease_until = NULL WHERE id = ?",
        JOB,
      );

      expect(await store.revokePage(a, page([id]))).toBe('lease_lost');
      expect((await states()).get(id)?.revoked_at).toBeNull();
    });

    it('writes nothing when the job does not exist', async () => {
      const id = await seed();

      expect(await store.revokePage(a, page([id], { jobId: 'missing' }))).toBe('lease_lost');
      expect((await states()).get(id)?.revoked_at).toBeNull();
    });
  });

  describe('outcome classification', () => {
    it('reports indeterminate when the executor loses the response', async () => {
      const id = await seed();
      const lossy: SqlExecutor = {
        ...executor,
        all: (statement) => executor.all(statement),
        batch: () => Promise.reject(new DbError('unknown', 'network reset')),
      };

      expect(await createPatOffboardingRepository(lossy).revokePage(a, page([id]))).toBe(
        'indeterminate',
      );
    });

    it('rethrows an error that is neither a lost lease nor a lost response', async () => {
      const id = await seed();
      const broken: SqlExecutor = {
        ...executor,
        all: (statement) => executor.all(statement),
        batch: () => Promise.reject(new DbError('check', 'check constraint failed')),
      };

      await expect(
        createPatOffboardingRepository(broken).revokePage(a, page([id])),
      ).rejects.toBeInstanceOf(DbError);
    });
  });

  describe('input validation', () => {
    it('refuses more than 25 ids before SQL', async () => {
      const ids = await Promise.all(Array.from({ length: 26 }, () => seed()));

      await expect(store.revokePage(a, page(ids))).rejects.toThrow(RangeError);
      expect((await states()).get(ids[0] as string)?.revoked_at).toBeNull();
    });

    it('refuses an empty page', async () => {
      await expect(store.revokePage(a, page([]))).rejects.toThrow(RangeError);
    });

    it('refuses repeated ids', async () => {
      const id = await seed();

      await expect(store.revokePage(a, page([id, id]))).rejects.toThrow(TypeError);
    });

    it('refuses audits that do not match the ids', async () => {
      const id = await seed();
      const other = await seed();
      const input = page([id]);

      await expect(
        store.revokePage(a, { ...input, audits: [auditFor(other, input.opId)] }),
      ).rejects.toThrow(TypeError);
      await expect(store.revokePage(a, { ...input, audits: [] })).rejects.toThrow(TypeError);
      expect((await states()).get(id)?.revoked_at).toBeNull();
    });

    it('refuses a non-canonical cutoff or timestamp and a bad fence', async () => {
      const id = await seed();

      await expect(
        store.revokePage(a, page([id], { cutoff: '2026-10-20T11:00:00Z' })),
      ).rejects.toThrow(TypeError);
      await expect(store.revokePage(a, { ...page([id]), now: 'now' })).rejects.toThrow(TypeError);
      await expect(store.revokePage(a, page([id], { fence: 0 }))).rejects.toThrow(RangeError);
      await expect(store.revokePage(a, { ...page([id]), opId: 'not-a-ulid' })).rejects.toThrow(
        TypeError,
      );
    });
  });
});

describe('statements', () => {
  function recording() {
    const batches: Statement[][] = [];
    const wrapped: SqlExecutor = {
      ...executor,
      all: (statement) => executor.all(statement),
      batch: (statements) => {
        batches.push([...statements]);
        return executor.batch(statements);
      },
    };
    return { batches, wrapped };
  }

  it('binds at most 100 parameters per statement and revokes 60 tokens in three pages', async () => {
    const { batches, wrapped } = recording();
    const ids = await Promise.all(Array.from({ length: 60 }, () => seed()));
    const entries: Record<string, unknown>[] = [];
    const job = createPatOffboardingJob({
      store: createPatOffboardingRepository(wrapped),
      clock: fixedClock(NOW),
      ids: { ulid },
      log: (entry) => entries.push({ ...entry }),
    });
    const context: JobContext = {
      org: a,
      jobId: JOB,
      idempotencyKey: 'k',
      attempt: 1,
      fence: 1,
      signal: new AbortController().signal,
      ports: {} as JobContext['ports'],
      observability: {} as JobContext['observability'],
    };

    await job.definition.handler(
      job.definition.validate({ userId: USER, cause: 'suspended', cutoff: CUTOFF }),
      context,
    );

    const revokeBatches = batches.filter((batch) =>
      batch.some((statement) => /UPDATE token/i.test(statement.sql)),
    );
    expect(revokeBatches).toHaveLength(3);
    const idCounts = revokeBatches.map(
      (batch) =>
        batch.filter((statement) => /INSERT INTO audit_pending/i.test(statement.sql)).length,
    );
    expect(idCounts).toEqual([25, 25, 10]);
    for (const batch of revokeBatches) {
      for (const statement of batch) expect(statement.params.length).toBeLessThanOrEqual(100);
    }
    const updates = revokeBatches.flatMap((batch) =>
      batch.filter((statement) => /UPDATE token/i.test(statement.sql)),
    );
    expect(updates.map((statement) => statement.params.length)).toEqual([6, 6, 6]);
    const states60 = await states();
    for (const id of ids) expect(states60.get(id)?.revoked_at).toBe(NOW);
    expect(await audited()).toEqual([...ids].sort());
    expect(entries.filter((entry) => entry.event === 'token.revoked')).toHaveLength(60);
    expect(entries.at(-1)).toMatchObject({ event: 'token.offboarding_done', revoked: 60 });
  });

  it('pins every statement to the organization', async () => {
    const { batches, wrapped } = recording();
    const id = await seed();
    await createPatOffboardingRepository(wrapped).revokePage(a, page([id]));

    const sqlText = batches.flat().map((statement) => statement.sql);
    expect(sqlText.filter((text) => /UPDATE token/i.test(text))).toSatisfy((list: string[]) =>
      list.every((text) => /org_id = \?/.test(text) && /kind = 'pat'/.test(text)),
    );
  });
});

describe('suspendedUsersWithLivePats', () => {
  type SweepRepository = ReturnType<typeof createPatOffboardingRepository>;
  const sweep = (): SweepRepository => createPatOffboardingRepository(executor);

  function userKey(n: number): string {
    return `01J0SWEEP${String(n).padStart(17, '0')}`;
  }

  async function addUser(
    id: string,
    status: 'active' | 'suspended',
    org: OrgContext = a,
  ): Promise<void> {
    await run(
      'INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, ?)',
      id,
      org.orgId,
      `${id.toLowerCase()}@example.test`,
      status,
    );
  }

  it('lists suspended users with an unrevoked personal token, ordered by id', async () => {
    await addUser(userKey(2), 'suspended');
    await addUser(userKey(1), 'suspended');
    await seed({ user: userKey(2) });
    await seed({ user: userKey(1) });

    expect(await sweep().suspendedUsersWithLivePats(a, '', 100)).toEqual([userKey(1), userKey(2)]);
  });

  it('lists a user once however many tokens they hold', async () => {
    await seed();
    await seed();

    expect(await sweep().suspendedUsersWithLivePats(a, '', 100)).toEqual([USER]);
  });

  it('skips a suspended user with no personal token', async () => {
    await addUser(userKey(1), 'suspended');

    expect(await sweep().suspendedUsersWithLivePats(a, '', 100)).toEqual([]);
  });

  it('skips a suspended user whose personal tokens are all revoked', async () => {
    await seed({ revokedAt: BEFORE });

    expect(await sweep().suspendedUsersWithLivePats(a, '', 100)).toEqual([]);
  });

  it('skips a suspended user who holds only service tokens', async () => {
    await seed({ kind: 'svc' });

    expect(await sweep().suspendedUsersWithLivePats(a, '', 100)).toEqual([]);
  });

  it('skips an active user with a personal token', async () => {
    await seed({ user: OTHER_USER });

    expect(await sweep().suspendedUsersWithLivePats(a, '', 100)).toEqual([]);
  });

  it('keeps an expired but unrevoked personal token live', async () => {
    await seed({ expiresAt: '2020-01-01T00:00:00.000Z' });

    expect(await sweep().suspendedUsersWithLivePats(a, '', 100)).toEqual([USER]);
  });

  it('does not return a suspended user of another organization', async () => {
    await addUser(userKey(1), 'suspended', b);
    await seed({ org: b, user: userKey(1) });

    expect(await sweep().suspendedUsersWithLivePats(a, '', 100)).toEqual([]);
    expect(await sweep().suspendedUsersWithLivePats(b, '', 100)).toEqual([userKey(1)]);
  });

  it('does not count a personal token stored under another organization', async () => {
    await seed({ org: b });

    expect(await sweep().suspendedUsersWithLivePats(a, '', 100)).toEqual([]);
  });

  it('returns only users above the cursor', async () => {
    for (let n = 1; n <= 3; n += 1) {
      await addUser(userKey(n), 'suspended');
      await seed({ user: userKey(n) });
    }

    expect(await sweep().suspendedUsersWithLivePats(a, userKey(1), 100)).toEqual([
      userKey(2),
      userKey(3),
    ]);
    expect(await sweep().suspendedUsersWithLivePats(a, userKey(3), 100)).toEqual([]);
  });

  it('returns at most the limit', async () => {
    for (let n = 1; n <= 3; n += 1) {
      await addUser(userKey(n), 'suspended');
      await seed({ user: userKey(n) });
    }

    expect(await sweep().suspendedUsersWithLivePats(a, '', 2)).toEqual([userKey(1), userKey(2)]);
  });

  it.each([0, 101, -1, 1.5, Number.NaN, '5'])(
    'rejects the limit %s with a RangeError',
    async (limit) => {
      await expect(sweep().suspendedUsersWithLivePats(a, '', limit as number)).rejects.toThrow(
        RangeError,
      );
    },
  );

  it('binds three parameters and pins both tables to the organization', async () => {
    const seen: Statement[] = [];
    const spying: SqlExecutor = {
      ...executor,
      all: (statement) => {
        seen.push(statement);
        return executor.all(statement);
      },
    };

    await createPatOffboardingRepository(spying).suspendedUsersWithLivePats(a, '', 100);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.params).toEqual([a.orgId, '', 100]);
    expect(seen[0]?.sql).toMatch(/\bu\.org_id = \?/);
    expect(seen[0]?.sql).toMatch(/t\.org_id = u\.org_id/);
  });

  describe('sweep job against the repository', () => {
    const DAY = '2026-10-20';
    const SWEEP_NOW = '2026-10-20T12:00:00.000Z';

    function sweepContext(): JobContext {
      return {
        org: a,
        jobId: 'job-sweep',
        idempotencyKey: 'k',
        attempt: 1,
        fence: 1,
        signal: new AbortController().signal,
        ports: {} as JobContext['ports'],
        observability: {} as JobContext['observability'],
      };
    }

    function recordingJobs() {
      const seenKeys = new Set<string>();
      const calls: { payload: { userId: string; cutoff: string }; key: string }[] = [];
      const jobs: Pick<Jobs, 'enqueue'> = {
        enqueue: async (_ctx, type, payload, input) => {
          expect(type).toBe(PAT_OFFBOARDING_JOB_TYPE);
          calls.push({
            payload: payload as { userId: string; cutoff: string },
            key: input.idempotencyKey,
          });
          const created = !seenKeys.has(input.idempotencyKey);
          seenKeys.add(input.idempotencyKey);
          return { id: input.idempotencyKey, created };
        },
      };
      return { jobs, calls };
    }

    function runSweep(
      jobs: Pick<Jobs, 'enqueue'>,
      store: PatOffboardingSweepStoreLike = sweep(),
    ): Promise<void> {
      const job = createPatOffboardingSweepJob({
        store,
        jobs,
        clock: fixedClock(SWEEP_NOW),
        log: () => undefined,
      });
      return job.definition.handler(job.definition.validate({}), sweepContext());
    }

    type PatOffboardingSweepStoreLike = Pick<SweepRepository, 'suspendedUsersWithLivePats'>;

    it('enqueues exactly the two qualifying users with the run date in the key', async () => {
      await addUser(userKey(1), 'suspended');
      await addUser(userKey(2), 'suspended');
      await addUser(userKey(3), 'suspended');
      await addUser(userKey(4), 'active');
      await seed({ user: userKey(1) });
      await seed({ user: userKey(2) });
      await seed({ user: userKey(4) });
      const { jobs, calls } = recordingJobs();

      await runSweep(jobs);

      expect(calls.map((call) => call.key)).toEqual([
        `pat-offboarding:${userKey(1)}:suspended:sweep:${DAY}`,
        `pat-offboarding:${userKey(2)}:suspended:sweep:${DAY}`,
      ]);
      expect(calls.map((call) => call.payload.userId)).toEqual([userKey(1), userKey(2)]);
    });

    it('completes a second run on the same day with no new job, through the real jobs port', async () => {
      await addUser(userKey(1), 'suspended');
      await seed({ user: userKey(1) });
      await seed();
      const offboarding = createPatOffboardingJob({
        store: createPatOffboardingRepository(executor),
        clock: fixedClock(SWEEP_NOW),
        ids: { ulid },
        log: () => undefined,
      });
      const jobs = createRepositoryJobs({
        store: createJobRepository(executor, { random: () => 0.5 }),
        jobs: [offboarding],
        clock: fixedClock(SWEEP_NOW),
        ids: { ulid },
      })('core', { projectId: null, tokenId: null });
      const events: Record<string, unknown>[] = [];
      const sweepAt = (instant: string) =>
        createPatOffboardingSweepJob({
          store: sweep(),
          jobs,
          clock: fixedClock(instant),
          log: (entry) => events.push({ ...entry }),
        });
      const execute = (instant: string) => {
        const job = sweepAt(instant);
        return job.definition.handler(job.definition.validate({}), sweepContext());
      };

      await execute('2026-10-20T08:00:00.000Z');
      await execute('2026-10-20T20:30:00.000Z');

      expect(events.map((entry) => entry.enqueued)).toEqual([2, 0]);
      const stored = await all<{ n: number }>(
        'SELECT COUNT(*) AS n FROM job WHERE type = ? AND org_id = ? AND id <> ?',
        PAT_OFFBOARDING_JOB_TYPE,
        a.orgId,
        JOB,
      );
      expect(stored[0]?.n).toBe(2);
    });

    it('enqueues all 150 qualifying users in one run', async () => {
      for (let n = 1; n <= 150; n += 1) {
        await addUser(userKey(n), 'suspended');
        await seed({ user: userKey(n) });
      }
      const { jobs, calls } = recordingJobs();

      await runSweep(jobs);

      expect(calls).toHaveLength(150);
      expect(calls[0]?.payload.userId).toBe(userKey(1));
      expect(calls[149]?.payload.userId).toBe(userKey(150));
    });

    it('does not revoke a personal token created after the cutoff the run enqueued', async () => {
      const lateAt = '2026-10-20T12:00:00.001Z';
      const late = tokenId(900);
      const spied: PatOffboardingSweepStoreLike = {
        suspendedUsersWithLivePats: async (ctx, afterId, limit) => {
          const ids = await sweep().suspendedUsersWithLivePats(ctx, afterId, limit);
          await run(
            `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json,
               read_only, user_id, created_by_user_id, expires_at, project_mode, created_at)
             VALUES (?, ?, 'pat', 'lateselector', ?, 1, 'late', '["write"]', 0, ?, ?, ?, 'all', ?)`,
            late,
            a.orgId,
            'a'.repeat(64),
            USER,
            USER,
            '2027-01-01T00:00:00.000Z',
            lateAt,
          );
          return ids;
        },
      };
      const early = await seed();
      const { jobs, calls } = recordingJobs();

      await runSweep(jobs, spied);

      const cutoff = calls[0]?.payload.cutoff ?? '';
      expect(cutoff).toBe(SWEEP_NOW);
      expect(await sweep().candidates(a, { userId: USER, cutoff, limit: 25 })).toEqual([early]);
    });
  });
});

describe('project_removed against the repository', () => {
  const PROJECT_2 = '01HZX3VQ7N5R8T2W4Y6A9B1C2J';
  const PROJECT_3 = '01HZX3VQ7N5R8T2W4Y6A9B1C2K';
  const AT = '2026-10-20T11:30:00.000Z';
  const LATER = '2026-10-20T11:45:00.000Z';

  beforeEach(async () => {
    await run(
      "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'two', 'Two')",
      PROJECT_2,
      a.orgId,
    );
    await run(
      "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'three', 'Three')",
      PROJECT_3,
      a.orgId,
    );
  });

  async function selected(projects: readonly string[], options: Seed = {}): Promise<string> {
    const id = await seed(options);
    await run("UPDATE token SET project_mode = 'selected' WHERE id = ?", id);
    for (const project of projects) {
      await run(
        'INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, ?)',
        (options.org ?? a).orgId,
        id,
        project,
      );
    }
    return id;
  }

  async function holds(
    project: string | null,
    createdAt = BEFORE,
    subject: { type: 'email' | 'group'; value: string; provider?: string } = {
      type: 'email',
      value: EMAIL,
    },
  ): Promise<void> {
    counter += 1;
    await run(
      `INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      `grant-${counter}`,
      a.orgId,
      subject.type,
      subject.value,
      subject.type === 'group' ? (subject.provider ?? 'oidc') : null,
      project === null ? 'organization' : 'project',
      project,
      ROLE,
      createdAt,
    );
  }

  async function lost(cutoff = AT): Promise<string[]> {
    return [
      ...(await store.candidates(a, {
        userId: USER,
        cutoff,
        limit: 25,
        selectedOnly: true,
      })),
    ];
  }

  async function offboard(cutoff = AT): Promise<void> {
    const job = createPatOffboardingJob({
      store,
      clock: fixedClock(NOW),
      ids: { ulid },
      log: () => undefined,
    });
    await job.definition.handler(
      job.definition.validate({ userId: USER, cause: 'project_removed', cutoff }),
      {
        org: a,
        jobId: JOB,
        idempotencyKey: 'k',
        attempt: 1,
        fence: 1,
        signal: new AbortController().signal,
        ports: {} as JobContext['ports'],
        observability: {} as JobContext['observability'],
      },
    );
  }

  async function revoked(id: string): Promise<boolean> {
    return (await states()).get(id)?.revoked_at !== null;
  }

  it('revokes a selected token whose only project the user no longer holds', async () => {
    const only = await selected([PROJECT]);

    await offboard();

    expect(await revoked(only)).toBe(true);
    expect(await audited()).toEqual([only]);
    const payload = await all<{ payload_json: string }>(
      'SELECT payload_json FROM audit_pending WHERE target_id = ?',
      only,
    );
    expect(payload[0]?.payload_json).toContain('"project_removed"');
  });

  it('keeps a selected token with two projects while the user holds one of them', async () => {
    const both = await selected([PROJECT, PROJECT_2]);
    await holds(PROJECT_2);

    await offboard();

    expect(await revoked(both)).toBe(false);
    expect(await audited()).toEqual([]);
  });

  it('revokes a selected token when the user holds none of its two projects', async () => {
    const both = await selected([PROJECT, PROJECT_2]);
    await holds(PROJECT_3);

    await offboard();

    expect(await revoked(both)).toBe(true);
  });

  it('keeps an all-projects token', async () => {
    const all = await seed();

    await offboard();

    expect(await revoked(all)).toBe(false);
  });

  it('keeps service and customer tokens, even bound to selected projects', async () => {
    const service = await selected([PROJECT], { kind: 'svc' });
    const customer = await selected([PROJECT], { kind: 'cst' });

    expect(await lost()).toEqual([]);
    await offboard();

    expect(await revoked(service)).toBe(false);
    expect(await revoked(customer)).toBe(false);
  });

  it('does not bring back a revoked token when the user is granted the project again', async () => {
    const only = await selected([PROJECT]);
    await offboard();
    const stamp = (await states()).get(only)?.revoked_at;

    await holds(PROJECT, LATER);
    await offboard(LATER);

    expect(stamp).toBe(NOW);
    expect((await states()).get(only)?.revoked_at).toBe(NOW);
    expect(await lost(LATER)).toEqual([]);
  });

  it('revokes when the project is granted again only after the removal instant', async () => {
    const only = await selected([PROJECT]);
    await holds(PROJECT, LATER);

    await offboard();

    expect(await revoked(only)).toBe(true);
  });

  it('keeps a token while a grant at or before the cutoff still reaches its project', async () => {
    const only = await selected([PROJECT]);
    await holds(PROJECT, AT);

    expect(await lost()).toEqual([]);
    await offboard();

    expect(await revoked(only)).toBe(false);
  });

  it('treats an organization grant as holding every project', async () => {
    const only = await selected([PROJECT]);
    await holds(null);

    await offboard();

    expect(await revoked(only)).toBe(false);
  });

  it('counts a project grant to a group the user belongs to', async () => {
    const only = await selected([PROJECT]);
    await holds(PROJECT, BEFORE, { type: 'group', value: 'staff' });

    expect(await lost()).toEqual([only]);
    await run(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'oidc', 'staff')",
      a.orgId,
      USER,
    );

    expect(await lost()).toEqual([]);
  });

  it('does not count membership in a different group name', async () => {
    const only = await selected([PROJECT]);
    await holds(PROJECT, BEFORE, { type: 'group', value: 'staff' });
    await run(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'oidc', 'visitors')",
      a.orgId,
      USER,
    );

    expect(await lost()).toEqual([only]);
    await offboard();
    expect(await revoked(only)).toBe(true);
  });

  it('does not count membership under a different provider', async () => {
    const only = await selected([PROJECT]);
    await holds(PROJECT, BEFORE, { type: 'group', value: 'staff', provider: 'oidc' });
    await run(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'saml', 'staff')",
      a.orgId,
      USER,
    );

    expect(await lost()).toEqual([only]);
    await offboard();
    expect(await revoked(only)).toBe(true);
  });

  it('revokes a selected token that has no project bound', async () => {
    const empty = await selected([]);

    await offboard();

    expect(await revoked(empty)).toBe(true);
  });

  it('leaves tokens of other users, newer tokens and already revoked tokens alone', async () => {
    const other = await selected([PROJECT], { user: OTHER_USER });
    const newer = await selected([PROJECT], { createdAt: LATER });
    const gone = await selected([PROJECT], { revokedAt: '2026-10-01T00:00:00.000Z' });

    expect(await lost()).toEqual([]);
    await offboard();

    expect(await revoked(other)).toBe(false);
    expect(await revoked(newer)).toBe(false);
    expect((await states()).get(gone)?.revoked_at).toBe('2026-10-01T00:00:00.000Z');
  });

  it('re-checks the held projects when it revokes, not only when it lists', async () => {
    const held = await selected([PROJECT]);
    await holds(PROJECT);

    const outcome = await store.revokePage(a, {
      ...page([held], { cutoff: AT }),
      selectedOnly: true,
    });

    expect(outcome).toEqual({ status: 'ok', revoked: [] });
    expect(await revoked(held)).toBe(false);
    expect(await audited()).toEqual([]);
  });

  it('does not narrow a page that is not selectedOnly', async () => {
    const held = await selected([PROJECT]);
    await holds(PROJECT);

    const outcome = await store.revokePage(a, page([held], { cutoff: AT }));

    expect(outcome).toEqual({ status: 'ok', revoked: [held] });
  });

  it('binds a bounded number of parameters', async () => {
    const seen: Statement[] = [];
    const spy: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => {
        seen.push(statement);
        return executor.all(statement);
      },
      batch: (statements) => {
        seen.push(...statements);
        return executor.batch(statements);
      },
    };
    const spied = createPatOffboardingRepository(spy);

    await spied.candidates(a, { userId: USER, cutoff: AT, limit: 25, selectedOnly: true });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.params.length).toBeLessThanOrEqual(100);
    expect(seen[0]?.sql).not.toMatch(/\bLIKE\b|\bGLOB\b/i);
  });

  it('ignores a token of another organization', async () => {
    await run(
      "INSERT INTO project (id, org_id, slug, name) VALUES ('proj-b', ?, 'b', 'B')",
      b.orgId,
    );
    const mine = await selected([PROJECT]);
    const theirs = await seed({ org: b });
    await run("UPDATE token SET project_mode = 'selected' WHERE id = ?", theirs);
    await run(
      "INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, 'proj-b')",
      b.orgId,
      theirs,
    );

    expect(await lost()).toEqual([mine]);
  });
});
