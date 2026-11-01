import { expect } from 'vitest';
import { orgContext } from '@package-broker/core/db/port';
import { createNpmTokenAdapters } from '../../repositories/npm-tokens.js';
import { anchors, input, seedNpmTokens } from '../../contract/npm-tokens-contract.js';
import { executing } from './factory-cases.js';
import { NOT_NULL } from './fixtures.js';
import type { ContractCase, MutationEntry } from './harness.js';

const foreign: ContractCase = {
  name: 'npm revoke cannot mutate a foreign organization token with a forged owner',
  async run(context) {
    await seedNpmTokens(context.executor);
    await context.executor.all({
      sql: "UPDATE token SET user_id='owner' WHERE id='foreign-token'",
      params: [],
    });
    expect(
      await createNpmTokenAdapters(executing(context), async () => anchors).revokeOwn(
        orgContext('org'),
        { ...input, targetId: 'foreign-token' },
      ),
    ).toBe(false);
  },
};
const guards = [
  {
    name: 'caller id',
    change: '',
    override: { tokenId: 'wrong' },
    pattern: /pa.token_id = \?/,
    replacement: '(? is not null)',
  },
  {
    name: 'caller owner',
    change: '',
    override: { userId: 'other', targetId: 'other-token' },
    pattern: /pa.user_id = \?/,
    replacement: '(? is not null)',
  },
  {
    name: 'revocation',
    change: "UPDATE token SET revoked_at='2020-01-01' WHERE id='caller'",
    pattern: /pa.revoked_at is null/,
    replacement: '1=1',
  },
  {
    name: 'expiry',
    change: "UPDATE token SET expires_at='2020-01-01' WHERE id='caller'",
    pattern: /pa.expired = 0/,
    replacement: '1=1',
  },
  {
    name: 'invalidation',
    change: "UPDATE user_account SET pat_invalid_before='2099-01-01' WHERE id='owner'",
    pattern: /pa.stamp_invalid = 0/,
    replacement: '1=1',
  },
  {
    name: 'freshness',
    change: "UPDATE identity SET validated_at='2020-01-01' WHERE id='identity'",
    pattern: /pa.validation_fresh = 1/,
    replacement: '1=1',
  },
  {
    name: 'project binding',
    change: "UPDATE token SET project_mode='selected' WHERE id='caller'",
    pattern: /pa.project_id = \?/,
    replacement: '(? is not null)',
  },
  {
    name: 'target kind',
    change:
      "UPDATE token SET kind='svc',user_id=NULL,service_principal_id='service' WHERE id='target'",
    pattern: /"kind" = \? and "user_id" = \?/,
    replacement: '(? is not null) and (? is not null)',
  },
  {
    name: 'target ownership',
    change: "UPDATE token SET user_id='other' WHERE id='target'",
    pattern: /"user_id" = \?/,
    replacement: '(? is not null)',
  },
  {
    name: 'scope cardinality',
    change: `UPDATE token SET scopes_json='["read","read"]' WHERE id='caller'`,
    pattern: /json_array_length\(pa.scopes_json\) = 1/,
    replacement: '1=1',
  },
  {
    name: 'scope capability',
    change: `UPDATE token SET scopes_json='["unknown"]', read_only=0 WHERE id='caller'`,
    pattern: /json_extract\(pa.scopes_json, '\$\[0\]'\) in \('read','write','full'\)/,
    replacement: '1=1',
  },
  {
    name: 'read only consistency',
    change: "UPDATE token SET read_only=0 WHERE id='caller'",
    pattern: /pa.read_only = \(json_extract\(pa.scopes_json, '\$\[0\]'\) = 'read'\)/,
    replacement: '1=1',
  },
  {
    name: 'target revocation',
    change: "UPDATE token SET revoked_at='2020-01-01' WHERE id='target'",
    pattern: /"revoked_at" is null/,
    replacement: '1=1',
  },
  {
    name: 'permission',
    change: "DELETE FROM access_grant WHERE id='grant'",
    pattern:
      /and \(exists \(select 1 from json_each\(json_extract\(pa.access, '\$\.organization'\)\) where value = 'project:read'\)\s+or exists \(select 1 from json_each\(json_extract\(pa.access, '\$\.project'\)\) where value = 'project:read'\)\)/,
    replacement: 'and 1=1',
  },
];
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/npm-tokens.ts',
    builder: 'createNpmTokenAdapters',
    cases: [foreign],
    predicates: [
      {
        name: 'revoke target organization',
        caseName: foreign.name,
        locate: /(?<=update "token" set "revoked_at" = \?, "last_op_id" = \? where )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
    ],
    waivers: [
      {
        locate: /"?\w+"?\."?org_id"? = /,
        reason:
          'The tokenAccessCondition subquery delegates organization joins and scoping to the independently mutation-tested access builder.',
      },
      {
        locate: /(?<![\w".])org_id = \?/,
        reason:
          'The audit marker uses a fresh unique operation id created only by the organization-scoped update in this same atomic batch.',
      },
    ],
    sqlDecisions: guards.map((g) => ({
      name: `npm revoke ${g.name}`,
      pattern: g.pattern,
      replacement: g.replacement,
      expected: 1,
      case: {
        name: `npm revoke refuses changed ${g.name}`,
        async run(context) {
          await seedNpmTokens(context.executor);
          if (g.change) await context.executor.all({ sql: g.change, params: [] });
          expect(
            await createNpmTokenAdapters(executing(context), async () => anchors).revokeOwn(
              orgContext('org'),
              { ...input, ...g.override },
            ),
          ).toBe(false);
        },
      },
    })),
  },
];
