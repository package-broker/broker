export type CheckStatus = 'pass' | 'unsupported' | 'transient' | 'unverified' | 'not_run';

export interface CheckResult {
  readonly id: string;
  readonly status: CheckStatus;
  readonly reason?: string;
  readonly observation?: string;
}

export interface PreflightRecord {
  readonly checks: readonly CheckResult[];
  readonly blocked: boolean;
  readonly blockers: readonly { readonly check: string; readonly reason: string }[];
  readonly complete: boolean;
  readonly notVerified: readonly string[];
  readonly cleanupFailed: boolean;
  readonly rateLimitHeaders: Readonly<Record<string, string>>;
}

export interface PreflightOptions {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly cacheProbeUrl?: string;
  readonly workersDevSuffix?: string;
  readonly reusedD1Id?: string;
  readonly reusedR2Bucket?: string;
  readonly allowCreateTemporaryR2?: boolean;
  readonly randomId?: () => string;
}

const API_HOST = 'api.cloudflare.com';
const API = `https://${API_HOST}/client/v4`;
const MAX_ATTEMPTS = 4;
const MAX_DELAY_MS = 30_000;
const RATE_LIMIT_HEADERS = ['ratelimit', 'ratelimit-policy'] as const;
const BUCKET_NAME = /^[a-z0-9-]{3,63}$/;
const D1_ID = /^[0-9a-f-]{32,36}$/;

class Transient extends Error {}

interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

function hostOf(url: string): string {
  return URL.canParse(url) ? new URL(url).hostname : '';
}

