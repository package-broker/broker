import { describe, expect, it, vi } from 'vitest';
import { createKeyring } from '../secrets/keyring.js';
import { hashToken } from '../secrets/token-hash.js';
import { formatToken } from '../secrets/token-format.js';
import { authenticateToken, deferredDispatch, TOUCH_WINDOW_MS } from './token-use.js';
import type { TokenAccessView, TokenUseDeps } from './token-use.js';

const keyring = createKeyring([
  { version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) },
]);
const SELECTOR = 'abcdefghijkl';
const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const OLD = '2026-10-16T11:00:00.000Z';
const RECENT = '2026-10-16T11:58:00.000Z';
const secretBytes = Uint8Array.from({ length: 32 }, (_, i) => i * 3 + 5);
const PRESENTED = formatToken('pat', SELECTOR, secretBytes);

interface Overrides {
  readonly kind?: 'pat' | 'svc';
  readonly expired?: boolean;
  readonly revoked?: boolean;
  readonly lastUsedAt?: string | null;
  readonly principalStatus?: string;
  readonly hashOf?: string;
}

async function access(overrides: Overrides = {}): Promise<TokenAccessView> {
  const secretHash = await hashToken(keyring, 1, overrides.hashOf ?? PRESENTED);
  const envelope = {
    token: {
      id: 'tok1',
      kind: overrides.kind ?? 'pat',
      expired: overrides.expired ?? false,
      revoked: overrides.revoked ?? false,
      lastUsedAt: overrides.lastUsedAt === undefined ? null : overrides.lastUsedAt,
    },
    projectVisible: false,
    principalStatus: overrides.principalStatus ?? 'active',
  };
  return Object.defineProperty(envelope, 'verifier', {
    value: { secretHash, pepperVersion: 1 },
    enumerable: false,
  }) as TokenAccessView;
}

interface Rig {
  readonly deps: TokenUseDeps;
  readonly touches: [string, string][];
  readonly pending: (() => Promise<void>)[];
  readonly logs: string[];
}

function rig(touch?: () => Promise<boolean>): Rig {
  const touches: [string, string][] = [];
  const pending: (() => Promise<void>)[] = [];
  const logs: string[] = [];
  return {
    touches,
    pending,
    logs,
    deps: {
      keyring,
      nowMs: () => NOW,
      touch: (id, kind) => {
        touches.push([id, kind]);
        return touch === undefined ? Promise.resolve(true) : touch();
      },
      dispatch: (run) => {
        pending.push(run);
      },
      log: (event) => {
        logs.push(event);
      },
    },
  };
}

const allow = () => true;
const flush = async (r: Rig): Promise<void> => {
  await Promise.all(r.pending.map((run) => run()));
};
const found = (view: TokenAccessView) => () => Promise.resolve(view);

