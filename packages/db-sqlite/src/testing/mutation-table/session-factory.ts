import { expect } from 'vitest';
import { createSessionRepository } from '../../repositories/session.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { HASH, OTHER_HASH, FUTURE, seedUser } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'session revocation preserves a foreign child of an own user',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', own.orgId);
    await seed(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES ('S', ?, 'U', ?, ?, ?)",
      foreign.orgId,
      HASH,
      OTHER_HASH,
      FUTURE,
    );
    expect(await createSessionRepository(executing(context)).revoke(own, 'S', FUTURE)).toBe(false);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('session', 'createSessionRepository', foreignRow, /"org_id" = \?/),
];
