import { auditWarningEvent } from '@package-broker/core/audit/config';
import {
  AuditEffectiveConfigError,
  AuditResolutionError,
  logAuditUnavailable,
  claimAuditResolutionLog,
  resolveOrgAudit,
  validateAuditBuild,
  type EffectiveAuditConfig,
} from '@package-broker/core/audit/effective';
import { enterAuditNone } from '@package-broker/core/audit/none';
import { pruneAudit } from '@package-broker/core/audit/prune';
import { evictAudit } from '@package-broker/core/audit/capacity';
import { createAuditHealthService, raiseAuditAlert } from '@package-broker/core/audit/health';
import { reconcileAuditSinks } from '@package-broker/core/audit/sinks/registry';
import { DEFAULT_AUDIT_REJECTION_RETRIES } from '@package-broker/core/audit/export-state';
import { resolveAuditDestination } from '@package-broker/core/audit/sinks/transport';
import { auditExportJob } from '@package-broker/core/audit/export';
import { detectAuditFork } from '@package-broker/core/audit/fork';
import type { AuditSink } from '@package-broker/core/audit/plugin-api';
import { brokerAuditWarnings, type BrokerConfig } from '@package-broker/core/config';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import type { Registration } from '@package-broker/core/kernel/registry';
import { KernelConfigError } from '@package-broker/core/kernel/registry';
import { JobError, type JobDefinition } from '@package-broker/core/platform/jobs';
import type { Observability } from '@package-broker/core/platform/observability';
import { systemClock, ulid } from '@package-broker/core/ids';
import {
  auditAlertPathActive,
  validAuditAlertDestination,
} from '@package-broker/core/audit/destinations';
import { createAuditEffectiveRepository } from '@package-broker/db-sqlite/repositories/audit-effective';
import { createAuditNoneRepository } from '@package-broker/db-sqlite/repositories/audit-none';
import { createAuditSinkRepository } from '@package-broker/db-sqlite/repositories/audit-sink';
import { createAuditPruneRepository } from '@package-broker/db-sqlite/repositories/audit-prune';
import { createAuditHealthRepository } from '@package-broker/db-sqlite/repositories/audit-health';
import { createAuditStatusReader } from '@package-broker/db-sqlite/repositories/audit-status';
import { createAuditExportRepository } from '@package-broker/db-sqlite/repositories/audit-export';
import { createAuditForkRepository } from '@package-broker/db-sqlite/repositories/audit-fork';

const nativeFetch = globalThis.fetch;

