import { describe, expect, it, vi } from 'vitest';
import type { OrgContext, OrgId } from '../db/port.js';
import { createAccessRecorder, type AccessRecorderOptions } from './access-recorder.js';

const a = { orgId: 'org-a' as OrgId } as OrgContext;
const b = { orgId: 'org-b' as OrgId } as OrgContext;

function setup(over: Partial<AccessRecorderOptions> = {}) {
  let clock = 0;
  const touch = vi.fn<AccessRecorderOptions['touch']>(async () => 0);
  const deferred: (() => Promise<void>)[] = [];
  const onError = vi.fn();
  const recorder = createAccessRecorder({
    touch,
    defer: (thunk) => deferred.push(thunk),
    now: () => clock,
    onError,
    ...over,
  });
  return {
    recorder,
    touch,
    onError,
    deferred,
    advance: (ms: number) => {
      clock += ms;
    },
    drain: async () => {
      while (deferred.length > 0) await deferred.shift()?.();
    },
  };
}

describe('access recorder', () => {
  it('collapses repeated hits on one blob and defers nothing before the interval', async () => {
    const s = setup();
    s.recorder.record(a, 'b1');
    s.recorder.record(a, 'b1');
    expect(s.deferred).toHaveLength(0);
    await s.recorder.flush();
    expect(s.touch).toHaveBeenCalledTimes(1);
    expect(s.touch).toHaveBeenCalledWith(a, ['b1']);
  });

  it('defers a flush once 200 distinct ids are pending, and only one', async () => {
    const s = setup();
    for (let i = 0; i < 199; i += 1) s.recorder.record(a, `b${i}`);
    expect(s.deferred).toHaveLength(0);
    for (let i = 199; i < 260; i += 1) s.recorder.record(a, `b${i}`);
    expect(s.deferred).toHaveLength(1);
    await s.drain();
    expect(s.touch).toHaveBeenCalledTimes(2);
  });

  it('defers a flush when 60 seconds passed since the last one', async () => {
    const s = setup();
    s.recorder.record(a, 'b1');
    s.advance(60_000);
    s.recorder.record(a, 'b2');
    expect(s.deferred).toHaveLength(1);
    await s.drain();
    expect(s.touch).toHaveBeenCalledWith(a, ['b1', 'b2']);
  });

  it('flushes per organization', async () => {
    const s = setup();
    s.recorder.record(a, 'b1');
    s.recorder.record(b, 'b1');
    await s.recorder.flush();
    expect(s.touch).toHaveBeenCalledTimes(2);
  });

  it('splits 450 ids of one organization into 200, 200 and 50', async () => {
    const s = setup({ maxPending: 1000 });
    for (let i = 0; i < 450; i += 1) s.recorder.record(a, `b${i}`);
    await s.drain();
    await s.recorder.flush();
    expect(s.touch.mock.calls.map(([, ids]) => ids.length)).toEqual([200, 200, 50]);
  });

  it('drops ids past twice the flush size and counts one error per window', async () => {
    const s = setup();
    for (let i = 0; i < 500; i += 1) s.recorder.record(a, `b${i}`);
    expect(s.onError).toHaveBeenCalledTimes(1);
    await s.drain();
    expect(s.touch.mock.calls.map(([, ids]) => ids.length)).toEqual([200, 200]);
    for (let i = 0; i < 500; i += 1) s.recorder.record(a, `c${i}`);
    expect(s.onError).toHaveBeenCalledTimes(2);
  });

  it('ignores empty and non-string ids', async () => {
    const s = setup();
    s.recorder.record(a, '');
    s.recorder.record(a, 7 as unknown as string);
    await s.recorder.flush();
    expect(s.touch).not.toHaveBeenCalled();
  });

  it('turns a flush failure into a counted error and never rejects', async () => {
    const s = setup({
      touch: async () => {
        throw new Error('d1 down');
      },
    });
    s.recorder.record(a, 'b1');
    await expect(s.recorder.flush()).resolves.toBeUndefined();
    expect(s.onError).toHaveBeenCalledTimes(1);
  });

  it('survives throwing handlers, clock and defer', async () => {
    const s = setup({
      touch: async () => {
        throw new Error('x');
      },
      onError: () => {
        throw new Error('metric down');
      },
      defer: () => {
        throw new Error('no waitUntil');
      },
      now: () => {
        throw new Error('clock');
      },
    });
    for (let i = 0; i < 200; i += 1) expect(() => s.recorder.record(a, `b${i}`)).not.toThrow();
    await expect(s.recorder.flush()).resolves.toBeUndefined();
  });
});
