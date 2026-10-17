import { readFileSync, readdirSync } from 'node:fs';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource } from '../migrations/source.js';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgContext, ScalarSqlExecutor, ScalarStatement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import type { RepresentationForm } from '../schema.js';
import { createRepresentationClock } from './representation-clock.js';

const PROJECT = '01J0PROJ000000000000000000';
const KEY = 'a'.repeat(64);
const V1 = '1'.repeat(64);
const V2 = '2'.repeat(64);
const V3 = '3'.repeat(64);
const SECONDS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

let database: MigratedDatabase;
let clock: ReturnType<typeof createRepresentationClock>;
let ctx: OrgContext;
let other: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ctx = database.orgs.a;
  other = database.orgs.b;
  await database.executor.all({
    sql: 'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
    params: [PROJECT, ctx.orgId, 'p', 'P'],
  });
  clock = createRepresentationClock(database.executor);
});

afterEach(async () => {
  await database.close();
});

const input = (validator: string, form: RepresentationForm = 'composer-p2') => ({
  projectId: PROJECT,
  packageId: 'package-a',
  keyHash: KEY,
  form,
  validator,
  rev: 0,
});

const rows = () =>
  database.executor.all<{ validator: string; last_modified: string }>({
    sql: 'SELECT validator, last_modified FROM representation_clock ORDER BY form',
    params: [],
  });

function counting(): {
  executor: ScalarSqlExecutor;
  reads: number[];
  upsertChanges: number[];
} {
  const reads: number[] = [];
  const upsertChanges: number[] = [];
  const inner = database.executor;
  return {
    reads,
    upsertChanges,
    executor: {
      driver: inner.driver,
      async all<R>(statement: ScalarStatement) {
        const result = await inner.all<R>(statement);
        reads.push(result.length);
        return result;
      },
      async batch(statements) {
        const results = await inner.batch(statements);
        upsertChanges.push(results[0]?.changes ?? -1);
        return results;
      },
    },
  };
}

