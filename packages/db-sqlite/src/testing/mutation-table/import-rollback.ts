import { expect } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import { auditEvent } from '@package-broker/core/audit/actions';
import { delegatedMutationFence } from '@package-broker/core/authz/fence';
import type { OrgContext } from '@package-broker/core/db/port';
import type { ImportRollbackAction } from '@package-broker/core/import/rollback';
import { IMPORT_RUN_JOB } from '@package-broker/core/import/run-service';
import { hash } from '../../repositories/import-journal.js';
import { createImportRollbackStore } from '../../repositories/import-rollback.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
  type Seed,
} from './harness.js';
import { FUTURE, NOT_NULL, permissionRowsWaiver } from './fixtures.js';

const ANCHORS = [
  {
    provider: 'oidc',
    anchor: 'test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const NOW = '2026-10-20T12:00:00.000Z';
const PAST = '2026-10-20T11:00:00.000Z';
const RUN = '01J0RN0000000000000000R001';
const FOREIGN_RUN = '01J0RN0000000000000000R002';
const SOURCE_COLUMNS = '(id, org_id, name, ecosystem, type)';

function storeFor(context: CaseContext) {
  return createImportRollbackStore({
    executor: {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    },
    providerAnchors: ANCHORS,
  });
}

async function seedAuthority(seed: Seed, org: OrgContext): Promise<void> {
  await seed(
    "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'test')",
    org.orgId,
  );
  await seed(
    "INSERT INTO role (id, org_id, key, name, scope) VALUES ('importer', ?, 'importer', 'Importer', 'organization')",
    org.orgId,
  );
  await seed(
    "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:approve')",
    org.orgId,
  );
  for (const name of ['actor', 'requester']) {
    await seed(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      name,
      org.orgId,
      `${name}@example.test`,
    );
    await seed(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, 'oidc', ?, ?, 1, ?)",
      `identity-${name}`,
      org.orgId,
      name,
      name,
      `${name}@example.test`,
      NOW,
    );
    await seed(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', 'importer')",
      `grant-${name}`,
      org.orgId,
      `${name}@example.test`,
    );
  }
}

async function seedRun(
  seed: Seed,
  org: OrgContext,
  runId: string,
  options: { expired?: boolean; job?: boolean; jobRun?: string } = {},
): Promise<void> {
  await seed(
    "INSERT INTO import_run (id, org_id, source_system, state, approved_by_user_id, approved_at, before_image_expires_at) VALUES (?, ?, 'test', ?, 'actor', ?, ?)",
    runId,
    org.orgId,
    options.expired === true ? 'verified' : 'applied',
    NOW,
    options.expired === true ? PAST : null,
  );
  if (options.job === false) return;
  const jobRun = options.jobRun ?? runId;
  await seed(
    "INSERT INTO job (id, org_id, type, payload_json, resource_key, state, lease_owner, lease_until, fence) VALUES (?, ?, ?, ?, ?, 'running', 'worker', ?, 1)",
    `job-${runId}`,
    org.orgId,
    IMPORT_RUN_JOB.rollback,
    JSON.stringify({ runId: jobRun, requestedBy: 'requester' }),
    IMPORT_RUN_JOB.resourceKey(jobRun),
    FUTURE,
  );
}

const fenceFor = (runId: string, expected: Readonly<Record<string, number>> = {}) =>
  delegatedMutationFence(
    'requester',
    runId,
    { id: `job-${runId}`, owner: 'worker', fence: 1 },
    expected,
  );

function auditFor(type: string, id: string) {
  const built = auditEvent({
    id: ulid(),
    now: NOW,
    action: 'import_run.rollback',
    actor: { type: 'user', id: 'requester' },
    target: { type: type, id },
    projectId: null,
    changes: { state: { new: 'deleted' } },
    context: { opId: RUN, requestId: RUN, sourceIp: null, tokenSelector: null },
  });
  if (!built.ok) throw new Error('invalid audit fixture');
  return built.event;
}

async function seedRef(
  seed: Seed,
  org: OrgContext,
  id: string,
  runId: string,
  type: string,
  entityId: string,
  action: 'create' | 'update' = 'create',
): Promise<void> {
  await seed(
    'INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action, published_at_basis) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    org.orgId,
    runId,
    type,
    entityId,
    id,
    action,
    type === 'version' ? 'source_release' : null,
  );
}

const TYPES = [
  'project',
  'role',
  'source',
  'registered_name',
  'project_source',
  'access_grant',
  'version',
] as const;

async function seedEntities(seed: Seed, org: OrgContext, tag: string): Promise<void> {
  const id = (name: string) => `${tag}-${name}`;
  await seed(
    "INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, 'P')",
    id('project'),
    org.orgId,
    id('project').toLowerCase(),
  );
  await seed(
    "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, 'R', 'organization')",
    id('role'),
    org.orgId,
    id('role').toLowerCase(),
  );
  await seed(
    `INSERT INTO source ${SOURCE_COLUMNS} VALUES (?, ?, ?, 'npm', 'npmjs_proxy')`,
    id('source'),
    org.orgId,
    id('source'),
  );
  await seed(
    "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES (?, ?, ?, 'npm', 'x/*')",
    id('registered_name'),
    org.orgId,
    id('source'),
  );
  await seed(
    'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 1)',
    org.orgId,
    id('project'),
    id('source'),
  );
  await seed(
    "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', ?, 'organization', ?)",
    id('access_grant'),
    org.orgId,
    `${tag.toLowerCase()}@example.test`,
    id('role'),
  );
  await seed(
    "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'npm', ?)",
    id('package'),
    org.orgId,
    id('source'),
    id('package'),
  );
  await seed(
    "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES (?, ?, ?, '1.0.0', '1.0.0', ?, 'source_release', '{}')",
    id('version'),
    org.orgId,
    id('package'),
    PAST,
  );
}

const entityIdOf = (tag: string, type: string): string =>
  type === 'project_source' ? `${tag}-project:${tag}-source` : `${tag}-${type}`;

const live: ContractCase = {
  name: 'live reads of every entity type are organization scoped',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedEntities(seeder(context.executor), foreign, 'foreign');
    const store = storeFor(context);
    const states = await store.liveStates(
      own,
      TYPES.map((type) => ({ entityType: type, entityId: entityIdOf('foreign', type) })),
    );
    expect(states.map((state) => state.exists)).toEqual(TYPES.map(() => false));
  },
};

