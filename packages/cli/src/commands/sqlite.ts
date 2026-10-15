import { ORG_SLUG_PATTERN } from '@package-broker/core/db/organization';
import { DbError } from '@package-broker/core/db/errors';
import { isoTimestamp, systemClock, ulid } from '@package-broker/core/ids';
import { MigrationLockedError } from '@package-broker/db-sqlite/migrations/lock';
import { migrate, MigrationChecksumError } from '@package-broker/db-sqlite/migrations/runner';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from '@package-broker/runtime-node/db/better-sqlite3-executor';
import { BuiltManifestError, loadBuiltMigrations } from './built-manifest.js';

function reportError(error: unknown): void {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  const message = (error as { message?: unknown } | null | undefined)?.message;
  const text =
    typeof name === 'string' && typeof message === 'string'
      ? `${name}: ${message}`
      : `Error: ${String(error)}`;
  console.error(text.replace(/[\r\n]+/g, ' '));
}

export async function runMigrateSqlite(o: {
  file: string;
  outDir: string;
  dryRun: boolean;
}): Promise<number> {
  try {
    const sources = await loadBuiltMigrations(o.outDir);
    const opened = openBetterSqliteExecutor(o.file);
    try {
      const result = await migrate(opened.executor, sources, { holder: ulid(), dryRun: o.dryRun });
      console.log(JSON.stringify(result));
      return 0;
    } finally {
      await opened.close();
    }
  } catch (error) {
    reportError(error);
    if (
      error instanceof MigrationChecksumError ||
      (error instanceof BuiltManifestError &&
        /checksum does not match the file/.test(error.message))
    )
      return 3;
    if (
      error instanceof MigrationLockedError ||
      (error instanceof DbError && error.kind === 'busy')
    )
      return 4;
    return 1;
  }
}

export async function runBootstrapSqlite(o: {
  file: string;
  slug: string;
  name: string;
}): Promise<number> {
  if (!ORG_SLUG_PATTERN.test(o.slug)) {
    reportError(new TypeError(`invalid organization slug ${JSON.stringify(o.slug)}`));
    return 2;
  }
  try {
    const opened = openBetterSqliteExecutor(o.file);
    try {
      const result = await createOrganizationBootstrap(opened.executor).bootstrap({
        id: ulid(),
        slug: o.slug,
        name: o.name,
        now: isoTimestamp(systemClock.now()),
      });
      if (!result.created && result.slug !== o.slug) {
        reportError(
          Object.assign(new Error(`organization already bootstrapped as ${result.slug}`), {
            name: 'AlreadyBootstrapped',
          }),
        );
        return 5;
      }
      console.log(JSON.stringify(result));
      return 0;
    } finally {
      await opened.close();
    }
  } catch (error) {
    reportError(error);
    return 1;
  }
}
