import { expect } from 'vitest';
import { createCredentialRepository } from '../../repositories/credential.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { seedProject } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'credential deletion preserves a foreign child of an own project',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seed(
      "INSERT INTO credential (id, org_id, project_id, kind, ciphertext, nonce, key_version, aad) VALUES ('C', ?, 'P', 'totp', X'01', zeroblob(12), 1, 'aad')",
      foreign.orgId,
    );
    expect(await createCredentialRepository(executing(context)).delete(own, 'C')).toBe(false);
    expect(
      await context.executor.all({ sql: "SELECT id FROM credential WHERE id = 'C'", params: [] }),
    ).toEqual([{ id: 'C' }]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('credential', 'createCredentialRepository', foreignRow, /"org_id" = \?/),
];
