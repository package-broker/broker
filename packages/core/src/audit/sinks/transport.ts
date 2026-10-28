import { classifyAddress } from '../../sources/url-policy.js';
import { AuditSinkConfigError } from '../plugin-api.js';
import type { AuditBoundFetch, AuditDestinationSpec, AuditSinkErrorCode } from '../plugin-api.js';

const DEFAULT_TIMEOUT_MS = 1500;
const MAX_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DENIED_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'traceparent',
  'tracestate',
  'baggage',
  'cookie',
  'set-cookie',
]);

export class AuditTransportError extends Error {
  constructor(readonly code: AuditSinkErrorCode) {
    super('Audit transport failed');
    this.name = 'AuditTransportError';
  }
}

function timeoutMs(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new AuditSinkConfigError('invalid_timeout');
  }
  return Math.min(value, MAX_TIMEOUT_MS);
}

function headersOf(input: Readonly<Record<string, string>>): Record<string, string> {
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(input)) {
    const key = name.toLowerCase();
    if (
      !HEADER_NAME.test(name) ||
      typeof value !== 'string' ||
      !/^[\x20-\x7e]*$/.test(value) ||
      DENIED_HEADERS.has(key) ||
      Object.hasOwn(headers, key)
    )
      throw new AuditSinkConfigError('invalid_headers');
    headers[key] = value;
  }
  return headers;
}

function endpoint(raw: string, runtime: 'docker' | 'cloudflare', allowPrivate = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AuditSinkConfigError('invalid_endpoint');
  }
  if (
    /[?#@\\\s]/.test(raw) ||
    url.username ||
    url.password ||
    !url.hostname ||
    !['http:', 'https:'].includes(url.protocol)
  ) {
    throw new AuditSinkConfigError('invalid_endpoint');
  }
  const host = url.hostname.replace(/\.$/, '');
  const octets = host.split('.').map(Number);
  const ipv4 =
    octets.length === 4 && octets.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
  const a = octets[0];
  const b = octets[1] ?? -1;
  // URL normalizes IPv4 aliases and IPv6 spelling before these checks.
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '[::1]' ||
    (ipv4 && (a === 127 || (a === 169 && b === 254))) ||
    /^\[fe[89ab][0-9a-f]:/.test(host);
  if (
    !host.startsWith('[') &&
    (host.startsWith('.') || host.endsWith('.') || host.includes('..'))
  ) {
    throw new AuditSinkConfigError('invalid_endpoint');
  }
  const privateHost =
    local ||
    (ipv4 && (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) ||
    /^\[f[cd][0-9a-f]{2}:/.test(host) ||
    (!ipv4 &&
      !host.startsWith('[') &&
      (!host.includes('.') ||
        ['.internal', '.local', '.svc', '.cluster.local', '.home.arpa'].some((suffix) =>
          host.endsWith(suffix),
        )));
  const optedIn = privateHost && runtime === 'docker' && allowPrivate;
  if (
    (privateHost && !optedIn) ||
    ((ipv4 || host.startsWith('[')) && !classifyAddress(host).ok && !optedIn) ||
    (url.protocol !== 'https:' && !optedIn)
  ) {
    throw new AuditSinkConfigError('invalid_endpoint');
  }
  return url.href;
}

interface AuditTransportOptions {
  readonly id: string;
  readonly runtime: 'docker' | 'cloudflare';
  readonly audit?: { readonly egress?: { readonly allowPrivate?: readonly string[] } };
  readonly fetchImpl?: typeof fetch;
}

export function createAuditBoundFetch(
  options: AuditTransportOptions & AuditOtelEnvironment,
): AuditBoundFetch {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = endpoint(
    options.endpoint,
    options.runtime,
    options.audit?.egress?.allowPrivate?.includes(options.id),
  );
  const headers = headersOf(options.headers);
  const duration = timeoutMs(options.timeoutMs);
  if (
    !Object.entries(headers).some(
      ([key, value]) =>
        (key === 'authorization' || /(?:^|-)(?:api-key|token)$/.test(key)) && value.trim() !== '',
    )
  ) {
    throw new AuditSinkConfigError('missing_credential');
  }
  headers['content-type'] = 'application/json';
  return async (request) => {
    if (request.contentType !== 'application/json') throw new AuditTransportError('refused');
    if (new TextEncoder().encode(request.body).byteLength > 512 * 1024) {
      throw new AuditTransportError('too_large');
    }
    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectStop: (error: AuditTransportError) => void = () => undefined;
    const stopped = new Promise<never>((_, reject) => {
      rejectStop = reject;
    });
    const stop = (code: AuditSinkErrorCode): void => {
      rejectStop(new AuditTransportError(code));
      controller.abort();
      void reader?.cancel().catch(() => undefined);
    };
    const abort = (): void => stop('refused');
    const attempt = async (): Promise<Awaited<ReturnType<AuditBoundFetch>>> => {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: request.body,
        redirect: 'manual',
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw new AuditTransportError('refused');
      }
      reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) throw new AuditTransportError('too_large');
          chunks.push(value);
        }
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
        body: new TextDecoder().decode(bytes),
      };
    };
    try {
      request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) abort();
      timer = setTimeout(() => stop('timeout'), duration);
      if (request.signal.aborted) return await stopped;
      return await Promise.race([attempt(), stopped]);
    } catch (error) {
      if (error instanceof AuditTransportError) throw error;
      throw new AuditTransportError('network');
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      void reader?.cancel().catch(() => undefined);
    }
  };
}

