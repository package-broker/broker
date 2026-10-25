import { API_ERROR_CODES } from '@package-broker/core/api/response';
import { isUlid } from '@package-broker/core/ids';
import {
  canonicalManifest,
  MAX_MANIFEST_BYTES,
  parseManifest,
  planHash,
  type ParsedManifest,
} from '@package-broker/core/import/manifest';
import {
  parseCredentialMaterial,
  type CredentialKind,
} from '@package-broker/core/sources/credentials';

export class ImportClientError extends Error {
  constructor(
    readonly code: string,
    readonly exitCode: number,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ImportClientError';
  }
}

export function localError(code: string, message: string): ImportClientError {
  return new ImportClientError(code, 2, message);
}

export function brokerOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === 'localhost')) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      ![url.origin, `${url.origin}/`].includes(value)
    )
      throw new Error();
    return url.origin;
  } catch {
    throw localError(
      'invalid_origin',
      'Use a bare HTTPS broker origin (HTTP is allowed only for localhost).',
    );
  }
}

export async function importManifest(text: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw localError('invalid_manifest', 'Invalid import manifest.');
  }
  const parsed = parseManifest(raw);
  if (!parsed.ok) throw localError('invalid_manifest', 'Invalid import manifest.');
  const canonical = canonicalManifest(parsed.data);
  if (Buffer.byteLength(canonical) > MAX_MANIFEST_BYTES)
    throw localError('manifest_too_large', 'The manifest exceeds the single-run limit.');
  return { manifest: parsed.data, canonical, hash: await planHash(parsed.data) };
}

export const RUN_STATES = [
  'planned',
  'applying',
  'failed',
  'applied',
  'verifying',
  'verified',
  'rolled_back',
  'cancelled',
] as const;
export interface CredentialState {
  readonly sourceRef: string;
  readonly bound: boolean;
}
export interface RunStatus {
  readonly id: string;
  readonly state: (typeof RUN_STATES)[number];
  readonly planHash: string | null;
  readonly approvedAt: string | null;
  readonly acceptedAt: string | null;
  readonly credentialWindowUntil: string | null;
  readonly credentials: readonly CredentialState[];
}
const WINDOW_MARGIN_MS = 5000;
/** Sources exist only once apply has run; the server refuses uploads before that. */
export const UPLOAD_STATES: ReadonlySet<RunStatus['state']> = new Set([
  'applied',
  'verifying',
  'verified',
]);
export function uploadsAccepted(status: RunStatus, nowMs: number): boolean {
  return (
    status.approvedAt !== null &&
    status.credentialWindowUntil !== null &&
    UPLOAD_STATES.has(status.state) &&
    Date.parse(status.credentialWindowUntil) > nowMs + WINDOW_MARGIN_MS
  );
}
export interface CredentialBinding {
  readonly external_ref: string;
  readonly credential_ref: string;
  readonly kind: CredentialKind;
}
export type CredentialResolver = (reference: string) => Promise<string>;

export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function timestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
function nullableDate(value: unknown): value is string | null {
  return value === null || timestamp(value);
}
function credentialStates(value: unknown): value is CredentialState[] {
  return (
    Array.isArray(value) &&
    value.length <= 10000 &&
    value.every(
      (entry) =>
        object(entry) &&
        typeof entry.sourceRef === 'string' &&
        typeof entry.bound === 'boolean' &&
        Object.keys(entry).length === 2,
    ) &&
    new Set(value.map((entry: CredentialState) => entry.sourceRef)).size === value.length
  );
}
export function runId(value: string): string {
  if (!isUlid(value)) throw localError('invalid_run', 'Invalid import run ID.');
  return value;
}

const incompatible = () =>
  new ImportClientError(
    'incompatible_response',
    1,
    'The broker returned an incompatible import response.',
  );
const unknownOutcome = () =>
  new ImportClientError(
    'outcome_unknown',
    6,
    'Outcome unknown; check the run in the UI before retrying.',
  );

// Credential summaries repeat only a subset of manifest content; allow room for the run DTO.
const MAX_STATUS_BYTES = MAX_MANIFEST_BYTES + 65536;
const waitTimeout = () => new ImportClientError('wait_timeout', 3, 'Import status wait timed out.');

