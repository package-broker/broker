import { expect } from 'vitest';
import { createLocalLoginReader } from '../../repositories/local-login.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ALWAYS, seedUser } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'local login reads exclude a foreign login and user',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', foreign.orgId);
    await seed("INSERT INTO local_login (user_id, org_id) VALUES ('U', ?)", foreign.orgId);
    expect(
      await createLocalLoginReader(executing(context)).findByEmail(own, 'u@example.test'),
    ).toBeNull();
  },
};
const foreignUser: ContractCase = {
  name: 'local login rejects a foreign user parent of an own login',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', foreign.orgId);
    await seed("INSERT INTO local_login (user_id, org_id) VALUES ('U', ?)", own.orgId);
    expect(
      await createLocalLoginReader(executing(context)).findByEmail(own, 'u@example.test'),
    ).toBeNull();
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'local-login',
    'createLocalLoginReader',
    foreignRow,
    /"local_login"\."org_id" = \?/,
    [
      {
        locate: /"user_account"\."org_id" = "local_login"\."org_id"/,
        reason:
          'This case targets the root login scope; the mismatched user join has its own case in this module.',
      },
      {
        locate: /"guard_\w+"\."org_id" = /,
        reason:
          'adminEligibility is delegated unchanged and has independent registrations in kysely.ts.',
      },
    ],
  ),
  factoryEntry(
    'local-login',
    'createLocalLoginReader',
    foreignUser,
    /"user_account"\."org_id" = "local_login"\."org_id"/,
    [
      {
        locate: /"local_login"\."org_id" = \?/,
        reason:
          'The login is an own control for the foreign-user join; the root login scope has its own independent case.',
      },
      {
        locate: /"guard_\w+"\."org_id" = /,
        reason: 'adminEligibility delegates to independently registered eligibility guards.',
      },
    ],
    ALWAYS,
  ),
];
