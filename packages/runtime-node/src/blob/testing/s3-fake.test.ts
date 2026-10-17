import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { S3_FAKE_DEFAULT_CREDENTIALS, S3_FAKE_ENDPOINT, startS3Fake } from './s3-fake.js';

const CREDENTIALS = { accessKeyId: 'AKIDEXAMPLE0000TEST', secretAccessKey: 'test-secret-key-0000' };
const AMZ_DATE = '20261016T120000Z';
const BUCKET = 'broker';

const sha256Hex = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest();
const encode = (value: string): string =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );

interface SignOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
  readonly secretAccessKey?: string;
  readonly accessKeyId?: string;
  readonly payloadHash?: string;
  readonly omitSigned?: readonly string[];
  readonly signedUrl?: string;
  readonly signedHeaderOrder?: (names: string[]) => string[];
  readonly region?: string;
  readonly credentials?: { accessKeyId: string; secretAccessKey: string };
  readonly contentLength?: string | null;
}

function signed(url: string, options: SignOptions = {}): [string, RequestInit] {
  const method = options.method ?? 'GET';
  const signUrl = new URL(options.signedUrl ?? url);
  const body = options.body ?? '';
  const payloadHash = options.payloadHash ?? sha256Hex(body);
  const all: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    ),
    'x-amz-date': AMZ_DATE,
    'x-amz-content-sha256': payloadHash,
  };
  const canonicalHeaders: Record<string, string> = { host: signUrl.host, ...all };
  const sortedNames = Object.keys(canonicalHeaders)
    .filter((n) => !(options.omitSigned ?? []).includes(n))
    .sort();
  const names = options.signedHeaderOrder?.(sortedNames) ?? sortedNames;
  const canonicalUri = signUrl.pathname
    .split('/')
    .map((s) => encode(decodeURIComponent(s)))
    .join('/');
  const canonicalQuery = [...signUrl.searchParams.entries()]
    .map(([k, v]) => [encode(k), encode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const headerBlock = names
    .map((n) => `${n}:${canonicalHeaders[n]!.trim().replace(/\s+/g, ' ')}\n`)
    .join('');
  const canonicalRequest = `${method}\n${canonicalUri}\n${canonicalQuery}\n${headerBlock}\n${names.join(';')}\n${payloadHash}`;
  const region = options.region ?? 'us-east-1';
  const credentials = options.credentials ?? CREDENTIALS;
  const scope = `20261016/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', AMZ_DATE, scope, sha256Hex(canonicalRequest)].join(
    '\n',
  );
  const key = hmac(
    hmac(
      hmac(
        hmac(`AWS4${options.secretAccessKey ?? credentials.secretAccessKey}`, '20261016'),
        region,
      ),
      's3',
    ),
    'aws4_request',
  );
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${options.accessKeyId ?? credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  const init: RequestInit = { method, headers: { ...all, authorization }, redirect: 'manual' };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = body;
    const length =
      options.contentLength === undefined ? String(Buffer.byteLength(body)) : options.contentLength;
    if (length !== null) (init.headers as Record<string, string>)['content-length'] = length;
  }
  return [url, init];
}

const objectUrl = (key: string): string => `${S3_FAKE_ENDPOINT}/${BUCKET}/${key}`;

async function put(
  fake: ReturnType<typeof startS3Fake>,
  key: string,
  body: string,
  headers: Record<string, string> = {},
) {
  return fake.fetch(...signed(objectUrl(key), { method: 'PUT', body, headers }));
}

describe('s3 fake signing', () => {
  it('accepts a correctly signed request', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const res = await put(fake, 'staging/a', 'hello', { 'content-type': 'text/plain' });
    expect(res.status).toBe(200);
    expect(fake.keys()).toEqual(['staging/a']);
  });

  it('works without options using its built-in credentials', async () => {
    const fake = startS3Fake();
    expect(fake.keys()).toEqual([]);
    const own = { credentials: S3_FAKE_DEFAULT_CREDENTIALS };
    const stored = await fake.fetch(
      ...signed(objectUrl('x'), { method: 'PUT', body: 'd', ...own }),
    );
    expect(stored.status).toBe(200);
    expect((await fake.fetch(objectUrl('x'))).status).toBe(403);
  });

  it('rejects an unsigned request', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const res = await fake.fetch(objectUrl('staging/a'), {
      method: 'PUT',
      body: 'x',
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(fake.keys()).toEqual([]);
  });

  it('rejects a request sent to another host even when signed for it', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const res = await fake.fetch(
      ...signed(`https://evil.example/${BUCKET}/staging/a`, { method: 'PUT', body: 'x' }),
    );
    expect(res.status).toBe(403);
    expect(fake.keys()).toEqual([]);
  });

  it('rejects a request signed for another host but sent to the fake', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const res = await fake.fetch(
      ...signed(objectUrl('staging/a'), {
        method: 'PUT',
        body: 'x',
        signedUrl: `https://evil.example/${BUCKET}/staging/a`,
      }),
    );
    expect(res.status).toBe(403);
    expect(fake.keys()).toEqual([]);
  });

  it('rejects a request signed for another path', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const res = await fake.fetch(
      ...signed(objectUrl('staging/a'), {
        method: 'PUT',
        body: 'x',
        signedUrl: objectUrl('staging/b'),
      }),
    );
    expect(res.status).toBe(403);
    expect(fake.keys()).toEqual([]);
  });

  it('rejects a wrong secret and an unknown access key', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    expect((await fake.fetch(...signed(objectUrl('a'), { secretAccessKey: 'nope' }))).status).toBe(
      403,
    );
    expect((await fake.fetch(...signed(objectUrl('a'), { accessKeyId: 'AKIDOTHER' }))).status).toBe(
      403,
    );
  });

  it('rejects a signature that leaves host or an x-amz header unsigned', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    expect((await fake.fetch(...signed(objectUrl('a'), { omitSigned: ['host'] }))).status).toBe(
      403,
    );
    expect(
      (await fake.fetch(...signed(objectUrl('a'), { omitSigned: ['x-amz-content-sha256'] })))
        .status,
    ).toBe(403);
    await put(fake, 'staging/a', 'x');
    const copy = await fake.fetch(
      ...signed(objectUrl('sha256/a'), {
        method: 'PUT',
        headers: { 'x-amz-copy-source': `/${BUCKET}/staging/a` },
        omitSigned: ['x-amz-copy-source'],
      }),
    );
    expect(copy.status).toBe(403);
    expect(fake.keys()).toEqual(['staging/a']);
  });

  it('rejects requests that would follow redirects', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const [url, init] = signed(objectUrl('a'));
    expect((await fake.fetch(url, { ...init, redirect: 'follow' })).status).toBe(400);
    expect(
      (await fake.fetch(url, { headers: init.headers as Record<string, string> })).status,
    ).toBe(400);
  });

  it('rejects a body that does not match the signed payload hash', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const res = await fake.fetch(
      ...signed(objectUrl('staging/a'), {
        method: 'PUT',
        body: 'abc',
        payloadHash: sha256Hex('other'),
      }),
    );
    expect(res.status).toBe(400);
    expect(fake.keys()).toEqual([]);
  });

  it('accepts UNSIGNED-PAYLOAD', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const res = await fake.fetch(
      ...signed(objectUrl('staging/a'), {
        method: 'PUT',
        body: 'abc',
        payloadHash: 'UNSIGNED-PAYLOAD',
      }),
    );
    expect(res.status).toBe(200);
  });

  it('rejects unsupported checksum and streaming behaviour with 501', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const checksum = await put(fake, 'staging/a', 'x', { 'x-amz-checksum-crc32': 'AAAAAA==' });
    const trailer = await put(fake, 'staging/b', 'x', { 'x-amz-trailer': 'x-amz-checksum-crc32' });
    const streaming = await fake.fetch(
      ...signed(objectUrl('staging/c'), {
        method: 'PUT',
        body: 'x',
        payloadHash: 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
      }),
    );
    expect([checksum.status, trailer.status, streaming.status]).toEqual([501, 501, 501]);
    expect(fake.keys()).toEqual([]);
  });

  it('rejects conditional headers it does not emulate', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    expect((await put(fake, 'staging/a', 'x', { 'if-match': '"abc"' })).status).toBe(501);
  });
});

