import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Selectable } from 'kysely';
import type { Database } from './schema.js';
import { openMigratedDatabase, type MigratedDatabase } from './testing/migrated-database.js';

type Table = 'publish_approval' | 'package_access_request' | 'version_readme';
type Columns<T extends Table> = {
  [K in keyof Selectable<Database[T]>]: null extends Selectable<Database[T]>[K] ? 0 : 1;
};
const declared: { [T in Table]: Columns<T> } = {
  publish_approval: {
    id: 1,
    org_id: 1,
    package_id: 1,
    version_id: 1,
    source_id: 1,
    hold_approval: 1,
    hold_scan: 1,
    approval_state: 1,
    scan_state: 1,
    required_scanners_json: 1,
    scan_attempts: 1,
    requested_by_type: 1,
    requested_by_id: 1,
    token_id: 1,
    route_project_id: 0,
    dist_tags_json: 1,
    readme_pending: 1,
    decided_by_user_id: 0,
    decided_at: 0,
    decision_reason: 0,
    scan_verdict_json: 1,
    expires_at: 1,
    revision: 1,
    created_at: 1,
    updated_at: 1,
  },
  package_access_request: {
    id: 1,
    org_id: 1,
    package_id: 1,
    project_id: 1,
    state: 1,
    requested_by_user_id: 1,
    reason: 0,
    decided_by_user_id: 0,
    decided_at: 0,
    decision_reason: 0,
    expires_at: 1,
    revision: 1,
    created_at: 1,
    updated_at: 1,
  },
  version_readme: { version_id: 1, org_id: 1, filename: 1, body: 1, created_at: 1 },
};
let database: MigratedDatabase;
beforeAll(async () => {
  database = await openMigratedDatabase();
});
afterAll(async () => {
  await database.close();
});
describe('npm publish schema types', () => {
  for (const table of Object.keys(declared) as Table[]) {
    it(`${table}: columns and nullability match the migrated schema`, async () => {
      const rows = await database.executor.all<{ name: string; notnull: number }>({
        sql: `SELECT name, "notnull" FROM pragma_table_info('${table}')`,
        params: [],
      });
      expect(Object.fromEntries(rows.map((row) => [row.name, row.notnull]))).toEqual(
        declared[table],
      );
    });
  }
});
