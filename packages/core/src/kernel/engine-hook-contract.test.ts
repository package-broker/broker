import { afterEach, describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import {
  SUPPORTED_PLUGIN_API,
  type HookMap,
  type PluginDefinition,
  type RequestContext,
  type RouteDefinition,
} from '../plugin.js';
import type { AuthorizationDecision, AuthorizationEngine } from './authorize.js';
import { createKernel } from './kernel.js';
import { KernelConfigError } from './registry.js';

type AccessHook = HookMap['access.check'];
const principal = { kind: 'user', id: 'contract-user' } as const;
const allow: AuthorizationDecision = { allow: true, principal, projectId: null };
const url = 'http://broker.test/contract';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function engineReturning(value: unknown): AuthorizationEngine {
  return { authorize: () => Promise.resolve(value as AuthorizationDecision) };
}

function hookReturning(value: unknown): AccessHook {
  return () => value as ReturnType<AccessHook>;
}

function fixture(
  authorization?: AuthorizationEngine,
  hooks: readonly AccessHook[] = [() => undefined],
  overrides: Record<string, unknown> = {},
) {
  const handler = vi.fn<(context: RequestContext) => Response>(() => new Response('handled'));
  const logs: Readonly<Record<string, unknown>>[] = [];
  const route = {
    method: 'GET',
    path: '/contract',
    permission: 'org:read',
    boundary: 'organization',
    handler,
    ...overrides,
  } as RouteDefinition;
  const plugin: PluginDefinition = {
    id: 'contract',
    package: '@test/contract',
    apiVersion: SUPPORTED_PLUGIN_API[1],
    platforms: ['node'],
    register(registry) {
      registry.route(route);
      for (const hook of hooks) registry.hook('access.check', hook);
    },
  };
  const kernel = () =>
    createKernel({
      platform: 'node',
      plugins: [plugin],
      ports: {
        organizations: { get: () => Promise.resolve(null) },
        clock: fixedClock('2026-10-15T00:00:00.000Z'),
        ids: { ulid: () => '01JA0000000000000000000000' },
      },
      resolveOrg: () => Promise.resolve(orgContext('contract-org')),
      health: () => Promise.resolve(true),
      log: (entry) => logs.push(entry),
      ...(authorization === undefined ? {} : { authorization }),
    });
  return { kernel, handler, logs };
}

async function expectForbidden(response: Response) {
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({
    error: {
      code: 'forbidden',
      message: 'Forbidden',
      requestId: expect.any(String),
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('kernel engine and hook contract', () => {
  it('waits for the engine allow, then the hook, before invoking the handler', async () => {
    const decision = deferred<AuthorizationDecision>();
    const engineEntered = deferred<void>();
    const hookEntered = deferred<void>();
    const hookFinished = deferred<undefined>();
    const hook = vi.fn<AccessHook>(() => {
      hookEntered.resolve();
      return hookFinished.promise;
    });
    const authorize = vi.fn<AuthorizationEngine['authorize']>(() => {
      engineEntered.resolve();
      return decision.promise;
    });
    const f = fixture({ authorize }, [hook]);
    const kernel = await f.kernel();
    const pending = kernel.fetch(new Request(url));
    await engineEntered.promise;
    expect(hook).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();

    decision.resolve(allow);
    await hookEntered.promise;
    expect(f.handler).not.toHaveBeenCalled();
    expect(hook).toHaveBeenCalledExactlyOnceWith({
      org: orgContext('contract-org'),
      principal,
      permission: 'org:read',
      projectId: null,
    });
    hookFinished.resolve(undefined);

    expect((await pending).status).toBe(200);
    expect(f.handler).toHaveBeenCalledOnce();
    expect(f.handler.mock.calls[0]?.[0]).toMatchObject({ principal, projectId: null });
  });

  it('defaults to deny-all without invoking hooks or the handler', async () => {
    const hook = vi.fn<AccessHook>(() => undefined);
    const f = fixture(undefined, [hook]);
    const kernel = await f.kernel();
    await expectForbidden(await kernel.fetch(new Request(url)));
    expect(hook).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404] as const)(
    'preserves engine denial %i and skips hooks',
    async (status) => {
      const hook = vi.fn<AccessHook>(() => undefined);
      const f = fixture(engineReturning({ allow: false, status }), [hook]);
      const kernel = await f.kernel();
      expect((await kernel.fetch(new Request(url))).status).toBe(status);
      expect(hook).not.toHaveBeenCalled();
      expect(f.handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['deny', () => ({ deny: true, reason: 'contract policy reason' })],
    ['allow-shaped result', hookReturning({ allow: true })],
    ['mixed allow and deny', hookReturning({ allow: true, deny: true })],
    ['malformed result', hookReturning({ deny: false })],
    ['null result', hookReturning(null)],
    [
      'exception',
      () => {
        throw new Error('contract policy reason');
      },
    ],
    ['rejection', () => Promise.reject(new Error('contract policy reason'))],
  ] satisfies readonly (readonly [string, AccessHook])[])(
    'returns a generic 403 for hook %s and stops the chain',
    async (_label, failingHook) => {
      const authorize = vi.fn<AuthorizationEngine['authorize']>(() => Promise.resolve(allow));
      const hook = vi.fn(failingHook);
      const later = vi.fn<AccessHook>(() => undefined);
      const f = fixture({ authorize }, [hook, later]);
      const kernel = await f.kernel();
      const response = await kernel.fetch(new Request(url));
      await expectForbidden(response);
      expect(authorize).toHaveBeenCalledOnce();
      expect(hook).toHaveBeenCalledOnce();
      expect(later).not.toHaveBeenCalled();
      expect(f.handler).not.toHaveBeenCalled();
      expect(JSON.stringify(f.logs).includes('contract policy reason')).toBe(false);
    },
  );

  it('denies a hook timeout and ignores a late successful settlement', async () => {
    vi.useFakeTimers();
    const entered = deferred<void>();
    const late = deferred<undefined>();
    const later = vi.fn<AccessHook>(() => undefined);
    const f = fixture(engineReturning(allow), [
      () => {
        entered.resolve();
        return late.promise;
      },
      later,
    ]);
    const kernel = await f.kernel();
    const pending = kernel.fetch(new Request(url));
    await entered.promise;
    await vi.advanceTimersByTimeAsync(999);
    expect(f.handler).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expectForbidden(await pending);
    late.resolve(undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(later).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each(['reason', 'exception', 'rejection'] as const)(
    'keeps a sentinel in the hook %s out of the response and logs',
    async (source) => {
      const sentinel = `sensitive-${crypto.randomUUID()}`;
      const hook: AccessHook = () => {
        if (source === 'exception') throw new Error(sentinel);
        if (source === 'rejection') return Promise.reject(new Error(sentinel));
        return { deny: true, reason: sentinel };
      };
      const f = fixture(engineReturning(allow), [hook]);
      const kernel = await f.kernel();
      const response = await kernel.fetch(new Request(url));
      const body = await response.clone().text();
      await expectForbidden(response);
      expect(body.includes(sentinel)).toBe(false);
      expect(JSON.stringify([...response.headers]).includes(sentinel)).toBe(false);
      expect(JSON.stringify(f.logs).includes(sentinel)).toBe(false);
      expect(f.logs.length).toBeGreaterThan(0);
      expect(f.handler).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['incomplete allow', { allow: true }],
    ['non-boolean allow', { ...allow, allow: 'true' }],
    ['invalid principal', { ...allow, principal: { kind: 'user' } }],
    ['extra field', { ...allow, extra: true }],
    ['invalid denial status', { allow: false, status: 200 }],
  ])('denies a malformed engine decision: %s', async (_label, value) => {
    const hook = vi.fn<AccessHook>(() => undefined);
    const f = fixture(engineReturning(value), [hook]);
    const kernel = await f.kernel();
    await expectForbidden(await kernel.fetch(new Request(url)));
    expect(hook).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each(['engine', 'hook'] as const)('HEAD cannot bypass a %s denial', async (source) => {
    const hook = vi.fn<AccessHook>(() => ({ deny: true }));
    const f = fixture(
      engineReturning(source === 'engine' ? { allow: false, status: 403 } : allow),
      [hook],
    );
    const kernel = await f.kernel();
    const response = await kernel.fetch(new Request(url, { method: 'HEAD' }));
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('');
    expect(hook).toHaveBeenCalledTimes(source === 'engine' ? 0 : 1);
    expect(f.handler).not.toHaveBeenCalled();
  });

  it.each([
    ['missing boundary', { boundary: undefined }],
    ['unknown boundary', { boundary: 'tenant' }],
    ['unknown permission', { permission: 'org:unknown-contract-action' }],
    ['malformed permission', { permission: 42 }],
    ['public with protected boundary', { permission: null }],
    ['protected without organization', { needsOrg: false }],
  ])('refuses %s at registration before any execution', async (_label, overrides) => {
    const authorize = vi.fn<AuthorizationEngine['authorize']>(() => Promise.resolve(allow));
    const hook = vi.fn<AccessHook>(() => undefined);
    const f = fixture({ authorize }, [hook], overrides);
    await expect(f.kernel()).rejects.toBeInstanceOf(KernelConfigError);
    expect(authorize).not.toHaveBeenCalled();
    expect(hook).not.toHaveBeenCalled();
    expect(f.handler).not.toHaveBeenCalled();
  });
});