export function parseAuditOtelHeaders(raw: string | undefined): Readonly<Record<string, string>> {
  if (raw === undefined || raw.trim() === '') return {};
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  try {
    for (const pair of raw.split(',')) {
      const split = pair.indexOf('=');
      if (split < 1) throw new AuditSinkConfigError('invalid_headers');
      const name = decodeURIComponent(pair.slice(0, split).trim()).toLowerCase();
      const value = decodeURIComponent(pair.slice(split + 1).trim());
      if (Object.hasOwn(result, name)) throw new AuditSinkConfigError('invalid_headers');
      result[name] = value;
    }
    return headersOf(result);
  } catch {
    throw new AuditSinkConfigError('invalid_headers');
  }
}

export interface AuditOtelEnvironment {
  readonly endpoint: string;
  readonly activationSource: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export function parseAuditOtelEnvironment(
  env: (name: string) => string | undefined,
  destination: Extract<AuditDestinationSpec, { protocol: 'otlp-http-json' }> = {
    protocol: 'otlp-http-json',
  },
): AuditOtelEnvironment | null {
  for (const prefix of ['OTEL_EXPORTER_OTLP_', 'OTEL_EXPORTER_OTLP_LOGS_']) {
    for (const suffix of ['CERTIFICATE', 'CLIENT_CERTIFICATE', 'CLIENT_KEY']) {
      if (env(prefix + suffix) !== undefined) throw new AuditSinkConfigError('unsupported_tls');
    }
    if (env(prefix + 'COMPRESSION') !== undefined) {
      throw new AuditSinkConfigError('unsupported_compression');
    }
  }
  const protocol = env('OTEL_EXPORTER_OTLP_LOGS_PROTOCOL') ?? env('OTEL_EXPORTER_OTLP_PROTOCOL');
  if (protocol !== undefined && protocol !== 'http/json') {
    throw new AuditSinkConfigError('unsupported_protocol');
  }
  const rawTimeout = env('OTEL_EXPORTER_OTLP_LOGS_TIMEOUT') ?? env('OTEL_EXPORTER_OTLP_TIMEOUT');
  if (rawTimeout !== undefined && !/^\d+$/.test(rawTimeout)) {
    throw new AuditSinkConfigError('invalid_timeout');
  }
  const duration = timeoutMs(rawTimeout === undefined ? undefined : Number(rawTimeout));
  for (const name of [
    destination.endpointEnv ?? 'PB_AUDIT_OTLP_ENDPOINT',
    'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    'OTEL_EXPORTER_OTLP_ENDPOINT',
  ]) {
    const raw = env(name);
    if (raw === undefined) continue;
    // Destination policy is enforced before core binds the transport.
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new AuditSinkConfigError('invalid_endpoint');
    }
    if (/[?#@\\\s]/.test(raw) || !['http:', 'https:'].includes(url.protocol)) {
      throw new AuditSinkConfigError('invalid_endpoint');
    }
    if (name === 'OTEL_EXPORTER_OTLP_ENDPOINT') {
      url.pathname = url.pathname.replace(/\/+$/, '').replace(/(?:\/v1\/logs)+$/, '') + '/v1/logs';
    }
    const rawHeaders =
      name === (destination.endpointEnv ?? 'PB_AUDIT_OTLP_ENDPOINT')
        ? env(destination.headersEnv ?? 'PB_AUDIT_OTLP_HEADERS')
        : destination.headersEnv === undefined
          ? (env('OTEL_EXPORTER_OTLP_LOGS_HEADERS') ?? env('OTEL_EXPORTER_OTLP_HEADERS'))
          : env(destination.headersEnv);
    return {
      endpoint: url.href,
      activationSource: name,
      headers: parseAuditOtelHeaders(rawHeaders),
      timeoutMs: duration,
    };
  }
  if (
    [
      destination.headersEnv ?? 'PB_AUDIT_OTLP_HEADERS',
      'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
      'OTEL_EXPORTER_OTLP_HEADERS',
    ].some((name) => env(name) !== undefined)
  ) {
    throw new AuditSinkConfigError('invalid_endpoint');
  }
  return null;
}

function retryAfterMs(value: string | null): number | null {
  if (value === null) return null;
  if (/^\d+$/.test(value)) {
    const ms = Number(value) * 1000;
    return Number.isSafeInteger(ms) ? ms : null;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function resolveAuditDestination(
  options: AuditTransportOptions & {
    readonly destination: AuditDestinationSpec;
    readonly activation: 'build' | 'env';
    readonly env: (name: string) => string | undefined;
  },
): Promise<{
  readonly fetch: AuditBoundFetch;
  readonly receiverFingerprint: string;
  readonly activationSource: string;
} | null> {
  const { destination, env } = options;
  let resolved: AuditOtelEnvironment | null;
  if (destination.protocol === 'otlp-http-json') {
    resolved = parseAuditOtelEnvironment(env, destination);
  } else {
    const raw = env(destination.urlEnv);
    const rawHeaders = env(destination.headersEnv ?? 'PB_AUDIT_WEBHOOK_HEADERS');
    if (raw === undefined && rawHeaders !== undefined) {
      throw new AuditSinkConfigError('invalid_endpoint');
    }
    resolved =
      raw === undefined
        ? null
        : {
            endpoint: raw,
            headers: parseAuditOtelHeaders(rawHeaders),
            timeoutMs: DEFAULT_TIMEOUT_MS,
            activationSource: destination.urlEnv,
          };
  }
  if (resolved === null) {
    if (options.activation === 'build') throw new AuditSinkConfigError('invalid_endpoint');
    return null;
  }
  const boundFetch = createAuditBoundFetch({ ...options, ...resolved });
  // Credentials are deliberately excluded: rotating them does not change the receiver.
  const canonical = endpoint(
    resolved.endpoint,
    options.runtime,
    options.audit?.egress?.allowPrivate?.includes(options.id),
  );
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return {
    fetch: boundFetch,
    receiverFingerprint: Array.from(new Uint8Array(digest), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join(''),
    activationSource: resolved.activationSource,
  };
}
