import { expect } from 'vitest';
import { createRegisteredNameRepository } from '../../repositories/registered-name.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ANCHORS, NOT_NULL, fenceOf, seedBindings, seedSubject, seedSource } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignName: ContractCase = {
  name: 'registered name removal rejects a foreign child of an own source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedBindings(context);
    const subject = await seedSubject(context, 'actor');
    await seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-actor', 'org:sources:write')",
      own.orgId,
    );
    await seedSource(seed, 'S', own.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('N', ?, 'S', 'composer', 'acme/*')",
      foreign.orgId,
    );
    expect(
      await createRegisteredNameRepository(executing(context)).remove(own, fenceOf(subject), {
        id: 'N',
        providerAnchors: ANCHORS,
        audit: {
          id: 'A-REMOVE',
          actor: { type: 'user', id: subject.userId },
          action: 'registered_name.remove',
          target: { type: 'registered_name', id: 'N' },
          occurredAt: new Date().toISOString(),
          tokenSelector: null,
          sourceIp: null,
          projectId: null,
          payloadJson: '{}',
        },
        pauseAudit: {
          id: 'A',
          actor: { type: 'user', id: subject.userId },
          action: 'source.pause',
          target: { type: 'source', id: 'different-source' },
          occurredAt: new Date().toISOString(),
          tokenSelector: null,
          sourceIp: null,
          projectId: null,
          payloadJson: '{}',
        },
      }),
    ).toBe('not_found');
  },
};
const foreignPageName: ContractCase = {
  name: 'registered-name pages exclude a foreign name referencing an own source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('N', ?, 'S', 'composer', 'acme/*')",
      foreign.orgId,
    );
    expect(
      await createRegisteredNameRepository(executing(context)).list(own, {
        sourceId: 'S',
        limit: 1,
      }),
    ).toEqual({ items: [], next: null });
  },
};
const foreignPageSource: ContractCase = {
  name: 'registered-name pages exclude an own name referencing a foreign source',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', foreign.orgId, 'vcs');
    await seed.forged(
      "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('N', ?, 'S', 'composer', 'acme/*')",
      own.orgId,
    );
    expect(
      await createRegisteredNameRepository(executing(context)).list(own, {
        sourceId: 'S',
        limit: 1,
      }),
    ).toEqual({ items: [], next: null });
  },
};
export const entries: readonly MutationEntry[] = [
  {
    builder: 'createRegisteredNameRepository',
    file: 'repositories/registered-name.ts',
    cases: [foreignPageName, foreignPageSource],
    predicates: [
      {
        name: 'page names belong to the organization',
        locate: /"names"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignPageName.name,
      },
      {
        name: 'page sources belong to the organization',
        locate: /"owner"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignPageSource.name,
      },
    ],
  },
  factoryEntry(
    'registered-name',
    'createRegisteredNameRepository',
    foreignName,
    /(?<=from "registered_name" where )"org_id" = \?/,
    [
      {
        locate: /"(?:actor|s|i|hp_session|guard_\w+)"\."org_id" = /,
        reason:
          'The actor is an own control; actorHolds and permissionRows have independent mismatched-child registrations.',
      },
    ],
  ),
];
