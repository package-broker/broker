import { expect } from 'vitest';
import { createSourceRepository } from '../../repositories/source.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE, OWNER, seedProject, seedSource } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignSource: ContractCase = {
  name: 'the source factory rejects a foreign child of an own project',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', foreign.orgId, 'vcs');
    await seed("UPDATE source SET project_id = 'P' WHERE id = 'S'");
    expect(await createSourceRepository(executing(context)).get(own, 'S')).toBeNull();
  },
};
const foreignPoll: ContractCase = {
  name: 'polling an own job preserves a foreign source child of an own project',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedProject(seed, 'P', own.orgId);
    await seedSource(seed, 'S', foreign.orgId, 'vcs');
    await seed("UPDATE source SET project_id = 'P' WHERE id = 'S'");
    await seed(
      "INSERT INTO job (id, org_id, type, idempotency_key, resource_key, state, lease_owner, lease_until, fence) VALUES ('J', ?, 'test:poll:v1', 'poll', 'source:S', 'running', ?, ?, 3)",
      own.orgId,
      OWNER,
      FUTURE,
    );
    const read = () =>
      context.executor.all({ sql: "SELECT * FROM source WHERE id = 'S'", params: [] });
    const before = await read();
    expect(
      await createSourceRepository(executing(context)).pollState(
        own,
        { id: 'J', owner: OWNER, fence: 3 },
        { id: 'S', outcome: 'success' },
      ),
    ).toBe('not_found');
    expect(await read()).toEqual(before);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('source', 'createSourceRepository', foreignSource, /"org_id" = \?/),
  factoryEntry('source', 'createSourceRepository', foreignPoll, /"org_id" = \?/, [
    {
      locate: /(?:job|polling)\.org_id = \?/,
      reason:
        'The live own job and its source resource key are controls; jobLeaseGuard has independent organization mutation registrations.',
    },
  ]),
];