const permissions: ContractCase = {
  name: 'a foreign permission row cannot enter the live role hash',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('own-role', ?, 'own-role', 'R', 'organization')",
      own.orgId,
    );
    await seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'own-role', 'org:read')",
      foreign.orgId,
    );
    const [state] = await storeFor(context).liveStates(own, [
      { entityType: 'role', entityId: 'own-role' },
    ]);
    expect(state?.contentHash).toBe(
      await hash({
        key: 'own-role',
        name: 'R',
        scope: 'organization',
        is_system: 0,
        protects_last_holder: 0,
        permissions: [],
      }),
    );
  },
};

async function foreignRefsUntouched(context: CaseContext): Promise<void> {
  const { foreign } = orgOf(context);
  expect(
    await context.executor.all({
      sql: 'SELECT id, conflict_state, rolled_back_at, expired_at FROM import_ref WHERE org_id = ? ORDER BY id',
      params: [foreign.orgId],
    }),
  ).toEqual(
    ['f-conflict', 'f-delete', 'f-expired'].map((id) => ({
      id,
      conflict_state: 'none',
      rolled_back_at: null,
      expired_at: null,
    })),
  );
}

const refs: ContractCase = {
  name: 'a journal ref of another organization is never marked',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedAuthority(seed, own);
    await seedRun(seed, own, RUN, { expired: true });
    await seed(
      "INSERT INTO project (id, org_id, slug, name) VALUES ('mine', ?, 'mine', 'P')",
      own.orgId,
    );
    for (const id of ['f-delete', 'f-conflict', 'f-expired']) {
      await seedRef(seed, foreign, id, RUN, 'project', 'mine');
    }
    const result = await storeFor(context).applyChunk(own, fenceFor(RUN, { mine: 1 }), {
      runId: RUN,
      approvedByUserId: 'actor',
      now: NOW,
      actions: [
        {
          kind: 'delete',
          refId: 'f-delete',
          entityType: 'project',
          entityId: 'mine',
          guard: { kind: 'revision', revision: 1 },
          requireUnreferenced: true,
          audit: auditFor('project', 'mine'),
        },
        { kind: 'conflict', refId: 'f-conflict' },
        { kind: 'expired', refId: 'f-expired' },
      ],
    });
    expect(result).toEqual({ ok: true, outcomes: ['conflict', 'conflict', 'conflict'] });
    await foreignRefsUntouched(context);
    expect(
      await context.executor.all({
        sql: "SELECT id FROM project WHERE org_id = ? AND id = 'mine'",
        params: [own.orgId],
      }),
    ).toEqual([{ id: 'mine' }]);
  },
};

