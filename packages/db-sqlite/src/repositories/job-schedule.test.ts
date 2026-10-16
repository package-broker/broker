import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { JobScheduleTickError, createJobScheduleRepository } from './job-schedule.js';

const NAME = 'core:session-cleanup:v1';
const OTHER = 'core:index-refresh:v1';
const EVERY = 60;

interface ScheduleRow {
  readonly name: string;
  readonly every_seconds: number;
  readonly next_run_at: string;
  readonly last_slot: string | null;
  readonly enabled: number;
}

interface JobRow {
  readonly id: string;
  readonly org_id: string;
  readonly type: string;
  readonly payload_json: string;
  readonly idempotency_key: string;
  readonly state: string;
  readonly run_at: string;
}

function iso(offsetSeconds: number): string {
  return new Date(Math.floor(Date.now() / 60_000) * 60_000 + offsetSeconds * 1000).toISOString();
}

async function schedules(executor: SqlExecutor): Promise<ScheduleRow[]> {
  return executor.all<ScheduleRow>({
    sql: 'SELECT name, every_seconds, next_run_at, last_slot, enabled FROM job_schedule ORDER BY name',
    params: [],
  });
}

async function jobs(executor: SqlExecutor): Promise<JobRow[]> {
  return executor.all<JobRow>({
    sql: 'SELECT id, org_id, type, payload_json, idempotency_key, state, run_at FROM job ORDER BY idempotency_key',
    params: [],
  });
}

