import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { CloudflareError } from './api.js';

type MigrationChecksum = Pick<MigrationSource, 'id' | 'checksum'>;

export function assertMigrationsApplied(
  migrations: readonly MigrationChecksum[],
  ledger: readonly MigrationChecksum[],
): void {
  const applied = new Map(ledger.map(({ id, checksum }) => [id, checksum]));
  if (migrations.some(({ id, checksum }) => applied.get(id) !== checksum))
    throw new CloudflareError('migrations_pending', 2, false, 'deploy');
}