const entities: ContractCase = {
  name: 'an own journal ref never reaches an entity of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedAuthority(seed, own);
    await seedRun(seed, own, RUN);
    await seedEntities(seed, foreign, 'foreign');
    await seed(
      "INSERT INTO project (id, org_id, slug, name) VALUES ('lone-project', ?, 'lone-project', 'P')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('lone-role', ?, 'lone-role', 'R', 'organization')",
      foreign.orgId,
    );
    await seed(
      `INSERT INTO source ${SOURCE_COLUMNS} VALUES ('lone-source', ?, 'lone-source', 'npm', 'npmjs_proxy')`,
      foreign.orgId,
    );
    const store = storeFor(context);
    const actions: ImportRollbackAction[] = [];
    const expected: Record<string, number> = {};
    for (const type of TYPES) {
      const entityId = ['project', 'role', 'source'].includes(type)
        ? `lone-${type}`
        : entityIdOf('foreign', type);
      const refId = `own-${type}`;
      await seedRef(
        seed,
        own,
        refId,
        RUN,
        type,
        entityId,
        type === 'version' ? 'update' : 'create',
      );
      const [state] = await store.liveStates(foreign, [{ entityType: type, entityId }]);
      if (state?.guard === null || state?.guard === undefined) throw new Error('missing guard');
      if (state.guard.kind === 'revision') expected[entityId] = state.guard.revision;
      actions.push(
        type === 'version'
          ? {
              kind: 'restore',
              refId,
              entityType: type,
              entityId,
              guard: state.guard,
              domain: { published_at: PAST, published_at_basis: 'source_release' },
              audit: auditFor(type, entityId),
            }
          : {
              kind: 'delete',
              refId,
              entityType: type,
              entityId,
              guard: state.guard,
              requireUnreferenced: true,
              audit: auditFor(type, entityId),
            },
      );
    }
    const result = await store.applyChunk(own, fenceFor(RUN, expected), {
      runId: RUN,
      approvedByUserId: 'actor',
      now: NOW,
      actions,
    });
    expect(result).toEqual({ ok: true, outcomes: TYPES.map(() => 'conflict') });
    const tables = [
      'project',
      'role',
      'source',
      'registered_name',
      'project_source',
      'access_grant',
      'version',
    ];
    for (const table of tables) {
      const [row] = await context.executor.all<{ n: number }>({
        sql: `SELECT count(*) AS n FROM ${table} WHERE org_id = ? AND ${table === 'role' || table === 'access_grant' ? "substr(id, 1, 8) = 'foreign-'" : '1 = 1'}`,
        params: [foreign.orgId],
      });
      expect(row?.n, table).toBeGreaterThan(0);
    }
    expect(
      await context.executor.all({
        sql: 'SELECT id FROM import_ref WHERE org_id = ? AND (rolled_back_at IS NOT NULL OR conflict_state <> ?)',
        params: [own.orgId, 'changed_after_import'],
      }),
    ).toEqual([]);
  },
};

const blobs: ContractCase = {
  name: 'a restore never adopts a blob of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedAuthority(seed, own);
    await seedRun(seed, own, RUN);
    await seedEntities(seed, own, 'own');
    await seed(
      "INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES ('foreign-blob', ?, ?, 1, 'foreign-blob')",
      foreign.orgId,
      'b'.repeat(64),
    );
    await seedRef(seed, own, 'restore', RUN, 'version', 'own-version', 'update');
    const result = await storeFor(context).applyChunk(own, fenceFor(RUN, { 'own-version': 1 }), {
      runId: RUN,
      approvedByUserId: 'actor',
      now: NOW,
      actions: [
        {
          kind: 'restore',
          refId: 'restore',
          entityType: 'version',
          entityId: 'own-version',
          guard: { kind: 'revision', revision: 1 },
          domain: { blob_id: 'foreign-blob', published_at_basis: 'source_release' },
          audit: auditFor('version', 'own-version'),
        },
      ],
    });
    expect(result).toEqual({ ok: true, outcomes: ['conflict'] });
    expect(
      await context.executor.all({
        sql: "SELECT blob_id, revision FROM version WHERE id = 'own-version'",
        params: [],
      }),
    ).toEqual([{ blob_id: null, revision: 1 }]);
  },
};

