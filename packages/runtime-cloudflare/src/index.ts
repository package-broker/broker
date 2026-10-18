import { selfTestPasswordHashing } from '@package-broker/core/auth/password';
import { createAuthModule } from '@package-broker/core/auth/module';
import type { AuthModule } from '@package-broker/core/auth/module';
import { DbError } from '@package-broker/core/db/errors';
import type { OrgContext, ScalarSqlExecutor, SqlExecutor } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import type { AuthorizationEngine } from '@package-broker/core/kernel/authorize';
import { defaultLog, errorResponse } from '@package-broker/core/kernel/errors';
import type { KernelLog } from '@package-broker/core/kernel/errors';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { KERNEL_EVENTS, KERNEL_REASON_CODES } from '@package-broker/core/kernel/obs-codes';
import { brokerObservabilityProblems, type BrokerConfig } from '@package-broker/core/config';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import type { Kernel } from '@package-broker/core/kernel/kernel';
import { buildIdentityProviders, scopedEnv } from '@package-broker/core/identity/providers';
import { createOrgResolver, NotBootstrappedError } from '@package-broker/core/kernel/org';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import type { Registration } from '@package-broker/core/kernel/registry';
import type { PluginDefinition, PluginPorts } from '@package-broker/core/plugin';
import type { PlatformServices } from '@package-broker/core/kernel/plugin-ports';
import { createBlobStore, createBlobUploadAdmission } from '@package-broker/core/platform/blob';
import { completionSpan } from '@package-broker/core/platform/completion-span';
import { createObservability, safeErrorName } from '@package-broker/core/platform/observability';
import type {
  Observability,
  ObsRecord,
  ObsRecordSink,
  ObsRegistry,
} from '@package-broker/core/platform/observability';
import { createOtlpExporter } from '@package-broker/core/platform/otlp';
import type { OtlpExporter } from '@package-broker/core/platform/otlp';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createJobScheduleRepository } from '@package-broker/db-sqlite/repositories/job-schedule';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { SecretsConfigError, readMasterKeys } from '@package-broker/core/secrets/master-key';
import { createAuthRepositories } from '@package-broker/db-sqlite/repositories/auth';
import {
  createOrganizationBootstrap,
  createOrganizationRepository,
} from '@package-broker/db-sqlite/repositories/organization';
import { createR2ByteStore } from './blob/r2.js';
import type { R2BucketLike } from './blob/r2.js';
import { createCacheApiAdapter, DEFAULT_CACHE_NAMESPACE } from './cache/cache-api.js';
import type { CacheStorageLike } from './cache/cache-api.js';
import { createD1Executor } from './db/d1-executor.js';
import type { D1DatabaseLike } from './db/d1-executor.js';
import {
  createJobBatchSender,
  createJobSender,
  createQueueHandler,
  enqueueAndNotify,
  JOB_EVENTS,
  JOB_REASON_CODES,
  QUEUE_RETRY_DELAY_SECONDS,
  reportJobEvent,
} from './jobs/consumer.js';
import type { JobEvent, QueueBatchLike, QueueLike, QueueMessageLike } from './jobs/consumer.js';
import { createScheduledHandler } from './jobs/cron.js';
import { createWorkersSink } from './observability/workers.js';
import type { AnalyticsEngineLike } from './observability/workers.js';

export type Env = {
  readonly DB?: D1DatabaseLike;
  readonly STORAGE?: R2BucketLike;
  readonly JOBS?: QueueLike;
  readonly ANALYTICS?: AnalyticsEngineLike;
  readonly DEPLOYMENT_ID?: string;
  readonly PB_MASTER_KEY?: string;
  readonly PB_MASTER_KEY_PREVIOUS?: string;
  readonly PB_PUBLIC_URL?: string;
  readonly [binding: `PB_IDP_${string}`]: string | undefined;
};

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface WorkerOptions {
  readonly log?: KernelLog;
  readonly authorization?: AuthorizationEngine;
  /** The cloudflare stanza of `platformPorts`; null or absent leaves platform services disabled. */
  readonly platformPorts?: PlatformPortConfig | null;
  /** Default `globalThis.caches`; null means the Cache API is unavailable. */
  readonly cacheStorage?: CacheStorageLike | null;
  readonly otlpFetch?: FetchLike;
  readonly observability?: BrokerConfig['observability'];
  readonly console?: { log: (value: unknown) => void; error: (value: unknown) => void };
}

