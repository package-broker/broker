import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { selfTestPasswordHashing } from '@package-broker/core/auth/password';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import type { Kernel } from '@package-broker/core/kernel/kernel';
import type { PlatformServices } from '@package-broker/core/kernel/plugin-ports';
import {
  BlobValidationError,
  createBlobStore,
  createBlobUploadAdmission,
  type ByteStore,
} from '@package-broker/core/platform/blob';
import { completionSpan } from '@package-broker/core/platform/completion-span';
import {
  createObservability,
  type ObsRecord,
  type ObsRecordSink,
  type ObsRegistry,
  type ObservabilityScope,
} from '@package-broker/core/platform/observability';
import { createOtlpExporter, type OtlpExporter } from '@package-broker/core/platform/otlp';
import { createOtlpSink, type OtlpSink } from '@package-broker/core/platform/otlp-sink';
import {
  validatePlatformPorts,
  type PlatformPortConfig,
} from '@package-broker/core/platform/port-config';
import type { PluginDefinition } from '@package-broker/core/plugin';
import { createKeyring, type Keyring } from '@package-broker/core/secrets/keyring';
import { readMasterKeys, SecretsConfigError } from '@package-broker/core/secrets/master-key';
import { migrate, type MigrateLogEvent } from '@package-broker/db-sqlite/migrations/runner';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { FilesystemRootError, openFilesystemByteStore } from './blob/filesystem.js';
import { createS3ByteStore, S3ConfigError } from './blob/s3.js';
import { createLruCache } from './cache/lru.js';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { createNodeServer, type NodeBroker } from './index.js';
import { brokerObservabilityProblems, type BrokerConfig } from '@package-broker/core/config';
import { createJobLoop, JOB_EVENTS, type JobLoop } from './jobs/loop.js';
import { createStdioSink, type StdioStream } from './observability/stdio.js';