describe('s3 fake objects', () => {
  it('promotes staging to the final key with CopyObject and the staging key is gone after delete', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await put(fake, 'staging/a', 'payload', { 'content-type': 'application/zip' });
    const copy = await fake.fetch(
      ...signed(objectUrl('sha256/ab/final'), {
        method: 'PUT',
        headers: { 'x-amz-copy-source': `/${BUCKET}/staging/a` },
      }),
    );
    expect(copy.status).toBe(200);
    expect(await copy.text()).toMatch(
      /^\s+<\?xml[^>]*\?><CopyObjectResult>.*<ETag>.*<\/ETag>.*<\/CopyObjectResult>$/,
    );
    expect(fake.keys()).toEqual(['sha256/ab/final', 'staging/a']);
    const del = await fake.fetch(...signed(objectUrl('staging/a'), { method: 'DELETE' }));
    expect(del.status).toBe(204);
    expect(fake.keys()).toEqual(['sha256/ab/final']);
    const head = await fake.fetch(...signed(objectUrl('sha256/ab/final'), { method: 'HEAD' }));
    expect(head.headers.get('content-type')).toBe('application/zip');
    expect(await (await fake.fetch(...signed(objectUrl('sha256/ab/final')))).text()).toBe(
      'payload',
    );
  });

  it('answers 404 NoSuchKey when the copy source is missing', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const copy = await fake.fetch(
      ...signed(objectUrl('sha256/x'), {
        method: 'PUT',
        headers: { 'x-amz-copy-source': `/${BUCKET}/staging/none` },
      }),
    );
    expect(copy.status).toBe(404);
    expect(await copy.text()).toContain('<Code>NoSuchKey</Code>');
    expect(fake.keys()).toEqual([]);
  });

  it('returns HTTP 200 with an Error body under the copy toggle and does not copy', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await put(fake, 'staging/a', 'payload');
    fake.faults.copyReturns200Error = true;
    const copy = await fake.fetch(
      ...signed(objectUrl('sha256/x'), {
        method: 'PUT',
        headers: { 'x-amz-copy-source': `/${BUCKET}/staging/a` },
      }),
    );
    expect(copy.status).toBe(200);
    expect(await copy.text()).toMatch(/<Error><Code>InternalError<\/Code>/);
    expect(fake.keys()).toEqual(['staging/a']);
  });

  it('returns exact bytes for ranges with 206 and Content-Range', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await put(fake, 'k', '0123456789');
    const get = (range: string) => fake.fetch(...signed(objectUrl('k'), { headers: { range } }));
    const mid = await get('bytes=2-5');
    expect(mid.status).toBe(206);
    expect(mid.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(await mid.text()).toBe('2345');
    const open = await get('bytes=7-');
    expect(open.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(await open.text()).toBe('789');
    const suffix = await get('bytes=-3');
    expect(suffix.headers.get('content-range')).toBe('bytes 7-9/10');
    expect(await suffix.text()).toBe('789');
    const clamped = await get('bytes=8-99');
    expect(clamped.headers.get('content-range')).toBe('bytes 8-9/10');
    expect(await clamped.text()).toBe('89');
  });

  it('rejects unsatisfiable and multi-range requests', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await put(fake, 'k', '0123456789');
    const get = (range: string) => fake.fetch(...signed(objectUrl('k'), { headers: { range } }));
    expect((await get('bytes=10-12')).status).toBe(416);
    expect((await get('bytes=0-1,3-4')).status).toBe(501);
    expect((await get('items=0-1')).status).toBe(501);
  });

  it('answers a range with 200 and the full body under the toggle', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await put(fake, 'k', '0123456789');
    fake.faults.rangeIgnored = true;
    const res = await fake.fetch(...signed(objectUrl('k'), { headers: { range: 'bytes=2-5' } }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-range')).toBeNull();
    expect(await res.text()).toBe('0123456789');
  });

  it('serves HEAD size and type and 404 for a missing key', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await put(fake, 'k', '0123456789', { 'content-type': 'application/octet-stream' });
    const head = await fake.fetch(...signed(objectUrl('k'), { method: 'HEAD' }));
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe('10');
    expect(head.headers.get('content-type')).toBe('application/octet-stream');
    const missingHead = await fake.fetch(...signed(objectUrl('none'), { method: 'HEAD' }));
    expect(missingHead.status).toBe(404);
    expect(await missingHead.text()).toBe('');
    const missing = await fake.fetch(...signed(objectUrl('none')));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('<Code>NoSuchKey</Code>');
  });

  it('deletes idempotently and honours If-None-Match: *', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    expect((await fake.fetch(...signed(objectUrl('none'), { method: 'DELETE' }))).status).toBe(204);
    await put(fake, 'k', 'one');
    expect((await put(fake, 'k', 'two', { 'if-none-match': '*' })).status).toBe(412);
    expect(await (await fake.fetch(...signed(objectUrl('k')))).text()).toBe('one');
  });

  it('accepts a streamed request body', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const [url, init] = signed(objectUrl('staging/s'), {
      method: 'PUT',
      body: 'streamed',
      payloadHash: 'UNSIGNED-PAYLOAD',
    });
    expect((init.headers as Record<string, string>)['content-length']).toBe('8');
    const stream = new Response('streamed').body;
    const res = await fake.fetch(url, { ...init, body: stream, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(200);
    expect(await (await fake.fetch(...signed(objectUrl('staging/s')))).text()).toBe('streamed');
  });
});

