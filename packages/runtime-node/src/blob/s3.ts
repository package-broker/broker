import { createHash, randomUUID } from 'node:crypto';
import { AwsV4Signer } from 'aws4fetch';
import { BlobSizeMismatchError, BlobValidationError } from '@package-broker/core/platform/blob';
import type { ByteRange, ByteStore } from '@package-broker/core/platform/blob';

export interface S3ByteStoreOptions {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly sessionToken?: string;
  readonly pathStyle?: boolean;
  readonly allowInsecureHttp?: boolean;
  readonly fetch?: typeof fetch;
}

export class S3ConfigError extends Error {
  override name = 'S3ConfigError';
  constructor(readonly field: string) {
    super(`invalid S3 storage configuration: ${field}`);
  }
}

export class S3SigningError extends Error {
  override name = 'S3SigningError';
  constructor() {
    super('S3 request signing failed');
  }
}

export class S3RequestError extends Error {
  override name = 'S3RequestError';
  constructor(readonly status: number) {
    super(`S3 request failed with status ${status}`);
  }
}

export class S3CopyError extends Error {
  override name = 'S3CopyError';
  constructor() {
    super('S3 CopyObject did not confirm the copy');
  }
}

export class S3UploadIncompleteError extends Error {
  override name = 'S3UploadIncompleteError';
  constructor() {
    super('S3 answered the staging upload before the body was verified');
  }
}

export class S3IntegrityError extends Error {
  override name = 'S3IntegrityError';
  constructor() {
    super('existing S3 object does not match the expected digest');
  }
}

const DEFAULT_MEDIA_TYPE = 'application/octet-stream';
const STAGING_PREFIX = 'staging/';
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const COPY_RESPONSE_LIMIT = 64 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/;
const SAFE_KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const CONTENT_RANGE = /^bytes (\d+)-(\d+)\/(\d+)$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const COPY_CHILDREN = new Set([
  'ETag',
  'LastModified',
  'ChecksumCRC32',
  'ChecksumCRC32C',
  'ChecksumSHA1',
  'ChecksumSHA256',
  'ChecksumCRC64NVME',
  'ChecksumType',
]);
const XML_DECLARATION =
  /^<\?xml\s+version=(["'])1\.[0-9]\1(?:\s+encoding=(["'])[A-Za-z][A-Za-z0-9._-]*\2)?(?:\s+standalone=(["'])(?:yes|no)\3)?\s*\?>/;
