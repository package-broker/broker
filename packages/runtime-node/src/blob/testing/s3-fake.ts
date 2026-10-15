import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const S3_FAKE_ENDPOINT = 'https://s3.fake.test';

export const S3_FAKE_DEFAULT_CREDENTIALS = {
  accessKeyId: 'AKIAFAKEFAKEFAKE0000',
  secretAccessKey: 'fake-secret-access-key',
};
const DEFAULT_BUCKET = 'broker';
const DEFAULT_REGION = 'us-east-1';
const LAST_MODIFIED = '2026-10-16T12:00:00.000Z';
const SUPPORTED_AMZ_HEADERS = new Set([
  'x-amz-date',
  'x-amz-content-sha256',
  'x-amz-copy-source',
  'x-amz-security-token',
  'x-amz-checksum-sha256',
]);
const XML_PREFIX = '\n\n  <?xml version="1.0" encoding="UTF-8"?>';
const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=([^/,\s]+)\/(\d{8})\/([^/,\s]+)\/s3\/aws4_request, ?SignedHeaders=([a-z0-9;-]+), ?Signature=([0-9a-f]{64})$/;

export interface S3FakeFaults {
  copyReturns200Error: boolean;
  rangeIgnored: boolean;
  rangeMismatch: boolean;
  failWith: number | 'SlowDown' | null;
  networkError: boolean;
  redirect: 301 | 307 | null;
}

export interface S3Fake {
  readonly fetch: typeof fetch;
  readonly keys: () => readonly string[];
  readonly faults: S3FakeFaults;
}

export interface S3FakeOptions {
  readonly credentials?: { accessKeyId: string; secretAccessKey: string };
  readonly endpoint?: string;
  readonly bucket?: string;
  readonly region?: string;
  readonly sessionToken?: string;
}

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly etag: string;
}

class Rejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(code);
  }
}

const sha256Hex = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();
const rfc3986 = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

