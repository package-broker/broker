import { expect } from 'vitest';
import { createImportCredentialRepository } from '../../repositories/import-credential.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ALWAYS, FUTURE, HASH, NOT_NULL, fenceOf, seedUser } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignRun: ContractCase = {
  name: 'credential inspection rejects a foreign import run child of an own starter',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', own.orgId);
    await seed(
      "INSERT INTO import_run (id, org_id, source_system, started_by_user_id, manifest_blob_sha256) VALUES ('RUN', ?, 'test', 'U', ?)",
      foreign.orgId,
      HASH,
    );
    const store = createImportCredentialRepository(executing(context), {
      providerAnchors: [],
      blobs: {
        get: async () => ({
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{}'));
              controller.close();
            },
          }),
          info: {
            generation: '',
            sha256: HASH as import('@package-broker/core/platform/blob').Sha256,
            size: 2,
            mediaType: 'application/json',
            purgeAfter: null,
          },
        }),
      },
    });
    expect(
      (await store.inspect(own, fenceOf({ userId: 'U', sessionId: 'S' }), 'RUN', 'source', FUTURE))
        .target,
    ).toBeNull();
  },
};
const foreignBindings: ContractCase = {
  name: 'credential binding status hides a foreign import run',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO import_run (id, org_id, source_system, manifest_blob_sha256) VALUES ('RUN', ?, 'test', ?)",
      foreign.orgId,
      HASH,
    );
    const store = createImportCredentialRepository(executing(context), {
      providerAnchors: [],
      blobs: {
        get: async () => ({
          body: new Response('{}').body!,
          info: {
            generation: '',
            sha256: HASH as import('@package-broker/core/platform/blob').Sha256,
            size: 2,
            mediaType: 'application/json',
            purgeAfter: null,
          },
        }),
      },
    });
    expect(await store.bindings(own, 'RUN')).toBeNull();
  },
};
const foreignChildren: ContractCase = {
  name: 'credential binding status ignores foreign import refs and sources under an own run',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO import_run (id, org_id, source_system, manifest_blob_sha256) VALUES ('RUN', ?, 'test', ?)",
      own.orgId,
      HASH,
    );
    for (const id of ['FOREIGN-SRC', 'F-SRC']) {
      await seed(
        "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'bearer', X'00', X'000000000000000000000000', 1, 'aad')",
        `${id}-CRED`,
        foreign.orgId,
      );
      await seed(
        "INSERT INTO source (id, org_id, name, ecosystem, type, credential_id) VALUES (?, ?, ?, 'composer', 'composer_repository', ?)",
        id,
        foreign.orgId,
        id,
        `${id}-CRED`,
      );
    }
    await seed(
      "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action) VALUES ('OWN-REF', ?, 'RUN', 'source', 'FOREIGN-SRC', 'own-ref', 'create')",
      own.orgId,
    );
    await seed(
      "INSERT INTO import_ref (id, org_id, import_run_id, entity_type, entity_id, external_ref, action) VALUES ('F-REF', ?, 'RUN', 'source', 'F-SRC', 'foreign-ref', 'create')",
      foreign.orgId,
    );
    const store = createImportCredentialRepository(executing(context), {
      providerAnchors: [],
      blobs: {
        get: async () => ({
          body: new Response('{}').body!,
          info: {
            generation: '',
            sha256: HASH as import('@package-broker/core/platform/blob').Sha256,
            size: 2,
            mediaType: 'application/json',
            purgeAfter: null,
          },
        }),
      },
    });
    expect(await store.bindings(own, 'RUN')).toEqual({ manifest: '{}', bound: [] });
  },
};
const base = factoryEntry(
  'import-credential',
  'createImportCredentialRepository',
  foreignRun,
  /"icr"\."org_id" = \?/,
  [
    {
      locate: /"(?:actor|s|i|hp_session|guard_\w+)"\."org_id" = /,
      reason:
        'Import session authority delegates unchanged to actorHolds, permissionRows and local eligibility, which are registered separately.',
    },
    {
      locate: /"ic[fs]"\."org_id" = /,
      reason:
        'No source reference is present in this foreign-run case; source binding predicates are independent of the run lookup.',
    },
  ],
);
export const entries: readonly MutationEntry[] = [
  {
    ...base,
    cases: [...base.cases, foreignBindings, foreignChildren],
    predicates: [
      ...base.predicates,
      {
        name: foreignBindings.name,
        caseName: foreignBindings.name,
        locate: /"icr"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
      {
        name: 'credential binding import refs are scoped to the organization',
        caseName: foreignChildren.name,
        locate: /"icf"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
      {
        name: 'credential binding sources share the import ref organization',
        caseName: foreignChildren.name,
        locate: /"ics"\."org_id" = "icf"\."org_id"/,
        neutral: ALWAYS,
        copies: 1,
      },
    ],
  },
];
