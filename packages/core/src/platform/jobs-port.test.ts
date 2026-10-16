import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import type { JobEnqueue } from './job-repository.js';
import { IdempotencyConflictError } from './job-repository.js';
import {
  canonicalPayload,
  DEFAULT_MAX_ATTEMPTS,
  defineJob,
  type EnqueueInput,
  JobError,
  type JobDefinition,
  type JobStatus,
} from './jobs.js';
import { createRepositoryJobs, MAX_RUN_AT_AHEAD_SECONDS, type JobStore } from './jobs-port.js';

const NOW = '2026-10-16T12:00:00.000Z';
const ctx = orgContext('org-1');

function definition(name: string, extra: Partial<JobDefinition> = {}): JobDefinition {
  return defineJob({
    name,
    version: 1,
    validate: (input: unknown) => input,
    handler: async () => {},
    ...extra,
  });
}

function status(id: string, type: string): JobStatus {
  return {
    id,
    type,
    state: 'queued',
    attempts: 0,
    maxAttempts: 5,
    runAt: NOW,
    lastErrorCode: null,
    history: [],
  };
}

interface FakeStore extends JobStore {
  readonly enqueued: JobEnqueue[];
  readonly statusCalls: string[];
}

function fakeStore(
  options: {
    result?: { id: string; created: boolean };
    statuses?: Map<string, JobStatus>;
    enqueueError?: Error;
  } = {},
): FakeStore {
  const enqueued: JobEnqueue[] = [];
  const statusCalls: string[] = [];
  return {
    enqueued,
    statusCalls,
    async enqueue(_ctx, row) {
      enqueued.push(row);
      if (options.enqueueError !== undefined) throw options.enqueueError;
      return options.result ?? { id: row.id, created: true };
    },
    async status(_ctx, id) {
      statusCalls.push(id);
      return options.statuses?.get(id) ?? null;
    },
  };
}

type JobEntry = { qualifiedName: string; definition: JobDefinition };

function setup(store: FakeStore = fakeStore(), extra: JobEntry[] = []) {
  let counter = 0;
  const factory = createRepositoryJobs({
    store,
    jobs: [
      { qualifiedName: 'a:sync:v1', definition: definition('sync', { maxAttempts: 7 }) },
      { qualifiedName: 'a:plain:v1', definition: definition('plain') },
      {
        qualifiedName: 'a:strict:v1',
        definition: definition('strict', {
          validate: () => {
            throw new Error('secret detail');
          },
        }),
      },
      { qualifiedName: 'b:x:v1', definition: definition('x') },
      { qualifiedName: 'core:x:v1', definition: definition('x') },
      ...extra,
    ],
    clock: fixedClock(NOW),
    ids: { ulid: () => `ULID${++counter}` },
  });
  return { store, factory };
}

async function expectJobError(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(JobError);
  expect((error as JobError).code).toBe(code);
}

describe('createRepositoryJobs enqueue', () => {
  it('builds one store row from the definition, key, initiator and ids', async () => {
    const { store, factory } = setup();
    const jobs = factory('a', { projectId: 'proj-1', tokenId: 'tok-1' });
    const payload = { z: 1, a: ['x'] };
    const result = await jobs.enqueue(ctx, 'a:sync:v1', payload, {
      idempotencyKey: 'k1',
      resourceKey: 'res-1',
    });
    expect(result).toEqual({ id: 'ULID1', created: true });
    expect(store.enqueued).toEqual([
      {
        id: 'ULID1',
        type: 'a:sync:v1',
        payloadJson: canonicalPayload(payload),
        idempotencyKey: 'a:sync:v1:k1',
        resourceKey: 'res-1',
        runAt: null,
        maxAttempts: 7,
        projectId: 'proj-1',
        initiatorTokenId: 'tok-1',
      },
    ]);
  });

  it('defaults maxAttempts and resourceKey and returns an existing row unchanged', async () => {
    const existing = { id: 'EXISTING', created: false };
    const { store, factory } = setup(fakeStore({ result: existing }));
    const jobs = factory('a', { projectId: null, tokenId: null });
    const result = await jobs.enqueue(ctx, 'a:plain:v1', {}, { idempotencyKey: 'k' });
    expect(result).toBe(existing);
    expect(store.enqueued).toHaveLength(1);
    expect(store.enqueued[0]).toMatchObject({
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      resourceKey: null,
      projectId: null,
      initiatorTokenId: null,
    });
  });

  it('returns a frozen Jobs object', () => {
    const { factory } = setup();
    expect(Object.isFrozen(factory('a', { projectId: null, tokenId: null }))).toBe(true);
  });
});

