import { dirname, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { normalizeQueueConsumer } from './queue-consumer.js';
import {
  CloudflareApi,
  CloudflareError,
  cloudflareCredentials,
  commandEnvelope,
  failCommand,
  object,
  type CommandResult,
} from './api.js';
import {
  reconcileCandidatePreview,
  rollbackDeployment,
  active,
  cloudflareDeployContract,
  versionAnnotationsMatch,
  withCandidatePreview,
  type DeployProviderContract,
} from './deploy.js';
import {
  installIdentity,
  InventoryStore,
  type DeploymentAttempt,
  type Distribution,
  type Inventory,
  type InventoryTransaction,
  type Jurisdiction,
  type SmokeCheck,
} from './inventory.js';

export interface SmokeOptions {
  workerName: string;
  configPath?: string;
  projectRoot?: string;
  outDir?: string;
  environment?: string;
  deploymentId?: string;
  inventory?: string;
  jurisdiction?: Jurisdiction;
  project?: string;
  publicUrl?: string;
  smokeTokenEnv?: string;
  deadlineSeconds?: number;
  noRollback?: boolean;
  dryRun?: boolean;
  json?: boolean;
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  contract?: DeployProviderContract;
  transaction?: InventoryTransaction;
}
const invalid = (): never => {
  throw new CloudflareError('invalid_input', 2, false, 'smoke');
};
const conflict = (): never => {
  throw new CloudflareError('ownership_conflict', 8, false, 'smoke');
};
const failed = (): never => {
  throw new CloudflareError('smoke_failed', 9, false, 'smoke');
};
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
function origin(raw: string): string {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' ||
      u.origin !== raw ||
      u.port ||
      u.username ||
      u.password ||
      u.hostname === 'localhost' ||
      !u.hostname.includes('.')
    )
      return invalid();
    return u.origin;
  } catch {
    return invalid();
  }
}
const sorted = (d: Distribution[]) =>
  [...d].sort((a, b) => a.version_id.localeCompare(b.version_id));
const equalDistribution = (a: Distribution[], b: Distribution[]) =>
  JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
function candidate(a: DeploymentAttempt): Distribution[] {
  return [
    { version_id: a.version_id!, percentage: a.requested_rollout },
    ...(a.requested_rollout === 100
      ? []
      : [{ version_id: a.previous_version_id!, percentage: 100 - a.requested_rollout }]),
  ];
}
async function liveDistribution(api: CloudflareApi, base: string): Promise<Distribution[]> {
  const live = await active(api, base);
  if (!live.versions.length) return conflict();
  return live.versions;
}
async function ownership(api: CloudflareApi, base: string, j: Inventory) {
  const settings = object((await api.request(`${base}/settings`)).result);
  if (
    !Array.isArray(settings.tags) ||
    !settings.tags.includes('pb-install-v1') ||
    !settings.tags.includes(`pb-owner-${j.identity.owner_digest}`) ||
    !Array.isArray(settings.bindings)
  )
    return conflict();
  const bindings = settings.bindings.map(object);
  for (const b of bindings) {
    if (b.type === 'secret_text' && (Object.hasOwn(b, 'text') || Object.hasOwn(b, 'value')))
      return conflict();
    if (
      b.name === 'DEPLOYMENT_ID' &&
      (b.type !== 'plain_text' || b.text !== j.identity.deployment_id)
    )
      return conflict();
    if (b.type === 'd1' && (b.name !== 'DB' || b.id !== j.resources.d1?.id)) return conflict();
    if (
      b.type === 'r2_bucket' &&
      (b.bucket_name !== j.resources.r2?.name || b.jurisdiction !== j.identity.jurisdiction)
    )
      return conflict();
    if (b.type === 'queue' && b.queue_name !== j.resources.jobs?.name) return conflict();
    if (b.type === 'analytics_engine' && b.dataset !== j.resources.analytics?.name)
      return conflict();
  }
  const urls = bindings.filter((b) => b.name === 'PB_PUBLIC_URL');
  if (urls.length !== 1 || urls[0]!.type !== 'plain_text' || typeof urls[0]!.text !== 'string')
    return conflict();
  return origin(urls[0]!.text);
}
async function endpointPolicy(
  api: CloudflareApi,
  base: string,
  canonical: string,
  a?: DeploymentAttempt,
  restored = false,
) {
  const p = object((await api.request(`${base}/subdomain`)).result);
  if (typeof p.enabled !== 'boolean' || typeof p.previews_enabled !== 'boolean') return failed();
  const enabled =
    a && a.intended_settings.endpoints.enabled && (!restored || a.prior_settings.endpoints.enabled);
  const reconciling =
    a?.phase === 'rollback_pending' &&
    p.enabled === (a.prior_settings.endpoints.enabled && a.intended_settings.endpoints.enabled);
  if (p.previews_enabled || (a && p.enabled !== enabled && !reconciling)) return failed();
  if (a && (a.intended_settings.domain || a.intended_settings.routes.length) && p.enabled)
    return failed();
  if (!a) {
    const domains = await api.list('/workers/domains');
    const custom =
      !new URL(canonical).hostname.endsWith('.workers.dev') ||
      domains.some((d) => d.service === base.slice('/workers/scripts/'.length));
    if (custom && p.enabled) return failed();
  }
}

