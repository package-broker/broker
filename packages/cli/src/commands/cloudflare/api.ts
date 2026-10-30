import type { BuildInfo } from '../../build-artifacts.js';

export type ErrorCode =
  | 'prebuilt_invalid'
  | 'prebuilt_dirty'
  | 'prebuilt_git_sha_mismatch'
  | 'prebuilt_lockfile_mismatch'
  | 'prebuilt_dependencies_refused'
  | 'prebuilt_io_failure'
  | 'prebuilt_unavailable'
  | 'prebuilt_version_mismatch'
  | 'prebuilt_unverifiable'
  | 'checksum_mismatch'
  | 'migrations_pending'
  | 'invalid_input'
  | 'unsafe_path'
  | 'invalid_inventory'
  | 'state_io_failure'
  | 'install_locked'
  | 'confirmation_required'
  | 'confirmation_declined'
  | 'plan_changed'
  | 'deadline_exceeded'
  | 'ownership_conflict'
  | 'jurisdiction_conflict'
  | 'configuration_conflict'
  | 'outcome_unknown'
  | 'provider_failure'
  | 'permission_denied'
  | 'capacity_exceeded'
  | 'capability_unknown'
  | 'domain_zone_not_found'
  | 'domain_zone_ambiguous'
  | 'domain_zone_not_supported'
  | 'queues_unavailable'
  | 'workers_paid_required'
  | 'workers_dev_subdomain_missing'
  | 'r2_unavailable'
  | 'analytics_engine_unavailable'
  | 'migration_failed'
  | 'smoke_failed'
  | 'rollback_blocked_contract'
  | 'rollback_unavailable_first_deploy'
  | 'rollback_failed'
  | 'organization_slug_mismatch'
  | 'organization_not_found'
  | 'key_recovery_required'
  | 'token_refresh_required'
  | 'provider_anchor_changed';

const GUIDANCE =
  'Workers Paid with Queues is the supported target. Enable the required service, verify token permissions, then rerun pb cloudflare setup. Resources were not created. For a different deployment target, use the documented single-replica Node installation.';
