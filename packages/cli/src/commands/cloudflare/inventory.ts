import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { CloudflareError, GitWorktreeRequiredError } from './api.js';
import type { BuildInfo } from '../../build-artifacts.js';
import { isLocalAuthMode, type LocalAuthMode } from './local-auth.js';

export type Jurisdiction = 'eu' | 'default';
export type ResourceKey = 'd1' | 'r2' | 'dlq' | 'jobs' | 'analytics' | 'worker';
export type ResourceKind = 'd1' | 'r2' | 'queue' | 'analytics' | 'worker';
export interface InstallIdentity {
  account_id: string;
  worker_name: string;
  environment: string;
  script_name: string;
  deployment_id: string;
  owner_digest: string;
  run_identity: string | null;
  jurisdiction: Jurisdiction;
  location_hint: string | null;
}
export interface Evidence {
  source: 'created' | 'pending_create' | 'adopted' | 'worker_binding';
  operation_id: string | null;
  verified_at: string;
}
export interface Resource {
  name: string;
  id: string | null;
  jurisdiction?: Jurisdiction | null;
  state: 'planned' | 'creating' | 'complete' | 'binding_pending' | 'bound';
  evidence: Evidence | null;
  lifecycle_baseline?: LifecycleRule[];
}
export interface LifecycleRule {
  id: string;
  enabled: boolean;
  conditions: { prefix: string };
  abortMultipartUploadsTransition: { condition: { type: 'Age'; maxAge: number } };
}
export interface LiveLifecycleRule extends Omit<LifecycleRule, 'conditions'> {
  conditions: { prefix?: string };
}
export function abortOnlyRule(rule: LiveLifecycleRule): LifecycleRule {
  return {
    id: rule.id,
    enabled: rule.enabled,
    conditions: { prefix: rule.conditions.prefix ?? '' },
    abortMultipartUploadsTransition: rule.abortMultipartUploadsTransition,
  };
}
export function lifecycleRule(raw: unknown): raw is LiveLifecycleRule {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const only = (v: Record<string, unknown>, keys: string[]) =>
    Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
  if (!record(raw)) return false;
  const emptyTransitions =
    Array.isArray(raw.storageClassTransitions) && raw.storageClassTransitions.length === 0;
  if (
    !only(
      raw,
      emptyTransitions
        ? [
            'id',
            'enabled',
            'conditions',
            'abortMultipartUploadsTransition',
            'storageClassTransitions',
          ]
        : ['id', 'enabled', 'conditions', 'abortMultipartUploadsTransition'],
    )
  )
    return false;
  const { conditions, abortMultipartUploadsTransition: abort } = raw;
  if (
    !record(conditions) ||
    !(
      only(conditions, []) ||
      (only(conditions, ['prefix']) && typeof conditions.prefix === 'string')
    )
  )
    return false;
  if (!record(abort) || !only(abort, ['condition']) || !record(abort.condition)) return false;
  const c = abort.condition;
  return (
    only(c, ['type', 'maxAge']) &&
    c.type === 'Age' &&
    typeof c.maxAge === 'number' &&
    Number.isSafeInteger(c.maxAge) &&
    c.maxAge > 0 &&
    typeof raw.id === 'string' &&
    raw.id.length > 0 &&
    raw.id.length <= 255 &&
    typeof raw.enabled === 'boolean'
  );
}
export interface Operation {
  id: string;
  kind: ResourceKind;
  name: string;
  spec_sha256: string;
  absence_observed_at: string;
  started_at: string;
  state: 'pending' | 'confirmed' | 'unknown' | 'failed';
  resolved_id: string | null;
}
export interface Inventory {
  schema_version: 2;
  revision: number;
  identity: InstallIdentity;
  resources: Partial<Record<ResourceKey, Resource>>;
  operations: Operation[];
  secret_delivery: {
    master_key:
      'not_started' | 'export_pending' | 'exported' | 'upload_pending' | 'installed' | 'unknown';
    secret_name: 'PB_MASTER_KEY';
  };
  bootstrap: {
    state:
      | 'not_started'
      | 'issuing'
      | 'issued'
      | 'unknown'
      | 'already_set_up'
      | 'sso_issuing'
      | 'sso_failed'
      | 'sso_unknown'
      | 'sso_complete';
    expires_at: string | null;
  };
  migrations: {
    applied_this_transaction: string[];
    ledger: { id: string; checksum: string; phase: 'expand' | 'contract' }[];
    rollback_compatible: boolean;
    contract_ids: string[];
  };
  deployment: DeploymentJournal | null;
  updated_at: string;
}
export interface EndpointPolicy {
  enabled: boolean;
  previews_enabled: boolean;
}
export interface QueueConsumer {
  consumer_id: string | null;
  script_name: string;
  batch_size: number;
  max_wait_time_ms: number;
  max_retries: number;
  max_concurrency: number;
  dead_letter_queue: string;
}
export interface ManagedRoute {
  id: string | null;
  zone_id: string;
  pattern: string;
  script: string;
}
export interface ManagedDomain {
  id: string | null;
  zone_id: string;
  hostname: string;
  service: string;
  environment: 'production';
}
export interface ManagedSettings {
  endpoints: EndpointPolicy;
  schedules: string[];
  consumer: QueueConsumer | null;
  routes: ManagedRoute[];
  domain: ManagedDomain | null;
}
export interface Distribution {
  version_id: string;
  percentage: number;
}
export interface DeploymentAttempt {
  operation_id: string;
  artifact_sha256: string;
  assets_sha256: string | null;
  settings_sha256: string;
  providers_sha256?: string | null;
  identity_sha256?: string | null;
  providers_text?: string;
  local_auth?: LocalAuthMode;
  secret_names: string[];
  build_info: BuildInfo;
  version_id: string | null;
  previous_version_id: string | null;
  previous_deployment_id: string | null;
  previous_distribution: Distribution[];
  script_creation?: {
    state: 'pending' | 'complete';
    deployment_id: string | null;
    version_id: string | null;
  };
  requested_rollout: number;
  worker_url: string;
  candidate_probe_url: string | null;
  migration_ledger_sha256: string;
  rollback_compatible: boolean;
  contract_ids: string[];
  phase:
    | 'preparing_upload'
    | 'upload_pending'
    | 'uploaded'
    | 'configuring'
    | 'activation_pending'
    | 'active'
    | 'verified'
    | 'failed'
    | 'rollback_pending'
    | 'rolled_back';
  activated_at: string | null;
  smoke: 'pending' | 'passed' | 'failed';
  smoke_checks?: SmokeCheck[];
  rollback: 'not_needed' | 'pending' | 'succeeded' | 'failed' | 'unknown';
  preview: 'disabled' | 'enable_pending' | 'enabled' | 'cleanup_pending';
  prior_settings: ManagedSettings;
  intended_settings: ManagedSettings;
  changes: {
    kind: 'endpoints' | 'schedules' | 'consumer' | 'routes' | 'domain';
    state: 'pending' | 'applied' | 'unknown';
    restoration: 'not_needed' | 'restored' | 'retained_first_install' | 'failed' | 'unknown';
  }[];
}
export interface SmokeCheck {
  name:
    | 'canonical_ready'
    | 'canonical_composer_unauthorized'
    | 'canonical_npm_unauthorized'
    | 'canonical_composer_authorized'
    | 'canonical_npm_authorized'
    | 'candidate_ready'
    | 'candidate_composer_unauthorized'
    | 'candidate_npm_unauthorized'
    | 'candidate_composer_authorized'
    | 'candidate_npm_authorized'
    | 'rollback_ready';
  status: 'passed' | 'failed' | 'connection' | 'not_ready' | 'rate_limited' | 'timeout';
  attempt: number;
  elapsed_ms: number;
}
export interface DeploymentJournal {
  attempt: DeploymentAttempt;
  last_verified: DeploymentAttempt | null;
  history?: DeploymentHistory;
}
export interface DeploymentHistory {
  version_ids: string[];
  plain_bindings: { name: string; texts: string[] }[];
  hashed_bindings?: { name: string; sha256: string[] }[];
}
export const hashedBindingNames: ReadonlySet<string> = new Set(['PB_IDP_PROVIDERS']);
export const deploymentHistoryLimits = {
  versions: 10_000,
  plainValues: 64,
  hashedValues: 64,
} as const;