function errorResponse(
  status: number,
  code: string,
  message = code,
  extra: Record<string, string> = {},
): Response {
  const body = `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  return new Response(body, { status, headers: { 'content-type': 'application/xml', ...extra } });
}

async function readBody(request: Request): Promise<Uint8Array> {
  const { signal } = request;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const onAbort = (): void => void reader.cancel(signal.reason).catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new Rejection(400, 'InvalidURI');
  }
}

function canonicalRequest(
  request: Request,
  url: URL,
  signedHeaders: readonly string[],
  payloadHash: string,
): string {
  const path = url.pathname
    .split('/')
    .map((segment) => rfc3986(decode(segment)))
    .join('/');
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const headers = signedHeaders
    .map((name) => {
      const value = name === 'host' ? url.host : request.headers.get(name);
      if (value === null) throw new Rejection(403, 'SignatureDoesNotMatch');
      return `${name}:${value.trim().replace(/\s+/g, ' ')}\n`;
    })
    .join('');
  return `${request.method}\n${path}\n${query}\n${headers}\n${signedHeaders.join(';')}\n${payloadHash}`;
}

function verifySignature(
  request: Request,
  url: URL,
  credentials: { accessKeyId: string; secretAccessKey: string },
  expectedRegion: string,
  sessionToken: string | undefined,
  payloadHash: string,
): void {
  const match = AUTHORIZATION.exec(request.headers.get('authorization') ?? '');
  if (match === null) throw new Rejection(403, 'AccessDenied');
  const [, accessKeyId, date, region, signedList, signature] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  const amzDate = request.headers.get('x-amz-date') ?? '';
  if (!/^\d{8}T\d{6}Z$/.test(amzDate) || !amzDate.startsWith(date))
    throw new Rejection(403, 'AccessDenied');
  if (accessKeyId !== credentials.accessKeyId) throw new Rejection(403, 'InvalidAccessKeyId');
  if (region !== expectedRegion) throw new Rejection(400, 'AuthorizationHeaderMalformed');
  const signedHeaders = signedList.split(';');
  if (signedHeaders.some((name, i) => i > 0 && name <= signedHeaders[i - 1]!)) {
    throw new Rejection(403, 'SignatureDoesNotMatch');
  }
  for (const required of ['host', 'x-amz-date', 'x-amz-content-sha256']) {
    if (!signedHeaders.includes(required)) throw new Rejection(403, 'AccessDenied');
  }
  const explicitHost = request.headers.get('host');
  if (explicitHost !== null && explicitHost !== url.host)
    throw new Rejection(403, 'SignatureDoesNotMatch');
  for (const [name] of request.headers) {
    if (name.startsWith('x-amz-') && !signedHeaders.includes(name))
      throw new Rejection(403, 'AccessDenied');
  }
  if (sessionToken !== undefined && request.headers.get('x-amz-security-token') !== sessionToken) {
    throw new Rejection(403, 'InvalidToken');
  }
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest(request, url, signedHeaders, payloadHash)),
  ].join('\n');
  const key = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, date), region), 's3'),
    'aws4_request',
  );
  const expected = Buffer.from(createHmac('sha256', key).update(stringToSign).digest('hex'));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
    throw new Rejection(403, 'SignatureDoesNotMatch');
}

function parseRange(header: string, size: number): { start: number; end: number } {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (match === null) throw new Rejection(501, 'NotImplemented');
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') throw new Rejection(501, 'NotImplemented');
  let start: number;
  let end: number;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0)
      throw new Rejection(416, 'InvalidRange', { 'content-range': `bytes */${size}` });
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  }
  if (start >= size || start > end)
    throw new Rejection(416, 'InvalidRange', { 'content-range': `bytes */${size}` });
  return { start, end };
}

export function startS3Fake(options: S3FakeOptions = {}): S3Fake {
  const credentials = options.credentials ?? S3_FAKE_DEFAULT_CREDENTIALS;
  const endpoint = new URL(options.endpoint ?? S3_FAKE_ENDPOINT);
  const bucketName = options.bucket ?? DEFAULT_BUCKET;
  const region = options.region ?? DEFAULT_REGION;
  const virtualHosted = endpoint.hostname.startsWith(`${bucketName}.`);
  const objects = new Map<string, StoredObject>();
  const faults: S3FakeFaults = {
    copyReturns200Error: false,
    rangeIgnored: false,
    rangeMismatch: false,
    failWith: null,
    networkError: false,
    redirect: null,
  };

  const locate = (url: URL): { bucket: string; key: string } => {
    const segments = url.pathname.split('/').slice(1).map(decode);
    const bucket = virtualHosted ? bucketName : (segments.shift() ?? '');
    const key = segments.join('/');
    if (bucket === '' || key === '') throw new Rejection(501, 'NotImplemented');
    return { bucket, key };
  };

  function injectedFault(request: Request, key: string): Response | undefined {
    if (!['GET', 'HEAD', 'PUT'].includes(request.method)) return undefined;
    if (faults.networkError) throw new TypeError('fetch failed');
    if (faults.redirect !== null) {
      if (request.redirect === 'error') throw new TypeError('fetch failed');
      return new Response(null, {
        status: faults.redirect,
        headers: { location: `https://redirect.example/${key}` },
      });
    }
    if (faults.failWith !== null) {
      const { failWith } = faults;
      const status = failWith === 'SlowDown' ? 503 : failWith;
      if (request.method === 'HEAD') return new Response(null, { status });
      return errorResponse(status, failWith === 'SlowDown' ? 'SlowDown' : 'InternalError');
    }
    return undefined;
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== endpoint.origin) throw new Rejection(403, 'AccessDenied');
    url.pathname.split('/').forEach(decode);
    const body = await readBody(request);
    const payloadHash = request.headers.get('x-amz-content-sha256') ?? '';
    if (payloadHash.startsWith('STREAMING-')) throw new Rejection(501, 'NotImplemented');
    verifySignature(request, url, credentials, region, options.sessionToken, payloadHash);
    if (request.redirect !== 'manual' && request.redirect !== 'error')
      throw new Rejection(400, 'InvalidRequest');

    const copySource = request.headers.get('x-amz-copy-source');
    const plainPut = request.method === 'PUT' && copySource === null;
    for (const [name, value] of request.headers) {
      if (name.startsWith('x-amz-') && !SUPPORTED_AMZ_HEADERS.has(name))
        throw new Rejection(501, 'NotImplemented');
      if ((name === 'x-amz-checksum-sha256' || name === 'content-md5') && !plainPut)
        throw new Rejection(501, 'NotImplemented');
      if (name.startsWith('if-') && !(name === 'if-none-match' && value === '*' && plainPut)) {
        throw new Rejection(501, 'NotImplemented');
      }
    }
    if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== sha256Hex(body))
      throw new Rejection(400, 'XAmzContentSHA256Mismatch');
    if (url.search !== '') throw new Rejection(501, 'NotImplemented');

    const { bucket, key } = locate(url);
    if (bucket !== bucketName) throw new Rejection(404, 'NoSuchBucket');
    const stored = objects.get(key);

    if (plainPut) {
      const declared = request.headers.get('content-length');
      if (declared === null) throw new Rejection(411, 'MissingContentLength');
      if (!/^\d+$/.test(declared) || Number(declared) !== body.byteLength)
        throw new Rejection(400, 'IncompleteBody');
      const md5 = request.headers.get('content-md5');
      if (md5 !== null && md5 !== createHash('md5').update(body).digest('base64')) {
        throw new Rejection(400, 'BadDigest');
      }
      const checksum = request.headers.get('x-amz-checksum-sha256');
      if (checksum !== null && checksum !== createHash('sha256').update(body).digest('base64')) {
        throw new Rejection(400, 'BadDigest');
      }
    }
    const fault = injectedFault(request, key);
    if (fault !== undefined) return fault;

    switch (request.method) {
      case 'PUT': {
        if (copySource !== null) return copy(copySource, key);
        if (request.headers.get('if-none-match') === '*' && stored !== undefined)
          throw new Rejection(412, 'PreconditionFailed');
        const etag = `"${createHash('md5').update(body).digest('hex')}"`;
        objects.set(key, {
          bytes: body,
          contentType: request.headers.get('content-type') ?? 'binary/octet-stream',
          etag,
        });
        return new Response(null, { status: 200, headers: { etag } });
      }
      case 'GET':
      case 'HEAD': {
        if (stored === undefined) {
          return request.method === 'HEAD'
            ? new Response(null, { status: 404 })
            : errorResponse(404, 'NoSuchKey', 'The specified key does not exist.');
        }
        const size = stored.bytes.byteLength;
        const headers: Record<string, string> = {
          'content-type': stored.contentType,
          etag: stored.etag,
          'accept-ranges': 'bytes',
        };
        const range = request.headers.get('range');
        if (request.method === 'HEAD')
          return new Response(null, {
            status: 200,
            headers: { ...headers, 'content-length': String(size) },
          });
        if (range === null || faults.rangeIgnored) {
          return new Response(stored.bytes, {
            status: 200,
            headers: { ...headers, 'content-length': String(size) },
          });
        }
        const { start, end } = parseRange(range, size);
        const slice = stored.bytes.slice(start, end + 1);
        const reported = faults.rangeMismatch ? `${start + 1}-${end + 1}` : `${start}-${end}`;
        return new Response(slice, {
          status: 206,
          headers: {
            ...headers,
            'content-length': String(slice.byteLength),
            'content-range': `bytes ${reported}/${size}`,
          },
        });
      }
      case 'DELETE':
        objects.delete(key);
        return new Response(null, { status: 204 });
      default:
        throw new Rejection(501, 'NotImplemented');
    }
  }

  function copy(copySource: string, key: string): Response {
    if (copySource.includes('?')) throw new Rejection(501, 'NotImplemented');
    const [sourceBucket, ...sourceParts] = decode(copySource.replace(/^\//, '')).split('/');
    const sourceKey = sourceParts.join('/');
    if (sourceBucket === undefined || sourceKey === '') throw new Rejection(400, 'InvalidArgument');
    if (sourceBucket !== bucketName) throw new Rejection(404, 'NoSuchBucket');
    if (sourceKey === key) throw new Rejection(400, 'InvalidRequest');
    const source = objects.get(sourceKey);
    if (source === undefined) throw new Rejection(404, 'NoSuchKey');
    if (faults.copyReturns200Error) {
      return new Response(
        `${XML_PREFIX}<Error><Code>InternalError</Code><Message>We encountered an internal error. Please try again.</Message></Error>`,
        { status: 200, headers: { 'content-type': 'application/xml' } },
      );
    }
    objects.set(key, source);
    return new Response(
      `${XML_PREFIX}<CopyObjectResult><ETag>${source.etag}</ETag><LastModified>${LAST_MODIFIED}</LastModified></CopyObjectResult>`,
      { status: 200, headers: { 'content-type': 'application/xml' } },
    );
  }

  const fakeFetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    try {
      const request = new Request(input, init);
      request.signal.throwIfAborted();
      return await handle(request);
    } catch (error) {
      if (error instanceof Rejection)
        return errorResponse(error.status, error.code, error.code, error.headers);
      throw error;
    }
  }) as typeof fetch;

  return { fetch: fakeFetch, faults, keys: () => [...objects.keys()].sort() };
}