async function readResponse(response: Response, maxBytes: number): Promise<unknown> {
  if (response.body === null) throw incompatible();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw incompatible();
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export class ImportClient {
  readonly origin: string;
  private readonly token: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(options: {
    broker: string;
    token: string;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.origin = brokerOrigin(options.broker);
    if (!options.token || !/^[\x21-\x7e]+$/.test(options.token))
      throw localError('invalid_token', 'Provide PB_IMPORT_TOKEN or --token-file.');
    this.token = options.token;
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    body?: string,
    key?: string,
    deadline?: number,
  ): Promise<{ data: unknown; headers: Headers }> {
    const remaining = deadline === undefined ? 30000 : deadline - this.now();
    if (remaining <= 0) throw waitTimeout();
    const signal = AbortSignal.timeout(Math.min(30000, remaining));
    const mutating = method !== 'GET';
    let response: Response;
    let data: unknown;
    try {
      response = await this.fetcher(new URL(`/_pb/import-runs${path}`, this.origin), {
        method,
        redirect: 'error',
        signal,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        ...(body === undefined ? {} : { body }),
      });
      if (deadline !== undefined && this.now() >= deadline) throw waitTimeout();
      if (response.status === 204) {
        if (method === 'GET' || path === '') throw incompatible();
        return { data: null, headers: response.headers };
      }
      if (response.status === 429) void response.body?.cancel().catch(() => undefined);
      else data = await readResponse(response, method === 'GET' ? MAX_STATUS_BYTES : 65536);
    } catch {
      if (
        deadline !== undefined &&
        (this.now() >= deadline || (remaining <= 30000 && signal.aborted))
      )
        throw waitTimeout();
      throw mutating
        ? unknownOutcome()
        : new ImportClientError('request_failed', 1, 'Could not read broker response.');
    }
    if (deadline !== undefined && this.now() >= deadline) throw waitTimeout();
    if (!response.ok) {
      if (response.status === 429) {
        const header = response.headers.get('retry-after');
        const seconds = header !== null && /^\d+$/.test(header) ? Number(header) : NaN;
        const delay = Number.isFinite(seconds)
          ? seconds * 1000
          : header === null
            ? 1000
            : Date.parse(header) - this.now();
        const retryAfterMs = Number.isFinite(delay) ? Math.max(1000, delay) : 1000;
        throw new ImportClientError('rate_limited', 1, 'Rate limited; retry later.', retryAfterMs);
      }
      const envelope = object(data) && object(data.error) ? data.error : null;
      const code = envelope?.code;
      if (typeof code === 'string' && Object.hasOwn(API_ERROR_CODES, code)) {
        const known = code as keyof typeof API_ERROR_CODES;
        throw new ImportClientError(known, 1, API_ERROR_CODES[known].message);
      }
      throw new ImportClientError('request_failed', 1, 'Broker request refused.');
    }
    if (
      (path === '' && response.status !== 201) ||
      (method === 'GET' && response.status !== 200) ||
      (method !== 'GET' && path !== '')
    )
      throw mutating ? unknownOutcome() : incompatible();
    return { data, headers: response.headers };
  }

  async submit(
    canonical: string,
    key: string,
  ): Promise<{ id: string; planHash: string; state: 'planned'; replayed: boolean }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key))
      throw localError('invalid_key', 'Invalid idempotency key.');
    let answer: Awaited<ReturnType<ImportClient['request']>>;
    try {
      answer = await this.request('', 'POST', canonical, key);
    } catch (error) {
      if (error instanceof ImportClientError && error.code === 'idempotency_mismatch')
        throw new ImportClientError(
          'idempotency_mismatch',
          1,
          'The broker already holds a different manifest under this receipt key; reconcile the run in the UI and submit with a new receipt.',
        );
      throw error;
    }
    const { data, headers } = answer;
    if (
      !object(data) ||
      typeof data.id !== 'string' ||
      !isUlid(data.id) ||
      !hash(data.planHash) ||
      data.state !== 'planned'
    )
      throw unknownOutcome();
    return {
      id: data.id,
      planHash: data.planHash,
      state: 'planned',
      replayed: headers.get('idempotent-replayed') === 'true',
    };
  }

  async status(id: string, deadline?: number): Promise<RunStatus> {
    const { data } = await this.request(`/${runId(id)}`, 'GET', undefined, undefined, deadline);
    if (
      !object(data) ||
      data.id !== id ||
      !RUN_STATES.includes(data.state as RunStatus['state']) ||
      !(data.planHash === null || hash(data.planHash)) ||
      !nullableDate(data.approvedAt) ||
      !nullableDate(data.acceptedAt) ||
      !nullableDate(data.credentialWindowUntil) ||
      !credentialStates(data.credentials)
    )
      throw incompatible();
    return {
      id,
      state: data.state as RunStatus['state'],
      planHash: data.planHash,
      approvedAt: data.approvedAt,
      acceptedAt: data.acceptedAt,
      credentialWindowUntil: data.credentialWindowUntil,
      credentials: data.credentials.map(({ sourceRef, bound }) => ({ sourceRef, bound })),
    };
  }

  async verify(id: string, deadline?: number): Promise<void> {
    await this.request(`/${runId(id)}/verify`, 'POST', undefined, undefined, deadline);
  }

  /**
   * Uploads material for every manifest source the broker reports unbound, re-reading the run
   * before each upload so a rerun after a partial failure skips sources bound meanwhile.
   */
  async credentials(
    id: string,
    manifest: ParsedManifest,
    bindings: readonly CredentialBinding[],
    resolve: CredentialResolver,
  ): Promise<{ uploaded: number; skipped: number }> {
    runId(id);
    const sources = manifest.items.filter(
      (item) => item.type === 'source' && item.credential_ref !== null,
    );
    if (sources.some((source) => source.external_ref === '.' || source.external_ref === '..'))
      throw localError(
        'invalid_external_ref',
        'Credential source reference cannot be a dot segment.',
      );
    if (
      sources.some(
        (source) => source.type === 'source' && source.credential_ref === 'env:PB_IMPORT_TOKEN',
      )
    )
      throw localError(
        'invalid_credential_ref',
        'The broker token cannot be used as a source credential.',
      );
    const byRef = new Map<string, CredentialBinding>();
    for (const binding of bindings) {
      const source = sources.find((item) => item.external_ref === binding.external_ref);
      if (
        source?.type !== 'source' ||
        source.credential_ref !== binding.credential_ref ||
        byRef.has(binding.external_ref)
      )
        throw localError(
          'credential_binding_mismatch',
          'Credential bindings must match manifest source entries exactly.',
        );
      if (
        !['http_basic', 'bearer', 'header', 'query', 'github_app', 'npm_token', 'ssh_key'].includes(
          binding.kind,
        ) ||
        (binding.kind === 'query' && source.source_type !== 'composer_repository') ||
        (binding.kind === 'github_app' &&
          (source.source_type !== 'vcs' ||
            source.project !== null ||
            !('provider' in source.config) ||
            source.config.provider !== 'github'))
      )
        throw localError(
          'invalid_credential_kind',
          'Credential kind is incompatible with the manifest source.',
        );
      byRef.set(binding.external_ref, binding);
    }
    const expectedHash = await planHash(manifest);
    const expectedRefs = sources.map((item) => item.external_ref).sort();
    const ready = async (): Promise<RunStatus> => {
      const status = await this.status(id);
      if (status.planHash !== expectedHash)
        throw localError(
          'plan_hash_mismatch',
          'The local manifest does not match the broker plan.',
        );
      const reported = status.credentials.map((entry) => entry.sourceRef).sort();
      if (
        reported.length !== expectedRefs.length ||
        reported.some((ref, index) => ref !== expectedRefs[index])
      )
        throw incompatible();
      return status;
    };
    const assertOpen = (status: RunStatus) => {
      if (status.approvedAt === null)
        throw new ImportClientError(
          'not_ready',
          3,
          'The credential window opens when the run is approved; approve and apply it in the UI first.',
        );
      if (status.credentialWindowUntil === null)
        throw new ImportClientError(
          'credential_window_closed',
          1,
          'The credential window for this run is closed; bind the remaining credentials in the UI.',
        );
      if (!UPLOAD_STATES.has(status.state))
        throw new ImportClientError(
          'not_ready',
          3,
          'Wait for apply to finish in the UI before uploading credentials.',
        );
      if (!uploadsAccepted(status, this.now()))
        throw new ImportClientError(
          'credential_window_closed',
          1,
          'The credential window for this run is closing; bind the remaining credentials in the UI.',
        );
    };
    let status = await ready();
    const pending = status.credentials.filter((entry) => !entry.bound);
    if (pending.length === 0) return { uploaded: 0, skipped: status.credentials.length };
    assertOpen(status);
    if (pending.some((entry) => !byRef.has(entry.sourceRef)))
      throw localError(
        'credential_binding_missing',
        'Supply a credential kind for every source the broker reports unbound.',
      );
    let uploaded = 0;
    for (const [index, entry] of pending.entries()) {
      if (index > 0) {
        status = await ready();
        if (status.credentials.some((item) => item.sourceRef === entry.sourceRef && item.bound))
          continue;
        assertOpen(status);
      }
      const binding = byRef.get(entry.sourceRef)!;
      let material: string;
      try {
        material = await resolve(binding.credential_ref);
        if (Buffer.byteLength(material) > 16384) throw new Error();
        parseCredentialMaterial(binding.kind, material);
      } catch {
        throw localError(
          'credential_resolution_failed',
          'Could not resolve valid credential material.',
        );
      }
      if (!uploadsAccepted(status, this.now()))
        throw new ImportClientError(
          'credential_window_closed',
          1,
          'The credential window for this run is closing; bind the remaining credentials in the UI.',
        );
      await this.request(
        `/${id}/credentials/${encodeURIComponent(binding.external_ref)}`,
        'PUT',
        JSON.stringify({ kind: binding.kind, material }),
      );
      uploaded++;
    }
    return { uploaded, skipped: status.credentials.length - uploaded };
  }
}
