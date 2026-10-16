import { pipeline, Readable } from 'node:stream';
import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { FetchLike } from '@package-broker/core/platform/tracing';
import type { OutboundPolicy } from '@package-broker/core/sources/url-policy';
import { createDnsGuard, DnsGuardError, type DnsGuardOptions } from './dns-guard.js';

export interface GuardedFetchOptions extends DnsGuardOptions {
  readonly tls?: { readonly ca?: string | Buffer };
}

class TransportError extends Error {
  override readonly name = 'TransportError';
  constructor(readonly code: string) {
    super(`transport error: ${code}`);
  }
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const CODE_PATTERN = /^[A-Z0-9_]{1,40}$/;

const fetchFailed = (cause?: Error): TypeError =>
  new TypeError('fetch failed', cause === undefined ? undefined : { cause });

function findGuardError(error: unknown): DnsGuardError | undefined {
  if (error instanceof DnsGuardError) return error;
  if (error instanceof AggregateError) {
    for (const inner of error.errors) {
      const found = findGuardError(inner);
      if (found) return found;
    }
  }
  return undefined;
}

function toTransportError(error: unknown): TypeError {
  const guard = findGuardError(error);
  if (guard) return fetchFailed(new DnsGuardError(guard.reason));
  const code = (error as { code?: unknown } | null)?.code;
  return fetchFailed(
    new TransportError(typeof code === 'string' && CODE_PATTERN.test(code) ? code : 'UNKNOWN'),
  );
}

function decoder(encoding: string | undefined): (() => NodeJS.ReadWriteStream) | undefined {
  switch (encoding?.trim().toLowerCase()) {
    case 'gzip':
    case 'x-gzip':
      return createGunzip;
    case 'deflate':
      return createInflate;
    case 'br':
      return createBrotliDecompress;
    default:
      return undefined;
  }
}

function buildHeaders(raw: readonly string[], decoded: boolean): Headers {
  const headers = new Headers();
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    if (decoded && /^content-(encoding|length)$/i.test(name)) continue;
    headers.append(name, raw[i + 1] as string);
  }
  return headers;
}

function toResponse(incoming: IncomingMessage, method: string): Response {
  const status = incoming.statusCode ?? 0;
  if (status < 200 || status > 599) throw new RangeError('unsupported status');
  const decode = method === 'HEAD' ? undefined : decoder(incoming.headers['content-encoding']);
  const headers = buildHeaders(incoming.rawHeaders, decode !== undefined);
  if (method === 'HEAD' || NULL_BODY_STATUSES.has(status)) {
    incoming.resume();
    return new Response(null, { status, headers });
  }
  let source: Readable = incoming;
  if (decode) {
    const stream = decode() as unknown as Readable;
    pipeline(incoming, stream as unknown as NodeJS.WritableStream, () => undefined);
    source = stream;
  }
  return new Response(Readable.toWeb(source) as unknown as ReadableStream<Uint8Array>, {
    status,
    headers,
  });
}

interface Normalized {
  readonly url: URL;
  readonly method: string;
  readonly headers: Headers;
  readonly body: Uint8Array | undefined;
}

async function normalizeRequest(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<Normalized> {
  if (init?.redirect === 'follow') throw new TypeError('redirect follow is not supported');
  const base = input instanceof Request ? input : undefined;
  let url: URL;
  try {
    url = new URL(base ? base.url : input);
  } catch {
    throw new TypeError('invalid url');
  }
  const headers = new Headers(init?.headers ?? base?.headers);
  const method = (init?.method ?? base?.method ?? 'GET').toUpperCase();
  const raw = init?.body ?? (base?.body ? await base.arrayBuffer() : undefined);
  let body: Uint8Array | undefined;
  if (raw !== undefined && raw !== null) {
    if (method === 'GET' || method === 'HEAD') throw new TypeError('request body not allowed');
    if (typeof raw === 'string') {
      body = new TextEncoder().encode(raw);
      if (!headers.has('content-type')) headers.set('content-type', 'text/plain;charset=UTF-8');
    } else if (raw instanceof URLSearchParams) {
      body = new TextEncoder().encode(raw.toString());
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
      }
    } else if (raw instanceof Uint8Array) body = raw;
    else if (raw instanceof ArrayBuffer) body = new Uint8Array(raw);
    else throw new TypeError('unsupported request body');
  }
  return { url, method, headers, body };
}

/**
 * Redirects are never followed, whatever init.redirect or a Request default says;
 * 3xx responses are returned as-is for the caller to vet. An explicit
 * redirect: 'follow' is rejected.
 */
export function createGuardedFetch(
  policy: OutboundPolicy,
  options: GuardedFetchOptions = {},
): FetchLike {
  const { tls, ...guardOptions } = options;
  const guard = createDnsGuard(policy, guardOptions);

  return async (input, init) => {
    const { url, method, headers, body } = await normalizeRequest(input, init);
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw fetchFailed();
    if (signal?.aborted) throw signal.reason;

    const secure = url.protocol === 'https:';
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    const port = url.port === '' ? (secure ? 443 : 80) : Number(url.port);
    const target = guard.forTarget(url.hostname, port);
    const literal = isIP(hostname) !== 0;

    let connectHost = hostname;
    if (literal) {
      let onLiteralAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onLiteralAbort = () => reject(signal?.reason);
        signal?.addEventListener('abort', onLiteralAbort, { once: true });
      });
      aborted.catch(() => undefined);
      try {
        const resolved = await (signal
          ? Promise.race([target.resolve(), aborted])
          : target.resolve());
        connectHost = resolved.addresses[0]?.address ?? hostname;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        throw toTransportError(error);
      } finally {
        if (onLiteralAbort) signal?.removeEventListener('abort', onLiteralAbort);
      }
    }

    if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'gzip, deflate, br');
    const outgoing: OutgoingHttpHeaders = Object.fromEntries(headers);
    outgoing['host'] = url.host;
    if (body !== undefined) outgoing['content-length'] = String(body.byteLength);
    const servername = hostname.replace(/\.$/, '');

    return new Promise<Response>((resolve, reject) => {
      const send = secure ? httpsRequest : httpRequest;
      const req = send({
        host: connectHost,
        port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: outgoing,
        agent: false,
        lookup: target.lookup,
        ...(secure ? { servername: literal ? '' : servername } : {}),
        ...(secure && tls?.ca !== undefined ? { ca: tls.ca } : {}),
      });
      let incoming: IncomingMessage | undefined;

      const abortReason = (): Error =>
        signal?.reason instanceof Error ? signal.reason : new Error('aborted');
      const onAbort = (): void => {
        incoming?.destroy(abortReason());
        req.destroy(abortReason());
        reject(signal?.reason);
      };
      const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
      signal?.addEventListener('abort', onAbort, { once: true });
      req.once('close', cleanup);

      const fail = (error: unknown): void => {
        incoming?.destroy();
        req.destroy();
        cleanup();
        reject(signal?.aborted ? signal.reason : toTransportError(error));
      };

      req.once('upgrade', (_response, socket) => {
        socket.destroy();
        fail(new TransportError('UPGRADE'));
      });
      req.once('response', (message) => {
        incoming = message;
        try {
          resolve(toResponse(message, method));
        } catch (error) {
          fail(error);
        }
      });
      req.once('error', fail);
      req.end(body === undefined ? undefined : Buffer.from(body));
    });
  };
}
