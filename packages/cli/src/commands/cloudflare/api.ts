import type { BuildInfo } from '../../build-artifacts.js';

export type ErrorCode =
  | 'invalid_input'
  | 'unsafe_path'
  | 'invalid_inventory'
  | 'install_locked'
  | 'confirmation_required'
  | 'confirmation_declined'
  | 'plan_changed'
  | 'ownership_conflict'
  | 'jurisdiction_conflict'
  | 'configuration_conflict'
  | 'outcome_unknown'
  | 'provider_failure'
  | 'permission_denied'
  | 'capacity_exceeded'
  | 'capability_unknown'
  | 'queues_unavailable'
  | 'workers_paid_required'
  | 'workers_dev_subdomain_missing'
  | 'r2_unavailable'
  | 'analytics_engine_unavailable'
  | 'migration_failed'
  | 'organization_slug_mismatch';

const GUIDANCE =
  'Workers Paid with Queues is the supported target. Enable the required service, verify token permissions, then rerun pb cloudflare setup. Resources were not created. For a different deployment target, use the documented single-replica Node installation.';
const MESSAGES: Record<ErrorCode, string> = {
  invalid_input:
    'Invalid input or incomplete Cloudflare build; build the selected configuration first.',
  unsafe_path: 'State must be ignored, contained, regular and separate from build output.',
  invalid_inventory: 'Inventory identity or journal is invalid; restore trusted private state.',
  install_locked:
    'Install lock exists; stop all writers and inspect the owner before explicit recovery.',
  confirmation_required: 'Review the create plan and supply --yes for noninteractive creates.',
  confirmation_declined: 'Creation declined; literal yes is required.',
  plan_changed: 'The acknowledged plan changed; inspect provider state and rerun.',
  ownership_conflict:
    'Exact ownership is unresolved; inspect resources and explicitly adopt the exact ID if appropriate. Nothing is deleted.',
  jurisdiction_conflict:
    'Actual jurisdiction is unknown or differs; choose another name or plan a separate migration.',
  configuration_conflict:
    'Existing resource configuration differs; inspect and resolve it explicitly.',
  outcome_unknown:
    'The create outcome is unknown. Retain private inventory, reconcile or explicitly adopt the exact ID; do not blindly repeat creation.',
  provider_failure: 'Provider request failed; no raw provider diagnostic is displayed.',
  permission_denied: GUIDANCE,
  capacity_exceeded: GUIDANCE,
  capability_unknown: `Required capability is unresolved. ${GUIDANCE}`,
  queues_unavailable: GUIDANCE,
  workers_paid_required: GUIDANCE,
  workers_dev_subdomain_missing:
    'Register a workers.dev subdomain manually in the Cloudflare dashboard, then rerun. No registration was attempted.',
  r2_unavailable: `Enable R2 manually, then rerun. ${GUIDANCE}`,
  analytics_engine_unavailable: GUIDANCE,
  migration_failed: 'Migration failed; inspect the migration state before continuing.',
  organization_slug_mismatch: 'The existing organization has a different slug.',
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
  ) {
    super(MESSAGES[code]);
    this.name = 'CloudflareError';
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
  return {
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
    checks: [] as { name: string; status: string }[],
    rollback: { status: 'not_needed', target_version_id: null },
    bootstrap_url: null as string | null,
    error: null as { code: ErrorCode; message: string; retryable: boolean; stage: string } | null,
  };
}
export type CommandEnvelope = ReturnType<typeof commandEnvelope>;
export interface CommandResult {
  exitCode: number;
  output: CommandEnvelope;
}

