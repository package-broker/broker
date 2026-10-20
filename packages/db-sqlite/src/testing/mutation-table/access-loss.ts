import { expect } from 'vitest';
import { grantGroupMembersStatement } from '../../repositories/access-loss.js';
import { ALWAYS, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

function foreignCase(layer: 'grant' | 'member'): ContractCase {
  return {
    name: `group revoke ignores a foreign ${layer}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seed(
        "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'reader', 'Reader', 'organization')",
        layer === 'grant' ? foreign.orgId : own.orgId,
      );
      await seed(
        "INSERT INTO user_account (id, org_id, email) VALUES ('U', ?, 'user@example.test')",
        foreign.orgId,
      );
      await seed(
        "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, role_id) VALUES ('G', ?, 'group', 'staff', 'oidc', 'organization', 'R')",
        layer === 'grant' ? foreign.orgId : own.orgId,
      );
      await seed(
        "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, 'U', 'oidc', 'staff')",
        foreign.orgId,
      );
      expect(
        await context.executor.all(context.mutate(grantGroupMembersStatement(own, 'G'))),
      ).toEqual([]);
    },
  };
}

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/access-loss.ts',
    builder: 'grantGroupMembersStatement',
    cases: [foreignCase('grant'), foreignCase('member')],
    predicates: [
      {
        name: 'removed grant belongs to the organization',
        locate: /removed\.org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignCase('grant').name,
      },
      {
        name: 'stored member belongs to the grant organization',
        locate: /member\.org_id = removed\.org_id/,
        neutral: ALWAYS,
        copies: 1,
        caseName: foreignCase('member').name,
      },
    ],
  },
];
