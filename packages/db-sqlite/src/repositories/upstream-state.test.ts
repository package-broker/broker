import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createUpstreamStateRepository } from './upstream-state.js';

const PACKAGE = '01J0PACK000000000000000000';
const SOURCE = '01J0SRCE000000000000000000';
const SHA = 'a'.repeat(64);
const SHA_2 = 'b'.repeat(64);
const FORM = 'composer-p2' as const;

let database: MigratedDatabase;
let repo: ReturnType<typeof createUpstreamStateRepository>;
let ctx: ReturnType<typeof orgContext>;
let other: ReturnType<typeof orgContext>;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  ctx = database.orgs.a;
  other = database.orgs.b;
  const run = (sql: string, params: string[]) => database.executor.all({ sql, params });
  await run('INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, ?, ?)', [
    SOURCE,
    ctx.orgId,
    'packagist',
    'composer',
    'packagist_proxy',
  ]);
  await run('INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)', [
    PACKAGE,
    ctx.orgId,
    SOURCE,
    'composer',
    'acme/lib',
  ]);
  repo = createUpstreamStateRepository(database.executor);
});

afterEach(async () => {
  vi.useRealTimers();
  await database.close();
});

const validators = {
  etag: '"v1"',
  lastModified: 'Wed, 01 Oct 2026 10:00:00 GMT',
  contentSha256: SHA,
};

