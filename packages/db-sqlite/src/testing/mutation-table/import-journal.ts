import { expect } from 'vitest';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import {
  createImportJournalStore,
  IMPORT_VERIFICATION_JOB,
} from '../../repositories/import-journal.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { NOT_NULL } from './fixtures.js';

function storeFor(context: CaseContext, updateOnly = false) {
  return createImportJournalStore({
    executor: {
      driver: context.executor.driver,
      all: (s) => context.executor.all(context.mutate(s)),
      batch: (s) =>
        context.executor.batch(
          context.mutateBatch(
            updateOnly
              ? s.filter((statement) =>
                  statement.sql.startsWith("UPDATE import_run SET state = 'verified'"),
                )
              : s,
          ),
        ),
    },
    providerAnchors: [],
  });
}
const run: ContractCase = {
  name: 'a foreign apply run is absent',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seeder(context.executor)(
      "INSERT INTO import_run (id, org_id, source_system) VALUES ('foreign-run', ?, 'test')",
      foreign.orgId,
    );
    expect(await storeFor(context).loadRun(own, 'foreign-run')).toBeNull();
  },
};
const refs: ContractCase = {
  name: 'foreign journal refs are absent',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO import_run (id, org_id, source_system) VALUES ('foreign-run', ?, 'test')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action) VALUES ('ref', ?, 'foreign-run', 'project', 'entity', 'external', 'create')",
      foreign.orgId,
    );
    expect(await storeFor(context).appliedRefs(own, 'foreign-run')).toEqual([]);
  },
};
const refOwner: ContractCase = {
  name: 'an own journal row cannot expose a foreign run',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO import_run (id, org_id, source_system) VALUES ('foreign-run', ?, 'test')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action) VALUES ('ref', ?, 'foreign-run', 'project', 'entity', 'external', 'create')",
      own.orgId,
    );
    expect(await storeFor(context).appliedRefs(own, 'foreign-run')).toEqual([]);
  },
};
const role: ContractCase = {
  name: 'a foreign role key cannot supply permissions',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seeder(context.executor)(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('foreign-role', ?, 'foreign-role', 'Role', 'organization')",
      foreign.orgId,
    );
    expect(await storeFor(context).rolePermissions(own, 'foreign-role')).toBeNull();
  },
};
const permission: ContractCase = {
  name: 'a foreign permission row cannot extend an own role',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('own-role', ?, 'own-role', 'Role', 'organization')",
      own.orgId,
    );
    await seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'own-role', 'org:import:approve')",
      foreign.orgId,
    );
    expect(await storeFor(context).rolePermissions(own, 'own-role')).toEqual([]);
  },
};
const verify: ContractCase = {
  name: 'a verifier cannot verify a foreign run using an own job',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO import_run (id, org_id, source_system, state) VALUES ('foreign-run', ?, 'test', 'verifying')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES ('job', ?, ?, ?, ?, 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
      own.orgId,
      IMPORT_VERIFICATION_JOB.type,
      JSON.stringify(IMPORT_RUN_JOB.payload('foreign-run')),
      IMPORT_VERIFICATION_JOB.resourceKey('foreign-run'),
    );
    const fence = systemMutationFence('verifier', { id: 'job', owner: 'worker', fence: 1 }, {});
    expect(
      await storeFor(context).markVerified(own, fence, {
        runId: 'foreign-run',
        verifiedAt: '2026-10-19T00:00:00.000Z',
      }),
    ).toMatchObject({ ok: false });
  },
};
const verifyUpdate: ContractCase = {
  name: 'the verification update independently excludes a foreign run',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seeder(context.executor)(
      "INSERT INTO import_run (id, org_id, source_system, state) VALUES ('foreign-run', ?, 'test', 'verifying')",
      foreign.orgId,
    );
    const fence = systemMutationFence('verifier', { id: 'job', owner: 'worker', fence: 1 }, {});
    await storeFor(context, true).markVerified(own, fence, {
      runId: 'foreign-run',
      verifiedAt: '2026-10-19T00:00:00.000Z',
    });
    expect(
      await context.executor.all({
        sql: "SELECT state, before_image_expires_at FROM import_run WHERE org_id = ? AND id = 'foreign-run'",
        params: [foreign.orgId],
      }),
    ).toEqual([{ state: 'verifying', before_image_expires_at: null }]);
  },
};
function rollbackCase(mismatched: boolean): ContractCase {
  return {
    name: mismatched
      ? 'rollback images require matching run ownership'
      : 'foreign rollback images are absent',
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seed(
        "INSERT INTO import_run (id, org_id, source_system) VALUES ('foreign-run', ?, 'test')",
        foreign.orgId,
      );
      await seed(
        "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, before_image_json) VALUES ('ref', ?, 'foreign-run', 'version', 'entity', 'external', 'update', '{}')",
        mismatched ? own.orgId : foreign.orgId,
      );
      expect(await storeFor(context).rollbackRefs(own, 'foreign-run')).toEqual([]);
    },
  };
}
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createImportJournalStore',
    file: 'repositories/import-journal.ts',
    cases: [
      run,
      refs,
      refOwner,
      role,
      permission,
      verify,
      verifyUpdate,
      rollbackCase(false),
      rollbackCase(true),
    ],
    predicates: [
      {
        name: 'apply run reads are organization scoped',
        locate: /ijload\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: run.name,
      },
      {
        name: 'journal reads are organization scoped',
        locate: /ijref\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: refs.name,
      },
      {
        name: 'a journal ref and its run have the same organization',
        locate: /ijrun\.org_id = ijref\.org_id/,
        neutral: '1 = 1',
        caseName: refOwner.name,
      },
      {
        name: 'role key resolution is organization scoped',
        locate: /r\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: role.name,
      },
      {
        name: 'role permissions have the role organization',
        locate: /p\.org_id = r\.org_id/,
        neutral: '1 = 1',
        caseName: permission.name,
      },
      {
        name: 'verification checks the run organization',
        locate: /ijverified\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: verify.name,
      },
      {
        name: 'the verification update is organization scoped',
        locate: /(?<=WHERE )org_id = \?/,
        neutral: NOT_NULL,
        caseName: verifyUpdate.name,
      },
      {
        name: 'rollback reads are organization scoped',
        locate: /ijrollback\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: rollbackCase(false).name,
      },
      {
        name: 'rollback images and their run have the same organization',
        locate: /ijrollbackrun\.org_id = ijrollback\.org_id/,
        neutral: '1 = 1',
        caseName: rollbackCase(true).name,
      },
    ],
    waivers: [
      {
        locate: /job\.org_id = \?/,
        reason:
          'The shared jobLeaseGuard registration tests ownership of this same globally unique leased job.',
      },
      {
        locate: /(?<!\.)"org_id" = \?/,
        reason: 'assertGuard cache epoch predicate is registered by its shared builder',
      },
    ],
  },
];
