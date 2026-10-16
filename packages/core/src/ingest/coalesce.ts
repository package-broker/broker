import type { OrgContext } from '../db/port.js';
import { ulid, type Clock } from '../ids.js';

/** `fence` is the lease generation; T396 must fence renew and release on (key, owner, fence). */
export interface FetchLeaseHandle {
  readonly key: string;
  readonly owner: string;
  readonly fence: number;
}

export interface FetchLeases {
  acquire(
    ctx: OrgContext,
    key: string,
    owner: string,
    leaseSeconds: number,
  ): Promise<FetchLeaseHandle | 'held'>;
  /** Resolves false when the lease is no longer held by this handle's owner and fence. */
  renew(ctx: OrgContext, handle: FetchLeaseHandle, leaseSeconds: number): Promise<boolean>;
  release(ctx: OrgContext, handle: FetchLeaseHandle): Promise<void>;
}

export type DoneState = 'filled' | 'negative' | 'pending';
export type CoalesceOutcome = 'filled' | 'negative' | 'busy';

export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
  constructor(options?: ErrorOptions) {
    super('fetch lease lost while the fill was running', options);
  }
}

export class CoalesceDoneCheckError extends Error {
  override readonly name = 'CoalesceDoneCheckError';
  constructor(options?: ErrorOptions) {
    super('completion check failed while waiting for a fill', options);
  }
}

export interface CoalesceOptions {
  readonly isDone: () => Promise<DoneState>;
  readonly waitBudgetMs?: number;
  readonly pollMs?: number;
  readonly renewEveryMs?: number;
  readonly leaseSeconds?: number;
  readonly signal?: AbortSignal;
}

/**
 * Joiners inherit the first caller's fill and options; only `signal` is per caller. The Composer
 * 25 s hold lives in the caller (T430). A waiter that takes over a lease runs `fill` without the
 * wait budget, so callers enforce the one-chunk limit. After LeaseLostError the lease is released
 * while a non-cooperative fill may still run; its writes are protected by T396's fence.
 */
export type CoalesceFill = (signal: AbortSignal) => Promise<DoneState>;

export interface Coalescer {
  run(
    ctx: OrgContext,
    key: string,
    fill: CoalesceFill,
    options: CoalesceOptions,
  ): Promise<CoalesceOutcome>;
}

export const FETCH_LEASE_SECONDS = 60;
export const FETCH_LEASE_RENEW_MS = 20_000;
export const COALESCE_WAIT_BUDGET_MS = 8000;
export const COALESCE_POLL_MS = 250;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

interface Flight {
  readonly promise: Promise<CoalesceOutcome>;
  readonly controller: AbortController;
  active: number;
}

export function createCoalescer(leases: FetchLeases, clock: Clock): Coalescer {
  const flights = new Map<string, Flight>();
  const newOwner = () => ulid(clock.now().getTime());

  async function hold(
    ctx: OrgContext,
    handle: FetchLeaseHandle,
    fill: CoalesceFill,
    options: CoalesceOptions,
    signal: AbortSignal,
  ): Promise<CoalesceOutcome> {
    const fillController = new AbortController();
    const relay = () => fillController.abort(signal.reason);
    if (signal.aborted) relay();
    else signal.addEventListener('abort', relay, { once: true });

    const leaseSeconds = options.leaseSeconds ?? FETCH_LEASE_SECONDS;
    const renewEveryMs = options.renewEveryMs ?? FETCH_LEASE_RENEW_MS;
    const marginMs = Math.max(0, leaseSeconds * 1000 - renewEveryMs);
    let ended = false;
    let renewing = false;
    let lastRenewedAt = Date.now();
    let rejectLost!: (error: LeaseLostError) => void;
    const lost = new Promise<never>((_resolve, reject) => {
      rejectLost = reject;
    });
    lost.catch(() => undefined);
    const lose = (cause?: unknown) => {
      if (ended || fillController.signal.aborted) return;
      const error = new LeaseLostError(cause === undefined ? undefined : { cause });
      fillController.abort(error);
      rejectLost(error);
    };
    const timer = setInterval(() => {
      if (Date.now() - lastRenewedAt >= marginMs) {
        lose();
        return;
      }
      if (renewing) return;
      renewing = true;
      leases.renew(ctx, handle, leaseSeconds).then(
        (held) => {
          renewing = false;
          if (!held) lose();
          else lastRenewedAt = Date.now();
        },
        () => {
          renewing = false;
        },
      );
    }, renewEveryMs);

    try {
      const work = fill(fillController.signal);
      work.catch(() => undefined);
      const state = await Promise.race([work, lost]);
      return state === 'pending' ? 'busy' : state;
    } finally {
      ended = true;
      clearInterval(timer);
      signal.removeEventListener('abort', relay);
      await leases.release(ctx, handle).catch(() => undefined);
    }
  }

  async function lead(
    ctx: OrgContext,
    key: string,
    fill: CoalesceFill,
    options: CoalesceOptions,
    signal: AbortSignal,
  ): Promise<CoalesceOutcome> {
    const waitBudgetMs = options.waitBudgetMs ?? COALESCE_WAIT_BUDGET_MS;
    const pollMs = options.pollMs ?? COALESCE_POLL_MS;
    const startedAt = clock.now().getTime();
    let slept = 0;

    const check = async (): Promise<DoneState> => {
      try {
        return await options.isDone();
      } catch (cause) {
        throw new CoalesceDoneCheckError({ cause });
      }
    };

    for (let attempt = 0; ; attempt += 1) {
      if (attempt > 0) {
        const polled = await check();
        if (polled !== 'pending') return polled;
      }
      const handle = await leases.acquire(
        ctx,
        key,
        newOwner(),
        options.leaseSeconds ?? FETCH_LEASE_SECONDS,
      );
      if (handle !== 'held') {
        let state: DoneState;
        try {
          state = await check();
        } catch (error) {
          await leases.release(ctx, handle).catch(() => undefined);
          throw error;
        }
        if (state !== 'pending' || signal.aborted) {
          await leases.release(ctx, handle).catch(() => undefined);
          if (state !== 'pending') return state;
          throw signal.reason;
        }
        return hold(ctx, handle, fill, options, signal);
      }

      const elapsed = Math.max(slept, clock.now().getTime() - startedAt);
      const remaining = waitBudgetMs - elapsed;
      if (remaining <= 0) return 'busy';
      const wait = Math.min(pollMs, remaining);
      await sleep(wait, signal);
      slept += wait;
    }
  }

  return {
    run(ctx, key, fill, options) {
      const caller = options.signal;
      if (caller?.aborted) return Promise.reject(caller.reason);

      const mapKey = `${ctx.orgId}\u0000${key}`;
      let flight = flights.get(mapKey);
      if (!flight) {
        const controller = new AbortController();
        const promise = (async () => {
          try {
            return await lead(ctx, key, fill, options, controller.signal);
          } finally {
            flights.delete(mapKey);
          }
        })();
        promise.catch(() => undefined);
        flight = { promise, controller, active: 0 };
        flights.set(mapKey, flight);
      }

      const joined = flight;
      joined.active += 1;
      const leave = () => {
        joined.active -= 1;
        if (joined.active === 0) {
          if (flights.get(mapKey) === joined) flights.delete(mapKey);
          joined.controller.abort(caller?.reason);
        }
      };
      const result = abortable(joined.promise, caller);
      if (caller) {
        caller.addEventListener('abort', leave, { once: true });
        const stop = () => caller.removeEventListener('abort', leave);
        result.then(stop, stop);
      }
      return result;
    },
  };
}