describe('job schedule repository', () => {
  let database: MigratedDatabase;
  let ctx: OrgContext;

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true });
    ctx = database.orgs!.a;
  });

  afterEach(async () => {
    await database.close();
  });

  it('upsert creates the row once and leaves an existing row untouched', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(3600) });
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(7200) });
    const rows = await schedules(database.executor);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: NAME, every_seconds: EVERY, enabled: 1 });
    expect(rows[0]!.next_run_at).toBe(iso(3600));
  });

  it('upsert refuses an in-place interval change', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(3600) });
    await expect(
      repo.upsert(ctx, { name: NAME, everySeconds: EVERY * 2, nextRunAt: iso(3600) }),
    ).rejects.toThrow(RangeError);
    expect((await schedules(database.executor))[0]!.every_seconds).toBe(EVERY);
  });

  it('upsert re-enables a disabled row with the same interval', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(3600) });
    await repo.disable(ctx, NAME);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(3600) });
    expect((await schedules(database.executor))[0]!.enabled).toBe(1);
  });

  it('upsert validates its input', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await expect(
      repo.upsert(ctx, { name: '', everySeconds: EVERY, nextRunAt: iso(0) }),
    ).rejects.toThrow();
    await expect(
      repo.upsert(ctx, { name: NAME, everySeconds: 90, nextRunAt: iso(0) }),
    ).rejects.toThrow();
    await expect(
      repo.upsert(ctx, {
        name: `core:${'a'.repeat(130)}:v1`,
        everySeconds: EVERY,
        nextRunAt: iso(0),
      }),
    ).rejects.toThrow();
    await expect(
      repo.upsert(ctx, { name: NAME, everySeconds: 0, nextRunAt: iso(0) }),
    ).rejects.toThrow();
    await expect(
      repo.upsert(ctx, { name: NAME, everySeconds: 1.5, nextRunAt: iso(0) }),
    ).rejects.toThrow();
    await expect(
      repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: 'tomorrow' }),
    ).rejects.toThrow();
    expect(await schedules(database.executor)).toHaveLength(0);
  });

  it('tick fires nothing before the row is due', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(3600) });
    expect(await repo.tick(ctx)).toEqual([]);
    expect(await jobs(database.executor)).toHaveLength(0);
  });

  it('tick inserts one keyed job for the due slot and advances the row', async () => {
    const repo = createJobScheduleRepository(database.executor);
    const slot = iso(0);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: slot });
    const fired = await repo.tick(ctx);
    const stored = await jobs(database.executor);
    expect(stored).toHaveLength(1);
    expect(fired).toEqual([{ name: NAME, jobId: stored[0]!.id }]);
    const firedSlot = stored[0]!.idempotency_key.slice(`schedule:${NAME}:`.length);
    expect([slot, iso(60)]).toContain(firedSlot);
    expect(stored[0]).toMatchObject({
      org_id: ctx.orgId,
      type: NAME,
      payload_json: '{}',
      state: 'queued',
      idempotency_key: `schedule:${NAME}:${firedSlot}`,
    });
    const [row] = await schedules(database.executor);
    expect(row!.last_slot).toBe(firedSlot);
    expect(Date.parse(row!.next_run_at)).toBe(Date.parse(firedSlot) + EVERY * 1000);
    expect(await repo.tick(ctx)).toEqual([]);
    expect(await jobs(database.executor)).toHaveLength(1);
  });

  it('two concurrent ticks for the same due slot create exactly one job', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-schedule-'));
    const shared = await openMigratedDatabase({
      file: join(dir, 'db.sqlite'),
      twoOrganizations: true,
    });
    try {
      const org = shared.orgs!.a;
      const first = createJobScheduleRepository(shared.executor);
      const second = createJobScheduleRepository(await shared.second());
      await first.upsert(org, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) });
      const results = await Promise.all([first.tick(org), second.tick(org)]);
      expect(results.flat()).toHaveLength(1);
      expect(await jobs(shared.executor)).toHaveLength(1);
    } finally {
      await shared.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('after a gap only the most recent due slot fires', async () => {
    const repo = createJobScheduleRepository(database.executor);
    const oldest = iso(-10 * EVERY - 60);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: oldest });
    const fired = await repo.tick(ctx);
    expect(fired).toHaveLength(1);
    const [stored] = await jobs(database.executor);
    const slot = stored!.idempotency_key.slice(`schedule:${NAME}:`.length);
    expect((Date.parse(slot) - Date.parse(oldest)) % (EVERY * 1000)).toBe(0);
    expect(Date.parse(slot)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(slot)).toBeGreaterThan(Date.now() - EVERY * 1000 - 2000);
    expect(Date.parse(slot)).toBeGreaterThan(Date.parse(oldest) + 9 * EVERY * 1000);
    const [row] = await schedules(database.executor);
    expect(Date.parse(row!.next_run_at)).toBeGreaterThan(Date.now());
    expect(await repo.tick(ctx)).toEqual([]);
    expect(await jobs(database.executor)).toHaveLength(1);
  });

  it('an already-existing slot job lets the row advance without a second job', async () => {
    const repo = createJobScheduleRepository(database.executor);
    const base = Date.parse('2020-01-01T00:00:00.000Z');
    const every = 366 * 86400;
    const slot = new Date(
      base + Math.floor((Date.now() - base) / (every * 1000)) * every * 1000,
    ).toISOString();
    await repo.upsert(ctx, {
      name: NAME,
      everySeconds: every,
      nextRunAt: new Date(base).toISOString(),
    });
    await database.executor.batch([
      {
        sql: `INSERT INTO job (id, org_id, type, idempotency_key) VALUES (?, ?, ?, ?)`,
        params: ['01J0PRE0000000000000000001', ctx.orgId, NAME, `schedule:${NAME}:${slot}`],
      },
    ]);
    expect(await repo.tick(ctx)).toEqual([]);
    expect(await jobs(database.executor)).toHaveLength(1);
    expect((await schedules(database.executor))[0]!.last_slot).toBe(slot);
  });

  it('a failed slot insert does not advance the row', async () => {
    const repo = createJobScheduleRepository(database.executor);
    const slot = iso(0);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: slot });
    await database.executor.batch([
      {
        sql: `CREATE TRIGGER job_insert_fails BEFORE INSERT ON job
          BEGIN SELECT RAISE(ABORT, 'insert refused'); END`,
        params: [],
      },
    ]);
    await expect(repo.tick(ctx)).rejects.toThrow();
    const [row] = await schedules(database.executor);
    expect(row).toMatchObject({ next_run_at: slot, last_slot: null });
    await database.executor.batch([{ sql: 'DROP TRIGGER job_insert_fails', params: [] }]);
    expect(await repo.tick(ctx)).toHaveLength(1);
  });

  it('a failure on one definition does not stop the others, and the error is rethrown', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) });
    await repo.upsert(ctx, { name: OTHER, everySeconds: EVERY, nextRunAt: iso(-60) });
    await database.executor.batch([
      {
        sql: `CREATE TRIGGER job_insert_fails BEFORE INSERT ON job WHEN NEW.type = '${NAME}'
          BEGIN SELECT RAISE(ABORT, 'insert refused'); END`,
        params: [],
      },
    ]);
    await expect(repo.tick(ctx)).rejects.toThrow();
    const stored = await jobs(database.executor);
    expect(stored.map((job) => job.type)).toEqual([OTHER]);
  });

  it('disable stops future slots and leaves a running job alone', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) });
    await repo.tick(ctx);
    await database.executor.batch([
      {
        sql: `UPDATE job SET state = 'running', lease_owner = 'owner', lease_until = '2099-01-01T00:00:00.000Z',
          payload_json = '{"kept":true}' WHERE org_id = ?`,
        params: [ctx.orgId],
      },
    ]);
    const before = await jobs(database.executor);
    await repo.disable(ctx, NAME);
    await database.executor.batch([
      { sql: `UPDATE job_schedule SET next_run_at = ? WHERE name = ?`, params: [iso(-60), NAME] },
    ]);
    expect(await repo.tick(ctx)).toEqual([]);
    expect(await jobs(database.executor)).toEqual(before);
    expect((await jobs(database.executor))[0]).toMatchObject({
      state: 'running',
      payload_json: '{"kept":true}',
    });
    expect((await schedules(database.executor))[0]!.enabled).toBe(0);
  });

  it('a new definition version gets its own row and key while the old row is disabled', async () => {
    const repo = createJobScheduleRepository(database.executor);
    const v2 = 'core:session-cleanup:v2';
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) });
    await repo.disable(ctx, NAME);
    await repo.upsert(ctx, { name: v2, everySeconds: EVERY * 2, nextRunAt: iso(-60) });
    const fired = await repo.tick(ctx);
    expect(fired.map((item) => item.name)).toEqual([v2]);
    expect((await jobs(database.executor))[0]!.type).toBe(v2);
  });

  it('is scoped to the caller organization', async () => {
    const repo = createJobScheduleRepository(database.executor);
    const other = database.orgs!.b;
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) });
    await repo.upsert(other, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) });
    expect(await repo.tick(other)).toHaveLength(1);
    const stored = await jobs(database.executor);
    expect(stored.map((job) => job.org_id)).toEqual([other.orgId]);
    await repo.disable(other, NAME);
    const rows = await database.executor.all<{ org_id: string; enabled: number }>({
      sql: 'SELECT org_id, enabled FROM job_schedule ORDER BY org_id',
      params: [],
    });
    expect(rows.find((row) => row.org_id === ctx.orgId)!.enabled).toBe(1);
  });

  it('keeps the single-organization invariant of the deployment', async () => {
    const single = await openMigratedDatabase();
    try {
      await single.executor.batch([
        {
          sql: `INSERT INTO organization (id, slug, name) VALUES ('01J0ORGONE0000000000000001', 'one', 'One')`,
          params: [],
        },
      ]);
      await expect(
        single.executor.batch([
          {
            sql: `INSERT INTO organization (id, slug, name) VALUES ('01J0ORGTWO0000000000000002', 'two', 'Two')`,
            params: [],
          },
        ]),
      ).rejects.toThrow();
    } finally {
      await single.close();
    }
  });

  it('upsert truncates nextRunAt to the minute', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.upsert(ctx, {
      name: NAME,
      everySeconds: EVERY,
      nextRunAt: new Date(Date.parse(iso(3600)) + 37_123).toISOString(),
    });
    expect((await schedules(database.executor))[0]!.next_run_at).toBe(iso(3600));
  });

  it('sync disables obsolete rows so they stop firing, and re-enables a row registered again', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.sync(ctx, [
      { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) },
      { name: OTHER, everySeconds: EVERY, nextRunAt: iso(-60) },
    ]);
    await repo.sync(ctx, [{ name: OTHER, everySeconds: EVERY }]);
    const rows = await schedules(database.executor);
    expect(rows.map((row) => [row.name, row.enabled])).toEqual([
      [OTHER, 1],
      [NAME, 0],
    ]);
    expect((await repo.tick(ctx)).map((item) => item.name)).toEqual([OTHER]);
    await repo.sync(ctx, [
      { name: NAME, everySeconds: EVERY },
      { name: OTHER, everySeconds: EVERY },
    ]);
    expect((await schedules(database.executor)).map((row) => row.enabled)).toEqual([1, 1]);
  });

  it('sync with no definitions disables everything and refuses an interval change', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.sync(ctx, [{ name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) }]);
    await expect(repo.sync(ctx, [{ name: NAME, everySeconds: EVERY * 2 }])).rejects.toThrow(
      RangeError,
    );
    expect((await schedules(database.executor))[0]).toMatchObject({
      every_seconds: EVERY,
      enabled: 1,
    });
    await repo.sync(ctx, []);
    expect((await schedules(database.executor))[0]!.enabled).toBe(0);
    expect(await repo.tick(ctx)).toEqual([]);
  });

  it('sync only touches the caller organization', async () => {
    const repo = createJobScheduleRepository(database.executor);
    const other = database.orgs!.b;
    await repo.sync(other, [{ name: NAME, everySeconds: EVERY }]);
    await repo.sync(ctx, []);
    const rows = await database.executor.all<{ enabled: number }>({
      sql: 'SELECT enabled FROM job_schedule',
      params: [],
    });
    expect(rows).toEqual([{ enabled: 1 }]);
  });

  it('carries maxAttempts from the definition into the job', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.sync(ctx, [
      { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60), maxAttempts: 7 },
      { name: OTHER, everySeconds: EVERY, nextRunAt: iso(-60) },
    ]);
    await repo.tick(ctx);
    const rows = await database.executor.all<{ type: string; max_attempts: number }>({
      sql: 'SELECT type, max_attempts FROM job ORDER BY type',
      params: [],
    });
    expect(rows).toEqual([
      { type: OTHER, max_attempts: 5 },
      { type: NAME, max_attempts: 7 },
    ]);
  });

  it('a partial failure keeps the jobs that fired on the thrown error', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) });
    await repo.upsert(ctx, { name: OTHER, everySeconds: EVERY, nextRunAt: iso(-60) });
    await database.executor.batch([
      {
        sql: `CREATE TRIGGER job_insert_fails BEFORE INSERT ON job WHEN NEW.type = '${NAME}'
          BEGIN SELECT RAISE(ABORT, 'insert refused'); END`,
        params: [],
      },
    ]);
    const error = await repo.tick(ctx).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(JobScheduleTickError);
    const tickError = error as JobScheduleTickError;
    expect(tickError.errors).toHaveLength(1);
    expect(tickError.fired.map((item) => item.name)).toEqual([OTHER]);
  });

  it('a failing schedule advance rolls the slot job back', async () => {
    const repo = createJobScheduleRepository(database.executor);
    const slot = iso(0);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: slot });
    await database.executor.batch([
      {
        sql: `CREATE TRIGGER schedule_update_fails BEFORE UPDATE ON job_schedule
          BEGIN SELECT RAISE(ABORT, 'update refused'); END`,
        params: [],
      },
    ]);
    await expect(repo.tick(ctx)).rejects.toThrow();
    expect(await jobs(database.executor)).toHaveLength(0);
    expect((await schedules(database.executor))[0]).toMatchObject({
      next_run_at: slot,
      last_slot: null,
    });
  });

  it('a tick that read a stale row creates and advances nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-schedule-'));
    const shared = await openMigratedDatabase({
      file: join(dir, 'db.sqlite'),
      twoOrganizations: true,
    });
    try {
      const org = shared.orgs!.a;
      const real = shared.executor;
      const repo = createJobScheduleRepository(real);
      await repo.upsert(org, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-2 * EVERY) });
      let stale = true;
      const racing: SqlExecutor = {
        driver: real.driver,
        all: async (statement) => {
          const rows = await real.all(statement);
          if (stale && statement.sql.includes('FROM job_schedule')) {
            stale = false;
            await createJobScheduleRepository(real).tick(org);
          }
          return rows;
        },
        batch: (statements) => real.batch(statements),
      } as SqlExecutor;
      const slow = createJobScheduleRepository(racing);
      expect(await slow.tick(org)).toEqual([]);
      expect(await jobs(real)).toHaveLength(1);
      expect((await schedules(real))[0]!.last_slot).not.toBeNull();
    } finally {
      await shared.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('tick recreates a registered row that went missing', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.sync(ctx, [{ name: NAME, everySeconds: EVERY, maxAttempts: 4 }]);
    await database.executor.batch([{ sql: 'DELETE FROM job_schedule', params: [] }]);
    expect(await repo.tick(ctx)).toEqual([]);
    const [row] = await schedules(database.executor);
    expect(row).toMatchObject({ name: NAME, every_seconds: EVERY, enabled: 1 });
    expect(Date.parse(row!.next_run_at)).toBeGreaterThan(Date.now());
  });

  it('computes the slot inside the batch, not from the enumeration', async () => {
    const real = database.executor;
    let moved = false;
    const racing = {
      driver: real.driver,
      all: (statement) => real.all(statement),
      batch: async (statements) => {
        if (!moved) {
          moved = true;
          await real.batch([
            {
              sql: 'UPDATE job_schedule SET next_run_at = ? WHERE name = ?',
              params: [iso(-7 * EVERY), NAME],
            },
          ]);
        }
        return real.batch(statements);
      },
    } as SqlExecutor;
    const repo = createJobScheduleRepository(racing);
    const minute = iso(0);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) });
    expect(await repo.tick(ctx)).toHaveLength(1);
    const [stored] = await jobs(real);
    const slot = stored!.idempotency_key.slice(`schedule:${NAME}:`.length);
    const [row] = await schedules(real);
    expect([minute, iso(60)]).toContain(slot);
    expect(row!.last_slot).toBe(slot);
    expect(Date.parse(row!.next_run_at)).toBe(Date.parse(slot) + EVERY * 1000);
  });

  it('two concurrent syncs with different intervals: one wins, the other gets a conflict', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'job-schedule-'));
    const shared = await openMigratedDatabase({
      file: join(dir, 'db.sqlite'),
      twoOrganizations: true,
    });
    try {
      const org = shared.orgs!.a;
      const first = createJobScheduleRepository(shared.executor);
      const second = createJobScheduleRepository(await shared.second());
      const results = await Promise.allSettled([
        first.sync(org, [{ name: NAME, everySeconds: EVERY }]),
        second.sync(org, [{ name: NAME, everySeconds: EVERY * 2 }]),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(RangeError);
      expect(await schedules(shared.executor)).toHaveLength(1);
    } finally {
      await shared.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('paging moves past more than a page of failing definitions', async () => {
    const repo = createJobScheduleRepository(database.executor);
    for (let index = 0; index < 105; index += 1) {
      await repo.upsert(ctx, {
        name: `core:fail-${String(index).padStart(3, '0')}:v1`,
        everySeconds: EVERY,
        nextRunAt: iso(-60),
      });
    }
    await repo.upsert(ctx, { name: 'core:healthy:v1', everySeconds: EVERY, nextRunAt: iso(-60) });
    await database.executor.batch([
      {
        sql: `CREATE TRIGGER job_insert_fails BEFORE INSERT ON job WHEN NEW.type LIKE 'core:fail-%'
          BEGIN SELECT RAISE(ABORT, 'insert refused'); END`,
        params: [],
      },
    ]);
    const error = (await repo.tick(ctx).catch((caught: unknown) => caught)) as JobScheduleTickError;
    expect(error).toBeInstanceOf(JobScheduleTickError);
    expect(error.errors).toHaveLength(105);
    expect(error.fired.map((item) => item.name)).toEqual(['core:healthy:v1']);
  });

  it('rejects intervals whose next slot cannot be represented', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await expect(
      repo.upsert(ctx, { name: NAME, everySeconds: 400 * 86400, nextRunAt: iso(0) }),
    ).rejects.toThrow(RangeError);
    await expect(
      repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: '9999-12-31T23:59:00.000Z' }),
    ).rejects.toThrow(RangeError);
    await expect(repo.sync(ctx, [{ name: NAME, everySeconds: 400 * 86400 }])).rejects.toThrow(
      RangeError,
    );
    expect(await schedules(database.executor)).toHaveLength(0);
  });

  it('a foreign job whose key falls in the slot range does not stall the row', async () => {
    const repo = createJobScheduleRepository(database.executor);
    await repo.upsert(ctx, { name: NAME, everySeconds: EVERY, nextRunAt: iso(-60) });
    await database.executor.batch([
      {
        sql: `INSERT INTO job (id, org_id, type, idempotency_key) VALUES (?, ?, ?, ?)`,
        params: [
          '01J0FOREIGN00000000000001',
          ctx.orgId,
          'schedule:a:v2',
          `schedule:${NAME}:9999-12-31T23:59:59.999Z`,
        ],
      },
      {
        sql: `INSERT INTO job (id, org_id, type, idempotency_key) VALUES (?, ?, ?, ?)`,
        params: ['01J0FOREIGN00000000000002', ctx.orgId, NAME, `schedule:${NAME}:zzzz`],
      },
    ]);
    expect(await repo.tick(ctx)).toHaveLength(1);
    const [row] = await schedules(database.executor);
    expect(row!.last_slot).not.toBeNull();
    expect(Date.parse(row!.next_run_at)).toBeLessThan(Date.parse(iso(0)) + 2 * EVERY * 1000);
    expect(Date.parse(row!.next_run_at)).toBeGreaterThan(Date.now());
  });
});