async function verifyRestoredSettings(api: CloudflareApi, base: string, j: Inventory) {
  const a = j.deployment!.attempt;
  const expected = structuredClone(a.prior_settings);
  for (const change of a.changes) {
    if (change.kind === 'endpoints') continue;
    if (change.restoration === 'retained_first_install')
      Object.assign(expected, { [change.kind]: a.intended_settings[change.kind] });
    else if (change.restoration !== 'restored') return failed();
  }
  const schedules = object((await api.request(`${base}/schedules`)).result).schedules;
  if (
    !Array.isArray(schedules) ||
    !isDeepStrictEqual(schedules.map((s) => object(s).cron).sort(), [...expected.schedules].sort())
  )
    return failed();
  const consumers = j.resources.jobs?.id
    ? await api.snapshot(`/queues/${j.resources.jobs.id}/consumers`)
    : [];
  if (j.resources.dlq?.id && (await api.snapshot(`/queues/${j.resources.dlq.id}/consumers`)).length)
    return failed();
  if (consumers.length !== (expected.consumer ? 1 : 0)) return failed();
  if (expected.consumer) {
    const c = normalizeQueueConsumer(consumers[0]!);
    if (
      !c ||
      !isDeepStrictEqual({ ...c, consumer_id: null }, { ...expected.consumer, consumer_id: null })
    )
      return failed();
  }
  const routeKey = (r: { zone_id: unknown; pattern: unknown; script: unknown }) =>
    JSON.stringify([r.zone_id, r.pattern, r.script]);
  const routes: string[] = [];
  const zones = new Set(
    [...a.prior_settings.routes, ...a.intended_settings.routes].map((r) => r.zone_id),
  );
  for (const zone of zones) {
    let complete = false;
    for (let page = 1; page <= 10_000; page++) {
      const response = await api.requestZone(zone, `/workers/routes?page=${page}&per_page=100`);
      if (!Array.isArray(response.result)) return failed();
      for (const raw of response.result) {
        const r = object(raw);
        if (r.script === j.identity.script_name)
          routes.push(routeKey({ zone_id: zone, pattern: r.pattern, script: r.script }));
      }
      const pages = response.result_info?.total_pages;
      if (pages === page || (pages === 0 && response.result.length === 0)) {
        complete = true;
        break;
      }
      if (typeof pages !== 'number' || !Number.isSafeInteger(pages) || pages < page)
        return failed();
    }
    if (!complete) return failed();
  }
  const allowed = new Set(expected.routes.map(routeKey));
  if (
    routes.some((r) => !allowed.has(r)) ||
    a.prior_settings.routes.some((r) => !routes.includes(routeKey(r)))
  )
    return failed();
  const domains = (await api.list('/workers/domains')).filter(
    (d) => d.service === j.identity.script_name || d.hostname === expected.domain?.hostname,
  );
  if (domains.length !== (expected.domain ? 1 : 0)) return failed();
  if (
    expected.domain &&
    !(['zone_id', 'hostname', 'service', 'environment'] as const).every(
      (key) => domains[0]![key] === expected.domain![key],
    )
  )
    return failed();
}
async function candidateArtifact(api: CloudflareApi, base: string, a: DeploymentAttempt) {
  const v = object((await api.request(`${base}/versions/${a.version_id}`)).result);
  const annotations = object(v.annotations);
  if (v.id !== a.version_id || !versionAnnotationsMatch(annotations, a)) return failed();
}