const runs: ContractCase = {
  name: 'the rollback guard and finish never accept a run of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedAuthority(seed, own);
    await seedRun(seed, foreign, FOREIGN_RUN, { job: false });
    await seedRun(seed, own, RUN, { jobRun: FOREIGN_RUN });
    const store = storeFor(context);
    const fence = delegatedMutationFence(
      'requester',
      FOREIGN_RUN,
      { id: `job-${RUN}`, owner: 'worker', fence: 1 },
      {},
    );
    expect(
      await store.applyChunk(own, fence, {
        runId: FOREIGN_RUN,
        approvedByUserId: 'actor',
        now: NOW,
        actions: [{ kind: 'conflict', refId: 'none' }],
      }),
    ).toEqual({ ok: false, reason: 'guard' });
    await expect(
      store.finish(own, fence, {
        runId: FOREIGN_RUN,
        outcome: 'rolled_back',
        counts: { restored: 0, conflict: 0, expired: 0 },
        audits: [],
        now: NOW,
      }),
    ).rejects.toThrow('refused');
    expect(
      await context.executor.all({
        sql: 'SELECT state, rollback_restored_count FROM import_run WHERE id = ?',
        params: [FOREIGN_RUN],
      }),
    ).toEqual([{ state: 'applied', rollback_restored_count: 0 }]);
  },
};

const bump: ContractCase = {
  name: 'a version restore never bumps a package of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedAuthority(seed, own);
    await seedRun(seed, own, RUN);
    await seedEntities(seed, foreign, 'foreign');
    await seed(
      "INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json) VALUES ('own-version', ?, 'foreign-package', '2.0.0', '2.0.0', ?, 'source_release', '{}')",
      own.orgId,
      NOW,
    );
    await seedRef(seed, own, 'restore', RUN, 'version', 'own-version', 'update');
    const result = await storeFor(context).applyChunk(own, fenceFor(RUN, { 'own-version': 1 }), {
      runId: RUN,
      approvedByUserId: 'actor',
      now: NOW,
      actions: [
        {
          kind: 'restore',
          refId: 'restore',
          entityType: 'version',
          entityId: 'own-version',
          guard: { kind: 'revision', revision: 1 },
          domain: { published_at: PAST, published_at_basis: 'source_release' },
          audit: auditFor('version', 'own-version'),
        },
      ],
    });
    expect(result).toEqual({ ok: true, outcomes: ['restored'] });
    expect(
      await context.executor.all({
        sql: "SELECT rev FROM package WHERE id = 'foreign-package'",
        params: [],
      }),
    ).toEqual([{ rev: 1 }]);
  },
};

