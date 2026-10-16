import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock, isUlid, systemClock, ulidTime } from '../ids.js';
import {
  CoalesceDoneCheckError,
  createCoalescer,
  LeaseLostError,
  type DoneState,
  type FetchLeaseHandle,
  type FetchLeases,
} from './coalesce.js';

const ctx = orgContext('org_1');

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function fakeLeases(options: { renew?: () => Promise<boolean> } = {}) {
  const held = new Map<string, string>();
  const owners: string[] = [];
  const renewals: string[] = [];
  const releases: string[] = [];
  let fence = 0;
  const leases: FetchLeases = {
    async acquire(c, key, owner) {
      const scoped = `${c.orgId}:${key}`;
      if (held.has(scoped)) return 'held';
      held.set(scoped, owner);
      owners.push(owner);
      fence += 1;
      const handle: FetchLeaseHandle = { key, owner, fence };
      return handle;
    },
    async renew(_c, handle) {
      renewals.push(handle.owner);
      return options.renew ? options.renew() : true;
    },
    async release(c, handle) {
      releases.push(handle.owner);
      const scoped = `${c.orgId}:${handle.key}`;
      if (held.get(scoped) === handle.owner) held.delete(scoped);
    },
  };
  return { leases, held, owners, renewals, releases };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const fast = { waitBudgetMs: 200, pollMs: 5 };
const pending = async (): Promise<DoneState> => 'pending';

describe('createCoalescer', () => {
  it('runs one fill for 20 concurrent callers in one process', async () => {
    const { leases } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const g = gate();
    let fills = 0;
    const fill = async (): Promise<DoneState> => {
      fills += 1;
      await g.promise;
      return 'filled';
    };
    const calls = Array.from({ length: 20 }, () =>
      coalescer.run(ctx, 'k', fill, { ...fast, isDone: pending }),
    );
    g.open();
    const results = await Promise.all(calls);
    expect(fills).toBe(1);
    expect(new Set(results)).toEqual(new Set(['filled']));
  });

  it('does not coalesce different keys or different orgs', async () => {
    const { leases } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const g = gate();
    let fills = 0;
    const fill = async (): Promise<DoneState> => {
      fills += 1;
      await g.promise;
      return 'filled';
    };
    const opts = { ...fast, isDone: pending };
    const calls = [
      coalescer.run(ctx, 'a', fill, opts),
      coalescer.run(ctx, 'b', fill, opts),
      coalescer.run(orgContext('org_2'), 'a', fill, opts),
    ];
    await vi.advanceTimersByTimeAsync(0);
    g.open();
    await Promise.all(calls);
    expect(fills).toBe(3);
  });

  it('lets a second coalescer wait for the holder and return filled only after completion', async () => {
    const { leases } = fakeLeases();
    const a = createCoalescer(leases, systemClock);
    const b = createCoalescer(leases, systemClock);
    const g = gate();
    let fills = 0;
    let done = false;
    const isDone = async (): Promise<DoneState> => (done ? 'filled' : 'pending');
    const first = a.run(
      ctx,
      'k',
      async () => {
        fills += 1;
        await g.promise;
        done = true;
        return 'filled';
      },
      { ...fast, isDone },
    );
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    const secondFill = vi.fn(async (): Promise<DoneState> => 'filled');
    const second = b.run(ctx, 'k', secondFill, { ...fast, isDone }).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.advanceTimersByTimeAsync(30);
    expect(settled).toBe(false);
    g.open();
    await vi.advanceTimersByTimeAsync(10);
    expect(await second).toBe('filled');
    await first;
    expect(fills).toBe(1);
    expect(secondFill).not.toHaveBeenCalled();
  });

  it('returns negative to a cross-isolate waiter once a 404 is recorded, without filling', async () => {
    const { leases } = fakeLeases();
    const a = createCoalescer(leases, systemClock);
    const b = createCoalescer(leases, systemClock);
    const g = gate();
    let state: DoneState = 'pending';
    const isDone = async () => state;
    const first = a.run(ctx, 'k', async () => (await g.promise, 'negative' as const), {
      ...fast,
      isDone,
    });
    await vi.advanceTimersByTimeAsync(0);
    const secondFill = vi.fn(async (): Promise<DoneState> => 'filled');
    const second = b.run(ctx, 'k', secondFill, { ...fast, isDone });
    state = 'negative';
    await vi.advanceTimersByTimeAsync(10);
    expect(await second).toBe('negative');
    expect(secondFill).not.toHaveBeenCalled();
    g.open();
    expect(await first).toBe('negative');
  });

  it('returns busy when the wait budget ends and never calls fill', async () => {
    const { leases } = fakeLeases();
    const a = createCoalescer(leases, systemClock);
    const b = createCoalescer(leases, systemClock);
    const g = gate();
    const first = a.run(ctx, 'k', async () => (await g.promise, 'filled' as const), {
      ...fast,
      isDone: pending,
    });
    await vi.advanceTimersByTimeAsync(0);
    const secondFill = vi.fn(async (): Promise<DoneState> => 'filled');
    const second = b.run(ctx, 'k', secondFill, { waitBudgetMs: 40, pollMs: 15, isDone: pending });
    await vi.advanceTimersByTimeAsync(40);
    expect(await second).toBe('busy');
    expect(secondFill).not.toHaveBeenCalled();
    g.open();
    await first;
  });

  it('measures the budget from a fixed clock by the sleeps alone', async () => {
    const { leases } = fakeLeases();
    const a = createCoalescer(leases, fixedClock('2026-01-01T00:00:00Z'));
    const b = createCoalescer(leases, fixedClock('2026-01-01T00:00:00Z'));
    const g = gate();
    const first = a.run(ctx, 'k', async () => (await g.promise, 'filled' as const), {
      ...fast,
      isDone: pending,
    });
    await vi.advanceTimersByTimeAsync(0);
    const second = b.run(ctx, 'k', async () => 'filled', {
      waitBudgetMs: 40,
      pollMs: 15,
      isDone: pending,
    });
    await vi.advanceTimersByTimeAsync(40);
    expect(await second).toBe('busy');
    g.open();
    await first;
  });

  it('maps an incomplete first ingest to busy for the holder and its joiners', async () => {
    const { leases, held } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const opts = { ...fast, isDone: pending };
    const fill = async (): Promise<DoneState> => 'pending';
    const results = await Promise.all([
      coalescer.run(ctx, 'k', fill, opts),
      coalescer.run(ctx, 'k', fill, opts),
    ]);
    expect(results).toEqual(['busy', 'busy']);
    expect(held.size).toBe(0);
  });

  it('maps a holder fill that recorded a 404 to negative for the holder and its joiners', async () => {
    const { leases } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const opts = { ...fast, isDone: pending };
    const fill = async (): Promise<DoneState> => 'negative';
    const results = await Promise.all([
      coalescer.run(ctx, 'k', fill, opts),
      coalescer.run(ctx, 'k', fill, opts),
    ]);
    expect(results).toEqual(['negative', 'negative']);
  });

  it('releases the lease when the fill throws and a later caller starts a new flight', async () => {
    const { leases, held, releases } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const run = () =>
      coalescer.run(
        ctx,
        'k',
        async () => {
          throw new Error('boom');
        },
        { ...fast, isDone: pending },
      );
    await expect(run()).rejects.toThrow('boom');
    expect(releases).toHaveLength(1);
    expect(held.size).toBe(0);
    await expect(run()).rejects.toThrow('boom');
    expect(releases).toHaveLength(2);
  });

  it('drops the flight from the map when the last caller aborts, so a third caller gets a fresh flight', async () => {
    const base = fakeLeases();
    const releaseGate = gate();
    const acquire = vi.spyOn(base.leases, 'acquire');
    const leases: FetchLeases = {
      ...base.leases,
      async release(c, handle) {
        await releaseGate.promise;
        return base.leases.release(c, handle);
      },
    };
    const coalescer = createCoalescer(leases, systemClock);
    const fill = (signal: AbortSignal) =>
      new Promise<DoneState>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const first = coalescer.run(ctx, 'k', fill, { ...fast, isDone: pending, signal: c1.signal });
    const second = coalescer.run(ctx, 'k', fill, { ...fast, isDone: pending, signal: c2.signal });
    await vi.advanceTimersByTimeAsync(0);
    const rejected = Promise.all([
      expect(first).rejects.toThrow('one'),
      expect(second).rejects.toThrow('two'),
    ]);
    c1.abort(new Error('one'));
    c2.abort(new Error('two'));
    await rejected;
    const thirdFill = vi.fn(async (): Promise<DoneState> => 'filled');
    const third = coalescer.run(ctx, 'k', thirdFill, { ...fast, isDone: async () => 'filled' });
    await vi.advanceTimersByTimeAsync(0);
    releaseGate.open();
    await vi.advanceTimersByTimeAsync(20);
    expect(await third).toBe('filled');
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(thirdFill).not.toHaveBeenCalled();
  });

  it('keeps the flight alive when the leader aborts and a joiner has no signal', async () => {
    const { leases } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const g = gate();
    let flightSignal: AbortSignal | undefined;
    const fill = async (signal: AbortSignal): Promise<DoneState> => {
      flightSignal = signal;
      await g.promise;
      return 'filled';
    };
    const leader = new AbortController();
    const first = coalescer.run(ctx, 'k', fill, {
      ...fast,
      isDone: pending,
      signal: leader.signal,
    });
    const second = coalescer.run(ctx, 'k', fill, { ...fast, isDone: pending });
    await vi.advanceTimersByTimeAsync(0);
    const firstRejected = expect(first).rejects.toThrow('leader gone');
    leader.abort(new Error('leader gone'));
    await firstRejected;
    expect(flightSignal?.aborted).toBe(false);
    g.open();
    expect(await second).toBe('filled');
  });

  it('releases without filling when the shared signal aborted during acquire', async () => {
    const base = fakeLeases();
    const acquireGate = gate();
    const leases: FetchLeases = {
      ...base.leases,
      async acquire(c, key, owner, seconds) {
        await acquireGate.promise;
        return base.leases.acquire(c, key, owner, seconds);
      },
    };
    const coalescer = createCoalescer(leases, systemClock);
    const fill = vi.fn(async (): Promise<DoneState> => 'filled');
    const controller = new AbortController();
    const run = coalescer.run(ctx, 'k', fill, {
      ...fast,
      isDone: pending,
      signal: controller.signal,
    });
    const rejected = expect(run).rejects.toThrow('gone');
    controller.abort(new Error('gone'));
    await rejected;
    acquireGate.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(fill).not.toHaveBeenCalled();
    expect(base.releases).toHaveLength(1);
    expect(base.held.size).toBe(0);
  });

  it('polls isDone each interval and retries acquire only while it reports pending', async () => {
    const base = fakeLeases();
    const acquire = vi.spyOn(base.leases, 'acquire');
    const a = createCoalescer(base.leases, systemClock);
    const b = createCoalescer(base.leases, systemClock);
    const g = gate();
    const first = a.run(ctx, 'k', async () => (await g.promise, 'filled' as const), {
      ...fast,
      isDone: pending,
    });
    await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    const second = b
      .run(ctx, 'k', async () => 'filled', { ...fast, isDone: async () => 'filled' })
      .then((outcome) => {
        settled = true;
        return outcome;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5);
    expect(await second).toBe('filled');
    expect(acquire).toHaveBeenCalledTimes(2);
    g.open();
    await first;
  });

  it('uses a fresh ulid owner per acquisition stamped by the injected clock', async () => {
    const { leases, owners } = fakeLeases();
    const coalescer = createCoalescer(leases, fixedClock('2100-01-01T00:00:00.000Z'));
    const opts = { ...fast, isDone: pending };
    const fill = async (): Promise<DoneState> => 'filled';
    await coalescer.run(ctx, 'k', fill, opts);
    await coalescer.run(ctx, 'k', fill, opts);
    expect(owners).toHaveLength(2);
    expect(owners[0]).not.toBe(owners[1]);
    expect(owners.every(isUlid)).toBe(true);
    expect(ulidTime(owners[0] as string)).toBe(Date.parse('2100-01-01T00:00:00.000Z'));
  });

  it('rechecks isDone after acquiring and releases without filling when already done', async () => {
    const real = fakeLeases();
    const a = createCoalescer(real.leases, systemClock);
    const delayedGate = gate();
    const delayed: FetchLeases = {
      ...real.leases,
      async acquire(c, key, owner, seconds) {
        await delayedGate.promise;
        return real.leases.acquire(c, key, owner, seconds);
      },
    };
    const b = createCoalescer(delayed, systemClock);
    let done = false;
    const isDone = async (): Promise<DoneState> => (done ? 'filled' : 'pending');
    const secondFill = vi.fn(async (): Promise<DoneState> => 'filled');
    const second = b.run(ctx, 'k', secondFill, { ...fast, isDone });
    await a.run(
      ctx,
      'k',
      async () => {
        done = true;
        return 'filled';
      },
      { ...fast, isDone },
    );
    delayedGate.open();
    expect(await second).toBe('filled');
    expect(secondFill).not.toHaveBeenCalled();
    expect(real.releases).toHaveLength(2);
    expect(real.held.size).toBe(0);
  });

  it('lets a waiter take over a lease the holder released without finishing', async () => {
    const { leases } = fakeLeases();
    const a = createCoalescer(leases, systemClock);
    const b = createCoalescer(leases, systemClock);
    const g = gate();
    let done = false;
    const isDone = async (): Promise<DoneState> => (done ? 'filled' : 'pending');
    const first = a.run(ctx, 'k', async () => (await g.promise, 'pending' as const), {
      ...fast,
      isDone,
    });
    await vi.advanceTimersByTimeAsync(0);
    const secondFill = vi.fn(async (): Promise<DoneState> => {
      done = true;
      return 'filled';
    });
    const second = b.run(ctx, 'k', secondFill, { ...fast, isDone });
    await vi.advanceTimersByTimeAsync(10);
    g.open();
    expect(await first).toBe('busy');
    await vi.advanceTimersByTimeAsync(10);
    expect(await second).toBe('filled');
    expect(secondFill).toHaveBeenCalledTimes(1);
  });

  it('wraps an isDone failure in a typed error', async () => {
    const { leases } = fakeLeases();
    const a = createCoalescer(leases, systemClock);
    const b = createCoalescer(leases, systemClock);
    const g = gate();
    const first = a.run(ctx, 'k', async () => (await g.promise, 'filled' as const), {
      ...fast,
      isDone: pending,
    });
    await vi.advanceTimersByTimeAsync(0);
    const second = b.run(ctx, 'k', async () => 'filled', {
      ...fast,
      isDone: async () => {
        throw new Error('db down');
      },
    });
    const rejected = expect(second).rejects.toBeInstanceOf(CoalesceDoneCheckError);
    await vi.advanceTimersByTimeAsync(10);
    await rejected;
    g.open();
    await first;
  });

  it('renews while the fill runs and stops when it ends', async () => {
    const { leases, renewals } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const g = gate();
    const run = coalescer.run(ctx, 'k', async () => (await g.promise, 'filled' as const), {
      ...fast,
      renewEveryMs: 10,
      isDone: pending,
    });
    await vi.advanceTimersByTimeAsync(35);
    expect(renewals).toHaveLength(3);
    g.open();
    await run;
    await vi.advanceTimersByTimeAsync(100);
    expect(renewals).toHaveLength(3);
  });

  const lostOptions = { ...fast, leaseSeconds: 1, renewEveryMs: 100, isDone: pending };
  const abortableFill = (onSignal: (signal: AbortSignal) => void) => (signal: AbortSignal) =>
    new Promise<DoneState>((_resolve, reject) => {
      onSignal(signal);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });

  it('treats a false renew as lost immediately', async () => {
    const { leases, held, releases } = fakeLeases({ renew: async () => false });
    const coalescer = createCoalescer(leases, systemClock);
    let seen: AbortSignal | undefined;
    const run = coalescer.run(
      ctx,
      'k',
      abortableFill((s) => (seen = s)),
      lostOptions,
    );
    const settled = expect(run).rejects.toBeInstanceOf(LeaseLostError);
    await vi.advanceTimersByTimeAsync(100);
    await settled;
    expect(seen?.aborted).toBe(true);
    expect(releases).toHaveLength(1);
    expect(held.size).toBe(0);
  });

  it('tolerates renew errors until the lease margin is spent, then loses the lease', async () => {
    const { leases } = fakeLeases({
      renew: async () => {
        throw new Error('db down');
      },
    });
    const coalescer = createCoalescer(leases, systemClock);
    let seen: AbortSignal | undefined;
    const run = coalescer.run(
      ctx,
      'k',
      abortableFill((s) => (seen = s)),
      lostOptions,
    );
    const settled = expect(run).rejects.toBeInstanceOf(LeaseLostError);
    await vi.advanceTimersByTimeAsync(500);
    expect(seen?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await settled;
    expect(seen?.aborted).toBe(true);
  });

  it('detects a renew that never resolves by the last-success clock', async () => {
    const { leases } = fakeLeases({ renew: () => new Promise<boolean>(() => undefined) });
    const coalescer = createCoalescer(leases, systemClock);
    const run = coalescer.run(
      ctx,
      'k',
      abortableFill(() => undefined),
      lostOptions,
    );
    const settled = expect(run).rejects.toBeInstanceOf(LeaseLostError);
    await vi.advanceTimersByTimeAsync(1000);
    await settled;
  });

  it('resets the margin after a successful renew', async () => {
    let calls = 0;
    const { leases } = fakeLeases({
      renew: async () => {
        calls += 1;
        if (calls % 5 === 0) throw new Error('blip');
        return true;
      },
    });
    const coalescer = createCoalescer(leases, systemClock);
    const g = gate();
    const run = coalescer.run(
      ctx,
      'k',
      async () => (await g.promise, 'filled' as const),
      lostOptions,
    );
    await vi.advanceTimersByTimeAsync(3000);
    g.open();
    expect(await run).toBe('filled');
  });

  it('keeps the flight alive when the leader aborts but a joiner has not', async () => {
    const { leases } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const g = gate();
    let flightSignal: AbortSignal | undefined;
    const fill = async (signal: AbortSignal): Promise<DoneState> => {
      flightSignal = signal;
      await g.promise;
      return 'filled';
    };
    const leader = new AbortController();
    const joiner = new AbortController();
    const first = coalescer.run(ctx, 'k', fill, {
      ...fast,
      isDone: pending,
      signal: leader.signal,
    });
    const second = coalescer.run(ctx, 'k', fill, {
      ...fast,
      isDone: pending,
      signal: joiner.signal,
    });
    await vi.advanceTimersByTimeAsync(0);
    const firstRejected = expect(first).rejects.toThrow('leader gone');
    leader.abort(new Error('leader gone'));
    await firstRejected;
    expect(flightSignal?.aborted).toBe(false);
    g.open();
    expect(await second).toBe('filled');
  });

  it('aborts the fill and releases the lease once every caller has aborted', async () => {
    const { leases, held, releases } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const fill = (signal: AbortSignal) =>
      new Promise<DoneState>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    const c1 = new AbortController();
    const c2 = new AbortController();
    const first = coalescer.run(ctx, 'k', fill, { ...fast, isDone: pending, signal: c1.signal });
    const second = coalescer.run(ctx, 'k', fill, { ...fast, isDone: pending, signal: c2.signal });
    await vi.advanceTimersByTimeAsync(0);
    const rejected = Promise.all([
      expect(first).rejects.toThrow('one'),
      expect(second).rejects.toThrow('two'),
    ]);
    c1.abort(new Error('one'));
    c2.abort(new Error('two'));
    await rejected;
    await vi.advanceTimersByTimeAsync(0);
    expect(releases).toHaveLength(1);
    expect(held.size).toBe(0);
  });

  it('rejects a pre-aborted caller before starting any work', async () => {
    const { leases, owners } = fakeLeases();
    const coalescer = createCoalescer(leases, systemClock);
    const fill = vi.fn(async (): Promise<DoneState> => {
      throw new Error('boom');
    });
    const signal = AbortSignal.abort(new Error('already'));
    await expect(
      coalescer.run(ctx, 'k', fill, { ...fast, isDone: pending, signal }),
    ).rejects.toThrow('already');
    expect(fill).not.toHaveBeenCalled();
    expect(owners).toHaveLength(0);
  });

  it('does not let a failing release mask the fill outcome', async () => {
    const base = fakeLeases();
    const leases: FetchLeases = {
      ...base.leases,
      async release() {
        throw new Error('release failed');
      },
    };
    const coalescer = createCoalescer(leases, systemClock);
    const opts = { ...fast, isDone: pending };
    expect(await coalescer.run(ctx, 'k', async () => 'filled', opts)).toBe('filled');
    base.held.clear();
    await expect(
      coalescer.run(
        ctx,
        'k',
        async () => {
          throw new Error('fill failed');
        },
        opts,
      ),
    ).rejects.toThrow('fill failed');
  });
});