export class DeploymentHistoryCapacityError extends CloudflareError {
  constructor() {
    super('capacity_exceeded', 2, false, 'deploy');
    this.message =
      'Deployment history capacity reached (10000 versions or 64 distinct plain binding values). Retain the inventory and use a new installation before deploying again.';
  }
}

export function recordDeploymentHistory(
  deployment: DeploymentJournal,
  receipt: {
    versionId?: string;
    plainBinding?: { name: string; text: string };
    reserveVersion?: boolean;
  },
): void {
  const history = structuredClone(deployment.history ?? { version_ids: [], plain_bindings: [] });
  for (const id of [
    receipt.versionId,
    deployment.attempt.version_id,
    deployment.last_verified?.version_id,
  ])
    if (id && !history.version_ids.includes(id)) history.version_ids.push(id);
  const bindings = [
    ...[deployment.attempt, deployment.last_verified].flatMap((attempt) =>
      attempt?.version_id && attempt.worker_url
        ? [{ name: 'PB_PUBLIC_URL', text: attempt.worker_url }]
        : [],
    ),
    ...(receipt.plainBinding ? [receipt.plainBinding] : []),
  ];
  for (const binding of bindings) {
    if (hashedBindingNames.has(binding.name)) {
      const hashes = (history.hashed_bindings ??= []);
      const existing = hashes.find((b) => b.name === binding.name);
      const sha256 = digest(binding.text);
      if (!existing) hashes.push({ name: binding.name, sha256: [sha256] });
      else {
        const index = existing.sha256.indexOf(sha256);
        if (index !== -1) existing.sha256.splice(index, 1);
        existing.sha256.push(sha256);
        if (existing.sha256.length > deploymentHistoryLimits.hashedValues) existing.sha256.shift();
      }
      continue;
    }
    const existing = history.plain_bindings.find((b) => b.name === binding.name);
    if (!existing) history.plain_bindings.push({ name: binding.name, texts: [binding.text] });
    else if (!existing.texts.includes(binding.text)) existing.texts.push(binding.text);
  }
  if (
    history.version_ids.length + Number(Boolean(receipt.reserveVersion)) >
      deploymentHistoryLimits.versions ||
    history.plain_bindings.reduce((count, b) => count + b.texts.length, 0) >
      deploymentHistoryLimits.plainValues
  )
    throw new DeploymentHistoryCapacityError();
  deployment.history = history;
}
export function safeBuildInfo(raw: unknown): BuildInfo {
  const bad = () => {
    throw new CloudflareError('invalid_input', 2);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad();
  const v = raw as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (k) =>
        ![
          'schemaVersion',
          'target',
          'core',
          'plugins',
          'lockfileSha256',
          'gitSha',
          'dirty',
        ].includes(k),
    ) ||
    v.schemaVersion !== 1 ||
    v.target !== 'cloudflare' ||
    typeof v.core !== 'string' ||
    !/^[a-zA-Z0-9.+-]{1,64}$/.test(v.core) ||
    !v.plugins ||
    typeof v.plugins !== 'object' ||
    Array.isArray(v.plugins)
  )
    return bad();
  if (
    Object.entries(v.plugins).some(
      ([k, value]) =>
        !/^[@a-zA-Z0-9/_.-]{1,128}$/.test(k) ||
        typeof value !== 'string' ||
        !/^[a-zA-Z0-9.+-]{1,64}$/.test(value),
    )
  )
    return bad();
  if (
    v.lockfileSha256 !== null &&
    (typeof v.lockfileSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.lockfileSha256))
  )
    return bad();
  if (v.gitSha !== null && (typeof v.gitSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(v.gitSha)))
    return bad();
  if (v.dirty !== undefined && v.dirty !== null && typeof v.dirty !== 'boolean') return bad();
  return raw as BuildInfo;
}
function deploymentValid(raw: unknown): boolean {
  const record = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v);
  const exact = (v: unknown, keys: string[]): v is Record<string, unknown> =>
    record(v) &&
    Object.keys(v).length === keys.length &&
    Object.keys(v).every((k) => keys.includes(k));
  const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const id = (v: unknown) => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
  const origin = (v: unknown) => {
    try {
      const u = new URL(String(v));
      return u.protocol === 'https:' && u.origin === v && !u.username && !u.password;
    } catch {
      return false;
    }
  };
  const settings = (v: unknown): boolean => {
    if (
      !exact(v, ['endpoints', 'schedules', 'consumer', 'routes', 'domain']) ||
      !exact(v.endpoints, ['enabled', 'previews_enabled']) ||
      typeof v.endpoints.enabled !== 'boolean' ||
      typeof v.endpoints.previews_enabled !== 'boolean' ||
      !Array.isArray(v.schedules) ||
      !v.schedules.every((s) => s === '* * * * *') ||
      !Array.isArray(v.routes)
    )
      return false;
    if (v.consumer !== null) {
      const c = v.consumer;
      if (
        !exact(c, [
          'consumer_id',
          'script_name',
          'batch_size',
          'max_wait_time_ms',
          'max_retries',
          'max_concurrency',
          'dead_letter_queue',
        ]) ||
        (c.consumer_id !== null && !id(c.consumer_id)) ||
        !id(c.script_name) ||
        !id(c.dead_letter_queue) ||
        !['batch_size', 'max_wait_time_ms', 'max_retries', 'max_concurrency'].every(
          (k) => typeof c[k] === 'number' && Number.isSafeInteger(c[k]) && (c[k] as number) >= 0,
        )
      )
        return false;
    }
    if (
      !v.routes.every(
        (r) =>
          exact(r, ['id', 'zone_id', 'pattern', 'script']) &&
          (r.id === null || id(r.id)) &&
          typeof r.zone_id === 'string' &&
          /^[a-f0-9]{32}$/.test(r.zone_id) &&
          typeof r.pattern === 'string' &&
          /^[a-zA-Z0-9*./:-]{1,256}$/.test(r.pattern) &&
          id(r.script),
      )
    )
      return false;
    if (v.domain !== null) {
      const d = v.domain;
      if (
        !exact(d, ['id', 'zone_id', 'hostname', 'service', 'environment']) ||
        (d.id !== null && !id(d.id)) ||
        typeof d.zone_id !== 'string' ||
        !/^[a-f0-9]{32}$/.test(d.zone_id) ||
        typeof d.hostname !== 'string' ||
        !/^[a-z0-9.-]{1,253}$/.test(d.hostname) ||
        !id(d.service) ||
        d.environment !== 'production'
      )
        return false;
    }
    return true;
  };
  const attempt = (v: unknown): boolean => {
    if (
      !record(v) ||
      !exact(v, [
        'operation_id',
        'artifact_sha256',
        'assets_sha256',
        'settings_sha256',
        ...(Object.hasOwn(v, 'providers_sha256') ? ['providers_sha256'] : []),
        ...(Object.hasOwn(v, 'identity_sha256') ? ['identity_sha256'] : []),
        ...(Object.hasOwn(v, 'providers_text') ? ['providers_text'] : []),
        ...(Object.hasOwn(v, 'local_auth') ? ['local_auth'] : []),
        'secret_names',
        'build_info',
        'version_id',
        'previous_version_id',
        'previous_deployment_id',
        'previous_distribution',
        ...(Object.hasOwn(v, 'script_creation') ? ['script_creation'] : []),
        'requested_rollout',
        'worker_url',
        'candidate_probe_url',
        'migration_ledger_sha256',
        'rollback_compatible',
        'contract_ids',
        'phase',
        'activated_at',
        'smoke',
        ...(Object.hasOwn(v, 'smoke_checks') ? ['smoke_checks'] : []),
        'rollback',
        'preview',
        'prior_settings',
        'intended_settings',
        'changes',
      ])
    )
      return false;
    try {
      safeBuildInfo(v.build_info);
    } catch {
      return false;
    }
    return (
      id(v.operation_id) &&
      hash(v.artifact_sha256) &&
      (v.assets_sha256 === null || hash(v.assets_sha256)) &&
      hash(v.settings_sha256) &&
      (!Object.hasOwn(v, 'local_auth') || isLocalAuthMode(v.local_auth)) &&
      (v.identity_sha256 === undefined || v.identity_sha256 === null || hash(v.identity_sha256)) &&
      (v.providers_sha256 === undefined ||
        v.providers_sha256 === null ||
        hash(v.providers_sha256)) &&
      (v.providers_text === undefined ||
        (typeof v.providers_text === 'string' &&
          Buffer.byteLength(v.providers_text, 'utf8') <= 5120 &&
          !['verified', 'failed', 'rolled_back'].includes(String(v.phase)))) &&
      Array.isArray(v.secret_names) &&
      v.secret_names.every(
        (n) =>
          typeof n === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/.test(n) && n !== 'PB_TOKEN_PEPPER',
      ) &&
      new Set(v.secret_names).size === v.secret_names.length &&
      hash(v.migration_ledger_sha256) &&
      [v.version_id, v.previous_version_id, v.previous_deployment_id].every(
        (x) => x === null || id(x),
      ) &&
      (v.script_creation === undefined ||
        (record(v.script_creation) &&
          exact(v.script_creation, ['state', 'deployment_id', 'version_id']) &&
          v.previous_version_id === null &&
          v.previous_deployment_id === null &&
          v.requested_rollout === 100 &&
          (v.script_creation.state === 'pending'
            ? v.script_creation.deployment_id === null &&
              v.script_creation.version_id === null &&
              v.phase === 'preparing_upload'
            : v.script_creation.state === 'complete' &&
              id(v.script_creation.deployment_id) &&
              id(v.script_creation.version_id)))) &&
      Array.isArray(v.previous_distribution) &&
      v.previous_distribution.every(
        (d) => exact(d, ['version_id', 'percentage']) && id(d.version_id) && d.percentage === 100,
      ) &&
      v.previous_distribution.length <= 1 &&
      (v.previous_version_id === null
        ? v.previous_distribution.length === 0
        : v.previous_distribution[0]?.version_id === v.previous_version_id) &&
      typeof v.requested_rollout === 'number' &&
      Number.isInteger(v.requested_rollout) &&
      v.requested_rollout >= 1 &&
      v.requested_rollout <= 100 &&
      origin(v.worker_url) &&
      (v.candidate_probe_url === null || origin(v.candidate_probe_url)) &&
      typeof v.rollback_compatible === 'boolean' &&
      Array.isArray(v.contract_ids) &&
      v.contract_ids.every(
        (x) => typeof x === 'string' && /^[a-z0-9-]+:\d{4}_[a-z0-9_]+$/.test(x),
      ) &&
      [
        'preparing_upload',
        'upload_pending',
        'uploaded',
        'configuring',
        'activation_pending',
        'active',
        'verified',
        'failed',
        'rollback_pending',
        'rolled_back',
      ].includes(String(v.phase)) &&
      (v.activated_at === null || iso(v.activated_at)) &&
      ['pending', 'passed', 'failed'].includes(String(v.smoke)) &&
      (v.smoke_checks === undefined ||
        (Array.isArray(v.smoke_checks) &&
          v.smoke_checks.length <= 4000 &&
          v.smoke_checks.every(
            (c) =>
              exact(c, ['name', 'status', 'attempt', 'elapsed_ms']) &&
              /^(?:(?:canonical|candidate)_(?:ready|(?:composer|npm)_(?:un)?authorized)|rollback_ready)$/.test(
                String(c.name),
              ) &&
              ['passed', 'failed', 'connection', 'not_ready', 'rate_limited', 'timeout'].includes(
                String(c.status),
              ) &&
              typeof c.attempt === 'number' &&
              Number.isSafeInteger(c.attempt) &&
              c.attempt > 0 &&
              typeof c.elapsed_ms === 'number' &&
              Number.isSafeInteger(c.elapsed_ms) &&
              c.elapsed_ms >= 0,
          ))) &&
      ['not_needed', 'pending', 'succeeded', 'failed', 'unknown'].includes(String(v.rollback)) &&
      ['disabled', 'enable_pending', 'enabled', 'cleanup_pending'].includes(String(v.preview)) &&
      settings(v.prior_settings) &&
      settings(v.intended_settings) &&
      Array.isArray(v.changes) &&
      v.changes.every(
        (c) =>
          exact(c, ['kind', 'state', 'restoration']) &&
          ['endpoints', 'schedules', 'consumer', 'routes', 'domain'].includes(String(c.kind)) &&
          ['pending', 'applied', 'unknown'].includes(String(c.state)) &&
          ['not_needed', 'restored', 'retained_first_install', 'failed', 'unknown'].includes(
            String(c.restoration),
          ),
      )
    );
  };
  const history = (v: unknown): boolean =>
    record(v) &&
    exact(v, [
      'version_ids',
      'plain_bindings',
      ...(Object.hasOwn(v, 'hashed_bindings') ? ['hashed_bindings'] : []),
    ]) &&
    (!Object.hasOwn(v, 'hashed_bindings') ||
      (Array.isArray(v.hashed_bindings) &&
        v.hashed_bindings.length > 0 &&
        new Set(v.hashed_bindings.map((b) => record(b) && b.name)).size ===
          v.hashed_bindings.length &&
        v.hashed_bindings.every(
          (b) =>
            exact(b, ['name', 'sha256']) &&
            typeof b.name === 'string' &&
            hashedBindingNames.has(b.name) &&
            Array.isArray(b.sha256) &&
            b.sha256.length > 0 &&
            b.sha256.length <= deploymentHistoryLimits.hashedValues &&
            b.sha256.every(hash) &&
            new Set(b.sha256).size === b.sha256.length,
        ))) &&
    Array.isArray(v.version_ids) &&
    v.version_ids.length <= deploymentHistoryLimits.versions &&
    v.version_ids.every(id) &&
    new Set(v.version_ids).size === v.version_ids.length &&
    Array.isArray(v.plain_bindings) &&
    v.plain_bindings.length <= deploymentHistoryLimits.plainValues &&
    new Set(v.plain_bindings.map((b) => record(b) && b.name)).size === v.plain_bindings.length &&
    v.plain_bindings.every(
      (b) =>
        exact(b, ['name', 'texts']) &&
        typeof b.name === 'string' &&
        !hashedBindingNames.has(b.name) &&
        /^[A-Z][A-Z0-9_]{0,127}$/.test(b.name) &&
        Array.isArray(b.texts) &&
        b.texts.length > 0 &&
        b.texts.every(
          (text) =>
            typeof text === 'string' &&
            text.length <= 4096 &&
            (b.name !== 'PB_AUTH_LOCAL' || isLocalAuthMode(text)),
        ) &&
        new Set(b.texts).size === b.texts.length,
    ) &&
    v.plain_bindings.reduce((count, b) => count + b.texts.length, 0) <=
      deploymentHistoryLimits.plainValues;
  return (
    record(raw) &&
    (Object.hasOwn(raw, 'history')
      ? exact(raw, ['attempt', 'last_verified', 'history']) && history(raw.history)
      : exact(raw, ['attempt', 'last_verified'])) &&
    attempt(raw.attempt) &&
    (raw.last_verified === null ||
      (record(raw.last_verified) &&
        attempt(raw.last_verified) &&
        raw.last_verified.phase === 'verified' &&
        raw.last_verified.smoke === 'passed'))
  );
}
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
const component = (value: string, max: number): boolean =>
  value.length <= max && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value);
