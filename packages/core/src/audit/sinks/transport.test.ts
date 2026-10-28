import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditSinkConfigError } from '../plugin-api.js';
import {
  createAuditBoundFetch,
  resolveAuditDestination,
  parseAuditOtelEnvironment,
  parseAuditOtelHeaders,
} from './transport.js';

const request = () => ({
  contentType: 'application/json' as const,
  body: '{}',
  signal: new AbortController().signal,
});
const transport = (options: Partial<Parameters<typeof createAuditBoundFetch>[0]> = {}) =>
  createAuditBoundFetch({
    id: 'audit',
    runtime: 'docker',
    endpoint: 'https://collector.example/v1/logs',
    headers: { authorization: 'Bearer test-credential' },
    timeoutMs: 1500,
    activationSource: 'TEST_ENDPOINT',
    ...options,
  });
const parse = (values: Record<string, string>) => parseAuditOtelEnvironment((name) => values[name]);

afterEach(() => vi.useRealTimers());

describe('audit OTEL environment', () => {
  it('resolves complete endpoints, isolates PB credentials, and records activation source', () => {
    const values = {
      PB_AUDIT_OTLP_ENDPOINT: 'https://audit.example/custom',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://logs.example/custom',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://generic.example/base/',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer%20telemetry',
    };
    expect(parse(values)).toEqual({
      endpoint: values.PB_AUDIT_OTLP_ENDPOINT,
      activationSource: 'PB_AUDIT_OTLP_ENDPOINT',
      headers: {},
      timeoutMs: 1500,
    });
    const standard = { ...values };
    delete (standard as Partial<typeof values>).PB_AUDIT_OTLP_ENDPOINT;
    expect(parse(standard)).toMatchObject({
      endpoint: values.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
      activationSource: 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
      headers: { authorization: 'Bearer telemetry' },
    });
    const generic = { ...standard };
    delete (generic as Partial<typeof values>).OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    expect(parse(generic)).toMatchObject({
      endpoint: 'https://generic.example/base/v1/logs',
      activationSource: 'OTEL_EXPORTER_OTLP_ENDPOINT',
    });
    expect(
      parse({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://generic.example/v1/logs/' })?.endpoint,
    ).toBe('https://generic.example/v1/logs');
    expect(parse({})).toBeNull();
  });

  it('uses signal-specific settings and caps the timeout', () => {
    expect(
      parse({
        OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example',
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: 'x-api-key=a%3Db%2Cc',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=unused',
        OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
        OTEL_EXPORTER_OTLP_LOGS_TIMEOUT: '12000',
        OTEL_EXPORTER_OTLP_TIMEOUT: 'invalid',
      }),
    ).toMatchObject({ headers: { 'x-api-key': 'a=b,c' }, timeoutMs: 10000 });
  });

  it.each(['grpc', 'http/protobuf', ''])('refuses unsupported protocol %s', (protocol) => {
    expect(() => parse({ OTEL_EXPORTER_OTLP_PROTOCOL: protocol })).toThrow(
      expect.objectContaining({ code: 'unsupported_protocol' }),
    );
  });

  it.each(['0', '-1', '1.5', 'NaN', 'Infinity', '', '9007199254740992'])(
    'refuses timeout %s',
    (value) => {
      expect(() => parse({ OTEL_EXPORTER_OTLP_TIMEOUT: value })).toThrow(
        expect.objectContaining({ code: 'invalid_timeout' }),
      );
    },
  );

  it.each(['OTEL_EXPORTER_OTLP_', 'OTEL_EXPORTER_OTLP_LOGS_'])(
    'refuses unsupported settings under %s',
    (prefix) => {
      for (const suffix of ['CERTIFICATE', 'CLIENT_CERTIFICATE', 'CLIENT_KEY', 'COMPRESSION']) {
        expect(() => parse({ [prefix + suffix]: '' })).toThrow(
          expect.objectContaining({
            code: suffix === 'COMPRESSION' ? 'unsupported_compression' : 'unsupported_tls',
          }),
        );
      }
    },
  );

  it('parses percent-encoded headers without treating plus as a space', () => {
    expect(parseAuditOtelHeaders(' Authorization = Bearer%20abc , x-key=a+b%3Dc')).toEqual({
      authorization: 'Bearer abc',
      'x-key': 'a+b=c',
    });
  });

  it.each([
    'authorization=%ZZ',
    'authorization=x%0D%0Asecret',
    'bad name=x',
    'host=secret',
    'cookie=secret',
    'authorization=x,Authorization=y',
    'x',
    'x=a,',
    'x=%C3%A9',
  ])('refuses unsafe headers without echoing input', (value) => {
    expect(() => parseAuditOtelHeaders(value)).toThrow(new AuditSinkConfigError('invalid_headers'));
  });
});

describe('AuditBoundFetch', () => {
  it('posts JSON with redirects disabled and returns only protocol response headers', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'retry-after': '120',
          'set-cookie': 'secret',
          'x-secret': 'secret',
        },
      }),
    );
    const result = await transport({ runtime: 'cloudflare', fetchImpl })(request());
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://collector.example/v1/logs',
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        body: '{}',
        headers: {
          authorization: 'Bearer test-credential',
          'content-type': 'application/json',
        },
      }),
    );
    expect(result).toEqual({
      status: 200,
      contentType: 'application/json',
      retryAfterMs: 120000,
      body: '{}',
    });
  });

  it.each([
    'https://user:secret@collector.example',
    'https://collector.example/?secret=x',
    'https://collector.example/#secret',
    'file:///secret',
    'invalid',
    'http://collector.example',
    'https://localhost..',
    'https://224.0.0.1',
    'https://[ff00::1]',
    'https://0.0.0.0',
    'https://[64:ff9b::7f00:1]',
    'https://[::127.0.0.1]',
    'https://[::ffff:127.0.0.1]',
  ])('refuses unsafe destination %s before sending', (url) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() =>
      transport({ endpoint: url, audit: { egress: { allowPrivate: ['audit'] } }, fetchImpl }),
    ).toThrow(
      expect.objectContaining({
        code: 'invalid_endpoint',
        message: 'Invalid audit sink configuration',
      }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'http://localhost:4318',
    'https://127.1',
    'http://169.254.1.1',
    'http://[::1]',
    'https://[fe80::1]',
    'https://localhost.',
    'http://10.0.0.1',
    'https://172.16.0.1',
    'https://192.168.0.1',
    'https://[fc00::1]',
    'https://collector.internal.',
    'https://collector.home.arpa',
  ])('allows local destinations only on opted-in Node: %s', async (url) => {
    for (const runtime of ['docker', 'cloudflare'] as const) {
      for (const allowPrivate of [false, true]) {
        const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
        const create = () =>
          transport({
            runtime,
            fetchImpl,
            endpoint: url,
            audit: { egress: { allowPrivate: allowPrivate ? ['audit'] : [] } },
          });
        if (runtime === 'docker' && allowPrivate)
          await expect(create()(request())).resolves.toMatchObject({ body: '{}' });
        else {
          expect(create).toThrow(expect.objectContaining({ code: 'invalid_endpoint' }));
          expect(fetchImpl).not.toHaveBeenCalled();
        }
      }
    }
  });

  it('requires a credential and refuses header injection', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const headers of [
      { 'content-type': 'application/json' },
      { 'accept-language': 'en' },
      { 'x-request-id': '1' },
    ]) {
      expect(() => transport({ fetchImpl, headers })).toThrow(
        expect.objectContaining({ code: 'missing_credential' }),
      );
    }
    expect(() =>
      transport({ fetchImpl, headers: { authorization: 'secret\r\nx: injected' } }),
    ).toThrow(expect.objectContaining({ code: 'invalid_headers' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('limits response bytes and cancels an oversized stream', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65536));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
    await expect(transport({ runtime: 'docker', fetchImpl })(request())).rejects.toMatchObject({
      code: 'too_large',
    });
    expect(cancel).toHaveBeenCalled();
    const exact = vi.fn<typeof fetch>().mockResolvedValue(new Response('a'.repeat(65536)));
    expect((await transport({ runtime: 'docker', fetchImpl: exact })(request())).body.length).toBe(
      65536,
    );
  });

  it('enforces the deadline through body reading, even if fetch ignores abort', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(new ReadableStream({ cancel })));
    const result = transport({ runtime: 'docker', fetchImpl })(request());
    const assertion = expect(result).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;
    expect(cancel).toHaveBeenCalled();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('caps custom deadlines and cleans up after caller cancellation', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const send = transport({ runtime: 'docker', fetchImpl, timeoutMs: 20000 });
    const timed = expect(send(request())).rejects.toMatchObject({
      code: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(10000);
    await timed;
    const controller = new AbortController();
    const aborted = expect(send({ ...request(), signal: controller.signal })).rejects.toMatchObject(
      { code: 'refused' },
    );
    controller.abort(new Error('secret'));
    await aborted;
    fetchImpl.mockClear();
    await expect(send({ ...request(), signal: controller.signal })).rejects.toMatchObject({
      code: 'refused',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not follow a redirect response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/secret' },
      }),
    );
    await expect(transport({ runtime: 'cloudflare', fetchImpl })(request())).resolves.toEqual({
      status: 302,
      contentType: null,
      retryAfterMs: null,
      body: '',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('manual');
  });

  it('cancels a response that arrives after its deadline', async () => {
    vi.useFakeTimers();
    let respond!: (value: Response) => void;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    const result = expect(
      transport({ runtime: 'docker', fetchImpl })(request()),
    ).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1500);
    await result;
    const cancel = vi.fn();
    respond(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not expose errors from response body reads', async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.error(new Error('secret@example.com token'));
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(body));
    await expect(transport({ runtime: 'docker', fetchImpl })(request())).rejects.toMatchObject({
      code: 'network',
      message: 'Audit transport failed',
    });
  });

  it('replaces network exceptions with a fixed error', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error('secret@example.com credential'));
    await expect(transport({ runtime: 'docker', fetchImpl })(request())).rejects.toMatchObject({
      name: 'AuditTransportError',
      code: 'network',
      message: 'Audit transport failed',
    });
  });
});

