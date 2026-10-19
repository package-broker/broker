import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parsePendingValidators,
  UPSTREAM_FORMS,
  type PendingValidators,
} from '@package-broker/core/ingest/validators';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { packageUpsertStatements } from './catalogue-write-package.js';
import { leaseKey } from './fetch-lease.js';
import {
  INGEST_CURSOR_MAX_BYTES,
  INGEST_SESSION_GC_LIMIT,
  createIngestSessionWriteGuard,
  createIngestSessions,
  ingestSessionGuard,
  type IngestScopeRef,
} from './ingest-session.js';

const A = '01J0WWWWWWWWWWWWWWWWWW0A01';
const B = '01J0WWWWWWWWWWWWWWWWWW0B01';
const C = '01J0WWWWWWWWWWWWWWWWWW0C01';
const SOURCE = '01J0SRC0000000000000000S01';
const OTHER_SOURCE = '01J0SRC0000000000000000S02';
const PAST = '2000-01-01T00:00:00.000Z';
const STAMP = 'a'.repeat(64);
const SHA = 'b'.repeat(64);

let database: MigratedDatabase;
let org: OrgContext;
let other: OrgContext;

function stmt(sql: string, ...params: (string | number | null)[]): Statement {
  return { sql, params };
}

const pkg = (key: string): IngestScopeRef => ({
  scope: 'package',
  sourceId: SOURCE,
  packageKey: key,
});
const listing: IngestScopeRef = { scope: 'source', sourceId: SOURCE };

async function expire(scopeKey: string): Promise<void> {
  await database.executor.batch([
    stmt(
      "UPDATE ingest_session SET lease_until = ? WHERE scope_key = ? AND state = 'running'",
      PAST,
      scopeKey,
    ),
  ]);
}

async function rows(): Promise<Record<string, unknown>[]> {
  return database.executor.all(stmt('SELECT * FROM ingest_session ORDER BY generation'));
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('organizations were not seeded');
  org = database.orgs.a;
  other = database.orgs.b;
  await database.executor.batch([
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'npm', 'npm_registry')",
      SOURCE,
      org.orgId,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'npm', 'npm_registry')",
      OTHER_SOURCE,
      other.orgId,
    ),
  ]);
});

afterEach(async () => {
  await database.close();
});

describe('ingest session acquire', () => {
  it('1: a job and a request fill on one package race to one holder', async () => {
    const sessions = createIngestSessions(database.executor);
    const results = await Promise.all([
      sessions.acquire(org, pkg('widget'), A, 60),
      sessions.acquire(org, pkg('widget'), B, 60),
    ]);
    expect(results.filter((r) => r === 'held')).toHaveLength(1);
    const won = results.find((r) => r !== 'held');
    expect(won).toMatchObject({ fence: 1, generation: 1, cursor: null, stamp: null });
  });

  it('1: after expiry the taker resumes cursor, stamp and snapshot with fence + 1', async () => {
    const sessions = createIngestSessions(database.executor);
    const first = await sessions.acquire(org, pkg('widget'), A, 60);
    if (first === 'held') throw new Error('unreachable');
    await sessions.start(org, first, { snapshot: { id: 'etag-1', blobSha256: SHA }, stamp: STAMP });
    await sessions.advance(org, first, { cursor: '{"o":7}', addSeen: 7 });
    await expire(first.scopeKey);
    const taken = await sessions.acquire(org, pkg('widget'), C, 60);
    if (taken === 'held') throw new Error('unreachable');
    expect(taken).toMatchObject({
      owner: C,
      fence: 2,
      generation: 1,
      stamp: STAMP,
      snapshotId: 'etag-1',
      snapshotBlobSha256: SHA,
      cursor: '{"o":7}',
      seenCount: 7,
      pagesSoFar: 1,
    });
    expect(await sessions.advance(org, first, { cursor: 'late', addSeen: 1 })).toBeNull();
    expect(await sessions.acquire(org, pkg('widget'), A, 60)).toBe('held');
  });

  it('keys package and listing scopes and organizations apart', async () => {
    const sessions = createIngestSessions(database.executor);
    const a = await sessions.acquire(org, pkg('widget'), A, 60);
    const b = await sessions.acquire(org, listing, A, 60);
    const c = await sessions.acquire(org, pkg('other'), A, 60);
    if (a === 'held' || b === 'held' || c === 'held') throw new Error('unreachable');
    expect(new Set([a.scopeKey, b.scopeKey, c.scopeKey]).size).toBe(3);
    const d = await sessions.acquire(other, { ...pkg('widget'), sourceId: OTHER_SOURCE }, B, 60);
    if (d === 'held') throw new Error('unreachable');
    expect(a.scopeKey).toBe(await leaseKey([org.orgId, 'ingest', 'package', SOURCE, 'widget']));
    expect(d.scopeKey).toBe(
      await leaseKey([other.orgId, 'ingest', 'package', OTHER_SOURCE, 'widget']),
    );
    expect(await sessions.acquire(org, pkg('widget'), B, 60)).toBe('held');
    expect((await rows()).filter((r) => r.org_id === org.orgId)).toHaveLength(3);
  });

  it('rejects a foreign or missing source without creating a session', async () => {
    const sessions = createIngestSessions(database.executor);
    await expect(sessions.acquire(other, pkg('widget'), B, 60)).rejects.toThrow(RangeError);
    await expect(
      sessions.acquire(org, { scope: 'source', sourceId: 'missing' }, A, 60),
    ).rejects.toThrow(RangeError);
    expect(await rows()).toEqual([]);
  });

  it('rejects malformed owners, durations and scopes', async () => {
    const sessions = createIngestSessions(database.executor);
    await expect(sessions.acquire(org, pkg('w'), '', 60)).rejects.toThrow(RangeError);
    await expect(sessions.acquire(org, pkg('w'), A, 0)).rejects.toThrow(RangeError);
    await expect(sessions.acquire(org, pkg(''), A, 60)).rejects.toThrow(RangeError);
    await expect(
      sessions.acquire(org, { scope: 'source', sourceId: 'x', packageKey: 'p' } as never, A, 60),
    ).rejects.toThrow(RangeError);
  });
});