export interface Worker {
  readonly plugins: readonly PluginDefinition[];
  fetch(request: Request, env?: Env, ctx?: ExecutionContextLike): Promise<Response>;
  queue(batch: unknown, env: Env, ctx?: ExecutionContextLike): Promise<void>;
  scheduled(event: unknown, env: Env, ctx?: ExecutionContextLike): Promise<void>;
}

export function unboundExecutor(): ScalarSqlExecutor {
  const reject = (): Promise<never> =>
    Promise.reject(new DbError('unknown', 'no DB binding', { cause: null }));

  return {
    driver: 'none',
    all: reject,
    batch: reject,
  };
}

const PUBLIC_URL_VARIABLE = 'PB_PUBLIC_URL';
const IDENTITY_FETCH_TIMEOUT_MS = 5000;

export function publicOriginOf(raw: string | undefined): string {
  if (raw === undefined || raw === '') throw new SecretsConfigError('missing', PUBLIC_URL_VARIABLE);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SecretsConfigError('malformed', PUBLIC_URL_VARIABLE);
  }
  if (
    url.protocol !== 'https:' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.username !== '' ||
    url.password !== ''
  ) {
    throw new SecretsConfigError('malformed', PUBLIC_URL_VARIABLE);
  }
  return url.origin;
}

async function buildAuth(
  executor: ScalarSqlExecutor,
  plugins: readonly PluginDefinition[],
  env: Env,
  log: KernelLog,
): Promise<{ auth: AuthModule; registration: Registration }> {
  const keyring = createKeyring(
    readMasterKeys({ current: env.PB_MASTER_KEY, previous: env.PB_MASTER_KEY_PREVIOUS }),
  );
  const publicOrigin = publicOriginOf(env.PB_PUBLIC_URL);
  await selfTestPasswordHashing(keyring);
  const registration = collectRegistrations(plugins);
  const providers = buildIdentityProviders(registration, plugins, {
    fetch: (request) =>
      fetch(request, {
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(IDENTITY_FETCH_TIMEOUT_MS)]),
      }),
    clock: systemClock,
    env: scopedEnv(env),
  });
  const auth = createAuthModule({
    repositories: createAuthRepositories(executor),
    keyring,
    clock: systemClock,
    ids: { ulid },
    publicOrigin,
    providers,
    hooks: registration.hooks,
    log,
  });
  return { auth, registration };
}

function withoutBodyForHead(request: Request, response: Response): Response {
  return request.method === 'HEAD' ? new Response(null, response) : response;
}

const STARTUP_EVENTS = [
  'startup.failed',
  'obs.analytics_unconfigured',
  'cache.put_untracked',
] as const;
const MAX_CACHED_APPLICATIONS = 8;
const FINGERPRINT_BINDINGS = ['DB', 'STORAGE', 'JOBS', 'ANALYTICS'] as const;
const HISTOGRAM_BOUNDS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

type Handler = (input: unknown) => Promise<void>;

interface Application {
  readonly kernel: Kernel;
  readonly queue?: Handler;
  readonly scheduled?: Handler;
  begin(): RequestScope;
  fail(event: JobEvent, error: unknown): void;
}

interface Bound {
  readonly db: D1DatabaseLike;
  readonly bucket: R2BucketLike;
  readonly queue: QueueLike;
  readonly analytics: AnalyticsEngineLike | undefined;
  readonly deploymentId: string;
  readonly cacheStorage: CacheStorageLike;
  readonly otlp: { readonly endpoint: string; readonly headers: Record<string, string> } | null;
}

function read(env: Env, name: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(env, name);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function hasMethods(value: unknown, methods: readonly string[]): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return methods.every((method) => typeof record[method] === 'function');
}

const DEPLOYMENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

