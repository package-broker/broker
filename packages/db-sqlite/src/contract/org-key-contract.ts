import { readdir, readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { ScalarSqlExecutor, ScalarSqlValue } from '@package-broker/core/db/port';
import { migrate, MigrationApplyError } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { forgedItFor, withForeignKeysOff } from '../testing/foreign-keys-off.js';
import type { OpenedPair } from './migration-contract.js';

const migrationsUrl = new URL('../../migrations/', import.meta.url);
const ORG_KEYS_MIGRATION = '0020_org_consistent_keys.sql';
const ORG_KEYS_TIER2_MIGRATION = '0021_org_consistent_keys_tier2.sql';

const ORG_A = '01J0ACME000000000000000000';
const ORG_B = '01J0ACME000000000000000001';

type Org = 'a' | 'b';
const orgId = (org: Org): string => (org === 'a' ? ORG_A : ORG_B);
const key = (kind: string, org: Org, n = 1): string => `${kind}-${org}-${n}`;

interface Step {
  readonly sql: string;
  readonly params: readonly ScalarSqlValue[];
}

const step = (sql: string, params: readonly ScalarSqlValue[] = []): Step => ({ sql, params });

interface CrossOrgReference {
  readonly table: string;
  readonly column: string;
  readonly parent: string;
  readonly insert: Step;
  readonly undo: Step;
}

// Every case inserts a row of organization B whose single reference points at a parent of
// organization A and whose other references stay inside B.
const CROSS_ORG_REFERENCES: readonly CrossOrgReference[] = [
  {
    table: 'dist_tag',
    column: 'package_id',
    parent: 'package',
    insert: step('INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)', [
      ORG_B,
      key('pkg', 'a'),
      'crossed',
      key('ver', 'b'),
    ]),
    undo: step('DELETE FROM dist_tag WHERE tag = ?', ['crossed']),
  },
  {
    table: 'dist_tag',
    column: 'version_id',
    parent: 'version',
    insert: step('INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)', [
      ORG_B,
      key('pkg', 'b'),
      'crossed',
      key('ver', 'a'),
    ]),
    undo: step('DELETE FROM dist_tag WHERE tag = ?', ['crossed']),
  },
  {
    table: 'dist_tag_history',
    column: 'package_id',
    parent: 'package',
    insert: step(
      "INSERT INTO dist_tag_history (id, org_id, package_id, tag, version_id, previous_version_id, action, actor_type) VALUES (?, ?, ?, 'crossed', ?, NULL, 'set', 'user')",
      ['crossed', ORG_B, key('pkg', 'a'), key('ver', 'b')],
    ),
    undo: step("DELETE FROM dist_tag_history WHERE id = 'crossed'"),
  },
  {
    table: 'dist_tag_history',
    column: 'version_id',
    parent: 'version',
    insert: step(
      "INSERT INTO dist_tag_history (id, org_id, package_id, tag, version_id, previous_version_id, action, actor_type) VALUES (?, ?, ?, 'crossed', ?, NULL, 'set', 'user')",
      ['crossed', ORG_B, key('pkg', 'b'), key('ver', 'a')],
    ),
    undo: step("DELETE FROM dist_tag_history WHERE id = 'crossed'"),
  },
  {
    table: 'dist_tag_history',
    column: 'previous_version_id',
    parent: 'version',
    insert: step(
      "INSERT INTO dist_tag_history (id, org_id, package_id, tag, version_id, previous_version_id, action, actor_type) VALUES (?, ?, ?, 'crossed', ?, ?, 'set', 'user')",
      ['crossed', ORG_B, key('pkg', 'b'), key('ver', 'b'), key('ver', 'a')],
    ),
    undo: step("DELETE FROM dist_tag_history WHERE id = 'crossed'"),
  },
  {
    table: 'project_package',
    column: 'project_id',
    parent: 'project',
    insert: step(
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'explicit')",
      [ORG_B, key('prj', 'a'), key('pkg', 'b', 2)],
    ),
    undo: step('DELETE FROM project_package WHERE package_id = ?', [key('pkg', 'b', 2)]),
  },
  {
    table: 'project_package',
    column: 'package_id',
    parent: 'package',
    insert: step(
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'explicit')",
      [ORG_B, key('prj', 'b', 2), key('pkg', 'a')],
    ),
    undo: step('DELETE FROM project_package WHERE project_id = ?', [key('prj', 'b', 2)]),
  },
  {
    table: 'project_package_pattern',
    column: 'project_id',
    parent: 'project',
    insert: step(
      "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('crossed', ?, ?, ?, 'crossed/*', 'include')",
      [ORG_B, key('prj', 'a'), key('src', 'b')],
    ),
    undo: step("DELETE FROM project_package_pattern WHERE id = 'crossed'"),
  },
  {
    table: 'project_package_pattern',
    column: 'source_id',
    parent: 'source',
    insert: step(
      "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES ('crossed', ?, ?, ?, 'crossed/*', 'include')",
      [ORG_B, key('prj', 'b'), key('src', 'a')],
    ),
    undo: step("DELETE FROM project_package_pattern WHERE id = 'crossed'"),
  },
  {
    table: 'project_source',
    column: 'project_id',
    parent: 'project',
    insert: step('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
      ORG_B,
      key('prj', 'a'),
      key('src', 'b', 2),
    ]),
    undo: step('DELETE FROM project_source WHERE source_id = ?', [key('src', 'b', 2)]),
  },
  {
    table: 'project_source',
    column: 'source_id',
    parent: 'source',
    insert: step('INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)', [
      ORG_B,
      key('prj', 'b', 2),
      key('src', 'a'),
    ]),
    undo: step('DELETE FROM project_source WHERE project_id = ?', [key('prj', 'b', 2)]),
  },
  {
    table: 'package',
    column: 'source_id',
    parent: 'source',
    insert: step(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('crossed', ?, ?, 'npm', 'crossed')",
      [ORG_B, key('src', 'a')],
    ),
    undo: step("DELETE FROM package WHERE id = 'crossed'"),
  },
  {
    table: 'version',
    column: 'package_id',
    parent: 'package',
    insert: step(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES ('crossed', ?, ?, '9.9.9', '9.9.9.0', '2026-01-01T00:00:00.000Z', 'upstream', '{}')",
      [ORG_B, key('pkg', 'a')],
    ),
    undo: step("DELETE FROM version WHERE id = 'crossed'"),
  },
  {
    table: 'registered_name',
    column: 'source_id',
    parent: 'source',
    insert: step(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('crossed', ?, ?, 'npm', 'crossed/*')",
      [ORG_B, key('src', 'a')],
    ),
    undo: step("DELETE FROM registered_name WHERE id = 'crossed'"),
  },
];

