import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { migrate, type MigrateLogEvent } from '@package-broker/db-sqlite/migrations/runner';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { createNodeServer, type NodeBroker } from './index.js';

export interface StartOptions {
  readonly plugins: readonly PluginDefinition[];
  readonly migrations: readonly MigrationSource[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: KernelLog;
}

export class AlreadyBootstrappedError extends Error {
  readonly slug: string;

  constructor(slug: string) {
    super(`the database is already bootstrapped with the slug ${slug}`);
    this.name = 'AlreadyBootstrappedError';
    this.slug = slug;
  }
}

const DEFAULT_DATABASE_PATH = './data/broker.sqlite';

interface OpenedDatabase {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}

function migrateLog(log: KernelLog): (event: MigrateLogEvent) => void {
  return (event) => {
    const entry: Record<string, unknown> = { level: event.level, message: event.message };
    if (event.id !== undefined) entry['id'] = event.id;
    if (event.holder !== undefined) entry['holder'] = event.holder;
    log(entry);
  };
}

async function bootstrapOrganization(
  executor: SqlExecutor,
  slug: string,
  name: string,
): Promise<void> {
  const result = await createOrganizationBootstrap(executor).bootstrap({
    id: ulid(),
    slug,
    name,
    now: systemClock.now().toISOString(),
  });
  if (!result.created && result.slug !== slug) throw new AlreadyBootstrappedError(result.slug);
}

export async function startNode(options: StartOptions): Promise<NodeBroker> {
  const log = options.log;
  const path = options.env['PB_SQLITE_PATH'] ?? DEFAULT_DATABASE_PATH;
  let opened: OpenedDatabase | undefined;
  let broker: NodeBroker | undefined;

  try {
    await mkdir(dirname(path), { recursive: true });
    opened = openBetterSqliteExecutor(path);

    if (options.env['PB_MIGRATE'] !== 'off') {
      await migrate(opened.executor, options.migrations, {
        holder: ulid(),
        ...(log === undefined ? {} : { log: migrateLog(log) }),
      });
    }

    const slug = options.env['PB_ORG_SLUG'];
    const name = options.env['PB_ORG_NAME'];
    if (slug !== undefined && name !== undefined) {
      await bootstrapOrganization(opened.executor, slug, name);
    } else if (slug !== undefined || name !== undefined) {
      throw new Error('PB_ORG_SLUG and PB_ORG_NAME must be set together');
    }

    broker = createNodeServer(options.plugins, {
      executor: opened.executor,
      closeDatabase: opened.close,
      ...(log === undefined ? {} : { log }),
    });
    await broker.ready();

    return broker;
  } catch (error) {
    const closing = broker === undefined ? opened?.close() : broker.close();
    if (closing !== undefined) await closing.catch(() => undefined);
    throw error;
  }
}