function stringRecord(text: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') return null;
    out[key] = value;
  }
  return out;
}

function resolveBindings(
  stanza: PlatformPortConfig,
  env: Env,
  cacheStorage: CacheStorageLike | null | undefined,
): Bound {
  const problems: string[] = [];
  const db = read(env, 'DB');
  if (!hasMethods(db, ['prepare', 'batch'])) problems.push('DB: not bound');
  if (stanza.blob.adapter !== 'r2') problems.push('blob.adapter: must be r2');
  if (stanza.cache.adapter !== 'cache-api') problems.push('cache.adapter: must be cache-api');
  if (stanza.jobs.adapter !== 'queues') problems.push('jobs.adapter: must be queues');
  if (stanza.observability.adapter !== 'workers') {
    problems.push('observability.adapter: must be workers');
  }
  const bucketName = stanza.blob.binding;
  const bucket = bucketName === undefined ? undefined : read(env, bucketName);
  if (!hasMethods(bucket, ['head', 'get', 'put', 'delete'])) {
    problems.push(`blob.binding: ${bucketName ?? 'unnamed'} is not bound`);
  }
  const queueName = stanza.jobs.binding;
  const queue = queueName === undefined ? undefined : read(env, queueName);
  if (!hasMethods(queue, ['send', 'sendBatch'])) {
    problems.push(`jobs.binding: ${queueName ?? 'unnamed'} is not bound`);
  }
  const analyticsName = stanza.observability.analyticsBinding;
  const analytics = analyticsName === undefined ? undefined : read(env, analyticsName);
  if (analyticsName !== undefined && !hasMethods(analytics, ['writeDataPoint'])) {
    problems.push(`observability.analyticsBinding: ${analyticsName} is not bound`);
  }
  const deploymentId = read(env, 'DEPLOYMENT_ID');
  if (typeof deploymentId !== 'string' || !DEPLOYMENT_ID_PATTERN.test(deploymentId)) {
    problems.push('DEPLOYMENT_ID: missing or malformed');
  }
  if (cacheStorage === null || cacheStorage === undefined) {
    problems.push('cache: the Cache API is unavailable');
  }
  let otlp: Bound['otlp'] = null;
  const { endpointEnv, headersEnv } = stanza.observability;
  if (endpointEnv !== undefined) {
    const endpoint = read(env, endpointEnv);
    let headers: Record<string, string> | null = {};
    if (headersEnv !== undefined) {
      const raw = read(env, headersEnv);
      headers = typeof raw === 'string' ? stringRecord(raw) : null;
      if (headers === null) problems.push(`observability.headersEnv: ${headersEnv} is malformed`);
    }
    if (typeof endpoint !== 'string' || endpoint === '') {
      problems.push(`observability.endpointEnv: ${endpointEnv} is not set`);
    } else if (headers !== null) {
      otlp = { endpoint, headers };
    }
  }
  if (problems.length > 0) throw new KernelConfigError(problems);
  return {
    db: db as D1DatabaseLike,
    bucket: bucket as R2BucketLike,
    queue: queue as QueueLike,
    analytics: analytics as AnalyticsEngineLike | undefined,
    deploymentId: deploymentId as string,
    cacheStorage: cacheStorage as CacheStorageLike,
    otlp,
  };
}

function histogramPoint(value: number): { bucketCounts: number[] } {
  const bucketCounts = new Array<number>(HISTOGRAM_BOUNDS.length + 1).fill(0);
  const index = HISTOGRAM_BOUNDS.findIndex((bound) => value <= bound);
  bucketCounts[index === -1 ? HISTOGRAM_BOUNDS.length : index] = 1;
  return { bucketCounts };
}

function bridgeToOtlp(
  exporter: OtlpExporter,
  record: ObsRecord,
  routeTemplates: ReadonlySet<string>,
): void {
  if (record.kind === 'log') {
    exporter.export('logs', record.record);
    const span = completionSpan(record.record, routeTemplates);
    if (span !== null) exporter.export('traces', span);
    return;
  }
  const labels = { ...record.labels } as Record<string, string>;
  if (record.kind === 'counter') {
    exporter.export('metrics', { kind: 'counter', name: record.name, value: record.value, labels });
    return;
  }
  exporter.export('metrics', {
    kind: 'histogram',
    name: record.name,
    bounds: HISTOGRAM_BOUNDS,
    ...histogramPoint(record.value),
    count: 1,
    sum: record.value,
    labels,
  });
}