const MESSAGES: Record<ErrorCode, string> = {
  prebuilt_invalid: 'Prebuilt metadata is invalid; reinstall trusted packages.',
  prebuilt_dirty: 'Prebuilt build provenance is dirty or unknown; reinstall trusted packages.',
  prebuilt_git_sha_mismatch:
    'Prebuilt git SHA does not match its build provenance; reinstall trusted packages.',
  prebuilt_lockfile_mismatch:
    'Prebuilt lockfile digest does not match its build provenance; reinstall trusted packages.',
  prebuilt_dependencies_refused:
    'Prebuilt packages must not declare dependencies or install hooks; reinstall trusted packages.',
  prebuilt_io_failure: 'Local prebuilt I/O failed; check permissions and free space, then rerun.',
  prebuilt_unavailable:
    'Prebuilt package is unavailable; install @package-broker/dist-cloudflare@<cli version> or run without --prebuilt.',
  prebuilt_version_mismatch: 'Prebuilt package version must equal the CLI version.',
  prebuilt_unverifiable: 'The CLI has no expected prebuilt record; use a published CLI package.',
  checksum_mismatch: 'Prebuilt checksum verification failed; reinstall trusted packages.',
  migrations_pending:
    'Prebuilt migrations are pending; run pb cloudflare migrate --prebuilt --worker-name <worker name> before deploying.',
  invalid_input:
    'Invalid input or incomplete Cloudflare build; build the selected configuration first.',
  unsafe_path: 'State must be ignored, contained, regular and separate from build output.',
  invalid_inventory: 'Inventory identity or journal is invalid; restore trusted private state.',
  state_io_failure:
    'Local inventory or lock I/O failed; check permissions and free space of .pb/state/cloudflare and keep the journal. Rerunning reads provider state before any further create.',
  install_locked:
    'Install lock exists. Stop all writers, read the lock file in .pb/state/cloudflare for its host, pid and started_at, and only if that process is gone remove that one file by hand, then rerun.',
  confirmation_required: 'Review the create plan and supply --yes for noninteractive creates.',
  confirmation_declined: 'Creation declined; literal yes is required.',
  plan_changed: 'The acknowledged plan changed; inspect provider state and rerun.',
  deadline_exceeded:
    'The time budget for safe creates is exhausted; no further create was sent. Rerun to continue.',
  ownership_conflict:
    'Exact ownership is unresolved; inspect resources and explicitly adopt the exact ID if appropriate. Nothing is deleted.',
  jurisdiction_conflict:
    'Actual jurisdiction is unknown or differs; choose another name or plan a separate migration.',
  configuration_conflict:
    'Existing resource configuration differs; inspect and resolve it explicitly.',
  outcome_unknown:
    'The create outcome is unknown. Retain private inventory, reconcile or explicitly adopt the exact ID; for a provision create whose resource is authoritatively absent, rerun provision with --abandon-intent <operation id> from the pending_intent check. Do not blindly repeat creation.',
  provider_failure: 'Provider request failed; no raw provider diagnostic is displayed.',
  permission_denied: GUIDANCE,
  capacity_exceeded: GUIDANCE,
  capability_unknown: `Required capability is unresolved. ${GUIDANCE}`,
  domain_zone_not_found:
    'No active zone in this account serves the hostname, or the token lacks Zone Read on it. Grant Zone Read, Workers Routes Edit and DNS Edit on that zone.',
  domain_zone_ambiguous:
    'Several zones match the hostname; remove the duplicate zone before retrying.',
  domain_zone_not_supported: 'This provider contract does not support hostname-to-zone lookup.',
  queues_unavailable: GUIDANCE,
  workers_paid_required: GUIDANCE,
  workers_dev_subdomain_missing:
    'Register a workers.dev subdomain manually in the Cloudflare dashboard, then rerun. No registration was attempted.',
  r2_unavailable: `Enable R2 manually, then rerun. ${GUIDANCE}`,
  analytics_engine_unavailable: GUIDANCE,
  migration_failed: 'Migration failed; inspect the migration state before continuing.',
  smoke_failed: 'Smoke assertions failed; inspect the named checks and rollback result.',
  rollback_blocked_contract:
    'A contract migration boundary blocks code rollback; restore or forward repair is required.',
  rollback_unavailable_first_deploy:
    'Smoke failed on the first deployment; retain the candidate and resources for forward repair.',
  rollback_failed: 'Rollback activation, configuration or readiness could not be verified.',
  organization_slug_mismatch: 'The existing organization has a different slug.',
  organization_not_found: 'Organization not found; bootstrap the organization first.',
  key_recovery_required:
    'Key delivery or installation is uncertain. Supply the saved --key-file or --master-key-env; setup will not generate another key.',
  token_refresh_required:
    'Token issuance is uncertain. Use the saved token or explicitly request --refresh-setup-token with safe delivery.',
  provider_anchor_changed:
    'A provider definition changes a bound trust anchor; run pb admin rebind-provider first.',
};

export class CloudflareError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly exitCode = 1,
    readonly retryable = false,
    readonly stage = 'provision',
    readonly status: number | null = null,
    readonly check: 'queues' | 'r2' | 'analytics_engine' | 'provider_contract' | null = code ===
    'capability_unknown'
      ? 'provider_contract'
      : null,
    readonly providerCode: number | null = null,
    readonly source: string | null = null,
    readonly fields: readonly string[] = [],
  ) {
    super(MESSAGES[code]);
    this.name = 'CloudflareError';
  }
}

export class GitWorktreeRequiredError extends CloudflareError {
  constructor() {
    super('unsafe_path', 2);
    this.message =
      'State must live in a git work tree that ignores it; run from the project checkout or initialise one.';
  }
}

export interface PlanEntry {
  stage: string;
  action: string;
  kind?: string;
  name?: string;
  jurisdiction?: 'eu' | 'default';
}

export function commandEnvelope(command: string, dryRun = false) {
  const output = {
    schema_version: 1 as const,
    command,
    status: 'ok' as 'ok' | 'planned' | 'error',
    dry_run: dryRun,
    worker_url: null as string | null,
    version_id: null as string | null,
    previous_version_id: null as string | null,
    database_id: null as string | null,
    kv_namespace_id: null,
    r2_bucket: null as string | null,
    queue_names: [] as string[],
    migrations_applied: [] as string[],
    build_info: null as BuildInfo | null,
    artifact_sha256: null as string | null,
    pending_migrations: [] as string[],
    remote_state: null as 'absent' | 'present' | null,
    plan: [] as PlanEntry[],
    checks: [] as CommandCheck[],
    rollback: { status: 'not_needed' as string, target_version_id: null as string | null },
    bootstrap_url: null as string | null,
    login_url: null as string | null,
    error: null as { code: ErrorCode; message: string; retryable: boolean; stage: string } | null,
  };
  return output as typeof output & {
    prebuilt?: { package: string; version: string; gitSha: string; artifact_sha256: string };
  };
}
export type CommandEnvelope = ReturnType<typeof commandEnvelope>;
export interface CommandCheck {
  name: string;
  status: string;
  enabled?: boolean;
  previews_enabled?: boolean;
  attempt?: number;
  elapsed_ms?: number;
  source?: string;
}
export interface CommandResult {
  exitCode: number;
  output: CommandEnvelope;
}

