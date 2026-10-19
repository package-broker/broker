import { describe, expect, it } from 'vitest';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import type { SyncPackageInput, VersionInput } from '@package-broker/core/db/catalogue';
import type { Statement } from '@package-broker/core/db/port';
import { registerCatalogueWriteGuard } from '../internal/catalogue-write-guard.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueWriter } from './catalogue-writer.js';

const statement = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const counts = [0, 1, 7, 49, 50];

describe('syncPackageCost', () => {
  it.each(['npm', 'composer'] as const)(
    'bounds insert and update execution for %s',
    async (ecosystem) => {
      const database = await openMigratedDatabase({ twoOrganizations: true });
      try {
        const ctx = database.orgs!.a;
        await database.executor.batch([
          statement(
            "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'main', ?, 'vcs')",
            ctx.orgId,
            ecosystem,
          ),
        ]);
        const writer = createCatalogueWriter(database.executor);
        for (const guardStatements of [1, 4]) {
          const guard = registerCatalogueWriteGuard(
            ctx,
            Array.from({ length: guardStatements }, () => statement('SELECT 1')),
          );
          for (const versions of counts) {
            for (const tags of [0, 1, 100]) {
              const shape = { versions, tags, guardStatements };
              const cost = writer.syncPackageCost(shape);
              const key =
                ecosystem === 'npm'
                  ? `widget-${versions}-${tags}-${guardStatements}`
                  : `acme/lib-${versions}-${tags}-${guardStatements}`;
              const inputs: VersionInput[] = Array.from({ length: versions }, (_, n) => ({
                version: `1.0.${n}`,
                versionNormalized: ecosystem === 'npm' ? `1.0.${n}` : `1.0.${n}.0`,
                license: null,
                distType: null,
                sourceRef: null,
                upstreamReleasedAt: null,
                history: { basis: 'release_date', at: '2020-01-01T00:00:00.000Z' },
                metadata: normalizeVersionMetadata(ecosystem, { name: key }),
              }));
              const request: SyncPackageInput = {
                sourceId: 'source',
                ecosystem,
                key,
                description: null,
                versions: inputs,
                ...(ecosystem === 'npm'
                  ? {
                      tags: Object.fromEntries(
                        Array.from({ length: tags }, (_, n) => [`tag${n}`, '1.0.0']),
                      ),
                    }
                  : {}),
              };
              // Composer has no dist-tags; its cost still conservatively bounds this shape.
              for (const updating of [false, true]) {
                const result = await writer.syncPackage(ctx, guard, {
                  ...request,
                  versions: inputs.map((input) => ({
                    ...input,
                    upstreamReleasedAt: updating ? '2020-01-02T00:00:00.000Z' : null,
                    metadata: normalizeVersionMetadata(ecosystem, {
                      name: key,
                      ...(updating && ecosystem === 'composer' ? { description: 'changed' } : {}),
                    }),
                  })),
                });
                expect(result.refused).toEqual([]);
                expect(result.statements).toBeLessThanOrEqual(cost);
                expect(updating ? result.updated + result.conflicts.length : result.inserted).toBe(
                  versions,
                );
              }
            }
          }
        }
        for (let versions = 0; versions <= 50; versions++) {
          for (let tags = 0; tags <= 100; tags++) {
            for (const guardStatements of [1, 4]) {
              const shape = { versions, tags, guardStatements };
              const cost = writer.syncPackageCost(shape);
              if (versions < 50)
                expect(
                  writer.syncPackageCost({ ...shape, versions: versions + 1 }),
                ).toBeGreaterThanOrEqual(cost);
              if (tags < 100)
                expect(writer.syncPackageCost({ ...shape, tags: tags + 1 })).toBeGreaterThanOrEqual(
                  cost,
                );
              expect(
                writer.syncPackageCost({ ...shape, guardStatements: guardStatements + 1 }),
              ).toBeGreaterThanOrEqual(cost);
            }
          }
        }
      } finally {
        await database.close();
      }
    },
  );

  it.each([
    { versions: 51, tags: 0 },
    { versions: 0, tags: 101 },
  ])('rejects an excessive shape: %j', (shape) => {
    const writer = createCatalogueWriter({
      driver: 'node-sqlite',
      all: async () => [],
      batch: async () => [],
    });
    expect(() => writer.syncPackageCost({ ...shape, guardStatements: 1 })).toThrow(RangeError);
  });
});
