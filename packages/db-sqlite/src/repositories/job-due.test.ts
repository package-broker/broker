import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { JobEnqueue } from '@package-broker/core/platform/job-repository';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  JOB_DUE_PAGE_LIMIT,
  JOB_UNREGISTERED_GRACE_SECONDS,
  createJobRepository,
  type SqliteJobRepository,
} from './job.js';

const TYPE = 'demo:due:v1';
const GONE = 'demo:gone:v1';
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2099-01-01T00:00:00.000Z';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0001';

let counter = 0;
function nextId(): string {
  counter += 1;
  return `01J0DUE${String(counter).padStart(19, '0')}`;
}

function row(id: string, type = TYPE, resourceKey: string | null = null): JobEnqueue {
  return {
    id,
    type,
    payloadJson: '{}',
    idempotencyKey: `${TYPE}:${id}`,
    resourceKey,
    runAt: null,
    maxAttempts: 3,
    projectId: null,
    initiatorTokenId: null,
  };
}

function recording(executor: SqlExecutor): { executor: SqlExecutor; statements: Statement[] } {
  const statements: Statement[] = [];
  return {
    statements,
    executor: {
      driver: executor.driver,
      all: (statement) => {
        statements.push(statement);
        return executor.all(statement);
      },
      batch: (batch) => {
        statements.push(...batch);
        return executor.batch(batch);
      },
    } as SqlExecutor,
  };
}