interface ProbeContext {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadline: number;
  checks: SmokeCheck[];
  onFailure?: (() => Promise<void>) | undefined;
}
function errorCode(body: unknown): string | null {
  return record(body) &&
    record(body.error) &&
    typeof body.error.code === 'string' &&
    typeof body.error.message === 'string' &&
    typeof body.error.requestId === 'string'
    ? body.error.code
    : null;
}
function npmErrorCode(body: unknown): string | null {
  return record(body) &&
    typeof body.error === 'string' &&
    typeof body.code === 'string' &&
    typeof body.requestId === 'string'
    ? body.code
    : null;
}
function composer(body: Record<string, unknown>, project: string, canonical: string): boolean {
  if (!record(body.packages) && !(Array.isArray(body.packages) && body.packages.length === 0))
    return false;
  const metadata = body['metadata-url'];
  if (typeof metadata === 'string') {
    // Validate the protocol reference without fetching it or following another origin.
    return (
      metadata === `/${project}/p2/%package%.json` ||
      metadata === `${canonical}/${project}/p2/%package%.json`
    );
  }
  return (
    record(body['provider-includes']) &&
    Object.keys(body['provider-includes']).length > 0 &&
    typeof body['providers-url'] === 'string' &&
    body['providers-url'].startsWith(`/${project}/`)
  );
}
async function assertionAttempts(
  ctx: ProbeContext,
  url: string,
  name: SmokeCheck['name'],
  kind: 'ready' | 'negative' | 'npm_negative' | 'composer' | 'npm',
  project: string,
  canonical: string,
  authorization?: string,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    const started = ctx.now();
    let status: SmokeCheck['status'] = 'failed';
    let delayHeader: string | null = null;
    let response: Response | undefined;
    const controller = new AbortController();
    const remaining = ctx.deadline - started;
    if (remaining <= 0) return failed();
    const timer = setTimeout(() => controller.abort(), Math.min(5000, remaining));
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(new Error()), { once: true }),
    );
    try {
      try {
        response = await Promise.race([
          ctx.fetch(url, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal,
            headers: { accept: 'application/json', ...(authorization ? { authorization } : {}) },
          }),
          aborted,
        ]);
      } catch {
        status = controller.signal.aborted ? 'timeout' : 'connection';
        if (kind !== 'ready') return failed();
      }
      if (response) {
        if (response.redirected || (response.url && response.url !== url)) return failed();
        if (response.status === 429) {
          status = 'rate_limited';
          delayHeader = response.headers.get('retry-after');
        } else {
          if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? ''))
            return failed();
          const reader = response.body?.getReader();
          if (!reader) return failed();
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const part = await Promise.race([reader.read(), aborted]);
              if (part.done) break;
              bytes += part.value.byteLength;
              if (bytes > 262_144) return failed();
              chunks.push(part.value);
            }
          } finally {
            void reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          let body: unknown;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            return failed();
          }
          if (!record(body)) return failed();
          if (kind === 'ready' && response.status === 503 && errorCode(body) === 'not_ready') {
            status = 'not_ready';
          } else {
            const valid =
              kind === 'ready'
                ? response.status === 200 && body.status === 'ready'
                : kind === 'negative'
                  ? response.status === 401 && errorCode(body) === 'unauthorized'
                  : kind === 'npm_negative'
                    ? response.status === 401 && npmErrorCode(body) === 'unauthorized'
                    : kind === 'composer'
                      ? response.status === 200 && composer(body, project, canonical)
                      : response.status === 200;
            if (!valid) return failed();
            status = 'passed';
          }
        }
      }
      if (ctx.now() >= ctx.deadline) {
        status = 'timeout';
        return failed();
      }
    } catch {
      if (controller.signal.aborted) status = 'timeout';
      return failed();
    } finally {
      clearTimeout(timer);
      controller.abort();
      void response?.body?.cancel().catch(() => undefined);
      ctx.checks.push({
        name,
        status,
        attempt,
        elapsed_ms: Math.max(0, Math.ceil(ctx.now() - started)),
      });
    }
    if (status === 'passed') return;
    let delay = Math.min(10_000, 1000 * 2 ** Math.min(attempt - 1, 4));
    if (delayHeader) {
      const requested = /^\d+$/.test(delayHeader)
        ? Number(delayHeader) * 1000
        : Date.parse(delayHeader) - ctx.now();
      if (Number.isFinite(requested) && requested >= 0) delay = Math.max(delay, requested);
    }
    if (ctx.now() + delay >= ctx.deadline) return failed();
    await ctx.sleep(delay);
  }
}
async function assertion(...args: Parameters<typeof assertionAttempts>): Promise<void> {
  try {
    await assertionAttempts(...args);
  } catch (error) {
    await args[0].onFailure?.();
    throw error;
  }
}
async function probes(
  ctx: ProbeContext,
  url: string,
  prefix: 'canonical' | 'candidate',
  project: string,
  canonical: string,
  token?: string,
) {
  await assertion(ctx, `${url}/health/ready`, `${prefix}_ready`, 'ready', project, canonical);
  await assertion(
    ctx,
    `${url}/${project}/packages.json`,
    `${prefix}_composer_unauthorized`,
    'negative',
    project,
    canonical,
  );
  await assertion(
    ctx,
    `${url}/${project}/npm/-/ping`,
    `${prefix}_npm_unauthorized`,
    'npm_negative',
    project,
    canonical,
  );
  if (token) {
    await assertion(
      ctx,
      `${url}/${project}/packages.json`,
      `${prefix}_composer_authorized`,
      'composer',
      project,
      canonical,
      `Basic ${Buffer.from(`token:${token}`).toString('base64')}`,
    );
    await assertion(
      ctx,
      `${url}/${project}/npm/-/ping`,
      `${prefix}_npm_authorized`,
      'npm',
      project,
      canonical,
      `Bearer ${token}`,
    );
  }
}

