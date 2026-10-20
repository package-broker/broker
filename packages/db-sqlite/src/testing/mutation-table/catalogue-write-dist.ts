import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { expect } from 'vitest';
import { createCatalogueWriteGuard } from '../../repositories/catalogue-write-package.js';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { distAttachStatements } from '../../repositories/catalogue-write-dist.js';
import {
  seedSource,
  seedPackage,
  seedVersion,
  HASH,
  WRITE_GUARD,
  guardPasses,
  ref,
  NOT_NULL,
  WRITE_ORG,
  writeGuard,
  REVISION_CLOCK,
} from './fixtures.js';

type DistProbe =
  | 'blob assignment'
  | 'blob eligibility'
  | 'blob postcondition'
  | 'version update'
  | 'version postcondition'
  | 'package advance';

function distProbe(probe: DistProbe): ContractCase {
  return {
    name: `dist attach scopes the ${probe} to its organization`,
    async run(context) {
      const seed = seeder(context.executor);
      const { own, foreign } = orgOf(context);
      await seedSource(seed, 'S-DIST', own.orgId, 'npm_registry', 'npm');
      await seedPackage(
        seed.forged,
        'K-DIST',
        probe === 'package advance' ? foreign.orgId : own.orgId,
        'S-DIST',
        'widget',
        'npm',
      );
      await seedVersion(
        seed.forged,
        'V-DIST',
        probe.startsWith('version') ? foreign.orgId : own.orgId,
        'K-DIST',
        '1.0.0',
      );
      await seed(
        'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
        'B-FOREIGN',
        foreign.orgId,
        HASH,
        'foreign',
      );
      if (probe !== 'blob eligibility' && probe !== 'blob postcondition') {
        await seed(
          'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
          'B-OWN',
          own.orgId,
          HASH,
          'own',
        );
      }
      const guard = createCatalogueWriteGuard(own, WRITE_GUARD);
      const plan = distAttachStatements(own, guard, {
        versionId: 'V-DIST',
        revision: 1,
        sha256: HASH as Sha256,
      });
      const statements = plan.statements.slice(guard.length);
      if (probe.endsWith('postcondition')) {
        await seed(
          'UPDATE version SET blob_id = ? WHERE id = ?',
          probe === 'blob postcondition' ? 'B-FOREIGN' : 'B-OWN',
          'V-DIST',
        );
        expect(await guardPasses(context, statements.slice(1, 2), true)).toBe(false);
      } else if (probe === 'package advance') {
        await seed('UPDATE version SET last_op_id = ? WHERE id = ?', plan.opId, 'V-DIST');
        const before = await context.executor.all({ sql: 'SELECT * FROM package', params: [] });
        await context.executor.batch(statements.slice(2).map(context.mutate));
        expect(await context.executor.all({ sql: 'SELECT * FROM package', params: [] })).toEqual(
          before,
        );
      } else {
        const [result] = await context.executor.batch(statements.slice(0, 1).map(context.mutate));
        if (probe === 'blob assignment') {
          expect(result?.changes).toBe(1);
          expect(
            await context.executor.all({
              sql: 'SELECT blob_id FROM version WHERE id = ?',
              params: ['V-DIST'],
            }),
          ).toEqual([{ blob_id: 'B-OWN' }]);
        } else {
          expect(result?.changes).toBe(0);
        }
      }
    },
  };
}

const distAttachEntry: MutationEntry = {
  builder: 'distAttachStatements',
  file: 'repositories/catalogue-write-dist.ts',
  cases: (
    [
      'blob assignment',
      'blob eligibility',
      'blob postcondition',
      'version update',
      'version postcondition',
      'package advance',
    ] as const
  ).map(distProbe),
  predicates: [
    ...(['blob assignment', 'blob eligibility', 'blob postcondition'] as const).map((probe) => ({
      name: probe,
      locate:
        probe === 'blob assignment'
          ? /(?<=set "blob_id" = \(SELECT blob.id FROM blob\s+WHERE )blob.org_id = \?/
          : probe === 'blob eligibility'
            ? /(?<=and \(SELECT blob.id FROM blob\s+WHERE )blob.org_id = \?/
            : ref('blob', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: distProbe(probe).name,
      copies: 1,
    })),
    ...(['version update', 'version postcondition'] as const).map((probe) => ({
      name: probe,
      locate: ref('version', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: distProbe(probe).name,
      copies: 1,
    })),
    {
      name: 'package advance',
      locate: ref('package', 'org_id', '\\?'),
      neutral: NOT_NULL,
      caseName: distProbe('package advance').name,
      copies: 1,
    },
  ],
  decisions: [
    {
      name: 'dist attach makes two clock reads including the job guard',
      pattern: /(?:strftime\('[^']*',\s*'now'(?:, '[^']*')?\)|unixepoch\('now'(?:, '[^']*')?\))/,
      expected: 2,
      build: () =>
        distAttachStatements(WRITE_ORG, writeGuard(), {
          versionId: 'V-DIST',
          revision: 1,
          sha256: HASH as Sha256,
        }).statements,
    },
    {
      name: 'dist attach reads the revision clock once',
      pattern: REVISION_CLOCK,
      expected: 1,
      build: () =>
        distAttachStatements(WRITE_ORG, writeGuard(), {
          versionId: 'V-DIST',
          revision: 1,
          sha256: HASH as Sha256,
        }).statements,
    },
  ],
};

export const entries: readonly MutationEntry[] = [distAttachEntry];
