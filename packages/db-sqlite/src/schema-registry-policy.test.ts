import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Selectable } from 'kysely';
import type { Database } from './schema.js';
import { openMigratedDatabase, type MigratedDatabase } from './testing/migrated-database.js';

type Table = 'registry_policy_rule' | 'registry_policy_version';
type Columns<T extends Table> = {
  [K in keyof Selectable<Database[T]>]: null extends Selectable<Database[T]>[K] ? 0 : 1;
};
const declared: { [T in Table]: Columns<T> } = {
  registry_policy_rule: {
    id: 1,
    org_id: 1,
    project_id: 0,
    ecosystem: 1,
    package_key: 0,
    kind: 1,
    min_age_seconds: 0,
    client_family: 0,
    client_min_version: 0,
    deny_unknown: 1,
    reason_code: 1,
    incident_id: 0,
    expires_at: 0,
    expiry_audited_at: 0,
    disabled_at: 0,
    disabled_reason: 0,
    revision: 1,
    created_at: 1,
    updated_at: 1,
  },
  registry_policy_version: { org_id: 1, rule_id: 1, version_normalized: 1 },
};
const types: { [T in Table]: Record<keyof Columns<T>, 'TEXT' | 'INTEGER'> } = {
  registry_policy_rule: {
    id: 'TEXT',
    org_id: 'TEXT',
    project_id: 'TEXT',
    ecosystem: 'TEXT',
    package_key: 'TEXT',
    kind: 'TEXT',
    min_age_seconds: 'INTEGER',
    client_family: 'TEXT',
    client_min_version: 'TEXT',
    deny_unknown: 'INTEGER',
    reason_code: 'TEXT',
    incident_id: 'TEXT',
    expires_at: 'TEXT',
    expiry_audited_at: 'TEXT',
    disabled_at: 'TEXT',
    disabled_reason: 'TEXT',
    revision: 'INTEGER',
    created_at: 'TEXT',
    updated_at: 'TEXT',
  },
  registry_policy_version: { org_id: 'TEXT', rule_id: 'TEXT', version_normalized: 'TEXT' },
};
let database: MigratedDatabase;
beforeAll(async () => {
  database = await openMigratedDatabase();
});
afterAll(async () => {
  await database.close();
});
describe('registry policy schema types', () => {
  for (const table of Object.keys(declared) as Table[]) {
    it(`${table}: columns, SQL types and nullability match the migrated schema`, async () => {
      const rows = await database.executor.all<{ name: string; notnull: number; type: string }>({
        sql: `SELECT name, "notnull", type FROM pragma_table_info('${table}')`,
        params: [],
      });
      expect(Object.fromEntries(rows.map((row) => [row.name, row.notnull]))).toEqual(
        declared[table],
      );
      expect(Object.fromEntries(rows.map((row) => [row.name, row.type]))).toEqual(types[table]);
    });
  }
});
