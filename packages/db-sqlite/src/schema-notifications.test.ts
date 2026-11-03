import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Selectable } from 'kysely';
import type { Database } from './schema.js';
import { openMigratedDatabase, type MigratedDatabase } from './testing/migrated-database.js';

type Table =
  'notification_endpoint' | 'notification_event' | 'notification_delivery' | 'notification_attempt';
type Columns<T extends Table> = {
  [K in keyof Selectable<Database[T]>]: null extends Selectable<Database[T]>[K] ? 0 : 1;
};
const declared: { [T in Table]: Columns<T> } = {
  notification_endpoint: {
    org_id: 1,
    project_id: 1,
    id: 1,
    name: 1,
    method: 1,
    events_json: 1,
    package_pattern: 1,
    credential_id: 1,
    headers_configured: 1,
    template_configured: 1,
    revision: 1,
    state: 1,
    disabled_reason: 0,
    failure_streak: 1,
    last_op_id: 0,
    created_at: 1,
    updated_at: 1,
  },
  notification_event: {
    org_id: 1,
    project_id: 1,
    id: 1,
    operation_id: 1,
    ordinal: 1,
    event_type: 1,
    source_id: 1,
    package_key: 1,
    payload_json: 1,
    occurred_at: 1,
    dispatched_at: 0,
    dispatch_generation: 1,
  },
  notification_delivery: {
    org_id: 1,
    project_id: 1,
    id: 1,
    event_id: 1,
    endpoint_id: 1,
    endpoint_revision: 1,
    configuration_credential_id: 1,
    body_credential_id: 0,
    state: 1,
    attempts: 1,
    job_generation: 1,
    active_job_id: 0,
    active_fence: 0,
    revision: 1,
    next_attempt_at: 1,
    expires_at: 1,
    last_status: 0,
    outcome_code: 0,
    created_at: 1,
    finished_at: 0,
  },
  notification_attempt: {
    org_id: 1,
    project_id: 1,
    delivery_id: 1,
    attempt: 1,
    job_id: 1,
    fence: 1,
    outcome: 1,
    outcome_code: 0,
    status: 0,
    duration_ms: 0,
    started_at: 1,
    finished_at: 0,
  },
};

let database: MigratedDatabase;
beforeAll(async () => {
  database = await openMigratedDatabase();
});
afterAll(async () => {
  await database.close();
});

describe('notification table types', () => {
  it.each(Object.keys(declared) as Table[])(
    '%s matches the migrated columns and nullability',
    async (table) => {
      const columns = await database.executor.all<{ name: string; notnull: number }>({
        sql: `SELECT name, "notnull" FROM pragma_table_info('${table}') ORDER BY cid`,
        params: [],
      });
      expect(Object.fromEntries(columns.map((column) => [column.name, column.notnull]))).toEqual(
        declared[table],
      );
    },
  );
});