export interface StartOptions {
  readonly plugins: readonly PluginDefinition[];
  readonly migrations: readonly MigrationSource[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: KernelLog;
  readonly platformPorts?: PlatformPortConfig | null;
  readonly observability?: BrokerConfig['observability'];
  readonly stdout?: StdioStream;
  readonly stderr?: StdioStream;
  readonly fetch?: typeof fetch;
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

export const NODE_RUNTIME_EVENTS: ReadonlySet<string> = new Set([
  ...JOB_EVENTS,
  'startup.failed',
  'process.uncaught_exception',
  'process.unhandled_rejection',
]);

const FLUSH_INTERVAL_MS = 1000;

interface Telemetry {
  readonly sink: ObsRecordSink;
  readonly deploymentId: string;
  readonly routes: Set<string>;
  flush(): Promise<void>;
}

function requiredEnv(env: Env, variable: string): string {
  const value = env[variable];
  if (!present(value)) throw new StartupConfigError(variable, 'is missing');
  return value;
}

function otlpHeaders(env: Env, variable: string | undefined): Record<string, string> {
  if (variable === undefined) return {};
  const raw = requiredEnv(env, variable);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StartupConfigError(variable, 'is not a JSON object of header values');
  }
  const valid =
    typeof parsed === 'object' &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    Object.values(parsed).every((value) => typeof value === 'string');
  if (!valid) throw new StartupConfigError(variable, 'is not a JSON object of header values');
  return { ...(parsed as Record<string, string>) };
}

function createTelemetry(ports: PlatformPortConfig, options: StartOptions): Telemetry {
  const { env } = options;
  const deploymentId = requiredEnv(env, ports.observability.deploymentIdEnv);
  let stdio: ObsRecordSink;
  try {
    stdio = createStdioSink({
      deploymentId,
      ...(options.stdout === undefined ? {} : { stdout: options.stdout }),
      ...(options.stderr === undefined ? {} : { stderr: options.stderr }),
    });
  } catch {
    throw new StartupConfigError(
      ports.observability.deploymentIdEnv,
      'is not a valid deployment id',
    );
  }
  const routes = new Set<string>();

  let exporter: OtlpExporter | undefined;
  let otlp: OtlpSink | undefined;
  const { endpointEnv, headersEnv } = ports.observability;
  if (endpointEnv !== undefined) {
    const endpoint = requiredEnv(env, endpointEnv);
    const headers = otlpHeaders(env, headersEnv);
    try {
      exporter = createOtlpExporter({
        endpoint,
        headers,
        routeTemplates: routes,
        resource: { service: 'package-broker', deploymentId, runtime: 'node' },
        metrics: { counter: (name, labels, value) => otlp?.internal.counter(name, labels, value) },
        ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
      });
    } catch {
      throw new StartupConfigError(endpointEnv, 'is not a valid OTLP endpoint or header set');
    }
    otlp = createOtlpSink(exporter);
  }

  const bridge = (record: ObsRecord): void => {
    if (otlp === undefined || exporter === undefined) return;
    otlp.emit(record);
    if (record.kind !== 'log') return;
    const span = completionSpan(record.record, routes);
    if (span !== null) exporter.export('traces', span);
  };

  return {
    deploymentId,
    routes,
    sink: {
      emit(record) {
        stdio.emit(record);
        try {
          bridge(record);
        } catch {
          return;
        }
      },
    },
    flush: () => otlp?.flush() ?? Promise.resolve(),
  };
}

async function openByteStore(
  config: PlatformPortConfig['blob'],
  env: Env,
  fetchImpl: typeof fetch | undefined,
): Promise<ByteStore> {
  if (config.adapter === 'filesystem') {
    if (config.rootEnv === undefined) throw new StartupConfigError('blob.rootEnv', 'is required');
    const variable = config.rootEnv;
    const root = requiredEnv(env, variable);
    try {
      return await openFilesystemByteStore({ root });
    } catch (error) {
      const reason =
        error instanceof FilesystemRootError
          ? error.message
          : error instanceof Error
            ? error.name
            : 'failed';
      throw new StartupConfigError(variable, `is not a usable blob root: ${reason}`);
    }
  }
  const value = (variable: string | undefined, field: string): string => {
    if (variable === undefined) throw new StartupConfigError(`blob.${field}`, 'is required');
    return requiredEnv(env, variable);
  };
  const endpoint = value(config.endpointEnv, 'endpointEnv');
  const region = value(config.regionEnv, 'regionEnv');
  const bucket = value(config.bucketEnv, 'bucketEnv');
  const accessKeyId = value(config.accessKeyIdEnv, 'accessKeyIdEnv');
  const secretAccessKey = value(config.secretAccessKeyEnv, 'secretAccessKeyEnv');
  const sessionToken =
    config.sessionTokenEnv === undefined ? undefined : requiredEnv(env, config.sessionTokenEnv);
  try {
    return createS3ByteStore({
      endpoint,
      region,
      bucket,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      ...(config.pathStyle === undefined ? {} : { pathStyle: config.pathStyle }),
      ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }),
    });
  } catch (error) {
    if (!(error instanceof S3ConfigError)) throw error;
    throw new StartupConfigError('blob', `S3 setting ${error.field} is invalid`);
  }
}

async function buildServices(
  ports: PlatformPortConfig,
  options: StartOptions,
  executor: SqlExecutor,
): Promise<PlatformServices> {
  const byteStore = await openByteStore(ports.blob, options.env, options.fetch);
  let blob;
  try {
    blob = createBlobStore(byteStore, createBlobRepository(executor), {
      admission: createBlobUploadAdmission(),
      maxBytes: ports.blob.maxBytes,
    });
  } catch (error) {
    if (!(error instanceof BlobValidationError)) throw error;
    throw new StartupConfigError('blob.maxBytes', 'is not usable with the upload budget');
  }
  const cache = createLruCache(
    ports.cache.maxBytes === undefined ? {} : { maxBytes: ports.cache.maxBytes },
  );
  return { blob, cache, jobStore: createJobRepository(executor) };
}

