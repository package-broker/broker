import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { CloudflareError, GitWorktreeRequiredError } from './api.js';

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
  schema_version: 1;
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
    state: 'not_started' | 'issuing' | 'issued' | 'unknown' | 'already_set_up';
    expires_at: string | null;
  };
  migrations: {
    applied_this_transaction: string[];
    ledger: { id: string; checksum: string; phase: 'expand' | 'contract' }[];
    rollback_compatible: boolean;
    contract_ids: string[];
  };
  deployment: null;
  updated_at: string;
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
    schema_version: 1,
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
    data.schema_version !== 1 ||
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
    data.deployment !== null
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
    !['not_started', 'issuing', 'issued', 'unknown', 'already_set_up'].includes(
      data.bootstrap.state,
    ) ||
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
        (key) => !['name', 'id', 'jurisdiction', 'state', 'evidence'].includes(key),
      )
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
