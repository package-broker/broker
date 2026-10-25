import { expect } from 'vitest';
import { vulnerabilitySnapshotStatement } from '../../repositories/vulnerability.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const inputIsolation: ContractCase = {
  name: 'npm audit input CTE excludes a foreign source/key/version reference',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      `INSERT INTO source (id,org_id,name,ecosystem,type,url) VALUES ('audit-foreign',?,'foreign','npm','npmjs_proxy','https://registry.npmjs.org')`,
      foreign.orgId,
    );
    await seed(
      `INSERT INTO package (id,org_id,source_id,ecosystem,name) VALUES ('audit-package',?,'audit-foreign','npm','pub')`,
      foreign.orgId,
    );
    await seed(
      `INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json) VALUES ('audit-version',?,'audit-package','1.0.0','1.0.0','2026-10-25T00:00:00.000Z','upstream','{}')`,
      foreign.orgId,
    );
    const query = vulnerabilitySnapshotStatement(own, {
      npm: [{ sourceId: 'audit-foreign', key: 'pub', version: '1.0.0' }],
    });
    // Observe input independently: the later candidate org pin also rejects these rows.
    const observed = {
      ...query,
      sql: query.sql.replace(
        "'detail_id', ?",
        "'input_ids', (SELECT json_group_array(id) FROM input), 'detail_id', ?",
      ),
    };
    const rows = await context.executor.all<{ snapshot: string }>(context.mutate(observed));
    expect(JSON.parse(rows[0]!.snapshot).input_ids).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/vulnerability.ts',
    builder: 'vulnerabilitySnapshotStatement',
    cases: [inputIsolation],
    predicates: [
      {
        name: 'npm audit reference org input',
        locate: /rp\.org_id = \?/,
        neutral: '(? IS NOT NULL)',
        copies: 1,
        caseName: inputIsolation.name,
      },
    ],
    waivers: [
      {
        locate: /\b(?:v|p|r|s)\.org_id = \?/g,
        reason:
          'The existing vulnerability snapshot entries independently test candidate, holder, registration and config organization pins.',
      },
      {
        locate: /\b\w+\.org_id\s*=\s*\w+\.org_id/g,
        reason:
          'Composite parent joins are covered by the existing vulnerability snapshot entries and composite foreign keys.',
      },
    ],
  },
];