describe('representation clock repository', () => {
  it('advances when package B at rev 1 replaces package A at rev 9 and when A wins again', async () => {
    const first = await clock.advance(ctx, { ...input(V1), rev: 9 });
    const second = await clock.advance(ctx, { ...input(V2), packageId: 'package-b', rev: 1 });
    expect(second.stale).toBe(false);
    expect(second.validator).toBe(V2);
    expect(Date.parse(second.lastModified) - Date.parse(first.lastModified)).toBeGreaterThanOrEqual(
      1000,
    );
    const third = await clock.advance(ctx, { ...input(V1), rev: 9 });
    expect(third.stale).toBe(false);
    expect(third.validator).toBe(V1);
    expect(Date.parse(third.lastModified) - Date.parse(second.lastModified)).toBeGreaterThanOrEqual(
      1000,
    );
    expect(
      await database.executor.all({
        sql: 'SELECT package_id, rev FROM representation_clock',
        params: [],
      }),
    ).toEqual([{ package_id: 'package-a', rev: 9 }]);
  });

  it('advances for a package change even if the validator is unchanged', async () => {
    const first = await clock.advance(ctx, { ...input(V1), rev: 9 });
    const second = await clock.advance(ctx, { ...input(V1), packageId: 'package-b', rev: 1 });
    expect(second.stale).toBe(false);
    expect(Date.parse(second.lastModified) - Date.parse(first.lastModified)).toBeGreaterThanOrEqual(
      1000,
    );
  });

  it('keeps rev 5 and its time when rev 4 has another validator', async () => {
    const first = await clock.advance(ctx, { ...input(V1), rev: 5 });
    const before = await rows();
    const second = await clock.advance(ctx, { ...input(V2), rev: 4 });
    expect(second).toEqual({ ...first, stale: true });
    expect(await rows()).toEqual(before);
    expect(
      await database.executor.all({ sql: 'SELECT rev FROM representation_clock', params: [] }),
    ).toEqual([{ rev: 5 }]);
  });

  it('guards a stale write even when the initial read misses the row', async () => {
    const first = await clock.advance(ctx, { ...input(V1), rev: 5 });
    const executor = {
      ...database.executor,
      all: vi.fn(async () => []),
    };
    const second = await createRepresentationClock(executor).advance(ctx, { ...input(V2), rev: 4 });
    expect(second).toEqual({ ...first, stale: true });
    expect((await rows())[0]?.validator).toBe(V1);
  });

  it('advances rev 5 to rev 6 by at least one second', async () => {
    const first = await clock.advance(ctx, { ...input(V1), rev: 5 });
    const second = await clock.advance(ctx, { ...input(V2), rev: 6 });
    expect(second.stale).toBe(false);
    expect(second.validator).toBe(V2);
    expect(Date.parse(second.lastModified) - Date.parse(first.lastModified)).toBeGreaterThanOrEqual(
      1000,
    );
    expect(
      await database.executor.all({ sql: 'SELECT rev FROM representation_clock', params: [] }),
    ).toEqual([{ rev: 6 }]);
  });

  it('advances a different validator at equal rev', async () => {
    const first = await clock.advance(ctx, { ...input(V1), rev: 5 });
    const second = await clock.advance(ctx, { ...input(V2), rev: 5 });
    expect(second.stale).toBe(false);
    expect(second.validator).toBe(V2);
    expect(Date.parse(second.lastModified) - Date.parse(first.lastModified)).toBeGreaterThanOrEqual(
      1000,
    );
  });

  it('stores a newer rev even when the validator is unchanged', async () => {
    const first = await clock.advance(ctx, { ...input(V1), rev: 5 });
    const second = await clock.advance(ctx, { ...input(V1), rev: 6 });
    expect(second).toEqual(first);
    expect((await clock.advance(ctx, { ...input(V2), rev: 5 })).stale).toBe(true);
  });

  it.each([
    ['negative', -1, RangeError],
    ['non-integer', 1.5, RangeError],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1, RangeError],
    ['non-number', '5' as unknown as number, TypeError],
  ])('rejects a %s rev before any SQL', async (_, rev, error) => {
    const all = vi.fn();
    const batch = vi.fn();
    const checked = createRepresentationClock({ driver: database.executor.driver, all, batch });
    await expect(checked.advance(ctx, { ...input(V1), rev })).rejects.toThrow(error);
    expect(all).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
  });

  it.each([0, 1])('upgrades a pre-migration row and advances it at rev %i', async (rev) => {
    const opened = openNodeSqliteExecutor();
    try {
      const url = new URL('../../migrations/', import.meta.url);
      const sources = await Promise.all(
        readdirSync(url)
          .filter((name) => name.endsWith('.sql'))
          .sort()
          .map((name) =>
            loadMigrationSource('core', name, readFileSync(new URL(name, url), 'utf8')),
          ),
      );
      await migrate(
        opened.executor,
        sources.filter((source) => source.sequence < 8),
        { holder: 'pre-rev' },
      );
      await opened.executor.all({
        sql: 'INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)',
        params: [ctx.orgId, 'old', 'Old'],
      });
      await opened.executor.all({
        sql: 'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        params: [PROJECT, ctx.orgId, 'p', 'P'],
      });
      await opened.executor.all({
        sql: 'INSERT INTO representation_clock (org_id, project_id, key_hash, form, validator, last_modified) VALUES (?, ?, ?, ?, ?, ?)',
        params: [ctx.orgId, PROJECT, KEY, 'composer-p2', V1, '2000-01-01T00:00:00Z'],
      });
      await migrate(opened.executor, sources, { holder: 'rev' });
      expect(
        await opened.executor.all({ sql: 'SELECT rev FROM representation_clock', params: [] }),
      ).toEqual([{ rev: 0 }]);
      const reading = await createRepresentationClock(opened.executor).advance(ctx, {
        ...input(V2),
        rev,
      });
      expect(reading.stale).toBe(false);
      expect(reading.validator).toBe(V2);
    } finally {
      await opened.close();
    }
  });

  it('stores the validator and a whole-second time on first use', async () => {
    const reading = await clock.advance(ctx, input(V1));
    expect(reading.validator).toBe(V1);
    expect(reading.lastModified).toMatch(SECONDS);
    expect(await rows()).toEqual([{ validator: V1, last_modified: reading.lastModified }]);
  });

  it('answers an unchanged representation with one read and no write', async () => {
    const { executor, reads, upsertChanges } = counting();
    const counted = createRepresentationClock(executor);
    const first = await counted.advance(ctx, input(V1));
    expect(upsertChanges).toEqual([1]);
    const before = await rows();
    reads.length = 0;
    const second = await counted.advance(ctx, input(V1));
    expect(second).toEqual(first);
    expect(reads).toEqual([1]);
    expect(upsertChanges).toEqual([1]);
    expect(await rows()).toEqual(before);
  });

  it('writes in one batch when the validator changed', async () => {
    const { executor, upsertChanges } = counting();
    const counted = createRepresentationClock(executor);
    await counted.advance(ctx, input(V1));
    await counted.advance(ctx, input(V2));
    expect(upsertChanges).toEqual([1, 1]);
  });

  it('advances by at least one second per change within the same second', async () => {
    const readings = [];
    for (const validator of [V1, V2, V3, V1]) {
      readings.push(await clock.advance(ctx, input(validator)));
    }
    const times = readings.map((reading) => Date.parse(reading.lastModified));
    for (let i = 1; i < times.length; i += 1) {
      expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(1000);
    }
    expect(readings.at(-1)?.validator).toBe(V1);
  });

  it('moves a stale time forward to now instead of previous + 1 s', async () => {
    await clock.advance(ctx, input(V1));
    await database.executor.all({
      sql: "UPDATE representation_clock SET last_modified = '2000-01-01T00:00:00Z'",
      params: [],
    });
    const reading = await clock.advance(ctx, input(V2));
    expect(Date.parse(reading.lastModified)).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));
  });

  it('keeps forms in separate rows with independent times', async () => {
    const dev = await clock.advance(ctx, input(V1, 'composer-p2-dev'));
    await clock.advance(ctx, input(V1));
    await clock.advance(ctx, input(V2));
    const p2 = await clock.advance(ctx, input(V3));
    const stored = await rows();
    expect(stored).toHaveLength(2);
    expect(stored).toEqual([
      { validator: V3, last_modified: p2.lastModified },
      { validator: V1, last_modified: dev.lastModified },
    ]);
    expect(Date.parse(p2.lastModified) - Date.parse(dev.lastModified)).toBeGreaterThanOrEqual(2000);
    expect(await clock.advance(ctx, input(V1, 'composer-p2-dev'))).toEqual(dev);
  });

  it('refuses another organization and leaves the row untouched', async () => {
    await clock.advance(ctx, input(V1));
    await expect(clock.advance(other, input(V2))).rejects.toThrow('project not found');
    expect((await rows())[0]?.validator).toBe(V1);
  });

  it('rejects malformed input before touching the database', async () => {
    await expect(clock.advance(ctx, { ...input(V1), keyHash: 'x' })).rejects.toThrow(TypeError);
    await expect(clock.advance(ctx, input('A'.repeat(64)))).rejects.toThrow(TypeError);
    await expect(clock.advance(ctx, { ...input(V1), projectId: '' })).rejects.toThrow(TypeError);
    await expect(
      clock.advance(ctx, { ...input(V1), form: 'npm-packument' as RepresentationForm }),
    ).rejects.toThrow(TypeError);
    expect(await rows()).toEqual([]);
  });
});
