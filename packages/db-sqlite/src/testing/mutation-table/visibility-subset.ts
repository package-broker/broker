import { entries as storeEntries } from './catalogue-writer.js';
import { expect } from 'vitest';
import { createVisibilitySubsetRepository } from '../../repositories/visibility-subset.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ANCHORS, fenceOf, seedBindings, seedSubject } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
import { visiblePackage } from './catalogue-factory-fixture.js';
const store = storeEntries.find((entry) => entry.builder === 'createVisibilityStore')!;
const methods = ['addPattern', 'removePattern', 'addExplicit', 'removeExplicit'];
const storeCases = store.cases.filter(
  (test) =>
    methods.some((method) => test.name.startsWith(method)) ||
    test.name.includes('foreign patterns'),
);

const foreignMembership: ContractCase = {
  name: 'explicit visibility removal preserves a foreign membership child of an own project',
  async run(context) {
    await visiblePackage(context, true);
    const { own } = orgOf(context);
    await seedBindings(context);
    const subject = await seedSubject(context, 'actor', { projectId: 'P' });
    await seeder(context.executor)(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-actor', 'project:packages:manage')",
      own.orgId,
    );
    expect(
      await createVisibilitySubsetRepository(executing(context)).removeExplicit(
        own,
        fenceOf(subject),
        { projectId: 'P', packageId: 'K', providerAnchors: ANCHORS },
      ),
    ).toBe('not_found');
    expect(
      await context.executor.all({
        sql: "SELECT origin FROM project_package WHERE project_id = 'P' AND package_id = 'K'",
        params: [],
      }),
    ).toEqual([{ origin: 'explicit' }]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'visibility-subset',
    'createVisibilitySubsetRepository',
    foreignMembership,
    /(?<=delete from "project_package" where )"org_id" = \?/,
    [
      {
        locate:
          /(?<=from "package" where "id" = \? and )"org_id" = \?|(?<=from "project" where )"org_id" = \?/,
        reason:
          'The own package and project are controls for the foreign membership deletion; project authority is covered by actorHolds.',
      },
      {
        locate: /(?<=cache_epoch[^;]{0,100})"org_id" = \?/,
        reason:
          'runOrgFenced delegates the unchanged epoch bump; cache-epoch-bump independently mutation-tests its scope.',
      },
      {
        locate: /"(?:actor|s|i|hp_session|guard_\w+)"\."org_id" = /,
        reason:
          'Actor authority and rederived attachment/admission guards delegate unchanged to independently registered actorHolds, permissionRows and catalogue-predicates.',
      },
      {
        locate: /(?<=from "package" where )"org_id" = \?/,
        reason: 'The own package is a parent control for the foreign membership mutation.',
      },
      {
        locate:
          /"(?:project_package|stay_package|derive_attachment|derive_package)"\."org_id" = \?|derive_include\.org_id = \?/,
        reason:
          'The unchanged rederiveStatements tail has independent remove, retag, stay and insert registrations in visibility-derive.ts.',
      },
    ],
  ),
  {
    ...store,
    file: 'repositories/visibility-subset.ts',
    builder: 'createVisibilitySubsetRepository',
    cases: storeCases,
    predicates: store.predicates.filter((predicate) =>
      storeCases.some((test) => test.name === predicate.caseName),
    ),
  },
];
