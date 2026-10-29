import { normalizeQueueConsumer, queueConsumerScript } from './queue-consumer.js';
import { d1BindingId } from './worker-settings.js';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  CloudflareError,
  cloudflareCredentials,
  commandEnvelope,
  failCommand,
  object,
  paginatedList,
  type CommandResult,
} from './api.js';
import {
  InventoryStore,
  abortOnlyRule,
  digest,
  hashedBindingNames,
  installIdentity,
  lifecycleRule,
  validateInventory,
  type Inventory,
  type LifecycleRule,
  type ResourceKey,
} from './inventory.js';

// R2 attaches this rule to every new bucket.
const PROVIDER_DEFAULT_LIFECYCLE_RULE = {
  id: 'Default Multipart Abort Rule',
  enabled: true,
  conditions: { prefix: '' },
  abortMultipartUploadsTransition: { condition: { type: 'Age', maxAge: 604800 } },
} satisfies LifecycleRule;

export interface TeardownOptions {
  inventory: string;
  project?: string;
  configPath?: string;
  outDir?: string;
  env: Readonly<Record<string, string | undefined>>;
  inventoryId?: string;
  iUnderstandThisDeletes?: boolean;
  dryRun?: boolean;
  json?: boolean;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  repositoryId?: string;
}

export class ForeignAccountInventoryError extends CloudflareError {
  constructor() {
    super('ownership_conflict', 8);
  }
}

class MultipartCleanupError extends CloudflareError {
  constructor() {
    super('ownership_conflict', 8);
  }
}

class WorkerOwnershipError extends CloudflareError {
  constructor() {
    super('ownership_conflict', 8);
  }
}

export function cleanupFailure(error: unknown, stage: string): CloudflareError {
  const safe =
    error instanceof CloudflareError
      ? new CloudflareError(error.code, error.exitCode, error.retryable, stage, error.status)
      : new CloudflareError('state_io_failure', 1, false, stage);
  const messages = {
    invalid_input:
      'Invalid cleanup input. Production teardown requires --i-understand-this-deletes and --inventory-id equal to identity.owner_digest. Adopted D1 and R2 resources always require --i-understand-this-deletes.',
    ownership_conflict:
      'Inventory ownership or live attachments differ from the selected account, run or resource.',
    outcome_unknown:
      'A resource has no resolved inventory ID or a deletion response was lost. Retain the inventory, inspect exact IDs and rerun cleanup.',
    deadline_exceeded: 'Cleanup deadline exceeded. Retain the inventory and rerun to finish.',
    state_io_failure:
      'Cleanup inventory or lock I/O failed. Resolve local state and retain the private inventory.',
    permission_denied:
      'The provider denied cleanup. Verify token permissions and retain the private inventory.',
  };
  if (Object.hasOwn(messages, safe.code))
    safe.message = messages[safe.code as keyof typeof messages];
  if (error instanceof MultipartCleanupError)
    safe.message =
      'R2 remains nonempty after an empty object drain; unrecorded multipart uploads may remain. Inspect and abort them with S3 credentials, retain the inventory and rerun cleanup. Trigger attachments may already be removed.';
  if (error instanceof WorkerOwnershipError)
    safe.message =
      'Worker ownership tags do not match the broker installation. Refusing to delete the Worker or its resources; retain the inventory and inspect the replacement Worker.';
  return safe;
}

