import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import type { SqlExecutor, Statement } from '@package-broker/core/db/port';
import { applyChunk, type ApplyDeps } from '@package-broker/core/ingest/apply-description';
import { INVOCATION_BUDGET } from '@package-broker/core/ingest/plan-chunk';
import type { IngestSessionHandle } from '@package-broker/core/ingest/session';
import {
  createPackageDescription,
  snapshotRef,
  type VersionCandidate,
} from '@package-broker/core/sources/provider';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createCatalogueWriter } from '@package-broker/db-sqlite/repositories/catalogue-writer';
import { createExistingVersionsReader } from '@package-broker/db-sqlite/repositories/existing-versions';
import { createIngestFinalizer } from '@package-broker/db-sqlite/repositories/ingest-finalize';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '@package-broker/db-sqlite/repositories/ingest-session';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const SOURCE = '01J0SRC0000000000000000S01';
const OWNER = '01J0WWWWWWWWWWWWWWWWWW0A01';
const KEY = 'acme/big';
const UPSTREAM = 200;
const STALE = 300;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['APPLY'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

function counting(executor: SqlExecutor): { executor: SqlExecutor; take(): number } {
  let count = 0;
  return {
    executor: {
      driver: executor.driver,
      all<R>(statement: Statement) {
        count += 1;
        return executor.all<R>(statement);
      },
      batch(statements) {
        count += statements.length;
        return executor.batch(statements);
      },
    },
    take() {
      const taken = count;
      count = 0;
      return taken;
    },
  };
}

const upstream = Array.from({ length: UPSTREAM }, (_, n) => `2.${Math.floor(n / 100)}.${n % 100}`);

function toVersion(candidate: VersionCandidate) {
  const parsed = JSON.parse(candidate.raw) as { version: string };
  return {
    version: parsed.version,
    versionNormalized: `${parsed.version}.0`,
    license: null,
    distType: 'zip' as const,
    sourceRef: null,
    upstreamReleasedAt: null,
    metadata: normalizeVersionMetadata('composer', parsed),
    history: { basis: 'release_date' as const, at: '2026-10-01T00:00:00.000Z' },
  };
}

describe('D1 ingest apply at the largest planned invocation', () => {
  it('applies full-budget chunks and finalizes the removal of stale versions', async () => {
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

    const counter = counting(executor);
    const deps: ApplyDeps = {
      writer: createCatalogueWriter(counter.executor),
      sessions: createIngestSessions(counter.executor),
      existing: createExistingVersionsReader(counter.executor),
      finalizer: createIngestFinalizer(counter.executor, { maxAbsenceShare: 1 }),
    };
    const acquired = await createIngestSessions(executor).acquire(
      org,
      { scope: 'package', sourceId: SOURCE, packageKey: KEY },
      OWNER,
      600,
    );
    if (acquired === 'held') throw new Error('session held');
    let session: IngestSessionHandle = acquired;
    const guard = createIngestSessionWriteGuard(org, session, {
      id: 'job-apply',
      owner: OWNER,
      fence: 1,
    });
    expect(guard).toHaveLength(2);
    const counts: number[] = [];
    const planned: number[] = [];
    let status = 'progress';
    for (let invocation = 0; invocation < 20 && status === 'progress'; invocation++) {
      const outcome = await applyChunk(org, deps, {
        session,
        guard,
        source: {
          id: SOURCE,
          key: KEY,
          type: 'composer_repository',
          ecosystem: 'composer',
          covered: true,
        },
        description: createPackageDescription({
          name: KEY,
          snapshot: snapshotRef('"d1-1"'),
          validators: {},
          members: (async function* () {
            for (const [ordinal, version] of upstream.entries()) {
              await Promise.resolve();
              yield {
                ordinal,
                version,
                form: 'composer-p2',
                raw: JSON.stringify({ name: KEY, version }),
              } satisfies VersionCandidate;
            }
          })(),
          documentsComplete: true,
        }),
        packageDescription: null,
        toVersion,
        validatorTtlSeconds: 300,
      });
      counts.push(counter.take());
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
        sql: 'SELECT status, count(*) AS n FROM version GROUP BY status ORDER BY status',
        params: [],
      }),
    ).toEqual([
      { status: 'active', n: UPSTREAM },
      { status: 'removed_upstream', n: STALE },
    ]);
  }, 120_000);
});
