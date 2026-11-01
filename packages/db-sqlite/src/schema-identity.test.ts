import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Selectable } from 'kysely';
import type { Database } from './schema.js';
import { openMigratedDatabase, type MigratedDatabase } from './testing/migrated-database.js';

type Table = 'npm_login_session' | 'trusted_publisher' | 'oidc_replay';
type Columns<T extends Table> = {
  [K in keyof Selectable<Database[T]>]: null extends Selectable<Database[T]>[K] ? 0 : 1;
};
const declared: { [T in Table]: Columns<T> } = {
  npm_login_session: {
    id: 1,
    selector_hash: 1,
    done_hash: 1,
    org_id: 1,
    project_id: 1,
    state: 1,
    cli_hostname: 0,
    source_ip: 0,
    created_at: 1,
    expires_at: 1,
    user_id: 0,
    token_id: 0,
    token_ciphertext: 0,
    token_nonce: 0,
    token_key_version: 0,
    consumed_at: 0,
    delivering_at: 0,
  },
  trusted_publisher: {
    id: 1,
    org_id: 1,
    package_name: 1,
    repository_id: 1,
    repository_owner_id: 1,
    repository: 1,
    workflow: 1,
    environment: 1,
    ref_pattern: 0,
    service_principal_id: 1,
    created_by_user_id: 1,
    created_at: 1,
    disabled_at: 0,
    last_used_at: 0,
    revision: 1,
  },
  oidc_replay: { issuer: 1, jti: 1, org_id: 1, trusted_publisher_id: 1, expires_at: 1 },
};
let database: MigratedDatabase;
beforeAll(async () => {
  database = await openMigratedDatabase();
});
afterAll(async () => {
  await database.close();
});
describe('npm identity schema types', () => {
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

it('TokenTable documents 0003 and follows token ALTER order', () => {
  const source = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8');
  expect(source).toMatch(
    /\/\*\* Mirrors `token` in `migrations\/0001_init.sql` and `migrations\/0003_npm_identity.sql`. \*\//,
  );
  const token = source.split('export interface TokenTable {')[1]!.split('}')[0]!;
  expect(token.trimEnd()).toMatch(
    /last_op_id: string \| null;\n {2}trusted_publisher_id: string \| null;\n {2}package_name: string \| null;$/,
  );
});
