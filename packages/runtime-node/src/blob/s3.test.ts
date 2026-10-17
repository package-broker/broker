import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AwsV4Signer } from 'aws4fetch';
import { describe, expect, it } from 'vitest';
import {
  BlobSizeMismatchError,
  BlobValidationError,
  parseSha256,
} from '@package-broker/core/platform/blob';
import {
  S3ConfigError,
  S3CopyError,
  S3IntegrityError,
  S3SigningError,
  S3UploadIncompleteError,
  createS3ByteStore,
} from './s3.js';
import type { S3ByteStoreOptions } from './s3.js';
import { S3_FAKE_DEFAULT_CREDENTIALS, startS3Fake } from './testing/s3-fake.js';
import type { S3Fake, S3FakeOptions } from './testing/s3-fake.js';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
  readonly init: RequestInit | undefined;
}

type Intercept = (call: Call, fake: S3Fake) => Response | Promise<Response> | undefined;

async function withoutChecksum(call: Call, fake: S3Fake): Promise<Response> {
  const response = await fake.fetch(call.url, call.init);
  const headers = new Headers(response.headers);
  headers.delete('x-amz-checksum-sha256');
  return new Response(response.body, { status: response.status, headers });
}

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const encoder = new TextEncoder();
const digestOf = (bytes: Uint8Array) =>
  parseSha256(createHash('sha256').update(bytes).digest('hex'));
const finalKeyOf = (bytes: Uint8Array) => {
  const digest = digestOf(bytes);
  return `sha256/6f7267/${digest.slice(0, 2)}/${digest}`;
};

interface Source {
  readonly stream: ReadableStream<Uint8Array>;
  readonly state: { cancelled: boolean };
}

function source(chunks: readonly Uint8Array[], failAfter?: number): Source {
  const state = { cancelled: false };
  let at = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (failAfter !== undefined && at >= failAfter) {
        controller.error(new Error('upstream failed'));
        return;
      }
      const next = chunks[at];
      at += 1;
      if (next === undefined) controller.close();
      else controller.enqueue(next);
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

const chunked = (chunks: readonly Uint8Array[], failAfter?: number) =>
  source(chunks, failAfter).stream;

const split = (bytes: Uint8Array, size: number): Uint8Array[] => {
  const parts: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) parts.push(bytes.slice(i, i + size));
  return parts;
};

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

function trackedBody(text: string): {
  body: ReadableStream<Uint8Array>;
  state: { cancelled: boolean };
} {
  const state = { cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { body, state };
}

const isCopy = (call: Call) => call.headers.has('x-amz-copy-source');
const isStagingPut = (call: Call) =>
  call.method === 'PUT' && !isCopy(call) && call.url.includes('/staging/');
const isFinal = (call: Call, method: string) =>
  call.method === method && !call.url.includes('/staging/');

function setup(
  fakeOptions: S3FakeOptions = {},
  storeOptions: Partial<S3ByteStoreOptions> = {},
  intercept?: Intercept,
) {
  const fake = startS3Fake(fakeOptions);
  const calls: Call[] = [];
  const recordingFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const call = { url, method: init?.method ?? 'GET', headers: new Headers(init?.headers), init };
    calls.push(call);
    const intercepted = intercept?.(call, fake);
    if (intercepted !== undefined) return intercepted;
    return fake.fetch(input, init);
  }) as typeof fetch;
  const store = createS3ByteStore({
    endpoint: 'https://s3.fake.test',
    region: 'us-east-1',
    bucket: 'broker',
    ...S3_FAKE_DEFAULT_CREDENTIALS,
    pathStyle: true,
    fetch: recordingFetch,
    ...storeOptions,
  });
  return { fake, calls, store };
}

const body = encoder.encode('package archive bytes, 0123456789');
const input = { sha256: digestOf(body), size: body.length, mediaType: 'application/zip' };

