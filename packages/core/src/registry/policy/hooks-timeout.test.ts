import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HOOK_TIMEOUT_MS } from '../../kernel/access.js';
import type { HookMap, ReadPolicyResult, VersionFact } from '../../plugin.js';
import { REGISTRY_DEFAULTS } from '../registry-config.js';
import { RegistryPolicyUnavailableError } from './errors.js';
import {
  createHookBudget,
  runRequestHooks,
  runVersionHooks,
  type HookContext,
  type RegisteredReadHook,
} from './hooks.js';

type Handler = HookMap['registry.read'];

const CONTEXT: HookContext = {
  orgId: 'org-a',
  projectId: 'P',
  principal: { kind: 'service', id: 'svc' },
  ecosystem: 'composer',
  client: { family: 'unknown', version: null },
  now: '2026-11-01T00:00:00.000Z',
};

const FACT: VersionFact = {
  packageId: 'K',
  sourceId: 'S',
  packageKey: 'acme/a',
  versionId: 'V1',
  version: '1.0.0',
  normalizedVersion: '1.0.0.0',
  revision: 1,
  publishedAt: '2026-01-01T00:00:00.000Z',
  ageBasis: 'published',
};

const hook = (handler: Handler, plugin = 'slow'): RegisteredReadHook[] => [{ plugin, handler }];
const after =
  (ms: number, value: ReadPolicyResult = undefined): Handler =>
  () =>
    new Promise((resolve) => setTimeout(() => resolve(value), ms));

async function settle<T>(pending: Promise<T>, advance: number): Promise<T> {
  const caught = pending.catch((error: unknown) => {
    throw error;
  });
  await vi.advanceTimersByTimeAsync(advance);
  return caught;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('one cumulative hook budget', () => {
  it('defaults to the access-hook default of 1,000 ms', () => {
    expect(REGISTRY_DEFAULTS.policy.hookBudgetMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(DEFAULT_HOOK_TIMEOUT_MS).toBe(1000);
    expect(createHookBudget({}).remainingMs()).toBe(1000);
  });

  it('a call that settles within the budget passes; one past it fails closed', async () => {
    await expect(
      settle(runVersionHooks(hook(after(999)), CONTEXT, [FACT], createHookBudget({})), 999),
    ).resolves.toEqual({ request: null, denied: [] });
    const late = runVersionHooks(hook(after(1001)), CONTEXT, [FACT], createHookBudget({}));
    const outcome = expect(late).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    await vi.advanceTimersByTimeAsync(1000);
    await outcome;
  });

  it('honours a custom budget', async () => {
    const budget = createHookBudget({ budgetMs: 50 });
    const pending = runRequestHooks(
      hook(after(60)),
      CONTEXT,
      { kind: 'listing', packageKey: null },
      budget,
    );
    const outcome = expect(pending).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    await vi.advanceTimersByTimeAsync(50);
    await outcome;
    const roomy = createHookBudget({ budgetMs: 5000 });
    await expect(
      settle(
        runRequestHooks(hook(after(3000)), CONTEXT, { kind: 'listing', packageKey: null }, roomy),
        3000,
      ),
    ).resolves.toBeNull();
  });

  it('is cumulative across hooks, phases and pages, and never resets per page', async () => {
    const budget = createHookBudget({ budgetMs: 1000 });
    await settle(
      runRequestHooks(
        hook(after(400)),
        CONTEXT,
        { kind: 'metadata', packageKey: 'acme/a' },
        budget,
      ),
      400,
    );
    await settle(runVersionHooks(hook(after(400)), CONTEXT, [FACT], budget), 400);
    expect(budget.remainingMs()).toBe(200);
    const signals: AbortSignal[] = [];
    const third = runVersionHooks(
      hook((input) => {
        signals.push(input.signal);
        return new Promise(() => undefined);
      }),
      CONTEXT,
      [FACT],
      budget,
    );
    const outcome = expect(third).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    await vi.advanceTimersByTimeAsync(200);
    await outcome;
    expect(signals[0]?.aborted).toBe(true);
    await expect(
      runVersionHooks(
        hook(() => undefined),
        CONTEXT,
        [FACT],
        budget,
      ),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  it('counts synchronous hook time against the budget and rejects a late synchronous result', async () => {
    const budget = createHookBudget({ budgetMs: 1000 });
    const busy =
      (ms: number): Handler =>
      () => {
        vi.advanceTimersByTime(ms);
        return undefined;
      };
    await runVersionHooks(hook(busy(999)), CONTEXT, [FACT], budget);
    expect(budget.remainingMs()).toBe(1);
    await expect(runVersionHooks(hook(busy(1)), CONTEXT, [FACT], budget)).rejects.toBeInstanceOf(
      RegistryPolicyUnavailableError,
    );
    expect(budget.remainingMs()).toBe(0);
    await expect(
      runVersionHooks(hook(busy(1000)), CONTEXT, [FACT], createHookBudget({})),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  it('a request abort cancels pending hook work and fails closed', async () => {
    const request = new AbortController();
    const budget = createHookBudget({ budgetMs: 1000, signal: request.signal });
    let seen: AbortSignal | undefined;
    const pending = runVersionHooks(
      hook((input) => {
        seen = input.signal;
        return new Promise(() => undefined);
      }),
      CONTEXT,
      [FACT],
      budget,
    );
    const outcome = expect(pending).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    request.abort();
    await outcome;
    expect(seen?.aborted).toBe(true);
    await expect(
      runVersionHooks(
        hook(() => undefined),
        CONTEXT,
        [FACT],
        budget,
      ),
    ).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  it('a result that settles after the deadline cannot change the decision', async () => {
    let resolveLate: (value: ReadPolicyResult) => void = () => undefined;
    const pending = runVersionHooks(
      hook(() => new Promise<ReadPolicyResult>((resolve) => (resolveLate = resolve))),
      CONTEXT,
      [FACT],
      createHookBudget({ budgetMs: 100 }),
    );
    const outcome = expect(pending).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
    await vi.advanceTimersByTimeAsync(100);
    await outcome;
    resolveLate({ deniedVersions: [] });
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).rejects.toBeInstanceOf(RegistryPolicyUnavailableError);
  });

  it('rejects a malformed budget instead of falling back to a default', () => {
    for (const budgetMs of [0, -1, 1.5, Number.NaN, 600_001, '1000']) {
      expect(() => createHookBudget({ budgetMs: budgetMs as number })).toThrow(TypeError);
    }
  });
});