describe('core destination resolution', () => {
  const resolve = (
    values: Record<string, string>,
    options: Partial<Parameters<typeof resolveAuditDestination>[0]> = {},
  ) =>
    resolveAuditDestination({
      id: 'audit',
      runtime: 'docker',
      activation: 'env',
      destination: { protocol: 'otlp-http-json' },
      env: (name) => values[name],
      ...options,
    });

  it('binds one destination and credentials, ignoring plugin attempts to override them', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const resolved = await resolve(
      {
        PB_AUDIT_WEBHOOK_URL: 'https://receiver.example/audit',
        PB_AUDIT_WEBHOOK_HEADERS: 'authorization=Bearer%20operator',
      },
      { destination: { protocol: 'https-json', urlEnv: 'PB_AUDIT_WEBHOOK_URL' }, fetchImpl },
    );
    expect(resolved).toMatchObject({
      activationSource: 'PB_AUDIT_WEBHOOK_URL',
      receiverFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(Object.keys(resolved!).sort()).toEqual([
      'activationSource',
      'fetch',
      'receiverFingerprint',
    ]);
    const injected = {
      ...request(),
      url: 'http://localhost/secret',
      headers: { authorization: 'other' },
      allowPrivate: true,
      timeoutMs: 1,
    };
    await resolved!.fetch(injected);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://receiver.example/audit',
      expect.objectContaining({
        headers: { authorization: 'Bearer operator', 'content-type': 'application/json' },
      }),
    );
  });

  it('uses static custom destination names without reading unrelated credentials', async () => {
    const values = {
      CUSTOM_ENDPOINT: 'https://custom.example/logs',
      CUSTOM_HEADERS: 'x-api-key=custom',
      PB_AUDIT_OTLP_ENDPOINT: 'https://unused.example',
      PB_AUDIT_OTLP_HEADERS: 'invalid',
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
    const resolved = await resolve(values, {
      destination: {
        protocol: 'otlp-http-json',
        endpointEnv: 'CUSTOM_ENDPOINT',
        headersEnv: 'CUSTOM_HEADERS',
      },
      fetchImpl,
    });
    await resolved!.fetch(request());
    expect(resolved!.activationSource).toBe('CUSTOM_ENDPOINT');
    expect(fetchImpl).toHaveBeenCalledWith(
      values.CUSTOM_ENDPOINT,
      expect.objectContaining({
        headers: { 'x-api-key': 'custom', 'content-type': 'application/json' },
      }),
    );
  });

  it('keeps receiver identity stable across credential rotation and changes it for a new URL', async () => {
    const first = await resolve({
      PB_AUDIT_OTLP_ENDPOINT: 'https://receiver.example',
      PB_AUDIT_OTLP_HEADERS: 'authorization=one',
    });
    const rotated = await resolve({
      PB_AUDIT_OTLP_ENDPOINT: 'https://receiver.example/',
      PB_AUDIT_OTLP_HEADERS: 'authorization=two',
    });
    const changed = await resolve({
      PB_AUDIT_OTLP_ENDPOINT: 'https://other.example',
      PB_AUDIT_OTLP_HEADERS: 'authorization=two',
    });
    expect(first!.receiverFingerprint).toBe(rotated!.receiverFingerprint);
    expect(first!.receiverFingerprint).not.toBe(changed!.receiverFingerprint);
  });

  it('distinguishes inactive, required, partial and unauthenticated destinations', async () => {
    expect(await resolve({})).toBeNull();
    await expect(resolve({}, { activation: 'build' })).rejects.toMatchObject({
      code: 'invalid_endpoint',
    });
    for (const values of [
      { PB_AUDIT_OTLP_HEADERS: 'authorization=x' },
      { OTEL_EXPORTER_OTLP_HEADERS: 'authorization=x' },
    ]) {
      await expect(resolve(values)).rejects.toMatchObject({ code: 'invalid_endpoint' });
    }
    await expect(
      resolve({
        PB_AUDIT_OTLP_ENDPOINT: 'https://receiver.example',
        OTEL_EXPORTER_OTLP_HEADERS: 'authorization=telemetry',
      }),
    ).rejects.toMatchObject({ code: 'missing_credential' });
    const webhook = {
      destination: { protocol: 'https-json' as const, urlEnv: 'PB_AUDIT_WEBHOOK_URL' },
    };
    expect(await resolve({}, webhook)).toBeNull();
    await expect(
      resolve({ PB_AUDIT_WEBHOOK_HEADERS: 'authorization=x' }, webhook),
    ).rejects.toMatchObject({ code: 'invalid_endpoint' });
  });

  it('permits private egress only for the configured sink id on Node', async () => {
    const values = {
      PB_AUDIT_OTLP_ENDPOINT: 'http://10.0.0.1',
      PB_AUDIT_OTLP_HEADERS: 'authorization=x',
    };
    for (const runtime of ['docker', 'cloudflare'] as const) {
      for (const id of ['audit', 'other']) {
        const result = resolve(values, {
          runtime,
          id,
          audit: { egress: { allowPrivate: ['audit'] } },
        });
        if (runtime === 'docker' && id === 'audit') expect(await result).not.toBeNull();
        else await expect(result).rejects.toMatchObject({ code: 'invalid_endpoint' });
      }
    }
  });
});

describe('bound request and response limits', () => {
  it('limits UTF-8 request bytes and refuses unsupported content types before sending', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}'));
    const send = transport({ fetchImpl });
    await expect(send({ ...request(), body: 'é'.repeat(262145) })).rejects.toMatchObject({
      code: 'too_large',
    });
    const invalid = { ...request(), contentType: 'text/plain' };
    // @ts-expect-error plugins can only send application/json
    await expect(send(invalid)).rejects.toMatchObject({ code: 'refused' });
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(send({ ...request(), body: 'é'.repeat(262144) })).resolves.toMatchObject({
      status: 200,
    });
  });

  it.each([
    ['120', 120000],
    ['invalid', null],
    ['999999999999999999', null],
    ['Wed, 28 Oct 2026 12:02:00 GMT', 120000],
    ['Wed, 28 Oct 2026 11:00:00 GMT', 0],
  ])('normalizes Retry-After %s without the delivery backoff cap', async (value, expected) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('{}', { headers: { 'retry-after': value } }));
    await expect(transport({ fetchImpl })(request())).resolves.toMatchObject({
      retryAfterMs: expected,
    });
  });
});