describe('upstream state repository', () => {
  it('get returns null before any row exists', async () => {
    expect(await repo.get(ctx, PACKAGE, FORM)).toBeNull();
  });

  it('publish stores validators and a database-time freshness window', async () => {
    await database.executor.batch(repo.publishStatements(ctx, PACKAGE, FORM, validators, 300));

    const state = await repo.get(ctx, PACKAGE, FORM);
    expect(state).toMatchObject({ ...validators, notFoundCount: 0, firstNotFoundAt: null });
    expect(Date.parse(state?.freshUntil ?? '') - Date.parse(state?.checkedAt ?? '')).toBe(300_000);
    expect(Math.abs(Date.parse(state?.checkedAt ?? '') - Date.now())).toBeLessThan(5_000);
  });

  it('a fake application clock does not move checked_at or fresh_until', async () => {
    vi.useFakeTimers({ now: new Date('2001-01-01T00:00:00.000Z'), toFake: ['Date'] });
    await database.executor.batch(repo.publishStatements(ctx, PACKAGE, FORM, validators, 300));
    vi.useRealTimers();

    const state = await repo.get(ctx, PACKAGE, FORM);
    const checked = Date.parse(state?.checkedAt ?? '');
    expect(checked).toBeGreaterThan(Date.parse('2026-01-01'));
    expect(Date.parse(state?.freshUntil ?? '')).toBeGreaterThan(
      Date.parse('2001-01-01T00:00:00.000Z') + 300_000,
    );
    expect(Date.parse(state?.freshUntil ?? '') - checked).toBe(300_000);
  });

  it('touch changes only the freshness window and never the validators', async () => {
    await database.executor.batch(repo.publishStatements(ctx, PACKAGE, FORM, validators, 0));
    const before = await repo.get(ctx, PACKAGE, FORM);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await database.executor.batch(repo.touchStatements(ctx, PACKAGE, FORM, 300));

    const after = await repo.get(ctx, PACKAGE, FORM);
    expect(after).toMatchObject(validators);
    expect((after?.checkedAt ?? '') > (before?.checkedAt ?? '')).toBe(true);
    expect((after?.freshUntil ?? '') > (before?.freshUntil ?? '')).toBe(true);
  });

  it('touch and not-found never create or alter validators', async () => {
    await database.executor.batch(repo.touchStatements(ctx, PACKAGE, FORM, 300));
    expect(await repo.get(ctx, PACKAGE, FORM)).toBeNull();

    await database.executor.batch(repo.publishStatements(ctx, PACKAGE, FORM, validators, 300));
    await database.executor.batch(repo.notFoundStatements(ctx, PACKAGE, FORM, 30));
    expect(await repo.get(ctx, PACKAGE, FORM)).toMatchObject(validators);
  });

  it('not-found increments the counter and sets first_not_found_at once', async () => {
    await database.executor.batch(repo.notFoundStatements(ctx, PACKAGE, FORM, 30));
    const first = await repo.get(ctx, PACKAGE, FORM);
    expect(first).toMatchObject({ notFoundCount: 1, etag: null, contentSha256: null });
    expect(first?.firstNotFoundAt).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 20));
    await database.executor.batch(repo.notFoundStatements(ctx, PACKAGE, FORM, 30));
    const second = await repo.get(ctx, PACKAGE, FORM);
    expect(second?.notFoundCount).toBe(2);
    expect(second?.firstNotFoundAt).toBe(first?.firstNotFoundAt);
    expect((second?.checkedAt ?? '') > (first?.checkedAt ?? '')).toBe(true);
  });

  it('a found result resets the counter and the first-not-found stamp', async () => {
    await database.executor.batch(repo.notFoundStatements(ctx, PACKAGE, FORM, 30));
    await database.executor.batch(repo.touchStatements(ctx, PACKAGE, FORM, 300));
    expect(await repo.get(ctx, PACKAGE, FORM)).toMatchObject({
      notFoundCount: 0,
      firstNotFoundAt: null,
    });

    await database.executor.batch(repo.notFoundStatements(ctx, PACKAGE, FORM, 30));
    await database.executor.batch(
      repo.publishStatements(ctx, PACKAGE, FORM, { ...validators, contentSha256: SHA_2 }, 300),
    );
    expect(await repo.get(ctx, PACKAGE, FORM)).toMatchObject({
      contentSha256: SHA_2,
      notFoundCount: 0,
      firstNotFoundAt: null,
    });
  });

  it('forms are independent rows', async () => {
    await database.executor.batch(repo.publishStatements(ctx, PACKAGE, FORM, validators, 300));
    expect(await repo.get(ctx, PACKAGE, 'npm-packument')).toBeNull();
  });

  it('another organization can neither read nor write the row', async () => {
    await database.executor.batch(repo.publishStatements(other, PACKAGE, FORM, validators, 300));
    await database.executor.batch(repo.notFoundStatements(other, PACKAGE, FORM, 30));
    expect(await repo.get(ctx, PACKAGE, FORM)).toBeNull();

    await database.executor.batch(repo.publishStatements(ctx, PACKAGE, FORM, validators, 300));
    await database.executor.batch(repo.touchStatements(other, PACKAGE, FORM, 9000));
    await database.executor.batch(repo.notFoundStatements(other, PACKAGE, FORM, 30));
    expect(await repo.get(other, PACKAGE, FORM)).toBeNull();
    expect(await repo.get(ctx, PACKAGE, FORM)).toMatchObject({ ...validators, notFoundCount: 0 });
  });

  it('rejects a malformed digest and an invalid ttl before building a statement', () => {
    expect(() =>
      repo.publishStatements(ctx, PACKAGE, FORM, { ...validators, contentSha256: 'ABC' }, 300),
    ).toThrow(TypeError);
    expect(() => repo.touchStatements(ctx, PACKAGE, FORM, -1)).toThrow(RangeError);
    expect(() => repo.notFoundStatements(ctx, PACKAGE, FORM, 1.5)).toThrow(RangeError);
  });

  it('another organization cannot touch a row that has a not-found history', async () => {
    await database.executor.batch(repo.notFoundStatements(ctx, PACKAGE, FORM, 30));
    await database.executor.batch(repo.notFoundStatements(ctx, PACKAGE, FORM, 30));
    const before = await repo.get(ctx, PACKAGE, FORM);
    expect(before?.notFoundCount).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await database.executor.batch(repo.touchStatements(other, PACKAGE, FORM, 300));

    expect(await repo.get(ctx, PACKAGE, FORM)).toEqual(before);
  });

  it.each([
    ['etag', 'a'.repeat(1025)],
    ['etag', '"a\nb"'],
    ['lastModified', 'a'.repeat(1025)],
    ['lastModified', 'x\u0000y'],
    ['lastModified', 'x\u007fy'],
  ] as const)('refuses an invalid %s', (field, value) => {
    expect(() =>
      repo.publishStatements(ctx, PACKAGE, FORM, { ...validators, [field]: value }, 300),
    ).toThrow(TypeError);
  });

  it('accepts validators at the length limit', () => {
    expect(() =>
      repo.publishStatements(
        ctx,
        PACKAGE,
        FORM,
        { ...validators, etag: 'a'.repeat(1024), lastModified: 'b'.repeat(1024) },
        300,
      ),
    ).not.toThrow();
  });

  it('accepts a ttl of one year and refuses one second more', () => {
    const year = 366 * 24 * 60 * 60;
    expect(() => repo.touchStatements(ctx, PACKAGE, FORM, year)).not.toThrow();
    expect(() => repo.touchStatements(ctx, PACKAGE, FORM, year + 1)).toThrow(`${year} seconds`);
  });
});