function startJobs(
  kernel: Kernel,
  ports: PlatformPortConfig,
  executor: SqlExecutor,
  telemetry: Telemetry,
): JobLoop {
  const registry: ObsRegistry = {
    events: NODE_RUNTIME_EVENTS,
    reasonCodes: new Set(),
    routeTemplates: telemetry.routes,
  };
  const scope: ObservabilityScope = {
    deploymentId: telemetry.deploymentId,
    runtime: 'node',
    requestId: null,
  };
  const loop = createJobLoop({
    executor,
    jobs: kernel.registration.jobs,
    scope: kernel.jobScope,
    maxRunning: ports.jobs.maxRunning,
    observability: createObservability(telemetry.sink, scope, registry),
    runnerObservability: ({ jobId, attempt }) =>
      createObservability(telemetry.sink, { ...scope, jobId, attempt }, registry),
  });
  loop.start();
  return loop;
}

export async function startNode(options: StartOptions): Promise<NodeBroker> {
  const log = options.log;
  const path = options.env['PB_SQLITE_PATH'] ?? DEFAULT_DATABASE_PATH;
  const ports = options.platformPorts ?? null;
  let opened: OpenedDatabase | undefined;
  let broker: NodeBroker | undefined;
  let loop: JobLoop | undefined;
  let flushTimer: ReturnType<typeof setInterval> | undefined;
  let telemetry: Telemetry | undefined;

  const closeDatabase = async (): Promise<void> => {
    if (flushTimer !== undefined) clearInterval(flushTimer);
    flushTimer = undefined;
    try {
      await loop?.stop();
    } finally {
      try {
        await telemetry?.flush();
      } catch {
        // A failed final flush must not keep the database open.
      } finally {
        await opened?.close();
      }
    }
  };

  try {
    await mkdir(dirname(path), { recursive: true });
    opened = openBetterSqliteExecutor(path);

    const observabilityProblems = brokerObservabilityProblems({
      platform: 'node',
      plugins: options.plugins,
      ...(options.observability === undefined ? {} : { observability: options.observability }),
    });
    if (observabilityProblems.length > 0) {
      throw new StartupConfigError('observability', observabilityProblems.join('; '));
    }

    let services: PlatformServices | undefined;
    if (ports !== null) {
      const problems = validatePlatformPorts({ node: ports }, 'node');
      if (problems.length > 0) throw new StartupConfigError('platformPorts', problems.join('; '));
    }

    const keyring = await readKeyring(options.env);
    const origin = publicOrigin(options.env['PB_PUBLIC_URL']);
    await selfTestPasswordHashing(keyring);

    if (ports !== null) {
      telemetry = createTelemetry(ports, options);
      services = await buildServices(ports, options, opened.executor);
    }

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
      closeDatabase,
      auth: { keyring, publicOrigin: origin, env: identityEnv(options.env) },
      ...(log === undefined ? {} : { log }),
      ...(telemetry === undefined
        ? {}
        : {
            observability: {
              sink: telemetry.sink,
              deploymentId: telemetry.deploymentId,
              trustInboundTraceparent: options.observability?.trustInboundTraceparent === true,
            },
          }),
      ...(services === undefined ? {} : { platformServices: services }),
    });
    const kernel = await broker.ready();
    if (telemetry !== undefined) {
      for (const template of kernel.routeTemplates) telemetry.routes.add(template);
    }

    if (ports !== null && telemetry !== undefined) {
      loop = startJobs(kernel, ports, opened.executor, telemetry);
      const active = telemetry;
      flushTimer = setInterval(() => {
        active.flush().catch(() => undefined);
      }, FLUSH_INTERVAL_MS);
      flushTimer.unref();
    }

    return broker;
  } catch (error) {
    const closing = broker === undefined ? closeDatabase() : broker.close();
    await closing.catch(() => undefined);
    throw error;
  }
}