const COPY_ROOT_OPEN = /^<CopyObjectResult(?:\s+xmlns=(?:"[^"<>&]*"|'[^'<>&]*'))?\s*>/;
const COPY_ROOT_CLOSE = /^<\/CopyObjectResult\s*>/;
const COPY_CHILD = /^<([A-Za-z][A-Za-z0-9]*)>([^<]*)<\/\1>/;
const XML_TEXT = /^(?:[^&<]|&(?:amp|lt|gt|quot|apos|#[0-9]{1,7}|#x[0-9A-Fa-f]{1,6});)*$/;
const CHAR_REFERENCE = /&#(x[0-9A-Fa-f]+|[0-9]+);/g;

const isXmlChar = (code: number): boolean =>
  code === 0x9 ||
  code === 0xa ||
  code === 0xd ||
  (code >= 0x20 && code <= 0xd7ff) ||
  (code >= 0xe000 && code <= 0xfffd) ||
  (code >= 0x10000 && code <= 0x10ffff);

function isXmlText(value: string): boolean {
  if (!XML_TEXT.test(value) || value.includes(']]>')) return false;
  for (const char of value) {
    if (!isXmlChar(char.codePointAt(0) ?? 0)) return false;
  }
  for (const [, reference] of value.matchAll(CHAR_REFERENCE)) {
    const code = reference!.startsWith('x')
      ? Number.parseInt(reference!.slice(1), 16)
      : Number.parseInt(reference!, 10);
    if (!isXmlChar(code)) return false;
  }
  return true;
}

type Init = RequestInit & { duplex?: 'half' };

interface VerifierState {
  completed: boolean;
  error: Error | null;
}

interface ObjectHead {
  readonly size: number;
  readonly mediaType: string;
  readonly checksum: string | null;
}

function validateKey(storageKey: string): void {
  if (!SAFE_KEY.test(storageKey) || storageKey.split('/').some((s) => s === '.' || s === '..')) {
    throw new BlobValidationError();
  }
}

const isLoopback = (hostname: string): boolean =>
  hostname === 'localhost' || hostname === '[::1]' || /^127(\.\d{1,3}){3}$/.test(hostname);

function parseEndpoint(endpoint: string, allowInsecureHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new S3ConfigError('endpoint');
  }
  const secure = url.protocol === 'https:';
  const plain = url.protocol === 'http:' && (allowInsecureHttp || isLoopback(url.hostname));
  if (!secure && !plain) throw new S3ConfigError('endpoint');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new S3ConfigError('endpoint');
  }
  if (url.pathname !== '/') throw new S3ConfigError('endpoint');
  return url;
}

function validateBucket(bucket: string, virtualHostedHttps: boolean): void {
  if (
    !BUCKET.test(bucket) ||
    bucket.includes('..') ||
    bucket.includes('.-') ||
    bucket.includes('-.') ||
    IPV4.test(bucket) ||
    bucket.startsWith('xn--') ||
    bucket.endsWith('-s3alias') ||
    (virtualHostedHttps && bucket.includes('.'))
  ) {
    throw new S3ConfigError('bucket');
  }
}

const CREDENTIAL_LIMITS = { accessKeyId: 128, secretAccessKey: 512, sessionToken: 16384 } as const;
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

function validateCredentials(options: S3ByteStoreOptions): void {
  for (const field of ['accessKeyId', 'secretAccessKey', 'sessionToken'] as const) {
    const value: unknown = options[field];
    if (value === undefined && field === 'sessionToken') continue;
    if (
      typeof value !== 'string' ||
      value.length > CREDENTIAL_LIMITS[field] ||
      !PRINTABLE_ASCII.test(value)
    ) {
      throw new S3ConfigError(field);
    }
  }
}

function sizeHeader(response: Response, name: string): number {
  const text = response.headers.get(name);
  if (text === null || !/^\d+$/.test(text)) throw new S3RequestError(response.status);
  const value = Number(text);
  if (!Number.isSafeInteger(value)) throw new S3RequestError(response.status);
  return value;
}

const mediaTypeOf = (response: Response): string =>
  response.headers.get('content-type') ?? DEFAULT_MEDIA_TYPE;

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

function exactLength(length: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      seen += chunk.length;
      if (seen > length) {
        controller.error(new BlobSizeMismatchError());
        return;
      }
      controller.enqueue(chunk);
    },
    flush(controller) {
      if (seen !== length) controller.error(new BlobSizeMismatchError());
    },
  });
}

async function readBounded(response: Response, limit: number): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      throw new S3CopyError();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function isCopyConfirmed(text: string): boolean {
  let rest = text.trimStart();
  const declaration = XML_DECLARATION.exec(rest);
  if (declaration !== null) rest = rest.slice(declaration[0].length).trimStart();
  const open = COPY_ROOT_OPEN.exec(rest);
  if (open === null) return false;
  rest = rest.slice(open[0].length);
  const seen = new Set<string>();
  for (;;) {
    rest = rest.trimStart();
    const close = COPY_ROOT_CLOSE.exec(rest);
    if (close !== null) return seen.has('ETag') && rest.slice(close[0].length).trim() === '';
    const child = COPY_CHILD.exec(rest);
    if (child === null) return false;
    const [whole, name = '', value = ''] = child;
    if (!COPY_CHILDREN.has(name) || seen.has(name) || !isXmlText(value)) return false;
    seen.add(name);
    rest = rest.slice(whole.length);
  }
}

function verifyingBody(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  expected: { sha256: string; size: number },
  state: VerifierState,
): ReadableStream<Uint8Array> {
  const hash = createHash('sha256');
  let seen = 0;
  let held: Uint8Array | null = null;
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>, error: Error): void => {
    state.error = error;
    controller.error(error);
    void reader.cancel(error).catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            if (seen !== expected.size) return fail(controller, new BlobSizeMismatchError());
            if (hash.digest('hex') !== expected.sha256) {
              return fail(controller, new BlobValidationError());
            }
            state.completed = true;
            if (held !== null) controller.enqueue(held);
            controller.close();
            return;
          }
          if (value.length === 0) continue;
          seen += value.length;
          if (seen > expected.size) return fail(controller, new BlobSizeMismatchError());
          hash.update(value);
          const previous = held;
          held = value;
          if (previous !== null) {
            controller.enqueue(previous);
            return;
          }
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