export function failCommand(output: CommandEnvelope, error: unknown): CommandResult {
  const safe = error instanceof CloudflareError ? error : new CloudflareError('provider_failure');
  output.status = 'error';
  if (safe.check !== null)
    output.checks.push({
      name: safe.check,
      status: safe.code,
      ...(safe.source === null ? {} : { source: safe.source }),
    });
  for (const name of safe.fields) output.checks.push({ name, status: safe.code });
  output.error = {
    code: safe.code,
    message: safe.message,
    retryable: safe.retryable,
    stage: safe.stage,
  };
  return { exitCode: safe.exitCode, output };
}

export interface ApiOptions {
  accountId: string;
  apiToken: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  jitter?: () => number;
  deadline?: number;
  /** A caller-owned absolute recovery bound, independent of an exhausted probe budget. */
  recoveryDeadline?: () => number;
  /** Recovery mutations can use the remaining bounded budget after durable intent is saved. */
  minimumMutationBudgetMs?: number;
}
export type ApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH';
export interface ApiResponse {
  result: unknown;
  result_info?: Record<string, unknown>;
}
function snapshotItems(response: ApiResponse): Record<string, unknown>[] {
  const { result, result_info: info } = response;
  if (!Array.isArray(result)) throw new CloudflareError('provider_failure');
  if (
    info &&
    ((info.total_pages !== undefined &&
      info.total_pages !== 1 &&
      !(info.total_pages === 0 && result.length === 0)) ||
      (info.cursor !== undefined && info.cursor !== '') ||
      (info.total_count !== undefined && info.total_count !== result.length) ||
      (info.page !== undefined && info.page !== 1) ||
      (info.count !== undefined && info.count !== result.length))
  )
    throw new CloudflareError('capability_unknown');
  return result.map(object);
}
export function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new CloudflareError('provider_failure');
  return value as Record<string, unknown>;
}

export function cloudflareCredentials(env: Readonly<Record<string, string | undefined>>) {
  const apiToken = env.CLOUDFLARE_API_TOKEN;
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  if (
    !apiToken ||
    !/^[\x21-\x7e]+$/.test(apiToken) ||
    !accountId ||
    !/^[a-f0-9]{32}$/.test(accountId)
  ) {
    throw new CloudflareError('invalid_input', 2);
  }
  return { accountId, apiToken };
}

