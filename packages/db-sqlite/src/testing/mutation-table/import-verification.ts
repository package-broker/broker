import { expect } from 'vitest';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import type { Manifest } from '@package-broker/core/import/manifest';
import { IMPORT_RUN_JOB, IMPORT_VERIFICATION_JOB } from '@package-broker/core/import/run-service';
import { createImportVerificationStore } from '../../repositories/import-verification.js';
import { hash } from '../../repositories/import-journal.js';
import { ROLLBACK_ENTITIES } from '../../repositories/import-rollback.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { NOT_NULL } from './fixtures.js';

async function fixture(context: CaseContext, updateOnly = false) {
  const { own, foreign } = orgOf(context);
  const seed = seeder(context.executor);
  await seed(
    "INSERT INTO import_run (id, org_id, source_system, state) VALUES ('run', ?, 'test', 'verifying')",
    own.orgId,
  );
  await seed(
    "INSERT INTO job (id, org_id, type, resource_key, payload_json, state, lease_owner, lease_until, fence) VALUES ('verify', ?, ?, ?, '{\"runId\":\"run\"}', 'running', 'worker', '2099-01-01T00:00:00.000Z', 1)",
    own.orgId,
    IMPORT_VERIFICATION_JOB.type,
    IMPORT_VERIFICATION_JOB.resourceKey('run'),
  );
  const store = createImportVerificationStore({
    executor: {
      driver: context.executor.driver,
      all: (s) => context.executor.all(context.mutate(s)),
      batch: (s) =>
        context.executor.batch(
          context.mutateBatch(
            updateOnly ? s.filter((s) => s.sql.startsWith('UPDATE import_run')) : s,
          ),
        ),
    },
    providerAnchors: [],
  });
  const fence = systemMutationFence('verifier', { id: 'verify', owner: 'worker', fence: 1 }, {});
  const input = { runId: 'run', now: new Date().toISOString(), reason: 'item_missing' as const };
  async function verify(type: string, entityId: string, item: unknown) {
    const entity = ROLLBACK_ENTITIES[type]!;
    const ids = entity.key.length === 1 ? [entityId] : entityId.split(':');
    const [row] = await context.executor.all<Record<string, string | number | null>>({
      sql: `SELECT * FROM ${entity.table} WHERE ${entity.key.map((c) => `${c} = ?`).join(' AND ')}`,
      params: ids,
    });
    if (row === undefined) throw new Error('missing fixture entity');
    const domain: Record<string, string | number | null | readonly string[]> = Object.fromEntries(
      entity.domain.map((c) => [c, row[c]!]),
    );
    if (type === 'source') domain.credential_id = null;
    if (type === 'role') domain.permissions = [];
    await seed(
      "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, content_hash, published_at_basis) VALUES ('ref', ?, 'run', ?, ?, 'item', 'create', ?, ?)",
      own.orgId,
      type,
      entityId,
      await hash(domain),
      type === 'version' ? 'source_release' : null,
    );
    await store.verify(own, fence, {
      ...input,
      manifest: { version: 1, source_system: 'test', items: [item], widening: [] } as Manifest,
    });
    return context.executor.all({
      sql: "SELECT state, last_error FROM import_run WHERE org_id = ? AND id = 'run'",
      params: [own.orgId],
    });
  }
  return { own, foreign, seed, store, fence, input, verify };
}
function isolated(
  name: string,
  setup: (
    f: Awaited<ReturnType<typeof fixture>>,
  ) => Promise<{ type: string; id: string; item: unknown }>,
  success = false,
): ContractCase {
  return {
    name,
    async run(context) {
      const f = await fixture(context);
      const target = await setup(f);
      expect(await f.verify(target.type, target.id, target.item)).toEqual([
        {
          state: success ? 'verified' : 'applied',
          last_error: success ? null : expect.any(String),
        },
      ]);
    },
  };
}
const entity = isolated('foreign entity cannot satisfy a journal item', async (f) => {
  await f.seed(
    "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'project', 'Project')",
    f.foreign.orgId,
  );
  return { type: 'project', id: 'project', item: { type: 'project', external_ref: 'item' } };
});
const project = isolated('foreign project cannot make an own source visible', async (f) => {
  await f.seed(
    "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'project', 'Project')",
    f.foreign.orgId,
  );
  await f.seed(
    "INSERT INTO source (id, org_id, name, ecosystem, type, project_id) VALUES ('source', ?, 'source', 'npm', 'npmjs_proxy', 'project')",
    f.own.orgId,
  );
  return {
    type: 'source',
    id: 'source',
    item: { type: 'source', external_ref: 'item', credential_ref: null },
  };
});
const role = isolated('foreign role cannot validate an own grant', async (f) => {
  await f.seed(
    "INSERT INTO role (id, org_id, key, name, scope) VALUES ('role', ?, 'role', 'Role', 'organization')",
    f.foreign.orgId,
  );
  await f.seed(
    "INSERT INTO access_grant (id, org_id, scope, role_id, subject_type, subject_value) VALUES ('grant', ?, 'organization', 'role', 'email', 'test@example.test')",
    f.own.orgId,
  );
  return { type: 'access_grant', id: 'grant', item: { type: 'grant', external_ref: 'item' } };
});
const source = isolated('foreign source cannot make an own name visible', async (f) => {
  await f.seed(
    "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'source', 'npm', 'npmjs_proxy')",
    f.foreign.orgId,
  );
  await f.seed(
    "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('name', ?, 'source', 'npm', 'pkg')",
    f.own.orgId,
  );
  return { type: 'registered_name', id: 'name', item: { type: 'name', external_ref: 'item' } };
});
const parent = isolated('source visibility cannot use a foreign parent project', async (f) => {
  await f.seed(
    "INSERT INTO project (id, org_id, slug, name) VALUES ('project', ?, 'project', 'Project')",
    f.foreign.orgId,
  );
  await f.seed(
    "INSERT INTO source (id, org_id, name, ecosystem, type, project_id) VALUES ('source', ?, 'source', 'npm', 'npmjs_proxy', 'project')",
    f.own.orgId,
  );
  await f.seed(
    "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('name', ?, 'source', 'npm', 'pkg')",
    f.own.orgId,
  );
  return { type: 'registered_name', id: 'name', item: { type: 'name', external_ref: 'item' } };
});
function versionTarget(foreignPackage: boolean): ContractCase {
  return isolated(
    foreignPackage
      ? 'foreign package cannot make a version visible'
      : 'package visibility requires an own source',
    async (f) => {
      await f.seed(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('source', ?, 'source', 'npm', 'npmjs_proxy')",
        f.foreign.orgId,
      );
      await f.seed(
        "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES ('package', ?, 'source', 'npm', 'pkg')",
        foreignPackage ? f.foreign.orgId : f.own.orgId,
      );
      await f.seed(
        "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES ('version', ?, 'package', '1.0.0', '1.0.0', '2026-01-01T00:00:00.000Z', 'source_release', '{}')",
        f.own.orgId,
      );
      return {
        type: 'version',
        id: 'version',
        item: { type: 'version_override', external_ref: 'item' },
      };
    },
  );
}
const pkg = versionTarget(true);
const pkgSource = versionTarget(false);
const credential = isolated('foreign credential cannot satisfy an own source upload', async (f) => {
  await f.seed(
    "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES ('credential', ?, 'bearer', x'00', zeroblob(12), 1, 'test')",
    f.foreign.orgId,
  );
  await f.seed(
    "INSERT INTO source (id, org_id, name, ecosystem, type, status, credential_id) VALUES ('source', ?, 'source', 'npm', 'npmjs_proxy', 'paused', 'credential')",
    f.own.orgId,
  );
  return {
    type: 'source',
    id: 'source',
    item: { type: 'source', external_ref: 'item', credential_ref: 'env:TEST' },
  };
});
const permission = isolated(
  'foreign permissions cannot change an own role digest',
  async (f) => {
    await f.seed(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('role', ?, 'role', 'Role', 'organization')",
      f.own.orgId,
    );
    await f.seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'role', 'org:import:write')",
      f.foreign.orgId,
    );
    return { type: 'role', id: 'role', item: { type: 'role', external_ref: 'item' } };
  },
  true,
);
const epoch: ContractCase = {
  name: 'foreign epoch cannot replace a missing own epoch',
  async run(context) {
    const f = await fixture(context);
    await f.seed('DELETE FROM cache_epoch WHERE org_id = ?', f.own.orgId);
    await expect(
      f.store.verify(f.own, f.fence, {
        ...f.input,
        manifest: { version: 1, source_system: 'test', items: [], widening: [] },
      }),
    ).rejects.toThrow('cache_epoch row is missing');
  },
};
const failure: ContractCase = {
  name: 'verification failure cannot modify a foreign run',
  async run(context) {
    const f = await fixture(context);
    await f.seed('UPDATE import_run SET org_id = ? WHERE org_id = ?', f.foreign.orgId, f.own.orgId);
    expect(await f.store.fail(f.own, f.fence, f.input)).toMatchObject({ ok: false });
  },
};
const failureUpdate: ContractCase = {
  name: 'verification failure update independently scopes the organization',
  async run(context) {
    const f = await fixture(context, true);
    await f.seed('UPDATE import_run SET org_id = ? WHERE org_id = ?', f.foreign.orgId, f.own.orgId);
    await f.store.fail(f.own, f.fence, f.input);
    expect(
      await context.executor.all({
        sql: "SELECT state FROM import_run WHERE org_id = ? AND id = 'run'",
        params: [f.foreign.orgId],
      }),
    ).toEqual([{ state: 'verifying' }]);
  },
};
const busy: ContractCase = {
  name: 'foreign rollback job does not block an own verification failure',
  async run(context) {
    const f = await fixture(context);
    await f.seed(
      "INSERT INTO job (id, org_id, type, resource_key, payload_json) VALUES ('rollback', ?, ?, ?, '{}')",
      f.foreign.orgId,
      IMPORT_RUN_JOB.rollback,
      IMPORT_RUN_JOB.resourceKey('run'),
    );
    expect(await f.store.fail(f.own, f.fence, f.input)).toMatchObject({ ok: true });
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createImportVerificationStore',
    file: 'repositories/import-verification.ts',
    cases: [
      entity,
      project,
      role,
      source,
      parent,
      pkg,
      pkgSource,
      credential,
      permission,
      epoch,
      failure,
      failureUpdate,
      busy,
    ],
    predicates: [
      {
        name: 'verification entity reads are organization scoped',
        locate: /iventity\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: entity.name,
      },
      {
        name: 'visible projects are organization scoped',
        locate: /ivproject\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: project.name,
      },
      {
        name: 'grant roles are organization scoped',
        locate: /ivrole\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: role.name,
      },
      {
        name: 'name sources are organization scoped',
        locate: /ivsource\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: source.name,
      },
      {
        name: 'source parent organization matches',
        locate: /ivparent\.org_id = ivsource\.org_id/,
        neutral: '1 = 1',
        caseName: parent.name,
      },
      {
        name: 'version package organization matches',
        locate: /ivpackage\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: pkg.name,
      },
      {
        name: 'package source organization matches',
        locate: /ivsource\.org_id = ivpackage\.org_id/,
        neutral: '1 = 1',
        caseName: pkgSource.name,
      },
      {
        name: 'credentials are organization scoped',
        locate: /ivcredential\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: credential.name,
      },
      {
        name: 'role digest permissions are organization scoped',
        locate: /ivpermission\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: permission.name,
      },
      {
        name: 'snapshot epoch is organization scoped',
        locate: /ivepoch\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: epoch.name,
      },
      {
        name: 'failure run guard is organization scoped',
        locate: /ivrun\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: failure.name,
      },
      {
        name: 'failure updates are organization scoped',
        locate: /(?<=WHERE )org_id = \?/,
        neutral: NOT_NULL,
        caseName: failureUpdate.name,
      },
      {
        name: 'conflicting rollback jobs are organization scoped',
        locate: /ivrollback\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: busy.name,
      },
    ],
    waivers: [
      {
        locate: /ivjob\.org_id = \?/,
        reason: 'The same job is independently organization scoped by the shared jobLeaseGuard.',
      },
      {
        locate: /(?:ijload|ijrollback|ijverified|ijbusy|cache_epoch|job)\.org_id = \?/,
        reason:
          'Shared import journal completion and job lease predicates have their own registrations.',
      },
      {
        locate: /(?:ijrollbackrun\.org_id = ijrollback\.org_id|(?<!\.)"org_id" = \?)/,
        reason: 'Shared import journal and assertGuard predicates have their own registrations.',
      },
    ],
  },
];