interface RequestScope {
  end(): void;
  settle(): Promise<void>;
}

const NO_ENV: Env = Object.freeze({});
const NO_SCOPE: RequestScope = Object.freeze({
  end: () => undefined,
  settle: () => Promise.resolve(),
});

function createScopes(
  flush: () => Promise<void>,
  onUntracked: () => void,
): {
  begin(): RequestScope;
  track(promise: Promise<unknown>): void;
} {
  const live: Set<Promise<void>>[] = [];
  return {
    begin() {
      const pending = new Set<Promise<void>>();
      live.push(pending);
      return {
        end() {
          const index = live.indexOf(pending);
          if (index !== -1) live.splice(index, 1);
        },
        async settle() {
          while (pending.size > 0) await Promise.all([...pending]);
          await flush();
        },
      };
    },
    track(promise) {
      const pending = live.at(-1);
      if (pending === undefined) {
        promise.catch(() => undefined);
        onUntracked();
        return;
      }
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      pending.add(settled);
      void settled.then(() => pending.delete(settled));
    },
  };
}

function scheduleDefinitions(jobs: Registration['jobs']) {
  return jobs.flatMap((job) =>
    job.definition.schedule === undefined
      ? []
      : [
          {
            name: job.qualifiedName,
            everySeconds: job.definition.schedule.everySeconds,
            ...(job.definition.maxAttempts === undefined
              ? {}
              : { maxAttempts: job.definition.maxAttempts }),
          },
        ],
  );
}

function delegatingObservability(target: () => Observability): Observability {
  const delegate: Observability = {
    log: (record) => target().log(record),
    counter: (name, labels, value) => target().counter(name, labels, value),
    histogram: (name, value, labels) => target().histogram(name, value, labels),
  };
  return Object.freeze(delegate);
}