function retryAfterMs(header: string | null | undefined, now: number): number | undefined {
  if (header === null || header === undefined) return undefined;
  if (/^\d+$/.test(header)) return Number(header) * 1000;
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export async function runProviderPreflight(options: PreflightOptions): Promise<PreflightRecord> {
  if (!/^[\x21-\x7e]+$/.test(options.apiToken) || !/^[a-f0-9]{32}$/.test(options.accountId))
    throw new Error('invalid_credentials');
  const transport = options.fetch ?? fetch;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = options.now ?? Date.now;
  const seen: Record<string, string> = {};
  const account = `${API}/accounts/${options.accountId}`;
  let cleanupFailed = false;

  async function send(url: string, init: RequestInit = {}, retry?: boolean): Promise<Reply> {
    const method = init.method ?? 'GET';
    const onApi = hostOf(url) === API_HOST;
    const headers = new Headers(init.headers);
    if (onApi) headers.set('authorization', `Bearer ${options.apiToken}`);
    const attempts = (retry ?? method === 'GET') ? MAX_ATTEMPTS : 1;
    for (let attempt = 0; ; attempt++) {
      let response: Response | undefined;
      try {
        response = await transport(url, {
          ...init,
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        });
      } catch {
        response = undefined;
      }
      if (response) {
        if (onApi) {
          for (const name of RATE_LIMIT_HEADERS) {
            const value = response.headers.get(name);
            if (value !== null) seen[name] = value;
          }
        }
        if (response.status !== 429 && response.status < 500) {
          const body: unknown = await response.json().catch(() => null);
          return { status: response.status, body, headers: response.headers };
        }
        void response.body?.cancel().catch(() => undefined);
      }
      if (attempt + 1 >= attempts) throw new Transient();
      const wanted =
        retryAfterMs(response?.headers.get('retry-after'), now()) ?? 500 * 2 ** attempt;
      await sleep(Math.min(MAX_DELAY_MS, wanted));
    }
  }

  const get = (path: string, headers?: Record<string, string>) =>
    send(`${account}${path}`, headers ? { headers } : {});

  async function guarded(id: string, run: () => Promise<CheckResult>): Promise<CheckResult> {
    try {
      return await run();
    } catch (error) {
      return {
        id,
        status: 'transient',
        reason: error instanceof Transient ? 'provider_unavailable' : 'unexpected_failure',
      };
    }
  }

  const denied = (status: number) => status === 401 || status === 403;
  const success = (reply: Reply) =>
    reply.status === 200 &&
    typeof reply.body === 'object' &&
    reply.body !== null &&
    (reply.body as { success?: unknown }).success === true;
  const resultOf = (reply: Reply): Record<string, unknown> | undefined => {
    const result = (reply.body as { result?: unknown } | null)?.result;
    return typeof result === 'object' && result !== null && !Array.isArray(result)
      ? (result as Record<string, unknown>)
      : undefined;
  };

  const tokenScopes = () =>
    guarded('token-scopes', async () => {
      const verify = await send(`${API}/user/tokens/verify`);
      if (denied(verify.status) || (success(verify) && resultOf(verify)?.status !== 'active'))
        return { id: 'token-scopes', status: 'unsupported', reason: 'token_inactive' };
      if (!success(verify))
        return { id: 'token-scopes', status: 'transient', reason: 'verify_failed' };
      const probes = [
        ['workers', '/workers/scripts'],
        ['d1', '/d1/database?per_page=1'],
        ['r2', '/r2/buckets?per_page=1'],
        ['queues', '/queues?per_page=1'],
      ] as const;
      for (const [scope, path] of probes) {
        const reply = await get(path);
        if (denied(reply.status))
          return { id: 'token-scopes', status: 'unsupported', reason: `scope_missing:${scope}` };
        if (!success(reply))
          return { id: 'token-scopes', status: 'transient', reason: `probe_failed:${scope}` };
      }
      return { id: 'token-scopes', status: 'pass' };
    });

  const writeScopes = (): CheckResult => ({
    id: 'token-write-scopes',
    status: 'unverified',
    reason: 'deploy_and_cleanup_scopes_not_probed',
  });

  const jurisdiction = () =>
    guarded('eu-jurisdiction', async () => {
      const id = 'eu-jurisdiction';
      const { reusedD1Id: d1Id, reusedR2Bucket: bucket } = options;
      if (d1Id === undefined && bucket === undefined)
        return { id, status: 'unverified', reason: 'no_reused_resource' };
      if (
        (d1Id !== undefined && !D1_ID.test(d1Id)) ||
        (bucket !== undefined && !BUCKET_NAME.test(bucket))
      )
        return { id, status: 'unsupported', reason: 'invalid_resource_identifier' };
      const targets: [string, string, Record<string, string>?][] = [];
      if (d1Id !== undefined) targets.push(['d1', `/d1/database/${d1Id}`]);
      if (bucket !== undefined)
        targets.push(['r2', `/r2/buckets/${bucket}`, { 'cf-r2-jurisdiction': 'eu' }]);
      for (const [kind, path, headers] of targets) {
        const reply = await get(path, headers);
        if (denied(reply.status))
          return { id, status: 'unsupported', reason: `scope_missing:${kind}` };
        if (kind === 'r2' && reply.status === 404)
          return { id, status: 'unsupported', reason: 'jurisdiction_not_reported' };
        if (!success(reply)) return { id, status: 'transient', reason: `${kind}_probe_failed` };
        if (resultOf(reply)?.jurisdiction !== 'eu')
          return { id, status: 'unsupported', reason: 'jurisdiction_not_reported' };
      }
      return targets.length === 2
        ? { id, status: 'pass' }
        : { id, status: 'unverified', reason: 'no_reused_resource' };
    });

  const cpuMetrics = () =>
    guarded('cpu-metrics', async () => {
      const since = new Date(now() - 3_600_000).toISOString();
      const reply = await send(
        `${API}/graphql`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            query: `query($a:String!,$s:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:1,filter:{datetime_geq:$s}){quantiles{cpuTimeP50}}}}}`,
            variables: { a: options.accountId, s: since },
          }),
        },
        true,
      );
      const body = reply.body as {
        errors?: unknown;
        data?: { viewer?: { accounts?: unknown } } | null;
      } | null;
      if (
        denied(reply.status) ||
        (reply.status === 200 && Array.isArray(body?.errors) && body.errors.length > 0)
      )
        return { id: 'cpu-metrics', status: 'unsupported', reason: 'metrics_access_denied' };
      if (reply.status !== 200 || !Array.isArray(body?.data?.viewer?.accounts))
        return { id: 'cpu-metrics', status: 'transient', reason: 'metrics_failed' };
      return { id: 'cpu-metrics', status: 'pass' };
    });

  const cacheApi = () =>
    guarded('cache-api-workers-dev', async () => {
      const base = {
        id: 'cache-api-workers-dev',
        status: 'unverified',
        reason: 'no_cache_probe_route',
      } as const;
      const url = options.cacheProbeUrl;
      if (url === undefined) return base;
      const suffix = options.workersDevSuffix ?? '.workers.dev';
      const host = hostOf(url);
      const inSuffix = suffix.startsWith('.') ? host.endsWith(suffix) : host === suffix;
      if (!url.startsWith('https://') || !inSuffix)
        return { ...base, observation: 'probe_url_refused' };
      try {
        const first = await send(url);
        const second = await send(url);
        const ok = (r: Reply) => r.status >= 200 && r.status < 300;
        if (!ok(first) || !ok(second)) return { ...base, observation: 'probe_failed' };
        const stored =
          second.headers.get('cf-cache-status')?.toUpperCase() === 'HIT' ||
          second.headers.has('age');
        return { ...base, observation: stored ? 'stores' : 'no_store' };
      } catch {
        return { ...base, observation: 'probe_failed' };
      }
    });

  const sessions = (): CheckResult => ({
    id: 'd1-sessions',
    status: 'unverified',
    reason: 'runtime_cloudflare_bookmark_wiring_unverified',
  });

  const r2NonEmpty = () =>
    guarded('r2-nonempty-delete', async () => {
      const id = 'r2-nonempty-delete';
      if (!options.allowCreateTemporaryR2)
        return { id, status: 'not_run', reason: 'temporary_bucket_not_allowed' };
      const name = `pb-preflight-${(options.randomId ?? (() => Math.random().toString(36).slice(2, 10)))()}`;
      if (!BUCKET_NAME.test(name))
        return { id, status: 'transient', reason: 'invalid_bucket_name' };
      const eu = { 'cf-r2-jurisdiction': 'eu' };
      const objectUrl = `${account}/r2/buckets/${name}/objects/probe`;
      const bucketUrl = `${account}/r2/buckets/${name}`;

      let outcome: CheckResult;
      let mayCleanup = true;
      try {
        const created = await send(`${account}/r2/buckets`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...eu },
          body: JSON.stringify({ name }),
        });
        if (created.status >= 400) mayCleanup = false;
        if (!success(created)) {
          outcome = { id, status: 'transient', reason: 'bucket_create_failed' };
        } else {
          const put = await send(objectUrl, { method: 'PUT', headers: eu, body: 'x' });
          if (!success(put)) {
            outcome = { id, status: 'transient', reason: 'object_put_failed' };
          } else {
            const attempt = await send(bucketUrl, { method: 'DELETE', headers: eu });
            outcome = success(attempt)
              ? { id, status: 'unsupported', reason: 'nonempty_delete_allowed' }
              : attempt.status === 409
                ? { id, status: 'pass' }
                : { id, status: 'transient', reason: 'unexpected_delete_status' };
          }
        }
      } catch (error) {
        outcome = {
          id,
          status: 'transient',
          reason: error instanceof Transient ? 'provider_unavailable' : 'unexpected_failure',
        };
      }

      const remove = async (url: string, retryConflict = false): Promise<boolean> => {
        try {
          for (let attempt = 0; ; attempt++) {
            const reply = await send(url, { method: 'DELETE', headers: eu }, true);
            if ((reply.status >= 200 && reply.status < 300) || reply.status === 404) return true;
            if (!retryConflict || reply.status !== 409 || attempt + 1 >= MAX_ATTEMPTS) return false;
            await sleep(Math.min(MAX_DELAY_MS, 500 * 2 ** attempt));
          }
        } catch {
          return false;
        }
      };
      if (!mayCleanup) return outcome;
      const objectGone = await remove(objectUrl);
      const bucketGone = await remove(bucketUrl, true);
      if (!objectGone || !bucketGone) {
        cleanupFailed = true;
        return { id, status: 'transient', reason: 'cleanup_failed' };
      }
      return outcome;
    });

  const checks: CheckResult[] = [];
  checks.push(await tokenScopes());
  checks.push(writeScopes());
  checks.push(await jurisdiction());
  checks.push(await cacheApi());
  checks.push(await cpuMetrics());
  checks.push(sessions());
  checks.push(await r2NonEmpty());

  const blockers = checks
    .filter((c) => c.status === 'unsupported' || c.status === 'transient')
    .map((c) => ({ check: c.id, reason: c.reason ?? c.status }));
  const notVerified = checks
    .filter((c) => c.status === 'unverified' || c.status === 'not_run')
    .map((c) => c.id);
  return {
    checks,
    blocked: blockers.length > 0,
    blockers,
    complete: blockers.length === 0 && notVerified.length === 0,
    notVerified,
    cleanupFailed,
    rateLimitHeaders: { ...seen },
  };
}