describe('authenticateToken', () => {
  it('authenticates, passes the envelope to decide and touches a NULL last_used_at once', async () => {
    const r = rig();
    const view = await access();
    const decide = vi.fn(allow);
    const result = await authenticateToken(r.deps, PRESENTED, found(view), decide);
    expect(result).toEqual({ ok: true, access: view });
    expect(decide).toHaveBeenCalledWith(view);
    await flush(r);
    expect(r.touches).toEqual([['tok1', 'pat']]);
  });

  it('touches only when last_used_at is NULL or older than the window', async () => {
    const r = rig();
    await authenticateToken(r.deps, PRESENTED, found(await access({ lastUsedAt: OLD })), allow);
    await authenticateToken(r.deps, PRESENTED, found(await access({ lastUsedAt: RECENT })), allow);
    expect(r.pending).toHaveLength(1);
    expect(TOUCH_WINDOW_MS).toBe(300_000);
  });

  it('touches when the clock cannot be read', async () => {
    const r = rig();
    const deps = { ...r.deps, nowMs: () => Number.NaN };
    await authenticateToken(deps, PRESENTED, found(await access({ lastUsedAt: RECENT })), allow);
    const throwing = {
      ...r.deps,
      nowMs: () => {
        throw new Error('clock');
      },
    };
    await expect(
      authenticateToken(throwing, PRESENTED, found(await access({ lastUsedAt: RECENT })), allow),
    ).resolves.toMatchObject({ ok: true });
    expect(r.pending).toHaveLength(2);
  });

  it('maps every refusal to one public result and keeps the detail in diagnostic', async () => {
    const r = rig();
    const cst = formatToken('cst', SELECTOR, secretBytes);
    const wrongSecret = formatToken(
      'pat',
      SELECTOR,
      Uint8Array.from({ length: 32 }, () => 9),
    );
    const cases: [string, unknown, () => Promise<TokenAccessView | null>, string][] = [
      ['malformed', 'nonsense', found(await access()), 'malformed'],
      ['reserved', cst, found(await access()), 'reserved'],
      ['unknown', PRESENTED, () => Promise.resolve(null), 'invalid'],
      ['wrong secret', wrongSecret, found(await access()), 'invalid'],
      ['kind mismatch', PRESENTED, found(await access({ kind: 'svc' })), 'invalid'],
      ['revoked', PRESENTED, found(await access({ revoked: true })), 'revoked'],
      ['expired', PRESENTED, found(await access({ expired: true })), 'expired'],
      [
        'suspended',
        PRESENTED,
        found(await access({ principalStatus: 'suspended' })),
        'principal_inactive',
      ],
    ];
    const decide = vi.fn(allow);
    for (const [, presented, lookup, diagnostic] of cases) {
      const result = await authenticateToken(r.deps, presented, lookup, decide);
      expect(result).toEqual({ ok: false, reason: 'unauthorized', diagnostic });
    }
    const denied = await authenticateToken(r.deps, PRESENTED, found(await access()), () => false);
    expect(denied).toEqual({ ok: false, reason: 'unauthorized', diagnostic: 'denied' });
    expect(decide).not.toHaveBeenCalled();
    expect(r.touches).toHaveLength(0);
    expect(r.pending).toHaveLength(0);
  });

  it('does not run the lookup for a malformed or reserved token', async () => {
    const r = rig();
    const lookup = vi.fn(() => Promise.resolve(null));
    await authenticateToken(r.deps, 'x', lookup, allow);
    await authenticateToken(r.deps, formatToken('cst', SELECTOR, secretBytes), lookup, allow);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('surfaces an exception from decide as an error and does not touch', async () => {
    const r = rig();
    await expect(
      authenticateToken(r.deps, PRESENTED, found(await access()), () => {
        throw new Error('engine failed');
      }),
    ).rejects.toThrow('engine failed');
    expect(r.pending).toHaveLength(0);
  });

  it('returns without awaiting the touch', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const r = rig(async () => {
      await gate;
      finished = true;
      return true;
    });
    const result = await authenticateToken(r.deps, PRESENTED, found(await access()), allow);
    expect(result.ok).toBe(true);
    expect(finished).toBe(false);
    release();
    await flush(r);
    expect(finished).toBe(true);
  });

  it('logs a fixed event for a failing touch and neither denies nor rejects', async () => {
    const r = rig(() => Promise.reject(new Error(`db said ${PRESENTED}`)));
    const result = await authenticateToken(r.deps, PRESENTED, found(await access()), allow);
    expect(result.ok).toBe(true);
    await expect(flush(r)).resolves.toBeUndefined();
    expect(r.logs).toEqual(['token_touch_failed']);
  });

  it('survives a throwing dispatch and a throwing touch call', async () => {
    const logs: string[] = [];
    const deps: TokenUseDeps = {
      keyring,
      nowMs: () => NOW,
      touch: () => {
        throw new Error('sync');
      },
      dispatch: () => {
        throw new Error('waitUntil');
      },
      log: (event) => {
        logs.push(event);
      },
    };
    const result = await authenticateToken(deps, PRESENTED, found(await access()), allow);
    expect(result.ok).toBe(true);
    expect(logs).toContain('token_touch_failed');
  });

  it('with deferredDispatch the touch starts only after the request resolved', async () => {
    const started: string[] = [];
    const logs: string[] = [];
    const deps: TokenUseDeps = {
      keyring,
      nowMs: () => NOW,
      touch: () => {
        started.push('touch');
        return Promise.reject(new Error('x'));
      },
      dispatch: deferredDispatch,
      log: (event) => {
        logs.push(event);
      },
    };
    const result = await authenticateToken(deps, PRESENTED, found(await access()), allow);
    expect(result.ok).toBe(true);
    expect(started).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(started).toEqual(['touch']);
    expect(logs).toEqual(['token_touch_failed']);
  });

  it('deferredDispatch swallows a run that throws synchronously', async () => {
    deferredDispatch(() => {
      throw new Error('sync');
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
