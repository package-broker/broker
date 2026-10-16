import { readdirSync, readFileSync } from 'node:fs';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { seedTwoOrganizations, type TwoOrganizations } from '../contract/two-organizations.js';
import { openNodeSqliteExecutor, type OpenedExecutor } from './node-sqlite-executor.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';

const migrationsUrl = new URL('../../migrations/', import.meta.url);
const HOLDER = 'testing-migrated-database';

export interface MigratedDatabaseOptions {
  readonly twoOrganizations?: boolean;
  readonly file?: string;
}

export interface MigratedDatabase {
  readonly executor: SqlExecutor;
  readonly orgs: TwoOrganizations | null;
  second(): Promise<SqlExecutor>;
  analyze(): Promise<void>;
  close(): Promise<void>;
}

function normalizeFile(file: string | undefined): string | undefined {
  if (file === undefined || file === '' || file === ':memory:') return undefined;
  return file;
}

export async function discoveredMigrations(): Promise<MigrationSource[]> {
  const names = readdirSync(migrationsUrl)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, migrationsUrl), 'utf8')),
    ),
  );
}

/** Test databases only. */
export async function openMigratedDatabase(
  options: MigratedDatabaseOptions = {},
): Promise<MigratedDatabase> {
  const file = normalizeFile(options.file);
  const opened = openNodeSqliteExecutor(file);
  const connections: OpenedExecutor[] = [opened];
  let closed = false;

  try {
    const sources = await discoveredMigrations();
    await migrate(opened.executor, sources, { holder: HOLDER });
    const orgs =
      options.twoOrganizations === true ? await seedTwoOrganizations(opened.executor) : null;

    return {
      executor: opened.executor,
      orgs,
      async second(): Promise<SqlExecutor> {
        if (closed) {
          throw new Error('the database is closed');
        }
        if (file === undefined) {
          throw new Error('second() needs the database to be opened from a file');
        }
        const extra = openNodeSqliteExecutor(file);
        connections.push(extra);
        return extra.executor;
      },
      async analyze(): Promise<void> {
        await opened.executor.all({ sql: 'ANALYZE', params: [] });
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        let failure: unknown;
        let failed = false;
        for (const connection of connections.splice(0).reverse()) {
          try {
            await connection.close();
          } catch (error) {
            if (!failed) {
              failed = true;
              failure = error;
            }
          }
        }
        if (failed) throw failure;
      },
    };
  } catch (error) {
    await opened.close();
    throw error;
  }
}
