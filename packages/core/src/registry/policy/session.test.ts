import { describe, expect, it, vi } from 'vitest';
import type { HookMap } from '../../plugin.js';
import {
  policyRule,
  projectActor,
  sessionSetup,
  T0,
  versionOf,
} from '../../test-support/registry-policy-session.js';
import {
  RegistryPolicyChangedError,
  RegistryPolicyDeniedError,
  RegistryPolicyUnavailableError,
} from './errors.js';
import { MAX_VERSION_DECISIONS } from './session.js';

type Handler = HookMap['registry.read'];

const phases = (hook: ReturnType<typeof vi.fn<Handler>>) =>
  hook.mock.calls.map(([input]) =>
    input.phase === 'request'
      ? `request:${String(input.packageKey)}`
      : `versions:${input.versions.map((v) => v.versionId).join(',')}`,
  );

describe('registry read session', () => {
  it('an unauthorized actor never reaches the policy reader or a hook', async () => {
    const hook = vi.fn<Handler>();
    for (const actor of [
      projectActor({ permissions: new Set() }),
      projectActor({ permissions: new Set(['project:packages:write']) }),
      { ...projectActor(), kind: 'organization' } as unknown as ReturnType<typeof projectActor>,
    ]) {
      const setup = sessionSetup({ hooks: [hook], actor });
      const reads = vi.spyOn(setup.policy.reader, 'snapshot');
      const session = setup.open();
      await expect(session.request('left-pad')).rejects.toBeInstanceOf(
        RegistryPolicyUnavailableError,
      );
      await expect(session.evaluate([versionOf(1)])).rejects.toBeInstanceOf(
        RegistryPolicyUnavailableError,
      );
      await expect(session.seal()).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
      expect(reads).not.toHaveBeenCalled();
    }
    expect(hook).not.toHaveBeenCalled();
  });

  it('reads the snapshot for the actor organization, project, ecosystem and package', async () => {
    const setup = sessionSetup({ actor: projectActor({ projectId: 'PRJ' }) });
    await setup.open({ ecosystem: 'npm' }).evaluate([versionOf(1)]);
    expect(setup.policy.queries).toEqual([
      { orgId: 'org-a', query: { ecosystem: 'npm', projectId: 'PRJ', packageKey: 'left-pad' } },
    ]);
  });

  it('runs the request phase once per package before any version phase', async () => {
    const hook = vi.fn<Handler>();
    const session = sessionSetup({ hooks: [hook] }).open({ kind: 'metadata' });
    await session.request('left-pad');
    await session.request('left-pad');
    await session.evaluate([versionOf(1)]);
    await session.evaluate([versionOf(2)]);
    expect(phases(hook)).toEqual(['request:left-pad', 'versions:V1', 'versions:V2']);
    expect(hook.mock.calls[0]![0]).toMatchObject({ phase: 'request', kind: 'metadata' });
  });

  it('memoizes decisions: a tag lookup and the body evaluate a version once and count it once', async () => {
    const hook = vi.fn<Handler>();
    const counter = vi.fn();
    const setup = sessionSetup({
      hooks: [hook],
      rules: [policyRule('01J0P0000000000000000000B1', { members: ['1.0.2'] })],
      deps: { observability: { counter } },
    });
    const session = setup.open();
    const tag = await session.evaluate([versionOf(2)]);
    const body = await session.evaluate([versionOf(1), versionOf(2), versionOf(3)]);
    expect(body[1]).toBe(tag[0]);
    expect(body.map((v) => v.allowed)).toEqual([true, false, true]);
    session.hidden(versionOf(2), tag[0]!);
    session.hidden(versionOf(2), body[1]!);
    session.metrics.flush({ counter });
    expect(counter.mock.calls).toEqual([
      ['pb.registry_policy.collection_filtered', { kind: 'npm', outcome: 'blocked' }, 1],
    ]);
    expect(phases(hook)).toEqual(['request:left-pad', 'versions:V1,V3']);
  });

  it('a different winner, revision, organization or client separates memo entries', async () => {
    const hook = vi.fn<Handler>();
    const setup = sessionSetup({ hooks: [hook] });
    const session = setup.open();
    await session.evaluate([versionOf(1)]);
    await session.evaluate([versionOf(1, { sourceId: 'S2', packageId: 'K2' })]);
    await session.evaluate([versionOf(1, { revision: 2 })]);
    await setup.open({ client: { family: 'pnpm', version: '9.0.0' } }).evaluate([versionOf(1)]);
    await setup.open({ actor: projectActor({ orgId: 'org-b' as never }) }).evaluate([versionOf(1)]);
    const versionCalls = hook.mock.calls.filter(([input]) => input.phase === 'versions');
    expect(versionCalls).toHaveLength(5);
    expect(versionCalls.map(([input]) => [input.org.orgId, input.client.family])).toEqual([
      ['org-a', 'npm'],
      ['org-a', 'npm'],
      ['org-a', 'npm'],
      ['org-a', 'pnpm'],
      ['org-b', 'npm'],
    ]);
  });

  it('combines built-ins and hooks; built-in denials never reach a hook', async () => {
    const hook = vi.fn<Handler>((input) =>
      input.phase === 'versions'
        ? {
            deniedVersions: input.versions
              .filter((v) => v.versionId === 'V3')
              .map((v) => ({
                versionId: v.versionId,
                revision: v.revision,
                reason: 'restricted' as const,
              })),
          }
        : undefined,
    );
    const session = sessionSetup({
      hooks: [hook],
      rules: [
        policyRule('01J0P0000000000000000000B1', { members: ['1.0.1'], revision: 4 }),
        policyRule('01J0P0000000000000000000A1', {
          kind: 'min_age',
          packageKey: null,
          minAgeSeconds: 86400,
        }),
      ],
    }).open();
    const verdicts = await session.evaluate([
      versionOf(1),
      versionOf(2, { publishedAt: '2026-10-31T12:00:00.000Z' }),
      versionOf(3),
      versionOf(4),
    ]);
    expect(verdicts).toEqual([
      {
        allowed: false,
        evidence: [
          {
            kind: 'rule',
            ruleId: '01J0P0000000000000000000B1',
            ruleRevision: 4,
            reason: 'blocked',
          },
        ],
      },
      {
        allowed: false,
        evidence: [
          {
            kind: 'rule',
            ruleId: '01J0P0000000000000000000A1',
            ruleRevision: 1,
            reason: 'min_age',
          },
        ],
      },
      { allowed: false, evidence: [{ kind: 'plugin', plugin: 'hook-0', reason: 'restricted' }] },
      { allowed: true, evidence: [] },
    ]);
    expect(phases(hook)).toEqual(['request:left-pad', 'versions:V3,V4']);
  });

  it('a client floor or a request-phase hook denies the whole request with the fixed 403', async () => {
    const floor = policyRule('01J0P0000000000000000000F1', {
      kind: 'client_floor',
      packageKey: null,
      clientFamily: 'npm',
      clientMinVersion: '11.0.0',
    });
    const later = vi.fn<Handler>();
    const floored = sessionSetup({ rules: [floor], hooks: [later] }).open();
    const error = await floored.evaluate([versionOf(1)]).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryPolicyDeniedError);
    expect((error as Error).message).toBe('Package access denied by policy');
    expect(later).not.toHaveBeenCalled();
    const denied = sessionSetup({ hooks: [() => ({ deny: true, reason: 'restricted' })] }).open();
    await expect(denied.request(null)).rejects.toBeInstanceOf(RegistryPolicyDeniedError);
    const unknownPasses = sessionSetup({ rules: [floor] }).open({
      client: { family: 'unknown', version: null },
    });
    await expect(unknownPasses.evaluate([versionOf(1)])).resolves.toEqual([
      { allowed: true, evidence: [] },
    ]);
  });

  it('a session without the client floor still runs request hooks and version rules', async () => {
    const floor = policyRule('01J0P0000000000000000000F1', {
      kind: 'client_floor',
      packageKey: null,
      clientFamily: 'npm',
      clientMinVersion: '11.0.0',
    });
    const block = policyRule('01J0P0000000000000000000B1', { members: ['1.0.1'] });
    const browser = sessionSetup({ rules: [floor, block] }).open({ clientFloor: false });
    const verdicts = await browser.evaluate([versionOf(0), versionOf(1)]);
    expect(verdicts.map((verdict) => verdict.allowed)).toEqual([true, false]);
    const hooked = sessionSetup({
      rules: [floor],
      hooks: [() => ({ deny: true, reason: 'restricted' })],
    }).open({ clientFloor: false });
    await expect(hooked.request(null)).rejects.toBeInstanceOf(RegistryPolicyDeniedError);
  });

  it('a version-phase whole-request denial is the fixed 403', async () => {
    const session = sessionSetup({
      hooks: [
        (input) =>
          input.phase === 'versions' ? { deny: true, reason: 'client_unsupported' } : undefined,
      ],
    }).open();
    await expect(session.evaluate([versionOf(1)])).rejects.toBeInstanceOf(
      RegistryPolicyDeniedError,
    );
  });

  it('a failing policy read or missing date fact is the fixed 503, never a pass', async () => {
    const setup = sessionSetup();
    setup.policy.state.fail = true;
    const error = await setup
      .open()
      .evaluate([versionOf(1)])
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RegistryPolicyUnavailableError);
    expect((error as Error).message).toBe('Package policy is unavailable');
    const aged = sessionSetup({
      rules: [
        policyRule('01J0P0000000000000000000A1', {
          kind: 'min_age',
          packageKey: null,
          minAgeSeconds: 1,
        }),
      ],
    }).open();
    await expect(aged.evaluate([versionOf(1, { publishedAt: 'unknown' })])).rejects.toBeInstanceOf(
      RegistryPolicyUnavailableError,
    );
  });

  it('snapshots of two packages at different epochs are a change, not a mixed decision', async () => {
    const setup = sessionSetup();
    const session = setup.open();
    await session.evaluate([versionOf(1)]);
    setup.policy.commit([]);
    await expect(
      session.evaluate([versionOf(1, { packageKey: 'right-pad' })]),
    ).rejects.toBeInstanceOf(RegistryPolicyChangedError);
  });

  it('caps version decisions per request', async () => {
    const session = sessionSetup().open();
    const many = Array.from({ length: MAX_VERSION_DECISIONS }, (_, n) => versionOf(n));
    await expect(session.evaluate(many)).resolves.toHaveLength(MAX_VERSION_DECISIONS);
    await expect(session.evaluate(many)).resolves.toHaveLength(MAX_VERSION_DECISIONS);
    await expect(session.evaluate([versionOf(MAX_VERSION_DECISIONS)])).rejects.toBeInstanceOf(
      RegistryPolicyUnavailableError,
    );
  });

  it('records durable evidence only for direct denials and refuses to audit an allowed version', async () => {
    const setup = sessionSetup({ rules: [policyRule('01J0P0000000000000000000B1')] });
    const session = setup.open();
    const [denied] = await session.evaluate([versionOf(1)]);
    session.hidden(versionOf(1), denied!);
    expect(setup.audit.events).toHaveLength(0);
    await session.denyDirect('tag', versionOf(1), denied!);
    expect(setup.audit.events.map((event) => event.action)).toEqual(['policy.read_denied']);
    await expect(
      session.denyDirect('version', versionOf(2), { allowed: true, evidence: [] }),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });
});

