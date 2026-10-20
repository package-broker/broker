import { expect } from 'vitest';
import { createRoleRepository } from '../../repositories/role.js';

import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import {} from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignRow: ContractCase = {
  name: 'role reads exclude a foreign permission child of an own role',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'r', 'R', 'organization')",
      own.orgId,
    );
    await seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R', 'org:users:read')",
      foreign.orgId,
    );
    expect(
      await createRoleRepository(executing(context), { providerAnchors: [] }).get(own, 'R'),
    ).toMatchObject({ permissions: [] });
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'role',
    'createRoleRepository',
    foreignRow,
    /"role_permission"\."org_id" = "role"\."org_id"/,
    [
      {
        locate: /"role"\."org_id" = \?/,
        reason: 'The root role is an own control; this case independently mutates the child join.',
      },
    ],
    '(1 = 1)',
  ),
];