export function failCommand(output: CommandEnvelope, error: unknown): CommandResult {
  const safe = error instanceof CloudflareError ? error : new CloudflareError('provider_failure');
  output.status = 'error';
  if (safe.check !== null) output.checks.push({ name: safe.check, status: safe.code });
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
}
export interface ApiResponse {
  result: unknown;
  result_info?: Record<string, unknown>;
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
interface Scheduler {
  next: number;
  tail: Promise<unknown>;
}
const schedulers = new WeakMap<typeof fetch, Map<string, Scheduler>>();
export class CloudflareApi {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly deadline: number;
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
    this.deadline = options.deadline ?? this.now() + 600_000;
  }
  async pause(ms: number): Promise<void> {
    if (this.now() + ms >= this.deadline) throw new CloudflareError('provider_failure', 1, true);
    if (ms > 0) await this.sleep(ms);
    if (this.now() >= this.deadline) throw new CloudflareError('provider_failure', 1, true);
  }
  request(path: string, method: 'GET' | 'POST' = 'GET', body?: unknown): Promise<ApiResponse> {
    const task = this.scheduler.tail.then(() => this.send(path, method, body));
    this.scheduler.tail = task.catch(() => undefined);
    return task;
  }
  private async send(path: string, method: 'GET' | 'POST', body?: unknown): Promise<ApiResponse> {
    if (
      (method !== 'GET' && method !== 'POST') ||
      !/^\/[a-zA-Z0-9_/?=&%.-]+$/.test(path) ||
      path.includes('..') ||
      path.startsWith('//')
    )
      throw new CloudflareError('invalid_input', 2);
    for (let attempt = 0; attempt < (method === 'GET' ? 5 : 1); attempt++) {
      await this.pause(Math.max(0, this.scheduler.next - this.now()));
      this.scheduler.next = this.now() + 1000;
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.min(35_000, Math.max(1, this.deadline - this.now())),
      );
      const aborted = new Promise<never>((_, reject) =>
        controller.signal.addEventListener('abort', () => reject(new Error()), { once: true }),
      );
      let response: Response | undefined;
      try {
        response = await Promise.race([
          (this.options.fetch ?? fetch)(
            `https://api.cloudflare.com/client/v4/accounts/${this.options.accountId}${path}`,
            {
              method,
              redirect: 'manual',
              signal: controller.signal,
              headers: {
                authorization: `Bearer ${this.options.apiToken}`,
                'content-type': 'application/json',
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          ),
          aborted,
        ]);
        if (!response.ok) {
          controller.abort();
          void response.body?.cancel().catch(() => undefined);
        }
        if (response.status === 403 || response.status === 401)
          throw new CloudflareError('permission_denied', 1, false, 'provision', response.status);
        const transient = [408, 429, 500, 502, 503, 504].includes(response.status);
        if (!response.ok)
          throw new CloudflareError('provider_failure', 1, transient, 'provision', response.status);
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
        if (parsed.success !== true || !Object.hasOwn(parsed, 'result')) throw new Error();
        return {
          result: parsed.result,
          ...(parsed.result_info === undefined ? {} : { result_info: object(parsed.result_info) }),
        };
      } catch (error) {
        const safe =
          error instanceof CloudflareError
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
        clearTimeout(timer);
      }
    }
    throw new CloudflareError('provider_failure', 1, true);
  }
  async list(path: string, field?: string): Promise<Record<string, unknown>[]> {
    const all: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let page = 1; page <= 10_000; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await this.request(
        `${path}${separator}${cursor === undefined ? `page=${page}&per_page=100` : `cursor=${encodeURIComponent(cursor)}`}`,
      );
      const result = field === undefined ? response.result : object(response.result)[field];
      if (!Array.isArray(result)) throw new CloudflareError('provider_failure');
      all.push(...result.map(object));
      const info = response.result_info;
      const next = info?.cursor;
      if (typeof next === 'string' && next !== '') {
        if (seen.has(next)) throw new CloudflareError('provider_failure');
        seen.add(next);
        cursor = next;
        continue;
      }
      const pages = info?.total_pages;
      if (typeof pages === 'number' && Number.isSafeInteger(pages) && pages >= page) {
        if (pages === page) return all;
        continue;
      }
      if (
        info?.total_count === all.length ||
        (cursor !== undefined && next === '') ||
        (pages === 0 && result.length === 0)
      )
        return all;
      // Absence requires explicit pagination completion, never a short-page guess.
      throw new CloudflareError('capability_unknown');
    }
    throw new CloudflareError('provider_failure');
  }
}
