import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import {
  createIdempotencyRepository,
  idempotencyInsertStatement,
} from '@package-broker/db-sqlite/repositories/idempotency';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['IDEMPOTENCY'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function loadSources(): Promise<MigrationSource[]> {
  return Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
}

const NOW = '2026-10-18T12:00:00.000Z';
const EXPIRY = '2026-10-19T12:00:00.000Z';
const AFTER = '2026-10-19T12:00:00.001Z';
const record: IdempotencyRecord = {
  principalKey: 'user:alice',
  key: 'create-project',
  route: 'POST /api/projects',
  requestHash: 'ab'.repeat(32),
  status: 201,
  responseJson: '{"id":"first"}',
  createdAt: NOW,
  expiresAt: EXPIRY,
};

let executor: SqlExecutor;
let a: OrgContext;

beforeAll(async () => {
  executor = createD1Executor((await mf.getD1Database('IDEMPOTENCY')) as unknown as D1DatabaseLike);
  await migrate(executor, await loadSources(), { holder: 'idempotency-test' });
  ({ a } = await seedTwoOrganizations(executor));
});

describe('D1 idempotency insert', () => {
  it('inserts a first record, refuses a live key and replaces an expired one', async () => {
    const repo = createIdempotencyRepository(
      executor as Parameters<typeof createIdempotencyRepository>[0],
    );
    await executor.batch([idempotencyInsertStatement(a, record)]);
    expect(await repo.find(a, record.principalKey, record.key, NOW)).toEqual(record);

    const live = executor.batch([
      idempotencyInsertStatement(a, { ...record, responseJson: '{"id":"live"}' }),
    ]);
    await expect(live).rejects.toBeInstanceOf(DbError);
    await expect(live).rejects.toMatchObject({ kind: 'unique' });
    expect(await repo.find(a, record.principalKey, record.key, NOW)).toEqual(record);

    const replacement = {
      ...record,
      responseJson: '{"id":"replacement"}',
      createdAt: AFTER,
      expiresAt: '2026-10-20T12:00:00.001Z',
    };
    await executor.batch([idempotencyInsertStatement(a, replacement)]);
    expect(await repo.find(a, record.principalKey, record.key, AFTER)).toEqual(replacement);
  });
  it('replaces an expired row at the exact expiry instant and honors the extra condition', async () => {
    const repo = createIdempotencyRepository(
      executor as Parameters<typeof createIdempotencyRepository>[0],
    );
    const base = { ...record, key: 'boundary' };
    await executor.batch([idempotencyInsertStatement(a, base)]);
    const next = {
      ...base,
      responseJson: '{"id":"next"}',
      createdAt: EXPIRY,
      expiresAt: '2026-10-21T12:00:00.000Z',
    };
    await executor.batch([
      idempotencyInsertStatement(a, next, false, { sql: '(1 = 0)', params: [] }),
    ]);
    expect(await repo.find(a, base.principalKey, base.key, NOW)).toEqual(base);
    await executor.batch([
      idempotencyInsertStatement(a, next, false, { sql: '(1 = 1)', params: [] }),
    ]);
    expect(await repo.find(a, base.principalKey, base.key, EXPIRY)).toEqual(next);
    const early = executor.batch([
      idempotencyInsertStatement(a, { ...next, createdAt: '2026-10-21T11:59:59.999Z' }),
    ]);
    await expect(early).rejects.toMatchObject({ kind: 'unique' });
  });
});
