import { expect } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import { selectedPatInvalidationStatement } from '../../repositories/access-loss.js';
import { ALWAYS, NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

type Layer = 'token' | 'owner' | 'removed' | 'member' | 'bound' | 'reach' | 'via' | 'lost';
const layers: readonly Layer[] = [
  'token',
  'owner',
  'removed',
  'member',
  'bound',
  'reach',
  'via',
  'lost',
];
function foreignCase(layer: Layer): ContractCase {
  return {
    name: `selected invalidation scopes ${layer} to the organization`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      const org = (part: Layer) =>
        part === layer ||
        (layer === 'token' && part === 'owner') ||
        (layer === 'removed' && part === 'member')
          ? foreign.orgId
          : own.orgId;
      await seed(
        "INSERT INTO user_account (id, org_id, email) VALUES ('U', ?, 'user@example.test')",
        org('owner'),
      );
      await seed(
        "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'reader', 'Reader', 'organization')",
        own.orgId,
      );
      await seed(
        "INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'p', 'P')",
        own.orgId,
      );
      const id = ulid();
      await (layer === 'owner' ? seed.forged : seed)(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at, project_mode, created_at)
        VALUES (?, ?, 'pat', 'abcdefabcdef', ?, 1, 'test', '["read"]', 'U', '2999-01-01T00:00:00.000Z', 'selected', '2020-01-01T00:00:00.000Z')`,
        id,
        org('token'),
        'a'.repeat(64),
      );
      // The first four layers test affected-user selection. The others test remaining access.
      const targeting = ['token', 'owner', 'removed', 'member', 'lost'].includes(layer);
      if (layer === 'lost') {
        await seed.forged(
          "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, 'U', 'oidc', 'removed')",
          foreign.orgId,
        );
      } else if (layer === 'removed') {
        await seed.forged(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('removed', ?, 'email', 'user@example.test', 'organization', 'R')",
          foreign.orgId,
        );
      } else if (layer === 'member') {
        await seed(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_provider, subject_value, scope, role_id) VALUES ('removed', ?, 'group', 'oidc', 'removed', 'organization', 'R')",
          org('removed'),
        );
        await seed.forged(
          "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, 'U', 'oidc', 'removed')",
          org('member'),
        );
      } else if (!targeting) {
        await (layer === 'bound' ? seed.forged : seed)(
          "INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, 'P')",
          org('bound'),
          id,
        );
        await (layer === 'reach' ? seed.forged : seed)(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_provider, subject_value, scope, project_id, role_id, created_at) VALUES ('held', ?, 'group', 'oidc', 'held', 'project', 'P', 'R', '2020-01-01T00:00:00.000Z')",
          org('reach'),
        );
        await (layer === 'via' ? seed.forged : seed)(
          "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, 'U', 'oidc', 'held')",
          org('via'),
        );
      }
      const statement = selectedPatInvalidationStatement(own, {
        opId: ulid(),
        at: '2026-10-20T12:00:00.000Z',
        ...(layer === 'lost' ? { membership: { provider: 'oidc', groups: [] } } : {}),
        ...(['removed', 'member'].includes(layer) ? { grantId: 'removed' } : { userId: 'U' }),
      });
      await context.executor.batch([context.mutate(statement)]);
      const jobs = await context.executor.all({ sql: 'SELECT id FROM job', params: [] });
      expect(jobs).toHaveLength(targeting ? 0 : 1);
    },
  };
}
const predicates = [
  ['token', /token\.org_id = \?/, NOT_NULL],
  ['owner', /owner\.org_id = token\.org_id/, ALWAYS],
  ['removed', /removed\.org_id = owner\.org_id/, ALWAYS],
  ['member', /member\.org_id = owner\.org_id/, ALWAYS],
  ['bound', /bound\.org_id = token\.org_id/, ALWAYS],
  ['reach', /reach\.org_id = owner\.org_id/, ALWAYS],
  ['via', /via\.org_id = owner\.org_id/, ALWAYS],
  ['lost', /\+?lost\.org_id = owner\.org_id/, ALWAYS],
] as const;
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/access-loss.ts',
    builder: 'selectedPatInvalidationStatement',
    cases: layers.map(foreignCase),
    predicates: predicates.map(([layer, locate, neutral]) => ({
      name: `${layer} belongs to the organization`,
      locate,
      neutral,
      copies: 1,
      caseName: foreignCase(layer).name,
    })),
  },
];
