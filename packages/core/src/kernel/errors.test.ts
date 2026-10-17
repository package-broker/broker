import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultLog, envelopeResponse, errorResponse, logError, responseReason } from './errors.js';
import type { KernelLog } from './errors.js';
import { liveResponse, readyResponse } from './health.js';
import { NotBootstrappedError } from './org.js';
import { KernelConfigError } from './registry.js';
import { SecretsConfigError } from '../secrets/master-key.js';
import { DbError } from '../db/errors.js';
import { orgContext } from '../db/port.js';
import type { OrgContext } from '../db/port.js';

interface Envelope {
  readonly error: { readonly code: string; readonly message: string; readonly requestId: string };
}

function recorder(): { log: KernelLog; entries: Readonly<Record<string, unknown>>[] } {
  const entries: Readonly<Record<string, unknown>>[] = [];
  return { log: (entry) => entries.push(entry), entries };
}

async function envelopeOf(response: Response): Promise<Envelope> {
  return (await response.json()) as Envelope;
}

const org = (): Promise<OrgContext> => Promise.resolve(orgContext('org-1'));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

function throwingLog(): KernelLog {
  return () => {
    throw new Error('log sink down');
  };
}

describe('envelopeResponse', () => {
  it('returns the JSON envelope with content type and request id headers', async () => {
    const response = envelopeResponse(404, 'not_found', 'Not found', 'req-404');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('x-request-id')).toBe('req-404');
    expect(await response.json()).toEqual({
      error: { code: 'not_found', message: 'Not found', requestId: 'req-404' },
    });
  });
});

