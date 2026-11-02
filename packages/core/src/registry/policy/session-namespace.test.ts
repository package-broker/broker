import { describe, expect, it, vi } from 'vitest';
import { policyRule, sessionSetup, versionOf } from '../../test-support/registry-policy-session.js';
import { RegistryPolicyChangedError, RegistryPolicyUnavailableError } from './errors.js';
import { MAX_VERSION_DECISIONS } from './session.js';

const BLOCK = '01J0P0000000000000000000B1';
const keys = Array.from({ length: 50 }, (_, n) => `pkg-${String(n)}`);

describe('registry read session rule reads', () => {
  it('a listing reads every rule once and its seal rechecks one epoch', async () => {
    const setup = sessionSetup({
      namespace: true,
      rules: [policyRule(BLOCK, { packageKey: 'pkg-7', members: [] })],
    });
    const session = setup.open({ kind: 'listing' });
    await session.request(null);
    const verdicts = [];
    for (const packageKey of keys) {
      await session.request(packageKey);
      verdicts.push(...(await session.evaluate([versionOf(1, { packageKey })])));
    }
    await session.seal();
    expect(verdicts.map((verdict) => verdict.allowed)).toEqual(
      keys.map((packageKey) => packageKey !== 'pkg-7'),
    );
    expect(setup.policy.namespaces).toEqual([
      { orgId: 'org-a', query: { ecosystem: 'npm', projectId: 'P' } },
    ]);
    expect(setup.policy.queries).toHaveLength(1);
  });

  it('falls back to per-package reads when the namespace is too large to load at once', async () => {
    const setup = sessionSetup({
      namespace: true,
      rules: [policyRule(BLOCK, { packageKey: 'pkg-1', members: [] })],
    });
    setup.policy.state.namespaceFull = true;
    const session = setup.open({ kind: 'search' });
    const [first] = await session.evaluate([versionOf(1, { packageKey: 'pkg-1' })]);
    const [second] = await session.evaluate([versionOf(1, { packageKey: 'pkg-2' })]);
    expect([first?.allowed, second?.allowed]).toEqual([false, true]);
    expect(setup.policy.queries.map(({ query }) => query.packageKey)).toEqual(['pkg-1', 'pkg-2']);
  });

  it('a single-package read keeps the per-package snapshot and an unreadable namespace is 503', async () => {
    const setup = sessionSetup({ namespace: true });
    await setup.open({ kind: 'metadata' }).evaluate([versionOf(1)]);
    expect(setup.policy.namespaces).toEqual([]);
    setup.policy.state.fail = true;
    await expect(setup.open({ kind: 'listing' }).request(null)).rejects.toBeInstanceOf(
      RegistryPolicyUnavailableError,
    );
  });

  it('a seal after many per-package reads rechecks the epoch once and still sees a change', async () => {
    const setup = sessionSetup();
    const session = setup.open({ kind: 'listing' });
    for (const packageKey of keys) await session.evaluate([versionOf(1, { packageKey })]);
    const before = setup.policy.queries.length;
    await session.seal();
    expect(setup.policy.queries.length - before).toBe(1);
    setup.policy.commit([]);
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);
  });

  it('a namespace committed between evaluation and seal is a change; the retry sees the rule', async () => {
    const setup = sessionSetup({ namespace: true });
    const session = setup.open({ kind: 'listing' });
    expect((await session.evaluate([versionOf(1)]))[0]?.allowed).toBe(true);
    setup.policy.commit([policyRule(BLOCK, { members: [] })]);
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    expect((await session.evaluate([versionOf(1)]))[0]?.allowed).toBe(false);
    await expect(session.seal()).resolves.toBeUndefined();
  });
});

describe('registry read session attempts', () => {
  it('the decision cap restarts with each attempt', async () => {
    const setup = sessionSetup();
    const session = setup.open();
    const half = MAX_VERSION_DECISIONS / 2 + 1;
    const first = Array.from({ length: half }, (_, n) => versionOf(n));
    await session.evaluate(first);
    expect(session.remaining()).toBe(MAX_VERSION_DECISIONS - half);
    setup.policy.commit([]);
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    expect(session.remaining()).toBe(MAX_VERSION_DECISIONS);
    const retry = Array.from({ length: half }, (_, n) => versionOf(n, { revision: 2 }));
    await expect(session.evaluate(retry)).resolves.toHaveLength(half);
  });

  it('a change reported while the bindings are rechecked is the one allowed retry', async () => {
    const session = sessionSetup().open();
    await session.evaluate([versionOf(1)]);
    const bindings = vi.fn(async () => {
      throw new RegistryPolicyChangedError();
    });
    await expect(session.seal({ bindings })).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    await expect(
      session.seal({
        bindings: async () => {
          throw new Error('sql: secret');
        },
      }),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });
});
