import { describe, expect, it, vi } from 'vitest';
import {
  CREATED,
  DELIVERY,
  EVENT,
  LEASE,
  ORG,
  SIGNING_KEY,
  deliveryWorld,
  memoryCredentials,
  sealedConfiguration,
} from '../test-support/notification-delivery.js';
import { jobFences } from '../platform/job-fences.js';
import { JobRelease } from '../platform/job-release.js';
import { JobError, type JobContext } from '../platform/jobs.js';
import { validateSigningKey } from './config.js';
import { BUSY_RELEASE_SECONDS, createNotificationDeliverJob } from './deliver.js';
import { verifyNotificationSignature } from './signature.js';
import { createNotificationTransport, type NotificationSend } from './transport.js';

const MINUTE = 60_000;

interface Received {
  readonly method: string;
  readonly body: Uint8Array;
  readonly headers: Headers;
}

/** A receiver that verifies signatures and deduplicates by delivery id before any effect. */
function receiver(responses: (() => Response | Promise<Response>)[] = []) {
  const received: Received[] = [];
  const seen = new Set<string>();
  let effects = 0;
  const send = vi.fn<NotificationSend>(async (_url, init) => {
    received.push({ method: init.method, body: init.body.slice(), headers: init.headers });
    const timestamp = Number(init.headers.get('x-package-broker-timestamp'));
    const valid = await verifyNotificationSignature({
      key: validateSigningKey(SIGNING_KEY),
      timestamp,
      deliveryId: init.headers.get('x-package-broker-delivery')!,
      eventId: init.headers.get('x-package-broker-event')!,
      method: init.method,
      body: init.body,
      signature: init.headers.get('x-package-broker-signature')!,
      now: timestamp,
    });
    if (!valid) return new Response(null, { status: 401 });
    const id = init.headers.get('idempotency-key')!;
    if (!seen.has(id)) {
      seen.add(id);
      effects += 1;
    }
    const next = responses.shift();
    return next ? next() : new Response(null, { status: 204 });
  });
  return { send, received, effects: () => effects };
}

async function setup(responses: (() => Response | Promise<Response>)[] = []) {
  const credentials = memoryCredentials();
  const world = deliveryWorld(credentials, await sealedConfiguration(credentials));
  const target = receiver(responses);
  let now = new Date(CREATED);
  const send = vi.fn<NotificationSend>(async (url, init) => {
    world.calls.push({ kind: 'network' });
    return new Promise<Response>((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
      target.send(url, init).then(resolve, reject);
    });
  });
  const allows = vi.fn((url: string) => url.startsWith('https://hooks.example.com/'));
  const transport = createNotificationTransport({ send, destination: allows, selfOrigins: [] });
  const job = createNotificationDeliverJob({
    attempts: world.attempts,
    prepare: world.prepare,
    credentials: credentials.credentials,
    bodies: credentials.bodies,
    transport,
    clock: { now: () => now },
    ids: { ulid: () => '01J0A0D1T00000000000000001' },
  });
  const run = (fence = LEASE.fence, signal = new AbortController().signal) => {
    world.state.currentFence = fence;
    const context: JobContext = {
      org: ORG,
      jobId: LEASE.id,
      idempotencyKey: 'k',
      attempt: 1,
      fence,
      signal,
      ports: {} as never,
      observability: {} as never,
      fences: jobFences({ ...LEASE, fence }),
    };
    return job.handler({ deliveryId: DELIVERY }, context);
  };
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  return { world, target, send, allows, job, run, advance, credentials, transport };
}

async function released(run: Promise<void>): Promise<number> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(JobRelease);
  return (error as JobRelease).delaySeconds;
}

