import { discoveredMigrations } from '../testing/migrated-database.js';
import { migrate } from '../migrations/runner.js';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { ScalarSqlExecutor, ScalarSqlValue } from '@package-broker/core/db/port';
import type { OpenedPair } from './migration-contract.js';
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
      "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) VALUES (?, ?, ?, 'explicit', 'npm', 'left-pad')",
      [ORG_B, key('prj', 'a'), key('pkg', 'b', 2)],
    ),
    undo: step('DELETE FROM project_package WHERE package_id = ?', [key('pkg', 'b', 2)]),
  },
  {
    table: 'project_package',
    column: 'package_id',
    parent: 'package',
    insert: step(
      "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) VALUES (?, ?, ?, 'explicit', 'npm', 'left-pad')",
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
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
      "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) VALUES (?, ?, ?, 'explicit', 'npm', 'left-pad')",
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

async function openBaseline(open: () => Promise<OpenedPair>): Promise<OpenedPair> {
  const pair = await open();
  try {
    await migrate(pair.executor, await discoveredMigrations(), { holder: 'org-keys-baseline' });
    await seedFixture(pair.executor);
  } catch (error) {
    await pair.close();
    throw error;
  }
  return pair;
}

export function describeOrgKeyContract(name: string, open: () => Promise<OpenedPair>): void {
  describe(`org-consistent keys on the baseline: ${name}`, () => {
    describe('populated fixture', () => {
      let pair: OpenedPair;
      beforeAll(async () => {
        pair = await openBaseline(open);
      });

      afterAll(async () => {
        await pair.close();
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
