import { sql } from 'kysely';
import { expect } from 'vitest';
import { compile, db } from '../../kysely.js';
import { sourceSelectionCondition } from '../../repositories/source-selection.js';
import { orgOf, seeder, type ContractCase, type MutationEntry, type OrgWaiver } from './harness.js';
import { NOT_NULL, seedSource } from './fixtures.js';

function foreignCase(kind: 'source' | 'registration'): ContractCase {
  return {
    name: `selection excludes a foreign ${kind}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', kind === 'source' ? foreign.orgId : own.orgId, 'vcs');
      await seed.forged(
        "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'composer', 'acme/*')",
        kind === 'registration' ? foreign.orgId : own.orgId,
      );
      const rows = await context.executor.all(
        context.mutate(
          compile(
            db.selectNoFrom(
              sql<number>`(${sourceSelectionCondition(own, 'S', 'composer', 'acme/p')})`.as(
                'selected',
              ),
            ),
          ),
        ),
      );
      expect(rows).toEqual([{ selected: 0 }]);
    },
  };
}
const source = foreignCase('source');
const registration = foreignCase('registration');
const unconfigured: ContractCase = {
  name: 'foreign registrations do not configure an own unconfigured source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('R', ?, 'S', 'composer', 'acme/*')",
      foreign.orgId,
    );
    expect(
      await context.executor.all(
        context.mutate(
          compile(
            db.selectNoFrom(
              sql<number>`(${sourceSelectionCondition(own, 'S', 'composer', 'acme/p', true)})`.as(
                'selected',
              ),
            ),
          ),
        ),
      ),
    ).toEqual([{ selected: 1 }]);
  },
};

export const selectionOrgWaivers: readonly OrgWaiver[] = [
  {
    locate: /selection_source\.org_id = \?/,
    reason: 'Composed sourceSelectionCondition has an isolated source organization mutation case.',
  },
  {
    locate: /rn_cov\.org_id = \?/,
    reason:
      'Composed sourceSelectionCondition has an isolated registration organization mutation case.',
  },
  {
    locate: /selection_registration\.org_id = \?/,
    reason:
      'Composed sourceSelectionCondition tests that foreign registrations cannot suppress unconfigured-source reconciliation.',
  },
];

export const entries: readonly MutationEntry[] = [
  {
    builder: 'sourceSelectionCondition',
    file: 'repositories/source-selection.ts',
    cases: [source, registration, unconfigured],
    predicates: [
      {
        name: 'source organization',
        locate: /selection_source\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: source.name,
      },
      {
        name: 'registration organization',
        locate: /rn_cov\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: registration.name,
      },
      {
        name: 'unconfigured registration organization',
        locate: /selection_registration\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: unconfigured.name,
      },
    ],
  },
];
