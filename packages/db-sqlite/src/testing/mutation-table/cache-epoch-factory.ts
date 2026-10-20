import { expect } from 'vitest';
import { createCacheEpochRepository } from '../../repositories/cache-epoch.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { executing, factoryEntry } from './factory-cases.js';
const epoch: ContractCase = {
  name: 'the epoch adapter reads its own epoch even when the foreign epoch sorts first',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed('DELETE FROM cache_epoch');
    await seed(
      'INSERT INTO cache_epoch (org_id, version) VALUES (?, ?)',
      foreign.orgId,
      'B'.repeat(32),
    );
    await seed(
      'INSERT INTO cache_epoch (org_id, version) VALUES (?, ?)',
      own.orgId,
      'A'.repeat(32),
    );
    expect(await createCacheEpochRepository(executing(context)).read(own)).toBe('A'.repeat(32));
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('cache-epoch', 'createCacheEpochRepository', epoch, /"cache_epoch"\."org_id" = \?/),
];
