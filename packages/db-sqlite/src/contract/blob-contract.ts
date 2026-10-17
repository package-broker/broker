import { describe, expect, it } from 'vitest';
import type { OrgContext } from '@package-broker/core/db/port';
import {
  BlobBusyError,
  BlobConflictError,
  BlobDigestMismatchError,
  BlobRangeError,
  BlobSizeMismatchError,
  BlobValidationError,
  parseSha256,
} from '@package-broker/core/platform/blob';
import type {
  BlobInfo,
  BlobLifecycle,
  BlobStore,
  ByteRange,
  PurgeGeneration,
  Sha256,
} from '@package-broker/core/platform/blob';

/**
 * `now` is the database clock as a UTC ISO timestamp with milliseconds; retention and lease
 * dates come from it and from observed `purgeAfter` values, never from fixed calendar dates.
 * `softDelete` schedules removal with the organization's retention policy and returns false for an
 * unknown digest or a removal time after `now`.
 * `expireRetention` moves a scheduled `purgeAfter` into the past.
 * `stagedObjects` counts staging or temporary objects the physical store holds; `stagesUploads`
 * says whether the backend stages uploads at all.
 * `corruptBytes` leaves the metadata row and changes the stored object's size; `removeBytes`
 * deletes only the physical object.
 * `failNextPublish` makes the next metadata publish reject and nothing else: it must fail
 * `publish` only, after the bytes are written. `failNextStorageRead` makes the next physical read
 * reject. `answerNextRangeWithFullBody` makes the next ranged physical read answer with the whole
 * object and no range; every backend can inject it by wrapping its byte store's `get`.
 */
export interface BlobContractFixture {
  readonly store: BlobStore;
  seed(org: string): Promise<OrgContext>;
  readonly now: () => Promise<string>;
  readonly softDelete: (
    ctx: OrgContext,
    key: Sha256,
    input: { removedAt: string },
  ) => Promise<boolean>;
  readonly expireRetention: (ctx: OrgContext, key: Sha256) => Promise<void>;
  readonly refetchableOf: (ctx: OrgContext, key: Sha256) => Promise<boolean | null>;
  readonly failNextPublish: () => void;
  readonly failNextStorageRead: () => void;
  readonly corruptBytes: (ctx: OrgContext, sha256: Sha256) => Promise<void>;
  readonly removeBytes: (ctx: OrgContext, key: Sha256) => Promise<void>;
  readonly stagedObjects: () => Promise<number>;
  readonly stagesUploads: boolean;
  readonly answerNextRangeWithFullBody: () => void;
}

/**
 * `expireLease` moves a live purge lease into the past. `narrowRefetchable` is the metadata port
 * operation of the same name and `generationOf` reads the row's current purge generation.
 */
export interface BlobLifecycleFixture extends BlobContractFixture {
  readonly lifecycle: BlobLifecycle;
  readonly expireLease: (ctx: OrgContext, key: Sha256) => Promise<void>;
  readonly narrowRefetchable: (
    ctx: OrgContext,
    input: { key: Sha256; size: number; mediaType: string },
  ) => Promise<BlobInfo | null>;
  readonly generationOf: (ctx: OrgContext, key: Sha256) => Promise<string | null>;
}

const FUNCTION_HOOKS = [
  'seed',
  'now',
  'softDelete',
  'expireRetention',
  'refetchableOf',
  'failNextPublish',
  'failNextStorageRead',
  'corruptBytes',
  'removeBytes',
  'stagedObjects',
  'answerNextRangeWithFullBody',
] as const;

const LIFECYCLE_METHODS = [
  'softDelete',
  'claimPurge',
  'recheckAndRemove',
  'markDeleted',
  'cancelPurge',
] as const;

