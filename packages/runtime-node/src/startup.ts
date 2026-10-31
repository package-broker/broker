import { assertMcpRateLimit } from '@package-broker/core/mcp/limit';
import { INGEST_EVENTS, INGEST_REASON_CODES } from '@package-broker/core/ingest/finalize-guard';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  AUTH_REASON_CODES,
  FINISH_FAILURE_DETAILS,
  isAuthReasonCode,
  type AuthReasonCode,
} from '@package-broker/core/auth/reason-codes';
import { selfTestPasswordHashing } from '@package-broker/core/auth/password';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import type { Kernel } from '@package-broker/core/kernel/kernel';
import { parsePublicOrigin, PublicOriginError } from '@package-broker/core/kernel/public-origin';
import { AUDIT_EVENTS } from '@package-broker/core/kernel/obs-codes';
import type { PlatformServices } from '@package-broker/core/kernel/plugin-ports';
import {
  BlobValidationError,
  createBlobStore,
  createBlobUploadAdmission,
  type ByteStore,
} from '@package-broker/core/platform/blob';
import { completionSpan, upstreamSpan } from '@package-broker/core/platform/completion-span';
import {
  createObservability,
  safeErrorName,
  type LogLevel,
  type Observability,
  type ObsRecord,
  type ObsRecordSink,
  filterLogLevel,
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
import {
  KeyringStoreUnavailableError,
  KeyringMismatchError,
  KeyringVerifierMissingError,
  KeyringVersionInUseError,
  RESEED_VARIABLE,
  verifyKeyring,
} from '@package-broker/core/secrets/keyring-verifier';
import { readMasterKeys, SecretsConfigError } from '@package-broker/core/secrets/master-key';
import { migrate, type MigrateLogEvent } from '@package-broker/db-sqlite/migrations/runner';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createKeyringVerifierStore } from '@package-broker/db-sqlite/repositories/keyring-verifier';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { FilesystemRootError, openFilesystemByteStore } from './blob/filesystem.js';
import { createS3ByteStore, S3ConfigError } from './blob/s3.js';
import { createLruCache } from './cache/lru.js';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { createNodeServer, type NodeBroker } from './index.js';
import {
  mcpEnabled,
  brokerObservabilityProblems,
  type BrokerConfig,
} from '@package-broker/core/config';
import {
  RegistryConfigError,
  resolveRegistryConfig,
  type RegistryConfig,
} from '@package-broker/core/registry/registry-config';
import {
  resolveTokenLifetimePolicy,
  TokenConfigError,
} from '@package-broker/core/authz/token-lifetime';
import { createJobLoop, JOB_EVENTS, type JobLoop } from './jobs/loop.js';
import { parseTrustedProxy, TRUSTED_PROXY_DEPRECATION, TRUSTED_PROXY_RULE } from './client-ip.js';
import { createStdioSink, type StdioStream } from './observability/stdio.js';

