import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { createOtlpExporter } from '@package-broker/core/platform/otlp';
import { parseUiManifest } from '@package-broker/core/platform/ui-manifest';
import {
  validatePlatformPorts,
  type PlatformPortConfig,
} from '@package-broker/core/platform/port-config';
import { PLUGIN_BINDABLE_PORTS } from '@package-broker/core/plugin';
import { builtRouteProblems, loadBuiltMigrations } from '../built-manifest.js';
import {
  CloudflareApi,
  CloudflareError,
  cloudflareCredentials,
  commandEnvelope,
  failCommand,
  object,
  wasNotSent,
  type CommandResult,
} from './api.js';
import {
  InventoryStore,
  InventoryTransaction,
  digest,
  installIdentity,
  safeBuildInfo,
  type DeploymentAttempt,
  type Distribution,
  type EndpointPolicy,
  type Inventory,
  type ManagedSettings,
  type Jurisdiction,
  type ManagedRoute,
  type ManagedDomain,
} from './inventory.js';

const COMPATIBILITY = { compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'] };
const ASSET_CONFIG = { run_worker_first: true, html_handling: 'none', not_found_handling: 'none' };
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const safeId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const invalid = (): never => {
  throw new CloudflareError('invalid_input', 2, false, 'deploy');
};
const conflict = (): never => {
  throw new CloudflareError('configuration_conflict', 8, false, 'deploy');
};
const unknown = (): never => {
  throw new CloudflareError('outcome_unknown', 6, false, 'deploy');
};
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
function definitiveRejection(error: unknown): error is CloudflareError {
  return (
    error instanceof CloudflareError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 409, 429].includes(error.status)
  );
}
/** The provider refused it, or the client never sent it: either way nothing was applied. */
const knownNotApplied = (error: unknown) => definitiveRejection(error) || wasNotSent(error);
function validateTelemetry(endpoint: string, rawHeaders?: string): void {
  try {
    const headers: unknown = rawHeaders === undefined ? {} : JSON.parse(rawHeaders);
    if (
      !headers ||
      typeof headers !== 'object' ||
      Array.isArray(headers) ||
      Object.values(headers).some((v) => typeof v !== 'string')
    )
      return invalid();
    createOtlpExporter({ endpoint, headers: headers as Record<string, string> });
  } catch {
    return invalid();
  }
}