export function installIdentity(o: {
  accountId: string;
  workerName: string;
  environment?: string;
  deploymentId?: string;
  jurisdiction?: Jurisdiction;
  locationHint?: string;
  runIdentity?: string;
}): InstallIdentity {
  const environment = o.environment ?? 'production';
  const script = `${o.workerName}-${environment}`;
  const deployment = o.deploymentId ?? script;
  if (
    !/^[a-f0-9]{32}$/.test(o.accountId) ||
    !component(o.workerName, 24) ||
    !component(environment, 12) ||
    !component(deployment, 64) ||
    (o.jurisdiction !== undefined && !['eu', 'default'].includes(o.jurisdiction)) ||
    (o.locationHint !== undefined && !/^[a-z]{2,8}$/.test(o.locationHint)) ||
    (o.runIdentity !== undefined && !/^[a-zA-Z0-9_.-]{1,128}$/.test(o.runIdentity))
  )
    throw new CloudflareError('invalid_input', 2);
  // Until the provider contract is verified, accept no guessed hint/EU combination.
  if ((o.jurisdiction ?? 'eu') === 'eu' && o.locationHint !== undefined)
    throw new CloudflareError('invalid_input', 2);
  return {
    account_id: o.accountId,
    worker_name: o.workerName,
    environment,
    script_name: script,
    deployment_id: deployment,
    owner_digest: digest([o.accountId, o.workerName, environment, deployment].join('\0')),
    run_identity: o.runIdentity ?? null,
    jurisdiction: o.jurisdiction ?? 'eu',
    location_hint: o.locationHint ?? null,
  };
}
export function emptyInventory(identity: InstallIdentity, now: number): Inventory {
  return {
    schema_version: 2,
    revision: 0,
    identity,
    resources: {},
    operations: [],
    secret_delivery: { master_key: 'not_started', secret_name: 'PB_MASTER_KEY' },
    bootstrap: { state: 'not_started', expires_at: null },
    migrations: {
      applied_this_transaction: [],
      ledger: [],
      rollback_compatible: true,
      contract_ids: [],
    },
    deployment: null,
    updated_at: new Date(now).toISOString(),
  };
}
function inside(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
}
async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
async function noLinks(root: string, path: string): Promise<void> {
  if (!inside(root, path)) throw new CloudflareError('unsafe_path', 2);
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = await stat(current);
    if (entry?.isSymbolicLink()) throw new CloudflareError('unsafe_path', 2);
    if (entry && current !== path && !entry.isDirectory())
      throw new CloudflareError('unsafe_path', 2);
  }
}
async function canonical(path: string): Promise<string> {
  const entry = await stat(path);
  if (entry !== null) return realpath(path);
  const parent = dirname(path);
  if (parent === path) throw new CloudflareError('unsafe_path', 2);
  return join(await canonical(parent), basename(path));
}
const iso = (v: unknown): boolean => typeof v === 'string' && Number.isFinite(Date.parse(v));
const safeId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
export function validResourceId(kind: ResourceKind, id: unknown): id is string {
  return (
    typeof id === 'string' &&
    (kind === 'd1'
      ? /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
      : kind === 'r2'
        ? /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(id)
        : kind === 'queue'
          ? /^[a-f0-9]{32}$/.test(id)
          : kind === 'worker'
            ? component(id, 37)
            : false)
  );
}
export function resourceKind(key: ResourceKey): ResourceKind {
  return key === 'jobs' || key === 'dlq' ? 'queue' : key;
}
export function validateInventory(raw: unknown, expected: InstallIdentity): Inventory {
  const bad = () => {
    throw new CloudflareError('invalid_inventory', 2);
  };
  if (typeof raw !== 'object' || raw === null) return bad();
  const data = raw as Inventory;
  if (
    data.schema_version !== 2 ||
    !Number.isSafeInteger(data.revision) ||
    data.revision < 0 ||
    !iso(data.updated_at) ||
    !data.identity
  )
    return bad();
  for (const key of Object.keys(expected) as (keyof InstallIdentity)[]) {
    // Location hints are creation-only; an altered hint never changes ownership.
    if (key !== 'location_hint' && data.identity[key] !== expected[key])
      throw new CloudflareError('ownership_conflict', 8);
  }
  if (
    !data.resources ||
    typeof data.resources !== 'object' ||
    Array.isArray(data.resources) ||
    !Array.isArray(data.operations) ||
    !data.migrations ||
    !data.bootstrap ||
    !data.secret_delivery ||
    (data.deployment !== null && !deploymentValid(data.deployment))
  )
    return bad();
  const names: Record<ResourceKey, string> = {
    d1: `${expected.script_name}-db`,
    r2: `${expected.script_name}-blobs`,
    jobs: `${expected.script_name}-jobs`,
    dlq: `${expected.script_name}-jobs-dlq`,
    analytics: `${expected.script_name.replaceAll('-', '_')}_metrics`,
    worker: expected.script_name,
  };
  for (const [key, r] of Object.entries(data.resources)) {
    if (
      !Object.hasOwn(names, key) ||
      !r ||
      r.name !== names[key as ResourceKey] ||
      !['planned', 'creating', 'complete', 'binding_pending', 'bound'].includes(r.state)
    )
      return bad();
    const kind = resourceKind(key as ResourceKey);
    if (
      r.id !== null &&
      (!validResourceId(kind, r.id) || ((kind === 'worker' || kind === 'r2') && r.id !== r.name))
    )
      return bad();
    if (
      (kind === 'd1' || kind === 'r2') &&
      (r.jurisdiction !== null || ['complete', 'binding_pending', 'bound'].includes(r.state)) &&
      r.jurisdiction !== expected.jurisdiction
    )
      return bad();
    if (r.state === 'complete' && (r.id === null || r.evidence === null)) return bad();
    if (
      r.evidence !== null &&
      (!['created', 'pending_create', 'adopted', 'worker_binding'].includes(r.evidence.source) ||
        !iso(r.evidence.verified_at) ||
        (r.evidence.operation_id !== null && !safeId(r.evidence.operation_id)))
    )
      return bad();
  }
  const ids = new Set<string>();
  for (const op of data.operations) {
    if (
      !op ||
      !safeId(op.id) ||
      ids.has(op.id) ||
      !['d1', 'r2', 'queue'].includes(op.kind) ||
      !/^[a-f0-9]{64}$/.test(op.spec_sha256) ||
      !iso(op.absence_observed_at) ||
      !iso(op.started_at) ||
      Date.parse(op.started_at) < Date.parse(op.absence_observed_at) ||
      !['pending', 'confirmed', 'unknown', 'failed'].includes(op.state) ||
      (op.resolved_id !== null && !validResourceId(op.kind, op.resolved_id)) ||
      !Object.entries(data.resources).some(
        ([key, r]) => r?.name === op.name && resourceKind(key as ResourceKey) === op.kind,
      )
    )
      return bad();
    ids.add(op.id);
  }
  const allowed = [
    'schema_version',
    'revision',
    'identity',
    'resources',
    'operations',
    'secret_delivery',
    'bootstrap',
    'migrations',
    'deployment',
    'updated_at',
  ];
  if (
    Object.keys(data).some((key) => !allowed.includes(key)) ||
    Object.keys(data.identity).some((key) => !Object.hasOwn(expected, key))
  )
    return bad();
  if (
    ![
      'not_started',
      'export_pending',
      'exported',
      'upload_pending',
      'installed',
      'unknown',
    ].includes(data.secret_delivery.master_key) ||
    data.secret_delivery.secret_name !== 'PB_MASTER_KEY' ||
    ![
      'not_started',
      'issuing',
      'issued',
      'unknown',
      'already_set_up',
      'sso_issuing',
      'sso_failed',
      'sso_unknown',
      'sso_complete',
    ].includes(data.bootstrap.state) ||
    (data.bootstrap.expires_at !== null && !iso(data.bootstrap.expires_at))
  )
    return bad();
  if (
    Object.keys(data.secret_delivery).some((key) => !['master_key', 'secret_name'].includes(key)) ||
    Object.keys(data.bootstrap).some((key) => !['state', 'expires_at'].includes(key)) ||
    Object.keys(data.migrations).some(
      (key) =>
        !['applied_this_transaction', 'ledger', 'rollback_compatible', 'contract_ids'].includes(
          key,
        ),
    )
  )
    return bad();
  const migrations = data.migrations;
  if (
    typeof migrations.rollback_compatible !== 'boolean' ||
    !Array.isArray(migrations.applied_this_transaction) ||
    !Array.isArray(migrations.contract_ids) ||
    !Array.isArray(migrations.ledger)
  )
    return bad();
  const migrationId = (id: unknown) =>
    typeof id === 'string' && /^[a-z0-9-]+:\d{4}_[a-z0-9_]+$/.test(id);
  if (
    ![...migrations.applied_this_transaction, ...migrations.contract_ids].every(migrationId) ||
    migrations.ledger.some(
      (entry) =>
        !entry ||
        !migrationId(entry.id) ||
        !/^[a-f0-9]{64}$/.test(entry.checksum) ||
        !['expand', 'contract'].includes(entry.phase) ||
        Object.keys(entry).some((key) => !['id', 'checksum', 'phase'].includes(key)),
    )
  )
    return bad();
  for (const [key, r] of Object.entries(data.resources)) {
    if (
      Object.keys(r).some(
        (key) =>
          !['name', 'id', 'jurisdiction', 'state', 'evidence', 'lifecycle_baseline'].includes(key),
      )
    )
      return bad();
    if (
      r.lifecycle_baseline !== undefined &&
      (key !== 'r2' ||
        !Array.isArray(r.lifecycle_baseline) ||
        r.lifecycle_baseline.length > 16 ||
        !r.lifecycle_baseline.every(
          (rule) => lifecycleRule(rule) && typeof rule.conditions.prefix === 'string',
        ) ||
        r.evidence === null ||
        !['created', 'pending_create'].includes(r.evidence.source))
    )
      return bad();
    if (
      r.evidence &&
      Object.keys(r.evidence).some(
        (key) => !['source', 'operation_id', 'verified_at'].includes(key),
      )
    )
      return bad();
    const unresolved = data.operations.filter(
      (op) => op.name === r.name && ['pending', 'unknown'].includes(op.state),
    );
    if (unresolved.length > 1) return bad();
    if (r.evidence && ['created', 'pending_create'].includes(r.evidence.source)) {
      if (
        !data.operations.some(
          (op) =>
            op.id === r.evidence?.operation_id &&
            op.kind === resourceKind(key as ResourceKey) &&
            op.name === r.name &&
            op.resolved_id === r.id,
        )
      )
        return bad();
    }
  }
  for (const op of data.operations) {
    if (
      Object.keys(op).some(
        (key) =>
          ![
            'id',
            'kind',
            'name',
            'spec_sha256',
            'absence_observed_at',
            'started_at',
            'state',
            'resolved_id',
          ].includes(key),
      ) ||
      (op.state === 'confirmed' && op.resolved_id === null)
    )
      return bad();
  }
  return data;
}
export class InventoryStore {
  private constructor(
    readonly project: string,
    readonly directory: string,
    readonly path: string,
    readonly lockPath: string,
    readonly identity: InstallIdentity,
    readonly stateRoot: string,
  ) {}
  static async create(o: {
    project: string;
    outDir: string;
    inventory?: string;
    identity: InstallIdentity;
  }): Promise<InventoryStore> {
    const project = await realpath(resolve(o.project));
    const stateRoot = join(project, '.pb/state/cloudflare');
    const path = resolve(
      project,
      o.inventory ??
        join(stateRoot, `inventory.${o.identity.worker_name}.${o.identity.environment}.json`),
    );
    if (
      !inside(stateRoot, path) ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.json$/.test(basename(path)) ||
      basename(path).startsWith('lock.')
    )
      throw new CloudflareError('unsafe_path', 2);
    const directory = dirname(path);
    await noLinks(project, directory);
    await noLinks(project, path);
    let output: string;
    try {
      output = await canonical(resolve(project, o.outDir));
    } catch {
      throw new CloudflareError('unsafe_path', 2);
    }
    if (inside(output, stateRoot) || inside(stateRoot, output))
      throw new CloudflareError('unsafe_path', 2);
    const lockPath = join(
      stateRoot,
      `lock.${o.identity.worker_name}.${o.identity.environment}.json`,
    );
    await noLinks(project, lockPath);
    const existingLock = await stat(lockPath);
    if (existingLock && !existingLock.isFile()) throw new CloudflareError('unsafe_path', 2);
    const file = await stat(path);
    if (file && !file.isFile()) throw new CloudflareError('unsafe_path', 2);
    try {
      for (const candidate of [path, lockPath, join(directory, '.inventory-probe.tmp')])
        await promisify(execFile)('git', ['check-ignore', '--quiet', candidate], { cwd: project });
    } catch {
      try {
        await promisify(execFile)('git', ['rev-parse', '--is-inside-work-tree'], { cwd: project });
      } catch (probe) {
        if ((probe as { code?: unknown }).code === 128) throw new GitWorktreeRequiredError();
      }
      throw new CloudflareError('unsafe_path', 2);
    }
    return new InventoryStore(project, directory, path, lockPath, o.identity, stateRoot);
  }
  async read(): Promise<Inventory | null> {
    await noLinks(this.project, this.path);
    if (!(await stat(this.path))) return null;
    if (!(await stat(this.path))?.isFile() || (await stat(this.path))!.size > 4_194_304)
      throw new CloudflareError('unsafe_path', 2);
    const file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const data: unknown = JSON.parse(await file.readFile('utf8'));
      return validateInventory(data, this.identity);
    } catch (error) {
      if (error instanceof CloudflareError) throw error;
      throw new CloudflareError('invalid_inventory', 2);
    } finally {
      await file.close();
    }
  }
  private async prepare(): Promise<void> {
    await noLinks(this.project, this.directory);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.stateRoot, 0o700);
    await chmod(this.directory, 0o700);
  }
  async write(data: Inventory): Promise<void> {
    for (const attempt of [data.deployment?.attempt, data.deployment?.last_verified])
      if (attempt && ['verified', 'failed', 'rolled_back'].includes(attempt.phase))
        delete attempt.providers_text;
    validateInventory(data, this.identity);
    await this.prepare();
    await noLinks(this.project, this.path);
    const existing = await stat(this.path);
    if (existing && !existing.isFile()) throw new CloudflareError('unsafe_path', 2);
    const temporary = join(this.directory, `.inventory-${randomUUID()}.tmp`);
    try {
      await promisify(execFile)('git', ['check-ignore', '--quiet', temporary], {
        cwd: this.project,
      });
    } catch {
      throw new CloudflareError('unsafe_path', 2);
    }
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await file.writeFile(`${JSON.stringify(data, null, 2)}\n`);
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      const dir = await open(this.directory, constants.O_RDONLY);
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  async lock(now: number): Promise<() => Promise<void>> {
    await this.prepare();
    await noLinks(this.project, this.lockPath);
    const marker = {
      pid: process.pid,
      host: hostname(),
      started_at: new Date(now).toISOString(),
      nonce: randomUUID(),
    };
    try {
      const file = await open(
        this.lockPath,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await file.writeFile(JSON.stringify(marker));
        await file.sync();
      } finally {
        await file.close();
      }
      return async () => {
        await noLinks(this.project, this.lockPath);
        if (JSON.parse(await readFile(this.lockPath, 'utf8')).nonce !== marker.nonce)
          throw new CloudflareError('install_locked', 4);
        await unlink(this.lockPath);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const entry = await stat(this.lockPath);
      if (!entry?.isFile()) throw new CloudflareError('unsafe_path', 2);
      // A check followed by unlink can remove a concurrent recovery's replacement lock.
      // Even a dead owner requires explicit recovery with all writers stopped.
      throw new CloudflareError('install_locked', 4);
    }
  }
}

// Raw journals contain sensitive infrastructure metadata even on failed runs.
export function inventoryTransportPolicy(visibility: 'public' | 'private' | 'unknown') {
  return visibility === 'private'
    ? { raw_inventory: true, retention_days: 30, scope: 'exact_inventory_only' as const }
    : { raw_inventory: false, retention_days: 0, scope: 'id_free_summary_only' as const };
}

/** A setup caller owns this lease across provision, migration and later stages. */
export class InventoryTransaction {
  private active = true;
  private readonly appliedMigrations = new Set<string>();
  private constructor(
    readonly store: InventoryStore,
    private readonly release: () => Promise<void>,
  ) {}
  static async begin(store: InventoryStore, now: number): Promise<InventoryTransaction> {
    return new InventoryTransaction(store, await store.lock(now));
  }
  assertStore(store: InventoryStore): void {
    if (!this.active) throw new CloudflareError('install_locked', 4);
    if (this.store.path !== store.path) throw new CloudflareError('ownership_conflict', 8);
    validateInventory(emptyInventory(this.store.identity, 0), store.identity);
  }
  recordAppliedMigrations(ids: readonly string[]): string[] {
    if (!this.active) throw new CloudflareError('install_locked', 4);
    for (const id of ids) this.appliedMigrations.add(id);
    return [...this.appliedMigrations];
  }
  async close(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.release();
  }
}
