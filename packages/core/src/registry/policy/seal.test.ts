import { describe, expect, it, vi } from 'vitest';
import { policyRule, sessionSetup, versionOf } from '../../test-support/registry-policy-session.js';
import { RegistryPolicyChangedError, RegistryPolicyUnavailableError } from './errors.js';
import { withPolicyRetry } from './session.js';

const BLOCK = '01J0P0000000000000000000B1';

function body() {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
    cancel,
  });
  return { stream, cancel };
}

describe('seal and retry', () => {
  it('seals an unchanged decision against a fresh authoritative read', async () => {
    const setup = sessionSetup();
    const reads = vi.spyOn(setup.policy.reader, 'snapshot');
    const session = setup.open();
    await session.evaluate([versionOf(1)]);
    await expect(session.seal()).resolves.toBeUndefined();
    expect(reads).toHaveBeenCalledTimes(2);
  });

  it('a block committed between evaluation and seal discards the result; the retry sees it', async () => {
    const setup = sessionSetup();
    const session = setup.open();
    expect((await session.evaluate([versionOf(1)]))[0]?.allowed).toBe(true);
    setup.policy.commit([policyRule(BLOCK, { members: ['1.0.1'] })]);
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    expect((await session.evaluate([versionOf(1)]))[0]?.allowed).toBe(false);
    await expect(session.seal()).resolves.toBeUndefined();
  });

  it('a second change in the same request is the fixed 503', async () => {
    const setup = sessionSetup();
    const session = setup.open();
    await session.evaluate([versionOf(1)]);
    setup.policy.commit([]);
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    await session.evaluate([versionOf(1)]);
    setup.policy.commit([]);
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  it('crossing an age boundary before the seal discards a denial that would now be stale', async () => {
    const setup = sessionSetup({
      rules: [
        policyRule('01J0P0000000000000000000A1', {
          kind: 'min_age',
          packageKey: null,
          minAgeSeconds: 60,
        }),
      ],
    });
    const session = setup.open();
    const young = versionOf(1, { publishedAt: '2026-10-31T23:59:30.000Z' });
    expect((await session.evaluate([young]))[0]?.allowed).toBe(false);
    setup.time.advance(29_999);
    await expect(session.seal()).resolves.toBeUndefined();
    setup.time.advance(1);
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    expect((await session.evaluate([young]))[0]?.allowed).toBe(true);
    await expect(session.seal()).resolves.toBeUndefined();
  });

  it('a rule expiring before the seal is a change without any write or epoch bump', async () => {
    const setup = sessionSetup({
      rules: [policyRule(BLOCK, { expiresAt: '2026-11-01T00:00:10.000Z' })],
    });
    const session = setup.open();
    expect((await session.evaluate([versionOf(1)]))[0]?.allowed).toBe(false);
    setup.time.advance(10_000);
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    expect((await session.evaluate([versionOf(1)]))[0]?.allowed).toBe(true);
  });

  it('a winner or revision change reported by the bindings check discards the result', async () => {
    const session = sessionSetup().open();
    await session.evaluate([versionOf(1)]);
    await expect(session.seal({ bindings: async () => false })).rejects.toBeInstanceOf(
      RegistryPolicyChangedError,
    );
    await session.evaluate([versionOf(1)]);
    await expect(session.seal({ bindings: async () => true })).resolves.toBeUndefined();
    await expect(
      session.seal({
        bindings: async () => {
          throw new Error('sql: secret');
        },
      }),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  it('an unreadable policy at seal time is the fixed 503', async () => {
    const setup = sessionSetup();
    const session = setup.open();
    await session.evaluate([versionOf(1)]);
    setup.policy.state.fail = true;
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  it('cancels an already opened body when the seal refuses, and keeps it on success', async () => {
    const setup = sessionSetup();
    const session = setup.open();
    await session.evaluate([versionOf(1)]);
    const kept = body();
    await session.sealBody(kept.stream);
    expect(kept.cancel).not.toHaveBeenCalled();
    setup.policy.commit([policyRule(BLOCK)]);
    const refused = body();
    await expect(session.sealBody(refused.stream)).rejects.toBeInstanceOf(
      RegistryPolicyChangedError,
    );
    expect(refused.cancel).toHaveBeenCalledTimes(1);
  });

  it('withPolicyRetry runs one more attempt with fresh policy, then gives up with 503', async () => {
    const setup = sessionSetup();
    const session = setup.open();
    let attempts = 0;
    const result = await withPolicyRetry(async () => {
      attempts += 1;
      const [verdict] = await session.evaluate([versionOf(1)]);
      if (attempts === 1) setup.policy.commit([policyRule(BLOCK)]);
      await session.seal();
      return verdict?.allowed;
    });
    expect({ attempts, result }).toEqual({ attempts: 2, result: false });

    const flapping = sessionSetup();
    const unstable = flapping.open();
    let tries = 0;
    await expect(
      withPolicyRetry(async () => {
        tries += 1;
        await unstable.evaluate([versionOf(1)]);
        flapping.policy.commit([]);
        await unstable.seal();
      }),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    expect(tries).toBe(2);
  });

  it('the retry refreshes the evaluation instant', async () => {
    const setup = sessionSetup();
    const session = setup.open();
    const first = session.now();
    await session.evaluate([versionOf(1)]);
    setup.time.advance(5000);
    setup.policy.commit([]);
    await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    expect(Date.parse(session.now()) - Date.parse(first)).toBe(5000);
  });
});
