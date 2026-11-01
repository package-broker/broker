import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import type { ProjectActor } from '@package-broker/core/authz/project-actor';
import { createPackageAccess } from '@package-broker/core/catalogue/package-access';
import { orgContext, type SqlExecutor, type SqlValue } from '@package-broker/core/db/port';
import { renderComposerP2 } from '@package-broker/core/registry/composer/render';
import { renderPackument } from '@package-broker/core/registry/npm/render';
import { migrate, MigrationOrderError } from '../migrations/runner.js';
import { loadMigrationSource } from '../migrations/source.js';
import { createCatalogueReader } from '../repositories/catalogue.js';
import { createRepresentationClock } from '../repositories/representation-clock.js';
import { discoveredMigrations, openMigratedDatabase } from '../testing/migrated-database.js';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
import { countCalls } from './count-calls.js';

const ctx = orgContext('performance-org');
const packageName = (ecosystem: 'npm' | 'composer') =>
  ecosystem === 'npm' ? '@acme/large' : 'acme/large';
const NOW = '2026-10-16T09:00:00.000Z';
const VERSIONS = 4000;
const actor: ProjectActor = {
  kind: 'project',
  userId: 'performance-user',
  orgId: ctx.orgId,
  projectId: 'performance-project',
  permissions: new Set(['project:packages:read']),
};

async function seed(executor: SqlExecutor, ecosystem: 'npm' | 'composer'): Promise<void> {
  const run = (sql: string, params: readonly SqlValue[]) => executor.all({ sql, params });
  await run('INSERT INTO organization (id, slug, name) VALUES (?, ?, ?)', [
    ctx.orgId,
    'perf',
    'Perf',
  ]);
  await run('INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)', [
    actor.projectId,
    ctx.orgId,
    'perf',
    'Perf',
  ]);
  await run(
    "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'source', ?, 'hosted')",
    [ctx.orgId, ecosystem],
  );
  await run("INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, 'source')", [
    ctx.orgId,
    actor.projectId,
  ]);
  await run(
    "INSERT INTO package (id, org_id, source_id, ecosystem, name, last_synced_at) VALUES ('package', ?, 'source', ?, ?, ?)",
    [ctx.orgId, ecosystem, packageName(ecosystem), NOW],
  );
  await run(
    "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) VALUES (?, ?, 'package', 'subscription', ?, ?)",
    [ctx.orgId, actor.projectId, ecosystem, packageName(ecosystem)],
  );
  for (let index = 0; index < VERSIONS; index++) {
    const metadata = {
      name: packageName(ecosystem),
      type: 'metapackage',
      description: `${index}:`,
    };
    metadata.description += 'x'.repeat(2048 - JSON.stringify(metadata).length);
    const json = JSON.stringify(metadata);
    expect(Buffer.byteLength(json)).toBe(2048);
    await run(
      `INSERT INTO version (id, org_id, package_id, version, version_normalized,
      published_at, published_at_basis, metadata_json)
      VALUES (?, ?, 'package', ?, ?, ?, 'import_time', ?)`,
      [
        `version-${String(index).padStart(4, '0')}`,
        ctx.orgId,
        `1.0.${index}`,
        `1.0.${index}`,
        NOW,
        json,
      ],
    );
  }
}

describe('large registry package on node:sqlite', () => {
  it.each(
    (['npm', 'composer'] as const).flatMap((ecosystem) => [
      {
        ecosystem,
        initialised: true,
        budget: 21,
        reason: 'with an initialised representation clock',
      },
      {
        ecosystem,
        initialised: false,
        budget: 22,
        reason: 'on the first cold render, allowing one extra clock initialisation batch',
      },
    ]),
  )(
    '$ecosystem renders 4,000 versions in at most $budget calls $reason',
    async ({ ecosystem, initialised, budget, reason }) => {
      const database = await openMigratedDatabase();
      try {
        await seed(database.executor, ecosystem);
        const counted = countCalls(database.executor);
        const access = createPackageAccess(createCatalogueReader(counted.executor));
        const options = {
          requestId: 'performance-request',
          access,
          actor,
          projectSlug: 'perf',
          name: packageName(ecosystem),
          publicUrl: 'https://broker.invalid',
        };
        const clock = createRepresentationClock(counted.executor);
        const render = () =>
          ecosystem === 'npm'
            ? renderPackument(options)
            : renderComposerP2({
                ...options,
                request: new Request('https://broker.invalid/perf/p2/acme/large.json'),
                clock,
              });
        if (initialised) {
          const setup = await render();
          expect(setup.status).toBe(200);
          await setup.text();
        }
        const baseline = counted.counts();
        global.gc?.();
        const before = process.memoryUsage().heapUsed;
        const started = performance.now();
        const response = await render();
        expect(response.status).toBe(200);
        const body = await response.text();
        global.gc?.();
        const growth = process.memoryUsage().heapUsed - before;
        const elapsed = performance.now() - started;
        const calls = counted.counts();
        const totalCalls = calls.all + calls.batch - baseline.all - baseline.batch;
        console.info(
          `${ecosystem} ${reason}: calls=${totalCalls}, wall=${elapsed.toFixed(1)}ms, retained heap=${global.gc ? `${growth} bytes` : 'NOT RUN (global.gc unavailable; use --expose-gc)'}`,
        );
        if (global.gc) expect(growth).toBeLessThan(48 * 1024 * 1024);
        const document = JSON.parse(body) as {
          versions?: Record<string, unknown>;
          packages?: Record<string, unknown[]>;
        };
        expect(
          ecosystem === 'npm'
            ? Object.keys(document.versions ?? {}).length
            : document.packages?.['acme/large']?.length,
        ).toBe(VERSIONS);
        expect(totalCalls).toBeLessThanOrEqual(budget);
      } finally {
        await database.close();
      }
    },
  );
});

describe('release migration contract', () => {
  it('ships contiguous core migrations', async () => {
    const core = (await discoveredMigrations()).filter((source) => source.owner === 'core');
    expect(core.length).toBe(6);
    expect(core.map((source) => source.sequence)).toEqual(core.map((_, index) => index + 1));
  });

  it('refuses a pending core migration below the highest already applied sequence', async () => {
    const [init] = await discoveredMigrations();
    if (init === undefined) throw new Error('missing init migration');
    const earlier = await loadMigrationSource(
      'core',
      '0010_earlier.sql',
      'CREATE TABLE earlier (id TEXT);',
    );
    const later = await loadMigrationSource(
      'core',
      '0011_later.sql',
      'CREATE TABLE later (id TEXT);',
    );
    const opened = openNodeSqliteExecutor();
    try {
      await migrate(opened.executor, [init, later], { holder: 'out-of-order' });
      await expect(
        migrate(opened.executor, [init, earlier, later], { holder: 'out-of-order' }),
      ).rejects.toBeInstanceOf(MigrationOrderError);
      expect(
        await opened.executor.all({
          sql: "SELECT name FROM sqlite_schema WHERE name = 'earlier'",
          params: [],
        }),
      ).toEqual([]);
      expect(
        await opened.executor.all({
          sql: 'SELECT id FROM schema_migration ORDER BY id',
          params: [],
        }),
      ).toEqual([{ id: init.id }, { id: later.id }]);
    } finally {
      await opened.close();
    }
  });
});