const REBUILT_TABLES = [
  'dist_tag',
  'dist_tag_history',
  'package',
  'project_package',
  'project_package_pattern',
  'project_source',
  'registered_name',
  'version',
];

const TIER_2_TABLES = ['dist_tag_history', 'version', 'registered_name'];

const NEW_PARENT_INDEXES = ['package_org_id', 'project_org_id', 'source_org_id', 'version_org_id'];

const EXPECTED_FOREIGN_KEYS: Readonly<Record<string, readonly string[]>> = {
  dist_tag: [
    'package|org_id,package_id|org_id,id|NO ACTION',
    'version|org_id,version_id|org_id,id|NO ACTION',
  ],
  dist_tag_history: [
    'package|org_id,package_id|org_id,id|NO ACTION',
    'version|org_id,version_id|org_id,id|NO ACTION',
    'version|org_id,previous_version_id|org_id,id|NO ACTION',
  ],
  package: ['source|org_id,source_id|org_id,id|NO ACTION'],
  project_package: [
    'project|org_id,project_id|org_id,id|NO ACTION',
    'package|org_id,package_id|org_id,id|NO ACTION',
  ],
  project_package_pattern: [
    'project|org_id,project_id|org_id,id|NO ACTION',
    'source|org_id,source_id|org_id,id|NO ACTION',
  ],
  project_source: [
    'project|org_id,project_id|org_id,id|NO ACTION',
    'source|org_id,source_id|org_id,id|NO ACTION',
  ],
  registered_name: ['source|org_id,source_id|org_id,id|CASCADE'],
  version: ['package|org_id,package_id|org_id,id|NO ACTION'],
};

async function loadSources(include: (name: string) => boolean): Promise<MigrationSource[]> {
  const names = (await readdir(migrationsUrl)).filter((n) => n.endsWith('.sql') && include(n));
  names.sort();
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
}

const beforeOrgKeys = (name: string): boolean => name < ORG_KEYS_MIGRATION;
const throughTier1 = (name: string): boolean => name <= ORG_KEYS_MIGRATION;
const throughOrgKeys = (name: string): boolean => name <= ORG_KEYS_TIER2_MIGRATION;