const protectedRole: ContractCase = {
  name: 'a protected role of another organization never blocks a grant removal',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedAuthority(seed, own);
    await seedRun(seed, own, RUN);
    await seed(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('foreign-role', ?, 'foreign-role', 'R', 'organization', 1)",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('own-grant', ?, 'email', 'holder@example.test', 'organization', 'foreign-role')",
      own.orgId,
    );
    await seedRef(seed, own, 'remove', RUN, 'access_grant', 'own-grant');
    const store = storeFor(context);
    const [state] = await store.liveStates(own, [
      { entityType: 'access_grant', entityId: 'own-grant' },
    ]);
    if (state?.guard === null || state?.guard === undefined) throw new Error('missing guard');
    const result = await store.applyChunk(own, fenceFor(RUN, { 'own-grant': 1 }), {
      runId: RUN,
      approvedByUserId: 'actor',
      now: NOW,
      actions: [
        {
          kind: 'delete',
          refId: 'remove',
          entityType: 'access_grant',
          entityId: 'own-grant',
          guard: state.guard,
          requireUnreferenced: true,
          audit: auditFor('access_grant', 'own-grant'),
        },
      ],
    });
    expect(result).toEqual({ ok: true, outcomes: ['restored'] });
    expect(
      await context.executor.all({
        sql: "SELECT id FROM access_grant WHERE id = 'own-grant'",
        params: [],
      }),
    ).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createImportRollbackStore',
    file: 'repositories/import-rollback.ts',
    cases: [live, permissions, refs, entities, blobs, runs, bump, protectedRole],
    predicates: [
      {
        name: 'live reads are organization scoped',
        locate: /rblive\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: live.name,
      },
      {
        name: 'live role permissions have the role organization',
        locate: /rbperm\.org_id = rblive\.org_id/,
        neutral: '1 = 1',
        caseName: permissions.name,
      },
      {
        name: 'journal refs are organization scoped',
        locate: /rbmark\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: refs.name,
        waivedCopies: {
          3: 'The expiry UPDATE binds the ref to the organization twice, with rbmark.org_id = ? and through rbexp.org_id = rbmark.org_id; the two are mutually redundant, so stripping either alone leaves the other binding the ref and no case can fail on it.',
        },
      },
      {
        name: 'entity guards are organization scoped',
        locate: /rbent\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: entities.name,
      },
      {
        name: 'a restored blob belongs to the organization',
        locate: /rbblob\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: blobs.name,
      },
      {
        name: 'the rollback run is organization scoped',
        locate: /rbrun\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: runs.name,
      },
      {
        name: 'a package bumped by a restore belongs to the organization',
        locate: /"package"\."org_id" = \?/,
        neutral: NOT_NULL,
        caseName: bump.name,
      },
      {
        name: 'a protecting role belongs to the grant organization',
        locate: /rbprotected\.org_id = rbent\.org_id/,
        neutral: '1 = 1',
        caseName: protectedRole.name,
      },
    ],
    waivers: [
      permissionRowsWaiver,
      {
        locate:
          /(?:"?(?:project_package|stay_package|derive_package|derive_attachment)"?\.)"?org_id"? = \?|derive_include\.org_id = \?/,
        reason:
          'The shared rederiveStatements registration tests the visibility derivation of an attachment.',
      },
      {
        locate: /(?:removed|removed_member|remaining|membership)\.org_id = /,
        reason: 'The shared patInvalidationStatement registration tests the grant removal.',
      },
      {
        locate: /bls_blob\.org_id = \?/,
        reason: 'The shared blobLeaseNotLive registration tests the purge lease.',
      },
      {
        locate: /(?<=DELETE FROM role_permission WHERE )org_id = \?/,
        reason:
          'role_permission rows are deleted by ON DELETE CASCADE from the role in the same batch, keyed on role_id alone, so every permission row of the role goes whatever its organization and the explicit DELETE cannot be told apart.',
      },
      {
        locate:
          /(?<=WHERE )org_id = \?(?! AND role_id = \?)(?= AND \w+ = \?(?: AND \w+ = \?)* AND EXISTS \(SELECT 1 FROM import_ref AS rbdone)/,
        reason:
          'Mutation targets sit behind the organization-scoped journal marker of the same batch, which binds the entity type and id; a row of another organization cannot share the id.',
      },
      {
        locate: /(?<=WHERE )org_id = \?(?= AND \(\s*email IN)/,
        reason: 'The shared patInvalidationStatement registration tests the grant removal.',
      },
      {
        locate: /(?<=WHERE )org_id = \?(?= AND id = \? AND state IN)/,
        reason:
          'The finish UPDATE runs behind the fence guard, whose rbrun.org_id predicate is registered; import_run.id is a global primary key, so a run of another organization cannot share the id.',
      },
      {
        locate: /rbdone\.org_id = \?/,
        reason:
          'import_ref.id is a global primary key and the organization-scoped marker is the only statement that can set rolled_back_at, so the done check cannot see a ref of another organization.',
      },
      {
        locate: /rbver\.org_id = \?/,
        reason:
          'The version_revision snapshot is gated by the done check of the organization-scoped marker, and version.id is a global primary key.',
      },
      {
        locate: /"version"\."org_id" = \?/,
        reason:
          'The package bump resolves its package through the version the organization-scoped marker restored; version.id is a global primary key, so the lookup cannot reach a version of another organization.',
      },
      {
        locate: /rbexp\.org_id = rbmark\.org_id/,
        reason:
          'The expiry UPDATE binds the ref to the organization twice, with rbmark.org_id = ? and through this join of the run to the marked ref; the two are mutually redundant, so stripping either alone leaves the other binding the ref and no case can fail on it.',
      },
      {
        locate: /(?<!rb)job\.org_id = \?/,
        reason: 'The shared jobLeaseGuard registration tests ownership of the leased job.',
      },
      {
        locate: /rbjob\.org_id = \?/,
        reason:
          'The shared jobLeaseGuard in the same batch binds the same job id to the organization with job.org_id; the two are mutually redundant, so stripping either alone leaves the other refusing a job of another organization and no case can fail on it.',
      },
      {
        locate: /(?<!\.)"org_id" = \?/,
        reason: 'assertGuard cache epoch predicate is registered by its shared builder',
      },
    ],
  },
];
