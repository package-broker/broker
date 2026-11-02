import type { ScalarSqlExecutor } from '@package-broker/core/db/port';

const TABLES = ['registry_policy_rule', 'registry_policy_version'] as const;

/** Whether the registry policy migration has been applied; enabled policy must not serve without it. */
export async function registryPolicySchemaReady(executor: ScalarSqlExecutor): Promise<boolean> {
  const rows = await executor.all<{ name: string }>({
    sql: `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${TABLES.map(() => '?').join(', ')})`,
    params: [...TABLES],
  });
  const found = new Set(rows.map((row) => row.name));
  return TABLES.every((table) => found.has(table));
}
