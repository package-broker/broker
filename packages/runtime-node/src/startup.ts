import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { selfTestPasswordHashing } from '@package-broker/core/auth/password';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { createKeyring, type Keyring } from '@package-broker/core/secrets/keyring';
import { readMasterKeys, SecretsConfigError } from '@package-broker/core/secrets/master-key';
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

export class StartupConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, problem: string) {
    super(`${variable} ${problem}`);
    this.name = 'StartupConfigError';
    this.variable = variable;
  }
}

const DEFAULT_DATABASE_PATH = './data/broker.sqlite';
const IDENTITY_ENV_PREFIX = 'PB_IDP_';
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

type Env = Readonly<Record<string, string | undefined>>;

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

function present(value: string | undefined): value is string {
  return value !== undefined && value !== '';
}

const MAX_KEY_FILE_BYTES = 4096;
const ERRNO_CODE = /^E[A-Z0-9]{2,15}$/;

function errnoSuffix(error: unknown): string {
  const code: unknown = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  return typeof code === 'string' && ERRNO_CODE.test(code) ? ` (${code})` : '';
}

async function readKeyFile(variable: string, file: string): Promise<string> {
  let bytes: Buffer;
  try {
    const stats = await stat(file);
    if (!stats.isFile()) throw new StartupConfigError(variable, 'is not a regular file');
    if (stats.size > MAX_KEY_FILE_BYTES) {
      throw new StartupConfigError(variable, `is larger than ${MAX_KEY_FILE_BYTES} bytes`);
    }
    bytes = await readFile(file);
  } catch (error) {
    if (error instanceof StartupConfigError) throw error;
    throw new StartupConfigError(variable, `is unreadable${errnoSuffix(error)}`);
  }
  if (bytes.length > MAX_KEY_FILE_BYTES) {
    throw new StartupConfigError(variable, `is larger than ${MAX_KEY_FILE_BYTES} bytes`);
  }
  const content = bytes.toString('utf8');
  return content.endsWith('\n') ? content.slice(0, -1) : content;
}

async function secretValue(
  env: Env,
  variable: 'PB_MASTER_KEY' | 'PB_MASTER_KEY_PREVIOUS',
): Promise<{ readonly value: string | undefined; readonly fromFile: boolean }> {
  const fileVariable = `${variable}_FILE` as const;
  const direct = env[variable];
  const file = env[fileVariable];
  if (direct !== undefined && file !== undefined) {
    throw new StartupConfigError(fileVariable, `and ${variable} are both set`);
  }
  if (direct !== undefined) {
    if (direct === '') throw new StartupConfigError(variable, 'is empty');
    return { value: direct, fromFile: false };
  }
  if (file === undefined) return { value: undefined, fromFile: false };
  if (file === '') throw new StartupConfigError(fileVariable, 'is empty');
  const value = await readKeyFile(fileVariable, file);
  if (value === '') throw new StartupConfigError(fileVariable, 'has empty content');
  return { value, fromFile: true };
}

async function readKeyring(env: Env): Promise<Keyring> {
  const current = await secretValue(env, 'PB_MASTER_KEY');
  const previous = await secretValue(env, 'PB_MASTER_KEY_PREVIOUS');
  try {
    return createKeyring(readMasterKeys({ current: current.value, previous: previous.value }));
  } catch (error) {
    if (!(error instanceof SecretsConfigError)) throw error;
    const fromFile =
      error.variable === 'PB_MASTER_KEY'
        ? current.fromFile
        : error.variable === 'PB_MASTER_KEY_PREVIOUS' && previous.fromFile;
    if (!fromFile) throw error;
    throw new SecretsConfigError(
      error.problem,
      error.variable === 'PB_MASTER_KEY' ? 'PB_MASTER_KEY_FILE' : 'PB_MASTER_KEY_PREVIOUS_FILE',
    );
  }
}

function publicOrigin(raw: string | undefined): string {
  if (!present(raw)) throw new StartupConfigError('PB_PUBLIC_URL', 'is missing');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new StartupConfigError('PB_PUBLIC_URL', 'is not an absolute URL');
  }
  const schemeAllowed =
    url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
  if (!schemeAllowed) {
    throw new StartupConfigError('PB_PUBLIC_URL', 'must be https, or http on a loopback host');
  }
  const bare =
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === '' &&
    !raw.includes('?') &&
    !raw.includes('#');
  if (!bare) {
    throw new StartupConfigError(
      'PB_PUBLIC_URL',
      'must be an origin without path, query or credentials',
    );
  }
  return url.origin;
}

function identityEnv(env: Env): Env {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(env).filter(([name]) => name.startsWith(IDENTITY_ENV_PREFIX)),
    ),
  );
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

    const keyring = await readKeyring(options.env);
    const origin = publicOrigin(options.env['PB_PUBLIC_URL']);
    await selfTestPasswordHashing(keyring);

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
      auth: { keyring, publicOrigin: origin, env: identityEnv(options.env) },
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