export function requireBlobFixtureHooks(fixture: BlobContractFixture): void {
  const record = fixture as unknown as Record<string, unknown>;
  if (typeof record.store !== 'object' || record.store === null) {
    throw new Error('blob contract fixture is missing the store hook');
  }
  for (const hook of FUNCTION_HOOKS) {
    if (typeof record[hook] !== 'function') {
      throw new Error(`blob contract fixture is missing the ${hook} hook`);
    }
  }
  if (typeof record.stagesUploads !== 'boolean') {
    throw new Error('blob contract fixture is missing the stagesUploads hook');
  }
  const store = record.store as Record<string, unknown>;
  for (const method of ['put', 'get', 'head'] as const) {
    if (typeof store[method] !== 'function') {
      throw new Error(`blob contract fixture store is missing ${method}`);
    }
  }
}

export function requireBlobLifecycleFixtureHooks(fixture: BlobLifecycleFixture): void {
  requireBlobFixtureHooks(fixture);
  const record = fixture as unknown as Record<string, unknown>;
  if (typeof record.lifecycle !== 'object' || record.lifecycle === null) {
    throw new Error('blob contract fixture is missing the lifecycle hook');
  }
  for (const hook of ['expireLease', 'narrowRefetchable', 'generationOf'] as const) {
    if (typeof record[hook] !== 'function') {
      throw new Error(`blob contract fixture is missing the ${hook} hook`);
    }
  }
  const lifecycle = record.lifecycle as Record<string, unknown>;
  for (const method of LIFECYCLE_METHODS) {
    if (typeof lifecycle[method] !== 'function') {
      throw new Error(`blob contract fixture lifecycle is missing ${method}`);
    }
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const encoder = new TextEncoder();

const bytes = (text: string): Uint8Array => encoder.encode(text);
const text = (data: Uint8Array): string => new TextDecoder().decode(data);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const shifted = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();

async function digestOf(data: Uint8Array): Promise<Sha256> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return parseSha256(
    [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join(''),
  );
}

function streamOf(data: Uint8Array, chunk = 3): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= data.length) {
        controller.close();
        return;
      }
      controller.enqueue(data.slice(at, at + chunk));
      at += chunk;
    },
  });
}

interface Controlled {
  readonly stream: ReadableStream<Uint8Array>;
  push(chunk: Uint8Array): void;
  close(): void;
  fail(error: Error): void;
}

function controlledStream(): Controlled {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  return {
    stream,
    push: (chunk) => controller.enqueue(chunk),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

interface PutOptions {
  mediaType?: string;
  refetchable?: boolean;
}

const PLAIN = { mediaType: 'application/octet-stream', refetchable: true } as const;

async function put(
  store: BlobStore,
  ctx: OrgContext,
  data: Uint8Array,
  options: PutOptions = {},
): Promise<Sha256> {
  const key = await digestOf(data);
  await store.put(ctx, key, streamOf(data), {
    size: data.length,
    mediaType: options.mediaType ?? PLAIN.mediaType,
    refetchable: options.refetchable ?? PLAIN.refetchable,
  });
  return key;
}

async function readText(store: BlobStore, ctx: OrgContext, key: Sha256): Promise<string> {
  const read = await store.get(ctx, key);
  if (read === null) throw new Error('expected a readable object');
  return text(await drain(read.body));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to reject');
}

type ErrorClass = abstract new (...args: never[]) => Error;

function expectErrorOf(error: unknown, ...classes: ErrorClass[]): void {
  expect(classes.some((type) => error instanceof type)).toBe(true);
}

function expectInfrastructureError(error: unknown): void {
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).name).not.toMatch(/^Blob/);
}

function expectAbort(error: unknown, original: Error): void {
  if (error === original) return;
  expectInfrastructureError(error);
}

const DIGEST_ERRORS = [BlobValidationError, BlobSizeMismatchError] as const;

let orgCounter = 0;
function nextOrg(): string {
  orgCounter += 1;
  let rest = orgCounter;
  let body = '';
  while (rest > 0) {
    body = CROCKFORD.charAt(rest % 32) + body;
    rest = Math.floor(rest / 32);
  }
  return `01J0${body.padStart(22, '0')}`;
}

