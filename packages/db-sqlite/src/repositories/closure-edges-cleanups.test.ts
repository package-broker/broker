import { describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { orgContext } from '@package-broker/core/db/port';
import {
  seedCatalogue,
  seedDerivedRows,
  type CatalogueConfig,
} from '../testing/catalogue-fixture.js';
import { openMigratedDatabase } from '../testing/migrated-database.js';
import { createClosureEdges } from './closure-edges.js';
import { createCatalogueList } from './catalogue-list.js';
import * as predicates from './catalogue-predicates.js';

const ctx = orgContext('org');
const query = { projectId: 'project', ecosystem: 'composer' as const };
const config: CatalogueConfig = {
  organizations: [{ id: 'org', slug: 'org', name: 'Org' }],
  projects: [{ id: 'project', orgId: 'org', slug: 'project', name: 'Project', status: 'active' }],
  sources: [
    {
      id: 'source',
      orgId: 'org',
      projectId: null,
      name: 'Source',
      ecosystem: 'composer',
      type: 'vcs',
      defaultVisible: 1,
      removalPolicy: 'flag',
    },
  ],
  attachments: [{ orgId: 'org', projectId: 'project', sourceId: 'source', precedence: 1 }],
  packages: [
    {
      id: 'package',
      orgId: 'org',
      sourceId: 'source',
      ecosystem: 'composer',
      key: 'vendor/pkg',
      visible: 1,
      status: 'active',
    },
  ],
  versions: [
    {
      id: 'version',
      orgId: 'org',
      packageId: 'package',
      version: '1.0.0',
      normalized: '1.0.0.0',
      stability: 'stable',
      status: 'active',
      publishedAt: '2026-01-01T00:00:00.000Z',
    },
  ],
  patterns: [],
  explicit: [],
  registeredNames: [],
};

async function fixture(input = config) {
  const database = await openMigratedDatabase({ d1PatternLimit: true });
  await seedCatalogue(database.executor, input);
  await seedDerivedRows(database.executor, input);
  return database;
}

describe('T740 closure cleanups', () => {
  it('round-trips lone surrogates in both classification methods', async () => {
    const database = await fixture();
    try {
      const closure = createClosureEdges(database.executor);
      const keys = ['\ud800', '\udfff', 'vendor/pkg', '\ud800'];
      expect((await closure.classify(ctx, { ...query, keys })).map((row) => row.key)).toEqual(keys);
      expect(
        (await closure.classifyWinners(ctx, { ...query, keys })).map((row) => row.key),
      ).toEqual(keys);
    } finally {
      await database.close();
    }
  });

  it.each(['plain text', 42, true, false, null])(
    'ignores scalar Composer require %j without throwing',
    async (require) => {
      const database = await fixture();
      try {
        await database.executor.all({
          sql: 'UPDATE version SET metadata_json = ? WHERE id = ?',
          params: [JSON.stringify({ require }), 'version'],
        });
        const page = await createClosureEdges(database.executor).pageEdges(ctx, {
          ...query,
          limit: 10,
        });
        expect(page.rows).toHaveLength(1);
        expect(page.rows[0]?.deps).toBeNull();
      } finally {
        await database.close();
      }
    },
  );

  it('does not mark a key hidden by pattern attachable', async () => {
    const database = await fixture({
      ...config,
      patterns: [
        {
          id: 'pattern',
          orgId: 'org',
          projectId: 'project',
          sourceId: 'source',
          pattern: 'vendor/*',
          effect: 'exclude',
        },
      ],
    });
    try {
      expect(
        await createClosureEdges(database.executor).classify(ctx, {
          ...query,
          keys: ['vendor/pkg'],
        }),
      ).toEqual([{ key: 'vendor/pkg', class: 'not_available' }]);
    } finally {
      await database.close();
    }
  });

  it('does not mark a key hidden from new projects attachable', async () => {
    const database = await fixture({
      ...config,
      attachments: [],
      packages: config.packages.map((p) => ({ ...p, visible: 0 })),
    });
    try {
      expect(
        await createClosureEdges(database.executor).classify(ctx, {
          ...query,
          keys: ['vendor/pkg'],
        }),
      ).toEqual([{ key: 'vendor/pkg', class: 'not_available' }]);
    } finally {
      await database.close();
    }
  });

  it('uses the same visibility predicate for listing and closure winners', async () => {
    const database = await fixture();
    try {
      expect(
        (await createCatalogueList(database.executor).listVisible(ctx, { ...query, limit: 10 }))
          .items,
      ).toHaveLength(1);
      const guard = vi.spyOn(predicates, 'visibleRowsCondition').mockReturnValue(sql`0 = 1`);
      try {
        expect(
          (await createCatalogueList(database.executor).listVisible(ctx, { ...query, limit: 10 }))
            .items,
        ).toEqual([]);
        expect(
          await createClosureEdges(database.executor).classifyWinners(ctx, {
            ...query,
            keys: ['vendor/pkg'],
          }),
        ).toEqual([{ key: 'vendor/pkg', winner: null }]);
        expect(
          (await createClosureEdges(database.executor).pageEdges(ctx, { ...query, limit: 10 }))
            .rows,
        ).toEqual([]);
      } finally {
        guard.mockRestore();
      }
    } finally {
      await database.close();
    }
  });
});