describe('s3 fake round 1', () => {
  const sendPut = (
    fake: ReturnType<typeof startS3Fake>,
    key: string,
    body: string,
    options: SignOptions = {},
  ) => fake.fetch(...signed(objectUrl(key), { method: 'PUT', body, ...options }));

  it('requires a matching content-length on a plain PUT', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const missing = await sendPut(fake, 'a', 'abc', { contentLength: null });
    expect(missing.status).toBe(411);
    expect(await missing.text()).toContain('<Code>MissingContentLength</Code>');
    const wrong = await sendPut(fake, 'a', 'abc', { contentLength: '5' });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain('<Code>IncompleteBody</Code>');
    expect(fake.keys()).toEqual([]);
  });

  it('rejects another bucket and a credential-scope region mismatch', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS, bucket: 'mine', region: 'eu-west-1' });
    const url = `${S3_FAKE_ENDPOINT}/mine/k`;
    const ok = await fake.fetch(...signed(url, { method: 'PUT', body: 'x', region: 'eu-west-1' }));
    expect(ok.status).toBe(200);
    const other = await fake.fetch(
      ...signed(`${S3_FAKE_ENDPOINT}/other/k`, { method: 'PUT', body: 'x', region: 'eu-west-1' }),
    );
    expect(other.status).toBe(404);
    expect(await other.text()).toContain('<Code>NoSuchBucket</Code>');
    const region = await fake.fetch(...signed(url, { region: 'us-east-1' }));
    expect(region.status).toBe(400);
    expect(await region.text()).toContain('<Code>AuthorizationHeaderMalformed</Code>');
    expect(fake.keys()).toEqual(['k']);
  });

  it('rejects If-None-Match on CopyObject and on non-PUT methods, accepts it on a missing key', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    expect((await sendPut(fake, 'new', 'x', { headers: { 'if-none-match': '*' } })).status).toBe(
      200,
    );
    const copy = await fake.fetch(
      ...signed(objectUrl('final'), {
        method: 'PUT',
        headers: { 'x-amz-copy-source': `/${BUCKET}/new`, 'if-none-match': '*' },
      }),
    );
    expect(copy.status).toBe(501);
    const get = await fake.fetch(
      ...signed(objectUrl('new'), { headers: { 'if-none-match': '*' } }),
    );
    expect(get.status).toBe(501);
  });

  it('sets content-length on 200 and 206 and content-range on 416', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await sendPut(fake, 'k', '0123456789');
    const full = await fake.fetch(...signed(objectUrl('k')));
    expect(full.headers.get('content-length')).toBe('10');
    const part = await fake.fetch(...signed(objectUrl('k'), { headers: { range: 'bytes=2-5' } }));
    expect(part.headers.get('content-length')).toBe('4');
    const bad = await fake.fetch(...signed(objectUrl('k'), { headers: { range: 'bytes=20-30' } }));
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */10');
  });

  it('injects range mismatch, 5xx, SlowDown, network error and redirect faults', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await sendPut(fake, 'k', '0123456789');
    const ranged = () => fake.fetch(...signed(objectUrl('k'), { headers: { range: 'bytes=2-5' } }));
    fake.faults.rangeMismatch = true;
    const mismatch = await ranged();
    expect([mismatch.status, mismatch.headers.get('content-range')]).toEqual([206, 'bytes 3-6/10']);
    fake.faults.rangeMismatch = false;

    fake.faults.failWith = 502;
    expect((await fake.fetch(...signed(objectUrl('k')))).status).toBe(502);
    expect((await sendPut(fake, 'z', 'x')).status).toBe(502);
    const head = await fake.fetch(...signed(objectUrl('k'), { method: 'HEAD' }));
    expect(head.status).toBe(502);
    fake.faults.failWith = 'SlowDown';
    const slow = await fake.fetch(...signed(objectUrl('k')));
    expect(slow.status).toBe(503);
    expect(await slow.text()).toContain('<Code>SlowDown</Code>');
    fake.faults.failWith = null;

    fake.faults.networkError = true;
    await expect(fake.fetch(...signed(objectUrl('k')))).rejects.toThrow(TypeError);
    fake.faults.networkError = false;

    fake.faults.redirect = 307;
    const redirected = await fake.fetch(...signed(objectUrl('k')));
    expect(redirected.status).toBe(307);
    expect(new URL(redirected.headers.get('location')!).origin).not.toBe(S3_FAKE_ENDPOINT);
    fake.faults.redirect = null;
    expect(fake.keys()).toEqual(['k']);
  });

  it('wraps XML responses with leading whitespace on copy success and 200-error', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await sendPut(fake, 'a', 'x');
    const headers = { 'x-amz-copy-source': `/${BUCKET}/a` };
    const ok = await fake.fetch(...signed(objectUrl('b'), { method: 'PUT', headers }));
    expect(await ok.text()).toMatch(/^\s+<\?xml/);
    fake.faults.copyReturns200Error = true;
    const failed = await fake.fetch(...signed(objectUrl('c'), { method: 'PUT', headers }));
    expect(await failed.text()).toMatch(/^\s+<\?xml.*<Error>/);
  });

  it('accepts a signed session token and enforces the expected one', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS, sessionToken: 'token-1' });
    const good = await sendPut(fake, 'a', 'x', { headers: { 'x-amz-security-token': 'token-1' } });
    expect(good.status).toBe(200);
    expect(
      (await sendPut(fake, 'b', 'x', { headers: { 'x-amz-security-token': 'other' } })).status,
    ).toBe(403);
    expect((await sendPut(fake, 'c', 'x')).status).toBe(403);
    const open = startS3Fake({ credentials: CREDENTIALS });
    expect(
      (await sendPut(open, 'a', 'x', { headers: { 'x-amz-security-token': 'any' } })).status,
    ).toBe(200);
    const unsigned = await sendPut(open, 'b', 'x', {
      headers: { 'x-amz-security-token': 'any' },
      omitSigned: ['x-amz-security-token'],
    });
    expect(unsigned.status).toBe(403);
  });

  it('verifies x-amz-checksum-sha256 on PUT and keeps other checksums unsupported', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const digest = createHash('sha256').update('data').digest('base64');
    expect(
      (await sendPut(fake, 'a', 'data', { headers: { 'x-amz-checksum-sha256': digest } })).status,
    ).toBe(200);
    const bad = await sendPut(fake, 'b', 'data', {
      headers: { 'x-amz-checksum-sha256': createHash('sha256').update('x').digest('base64') },
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('<Code>BadDigest</Code>');
    expect(
      (await sendPut(fake, 'c', 'data', { headers: { 'x-amz-checksum-crc32': 'AAAAAA==' } }))
        .status,
    ).toBe(501);
    expect(fake.keys()).toEqual(['a']);
  });

  it('returns the stored checksum on HEAD and GET only in checksum mode', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const digest = createHash('sha256').update('data').digest('base64');
    await sendPut(fake, 'with', 'data', { headers: { 'x-amz-checksum-sha256': digest } });
    await sendPut(fake, 'without', 'data');
    const request = (key: string, method: string, mode: boolean) =>
      fake.fetch(
        ...signed(objectUrl(key), {
          method,
          ...(mode ? { headers: { 'x-amz-checksum-mode': 'ENABLED' } } : {}),
        }),
      );
    for (const method of ['HEAD', 'GET']) {
      expect((await request('with', method, true)).headers.get('x-amz-checksum-sha256')).toBe(
        digest,
      );
      expect(
        (await request('with', method, false)).headers.get('x-amz-checksum-sha256'),
      ).toBeNull();
      const bare = await request('without', method, true);
      expect(bare.status).toBe(200);
      expect(bare.headers.get('x-amz-checksum-sha256')).toBeNull();
    }
  });

  it('rejects a checksum mode other than ENABLED and on non-read methods', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    await sendPut(fake, 'k', 'data');
    const other = await fake.fetch(
      ...signed(objectUrl('k'), { method: 'HEAD', headers: { 'x-amz-checksum-mode': 'DISABLED' } }),
    );
    const onPut = await sendPut(fake, 'j', 'data', {
      headers: { 'x-amz-checksum-mode': 'ENABLED' },
    });
    expect([other.status, onPut.status]).toEqual([501, 501]);
  });

  it('accepts redirect error mode', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const [url, init] = signed(objectUrl('none'));
    expect((await fake.fetch(url, { ...init, redirect: 'error' })).status).toBe(404);
  });

  it('matches the AWS documented SigV4 GET object with Range example', async () => {
    const fake = startS3Fake({
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
      endpoint: 'https://examplebucket.s3.amazonaws.com',
      bucket: 'examplebucket',
    });
    const signature = 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41';
    const request = (sig: string) =>
      fake.fetch('https://examplebucket.s3.amazonaws.com/test.txt', {
        redirect: 'manual',
        headers: {
          range: 'bytes=0-9',
          'x-amz-content-sha256':
            'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          'x-amz-date': '20130524T000000Z',
          authorization: `AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,Signature=${sig}`,
        },
      });
    const good = await request(signature);
    expect(good.status).toBe(404);
    expect(await good.text()).toContain('<Code>NoSuchKey</Code>');
    const bad = await request(`${signature.slice(0, -1)}0`);
    expect(bad.status).toBe(403);
  });

  it('canonicalises internal runs of spaces in header values', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const res = await sendPut(fake, 'a', 'x', { headers: { 'x-note': 'one   two  three' } });
    expect(res.status).toBe(200);
  });

  it('answers a malformed percent escape with 400 InvalidURI', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const res = await fake.fetch(
      ...signed(`${S3_FAKE_ENDPOINT}/${BUCKET}/a%ZZ`, { signedUrl: objectUrl('a') }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('<Code>InvalidURI</Code>');
  });
});

