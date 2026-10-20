import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import {
  describeRegistryContract,
  registryContractCases,
  type RegistryContractFixture,
} from './registry-contract.js';

const open = async (): Promise<RegistryContractFixture> =>
  openNodeSqliteExecutor(':memory:', { d1PatternLimit: true });
describeRegistryContract('node:sqlite', open);

it('fails when the executor fixture is missing', async () => {
  await expect(registryContractCases.sourceOwnership(async () => ({}) as never)).rejects.toThrow(
    /registry contract fixture/,
  );
});

it('detects removal of the source ownership predicate', async () => {
  let changed = 0;
  const weaken = (executor: SqlExecutor): SqlExecutor => ({
    ...executor,
    all(statement) {
      if (statement.sql.includes('from "source"') && statement.sql.includes('"org_id" = ?')) {
        changed += 1;
        return executor.all({
          ...statement,
          sql: statement.sql.replace('"org_id" = ?', '? is not null'),
        });
      }
      return executor.all(statement);
    },
  });
  await expect(registryContractCases.sourceOwnership(open, weaken)).rejects.toThrow(
    /expected.*to be null/s,
  );
  expect(changed).toBeGreaterThan(0);
});

it('publishes a test-only contract subpath', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, unknown> };
  expect(manifest.exports['./contract/registry-contract']).toEqual({
    types: './dist/contract/registry-contract.d.ts',
    default: './dist/contract/registry-contract.js',
  });
});
