import { expect } from 'vitest';
import { createUserRepository } from '../../repositories/user.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { seedUser } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'user listing excludes a foreign account',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', foreign.orgId);
    expect(
      await createUserRepository(executing(context)).list(own, { afterId: null, limit: 10 }),
    ).toEqual([]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('user', 'createUserRepository', foreignRow, /"user_account"\."org_id" = \?/),
];
