import { expect } from 'vitest';
import { createRegistryPolicyReader } from '../../repositories/registry-policy-read.js';
import { seedMember, seedRule } from '../../contract/registry-policy-fixture.js';
import { executing } from './factory-cases.js';
import { NOT_NULL, seedProject } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const RULE = '01J0P0000000000000000000R1';
const FOREIGN_RULE = '01J0P0000000000000000000F1';
const FORGED_RULE = '01J0P0000000000000000000G1';
const OTHER_PROJECT_RULE = '01J0P0000000000000000000P1';

const foreignSnapshot: ContractCase = {
  name: 'policy snapshot excludes foreign rules, members, projects and epochs',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'PROJECT', own.orgId);
    await seedProject(seed, 'FOREIGN', foreign.orgId);
    await seedRule(seed, { id: RULE, orgId: own.orgId });
    await seedMember(seed, own.orgId, RULE, '1.0.0');
    await seedRule(seed, { id: FOREIGN_RULE, orgId: foreign.orgId });
    await seedMember(seed, foreign.orgId, FOREIGN_RULE, '2.0.0');
    await seedMember(seed.forged, own.orgId, FOREIGN_RULE, '3.0.0');
    await seedRule(seed.forged, { id: FORGED_RULE, orgId: own.orgId, projectId: 'FOREIGN' });
    await seedMember(seed.forged, own.orgId, FORGED_RULE, '4.0.0');
    await seedRule(seed, { id: OTHER_PROJECT_RULE, orgId: own.orgId, projectId: 'PROJECT' });
    await seedMember(seed, own.orgId, OTHER_PROJECT_RULE, '5.0.0');
    const reader = createRegistryPolicyReader(executing(context));
    const snapshot = reader.snapshot(own, {
      ecosystem: 'npm',
      projectId: 'FOREIGN',
      packageKey: 'left-pad',
    });
    await expect(snapshot).resolves.toMatchObject({
      rules: [{ id: RULE, members: ['1.0.0'] }],
    });
    expect((await snapshot).rules).toHaveLength(1);
  },
};

const foreignNamespace: ContractCase = {
  name: 'policy namespace excludes foreign rules, members, projects and epochs',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'PROJECT', own.orgId);
    await seedProject(seed, 'FOREIGN', foreign.orgId);
    await seedRule(seed, { id: RULE, orgId: own.orgId });
    await seedMember(seed, own.orgId, RULE, '1.0.0');
    await seedRule(seed, { id: FOREIGN_RULE, orgId: foreign.orgId });
    await seedMember(seed, foreign.orgId, FOREIGN_RULE, '2.0.0');
    await seedMember(seed.forged, own.orgId, FOREIGN_RULE, '3.0.0');
    await seedRule(seed.forged, { id: FORGED_RULE, orgId: own.orgId, projectId: 'FOREIGN' });
    await seedMember(seed.forged, own.orgId, FORGED_RULE, '4.0.0');
    await seedRule(seed, { id: OTHER_PROJECT_RULE, orgId: own.orgId, projectId: 'PROJECT' });
    await seedMember(seed, own.orgId, OTHER_PROJECT_RULE, '5.0.0');
    const reader = createRegistryPolicyReader(executing(context));
    const namespace = reader.namespace!(own, { ecosystem: 'npm', projectId: 'FOREIGN' });
    await expect(namespace).resolves.toMatchObject({ rules: [{ id: RULE, members: ['1.0.0'] }] });
    expect((await namespace)?.rules).toHaveLength(1);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/registry-policy-read.ts',
    builder: 'createRegistryPolicyReader',
    cases: [foreignSnapshot, foreignNamespace],
    predicates: [
      {
        name: 'the epoch is the organization epoch',
        locate: /(?<![\w".])"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSnapshot.name,
      },
      {
        name: 'rules belong to the organization',
        locate: /"r"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSnapshot.name,
      },
      {
        name: 'members belong to the organization',
        locate: /"m"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSnapshot.name,
      },
      {
        name: 'members join their rule within the organization',
        locate: /"r"\."org_id" = "m"\."org_id"/,
        neutral: '1 = 1',
        copies: 1,
        caseName: foreignSnapshot.name,
      },
      {
        name: 'a project rule applies only to its own project',
        locate: /"r"\."project_id" = \?/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: foreignSnapshot.name,
      },
      {
        name: 'a project rule needs a project of the organization',
        locate: /"p"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: foreignSnapshot.name,
      },
      {
        name: 'namespace: the epoch is the organization epoch',
        locate: /(?<![\w".])"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignNamespace.name,
      },
      {
        name: 'namespace: rules belong to the organization',
        locate: /"r"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignNamespace.name,
      },
      {
        name: 'namespace: members belong to the organization',
        locate: /"m"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignNamespace.name,
      },
      {
        name: 'namespace: members join their rule within the organization',
        locate: /"r"\."org_id" = "m"\."org_id"/,
        neutral: '1 = 1',
        copies: 1,
        caseName: foreignNamespace.name,
      },
      {
        name: 'namespace: a project rule applies only to its own project',
        locate: /"r"\."project_id" = \?/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: foreignNamespace.name,
      },
      {
        name: 'namespace: a project rule needs a project of the organization',
        locate: /"p"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: foreignNamespace.name,
      },
    ],
  },
];