export interface StartOptions {
  readonly plugins: readonly PluginDefinition[];
  readonly migrations: readonly MigrationSource[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly log?: KernelLog;
  readonly platformPorts?: PlatformPortConfig | null;
  readonly observability?: BrokerConfig['observability'];
  readonly registry?: BrokerConfig['registry'];
  readonly tokens?: BrokerConfig['tokens'];
  readonly vulnerability?: BrokerConfig['vulnerability'];
  readonly mcp?: BrokerConfig['mcp'];
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

export const BLOB_PURGE_LEASE_SECONDS = 900;
export const BLOB_DELETE_TIMEOUT_MS = 30_000;

export function blobPurgeTiming(
  deleteTimeoutMs: number,
  purgeLeaseSeconds: number,
): { deleteTimeoutMs: number; leaseMs: number } {
  const leaseMs = purgeLeaseSeconds * 1000;
  if (
    !Number.isInteger(leaseMs) ||
    leaseMs <= 0 ||
    !Number.isInteger(deleteTimeoutMs) ||
    deleteTimeoutMs < 1000 ||
    deleteTimeoutMs > leaseMs / 10
  ) {
    throw new StartupConfigError(
      'blob.deleteTimeoutMs',
      'must be at least 1000 ms and at most a tenth of the purge lease',
    );
  }
  return { deleteTimeoutMs, leaseMs };
}

const DEFAULT_DATABASE_PATH = './data/broker.sqlite';
const IDENTITY_ENV_PREFIX = 'PB_IDP_';

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
  try {
    return parsePublicOrigin(raw, { http: 'loopback' });
  } catch (error) {
    if (!(error instanceof PublicOriginError)) throw error;
    const problems = {
      missing: 'is missing',
      'absolute-url': 'is not an absolute URL',
      scheme: 'must be https, or http on a loopback host',
      origin: 'must be an origin without path, query or credentials',
    };
    throw new StartupConfigError('PB_PUBLIC_URL', problems[error.problem]);
  }
}

function registryConfig(input: StartOptions['registry'], origin: string): RegistryConfig {
  try {
    return resolveRegistryConfig(input, 'node', origin);
  } catch (error) {
    if (!(error instanceof RegistryConfigError)) throw error;
    throw new StartupConfigError('registry', error.problems.join('; '));
  }
}

function checkTokens(input: StartOptions['tokens']): void {
  try {
    resolveTokenLifetimePolicy(input);
  } catch (error) {
    if (!(error instanceof TokenConfigError)) throw error;
    throw new StartupConfigError('config', error.problems.join('; '));
  }
}

function authEnv(env: Env): Env {
  return Object.freeze({
    ...Object.fromEntries(
      Object.entries(env).filter(([name]) => name.startsWith(IDENTITY_ENV_PREFIX)),
    ),
    ...(env['PB_AUTH_LOCAL'] === undefined ? {} : { PB_AUTH_LOCAL: env['PB_AUTH_LOCAL'] }),
  });
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

export const AUTH_EVENTS = Object.freeze([
  'auth.hook.denied',
  'auth.hook.error',
  'auth.local.locked',
  'auth.local.refused_disabled',
  'auth.local.setup.completed',
  'auth.local.setup.refused',
  'auth.login.refused',
  'auth.login.succeeded',
  'auth.logout.refused',
  'auth.reauth.refused',
  'auth.reauth.succeeded',
  'token_touch_failed',
] as const);

export const NODE_RUNTIME_EVENTS: ReadonlySet<string> = new Set([
  ...AUDIT_EVENTS,
  ...INGEST_EVENTS,
  ...JOB_EVENTS,
  ...AUTH_EVENTS,
  'http.error',
  'shutdown.jobs_abandoned',
  'startup.failed',
  'process.uncaught_exception',
  'process.unhandled_rejection',
]);

const FLUSH_INTERVAL_MS = 1000;

interface Telemetry {
  readonly sink: ObsRecordSink;
  readonly deploymentId: string;
  readonly routes: Set<string>;
  observe(scope?: ObserveScope): Observability;
  flush(): Promise<void>;
}

const JOBS_ABANDONED_COUNTER = 'pb.jobs.abandoned';

interface ObserveScope {
  readonly requestId?: string;
  readonly plugin?: string;
}

const LOGIN_OUTCOMES: Readonly<Record<string, string>> = {
  'auth.login.succeeded': 'succeeded',
  'auth.login.refused': 'refused',
};

export function registeredAuthReason(value: unknown): AuthReasonCode | undefined {
  return isAuthReasonCode(value) ? value : undefined;
}

export function sinkLog(observe: (scope?: ObserveScope) => Observability): KernelLog {
  const unscoped = observe();
  return (entry) => {
    const requestId = entry['request_id'] ?? entry['requestId'];
    const plugin = entry['pluginId'];
    const scope: ObserveScope = {
      ...(typeof requestId === 'string' ? { requestId } : {}),
      ...(typeof plugin === 'string' ? { plugin } : {}),
    };
    let observability = unscoped;
    if (scope.requestId !== undefined || scope.plugin !== undefined) {
      try {
        observability = observe(scope);
      } catch {
        observability = unscoped;
      }
    }
    const error = entry['error_name'] ?? entry['error'];
    const detail = registeredAuthReason(entry['detail']);
    const reason =
      detail ?? registeredAuthReason(entry['reason']) ?? registeredAuthReason(entry['code']);
    const event = entry['event'] as string;
    observability.log({
      level: entry['level'] as LogLevel,
      event,
      ...(error === undefined ? {} : { error_name: error }),
      ...(reason === undefined ? {} : { reason_code: reason }),
    });
    const outcome = LOGIN_OUTCOMES[event];
    const provider = entry['provider'];
    if (outcome !== undefined && typeof provider === 'string') {
      const finishDetail =
        outcome === 'refused' &&
        entry['reason'] === 'provider_error' &&
        detail !== undefined &&
        (FINISH_FAILURE_DETAILS as ReadonlySet<string>).has(detail);
      observability.counter('pb.auth.login', {
        provider,
        outcome,
        ...(finishDetail ? { detail } : {}),
      });
    }
  };
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
  };

  const outputs = filterLogLevel(
    {
      emit(record) {
        stdio.emit(record);
        try {
          bridge(record);
        } catch {
          return;
        }
      },
    },
    options.observability?.level,
  );
  const sink: ObsRecordSink = {
    emit(record) {
      outputs.emit(record);
      if (record.kind !== 'log' || exporter === undefined) return;
      try {
        const span = completionSpan(record.record, routes) ?? upstreamSpan(record.record);
        if (span !== null) exporter.export('traces', span);
      } catch {
        return;
      }
    },
  };
  return {
    deploymentId,
    routes,
    sink,
    observe: (scope) =>
      createObservability(
        sink,
        {
          deploymentId,
          runtime: 'node',
          requestId: scope?.requestId ?? null,
          ...(scope?.plugin === undefined ? {} : { plugin: scope.plugin }),
        },
        {
          events: NODE_RUNTIME_EVENTS,
          reasonCodes: new Set([...AUTH_REASON_CODES, ...INGEST_REASON_CODES]),
          routeTemplates: routes,
        },
      ),
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
  admissionWaitMs: number,
  telemetry: Telemetry,
): Promise<PlatformServices> {
  blobPurgeTiming(BLOB_DELETE_TIMEOUT_MS, BLOB_PURGE_LEASE_SECONDS);
  const byteStore = await openByteStore(ports.blob, options.env, options.fetch);
  let blob;
  try {
    blob = createBlobStore(
      byteStore,
      createBlobRepository(executor, {
        purgeLeaseSeconds: BLOB_PURGE_LEASE_SECONDS,
        supersededObjects: {
          remove: (key) => byteStore.remove(key),
          counter: (outcome) =>
            telemetry
              .observe()
              .counter('pb.blob.operations', { kind: 'superseded_remove', outcome }),
        },
      }),
      {
        observability: telemetry.observe(),
        admission: createBlobUploadAdmission(),
        maxBytes: ports.blob.maxBytes,
        admissionWaitMs,
      },
    );
  } catch (error) {
    if (!(error instanceof BlobValidationError)) throw error;
    throw new StartupConfigError('blob.maxBytes', 'is not usable with the upload budget');
  }
  const cache = createLruCache(
    ports.cache.maxBytes === undefined ? {} : { maxBytes: ports.cache.maxBytes },
  );
  const services = {
    blob,
    cache,
    jobStore: createJobRepository(executor),
    retention: {
      store: byteStore,
      deleteTimeoutMs: BLOB_DELETE_TIMEOUT_MS,
      leaseMs: BLOB_PURGE_LEASE_SECONDS * 1000,
    },
  };
  return services;
}

function startJobs(
  kernel: Kernel,
  ports: PlatformPortConfig,
  executor: SqlExecutor,
  telemetry: Telemetry,
): JobLoop {
  const registry: ObsRegistry = {
    events: NODE_RUNTIME_EVENTS,
    reasonCodes: INGEST_REASON_CODES,
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

async function keyringGate(
  keyring: Keyring,
  executor: SqlExecutor,
  options: StartOptions,
): Promise<(() => Promise<boolean>) | undefined> {
  const store = createKeyringVerifierStore(executor);
  const reseed = options.env[RESEED_VARIABLE] === '1';
  const attempt = async (): Promise<void> => {
    const result = await verifyKeyring(keyring, store, {
      reseed,
      onReseedIgnored: (keyVersion) =>
        options.log?.({ level: 'warn', event: 'keyring.reseed_ignored', key_version: keyVersion }),
    });
    if (result.reseeded) {
      options.log?.({ level: 'warn', event: 'keyring.reseeded', key_version: result.keyVersion });
    }
  };
  try {
    await attempt();
    return undefined;
  } catch (error) {
    const deferred =
      error instanceof KeyringStoreUnavailableError && options.env['PB_MIGRATE'] === 'off';
    if (!deferred) throw error;
  }
  let verified = false;
  let inFlight: Promise<boolean> | undefined;
  let nextAttempt = Date.now() + 1000;
  const retry = async (): Promise<boolean> => {
    try {
      await attempt();
      verified = true;
    } catch (error) {
      options.log?.({
        level: 'error',
        event: 'keyring.unverified',
        error_name: error instanceof Error ? error.name : 'Error',
        ...(error instanceof KeyringMismatchError ||
        error instanceof KeyringVerifierMissingError ||
        error instanceof KeyringVersionInUseError
          ? { key_version: error.keyVersion }
          : {}),
      });
    }
    return verified;
  };
  return async () => {
    if (verified) return true;
    if (inFlight !== undefined) return inFlight;
    if (Date.now() < nextAttempt) return false;
    nextAttempt = Date.now() + 1000;
    inFlight = retry().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}

export async function startNode(options: StartOptions): Promise<NodeBroker> {
  const trustedProxy = parseTrustedProxy(options.env['PB_TRUSTED_PROXY']);
  if (trustedProxy === null) throw new StartupConfigError('PB_TRUSTED_PROXY', TRUSTED_PROXY_RULE);
  if (trustedProxy.kind === 'legacy') options.log?.(TRUSTED_PROXY_DEPRECATION);

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
      const stopped = await loop?.stop();
      if (telemetry !== undefined && stopped !== undefined && stopped.abandoned > 0) {
        const observability = telemetry.observe();
        observability.log({ level: 'warn', event: 'shutdown.jobs_abandoned' });
        observability.counter(JOBS_ABANDONED_COUNTER, {}, stopped.abandoned);
      }
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
    assertMcpRateLimit({
      runtime: 'node',
      mcpEnabled: mcpEnabled({
        platform: 'node',
        plugins: options.plugins,
        ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      }),
    });
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
    if (options.registry !== undefined && ports === null) {
      throw new StartupConfigError('registry', 'requires platformPorts');
    }
    const registry = registryConfig(options.registry, origin);
    checkTokens(options.tokens);
    await selfTestPasswordHashing(keyring);

    if (ports !== null) {
      telemetry = createTelemetry(ports, options);
      services = await buildServices(
        ports,
        options,
        opened.executor,
        registry.timers.waitBudgetMs,
        telemetry,
      );
    }

    if (options.env['PB_MIGRATE'] !== 'off') {
      await migrate(opened.executor, options.migrations, {
        holder: ulid(),
        ...(log === undefined ? {} : { log: migrateLog(log) }),
      });
    }

    const servingGate = await keyringGate(keyring, opened.executor, options);

    const slug = options.env['PB_ORG_SLUG'];
    const name = options.env['PB_ORG_NAME'];
    if (slug !== undefined && name !== undefined) {
      if (servingGate !== undefined) {
        throw new StartupConfigError(
          'PB_ORG_SLUG',
          'organization bootstrap requires applied migrations and a verified keyring',
        );
      }
      await bootstrapOrganization(opened.executor, slug, name);
    } else if (slug !== undefined || name !== undefined) {
      throw new Error('PB_ORG_SLUG and PB_ORG_NAME must be set together');
    }

    broker = createNodeServer(options.plugins, {
      trustedProxy,
      executor: opened.executor,
      migrations: options.migrations,
      closeDatabase,
      ...(options.tokens === undefined ? {} : { tokens: options.tokens }),
      ...(options.vulnerability === undefined ? {} : { vulnerability: options.vulnerability }),
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      auth: { keyring, publicOrigin: origin, env: authEnv(options.env) },
      ...(servingGate === undefined ? {} : { servingGate }),
      ...(telemetry !== undefined
        ? { log: sinkLog(telemetry.observe) }
        : log === undefined
          ? {}
          : { log }),
      ...(telemetry === undefined
        ? {}
        : {
            observability: {
              sink: telemetry.sink,
              level: options.observability?.level ?? 'info',
              deploymentId: telemetry.deploymentId,
              trustInboundTraceparent: options.observability?.trustInboundTraceparent === true,
            },
          }),
      ...(services === undefined ? {} : { platformServices: services }),
      ...(services === undefined
        ? {}
        : {
            registry: {
              config: registry,
              sshArchiveRoot:
                options.env['PB_SSH_ARCHIVE_ROOT'] ?? join(dirname(path), 'ssh-archives'),
              gitArchiveRoot:
                options.env['PB_GIT_ARCHIVE_ROOT'] ?? join(dirname(path), 'git-archives'),
            },
          }),
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
    telemetry?.observe().log({
      level: 'error',
      event: 'startup.failed',
      error_name: safeErrorName(error),
    });
    const closing = broker === undefined ? closeDatabase() : broker.close();
    await closing.catch(() => undefined);
    throw error;
  }
}
