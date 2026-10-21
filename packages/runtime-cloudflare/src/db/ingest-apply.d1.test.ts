import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { INVOCATION_BUDGET } from '@package-broker/core/ingest/plan-chunk';
import type { ApplyOutcome } from '@package-broker/core/ingest/apply-description';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const root = fileURLToPath(new URL('../../../..', import.meta.url));
const cliRequire = createRequire(join(root, 'packages/cli/package.json'));
const script = execFileSync(
  cliRequire.resolve('esbuild/bin/esbuild'),
  [
    join(root, 'fixtures/workers-ingest-apply.ts'),
    '--bundle',
    '--format=esm',
    '--platform=browser',
    `--alias:@package-broker/core=${root}/packages/core/src`,
    `--alias:@package-broker/db-sqlite=${root}/packages/db-sqlite/src`,
  ],
  { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
);

const SOURCE = '01J0SRC0000000000000000S01';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0A01';
const KEY = 'acme/big';
const UPSTREAM = 200;
const STALE = 300;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: '2026-10-01',
    d1Databases: ['APPLY'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

describe('D1 ingest apply at the largest planned invocation', () => {
  it('applies each full-budget chunk in one Worker request and finalizes stale versions', async () => {
    const require = createRequire(import.meta.url);
    const directory = join(
      dirname(require.resolve('@package-broker/db-sqlite/package.json')),
      'migrations',
    );
    const sources = await Promise.all(
      readdirSync(directory)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) =>
          loadMigrationSource('core', name, readFileSync(join(directory, name), 'utf8')),
        ),
    );
    const executor = createD1Executor(
      (await mf.getD1Database('APPLY')) as unknown as D1DatabaseLike,
    );
    await migrate(executor, sources, { holder: 'apply-test' });
    const { a: org } = await seedTwoOrganizations(executor);
    await executor.batch([
      {
        sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'main', 'composer', 'composer_repository')",
        params: [SOURCE, org.orgId],
      },
      {
        sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('pkg-big', ?, ?, 'composer', ?)",
        params: [org.orgId, SOURCE, KEY],
      },
      {
        sql: `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
          INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at,
            published_at_basis, metadata_json)
          SELECT 'stale-' || i, ?, 'pkg-big', '0.' || i || '.0', '0.' || i || '.0.0',
            '2020-01-01T00:00:00.000Z', 'release_date', '{}' FROM n`,
        params: [STALE, org.orgId],
      },
      {
        sql: `INSERT INTO job (id, org_id, type, state, lease_owner, lease_until, fence)
          VALUES ('job-apply', ?, 'core:package-sync:v1', 'running', ?,
            strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'), 1)`,
        params: [org.orgId, OWNER],
      },
    ]);

    const invoke = async (session?: IngestSessionHandle) => {
      const response = await mf.dispatchFetch('https://ingest.test', {
        method: 'POST',
        body: JSON.stringify({ org, session }),
      });
      expect(response.status).toBe(200);
      return response.json() as Promise<{
        session: IngestSessionHandle;
        outcome: ApplyOutcome;
        statements: number;
        guardLength: number;
      }>;
    };
    let { session } = await invoke();
    const counts: number[] = [];
    const planned: number[] = [];
    let status = 'progress';
    for (let invocation = 0; invocation < 20 && status === 'progress'; invocation++) {
      const { outcome, statements, guardLength } = await invoke(session);
      expect(guardLength).toBe(2);
      expect(statements).toBeLessThanOrEqual(outcome.planned);
      counts.push(statements);
      planned.push(outcome.planned);
      status = outcome.status;
      session = outcome.session;
    }

    expect(status).toBe('complete');
    expect(Math.max(...planned)).toBeGreaterThanOrEqual(INVOCATION_BUDGET - 5);
    expect(Math.max(...planned)).toBeLessThanOrEqual(INVOCATION_BUDGET);
    expect(Math.max(...counts)).toBeLessThanOrEqual(INVOCATION_BUDGET);
    expect(
      await executor.all({
        sql: 'SELECT status, count(*) AS n FROM version WHERE org_id = ? GROUP BY status ORDER BY status',
        params: [org.orgId],
      }),
    ).toEqual([
      { status: 'active', n: UPSTREAM },
      { status: 'removed_upstream', n: STALE },
    ]);
  }, 120_000);
});
