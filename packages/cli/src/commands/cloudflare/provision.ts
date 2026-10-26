import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { validatePlatformPorts } from '@package-broker/core/platform/port-config';
import { PLUGIN_BINDABLE_PORTS } from '@package-broker/core/plugin';
import type { PlatformPortConfig } from '@package-broker/core/platform/port-config';
import {
  assertPrebuiltConfiguration,
  materializePrebuilt,
  prebuiltEnvelope,
  removePrebuilt,
} from '../../prebuilt.js';
import type { BuildInfo } from '../../build-artifacts.js';
import { queueConsumerScript } from './queue-consumer.js';
import {
  CREATE_SETTLE_MS,
  CloudflareApi,
  CloudflareError,
  cloudflareCredentials,
  commandEnvelope,
  failCommand,
  object,
  type CommandResult,
  type CommandCheck,
  type PlanEntry,
} from './api.js';
import {
  InventoryStore,
  InventoryTransaction,
  digest,
  emptyInventory,
  installIdentity,
  abortOnlyRule,
  lifecycleRule,
  type LifecycleRule,
  validResourceId,
  type InstallIdentity,
  type Inventory,
  type Jurisdiction,
  type Operation,
  type Resource,
  type ResourceKey,
  type ResourceKind,
} from './inventory.js';

const QUEUE_ACCOUNT_LIMIT = 10_000;

export interface RequiredResources {
  r2: boolean;
  queues: boolean;
  analytics: boolean;
}
export interface CapabilityEvidence {
  queues?: { supported: boolean; remaining: number };
  r2?: { supported: boolean };
  analytics?: { supported: boolean; source?: 'analytics_engine_sql' | 'subscriptions' };
}
export interface RemoteResource {
  kind: ResourceKind;
  id: string;
  name: string;
  jurisdiction: Jurisdiction | null;
  created_at: string | null;
}
export interface WorkerState {
  tags: string[];
  bindings: {
    type: string;
    name: string;
    id: string | null;
    resource_name: string | null;
    text: string | null;
  }[];
}
/** Service evidence is read-only; creation reconciliation must have documented guarantees. */
export interface ProviderContract {
  capabilities(
    api: CloudflareApi,
    required: RequiredResources,
    identity: InstallIdentity,
  ): Promise<CapabilityEvidence>;
  pendingCreation(resource: RemoteResource, operation: Operation, now: number): boolean;
  exactNameUnique(kind: ResourceKind): boolean;
}
export const cloudflareProviderContract: ProviderContract = {
  async capabilities(api, required, identity) {
    const evidence: CapabilityEvidence = {};
    const probe = async (
      check: 'queues' | 'r2' | 'analytics_engine',
      read: () => Promise<void>,
    ): Promise<boolean> => {
      try {
        await read();
        return true;
      } catch (error) {
        if (
          check !== 'analytics_engine' &&
          error instanceof CloudflareError &&
          (error.status === 403 || (check === 'queues' && error.providerCode === 10253))
        )
          return false;
        throw new CloudflareError('capability_unknown', 1, false, 'provision', null, check);
      }
    };
    if (required.queues) {
      let count = 0;
      const supported = await probe('queues', async () => {
        count = (await api.list('/queues')).length;
      });
      // https://developers.cloudflare.com/queues/platform/limits/
      evidence.queues = {
        supported,
        remaining: supported ? Math.max(0, QUEUE_ACCOUNT_LIMIT - count) : 0,
      };
    }
    if (required.r2)
      evidence.r2 = {
        supported: await probe('r2', async () => {
          await api.list('/r2/buckets', 'buckets', {
            'cf-r2-jurisdiction': identity.jurisdiction,
          });
        }),
      };
    if (required.analytics) {
      let paid: boolean | null = null;
      try {
        const subscriptions = await api.snapshot('/subscriptions');
        // WORKERS_PAID is documented at /tenant/reference/subscriptions/.
        paid = subscriptions.some((subscription) => {
          const plan = object(subscription.rate_plan);
          return (
            typeof plan.id === 'string' &&
            plan.id.toUpperCase() === 'WORKERS_PAID' &&
            plan.scope === 'account' &&
            (subscription.state === 'Paid' || subscription.state === 'Provisioned')
          );
        });
      } catch {
        // Billing permission is optional; unreadable or incomplete subscriptions are no veto.
      }
      if (paid !== null) evidence.analytics = { supported: paid, source: 'subscriptions' };
      else {
        try {
          await api.analyticsEngineTables();
        } catch (error) {
          const unknown = new CloudflareError(
            'capability_unknown',
            1,
            false,
            'provision',
            null,
            'analytics_engine',
            null,
            'analytics_engine_sql',
          );
          if (error instanceof CloudflareError && (error.status === 401 || error.status === 403))
            unknown.message =
              'Analytics Engine SQL access was denied. Verify the token has Account Analytics Read permission for the selected account, then rerun. Billing permission is optional.';
          throw unknown;
        }
        evidence.analytics = { supported: true, source: 'analytics_engine_sql' };
      }
    }
    return evidence;
  },
  // No bounded creation-visibility guarantee is documented. Journal timing alone is not ownership.
  pendingCreation: () => false,
  exactNameUnique: (kind) => ['d1', 'r2', 'queue', 'worker'].includes(kind),
};
export interface ProvisionOptions {
  workerName: string;
  prebuilt?: boolean;
  configPath?: string;
  project?: string;
  outDir?: string;
  environment?: string;
  deploymentId?: string;
  runIdentity?: string;
  inventory?: string;
  jurisdiction?: Jurisdiction;
  locationHint?: string;
  adoptResource?: readonly string[];
  abandonIntent?: string;
  domain?: string;
  gradualProbe?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
  interactive?: boolean;
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  prompt?: (message: string) => Promise<string>;
  progress?: (message: string) => void;
  contract?: ProviderContract;
  transaction?: InventoryTransaction;
}
interface Specification {
  key: ResourceKey;
  kind: ResourceKind;
  name: string;
  jurisdiction: Jurisdiction | null;
}
const kindPath = (kind: ResourceKind): string =>
  kind === 'd1' ? '/d1/database' : kind === 'r2' ? '/r2/buckets' : '/queues';
