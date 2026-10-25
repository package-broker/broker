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
export interface RunStatus {
  readonly id: string;
  readonly state: (typeof RUN_STATES)[number];
  readonly planHash: string | null;
  readonly approvedAt: string | null;
  readonly acceptedAt: string | null;
  readonly credentialWindowUntil?: string | null;
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

async function readResponse(response: Response): Promise<unknown> {
  if (response.body === null) throw incompatible();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65536) throw incompatible();
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
  ): Promise<unknown> {
    const mutating = method !== 'GET';
    let response: Response;
    let data: unknown;
    try {
      response = await this.fetcher(new URL(`/_pb/import-runs${path}`, this.origin), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(key === undefined ? {} : { 'idempotency-key': key }),
        },
        ...(body === undefined ? {} : { body }),
      });
      if (response.status === 204) {
        if (method === 'GET' || path === '') throw incompatible();
        return null;
      }
      data = await readResponse(response);
    } catch {
      throw mutating
        ? unknownOutcome()
        : new ImportClientError('request_failed', 1, 'Could not read broker response.');
    }
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
    return data;
  }

  async submit(
    canonical: string,
    key: string,
  ): Promise<{ id: string; planHash: string; state: 'planned' }> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(key))
      throw localError('invalid_key', 'Invalid idempotency key.');
    const data = await this.request('', 'POST', canonical, key);
    if (
      !object(data) ||
      typeof data.id !== 'string' ||
      !isUlid(data.id) ||
      !hash(data.planHash) ||
      data.state !== 'planned'
    )
      throw unknownOutcome();
    return { id: data.id, planHash: data.planHash, state: 'planned' };
  }

  async status(id: string): Promise<RunStatus> {
    const data = await this.request(`/${runId(id)}`, 'GET');
    if (
      !object(data) ||
      data.id !== id ||
      !RUN_STATES.includes(data.state as RunStatus['state']) ||
      !(data.planHash === null || hash(data.planHash)) ||
      !nullableDate(data.approvedAt) ||
      !nullableDate(data.acceptedAt) ||
      (data.credentialWindowUntil !== undefined && !nullableDate(data.credentialWindowUntil))
    )
      throw incompatible();
    return {
      id,
      state: data.state as RunStatus['state'],
      planHash: data.planHash,
      approvedAt: data.approvedAt,
      acceptedAt: data.acceptedAt,
      ...(data.credentialWindowUntil === undefined
        ? {}
        : { credentialWindowUntil: data.credentialWindowUntil as string | null }),
    };
  }

  async verify(id: string): Promise<RunStatus> {
    await this.request(`/${runId(id)}/verify`, 'POST');
    return this.status(id);
  }

  async credentials(
    id: string,
    manifest: ParsedManifest,
    bindings: readonly CredentialBinding[],
    resolve: CredentialResolver,
  ): Promise<number> {
    runId(id);
    const sources = manifest.items.filter(
      (item) => item.type === 'source' && item.credential_ref !== null,
    );
    const seen = new Set<string>();
    for (const binding of bindings) {
      const source = sources.find((item) => item.external_ref === binding.external_ref);
      if (
        source?.type !== 'source' ||
        source.credential_ref !== binding.credential_ref ||
        seen.has(binding.external_ref)
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
      seen.add(binding.external_ref);
    }
    if (seen.size !== sources.length)
      throw localError(
        'credential_binding_missing',
        'Supply a credential kind for every manifest source reference.',
      );
    const expectedHash = await planHash(manifest);
    for (const binding of bindings) {
      const status = await this.status(id);
      if (status.planHash !== expectedHash)
        throw localError(
          'plan_hash_mismatch',
          'The local manifest does not match the broker plan.',
        );
      if (status.credentialWindowUntil === undefined)
        throw localError(
          'credential_window_unavailable',
          'The broker must expose the credential window before secrets can be resolved.',
        );
      if (
        status.approvedAt === null ||
        status.credentialWindowUntil === null ||
        Date.parse(status.credentialWindowUntil) <= this.now() + 5000
      )
        throw new ImportClientError('conflict', 1, API_ERROR_CODES.conflict.message);
      if (status.state !== 'applied')
        throw new ImportClientError(
          'not_ready',
          3,
          'Wait for approval and apply in the UI before uploading credentials.',
        );
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
      if (Date.parse(status.credentialWindowUntil) <= this.now() + 5000)
        throw new ImportClientError('conflict', 1, API_ERROR_CODES.conflict.message);
      await this.request(
        `/${id}/credentials/${encodeURIComponent(binding.external_ref)}`,
        'PUT',
        JSON.stringify({ kind: binding.kind, material }),
      );
    }
    return bindings.length;
  }
}