describe('errorResponse', () => {
  it('maps an unknown error to 500 internal without leaking its message', async () => {
    const { log, entries } = recorder();

    const response = errorResponse(new Error('secret SELECT * FROM token'), 'req-1', log);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(response.headers.get('x-request-id')).toBe('req-1');
    expect(JSON.parse(text)).toEqual({
      error: { code: 'internal', message: 'Internal error', requestId: 'req-1' },
    });
    expect(text).not.toContain('secret');
    expect(text).not.toContain('SELECT');
    expect(entries).toEqual([
      { level: 'error', event: 'http.error', request_id: 'req-1', error_name: 'Error' },
    ]);
    const logged = JSON.stringify(entries);
    expect(logged).not.toContain('secret');
    expect(logged).not.toContain('SELECT');
  });

  it('maps NotBootstrappedError to 503 not_bootstrapped', async () => {
    const { log, entries } = recorder();

    const response = errorResponse(new NotBootstrappedError(), 'req-2', log);
    const body = await envelopeOf(response);

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    expect(body.error).toEqual({
      code: 'not_bootstrapped',
      message: 'Organization is not bootstrapped',
      requestId: 'req-2',
    });
    expect(entries).toEqual([
      {
        level: 'error',
        event: 'http.error',
        request_id: 'req-2',
        error_name: 'NotBootstrappedError',
      },
    ]);
  });

  it('maps a busy DbError to 503 unavailable and logs its kind', async () => {
    const { log, entries } = recorder();

    const response = errorResponse(new DbError('busy', 'busy: SQLITE_BUSY on token'), 'req-3', log);
    const body = await envelopeOf(response);

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    expect(body.error).toEqual({
      code: 'unavailable',
      message: 'Try again later',
      requestId: 'req-3',
    });
    expect(entries).toEqual([
      {
        level: 'error',
        event: 'http.error',
        request_id: 'req-3',
        error_name: 'DbError',
        reason_code: 'db.busy',
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain('token');
  });

  it('maps a non-busy DbError to 500 internal and logs its kind', async () => {
    const { log, entries } = recorder();

    const response = errorResponse(
      new DbError('unique', 'unique: UNIQUE constraint failed: token.secret'),
      'req-4',
      log,
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain('secret');
    expect(entries).toEqual([
      {
        level: 'error',
        event: 'http.error',
        request_id: 'req-4',
        error_name: 'DbError',
        reason_code: 'db.unique',
      },
    ]);
  });

  it('maps a thrown non-Error value to 500 internal without logging its content', async () => {
    const { log, entries } = recorder();

    const response = errorResponse('secret string', 'req-5', log);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain('secret');
    expect(entries).toEqual([
      { level: 'error', event: 'http.error', request_id: 'req-5', error_name: 'Error' },
    ]);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });
});

describe('defaultLog', () => {
  it('writes one JSON line to console.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    defaultLog({ level: 'error', requestId: 'req-6', error: 'DbError', kind: 'busy' });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      '{"level":"error","requestId":"req-6","error":"DbError","kind":"busy"}',
    );
  });
});

describe('liveResponse', () => {
  it('returns 200 live with the request id', async () => {
    const response = liveResponse('req-7');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-7');
    expect(await response.json()).toEqual({ status: 'live' });
  });
});

describe('readyResponse', () => {
  it('returns 200 ready when the probe is true and the org resolves', async () => {
    const response = await readyResponse(() => Promise.resolve(true), org, 'req-8');

    expect(response.status).toBe(200);
    expect(response.headers.get('x-request-id')).toBe('req-8');
    expect(await response.json()).toEqual({ status: 'ready' });
  });

  it('returns 503 not_ready when the probe is false', async () => {
    const response = await readyResponse(() => Promise.resolve(false), org, 'req-9');
    const body = await envelopeOf(response);

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe(body.error.requestId);
    expect(body.error).toEqual({ code: 'not_ready', message: 'Not ready', requestId: 'req-9' });
  });

  it('returns 503 not_ready when the probe rejects', async () => {
    const response = await readyResponse(() => Promise.reject(new Error('db down')), org, 'req-10');
    const body = await envelopeOf(response);

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('req-10');
    expect(body.error).toEqual({ code: 'not_ready', message: 'Not ready', requestId: 'req-10' });
  });

  it('returns 503 not_ready when resolveOrg rejects', async () => {
    const response = await readyResponse(
      () => Promise.resolve(true),
      () => Promise.reject(new NotBootstrappedError()),
      'req-11',
    );
    const body = await envelopeOf(response);

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('req-11');
    expect(body).toEqual({
      error: { code: 'not_ready', message: 'Not ready', requestId: 'req-11' },
    });
  });

  it('calls the probe on every invocation without caching the result', async () => {
    const probe = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('db down'));

    const first = await readyResponse(probe, org, 'req-12');
    const second = await readyResponse(probe, org, 'req-13');

    expect(first.status).toBe(200);
    expect(second.status).toBe(503);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('cache-control', () => {
  it('marks live, ready and every error envelope as no-store', async () => {
    const responses = [
      liveResponse('req-20'),
      await readyResponse(() => Promise.resolve(true), org, 'req-21'),
      await readyResponse(() => Promise.resolve(false), org, 'req-22'),
      envelopeResponse(404, 'not_found', 'Not found', 'req-23'),
      errorResponse(new Error('boom'), 'req-24', () => undefined),
      errorResponse(new NotBootstrappedError(), 'req-25', () => undefined),
    ];

    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('errorResponse log safety', () => {
  it('returns the envelope when the log throws', async () => {
    const response = errorResponse(new Error('boom'), 'req-30', throwingLog());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: { code: 'internal', message: 'Internal error', requestId: 'req-30' },
    });
  });

  it('logs Error for a well-formed custom error name outside the allowlist', () => {
    const { log, entries } = recorder();
    const error = new Error('boom');
    error.name = `$Custom_${'a'.repeat(56)}`;

    errorResponse(error, 'req-31', log);

    expect(entries).toEqual([
      { level: 'error', event: 'http.error', request_id: 'req-31', error_name: 'Error' },
    ]);
  });

  it.each([
    ['contains spaces and SQL', 'secret SELECT * FROM token'],
    ['starts with a digit', '1Error'],
    ['is empty', ''],
    ['is longer than 64 characters', `E${'a'.repeat(64)}`],
  ])('logs Error when the error name %s', (_label, name) => {
    const { log, entries } = recorder();
    const error = new Error('boom');
    error.name = name;

    errorResponse(error, 'req-32', log);

    expect(entries).toEqual([
      { level: 'error', event: 'http.error', request_id: 'req-32', error_name: 'Error' },
    ]);
  });
});

describe('readyResponse logging', () => {
  it('logs a probe that resolves false', async () => {
    const { log, entries } = recorder();

    await readyResponse(() => Promise.resolve(false), org, 'req-40', { log });

    expect(entries).toEqual([
      { level: 'error', event: 'http.error', request_id: 'req-40', error_name: 'ProbeFailedError' },
    ]);
  });

  it('logs a rejecting probe by name and kind without its message', async () => {
    const { log, entries } = recorder();

    await readyResponse(
      () => Promise.reject(new DbError('busy', 'busy: SQLITE_BUSY secret')),
      org,
      'req-41',
      { log },
    );

    expect(entries).toEqual([
      {
        level: 'error',
        event: 'http.error',
        request_id: 'req-41',
        error_name: 'DbError',
        reason_code: 'db.busy',
      },
    ]);
    expect(JSON.stringify(entries)).not.toContain('secret');
  });

  it('logs a rejecting resolveOrg', async () => {
    const { log, entries } = recorder();

    await readyResponse(
      () => Promise.resolve(true),
      () => Promise.reject(new NotBootstrappedError()),
      'req-42',
      { log },
    );

    expect(entries).toEqual([
      {
        level: 'error',
        event: 'http.error',
        request_id: 'req-42',
        error_name: 'NotBootstrappedError',
      },
    ]);
  });

  it('does not log a ready response', async () => {
    const { log, entries } = recorder();

    await readyResponse(() => Promise.resolve(true), org, 'req-43', { log });

    expect(entries).toEqual([]);
  });

  it('returns 503 not_ready when the log throws', async () => {
    const response = await readyResponse(() => Promise.resolve(false), org, 'req-44', {
      log: throwingLog(),
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'not_ready', message: 'Not ready', requestId: 'req-44' },
    });
  });
});

describe('readyResponse probe and org sequencing', () => {
  it('skips resolveOrg when the probe is false', async () => {
    const resolveOrg = vi.fn<() => Promise<OrgContext>>().mockImplementation(org);

    await readyResponse(() => Promise.resolve(false), resolveOrg, 'req-50');

    expect(resolveOrg).not.toHaveBeenCalled();
  });

  it('returns 200 then 503 when resolveOrg resolves and then rejects', async () => {
    const resolveOrg = vi
      .fn<() => Promise<OrgContext>>()
      .mockResolvedValueOnce(orgContext('org-1'))
      .mockRejectedValueOnce(new NotBootstrappedError());
    const probe = (): Promise<boolean> => Promise.resolve(true);

    const first = await readyResponse(probe, resolveOrg, 'req-51');
    const second = await readyResponse(probe, resolveOrg, 'req-52');

    expect(first.status).toBe(200);
    expect(second.status).toBe(503);
    expect(resolveOrg).toHaveBeenCalledTimes(2);
  });
});

describe('readyResponse timeout', () => {
  it('returns 503 not_ready after 2000 ms by default when the probe hangs', async () => {
    vi.useFakeTimers();
    const { log, entries } = recorder();
    let settled = false;

    const pending = readyResponse(never, org, 'req-60', { log }).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: 'not_ready', message: 'Not ready', requestId: 'req-60' },
    });
    expect(entries).toEqual([
      {
        level: 'error',
        event: 'http.error',
        request_id: 'req-60',
        error_name: 'ReadinessTimeoutError',
      },
    ]);
  });

  it('returns 503 not_ready when resolveOrg hangs past a custom timeout', async () => {
    vi.useFakeTimers();

    const pending = readyResponse(() => Promise.resolve(true), never, 'req-61', {
      timeoutMs: 50,
    });
    await vi.advanceTimersByTimeAsync(50);
    const response = await pending;

    expect(response.status).toBe(503);
  });

  it('clears the timer when the check finishes in time', async () => {
    vi.useFakeTimers();

    const response = await readyResponse(() => Promise.resolve(true), org, 'req-62');

    expect(response.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('errorResponse configuration errors', () => {
  const VECTOR = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
  const BODY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';

  it.each([
    ['SecretsConfigError', () => new SecretsConfigError('malformed', 'PB_MASTER_KEY')],
    ['KernelConfigError', () => new KernelConfigError([`bad value ${VECTOR}`])],
  ])('maps %s to 503 misconfigured without key text', async (name, make) => {
    const { log, entries } = recorder();
    const error = make();
    error.message = `${error.message} ${VECTOR}`;

    const response = errorResponse(error, 'req-70', log);
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(response.headers.get('x-request-id')).toBe('req-70');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(JSON.parse(text)).toEqual({
      error: { code: 'misconfigured', message: 'Server is not configured', requestId: 'req-70' },
    });
    expect(text).not.toContain(BODY);
    expect(entries).toEqual([
      { level: 'error', event: 'http.error', request_id: 'req-70', error_name: name },
    ]);
    expect(JSON.stringify(entries)).not.toContain(BODY);
  });
});

describe('logError', () => {
  it('emits the http.error record for a plain error', () => {
    const { log, entries } = recorder();

    logError(log, 'req-80', new TypeError('boom'));

    expect(entries).toEqual([
      { level: 'error', event: 'http.error', request_id: 'req-80', error_name: 'TypeError' },
    ]);
    expect(Object.keys(entries[0] ?? {})).not.toContain('reason_code');
  });

  it('adds reason_code db.<kind> for a DbError and no kind or message', () => {
    const { log, entries } = recorder();

    logError(
      log,
      'req-81',
      new DbError('foreign_key', 'foreign_key: FOREIGN KEY constraint failed'),
    );

    expect(entries).toEqual([
      {
        level: 'error',
        event: 'http.error',
        request_id: 'req-81',
        error_name: 'DbError',
        reason_code: 'db.foreign_key',
      },
    ]);
    expect(Object.keys(entries[0] ?? {})).not.toContain('kind');
    expect(Object.keys(entries[0] ?? {})).not.toContain('message');
  });

  it('leaves a secret-looking message out of the record', () => {
    const { log, entries } = recorder();
    const error = new Error('token=pbt_live_s3cr3tvalue');

    logError(log, 'req-82', error);

    expect(JSON.stringify(entries)).not.toContain('s3cr3t');
  });

  it('does not throw when the log throws', () => {
    expect(() => logError(throwingLog(), 'req-83', new Error('x'))).not.toThrow();
  });
});

describe('responseReason', () => {
  it.each([
    ['not_bootstrapped', new NotBootstrappedError(), 'error.not_bootstrapped'],
    ['misconfigured', new KernelConfigError(['bad']), 'error.misconfigured'],
    ['unavailable', new DbError('busy', 'busy: database is locked'), 'error.unavailable'],
    ['internal', new Error('x'), 'error.internal'],
  ] as const)('is attached by errorResponse for %s', (_name, error, reason) => {
    expect(responseReason(errorResponse(error, 'req-r1', () => undefined))).toBe(reason);
  });

  it('is attached by envelopeResponse only when a reason is given', () => {
    expect(
      responseReason(envelopeResponse(503, 'unavailable', 'x', 'r', 'authz.engine_error')),
    ).toBe('authz.engine_error');
    expect(responseReason(envelopeResponse(403, 'forbidden', 'x', 'r'))).toBeUndefined();
  });

  it('is undefined for a response the kernel did not build', () => {
    expect(responseReason(Response.json({ error: { code: 'unavailable' } }, { status: 503 }))).toBe(
      undefined,
    );
  });

  it('keeps the reason out of the headers and the body', async () => {
    const response = errorResponse(new Error('x'), 'req-r2', () => undefined);
    expect(JSON.stringify([...response.headers])).not.toContain('error.internal');
    expect(await response.text()).not.toContain('error.internal');
  });
});