describe('ingest session state', () => {
  it('advance renews the lease for its acquired duration and keeps the fence', async () => {
    let now = '2030-01-01T00:00:00.000Z';
    const sessions = createIngestSessions({
      ...database.executor,
      batch: (statements) =>
        database.executor.batch(
          statements.map((statement) => ({
            ...statement,
            sql: statement.sql.replaceAll("'now'", `'${now}'`),
          })),
        ),
    });
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    now = '2030-01-01T00:00:45.000Z';
    expect(await sessions.advance(org, h, { cursor: 'page-1', addSeen: 1 })).not.toBeNull();
    expect((await rows())[0]?.lease_until).toBe('2030-01-01T00:01:45.000Z');
    now = '2030-01-01T00:01:15.000Z';
    expect(await sessions.acquire(org, pkg('widget'), B, 60)).toBe('held');
    expect(await sessions.advance(org, h, { cursor: 'page-2', addSeen: 1 })).not.toBeNull();
    expect((await rows())[0]).toMatchObject({ fence: h.fence, owner: A });
    now = '2030-01-01T00:02:15.000Z';
    expect(await sessions.advance(org, h, { cursor: 'stale', addSeen: 1 })).toBeNull();
    const next = await sessions.acquire(org, pkg('widget'), B, 120);
    if (next === 'held') throw new Error('unreachable');
    now = '2030-01-01T00:03:00.000Z';
    expect(await sessions.advance(org, h, { cursor: 'stale', addSeen: 1 })).toBeNull();
    expect(await sessions.advance(org, next, { cursor: 'page-3', addSeen: 1 })).not.toBeNull();
    expect((await rows())[0]).toMatchObject({
      lease_until: '2030-01-01T00:05:00.000Z',
      fence: h.fence + 1,
      cursor: 'page-3',
      seen_count: 3,
    });
  });

  it('start records once; advance accumulates and caps the cursor at 4 KiB', async () => {
    const sessions = createIngestSessions(database.executor);
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    expect(await sessions.start(org, h, { snapshot: { id: 's' }, stamp: STAMP })).toBe(true);
    expect(await sessions.start(org, h, { snapshot: { id: 't' }, stamp: 'c'.repeat(64) })).toBe(
      false,
    );
    expect(await sessions.advance(org, h, { cursor: 'x', addSeen: 3 })).toEqual({
      seenCount: 3,
      pagesSoFar: 1,
    });
    expect(await sessions.advance(org, h, { cursor: 'y', addSeen: 2 })).toEqual({
      seenCount: 5,
      pagesSoFar: 2,
    });
    await expect(
      sessions.advance(org, h, { cursor: 'z'.repeat(INGEST_CURSOR_MAX_BYTES + 1), addSeen: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(
      sessions.advance(org, h, { cursor: 'é'.repeat(2049), addSeen: 0 }),
    ).rejects.toThrow(RangeError);
    await expect(sessions.advance(org, h, { cursor: 'ok', addSeen: -1 })).rejects.toThrow(
      RangeError,
    );
    expect(
      await sessions.setPendingValidators(
        org,
        h,
        parsePendingValidators({ 'composer-p2': { etag: '"1"' } }),
      ),
    ).toBe(true);
    const [row] = await rows();
    expect(JSON.parse(String(row?.pending_validators))).toEqual({
      'composer-p2': { etag: '"1"', lastModified: null, contentSha256: null },
    });
    expect(row).toMatchObject({ cursor: 'y', seen_count: 5, pages_so_far: 2 });
  });

  it('rejects invalid validators without executing a write and preserves the stored column', async () => {
    const sessions = createIngestSessions(database.executor);
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    const valid = parsePendingValidators({ 'composer-p2': { etag: '"1"' } });
    await sessions.setPendingValidators(org, h, valid);
    const [before] = await rows();
    const batch = vi.spyOn(database.executor, 'batch');
    const invalid: [unknown, typeof RangeError | typeof TypeError][] = [
      [{ bogus: {} }, RangeError],
      [{ 'composer-p2': null }, TypeError],
      [{ 'composer-p2': [] }, TypeError],
      [{ 'composer-p2': { etag: 1 } }, TypeError],
      [{ 'composer-p2': { lastModified: false } }, TypeError],
      [{ 'composer-p2': { contentSha256: 1 } }, TypeError],
      [{ 'composer-p2': { etag: 'bad\n' } }, TypeError],
      [{ 'composer-p2': { lastModified: 'bad\x7f' } }, TypeError],
      [{ 'composer-p2': { contentSha256: 'A'.repeat(64) } }, TypeError],
      [{ 'composer-p2': { etag: 'x'.repeat(1025) } }, TypeError],
      [[], RangeError],
      [1, RangeError],
    ];
    for (const [value, error] of invalid) {
      expect(() => sessions.setPendingValidators(org, h, value as PendingValidators)).toThrow(
        error,
      );
      expect(batch).not.toHaveBeenCalled();
      expect((await rows())[0]).toEqual(before);
    }
    batch.mockRestore();
    expect(await sessions.setPendingValidators(org, h, null)).toBe(true);
    expect((await rows())[0]?.pending_validators).toBeNull();
  });

  it('caps normalised validators by UTF-8 byte length before writing', async () => {
    const sessions = createIngestSessions(database.executor);
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    const oversized = Object.fromEntries(
      UPSTREAM_FORMS.map((form) => [
        form,
        {
          etag: '界'.repeat(1024),
          lastModified: '界'.repeat(1024),
          contentSha256: null,
        },
      ]),
    );
    expect(() => sessions.setPendingValidators(org, h, oversized)).toThrow(RangeError);
    expect((await rows())[0]?.pending_validators).toBeNull();
  });

  it('3: abandon then acquire starts generation + 1 with no stamp and an empty cursor', async () => {
    const sessions = createIngestSessions(database.executor);
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    await sessions.start(org, h, { snapshot: { id: 's' }, stamp: STAMP });
    await sessions.advance(org, h, { cursor: 'c', addSeen: 4 });
    expect(await sessions.abandon(org, h)).toBe(true);
    expect(await sessions.abandon(org, h)).toBe(false);
    const next = await sessions.acquire(org, pkg('widget'), B, 60);
    if (next === 'held') throw new Error('unreachable');
    expect(next).toMatchObject({
      generation: 2,
      fence: 1,
      stamp: null,
      snapshotId: null,
      cursor: null,
      seenCount: 0,
      pagesSoFar: 0,
    });
  });

  it('a superseded or foreign handle changes nothing', async () => {
    const sessions = createIngestSessions(database.executor);
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    expect(await sessions.advance(other, h, { cursor: 'x', addSeen: 1 })).toBeNull();
    expect(await sessions.advance(org, { ...h, fence: 2 }, { cursor: 'x', addSeen: 1 })).toBeNull();
    expect(await sessions.advance(org, { ...h, owner: B }, { cursor: 'x', addSeen: 1 })).toBeNull();
    expect(await sessions.setPendingValidators(org, { ...h, fence: 2 }, {})).toBe(false);
    expect(await sessions.abandon(org, { ...h, fence: 2 })).toBe(false);
    await expire(h.scopeKey);
    expect(await sessions.advance(org, h, { cursor: 'x', addSeen: 1 })).toBeNull();
  });

  it('collects older non-running generations of the acquired scope, at most 20 per call', async () => {
    const sessions = createIngestSessions(database.executor);
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    await sessions.abandon(org, h);
    const old: Statement[] = [];
    for (let g = 2; g < 2 + INGEST_SESSION_GC_LIMIT + 5; g += 1) {
      old.push(
        stmt(
          `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, package_key, generation, owner, fence, lease_until, state, started_at, updated_at)
           VALUES (?, ?, 'package', ?, ?, 'widget', ?, 'o', 1, ?, 'complete', ?, ?)`,
          `01J0OLD${String(g).padStart(19, '0')}`,
          org.orgId,
          h.scopeKey,
          SOURCE,
          g,
          PAST,
          PAST,
          PAST,
        ),
      );
    }
    await database.executor.batch(old);
    const next = await sessions.acquire(org, pkg('widget'), B, 60);
    if (next === 'held') throw new Error('unreachable');
    expect(next.generation).toBe(2 + INGEST_SESSION_GC_LIMIT + 5);
    expect(await rows()).toHaveLength(
      1 + INGEST_SESSION_GC_LIMIT + 5 + 1 - INGEST_SESSION_GC_LIMIT,
    );
    await sessions.abandon(org, next);
    await sessions.acquire(org, pkg('widget'), B, 60);
    const left = await rows();
    expect(left.filter((r) => r.state === 'running')).toHaveLength(1);
    expect(left.length).toBeLessThanOrEqual(1 + 6 + 1);
  });
});

describe('ingest session write guard', () => {
  const PROJECT = '01J0PRJ0000000000000000P01';

  beforeEach(async () => {
    await database.executor.batch([
      stmt(
        "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, 'p1', 'P1')",
        PROJECT,
        org.orgId,
      ),
      stmt(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        org.orgId,
        PROJECT,
        SOURCE,
      ),
    ]);
  });

  it.each(['expired', 'taken over', 'abandoned'] as const)(
    '2: a batch with a %s session guard rolls back entirely, catalogue writes included',
    async (state) => {
      const sessions = createIngestSessions(database.executor);
      const old = await sessions.acquire(org, pkg('widget'), A, 60);
      if (old === 'held') throw new Error('unreachable');
      const input = {
        sourceId: SOURCE,
        ecosystem: 'npm' as const,
        key: 'widget',
        description: 'Live',
      };
      const live = packageUpsertStatements(org, createIngestSessionWriteGuard(org, old), input);
      await database.executor.batch(live.statements);
      const packages = () =>
        database.executor.all(stmt('SELECT * FROM package WHERE org_id = ?', org.orgId));
      const before = await packages();
      expect(before).toHaveLength(1);

      if (state === 'abandoned') await sessions.abandon(org, old);
      else await expire(old.scopeKey);
      if (state === 'taken over') {
        const next = await sessions.acquire(org, pkg('widget'), B, 60);
        if (next === 'held') throw new Error('unreachable');
        expect(next.fence).toBe(2);
      }
      const stale = packageUpsertStatements(org, createIngestSessionWriteGuard(org, old), {
        ...input,
        key: 'stale-widget',
      });
      await expect(
        database.executor.batch([
          stmt(
            "UPDATE package SET description = 'Changed before guard' WHERE org_id = ?",
            org.orgId,
          ),
          ...stale.statements,
        ]),
      ).rejects.toThrow();
      expect(await packages()).toEqual(before);
    },
  );

  it('combines with a job guard: either one superseded fails the batch', async () => {
    const sessions = createIngestSessions(database.executor);
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    const job = { id: '01J0JOB0000000000000000J01', owner: A, fence: 1 };
    await database.executor.batch([
      stmt(
        `INSERT INTO job (id, org_id, type, state, lease_owner, fence, lease_until) VALUES (?, ?, 'x', 'running', ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ','now','+60 seconds'))`,
        job.id,
        org.orgId,
        A,
      ),
    ]);
    const guard = createIngestSessionWriteGuard(org, h, job);
    const ok = packageUpsertStatements(org, guard, {
      sourceId: SOURCE,
      ecosystem: 'npm',
      key: 'w',
      description: 'd',
    });
    await database.executor.batch(ok.statements);
    await database.executor.batch([stmt('UPDATE job SET fence = 2 WHERE id = ?', job.id)]);
    const bad = packageUpsertStatements(org, guard, {
      sourceId: SOURCE,
      ecosystem: 'npm',
      key: 'w2',
      description: 'd',
    });
    await expect(database.executor.batch(bad.statements)).rejects.toThrow();
  });

  it('a foreign bare guard rolls back an earlier write', async () => {
    const sessions = createIngestSessions(database.executor);
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    const before = await rows();
    await expect(
      database.executor.batch([
        stmt('UPDATE ingest_session SET seen_count = 42 WHERE id = ?', h.id),
        ...ingestSessionGuard(other, h),
      ]),
    ).rejects.toThrow();
    expect(await rows()).toEqual(before);
  });

  it('the bare guard fails for another organization', async () => {
    const sessions = createIngestSessions(database.executor);
    const h = await sessions.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    await expect(database.executor.batch([...ingestSessionGuard(other, h)])).rejects.toThrow();
    await database.executor.batch([...ingestSessionGuard(org, h)]);
  });
});
