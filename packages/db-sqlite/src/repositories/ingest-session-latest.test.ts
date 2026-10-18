import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, Statement } from '@package-broker/core/db/port';
import type {
  IngestScopeRef,
  IngestSessionMaintenance,
  IngestSessions as IngestSessionsPort,
} from '@package-broker/core/ingest/session';
import {
  INGEST_SESSION_DEAD_DAYS,
  INGEST_SESSION_SWEEP_LIMIT,
  createIngestSessionMaintenance,
  sweepStatements,
} from './ingest-session.js';
import { leaseKey } from './fetch-lease.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createIngestSessions } from './ingest-session.js';

const A = '01J0WWWWWWWWWWWWWWWWWW0A01';
const SOURCE = '01J0SRC0000000000000000S01';
const OTHER_SOURCE = '01J0SRC0000000000000000S02';
const PAST = '2000-01-01T00:00:00.000Z';
const STAMP = 'a'.repeat(64);

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

function sessions(): IngestSessionsPort {
  return createIngestSessions(database.executor);
}

let serial = 0;
async function insertRow(
  orgId: string,
  scopeKey: string,
  generation: number,
  state: 'running' | 'complete' | 'abandoned',
  leaseUntil: string,
): Promise<string> {
  serial += 1;
  const id = `01J0ROW${String(serial).padStart(19, '0')}`;
  await database.executor.batch([
    stmt(
      `INSERT INTO ingest_session (id, org_id, scope, scope_key, source_id, package_key, generation, owner, fence, lease_until, state, started_at, updated_at)
       VALUES (?, ?, 'package', ?, ?, 'widget', ?, 'o', 1, ?, ?, ?, ?)`,
      id,
      orgId,
      scopeKey,
      orgId === org.orgId ? SOURCE : OTHER_SOURCE,
      generation,
      leaseUntil,
      state,
      PAST,
      PAST,
    ),
  ]);
  return id;
}

async function ids(): Promise<string[]> {
  const found = await database.executor.all(stmt('SELECT id FROM ingest_session ORDER BY id'));
  return found.map((r) => String(r.id));
}

const key = (n: number) => n.toString(16).padStart(64, '0');
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

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

describe('ingest session latest', () => {
  it('1: the repository satisfies the core port', () => {
    const port: IngestSessionsPort = createIngestSessions(database.executor);
    expect(typeof port.latest).toBe('function');
    const maintenance: IngestSessionMaintenance = createIngestSessionMaintenance(database.executor);
    expect(typeof maintenance.sweep).toBe('function');
    expect('sweep' in port).toBe(false);
  });

  it('2: returns null when the scope has no session', async () => {
    expect(await sessions().latest(org, pkg('widget'))).toBeNull();
  });

  it('2: reports a running session with its fence and counts', async () => {
    const s = sessions();
    const h = await s.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    await s.start(org, h, { snapshot: { id: 'e' }, stamp: STAMP });
    await s.advance(org, h, { cursor: 'c', addSeen: 4 });
    expect(await s.latest(org, pkg('widget'))).toEqual({
      state: 'running',
      generation: 1,
      fence: 1,
      seenCount: 4,
      pagesSoFar: 1,
    });
  });

  it('2: reports the newest generation, complete or abandoned', async () => {
    const s = sessions();
    const h = await s.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    await s.abandon(org, h);
    expect(await s.latest(org, pkg('widget'))).toMatchObject({
      state: 'abandoned',
      generation: 1,
    });
    await database.executor.batch([
      stmt(
        "UPDATE ingest_session SET state = 'complete', seen_count = 9 WHERE org_id = ?",
        org.orgId,
      ),
    ]);
    expect(await s.latest(org, pkg('widget'))).toMatchObject({
      state: 'complete',
      generation: 1,
      seenCount: 9,
    });
    const next = await s.acquire(org, pkg('widget'), A, 60);
    if (next === 'held') throw new Error('unreachable');
    expect(await s.latest(org, pkg('widget'))).toMatchObject({
      state: 'running',
      generation: 2,
    });
  });

  it('2: picks the highest generation among several rows', async () => {
    const s = sessions();
    const h = await s.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    await s.abandon(org, h);
    await insertRow(org.orgId, h.scopeKey, 2, 'complete', PAST);
    await insertRow(org.orgId, h.scopeKey, 3, 'abandoned', PAST);
    await insertRow(org.orgId, h.scopeKey, 4, 'complete', PAST);
    await insertRow(org.orgId, h.scopeKey, 11, 'abandoned', PAST);
    expect(await s.latest(org, pkg('widget'))).toMatchObject({
      state: 'abandoned',
      generation: 11,
    });
  });

  it('2: ignores another organization with the same scope key', async () => {
    const s = sessions();
    const h = await s.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    await insertRow(other.orgId, h.scopeKey, 5, 'complete', PAST);
    expect(await s.latest(org, pkg('widget'))).toMatchObject({ generation: 1 });
    expect(await s.latest(other, pkg('widget'))).toBeNull();
  });

  it('2: never extends a lease or touches a row', async () => {
    const s = sessions();
    const h = await s.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    await database.executor.batch([
      stmt('UPDATE ingest_session SET lease_until = ? WHERE org_id = ?', PAST, org.orgId),
    ]);
    const before = await database.executor.all(stmt('SELECT * FROM ingest_session'));
    await s.latest(org, pkg('widget'));
    expect(await database.executor.all(stmt('SELECT * FROM ingest_session'))).toEqual(before);
  });

  it('rejects malformed scopes', async () => {
    await expect(sessions().latest(org, pkg(''))).rejects.toThrow(RangeError);
  });
});

