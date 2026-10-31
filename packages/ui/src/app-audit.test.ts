import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useAuditCapabilities } from './app.js';
import { useServices, type AuthClient, type ShellServices } from './auth.js';
import { AuditPage, type AuditView } from './pages/audit.js';

vi.mock('./auth.js', async (original) => ({
  ...(await original<typeof import('./auth.js')>()),
  useServices: vi.fn(),
}));

vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useCallback: vi.fn((callback) => callback),
  useEffect: vi.fn(),
  useMemo: vi.fn(),
  useRef: vi.fn(),
  useState: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mount(client: AuthClient) {
  const memo = new Map<number, unknown>();
  let index = 0;
  const generation = { current: 0 };
  let state = {
    features: undefined as { auditTrail: boolean } | null | undefined,
    organizationAuditor: null as boolean | null,
  };
  vi.mocked(useMemo).mockImplementation((create) => {
    const key = index++;
    if (!memo.has(key)) memo.set(key, create());
    return memo.get(key) as ReturnType<typeof create>;
  });
  vi.mocked(useCallback).mockImplementation((callback) => callback);
  vi.mocked(useRef).mockReturnValue(generation);
  vi.mocked(useState).mockImplementation(
    () =>
      [
        state,
        (next: unknown) => {
          state = next as typeof state;
        },
      ] as never,
  );
  let cleanup: (() => void) | undefined;
  return {
    render(session: 'in' | 'out', hash: string) {
      cleanup?.();
      index = 0;
      const result = useAuditCapabilities(client, session, hash);
      cleanup = vi.mocked(useEffect).mock.calls.at(-1)![0]() as () => void;
      return result;
    },
    snapshot: () => state,
  };
}

it.each([
  [true, false],
  [false, false],
  [false, true],
])(
  'loads the navigation effect for active trail %s and organization auditor %s',
  async (auditTrail, organizationAuditor) => {
    const request = vi.fn(async (_method, path) => ({
      ok: true,
      data:
        path === '/_pb/me'
          ? { features: { auditTrail } }
          : { organization: organizationAuditor ? ['org:audit:read'] : [] },
    }));
    const app = mount({ request } as unknown as AuthClient);
    app.render('in', '#/projects');
    await vi.waitFor(() =>
      expect(app.snapshot()).toEqual({ features: { auditTrail }, organizationAuditor }),
    );
    app.render('in', '#/audit');
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(2);
    app.render('out', '#/login');
    expect(app.snapshot()).toEqual({ features: undefined, organizationAuditor: null });
  },
);

it('retries failed /me on navigation and reloads after signing out', async () => {
  let failure = true;
  const request = vi.fn(async (_method, path) =>
    path === '/_pb/me' && failure
      ? { ok: false, status: 503 }
      : {
          ok: true,
          data: path === '/_pb/me' ? { features: { auditTrail: true } } : { organization: [] },
        },
  );
  const app = mount({ request } as unknown as AuthClient);
  app.render('in', '#/projects');
  await new Promise((resolve) => setImmediate(resolve));
  expect(request).toHaveBeenCalledTimes(2);
  expect(app.snapshot().features).toBeNull();
  failure = false;
  app.render('in', '#/tokens');
  await vi.waitFor(() => expect(app.snapshot().features?.auditTrail).toBe(true));
  expect(request).toHaveBeenCalledTimes(3);
  app.render('out', '#/login');
  expect(app.snapshot().features).toBeUndefined();
  app.render('in', '#/projects');
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(5));
});

it('discards a capability response that finishes after sign-out', async () => {
  let finish!: (result: unknown) => void;
  const request = vi.fn((_method, path) =>
    path === '/_pb/me'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ ok: true, data: { organization: ['org:audit:read'] } }),
  );
  const app = mount({ request } as unknown as AuthClient);
  app.render('in', '#/projects');
  app.render('out', '#/login');
  finish({ ok: true, data: { features: { auditTrail: true } } });
  await new Promise((resolve) => setImmediate(resolve));
  expect(app.snapshot()).toEqual({ features: undefined, organizationAuditor: null });
});

it.each(['/_pb/me', '/_pb/me/permissions'])(
  'keeps a direct Audit link loading when %s arrives first',
  async (first) => {
    const pending = new Map<string, (value: unknown) => void>();
    const request = vi.fn(
      (_method, path: string) => new Promise((resolve) => pending.set(path, resolve)),
    );
    const client = { request } as unknown as AuthClient;
    const app = mount(client);
    app.render('in', '#/audit');
    vi.stubGlobal('window', {
      location: { hash: '#/audit' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const states: unknown[] = [];
    const shellUseState = vi.mocked(useState).getMockImplementation()!;
    let cleanup: (() => void) | undefined;
    function page(commit: boolean) {
      vi.mocked(useServices).mockReturnValue({
        client,
        ...app.snapshot(),
      } as ShellServices);
      let slot = 0;
      vi.mocked(useState).mockImplementation((initial?: unknown) => {
        const key = slot++;
        if (!(key in states)) states[key] = typeof initial === 'function' ? initial() : initial;
        return [
          states[key],
          (next: unknown) => {
            states[key] = next;
          },
        ] as never;
      });
      const view = AuditPage();
      if (commit) {
        cleanup?.();
        cleanup = vi.mocked(useEffect).mock.calls.at(-1)![0]() as (() => void) | undefined;
      }
      vi.mocked(useState).mockImplementation(shellUseState);
      return view.props as Parameters<typeof AuditView>[0];
    }
    expect(page(true)).toMatchObject({ loading: true, error: null });
    const respond = (path: string) =>
      pending.get(path)!({
        ok: true,
        data:
          path === '/_pb/me'
            ? { features: { auditTrail: true } }
            : { organization: ['org:audit:read'] },
      });
    respond(first);
    await new Promise((resolve) => setImmediate(resolve));
    expect(app.snapshot().features).toBeUndefined();
    expect(page(true)).toMatchObject({ loading: true, error: null });
    expect(request).toHaveBeenCalledTimes(2);
    request.mockImplementation(async () => ({
      ok: true,
      data: { items: [], next: null },
    }));
    respond(first === '/_pb/me' ? '/_pb/me/permissions' : '/_pb/me');
    await vi.waitFor(() => expect(app.snapshot().features).toEqual({ auditTrail: true }));
    expect(page(true)).toMatchObject({ loading: true, error: null });
    await new Promise((resolve) => setImmediate(resolve));
    expect(page(false)).toMatchObject({ loading: false, error: null });
    expect(request.mock.calls.filter(([, path]) => path === '/_pb/me/permissions')).toHaveLength(1);
    expect(request.mock.calls.map(([, path]) => path)).toEqual([
      '/_pb/me',
      '/_pb/me/permissions',
      '/_pb/audit/status',
      '/_pb/audit',
      '/_pb/audit/head',
    ]);
    cleanup?.();
  },
);