const jurisdictionHeaders = (spec: Specification): Record<string, string> | undefined =>
  spec.kind === 'r2' && spec.jurisdiction !== null
    ? { 'cf-r2-jurisdiction': spec.jurisdiction }
    : undefined;
function specsFor(identity: InstallIdentity, required: RequiredResources): Specification[] {
  const base = identity.script_name;
  return [
    { key: 'd1', kind: 'd1', name: `${base}-db`, jurisdiction: identity.jurisdiction },
    ...(required.r2
      ? [
          {
            key: 'r2' as const,
            kind: 'r2' as const,
            name: `${base}-blobs`,
            jurisdiction: identity.jurisdiction,
          },
        ]
      : []),
    ...(required.queues
      ? [
          {
            key: 'dlq' as const,
            kind: 'queue' as const,
            name: `${base}-jobs-dlq`,
            jurisdiction: null,
          },
          {
            key: 'jobs' as const,
            kind: 'queue' as const,
            name: `${base}-jobs`,
            jurisdiction: null,
          },
        ]
      : []),
  ];
}
class UnsupportedRequirementsError extends CloudflareError {
  constructor(readonly requirements: string[]) {
    super('invalid_input', 2);
  }
}
async function selectedBuild(
  outDir: string,
): Promise<{ required: RequiredResources; info: BuildInfo; ports: PlatformPortConfig | null }> {
  try {
    const manifest = object(
      JSON.parse(await readFile(resolve(outDir, 'generated/manifest.json'), 'utf8')),
    );
    const info = object(JSON.parse(await readFile(resolve(outDir, 'build-info.json'), 'utf8')));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.platform !== 'cloudflare' ||
      info.schemaVersion !== 1 ||
      info.target !== 'cloudflare' ||
      typeof info.core !== 'string' ||
      !Array.isArray(manifest.bindings) ||
      !Array.isArray(manifest.plugins)
    )
      throw new Error();
    const unsupported: string[] = [];
    for (const binding of manifest.bindings) {
      const port = object(binding).port;
      if (
        typeof port !== 'string' ||
        !PLUGIN_BINDABLE_PORTS.some((supported) => supported === port)
      )
        unsupported.push(
          typeof port === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(port)
            ? port
            : 'unrecognized_requirement',
        );
    }
    const ports = manifest.platformPorts;
    if (ports && typeof ports === 'object') {
      for (const [key, adapter] of Object.entries({
        blob: 'r2',
        cache: 'cache-api',
        jobs: 'queues',
        observability: 'workers',
      })) {
        const section = object(ports)[key];
        if (section && object(section).adapter !== adapter) unsupported.push(key);
      }
    }
    if (unsupported.length) throw new UnsupportedRequirementsError(unsupported);
    if (
      ports !== null &&
      (ports === undefined || validatePlatformPorts({ cloudflare: ports }, 'cloudflare').length > 0)
    )
      throw new Error();
    const selected = ports as PlatformPortConfig | null;
    // Only allow build-info fields with their declared types; never echo arbitrary manifest data.
    if (typeof info.core !== 'string' || !/^[a-zA-Z0-9.+-]{1,64}$/.test(info.core))
      throw new Error();
    const plugins = object(info.plugins);
    for (const [key, value] of Object.entries(plugins))
      if (
        !/^[@a-zA-Z0-9/_.-]{1,128}$/.test(key) ||
        typeof value !== 'string' ||
        !/^[a-zA-Z0-9.+-]{1,64}$/.test(value)
      )
        throw new Error();
    if (
      info.lockfileSha256 !== null &&
      (typeof info.lockfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(info.lockfileSha256))
    )
      throw new Error();
    if (
      info.gitSha !== null &&
      (typeof info.gitSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(info.gitSha))
    )
      throw new Error();
    if (info.dirty !== undefined && info.dirty !== null && typeof info.dirty !== 'boolean')
      throw new Error();
    return {
      required: {
        r2: selected?.blob.adapter === 'r2',
        queues: selected?.jobs.adapter === 'queues',
        analytics: selected?.observability.analyticsBinding !== undefined,
      },
      ports: selected,
      info: {
        schemaVersion: 1,
        target: 'cloudflare',
        core: info.core,
        plugins: plugins as Record<string, string>,
        lockfileSha256: info.lockfileSha256 as string | null,
        gitSha: info.gitSha as string | null,
        ...(info.dirty === undefined ? {} : { dirty: info.dirty as boolean | null }),
      },
    };
  } catch (error) {
    if (error instanceof UnsupportedRequirementsError) throw error;
    throw new CloudflareError('invalid_input', 2);
  }
}
function parseRemote(kind: ResourceKind, raw: unknown): RemoteResource {
  const record = object(raw);
  const id = kind === 'd1' ? record.uuid : kind === 'r2' ? record.name : record.queue_id;
  const name = kind === 'queue' ? record.queue_name : record.name;
  if (
    !validResourceId(kind, id) ||
    typeof name !== 'string' ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)
  )
    throw new CloudflareError('provider_failure');
  const jurisdiction =
    record.jurisdiction === 'eu' || record.jurisdiction === 'default' ? record.jurisdiction : null;
  const timestamp = record.created_at ?? record.created_on;
  return {
    kind,
    id,
    name,
    jurisdiction,
    created_at:
      typeof timestamp === 'string' && Number.isFinite(Date.parse(timestamp)) ? timestamp : null,
  };
}
async function readWorker(
  api: CloudflareApi,
  identity: InstallIdentity,
): Promise<WorkerState | null> {
  try {
    const raw = object(
      (await api.request(`/workers/scripts/${identity.script_name}/settings`)).result,
    );
    if (
      !Array.isArray(raw.tags) ||
      raw.tags.some((tag) => typeof tag !== 'string') ||
      !Array.isArray(raw.bindings)
    )
      throw new CloudflareError('capability_unknown');
    const names = raw.bindings.map((binding) => object(binding).name);
    if (new Set(names).size !== names.length)
      throw new CloudflareError('configuration_conflict', 8);
    return {
      tags: raw.tags as string[],
      bindings: raw.bindings.map((b) => {
        const binding = object(b);
        if (typeof binding.type !== 'string' || typeof binding.name !== 'string')
          throw new CloudflareError('capability_unknown');
        return {
          type: binding.type,
          name: binding.name,
          id: typeof binding.id === 'string' ? binding.id : null,
          text: typeof binding.text === 'string' ? binding.text : null,
          resource_name:
            typeof (binding.bucket_name ?? binding.queue_name ?? binding.dataset) === 'string'
              ? String(binding.bucket_name ?? binding.queue_name ?? binding.dataset)
              : null,
        };
      }),
    };
  } catch (error) {
    if (error instanceof CloudflareError && error.status === 404) return null;
    throw error;
  }
}
function ownedWorker(worker: WorkerState | null, identity: InstallIdentity): boolean {
  return (
    worker !== null &&
    worker.tags.includes('pb-install-v1') &&
    worker.tags.includes(`pb-owner-${identity.owner_digest}`)
  );
}
function bindingOwns(
  worker: WorkerState | null,
  identity: InstallIdentity,
  spec: Specification,
  remote: RemoteResource,
): boolean {
  if (!ownedWorker(worker, identity)) return false;
  return worker!.bindings.some((b) =>
    spec.kind === 'd1'
      ? b.type === 'd1' && b.id === remote.id
      : spec.kind === 'r2'
        ? b.type === 'r2_bucket' && b.resource_name === remote.name
        : b.type === 'queue' && (b.id === remote.id || b.resource_name === remote.name),
  );
}
function verify(spec: Specification, remote: RemoteResource): void {
  if (spec.name !== remote.name || spec.kind !== remote.kind)
    throw new CloudflareError('configuration_conflict', 8);
  if (spec.jurisdiction !== null && spec.jurisdiction !== remote.jurisdiction)
    throw new CloudflareError('jurisdiction_conflict', 8);
}
function pendingEvidence(
  contract: ProviderContract,
  remote: RemoteResource,
  op: Operation,
  now: number,
): boolean {
  return (
    remote.created_at !== null &&
    Date.parse(remote.created_at) >= Date.parse(op.absence_observed_at) &&
    Date.parse(remote.created_at) >= Date.parse(op.started_at) &&
    Date.parse(remote.created_at) <= now &&
    contract.pendingCreation(remote, op, now)
  );
}
function specHash(spec: Specification): string {
  return digest(
    JSON.stringify({ kind: spec.kind, name: spec.name, jurisdiction: spec.jurisdiction }),
  );
}
function receipt(
  remote: RemoteResource,
  source: 'created' | 'pending_create' | 'adopted' | 'worker_binding',
  now: number,
  operationId: string | null,
): Resource {
  return {
    name: remote.name,
    id: remote.id,
    ...(remote.kind === 'd1' || remote.kind === 'r2' ? { jurisdiction: remote.jurisdiction } : {}),
    state: 'complete',
    evidence: { source, operation_id: operationId, verified_at: new Date(now).toISOString() },
  };
}
async function allResources(
  api: CloudflareApi,
  specs: Specification[],
  queueConsumers = new Map<string, Record<string, unknown>[]>(),
): Promise<Map<string, RemoteResource[]>> {
  const result = new Map<string, RemoteResource[]>();
  const lists = new Map<ResourceKind, Record<string, unknown>[]>();
  for (const spec of specs) {
    if (!lists.has(spec.kind))
      lists.set(
        spec.kind,
        await api.list(
          kindPath(spec.kind),
          spec.kind === 'r2' ? 'buckets' : undefined,
          jurisdictionHeaders(spec),
        ),
      );
    const matches = lists
      .get(spec.kind)!
      .filter((raw) => (spec.kind === 'queue' ? raw.queue_name : raw.name) === spec.name);
    if (matches.length > 1) throw new CloudflareError('ownership_conflict', 8);
    const resources: RemoteResource[] = [];
    for (const raw of matches) {
      const listed = parseRemote(spec.kind, raw);
      const detail = parseRemote(
        spec.kind,
        (
          await api.request(
            `${kindPath(spec.kind)}/${encodeURIComponent(listed.id)}`,
            'GET',
            undefined,
            jurisdictionHeaders(spec),
          )
        ).result,
      );
      if (detail.id !== listed.id) throw new CloudflareError('ownership_conflict', 8);
      verify(spec, detail);
      if (spec.kind === 'queue') {
        const consumers = await api.snapshot(`/queues/${detail.id}/consumers`);
        queueConsumers.set(detail.id, consumers);
        const script = spec.name.slice(0, spec.key === 'dlq' ? -9 : -5);
        if (
          (spec.key === 'dlq' && consumers.length > 0) ||
          consumers.length > 1 ||
          consumers.some(
            (consumer) =>
              consumer.type !== 'worker' ||
              queueConsumerScript(consumer) !== script ||
              (spec.key === 'jobs' &&
                consumer.dead_letter_queue !== undefined &&
                consumer.dead_letter_queue !== null &&
                consumer.dead_letter_queue !== `${script}-jobs-dlq`),
          )
        )
          throw new CloudflareError('configuration_conflict', 8);
      }
      resources.push(detail);
    }
    result.set(spec.name, resources);
  }
  return result;
}
async function preflight(
  api: CloudflareApi,
  o: ProvisionOptions,
  required: RequiredResources,
  missingQueues: number,
  contract: ProviderContract,
  identity: InstallIdentity,
  checks: CommandCheck[],
): Promise<void> {
  // Optional identification has no bearing on authoritative service checks.
  let planStatus = 'readable_unverified';
  try {
    await api.request('/subscriptions');
  } catch {
    planStatus = 'unavailable_optional';
  }
  const planCheck = checks.find((check) => check.name === 'plan_identification');
  if (planCheck) planCheck.status = planStatus;
  else checks.push({ name: 'plan_identification', status: planStatus });
  if (o.domain === undefined || o.gradualProbe === true) {
    let subdomain: unknown;
    try {
      subdomain = object((await api.request('/workers/subdomain')).result).subdomain;
    } catch (error) {
      if (!(error instanceof CloudflareError && error.status === 404)) throw error;
    }
    if (typeof subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(subdomain))
      throw new CloudflareError('workers_dev_subdomain_missing');
  }
  const evidence = await contract.capabilities(api, required, identity);
  if (required.queues) {
    if (!evidence.queues || typeof evidence.queues.supported !== 'boolean')
      throw new CloudflareError('capability_unknown', 1, false, 'provision', null, 'queues');
    if (!evidence.queues.supported)
      throw new CloudflareError('queues_unavailable', 1, false, 'provision', null, 'queues');
    if (!Number.isSafeInteger(evidence.queues.remaining) || evidence.queues.remaining < 0)
      throw new CloudflareError('capability_unknown', 1, false, 'provision', null, 'queues');
    if (missingQueues > evidence.queues.remaining)
      throw new CloudflareError('capacity_exceeded', 1, false, 'provision', null, 'queues');
  }
  if (required.r2) {
    if (typeof evidence.r2?.supported !== 'boolean')
      throw new CloudflareError('capability_unknown', 1, false, 'provision', null, 'r2');
    if (!evidence.r2.supported)
      throw new CloudflareError('r2_unavailable', 1, false, 'provision', null, 'r2');
  }
  if (required.analytics) {
    if (typeof evidence.analytics?.supported !== 'boolean')
      throw new CloudflareError(
        'capability_unknown',
        1,
        false,
        'provision',
        null,
        'analytics_engine',
      );
    if (evidence.analytics.source)
      checks.push({
        name: 'analytics_engine',
        status: evidence.analytics.supported ? 'supported' : 'unsupported',
        source: evidence.analytics.source,
      });
    if (!evidence.analytics.supported)
      throw new CloudflareError(
        'analytics_engine_unavailable',
        1,
        false,
        'provision',
        null,
        'analytics_engine',
      );
  }
}
function checkAdoptions(values: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const value of values) {
    const [kind, id, extra] = value.split(':');
    if (
      extra !== undefined ||
      !kind ||
      !id ||
      (kind === 'worker'
        ? !/^[a-z0-9-]{1,37}$/.test(id)
        : !['d1', 'r2', 'queue'].includes(kind) || !validResourceId(kind as ResourceKind, id)) ||
      set.has(value)
    )
      throw new CloudflareError('invalid_input', 2);
    set.add(value);
  }
  return set;
}
async function confirmedGone(
  api: CloudflareApi,
  spec: Specification,
  id: string,
): Promise<boolean> {
  const paths = spec.kind === 'r2' ? ['eu', 'default'] : [null];
  for (const jurisdiction of paths) {
    try {
      await api.request(
        `${kindPath(spec.kind)}/${encodeURIComponent(id)}`,
        'GET',
        undefined,
        jurisdiction === null ? undefined : { 'cf-r2-jurisdiction': jurisdiction },
      );
      return false;
    } catch (error) {
      if (!(error instanceof CloudflareError && error.status === 404)) return false;
    }
  }
  return true;
}
function localFailure(error: unknown): unknown {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return !(error instanceof CloudflareError) &&
    typeof code === 'string' &&
    /^E[A-Z0-9]+$/.test(code)
    ? new CloudflareError('state_io_failure')
    : error;
}
async function defaultPrompt(message: string): Promise<string> {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await prompt.question(message);
  } finally {
    prompt.close();
  }
}
export async function provision(
  o: ProvisionOptions,
  operations: { materializePrebuilt?: typeof materializePrebuilt } = {},
): Promise<CommandResult> {
  let prebuiltOut: string | undefined;
  const output = commandEnvelope('provision', o.dryRun ?? false);
  let release: (() => Promise<void>) | undefined;
  let inventory: Inventory | undefined;
  const setOutputs = () => {
    output.database_id = inventory?.resources.d1?.id ?? null;
    output.r2_bucket = inventory?.resources.r2?.id ?? null;
    output.queue_names = [inventory?.resources.jobs, inventory?.resources.dlq]
      .filter((r) => r?.id !== null && r !== undefined)
      .map((r) => r!.name);
  };
  try {
    if (o.prebuilt)
      await assertPrebuiltConfiguration(
        resolve(o.project ?? dirname(resolve(o.configPath ?? 'broker.config.ts'))),
        o.configPath,
      );
    const auth = cloudflareCredentials(o.env);
    const identity = installIdentity({
      ...auth,
      workerName: o.workerName,
      ...(o.environment === undefined ? {} : { environment: o.environment }),
      ...(o.deploymentId === undefined ? {} : { deploymentId: o.deploymentId }),
      ...(o.runIdentity === undefined ? {} : { runIdentity: o.runIdentity }),
      ...(o.jurisdiction === undefined ? {} : { jurisdiction: o.jurisdiction }),
      ...(o.locationHint === undefined ? {} : { locationHint: o.locationHint }),
    });
    if (
      o.domain !== undefined &&
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(o.domain)
    )
      throw new CloudflareError('invalid_input', 2);
    const adoptions = checkAdoptions(o.adoptResource ?? []);
    const project = resolve(o.project ?? dirname(resolve(o.configPath ?? 'broker.config.ts')));
    let outDir = o.prebuilt
      ? resolve(project, o.outDir ?? '.pb/prebuilt/cloudflare')
      : resolve(o.outDir ?? '.pb/cloudflare');
    if (o.prebuilt) {
      const materialized = await (operations.materializePrebuilt ?? materializePrebuilt)({
        project,
        outDir,
      });
      outDir = prebuiltOut = materialized.outDir;
      output.prebuilt = prebuiltEnvelope(materialized);
      output.artifact_sha256 = output.prebuilt.artifact_sha256;
    }
    const store = await InventoryStore.create({
      project,
      outDir,
      identity,
      ...(o.inventory === undefined ? {} : { inventory: o.inventory }),
    });
    const build = await selectedBuild(outDir);
    output.build_info = build.info;
    const now = o.now ?? Date.now;
    // After confirmation: inventory + capacity, then absence + read-back for each of two queues.
    // Each scan can take 100 pages at the client's one-request-per-second rate.
    const provisionBudgetMs =
      600_000 + (build.required.queues ? 6 * Math.ceil(QUEUE_ACCOUNT_LIMIT / 100) * 1000 : 0);
    const api = new CloudflareApi({
      ...auth,
      ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
      now,
      ...(o.sleep === undefined ? {} : { sleep: o.sleep }),
    });
    api.restartDeadline(provisionBudgetMs);
    const contract = o.contract ?? cloudflareProviderContract;
    if (o.transaction) o.transaction.assertStore(store);
    else if (!o.dryRun) release = await store.lock(now());
    inventory = (await store.read()) ?? emptyInventory(identity, now());
    const journal = inventory;
    if (
      journal.identity.location_hint !== identity.location_hint &&
      Object.keys(journal.resources).length
    )
      output.checks.push({ name: 'location_hint', status: 'ignored_for_existing_resources' });
    const save = async () => {
      journal.revision++;
      journal.updated_at = new Date(now()).toISOString();
      await store.write(journal);
    };
    const specs = specsFor(identity, build.required);
    for (const key of Object.keys(journal.resources) as ResourceKey[]) {
      if (key !== 'analytics' && key !== 'worker' && !specs.some((spec) => spec.key === key))
        throw new CloudflareError('configuration_conflict', 8);
      if (key === 'analytics' && !build.required.analytics)
        throw new CloudflareError('configuration_conflict', 8);
    }
    const inspect = async () => {
      const queueConsumers = new Map<string, Record<string, unknown>[]>();
      const resources = await allResources(api, specs, queueConsumers);
      const worker = await readWorker(api, identity);
      if (
        worker &&
        !ownedWorker(worker, identity) &&
        !(
          journal.resources.worker?.id === identity.script_name &&
          journal.resources.worker.evidence?.source === 'adopted'
        ) &&
        !adoptions.has(`worker:${identity.script_name}`)
      )
        throw new CloudflareError('ownership_conflict', 8);
      if (
        worker &&
        worker.tags.some(
          (tag) => tag.startsWith('pb-owner-') && tag !== `pb-owner-${identity.owner_digest}`,
        )
      )
        throw new CloudflareError('ownership_conflict', 8);
      // A foreign binding is not overridden by adoption or a local receipt.
      if (worker) {
        const expectedBindings = [
          { name: 'DB', type: 'd1' },
          ...(build.ports
            ? [
                { name: build.ports.blob.binding, type: 'r2_bucket' },
                { name: build.ports.jobs.binding, type: 'queue' },
              ]
            : []),
        ];
        for (const binding of expectedBindings) {
          const b = worker.bindings.find((b) => b.name === binding.name);
          if (b && b.type !== binding.type) throw new CloudflareError('configuration_conflict', 8);
          const spec = specs.find((s) =>
            binding.type === 'd1'
              ? s.key === 'd1'
              : binding.type === 'r2_bucket'
                ? s.key === 'r2'
                : s.key === 'jobs',
          );
          const found = spec ? resources.get(spec.name)?.[0] : undefined;
          if (b && !found) throw new CloudflareError('configuration_conflict', 8);
          if (
            b &&
            found &&
            (binding.type === 'd1' ? b.id !== found.id : b.resource_name !== found.name)
          )
            throw new CloudflareError('ownership_conflict', 8);
        }
      }
      if (worker) {
        const deployment = worker.bindings.find((binding) => binding.name === 'DEPLOYMENT_ID');
        if (
          deployment &&
          (deployment.type !== 'plain_text' || deployment.text !== identity.deployment_id)
        )
          throw new CloudflareError('configuration_conflict', 8);
        if (build.required.analytics) {
          const analytics = worker.bindings.find(
            (binding) => binding.name === build.ports?.observability.analyticsBinding,
          );
          if (
            analytics &&
            (analytics.type !== 'analytics_engine' ||
              analytics.resource_name !== `${identity.script_name.replaceAll('-', '_')}_metrics`)
          )
            throw new CloudflareError('configuration_conflict', 8);
        }
      }
      const resourceOwned = (spec: Specification, remote: RemoteResource): boolean => {
        if (bindingOwns(worker, identity, spec, remote)) return true;
        if (spec.key !== 'dlq' || !ownedWorker(worker, identity)) return false;
        const jobs = resources.get(`${identity.script_name}-jobs`)?.[0];
        if (!jobs) return false;
        const consumers = queueConsumers.get(jobs.id) ?? [];
        return (
          worker!.bindings.some(
            (binding) =>
              binding.name === build.ports?.jobs.binding &&
              binding.type === 'queue' &&
              (binding.id === jobs.id || binding.resource_name === jobs.name),
          ) &&
          consumers.length === 1 &&
          consumers[0]!.type === 'worker' &&
          queueConsumerScript(consumers[0]!) === identity.script_name &&
          consumers[0]!.dead_letter_queue === remote.name
        );
      };
      for (const spec of specs) {
        const remote = resources.get(spec.name)?.[0];
        const recorded = journal.resources[spec.key];
        const pending = journal.operations.find(
          (op) => op.name === spec.name && (op.state === 'pending' || op.state === 'unknown'),
        );
        if (pending && pending.spec_sha256 !== specHash(spec))
          throw new CloudflareError('configuration_conflict', 8);
        if (recorded?.state === 'complete' && (!remote || remote.id !== recorded.id))
          throw new CloudflareError('ownership_conflict', 8);
        if (!remote) continue;
        const adopted = adoptions.has(`${spec.kind}:${remote.id}`);
        if (
          pending &&
          !adopted &&
          !(
            recorded?.id === remote.id &&
            recorded.evidence?.source === 'created' &&
            recorded.evidence.operation_id === pending.id
          ) &&
          !pendingEvidence(contract, remote, pending, now()) &&
          !resourceOwned(spec, remote)
        )
          throw new CloudflareError('ownership_conflict', 8);
        if (!pending && recorded?.state !== 'complete' && !adopted && !resourceOwned(spec, remote))
          throw new CloudflareError('ownership_conflict', 8);
      }
      const missing = specs.filter((spec) => !resources.get(spec.name)?.length);
      await preflight(
        api,
        o,
        build.required,
        missing.filter((spec) => spec.kind === 'queue').length,
        contract,
        identity,
        output.checks,
      );
      return { resources, worker, missing, queueConsumers };
    };
    let state = await inspect();
    if (o.abandonIntent !== undefined) {
      const target = journal.operations.find(
        (op) =>
          op.id === o.abandonIntent &&
          (op.state === 'pending' || op.state === 'unknown') &&
          specs.some((spec) => spec.name === op.name),
      );
      if (!target) throw new CloudflareError('invalid_input', 2);
      output.checks.push({ name: 'abandon_intent', status: target.id });
    }
    for (const flag of adoptions) {
      const [kind, id] = flag.split(':');
      if (
        kind === 'worker'
          ? state.worker === null || id !== identity.script_name
          : !specs.some((spec) => spec.kind === kind)
      )
        throw new CloudflareError('invalid_input', 2);
    }
    const abandoned: { operation: Operation; key: ResourceKey }[] = [];
    // Resolve every old intent before planning additional creates. Read-only runs never repair the journal.
    for (const spec of specs) {
      const pending = journal.operations.find(
        (op) => op.name === spec.name && ['pending', 'unknown'].includes(op.state),
      );
      if (!pending) continue;
      const remote = state.resources.get(spec.name)?.[0];
      const abandoning = pending.id === o.abandonIntent;
      if (abandoning && remote) throw new CloudflareError('ownership_conflict', 8);
      if (!remote) {
        if (abandoning) {
          if (now() - Date.parse(pending.started_at) <= CREATE_SETTLE_MS)
            throw new CloudflareError('outcome_unknown', 6);
          if (
            pending.resolved_id !== null &&
            !(await confirmedGone(api, spec, pending.resolved_id))
          )
            throw new CloudflareError('ownership_conflict', 8);
          abandoned.push({ operation: pending, key: spec.key });
          continue;
        }
        output.checks.push({ name: 'pending_intent', status: pending.id });
        if (!o.dryRun) {
          pending.state = 'unknown';
          await save();
        }
        throw new CloudflareError('outcome_unknown', 6);
      }
      if (!o.dryRun) {
        const recorded = journal.resources[spec.key];
        pending.state = 'confirmed';
        pending.resolved_id = remote.id;
        journal.resources[spec.key] = receipt(
          remote,
          recorded?.state === 'complete' && recorded.id === remote.id && recorded.evidence
            ? recorded.evidence.source
            : adoptions.has(`${spec.kind}:${remote.id}`)
              ? 'adopted'
              : 'pending_create',
          now(),
          pending.id,
        );
        await save();
      }
    }
    const plan = (): PlanEntry[] =>
      specs.map((spec) => ({
        stage: 'provision',
        action: state.missing.some((s) => s.key === spec.key) ? 'create' : 'reuse',
        kind: spec.kind,
        name: spec.name,
        ...(spec.jurisdiction === null ? {} : { jurisdiction: spec.jurisdiction }),
      }));
    output.plan = plan();
    if (build.required.analytics)
      output.plan.push({
        stage: 'provision',
        action: 'binding_pending',
        kind: 'analytics',
        name: `${identity.script_name.replaceAll('-', '_')}_metrics`,
      });
    o.progress?.(
      `${JSON.stringify(output.plan)}\nAccount: [redacted]. Resources are retained; no deletes. Lost responses require durable private inventory or exact-ID adoption.`,
    );
    if (state.missing.length && !o.dryRun) {
      if (!o.yes) {
        if (o.json || !(o.interactive ?? (process.stdin.isTTY && process.stderr.isTTY)))
          throw new CloudflareError('confirmation_required', 2);
        if ((await (o.prompt ?? defaultPrompt)('Type yes to create these resources: ')) !== 'yes')
          throw new CloudflareError('confirmation_declined', 2);
      }
      api.restartDeadline(provisionBudgetMs);
      const signature = JSON.stringify({
        resources: [...state.resources.entries()],
        worker: state.worker,
        queueConsumers: [...state.queueConsumers.entries()],
      });
      const confirmed = await inspect();
      let confirmedBuild: Awaited<ReturnType<typeof selectedBuild>>;
      try {
        confirmedBuild = await selectedBuild(outDir);
      } catch {
        throw new CloudflareError('plan_changed', 8);
      }
      if (
        JSON.stringify(confirmedBuild) !== JSON.stringify(build) ||
        JSON.stringify({
          resources: [...confirmed.resources.entries()],
          worker: confirmed.worker,
          queueConsumers: [...confirmed.queueConsumers.entries()],
        }) !== signature
      )
        throw new CloudflareError('plan_changed', 8);
      state = confirmed;
    }
    const resolvedIds = [...state.resources.values()].flat();
    for (const flag of adoptions) {
      const [kind, id] = flag.split(':');
      const matched =
        kind === 'worker'
          ? state.worker !== null && id === identity.script_name
          : resolvedIds.some((remote) => remote.kind === kind && remote.id === id);
      if (!matched) throw new CloudflareError('invalid_input', 2);
    }
    if (!o.dryRun && abandoned.length) {
      for (const { operation, key } of abandoned) {
        operation.state = 'failed';
        const intended = journal.resources[key];
        if (intended && intended.state !== 'complete') intended.state = 'planned';
      }
      await save();
    }
    if (!o.dryRun && state.worker && adoptions.has(`worker:${identity.script_name}`)) {
      journal.resources.worker = {
        name: identity.script_name,
        id: identity.script_name,
        state: 'complete',
        evidence: {
          source: 'adopted',
          operation_id: null,
          verified_at: new Date(now()).toISOString(),
        },
      };
      await save();
    }
    for (const spec of specs) {
      let remote = state.resources.get(spec.name)?.[0];
      if (remote) {
        if (!o.dryRun && journal.resources[spec.key]?.state !== 'complete') {
          journal.resources[spec.key] = receipt(
            remote,
            adoptions.has(`${spec.kind}:${remote.id}`) ? 'adopted' : 'worker_binding',
            now(),
            null,
          );
          await save();
        }
        continue;
      }
      if (o.dryRun) continue;
      // Observe exact absence at this boundary, after the acknowledged plan was checked.
      if ((await allResources(api, [spec])).get(spec.name)?.length)
        throw new CloudflareError('plan_changed', 8);
      api.assertCreateBudget();
      const started = new Date(now()).toISOString();
      const operation: Operation = {
        id: randomUUID(),
        kind: spec.kind,
        name: spec.name,
        spec_sha256: specHash(spec),
        absence_observed_at: started,
        started_at: started,
        state: 'pending',
        resolved_id: null,
      };
      journal.operations.push(operation);
      journal.resources[spec.key] = {
        name: spec.name,
        id: null,
        ...(spec.jurisdiction === null ? {} : { jurisdiction: spec.jurisdiction }),
        state: 'creating',
        evidence: null,
      };
      await save();
      let returnedId: string | undefined;
      let posted = false;
      try {
        const body =
          spec.kind === 'queue'
            ? {
                queue_name: spec.name,
                ...(identity.jurisdiction === 'default'
                  ? {}
                  : { jurisdiction: identity.jurisdiction }),
              }
            : {
                name: spec.name,
                ...(spec.kind === 'd1' && spec.jurisdiction !== 'default'
                  ? { jurisdiction: spec.jurisdiction }
                  : {}),
                ...(identity.location_hint === null
                  ? {}
                  : spec.kind === 'd1'
                    ? { primary_location_hint: identity.location_hint }
                    : { locationHint: identity.location_hint }),
              };
        const response = await api.request(
          kindPath(spec.kind),
          'POST',
          body,
          jurisdictionHeaders(spec),
        );
        posted = true;
        const created = parseRemote(spec.kind, response.result);
        returnedId = created.id;
        operation.resolved_id = created.id;
        await save();
        verify(spec, created);
        journal.resources[spec.key] = receipt(created, 'created', now(), operation.id);
        await save();
        remote = (await allResources(api, [spec])).get(spec.name)?.[0];
        if (!remote || remote.id !== returnedId) throw new CloudflareError('outcome_unknown', 6);
      } catch (error) {
        if (!(error instanceof CloudflareError)) throw error;
        if (error.code === 'deadline_exceeded' && !posted) {
          operation.state = 'failed';
          const intended = journal.resources[spec.key];
          if (intended && intended.state !== 'complete') intended.state = 'planned';
          await save();
          throw error;
        }
        if (error.code === 'jurisdiction_conflict' || error.code === 'configuration_conflict') {
          operation.state = 'unknown';
          await save();
          throw error;
        }
        if (
          !posted &&
          error.status !== null &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 409, 429].includes(error.status)
        ) {
          operation.state = 'failed';
          await save();
          throw error;
        }
        // Never resend a POST: even 409 and truncated successes require exact reconciliation.
        for (let attempt = 0; attempt < 4; attempt++) {
          try {
            await api.pause(1000 * 2 ** attempt);
            remote = (await allResources(api, [spec])).get(spec.name)?.[0];
          } catch (readError) {
            if (
              readError instanceof CloudflareError &&
              ['ownership_conflict', 'jurisdiction_conflict'].includes(readError.code)
            )
              throw readError;
            continue;
          }
          if (remote) break;
        }
        if (
          !remote ||
          (returnedId !== undefined
            ? returnedId !== remote.id
            : !pendingEvidence(contract, remote, operation, now()))
        ) {
          operation.state = 'unknown';
          await save();
          throw new CloudflareError(
            remote ? 'ownership_conflict' : 'outcome_unknown',
            remote ? 8 : 6,
          );
        }
      }
      verify(spec, remote);
      operation.state = 'confirmed';
      operation.resolved_id = remote.id;
      journal.resources[spec.key] = receipt(
        remote,
        returnedId === remote.id ? 'created' : 'pending_create',
        now(),
        operation.id,
      );
      await save();
    }
    const bucket = journal.resources.r2;
    if (
      !o.dryRun &&
      bucket?.id &&
      bucket.state === 'complete' &&
      bucket.lifecycle_baseline === undefined &&
      bucket.evidence &&
      ['created', 'pending_create'].includes(bucket.evidence.source)
    ) {
      let baseline: LifecycleRule[] | undefined;
      try {
        const live = object(
          (
            await api.request(
              `/r2/buckets/${encodeURIComponent(bucket.id)}/lifecycle`,
              'GET',
              undefined,
              { 'cf-r2-jurisdiction': identity.jurisdiction },
            )
          ).result,
        ).rules;
        if (Array.isArray(live) && live.length <= 16 && live.every(lifecycleRule))
          baseline = live.map(abortOnlyRule);
      } catch {
        baseline = undefined;
      }
      if (baseline) {
        bucket.lifecycle_baseline = baseline;
        await save();
      } else output.checks.push({ name: 'lifecycle_baseline', status: 'unrecorded' });
    }
    if (!o.dryRun && build.required.analytics && journal.resources.analytics === undefined) {
      journal.resources.analytics = {
        name: `${identity.script_name.replaceAll('-', '_')}_metrics`,
        id: null,
        state: 'binding_pending',
        evidence: null,
      };
      await save();
    }
    // Dry-run exposes resolved non-secret IDs without writing adoption receipts.
    if (o.dryRun)
      for (const spec of specs) {
        const remote = state.resources.get(spec.name)?.[0];
        if (remote) journal.resources[spec.key] = receipt(remote, 'worker_binding', now(), null);
      }
    if (o.domain) output.worker_url = `https://${o.domain}`;
    output.status = o.dryRun ? 'planned' : 'ok';
    output.checks.push({
      name: 'provider_semantics',
      status: contract === cloudflareProviderContract ? 'documented' : 'custom',
    });
    setOutputs();
    await release?.();
    release = undefined;
    return { exitCode: 0, output };
  } catch (error) {
    if (error instanceof UnsupportedRequirementsError)
      output.checks.push(...error.requirements.map((name) => ({ name, status: 'unsupported' })));
    setOutputs();
    if (release) {
      try {
        await release();
      } catch {
        /* Preserve the original safe failure and journal. */
      }
    }
    return failCommand(output, localFailure(error));
  } finally {
    if (prebuiltOut) await removePrebuilt(prebuiltOut).catch(() => undefined);
  }
}
export async function runCloudflareProvision(o: ProvisionOptions): Promise<number> {
  const result = await provision({
    ...o,
    progress: o.progress ?? ((message) => console.error(message)),
  });
  if (o.json) console.log(JSON.stringify(result.output));
  else if (result.output.error)
    console.error(`${result.output.error.code}: ${result.output.error.message}`);
  else console.log(JSON.stringify(result.output));
  return result.exitCode;
}