describe('s3 fake round 2', () => {
  it('validates Content-MD5 and stores nothing on mismatch', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const md5 = (v: string) => createHash('md5').update(v).digest('base64');
    const put = (key: string, headers: Record<string, string>) =>
      fake.fetch(...signed(objectUrl(key), { method: 'PUT', body: 'data', headers }));
    expect((await put('ok', { 'content-md5': md5('data') })).status).toBe(200);
    const bad = await put('bad', { 'content-md5': md5('other') });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('<Code>BadDigest</Code>');
    expect(fake.keys()).toEqual(['ok']);
  });

  it('rejects SignedHeaders that are unsorted or duplicated even when signed consistently', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const orders = [
      (names: string[]) => [...names].reverse(),
      (names: string[]) => [...names, names[0]!],
    ];
    for (const signedHeaderOrder of orders) {
      const res = await fake.fetch(...signed(objectUrl('a'), { signedHeaderOrder }));
      expect(res.status).toBe(403);
    }
    expect((await fake.fetch(...signed(objectUrl('a')))).status).toBe(404);
  });

  it('rejects an already-aborted request before reading or storing', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const controller = new AbortController();
    const reason = new Error('stop');
    controller.abort(reason);
    const [url, init] = signed(objectUrl('a'), { method: 'PUT', body: 'x' });
    await expect(fake.fetch(url, { ...init, signal: controller.signal })).rejects.toBe(reason);
    expect(fake.keys()).toEqual([]);
  });

  it('stops reading and stores nothing when aborted during the body', async () => {
    const fake = startS3Fake({ credentials: CREDENTIALS });
    const controller = new AbortController();
    const reason = new Error('mid-body');
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('ab'));
      },
    });
    const [url, init] = signed(objectUrl('a'), {
      method: 'PUT',
      body: 'ab',
      payloadHash: 'UNSIGNED-PAYLOAD',
    });
    const pending = fake.fetch(url, {
      ...init,
      body,
      duplex: 'half',
      signal: controller.signal,
    } as RequestInit);
    setTimeout(() => controller.abort(reason), 10);
    await expect(pending).rejects.toBe(reason);
    expect(fake.keys()).toEqual([]);
  });
});