export function createS3ByteStore(options: S3ByteStoreOptions): ByteStore {
  validateCredentials(options);
  const endpoint = parseEndpoint(options.endpoint, options.allowInsecureHttp ?? false);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const pathStyle = options.pathStyle ?? false;
  validateBucket(options.bucket, !pathStyle && endpoint.protocol === 'https:');
  const base = new URL(endpoint.origin);
  if (!pathStyle) {
    base.hostname = `${options.bucket}.${endpoint.hostname}`;
    if (base.host !== `${options.bucket}.${endpoint.host}`) throw new S3ConfigError('bucket');
  }
  const bucketPath = pathStyle ? `/${options.bucket}` : '';

  const encodeKey = (storageKey: string): string =>
    storageKey.split('/').map(encodeURIComponent).join('/');
  const objectUrl = (storageKey: string): URL => {
    validateKey(storageKey);
    return new URL(`${bucketPath}/${encodeKey(storageKey)}`, base);
  };

  async function send(
    method: string,
    storageKey: string,
    headers: Record<string, string> = {},
    upload?: { body: ReadableStream<Uint8Array>; signal: AbortSignal },
  ): Promise<Response> {
    const url = objectUrl(storageKey);
    let signed: { url: URL; headers: Headers };
    try {
      signed = await new AwsV4Signer({
        method,
        url: url.toString(),
        headers:
          upload === undefined ? { 'x-amz-content-sha256': EMPTY_SHA256, ...headers } : headers,
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
        ...(options.sessionToken === undefined ? {} : { sessionToken: options.sessionToken }),
        service: 's3',
        region: options.region,
      }).sign();
    } catch {
      throw new S3SigningError();
    }
    if (signed.url.origin !== base.origin) throw new S3ConfigError('endpoint');
    const init: Init = { method, headers: signed.headers, redirect: 'manual' };
    if (upload !== undefined) {
      init.body = upload.body;
      init.duplex = 'half';
      init.signal = upload.signal;
    }
    return fetchImpl(signed.url.toString(), init);
  }

  async function expectStatus(response: Response, allowed: readonly number[]): Promise<void> {
    await discard(response);
    if (!allowed.includes(response.status)) throw new S3RequestError(response.status);
  }

  let checksumModeSupported = true;

  async function headObject(storageKey: string, askChecksum = false): Promise<ObjectHead | null> {
    const checksumMode = askChecksum && checksumModeSupported;
    const response = await send(
      'HEAD',
      storageKey,
      checksumMode ? { 'x-amz-checksum-mode': 'ENABLED' } : {},
    );
    if (checksumMode && (response.status === 400 || response.status === 501)) {
      await discard(response);
      checksumModeSupported = false;
      return headObject(storageKey);
    }
    await expectStatus(response, [200, 404]);
    if (response.status === 404) return null;
    return {
      size: sizeHeader(response, 'content-length'),
      mediaType: mediaTypeOf(response),
      checksum: response.headers.get('x-amz-checksum-sha256'),
    };
  }

  async function remove(storageKey: string): Promise<void> {
    await expectStatus(await send('DELETE', storageKey), [200, 204, 404]);
  }

  async function hashObject(storageKey: string, size: number): Promise<string> {
    const response = await send('GET', storageKey);
    const stream = response.body;
    if (response.status !== 200 || stream === null) {
      await discard(response);
      throw new S3RequestError(response.status);
    }
    const hash = createHash('sha256');
    const reader = stream.pipeThrough(exactLength(size)).getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    return hash.digest('hex');
  }

  async function verifyExisting(
    storageKey: string,
    existing: ObjectHead,
    expected: { sha256: string; size: number },
  ): Promise<void> {
    if (existing.size !== expected.size) throw new BlobSizeMismatchError();
    if (existing.checksum !== null && SHA256_BASE64.test(existing.checksum)) {
      const stored = Buffer.from(existing.checksum, 'base64').toString('hex');
      if (stored !== expected.sha256) throw new S3IntegrityError();
      return;
    }
    if ((await hashObject(storageKey, expected.size)) !== expected.sha256) {
      throw new S3IntegrityError();
    }
  }

  async function copy(sourceKey: string, targetKey: string): Promise<void> {
    const response = await send('PUT', targetKey, {
      'x-amz-copy-source': `/${options.bucket}/${encodeKey(sourceKey)}`,
    });
    if (response.status !== 200) {
      await discard(response);
      throw new S3RequestError(response.status);
    }
    if (!isCopyConfirmed(await readBounded(response, COPY_RESPONSE_LIMIT))) {
      throw new S3CopyError();
    }
  }

  async function stage(
    stagingKey: string,
    body: ReadableStream<Uint8Array>,
    input: { sha256: string; size: number; mediaType: string },
    verifier: VerifierState,
    signal: AbortSignal,
  ): Promise<void> {
    let response: Response;
    try {
      response = await send(
        'PUT',
        stagingKey,
        {
          'content-length': String(input.size),
          'content-type': input.mediaType,
          'x-amz-content-sha256': 'UNSIGNED-PAYLOAD',
          'x-amz-checksum-sha256': Buffer.from(input.sha256, 'hex').toString('base64'),
        },
        { body, signal },
      );
    } catch (error) {
      throw verifier.error ?? error;
    }
    await discard(response);
    if (verifier.error !== null) throw verifier.error;
    if (response.status !== 200) throw new S3RequestError(response.status);
    if (!verifier.completed) throw new S3UploadIncompleteError();
  }

  return Object.freeze({
    async putVerified(storageKey, source, input) {
      validateKey(storageKey);
      if (
        !SHA256_HEX.test(input.sha256) ||
        !storageKey.endsWith(`/${input.sha256}`) ||
        storageKey.startsWith(STAGING_PREFIX)
      ) {
        throw new BlobValidationError();
      }
      const stagingKey = `${STAGING_PREFIX}${randomUUID()}`;
      const abort = new AbortController();
      const verifier: VerifierState = { completed: false, error: null };
      const reader = source.getReader();
      const body = verifyingBody(reader, input, verifier);
      try {
        await stage(stagingKey, body, input, verifier, abort.signal);
        const existing = await headObject(storageKey, true);
        let mediaType = input.mediaType;
        if (existing === null) {
          await copy(stagingKey, storageKey);
        } else {
          await verifyExisting(storageKey, existing, input);
          mediaType = existing.mediaType;
        }
        await remove(stagingKey).catch(() => undefined);
        return { size: input.size, mediaType };
      } catch (error) {
        abort.abort();
        await reader.cancel().catch(() => undefined);
        await remove(stagingKey).catch(() => undefined);
        throw error;
      }
    },

    async get(storageKey, range?: ByteRange) {
      const headers: Record<string, string> =
        range === undefined
          ? {}
          : { range: `bytes=${range.offset}-${range.offset + range.length - 1}` };
      const response = await send('GET', storageKey, headers);
      if (response.status === 404) {
        await discard(response);
        return null;
      }
      try {
        const stream = response.body;
        if (range === undefined) {
          if (response.status !== 200 || stream === null) throw new S3RequestError(response.status);
          const size = sizeHeader(response, 'content-length');
          return {
            size,
            mediaType: mediaTypeOf(response),
            range: null,
            body: stream.pipeThrough(exactLength(size)),
          };
        }
        if (response.status === 200) throw new BlobSizeMismatchError();
        if (response.status !== 206 || stream === null) throw new S3RequestError(response.status);
        const match = CONTENT_RANGE.exec(response.headers.get('content-range') ?? '');
        const start = Number(match?.[1]);
        const end = Number(match?.[2]);
        const total = Number(match?.[3]);
        const declared = response.headers.get('content-length');
        if (
          match === null ||
          start !== range.offset ||
          end !== range.offset + range.length - 1 ||
          !Number.isSafeInteger(total) ||
          end >= total ||
          (declared !== null && declared !== String(range.length))
        ) {
          throw new BlobSizeMismatchError();
        }
        return {
          size: total,
          mediaType: mediaTypeOf(response),
          range: { offset: range.offset, length: range.length },
          body: stream.pipeThrough(exactLength(range.length)),
        };
      } catch (error) {
        await discard(response);
        throw error;
      }
    },

    async head(storageKey) {
      const found = await headObject(storageKey);
      return found === null ? null : { size: found.size, mediaType: found.mediaType };
    },

    remove,
  } satisfies ByteStore);
}
