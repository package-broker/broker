import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { CloudflareError } from './api.js';

type MigrationChecksum = Pick<MigrationSource, 'id' | 'checksum'>;

export function assertMigrationsApplied(
  migrations: readonly Pick<MigrationSource, 'id' | 'checksum' | 'phase'>[],
  ledger: readonly MigrationChecksum[],
  remedyCommand: 'pb cloudflare migrate' | 'pb cloudflare migrate --prebuilt',
): void {
  const applied = new Map(ledger.map(({ id, checksum }) => [id, checksum]));
  if (
    migrations.some(({ id, checksum, phase }) =>
      applied.has(id) ? applied.get(id) !== checksum : phase !== 'contract',
    )
  ) {
    const error = new CloudflareError('migrations_pending', 2, false, 'deploy');
    error.message = `Artifact migrations are unapplied or their checksums differ; run ${remedyCommand} before deploying.`;
    throw error;
  }
}
