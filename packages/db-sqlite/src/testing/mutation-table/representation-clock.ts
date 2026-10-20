import { expect } from 'vitest';
import { createRepresentationClock } from '../../repositories/representation-clock.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { HASH, NOT_NULL, seedProject } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const OTHER_HASH = 'b'.repeat(64);
const foreignClock: ContractCase = {
  name: 'the representation clock rejects a foreign child of an own project',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seed(
      "INSERT INTO representation_clock (org_id, project_id, key_hash, form, validator, last_modified, package_id, rev) VALUES (?, 'P', ?, 'composer-p2', ?, '2000-01-01T00:00:00Z', 'K', 1)",
      foreign.orgId,
      HASH,
      HASH,
    );
    await expect(
      createRepresentationClock(executing(context)).advance(own, {
        projectId: 'P',
        packageId: 'K',
        keyHash: HASH,
        form: 'composer-p2',
        validator: HASH,
        rev: 1,
      }),
    ).rejects.toThrow('representation clock: project not found');
  },
};
const foreignConflict: ContractCase = {
  name: 'the representation clock does not advance a foreign child of an own project',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seed(
      "INSERT INTO representation_clock (org_id, project_id, key_hash, form, validator, last_modified, package_id, rev) VALUES (?, 'P', ?, 'composer-p2', ?, '2000-01-01T00:00:00Z', 'K', 1)",
      foreign.orgId,
      HASH,
      HASH,
    );
    await expect(
      createRepresentationClock(executing(context)).advance(own, {
        projectId: 'P',
        packageId: 'K',
        keyHash: HASH,
        form: 'composer-p2',
        validator: OTHER_HASH,
        rev: 2,
      }),
    ).rejects.toThrow('representation clock: project not found');
    expect(
      await context.executor.all({
        sql: 'SELECT org_id, validator, rev, package_id, last_modified FROM representation_clock',
        params: [],
      }),
    ).toEqual([
      {
        org_id: foreign.orgId,
        validator: HASH,
        rev: 1,
        package_id: 'K',
        last_modified: '2000-01-01T00:00:00Z',
      },
    ]);
  },
};
const foreignProject: ContractCase = {
  name: 'the representation clock does not write under a foreign project',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'FP', foreign.orgId);
    await expect(
      createRepresentationClock(executing(context)).advance(own, {
        projectId: 'FP',
        packageId: 'K',
        keyHash: HASH,
        form: 'composer-p2',
        validator: HASH,
        rev: 1,
      }),
    ).rejects.toThrow('representation clock: project not found');
    expect(
      await context.executor.all({ sql: 'SELECT org_id FROM representation_clock', params: [] }),
    ).toEqual([]);
  },
};
const base = factoryEntry(
  'representation-clock',
  'createRepresentationClock',
  foreignClock,
  /(?<=from "representation_clock" where )"org_id" = \?/,
  [],
  NOT_NULL,
  2,
);
export const entries: readonly MutationEntry[] = [
  {
    ...base,
    cases: [foreignClock, foreignConflict, foreignProject],
    predicates: [
      ...base.predicates,
      {
        name: foreignConflict.name,
        caseName: foreignConflict.name,
        locate: /"representation_clock"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
      {
        name: foreignProject.name,
        caseName: foreignProject.name,
        locate: /"project"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
      },
    ],
  },
];