describe('JobRepository.listDue', () => {
  let database: MigratedDatabase;
  let repo: SqliteJobRepository;
  let a: OrgContext;
  let b: OrgContext;

  async function enqueue(
    ctx: OrgContext,
    runAt: string,
    type = TYPE,
    resourceKey: string | null = null,
  ): Promise<string> {
    const id = nextId();
    await repo.enqueue(ctx, row(id, type, resourceKey));
    await database.executor.batch([
      { sql: 'UPDATE job SET run_at = ? WHERE id = ?', params: [runAt, id] },
    ]);
    return id;
  }

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    if (database.orgs === null) throw new Error('organizations not seeded');
    ({ a, b } = database.orgs);
    repo = createJobRepository(database.executor);
  });

  afterEach(async () => {
    await database.close();
  });

  it('returns only due queued jobs of the org, ordered by run_at then id', async () => {
    const late = await enqueue(a, '2021-01-01T00:00:00.000Z');
    const early = await enqueue(a, PAST);
    const tie = await enqueue(a, PAST);
    await enqueue(a, FUTURE);
    await enqueue(b, PAST);
    const running = await enqueue(a, PAST);
    await repo.claim(a, OWNER, { id: running, types: [TYPE], leaseSeconds: 60, maxRunning: 10 });

    expect(await repo.listDue(a, { types: [TYPE], limit: 10 })).toEqual([early, tie, late]);
  });

  it('excludes succeeded and dead jobs', async () => {
    const done = await enqueue(a, PAST);
    await database.executor.batch([
      { sql: "UPDATE job SET state = 'succeeded' WHERE id = ?", params: [done] },
    ]);
    const dead = await enqueue(a, PAST);
    await database.executor.batch([
      { sql: "UPDATE job SET state = 'dead' WHERE id = ?", params: [dead] },
    ]);
    expect(await repo.listDue(a, { types: [TYPE], limit: 10 })).toEqual([]);
  });

  it('pages with a keyset cursor without gaps or duplicates', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      ids.push(await enqueue(a, `2020-01-0${String((i % 3) + 1)}T00:00:00.000Z`));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await repo.listDue(a, { types: [TYPE], limit: 3, afterId: cursor });
      expect(page.length).toBeLessThanOrEqual(3);
      if (page.length === 0) break;
      seen.push(...page);
      cursor = page[page.length - 1];
    }
    expect(seen).toEqual(await repo.listDue(a, { types: [TYPE], limit: 10 }));
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('returns an empty page for an unknown, foreign or no longer queued cursor', async () => {
    const own = await enqueue(a, PAST);
    await enqueue(a, '2021-01-01T00:00:00.000Z');
    const foreign = await enqueue(b, PAST);
    expect(
      await repo.listDue(a, { types: [TYPE], limit: 10, afterId: '01J0NOPE000000000000000000' }),
    ).toEqual([]);
    expect(await repo.listDue(a, { types: [TYPE], limit: 10, afterId: foreign })).toEqual([]);
    await repo.claim(a, OWNER, { id: own, types: [TYPE], leaseSeconds: 60, maxRunning: 10 });
    expect(await repo.listDue(a, { types: [TYPE], limit: 10, afterId: own })).toEqual([]);
  });

  it('rejects a limit outside 1..JOB_DUE_PAGE_LIMIT and an empty cursor', async () => {
    for (const limit of [0, -1, 1.5, JOB_DUE_PAGE_LIMIT + 1, Number.NaN]) {
      await expect(repo.listDue(a, { types: [TYPE], limit: limit })).rejects.toThrow(RangeError);
    }
    await expect(repo.listDue(a, { types: [TYPE], limit: 1, afterId: '' })).rejects.toThrow(
      RangeError,
    );
    await expect(repo.listDue(a, { types: [TYPE], limit: JOB_DUE_PAGE_LIMIT })).resolves.toEqual(
      [],
    );
  });

  it('skips unregistered types and resource-blocked rows', async () => {
    await enqueue(a, PAST, GONE);
    const holder = await enqueue(a, PAST, TYPE, 'res-1');
    await repo.claim(a, OWNER, { id: holder, types: [TYPE], leaseSeconds: 60, maxRunning: 10 });
    await enqueue(a, PAST, TYPE, 'res-1');
    const free = await enqueue(a, PAST, TYPE, 'res-2');
    expect(await repo.listDue(a, { types: [TYPE], limit: 10 })).toEqual([free]);
    expect(await repo.listDue(a, { types: [], limit: 10 })).toEqual([]);
  });

  it('a page of 50 stuck rows no longer hides a newer due job', async () => {
    const holder = await enqueue(a, PAST, TYPE, 'blocked');
    await repo.claim(a, OWNER, { id: holder, types: [TYPE], leaseSeconds: 60, maxRunning: 10 });
    for (let i = 0; i < 25; i += 1) {
      await enqueue(a, PAST, GONE);
      await enqueue(a, PAST, TYPE, 'blocked');
    }
    const fresh = await enqueue(a, '2021-01-01T00:00:00.000Z');
    expect(await repo.listDue(a, { types: [TYPE], limit: 50 })).toEqual([fresh]);
  });

  it('buries queued jobs of an unregistered type once they are past the grace period', async () => {
    const old = await enqueue(a, PAST, GONE);
    const old2 = await enqueue(a, PAST, GONE);
    const recent = await enqueue(a, new Date(Date.now() - 60_000).toISOString(), GONE);
    const registered = await enqueue(a, PAST, TYPE);
    const foreign = await enqueue(b, PAST, GONE);
    const input = { types: [TYPE], graceSeconds: JOB_UNREGISTERED_GRACE_SECONDS };

    expect(await repo.buryUnregistered(a, { ...input, limit: 1 })).toBe(1);
    expect(await repo.buryUnregistered(a, { ...input, limit: 10 })).toBe(1);
    expect(await repo.buryUnregistered(a, { ...input, limit: 10 })).toBe(0);

    for (const id of [old, old2]) {
      const status = await repo.status(a, id);
      expect(status?.state).toBe('dead');
      expect(status?.lastErrorCode).toBe('unknown_job_type');
    }
    expect((await repo.status(a, recent))?.state).toBe('queued');
    expect((await repo.status(a, registered))?.state).toBe('queued');
    expect((await repo.status(b, foreign))?.state).toBe('queued');
  });

  it('lists at most one due row per resource, the first by (run_at, id)', async () => {
    const first = await enqueue(a, PAST, TYPE, 'shared');
    await enqueue(a, PAST, TYPE, 'shared');
    await enqueue(a, '2021-01-01T00:00:00.000Z', TYPE, 'shared');
    const other = await enqueue(a, '2021-01-01T00:00:00.000Z', TYPE, 'other');
    const plain = await enqueue(a, '2022-01-01T00:00:00.000Z');
    expect(await repo.listDue(a, { types: [TYPE], limit: 10 })).toEqual([first, other, plain]);
  });

  it('buries nothing for an empty registered-type list', async () => {
    const old = await enqueue(a, PAST, GONE);
    const registered = await enqueue(a, PAST, TYPE);
    expect(
      await repo.buryUnregistered(a, {
        types: [],
        graceSeconds: JOB_UNREGISTERED_GRACE_SECONDS,
        limit: 10,
      }),
    ).toBe(0);
    expect((await repo.status(a, old))?.state).toBe('queued');
    expect((await repo.status(a, registered))?.state).toBe('queued');
  });

  it('spares a type that ran within the grace window (rollback after a type returned)', async () => {
    const stale = await enqueue(a, PAST, GONE);
    const ran = await enqueue(a, PAST, GONE);
    await repo.claim(a, OWNER, { id: ran, types: [GONE], leaseSeconds: 60, maxRunning: 10 });
    const input = { types: [TYPE], graceSeconds: JOB_UNREGISTERED_GRACE_SECONDS, limit: 10 };

    expect(await repo.buryUnregistered(a, { ...input, types: [TYPE, GONE] })).toBe(0);
    expect(await repo.buryUnregistered(a, input)).toBe(0);
    expect((await repo.status(a, stale))?.state).toBe('queued');

    await database.executor.batch([
      { sql: 'UPDATE job_attempt SET started_at = ? WHERE job_id = ?', params: [PAST, ran] },
    ]);
    expect(await repo.buryUnregistered(a, input)).toBe(1);
    expect((await repo.status(a, stale))?.state).toBe('dead');
  });

  it('rejects out-of-range burial input', async () => {
    const input = { types: [TYPE], graceSeconds: 60, limit: 1 };
    await expect(repo.buryUnregistered(a, { ...input, limit: 0 })).rejects.toThrow(RangeError);
    await expect(repo.buryUnregistered(a, { ...input, graceSeconds: -1 })).rejects.toThrow(
      RangeError,
    );
    await expect(repo.buryUnregistered(a, { ...input, types: [''] })).rejects.toThrow(RangeError);
  });

  it('is one executor call on the due index, judged by database time', async () => {
    const recorded = recording(database.executor);
    const counted = createJobRepository(recorded.executor);
    const id = await enqueue(a, PAST);
    await counted.listDue(a, { types: [TYPE], limit: 5, afterId: id });
    expect(recorded.statements).toHaveLength(1);
    const [statement] = recorded.statements;
    expect(statement?.sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ','now')");

    const plan = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN ${statement?.sql ?? ''}`,
      params: statement?.params ?? [],
    });
    const details = plan.map((step) => step.detail).join('\n');
    expect(details).toMatch(/USING (COVERING )?INDEX job_claim/);
    expect(details).not.toMatch(/SCAN job\b(?! USING)/);
    expect(details).not.toContain('TEMP B-TREE');
  });
});
