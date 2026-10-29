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
const foreignReplacement: ContractCase = {
  name: 'credential replacement preserves foreign material',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad, updated_at) VALUES ('C', ?, 'totp', X'01', zeroblob(12), 1, 'aad', '2026-10-28T00:00:00.000Z')",
      foreign.orgId,
    );
    expect(
      await createCredentialRepository(executing(context)).replaceMaterial(
        own,
        'C',
        '2026-10-28T00:00:00.000Z',
        { ciphertext: new Uint8Array([2]), nonce: new Uint8Array(12), keyVersion: 1 },
        '2026-10-28T01:00:00.000Z',
      ),
    ).toBe(false);
    const rows = await context.executor.all<{ key_version: number; ciphertext: Uint8Array }>({
      sql: "SELECT key_version, ciphertext FROM credential WHERE id = 'C'",
      params: [],
    });
    expect(rows[0]?.ciphertext).toEqual(new Uint8Array([1]));
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('credential', 'createCredentialRepository', foreignReplacement, /"org_id" = \?/),
  factoryEntry('credential', 'createCredentialRepository', foreignRow, /"org_id" = \?/),
];