describe('notification delivery job', () => {
  it.each([1, 2])('retries a repository read error during prepare (read %i)', async (read) => {
    const { credentials, world, run, send } = await setup();
    const error = new Error('repository unavailable');
    const get = vi.spyOn(credentials.repository, 'get');
    if (read === 2)
      get.mockResolvedValueOnce(
        credentials.rows.get(world.state.delivery.configurationCredentialId)!,
      );
    get.mockRejectedValueOnce(error);
    await expect(run()).rejects.toBe(error);
    expect(world.state.endpoint?.state).toBe('enabled');
    expect(world.state.disabled).toBeNull();
    expect(world.state.delivery.state).toBe('pending');
    expect(world.state.streak).toBe(0);
    expect(send).not.toHaveBeenCalled();
    await run();
    expect(world.state.delivery.state).toBe('delivered');
  });

  it('rethrows a signing failure without disabling the endpoint', async () => {
    const { world, run } = await setup();
    const error = new Error('crypto unavailable');
    const sign = vi.spyOn(crypto.subtle, 'sign').mockRejectedValueOnce(error);
    try {
      await expect(run()).rejects.toBe(error);
      expect(world.state.disabled).toBeNull();
      expect(world.state.delivery.state).toBe('sending');
    } finally {
      sign.mockRestore();
    }
  });

  it('rethrows a pre-network transport defect without disabling the endpoint', async () => {
    const { world, run, transport } = await setup();
    const error = new Error('transport unavailable');
    vi.spyOn(transport, 'send').mockRejectedValueOnce(error);
    await expect(run()).rejects.toBe(error);
    expect(world.state.disabled).toBeNull();
    expect(world.state.delivery.state).toBe('sending');
  });

  it('does not count template failures toward the receiver failure streak', async () => {
    const { world, run, send } = await setup();
    world.state.streak = 9;
    world.state.payloadJson = '{}';
    await run();
    expect(world.state.delivery.state).toBe('failed');
    expect(world.state.streak).toBe(9);
    expect(world.state.disabled).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('accepts only a delivery id payload', async () => {
    const { job } = await setup();
    expect(job.name).toBe('notification-deliver');
    expect(job.validate({ deliveryId: DELIVERY })).toEqual({ deliveryId: DELIVERY });
    expect(() => job.validate({ deliveryId: DELIVERY, url: 'https://x' })).toThrow();
  });

  it('commits the started attempt and its audit before the network, then settles delivered', async () => {
    const { world, target, run } = await setup();
    await run();
    const order = world.calls.map((call) => call.kind);
    expect(order.indexOf('reserve')).toBeGreaterThan(-1);
    expect(order.indexOf('network')).toBeGreaterThan(order.indexOf('reserve'));
    expect(order.indexOf('settle')).toBeGreaterThan(order.indexOf('network'));
    expect(world.state.delivery.state).toBe('delivered');
    expect(world.state.audits).toEqual([
      'notification.delivery_started',
      'notification.delivery_finished',
    ]);
    expect(target.received).toHaveLength(1);
    expect(target.received[0]!.headers.get('x-package-broker-event')).toBe(EVENT);
    expect(target.received[0]!.headers.get('authorization')).toBe('Bearer SECRETHEADER');
  });

  it('does not reach the network when the start cannot be committed', async () => {
    const { world, send, run } = await setup();
    world.state.endpoint = { state: 'enabled', revision: 1, method: 'POST' };
    world.attempts.reserve = vi.fn(async () => ({ ok: false as const }));
    expect(await released(run())).toBe(BUSY_RELEASE_SECONDS);
    expect(send).not.toHaveBeenCalled();
  });

  it('retries a 503 at the persisted slot honouring Retry-After and never sends early', async () => {
    const { world, send, run, advance } = await setup([
      () => new Response('busy', { status: 503, headers: { 'retry-after': '600' } }),
    ]);
    expect(await released(run())).toBe(600);
    expect(world.state.delivery).toMatchObject({
      state: 'pending',
      attempts: 1,
      nextAttemptAt: '2026-11-01T12:10:00.000Z',
    });
    expect(world.state.attempts).toEqual([{ attempt: 1, outcome: 'retry', code: 'http_retry' }]);
    advance(5 * MINUTE);
    expect(await released(run())).toBe(300);
    expect(send).toHaveBeenCalledTimes(1);
    expect(world.calls.filter((call) => call.kind === 'reserve')).toHaveLength(1);
    advance(5 * MINUTE);
    await run();
    expect(send).toHaveBeenCalledTimes(2);
    expect(world.state.delivery.state).toBe('delivered');
  });

  it('releases hourly for a distant slot without consuming attempts', async () => {
    const { world, send, run, advance } = await setup();
    world.state.delivery = {
      ...world.state.delivery,
      attempts: 4,
      nextAttemptAt: '2026-11-01T18:00:00.000Z',
    };
    expect(await released(run())).toBe(3600);
    advance(60 * MINUTE);
    expect(await released(run())).toBe(3600);
    expect(world.state.delivery.attempts).toBe(4);
    expect(send).not.toHaveBeenCalled();
  });

  it('resends the same bytes and delivery id after a crash past acceptance; the receiver deduplicates', async () => {
    const { world, target, run, advance } = await setup();
    const settle = world.attempts.settle;
    world.attempts.settle = vi.fn(async () => {
      throw new Error('process died after the receiver accepted');
    });
    await expect(run()).rejects.toThrow();
    expect(world.state.delivery.state).toBe('sending');
    world.attempts.settle = settle;
    expect(await released(run(2))).toBeGreaterThanOrEqual(1);
    expect(world.state.attempts.at(-1)).toMatchObject({ outcome: 'unknown' });
    expect(world.state.delivery.state).toBe('pending');
    expect(world.state.streak).toBe(0);
    advance(5 * MINUTE + 1000);
    await run(2);
    expect(target.received).toHaveLength(2);
    const [first, second] = target.received;
    expect([...second!.body]).toEqual([...first!.body]);
    expect(second!.headers.get('idempotency-key')).toBe(first!.headers.get('idempotency-key'));
    expect(second!.headers.get('x-package-broker-timestamp')).not.toBe(
      first!.headers.get('x-package-broker-timestamp'),
    );
    expect(target.effects()).toBe(1);
  });

  it('settles a job abort during the send as unknown without counting it', async () => {
    const controller = new AbortController();
    const { world, run } = await setup([
      () => {
        controller.abort();
        return new Promise<Response>(() => undefined);
      },
    ]);
    await expect(run(1, controller.signal)).rejects.toBeInstanceOf(JobRelease);
    expect(world.state.attempts).toEqual([{ attempt: 1, outcome: 'unknown', code: 'unknown' }]);
    expect(world.state.streak).toBe(0);
  });

  it('reports a lost lease when the settlement is refused', async () => {
    const { world, run } = await setup();
    world.attempts.settle = vi.fn(async () => false);
    await expect(run()).rejects.toMatchObject({ code: 'lease_lost' });
  });

  it.each([
    [401, 'http_permanent', 'credentials'],
    [403, 'http_permanent', 'credentials'],
    [410, 'http_permanent', 'gone'],
    [404, 'http_permanent', null],
    [302, 'redirect', null],
  ])('fails a %i permanently with code %s and disable %s', async (status, code, disable) => {
    const { world, run } = await setup([
      () => new Response(null, { status, headers: { location: 'https://other.example.com/' } }),
    ]);
    await run();
    expect(world.state.delivery.state).toBe('failed');
    expect(world.state.attempts[0]).toMatchObject({ outcome: 'failed', code });
    expect(world.state.disabled).toBe(disable);
    expect(world.state.streak).toBe(1);
  });

  it.each([408, 425, 429, 500, 599])('retries a %i', async (status) => {
    const { world, run } = await setup([() => new Response(null, { status })]);
    await expect(run()).rejects.toBeInstanceOf(JobRelease);
    expect(world.state.delivery.state).toBe('pending');
    expect(world.state.streak).toBe(0);
  });

  it('fails and disables for policy when the destination is refused at send time', async () => {
    const { world, allows, send, run } = await setup();
    allows.mockImplementationOnce(() => true).mockImplementation(() => false);
    await run();
    expect(send).not.toHaveBeenCalled();
    expect(world.state.attempts[0]).toMatchObject({ outcome: 'failed', code: 'policy' });
    expect(world.state.disabled).toBe('policy');
  });

  it('expires at the deadline and at the attempt limit without sending', async () => {
    const late = await setup();
    late.advance(24 * 60 * MINUTE);
    await late.run();
    expect(late.world.calls.filter((call) => call.kind === 'finish')).toEqual([
      { kind: 'finish', input: 'expired' },
    ]);
    expect(late.send).not.toHaveBeenCalled();
    const full = await setup();
    full.world.state.delivery = { ...full.world.state.delivery, attempts: 8 };
    await full.run();
    expect(full.world.calls.filter((call) => call.kind === 'finish')).toEqual([
      { kind: 'finish', input: 'attempt_limit' },
    ]);
    expect(full.send).not.toHaveBeenCalled();
  });

  it('fails the last retryable attempt at the attempt limit', async () => {
    const { world, run } = await setup([() => new Response(null, { status: 500 })]);
    world.state.delivery = { ...world.state.delivery, attempts: 7 };
    await run();
    expect(world.state.delivery.state).toBe('failed');
    expect(world.calls.find((call) => call.kind === 'terminal')?.input).toBe('attempt_limit');
    expect(world.state.streak).toBe(1);
  });

  it('cancels without a network call when the endpoint changed', async () => {
    const { world, send, run } = await setup();
    world.state.endpoint = { state: 'enabled', revision: 2, method: 'POST' };
    await run();
    expect(world.state.delivery.state).toBe('cancelled');
    expect(world.state.audits).toEqual(['notification.delivery_cancelled']);
    expect(send).not.toHaveBeenCalled();
  });

  it('does nothing for a delivery another job generation owns, or one that is gone', async () => {
    const { world, send, run } = await setup();
    world.state.delivery = { ...world.state.delivery, activeJobId: '01J0J0B00000000000000000J2' };
    await run();
    world.state.delivery = { ...world.state.delivery, activeJobId: LEASE.id, state: 'cancelled' };
    await run();
    expect(send).not.toHaveBeenCalled();
    expect(world.calls.map((call) => call.kind)).toEqual(['context', 'context']);
  });

  it('refuses to act on a sending delivery its own current claim started', async () => {
    const { world, send, run } = await setup();
    world.state.delivery = { ...world.state.delivery, state: 'sending', activeFence: 1 };
    await expect(run(1)).rejects.toBeInstanceOf(JobError);
    expect(send).not.toHaveBeenCalled();
  });
});