// Endpoint families are provisional until T830 verifies the provider wire contract.
// This client never infers capabilities from provider prose or retries a mutation.
const BUDGET_MS = 600_000;
const REQUEST_TIMEOUT_MS = 35_000;
const RECONCILIATION_MS = 15_000;
export const CREATE_SETTLE_MS = REQUEST_TIMEOUT_MS + RECONCILIATION_MS;
const RECOVERY_READS_MS = 60_000;
const RECOVERY_STEP_MS = CREATE_SETTLE_MS + 20_000;
const UNSENT = new WeakSet<CloudflareError>();
/** True only when the client refused a mutation locally, before any byte reached the transport. */
export function wasNotSent(error: unknown): boolean {
  return error instanceof CloudflareError && UNSENT.has(error);
}
interface Scheduler {
  next: number;
  tail: Promise<unknown>;
}
const schedulers = new WeakMap<typeof fetch, Map<string, Scheduler>>();
export class CloudflareApi {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  private budgetEnd: number;
  private readonly fixedDeadline: boolean;
  private readonly scheduler: Scheduler;
  constructor(private readonly options: ApiOptions) {
    cloudflareCredentials({
      CLOUDFLARE_API_TOKEN: options.apiToken,
      CLOUDFLARE_ACCOUNT_ID: options.accountId,
    });
    const transport = options.fetch ?? fetch;
    let accounts = schedulers.get(transport);
    if (!accounts) {
      accounts = new Map();
      schedulers.set(transport, accounts);
    }
    let scheduler = accounts.get(options.accountId);
    if (!scheduler) {
      scheduler = { next: 0, tail: Promise.resolve() };
      accounts.set(options.accountId, scheduler);
    }
    this.scheduler = scheduler;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.fixedDeadline = options.deadline !== undefined;
    this.budgetEnd = options.deadline ?? this.now() + BUDGET_MS;
  }
  get deadline(): number {
    return this.budgetEnd;
  }
  get accountId(): string {
    return this.options.accountId;
  }
  restartDeadline(budgetMs = BUDGET_MS): void {
    if (!this.fixedDeadline) this.budgetEnd = this.now() + budgetMs;
  }
  /** Each recovery mutation keeps its full settle reserve plus its own read-back allowance. */
  reserveRecovery(mutations: number): void {
    if (this.options.recoveryDeadline) {
      this.budgetEnd = this.options.recoveryDeadline();
      return;
    }
    if (!this.fixedDeadline)
      this.budgetEnd = Math.max(
        this.budgetEnd,
        this.now() + RECOVERY_READS_MS + mutations * RECOVERY_STEP_MS,
      );
  }
  assertCreateBudget(): void {
    if (this.deadline - this.now() < (this.options.minimumMutationBudgetMs ?? CREATE_SETTLE_MS))
      throw new CloudflareError('deadline_exceeded', 1, true);
  }
  async pause(ms: number): Promise<void> {
    if (this.now() + ms >= this.deadline) throw new CloudflareError('provider_failure', 1, true);
    if (ms > 0) await this.sleep(ms);
    if (this.now() >= this.deadline) throw new CloudflareError('provider_failure', 1, true);
  }
  request(
    path: string,
    method: ApiMethod = 'GET',
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<ApiResponse> {
    return this.enqueue(path, method, body, undefined, undefined, headers);
  }
  async analyticsEngineTables(): Promise<void> {
    const { result } = await this.request('/analytics_engine/sql', 'POST', 'SHOW TABLES');
    const tables = object(result);
    if (
      !Array.isArray(tables.meta) ||
      tables.meta.length !== 1 ||
      object(tables.meta[0]).name !== 'dataset' ||
      object(tables.meta[0]).type !== 'String' ||
      !Array.isArray(tables.data) ||
      !Number.isSafeInteger(tables.rows) ||
      tables.rows !== tables.data.length ||
      !tables.data.every((row: unknown) => typeof object(row).dataset === 'string')
    )
      throw new CloudflareError('provider_failure');
  }
  requestZone(
    zone: string,
    path: string,
    method: ApiMethod = 'GET',
    body?: unknown,
  ): Promise<ApiResponse> {
    if (!/^[a-f0-9]{32}$/.test(zone)) throw new CloudflareError('invalid_input', 2);
    return this.enqueue(path, method, body, `/zones/${zone}`);
  }
  async listZones(name: string): Promise<Record<string, unknown>[]> {
    return paginatedList(
      `/zones?name=${encodeURIComponent(name)}`,
      (path) => this.enqueue(path, 'GET', undefined, ''),
      undefined,
      () => {
        throw new CloudflareError('provider_failure', 1, false, 'deploy');
      },
      () => {
        throw new CloudflareError('provider_failure', 1, false, 'deploy');
      },
      50,
    );
  }
  uploadAssets(body: FormData, sessionToken: string): Promise<ApiResponse> {
    if (!/^[A-Za-z0-9_.-]+$/.test(sessionToken)) throw new CloudflareError('provider_failure');
    return this.enqueue(
      '/workers/assets/upload?base64=true',
      'POST',
      body,
      undefined,
      sessionToken,
    );
  }
  private enqueue(
    path: string,
    method: ApiMethod,
    body?: unknown,
    prefix?: string,
    token?: string,
    headers?: Record<string, string>,
  ): Promise<ApiResponse> {
    const task = this.scheduler.tail.then(() =>
      this.send(path, method, body, prefix, token, headers),
    );
    this.scheduler.tail = task.catch(() => undefined);
    return task;
  }
  private async send(
    path: string,
    method: ApiMethod,
    body?: unknown,
    prefix?: string,
    token?: string,
    extraHeaders?: Record<string, string>,
  ): Promise<ApiResponse> {
    if (
      !['GET', 'POST', 'PUT', 'PATCH'].includes(method) ||
      !/^\/[a-zA-Z0-9_/?=&%.-]+$/.test(path) ||
      path.includes('..') ||
      path.startsWith('//')
    )
      throw new CloudflareError('invalid_input', 2);
    // SQL is a read-only POST with a plain-text request and a non-v4 JSON response.
    const analyticsQuery =
      path === '/analytics_engine/sql' && method === 'POST' && body === 'SHOW TABLES';
    for (let attempt = 0; attempt < (method === 'GET' ? 5 : 1); attempt++) {
      try {
        await this.pause(Math.max(0, this.scheduler.next - this.now()));
        if (method !== 'GET' && !analyticsQuery) this.assertCreateBudget();
      } catch (error) {
        if (method !== 'GET' && error instanceof CloudflareError) UNSENT.add(error);
        throw error;
      }
      this.scheduler.next = this.now() + 1000;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(REQUEST_TIMEOUT_MS, Math.max(1, this.deadline - this.now())),
      );
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error()), { once: true }),
      );
      let response: Response | undefined;
      let responseFailure: CloudflareError | undefined;
      let errorTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        response = await Promise.race([
          (this.options.fetch ?? fetch)(
            `https://api.cloudflare.com/client/v4${prefix ?? `/accounts/${this.options.accountId}`}${path}`,
            {
              method,
              redirect: 'manual',
              signal: controller.signal,
              headers: {
                ...extraHeaders,
                authorization: `Bearer ${token ?? this.options.apiToken}`,
                ...(body instanceof FormData
                  ? {}
                  : { 'content-type': analyticsQuery ? 'text/plain' : 'application/json' }),
              },
              ...(body === undefined
                ? {}
                : {
                    body:
                      body instanceof FormData || analyticsQuery
                        ? (body as string | FormData)
                        : JSON.stringify(body),
                  }),
            },
          ),
          aborted,
        ]);
        if (response.status === 403 || response.status === 401) {
          controller.abort();
          void response.body?.cancel().catch(() => undefined);
          throw new CloudflareError('permission_denied', 1, false, 'provision', response.status);
        }
        const transient = [408, 429, 500, 502, 503, 504].includes(response.status);
        if (!response.ok)
          responseFailure = new CloudflareError(
            'provider_failure',
            1,
            transient,
            'provision',
            response.status,
          );
        if (responseFailure) {
          // Read only the numeric codes needed for plan rejection and confirmed Worker absence.
          if (
            method !== 'GET' ||
            !(
              /^\/queues(?:\?|$)/.test(path) ||
              (response.status === 404 && /^\/workers\/scripts\/[^/]+\/settings$/.test(path))
            ) ||
            !response.headers.get('content-type')?.includes('application/json')
          ) {
            controller.abort();
            void response.body?.cancel().catch(() => undefined);
            throw responseFailure;
          }
          errorTimer = setTimeout(() => controller.abort(), 1000);
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done) break;
            size += value.byteLength;
            if (size > 1_048_576) {
              void reader.cancel().catch(() => undefined);
              throw new Error();
            }
            chunks.push(value);
          }
        } finally {
          void reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        const parsed = object(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        if (!response.ok || parsed.success === false) {
          const planRejected =
            method === 'GET' &&
            /^\/queues(?:\?|$)/.test(path) &&
            Array.isArray(parsed.errors) &&
            parsed.errors.some(
              (entry: unknown) =>
                entry !== null &&
                typeof entry === 'object' &&
                !Array.isArray(entry) &&
                (entry as Record<string, unknown>).code === 10253,
            );
          if (planRejected)
            throw new CloudflareError(
              'provider_failure',
              1,
              false,
              'provision',
              response.status,
              null,
              10253,
            );
          if (
            method === 'GET' &&
            response.status === 404 &&
            /^\/workers\/scripts\/[^/]+\/settings$/.test(path) &&
            Array.isArray(parsed.errors) &&
            parsed.errors.some(
              (entry: unknown) =>
                entry !== null &&
                typeof entry === 'object' &&
                !Array.isArray(entry) &&
                (entry as Record<string, unknown>).code === 10007,
            )
          )
            throw new CloudflareError('provider_failure', 1, false, 'provision', 404, null, 10007);
          if (responseFailure) throw responseFailure;
          throw new Error();
        }
        if (analyticsQuery) {
          if (response.status !== 200) throw new Error();
          return { result: parsed };
        }
        if (parsed.success !== true || !Object.hasOwn(parsed, 'result')) throw new Error();
        return {
          result: parsed.result,
          ...(parsed.result_info == null ? {} : { result_info: object(parsed.result_info) }),
        };
      } catch (error) {
        const safe =
          responseFailure &&
          !(error instanceof CloudflareError && [10253, 10007].includes(error.providerCode ?? 0))
            ? responseFailure
            : error instanceof CloudflareError
              ? error
              : new CloudflareError('provider_failure', 1, true);
        const header = response?.headers.get('retry-after');
        if (safe.retryable && header) {
          const requested = /^\d+$/.test(header)
            ? Number(header) * 1000
            : Date.parse(header) - this.now();
          if (Number.isFinite(requested) && requested >= 0)
            this.scheduler.next = Math.max(this.scheduler.next, this.now() + requested);
        }
        if (method !== 'GET') throw safe;
        if (!safe.retryable || attempt === 4) throw safe;
        const delay = Math.max(
          this.scheduler.next - this.now(),
          1000 * 2 ** attempt +
            Math.min(250, Math.max(0, this.options.jitter?.() ?? Math.random() * 250)),
        );
        await this.pause(delay);
      } finally {
        clearTimeout(errorTimer);
        clearTimeout(timer);
      }
    }
    throw new CloudflareError('provider_failure', 1, true);
  }
  /** A collection whose documented response is one array without pagination metadata. */
  async snapshot(path: string): Promise<Record<string, unknown>[]> {
    return snapshotItems(await this.request(path));
  }
  async snapshotZone(zone: string, path: string): Promise<Record<string, unknown>[]> {
    return snapshotItems(await this.requestZone(zone, path));
  }
  async list(
    path: string,
    field?: string,
    headers?: Record<string, string>,
  ): Promise<Record<string, unknown>[]> {
    return paginatedList(path, (page) => this.request(page, 'GET', undefined, headers), field);
  }
}

