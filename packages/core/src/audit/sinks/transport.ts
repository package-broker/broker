import { isPrivateHost, isCloudMetadataHost } from '../../platform/private-host.js';
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
  'content-encoding',
  'expect',
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
  if (Number.isNaN(value) || value <= 0 || (value < MAX_TIMEOUT_MS && !Number.isInteger(value))) {
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
      key.startsWith('x-forwarded-') ||
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
  const ipv4 = /^\d+\.\d+\.\d+\.\d+$/.test(host);
  if (
    isCloudMetadataHost(host) ||
    (!host.startsWith('[') && (host.startsWith('.') || host.endsWith('.') || host.includes('..')))
  ) {
    throw new AuditSinkConfigError('invalid_endpoint');
  }
  const privateHost = isPrivateHost(host, true);
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
    !options.audit?.egress?.allowPrivate?.includes(options.id) &&
    Object.keys(headers).length === 0
  ) {
    throw new AuditSinkConfigError('missing_credential');
  }
  headers['content-type'] = 'application/json';
  return async (request) => {
    const { body, contentType } = request;
    if (
      typeof body !== 'string' ||
      typeof contentType !== 'string' ||
      contentType !== 'application/json'
    ) {
      throw new AuditTransportError('refused');
    }
    if (new TextEncoder().encode(body).byteLength > 512 * 1024) {
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
        body,
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

const OTEL_ENDPOINTS = ['OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', 'OTEL_EXPORTER_OTLP_ENDPOINT'];
const OTEL_HEADERS = ['OTEL_EXPORTER_OTLP_LOGS_HEADERS', 'OTEL_EXPORTER_OTLP_HEADERS'];

export function parseAuditOtelEnvironment(
  env: (name: string) => string | undefined,
  destination: Extract<AuditDestinationSpec, { protocol: 'otlp-http-json' }> = {
    protocol: 'otlp-http-json',
  },
): AuditOtelEnvironment | null {
  const value = (name: string): string | undefined => env(name) || undefined;
  const endpointName = destination.endpointEnv ?? 'PB_AUDIT_OTLP_ENDPOINT';
  const explicitOtel = OTEL_ENDPOINTS.includes(endpointName);
  const pairedOtelHeaders = endpointName.replace(/ENDPOINT$/, 'HEADERS');
  const headersName =
    destination.headersEnv ??
    (endpointName === 'PB_AUDIT_OTLP_ENDPOINT'
      ? 'PB_AUDIT_OTLP_HEADERS'
      : explicitOtel
        ? pairedOtelHeaders
        : undefined);
  if (
    headersName !== undefined &&
    headersName.toUpperCase().startsWith('OTEL_EXPORTER_OTLP_') &&
    !(explicitOtel && headersName === pairedOtelHeaders)
  ) {
    throw new AuditSinkConfigError('invalid_headers');
  }
  if (!value(endpointName) && headersName !== undefined && value(headersName)) {
    throw new AuditSinkConfigError('invalid_endpoint');
  }
  for (const name of explicitOtel ? [endpointName] : [endpointName, ...OTEL_ENDPOINTS]) {
    const raw = value(name);
    if (raw === undefined) continue;
    const otel = OTEL_ENDPOINTS.includes(name);
    if (otel) {
      for (const prefix of ['OTEL_EXPORTER_OTLP_', 'OTEL_EXPORTER_OTLP_LOGS_']) {
        for (const suffix of ['CERTIFICATE', 'CLIENT_CERTIFICATE', 'CLIENT_KEY']) {
          if (value(prefix + suffix) !== undefined)
            throw new AuditSinkConfigError('unsupported_tls');
        }
        const compression = value(prefix + 'COMPRESSION');
        if (compression !== undefined && compression !== 'none') {
          throw new AuditSinkConfigError('unsupported_compression');
        }
      }
      const protocol =
        value('OTEL_EXPORTER_OTLP_LOGS_PROTOCOL') ?? value('OTEL_EXPORTER_OTLP_PROTOCOL');
      if (protocol !== undefined && protocol !== 'http/json') {
        throw new AuditSinkConfigError('unsupported_protocol');
      }
    }
    const rawTimeout =
      value('OTEL_EXPORTER_OTLP_LOGS_TIMEOUT') ?? value('OTEL_EXPORTER_OTLP_TIMEOUT');
    if (rawTimeout !== undefined && !/^\d+$/.test(rawTimeout)) {
      throw new AuditSinkConfigError('invalid_timeout');
    }
    const duration = timeoutMs(rawTimeout === undefined ? undefined : Number(rawTimeout));
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
      url.pathname = url.pathname.replace(/\/+$/, '') + '/v1/logs';
    }
    const rawHeaders =
      name === endpointName
        ? headersName === undefined
          ? undefined
          : value(headersName)
        : (value('OTEL_EXPORTER_OTLP_LOGS_HEADERS') ?? value('OTEL_EXPORTER_OTLP_HEADERS'));
    return {
      endpoint: url.href,
      activationSource: name,
      headers: parseAuditOtelHeaders(rawHeaders),
      timeoutMs: duration,
    };
  }
  if (!explicitOtel && OTEL_HEADERS.some((name) => value(name))) {
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
    const raw = env(destination.urlEnv) || undefined;
    const headersName =
      destination.headersEnv ??
      (destination.urlEnv === 'PB_AUDIT_WEBHOOK_URL' ? 'PB_AUDIT_WEBHOOK_HEADERS' : undefined);
    const rawHeaders = headersName === undefined ? undefined : env(headersName) || undefined;
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