async function ready(make: () => Promise<BlobContractFixture>): Promise<BlobContractFixture> {
  const fixture = await make();
  requireBlobFixtureHooks(fixture);
  return fixture;
}

async function readyLifecycle(
  make: () => Promise<BlobLifecycleFixture>,
): Promise<BlobLifecycleFixture> {
  const fixture = await make();
  requireBlobLifecycleFixtureHooks(fixture);
  return fixture;
}

async function waitFor(condition: () => Promise<boolean>): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await condition()) return true;
    await sleep(10);
  }
  return false;
}

export function describeBlobContract(name: string, make: () => Promise<BlobContractFixture>): void {
  describe(`blob contract: ${name}`, () => {
    it('a complete fixture is required: a missing hook fails the suite', async () => {
      const fixture = await make();
      expect(() => requireBlobFixtureHooks(fixture)).not.toThrow();
    });

    it('round-trips a full body with its info', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('hello blob contract');
      const key = await put(f.store, org, data, { mediaType: 'text/plain' });
      const read = await f.store.get(org, key);
      expect(read?.info).toEqual({
        sha256: key,
        size: data.length,
        mediaType: 'text/plain',
        purgeAfter: null,
      });
      expect(text(await drain(read!.body))).toBe('hello blob contract');
      expect(await f.store.head(org, key)).toEqual(read?.info);
    });

    it('serves a range and clamps a length past the end', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, bytes('0123456789'));
      const middle = await f.store.get(org, key, { offset: 2, length: 3 });
      expect(text(await drain(middle!.body))).toBe('234');
      expect(middle?.info.size).toBe(10);
      const clamped = await f.store.get(org, key, { offset: 8, length: 100 });
      expect(text(await drain(clamped!.body))).toBe('89');
      const last = await f.store.get(org, key, { offset: 9, length: 1 });
      expect(text(await drain(last!.body))).toBe('9');
    });

    it('stores an empty object, reads it in full and refuses every range', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, new Uint8Array(0));
      const read = await f.store.get(org, key);
      expect(read?.info.size).toBe(0);
      expect((await drain(read!.body)).length).toBe(0);
      expect(await rejection(f.store.get(org, key, { offset: 0, length: 1 }))).toBeInstanceOf(
        BlobRangeError,
      );
    });

    it('refuses an offset at or past the end with a range error', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, bytes('abcd'));
      for (const offset of [4, 5, 1000]) {
        expect(await rejection(f.store.get(org, key, { offset, length: 1 }))).toBeInstanceOf(
          BlobRangeError,
        );
      }
    });

    it('rejects invalid range tuples', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, bytes('abcdef'));
      const tuples: ByteRange[] = [
        { offset: -1, length: 1 },
        { offset: 0, length: 0 },
        { offset: 0, length: -1 },
        { offset: 0.5, length: 1 },
        { offset: 0, length: 1.5 },
        { offset: Number.NaN, length: 1 },
        { offset: 0, length: Number.POSITIVE_INFINITY },
        { offset: Number.MAX_SAFE_INTEGER, length: 1 },
        { offset: 1, length: Number.MAX_SAFE_INTEGER },
      ];
      for (const tuple of tuples) {
        expect(await rejection(f.store.get(org, key, tuple))).toBeInstanceOf(BlobRangeError);
      }
    });

    it('a ranged read answered with the full body errors instead of streaming it', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, bytes('0123456789'));
      f.answerNextRangeWithFullBody();
      const error = await rejection(
        f.store.get(org, key, { offset: 2, length: 3 }).then(async (read) => {
          if (read === null) return null;
          return drain(read.body);
        }),
      );
      expectErrorOf(error, BlobSizeMismatchError);
    });

    it('rejects malformed digests before any storage access', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      for (const bad of ['', 'A'.repeat(64), 'a'.repeat(63), '../'.padEnd(64, 'a')]) {
        expect(await rejection(f.store.head(org, bad as Sha256))).toBeInstanceOf(
          BlobValidationError,
        );
      }
    });

    it('a digest mismatch leaves no publication and no staged object', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const claimed = await digestOf(bytes('the claimed bytes'));
      const wrong = bytes('other bytes here!');
      const error = await rejection(
        f.store.put(org, claimed, streamOf(wrong), { size: wrong.length, ...PLAIN }),
      );
      expect(error).toBeInstanceOf(BlobDigestMismatchError);
      expect(await f.store.head(org, claimed)).toBeNull();
      expect(await f.store.get(org, claimed)).toBeNull();
      expect(await f.stagedObjects()).toBe(0);
    });

    it('a bad upload is not accepted because a good object already exists', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const good = bytes('good bytes');
      const key = await put(f.store, org, good);
      const error = await rejection(
        f.store.put(org, key, streamOf(bytes('evil bytes')), { size: good.length, ...PLAIN }),
      );
      expect(error).toBeInstanceOf(BlobDigestMismatchError);
      expect(await readText(f.store, org, key)).toBe('good bytes');
    });

    it('an oversized body leaves no final publication', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('twelve bytes');
      const key = await digestOf(data);
      const error = await rejection(
        f.store.put(org, key, streamOf(data), { size: data.length - 4, ...PLAIN }),
      );
      expectErrorOf(error, BlobSizeMismatchError);
      expect(await f.store.head(org, key)).toBeNull();
      expect(await f.stagedObjects()).toBe(0);
    });

    it('a short body leaves no final publication', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('twelve bytes');
      const key = await digestOf(data);
      const error = await rejection(
        f.store.put(org, key, streamOf(data), { size: data.length + 4, ...PLAIN }),
      );
      expectErrorOf(error, BlobSizeMismatchError);
      expect(await f.store.head(org, key)).toBeNull();
      expect(await f.stagedObjects()).toBe(0);
    });

    it('a stream that errors mid-upload leaves no staged or temporary object', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('partial upload that breaks');
      const key = await digestOf(data);
      const aborted = new Error('client aborted');
      const body = controlledStream();
      body.push(data.slice(0, 5));
      const pending = rejection(
        f.store.put(org, key, body.stream, { size: data.length, ...PLAIN }),
      );
      await sleep(20);
      body.fail(aborted);
      expectAbort(await pending, aborted);
      expect(await f.store.head(org, key)).toBeNull();
      expect(await f.stagedObjects()).toBe(0);
    });

    it('an in-flight upload is invisible and staged only where the backend stages', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('held open while paused');
      const key = await digestOf(data);
      const body = controlledStream();
      body.push(data.slice(0, 4));
      const pending = rejection(
        f.store.put(org, key, body.stream, { size: data.length, ...PLAIN }),
      );
      if (f.stagesUploads) {
        expect(await waitFor(async () => (await f.stagedObjects()) >= 1)).toBe(true);
      } else {
        await sleep(20);
      }
      expect(await f.store.head(org, key)).toBeNull();
      expect(await f.store.get(org, key)).toBeNull();
      const aborted = new Error('upload abandoned');
      body.fail(aborted);
      expectAbort(await pending, aborted);
      expect(await f.stagedObjects()).toBe(0);
      expect(await f.store.head(org, key)).toBeNull();
    });

    it('a cancelled upload source leaves no staged or temporary object', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('cancelled before the end');
      const key = await digestOf(data);
      const body = streamOf(data, 4);
      await body.cancel();
      const error = await rejection(f.store.put(org, key, body, { size: data.length, ...PLAIN }));
      expectErrorOf(error, BlobSizeMismatchError);
      expect(await f.store.head(org, key)).toBeNull();
      expect(await f.stagedObjects()).toBe(0);
    });

    it('a duplicate put is idempotent and keeps one readable object', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('same bytes twice');
      const first = await put(f.store, org, data);
      const second = await put(f.store, org, data);
      expect(second).toBe(first);
      expect(await readText(f.store, org, first)).toBe('same bytes twice');
      expect(await f.stagedObjects()).toBe(0);
    });

    it('concurrent same-digest puts all succeed with identical info', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('racing writers share one digest');
      const key = await digestOf(data);
      const infos = await Promise.all(
        [1, 2, 3, 4].map(() =>
          f.store.put(org, key, streamOf(data, 5), { size: data.length, ...PLAIN }),
        ),
      );
      for (const info of infos) expect(info).toEqual(infos[0]);
      expect(await readText(f.store, org, key)).toBe('racing writers share one digest');
      expect(await f.stagedObjects()).toBe(0);
    });

    it('never stored is null, corrupt storage is a typed error', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const unknown = await digestOf(bytes('never stored'));
      expect(await f.store.get(org, unknown)).toBeNull();
      expect(await f.store.head(org, unknown)).toBeNull();
      const key = await put(f.store, org, bytes('will be damaged'));
      await f.corruptBytes(org, key);
      expectErrorOf(await rejection(f.store.head(org, key)), BlobSizeMismatchError);
      expectErrorOf(await rejection(f.store.get(org, key)), BlobSizeMismatchError);
    });

    it('missing bytes behind a surviving row read as null and a re-put restores them', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('bytes that vanish');
      const key = await put(f.store, org, data);
      await f.removeBytes(org, key);
      expect(await f.store.get(org, key)).toBeNull();
      expect(await f.store.head(org, key)).toBeNull();
      expect(await f.refetchableOf(org, key)).not.toBeNull();
      await put(f.store, org, data);
      expect(await readText(f.store, org, key)).toBe('bytes that vanish');
    });

    it('a failed storage read is an error, never a miss', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, bytes('storage goes down'));
      f.failNextStorageRead();
      expectInfrastructureError(await rejection(f.store.get(org, key)));
      f.failNextStorageRead();
      expectInfrastructureError(await rejection(f.store.head(org, key)));
      expect(await readText(f.store, org, key)).toBe('storage goes down');
    });

    it('isolates two organizations sharing a digest', async () => {
      const f = await ready(make);
      const a = await f.seed(nextOrg());
      const b = await f.seed(nextOrg());
      const data = bytes('shared digest, separate organizations');
      const key = await put(f.store, a, data);
      expect(await f.store.head(b, key)).toBeNull();
      expect(await f.store.get(b, key)).toBeNull();
      await put(f.store, b, data, { mediaType: 'application/zip' });
      expect((await f.store.head(a, key))?.mediaType).toBe('application/octet-stream');
      expect((await f.store.head(b, key))?.mediaType).toBe('application/zip');
    });

    it('keeps reading a soft-deleted object before and after the retention deadline', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, bytes('retained after upstream removal'));
      const now = await f.now();
      expect(await f.softDelete(org, key, { removedAt: now })).toBe(true);
      const scheduled = (await f.store.head(org, key))?.purgeAfter;
      expect(scheduled).toBeTruthy();
      expect(Date.parse(scheduled!)).toBeGreaterThanOrEqual(Date.parse(now) + 364 * DAY_MS);
      expect(await readText(f.store, org, key)).toBe('retained after upstream removal');
      await f.expireRetention(org, key);
      const expired = (await f.store.head(org, key))?.purgeAfter;
      expect(Date.parse(expired!)).toBeLessThanOrEqual(Date.parse(await f.now()));
      expect(await readText(f.store, org, key)).toBe('retained after upstream removal');
    });

    it('a repeated soft delete keeps the first deadline', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, bytes('removed twice'));
      const now = await f.now();
      expect(await f.softDelete(org, key, { removedAt: now })).toBe(true);
      const first = (await f.store.head(org, key))?.purgeAfter;
      expect(first).toBeTruthy();
      await sleep(15);
      expect(await f.softDelete(org, key, { removedAt: await f.now() })).toBe(true);
      expect((await f.store.head(org, key))?.purgeAfter).toBe(first);
    });

    it('accepts a backdated removal time and refuses a future one', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const backdated = await put(f.store, org, bytes('removed yesterday'));
      const future = await put(f.store, org, bytes('removed tomorrow'));
      const now = await f.now();
      expect(await f.softDelete(org, backdated, { removedAt: shifted(now, -DAY_MS) })).toBe(true);
      expect((await f.store.head(org, backdated))?.purgeAfter).not.toBeNull();
      expect(await f.softDelete(org, future, { removedAt: shifted(now, DAY_MS) })).toBe(false);
      expect((await f.store.head(org, future))?.purgeAfter).toBeNull();
    });

    it('soft deleting an unknown digest reports false', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await digestOf(bytes('unknown'));
      expect(await f.softDelete(org, key, { removedAt: await f.now() })).toBe(false);
    });

    it('a verified re-upload after soft delete clears the scheduled purge', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('uploaded again after removal');
      const key = await put(f.store, org, data);
      await f.softDelete(org, key, { removedAt: await f.now() });
      expect((await f.store.head(org, key))?.purgeAfter).not.toBeNull();
      await put(f.store, org, data);
      expect((await f.store.head(org, key))?.purgeAfter).toBeNull();
      expect(await readText(f.store, org, key)).toBe('uploaded again after removal');
    });

    it('a bare put with unverified bytes does not clear the scheduled purge', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('scheduled for purge');
      const key = await put(f.store, org, data);
      await f.softDelete(org, key, { removedAt: await f.now() });
      const scheduled = (await f.store.head(org, key))?.purgeAfter;
      expect(scheduled).toBeTruthy();
      const error = await rejection(
        f.store.put(org, key, streamOf(bytes('not the same bytes!!!!!!')), {
          size: data.length,
          ...PLAIN,
        }),
      );
      expectErrorOf(error, ...DIGEST_ERRORS);
      expect((await f.store.head(org, key))?.purgeAfter).toBe(scheduled);
    });

    it('a refetchable first writer does not become expirable after a non-refetchable writer', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('sticky refetchable flag');
      const key = await put(f.store, org, data, { refetchable: true });
      expect(await f.refetchableOf(org, key)).toBe(true);
      await put(f.store, org, data, { refetchable: false });
      expect(await f.refetchableOf(org, key)).toBe(false);
      await put(f.store, org, data, { refetchable: true });
      expect(await f.refetchableOf(org, key)).toBe(false);
    });

    it('refuses a conflicting media type instead of overwriting it', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('one object, one media type');
      const key = await put(f.store, org, data, { mediaType: 'application/zip' });
      const error = await rejection(put(f.store, org, data, { mediaType: 'application/gzip' }));
      expectErrorOf(error, BlobConflictError);
      expect((await f.store.head(org, key))?.mediaType).toBe('application/zip');
    });

    it('refuses a media type outside the allowlist', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('<script>alert(1)</script>');
      const key = await digestOf(data);
      const error = await rejection(
        f.store.put(org, key, streamOf(data), {
          size: data.length,
          mediaType: 'text/html',
          refetchable: true,
        }),
      );
      expectErrorOf(error, BlobValidationError);
      expect(await f.store.head(org, key)).toBeNull();
    });

    it('cancelling a read body does not break later reads', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, bytes('a body that is abandoned midway'));
      const read = await f.store.get(org, key);
      await read!.body.cancel();
      expect(await readText(f.store, org, key)).toBe('a body that is abandoned midway');
    });

    it('a publish failure after the physical write leaves a tolerated orphan', async () => {
      const f = await ready(make);
      const org = await f.seed(nextOrg());
      const data = bytes('bytes written before the row');
      const key = await digestOf(data);
      f.failNextPublish();
      const error = await rejection(
        f.store.put(org, key, streamOf(data), { size: data.length, ...PLAIN }),
      );
      expectInfrastructureError(error);
      expect(await f.store.head(org, key)).toBeNull();
      expect(await f.store.get(org, key)).toBeNull();
      expect(await f.stagedObjects()).toBe(0);
      await put(f.store, org, data);
      expect(await readText(f.store, org, key)).toBe('bytes written before the row');
    });
  });
}