export async function paginatedList(
  path: string,
  read: (path: string) => Promise<ApiResponse>,
  field?: string,
  unknown: () => never = () => {
    throw new CloudflareError('capability_unknown');
  },
  malformed: () => never = () => {
    throw new CloudflareError('provider_failure');
  },
  perPage = 100,
): Promise<Record<string, unknown>[]> {
  const all: Record<string, unknown>[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  let totalCount: number | undefined;
  let totalPages: number | undefined;
  for (let page = 1; page <= 10_000; page++) {
    const separator = path.includes('?') ? '&' : '?';
    const response = await read(
      `${path}${separator}${cursor === undefined ? `page=${page}&per_page=${perPage}` : `cursor=${encodeURIComponent(cursor)}`}`,
    );
    const result = field === undefined ? response.result : object(response.result)[field];
    if (!Array.isArray(result)) return malformed();
    all.push(...result.map(object));
    const info = response.result_info;
    const next = info?.cursor;
    const pages = info?.total_pages;
    const count = info?.total_count;
    for (const value of [pages, count, info?.count, info?.page])
      if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) unknown();
    if (
      (next !== undefined && typeof next !== 'string') ||
      (info?.page !== undefined && cursor === undefined && info.page !== page) ||
      (info?.count !== undefined && info.count !== result.length) ||
      (totalCount !== undefined && count !== undefined && totalCount !== count) ||
      (totalPages !== undefined && pages !== undefined && totalPages !== pages)
    )
      unknown();
    if (typeof count === 'number') totalCount = count;
    if (typeof pages === 'number') totalPages = pages;
    if (
      (totalCount !== undefined && all.length > totalCount) ||
      (pages === 0 && (all.length !== 0 || (next !== undefined && next !== '')))
    )
      unknown();
    const complete = () => {
      if (totalCount !== undefined && totalCount !== all.length) unknown();
      return all;
    };
    if (typeof next === 'string' && next !== '') {
      if (seen.has(next)) return malformed();
      seen.add(next);
      cursor = next;
      continue;
    }
    if (typeof pages === 'number' && Number.isSafeInteger(pages) && pages >= page) {
      if (pages === page) return complete();
      continue;
    }
    if (info?.total_count === all.length || next === '' || (pages === 0 && result.length === 0))
      return complete();
    if (
      totalPages === undefined &&
      cursor === undefined &&
      next === undefined &&
      typeof count === 'number' &&
      count > all.length &&
      info?.page === page &&
      info.count === result.length &&
      result.length > 0 &&
      Number.isSafeInteger(info.per_page) &&
      Number(info.per_page) >= result.length
    )
      continue;
    // Absence requires explicit pagination completion, never a short-page guess.
    unknown();
  }
  return malformed();
}
