import { expect, it } from 'vitest';
import { assertMigrationsApplied } from './migrations-check.js';

it.each(['pb cloudflare migrate', 'pb cloudflare migrate --prebuilt'] as const)(
  'names the remedy %s for pending expands and applied checksum drift',
  (remedy) => {
    const migration = { id: 'core:0001_init', checksum: 'expected', phase: 'expand' as const };
    for (const ledger of [[], [{ id: migration.id, checksum: 'different' }]]) {
      expect(() => assertMigrationsApplied([migration], ledger, remedy)).toThrow(
        `Artifact migrations are unapplied or their checksums differ; run ${remedy} before deploying.`,
      );
    }
  },
);

it('allows pending contracts while still checking expands and applied contracts', () => {
  const contract = { id: 'core:0002_contract', checksum: 'expected', phase: 'contract' as const };
  const expand = { id: 'core:0003_expand', checksum: 'expected', phase: 'expand' as const };
  expect(() => assertMigrationsApplied([contract], [], 'pb cloudflare migrate')).not.toThrow();
  expect(() => assertMigrationsApplied([contract, expand], [], 'pb cloudflare migrate')).toThrow();
  expect(() =>
    assertMigrationsApplied(
      [contract],
      [{ id: contract.id, checksum: 'different' }],
      'pb cloudflare migrate',
    ),
  ).toThrow();
});