export function describeBlobLifecycleContract(
  name: string,
  make: () => Promise<BlobLifecycleFixture>,
): void {
  describe(`blob lifecycle contract: ${name}`, () => {
    it('a complete lifecycle fixture is required: a missing hook fails the suite', async () => {
      const fixture = await make();
      expect(() => requireBlobLifecycleFixtureHooks(fixture)).not.toThrow();
    });

    async function scheduled(f: BlobLifecycleFixture, label: string) {
      const org = await f.seed(nextOrg());
      const data = bytes(label);
      const key = await put(f.store, org, data);
      await f.lifecycle.softDelete(org, key, { removedAt: await f.now() });
      return { org, data, key };
    }

    it('narrowRefetchable clears refetchable and leaves the generation unchanged', async () => {
      const f = await readyLifecycle(make);
      const org = await f.seed(nextOrg());
      const data = bytes('narrowed while live');
      const key = await put(f.store, org, data);
      const before = await f.generationOf(org, key);
      const args = { key, size: data.length, mediaType: PLAIN.mediaType };
      expect(await f.refetchableOf(org, key)).toBe(true);
      const narrowed = await f.narrowRefetchable(org, args);
      expect(narrowed).toEqual({
        sha256: key,
        size: data.length,
        mediaType: PLAIN.mediaType,
        purgeAfter: null,
      });
      expect(await f.refetchableOf(org, key)).toBe(false);
      expect(await f.generationOf(org, key)).toBe(before);
      expect(await readText(f.store, org, key)).toBe('narrowed while live');
    });

    it('narrowRefetchable returns null for an unknown digest and for size or media type mismatches', async () => {
      const f = await readyLifecycle(make);
      const org = await f.seed(nextOrg());
      const data = bytes('narrow mismatch');
      const key = await put(f.store, org, data);
      const args = { key, size: data.length, mediaType: PLAIN.mediaType };
      const unknown = await digestOf(bytes('never stored'));
      expect(await f.narrowRefetchable(org, { ...args, key: unknown })).toBeNull();
      expect(await f.narrowRefetchable(org, { ...args, size: data.length + 1 })).toBeNull();
      expect(await f.narrowRefetchable(org, { ...args, mediaType: 'application/zip' })).toBeNull();
      expect(await f.refetchableOf(org, key)).toBe(true);
    });

    it('narrowRefetchable refuses under a scheduled purge and under a live lease', async () => {
      const f = await readyLifecycle(make);
      const { org, data, key } = await scheduled(f, 'narrow refused');
      const args = { key, size: data.length, mediaType: PLAIN.mediaType };
      expect(await f.narrowRefetchable(org, args)).toBeNull();
      expect(await f.refetchableOf(org, key)).toBe(true);
      await f.expireRetention(org, key);
      const claimed = await f.lifecycle.claimPurge(org, key);
      expect(claimed).not.toBeNull();
      expect(await f.narrowRefetchable(org, args)).toBeNull();
      expect(await f.refetchableOf(org, key)).toBe(true);
      expect(await f.generationOf(org, key)).toBe(claimed);
    });

    it('refuses a claim before the deadline and grants one once it has passed', async () => {
      const f = await readyLifecycle(make);
      const { org, key } = await scheduled(f, 'claimed at the deadline');
      expect(await f.lifecycle.claimPurge(org, key)).toBeNull();
      await f.expireRetention(org, key);
      expect(await f.lifecycle.claimPurge(org, key)).not.toBeNull();
    });

    it('refuses a claim on an object with no scheduled purge', async () => {
      const f = await readyLifecycle(make);
      const org = await f.seed(nextOrg());
      const key = await put(f.store, org, bytes('never removed'));
      expect(await f.lifecycle.claimPurge(org, key)).toBeNull();
    });

    it('a live lease hides the row and refuses a second claim', async () => {
      const f = await readyLifecycle(make);
      const { org, key } = await scheduled(f, 'leased');
      await f.expireRetention(org, key);
      const generation = await f.lifecycle.claimPurge(org, key);
      expect(generation).not.toBeNull();
      expect(await f.store.get(org, key)).toBeNull();
      expect(await f.store.head(org, key)).toBeNull();
      expect(await f.lifecycle.claimPurge(org, key)).toBeNull();
    });

    it('put after purge restores a readable object', async () => {
      const f = await readyLifecycle(make);
      const { org, data, key } = await scheduled(f, 'purged then uploaded again');
      await f.expireRetention(org, key);
      const generation = (await f.lifecycle.claimPurge(org, key))!;
      expect(await f.lifecycle.recheckAndRemove(org, key, generation)).toBe(true);
      expect(await f.lifecycle.markDeleted(org, key, generation)).toBe(true);
      expect(await f.store.get(org, key)).toBeNull();
      await put(f.store, org, data);
      expect(await readText(f.store, org, key)).toBe('purged then uploaded again');
      expect((await f.store.head(org, key))?.purgeAfter).toBeNull();
    });

    it('a put during a live purge lease is refused and the purge still completes', async () => {
      const f = await readyLifecycle(make);
      const { org, data, key } = await scheduled(f, 'put races the purge job');
      await f.expireRetention(org, key);
      const generation = (await f.lifecycle.claimPurge(org, key))!;
      const error = await rejection(put(f.store, org, data));
      expectErrorOf(error, BlobBusyError);
      expect(await f.lifecycle.recheckAndRemove(org, key, generation)).toBe(true);
      expect(await f.lifecycle.markDeleted(org, key, generation)).toBe(true);
      await put(f.store, org, data);
      expect(await readText(f.store, org, key)).toBe('put races the purge job');
    });

    it('a claim made stale by a later put removes and marks nothing', async () => {
      const f = await readyLifecycle(make);
      const { org, data, key } = await scheduled(f, 'claim invalidated by a put');
      await f.expireRetention(org, key);
      const stale = (await f.lifecycle.claimPurge(org, key))!;
      await f.expireLease(org, key);
      await put(f.store, org, data);
      expect(await f.lifecycle.markDeleted(org, key, stale)).toBe(false);
      expect(await readText(f.store, org, key)).toBe('claim invalidated by a put');
    });

    it('an unknown generation removes and marks nothing', async () => {
      const f = await readyLifecycle(make);
      const { org, key } = await scheduled(f, 'wrong generation');
      await f.expireRetention(org, key);
      await f.lifecycle.claimPurge(org, key);
      const wrong = '0'.repeat(32) as PurgeGeneration;
      expect(await f.lifecycle.recheckAndRemove(org, key, wrong)).toBe(false);
      expect(await f.lifecycle.markDeleted(org, key, wrong)).toBe(false);
      expect(await f.lifecycle.cancelPurge(org, key, wrong)).toBe(false);
    });

    it('cancelling a claim makes the object readable again with no scheduled purge', async () => {
      const f = await readyLifecycle(make);
      const { org, key } = await scheduled(f, 'claim cancelled');
      await f.expireRetention(org, key);
      const generation = (await f.lifecycle.claimPurge(org, key))!;
      expect(await f.lifecycle.cancelPurge(org, key, generation)).toBe(true);
      expect(await readText(f.store, org, key)).toBe('claim cancelled');
      expect((await f.store.head(org, key))?.purgeAfter).toBeNull();
    });
  });
}
