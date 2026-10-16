import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  keyHash: KEY,
  form,
  validator,
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
