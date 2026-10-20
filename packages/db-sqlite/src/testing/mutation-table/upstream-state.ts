import { expect } from 'vitest';
import { createUpstreamStateRepository } from '../../repositories/upstream-state.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE, seedSource, seedPackage } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';

const foreignState: ContractCase = {
  name: 'upstream state reads reject a foreign child of an own package',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
    await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
    await seed(
      "INSERT INTO upstream_state (org_id, package_id, form, checked_at, fresh_until) VALUES (?, 'K', 'npm-packument', ?, ?)",
      foreign.orgId,
      FUTURE,
      FUTURE,
    );
    expect(
      await createUpstreamStateRepository(executing(context)).get(own, 'K', 'npm-packument'),
    ).toBeNull();
  },
};
function foreignWrite(operation: 'touch' | 'publish' | 'notFound'): ContractCase {
  return {
    name: `upstream ${operation} preserves a foreign state child of an own package`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      await seedSource(seed, 'S', own.orgId, 'npm_registry', 'npm');
      await seedPackage(seed, 'K', own.orgId, 'S', 'widget', 'npm');
      await seed(
        "INSERT INTO upstream_state (org_id, package_id, form, etag, checked_at, fresh_until, not_found_count) VALUES (?, 'K', 'npm-packument', 'foreign', ?, ?, 2)",
        foreign.orgId,
        FUTURE,
        FUTURE,
      );
      const read = () =>
        context.executor.all({
          sql: "SELECT * FROM upstream_state WHERE package_id = 'K'",
          params: [],
        });
      const before = await read();
      const repository = createUpstreamStateRepository(context.executor);
      const statements =
        operation === 'touch'
          ? repository.touchStatements(own, 'K', 'npm-packument', 60)
          : operation === 'publish'
            ? repository.publishStatements(
                own,
                'K',
                'npm-packument',
                { etag: 'own', lastModified: null, contentSha256: null },
                60,
              )
            : repository.notFoundStatements(own, 'K', 'npm-packument', 60);
      await context.executor.batch(context.mutateBatch(statements));
      expect(await read()).toEqual(before);
    },
  };
}
export const entries: readonly MutationEntry[] = [
  factoryEntry('upstream-state', 'createUpstreamStateRepository', foreignState, /"org_id" = \?/),
  ...(['touch', 'publish', 'notFound'] as const).map((operation) =>
    factoryEntry(
      'upstream-state',
      'createUpstreamStateRepository',
      foreignWrite(operation),
      operation === 'touch' ? /"org_id" = \?/ : /"upstream_state"\."org_id" = \?/,
      [
        {
          locate: /"package"\."org_id" = \?/,
          reason:
            'The package is an own control for the foreign state conflict; its source selection is independent of the existing state row.',
        },
      ],
    ),
  ),
];
