import { expect } from 'vitest';
import {
  versionStatusStatements,
  conditionalEpochBumpStatement,
} from '../../internal/catalogue-status-statements.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, ref, seedPackage, seedSource, seedVersion } from './fixtures.js';

function statusCase(layer: 'revision' | 'version' | 'package'): ContractCase {
  return {
    name: `versionStatusStatements rejects a foreign ${layer}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', own.orgId, 'vcs');
      await seedPackage(seed, 'K', layer === 'package' ? foreign.orgId : own.orgId, 'S', 'acme/a');
      await seedVersion(seed, 'V', layer === 'package' ? own.orgId : foreign.orgId, 'K', '1.0.0');
      const plan = versionStatusStatements(own, {
        versionId: 'V',
        to: 'quarantined',
        reason: 'digest_mismatch',
      });
      if (layer === 'version') {
        // Supply the before-image marker to isolate the update's own organization check.
        await seed(
          "INSERT INTO version_revision (id, org_id, version_id, revision, metadata_json, reason, op_id) VALUES ('R', ?, 'V', 1, '{}', 'status:active:quarantined:digest_mismatch', ?)",
          foreign.orgId,
          plan.opId,
        );
      }
      await context.executor.batch(
        context.mutateBatch(layer === 'version' ? plan.statements.slice(1) : plan.statements),
      );
      if (layer === 'revision')
        expect(
          await context.executor.all({
            sql: "SELECT id FROM version_revision WHERE version_id = 'V'",
            params: [],
          }),
        ).toEqual([]);
      if (layer === 'version')
        expect(
          await context.executor.all({
            sql: "SELECT status, revision FROM version WHERE id = 'V'",
            params: [],
          }),
        ).toEqual([{ status: 'active', revision: 1 }]);
      if (layer === 'package')
        expect(
          await context.executor.all({ sql: "SELECT rev FROM package WHERE id = 'K'", params: [] }),
        ).toEqual([{ rev: 1 }]);
    },
  };
}
function epochCase(layer: 'epoch' | 'version'): ContractCase {
  return {
    name: `conditionalEpochBumpStatement rejects a foreign ${layer}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', own.orgId, 'vcs');
      await seedPackage(seed, 'K', own.orgId, 'S', 'acme/a');
      await seedVersion(seed, 'V', layer === 'version' ? foreign.orgId : own.orgId, 'K', '1.0.0');
      await seed("UPDATE version SET last_op_id = 'op' WHERE id = 'V'");
      for (const org of [own, foreign])
        await seed("UPDATE cache_epoch SET version = 'before' WHERE org_id = ?", org.orgId);
      await context.executor.batch([context.mutate(conditionalEpochBumpStatement(own, 'V', 'op'))]);
      expect(
        await context.executor.all({
          sql: 'SELECT org_id, version FROM cache_epoch ORDER BY org_id',
          params: [],
        }),
      ).toEqual([
        {
          org_id: own.orgId,
          version: layer === 'epoch' ? expect.not.stringMatching(/^before$/) : 'before',
        },
        { org_id: foreign.orgId, version: 'before' },
      ]);
    },
  };
}
export const entries: readonly MutationEntry[] = [
  {
    file: 'internal/catalogue-status-statements.ts',
    builder: 'versionStatusStatements',
    cases: (['revision', 'version', 'package'] as const).map(statusCase),
    predicates: [
      {
        name: 'before-image version belongs to the organization',
        locate: ref('version', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 2,
        waivedCopies: {
          1: `the version update occurrence is killed by "${statusCase('version').name}"`,
        },
        caseName: statusCase('revision').name,
      },
      {
        name: 'updated version belongs to the organization',
        locate: ref('version', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: statusCase('version').name,
      },
      {
        name: 'advanced package belongs to the organization',
        locate: ref('package', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: statusCase('package').name,
      },
    ],
  },
  {
    file: 'internal/catalogue-status-statements.ts',
    builder: 'conditionalEpochBumpStatement',
    cases: [epochCase('epoch'), epochCase('version')],
    predicates: (['epoch', 'version'] as const).map((layer) => ({
      name: `${layer} belongs to the organization`,
      locate: ref(layer === 'epoch' ? 'cache_epoch' : 'version', 'org_id', '\\?'),
      neutral: NOT_NULL,
      copies: 1,
      caseName: epochCase(layer).name,
    })),
  },
];
