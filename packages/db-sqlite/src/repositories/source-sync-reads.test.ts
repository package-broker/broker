import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createSourceSyncReads, staleHeldKeysStatement } from './source-sync-reads.js';

let database: MigratedDatabase;
let executor: SqlExecutor;
let own: OrgContext;
let foreign: OrgContext;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  executor = database.executor;
  own = database.orgs!.a;
  foreign = database.orgs!.b;
});
afterEach(async () => {
  await database.close();
});

const OLD = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const NOW = '2026-10-20T12:00:00.000Z';
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });

async function source(id: string, org: OrgContext, type = 'npmjs_proxy') {
  await executor.batch([
    stmt(
      'INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, ?, ?, ?)',
      id,
      org.orgId,
      id,
      type === 'packagist_proxy' ? 'composer' : 'npm',
      type,
    ),
  ]);
}

async function pkg(id: string, org: OrgContext, sourceId: string, name: string, ecosystem = 'npm') {
  await executor.batch([
    stmt(
      'INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, ?, ?)',
      id,
      org.orgId,
      sourceId,
      ecosystem,
      name,
    ),
  ]);
}

async function state(id: string, org: OrgContext, form: string, freshUntil: string, notFound = 0) {
  await executor.batch([
    stmt(
      'INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until, not_found_count) VALUES (?, ?, ?, ?, ?, ?)',
      org.orgId,
      id,
      form,
      OLD,
      freshUntil,
      notFound,
    ),
  ]);
}

const reads = () => createSourceSyncReads(executor);