describe('registry read session across attempts', () => {
  const gate = () => {
    let release!: () => void;
    let entered!: () => void;
    const open = new Promise<void>((resolve) => (release = resolve));
    const reached = new Promise<void>((resolve) => (entered = resolve));
    return { open, reached, release, entered };
  };
  const denyAll = (input: Parameters<Handler>[0]) =>
    input.phase === 'versions'
      ? {
          deniedVersions: input.versions.map((v) => ({
            versionId: v.versionId,
            revision: v.revision,
            reason: 'restricted' as const,
          })),
        }
      : undefined;

  it('an evaluation started before an invalidation never writes its verdicts into the next attempt', async () => {
    const wait = gate();
    let blocked = false;
    const hook = vi.fn<Handler>(async (input) => {
      if (blocked) return denyAll(input);
      if (input.phase === 'versions') {
        wait.entered();
        await wait.open;
      }
      return undefined;
    });
    const session = sessionSetup({ hooks: [hook] }).open();
    const early = session.evaluate([versionOf(1)]);
    await wait.reached;
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    blocked = true;
    wait.release();
    await expect(early).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    const [verdict] = await session.evaluate([versionOf(1)]);
    expect(verdict).toEqual({
      allowed: false,
      evidence: [{ kind: 'plugin', plugin: 'hook-0', reason: 'restricted' }],
    });
  });

  it('an evaluation discarded by an invalidation leaves no age boundary for the seal', async () => {
    const week = 7 * 86_400_000;
    const setup = sessionSetup({
      rules: [
        policyRule('01J0P0000000000000000000A1', {
          kind: 'min_age',
          packageKey: null,
          minAgeSeconds: week / 1000,
        }),
      ],
    });
    const session = setup.open();
    await session.request('left-pad');
    const early = session.evaluate([
      versionOf(1, { publishedAt: new Date(T0 - 86_400_000).toISOString() }),
    ]);
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    await expect(early).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    expect(session.nextBoundary()).toBeNull();
    setup.time.advance(week);
    await expect(session.seal()).resolves.toBeUndefined();
  });

  it('decisions of a discarded evaluation do not count toward the cap', async () => {
    const session = sessionSetup().open();
    await session.request('left-pad');
    const many = Array.from({ length: MAX_VERSION_DECISIONS }, (_, n) => versionOf(n));
    const early = session.evaluate(many);
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    await expect(early).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    await expect(session.evaluate(many)).resolves.toHaveLength(MAX_VERSION_DECISIONS);
  });

  it('a policy read started before an invalidation never sets the next attempt epoch', async () => {
    const wait = gate();
    const setup = sessionSetup();
    const read = setup.policy.reader.snapshot.bind(setup.policy.reader);
    vi.spyOn(setup.policy.reader, 'snapshot').mockImplementationOnce(async (ctx, query) => {
      const value = await read(ctx, query);
      wait.entered();
      await wait.open;
      return value;
    });
    const session = setup.open();
    const early = session.evaluate([versionOf(1)]);
    await wait.reached;
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    setup.policy.commit([]);
    wait.release();
    await expect(early).rejects.toBeInstanceOf(RegistryPolicyChangedError);
    await expect(
      session.evaluate([versionOf(1, { packageKey: 'right-pad' })]),
    ).resolves.toHaveLength(1);
    await expect(session.seal()).resolves.toBeUndefined();
  });

  it('a request-phase denial from before an invalidation is a change, not a 403', async () => {
    const wait = gate();
    const session = sessionSetup({
      hooks: [
        async () => {
          wait.entered();
          await wait.open;
          return { deny: true, reason: 'restricted' };
        },
      ],
    }).open();
    const early = session.request('left-pad');
    await wait.reached;
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    wait.release();
    await expect(early).rejects.toBeInstanceOf(RegistryPolicyChangedError);
  });

  it('collection metrics count only what the final attempt hid', async () => {
    const counter = vi.fn();
    const setup = sessionSetup({ rules: [policyRule('01J0P0000000000000000000B1')] });
    const session = setup.open();
    const [denied] = await session.evaluate([versionOf(1)]);
    session.hidden(versionOf(1), denied!);
    setup.policy.commit([]);
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    await expect(session.evaluate([versionOf(1)])).resolves.toEqual([
      { allowed: true, evidence: [] },
    ]);
    session.metrics.flush({ counter });
    expect(counter).not.toHaveBeenCalled();
  });

  it('collection metrics still count a version the final attempt hides again', async () => {
    const counter = vi.fn();
    const setup = sessionSetup({ rules: [policyRule('01J0P0000000000000000000B1')] });
    const session = setup.open();
    const [first] = await session.evaluate([versionOf(1)]);
    session.hidden(versionOf(1), first!);
    session.metrics.flush({ counter });
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    const [again] = await session.evaluate([versionOf(1)]);
    session.hidden(versionOf(1), again!);
    session.metrics.flush({ counter });
    expect(counter).toHaveBeenCalledTimes(2);
  });

  it('a direct denial is recorded again when the next attempt denies it again', async () => {
    const setup = sessionSetup({ rules: [policyRule('01J0P0000000000000000000B1')] });
    const session = setup.open();
    const [first] = await session.evaluate([versionOf(1)]);
    await session.denyDirect('version', versionOf(1), first!);
    await session.denyDirect('version', versionOf(1), first!);
    expect(setup.audit.state.calls).toBe(1);
    expect(() => session.invalidate()).toThrow(RegistryPolicyChangedError);
    const [again] = await session.evaluate([versionOf(1)]);
    await session.denyDirect('version', versionOf(1), again!);
    expect(setup.audit.state.calls).toBe(2);
  });

  it('one version id at two revisions never reaches a hook and is the fixed 503', async () => {
    const hook = vi.fn<Handler>(denyAll);
    const session = sessionSetup({ hooks: [hook] }).open();
    await expect(
      session.evaluate([versionOf(1), versionOf(1, { revision: 2 })]),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    expect(hook.mock.calls.filter(([input]) => input.phase === 'versions')).toHaveLength(0);
  });

  it('a malformed hook budget is the fixed 503', () => {
    for (const hookBudgetMs of [Number.NaN, 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      const error = (() => {
        try {
          sessionSetup({ deps: { hookBudgetMs } }).open();
          return null;
        } catch (caught) {
          return caught;
        }
      })();
      expect(error).toBeInstanceOf(RegistryPolicyUnavailableError);
    }
  });
});