export async function smoke(o: SmokeOptions): Promise<CommandResult> {
  const output = commandEnvelope('smoke', o.dryRun);
  let release: (() => Promise<void>) | undefined;
  let result: CommandResult = { exitCode: 1, output };
  try {
    const seconds = o.deadlineSeconds ?? 120;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > 300) return invalid();
    const tokenName = o.smokeTokenEnv ?? 'PB_SMOKE_TOKEN';
    if (
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(tokenName) ||
      ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].includes(tokenName)
    )
      return invalid();
    const token = o.env[tokenName];
    const project = o.project ?? 'pb-smoke-unassigned';
    if (
      !/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(project) ||
      ['health', '_pb', 'auth', 'setup', 'callback', 'login'].includes(project) ||
      (token && (!o.project || o.project === 'pb-smoke-unassigned')) ||
      (o.smokeTokenEnv !== undefined && !token) ||
      (token && (!/^[\x21-\x7e]+$/.test(token) || token === o.env.CLOUDFLARE_API_TOKEN))
    )
      return invalid();
    if (o.publicUrl) origin(o.publicUrl);
    const auth = cloudflareCredentials(o.env);
    const identity = installIdentity({
      ...auth,
      workerName: o.workerName,
      ...(o.environment === undefined ? {} : { environment: o.environment }),
      ...(o.deploymentId === undefined ? {} : { deploymentId: o.deploymentId }),
      ...(o.jurisdiction === undefined ? {} : { jurisdiction: o.jurisdiction }),
    });
    const root = resolve(o.projectRoot ?? dirname(resolve(o.configPath ?? 'broker.config.ts')));
    const store = await InventoryStore.create({
      project: root,
      outDir: resolve(root, o.outDir ?? '.pb/cloudflare'),
      identity,
      ...(o.inventory === undefined ? {} : { inventory: o.inventory }),
    });
    if (o.transaction) o.transaction.assertStore(store);
    const now = o.now ?? Date.now;
    const sleep =
      o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const transport = o.fetch ?? fetch;
    const end = now() + seconds * 1000;
    const apiOptions = {
      ...auth,
      fetch: transport,
      now,
      sleep,
      jitter: () => 0,
      minimumMutationBudgetMs: 1,
    };
    const api = new CloudflareApi({ ...apiOptions, deadline: end });
    if (!o.dryRun && !o.transaction) release = await store.lock(now());
    const j = await store.read();
    if (
      !j ||
      !j.resources.d1?.id ||
      j.resources.d1.state !== 'complete' ||
      j.operations.some((op) => ['pending', 'unknown'].includes(op.state))
    )
      return invalid();
    const a = j.deployment?.attempt;
    if (
      a &&
      (!a.version_id ||
        !a.activated_at ||
        !['active', 'verified', 'failed', 'rollback_pending', 'rolled_back'].includes(a.phase))
    )
      return invalid();
    if (
      a &&
      a.requested_rollout < 100 &&
      (!a.candidate_probe_url || !a.previous_version_id || a.candidate_probe_url === a.worker_url)
    )
      return invalid();
    if (
      a &&
      (a.intended_settings.endpoints.previews_enabled ||
        ((a.intended_settings.domain || a.intended_settings.routes.length) &&
          a.intended_settings.endpoints.enabled))
    )
      return invalid();
    const previousReceipt = j.deployment?.last_verified;
    const previousOrigin =
      a && previousReceipt?.version_id === a.previous_version_id
        ? previousReceipt?.worker_url
        : undefined;
    output.database_id = j.resources.d1.id;
    output.r2_bucket = j.resources.r2?.id ?? null;
    output.queue_names = [j.resources.jobs?.name, j.resources.dlq?.name].filter(
      (n): n is string => n !== undefined,
    );
    output.migrations_applied = o.transaction?.recordAppliedMigrations([]) ?? [];
    if (a) {
      origin(a.worker_url);
      if (a.candidate_probe_url) origin(a.candidate_probe_url);
      output.version_id = a.version_id;
      output.previous_version_id = a.previous_version_id;
      output.build_info = a.build_info;
      output.artifact_sha256 = a.artifact_sha256;
    }
    const save = async () => {
      j.revision++;
      j.updated_at = new Date(now()).toISOString();
      await store.write(j);
    };
    const base = `/workers/scripts/${identity.script_name}`;
    const liveOrigin = await ownership(api, base, j);
    const canonical = a?.worker_url ?? liveOrigin;
    if (o.publicUrl && o.publicUrl !== canonical) return conflict();
    output.worker_url = canonical;
    const prior = a?.previous_version_id
      ? [{ version_id: a.previous_version_id, percentage: 100 }]
      : [];
    const initialDistribution = await liveDistribution(api, base);
    const assertDistribution = async (client: CloudflareApi, observed?: Distribution[]) => {
      const live = observed ?? (await liveDistribution(client, base));
      if (
        a
          ? !equalDistribution(live, candidate(a)) &&
            !(
              ['rollback_pending', 'rolled_back'].includes(a.phase) &&
              equalDistribution(live, prior)
            )
          : !equalDistribution(live, initialDistribution)
      ) {
        output.rollback.status = 'conflict';
        return conflict();
      }
      return live;
    };
    const current = await assertDistribution(api, initialDistribution);
    const restored =
      a &&
      ['rollback_pending', 'rolled_back'].includes(a.phase) &&
      equalDistribution(current, prior);
    const expectedOrigin = restored ? previousOrigin : canonical;
    if (expectedOrigin && liveOrigin !== expectedOrigin) return conflict();
    const blocked =
      a &&
      (!a.rollback_compatible ||
        a.contract_ids.length ||
        !j.migrations.rollback_compatible ||
        j.migrations.contract_ids.length);
    if (o.dryRun) {
      await endpointPolicy(api, base, canonical, a, !!restored);
      output.status = 'planned';
      for (const prefix of a && a.requested_rollout < 100
        ? ['canonical', 'candidate']
        : ['canonical'])
        for (const name of [
          'ready',
          'composer_unauthorized',
          'npm_unauthorized',
          ...(token ? ['composer_authorized', 'npm_authorized'] : []),
        ])
          output.plan.push({
            stage: 'smoke',
            action: `${prefix}_${name}`,
            name: `GET ${prefix === 'candidate' ? a?.candidate_probe_url : canonical}${name === 'ready' ? '/health/ready' : name.startsWith('composer') ? `/${project}/packages.json` : `/${project}/npm/-/ping`}`,
          });
      output.rollback = {
        status: !a
          ? 'unavailable_no_receipt'
          : !a.previous_version_id
            ? 'unavailable_first_deploy'
            : o.noRollback
              ? 'disabled'
              : blocked
                ? 'blocked_contract'
                : 'eligible',
        target_version_id: a?.previous_version_id ?? null,
      };
      result = { exitCode: 0, output };
      return result;
    }
    const ctx: ProbeContext = { fetch: transport, now, sleep, deadline: end, checks: [] };
    if (a)
      ctx.onFailure = async () => {
        a.smoke = 'failed';
        a.smoke_checks = structuredClone(ctx.checks);
        await save();
      };
    let recoveryEnd: number | undefined;
    const recoveryDeadline = () => (recoveryEnd ??= now() + 60_000);
    let probeError: unknown;
    if (a?.smoke === 'failed') {
      output.checks.push(...(a.smoke_checks ?? []));
      probeError = new CloudflareError('smoke_failed', 9, false, 'smoke');
    } else {
      try {
        if (a?.preview !== undefined && a.preview !== 'disabled') {
          const cleanup = new CloudflareApi({
            ...apiOptions,
            deadline: Math.min(end, now() + 60_000),
          });
          await reconcileCandidatePreview(cleanup, store, j);
        }
        await endpointPolicy(api, base, canonical, a);
        if (a) await candidateArtifact(api, base, a);
        await probes(ctx, canonical, 'canonical', project, canonical, token);
        if (a && a.requested_rollout < 100) {
          if (!a.candidate_probe_url || !(o.contract ?? cloudflareDeployContract).preview)
            throw new CloudflareError('capability_unknown', 2, false, 'smoke');
          const previewApi = new CloudflareApi({
            ...apiOptions,
            deadline: end,
            recoveryDeadline,
          });
          await withCandidatePreview(
            previewApi,
            store,
            j,
            o.contract ?? cloudflareDeployContract,
            async (url) => {
              await probes(ctx, origin(url), 'candidate', project, canonical, token);
            },
          );
        }
        await assertDistribution(api);
        await endpointPolicy(api, base, canonical, a);
      } catch (error) {
        probeError = error;
      }
      output.checks.push(...ctx.checks);
      if (a) {
        a.smoke_checks = ctx.checks;
        a.smoke = probeError ? 'failed' : 'passed';
        if (!probeError) {
          a.rollback_compatible &&= j.migrations.rollback_compatible;
          a.contract_ids = [...new Set([...a.contract_ids, ...j.migrations.contract_ids])];
          a.phase = 'verified';
          j.deployment!.last_verified = structuredClone(a);
          j.migrations.rollback_compatible = true;
          j.migrations.contract_ids = [];
        }
        await save();
      }
    }
    if (!probeError) {
      result = { exitCode: 0, output };
      return result;
    }
    if (probeError instanceof CloudflareError && probeError.exitCode === 8) {
      output.rollback.status = 'conflict';
      throw probeError;
    }
    if (!a) {
      await assertDistribution(new CloudflareApi({ ...apiOptions, deadline: recoveryDeadline() }));
      output.rollback.status = o.noRollback ? 'disabled' : 'unavailable_no_receipt';
      result = failCommand(output, new CloudflareError('smoke_failed', 9, false, 'smoke'));
      return result;
    }
    const recoveryApi = new CloudflareApi({ ...apiOptions, deadline: recoveryDeadline() });
    try {
      await ownership(recoveryApi, base, j);
      await assertDistribution(recoveryApi);
      await reconcileCandidatePreview(recoveryApi, store, j);
      try {
        await endpointPolicy(recoveryApi, base, canonical, a, a.phase === 'rolled_back');
      } catch {
        a.preview = 'cleanup_pending';
        await save();
        await reconcileCandidatePreview(recoveryApi, store, j);
        await endpointPolicy(recoveryApi, base, canonical, a, a.phase === 'rolled_back');
      }
      if (!a.previous_version_id) {
        output.rollback.status = 'unavailable_first_deploy';
        throw new CloudflareError('rollback_unavailable_first_deploy', 12, false, 'rollback');
      }
      if (blocked && !o.noRollback) {
        output.rollback = { status: 'blocked_contract', target_version_id: a.previous_version_id };
        output.pending_migrations = [...new Set([...a.contract_ids, ...j.migrations.contract_ids])];
        throw new CloudflareError('rollback_blocked_contract', 11, false, 'rollback');
      }
      output.rollback.target_version_id = a.previous_version_id;
      if (o.noRollback) {
        output.rollback.status = 'disabled';
        await endpointPolicy(recoveryApi, base, canonical, a, a.phase === 'rolled_back');
      } else {
        let outcome = a.rollback;
        if (outcome === 'not_needed' || (a.phase === 'rollback_pending' && outcome !== 'failed')) {
          outcome = await rollbackDeployment(recoveryApi, store, j);
        }
        output.rollback.status = outcome;
        if (outcome !== 'succeeded')
          throw new CloudflareError('rollback_failed', 10, false, 'rollback');
        if (!equalDistribution(await liveDistribution(recoveryApi, base), prior)) {
          output.rollback.status = 'conflict';
          return conflict();
        }
        const restoredOrigin = await ownership(recoveryApi, base, j);
        if (previousOrigin && restoredOrigin !== previousOrigin) return conflict();
        const ready: ProbeContext = {
          ...ctx,
          onFailure: undefined,
          deadline: Math.min(recoveryDeadline(), now() + 30_000),
          checks: [],
        };
        try {
          await assertion(
            ready,
            `${restoredOrigin}/health/ready`,
            'rollback_ready',
            'ready',
            project,
            canonical,
          );
        } catch {
          a.rollback = 'failed';
          output.rollback.status = 'failed';
          throw new CloudflareError('rollback_failed', 10, false, 'rollback');
        } finally {
          output.checks.push(...ready.checks);
          const candidateChecks = (a.smoke_checks ?? []).filter((c) => c.name !== 'rollback_ready');
          const recoveryCapacity = 4000 - candidateChecks.length;
          a.smoke_checks = [
            ...candidateChecks,
            ...ready.checks.slice(Math.max(0, ready.checks.length - recoveryCapacity)),
          ];
          await save();
        }
        await endpointPolicy(recoveryApi, base, canonical, a, true);
        try {
          await verifyRestoredSettings(recoveryApi, base, j);
        } catch {
          a.rollback = 'failed';
          output.rollback.status = 'failed';
          await save();
          throw new CloudflareError('rollback_failed', 10, false, 'rollback');
        }
        if (!equalDistribution(await liveDistribution(recoveryApi, base), prior)) {
          output.rollback.status = 'conflict';
          return conflict();
        }
      }
      result = failCommand(output, new CloudflareError('smoke_failed', 9, false, 'smoke'));
    } catch (error) {
      const safe = error instanceof CloudflareError ? error : null;
      if (safe?.exitCode === 8) output.rollback.status = 'conflict';
      else if (![11, 12].includes(safe?.exitCode ?? 0)) {
        if (!['failed', 'unknown'].includes(output.rollback.status))
          output.rollback.status = 'unknown';
        result = failCommand(output, new CloudflareError('rollback_failed', 10, false, 'rollback'));
        return result;
      }
      result = failCommand(output, error);
    }
    return result;
  } catch (error) {
    if (error instanceof CloudflareError && error.exitCode === 8)
      output.rollback.status = 'conflict';
    result = failCommand(output, error);
    return result;
  } finally {
    try {
      await release?.();
    } catch (error) {
      Object.assign(result, failCommand(output, error));
    }
  }
}

export async function runCloudflareSmoke(o: SmokeOptions): Promise<number> {
  const result = await smoke(o);
  if (o.json) console.log(JSON.stringify(result.output));
  else {
    for (const entry of result.output.plan) console.error(`${entry.action}: ${entry.name}`);
    for (const check of result.output.checks)
      console.error(
        `${check.name}: ${check.status} (attempt ${check.attempt ?? 1}, ${check.elapsed_ms ?? 0}ms)`,
      );
    if (result.exitCode !== 0 || o.dryRun)
      console.error(`rollback: ${result.output.rollback.status}`);
    if (result.output.error) console.error(result.output.error.message);
    else console.log(o.dryRun ? 'Cloudflare smoke planned.' : 'Cloudflare smoke passed.');
  }
  return result.exitCode;
}
