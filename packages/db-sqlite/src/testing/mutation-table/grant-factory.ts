import { expect } from 'vitest';
import { createGrantRepository } from '../../repositories/grant.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import {} from './fixtures.js';
import { FUTURE } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'grant listing excludes a foreign child of an own role',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'r', 'R', 'organization')",
      own.orgId,
    );
    await seed(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('G', ?, 'email', 'u@example.test', 'organization', 'R')",
      foreign.orgId,
    );
    expect(
      await createGrantRepository(executing(context), {
        providerAnchors: [],
        holderInput: () => ({ kind: 'fresh', now: FUTURE, providers: [] }),
      }).listOrganization(own),
    ).toEqual([]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('grant', 'createGrantRepository', foreignRow, /"access_grant"\."org_id" = \?/),
];
