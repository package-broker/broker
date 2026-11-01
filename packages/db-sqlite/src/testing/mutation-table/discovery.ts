import { expect } from 'vitest';
import { createDiscoveryRepositoryReader } from '../../repositories/discovery.js';
import { executing, factoryEntry } from './factory-cases.js';
import { seedSource } from './fixtures.js';
import { orgOf, seeder } from './harness.js';

export const entries = ['has', 'hasSourceName'].map((method) =>
  factoryEntry(
    'discovery',
    'createDiscoveryRepositoryReader',
    {
      name: `${method} excludes a foreign organization source`,
      async run(context) {
        const { own, foreign } = orgOf(context);
        const seed = seeder(context.executor);
        await seedSource(seed, 'DS', foreign.orgId, 'vcs', 'npm');
        await seed(
          'UPDATE source SET name=?,config_json=? WHERE id=?',
          'widget',
          JSON.stringify({ provider: 'github', repository: 'owner/repo' }),
          'DS',
        );
        const reader = createDiscoveryRepositoryReader(executing(context));
        expect(
          await (method === 'has'
            ? reader.has(own, 'owner/repo', 'npm')
            : reader.hasSourceName(own, 'widget')),
        ).toBe(false);
      },
    },
    /"org_id" = \?/,
  ),
);