describe('source sync reads', () => {
  beforeEach(async () => {
    await source('S', own);
    await source('T', own);
    await source('F', foreign);
  });

  it('existingKeys returns only requested keys in this organization and source', async () => {
    await pkg('own', own, 'S', 'shared');
    await pkg('removed', own, 'S', 'removed');
    await executor.batch([
      stmt(
        "UPDATE package SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = 'removed'",
        OLD,
      ),
    ]);
    await pkg('other-source', own, 'T', 'other');
    await pkg('foreign-shared', foreign, 'F', 'shared');
    await pkg('foreign-only', foreign, 'F', 'foreign');
    expect(
      await reads().existingKeys(own, 'S', [
        'shared',
        'shared',
        'removed',
        'other',
        'foreign',
        'missing',
      ]),
    ).toEqual(new Set(['shared', 'removed']));
    expect(await reads().existingKeys(foreign, 'F', ['shared', 'foreign'])).toEqual(
      new Set(['shared', 'foreign']),
    );
    expect(await reads().existingKeys(foreign, 'S', ['shared', 'removed'])).toEqual(new Set());
    expect(await reads().existingKeys(own, 'F', ['shared', 'foreign'])).toEqual(new Set());
  });

  it('chunks 250 names into statements binding at most 100 parameters, without patterns', async () => {
    const names = Array.from(
      { length: 250 },
      (_, i) => `long-${'x'.repeat(60)}-${String(i).padStart(3, '0')}`,
    );
    for (const [i, name] of names.entries()) await pkg(`p${String(i)}`, own, 'S', name);
    const statements: Statement[] = [];
    const observed: SqlExecutor = {
      ...executor,
      async all<R>(statement: Statement): Promise<R[]> {
        statements.push(statement);
        return executor.all<R>(statement);
      },
    };
    expect(await createSourceSyncReads(observed).existingKeys(own, 'S', names)).toEqual(
      new Set(names),
    );
    expect(statements).toHaveLength(3);
    expect(statements.map((statement) => statement.params.length)).toEqual([100, 100, 56]);
    expect(statements.every((statement) => !/\b(?:glob|like)\b/i.test(statement.sql))).toBe(true);
    statements.length = 0;
    expect(await createSourceSyncReads(observed).existingKeys(own, 'S', [])).toEqual(new Set());
    expect(statements).toEqual([]);
  });

  it('staleHeldKeys uses the primary upstream form, absence counter and strict freshness boundary', async () => {
    for (const key of [
      'absent',
      'expired',
      'negative',
      'fresh',
      'boundary',
      'wrong-form',
      'removed',
    ]) {
      await pkg(key, own, 'S', key);
    }
    await state('expired', own, 'npm-packument', OLD);
    await state('negative', own, 'npm-packument', FUTURE, 1);
    await state('fresh', own, 'npm-packument', FUTURE);
    await state('boundary', own, 'npm-packument', NOW);
    await state('wrong-form', own, 'composer-p2', FUTURE);
    await executor.batch([
      stmt(
        "UPDATE package SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = 'removed'",
        OLD,
      ),
    ]);
    for (const [org, id] of [
      [own, 'T'],
      [foreign, 'F'],
    ] as const) {
      for (const key of ['absent', 'foreign-only']) await pkg(`${id}-${key}`, org, id, key);
    }
    // Pin SQLite's statement clock, preserving the production comparison operator.
    const atBoundary = createSourceSyncReads({
      ...executor,
      all<R>(statement: Statement): Promise<R[]> {
        expect(statement.sql).toContain("strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");
        return executor.all<R>({
          ...statement,
          sql: statement.sql.replaceAll("'now'", `'${NOW}'`),
        });
      },
    });
    expect(await atBoundary.staleHeldKeys(own, 'S', { after: null, limit: 20 })).toEqual({
      keys: ['absent', 'boundary', 'expired', 'negative', 'removed', 'wrong-form'],
      next: null,
    });
    expect(await atBoundary.staleHeldKeys(foreign, 'S', { after: null, limit: 20 })).toEqual({
      keys: [],
      next: null,
    });
    expect(await atBoundary.staleHeldKeys(own, 'F', { after: null, limit: 20 })).toEqual({
      keys: [],
      next: null,
    });
    expect(await atBoundary.staleHeldKeys(foreign, 'F', { after: null, limit: 20 })).toEqual({
      keys: ['absent', 'foreign-only'],
      next: null,
    });
  });

  it('uses composer-p2 for Packagist and npm-packument for npm_registry', async () => {
    for (const [id, type, form, ecosystem] of [
      ['C', 'packagist_proxy', 'composer-p2', 'composer'],
      ['N', 'npm_registry', 'npm-packument', 'npm'],
    ] as const) {
      await source(id, own, type);
      await pkg(`${id}-fresh`, own, id, 'vendor/fresh', ecosystem);
      await pkg(`${id}-stale`, own, id, 'vendor/stale', ecosystem);
      await state(`${id}-fresh`, own, form, FUTURE);
      await state(
        `${id}-stale`,
        own,
        form === 'composer-p2' ? 'composer-p2-dev' : 'composer-p2',
        FUTURE,
      );
      expect(await reads().staleHeldKeys(own, id, { after: null, limit: 2 })).toEqual({
        keys: ['vendor/stale'],
        next: null,
      });
    }
  });

  it('walks three keyset pages without losing or repeating keys after inserts', async () => {
    for (const key of ['a', 'c', 'e', 'g', 'i']) await pkg(key, own, 'S', key);
    const first = await reads().staleHeldKeys(own, 'S', { after: null, limit: 2 });
    expect(first).toEqual({ keys: ['a', 'c'], next: 'c' });
    await pkg('b', own, 'S', 'b');
    await pkg('d', own, 'S', 'd');
    const second = await reads().staleHeldKeys(own, 'S', { after: first.next, limit: 2 });
    expect(second).toEqual({ keys: ['d', 'e'], next: 'e' });
    const third = await reads().staleHeldKeys(own, 'S', { after: second.next, limit: 2 });
    expect(third).toEqual({ keys: ['g', 'i'], next: null });
    const keys = [...first.keys, ...second.keys, ...third.keys];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(['a', 'c', 'd', 'e', 'g', 'i']);
    expect(await reads().staleHeldKeys(own, 'S', { after: 'z', limit: 2 })).toEqual({
      keys: [],
      next: null,
    });
    const statement = staleHeldKeysStatement(own, 'S', { after: 'c', limit: 2 });
    expect(statement.sql).not.toMatch(/\boffset\b/i);
  });

  it('seeks package_identity from the cursor without temporary ordering', async () => {
    for (const after of [null, 'cursor']) {
      const statement = staleHeldKeysStatement(own, 'S', { after, limit: 2 });
      const plan = await executor.all<{ detail: string }>({
        ...statement,
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
      });
      const details = plan.map((row) => row.detail).join('\n');
      const cursor = after === null ? '' : ' AND name>?';
      expect(details).toContain(
        `SEARCH p USING INDEX package_identity (org_id=? AND ecosystem=? AND source_id=?${cursor})`,
      );
      expect(details).not.toContain('USE TEMP B-TREE');
      expect(statement.params.at(-1)).toBe(3);
    }
  });

  // Before migration 0020 these cross-organization rows satisfy the single-column FKs.
  it('excludes an own package referencing a foreign source', async () => {
    await pkg('cross-source', own, 'F', 'cross-source');
    expect(await reads().staleHeldKeys(own, 'F', { after: null, limit: 2 })).toEqual({
      keys: [],
      next: null,
    });
  });

  it('ignores foreign upstream state referencing an own package', async () => {
    await pkg('cross-state', own, 'S', 'cross-state');
    await state('cross-state', foreign, 'npm-packument', FUTURE);
    expect(await reads().staleHeldKeys(own, 'S', { after: null, limit: 2 })).toEqual({
      keys: ['cross-state'],
      next: null,
    });
  });

  it('rejects invalid source ids and page sizes', async () => {
    await expect(reads().existingKeys(own, '', [])).rejects.toThrow(RangeError);
    await expect(reads().staleHeldKeys(own, '', { after: null, limit: 2 })).rejects.toThrow(
      RangeError,
    );
    for (const limit of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      await expect(reads().staleHeldKeys(own, 'S', { after: null, limit })).rejects.toThrow(
        RangeError,
      );
    }
  });
});