export async function cleanupPath(project: string, path: string): Promise<void> {
  const root = join(project, '.pb/state/cloudflare');
  const part = relative(root, path);
  if (isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`))
    throw new CloudflareError('unsafe_path', 2);
  let current = project;
  for (const component of relative(project, path).split(sep)) {
    current = join(current, component);
    try {
      const entry = await lstat(current);
      if (entry.isSymbolicLink() || (current !== path && !entry.isDirectory()))
        throw new CloudflareError('unsafe_path', 2);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

export async function cleanupInventory(o: TeardownOptions) {
  const auth = cloudflareCredentials(o.env);
  const project = await realpath(
    resolve(o.project ?? dirname(resolve(o.configPath ?? 'broker.config.ts'))),
  );
  const path = resolve(project, o.inventory);
  await cleanupPath(project, path);
  const entry = await lstat(path).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new CloudflareError('invalid_inventory', 2);
    throw error;
  });
  if (!entry.isFile() || entry.size > 4_194_304) throw new CloudflareError('unsafe_path', 2);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let journal: Inventory;
  try {
    const raw: unknown = JSON.parse(await file.readFile('utf8'));
    const identity = object(object(raw).identity);
    if (typeof identity.account_id !== 'string' || !/^[a-f0-9]{32}$/.test(identity.account_id))
      throw new CloudflareError('invalid_inventory', 2);
    if (identity.account_id !== auth.accountId) throw new ForeignAccountInventoryError();
    const expected = installIdentity({
      accountId: auth.accountId,
      workerName: identity.worker_name as string,
      environment: identity.environment as string,
      deploymentId: identity.deployment_id as string,
      jurisdiction: identity.jurisdiction as 'eu' | 'default',
      ...(identity.run_identity === null ? {} : { runIdentity: identity.run_identity as string }),
    });
    journal = validateInventory(raw, expected);
  } catch (error) {
    if (error instanceof CloudflareError && error.code !== 'provider_failure') throw error;
    throw new CloudflareError('invalid_inventory', 2);
  } finally {
    await file.close();
  }
  const store = await InventoryStore.create({
    project,
    inventory: path,
    outDir: o.outDir ?? '.pb/cloudflare',
    identity: journal.identity,
  });
  return { auth, store, journal };
}

export function expiredRun(journal: Inventory, repositoryId: string, now: number): boolean {
  if (!/^[1-9][0-9]{0,19}$/.test(repositoryId)) throw new CloudflareError('invalid_input', 2);
  const run = journal.identity.run_identity;
  const match = run?.match(/^pb-e2e-([1-9][0-9]{0,19})-([0-9]{10})(?:-[a-zA-Z0-9_.-]+)?$/);
  if (!match || match[1] !== repositoryId) return false;
  const stem = `pb-e2e-${repositoryId}-${match[2]}`;
  const compact = `pb-e2e-${BigInt(repositoryId).toString(36)}-${Number(match[2]).toString(36)}`;
  const worker = journal.identity.worker_name;
  return (
    [stem, compact].some((name) => worker === name || worker.startsWith(`${name}-`)) &&
    now - Number(match[2]) * 1000 > 6 * 3600_000 &&
    now - Date.parse(journal.updated_at) > 6 * 3600_000
  );
}

function errorCodes(text: string): number[] {
  try {
    const parsed = object(JSON.parse(text));
    if (parsed.success !== false || parsed.result !== null || !Array.isArray(parsed.errors))
      return [];
    const codes = parsed.errors.map((entry) => object(entry).code);
    return codes.every((code) => Number.isInteger(code)) ? (codes as number[]) : [];
  } catch {
    return [];
  }
}

class CleanupApi {
  private readonly now: () => number;
  private readonly deadline: number;
  constructor(
    private readonly o: TeardownOptions,
    private readonly auth: ReturnType<typeof cloudflareCredentials>,
  ) {
    this.now = o.now ?? Date.now;
    this.deadline = this.now() + 600_000;
  }
  async request(
    path: string,
    method: 'GET' | 'DELETE' | 'PUT' = 'DELETE',
    body?: unknown,
    r2 = false,
    notFoundCodes = false,
    deniedCodes = false,
  ): Promise<{
    gone: boolean;
    denied?: boolean;
    result: unknown;
    result_info?: Record<string, unknown>;
    resultInfoAbsent?: boolean;
    codes?: number[];
  }> {
    if (
      (!/^\/(?:accounts|zones)\/[a-f0-9]{32}\/[a-zA-Z0-9_/?=&%.-]+$/.test(path) &&
        !/^\/zones\?account\.id=[a-f0-9]{32}&(?:page=\d+&per_page=100|cursor=[a-zA-Z0-9_%.-]+)$/.test(
          path,
        )) ||
      path.includes('..')
    )
      throw new CloudflareError('invalid_input', 2);
    for (let attempt = 0; attempt < 5; attempt++) {
      const remaining = this.deadline - this.now();
      if (remaining <= 0) throw new CloudflareError('deadline_exceeded', 1, true);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(35_000, remaining));
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error()), { once: true }),
      );
      let response: Response | undefined;
      try {
        response = await Promise.race([
          (this.o.fetch ?? fetch)(`https://api.cloudflare.com/client/v4${path}`, {
            method,
            redirect: 'manual',
            signal: controller.signal,
            headers: {
              authorization: `Bearer ${this.auth.apiToken}`,
              'content-type': 'application/json',
              ...(r2 ? { 'cf-r2-jurisdiction': this.jurisdiction } : {}),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          aborted,
        ]);
        const read = async (source: Response): Promise<string> => {
          const reader = source.body?.getReader();
          if (!reader) return '';
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          try {
            for (;;) {
              const { done, value } = await Promise.race([reader.read(), aborted]);
              if (done) break;
              bytes += value.byteLength;
              if (bytes > 1_048_576) throw new Error();
              chunks.push(value);
            }
          } finally {
            void reader.cancel().catch(() => undefined);
            reader.releaseLock();
          }
          return Buffer.concat(chunks).toString('utf8');
        };
        if (response.status === 404) {
          if (!notFoundCodes) return { gone: true, result: null };
          return { gone: true, result: null, codes: errorCodes(await read(response)) };
        }
        if (response.status === 403 && deniedCodes)
          return {
            gone: false,
            denied: true,
            result: null,
            codes: errorCodes(await read(response)),
          };
        if (!response.ok)
          throw new CloudflareError(
            [401, 403].includes(response.status) ? 'permission_denied' : 'provider_failure',
            1,
            [408, 429, 500, 502, 503, 504].includes(response.status),
            'teardown',
            response.status,
          );
        const text = await read(response);
        const domainDeletion =
          method === 'DELETE' &&
          new RegExp(`^/accounts/${this.auth.accountId}/workers/domains/[a-zA-Z0-9_-]+$`).test(
            path,
          );
        if (domainDeletion && text === '') return { gone: false, result: null };
        try {
          const parsed = object(JSON.parse(text));
          if (parsed.success !== true || (!domainDeletion && !Object.hasOwn(parsed, 'result')))
            throw new Error();
          return {
            gone: false,
            result: Object.hasOwn(parsed, 'result') ? parsed.result : null,
            ...(parsed.result_info == null ? {} : { result_info: object(parsed.result_info) }),
            ...(Object.hasOwn(parsed, 'result_info') ? {} : { resultInfoAbsent: true }),
          };
        } catch {
          throw new CloudflareError(
            'provider_failure',
            method === 'GET' ? 1 : 6,
            false,
            'teardown',
          );
        }
      } catch (error) {
        const safe =
          error instanceof CloudflareError
            ? error
            : new CloudflareError('provider_failure', method === 'GET' ? 1 : 6, false, 'teardown');
        if (!safe.retryable || attempt === 4) throw safe;
        const header = response?.headers.get('retry-after');
        const retry =
          header && /^\d+$/.test(header)
            ? Number(header) * 1000
            : header
              ? Date.parse(header) - this.now()
              : 0;
        const delay = Math.max(1000 * 2 ** attempt, Number.isFinite(retry) ? retry : 0);
        if (this.now() + delay >= this.deadline)
          throw new CloudflareError('deadline_exceeded', 1, true);
        await (this.o.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(delay);
      } finally {
        clearTimeout(timer);
        controller.abort();
        void response?.body?.cancel().catch(() => undefined);
      }
    }
    throw new CloudflareError('provider_failure');
  }
  async list(
    path: string,
    field?: string,
    r2 = false,
    deniedMeansEmpty = false,
  ): Promise<Record<string, unknown>[]> {
    const conflict = (): never => {
      throw new CloudflareError('ownership_conflict', 8);
    };
    const empty = new Error();
    let first = true;
    try {
      return await paginatedList(
        path,
        async (page) => {
          const response = await this.request(
            page,
            'GET',
            undefined,
            r2,
            false,
            deniedMeansEmpty && first,
          );
          first = false;
          if (response.denied) {
            if (response.codes?.length === 1 && response.codes[0] === 10003) throw empty;
            throw new CloudflareError('permission_denied', 1, false, 'teardown', 403);
          }
          // A missing child collection is not evidence of an empty live parent.
          if (response.gone) return conflict();
          return response;
        },
        field,
        conflict,
        conflict,
      );
    } catch (error) {
      if (error === empty) return [];
      throw error;
    }
  }

  async snapshot(path: string): Promise<Record<string, unknown>[]> {
    const response = await this.request(path, 'GET');
    if (response.gone || !Array.isArray(response.result))
      throw new CloudflareError('ownership_conflict', 8);
    completeSnapshot(response.result_info, response.result.length);
    return response.result.map(object);
  }
  async configuration(
    path: string,
    field: string,
    emptyCode?: number,
  ): Promise<Record<string, unknown>[]> {
    const response = await this.request(path, 'GET', undefined, true, emptyCode !== undefined);
    // Cloudflare answers 404 with a dedicated code for an existing bucket without this configuration.
    if (
      emptyCode !== undefined &&
      response.gone &&
      response.codes?.length === 1 &&
      response.codes[0] === emptyCode
    )
      return [];
    if (response.gone) throw new CloudflareError('ownership_conflict', 8);
    const records = object(response.result)[field];
    if (!Array.isArray(records)) throw new CloudflareError('ownership_conflict', 8);
    completeSnapshot(response.result_info, records.length);
    return records.map(object);
  }
  jurisdiction = 'eu';
  drained = 0;
  async drain(path: string, readOnly = false): Promise<boolean> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 0; page < 10_000; page++) {
      // A 1024-byte key can occupy 6144 JSON bytes; leave room for object metadata.
      const response = await this.request(
        `${path}/objects?per_page=100${cursor === undefined ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
        'GET',
        undefined,
        true,
      );
      if (response.gone) {
        if ((await this.request(path, 'GET', undefined, true)).gone) return false;
        throw new CloudflareError('capability_unknown');
      }
      const info = response.result_info;
      // An empty bucket answers without result_info; only an empty listing is complete without it.
      if (
        !Array.isArray(response.result) ||
        (info === undefined
          ? !response.resultInfoAbsent || response.result.length > 0
          : typeof info.is_truncated !== 'boolean')
      )
        throw new CloudflareError('provider_failure');
      const keys = response.result.map((raw) => {
        const key = object(raw).key;
        if (typeof key !== 'string' || !key || Buffer.byteLength(key) > 1024)
          throw new CloudflareError('provider_failure');
        return key;
      });
      if (keys.length && !readOnly) {
        const deleted = await this.request(`${path}/objects`, 'DELETE', keys, true);
        if (deleted.gone || !Array.isArray(deleted.result))
          throw new CloudflareError('outcome_unknown', 6);
        const confirmed = new Set<string>();
        for (const entry of deleted.result) {
          if (
            !entry ||
            typeof entry !== 'object' ||
            Array.isArray(entry) ||
            typeof entry.key !== 'string'
          )
            throw new CloudflareError('outcome_unknown', 6);
          confirmed.add(entry.key);
        }
        if (keys.some((key) => !confirmed.has(key)))
          throw new CloudflareError('outcome_unknown', 6);
        this.drained += keys.length;
      }
      if (info === undefined || !info.is_truncated) return true;
      if (typeof info.cursor !== 'string' || !info.cursor || seen.has(info.cursor))
        throw new CloudflareError('provider_failure');
      seen.add(info.cursor);
      cursor = info.cursor;
    }
    throw new CloudflareError('provider_failure');
  }
}

interface Deletion {
  name: string;
  path: string;
  method?: 'PUT';
  body?: unknown;
  bucket?: boolean;
  crons?: string[];
  receipts?: Record<string, unknown>[];
}

function matchesReceipt(live: unknown, receipt: Record<string, unknown>): boolean {
  if (live === null || typeof live !== 'object' || Array.isArray(live)) return false;
  if (receipt.type === 'worker' && Object.hasOwn(receipt, 'consumer_id')) {
    const actual = normalizeQueueConsumer(live as Record<string, unknown>);
    const expected = normalizeQueueConsumer(receipt);
    return actual !== null && expected !== null && matchesReceipt(actual, { ...expected });
  }
  return Object.entries(receipt).every(([key, value]) => {
    const actual = (live as Record<string, unknown>)[key];
    return value !== null && typeof value === 'object'
      ? matchesReceipt(actual, value as Record<string, unknown>)
      : actual === value;
  });
}

function deletions(j: Inventory): { entries: Deletion[]; unresolved: boolean } {
  const base = `/accounts/${j.identity.account_id}`;
  const script = `${base}/workers/scripts/${j.identity.script_name}`;
  const entries: Deletion[] = [];
  let unresolved = j.operations.some(
    (op) => ['pending', 'unknown'].includes(op.state) && op.resolved_id === null,
  );
  const add = (entry: Deletion) => {
    const existing = entries.find((x) => x.path === entry.path);
    if (!existing) entries.push(entry);
    else {
      if (entry.crons) existing.crons = [...new Set([...(existing.crons ?? []), ...entry.crons])];
      if (entry.receipts) existing.receipts = [...(existing.receipts ?? []), ...entry.receipts];
    }
  };
  const attempts = [j.deployment?.attempt, j.deployment?.last_verified].filter(
    (x) => x !== null && x !== undefined,
  );
  const uploadedWorker = attempts.some((attempt) => attempt.version_id !== null);
  const knownWorker = uploadedWorker || Boolean(j.resources.worker?.id);
  if (!knownWorker && attempts.some((attempt) => attempt.phase !== 'preparing_upload'))
    throw new CloudflareError('outcome_unknown', 6);
  for (const attempt of attempts) {
    for (const settings of [attempt.intended_settings, attempt.prior_settings]) {
      const recorded = (kind: 'routes' | 'domain' | 'consumer' | 'schedules') =>
        settings === attempt.prior_settings ||
        attempt.changes.some((change) => change.kind === kind && change.restoration !== 'restored');
      for (const route of settings.routes) {
        if (route.script !== j.identity.script_name)
          throw new CloudflareError('ownership_conflict', 8);
        if (!route.id && !recorded('routes')) continue;
        if (route.id)
          add({
            name: 'route',
            path: `/zones/${route.zone_id}/workers/routes/${route.id}`,
            receipts: [{ id: route.id, pattern: route.pattern, script: route.script }],
          });
        else unresolved = true;
      }
      if (settings.domain && (settings.domain.id || recorded('domain'))) {
        if (settings.domain.service !== j.identity.script_name)
          throw new CloudflareError('ownership_conflict', 8);
        if (settings.domain.id)
          add({
            name: 'domain',
            path: `${base}/workers/domains/${settings.domain.id}`,
            receipts: [{ ...settings.domain }],
          });
        else unresolved = true;
      }
      if (settings.consumer && (settings.consumer.consumer_id || recorded('consumer'))) {
        if (settings.consumer.script_name !== j.identity.script_name)
          throw new CloudflareError('ownership_conflict', 8);
        if (settings.consumer.consumer_id && j.resources.jobs?.id) {
          const { consumer_id, script_name, dead_letter_queue, ...consumerSettings } =
            settings.consumer;
          add({
            name: 'consumer',
            path: `${base}/queues/${j.resources.jobs.id}/consumers/${settings.consumer.consumer_id}`,
            receipts: [
              {
                consumer_id,
                type: 'worker',
                script_name,
                dead_letter_queue,
                settings: consumerSettings,
              },
            ],
          });
        } else unresolved = true;
      }
      if (settings.schedules.length && recorded('schedules')) {
        if (knownWorker)
          add({
            name: 'schedules',
            path: `${script}/schedules`,
            method: 'PUT',
            body: [],
            crons: settings.schedules,
          });
        else unresolved = true;
      }
    }
  }
  // Deleting the inventoried script also removes its versions; never enumerate workers by prefix.
  for (const key of ['worker', 'jobs', 'dlq', 'd1', 'r2'] as ResourceKey[]) {
    if (key === 'worker' && uploadedWorker) {
      add({ name: key, path: script });
      continue;
    }
    const r = j.resources[key];
    if (!r) continue;
    const operations = j.operations.filter((op) => op.name === r.name);
    const ids = new Set(
      [r.id, ...operations.map((op) => op.resolved_id)].filter((id): id is string => id !== null),
    );
    if (!ids.size) {
      if (
        r.state !== 'planned' &&
        !(
          r.state === 'creating' &&
          operations.length > 0 &&
          operations.every((op) => op.state === 'failed')
        )
      )
        unresolved = true;
      continue;
    }
    for (const id of ids) {
      if (key === 'worker') add({ name: key, path: script });
      else if (key === 'r2') add({ name: key, path: `${base}/r2/buckets/${id}`, bucket: true });
      else if (key === 'd1')
        add({
          name: key,
          path: `${base}/d1/database/${id}?jurisdiction=${j.identity.jurisdiction}`,
        });
      else add({ name: key, path: `${base}/queues/${id}` });
    }
  }
  return { entries, unresolved };
}

function sorted(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([k, v]) => [k, sorted(v)]),
      )
    : value;
}

function liveId(value: unknown, pattern = /^[a-zA-Z0-9_-]+$/): string {
  if (typeof value !== 'string' || !pattern.test(value))
    throw new CloudflareError('ownership_conflict', 8);
  return value;
}

function completeSnapshot(info: Record<string, unknown> | undefined, length?: number): void {
  if (
    info &&
    ((info.total_pages !== undefined &&
      info.total_pages !== 1 &&
      !(info.total_pages === 0 && length === 0)) ||
      (info.cursor !== undefined && info.cursor !== '') ||
      (length !== undefined && info.total_count !== undefined && info.total_count !== length))
  )
    throw new CloudflareError('ownership_conflict', 8);
}

function recordedBinding(
  binding: Record<string, unknown>,
  j: Inventory,
  queueIdsByName: ReadonlyMap<string, string>,
): boolean {
  const resources = Object.values(j.resources);
  const attempts = [j.deployment?.attempt, j.deployment?.last_verified].filter(
    (attempt) => attempt !== null && attempt !== undefined,
  );
  if (binding.type === 'd1')
    return resources.some(
      (r) => r === j.resources.d1 && r.id !== null && r.id === d1BindingId(binding),
    );
  if (binding.type === 'r2_bucket')
    return Boolean(
      j.resources.r2?.id &&
      binding.bucket_name === j.resources.r2.name &&
      binding.jurisdiction === j.identity.jurisdiction,
    );
  if (binding.type === 'queue')
    return [j.resources.jobs, j.resources.dlq].some(
      (r) =>
        r?.id &&
        (binding.queue_id !== undefined || binding.queue_name !== undefined) &&
        (binding.queue_id === undefined || binding.queue_id === r.id) &&
        (binding.queue_name === undefined ||
          (binding.queue_name === r.name && queueIdsByName.get(r.name) === r.id)),
    );
  if (binding.type === 'analytics_engine')
    return Boolean(
      binding.dataset === j.resources.analytics?.name &&
      attempts.some((a) => a.version_id !== null) &&
      (j.resources.analytics?.state === 'binding_pending' ||
        (j.resources.analytics?.state === 'bound' &&
          j.resources.analytics.evidence?.source === 'worker_binding')),
    );
  if (binding.type === 'plain_text') {
    const text = binding.text;
    if (typeof binding.name === 'string' && hashedBindingNames.has(binding.name))
      return (
        typeof text === 'string' &&
        Boolean(
          j.deployment?.history?.hashed_bindings?.some(
            (b) => b.name === binding.name && b.sha256.includes(digest(text)),
          ),
        )
      );
    return (
      (binding.name === 'DEPLOYMENT_ID' && binding.text === j.identity.deployment_id) ||
      (binding.name === 'PB_PUBLIC_URL' && attempts.some((a) => binding.text === a.worker_url)) ||
      Boolean(
        j.deployment?.history?.plain_bindings.some(
          (b) =>
            b.name === binding.name &&
            typeof binding.text === 'string' &&
            b.texts.includes(binding.text),
        ),
      )
    );
  }
  if (binding.type === 'assets')
    return binding.name === 'ASSETS' && attempts.some((a) => a.assets_sha256 !== null);
  if (binding.type === 'secret_text')
    return (
      !Object.hasOwn(binding, 'text') &&
      !Object.hasOwn(binding, 'value') &&
      ((binding.name === 'PB_MASTER_KEY' && j.secret_delivery.master_key !== 'not_started') ||
        attempts.some((a) => a.secret_names.includes(String(binding.name))))
    );
  return false;
}

function checkWorkerOwner(settings: unknown, j: Inventory): void {
  const tags = object(settings).tags ?? [];
  const deployed =
    Boolean(j.deployment?.history?.version_ids.length) ||
    [j.deployment?.attempt, j.deployment?.last_verified].some((a) => a?.version_id != null);
  if (
    !Array.isArray(tags) ||
    (deployed &&
      (!tags.includes('pb-install-v1') || !tags.includes(`pb-owner-${j.identity.owner_digest}`))) ||
    tags.some(
      (tag) =>
        typeof tag !== 'string' ||
        (tag.startsWith('pb-owner-') && tag !== `pb-owner-${j.identity.owner_digest}`),
    )
  )
    throw new WorkerOwnershipError();
}

export class WorkerReferenceScan {
  private readonly removed = new Set<string>();
  private readonly accounts = new Map<string, Promise<Record<string, unknown>[]>>();
  private readonly bindings = new Map<string, Promise<unknown[]>>();

  async scripts(api: CleanupApi, base: string): Promise<Record<string, unknown>[]> {
    let result = this.accounts.get(base);
    if (!result) {
      result = api.snapshot(`${base}/workers/scripts`);
      this.accounts.set(base, result);
    }
    return (await result).filter(
      (worker) => !this.removed.has(`${base}/workers/scripts/${liveId(worker.id)}`),
    );
  }

  deleted(path: string): void {
    this.removed.add(path);
  }

  references(api: CleanupApi, path: string): Promise<unknown[]> {
    let result = this.bindings.get(path);
    if (!result) {
      result = this.readReferences(api, path);
      this.bindings.set(path, result);
    }
    return result;
  }

  private async readReferences(api: CleanupApi, path: string): Promise<unknown[]> {
    const bindings: unknown[] = [];
    const add = (raw: unknown) => {
      if (!Array.isArray(raw)) throw new CloudflareError('ownership_conflict', 8);
      bindings.push(...raw);
    };
    const settings = await api.request(`${path}/settings`, 'GET');
    if (settings.gone) throw new CloudflareError('ownership_conflict', 8);
    completeSnapshot(settings.result_info);
    add(object(settings.result).bindings);
    for (const version of await api.list(`${path}/versions`, 'items')) {
      const id = liveId(version.id);
      const detail = await api.request(`${path}/versions/${id}`, 'GET');
      if (detail.gone) throw new CloudflareError('ownership_conflict', 8);
      completeSnapshot(detail.result_info);
      add(object(object(detail.result).resources).bindings);
    }
    return bindings;
  }
}

async function preflight(
  api: CleanupApi,
  entries: Deletion[],
  j: Inventory,
  references: WorkerReferenceScan,
): Promise<Set<string>> {
  const absent = new Set<string>();
  const base = `/accounts/${j.identity.account_id}`;
  const primary = entries.filter((entry) =>
    ['worker', 'jobs', 'dlq', 'd1', 'r2'].includes(entry.name),
  );
  for (const entry of primary) {
    const path = entry.name === 'worker' ? `${entry.path}/settings` : entry.path;
    const live = await api.request(path, 'GET', undefined, entry.bucket);
    if (live.gone) absent.add(entry.path);
    else if (entry.name === 'worker') checkWorkerOwner(live.result, j);
  }
  const workers = new Set(
    primary
      .filter((entry) => entry.name === 'worker' && !absent.has(entry.path))
      .map((entry) => entry.path.split('/').at(-1)!),
  );
  const livePrimary = primary.filter((entry) => !absent.has(entry.path));
  const schedules = new Map<string, string[]>();
  for (const entry of entries) {
    if (entry.crons !== undefined) schedules.set(entry.path, entry.crons);
    if (entry.name === 'worker' && !schedules.has(`${entry.path}/schedules`))
      schedules.set(`${entry.path}/schedules`, []);
  }
  for (const [path, allowed] of schedules) {
    const live = await api.request(path, 'GET');
    if (live.gone) {
      absent.add(path);
      continue;
    }
    const crons = object(live.result).schedules;
    if (!Array.isArray(crons)) throw new CloudflareError('provider_failure');
    completeSnapshot(live.result_info, crons.length);
    if (crons.some((raw) => !allowed.includes(String(object(raw).cron))))
      throw new CloudflareError('ownership_conflict', 8);
  }
  for (const entry of entries.filter((entry) => ['route', 'domain'].includes(entry.name))) {
    const live = await api.request(entry.path, 'GET');
    if (live.gone) absent.add(entry.path);
    else {
      completeSnapshot(live.result_info);
      if (!entry.receipts?.some((receipt) => matchesReceipt(live.result, receipt)))
        throw new CloudflareError('ownership_conflict', 8);
    }
  }
  const queues = new Set(
    entries.filter((entry) => ['jobs', 'dlq'].includes(entry.name)).map((entry) => entry.path),
  );
  for (const entry of entries.filter((entry) => entry.name === 'consumer'))
    queues.add(entry.path.slice(0, entry.path.lastIndexOf('/consumers/')));
  for (const queue of queues) {
    const consumers = entries.filter((entry) => entry.path.startsWith(`${queue}/consumers/`));
    const records = absent.has(queue) ? [] : await api.snapshot(`${queue}/consumers`);
    if (
      records.some(
        (record) =>
          !consumers.some((entry) =>
            entry.receipts?.some((receipt) => matchesReceipt(record, receipt)),
          ),
      )
    )
      throw new CloudflareError('ownership_conflict', 8);
    for (const entry of consumers)
      if (!records.some((record) => entry.receipts?.some((r) => matchesReceipt(record, r))))
        absent.add(entry.path);
  }
  if (!livePrimary.length) return absent;

  const owns = (name: string, record: Record<string, unknown>, path?: string) =>
    entries.some(
      (entry) =>
        entry.name === name &&
        (path === undefined || entry.path === path) &&
        entry.receipts?.some((receipt) => matchesReceipt(record, receipt)),
    );
  if (workers.size) {
    for (const domain of await api.snapshot(`${base}/workers/domains`)) {
      liveId(domain.service);
      if (workers.has(String(domain.service)) && !owns('domain', domain))
        throw new CloudflareError('ownership_conflict', 8);
    }
    for (const zone of await api.list(`/zones?account.id=${j.identity.account_id}`)) {
      const zoneId = liveId(zone.id, /^[a-f0-9]{32}$/);
      for (const route of await api.snapshot(`/zones/${zoneId}/workers/routes`))
        if (
          workers.has(String(route.script)) &&
          !owns('route', route, `/zones/${zoneId}/workers/routes/${liveId(route.id)}`)
        )
          throw new CloudflareError('ownership_conflict', 8);
    }
  }

  const selectedQueues = new Map(
    livePrimary
      .filter((entry) => ['jobs', 'dlq'].includes(entry.name))
      .map((entry) => [
        entry.path.split('/').at(-1)!,
        j.resources[entry.name as 'jobs' | 'dlq']!.name,
      ]),
  );
  const queueIdsByName = new Map<string, string>();
  if (workers.size || selectedQueues.size) {
    for (const queue of await api.list(`${base}/queues`)) {
      const id = liveId(queue.queue_id, /^[a-f0-9]{32}$/);
      if (typeof queue.queue_name === 'string') {
        if (queueIdsByName.has(queue.queue_name))
          throw new CloudflareError('ownership_conflict', 8);
        queueIdsByName.set(queue.queue_name, id);
      }
      if (absent.has(`${base}/queues/${id}`)) throw new CloudflareError('ownership_conflict', 8);
      if (queues.has(`${base}/queues/${id}`)) continue;
      for (const consumer of await api.snapshot(`${base}/queues/${id}/consumers`)) {
        const script = queueConsumerScript(consumer);
        if (
          (consumer.type === 'worker' && script === null) ||
          workers.has(script ?? '') ||
          [...selectedQueues].some(([id, name]) =>
            [id, name].includes(String(consumer.dead_letter_queue)),
          )
        )
          throw new CloudflareError('ownership_conflict', 8);
      }
    }
  }

  const selectedBuckets = new Set(
    livePrimary.filter((entry) => entry.bucket).map((entry) => entry.path.split('/').at(-1)!),
  );
  if (selectedQueues.size || selectedBuckets.size) {
    const original = api.jurisdiction;
    try {
      for (const jurisdiction of ['default', 'eu', 'fedramp']) {
        api.jurisdiction = jurisdiction;
        const buckets = await api.list(
          `${base}/r2/buckets`,
          'buckets',
          true,
          // Accounts without FedRAMP answer 403/10003 to a FedRAMP-scoped bucket listing.
          jurisdiction === 'fedramp' && (j.identity.jurisdiction as string) !== 'fedramp',
        );
        const names = new Set(buckets.map((bucket) => liveId(bucket.name)));
        if (jurisdiction === j.identity.jurisdiction)
          for (const name of selectedBuckets) names.add(name);
        for (const name of names) {
          const notifications = await api.configuration(
            `${base}/event_notifications/r2/${name}/configuration`,
            'queues',
            11015,
          );
          for (const notification of notifications) {
            liveId(notification.queueId, /^[a-f0-9]{32}$/);
            if (!Array.isArray(notification.rules))
              throw new CloudflareError('ownership_conflict', 8);
            if (
              notification.rules.length &&
              ((jurisdiction === j.identity.jurisdiction && selectedBuckets.has(name)) ||
                selectedQueues.has(String(notification.queueId)))
            )
              throw new CloudflareError('ownership_conflict', 8);
          }
        }
      }
    } finally {
      api.jurisdiction = original;
    }
  }

  // Both current settings and inactive versions can retain references to backing resources.
  const scripts = new Set((await references.scripts(api, base)).map((w) => liveId(w.id)));
  for (const worker of workers) scripts.add(worker);
  const affectedBinding = (b: Record<string, unknown>) =>
    livePrimary.some((entry) => {
      const id = entry.path.split('/').at(-1)!.split('?')[0];
      return (
        (entry.name === 'd1' && b.type === 'd1' && d1BindingId(b) === id) ||
        (entry.bucket &&
          b.type === 'r2_bucket' &&
          b.bucket_name === id &&
          (!['default', 'eu', 'fedramp'].includes(String(b.jurisdiction)) ||
            b.jurisdiction === j.identity.jurisdiction)) ||
        (selectedQueues.has(id!) &&
          b.type === 'queue' &&
          (b.queue_id === id || b.queue_name === selectedQueues.get(id!))) ||
        (entry.name === 'worker' && b.type === 'service' && b.service === id)
      );
    });
  const checkBindings = (bindings: unknown, selected: boolean) => {
    if (!Array.isArray(bindings)) throw new CloudflareError('ownership_conflict', 8);
    for (const binding of bindings.map(object)) {
      if (binding.type === 'd1' && d1BindingId(binding) === null)
        throw new CloudflareError('ownership_conflict', 8);
      if (selected ? !recordedBinding(binding, j, queueIdsByName) : affectedBinding(binding))
        throw new CloudflareError('ownership_conflict', 8);
    }
  };
  const attempts = [j.deployment?.attempt, j.deployment?.last_verified].filter(
    (a) => a !== null && a !== undefined,
  );
  const versionIds = new Set<string | null>(j.deployment?.history?.version_ids ?? []);
  for (const id of attempts.flatMap((a) => [
    a.version_id,
    a.previous_version_id,
    ...a.previous_distribution.map((v) => v.version_id),
  ]))
    versionIds.add(id);
  for (const script of scripts) {
    const path = `${base}/workers/scripts/${script}`;
    const selected = workers.has(script);
    if (!selected) {
      checkBindings(await references.references(api, path), false);
      continue;
    }
    const settings = await api.request(`${path}/settings`, 'GET');
    if (settings.gone) throw new CloudflareError('ownership_conflict', 8);
    completeSnapshot(settings.result_info);
    if (selected) checkWorkerOwner(settings.result, j);
    checkBindings(object(settings.result).bindings, selected);
    for (const version of await api.list(`${path}/versions`, 'items')) {
      const id = liveId(version.id);
      if (selected && !versionIds.has(id)) throw new CloudflareError('ownership_conflict', 8);
      const detail = await api.request(`${path}/versions/${id}`, 'GET');
      if (detail.gone) throw new CloudflareError('ownership_conflict', 8);
      completeSnapshot(detail.result_info);
      checkBindings(object(object(detail.result).resources).bindings, selected);
    }
    if (selected) {
      for (const secret of await api.snapshot(`${path}/secrets`))
        if (!recordedBinding(secret, j, queueIdsByName))
          throw new CloudflareError('ownership_conflict', 8);
      const endpoint = await api.request(`${path}/subdomain`, 'GET');
      completeSnapshot(endpoint.result_info);
      const candidate = j.deployment?.attempt;
      const previewPolicies =
        candidate?.version_id &&
        candidate.requested_rollout < 100 &&
        candidate.preview !== 'disabled'
          ? [{ ...candidate.intended_settings.endpoints, previews_enabled: true }]
          : [];
      if (
        endpoint.gone ||
        ![
          ...attempts.flatMap((a) => [a.prior_settings.endpoints, a.intended_settings.endpoints]),
          ...previewPolicies,
          { enabled: false, previews_enabled: false },
        ].some((receipt) => matchesReceipt(endpoint.result, { ...receipt }))
      )
        throw new CloudflareError('ownership_conflict', 8);
    }
  }
  const r2 = j.resources.r2;
  const implicitBaseline =
    r2?.lifecycle_baseline === undefined &&
    !!r2?.evidence &&
    ['created', 'pending_create'].includes(r2.evidence.source);
  for (const entry of livePrimary.filter((entry) => entry.bucket)) {
    for (const [suffix, field] of [
      ['domains/custom', 'domains'],
      ['cors', 'rules'],
      ['lifecycle', 'rules'],
      ['lock', 'rules'],
    ] as const) {
      const rules = await api.configuration(
        `${entry.path}/${suffix}`,
        field,
        suffix === 'cors' ? 10059 : undefined,
      );
      const lifecycle = suffix === 'lifecycle';
      const remaining = (
        lifecycle
          ? (r2?.lifecycle_baseline ?? (implicitBaseline ? [PROVIDER_DEFAULT_LIFECYCLE_RULE] : []))
          : []
      ).map((expected) => JSON.stringify(sorted(expected)));
      if (lifecycle && implicitBaseline && rules.length !== 1)
        throw new CloudflareError('ownership_conflict', 8);
      for (const rule of rules) {
        const index = remaining.indexOf(
          JSON.stringify(sorted(lifecycleRule(rule) ? abortOnlyRule(rule) : rule)),
        );
        if (index < 0) throw new CloudflareError('ownership_conflict', 8);
        remaining.splice(index, 1);
      }
    }
    for (const suffix of ['domains/managed', 'sippy']) {
      const config = await api.request(`${entry.path}/${suffix}`, 'GET', undefined, true);
      completeSnapshot(config.result_info);
      if (config.gone || object(config.result).enabled !== false)
        throw new CloudflareError('ownership_conflict', 8);
    }
    if (!(await api.drain(entry.path, true))) absent.add(entry.path);
  }
  return absent;
}

export async function teardown(
  o: TeardownOptions,
  references = new WorkerReferenceScan(),
): Promise<CommandResult> {
  const output = commandEnvelope('teardown', o.dryRun);
  let release: (() => Promise<void>) | undefined;
  let result: CommandResult;
  try {
    const { auth, store } = await cleanupInventory(o);
    if (!o.dryRun) release = await store.lock((o.now ?? Date.now)());
    const journal = await store.read();
    if (!journal) throw new CloudflareError('invalid_inventory', 2);
    if (
      o.repositoryId !== undefined &&
      !expiredRun(journal, o.repositoryId, (o.now ?? Date.now)())
    ) {
      output.checks.push({ name: 'inventory', status: 'skipped' });
    } else {
      if (
        journal.identity.run_identity === null &&
        (!o.iUnderstandThisDeletes || o.inventoryId !== journal.identity.owner_digest)
      )
        throw new CloudflareError('invalid_input', 2);
      if (o.inventoryId !== undefined && o.inventoryId !== journal.identity.owner_digest)
        throw new CloudflareError('invalid_input', 2);
      if (
        !o.iUnderstandThisDeletes &&
        [journal.resources.d1, journal.resources.r2].some(
          (resource) => resource?.evidence?.source === 'adopted',
        )
      )
        throw new CloudflareError('invalid_input', 2);
      const plan = deletions(journal);
      const order = (entry: Deletion) =>
        ['schedules', 'consumer', 'route', 'domain'].includes(entry.name)
          ? 0
          : entry.name === 'worker'
            ? 1
            : entry.bucket
              ? 2
              : 3;
      plan.entries.sort((a, b) => order(a) - order(b));
      output.plan = plan.entries.map((entry) => ({
        stage: 'teardown',
        action: entry.bucket ? 'drain_then_delete' : 'delete',
        kind: entry.name,
      }));
      const api = new CleanupApi(o, auth);
      api.jurisdiction = journal.identity.jurisdiction;
      const absent = o.dryRun
        ? new Set<string>()
        : await preflight(api, plan.entries, journal, references);
      for (const entry of plan.entries) {
        if (o.dryRun) continue;
        if (absent.has(entry.path)) {
          if (entry.name === 'worker') references.deleted(entry.path);
          output.checks.push({ name: entry.name, status: 'already_gone' });
          continue;
        }
        let gone = false;
        if (entry.bucket) {
          let finished = false;
          for (let attempt = 0; attempt < 4; attempt++) {
            if (!(await api.drain(entry.path))) {
              gone = true;
              finished = true;
              break;
            }
            try {
              gone = (await api.request(entry.path, 'DELETE', undefined, true)).gone;
              finished = true;
              break;
            } catch (error) {
              if (!(error instanceof CloudflareError) || error.status !== 409) throw error;
              if (attempt === 3) {
                if (api.drained === 0) throw new MultipartCleanupError();
                throw error;
              }
            }
          }
          if (!finished) throw new CloudflareError('provider_failure');
        } else gone = (await api.request(entry.path, entry.method ?? 'DELETE', entry.body)).gone;
        if (entry.name === 'worker') references.deleted(entry.path);
        output.checks.push({ name: entry.name, status: gone ? 'already_gone' : 'deleted' });
      }
      if (plan.unresolved) throw new CloudflareError('outcome_unknown', 6);
    }
    output.status = o.dryRun ? 'planned' : 'ok';
    result = { exitCode: 0, output };
  } catch (error) {
    result = failCommand(output, cleanupFailure(error, 'teardown'));
  }
  try {
    await release?.();
  } catch (error) {
    if (result.exitCode === 0) result = failCommand(output, cleanupFailure(error, 'teardown'));
  }
  return result;
}

export async function runCloudflareTeardown(o: TeardownOptions): Promise<number> {
  const result = await teardown(o);
  if (o.json || !result.output.error) console.log(JSON.stringify(result.output));
  else console.error(`${result.output.error.code}: ${result.output.error.message}`);
  return result.exitCode;
}