describe('createS3ByteStore', () => {
  it('stages, verifies, copies to the final key and removes staging', async () => {
    const { fake, calls, store } = setup();
    const key = finalKeyOf(body);
    await expect(store.putVerified(key, chunked(split(body, 5)), input)).resolves.toEqual({
      size: body.length,
      mediaType: 'application/zip',
    });
    expect(fake.keys()).toEqual([key]);
    const staging = calls[0]!;
    expect(staging.method).toBe('PUT');
    expect(staging.url).toMatch(/^https:\/\/s3\.fake\.test\/broker\/staging\/[0-9a-f-]{36}$/);
    expect(staging.headers.get('x-amz-content-sha256')).toBe('UNSIGNED-PAYLOAD');
    expect(staging.headers.get('x-amz-checksum-sha256')).toBe(
      createHash('sha256').update(body).digest('base64'),
    );
    expect(staging.headers.get('content-length')).toBe(String(body.length));
    expect(staging.init?.body).toBeInstanceOf(ReadableStream);
    expect((staging.init as { duplex?: string }).duplex).toBe('half');
    const stagingPath = new URL(staging.url).pathname;
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      `PUT ${stagingPath}`,
      `HEAD /broker/${key}`,
      `PUT /broker/${key}`,
      `DELETE ${stagingPath}`,
    ]);
    expect(calls[2]!.headers.get('x-amz-copy-source')).toBe(stagingPath);
    const read = await store.get(key);
    expect(read).toMatchObject({ size: body.length, mediaType: 'application/zip', range: null });
    expect(await readAll(read!.body)).toBe(new TextDecoder().decode(body));
  });

  it('signs bodiless requests with the empty-payload digest', async () => {
    const { calls, store } = setup();
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    await store.get(key);
    await store.get(key, { offset: 0, length: 2 });
    await store.head(key);
    await store.remove(key);
    const bodiless = calls.filter((c) => !isStagingPut(c));
    expect(bodiless.length).toBeGreaterThan(5);
    for (const call of bodiless)
      expect(call.headers.get('x-amz-content-sha256')).toBe(EMPTY_SHA256);
  });

  it('round-trips an empty object', async () => {
    const { fake, store } = setup();
    const empty = new Uint8Array();
    const key = finalKeyOf(empty);
    await store.putVerified(key, chunked([]), {
      sha256: digestOf(empty),
      size: 0,
      mediaType: 'application/octet-stream',
    });
    expect(fake.keys()).toEqual([key]);
    expect(await store.head(key)).toEqual({ size: 0, mediaType: 'application/octet-stream' });
  });

  it('rejects a digest mismatch before CopyObject and cleans staging', async () => {
    const { fake, calls, store } = setup();
    const key = finalKeyOf(body);
    const wrong = { ...input, sha256: digestOf(encoder.encode('other')) };
    await expect(
      store.putVerified(`sha256/6f7267/00/${wrong.sha256}`, chunked(split(body, 4)), wrong),
    ).rejects.toBeInstanceOf(BlobValidationError);
    expect(calls.some(isCopy)).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/staging/'))).toBe(true);
    expect(fake.keys()).toEqual([]);
    expect(key).not.toContain(wrong.sha256);
  });

  it('rejects an early EOF and an overflow before CopyObject', async () => {
    const { fake, calls, store } = setup();
    const key = finalKeyOf(body);
    await expect(
      store.putVerified(key, chunked([body.slice(0, 10)]), input),
    ).rejects.toBeInstanceOf(BlobSizeMismatchError);
    await expect(
      store.putVerified(key, chunked([body, encoder.encode('x')]), input),
    ).rejects.toBeInstanceOf(BlobSizeMismatchError);
    expect(calls.some(isCopy)).toBe(false);
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(2);
    expect(fake.keys()).toEqual([]);
  });

  it('propagates an upstream stream failure and cleans staging', async () => {
    const { fake, calls, store } = setup();
    await expect(
      store.putVerified(finalKeyOf(body), chunked(split(body, 4), 2), input),
    ).rejects.toThrow('upstream failed');
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/staging/'))).toBe(true);
    expect(calls.some(isCopy)).toBe(false);
    expect(fake.keys()).toEqual([]);
  });

  it('refuses to promote when staging answered before the verifier completed', async () => {
    const { fake, calls, store } = setup({}, {}, (call) =>
      isStagingPut(call) ? new Response(null, { status: 200 }) : undefined,
    );
    const upload = source(split(body, 2));
    await expect(store.putVerified(finalKeyOf(body), upload.stream, input)).rejects.toBeInstanceOf(
      S3UploadIncompleteError,
    );
    expect(upload.state.cancelled).toBe(true);
    expect(calls.some(isCopy)).toBe(false);
    expect(calls.some((c) => c.method === 'HEAD')).toBe(false);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/staging/'))).toBe(true);
    expect(fake.keys()).toEqual([]);
  });

  it('cancels the caller source when the staging request fails', async () => {
    const { calls, store } = setup({}, {}, (call) => {
      if (isStagingPut(call)) throw new TypeError('fetch failed');
      return undefined;
    });
    const upload = source(split(body, 2));
    await expect(store.putVerified(finalKeyOf(body), upload.stream, input)).rejects.toThrow(
      'fetch failed',
    );
    expect(upload.state.cancelled).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/staging/'))).toBe(true);
  });

  it('treats a CopyObject HTTP-200 <Error> body as failure', async () => {
    const { fake, store } = setup();
    fake.faults.copyReturns200Error = true;
    const key = finalKeyOf(body);
    await expect(store.putVerified(key, chunked([body]), input)).rejects.toBeInstanceOf(
      S3CopyError,
    );
    expect(fake.keys()).toEqual([]);
    expect(await store.head(key)).toBeNull();
  });

  describe('CopyObject response parsing', () => {
    const copyCases: readonly [string, () => Response][] = [
      ['truncated', () => new Response('<CopyObjectResult><ETag>"e"</ETag>', { status: 200 })],
      [
        'comment-embedded',
        () =>
          new Response(
            '<Response><!--<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult>--></Response>',
            {
              status: 200,
            },
          ),
      ],
      [
        'comment inside the result',
        () =>
          new Response('<CopyObjectResult><!-- x --><ETag>"e"</ETag></CopyObjectResult>', {
            status: 200,
          }),
      ],
      [
        'trailing error after the result',
        () =>
          new Response(
            '<CopyObjectResult><ETag>"e"</ETag></CopyObjectResult><Error><Code>X</Code></Error>',
            { status: 200 },
          ),
      ],
      [
        'without an ETag',
        () => new Response('<CopyObjectResult></CopyObjectResult>', { status: 200 }),
      ],
      [
        'NUL character reference',
        () =>
          new Response('<CopyObjectResult><ETag>&#0;</ETag></CopyObjectResult>', { status: 200 }),
      ],
      [
        'out-of-range character reference',
        () =>
          new Response('<CopyObjectResult><ETag>&#x110000;</ETag></CopyObjectResult>', {
            status: 200,
          }),
      ],
      [
        'CDATA terminator in text',
        () =>
          new Response('<CopyObjectResult><ETag>"e"]]></ETag></CopyObjectResult>', {
            status: 200,
          }),
      ],
      [
        'control character in text',
        () =>
          new Response('<CopyObjectResult><ETag>"e\u0001"</ETag></CopyObjectResult>', {
            status: 200,
          }),
      ],
      [
        'oversized',
        () =>
          new Response(
            `<CopyObjectResult><ETag>"e"</ETag>${' '.repeat(70 * 1024)}</CopyObjectResult>`,
            { status: 200 },
          ),
      ],
      [
        'non-200',
        () =>
          new Response('<Error><Code>SlowDown</Code></Error>', {
            status: 503,
          }),
      ],
    ];
    it.each(copyCases)('fails a %s copy response and cleans staging', async (_name, respond) => {
      const { fake, store } = setup({}, {}, (call) => (isCopy(call) ? respond() : undefined));
      const key = finalKeyOf(body);
      await expect(store.putVerified(key, chunked([body]), input)).rejects.toThrow();
      expect(fake.keys()).toEqual([]);
    });

    it('accepts a single-quoted namespace', async () => {
      const { fake, store } = setup({}, {}, (call) =>
        isCopy(call)
          ? new Response(
              '<CopyObjectResult xmlns=\'http://s3.amazonaws.com/doc/2006-03-01/\'><ETag>"e"</ETag></CopyObjectResult>',
              { status: 200 },
            )
          : undefined,
      );
      await store.putVerified(finalKeyOf(body), chunked([body]), input);
      expect(fake.keys()).toEqual([]);
    });

    it('accepts a namespaced document with an XML declaration', async () => {
      const { fake, store } = setup({}, {}, (call) =>
        isCopy(call)
          ? new Response(
              '<?xml version="1.0" encoding="UTF-8"?>\n<CopyObjectResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LastModified>2026-10-16T12:00:00.000Z</LastModified><ETag>"e"</ETag></CopyObjectResult>',
              { status: 200 },
            )
          : undefined,
      );
      await store.putVerified(finalKeyOf(body), chunked([body]), input);
      expect(fake.keys()).toEqual([]);
    });
  });

  it('reuses an existing final object only after verifying the new stream and hashing the stored bytes when no checksum is returned', async () => {
    const { fake, calls, store } = setup({}, {}, (call, s3) =>
      isFinal(call, 'HEAD') ? withoutChecksum(call, s3) : undefined,
    );
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    calls.length = 0;
    await expect(store.putVerified(key, chunked([body]), input)).resolves.toEqual({
      size: body.length,
      mediaType: 'application/zip',
    });
    expect(calls.some(isCopy)).toBe(false);
    expect(calls.some((c) => isFinal(c, 'GET'))).toBe(true);
    await expect(store.putVerified(key, chunked([body.slice(0, 3)]), input)).rejects.toBeInstanceOf(
      BlobSizeMismatchError,
    );
    expect(fake.keys()).toEqual([key]);
  });

  it('refuses an existing final object whose size differs', async () => {
    const key = finalKeyOf(body);
    let armed = false;
    const { fake, calls, store } = setup({}, {}, (call) =>
      armed && isFinal(call, 'HEAD')
        ? new Response(null, {
            status: 200,
            headers: {
              'content-length': String(body.length + 1),
              'content-type': 'application/zip',
            },
          })
        : undefined,
    );
    await store.putVerified(key, chunked([body]), input);
    armed = true;
    calls.length = 0;
    await expect(store.putVerified(key, chunked([body]), input)).rejects.toBeInstanceOf(
      BlobSizeMismatchError,
    );
    expect(calls.some(isCopy)).toBe(false);
    expect(fake.keys()).toEqual([key]);
  });

  it('refuses an existing final object whose stored checksum differs', async () => {
    const key = finalKeyOf(body);
    let armed = false;
    const { fake, calls, store } = setup({}, {}, (call) =>
      armed && isFinal(call, 'HEAD')
        ? new Response(null, {
            status: 200,
            headers: {
              'content-length': String(body.length),
              'x-amz-checksum-sha256': createHash('sha256').update('other').digest('base64'),
            },
          })
        : undefined,
    );
    await store.putVerified(key, chunked([body]), input);
    armed = true;
    calls.length = 0;
    await expect(store.putVerified(key, chunked([body]), input)).rejects.toBeInstanceOf(
      S3IntegrityError,
    );
    expect(calls.some(isCopy)).toBe(false);
    expect(fake.keys()).toEqual([key]);
  });

  it('refuses an existing final object whose bytes hash differently', async () => {
    const key = finalKeyOf(body);
    let armed = false;
    const { fake, calls, store } = setup({}, {}, (call, s3) =>
      isFinal(call, 'HEAD')
        ? withoutChecksum(call, s3)
        : armed && isFinal(call, 'GET')
          ? new Response(new Uint8Array(body.length), {
              status: 200,
              headers: { 'content-length': String(body.length) },
            })
          : undefined,
    );
    await store.putVerified(key, chunked([body]), input);
    armed = true;
    calls.length = 0;
    await expect(store.putVerified(key, chunked([body]), input)).rejects.toBeInstanceOf(
      S3IntegrityError,
    );
    expect(calls.some(isCopy)).toBe(false);
    expect(fake.keys()).toEqual([key]);
    armed = false;
    expect(await readAll((await store.get(key))!.body)).toBe(new TextDecoder().decode(body));
  });

  it('only accepts a final key that ends with the digest outside the staging prefix', async () => {
    const { calls, store } = setup();
    await expect(
      store.putVerified('sha256/6f7267/00/other', chunked([body]), input),
    ).rejects.toBeInstanceOf(BlobValidationError);
    await expect(
      store.putVerified(`staging/${input.sha256}`, chunked([body]), input),
    ).rejects.toBeInstanceOf(BlobValidationError);
    expect(calls).toEqual([]);
  });

  it('serves a ranged read with the total size and type', async () => {
    const { store } = setup();
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    const read = await store.get(key, { offset: 2, length: 4 });
    expect(read).toMatchObject({
      size: body.length,
      mediaType: 'application/zip',
      range: { offset: 2, length: 4 },
    });
    expect(await readAll(read!.body)).toBe('ckag');
  });

  it('fails a ranged read answered with 200 or a mismatched Content-Range', async () => {
    const { fake, store } = setup();
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    fake.faults.rangeIgnored = true;
    await expect(store.get(key, { offset: 2, length: 4 })).rejects.toThrow();
    fake.faults.rangeIgnored = false;
    fake.faults.rangeMismatch = true;
    await expect(store.get(key, { offset: 2, length: 4 })).rejects.toThrow();
  });

  describe('response hygiene', () => {
    const key = finalKeyOf(body);
    const getWith = (respond: () => Response) =>
      setup({}, {}, (call) => (call.method === 'GET' ? respond() : undefined));

    it.each([
      ['missing', {}],
      ['invalid', { 'content-length': 'abc' }],
    ])('discards a full GET with a %s Content-Length', async (_name, headers) => {
      const tracked = trackedBody('bytes');
      const { store } = getWith(() => new Response(tracked.body, { status: 200, headers }));
      await expect(store.get(key)).rejects.toThrow();
      expect(tracked.state.cancelled).toBe(true);
    });

    it('discards a ranged GET whose Content-Length differs from the range', async () => {
      const tracked = trackedBody('abcd');
      const { store } = getWith(
        () =>
          new Response(tracked.body, {
            status: 206,
            headers: { 'content-range': 'bytes 2-5/34', 'content-length': '99' },
          }),
      );
      await expect(store.get(key, { offset: 2, length: 4 })).rejects.toBeInstanceOf(
        BlobSizeMismatchError,
      );
      expect(tracked.state.cancelled).toBe(true);
    });

    it('discards a ranged GET answered with the full body', async () => {
      const tracked = trackedBody('whole');
      const { store } = getWith(() => new Response(tracked.body, { status: 200 }));
      await expect(store.get(key, { offset: 2, length: 4 })).rejects.toThrow();
      expect(tracked.state.cancelled).toBe(true);
    });

    it('bounds a ranged body to the range length', async () => {
      const { store } = getWith(
        () =>
          new Response('abcdefgh', { status: 206, headers: { 'content-range': 'bytes 2-5/34' } }),
      );
      const read = await store.get(key, { offset: 2, length: 4 });
      await expect(readAll(read!.body)).rejects.toThrow();
    });

    it('bounds a full body to its Content-Length', async () => {
      const { store } = getWith(
        () => new Response('abcdefgh', { status: 200, headers: { 'content-length': '4' } }),
      );
      const read = await store.get(key);
      await expect(readAll(read!.body)).rejects.toThrow();
    });
  });

  it('returns null for a missing key and errors on a storage failure', async () => {
    const { fake, store } = setup();
    const key = finalKeyOf(body);
    expect(await store.get(key)).toBeNull();
    expect(await store.head(key)).toBeNull();
    fake.faults.failWith = 500;
    await expect(store.get(key)).rejects.toThrow();
    await expect(store.head(key)).rejects.toThrow();
  });

  it('removes an object and tolerates removing a missing one', async () => {
    const { fake, store } = setup();
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    await store.remove(key);
    await store.remove(key);
    expect(fake.keys()).toEqual([]);
  });

  it('never follows a redirect and only talks to the configured origin', async () => {
    const { fake, calls, store } = setup();
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    fake.faults.redirect = 307;
    await expect(store.get(key)).rejects.toThrow();
    await expect(store.head(key)).rejects.toThrow();
    for (const call of calls) {
      expect(new URL(call.url).origin).toBe('https://s3.fake.test');
      expect(call.init?.redirect).toBe('manual');
    }
  });

  it('signs virtual-hosted requests with the bucket host', async () => {
    const { fake, calls, store } = setup(
      { endpoint: 'https://broker.s3.fake.test' },
      { pathStyle: false },
    );
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    expect(fake.keys()).toEqual([key]);
    expect(new URL(calls[1]!.url).toString()).toBe(`https://broker.s3.fake.test/${key}`);
    expect(calls[2]!.headers.get('x-amz-copy-source')).toMatch(/^\/broker\/staging\//);
  });

  it('sends the session token and is refused with the wrong secret', async () => {
    const withToken = setup({ sessionToken: 'session-token' }, { sessionToken: 'session-token' });
    await withToken.store.putVerified(finalKeyOf(body), chunked([body]), input);
    expect(withToken.fake.keys()).toEqual([finalKeyOf(body)]);
    const wrong = setup({}, { secretAccessKey: 'not-the-secret' });
    await expect(wrong.store.head(finalKeyOf(body))).rejects.toThrow();
  });

  it('never puts secrets in error names or messages', async () => {
    const secrets = {
      accessKeyId: 'AKIASECRETIDENTITY99',
      secretAccessKey: 'super-secret-access-key-value',
      sessionToken: 'secret-session-token-value',
    };
    const errors: unknown[] = [];
    const capture = (promise: Promise<unknown>) =>
      promise.catch((error: unknown) => errors.push(error));
    const refused = setup({}, secrets);
    await capture(refused.store.head(finalKeyOf(body)));
    await capture(refused.store.get(finalKeyOf(body)));
    await capture(refused.store.putVerified(finalKeyOf(body), chunked([body]), input));
    const failing = setup(
      { credentials: secrets, sessionToken: secrets.sessionToken },
      secrets,
      (call) => (isCopy(call) ? new Response('<Error/>', { status: 200 }) : undefined),
    );
    await capture(failing.store.putVerified(finalKeyOf(body), chunked([body]), input));
    for (const endpoint of ['ftp://s3.fake.test', 'http://s3.example.test']) {
      try {
        setup({}, { ...secrets, endpoint });
      } catch (error) {
        errors.push(error);
      }
    }
    expect(errors.length).toBe(6);
    for (const error of errors) {
      const text = `${(error as Error).name} ${(error as Error).message}`;
      for (const secret of Object.values(secrets)) expect(text).not.toContain(secret);
    }
  });

  describe('configuration', () => {
    it('rejects unsafe endpoints and storage keys', async () => {
      expect(() => setup({}, { endpoint: 'ftp://s3.fake.test' })).toThrow(S3ConfigError);
      expect(() => setup({}, { endpoint: 'https://user:pw@s3.fake.test' })).toThrow(S3ConfigError);
      const { store } = setup();
      await expect(store.head('../escape')).rejects.toThrow();
      await expect(store.head('/sha256/x')).rejects.toThrow();
    });

    it.each([true, false])('rejects hostile bucket names (pathStyle %s)', (pathStyle) => {
      for (const bucket of ['evil.com/x', 'a@b', 'UPPER', 'ab', 'a..b', '-bucket', '192.168.1.1']) {
        expect(() => setup({}, { bucket, pathStyle })).toThrow(S3ConfigError);
      }
    });

    it('rejects dotted buckets for virtual-hosted https only', () => {
      expect(() => setup({}, { bucket: 'my.bucket', pathStyle: false })).toThrow(S3ConfigError);
      expect(() => setup({}, { bucket: 'my.bucket', pathStyle: true })).not.toThrow();
    });

    it('allows plain http only for loopback hosts unless opted in', () => {
      expect(() => setup({}, { endpoint: 'http://s3.example.test' })).toThrow(S3ConfigError);
      expect(() =>
        setup({}, { endpoint: 'http://s3.example.test', allowInsecureHttp: true }),
      ).not.toThrow();
      for (const endpoint of [
        'http://127.0.0.1:9000',
        'http://localhost:9000',
        'http://[::1]:9000',
      ]) {
        expect(() => setup({}, { endpoint })).not.toThrow();
      }
    });
  });

  it('works through the real global fetch against a loopback server', async () => {
    let fake: S3Fake | undefined;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers)) {
          if (typeof value === 'string') headers.set(name, value);
        }
        const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
        const response = await fake!.fetch(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers,
          redirect: 'manual',
          ...(hasBody
            ? { body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }
            : {}),
        } as RequestInit);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body === null) res.end();
        else Readable.fromWeb(response.body as never).pipe(res);
      })().catch(() => {
        res.writeHead(500).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      const endpoint = `http://127.0.0.1:${address.port}`;
      fake = startS3Fake({ endpoint });
      const store = createS3ByteStore({
        endpoint,
        region: 'us-east-1',
        bucket: 'broker',
        ...S3_FAKE_DEFAULT_CREDENTIALS,
        pathStyle: true,
      });
      const key = finalKeyOf(body);
      await store.putVerified(key, chunked(split(body, 7)), input);
      expect(fake.keys()).toEqual([key]);
      expect(await readAll((await store.get(key))!.body)).toBe(new TextDecoder().decode(body));
      expect(await readAll((await store.get(key, { offset: 2, length: 4 }))!.body)).toBe('ckag');
      await expect(
        store.putVerified(key, chunked([body.slice(0, 5)]), input),
      ).rejects.toBeInstanceOf(BlobSizeMismatchError);
      expect(fake.keys()).toEqual([key]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('createS3ByteStore round 3', () => {
  const copyBody = (xml: string) => (call: Call) =>
    isCopy(call) ? new Response(xml, { status: 200 }) : undefined;

  it.each([
    ['an undeclared entity', '<CopyObjectResult><ETag>&foo;</ETag></CopyObjectResult>'],
    ['a bare ampersand', '<CopyObjectResult><ETag>a&b</ETag></CopyObjectResult>'],
    [
      'an invalid element name',
      '<CopyObjectResult><1ETag>e</1ETag><ETag>e</ETag></CopyObjectResult>',
    ],
    ['an unknown element', '<CopyObjectResult><ETag>e</ETag><Owner>x</Owner></CopyObjectResult>'],
    ['nested elements', '<CopyObjectResult><ETag><Inner>e</Inner></ETag></CopyObjectResult>'],
    ['trailing garbage', '<CopyObjectResult><ETag>e</ETag></CopyObjectResult>junk'],
    ['a duplicate ETag', '<CopyObjectResult><ETag>a</ETag><ETag>b</ETag></CopyObjectResult>'],
    ['a second root', '<CopyObjectResult><ETag>e</ETag></CopyObjectResult><CopyObjectResult/>'],
    [
      'a bad declaration',
      '<?xml version="1.0" foo="bar"?><CopyObjectResult><ETag>e</ETag></CopyObjectResult>',
    ],
    ['a DOCTYPE', '<!DOCTYPE x><CopyObjectResult><ETag>e</ETag></CopyObjectResult>'],
  ])('fails a copy response with %s and cleans staging', async (_name, xml) => {
    const { fake, store } = setup({}, {}, copyBody(xml));
    await expect(
      store.putVerified(finalKeyOf(body), chunked([body]), input),
    ).rejects.toBeInstanceOf(S3CopyError);
    expect(fake.keys()).toEqual([]);
  });

  it('accepts every allowlisted child and predefined or numeric entities', async () => {
    const xml =
      "<?xml version='1.0' encoding='UTF-8'?><CopyObjectResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\">" +
      '<ETag>&quot;9b2cf535f27731c974343645a3985328&quot;&amp;&lt;&gt;&apos;&#34;&#x22;</ETag>' +
      '<LastModified>2026-10-16T12:00:00.000Z</LastModified><ChecksumCRC32>AAAAAA==</ChecksumCRC32>' +
      '<ChecksumCRC32C>AAAAAA==</ChecksumCRC32C><ChecksumSHA1>x</ChecksumSHA1><ChecksumSHA256>x</ChecksumSHA256>' +
      '<ChecksumCRC64NVME>x</ChecksumCRC64NVME><ChecksumType>FULL_OBJECT</ChecksumType></CopyObjectResult>\n';
    const { store } = setup({}, {}, copyBody(xml));
    await expect(store.putVerified(finalKeyOf(body), chunked([body]), input)).resolves.toEqual({
      size: body.length,
      mediaType: 'application/zip',
    });
  });

  it.each([
    ['accessKeyId', { accessKeyId: 'AKIDPART1\nAKIDPART2' }],
    ['secretAccessKey', { secretAccessKey: 'secretpart1\r\nsecretpart2' }],
    ['sessionToken', { sessionToken: 'tokenpartone\ntokenparttwo' }],
    ['sessionToken', { sessionToken: `tokenpartone${'\u0007'}tokenparttwo` }],
    ['accessKeyId', { accessKeyId: 'A'.repeat(1000) }],
  ] as const)('rejects an unsafe %s without echoing it', (field, credentials) => {
    let caught: unknown;
    try {
      setup({}, credentials);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(S3ConfigError);
    const text = `${(caught as Error).name} ${(caught as Error).message}`;
    expect(text).toContain(field);
    for (const part of ['AKIDPART', 'secretpart', 'tokenpart', 'AAAAAAAAAA']) {
      expect(text).not.toContain(part);
    }
  });

  it('translates a signer exception into a safe error', async () => {
    const { calls, store } = setup({}, { region: 'us-east-1\nINJECTED' });
    let caught: unknown;
    try {
      await store.head(finalKeyOf(body));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(S3SigningError);
    expect((caught as Error).message).not.toContain(S3_FAKE_DEFAULT_CREDENTIALS.accessKeyId);
    expect((caught as Error).message).not.toContain('INJECTED');
    expect((caught as Error).cause).toBeUndefined();
    expect(calls).toEqual([]);
  });

  it('asks for the stored checksum and skips the GET when it matches', async () => {
    const { calls, store } = setup();
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    calls.length = 0;
    await store.putVerified(key, chunked([body]), input);
    const head = calls.find((c) => isFinal(c, 'HEAD'))!;
    expect(head.headers.get('x-amz-checksum-mode')).toBe('ENABLED');
    expect(head.headers.get('authorization')).toMatch(/SignedHeaders=[^,]*x-amz-checksum-mode/);
    expect(calls.some((c) => isFinal(c, 'GET'))).toBe(false);
    expect(calls.some(isCopy)).toBe(false);
  });

  it('confirms a 5 MiB duplicate put with HEAD only', async () => {
    const big = new Uint8Array(5 * 1024 * 1024).fill(7);
    const bigInput = { sha256: digestOf(big), size: big.length, mediaType: 'application/zip' };
    const { calls, store } = setup();
    const key = finalKeyOf(big);
    await store.putVerified(key, chunked(split(big, 1024 * 1024)), bigInput);
    calls.length = 0;
    await store.putVerified(key, chunked(split(big, 1024 * 1024)), bigInput);
    expect(calls.filter((c) => isFinal(c, 'HEAD'))).toHaveLength(1);
    expect(calls.some((c) => isFinal(c, 'GET'))).toBe(false);
  });

  it('falls back to GET and hash when the store returns no checksum', async () => {
    const { calls, store } = setup({}, {}, (call, s3) =>
      isFinal(call, 'HEAD') ? withoutChecksum(call, s3) : undefined,
    );
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    calls.length = 0;
    await store.putVerified(key, chunked([body]), input);
    expect(calls.filter((c) => isFinal(c, 'HEAD'))).toHaveLength(1);
    expect(calls.filter((c) => isFinal(c, 'GET'))).toHaveLength(1);
  });

  for (const status of [400, 501]) {
    it(`retries the HEAD once without the header on ${status}, hashes via GET and skips the header afterwards`, async () => {
      const key = finalKeyOf(body);
      let armed = false;
      const { fake, calls, store } = setup({}, {}, (call, s3) => {
        if (!armed || !isFinal(call, 'HEAD')) return undefined;
        if (call.headers.has('x-amz-checksum-mode')) return new Response(null, { status });
        return withoutChecksum(call, s3);
      });
      await store.putVerified(key, chunked([body]), input);
      armed = true;
      calls.length = 0;
      await expect(store.putVerified(key, chunked([body]), input)).resolves.toEqual({
        size: body.length,
        mediaType: 'application/zip',
      });
      const heads = calls.filter((c) => isFinal(c, 'HEAD'));
      expect(heads.map((c) => c.headers.has('x-amz-checksum-mode'))).toEqual([true, false]);
      expect(calls.filter((c) => isFinal(c, 'GET'))).toHaveLength(1);
      calls.length = 0;
      await store.putVerified(key, chunked([body]), input);
      const later = calls.filter((c) => isFinal(c, 'HEAD'));
      expect(later.map((c) => c.headers.has('x-amz-checksum-mode'))).toEqual([false]);
      expect(fake.keys()).toEqual([key]);
    });
  }

  it('keeps sending the header on a store that never rejected it', async () => {
    const { calls, store } = setup();
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    await store.putVerified(key, chunked([body]), input);
    await store.putVerified(key, chunked([body]), input);
    const heads = calls.filter((c) => isFinal(c, 'HEAD'));
    expect(heads).toHaveLength(3);
    expect(heads.every((c) => c.headers.get('x-amz-checksum-mode') === 'ENABLED')).toBe(true);
  });

  it('does not retry the HEAD on other error statuses', async () => {
    const key = finalKeyOf(body);
    let armed = false;
    const { calls, store } = setup({}, {}, (call) =>
      armed && isFinal(call, 'HEAD') ? new Response(null, { status: 403 }) : undefined,
    );
    await store.putVerified(key, chunked([body]), input);
    armed = true;
    calls.length = 0;
    await expect(store.putVerified(key, chunked([body]), input)).rejects.toMatchObject({
      status: 403,
    });
    expect(calls.filter((c) => isFinal(c, 'HEAD'))).toHaveLength(1);
  });

  it('the fake returns the stored checksum only in checksum mode', async () => {
    const { fake, store } = setup();
    const key = finalKeyOf(body);
    await store.putVerified(key, chunked([body]), input);
    const expected = createHash('sha256').update(body).digest('base64');
    const signer = (method: string, mode: boolean) =>
      new AwsV4Signer({
        method,
        url: `https://s3.fake.test/broker/${key}`,
        headers: {
          'x-amz-content-sha256': EMPTY_SHA256,
          ...(mode ? { 'x-amz-checksum-mode': 'ENABLED' } : {}),
        },
        ...S3_FAKE_DEFAULT_CREDENTIALS,
        service: 's3',
        region: 'us-east-1',
      }).sign();
    for (const method of ['HEAD', 'GET']) {
      const withMode = await signer(method, true);
      const on = await fake.fetch(withMode.url, {
        method,
        headers: withMode.headers,
        redirect: 'manual',
      });
      expect(on.status).toBe(200);
      expect(on.headers.get('x-amz-checksum-sha256')).toBe(expected);
      const plain = await signer(method, false);
      const off = await fake.fetch(plain.url, {
        method,
        headers: plain.headers,
        redirect: 'manual',
      });
      expect(off.headers.get('x-amz-checksum-sha256')).toBeNull();
    }
  });

  it('exports the adapter by package name through ./blob/s3', () => {
    const packageDir = fileURLToPath(new URL('../..', import.meta.url));
    const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>;
    };
    expect(manifest.exports['./blob/s3']).toEqual({
      types: './dist/blob/s3.d.ts',
      default: './dist/blob/s3.js',
    });
    const resolved = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "process.stdout.write(import.meta.resolve('@package-broker/runtime-node/blob/s3'))",
      ],
      { cwd: packageDir, encoding: 'utf8' },
    );
    expect(resolved).toBe(pathToFileURL(join(packageDir, 'dist/blob/s3.js')).href);
  });
});