function notificationOrg(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(body, 'org');
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

function queueBatchOf(batch: unknown): QueueBatchLike {
  let messages: unknown;
  try {
    messages = (batch as { messages?: unknown } | null | undefined)?.messages;
  } catch {
    messages = undefined;
  }
  return { messages: Array.isArray(messages) ? (messages as QueueMessageLike[]) : [] };
}

const uploadAdmission = createBlobUploadAdmission();

function retryAll(messages: readonly QueueMessageLike[], report: (error: unknown) => void): void {
  try {
    for (const message of messages) {
      try {
        message.retry({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
      } catch (error) {
        report(error);
      }
    }
  } catch (error) {
    report(error);
  }
}

function logJobFailure(log: KernelLog, event: JobEvent, error: unknown): void {
  try {
    log({ level: 'error', event, error_name: safeErrorName(error) });
  } catch {
    return;
  }
}

function logBuildFailure(log: KernelLog, error: unknown): void {
  if (!(error instanceof KernelConfigError)) return;
  try {
    log({
      level: 'error',
      event: 'startup.misconfigured',
      error_name: safeErrorName(error),
      problems: error.problems,
    });
  } catch {
    return;
  }
}

async function digestOf(text: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)),
  );
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export function createWorker(
  plugins: readonly PluginDefinition[],
  options: WorkerOptions = {},
): Worker {
  const log = options.log ?? defaultLog;
  const stanza = options.platformPorts ?? null;
  const cacheStorage =
    options.cacheStorage === undefined
      ? (globalThis as { caches?: CacheStorageLike }).caches
      : options.cacheStorage;
  const applications = new Map<string, Promise<Application>>();
  const identities = new WeakMap<object, number>();
  let nextIdentity = 0;

  function identity(value: unknown): string {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      return value === undefined ? '-' : `v:${typeof value}`;
    }
    let id = identities.get(value);
    if (id === undefined) {
      nextIdentity += 1;
      id = nextIdentity;
      identities.set(value, id);
    }
    return String(id);
  }

  const fingerprints = new WeakMap<object, Promise<string>>();

  function fingerprint(env: Env): Promise<string> {
    let cached = fingerprints.get(env);
    if (cached === undefined) {
      cached = computeFingerprint(env);
      fingerprints.set(env, cached);
    }
    return cached;
  }

  async function computeFingerprint(env: Env): Promise<string> {
    const names = new Set<string>(FINGERPRINT_BINDINGS);
    const variables = new Set<string>(Object.keys(env).filter((name) => name.startsWith('PB_')));
    if (stanza !== null) {
      for (const name of [
        stanza.blob.binding,
        stanza.jobs.binding,
        stanza.observability.analyticsBinding,
      ]) {
        if (name !== undefined) names.add(name);
      }
      for (const name of [
        stanza.observability.endpointEnv,
        stanza.observability.headersEnv,
        stanza.observability.deploymentIdEnv,
      ]) {
        if (name !== undefined) variables.add(name);
      }
    }
    const configuration = await digestOf(
      JSON.stringify(
        [...variables].sort().map((name) => {
          const value = read(env, name);
          return [name, typeof value === 'string' ? value : null];
        }),
      ),
    );
    const deploymentId = read(env, 'DEPLOYMENT_ID');
    return JSON.stringify([
      [...names].map((name) => identity(read(env, name))),
      typeof deploymentId === 'string' ? deploymentId : null,
      configuration,
    ]);
  }

  function buildPlatform(
    config: PlatformPortConfig,
    bound: Bound,
    executor: SqlExecutor,
    registration: Registration,
    resolveOrg: () => Promise<OrgContext>,
  ) {
    const repository = createJobRepository(executor);
    const schedule = createJobScheduleRepository(executor);
    const routeTemplates = new Set<string>();
    const workersSink = createWorkersSink({
      deploymentId: bound.deploymentId,
      ...(bound.analytics === undefined ? {} : { analytics: bound.analytics }),
      ...(options.console === undefined ? {} : { console: options.console }),
    });
    const newExporter = (): OtlpExporter | undefined =>
      bound.otlp === null
        ? undefined
        : createOtlpExporter({
            endpoint: bound.otlp.endpoint,
            headers: bound.otlp.headers,
            ...(options.otlpFetch === undefined ? {} : { fetchImpl: options.otlpFetch }),
            resource: {
              service: 'package-broker',
              deploymentId: bound.deploymentId,
              runtime: 'cloudflare',
            },
            routeTemplates,
            metrics: {
              counter: (name, labels = {}, value = 1) =>
                workersSink.emit({ kind: 'counter', name, labels, value }),
            },
          });
    let exporter = newExporter();
    let untrackedReported = false;
    const scopes = createScopes(
      async () => {
        const full = exporter;
        if (full === undefined) return;
        exporter = newExporter();
        await full.flush();
      },
      () => {
        if (untrackedReported) return;
        untrackedReported = true;
        try {
          observability.log({ level: 'warn', event: 'cache.put_untracked' });
        } catch {
          return;
        }
      },
    );
    const sink: ObsRecordSink = {
      emit(record) {
        const httpMetric = record.kind !== 'log' && record.name.startsWith('pb.http.');
        if (!(httpMetric && bound.analytics === undefined)) workersSink.emit(record);
        if (exporter !== undefined) bridgeToOtlp(exporter, record, routeTemplates);
      },
    };
    const registry = (templates: ReadonlySet<string>): ObsRegistry => ({
      events: new Set<string>([...KERNEL_EVENTS, ...JOB_EVENTS, ...STARTUP_EVENTS]),
      reasonCodes: new Set<string>([...KERNEL_REASON_CODES, ...JOB_REASON_CODES]),
      routeTemplates: templates,
    });
    const scope = {
      deploymentId: bound.deploymentId,
      runtime: 'cloudflare',
      requestId: null,
    } as const;
    let current = createObservability(sink, scope, registry(routeTemplates));
    const observability = delegatingObservability(() => current);

    const definitions = registration.jobs.map((job) => job.qualifiedName);
    const platformServices: PlatformServices = Object.freeze({
      blob: createBlobStore(createR2ByteStore(bound.bucket), createBlobRepository(executor), {
        admission: uploadAdmission,
        maxBytes: config.blob.maxBytes,
      }),
      cache: createCacheApiAdapter(
        bound.cacheStorage,
        config.cache.namespace ?? DEFAULT_CACHE_NAMESPACE,
        { metrics: observability, waitUntil: (promise) => scopes.track(promise) },
      ),
      jobStore: Object.freeze({
        enqueue: enqueueAndNotify({
          repository,
          send: createJobSender(bound.queue),
          observability,
        }),
        status: (ctx: OrgContext, id: string) => repository.status(ctx, id),
      }),
    });

    const org = async (): Promise<OrgContext | null> => {
      try {
        return await resolveOrg();
      } catch (error) {
        if (error instanceof NotBootstrappedError) return null;
        throw error;
      }
    };

    function attach(kernel: Kernel): Omit<Application, 'kernel'> {
      for (const template of kernel.routeTemplates) routeTemplates.add(template);
      current = createObservability(sink, scope, registry(routeTemplates));
      const consume = createQueueHandler({
        repository,
        jobs: registration,
        observability,
        scope: kernel.jobScope,
        limits: { maxRunning: config.jobs.maxRunning },
        runnerObservability: ({ jobId, attempt }) =>
          createObservability(sink, { ...scope, jobId, attempt }, registry(routeTemplates)),
      });
      const tick = createScheduledHandler({
        repository,
        schedule,
        sendJobs: createJobBatchSender(bound.queue),
        org,
        definitions: scheduleDefinitions(registration.jobs),
        types: definitions,
        observability,
      });
      return {
        async queue(input) {
          const batch = queueBatchOf(input);
          let ctx: OrgContext | null;
          try {
            ctx = await org();
          } catch (error) {
            reportJobEvent(observability, 'error', 'job.batch_failed', error);
            retryAll(batch.messages, (failure) =>
              reportJobEvent(observability, 'error', 'job.retry_failed', failure),
            );
            return;
          }
          const accepted: QueueMessageLike[] = [];
          for (const message of batch.messages) {
            if (ctx !== null && notificationOrg(message?.body) === ctx.orgId) {
              accepted.push(message);
              continue;
            }
            reportJobEvent(observability, 'warn', 'job.notification_rejected');
            try {
              message.ack();
            } catch (error) {
              reportJobEvent(observability, 'error', 'job.ack_failed', error);
            }
          }
          if (accepted.length > 0) await consume({ messages: accepted }, undefined);
        },
        scheduled: (event) => tick(event, undefined),
        begin: scopes.begin,
        fail: (event, error) => reportJobEvent(observability, 'error', event, error),
      };
    }

    function failed(error: unknown): void {
      try {
        observability.log({
          level: 'error',
          event: 'startup.failed',
          error_name: safeErrorName(error),
        });
      } catch {
        return;
      }
    }

    return { platformServices, sink, deploymentId: bound.deploymentId, attach, failed };
  }

  async function build(env: Env | undefined): Promise<Application> {
    const observabilityProblems = brokerObservabilityProblems({
      platform: 'cloudflare',
      plugins,
      ...(options.observability === undefined ? {} : { observability: options.observability }),
    });
    if (observabilityProblems.length > 0) throw new KernelConfigError(observabilityProblems);
    const config = stanza;
    const bound = config === null ? null : resolveBindings(config, env ?? {}, cacheStorage);
    const db = bound?.db ?? env?.DB;
    const executor: SqlExecutor | ScalarSqlExecutor =
      db === undefined ? unboundExecutor() : createD1Executor(db);
    const bootstrap = createOrganizationBootstrap(executor);
    const organizations = createOrganizationRepository(executor);
    const resolveOrg = createOrgResolver(bootstrap);

    const built = db === undefined ? undefined : await buildAuth(executor, plugins, env ?? {}, log);
    const registration = built?.registration ?? collectRegistrations(plugins);
    const auth = built?.auth;
    const services =
      config === null || bound === null
        ? undefined
        : buildPlatform(config, bound, executor as SqlExecutor, registration, resolveOrg);

    const ports: PluginPorts = {
      organizations: Object.freeze({ get: (ctx: OrgContext) => organizations.get(ctx) }),
      clock: systemClock,
      ids: { ulid },
    };

    try {
      const kernel = await createKernel({
        platform: 'cloudflare',
        plugins,
        registration,
        ports,
        ...(services === undefined ? {} : { platformServices: services.platformServices }),
        resolveOrg,
        health: async () => (await bootstrap.findSingleton()) !== null,
        ...(auth === undefined ? {} : { coreRoutes: auth.coreRoutes }),
        ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
        ...(services === undefined
          ? { log }
          : {
              observability: {
                sink: services.sink,
                deploymentId: services.deploymentId,
                trustInboundTraceparent: options.observability?.trustInboundTraceparent === true,
              },
            }),
      });
      if (services === undefined)
        return {
          kernel,
          begin: () => NO_SCOPE,
          fail: (event, error) => logJobFailure(log, event, error),
        };
      return { kernel, ...services.attach(kernel) };
    } catch (error) {
      services?.failed(error);
      throw error;
    }
  }

  async function applicationFor(env: Env | undefined): Promise<Application> {
    const key = await fingerprint(env ?? NO_ENV);
    const cached = applications.get(key);
    if (cached !== undefined) {
      applications.delete(key);
      applications.set(key, cached);
      return cached;
    }

    const pending = build(env).catch((error: unknown) => {
      if (applications.get(key) === pending) applications.delete(key);
      logBuildFailure(log, error);
      throw error;
    });
    if (applications.size >= MAX_CACHED_APPLICATIONS) {
      const oldest = applications.keys().next();
      if (oldest.done !== true) applications.delete(oldest.value);
    }
    applications.set(key, pending);
    return pending;
  }

  function defer(scope: RequestScope, ctx: ExecutionContextLike | undefined): void {
    scope.end();
    if (ctx === undefined) return;
    try {
      ctx.waitUntil(scope.settle().catch(() => undefined));
    } catch {
      return;
    }
  }

  async function event(
    failure: 'job.batch_failed' | 'job.cron_failed',
    pick: (application: Application) => Handler | undefined,
    input: unknown,
    env: Env,
    ctx: ExecutionContextLike | undefined,
    onFailure: () => void,
  ): Promise<void> {
    let application: Application;
    try {
      application = await applicationFor(env);
    } catch (error) {
      logJobFailure(log, failure, error);
      onFailure();
      return;
    }
    const scope = application.begin();
    try {
      const handler = pick(application);
      if (handler === undefined) onFailure();
      else await handler(input);
    } catch (error) {
      application.fail(failure, error);
      onFailure();
    } finally {
      defer(scope, ctx);
    }
  }

  function retryBatch(batch: unknown): void {
    retryAll(queueBatchOf(batch).messages, (error) =>
      logJobFailure(log, 'job.retry_failed', error),
    );
  }

  return {
    plugins,
    async fetch(request: Request, env?: Env, ctx?: ExecutionContextLike): Promise<Response> {
      const requestId = crypto.randomUUID();
      let application: Application;
      try {
        application = await applicationFor(env);
      } catch (error) {
        return withoutBodyForHead(request, errorResponse(error, requestId, log));
      }
      const scope = application.begin();
      try {
        return await application.kernel.fetch(request);
      } catch (error) {
        return withoutBodyForHead(request, errorResponse(error, requestId, log));
      } finally {
        defer(scope, ctx);
      }
    },
    queue: (batch, env, ctx) =>
      event(
        'job.batch_failed',
        (application) => application.queue,
        batch,
        env,
        ctx,
        () => retryBatch(batch),
      ),
    scheduled: (input, env, ctx) =>
      event(
        'job.cron_failed',
        (application) => application.scheduled,
        input,
        env,
        ctx,
        () => undefined,
      ),
  };
}
