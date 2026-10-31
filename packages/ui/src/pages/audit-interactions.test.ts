import { isValidElement, useEffect, useState, type ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import { useServices, type ShellServices } from '../auth.js';
import { checkSession, createSessionClient, signOut } from '../app.js';
import {
  AuditPage,
  AuditProjectFilter,
  AuditView,
  auditHash,
  loadAuditNames,
  clearAuditNames,
  type AuditFilters,
} from './audit.js';

vi.mock('../auth.js', async (original) => ({
  ...(await original<typeof import('../auth.js')>()),
  useServices: vi.fn(),
}));
vi.mock('react', async (original) => ({
  ...(await original<typeof import('react')>()),
  useEffect: vi.fn(),
  useState: vi.fn(),
}));
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const states: unknown[] = [];
  const effects: { deps: readonly unknown[] | undefined; cleanup: void | (() => void) }[] = [];
  let slot = 0;
  let effect = 0;
  let pending: (() => void)[] = [];
  vi.mocked(useState).mockImplementation((initial?: unknown) => {
    const key = slot++;
    if (!(key in states)) states[key] = typeof initial === 'function' ? initial() : initial;
    return [
      states[key],
      (next: unknown) => {
        states[key] = typeof next === 'function' ? next(states[key]) : next;
      },
    ] as never;
  });
  vi.mocked(useEffect).mockImplementation((create, deps) => {
    const key = effect++;
    const previous = effects[key];
    if (!previous || !deps || deps.some((dep, i) => !Object.is(dep, previous.deps?.[i]))) {
      pending.push(() => {
        previous?.cleanup?.();
        effects[key] = { deps, cleanup: create() };
      });
    }
  });
  return <T>(render: () => T): T => {
    slot = 0;
    effect = 0;
    pending = [];
    const result = render();
    pending.forEach((run) => run());
    return result;
  };
}
function find(node: ReactNode, type: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) return node.map((child) => find(child, type)).find(Boolean);
  if (!isValidElement<Record<string, unknown>>(node)) return;
  if (node.type === type) return node.props;
  return find(node.props.children as ReactNode, type);
}
const filters: AuditFilters = { actor: '', action: '', project: 'web', limit: '50', after: '' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

it('keeps a bookmarked project selected when names arrive and submits it on the next Apply', () => {
  const render = mount();
  const first = render(() => AuditProjectFilter({ project: 'web', projects: [] }));
  expect(first.props.value).toBe('web');
  const loaded = render(() =>
    AuditProjectFilter({ project: 'web', projects: [{ id: 'web', name: 'Storefront' }] }),
  );
  expect(loaded.props.value).toBe('web');
  const onNavigate = vi.fn();
  const view = AuditView({
    filters,
    scope: null,
    data: null,
    head: null,
    error: null,
    loading: false,
    onNavigate,
  });
  vi.stubGlobal(
    'FormData',
    class {
      get(key: string) {
        return key === 'filterProject' ? loaded.props.value : key === 'limit' ? '50' : '';
      }
    },
  );
  const submit = find(view, 'form')!.onSubmit as (event: unknown) => void;
  submit({ preventDefault: vi.fn(), currentTarget: {} });
  expect(onNavigate).toHaveBeenCalledWith(filters);
  loaded.props.onChange!({ currentTarget: { value: '' } } as never);
  expect(render(() => AuditProjectFilter({ project: 'web', projects: [] })).props.value).toBe('');
});

it('loads names only for rendered events, reuses scope names on unchanged Apply and navigation, and clears them on sign-out', async () => {
  const render = mount();
  const event = {
    seq: 1,
    actor: { type: 'user', id: 'self' },
    targetType: 'project',
    targetId: 'web',
    projectId: 'web',
    action: 'project.update',
    createdAt: '2026-10-22T10:00:00Z',
  };
  let items: unknown[] = [];
  const fetch = vi.fn(async (url: string) =>
    Response.json(
      url === '/_pb/me'
        ? { user: { id: 'self', displayName: 'Alex' } }
        : url === '/_pb/me/permissions'
          ? { organization: [] }
          : { items: url.includes('/audit?') ? items : [], next: null },
    ),
  );
  const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
  const listeners = new Map<string, () => void>();
  const location = { hash: auditHash(filters, 'web') };
  vi.stubGlobal('window', {
    location,
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  });
  vi.mocked(useServices).mockReturnValue({
    client,
    features: { auditTrail: true },
    organizationAuditor: false,
  } as ShellServices);
  render(AuditPage);
  await tick();
  let page = render(AuditPage);
  expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/_pb/me');
  items = [event];
  page.props.onNavigate(filters);
  render(AuditPage);
  await tick();
  render(AuditPage);
  await tick();
  page = render(AuditPage);
  expect(page.props.names?.users.self).toBe('Alex');
  const nameReads = () =>
    fetch.mock.calls.filter(([url]) => !url.includes('/audit?') && url !== '/_pb/me');
  const count = nameReads().length;
  page.props.onNavigate(filters);
  render(AuditPage);
  await tick();
  expect(render(AuditPage).props.names?.users.self).toBe('Alex');
  expect(render(AuditPage).props.names?.users.self).toBe('Alex');
  await tick();
  render(AuditPage);
  expect(nameReads()).toHaveLength(count);
  location.hash = auditHash(filters, 'other');
  listeners.get('hashchange')!();
  render(AuditPage);
  await tick();
  render(AuditPage);
  await tick();
  const otherCount = nameReads().length;
  expect(otherCount).toBeGreaterThan(count);
  location.hash = auditHash(filters, 'web');
  listeners.get('hashchange')!();
  render(AuditPage);
  await tick();
  render(AuditPage);
  await tick();
  expect(nameReads()).toHaveLength(otherCount);
  await signOut({ client, clearPending: vi.fn(), onSignedOut: vi.fn() });
  const newSession = mount();
  newSession(AuditPage);
  await tick();
  newSession(AuditPage);
  await tick();
  expect(nameReads().length).toBeGreaterThan(otherCount + 1);
});

it.each(['inactive', 'denied', 'withheld'] as const)(
  'does not load names for an %s event list',
  async (state) => {
    const render = mount();
    const fetch = vi.fn(async () =>
      state === 'denied'
        ? Response.json({ error: { code: 'forbidden' } }, { status: 403 })
        : Response.json({
            items: [{ kind: 'withheld', id: 'hidden', seq: 1, reason: 'content' }],
            next: null,
          }),
    );
    const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
    vi.stubGlobal('window', {
      location: { hash: '#/audit?project=web' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.mocked(useServices).mockReturnValue({
      client,
      features: { auditTrail: state !== 'inactive' },
      organizationAuditor: false,
    } as ShellServices);
    render(AuditPage);
    await tick();
    render(AuditPage);
    await tick();
    expect(fetch.mock.calls.length).toBe(state === 'inactive' ? 0 : 1);
  },
);

it('isolates accounts after expiry without sign-out and verifies identity before cache hits', async () => {
  let account = 'a';
  const fetch = vi.fn(async (url: string) => {
    if (account === 'expired') return Response.json({}, { status: 401 });
    if (url === '/_pb/me') return Response.json({ user: { id: account, displayName: account } });
    if (url === '/_pb/me/permissions')
      return Response.json({ organization: account === 'a' ? ['org:users:read'] : [] });
    return Response.json({
      items: url === '/_pb/users' ? [{ id: 'other', displayName: 'Private name' }] : [],
      next: null,
    });
  });
  const source = createApiClient<paths>({ fetch, readCookie: () => undefined });
  const client = createSessionClient(source);
  expect((await loadAuditNames(client, null)).users.other).toBe('Private name');
  account = 'expired';
  await client.request('get', '/_pb/projects');
  account = 'b';
  fetch.mockClear();
  const names = await loadAuditNames(client, null);
  expect(names).toEqual({ users: { b: 'b' }, tokens: {} });
  expect(fetch.mock.calls.map(([url]) => url)).not.toContain('/_pb/users');
  account = 'a';
  fetch.mockClear();
  await loadAuditNames(client, null);
  expect(fetch.mock.calls.map(([url]) => url)).toContain('/_pb/users');

  // Account isolation also holds if no request observed the expired session.
  account = 'b';
  expect((await loadAuditNames(source, null)).users.other).toBeUndefined();
  account = 'a';
  await loadAuditNames(source, null);
  account = 'b';
  expect((await loadAuditNames(source, null)).users.other).toBeUndefined();
});

it.each([true, false])(
  'clears names when a session probe returns signed-in=%s',
  async (signedIn) => {
    let probe = false;
    const fetch = vi.fn(async (url: string) => {
      if (probe && url === '/_pb/session')
        return Response.json({}, { status: signedIn ? 200 : 401 });
      return Response.json(
        url === '/_pb/me'
          ? { user: { id: 'self', displayName: 'Alex' } }
          : url === '/_pb/me/permissions'
            ? { organization: [] }
            : { items: [], next: null },
      );
    });
    const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
    await loadAuditNames(client, null);
    probe = true;
    await checkSession(client, { restore: vi.fn() }, '#/audit');
    fetch.mockClear();
    await loadAuditNames(client, null);
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/_pb/me/tokens');
  },
);

it.each([
  '/_pb/me',
  '/_pb/me/permissions',
  '/_pb/users',
  '/_pb/me/tokens',
  '/_pb/tokens',
  '/_pb/projects/web/tokens',
])('retries a failed name request at %s', async (failedPath) => {
  let fail = true;
  const fetch = vi.fn(async (url: string) => {
    if (fail && url === failedPath) return Response.json({}, { status: 503 });
    return Response.json(
      url === '/_pb/me'
        ? { user: { id: 'self', displayName: 'Alex' } }
        : url === '/_pb/me/permissions'
          ? {
              organization: failedPath.includes('/projects/')
                ? []
                : ['org:users:read', 'org:tokens:read'],
            }
          : {
              items:
                url === '/_pb/users'
                  ? [{ id: 'other', displayName: 'Sam' }]
                  : [{ id: 'token', name: 'Laptop' }],
              next: null,
            },
    );
  });
  const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
  await loadAuditNames(client, 'web');
  fail = false;
  fetch.mockClear();
  const names = await loadAuditNames(client, 'web');
  expect(fetch.mock.calls.map(([url]) => url)).toContain(failedPath);
  expect(names.users.self).toBe('Alex');
  expect(names.tokens.token).toBe('Laptop');
});

it('discards in-flight names when the session ends', async () => {
  let finish!: (response: Response) => void;
  const fetch = vi.fn(async (url: string) => {
    if (url === '/_pb/me') return Response.json({ user: { id: 'a', displayName: 'Alex' } });
    if (url === '/_pb/me/permissions') return Response.json({ organization: ['org:users:read'] });
    if (url === '/_pb/users')
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return Response.json({ items: [], next: null });
  });
  const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
  const pending = loadAuditNames(client, null);
  await tick();
  clearAuditNames(client);
  finish(Response.json({ items: [{ id: 'other', displayName: 'Private name' }], next: null }));
  expect(await pending).toEqual({ users: {}, tokens: {} });
});

it('evicts previously cached names if identity verification fails', async () => {
  let fail = false;
  const fetch = vi.fn(async (url: string) => {
    if (fail && url === '/_pb/me') return Response.json({}, { status: 503 });
    return Response.json(
      url === '/_pb/me'
        ? { user: { id: 'self', displayName: 'Alex' } }
        : url === '/_pb/me/permissions'
          ? { organization: [] }
          : { items: [], next: null },
    );
  });
  const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
  await loadAuditNames(client, null);
  fail = true;
  expect(await loadAuditNames(client, null)).toEqual({ users: {}, tokens: {} });
  fail = false;
  fetch.mockClear();
  await loadAuditNames(client, null);
  expect(fetch.mock.calls.map(([url]) => url)).toContain('/_pb/me/tokens');
});