function maintenance(): IngestSessionMaintenance {
  return createIngestSessionMaintenance(database.executor);
}

async function states(): Promise<Record<string, string>> {
  const found = await database.executor.all(stmt('SELECT id, state FROM ingest_session'));
  return Object.fromEntries(found.map((r) => [String(r.id), String(r.state)]));
}

describe('ingest session maintenance sweep', () => {
  it('3: deletes non-latest finished generations and keeps the latest', async () => {
    const k = key(1);
    await insertRow(org.orgId, k, 1, 'complete', PAST);
    await insertRow(org.orgId, k, 2, 'abandoned', PAST);
    const latest = await insertRow(org.orgId, k, 3, 'complete', PAST);
    expect(await maintenance().sweep(10)).toEqual({ abandoned: 0, deleted: 2 });
    expect(await ids()).toEqual([latest]);
  });

  it('1: two scopes in one org are judged separately', async () => {
    const onlyA = await insertRow(org.orgId, key(1), 1, 'complete', PAST);
    await insertRow(org.orgId, key(2), 1, 'complete', PAST);
    await insertRow(org.orgId, key(2), 2, 'complete', PAST);
    const latestB = await insertRow(org.orgId, key(2), 3, 'complete', PAST);
    expect(await maintenance().sweep(10)).toEqual({ abandoned: 0, deleted: 2 });
    expect(await ids()).toEqual([onlyA, latestB].sort());
  });

  it('4: two orgs sharing a scope key are judged separately', async () => {
    const k = key(1);
    const lowOther = await insertRow(other.orgId, k, 1, 'complete', PAST);
    await insertRow(org.orgId, k, 1, 'complete', PAST);
    const top = await insertRow(org.orgId, k, 2, 'complete', PAST);
    expect(await maintenance().sweep(10)).toEqual({ abandoned: 0, deleted: 1 });
    expect(await ids()).toEqual([lowOther, top].sort());
  });

  it('a bounded sweep keeps a finished row when only a foreign generation is newer', async () => {
    const own = await insertRow(org.orgId, key(1), 1, 'complete', PAST);
    const foreign = await insertRow(other.orgId, key(1), 2, 'complete', PAST);
    await database.executor.batch([...sweepStatements(1, PAST, PAST)]);
    expect(await ids()).toEqual([own, foreign].sort());
  });

  it('3: keeps a latest finished session and a recently expired running one', async () => {
    const abandoned = await insertRow(org.orgId, key(1), 1, 'abandoned', PAST);
    const fresh = await insertRow(org.orgId, key(2), 1, 'running', ago(1));
    const live = await insertRow(org.orgId, key(3), 1, 'running', '2999-01-01T00:00:00.000Z');
    expect(await maintenance().sweep(10)).toEqual({ abandoned: 0, deleted: 0 });
    expect(await ids()).toEqual([abandoned, fresh, live].sort());
    expect((await states())[fresh]).toBe('running');
  });

  it('3: abandons a long-dead running session across orgs instead of deleting it', async () => {
    const age = ago(INGEST_SESSION_DEAD_DAYS + 1);
    const dead = await insertRow(org.orgId, key(1), 2, 'running', age);
    await insertRow(org.orgId, key(1), 1, 'complete', PAST);
    const deadOther = await insertRow(other.orgId, key(2), 1, 'running', age);
    const keep = await insertRow(
      org.orgId,
      key(3),
      1,
      'running',
      ago(INGEST_SESSION_DEAD_DAYS - 1),
    );
    expect(await maintenance().sweep(10)).toEqual({ abandoned: 2, deleted: 1 });
    expect(await states()).toEqual({
      [dead]: 'abandoned',
      [deadOther]: 'abandoned',
      [keep]: 'running',
    });
  });

  it('3: after the sweep latest reports abandoned, not an older complete, and acquire is generation + 1', async () => {
    const s = sessions();
    const scopeKey = await leaseKey([org.orgId, 'ingest', 'package', SOURCE, 'widget']);
    await insertRow(org.orgId, scopeKey, 1, 'complete', PAST);
    const h = await s.acquire(org, pkg('widget'), A, 60);
    if (h === 'held') throw new Error('unreachable');
    expect(h.generation).toBe(2);
    await database.executor.batch([
      stmt(
        "UPDATE ingest_session SET lease_until = ? WHERE org_id = ? AND state = 'running'",
        ago(INGEST_SESSION_DEAD_DAYS + 1),
        org.orgId,
      ),
    ]);
    await maintenance().sweep(10);
    expect(await s.latest(org, pkg('widget'))).toMatchObject({
      state: 'abandoned',
      generation: 2,
    });
    const next = await s.acquire(org, pkg('widget'), A, 60);
    if (next === 'held') throw new Error('unreachable');
    expect(next.generation).toBe(3);
  });

  it('5: removes at most the requested number per run, oldest lease first', async () => {
    const k = key(1);
    const made: string[] = [];
    for (let g = 1; g <= 5; g += 1) {
      made.push(
        await insertRow(org.orgId, k, g, 'complete', `2000-01-0${String(g)}T00:00:00.000Z`),
      );
    }
    const latest = await insertRow(org.orgId, k, 6, 'complete', '2000-01-09T00:00:00.000Z');
    expect(await maintenance().sweep(3)).toEqual({ abandoned: 0, deleted: 3 });
    expect(await ids()).toEqual([made[3], made[4], latest].sort());
    expect(await maintenance().sweep(3)).toEqual({ abandoned: 0, deleted: 2 });
    expect(await ids()).toEqual([latest]);
  });

  it('3: abandoning is bounded too', async () => {
    const age = ago(INGEST_SESSION_DEAD_DAYS + 1);
    for (let n = 1; n <= 4; n += 1) await insertRow(org.orgId, key(n), 1, 'running', age);
    expect(await maintenance().sweep(3)).toEqual({ abandoned: 3, deleted: 0 });
  });

  it('3: the limit is validated and capped', async () => {
    await expect(maintenance().sweep(0)).rejects.toThrow(RangeError);
    await expect(maintenance().sweep(INGEST_SESSION_SWEEP_LIMIT + 1)).rejects.toThrow(RangeError);
    await expect(maintenance().sweep(1.5)).rejects.toThrow(RangeError);
  });

  it('3: a full-size run stays within the bound', async () => {
    const k = key(1);
    for (let g = 1; g <= INGEST_SESSION_SWEEP_LIMIT + 3; g += 1) {
      await insertRow(org.orgId, k, g, 'complete', PAST);
    }
    const result = await maintenance().sweep(INGEST_SESSION_SWEEP_LIMIT);
    expect(result.deleted).toBe(INGEST_SESSION_SWEEP_LIMIT);
    expect(await ids()).toHaveLength(3);
  });

  it('2: neither sweep statement scans ingest_session', async () => {
    const statements = sweepStatements(5, '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z');
    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      const plan = await database.executor.all(
        stmt(
          `EXPLAIN QUERY PLAN ${statement.sql}`,
          ...(statement.params as (string | number | null)[]),
        ),
      );
      const details = plan.map((r) => String(r.detail));
      expect(details.filter((d) => /\bSCAN\b(?!.*USING)/.test(d))).toEqual([]);
      expect(details.some((d) => d.includes('ingest_session_'))).toBe(true);
    }
  });

  it('2: the statements carry the cutoff and never re-read now', () => {
    for (const statement of sweepStatements(5, 'C', 'N')) {
      expect(statement.sql).not.toMatch(/'now'|strftime/);
    }
  });
});
