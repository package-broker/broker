import { expect } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createRegistryPolicyMembers } from '../../repositories/registry-policy-members.js';
import { policyFixture, seedMember, seedRule } from '../../contract/registry-policy-fixture.js';
import { executing } from './factory-cases.js';
import { ANCHORS, NOT_NULL } from './fixtures.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';
import { policyAuthorityWaivers, policyEpochWaivers } from './registry-policy-create.js';

const replace = (id: string, members: readonly string[]) => ({
  id,
  expectedRevision: 1,
  members,
  now: new Date().toISOString(),
  audit: {
    id: ulid(),
    occurredAt: new Date().toISOString(),
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
  },
});

const foreignRule: ContractCase = {
  name: 'member replacement cannot read a rule of another organization',
  async run(context) {
    const f = await policyFixture(context.executor, context);
    const id = ulid();
    await seedRule(f.seed, { id, orgId: orgOf(context).foreign.orgId });
    await expect(
      createRegistryPolicyMembers(executing(context), ANCHORS).replace(
        f.org,
        f.decideFence,
        replace(id, []),
      ),
    ).resolves.toEqual({ ok: false, reason: 'not_found' });
  },
};

const foreignMembers: ContractCase = {
  name: 'member replacement ignores and keeps foreign member rows naming the rule',
  async run(context) {
    const f = await policyFixture(context.executor, context);
    const { foreign } = orgOf(context);
    const id = ulid();
    await seedRule(f.seed, { id, orgId: f.org.orgId });
    await seedMember(f.seed, f.org.orgId, id, '1.0.0');
    await seedMember(f.seed.forged, foreign.orgId, id, '9.9.9');
    await expect(
      createRegistryPolicyMembers(executing(context), ANCHORS).replace(
        f.org,
        f.decideFence,
        replace(id, ['1.0.0', '2.0.0']),
      ),
    ).resolves.toEqual({ ok: true, revision: 2 });
    expect(
      await context.executor.all({
        sql: 'SELECT org_id, version_normalized FROM registry_policy_version WHERE rule_id = ? ORDER BY org_id, version_normalized',
        params: [id],
      }),
    ).toEqual(
      [
        { org_id: f.org.orgId, version_normalized: '1.0.0' },
        { org_id: f.org.orgId, version_normalized: '2.0.0' },
        { org_id: foreign.orgId, version_normalized: '9.9.9' },
      ].sort((a, b) => a.org_id.localeCompare(b.org_id)),
    );
  },
};

const movedRule: ContractCase = {
  name: 'member replacement writes nothing once the rule belongs to another organization',
  async run(context) {
    const f = await policyFixture(context.executor, context);
    const { foreign } = orgOf(context);
    const id = ulid();
    await seedRule(f.seed, { id, orgId: f.org.orgId });
    const inner = executing(context);
    let moved = false;
    const racing: SqlExecutor = {
      driver: inner.driver,
      all: (statement) => inner.all(statement),
      async batch(statements) {
        if (moved) return inner.batch(statements);
        moved = true;
        const read = await inner.batch(statements);
        await f.seed.forged(
          'UPDATE registry_policy_rule SET org_id = ? WHERE id = ?',
          foreign.orgId,
          id,
        );
        return read;
      },
    };
    expect(
      await createRegistryPolicyMembers(racing, ANCHORS).replace(
        f.org,
        f.decideFence,
        replace(id, []),
      ),
    ).toEqual({ ok: false, reason: 'conflict' });
    expect(await f.rule(id)).toMatchObject({ org_id: foreign.orgId, revision: 1 });
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/registry-policy-members.ts',
    builder: 'createRegistryPolicyMembers',
    cases: [foreignRule, foreignMembers, movedRule],
    predicates: [
      {
        name: 'a refused batch reads the rule revision within the organization',
        locate:
          /(?<=select "id" from "registry_policy_rule" where )"org_id" = \?(?= and "id" = \? and "revision" = \?)/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: movedRule.name,
      },
      {
        name: 'the rule is read within the organization',
        locate: /"r"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignRule.name,
      },
      {
        name: 'the current members are read within the organization',
        locate: /"m"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignMembers.name,
      },
      {
        name: 'the replacement deletes only members of the organization',
        locate: /(?<=DELETE FROM registry_policy_version WHERE )org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignMembers.name,
      },
      {
        name: 'the final member count covers only the organization',
        locate: /(?<=registry_policy_version\s+where )org_id = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignMembers.name,
      },
      {
        name: 'the revision bump targets a rule of the organization',
        locate: /(?<=update "registry_policy_rule" set [^;]*? where )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: movedRule.name,
      },
    ],
    waivers: [...policyAuthorityWaivers, ...policyEpochWaivers],
  },
];