function origin(raw: string): string {
  try {
    const u = new URL(raw);
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      u.pathname !== '/' ||
      u.port ||
      u.hostname === 'localhost' ||
      !u.hostname.includes('.')
    )
      return invalid();
    return u.origin;
  } catch {
    return invalid();
  }
}
function hostname(raw: string): string {
  if (
    raw.length > 253 ||
    !raw.split('.').every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)) ||
    !raw.includes('.')
  )
    return invalid();
  return raw;
}
async function artifactFile(root: string, name: string): Promise<Buffer> {
  const file = resolve(root, name);
  const rel = relative(root, file);
  if (!rel || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return invalid();
  let current = root;
  for (const part of rel.split(sep)) {
    current = resolve(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (current === file ? !stat.isFile() : !stat.isDirectory()))
      return invalid();
  }
  if ((await realpath(file)) !== file) return invalid();
  return readFile(file);
}
export async function validateDeploymentArtifact(out: string) {
  try {
    const root = await realpath(resolve(out));
    const files = new Map<string, Buffer>();
    const read = async (name: string) => {
      const b = await artifactFile(root, name);
      files.set(name, b);
      return b;
    };
    const module = await read('worker.js');
    if (module.length === 0) return invalid();
    const info = safeBuildInfo(JSON.parse((await read('build-info.json')).toString('utf8')));
    const manifest = object(JSON.parse((await read('generated/manifest.json')).toString('utf8')));
    if (
      manifest.schemaVersion !== 1 ||
      manifest.platform !== 'cloudflare' ||
      !Array.isArray(manifest.plugins) ||
      !Array.isArray(manifest.bindings) ||
      manifest.bindings.some((b) => !PLUGIN_BINDABLE_PORTS.includes(object(b).port as never))
    )
      return invalid();
    const ports = manifest.platformPorts as PlatformPortConfig | null;
    if (
      ports !== null &&
      (!ports || validatePlatformPorts({ cloudflare: ports }, 'cloudflare').length)
    )
      return invalid();
    if (
      ports &&
      (ports.blob.adapter !== 'r2' ||
        ports.cache.adapter !== 'cache-api' ||
        ports.jobs.adapter !== 'queues' ||
        ports.observability.adapter !== 'workers')
    )
      return invalid();
    const entries = manifest.migrations;
    if (!Array.isArray(entries)) return invalid();
    for (const entry of entries) {
      const e = object(entry);
      if (
        typeof e.id !== 'string' ||
        !/^[a-z0-9-]+:\d{4}_[a-z0-9_]+$/.test(e.id) ||
        typeof e.name !== 'string' ||
        !/^\d{4}_[a-z0-9_]+\.sql$/.test(e.name)
      )
        return invalid();
      await read(`migrations/${e.id.split(':')[0]}/${e.name}`);
    }
    await loadBuiltMigrations(root);
    const routes = await builtRouteProblems(root);
    if (routes === null || routes.length) return invalid();
    // T811's exact record contains the relative deployment descriptor; no second asset schema.
    const record = object(JSON.parse((await read('assets.json')).toString('utf8')));
    const descriptor = object(record.descriptor);
    if (
      record.schemaVersion !== 1 ||
      descriptor.directory !== './assets' ||
      descriptor.binding !== 'ASSETS' ||
      !equal(descriptor, { directory: './assets', binding: 'ASSETS', ...ASSET_CONFIG }) ||
      typeof record.digest !== 'string'
    )
      return invalid();
    const provider = object(record.provider);
    if (typeof provider.specifier !== 'string' || typeof provider.version !== 'string')
      return invalid();
    const manifestBytes = await read('assets/manifest.json');
    const ui = parseUiManifest(manifestBytes.toString('utf8'));
    if (Object.hasOwn(ui.files, 'manifest.json')) return invalid();
    const assets = [{ name: 'manifest.json', content: manifestBytes }];
    for (const name of Object.keys(ui.files).sort()) {
      const content = await read(`assets/${name}`);
      if (content.length !== ui.files[name]!.bytes) return invalid();
      assets.push({ name, content });
    }
    // Asset staging hashes bytes, including non-UTF8 files.
    const byteHash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
    const exactAssetsHash = digest(
      JSON.stringify(assets.map((f) => [f.name, byteHash(f.content)])),
    );
    if (record.digest !== `sha256:${exactAssetsHash}`) return invalid();
    const artifactHash = digest(
      canonical({
        files: [...files].sort(([a], [b]) => a.localeCompare(b)).map(([n, b]) => [n, byteHash(b)]),
        compatibility: COMPATIBILITY,
        assets: ASSET_CONFIG,
        ports,
      }),
    );
    return { module, info, ports, assets, assetsHash: exactAssetsHash, artifactHash };
  } catch {
    return invalid();
  }
}

/** All wire schemas below are fixture contracts, UNVERIFIED until T830.
 * In particular, no guessed native asset hash or secret inheritance is enabled by default.
 */
export interface DeployProviderContract {
  versionsCreateScript: boolean;
  domainZone?: (api: CloudflareApi, hostname: string) => Promise<string>;
  secretInheritance: boolean;
  assetHash?: (bytes: Buffer, name: string) => string;
  preview?: (
    api: CloudflareApi,
    script: string,
    version: string,
  ) => Promise<{ version_id: string; url: string; bindings_verified: boolean }>;
}
export const unverifiedDeployContract: DeployProviderContract = {
  versionsCreateScript: false,
  secretInheritance: false,
};
export interface DeployOptions {
  workerName: string;
  configPath?: string;
  project?: string;
  outDir?: string;
  environment?: string;
  deploymentId?: string;
  inventory?: string;
  jurisdiction?: Jurisdiction;
  runIdentity?: string;
  rollout?: number;
  publicUrl?: string;
  domain?: string;
  routes?: string;
  secret?: readonly string[];
  secrets?: string;
  allowContract?: readonly string[];
  dryRun?: boolean;
  json?: boolean;
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  contract?: DeployProviderContract;
  transaction?: InventoryTransaction;
}
interface ActiveDeployment {
  id: string | null;
  versions: Distribution[];
}
async function active(api: CloudflareApi, base: string): Promise<ActiveDeployment> {
  const raw = object((await api.request(`${base}/deployments`)).result);
  // The adapter requires an explicit active deployment, never the first/newest version.
  if (raw.active === null) return { id: null, versions: [] };
  const d = object(raw.active);
  if (!safeId(d.id) || !Array.isArray(d.versions) || d.versions.length < 1 || d.versions.length > 2)
    return conflict();
  const versions = d.versions.map((v) => {
    const x = object(v);
    if (
      !uuid(x.version_id) ||
      typeof x.percentage !== 'number' ||
      !Number.isInteger(x.percentage) ||
      x.percentage <= 0 ||
      x.percentage > 100
    )
      return conflict();
    return { version_id: x.version_id, percentage: x.percentage };
  });
  if (
    versions.reduce((n, v) => n + v.percentage, 0) !== 100 ||
    new Set(versions.map((v) => v.version_id)).size !== versions.length
  )
    return conflict();
  return { id: d.id, versions: versions.sort((a, b) => a.version_id.localeCompare(b.version_id)) };
}
function distribution(a: DeploymentAttempt): Distribution[] {
  if (!a.version_id) return unknown();
  return [
    { version_id: a.version_id, percentage: a.requested_rollout },
    ...(a.requested_rollout === 100
      ? []
      : [{ version_id: a.previous_version_id!, percentage: 100 - a.requested_rollout }]),
  ].sort((x, y) => x.version_id.localeCompare(y.version_id));
}
async function endpoints(api: CloudflareApi, base: string): Promise<EndpointPolicy> {
  const r = object((await api.request(`${base}/subdomain`)).result);
  if (typeof r.enabled !== 'boolean' || typeof r.previews_enabled !== 'boolean')
    throw new CloudflareError('capability_unknown');
  return { enabled: r.enabled, previews_enabled: r.previews_enabled };
}
function routeInput(raw: string | undefined, script: string): ManagedRoute[] {
  if (raw === undefined) return [];
  const lines = raw.split('\n');
  if (!lines.length || lines.some((l) => !l)) return invalid();
  const routes = lines.map((line) => {
    const match = /^([a-f0-9]{32}):([a-zA-Z0-9*./:-]{1,256})$/.exec(line);
    if (!match) return invalid();
    return { id: null, zone_id: match[1]!, pattern: match[2]!, script };
  });
  if (new Set(routes.map((r) => `${r.zone_id}:${r.pattern}`)).size !== routes.length)
    return invalid();
  return routes.sort((a, b) => a.pattern.localeCompare(b.pattern));
}
function secretNames(o: DeployOptions): string[] {
  const names = [...(o.secret ?? []), ...(o.secrets === undefined ? [] : o.secrets.split('\n'))];
  if (
    new Set(names).size !== names.length ||
    names.some((n) => !/^[A-Z][A-Z0-9_]{0,127}$/.test(n) || n === 'PB_TOKEN_PEPPER')
  )
    return invalid();
  return names.sort();
}
async function ownedWorkerSettings(
  api: CloudflareApi,
  base: string,
  j: Inventory,
): Promise<Record<string, unknown>> {
  const s = object((await api.request(`${base}/settings`)).result);
  if (
    !Array.isArray(s.tags) ||
    !s.tags.includes('pb-install-v1') ||
    !s.tags.includes(`pb-owner-${j.identity.owner_digest}`) ||
    !Array.isArray(s.bindings)
  )
    throw new CloudflareError('ownership_conflict', 8, false, 'deploy');
  for (const b of s.bindings.map(object)) {
    if (b.type === 'secret_text' && (Object.hasOwn(b, 'text') || Object.hasOwn(b, 'value')))
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
    if (
      b.name === 'DEPLOYMENT_ID' &&
      (b.type !== 'plain_text' || b.text !== j.identity.deployment_id)
    )
      return conflict();
  }
  return s;
}
async function liveResources(
  api: CloudflareApi,
  j: Inventory,
  ports: PlatformPortConfig | null,
): Promise<void> {
  const resources = [
    ['d1', '/d1/database'],
    ...(ports?.blob.adapter === 'r2' ? [['r2', '/r2/buckets']] : []),
    ...(ports?.jobs.adapter === 'queues'
      ? [
          ['jobs', '/queues'],
          ['dlq', '/queues'],
        ]
      : []),
  ] as const;
  for (const [key, path] of resources) {
    const r = j.resources[key as 'd1' | 'r2' | 'jobs' | 'dlq'];
    if (!r?.id || r.state !== 'complete' || !r.evidence) return invalid();
    const remote = object(
      (
        await api.request(
          `${path}/${r.id}${key === 'r2' ? `?jurisdiction=${j.identity.jurisdiction}` : ''}`,
        )
      ).result,
    );
    if (
      (key === 'r2' ? remote.name : (remote.uuid ?? remote.id ?? remote.queue_id)) !== r.id ||
      (key === 'jobs' || key === 'dlq' ? remote.queue_name : remote.name) !== r.name
    )
      return conflict();
    if ((key === 'r2' || key === 'd1') && remote.jurisdiction !== j.identity.jurisdiction)
      throw new CloudflareError('jurisdiction_conflict', 8);
  }
}
async function readSettings(
  api: CloudflareApi,
  base: string,
  j: Inventory,
  routes: ManagedRoute[],
  domain: string | undefined,
  workerExists = true,
  managedZones: readonly string[] = [],
): Promise<ManagedSettings> {
  const policy = workerExists
    ? await endpoints(api, base)
    : { enabled: false, previews_enabled: false };
  let schedules: string[] = [];
  if (workerExists) {
    const schedule = object((await api.request(`${base}/schedules`)).result);
    if (
      !Array.isArray(schedule.schedules) ||
      schedule.schedules.some((s) => object(s).cron !== '* * * * *') ||
      schedule.schedules.length > 1
    )
      return conflict();
    schedules = schedule.schedules.map((s) => String(object(s).cron));
  }
  let consumer: ManagedSettings['consumer'] = null;
  if (j.resources.jobs?.id) {
    const consumers = await api.list(`/queues/${j.resources.jobs.id}/consumers`);
    if (consumers.length > 1) return conflict();
    if (j.resources.dlq?.id && (await api.list(`/queues/${j.resources.dlq.id}/consumers`)).length)
      return conflict();
    if (consumers[0]) {
      const c = consumers[0],
        settings = object(c.settings);
      if (
        c.type !== 'worker' ||
        c.script_name !== j.identity.script_name ||
        c.dead_letter_queue !== j.resources.dlq?.name ||
        !safeId(c.consumer_id) ||
        !['batch_size', 'max_wait_time_ms', 'max_retries', 'max_concurrency'].every(
          (k) =>
            typeof settings[k] === 'number' &&
            Number.isSafeInteger(settings[k]) &&
            (settings[k] as number) >= 0,
        )
      )
        return conflict();
      consumer = {
        consumer_id: c.consumer_id,
        script_name: c.script_name,
        batch_size: settings.batch_size as number,
        max_wait_time_ms: settings.max_wait_time_ms as number,
        max_retries: settings.max_retries as number,
        max_concurrency: settings.max_concurrency as number,
        dead_letter_queue: String(c.dead_letter_queue),
      };
    }
  }
  const foundRoutes: ManagedRoute[] = [];
  for (const zone of new Set([...routes.map((r) => r.zone_id), ...managedZones])) {
    const listed = await zoneRoutes(api, zone);
    for (const r of listed) {
      if (r.script !== j.identity.script_name && typeof r.pattern === 'string') {
        const attachedHost = r.pattern.replace(/^https?:\/\//, '').split('/')[0]!;
        if (
          routes.some((x) => {
            const wanted = x.pattern.replace(/^https?:\/\//, '').split('/')[0]!;
            return (
              attachedHost === '*' ||
              attachedHost === wanted ||
              (attachedHost.startsWith('*.') && wanted.endsWith(attachedHost.slice(1)))
            );
          })
        )
          return conflict();
      }
      if (
        r.script === j.identity.script_name ||
        routes.some((x) => x.zone_id === zone && x.pattern === r.pattern)
      ) {
        if (
          r.script !== j.identity.script_name ||
          !safeId(r.id) ||
          typeof r.pattern !== 'string' ||
          !/^[a-zA-Z0-9*./:-]{1,256}$/.test(r.pattern)
        )
          return conflict();
        foundRoutes.push({ id: r.id, zone_id: zone, pattern: r.pattern, script: r.script });
      }
    }
  }
  let foundDomain: ManagedDomain | null = null;
  const domains = await api.list('/workers/domains');
  for (const d of domains) {
    if (d.hostname === domain || d.service === j.identity.script_name) {
      if (
        foundDomain ||
        d.service !== j.identity.script_name ||
        d.hostname !== domain ||
        d.environment !== 'production' ||
        !safeId(d.id) ||
        typeof d.zone_id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(d.zone_id)
      )
        return conflict();
      foundDomain = {
        id: d.id,
        zone_id: d.zone_id,
        hostname: hostname(String(d.hostname)),
        service: d.service,
        environment: 'production',
      };
    }
  }
  return {
    endpoints: policy,
    schedules,
    consumer,
    routes: foundRoutes.sort((a, b) => a.pattern.localeCompare(b.pattern)),
    domain: foundDomain,
  };
}
async function zoneRoutes(api: CloudflareApi, zone: string): Promise<Record<string, unknown>[]> {
  // Zone APIs must never be sent beneath the accounts prefix.
  const all: Record<string, unknown>[] = [];
  for (let page = 1; page <= 10000; page++) {
    const r = await api.requestZone(zone, `/workers/routes?page=${page}&per_page=100`);
    if (!Array.isArray(r.result)) return conflict();
    all.push(...r.result.map(object));
    if (r.result_info?.total_pages === page || r.result_info?.total_count === all.length)
      return all;
    if (typeof r.result_info?.total_pages !== 'number' || r.result_info.total_pages < page)
      return conflict();
  }
  return conflict();
}
function bindings(j: Inventory, ports: PlatformPortConfig | null, url: string) {
  const b: Record<string, unknown>[] = [
    { type: 'd1', name: 'DB', id: j.resources.d1!.id },
    { type: 'plain_text', name: 'DEPLOYMENT_ID', text: j.identity.deployment_id },
    { type: 'plain_text', name: 'PB_PUBLIC_URL', text: url },
  ];
  if (ports) {
    b.push(
      {
        type: 'r2_bucket',
        name: ports.blob.binding,
        bucket_name: j.resources.r2!.name,
        jurisdiction: j.identity.jurisdiction,
      },
      { type: 'queue', name: ports.jobs.binding, queue_name: j.resources.jobs!.name },
    );
    if (ports.observability.analyticsBinding)
      b.push({
        type: 'analytics_engine',
        name: ports.observability.analyticsBinding,
        dataset: j.resources.analytics!.name,
      });
  }
  b.push({ type: 'assets', name: 'ASSETS' });
  if (new Set(b.map((x) => x.name)).size !== b.length) return invalid();
  return b;
}
async function uploadAssets(
  api: CloudflareApi,
  base: string,
  artifact: Awaited<ReturnType<typeof validateDeploymentArtifact>>,
  hash: NonNullable<DeployProviderContract['assetHash']>,
): Promise<string> {
  const byHash = new Map<string, Buffer>();
  const manifest: Record<string, { hash: string; size: number }> = {};
  for (const f of artifact.assets) {
    const h = hash(f.content, f.name);
    if (!/^[a-f0-9]{32,64}$/.test(h)) throw new CloudflareError('capability_unknown');
    if (byHash.has(h) && !byHash.get(h)!.equals(f.content))
      throw new CloudflareError('capability_unknown');
    byHash.set(h, f.content);
    manifest[`/${f.name}`] = { hash: h, size: f.content.length };
  }
  const session = object(
    (await api.request(`${base}/assets-upload-session`, 'POST', { manifest })).result,
  );
  if (typeof session.jwt !== 'string' || !Array.isArray(session.buckets))
    throw new CloudflareError('provider_failure');
  let completion = session.jwt;
  const requested = new Set<string>();
  for (const bucket of session.buckets) {
    if (!Array.isArray(bucket) || bucket.length === 0)
      throw new CloudflareError('provider_failure');
    const form = new FormData();
    for (const h of bucket) {
      if (typeof h !== 'string' || !byHash.has(h) || requested.has(h))
        throw new CloudflareError('provider_failure');
      requested.add(h);
      form.set(
        h,
        new Blob([byHash.get(h)!.toString('base64')], { type: 'application/octet-stream' }),
        h,
      );
    }
    const result = object((await api.uploadAssets(form, session.jwt)).result);
    if (typeof result.jwt === 'string') completion = result.jwt;
    else if (requested.size === session.buckets.flat().length)
      throw new CloudflareError('provider_failure');
  }
  if (session.buckets.length > 0 && completion === session.jwt)
    throw new CloudflareError('provider_failure');
  return completion;
}
async function save(store: InventoryStore, j: Inventory, now: () => number): Promise<void> {
  j.revision++;
  j.updated_at = new Date(now()).toISOString();
  await store.write(j);
}

export async function reconcileCandidatePreview(
  api: CloudflareApi,
  store: InventoryStore,
  j: Inventory,
): Promise<void> {
  const a = j.deployment?.attempt;
  if (!a || a.preview === 'disabled') return;
  api.reserveRecovery(1);
  const base = `/workers/scripts/${j.identity.script_name}`;
  await ownedWorkerSettings(api, base, j);
  a.preview = 'cleanup_pending';
  await save(store, j, api.now);
  const live = await endpoints(api, base);
  const expected = {
    enabled: live.enabled && a.intended_settings.endpoints.enabled,
    previews_enabled: false,
  };
  if (!equal(live, expected)) await api.request(`${base}/subdomain`, 'POST', expected);
  if (!equal(await endpoints(api, base), expected))
    throw new CloudflareError('configuration_conflict', 10, false, 'preview_cleanup');
  a.preview = 'disabled';
  await save(store, j, api.now);
}
/** Smoke owns this finally block. Persisted intent also covers process interruption. */
export async function withCandidatePreview<T>(
  api: CloudflareApi,
  store: InventoryStore,
  j: Inventory,
  contract: DeployProviderContract,
  probe: (url: string) => Promise<T>,
): Promise<T> {
  const a = j.deployment?.attempt;
  if (!a?.version_id || a.requested_rollout === 100 || !contract.preview) return invalid();
  await reconcileCandidatePreview(api, store, j);
  const base = `/workers/scripts/${j.identity.script_name}`;
  await ownedWorkerSettings(api, base, j);
  if (!equal((await active(api, base)).versions, distribution(a))) return conflict();
  a.preview = 'enable_pending';
  await save(store, j, api.now);
  try {
    await api.request(`${base}/subdomain`, 'POST', {
      ...a.intended_settings.endpoints,
      previews_enabled: true,
    });
    if (
      !equal(await endpoints(api, base), {
        ...a.intended_settings.endpoints,
        previews_enabled: true,
      })
    )
      return conflict();
    a.preview = 'enabled';
    await save(store, j, api.now);
    const p = await contract.preview(api, j.identity.script_name, a.version_id);
    if (
      p.version_id !== a.version_id ||
      !p.bindings_verified ||
      origin(p.url) !== a.candidate_probe_url
    )
      return conflict();
    return await probe(origin(p.url));
  } finally {
    await reconcileCandidatePreview(api, store, j);
  }
}

async function writeSetting(
  api: CloudflareApi,
  base: string,
  j: Inventory,
  kind: DeploymentAttempt['changes'][number]['kind'],
  value: ManagedSettings,
): Promise<void> {
  if (kind === 'endpoints') await api.request(`${base}/subdomain`, 'POST', value.endpoints);
  if (kind === 'schedules')
    await api.request(
      `${base}/schedules`,
      'PUT',
      value.schedules.map((cron) => ({ cron })),
    );
  if (kind === 'consumer' && value.consumer) {
    const { consumer_id, script_name, dead_letter_queue, ...settings } = value.consumer;
    await api.request(
      `/queues/${j.resources.jobs!.id}/consumers${consumer_id ? `/${consumer_id}` : ''}`,
      consumer_id ? 'PUT' : 'POST',
      { type: 'worker', script_name, dead_letter_queue, settings },
    );
  }
  if (kind === 'routes')
    for (const r of value.routes)
      await api.requestZone(
        r.zone_id,
        `/workers/routes${r.id ? `/${r.id}` : ''}`,
        r.id ? 'PUT' : 'POST',
        { pattern: r.pattern, script: r.script },
      );
  if (kind === 'domain' && value.domain) {
    const { id, ...body } = value.domain;
    void id;
    await api.request('/workers/domains', 'PUT', body);
  }
}
function restrictivePolicy(a: DeploymentAttempt): EndpointPolicy {
  return {
    enabled: a.prior_settings.endpoints.enabled && a.intended_settings.endpoints.enabled,
    previews_enabled: false,
  };
}
async function applyEndpointPolicy(
  api: CloudflareApi,
  store: InventoryStore,
  j: Inventory,
  policy: EndpointPolicy,
): Promise<void> {
  const a = j.deployment!.attempt;
  const base = `/workers/scripts/${j.identity.script_name}`;
  if (!equal(await endpoints(api, base), policy)) {
    const change = {
      kind: 'endpoints' as const,
      state: 'pending' as 'pending' | 'applied' | 'unknown',
      restoration: 'not_needed' as const,
    };
    a.changes.push(change);
    await save(store, j, api.now);
    try {
      await api.request(`${base}/subdomain`, 'POST', policy);
      if (!equal(await endpoints(api, base), policy)) return conflict();
      change.state = 'applied';
    } catch (error) {
      change.state = 'unknown';
      await save(store, j, api.now);
      throw error;
    }
    await save(store, j, api.now);
  }
}
/** The only way deploy and rollback change endpoint flags: ownership read, journalled write, read-back. */
async function enforceEndpoints(
  api: CloudflareApi,
  store: InventoryStore,
  j: Inventory,
  policy: EndpointPolicy,
): Promise<void> {
  await ownedWorkerSettings(api, `/workers/scripts/${j.identity.script_name}`, j);
  await applyEndpointPolicy(api, store, j, policy);
}
type EndpointGuard = 'verified' | 'ownership_conflict' | 'unverified';
/** Exit guard: every failure or rollback exit restricts and verifies endpoints, never throwing. */
async function secureEndpoints(
  api: CloudflareApi,
  store: InventoryStore,
  j: Inventory,
): Promise<EndpointGuard> {
  const a = j.deployment!.attempt;
  try {
    await enforceEndpoints(api, store, j, restrictivePolicy(a));
    const unresolved = a.changes.filter(
      (c) => c.kind === 'endpoints' && (c.restoration === 'unknown' || c.restoration === 'failed'),
    );
    for (const c of unresolved) c.restoration = 'restored';
    if (unresolved.length) await save(store, j, api.now);
    return 'verified';
  } catch (error) {
    return error instanceof CloudflareError && error.code === 'ownership_conflict'
      ? 'ownership_conflict'
      : 'unverified';
  }
}
function recoveryMutations(a: DeploymentAttempt): number {
  return 4 + a.changes.length + a.prior_settings.routes.length + a.intended_settings.routes.length;
}
const routeKey = (r: ManagedRoute) => `${r.zone_id}:${r.pattern}`;
function routesWithin(inner: ManagedRoute[], outer: ManagedRoute[]): boolean {
  const keys = new Set(outer.map(routeKey));
  return inner.every((r) => keys.has(routeKey(r)));
}
/** Live attachments match a managed snapshot; routes are only ever added, so a subset matches. */
function matchesManaged(
  live: ManagedSettings,
  managed: ManagedSettings,
  required: ManagedRoute[] = [],
): boolean {
  const rest = (s: ManagedSettings) => ({
    ...(withoutIds({ ...s, endpoints: managed.endpoints }) as Record<string, unknown>),
    routes: null,
  });
  return (
    equal(rest(live), rest(managed)) &&
    routesWithin(live.routes, managed.routes) &&
    routesWithin(required, live.routes)
  );
}
/** Settings a failed or rolled-back attempt left behind: prior values, plus retained first-install attachments. */
function restoredSnapshot(a: DeploymentAttempt): ManagedSettings | null {
  const snapshot = structuredClone(a.prior_settings);
  for (const change of a.changes) {
    if (change.kind === 'endpoints') continue;
    if (change.restoration === 'retained_first_install')
      Object.assign(snapshot, { [change.kind]: a.intended_settings[change.kind] });
    else if (change.restoration !== 'restored') return null;
  }
  return snapshot;
}
function withoutIds(s: ManagedSettings): unknown {
  return {
    ...s,
    consumer: s.consumer && { ...s.consumer, consumer_id: null },
    routes: s.routes.map((r) => ({ ...r, id: null })),
    domain: s.domain && { ...s.domain, id: null },
  };
}
async function restoreSettings(
  api: CloudflareApi,
  store: InventoryStore,
  j: Inventory,
  routes: ManagedRoute[],
  domain: string | undefined,
): Promise<void> {
  const a = j.deployment!.attempt,
    base = `/workers/scripts/${j.identity.script_name}`;
  for (const change of [...a.changes].reverse()) {
    if (change.restoration === 'restored' || change.restoration === 'retained_first_install')
      continue;
    try {
      const live = await readSettings(api, base, j, routes, domain);
      const prior = a.prior_settings[change.kind];
      const safePrior = { ...a.prior_settings, endpoints: restrictivePolicy(a) };
      const part = (v: ManagedSettings) => withoutIds(v) as Record<string, unknown>;
      const settle = async (restoration: DeploymentAttempt['changes'][number]['restoration']) => {
        change.restoration = restoration;
        await save(store, j, api.now);
      };
      if (equal(part(live)[change.kind], part(safePrior)[change.kind])) {
        await settle('restored');
        continue;
      }
      if (change.kind === 'endpoints') {
        await settle('unknown');
        continue;
      }
      if (change.kind === 'routes') {
        const intendedRoutes = a.intended_settings.routes;
        await settle(
          routesWithin(a.prior_settings.routes, live.routes) &&
            routesWithin(live.routes, intendedRoutes)
            ? 'retained_first_install'
            : 'unknown',
        );
        continue;
      }
      if (!equal(part(live)[change.kind], part(a.intended_settings)[change.kind])) {
        await settle('unknown');
        continue;
      }
      if ((Array.isArray(prior) && prior.length === 0) || prior === null) {
        await settle('retained_first_install');
        continue;
      }
      await writeSetting(api, base, j, change.kind, safePrior);
      const after = await readSettings(api, base, j, routes, domain);
      change.restoration = equal(part(after)[change.kind], part(safePrior)[change.kind])
        ? 'restored'
        : 'failed';
    } catch {
      change.restoration = 'unknown';
    }
    await save(store, j, api.now);
  }
}
async function version(
  api: CloudflareApi,
  base: string,
  id: string,
  a: DeploymentAttempt,
  requiredSecrets: string[],
  expectedBindings: Record<string, unknown>[],
): Promise<void> {
  const v = object((await api.request(`${base}/versions/${id}`)).result);
  const metadata = object(v.metadata),
    annotations = object(metadata.annotations);
  const resources = object(v.resources);
  if (
    v.id !== id ||
    annotations['pb-operation'] !== a.operation_id ||
    annotations['pb-artifact-sha256'] !== a.artifact_sha256 ||
    !Array.isArray(resources.bindings)
  )
    return conflict();
  const names = resources.bindings
    .filter((b) => object(b).type === 'secret_text')
    .map((b) => object(b).name);
  if (requiredSecrets.some((n) => !names.includes(n)) || new Set(names).size !== names.length)
    return conflict();
  const actualBindings = resources.bindings.map(object).filter((b) => b.type !== 'secret_text');
  if (
    !equal(
      actualBindings.sort((a, b) => String(a.name).localeCompare(String(b.name))),
      [...expectedBindings].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    ) ||
    !equal(object(resources.assets).config, ASSET_CONFIG)
  )
    return conflict();
}
async function finalizeActivation(
  api: CloudflareApi,
  store: InventoryStore,
  j: Inventory,
  ports: PlatformPortConfig | null,
): Promise<void> {
  const a = j.deployment!.attempt;
  const base = `/workers/scripts/${j.identity.script_name}`;
  const intended = a.intended_settings;
  const settings = () =>
    readSettings(api, base, j, intended.routes, intended.domain?.hostname).then(withoutIds);
  await ownedWorkerSettings(api, base, j);
  await liveResources(api, j, ports);
  const live = (await settings()) as ManagedSettings;
  if (!equal({ ...live, endpoints: intended.endpoints }, withoutIds(intended))) return conflict();
  // A recovery guard may have narrowed endpoints; anything wider than intended is concurrent drift.
  const widened =
    (live.endpoints.enabled && !intended.endpoints.enabled) || live.endpoints.previews_enabled;
  await enforceEndpoints(api, store, j, intended.endpoints);
  if (widened || !equal(await settings(), withoutIds(intended))) return conflict();
  a.phase = 'active';
  a.activated_at = new Date(api.now()).toISOString();
  j.resources.worker = {
    name: j.identity.script_name,
    id: j.identity.script_name,
    state: 'complete',
    evidence: { source: 'worker_binding', operation_id: null, verified_at: a.activated_at },
  };
  if (j.resources.analytics) {
    j.resources.analytics.state = 'bound';
    j.resources.analytics.evidence = {
      source: 'worker_binding',
      operation_id: null,
      verified_at: a.activated_at,
    };
  }
  if (a.secret_names.includes('PB_MASTER_KEY')) j.secret_delivery.master_key = 'installed';
  await save(store, j, api.now);
}
function outputAttempt(output: ReturnType<typeof commandEnvelope>, a: DeploymentAttempt): void {
  output.version_id = a.version_id;
  output.previous_version_id = a.previous_version_id;
  output.artifact_sha256 = a.artifact_sha256;
  output.build_info = a.build_info;
  output.worker_url = a.worker_url;
  output.rollback = {
    status: a.rollback,
    target_version_id: a.rollback === 'not_needed' ? null : a.previous_version_id,
  };
}
export async function deploy(o: DeployOptions): Promise<CommandResult> {
  const output = commandEnvelope('deploy', o.dryRun);
  const result: CommandResult = { exitCode: 1, output };
  const succeed = () => {
    result.exitCode = 0;
    return result;
  };
  let release: (() => Promise<void>) | undefined;
  let journal: Inventory | null = null,
    store: InventoryStore | undefined,
    api: CloudflareApi | undefined;
  let requestedRoutes: ManagedRoute[] = [];
  let attemptStarted = false;
  let uploadSent = false;
  let creatingWorker = false;
  try {
    const auth = cloudflareCredentials(o.env);
    const identity = installIdentity({
      ...auth,
      workerName: o.workerName,
      ...(o.environment === undefined ? {} : { environment: o.environment }),
      ...(o.deploymentId === undefined ? {} : { deploymentId: o.deploymentId }),
      ...(o.jurisdiction === undefined ? {} : { jurisdiction: o.jurisdiction }),
      ...(o.runIdentity === undefined ? {} : { runIdentity: o.runIdentity }),
    });
    const project = resolve(o.project ?? dirname(resolve(o.configPath ?? 'broker.config.ts')));
    const out = resolve(project, o.outDir ?? '.pb/cloudflare');
    const rollout = o.rollout ?? 100;
    if (!Number.isInteger(rollout) || rollout < 1 || rollout > 100) return invalid();
    const selectedSecrets = secretNames(o);
    if (o.domain) hostname(o.domain);
    requestedRoutes = routeInput(o.routes, identity.script_name);
    if (requestedRoutes.length && !o.publicUrl) return invalid();
    let url = o.publicUrl ? origin(o.publicUrl) : o.domain ? `https://${o.domain}` : null;
    if (o.domain && url !== `https://${o.domain}`) return invalid();
    if (
      requestedRoutes.some(
        (r) => r.pattern.replace(/^https:\/\//, '').split('/')[0] !== new URL(url!).hostname,
      )
    )
      return invalid();
    const artifact = await validateDeploymentArtifact(out);
    const endpointEnv = artifact.ports?.observability.endpointEnv;
    const headersEnv = artifact.ports?.observability.headersEnv;
    const generatedNames = [
      'DB',
      'DEPLOYMENT_ID',
      'PB_PUBLIC_URL',
      'ASSETS',
      ...(artifact.ports
        ? [
            artifact.ports.blob.binding,
            artifact.ports.jobs.binding,
            artifact.ports.observability.analyticsBinding,
          ]
        : []),
    ];
    if ([endpointEnv, headersEnv].some((n) => n && generatedNames.includes(n))) return invalid();
    const telemetryEndpoint = endpointEnv ? o.env[endpointEnv] : undefined;
    if (endpointEnv) {
      if (!telemetryEndpoint) return invalid();
      const suppliedHeaders =
        headersEnv && selectedSecrets.includes(headersEnv) ? o.env[headersEnv] : undefined;
      validateTelemetry(telemetryEndpoint, suppliedHeaders || undefined);
    }
    output.build_info = artifact.info;
    output.artifact_sha256 = artifact.artifactHash;
    store = await InventoryStore.create({
      project,
      outDir: out,
      identity,
      ...(o.inventory === undefined ? {} : { inventory: o.inventory }),
    });
    if (o.transaction) o.transaction.assertStore(store);
    const now = o.now ?? Date.now;
    if (!o.dryRun && !o.transaction) release = await store.lock(now());
    journal = await store.read();
    if (
      !journal ||
      journal.operations.some((op) => op.state === 'pending' || op.state === 'unknown')
    )
      return invalid();
    if (journal.deployment) {
      outputAttempt(output, journal.deployment.attempt);
      output.artifact_sha256 = artifact.artifactHash;
      output.build_info = artifact.info;
    }
    output.database_id = journal.resources.d1?.id ?? null;
    output.r2_bucket = journal.resources.r2?.id ?? null;
    output.queue_names = [journal.resources.jobs?.name, journal.resources.dlq?.name].filter(
      (n): n is string => n !== undefined,
    );
    const requiredKeys = ['d1', ...(artifact.ports ? ['r2', 'jobs', 'dlq'] : [])] as const;
    if (
      requiredKeys.some((k) => {
        const r = journal!.resources[k as 'd1' | 'r2' | 'jobs' | 'dlq'];
        return !r?.id || r.state !== 'complete' || !r.evidence;
      })
    )
      return invalid();
    if (
      artifact.ports?.observability.analyticsBinding &&
      !['binding_pending', 'bound'].includes(journal.resources.analytics?.state ?? '')
    )
      return invalid();
    const ledgerHash = digest(canonical(journal.migrations.ledger));
    const contract = o.contract ?? unverifiedDeployContract;
    api = new CloudflareApi({
      ...auth,
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.now ? { now: o.now } : {}),
      ...(o.sleep ? { sleep: o.sleep } : {}),
    });
    const base = `/workers/scripts/${identity.script_name}`;
    const workers = await api.list('/workers/scripts');
    const matches = workers.filter((w) => w.id === identity.script_name);
    if (matches.length > 1) return conflict();
    const exists = matches.length === 1;
    creatingWorker = !exists;
    if (exists) {
      const tags = matches[0]!.tags;
      if (
        !Array.isArray(tags) ||
        !tags.includes('pb-install-v1') ||
        !tags.includes(`pb-owner-${identity.owner_digest}`)
      )
        throw new CloudflareError('ownership_conflict', 8, false, 'deploy');
    }
    if (journal.deployment && journal.deployment.attempt.preview !== 'disabled') {
      if (o.dryRun) {
        output.plan.push({ stage: 'deploy', action: 'reconcile_preview_cleanup' });
        output.status = 'planned';
        return succeed();
      }
      await reconcileCandidatePreview(api, store, journal);
      return conflict(); // Re-read the complete configuration on a fresh run after interrupted cleanup.
    }
    const workerSettings = exists ? await ownedWorkerSettings(api, base, journal) : null;
    if (
      workerSettings &&
      (!Array.isArray(workerSettings.tags) ||
        !workerSettings.tags.includes('pb-install-v1') ||
        !workerSettings.tags.includes(`pb-owner-${identity.owner_digest}`) ||
        !Array.isArray(workerSettings.bindings))
    )
      return conflict();
    if (workerSettings) {
      const currentBindings = (workerSettings.bindings as unknown[]).map(object);
      for (const b of currentBindings) {
        if (b.type === 'secret_text') {
          if (Object.hasOwn(b, 'text') || Object.hasOwn(b, 'value')) return conflict();
          continue;
        }
        if (b.name === 'DB' && (b.type !== 'd1' || b.id !== journal.resources.d1!.id))
          return conflict();
        if (
          b.name === 'DEPLOYMENT_ID' &&
          (b.type !== 'plain_text' || b.text !== identity.deployment_id)
        )
          return conflict();
        if (
          b.type === 'r2_bucket' &&
          (b.name !== artifact.ports?.blob.binding ||
            b.bucket_name !== journal.resources.r2?.name ||
            b.jurisdiction !== identity.jurisdiction)
        )
          return conflict();
        if (
          b.type === 'queue' &&
          (b.name !== artifact.ports?.jobs.binding || b.queue_name !== journal.resources.jobs?.name)
        )
          return conflict();
        if (
          b.type === 'analytics_engine' &&
          (b.name !== artifact.ports?.observability.analyticsBinding ||
            b.dataset !== journal.resources.analytics?.name)
        )
          return conflict();
      }
    }
    const workerSignature = workerSettings && canonical(workerSettings);
    await liveResources(api, journal, artifact.ports);
    let current = exists ? await active(api, base) : { id: null, versions: [] };
    const recordedVerified =
      journal.deployment?.attempt.phase === 'verified' &&
      journal.deployment.attempt.smoke === 'passed'
        ? journal.deployment.attempt
        : journal.deployment?.last_verified;
    if (
      current.versions.length > 1 &&
      journal.deployment?.attempt.phase !== 'activation_pending' &&
      !(recordedVerified && equal(current.versions, distribution(recordedVerified)))
    )
      return conflict();
    if (!current.versions.length && rollout !== 100) return invalid();
    if (current.versions.length === 1) {
      const prior = object(
        (await api.request(`${base}/versions/${current.versions[0]!.version_id}`)).result,
      );
      if (prior.id !== current.versions[0]!.version_id) return conflict();
      const annotations = object(object(prior.metadata).annotations);
      if (annotations['pb-maintenance-shell'] === 'true')
        throw new CloudflareError('capability_unknown', 1, false, 'deploy');
    }
    if (!url) {
      const registration = await api.request('/workers/subdomain').catch((error: unknown) => {
        if (error instanceof CloudflareError && error.status === 404) return { result: {} };
        throw error;
      });
      const sub = object(registration.result).subdomain;
      if (typeof sub !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(sub))
        throw new CloudflareError('workers_dev_subdomain_missing', 2, false, 'deploy');
      url = `https://${identity.script_name}.${sub}.workers.dev`;
    }
    if (!exists && !contract.versionsCreateScript) throw new CloudflareError('capability_unknown');
    if (!contract.assetHash) throw new CloudflareError('capability_unknown');
    if (rollout < 100 && !contract.preview) throw new CloudflareError('capability_unknown');
    const custom = !!(o.domain || requestedRoutes.length || o.publicUrl);
    const policy = { enabled: !custom, previews_enabled: false };
    const journalled = journal.deployment;
    const managedZones = [
      ...new Set(
        [
          journalled?.attempt.prior_settings,
          journalled?.attempt.intended_settings,
          journalled?.last_verified?.intended_settings,
        ].flatMap((settings) => settings?.routes.map((r) => r.zone_id) ?? []),
      ),
    ];
    const live = await readSettings(
      api,
      base,
      journal,
      requestedRoutes,
      o.domain,
      exists,
      managedZones,
    );
    const installed = exists ? await api.list(`${base}/secrets`) : [];
    if (
      installed.some(
        (s) =>
          s.type !== 'secret_text' ||
          typeof s.name !== 'string' ||
          !/^[A-Z][A-Z0-9_]{0,127}$/.test(s.name),
      )
    )
      return conflict();
    const installedNames = installed.map((s) => s.name as string).sort();
    if (
      installedNames.length !== new Set(installedNames).size ||
      installedNames.includes('PB_TOKEN_PEPPER')
    )
      return invalid();
    if (installedNames.length && !contract.secretInheritance)
      throw new CloudflareError('capability_unknown');
    const plainBindings = bindings(journal, artifact.ports, url);
    if (endpointEnv) {
      if (selectedSecrets.includes(endpointEnv) || installedNames.includes(endpointEnv))
        return invalid();
      plainBindings.push({ type: 'plain_text', name: endpointEnv, text: telemetryEndpoint! });
    }
    const collisionNames = new Set(plainBindings.map((b) => b.name));
    if ([...selectedSecrets, ...installedNames].some((n) => collisionNames.has(n)))
      return invalid();
    const updates: Record<string, unknown>[] = [];
    for (const name of selectedSecrets) {
      if (
        (name === 'PB_MASTER_KEY' || name === 'PB_MASTER_KEY_PREVIOUS') &&
        installedNames.includes(name)
      ) {
        output.checks.push({ name, status: 'existing_secret_retained' });
        continue;
      }
      const text = o.env[name];
      if (text) updates.push({ type: 'secret_text', name, text });
      else if (!installedNames.includes(name)) return invalid();
    }
    const pending = journal.deployment?.attempt;
    const pendingNames =
      pending &&
      ['upload_pending', 'uploaded', 'configuring', 'activation_pending'].includes(pending.phase)
        ? pending.secret_names
        : [];
    const allNames = [
      ...new Set([...installedNames, ...pendingNames, ...updates.map((b) => String(b.name))]),
    ].sort();
    if (!allNames.includes('PB_MASTER_KEY')) return invalid();
    if (headersEnv && !allNames.includes(headersEnv)) return invalid();
    let domain = live.domain;
    if (o.domain && !domain) {
      if (!contract.domainZone) throw new CloudflareError('capability_unknown');
      const zone = await contract.domainZone(api, o.domain);
      if (!/^[a-f0-9]{32}$/.test(zone)) throw new CloudflareError('capability_unknown');
      domain = {
        id: null,
        zone_id: zone,
        hostname: o.domain,
        service: identity.script_name,
        environment: 'production',
      };
    }
    const intended: ManagedSettings = {
      endpoints: policy,
      schedules: ['* * * * *'],
      consumer: artifact.ports
        ? {
            consumer_id: live.consumer?.consumer_id ?? null,
            script_name: identity.script_name,
            batch_size: 1,
            max_wait_time_ms: 1000,
            max_retries: 4,
            max_concurrency: 2,
            dead_letter_queue: journal.resources.dlq!.name,
          }
        : null,
      routes: requestedRoutes.map((r) => ({
        ...r,
        id: live.routes.find((x) => x.zone_id === r.zone_id && x.pattern === r.pattern)?.id ?? null,
      })),
      domain,
    };
    const settingsHash = digest(
      canonical({
        settings: withoutIds(intended),
        bindings: plainBindings,
        secrets: allNames,
        ledgerHash,
      }),
    );
    const priorJournal = journal.deployment;
    const priorAttempt = priorJournal?.attempt;
    const verified =
      priorAttempt?.phase === 'verified' && priorAttempt.smoke === 'passed'
        ? priorAttempt
        : (priorJournal?.last_verified ?? null);
    const livePlain =
      workerSettings &&
      (workerSettings.bindings as unknown[]).map(object).filter((b) => b.type !== 'secret_text');
    const plainMatch =
      livePlain !== null &&
      livePlain !== undefined &&
      plainBindings.every((b) => livePlain.some((x) => equal(x, b))) &&
      livePlain.length === plainBindings.length;
    if (
      verified &&
      plainMatch &&
      verified.artifact_sha256 === artifact.artifactHash &&
      verified.settings_sha256 === settingsHash &&
      verified.requested_rollout === rollout &&
      verified.migration_ledger_sha256 === ledgerHash &&
      equal(current.versions, distribution(verified)) &&
      equal(withoutIds(live), withoutIds(intended)) &&
      !updates.some((b) => b.name !== 'PB_MASTER_KEY' && b.name !== 'PB_MASTER_KEY_PREVIOUS')
    ) {
      outputAttempt(output, verified);
      output.plan.push({ stage: 'deploy', action: 'unchanged' });
      output.status = o.dryRun ? 'planned' : 'ok';
      return succeed();
    }
    const resuming =
      priorAttempt &&
      [
        'preparing_upload',
        'upload_pending',
        'uploaded',
        'configuring',
        'activation_pending',
      ].includes(priorAttempt.phase);
    if (
      resuming &&
      priorAttempt.phase !== 'preparing_upload' &&
      updates.some((b) => b.name !== 'PB_MASTER_KEY' && b.name !== 'PB_MASTER_KEY_PREVIOUS')
    )
      return conflict();
    if (
      resuming &&
      (priorAttempt.artifact_sha256 !== artifact.artifactHash ||
        priorAttempt.settings_sha256 !== settingsHash ||
        priorAttempt.requested_rollout !== rollout)
    )
      return conflict();
    if (!resuming) {
      if (current.versions.length > 1) return conflict();
      let managed = priorAttempt?.intended_settings ?? verified?.intended_settings;
      if (priorAttempt?.phase === 'failed' || priorAttempt?.phase === 'rolled_back')
        managed = restoredSnapshot(priorAttempt) ?? conflict();
      if (
        live.routes.some(
          (r) => !intended.routes.some((x) => x.zone_id === r.zone_id && x.pattern === r.pattern),
        )
      )
        return conflict();
      // Never take over pre-existing attachments without a previous managed receipt.
      if (
        (live.consumer || live.schedules.length || live.routes.length || live.domain) &&
        (!managed || !matchesManaged(live, managed))
      )
        return conflict();
    }
    output.worker_url = url;
    output.previous_version_id = resuming
      ? priorAttempt.previous_version_id
      : (current.versions[0]?.version_id ?? null);
    output.checks.push({ name: 'provider_semantics', status: 'UNVERIFIED_until_T830' });
    output.plan.push({ stage: 'deploy', action: resuming ? 'reconcile' : 'upload_activate' });
    if (o.dryRun) {
      output.status = 'planned';
      return succeed();
    }
    let a: DeploymentAttempt;
    if (resuming) a = priorAttempt;
    else {
      a = {
        operation_id: randomUUID(),
        artifact_sha256: artifact.artifactHash,
        assets_sha256: artifact.assetsHash,
        settings_sha256: settingsHash,
        secret_names: allNames,
        build_info: artifact.info,
        version_id: null,
        previous_version_id: current.versions[0]?.version_id ?? null,
        previous_deployment_id: current.id,
        previous_distribution: current.versions,
        requested_rollout: rollout,
        worker_url: url,
        candidate_probe_url: null,
        migration_ledger_sha256: ledgerHash,
        rollback_compatible: journal.migrations.rollback_compatible,
        contract_ids: [...journal.migrations.contract_ids],
        phase: 'preparing_upload',
        activated_at: null,
        smoke: 'pending',
        rollback: 'not_needed',
        preview: 'disabled',
        prior_settings: structuredClone(live),
        intended_settings: structuredClone(intended),
        changes: [],
      };
      journal.deployment = { attempt: a, last_verified: verified };
      await save(store, journal, now);
    }
    attemptStarted = true;
    outputAttempt(output, a);
    if (a.phase === 'preparing_upload' || a.phase === 'upload_pending') {
      if (a.phase === 'upload_pending') {
        if (exists) await enforceEndpoints(api, store, journal, restrictivePolicy(a));
        const versions = await api.list(`${base}/versions`, 'items');
        const matches = versions.filter((v) => {
          const m = object(v.metadata);
          const n = object(m.annotations);
          return (
            n['pb-operation'] === a.operation_id && n['pb-artifact-sha256'] === a.artifact_sha256
          );
        });
        if (matches.length !== 1 || !uuid(matches[0]!.id)) return unknown();
        a.version_id = matches[0]!.id;
        await version(api, base, a.version_id, a, allNames, plainBindings);
      } else {
        if (
          !equal(await activeOrAbsent(api, base, exists), {
            id: a.previous_deployment_id,
            versions: a.previous_distribution,
          })
        )
          return conflict();
        if (exists) await enforceEndpoints(api, store, journal, restrictivePolicy(a));
        const token = await uploadAssets(api, base, artifact, contract.assetHash);
        const form = new FormData();
        form.set(
          'metadata',
          JSON.stringify({
            ...COMPATIBILITY,
            main_module: 'worker.js',
            bindings: [...plainBindings, ...updates],
            ...(installedNames.length ? { keep_bindings: ['secret_text'] } : {}),
            assets: { jwt: token, config: ASSET_CONFIG },
            tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`],
            annotations: {
              'pb-operation': a.operation_id,
              'pb-artifact-sha256': a.artifact_sha256,
            },
            observability: { enabled: true, logs: { invocation_logs: false } },
          }),
        );
        form.set(
          'worker.js',
          new Blob([new Uint8Array(artifact.module)], { type: 'application/javascript+module' }),
          'worker.js',
        );
        a.phase = 'upload_pending';
        await save(store, journal, now);
        uploadSent = true;
        let response;
        try {
          response = await api.request(`${base}/versions`, 'POST', form);
        } catch (error) {
          if (knownNotApplied(error)) {
            if (wasNotSent(error)) uploadSent = false;
            a.phase = 'preparing_upload';
            await save(store, journal, now);
          }
          throw error;
        }
        if (!exists) await enforceEndpoints(api, store, journal, restrictivePolicy(a));
        const uploaded = object(response.result);
        if (!uuid(uploaded.id)) return unknown();
        a.version_id = uploaded.id;
        await save(store, journal, now);
        await version(api, base, a.version_id, a, allNames, plainBindings);
      }
      a.phase = 'uploaded';
      await save(store, journal, now);
      outputAttempt(output, a);
    }
    if (!a.version_id) return unknown();
    await version(api, base, a.version_id, a, allNames, plainBindings);
    if (rollout < 100) {
      const preview = await contract.preview!(api, identity.script_name, a.version_id);
      if (preview.version_id !== a.version_id || !preview.bindings_verified) return conflict();
      const probeUrl = origin(preview.url);
      if (
        !probeUrl.endsWith('.workers.dev') ||
        probeUrl === url ||
        !new URL(probeUrl).hostname.startsWith(`${a.version_id}-`)
      )
        return conflict();
      a.candidate_probe_url = probeUrl;
      await save(store, journal, now);
    }
    if (a.phase === 'activation_pending') {
      const observed = await active(api, base);
      if (equal(observed.versions, distribution(a))) {
        await finalizeActivation(api, store, journal, artifact.ports);
        outputAttempt(output, a);
        return succeed();
      }
      return unknown(); // An old distribution does not prove that an activation was never accepted.
    }
    a.phase = 'configuring';
    await save(store, journal, now);
    let expected = await readSettings(
      api,
      base,
      journal,
      requestedRoutes,
      o.domain,
      true,
      managedZones,
    );
    for (const kind of ['endpoints', 'consumer', 'schedules', 'routes', 'domain'] as const) {
      const part = (v: ManagedSettings) => (withoutIds(v) as Record<string, unknown>)[kind];
      if (
        !equal(part(expected), part(a.prior_settings)) &&
        !equal(part(expected), part(a.intended_settings)) &&
        !(kind === 'endpoints' && equal(expected.endpoints, restrictivePolicy(a)))
      )
        return conflict();
    }
    for (const kind of ['consumer', 'schedules', 'routes', 'domain'] as const) {
      const before = await readSettings(
        api,
        base,
        journal,
        requestedRoutes,
        o.domain,
        true,
        managedZones,
      );
      const part = (v: ManagedSettings) => (withoutIds(v) as Record<string, unknown>)[kind];
      if (!equal(part(before), part(expected)) && !equal(part(before), part(a.intended_settings)))
        return conflict();
      if (!equal(part(before), part(a.intended_settings))) {
        const change = {
          kind,
          state: 'pending' as 'pending' | 'applied' | 'unknown',
          restoration: 'not_needed' as const,
        };
        a.changes.push(change);
        await save(store, journal, now);
        try {
          await writeSetting(api, base, journal, kind, a.intended_settings);
          change.state = 'applied';
        } catch (error) {
          change.state = 'unknown';
          await save(store, journal, now);
          throw error;
        }
        await save(store, journal, now);
      }
      const observed = await readSettings(
        api,
        base,
        journal,
        requestedRoutes,
        o.domain,
        true,
        managedZones,
      );
      if (!equal(part(observed), part(a.intended_settings))) return conflict();
      expected = { ...expected, [kind]: observed[kind] };
      a.intended_settings = { ...a.intended_settings, [kind]: observed[kind] };
      if (!equal(withoutIds(observed), withoutIds(expected))) return conflict();
      await save(store, journal, now);
    }
    current = await active(api, base);
    if (!equal(current, { id: a.previous_deployment_id, versions: a.previous_distribution }))
      return conflict();
    if (
      !equal(
        withoutIds(
          await readSettings(api, base, journal, requestedRoutes, o.domain, true, managedZones),
        ),
        withoutIds(expected),
      )
    )
      return conflict();
    if (
      exists &&
      canonical(object((await api.request(`${base}/settings`)).result)) !== workerSignature
    )
      return conflict();
    await liveResources(api, journal, artifact.ports);
    await enforceEndpoints(api, store, journal, policy);
    if (
      !equal(
        withoutIds(
          await readSettings(api, base, journal, requestedRoutes, o.domain, true, managedZones),
        ),
        withoutIds(a.intended_settings),
      )
    )
      return conflict();
    if (!equal(await active(api, base), current)) return conflict();
    a.phase = 'activation_pending';
    await save(store, journal, now);
    let activationFailure: unknown;
    try {
      await api.request(`${base}/deployments`, 'POST', {
        strategy: 'percentage',
        versions: distribution(a),
      });
    } catch (error) {
      activationFailure = error;
    }
    const refused = knownNotApplied(activationFailure);
    if (refused) {
      // Journalled before the fallible read-back; a resumed configuration re-verifies the prior distribution.
      a.phase = 'configuring';
      await save(store, journal, now);
    }
    const activated = await active(api, base);
    if (!equal(activated.versions, distribution(a))) {
      if (
        refused &&
        equal(activated, { id: a.previous_deployment_id, versions: a.previous_distribution })
      )
        throw activationFailure;
      a.phase = 'activation_pending';
      await save(store, journal, now);
      return unknown();
    }
    if (refused) {
      a.phase = 'activation_pending';
      await save(store, journal, now);
    }
    await finalizeActivation(api, store, journal, artifact.ports);
    outputAttempt(output, a);
    return succeed();
  } catch (error) {
    let failure = error;
    if (
      uploadSent &&
      journal?.deployment?.attempt.phase === 'upload_pending' &&
      (!(error instanceof CloudflareError) ||
        (error.code === 'provider_failure' &&
          (error.status === null || [408, 409, 429].includes(error.status) || error.status >= 500)))
    )
      failure = new CloudflareError('outcome_unknown', 6, false, 'deploy');
    if (attemptStarted && journal?.deployment && store && api && (!creatingWorker || uploadSent)) {
      const a = journal.deployment.attempt,
        base = `/workers/scripts/${journal.identity.script_name}`;
      outputAttempt(output, a);
      api.reserveRecovery(recoveryMutations(a));
      await secureEndpoints(api, store, journal);
      try {
        if (a.phase === 'configuring') {
          await ownedWorkerSettings(api, base, journal);
          const observed = await active(api, base);
          if (
            !equal(observed, { id: a.previous_deployment_id, versions: a.previous_distribution })
          ) {
            output.checks.push({ name: 'configuration_restoration', status: 'conflict' });
            throw new CloudflareError('configuration_conflict', 8, false, 'restore');
          }
          await restoreSettings(api, store, journal, requestedRoutes, o.domain);
          a.phase = 'failed';
          await save(store, journal, api.now);
        }
      } catch {
        output.checks.push({ name: 'configuration_restoration', status: 'unknown' });
      }
      output.checks.push({
        name: 'endpoint_policy',
        status: await secureEndpoints(api, store, journal),
      });
      if (a.changes.some((c) => c.restoration === 'unknown' || c.restoration === 'failed'))
        output.checks.push({ name: 'configuration_restoration', status: 'failed_or_unknown' });
      if (a.changes.some((c) => c.restoration === 'retained_first_install'))
        output.checks.push({
          name: 'configuration_restoration',
          status: 'incomplete_attachments_retained',
        });
    } else if (attemptStarted && journal?.deployment)
      outputAttempt(output, journal.deployment.attempt);
    Object.assign(
      result,
      failCommand(
        output,
        failure instanceof CloudflareError
          ? new CloudflareError(
              failure.code,
              failure.exitCode,
              failure.retryable,
              'deploy',
              failure.status,
              failure.check,
            )
          : new CloudflareError('provider_failure', 1, false, 'deploy'),
      ),
    );
    return result;
  } finally {
    if (release) {
      try {
        await release();
      } catch {
        result.exitCode = failCommand(
          output,
          new CloudflareError('install_locked', 4, false, 'deploy'),
        ).exitCode;
      }
    }
  }
}
async function activeOrAbsent(
  api: CloudflareApi,
  base: string,
  exists: boolean,
): Promise<ActiveDeployment> {
  if (exists) return active(api, base);
  const script = base.split('/').at(-1);
  if ((await api.list('/workers/scripts')).some((w) => w.id === script)) return conflict();
  return { id: null, versions: [] };
}
export async function runCloudflareDeploy(o: DeployOptions): Promise<number> {
  const result = await deploy(o);
  if (o.json || !result.output.error) console.log(JSON.stringify(result.output));
  else console.error(`${result.output.error.code}: ${result.output.error.message}`);
  return result.exitCode;
}

/** Caller holds the install lease; smoke uses this after disabling any temporary preview. */
export async function rollbackDeployment(
  api: CloudflareApi,
  store: InventoryStore,
  journal: Inventory,
): Promise<'succeeded' | 'unknown' | 'failed'> {
  const a = journal.deployment?.attempt;
  if (!a?.version_id) return invalid();
  api.reserveRecovery(recoveryMutations(a));
  await reconcileCandidatePreview(api, store, journal);
  if (
    !a.rollback_compatible ||
    a.contract_ids.length ||
    !journal.migrations.rollback_compatible ||
    journal.migrations.contract_ids.length
  )
    throw new CloudflareError('configuration_conflict', 11, false, 'rollback');
  if (!a.previous_version_id)
    throw new CloudflareError('configuration_conflict', 12, false, 'rollback');
  await ownedWorkerSettings(api, `/workers/scripts/${journal.identity.script_name}`, journal);
  let outcome: 'succeeded' | 'unknown' | 'failed';
  try {
    outcome = await rollbackOwned(api, store, journal, a, a.previous_version_id);
  } catch (error) {
    await secureEndpoints(api, store, journal);
    throw error;
  }
  const guard = await secureEndpoints(api, store, journal);
  if (outcome !== 'succeeded') return outcome;
  if (guard !== 'verified') a.rollback = 'unknown';
  else {
    a.phase = 'rolled_back';
    a.rollback = 'succeeded';
  }
  await save(store, journal, api.now);
  return guard === 'verified' ? 'succeeded' : 'unknown';
}
async function rollbackOwned(
  api: CloudflareApi,
  store: InventoryStore,
  journal: Inventory,
  a: DeploymentAttempt,
  previous: string,
): Promise<'succeeded' | 'unknown' | 'failed'> {
  const base = `/workers/scripts/${journal.identity.script_name}`;
  const prior = [{ version_id: previous, percentage: 100 }];
  const live = await active(api, base);
  const recovering = a.phase === 'rollback_pending';
  if (!equal(live.versions, distribution(a)) && !(recovering && equal(live.versions, prior)))
    return conflict();
  if ((await secureEndpoints(api, store, journal)) === 'ownership_conflict')
    throw new CloudflareError('ownership_conflict', 8, false, 'rollback');
  let rollbackFailure: unknown;
  const previousPhase = a.phase;
  if (!recovering) {
    a.phase = 'rollback_pending';
    a.rollback = 'pending';
    await save(store, journal, api.now);
    try {
      await api.request(`${base}/deployments`, 'POST', { strategy: 'percentage', versions: prior });
    } catch (error) {
      rollbackFailure = error;
    }
  }
  const refused = knownNotApplied(rollbackFailure);
  if (refused) {
    // Journalled before the fallible read-back; a retry re-verifies the live distribution first.
    a.phase = previousPhase;
    a.rollback = 'failed';
    await save(store, journal, api.now);
  }
  const observed = await active(api, base);
  if (!equal(observed.versions, prior)) {
    if (refused && equal(observed, live)) return 'failed';
    a.phase = 'rollback_pending';
    a.rollback = 'unknown';
    await save(store, journal, api.now);
    return 'unknown';
  }
  if (refused) {
    a.phase = 'rollback_pending';
    a.rollback = 'pending';
    await save(store, journal, api.now);
  }
  await ownedWorkerSettings(api, base, journal);
  await restoreSettings(
    api,
    store,
    journal,
    a.intended_settings.routes,
    a.intended_settings.domain?.hostname,
  );
  const expected = restoredSnapshot(a);
  const restored =
    expected &&
    matchesManaged(
      await readSettings(
        api,
        base,
        journal,
        a.intended_settings.routes,
        a.intended_settings.domain?.hostname,
      ),
      expected,
      a.prior_settings.routes,
    );
  if (!restored) {
    a.rollback = 'failed';
    await save(store, journal, api.now);
    return 'failed';
  }
  return 'succeeded';
}