export async function createWorkerAudit(input: {
  readonly config: BrokerConfig;
  readonly env: (name: string) => string | undefined;
  readonly executor: SqlExecutor;
  readonly observability: Observability;
  readonly deploymentId?: string;
  readonly generation: number;
  readonly telemetryActive: boolean;
  readonly dispatch?: (run: () => Promise<void>) => void;
  readonly maxJournalBytes: number | null;
  readonly registration: () => Registration;
}) {
  const { executor, observability, generation, env } = input;
  if (!Number.isSafeInteger(generation) || generation < 0)
    throw new KernelConfigError(['Invalid audit build generation']);
  const build = (() => {
    try {
      return validateAuditBuild(input.config, env, 'cloudflare');
    } catch (error) {
      if (!(error instanceof AuditEffectiveConfigError) || error.code !== 'none_not_accepted')
        throw error;
      return {
        ...validateAuditBuild(
          { ...input.config, audit: { ...input.config.audit, acceptNoDurableAudit: true } },
          env,
          'cloudflare',
        ),
        accepted: false,
        acceptanceSource: null,
      };
    }
  })();
  for (const warning of brokerAuditWarnings(
    { ...input.config, audit: { ...input.config.audit, policy: build.policy } },
    input.config.platform,
  )) {
    const event = auditWarningEvent(warning.code);
    observability.log({ level: 'warn', event, reason_code: event });
  }
  const capacity = input.maxJournalBytes === null ? {} : { maxJournalBytes: input.maxJournalBytes };
  const none = createAuditNoneRepository(executor, observability);
  const transitions = createAuditEffectiveRepository(executor);
  const sinks = createAuditSinkRepository(executor);
  const alertEndpoint = input.config.audit?.alerts?.webhookEnv;
  const alertUrl = alertEndpoint === undefined ? undefined : env(alertEndpoint);
  const alertFetch: typeof fetch = (url, init) => nativeFetch(url, { ...init, redirect: 'manual' });
  if (alertEndpoint !== undefined && !validAuditAlertDestination(alertUrl))
    throw new KernelConfigError(['Audit alert destination is invalid']);
  const alertPathActive = auditAlertPathActive(input.telemetryActive, alertUrl);
  if (build.policy === 'required' && !alertPathActive)
    throw new KernelConfigError(['Audit alert path is unavailable']);
  const sendAlert = async (code: string): Promise<void> => {
    if (alertUrl === undefined) return;
    try {
      const response = await alertFetch(alertUrl, {
        method: 'POST',
        body: JSON.stringify({ code }),
        headers: { 'content-type': 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(1500),
      });
      await response.body?.cancel();
    } catch {
      // Persistent health remains the backstop when alert delivery fails.
    }
  };
  const healthObservability: Observability = {
    ...observability,
    log(record) {
      observability.log(record);
      if (record.event === 'audit.alert' && typeof record.reason_code === 'string') {
        const code = record.reason_code;
        if (input.dispatch === undefined) void sendAlert(code);
        else input.dispatch(() => sendAlert(code));
      }
    },
  };
  const health = createAuditHealthService({
    port: createAuditHealthRepository(executor),
    clock: systemClock,
    observability: healthObservability,
  });
  const prune = createAuditPruneRepository(executor, healthObservability, capacity);
  const destinations = await Promise.all(
    input.registration().audit.sinks.map(async (owned) => {
      const definition = owned.definition;
      const destination = await resolveAuditDestination({
        id: definition.id,
        runtime: 'cloudflare',
        ...(input.config.audit === undefined ? {} : { audit: input.config.audit }),
        destination: definition.destination,
        activation: definition.activation,
        env,
        fetchImpl: (url, init) => nativeFetch(url, { ...init, redirect: 'manual' }),
      });
      if (destination !== null && input.deploymentId === undefined)
        throw new KernelConfigError(['Audit sinks require a configured deployment id']);
      return { ...owned, destination };
    }),
  );
  const instances = new Map<string, AuditSink>();
  const sinkInstance = (id: string): AuditSink => {
    const cached = instances.get(id);
    if (cached !== undefined) return cached;
    const owned = input.registration().audit.sinks.find((sink) => sink.definition.id === id);
    const destination = destinations.find((sink) => sink.definition.id === id)?.destination;
    if (owned === undefined || destination == null)
      throw new KernelConfigError(['Audit sink is unavailable']);
    const allowed = new Set(owned.definition.envNames ?? []);
    const instance = owned.definition.create({
      deploymentId: input.deploymentId!,
      runtime: 'cloudflare',
      fetch: destination.fetch,
      env: (name) => (allowed.has(name) ? env(name) : undefined),
      clock: systemClock,
    });
    instances.set(id, instance);
    return instance;
  };
  const configured = destinations.map(({ plugin, definition, destination }) => ({
    id: definition.id,
    pluginId: plugin,
    kind: definition.kind,
    durableAck: definition.custody === 'durable',
    destination,
  }));
  const raise = async (org: OrgContext, code: Parameters<typeof health.raise>[1]) => {
    await raiseAuditAlert(health, org, code);
  };
  const reconciliations = new Map<string, Promise<'applied' | 'stale' | 'contended'>>();
  const reconcile = (org: OrgContext) => {
    let work = reconciliations.get(org.orgId);
    if (work === undefined) {
      work = reconcileAuditSinks(sinks, org, generation, configured, systemClock.now());
      reconciliations.set(org.orgId, work);
      void work.then(
        (outcome) => {
          if (outcome === 'contended') reconciliations.delete(org.orgId);
        },
        () => {
          reconciliations.delete(org.orgId);
        },
      );
    }
    return work;
  };
  const resolve = async (org: OrgContext): Promise<EffectiveAuditConfig> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const reconciled = await reconcile(org);
      if (reconciled === 'stale') throw new AuditResolutionError('audit_generation_stale');
      if (reconciled === 'contended') continue;
      const snapshot = await none.snapshot(org);
      const state = await sinks.read(org);
      if (state.sinks.some((sink) => sink.generation > generation))
        throw new AuditResolutionError('audit_generation_stale');
      const resolved = resolveOrgAudit({
        build,
        storedPolicy: snapshot.policy,
        sinks: state.sinks,
        alertPathActive,
      });
      if (!resolved.ok) {
        if (resolved.persistRaise) {
          const raised: EffectiveAuditConfig = {
            policy: 'required',
            policySource: build.policySource,
            persistRaise: true,
            mode: snapshot.pendingMode ?? snapshot.mode,
            trailActive: false,
            activeSinkIds: [],
            blockedSinkIds: [],
            durableSinkIds: [],
            durablePath: false,
            maxJournalBytes: build.maxJournalBytes,
            warnings: [],
          };
          if (
            !(await transitions.save(
              org,
              snapshot,
              raised,
              generation,
              systemClock.now().toISOString(),
              true,
            ))
          )
            continue;
        }
        throw new AuditResolutionError(resolved.code);
      }
      if (snapshot.pendingMode !== null && snapshot.pendingMode !== resolved.effective.mode)
        throw new AuditResolutionError(
          'audit_cutover_refused',
          resolved.effective.policy === 'required',
        );
      if (
        snapshot.modeGeneration === 0 &&
        snapshot.headSeq === 0 &&
        (await transitions.initialize(org, snapshot, resolved.effective, generation))
      ) {
        cache.delete(org.orgId);
        return resolved.effective;
      }
      if (resolved.effective.mode === 'none') {
        const outcome = await enterAuditNone(none, org, {
          audit: { build, sinks: state.sinks, alertPathActive },
          generation,
          now: systemClock.now().toISOString(),
          ids: [ulid(), ulid(), ulid()],
        });
        if (outcome.outcome === 'contended') continue;
        if (outcome.outcome !== 'degraded') throw new AuditResolutionError('audit_cutover_refused');
      } else if (
        !(await transitions.save(
          org,
          snapshot,
          resolved.effective,
          generation,
          systemClock.now().toISOString(),
        ))
      )
        continue;
      cache.delete(org.orgId);
      if (snapshot.pendingMode === null && snapshot.mode !== resolved.effective.mode)
        await raise(org, 'audit.mode_change');
      return resolved.effective;
    }
    throw new AuditResolutionError('audit_unavailable');
  };
  const cache = new Map<
    string,
    { generation: number; expires: number; value: Promise<EffectiveAuditConfig> }
  >();
  const effective = (org: OrgContext): Promise<EffectiveAuditConfig> => {
    const hit = cache.get(org.orgId);
    if (hit !== undefined && hit.generation === generation && hit.expires > Date.now())
      return hit.value;
    const value = resolve(org).then(
      (resolved) => {
        const stable = {
          ...resolved,
          persistRaise: false,
          policySource:
            resolved.policy === 'required' ? ('stored' as const) : resolved.policySource,
        };
        cache.set(org.orgId, {
          generation,
          expires: Date.now() + 30_000,
          value: Promise.resolve(stable),
        });
        return resolved;
      },
      (error: unknown) => {
        throw error instanceof AuditResolutionError
          ? error
          : new AuditResolutionError('audit_unavailable');
      },
    );
    cache.set(org.orgId, { generation, expires: Date.now() + 30_000, value });
    void value.catch((error: unknown) => {
      if (cache.get(org.orgId)?.value !== value) return;
      if (error instanceof AuditResolutionError && !error.transient)
        cache.set(org.orgId, { generation, expires: Date.now() + 30_000, value });
      else cache.delete(org.orgId);
    });
    return value;
  };
  const backgroundTrailActive = async (org: OrgContext): Promise<boolean> => {
    try {
      return (await effective(org)).trailActive;
    } catch (error) {
      if (!(error instanceof AuditResolutionError) || error.code !== 'audit_cutover_refused')
        throw error;
      const snapshot = await none.snapshot(org);
      if (snapshot.pendingMode === null) throw error;
      return snapshot.pendingMode === 'trail';
    }
  };
  const resolveRequest = async (org: OrgContext, request?: Request): Promise<void> => {
    try {
      await effective(org);
    } catch (error) {
      if (!(error instanceof AuditResolutionError))
        throw new AuditResolutionError('audit_unavailable');
      if (request === undefined || error.transient) throw error;
      if (request.method === 'GET' || request.method === 'HEAD') {
        logAuditUnavailable(request, (record) => observability.log(record), error);
        return;
      }
      if (!error.fenceWrites) {
        logAuditUnavailable(request, (record) => observability.log(record), error);
        return;
      }
      const path = new URL(request.url).pathname;
      const security =
        (request.method === 'POST' &&
          ([
            '/_pb/auth/local/login',
            '/_pb/auth/local/reauth',
            '/_pb/auth/local/setup/start',
            '/_pb/auth/local/setup/finish',
            '/_pb/auth/logout',
          ].includes(path) ||
            /^\/_pb\/auth\/sso\/[^/]+\/start$/.test(path))) ||
        (request.method === 'DELETE' &&
          (/^\/_pb\/(?:me\/)?tokens\/[^/]+$/.test(path) ||
            /^\/_pb\/grants\/[^/]+$/.test(path) ||
            /^\/_pb\/projects\/[^/]+\/(?:tokens|grants)\/[^/]+$/.test(path)));
      if (!security) throw error;
    }
  };
  const validate = (payload: unknown): Record<string, never> => {
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload) ||
      Reflect.ownKeys(payload).length !== 0
    )
      throw new JobError('invalid_payload');
    return {};
  };
  const jobs: JobDefinition[] = [
    {
      name: 'audit-maintain',
      version: 1,
      maxAttempts: 3,
      schedule: { everySeconds: 60, resourceKey: 'audit-maintain' },
      validate,
      async handler(_payload, context) {
        const trailActive = await backgroundTrailActive(context.org);
        await pruneAudit(prune, context.org, {
          generation,
          configuredSinkIds: input.registration().audit.sinks.map((sink) => sink.definition.id),
          trailActive,
        });
        if (input.maxJournalBytes !== null)
          await evictAudit(prune, context.org, {
            generation,
            maxJournalBytes: input.maxJournalBytes,
          });
        cache.delete(context.org.orgId);
      },
    },
    {
      name: 'audit-health-observe',
      version: 1,
      maxAttempts: 3,
      schedule: { everySeconds: 60, resourceKey: 'audit-health-observe' },
      validate,
      async handler(_payload, context) {
        await health.read(context.org);
      },
    },
    {
      name: 'audit-frontier',
      version: 1,
      maxAttempts: 3,
      schedule: { everySeconds: 86400, resourceKey: 'audit-frontier' },
      validate,
      async handler(_payload, context) {
        await probe(context.org, context.signal);
      },
    },
  ];
  async function probe(org: OrgContext, signal: AbortSignal) {
    await backgroundTrailActive(org);
    await health.read(org);
    const outcome = await detectAuditFork(createAuditForkRepository(executor), org, {
      generation,
      now: systemClock.now(),
      signal,
      probes: destinations
        .filter((sink) => sink.destination !== null)
        .map((sink) => ({ id: sink.definition.id, sink: sinkInstance(sink.definition.id) })),
      alert: () => {
        observability.log({
          level: 'error',
          event: 'audit.delivery_loss',
          reason_code: 'audit.fork',
        });
        void raise(org, 'audit.fork');
      },
    });
    if (!['clear', 'blocked'].includes(outcome)) throw new JobError('lease_lost');
  }
  for (const { plugin, definition, destination } of destinations) {
    if (destination === null) continue;
    const job = auditExportJob(createAuditExportRepository(executor), {
      id: definition.id,
      generation,
      pluginVersion: String(
        input.config.plugins.find((entry) => entry.id === plugin)?.apiVersion ?? 4,
      ),
      sourceIp: definition.sourceIp,
      ...(definition.maxBatchEvents === undefined
        ? {}
        : { maxBatchEvents: definition.maxBatchEvents }),
      rejectionRetries:
        definition.destination.protocol === 'otlp-http-json'
          ? 'terminal'
          : (definition.skipAfter ?? DEFAULT_AUDIT_REJECTION_RETRIES),
      sink: { deliver: (batch, signal) => sinkInstance(definition.id).deliver(batch, signal) },
      now: () => systemClock.now(),
      health: { raise },
    });
    jobs.push({
      ...job,
      async handler(payload, context) {
        await backgroundTrailActive(context.org);
        await job.handler(job.validate(payload), context);
      },
    });
  }
  return {
    effective,
    resolveRequest,
    async admitJob(org: OrgContext): Promise<boolean> {
      try {
        await effective(org);
        return true;
      } catch (error) {
        if (!(error instanceof AuditResolutionError)) throw error;
        if (!error.transient && !error.fenceWrites) return true;
        if (claimAuditResolutionLog(error))
          observability.log({
            level: 'error',
            event: 'audit.effective_unavailable',
            reason_code: 'audit.effective_unavailable',
          });
        return false;
      }
    },
    health,
    jobs,
    probe,
    raise,
    capacity,
    status: {
      reader: createAuditStatusReader(executor),
      effective,
      modeSource: async (org: OrgContext): Promise<'build' | 'env' | 'stored'> => {
        const resolved = await effective(org);
        if (resolved.policy === 'required') return resolved.policySource;
        const toggle = input.registration().audit.trail?.definition.toggleEnv;
        return toggle !== undefined && env(toggle) !== undefined ? 'env' : 'build';
      },
    },
  };
}
