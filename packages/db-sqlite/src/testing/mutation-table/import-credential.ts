import { expect } from 'vitest';
import { createImportCredentialRepository } from '../../repositories/import-credential.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE, HASH, fenceOf, seedUser } from './fixtures.js';
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
export const entries: readonly MutationEntry[] = [
  factoryEntry(
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
  ),
];