async function run(executor: ScalarSqlExecutor, statement: Step): Promise<void> {
  await executor.all({ sql: statement.sql, params: statement.params });
}

async function rows<R>(
  executor: ScalarSqlExecutor,
  sql: string,
  params: readonly ScalarSqlValue[] = [],
): Promise<R[]> {
  return executor.all<R>({ sql, params });
}

function seedOrganization(org: Org): Step[] {
  const o = orgId(org);
  return [
    step('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [o, `org-${org}`, org]),
    step('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
      key('prj', org),
      o,
      'one',
      'One',
    ]),
    step('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
      key('prj', org, 2),
      o,
      'two',
      'Two',
    ]),
    step(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'npm', 'npmjs_proxy')",
      [key('src', org), o],
    ),
    step(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'second', 'npm', 'npmjs_proxy')",
      [key('src', org, 2), o],
    ),
    step(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name, removal_cause, last_op_id) VALUES (?, ?, ?, 'npm', 'left-pad', 'document_absent', 'op-1')",
      [key('pkg', org), o, key('src', org)],
    ),
    step(
      "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', 'right-pad')",
      [key('pkg', org, 2), o, key('src', org)],
    ),
    step(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, listing_seen_stamp) VALUES (?, ?, ?, '1.0.0', '1.0.0.0', '2026-01-01T00:00:00.000Z', 'upstream', '{}', 'stamp')",
      [key('ver', org), o, key('pkg', org)],
    ),
    step(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES (?, ?, ?, '1.1.0', '1.1.0.0', '2026-02-01T00:00:00.000Z', 'upstream', '{}')",
      [key('ver', org, 2), o, key('pkg', org)],
    ),
    step(
      "INSERT INTO version_revision (id, org_id, version_id, revision, metadata_json, reason) VALUES (?, ?, ?, 1, '{}', 'seed')",
      [key('rev', org), o, key('ver', org)],
    ),
    step("INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, 'latest', ?)", [
      o,
      key('pkg', org),
      key('ver', org, 2),
    ]),
    step(
      "INSERT INTO dist_tag_history (id, org_id, package_id, tag, version_id, previous_version_id, action, actor_type) VALUES (?, ?, ?, 'latest', ?, ?, 'set', 'user')",
      [key('his', org), o, key('pkg', org), key('ver', org, 2), key('ver', org)],
    ),
    step(
      "INSERT INTO project_package (org_id, project_id, package_id, origin) VALUES (?, ?, ?, 'explicit')",
      [o, key('prj', org), key('pkg', org)],
    ),
    step(
      "INSERT INTO project_package_pattern (id, org_id, project_id, source_id, pattern, effect) VALUES (?, ?, ?, ?, 'left-*', 'include')",
      [key('pat', org), o, key('prj', org), key('src', org)],
    ),
    step(
      'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 7)',
      [o, key('prj', org), key('src', org)],
    ),
    step(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', '@acme/*')",
      [key('reg', org), o, key('src', org)],
    ),
    step(
      "INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until) VALUES (?, ?, 'npm-packument', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')",
      [o, key('pkg', org)],
    ),
    step('INSERT INTO bundle (id, org_id, name) VALUES (?, ?, ?)', [key('bun', org), o, 'bundle']),
    step(
      'INSERT INTO bundle_item (org_id, bundle_id, bundle_revision, package_id) VALUES (?, ?, 1, ?)',
      [o, key('bun', org), key('pkg', org)],
    ),
  ];
}

async function seedFixture(executor: ScalarSqlExecutor): Promise<void> {
  await run(executor, step('DROP INDEX organization_singleton'));
  for (const org of ['a', 'b'] as const) {
    for (const statement of seedOrganization(org)) await run(executor, statement);
  }
}

async function openAtPreviousSchema(open: () => Promise<OpenedPair>): Promise<OpenedPair> {
  const pair = await open();
  try {
    await migrate(pair.executor, await loadSources(beforeOrgKeys), { holder: 'org-keys-before' });
    await seedFixture(pair.executor);
  } catch (error) {
    await pair.close();
    throw error;
  }
  return pair;
}

const IGNORED_FOR_DUMP = ['schema_migration', 'migration_lock'];

async function userTables(executor: ScalarSqlExecutor): Promise<string[]> {
  const found = await rows<{ name: string }>(
    executor,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY name",
  );
  return found.map((row) => row.name).filter((name) => !IGNORED_FOR_DUMP.includes(name));
}

async function dumpData(executor: ScalarSqlExecutor): Promise<Record<string, string[]>> {
  const dump: Record<string, string[]> = {};
  for (const table of await userTables(executor)) {
    const all = await rows<Record<string, unknown>>(executor, `SELECT * FROM "${table}"`);
    dump[table] = all.map((row) => JSON.stringify(row)).sort();
  }
  return dump;
}

async function dumpSchema(executor: ScalarSqlExecutor): Promise<string[]> {
  const found = await rows<{ type: string; name: string; sql: string }>(
    executor,
    "SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name, 1, 4) <> '_cf_' ORDER BY type, name",
  );
  return found.map((row) => `${row.type}|${row.name}|${row.sql}`);
}

interface IndexRow {
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string;
}

async function indexes(executor: ScalarSqlExecutor): Promise<IndexRow[]> {
  return rows<IndexRow>(
    executor,
    "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
  );
}

async function foreignKeys(executor: ScalarSqlExecutor, table: string): Promise<string[]> {
  const found = await rows<{
    id: number;
    table: string;
    from: string;
    to: string;
    on_delete: string;
  }>(
    executor,
    `SELECT id, "table", "from", "to", on_delete FROM pragma_foreign_key_list('${table}') ORDER BY id, seq`,
  );
  const grouped = new Map<number, { table: string; from: string[]; to: string[]; del: string }>();
  for (const row of found) {
    const entry = grouped.get(row.id) ?? {
      table: row.table,
      from: [],
      to: [],
      del: row.on_delete,
    };
    entry.from.push(row.from);
    entry.to.push(row.to);
    grouped.set(row.id, entry);
  }
  return [...grouped.values()]
    .map((entry) => `${entry.table}|${entry.from.join(',')}|${entry.to.join(',')}|${entry.del}`)
    .sort();
}

async function tableShape(executor: ScalarSqlExecutor, table: string): Promise<unknown> {
  return {
    columns: await rows(
      executor,
      `SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info('${table}') ORDER BY cid`,
    ),
    flags: await rows(
      executor,
      `SELECT strict, wr FROM pragma_table_list WHERE name = '${table}' AND schema = 'main'`,
    ),
  };
}

async function checkClauseCount(executor: ScalarSqlExecutor, table: string): Promise<number> {
  const [row] = await rows<{ sql: string }>(
    executor,
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    [table],
  );
  return (row?.sql.match(/\bCHECK\s*\(/g) ?? []).length;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

export function describeOrgKeyContract(
  name: string,
  open: () => Promise<OpenedPair>,
  options: { readonly d1?: boolean } = {},
): void {
  const forgedIt = forgedItFor(options.d1 === true);
  describe(`org-consistent keys, migrations 0020 and 0021: ${name}`, () => {
    describe('preflight', () => {
      let pair: OpenedPair;
      let migrations: MigrationSource[];

      beforeAll(async () => {
        pair = await openAtPreviousSchema(open);
        migrations = await loadSources(throughOrgKeys);
      });

      afterAll(async () => {
        await pair.close();
      });

      it.each(CROSS_ORG_REFERENCES.map((ref) => [`${ref.table}.${ref.column}`, ref] as const))(
        'refuses to migrate and changes nothing when %s crosses organizations',
        async (_label, ref) => {
          const { executor } = pair;
          await run(executor, ref.insert);
          try {
            const dataBefore = await dumpData(executor);
            const schemaBefore = await dumpSchema(executor);

            const error = await rejection(migrate(executor, migrations, { holder: 'org-keys' }));

            expect(error).toBeInstanceOf(MigrationApplyError);
            expect((error as Error).message).toContain(`${ref.table}.${ref.column}`);
            expect((error as Error).message).toContain('cross-org rows: 1');
            expect(await dumpData(executor)).toEqual(dataBefore);
            expect(await dumpSchema(executor)).toEqual(schemaBefore);
            expect(
              await rows(executor, 'SELECT id FROM schema_migration WHERE id = ?', [
                `core:${ORG_KEYS_MIGRATION.replace('.sql', '')}`,
              ]),
            ).toEqual([]);
          } finally {
            await run(executor, ref.undo);
          }
        },
      );

      it('reports the number of crossing rows', async () => {
        const { executor } = pair;
        const second = step(
          'INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, ?, ?)',
          [ORG_B, key('pkg', 'a'), 'crossed-two', key('ver', 'b')],
        );
        const first = CROSS_ORG_REFERENCES[0];
        if (first === undefined) throw new Error('no cross-org reference cases');
        await run(executor, first.insert);
        await run(executor, second);
        try {
          const error = await rejection(migrate(executor, migrations, { holder: 'org-keys' }));

          expect((error as Error).message).toContain('dist_tag.package_id cross-org rows: 2');
        } finally {
          await run(executor, step("DELETE FROM dist_tag WHERE tag IN ('crossed', 'crossed-two')"));
        }
      });
    });

    describe('orphan preflight', () => {
      let pair: OpenedPair;
      let migrations: MigrationSource[];

      beforeAll(async () => {
        pair = await openAtPreviousSchema(open);
        migrations = await loadSources(throughOrgKeys);
      });

      afterAll(async () => {
        await pair.close();
      });

      forgedIt(
        'refuses to migrate and changes nothing when a child row has no parent',
        async () => {
          const { executor } = pair;
          await withForeignKeysOff(executor, () =>
            run(
              executor,
              step(
                "INSERT INTO dist_tag_history (id, org_id, package_id, tag, version_id, previous_version_id, action, actor_type) VALUES ('orphan', ?, 'missing-package', 'x', NULL, NULL, 'set', 'user')",
                [ORG_A],
              ),
            ),
          );
          try {
            const schemaBefore = await dumpSchema(executor);

            const error = await rejection(migrate(executor, migrations, { holder: 'org-keys' }));

            expect(error).toBeInstanceOf(MigrationApplyError);
            expect((error as Error).message).toContain(
              'dist_tag_history.package_id orphan rows: 1',
            );
            expect(await dumpSchema(executor)).toEqual(schemaBefore);
          } finally {
            await run(executor, step("DELETE FROM dist_tag_history WHERE id = 'orphan'"));
          }
        },
      );
    });

    describe('tier 2 preflight (0021)', () => {
      let pair: OpenedPair;
      let migrations: MigrationSource[];

      beforeAll(async () => {
        pair = await openAtPreviousSchema(open);
        await migrate(pair.executor, await loadSources(throughTier1), { holder: 'org-keys-tier1' });
        migrations = await loadSources(throughOrgKeys);
      });

      afterAll(async () => {
        await pair.close();
      });

      it.each(
        CROSS_ORG_REFERENCES.filter((ref) => TIER_2_TABLES.includes(ref.table)).map(
          (ref) => [`${ref.table}.${ref.column}`, ref] as const,
        ),
      )(
        'refuses to run 0021 and changes nothing when %s crosses organizations',
        async (_l, ref) => {
          const { executor } = pair;
          await run(executor, ref.insert);
          try {
            const dataBefore = await dumpData(executor);
            const schemaBefore = await dumpSchema(executor);

            const error = await rejection(migrate(executor, migrations, { holder: 'org-keys' }));

            expect(error).toBeInstanceOf(MigrationApplyError);
            expect((error as Error).message).toContain(
              `${ref.table}.${ref.column} cross-org rows: 1`,
            );
            expect(await dumpData(executor)).toEqual(dataBefore);
            expect(await dumpSchema(executor)).toEqual(schemaBefore);
            expect(
              await rows(executor, 'SELECT id FROM schema_migration WHERE id = ?', [
                `core:${ORG_KEYS_TIER2_MIGRATION.replace('.sql', '')}`,
              ]),
            ).toEqual([]);
          } finally {
            await run(executor, ref.undo);
          }
        },
      );
    });

    it('preserves version counts and contents with negative, zero and large rowids', async () => {
      const pair = await openAtPreviousSchema(open);
      try {
        const { executor } = pair;
        await migrate(executor, await loadSources(throughTier1), { holder: 'rowids-tier1' });
        const rowids = [-1, -7, 0, Number.MAX_SAFE_INTEGER];
        const ids = [key('ver', 'a'), key('ver', 'a', 2), key('ver', 'b'), key('ver', 'b', 2)];
        for (const [index, id] of ids.entries()) {
          await run(
            executor,
            step('UPDATE version SET rowid = ? WHERE id = ?', [rowids[index]!, id]),
          );
        }
        expect(await rows(executor, 'SELECT rowid FROM version ORDER BY rowid')).toEqual(
          [...rowids].sort((a, b) => a - b).map((rowid) => ({ rowid })),
        );
        const before = await dumpData(executor);
        const countBefore = await rows(executor, 'SELECT count(*) AS n FROM version');

        await migrate(executor, await loadSources(throughOrgKeys), { holder: 'rowids-tier2' });

        expect(await rows(executor, 'SELECT count(*) AS n FROM version')).toEqual(countBefore);
        expect(await dumpData(executor)).toEqual(before);
      } finally {
        await pair.close();
      }
    });

    describe('populated fixture', () => {
      let pair: OpenedPair;
      let dataBefore: Record<string, string[]>;
      let indexesBefore: IndexRow[];
      let shapesBefore: unknown[];
      let checksBefore: number[];

      beforeAll(async () => {
        pair = await openAtPreviousSchema(open);
        const { executor } = pair;
        dataBefore = await dumpData(executor);
        indexesBefore = await indexes(executor);
        shapesBefore = await Promise.all(REBUILT_TABLES.map((t) => tableShape(executor, t)));
        checksBefore = await Promise.all(REBUILT_TABLES.map((t) => checkClauseCount(executor, t)));
        await migrate(executor, await loadSources(throughOrgKeys), { holder: 'org-keys' });
      });

      afterAll(async () => {
        await pair.close();
      });

      it('ships as a contract-phase migration', async () => {
        const found = await loadSources(
          (n) => n === ORG_KEYS_MIGRATION || n === ORG_KEYS_TIER2_MIGRATION,
        );

        expect(found.map((source) => source.phase)).toEqual(['contract', 'contract']);
      });

      it('keeps every row of every table', async () => {
        expect(await dumpData(pair.executor)).toEqual(dataBefore);
      });

      it('keeps every index and adds one unique (id, org_id) index per parent', async () => {
        const after = await indexes(pair.executor);

        const kept = after.filter((index) => !NEW_PARENT_INDEXES.includes(index.name));
        const added = after.filter((index) => NEW_PARENT_INDEXES.includes(index.name));
        expect(kept).toEqual(indexesBefore);
        expect(added.map((index) => `${index.tbl_name}:${index.name}`).sort()).toEqual([
          'package:package_org_id',
          'project:project_org_id',
          'source:source_org_id',
          'version:version_org_id',
        ]);
        for (const index of added) expect(index.sql).toMatch(/^CREATE UNIQUE INDEX/);
      });

      it('keeps column definitions, STRICT and WITHOUT ROWID of rebuilt tables', async () => {
        const after = await Promise.all(REBUILT_TABLES.map((t) => tableShape(pair.executor, t)));

        expect(after).toEqual(shapesBefore);
      });

      it('keeps every CHECK clause of rebuilt tables', async () => {
        const after = await Promise.all(
          REBUILT_TABLES.map((t) => checkClauseCount(pair.executor, t)),
        );

        expect(after).toEqual(checksBefore);
      });

      it.each(Object.entries(EXPECTED_FOREIGN_KEYS))(
        'declares composite organization references on %s',
        async (table, expected) => {
          const found = await foreignKeys(pair.executor, table);

          expect(
            found.filter((entry) => /^(package|source|project|version)\|/.test(entry)),
          ).toEqual([...expected].sort());
        },
      );

      it('leaves no foreign key violation behind', async () => {
        expect(await rows(pair.executor, 'PRAGMA foreign_key_check')).toEqual([]);
      });

      it('accepts a row whose references stay inside its organization', async () => {
        await run(
          pair.executor,
          step(
            "INSERT INTO dist_tag (org_id, package_id, tag, version_id) VALUES (?, ?, 'beta', ?)",
            [ORG_B, key('pkg', 'b'), key('ver', 'b')],
          ),
        );

        const [row] = await rows<{ n: number }>(
          pair.executor,
          "SELECT count(*) AS n FROM dist_tag WHERE tag = 'beta'",
        );
        expect(row?.n).toBe(1);
      });

      it.each(CROSS_ORG_REFERENCES.map((ref) => [`${ref.table}.${ref.column}`, ref] as const))(
        'refuses a cross-organization insert through %s',
        async (_label, ref) => {
          const error = await rejection(run(pair.executor, ref.insert));

          expect(error).toBeInstanceOf(DbError);
          expect((error as DbError).kind).toBe('foreign_key');
        },
      );
    });
  });
}
