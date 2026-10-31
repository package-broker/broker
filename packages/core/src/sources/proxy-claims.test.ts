import { expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { checkProxyClaims } from './proxy-claims.js';

it.each(['found', 'unavailable', 'throw', 'not_found'] as const)(
  'probes every exact hosted claim fail-closed: %s',
  async (answer) => {
    const ctx = orgContext('org');
    const probe = vi.fn(async () => {
      if (answer === 'throw') throw new Error('credential-bearing upstream failure');
      return answer;
    });
    const sources = {
      list: vi.fn().mockResolvedValue([
        { id: 'host', type: 'hosted', ecosystem: 'npm' },
        { id: 'registry', type: 'npm_registry', ecosystem: 'npm' },
        { id: 'composer', type: 'hosted', ecosystem: 'composer' },
      ]),
    };
    const registeredNames = {
      list: vi
        .fn()
        .mockResolvedValueOnce({
          items: [{ pattern: 'one' }, { pattern: '@scope/*' }],
          next: 'next',
        })
        .mockResolvedValueOnce({ items: [{ pattern: '@scope/two' }], next: null })
        .mockResolvedValue({ items: [{ pattern: 'other-source' }], next: null }),
    };
    expect(
      await checkProxyClaims({ sources, registeredNames, claimProbe: probe }, ctx, 'proxy'),
    ).toEqual(answer === 'not_found' ? [] : ['one', '@scope/two']);
    expect(probe.mock.calls).toHaveLength(2);
    expect(probe).toHaveBeenCalledWith(ctx, 'proxy', 'one', expect.any(AbortSignal), 'claim');
    expect(registeredNames.list).toHaveBeenLastCalledWith(ctx, {
      sourceId: 'host',
      after: 'next',
      limit: 100,
    });
  },
);

it('scans every source page and refuses exact claims when the probe is absent', async () => {
  const ctx = orgContext('org');
  const rows = Array.from({ length: 101 }, (_, index) => ({
    id: String(index),
    type: 'hosted',
    ecosystem: 'npm',
  }));
  const list = vi.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce(rows.slice(100));
  const names = vi.fn().mockImplementation(async (_ctx, input) => ({
    items: [{ pattern: `claim-${input.sourceId}` }],
    next: null,
  }));
  const result = await checkProxyClaims(
    { sources: { list }, registeredNames: { list: names } },
    ctx,
    'proxy',
  );
  expect(result).toEqual(rows.map(({ id }) => `claim-${id}`));
  expect(list).toHaveBeenLastCalledWith(ctx, { projectId: null, after: '99', limit: 100 });
  expect(names).toHaveBeenCalledTimes(101);
});

function manyClaims(count: number, pattern = (i: number) => `claim-${i}`) {
  return {
    sources: {
      list: vi.fn().mockResolvedValue([{ id: 'host', type: 'hosted', ecosystem: 'npm' }]),
    },
    registeredNames: {
      list: vi.fn().mockResolvedValue({
        items: Array.from({ length: count }, (_, i) => ({ pattern: pattern(i) })),
        next: null,
      }),
    },
  };
}

it('runs four probes at once and closes all remaining claims at the 15 second deadline', async () => {
  vi.useFakeTimers();
  try {
    let active = 0;
    let peak = 0;
    const signals: AbortSignal[] = [];
    const claimProbe = vi.fn(async (_ctx, _target, _key, signal) => {
      signals.push(signal);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 4900));
      active--;
      return 'not_found' as const;
    });
    const verified: string[] = [];
    const pending = checkProxyClaims(
      { ...manyClaims(20), claimProbe },
      orgContext('org'),
      'proxy',
      verified,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(claimProbe).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toEqual([
      'claim-12',
      'claim-13',
      'claim-14',
      'claim-15',
      'claim-16',
      'claim-17',
      'claim-18',
      'claim-19',
    ]);
    expect(peak).toBe(4);
    expect(verified).toHaveLength(12);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(verified).toHaveLength(12);
  } finally {
    vi.useRealTimers();
  }
});

it('bounds the proof JSON by UTF-8 bytes and refuses claims beyond 48 KiB', async () => {
  const pattern = 'a'.repeat(214);
  const verified: string[] = [];
  const conflicts = await checkProxyClaims(
    { ...manyClaims(230, () => pattern), claimProbe: vi.fn().mockResolvedValue('not_found') },
    orgContext('org'),
    'proxy',
    verified,
  );
  expect(new TextEncoder().encode(JSON.stringify(verified)).length).toBeLessThanOrEqual(48 * 1024);
  expect(verified).toHaveLength(226);
  expect(conflicts).toHaveLength(4);
});

it('fails closed by the overall deadline even while enumerating claims', async () => {
  vi.useFakeTimers();
  try {
    const pending = checkProxyClaims(
      {
        sources: { list: vi.fn().mockImplementation(() => new Promise(() => {})) },
        registeredNames: { list: vi.fn() },
      },
      orgContext('org'),
      'proxy',
    );
    let completed = false;
    void pending.then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(completed).toBe(true);
    expect(await pending).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});

it('keeps at most four probes in flight even when a probe ignores cancellation', async () => {
  vi.useFakeTimers();
  try {
    const claimProbe = vi.fn().mockImplementation(() => new Promise(() => {}));
    const pending = checkProxyClaims({ ...manyClaims(20), claimProbe }, orgContext('org'), 'proxy');
    await vi.advanceTimersByTimeAsync(15000);
    expect(claimProbe).toHaveBeenCalledTimes(4);
    expect(await pending).toHaveLength(20);
  } finally {
    vi.useRealTimers();
  }
});
