import { expect } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createRegistryPolicyUpdater } from '../../repositories/registry-policy-update.js';
import { policyFixture, seedRule } from '../../contract/registry-policy-fixture.js';
import { executing } from './factory-cases.js';
import { ANCHORS, NOT_NULL } from './fixtures.js';
import { orgOf, type ContractCase, type MutationEntry } from './harness.js';
import { policyAuthorityWaivers, policyEpochWaivers } from './registry-policy-create.js';

const patch = (id: string) => ({
  id,
  expectedRevision: 1,
  patch: { minAgeSeconds: 1209600 },
  now: new Date().toISOString(),
  audit: {
    id: ulid(),
    occurredAt: new Date().toISOString(),
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
  },
});

const foreignRead: ContractCase = {
  name: 'a rule update cannot read a rule of another organization',
  async run(context) {
    const f = await policyFixture(context.executor, context);
    const id = ulid();
    await seedRule(f.seed, {
      id,
      orgId: orgOf(context).foreign.orgId,
      kind: 'min_age',
      packageKey: null,
    });
    expect(
      await createRegistryPolicyUpdater(executing(context), ANCHORS).update(
        f.org,
        f.decideFence,
        patch(id),
      ),
    ).toEqual({ ok: false, reason: 'not_found' });
  },
};

const movedRule: ContractCase = {
  name: 'a rule update writes nothing once the rule belongs to another organization',
  async run(context) {
    const f = await policyFixture(context.executor, context);
    const { foreign } = orgOf(context);
    const id = ulid();
    await seedRule(f.seed, { id, orgId: f.org.orgId, kind: 'min_age', packageKey: null });
    const inner = executing(context);
    const racing: SqlExecutor = {
      driver: inner.driver,
      all: (statement) => inner.all(statement),
      async batch(statements) {
        await f.seed.forged(
          'UPDATE registry_policy_rule SET org_id = ? WHERE id = ?',
          foreign.orgId,
          id,
        );
        return inner.batch(statements);
      },
    };
    expect(
      await createRegistryPolicyUpdater(racing, ANCHORS).update(f.org, f.decideFence, patch(id)),
    ).toEqual({ ok: false, reason: 'conflict' });
    expect(await f.rule(id)).toMatchObject({
      org_id: foreign.orgId,
      min_age_seconds: 86400,
      revision: 1,
    });
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/registry-policy-update.ts',
    builder: 'createRegistryPolicyUpdater',
    cases: [foreignRead, movedRule],
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
        name: 'the current rule is read within the organization',
        locate: /"r"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignRead.name,
      },
      {
        name: 'the revisioned update targets a rule of the organization',
        locate: /(?<=update "registry_policy_rule" set [^;]*? where )"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: movedRule.name,
      },
    ],
    waivers: [...policyAuthorityWaivers, ...policyEpochWaivers],
  },
];