describe('createRepositoryJobs ownership', () => {
  const initiator = { projectId: null, tokenId: null };

  it.each(['b:x:v1', 'core:x:v1', 'not a type'])('plugin a cannot enqueue %s', async (type) => {
    const { store, factory } = setup();
    await expectJobError(
      factory('a', initiator).enqueue(ctx, type, {}, { idempotencyKey: 'k' }),
      'invalid_name',
    );
    expect(store.enqueued).toHaveLength(0);
  });

  it('owner core can enqueue a core type', async () => {
    const { store, factory } = setup();
    await factory('core', initiator).enqueue(ctx, 'core:x:v1', {}, { idempotencyKey: 'k' });
    expect(store.enqueued).toHaveLength(1);
    expect(store.enqueued[0]?.type).toBe('core:x:v1');
  });

  it('owner core cannot enqueue a plugin type', async () => {
    const { store, factory } = setup();
    await expectJobError(
      factory('core', initiator).enqueue(ctx, 'a:sync:v1', {}, { idempotencyKey: 'k' }),
      'invalid_name',
    );
    expect(store.enqueued).toHaveLength(0);
  });

  it.each(['', 'Core', 'a'.repeat(65)])('factory rejects plugin id %j', (pluginId) => {
    const { factory } = setup();
    let error: unknown;
    try {
      factory(pluginId, initiator);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('invalid_name');
  });
});

describe('createRepositoryJobs validation', () => {
  const initiator = { projectId: null, tokenId: null };

  it('rejects an unregistered owned type', async () => {
    const { store, factory } = setup();
    await expectJobError(
      factory('a', initiator).enqueue(ctx, 'a:missing:v1', {}, { idempotencyKey: 'k' }),
      'unknown_job_type',
    );
    expect(store.enqueued).toHaveLength(0);
  });

  it('maps a plain validate error to invalid_payload without its message', async () => {
    const { store, factory } = setup();
    const error: unknown = await factory('a', initiator)
      .enqueue(ctx, 'a:strict:v1', {}, { idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('invalid_payload');
    expect((error as JobError).message).not.toContain('secret detail');
    expect(store.enqueued).toHaveLength(0);
  });

  it('rejects a payload over 16 KiB', async () => {
    const { store, factory } = setup();
    await expectJobError(
      factory('a', initiator).enqueue(
        ctx,
        'a:plain:v1',
        { blob: 'x'.repeat(17 * 1024) },
        { idempotencyKey: 'k' },
      ),
      'payload_too_large',
    );
    expect(store.enqueued).toHaveLength(0);
  });
});

describe('createRepositoryJobs round 2 hardening', () => {
  const initiator = { projectId: null, tokenId: null };

  it('rejects a validator that returns a thenable and attaches a rejection handler', async () => {
    let handlers = 0;
    const thenable = {
      then(_onFulfilled: unknown, onRejected: unknown) {
        if (typeof onRejected === 'function') handlers += 1;
      },
    };
    const store = fakeStore();
    const { factory } = setup(store, [
      {
        qualifiedName: 'a:thenable:v1',
        definition: definition('thenable', { validate: () => thenable }),
      },
    ]);
    await expectJobError(
      factory('a', initiator).enqueue(ctx, 'a:thenable:v1', {}, { idempotencyKey: 'k' }),
      'invalid_payload',
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handlers).toBeGreaterThan(0);
    expect(store.enqueued).toHaveLength(0);
  });

  it('sanitizes a validator result whose then getter throws', async () => {
    const hostile = {
      get then(): unknown {
        throw new Error('secret detail');
      },
    };
    const store = fakeStore();
    const { factory } = setup(store, [
      {
        qualifiedName: 'a:hostile:v1',
        definition: definition('hostile', { validate: () => hostile }),
      },
    ]);
    const error: unknown = await factory('a', initiator)
      .enqueue(ctx, 'a:hostile:v1', {}, { idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('invalid_payload');
    expect((error as JobError).message).not.toContain('secret detail');
    expect(store.enqueued).toHaveLength(0);
  });

  it('reports a rejected payload before a bad enqueue input', async () => {
    const { store, factory } = setup();
    await expectJobError(
      factory('a', initiator).enqueue(ctx, 'a:strict:v1', {}, null as unknown as EnqueueInput),
      'invalid_payload',
    );
    await expectJobError(
      factory('a', initiator).enqueue(ctx, 'a:plain:v1', { n: Number.NaN }, { idempotencyKey: '' }),
      'invalid_payload',
    );
    expect(store.enqueued).toHaveLength(0);
  });

  it('rejects an async function validator', async () => {
    const store = fakeStore();
    const { factory } = setup(store, [
      {
        qualifiedName: 'a:async:v1',
        definition: definition('async', {
          validate: (async () => {
            throw new Error('secret detail');
          }) as unknown as JobDefinition['validate'],
        }),
      },
    ]);
    await expectJobError(
      factory('a', initiator).enqueue(ctx, 'a:async:v1', {}, { idempotencyKey: 'k' }),
      'invalid_payload',
    );
    expect(store.enqueued).toHaveLength(0);
  });

  it('serializes once: the validator sees exactly the stored payload', async () => {
    const seen: unknown[] = [];
    const store = fakeStore();
    const { factory } = setup(store, [
      {
        qualifiedName: 'a:spy:v1',
        definition: definition('spy', {
          validate: (input: unknown) => {
            seen.push(input);
            return input;
          },
        }),
      },
    ]);
    let reads = 0;
    const payload = new Proxy<Record<string, unknown>>(
      { n: 0 },
      {
        getOwnPropertyDescriptor(target, key) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
          if (descriptor === undefined || key !== 'n') return descriptor;
          reads += 1;
          return { ...descriptor, value: reads };
        },
        get(_target, key) {
          if (key !== 'n') return undefined;
          reads += 1;
          return reads;
        },
      },
    );
    await factory('a', initiator).enqueue(ctx, 'a:spy:v1', payload, { idempotencyKey: 'k' });
    expect(reads).toBeGreaterThan(1);
    expect(store.enqueued).toHaveLength(1);
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(seen[0])).toBe(store.enqueued[0]?.payloadJson);
  });

  it('rejects a duplicate qualifiedName', () => {
    let error: unknown;
    try {
      setup(fakeStore(), [{ qualifiedName: 'a:plain:v1', definition: definition('plain') }]);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(JobError);
    expect((error as JobError).code).toBe('invalid_definition');
  });

  it.each([null, undefined, 'k', 1])('rejects a non-object enqueue input %j', async (input) => {
    const { store, factory } = setup();
    const error: unknown = await factory('a', initiator)
      .enqueue(ctx, 'a:plain:v1', {}, input as unknown as EnqueueInput)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobError);
    expect(store.enqueued).toHaveLength(0);
  });
});

describe('createRepositoryJobs runAt', () => {
  const initiator = { projectId: null, tokenId: null };
  const horizon = Date.parse(NOW) + MAX_RUN_AT_AHEAD_SECONDS * 1000;

  it('passes a valid instant within the horizon through', async () => {
    const { store, factory } = setup();
    const runAt = new Date(horizon).toISOString();
    await factory('a', initiator).enqueue(ctx, 'a:plain:v1', {}, { idempotencyKey: 'k', runAt });
    expect(store.enqueued[0]?.runAt).toBe(runAt);
  });

  it('passes an instant strictly inside the horizon through', async () => {
    const { store, factory } = setup();
    const runAt = new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString();
    await factory('a', initiator).enqueue(ctx, 'a:plain:v1', {}, { idempotencyKey: 'k', runAt });
    expect(store.enqueued[0]?.runAt).toBe(runAt);
  });

  it('accepts a past instant', async () => {
    const { store, factory } = setup();
    const runAt = '2020-01-01T00:00:00.000Z';
    await factory('a', initiator).enqueue(ctx, 'a:plain:v1', {}, { idempotencyKey: 'k', runAt });
    expect(store.enqueued[0]?.runAt).toBe(runAt);
  });

  it('rejects an instant one millisecond past the horizon', async () => {
    const { store, factory } = setup();
    const runAt = new Date(horizon + 1).toISOString();
    await expectJobError(
      factory('a', initiator).enqueue(ctx, 'a:plain:v1', {}, { idempotencyKey: 'k', runAt }),
      'invalid_run_at',
    );
    expect(store.enqueued).toHaveLength(0);
  });

  it('rejects an offset form', async () => {
    const { store, factory } = setup();
    await expectJobError(
      factory('a', initiator).enqueue(
        ctx,
        'a:plain:v1',
        {},
        { idempotencyKey: 'k', runAt: '2026-10-16T13:00:00.000+01:00' },
      ),
      'invalid_run_at',
    );
    expect(store.enqueued).toHaveLength(0);
  });

  it('rejects a form without milliseconds', async () => {
    const { store, factory } = setup();
    await expectJobError(
      factory('a', initiator).enqueue(
        ctx,
        'a:plain:v1',
        {},
        { idempotencyKey: 'k', runAt: '2026-10-16T13:00:00Z' },
      ),
      'invalid_run_at',
    );
    expect(store.enqueued).toHaveLength(0);
  });
});

describe('createRepositoryJobs idempotency keys', () => {
  const initiator = { projectId: null, tokenId: null };

  it.each([
    ['empty', ''],
    ['161 characters', 'k'.repeat(161)],
    ['schedule: prefix', 'schedule:x'],
  ])('rejects a %s key', async (_label, idempotencyKey) => {
    const { store, factory } = setup();
    await expectJobError(
      factory('a', initiator).enqueue(ctx, 'a:plain:v1', {}, { idempotencyKey }),
      'invalid_idempotency_key',
    );
    expect(store.enqueued).toHaveLength(0);
  });

  it('propagates an IdempotencyConflictError from the store', async () => {
    const { store, factory } = setup(fakeStore({ enqueueError: new IdempotencyConflictError() }));
    const error: unknown = await factory('a', initiator)
      .enqueue(ctx, 'a:plain:v1', {}, { idempotencyKey: 'k' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IdempotencyConflictError);
    expect((error as JobError).code).toBe('idempotency_conflict');
    expect(store.enqueued).toHaveLength(1);
  });
});

describe('createRepositoryJobs get', () => {
  const initiator = { projectId: null, tokenId: null };
  const owned = status('J1', 'a:sync:v1');
  const foreign = status('J2', 'b:x:v1');
  const statuses = new Map([
    ['J1', owned],
    ['J2', foreign],
  ]);

  it('returns the status of an owned job unchanged', async () => {
    const store = fakeStore({ statuses });
    const { factory } = setup(store);
    expect(await factory('a', initiator).get(ctx, 'J1')).toBe(owned);
    expect(store.statusCalls).toEqual(['J1']);
  });

  it('returns null for a missing job', async () => {
    const store = fakeStore({ statuses });
    const { factory } = setup(store);
    expect(await factory('a', initiator).get(ctx, 'J9')).toBeNull();
    expect(store.statusCalls).toEqual(['J9']);
  });

  it("returns null for another plugin's job", async () => {
    const store = fakeStore({ statuses });
    const { factory } = setup(store);
    expect(await factory('a', initiator).get(ctx, 'J2')).toBeNull();
    expect(store.statusCalls).toEqual(['J2']);
  });

  it('owner core reads a core job', async () => {
    const coreStatus = status('J3', 'core:x:v1');
    const store = fakeStore({ statuses: new Map([['J3', coreStatus]]) });
    const { factory } = setup(store);
    expect(await factory('core', initiator).get(ctx, 'J3')).toBe(coreStatus);
    expect(store.statusCalls).toEqual(['J3']);
  });

  it('returns null for a plugin job read by owner core', async () => {
    const store = fakeStore({ statuses });
    const { factory } = setup(store);
    expect(await factory('core', initiator).get(ctx, 'J1')).toBeNull();
    expect(store.statusCalls).toEqual(['J1']);
  });
});
