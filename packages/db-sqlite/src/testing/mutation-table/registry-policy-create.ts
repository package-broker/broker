import { expect } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import { createRegistryPolicyStore } from '../../repositories/registry-policy-create.js';
import { policyAuthorityGuard } from '../../repositories/registry-policy-authority.js';
import { policyFixture, seedRule } from '../../contract/registry-policy-fixture.js';
import { executing } from './factory-cases.js';
import {
  ANCHORS,
  NOT_NULL,
  fenceOf,
  held,
  permissionRowsWaiver,
  ref,
  seedBindings,
  seedProject,
  seedSubject,
} from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry, type OrgWaiver } from './harness.js';

/** actorAuthority comparisons of the policy authority guard; registered in actor-authority.ts. */
export const policyAuthorityWaivers: readonly OrgWaiver[] = [
  permissionRowsWaiver,
  {
    locate: ref('actor', 'org_id', '"s"\\."org_id"'),
    reason:
      'policyAuthorityGuard delegates to actorAuthority; its actor join is registered in actor-authority.ts.',
  },
  {
    locate: ref('i', 'org_id', '"s"\\."org_id"'),
    reason:
      'policyAuthorityGuard delegates to actorAuthority; the session identity join is registered in actor-authority.ts.',
  },
  {
    locate: ref('s', 'org_id', '\\?'),
    reason:
      'policyAuthorityGuard delegates to actorAuthority; the session scope is registered in actor-authority.ts and identity-block.ts.',
  },
  {
    locate: ref('hp_session', 'org_id', '\\?'),
    reason: 'holdsPermission local-admin eligibility, registered with the access builders.',
  },
  {
    locate: ref('hp_project', 'org_id', '\\?'),
    reason:
      'holdsPermission active-project check of a project rule, registered with the access builders.',
  },
];

/** The epoch replacement of assertGuard and the epoch read of runOrgFenced after a refusal. */
export const policyEpochWaivers: readonly OrgWaiver[] = [
  {
    locate: /(?<=update "cache_epoch" set [^;]*? where )"org_id" = \?/,
    reason: 'assertGuard cache epoch predicate is registered by its shared builder.',
  },
  {
    locate: /(?<=from "cache_epoch" where )"org_id" = \?/,
    reason:
      'runOrgFenced reads the epoch row only to diagnose a missing row after a refused batch; cache-epoch registers its organization scope.',
  },
];

const foreignCap: ContractCase = {
  name: 'rules of another organization do not count toward the rule cap',
  async run(context) {
    const f = await policyFixture(context.executor, context);
    const { foreign } = orgOf(context);
    for (let n = 0; n < 256; n += 1) {
      await seedRule(f.seed, { id: ulid(), orgId: foreign.orgId, kind: 'min_age' });
      await seedRule(f.seed, { id: ulid(), orgId: foreign.orgId });
    }
    const input = f.create();
    const outcome = await createRegistryPolicyStore(executing(context), ANCHORS).create(
      f.org,
      f.decideFence,
      input,
    );
    expect(outcome).toEqual({ ok: true, revision: 1 });
    expect(await f.rule(input.id)).toMatchObject({ org_id: f.org.orgId });
  },
};

const foreignProjectAuthority: ContractCase = {
  name: 'organization policy authority does not cover a project of another organization',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    await seedProject(seed, 'P-OWN', own.orgId);
    await seedProject(seed, 'P-FOREIGN', foreign.orgId);
    const subject = await seedSubject(context, 'manager');
    const guardFor = (projectId: string) =>
      policyAuthorityGuard(own, fenceOf(subject), {
        scope: { kind: 'project', projectId },
        kind: 'min_age',
        fresh: false,
        providerAnchors: ANCHORS,
      });
    expect(await held(context, guardFor('P-OWN'), false)).toBe(true);
    expect(await held(context, guardFor('P-FOREIGN'), true)).toBe(false);
  },
};

const foreignCollision: ContractCase = {
  name: 'a rule id taken in another organization is not reported as a conflict',
  async run(context) {
    const f = await policyFixture(context.executor, context);
    const id = ulid();
    await seedRule(f.seed, { id, orgId: orgOf(context).foreign.orgId });
    expect(
      await createRegistryPolicyStore(executing(context), ANCHORS).create(
        f.org,
        f.decideFence,
        f.create({ id }),
      ),
    ).toEqual({ ok: false, reason: 'indeterminate' });
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/registry-policy-authority.ts',
    builder: 'policyAuthorityGuard',
    cases: [foreignProjectAuthority],
    predicates: [
      {
        name: 'organization authority over a project rule needs a project of the organization',
        locate: ref('pa_project', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: foreignProjectAuthority.name,
      },
    ],
    waivers: [...policyAuthorityWaivers],
  },
  {
    file: 'repositories/registry-policy-create.ts',
    builder: 'createRegistryPolicyStore',
    cases: [foreignCap, foreignCollision],
    predicates: [
      {
        name: 'the failure probe looks for a colliding id only in the organization',
        locate: /(?<=from "registry_policy_rule" where "id" = \? and )"org_id" = \?/,
        neutral: NOT_NULL,
        caseName: foreignCollision.name,
      },
      {
        name: 'the rule cap counts only rules of the organization',
        locate: /(?<![\w".])org_id = \?/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: foreignCap.name,
      },
    ],
    waivers: [...policyAuthorityWaivers, ...policyEpochWaivers],
  },
];
