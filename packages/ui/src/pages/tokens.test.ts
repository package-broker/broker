import { readFileSync } from 'node:fs';
import { tokenEligiblePermissions } from './tokens/principal-form.js';
import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  IssueTokenForm,
  scopeReason,
  usablePrincipals,
  selectionError,
} from './tokens/issue-token-form.js';
import { tokenClientConfig } from './tokens/client-config.js';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import { createReauthFlow } from '../auth.js';
import {
  TokensView,
  TokenList,
  filterTokens,
  bindTokensLifecycle,
  bindTokensReplay,
  createTokensController,
  lifetimeChoices,
  tokensReducer,
} from './tokens.js';

afterEach(() => vi.unstubAllGlobals());

const sentinel = 'show-once-sentinel';
const id = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const lifetime = {
  personal: { maxDays: 120, defaultDays: 45 },
  service: { maxDays: 365, defaultDays: 90 },
};
const item = {
  id,
  kind: 'pat',
  name: 'automation',
  scope: 'read',
  readOnly: true,
  status: 'active',
  projectMode: 'all',
  projectCount: 0,
  projectId: null,
  userId: 'me',
  createdByUserId: 'me',
  servicePrincipalId: null,
  createdAt: '2026-10-01',
  expiresAt: '2026-11-01',
  lastUsedAt: null,
  revokedAt: null,
};
const draft = {
  name: 'automation',
  scope: 'read' as const,
  lifetimeDays: 45,
  projectMode: 'all' as const,
  projectIds: [],
  servicePrincipalId: id,
};
function storage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
function setup(status = 201, code = 'invalid_request', clearAfterCopy = false) {
  const session = storage();
  const local = storage();
  vi.stubGlobal('sessionStorage', session);
  vi.stubGlobal('localStorage', local);
  const clipboard = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
  const navigate = vi.fn();
  const requireReauth = vi.fn();
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'GET') {
      if (url.startsWith('/_pb/projects') && !url.includes('/tokens'))
        return Response.json({ items: [{ id: 'project-id', slug: 'demo' }], next: null });
      if (url === '/_pb/me/permissions') return Response.json({ organization: [] });
      if (url === '/_pb/session') return Response.json({ user: { id: 'me' } });
      if (url.startsWith('/_pb/users')) return new Response(null, { status: 403 });
      if (url.includes('service-principals'))
        return Response.json({
          items: [{ id, name: 'build', status: 'active', projectId: null }],
          next: null,
        });
      return Response.json({ items: [item], next: null, lifetime });
    }
    return status === 204
      ? new Response(null, { status })
      : Response.json(
          status === 201
            ? { id, token: sentinel }
            : { error: { code, message: sentinel }, token: sentinel },
          { status },
        );
  });
  const services = {
    client: createApiClient<paths>({ fetch, readCookie: () => 'csrf' }),
    requireReauth,
  };
  const deps = {
    storage: session,
    origin: 'https://broker.example:8443',
    clipboard,
    navigate,
    newKey: () => 'new-key',
    now: Date.now,
    clearAfterCopy,
  };
  const controller = createTokensController(services, deps);
  return { controller, services, deps, session, local, clipboard, fetch, navigate, requireReauth };
}
function markup(controller: ReturnType<typeof createTokensController>) {
  return renderToString(createElement(TokensView, { state: controller.snapshot(), controller }));
}

describe('token mutation replay refresh', () => {
  it.each([
    '/_pb/me/tokens/token-id',
    '/_pb/tokens/token-id',
    '/_pb/projects/demo/tokens/token-id',
    '/_pb/service-principals',
    '/_pb/service-principals/principal-id/suspend',
    '/_pb/projects/demo/service-principals/principal-id/suspend',
  ])('refreshes current lists after a successful replay at %s', async (path) => {
    const f = setup();
    await f.controller.load('project', 'demo', 'old-page');
    const listeners = new Set<(result: { path: string; ok: boolean; status: number }) => void>();
    const services = {
      ...f.services,
      subscribeReplay: (
        listener: (result: { path: string; ok: boolean; status: number }) => void,
      ) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
    };
    const cleanup = bindTokensReplay(f.controller, services);
    f.fetch.mockClear();
    for (const listener of listeners) listener({ path, ok: true, status: 204 });
    await vi.waitFor(() =>
      expect(f.fetch.mock.calls.some(([url]) => url === '/_pb/projects/demo/tokens')).toBe(true),
    );
    expect(f.fetch.mock.calls.some(([url]) => url === '/_pb/service-principals')).toBe(true);
    cleanup!();
    expect(listeners.size).toBe(0);
  });
  it.each(['revoke', 'create', 'suspend'] as const)(
    'updates displayed records after confirming reauthenticated %s',
    async (action) => {
      const f = setup();
      const original = f.fetch.getMockImplementation()!;
      let attempts = 0;
      let replayed = false;
      f.fetch.mockImplementation(async (url, init) => {
        if (init.method !== 'GET') {
          if (++attempts === 1)
            return Response.json({ error: { code: 'reauth_required' } }, { status: 403 });
          replayed = true;
          return new Response(null, { status: 204 });
        }
        if (url.startsWith('/_pb/me/tokens'))
          return Response.json({
            items: [{ ...item, status: replayed && action === 'revoke' ? 'revoked' : 'active' }],
            next: null,
            lifetime,
          });
        if (url.startsWith('/_pb/service-principals'))
          return Response.json({
            items: replayed
              ? [
                  {
                    id,
                    name: 'build',
                    status: action === 'suspend' ? 'suspended' : 'active',
                    projectId: null,
                  },
                ]
              : [],
            next: null,
          });
        return original(url, init);
      });
      const flow = createReauthFlow({
        client: f.services.client,
        storage: f.session,
        now: Date.now,
        navigate: vi.fn(),
      });
      const services = {
        client: f.services.client,
        subscribeReplay: flow.subscribeReplay,
        requireReauth: (
          request: Parameters<typeof flow.requireReauth>[0],
          options: Parameters<typeof flow.requireReauth>[1],
        ) => flow.requireReauth(request, options, '#/tokens'),
      };
      const before = createTokensController(services, f.deps);
      await before.load();
      if (action === 'revoke') await before.revoke(id);
      else if (action === 'create') await before.createPrincipal('build', '', []);
      else
        await before.suspendPrincipal({
          id,
          name: 'build',
          projectId: null,
          status: 'active',
          revision: 1,
          createdByUserId: 'me',
          permissions: [],
        });
      before.dispose();
      const returned = createTokensController(services, f.deps);
      await returned.load();
      await returned.loadPrincipals();
      const cleanup = bindTokensReplay(returned, services);
      flow.restore();
      expect(replayed).toBe(false);
      await flow.confirm();
      await vi.waitFor(() => {
        if (action === 'revoke') expect(returned.snapshot().items[0]?.status).toBe('revoked');
        else
          expect(returned.snapshot().principals[0]?.status).toBe(
            action === 'suspend' ? 'suspended' : 'active',
          );
      });
      cleanup!();
    },
  );
  it('ignores failures and unrelated replay results', () => {
    const f = setup();
    let replay!: (result: { path: string; ok: boolean; status: number }) => void;
    const cleanup = bindTokensReplay(f.controller, {
      ...f.services,
      subscribeReplay: (listener) => {
        replay = listener;
        return vi.fn();
      },
    });
    replay({ path: '/_pb/me/tokens/id', ok: false, status: 403 });
    replay({ path: '/_pb/projects/demo/archive', ok: true, status: 204 });
    expect(f.fetch).not.toHaveBeenCalled();
    cleanup!();
  });
});

describe('tokens show once', () => {
  it('clears the secret from state and second render on navigate', async () => {
    const { controller } = setup();
    await controller.issue(draft);
    expect(markup(controller)).toContain(sentinel);
    expect(markup(controller)).toContain('Copy this token now. You cannot view it again.');
    expect(tokensReducer(controller.snapshot(), { type: 'navigate' }).secret).toBeNull();
    controller.navigate();
    expect(JSON.stringify(controller.snapshot())).not.toContain(sentinel);
    expect(markup(controller)).not.toContain(sentinel);
  });
  it('does not persist the issued secret in either storage', async () => {
    const { controller, session, local } = setup();
    await controller.issue(draft);
    expect(controller.snapshot().secret).toBe(sentinel);
    expect([...session.values.values(), ...local.values.values()].join()).not.toContain(sentinel);
  });
  it('does not persist a secret after reauth_required', async () => {
    const { controller, session, local, navigate } = setup(403, 'reauth_required');
    await controller.issue(draft);
    expect(session.values.size).toBe(1);
    expect([...session.values.values(), ...local.values.values()].join()).not.toContain(sentinel);
    expect(navigate).toHaveBeenCalledWith(expect.stringContaining('#/reauth?return='));
    expect(markup(controller)).not.toContain(sentinel);
  });
  it('clears the secret on unmount without persisting it', async () => {
    const { controller, session, local } = setup();
    await controller.issue(draft);
    controller.dispose();
    expect(controller.snapshot().secret).toBeNull();
    expect([...session.values.values(), ...local.values.values()].join()).not.toContain(sentinel);
  });
  it('does not show a secret field for already_issued', async () => {
    const { controller } = setup(409, 'already_issued');
    await controller.issue(draft);
    expect(markup(controller)).toContain('already issued, create a new token');
    expect(markup(controller)).not.toContain(sentinel);
    expect(markup(controller)).not.toContain('aria-label="Token secret"');
  });
  it('does not show a copy button for already_issued', async () => {
    const { controller } = setup(409, 'already_issued');
    await controller.issue(draft);
    expect(markup(controller)).not.toContain('Copy token');
  });
  it.each([400, 403, 409])('does not render response text from failed issue %s', async (status) => {
    const { controller } = setup(status);
    await controller.issue(draft);
    expect(markup(controller)).toContain('Unable to update tokens');
    expect(markup(controller)).not.toContain(sentinel);
    expect(JSON.stringify(controller.snapshot())).not.toContain(sentinel);
  });
  it('restores only a safe pending action and requires confirmation before replay', async () => {
    const f = setup(403, 'reauth_required');
    await f.controller.issue(draft);
    expect([...f.session.values.values()].join()).toContain('lifetimeDays');
    const next = createTokensController(f.services, f.deps);
    next.restore();
    expect(markup(next)).toContain('Confirm token issue');
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(next.snapshot().pending)).not.toContain(sentinel);
    await next.confirm();
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.fetch.mock.calls[1]![0]).toBe('/_pb/me/tokens');
    expect(f.fetch.mock.calls[1]![1].method).toBe('GET');
    const init = f.fetch.mock.calls[2]![1];
    expect(init.headers).toMatchObject({ 'Idempotency-Key': 'new-key' });
    expect(JSON.parse(String(init.body))).toEqual({
      name: 'automation',
      scope: 'read',
      lifetimeDays: 45,
      projectMode: 'all',
      projectIds: [],
    });
  });
  it('keeps the secret after a successful copy by default', async () => {
    const { controller, clipboard } = setup();
    await controller.issue(draft);
    await controller.copy();
    expect(clipboard).toHaveBeenCalledWith(sentinel);
    expect(controller.snapshot().secret).toBe(sentinel);
  });
  it('clears after successful copy when configured', async () => {
    const { controller } = setup(201, 'invalid_request', true);
    await controller.issue(draft);
    await controller.copy();
    expect(controller.snapshot().secret).toBeNull();
  });
  it('keeps the secret after clipboard failure', async () => {
    const { controller, clipboard } = setup(201, 'invalid_request', true);
    clipboard.mockRejectedValueOnce(new Error(sentinel));
    await controller.issue(draft);
    await controller.copy();
    expect(controller.snapshot().secret).toBe(sentinel);
    expect(controller.snapshot().notice).toBe(
      'Could not copy. Select and copy the token manually.',
    );
  });
  it('discards a late issue response after navigation', async () => {
    const f = setup();
    let finish!: (response: Response) => void;
    f.fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const issuing = f.controller.issue(draft);
    f.controller.navigate();
    finish(Response.json({ id, token: sentinel }, { status: 201 }));
    await issuing;
    expect(f.controller.snapshot().secret).toBeNull();
  });
  it('clears on leaving the panel', async () => {
    const { controller } = setup();
    await controller.issue(draft);
    controller.closeSecret();
    expect(markup(controller)).not.toContain(sentinel);
  });
  it('sends only session requests and lifetimeDays', async () => {
    const { controller, fetch } = setup();
    await controller.issue(draft);
    expect(fetch.mock.calls[0]![0]).toBe('/_pb/me/tokens');
    expect(fetch.mock.calls[0]![1]).toMatchObject({
      credentials: 'same-origin',
      redirect: 'error',
      headers: { 'Idempotency-Key': 'new-key', 'X-CSRF-Token': 'csrf' },
    });
    expect(fetch.mock.calls[0]![1].headers).not.toHaveProperty('Authorization');
    expect(String(fetch.mock.calls[0]![1].body)).not.toContain('expiresAt');
  });
  it('uses configured default and maximum among lifetime presets', () => {
    expect(lifetimeChoices(lifetime.personal)).toEqual([30, 45, 90, 120]);
  });
  it('loads own, project and organization lists', async () => {
    const { controller, fetch } = setup();
    await controller.load('personal', null);
    await controller.load('project', 'demo');
    await controller.load('organization', null);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining(['/_pb/me/tokens', '/_pb/projects/demo/tokens', '/_pb/tokens']),
    );
    expect(markup(controller)).toContain('2026-11-01');
    expect(markup(controller)).toContain('a member');
  });
  it('passes revocation reauth to the shell without response text', async () => {
    const { controller, requireReauth } = setup(403, 'reauth_required');
    await controller.revoke(id);
    expect(requireReauth).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'DELETE', path: `/_pb/me/tokens/${id}` }),
      { credential: false, secretFields: [] },
    );
  });
  it('shows a fixed reload message on precondition failure', async () => {
    const { controller } = setup(412, 'precondition_failed');
    await controller.revoke(id);
    expect(markup(controller)).toContain('changed. Reload');
    expect(markup(controller)).not.toContain(sentinel);
  });
});

describe('token lifecycle and management edges', () => {
  it.each(['hashchange', 'pagehide', 'pageshow'])('clears a secret on %s', async (name) => {
    const { controller } = setup();
    const events = new EventTarget();
    const cleanup = bindTokensLifecycle(controller, events, () => {});
    await controller.issue(draft);
    expect(markup(controller)).toContain(sentinel);
    events.dispatchEvent(new Event(name));
    expect(markup(controller)).not.toContain(sentinel);
    expect(controller.snapshot().secret).toBeNull();
    cleanup();
  });
  it('wires unmount cleanup to secret clearing', async () => {
    const { controller } = setup();
    const cleanup = bindTokensLifecycle(controller, new EventTarget(), () => {});
    await controller.issue(draft);
    cleanup();
    expect(controller.snapshot().secret).toBeNull();
  });
  it('does not let a late clipboard completion clear a later secret', async () => {
    const { controller, clipboard } = setup(201, 'invalid_request', true);
    let finish!: () => void;
    clipboard.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await controller.issue(draft);
    const copying = controller.copy();
    await controller.issue(draft);
    finish();
    await copying;
    expect(controller.snapshot().secret).toBe(sentinel);
  });
  it('renews an own personal token through the personal route from the organization list', async () => {
    const { controller, fetch } = setup();
    await controller.identity();
    await controller.load('organization', null);
    controller.renew(controller.snapshot().items[0]!);
    expect(markup(controller)).toContain('value="automation"');
    await controller.issue(draft);
    expect(fetch.mock.calls.at(-1)![0]).toBe('/_pb/me/tokens');
    expect(markup(controller)).toContain('Revoke old personal token');
  });
  it('retains the offer to revoke an old personal token after reauth', async () => {
    const f = setup(403, 'reauth_required');
    await f.controller.identity();
    await f.controller.load();
    f.controller.renew(f.controller.snapshot().items[0]!);
    await f.controller.issue(draft);
    const next = createTokensController(f.services, f.deps);
    await next.start('personal', null);
    f.fetch.mockImplementationOnce(async () =>
      Response.json({ id: 'new-id', token: sentinel }, { status: 201 }),
    );
    await next.confirm();
    expect(markup(next)).toContain('Revoke old personal token');
  });
  it('does not renew another member personal token', async () => {
    const { controller } = setup();
    await controller.identity();
    await controller.load();
    controller.renew({ ...controller.snapshot().items[0]!, userId: 'someone-else' });
    expect(controller.snapshot().renewal).toBeNull();
  });
  it('rotates a project service token with the chosen overlap', async () => {
    const { controller, fetch } = setup();
    await controller.load('project', 'demo');
    controller.renew({ ...controller.snapshot().items[0]!, kind: 'svc', servicePrincipalId: id });
    expect(markup(controller)).toContain('whichever is first');
    await controller.issue({ ...draft, overlapDays: 7 });
    expect(fetch.mock.calls.at(-1)![0]).toBe(`/_pb/projects/demo/tokens/${id}/rotate`);
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1].body))).toEqual({
      name: 'automation',
      lifetimeDays: 45,
      overlapDays: 7,
    });
  });
  it('creates a principal with an idempotency key through the session client', async () => {
    const { controller, fetch } = setup(204);
    await controller.createPrincipal('build', '', ['project:read']);
    const write = fetch.mock.calls.find(([, init]) => init.method === 'POST')!;
    expect(write[0]).toBe('/_pb/service-principals');
    expect(write[1].headers).toMatchObject({ 'Idempotency-Key': 'new-key' });
    expect(JSON.parse(String(write[1].body))).toEqual({
      name: 'build',
      permissions: ['project:read'],
    });
  });
  it('suspends a principal using the documented revoke-access operation', async () => {
    const { controller, fetch } = setup(204);
    await controller.loadPrincipals();
    await controller.suspendPrincipal(controller.snapshot().principals[0]!);
    expect(
      fetch.mock.calls.some(
        ([url, init]) => url === `/_pb/service-principals/${id}/suspend` && init.method === 'POST',
      ),
    ).toBe(true);
  });
  it('does not load account names without org:users:read', async () => {
    const { controller, fetch } = setup();
    await controller.identity();
    expect(fetch.mock.calls.some(([url]) => url.startsWith('/_pb/users'))).toBe(false);
    expect(controller.snapshot().names).toEqual({});
  });
  it('does not retain secrets added to a hostile list response', async () => {
    const { controller, fetch } = setup();
    fetch.mockImplementationOnce(async () =>
      Response.json({ items: [{ ...item, token: sentinel }], next: null, lifetime }),
    );
    await controller.load();
    expect(controller.snapshot().items).toHaveLength(1);
    expect(JSON.stringify(controller.snapshot())).not.toContain(sentinel);
  });
  it('does not replay a declined pending issue', async () => {
    const f = setup(403, 'reauth_required');
    await f.controller.issue(draft);
    const next = createTokensController(f.services, f.deps);
    next.restore();
    next.decline();
    await next.confirm();
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('token scope and policy edges', () => {
  it('renews a project service token from the organization list using its project slug', async () => {
    const { controller, fetch } = setup();
    await controller.identity();
    await controller.load('organization', null);
    controller.renew({ ...controller.snapshot().items[0]!, kind: 'svc', projectId: 'project-id' });
    await controller.issue({ ...draft, overlapDays: 1 });
    expect(fetch.mock.calls.at(-1)![0]).toBe(`/_pb/projects/demo/tokens/${id}/rotate`);
  });
  it('preselects the reported default and excludes presets above the maximum', async () => {
    const { controller } = setup();
    await controller.load();
    await controller.identity();
    controller.renew(controller.snapshot().items[0]!);
    const html = markup(controller);
    expect(html).toContain('<option value="45" selected="">');
    expect(html).not.toContain('value="180"');
    expect(html).not.toContain('value="365"');
  });
  it('blocks duplicate issue while a request is pending', async () => {
    const { controller, fetch } = setup();
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const first = controller.issue(draft);
    await controller.issue(draft);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(Response.json({ id, token: sentinel }, { status: 201 }));
    await first;
  });
  it('clears an existing secret before reauth and never stores it in pending intent', async () => {
    const { controller, fetch, session } = setup();
    await controller.issue(draft);
    fetch.mockImplementationOnce(async () =>
      Response.json({ error: { code: 'reauth_required' } }, { status: 403 }),
    );
    await controller.issue(draft);
    expect(controller.snapshot().secret).toBeNull();
    expect(session.values.size).toBe(1);
    expect([...session.values.values()].join()).not.toContain(sentinel);
  });
  it('does not hold email addresses when loading permitted issuer names', async () => {
    const { controller, fetch } = setup();
    fetch.mockImplementation(async (url: string) => {
      if (url === '/_pb/session')
        return Response.json({ user: { id: 'me', email: 'private-email-sentinel' } });
      if (url === '/_pb/me/permissions') return Response.json({ organization: ['org:users:read'] });
      return Response.json({
        items: url.startsWith('/_pb/users')
          ? [{ id: 'me', displayName: 'Member name', email: 'private-email-sentinel' }]
          : [],
        next: null,
      });
    });
    await controller.identity();
    expect(controller.snapshot().names).toEqual({ me: 'Member name' });
    expect(JSON.stringify(controller.snapshot()) + markup(controller)).not.toContain(
      'private-email-sentinel',
    );
  });
});

function control(
  controller: ReturnType<typeof createTokensController>,
  matches: (props: Record<string, unknown>) => boolean,
) {
  function find(node: ReactNode): Record<string, unknown> | undefined {
    for (const child of Children.toArray(node)) {
      if (!isValidElement<Record<string, unknown>>(child)) continue;
      if (matches(child.props)) return child.props;
      const nested = find(child.props.children as ReactNode);
      if (nested) return nested;
    }
    return undefined;
  }
  const found = find(TokensView({ state: controller.snapshot(), controller }));
  if (!found) throw new Error('Control missing');
  return found;
}

function selectList(controller: ReturnType<typeof createTokensController>, target: string) {
  const props = control(controller, (props) => props.id === 'token-list');
  (props.onChange as (event: { target: { value: string } }) => void)({ target: { value: target } });
}

describe('round 1 regressions', () => {
  it('keeps a project principal selected when renewing from the organization list', async () => {
    const { controller, fetch } = setup();
    await controller.identity();
    await controller.load('organization', null);
    fetch.mockImplementationOnce(async () =>
      Response.json({
        items: [
          { id: 'local-principal', name: 'Local bot', status: 'active', projectId: 'project-id' },
        ],
        next: null,
      }),
    );
    await controller.loadPrincipals();
    controller.renew({
      ...controller.snapshot().items[0]!,
      kind: 'svc',
      projectId: 'project-id',
      servicePrincipalId: 'local-principal',
    });
    const picker = control(controller, (props) => props.id === 'token-principal');
    expect(picker.disabled).toBe(true);
    expect(
      renderToString(
        createElement(
          'select',
          { defaultValue: picker.defaultValue as string },
          picker.children as ReactNode,
        ),
      ),
    ).toContain('<option value="local-principal" selected="">');
  });

  it.each(['pat', 'svc'] as const)(
    'keeps %s renewal and its secret safe while issuing',
    async (kind) => {
      const { controller, fetch } = setup();
      await controller.identity();
      await controller.load(kind === 'pat' ? 'personal' : 'project', 'demo');
      controller.renew({ ...controller.snapshot().items[0]!, kind, servicePrincipalId: id });
      let finish!: (response: Response) => void;
      fetch.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      const issuing = controller.issue(draft);
      const cancel = control(controller, (props) => props.children === 'Cancel renewal');
      expect(cancel.disabled).toBe(true);
      controller.closeSecret();
      expect(controller.snapshot().renewal).not.toBeNull();
      finish(Response.json({ id: 'new-id', token: sentinel }, { status: 201 }));
      await issuing;
      expect(controller.snapshot().secret).toBe(sentinel);
      expect(markup(controller)).toContain(sentinel);
      if (kind === 'pat') expect(markup(controller)).toContain('Revoke old personal token');
    },
  );

  it.each(['project', 'organization'] as const)(
    'offers principals only in the %s issuance boundary',
    async (target) => {
      const { controller, fetch } = setup();
      await controller.identity();
      await controller.load(target, 'demo');
      fetch.mockImplementationOnce(async () =>
        Response.json({
          items: [
            { id: 'org-principal', name: 'Org bot', status: 'active', projectId: null },
            { id: 'local-principal', name: 'Local bot', status: 'active', projectId: 'project-id' },
            {
              id: 'foreign-principal',
              name: 'Foreign bot',
              status: 'active',
              projectId: 'other-id',
            },
            {
              id: 'suspended-principal',
              name: 'Suspended bot',
              status: 'suspended',
              projectId: 'project-id',
            },
          ],
          next: null,
        }),
      );
      await controller.loadPrincipals();
      controller.renew({
        ...controller.snapshot().items[0]!,
        kind: 'svc',
        projectId: target === 'project' ? 'project-id' : null,
      });
      const picker = control(controller, (props) => props.id === 'token-principal');
      const html = renderToString(createElement('select', {}, picker.children as ReactNode));
      expect(html).toContain(`value="${target === 'project' ? 'local' : 'org'}-principal"`);
      expect(html).not.toContain(`value="${target === 'project' ? 'org' : 'local'}-principal"`);
      expect(html).not.toContain('value="foreign-principal"');
      expect(html).not.toContain('value="suspended-principal"');
    },
  );

  it('does not offer raw token principal IDs when principal discovery is forbidden', async () => {
    const { controller, fetch } = setup();
    await controller.identity();
    fetch.mockImplementationOnce(async () =>
      Response.json({
        items: [
          {
            ...item,
            kind: 'svc',
            projectId: 'project-id',
            servicePrincipalId: 'visible-principal',
          },
        ],
        next: null,
        lifetime,
      }),
    );
    await controller.load('project', 'demo');
    fetch.mockImplementationOnce(async () =>
      Response.json({ error: { code: 'forbidden' } }, { status: 403 }),
    );
    await controller.loadPrincipals();
    expect(usablePrincipals(controller.snapshot(), 'project-id')).toEqual([]);
    expect(controller.snapshot().principalsRestricted).toBe(true);
    expect(markup(controller)).not.toContain('value="visible-principal"');
  });

  it.each(['project', 'organization'] as const)(
    'loads the restored %s scope before allowing replay',
    async (target) => {
      const f = setup(403, 'reauth_required');
      await f.controller.load(target, target === 'project' ? 'demo' : null);
      await f.controller.issue({ ...draft, lifetimeDays: 180 });
      const next = createTokensController(f.services, f.deps);
      let finish!: (response: Response) => void;
      f.fetch.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      const starting = next.start('personal', null);
      expect(next.snapshot().target).toBe(target);
      expect(next.snapshot().loading).toBe(true);
      expect(
        control(
          next,
          (props) =>
            props.children === 'Confirm token issue' && typeof props.onClick === 'function',
        ).disabled,
      ).toBe(true);
      const calls = f.fetch.mock.calls.length;
      await next.confirm();
      expect(f.fetch).toHaveBeenCalledTimes(calls);
      finish(Response.json({ items: [], next: null, lifetime }));
      await starting;
      expect(f.fetch.mock.calls.at(-1)![0]).toBe(
        target === 'project' ? '/_pb/projects/demo/tokens' : '/_pb/tokens',
      );
      expect(next.snapshot().lifetime?.service.maxDays).toBe(365);
      f.fetch.mockImplementationOnce(async () =>
        Response.json({ id, token: sentinel }, { status: 201 }),
      );
      await next.confirm();
      expect(f.fetch.mock.calls.at(-1)![0]).toBe(
        target === 'project' ? '/_pb/projects/demo/tokens' : '/_pb/tokens',
      );
      expect(f.fetch.mock.calls.at(-1)![1].headers).toMatchObject({ 'Idempotency-Key': 'new-key' });
      expect(JSON.parse(String(f.fetch.mock.calls.at(-1)![1].body)).lifetimeDays).toBe(180);
      expect(next.snapshot().secret).toBe(sentinel);
    },
  );

  it.each(['pat', 'svc'] as const)(
    'makes the scope editable only for personal renewal (%s)',
    async (kind) => {
      const { controller } = setup();
      await controller.identity();
      await controller.load(kind === 'pat' ? 'personal' : 'project', 'demo');
      controller.renew({
        ...controller.snapshot().items[0]!,
        kind,
        scope: 'write',
        servicePrincipalId: id,
      });
      const scope = control(controller, (props) => props.id === 'token-scope');
      expect(scope.disabled === true).toBe(kind === 'svc');
      expect(scope.defaultValue).toBe('write');
    },
  );

  it('preserves identity initialization when the token list changes', async () => {
    const { controller, fetch } = setup();
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const initializing = controller.identity();
    selectList(controller, 'organization');
    finish(Response.json({ user: { id: 'me' } }));
    await initializing;
    expect(controller.snapshot().userId).toBe('me');
    expect(controller.snapshot().projectSlugs).toEqual({ 'project-id': 'demo' });
    expect(controller.snapshot().target).toBe('organization');
  });

  it('preserves principal discovery when the token list changes', async () => {
    const { controller, fetch } = setup();
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const initializing = controller.loadPrincipals();
    selectList(controller, 'organization');
    finish(
      Response.json({
        items: [{ id, name: 'build', status: 'active', projectId: null }],
        next: null,
      }),
    );
    await initializing;
    expect(controller.snapshot().principals.map((principal) => principal.id)).toEqual([id]);
    expect(controller.snapshot().target).toBe('organization');
  });
});

describe('token list presentation', () => {
  it('filters the loaded page by name, scope and status together', async () => {
    const { controller } = setup();
    await controller.load();
    const items = controller.snapshot().items;
    expect(filterTokens(items, { q: 'AUTO', scope: 'read', status: 'active' })).toEqual(items);
    expect(filterTokens(items, { q: '', scope: 'write', status: 'active' })).toEqual([]);
    expect(filterTokens(items, { q: '', scope: '', status: 'revoked' })).toEqual([]);
  });
  it('shows token names, status, copyable selectors and exact time without secrets', async () => {
    const { controller } = setup();
    await controller.load();
    const html = markup(controller);
    expect(html).toContain('responsive-table');
    expect(html).toContain('data-label="Token"');
    expect(html).toContain('automation');
    expect(html).toContain('>Active<');
    expect(html).toContain('aria-label="Copy token ID"');
    expect(html).toContain('dateTime="2026-11-01"');
    expect(html).toContain('Never');
    expect(html).not.toContain(sentinel);
    expect(html).not.toContain('<dialog');
  });
  it('shows failed token loading as an error and recovers on reload', async () => {
    const { controller, fetch } = setup();
    fetch.mockResolvedValueOnce(
      Response.json({ error: { code: 'forbidden', message: sentinel } }, { status: 403 }),
    );
    await controller.load();
    const html = renderToString(
      createElement(TokenList, { state: controller.snapshot(), controller }),
    );
    expect(html).toContain('data-list-state="error"');
    expect(html).not.toContain('data-list-state="empty"');
    expect(html).not.toContain(sentinel);
    await controller.load();
    expect(controller.snapshot().listError).toBe(false);
    expect(markup(controller)).toContain('automation');
  });
});

describe('one-time client configuration', () => {
  it('renders and copies the project registry configuration, including the port', async () => {
    const f = setup();
    await f.controller.load('project', 'demo');
    expect(markup(f.controller)).not.toContain('Copy Composer configuration');
    await f.controller.issue(draft);
    const composer = tokenClientConfig('https://broker.example:8443', 'demo', sentinel).composer;
    const npm = `registry=https://broker.example:8443/demo/npm/\n//broker.example:8443/demo/npm/:_authToken=${sentinel}`;
    expect(f.controller.clientConfig()?.composer).toBe(composer);
    expect(markup(f.controller)).toContain('Composer repository command');
    expect(markup(f.controller)).toContain(npm);
    expect(markup(f.controller)).toContain('Copy Composer configuration');
    expect(markup(f.controller)).toContain('Copy npm configuration');
    for (const label of ['Copy Composer configuration', 'Copy npm configuration']) {
      const button = control(f.controller, (props) => props.children === label);
      (button.onClick as () => void)();
      await vi.waitFor(() =>
        expect(f.clipboard).toHaveBeenLastCalledWith(label.includes('Composer') ? composer : npm),
      );
    }
    expect(f.clipboard).toHaveBeenLastCalledWith(npm);
    expect(f.controller.snapshot().secret).toBe(sentinel);
    expect([...f.session.values.values(), ...f.local.values.values()].join()).not.toContain(
      sentinel,
    );
    f.controller.closeSecret();
    expect(f.controller.clientConfig()).toBeNull();
    expect(markup(f.controller)).not.toContain(sentinel);
    expect(markup(f.controller)).not.toContain('Copy npm configuration');
    await f.controller.copy('npm');
    expect(f.clipboard).toHaveBeenCalledTimes(2);
  });

  it.each(['personal', 'organization'] as const)(
    'shows a project hint for %s tokens',
    async (target) => {
      const f = setup();
      await f.controller.load(target, 'demo');
      await f.controller.issue(draft);
      expect(markup(f.controller)).toContain('Choose a project this token can access');
      expect(f.controller.clientConfig()).toBeNull();
      expect(markup(f.controller)).not.toContain('Copy Composer configuration');
      expect(markup(f.controller)).not.toContain('_authToken=');
      await f.controller.copy('npm');
      expect(f.clipboard).not.toHaveBeenCalled();
    },
  );

  it('uses the renewed token’s project when rotating from the organization list', async () => {
    const f = setup();
    await f.controller.identity();
    await f.controller.load('organization', null);
    f.controller.renew({
      ...f.controller.snapshot().items[0]!,
      kind: 'svc',
      projectId: 'project-id',
    });
    await f.controller.issue(draft);
    expect(f.controller.clientConfig()?.npm).toContain('/demo/npm/');
    expect(markup(f.controller)).not.toContain('Choose a project this token can access');
    f.controller.navigate();
    expect(f.controller.clientConfig()).toBeNull();
    expect(markup(f.controller)).not.toContain(sentinel);
  });

  it('keeps copy failures generic and does not expose clipboard errors', async () => {
    const f = setup();
    await f.controller.load('project', 'demo');
    await f.controller.issue(draft);
    f.clipboard.mockRejectedValueOnce(new Error(sentinel));
    await f.controller.copy('npm');
    expect(f.controller.snapshot().notice).toBe(
      'Could not copy. Select and copy the configuration manually.',
    );
    expect(f.controller.snapshot().secret).toBe(sentinel);
  });

  it('ignores a late configuration copy result after navigation', async () => {
    const f = setup();
    await f.controller.load('project', 'demo');
    await f.controller.issue(draft);
    let finish!: () => void;
    f.clipboard.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const copying = f.controller.copy('composer');
    f.controller.navigate();
    finish();
    await copying;
    expect(f.controller.snapshot().notice).toBeNull();
    expect(markup(f.controller)).not.toContain(sentinel);
  });
});

describe('guided token issuance policy and setup', () => {
  const project = {
    id: 'project-id',
    slug: 'demo',
    name: 'Storefront',
    cap: 'full' as const,
    permissions: ['project:read', 'project:packages:read', 'project:tokens:create'],
  };
  it('renders the personal path without any identity control or explanation', async () => {
    const { controller } = setup();
    await controller.load();
    const html = renderToString(
      createElement(IssueTokenForm, {
        state: controller.snapshot(),
        controller,
        initialAudience: 'personal',
        defaultOpen: true,
      }),
    );
    expect(html).toContain('Which projects?');
    expect(html).toContain('Choose up to 200 projects.');
    expect(html).toContain('value="45" selected=""');
    expect(html).not.toContain('Service identity');
    expect(html).not.toContain('service principal');
    expect(html).not.toContain('issue-principal');
  });
  it('enforces the selected-project limit', () => {
    expect(selectionError([])).toContain('1 and 200');
    expect(selectionError(Array.from({ length: 200 }, (_, i) => String(i)))).toBeNull();
    expect(selectionError(Array.from({ length: 201 }, (_, i) => String(i)))).toContain('1 and 200');
  });
  it('checks caps, personal publish prerequisites and service authority with reasons', () => {
    expect(scopeReason('read', [project], true)).toBeNull();
    expect(scopeReason('write', [{ ...project, cap: 'read' }], true)).toContain('not available');
    expect(scopeReason('full', [project], true)).toContain(
      'requires package publishing permission',
    );
    expect(scopeReason('read', [{ ...project, cap: null }], true)).toContain('could not be loaded');
    expect(scopeReason('read', [project], false, ['project:packages:read'])).toBeNull();
    expect(
      scopeReason('read', [{ ...project, permissions: [] }], false, ['project:packages:read']),
    ).toContain('permission to create');
    expect(scopeReason('write', [project], false, ['project:packages:read'])).toContain(
      'service identity needs',
    );
    expect(scopeReason('full', [project], false, ['project:audit:read'])).toContain(
      'cannot confer',
    );
  });
  it.each([
    { maxDays: 1, defaultDays: 1 },
    { maxDays: 3650, defaultDays: 900 },
  ])('bounds lifetime presets to %j', (policy) => {
    expect(lifetimeChoices(policy)).toContain(policy.defaultDays);
    expect(lifetimeChoices(policy)).toContain(policy.maxDays);
    expect(
      lifetimeChoices(policy).every((n) => Number.isInteger(n) && n >= 1 && n <= policy.maxDays),
    ).toBe(true);
  });
  it('generates valid multiline JSON and INI and secret-free CI commands', () => {
    const config = tokenClientConfig('https://broker.example:8443', "strange'project", sentinel);
    expect(JSON.parse(config.composerAuth)).toEqual({
      bearer: { 'broker.example:8443': sentinel },
    });
    expect(config.composerAuth.split('\n').length).toBeGreaterThan(2);
    expect(config.npm.split('\n')).toEqual([
      "registry=https://broker.example:8443/strange'project/npm/",
      `//broker.example:8443/strange'project/npm/:_authToken=${sentinel}`,
    ]);
    const ini = Object.fromEntries(
      config.npm.split('\n').map((line) => {
        const separator = line.indexOf('=');
        expect(separator).toBeGreaterThan(0);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
    );
    expect(ini.registry).toBe("https://broker.example:8443/strange'project/npm/");
    expect(ini["//broker.example:8443/strange'project/npm/:_authToken"]).toBe(sentinel);
    expect(config.composer).not.toContain(sentinel);
    expect(config.ciComposer + config.ciNpm).not.toContain(sentinel);
    expect(config.ciComposer).toContain('$PACKAGE_BROKER_TOKEN');
    expect(config.ciNpm).toContain('${PACKAGE_BROKER_TOKEN}');
    expect(config.composer).toContain("'\\''");
  });
  it('keeps a personal result through metadata refresh and clears it on Done', async () => {
    const f = setup();
    await f.controller.identity();
    await f.controller.load('organization', null);
    await f.controller.issueFor('personal', null, {
      ...draft,
      projectMode: 'selected',
      projectIds: ['project-id'],
    });
    const write = f.fetch.mock.calls.find(([, init]) => init.method === 'POST')!;
    expect(write[0]).toBe('/_pb/me/tokens');
    expect(JSON.parse(String(write[1].body))).toMatchObject({
      projectIds: ['project-id'],
      projectMode: 'selected',
    });
    expect(JSON.parse(String(write[1].body))).not.toHaveProperty('servicePrincipalId');
    expect(f.controller.clientConfig()?.npm).toContain('/demo/npm/');
    await f.controller.load('personal', null);
    expect(f.controller.snapshot().secret).toBe(sentinel);
    expect([...f.session.values.values(), ...f.local.values.values()].join()).not.toContain(
      sentinel,
    );
    f.controller.closeSecret();
    expect(f.controller.snapshot().secret).toBeNull();
    expect(f.controller.snapshot().result).toBeNull();
    expect(f.controller.clientConfig()).toBeNull();
  });
  it('loads project names before fetching only selected policies', async () => {
    const f = setup();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (url === '/_pb/projects' || url === '/_pb/projects?after=next-page') {
        const next = url.includes('?');
        return Response.json({
          items: [
            {
              id: next ? 'second-id' : 'first-id',
              slug: next ? 'second' : 'first',
              name: next ? 'Second project' : 'First project',
              status: 'active',
            },
          ],
          next: next ? null : 'next-page',
        });
      }
      if (url.endsWith('/permissions') && url.includes('/projects/'))
        return Response.json({ project: ['project:packages:read'] });
      if (url === '/_pb/projects/first' || url === '/_pb/projects/second')
        return Response.json({ tokenMaxScope: 'read' });
      return original(url, init);
    });
    await f.controller.identity();
    expect(f.controller.snapshot().projects.map((p) => p.name)).toEqual([
      'First project',
      'Second project',
    ]);
    expect(f.fetch.mock.calls.some(([url]) => url === '/_pb/projects/first')).toBe(false);
    f.controller.loadProjectPolicies(['first-id']);
    await vi.waitFor(() => expect(f.controller.snapshot().projects[0]?.policyState).toBe('loaded'));
    expect(f.fetch.mock.calls.some(([url]) => url === '/_pb/projects/second')).toBe(false);
    f.controller.loadProjectPolicies(['second-id']);
    await vi.waitFor(() => expect(f.controller.snapshot().projects[1]?.policyState).toBe('loaded'));
    expect(f.controller.snapshot().projects).toEqual([
      {
        id: 'first-id',
        slug: 'first',
        name: 'First project',
        cap: 'read',
        policyState: 'loaded',
        permissions: ['project:packages:read'],
      },
      {
        id: 'second-id',
        slug: 'second',
        name: 'Second project',
        cap: 'read',
        policyState: 'loaded',
        permissions: ['project:packages:read'],
      },
    ]);
    expect(f.controller.snapshot().projectsError).toBe(false);
    expect(scopeReason('write', f.controller.snapshot().projects, true)).toContain('not available');
  });
  it('includes named identities from every discovery page', async () => {
    const f = setup();
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (url === '/_pb/service-principals')
        return Response.json({ items: [], next: 'second-page' });
      if (url === '/_pb/service-principals?after=second-page')
        return Response.json({
          items: [
            {
              id: 'second-principal',
              name: 'Later build',
              projectId: 'project-id',
              status: 'active',
              permissions: ['project:packages:read'],
            },
          ],
          next: null,
        });
      return original(url, init);
    });
    await f.controller.loadPrincipals();
    expect(
      usablePrincipals(f.controller.snapshot(), 'project-id').map((p) => [p.id, p.name]),
    ).toEqual([['second-principal', 'Later build']]);
    expect(usablePrincipals(f.controller.snapshot(), undefined)).toEqual([]);
  });
  it('refreshes metadata after confirming guided issuance following reauthentication', async () => {
    const f = setup(403, 'reauth_required');
    await f.controller.issueFor('personal', null, draft);
    const next = createTokensController(f.services, f.deps);
    next.restore();
    f.fetch.mockImplementation(async (_url, init) =>
      init.method === 'GET'
        ? Response.json({ items: [], next: null, lifetime })
        : Response.json({ id, token: sentinel }, { status: 201 }),
    );
    await next.confirm();
    expect(f.fetch.mock.calls.at(-1)![1].method).toBe('GET');
    expect(next.snapshot().secret).toBe(sentinel);
    expect(next.snapshot().items).toEqual([]);
    expect([...f.session.values.values()].join()).not.toContain(sentinel);
  });
  it('does not configure a personal token for a project outside its selection', async () => {
    const f = setup();
    await f.controller.identity();
    await f.controller.issueFor('personal', null, {
      ...draft,
      projectMode: 'selected',
      projectIds: ['other-id'],
    });
    f.controller.configureProject('demo');
    expect(f.controller.clientConfig()).toBeNull();
  });
  it('issues a named project service token independently of the list target', async () => {
    const f = setup();
    await f.controller.load('personal', null);
    await f.controller.issueFor('project', 'storefront', draft);
    const write = f.fetch.mock.calls.find(([, init]) => init.method === 'POST')!;
    expect(write[0]).toBe('/_pb/projects/storefront/tokens');
    expect(JSON.parse(String(write[1].body)).servicePrincipalId).toBe(id);
    expect(f.controller.snapshot().target).toBe('personal');
  });
});

describe('token review regressions', () => {
  it('keeps the issuance draft and visible result while changing list target, and clears renewal', async () => {
    const f = setup();
    await f.controller.load();
    f.controller.renew(f.controller.snapshot().items[0]!);
    await f.controller.issueFor('personal', null, draft);
    const before = f.controller.snapshot();
    await f.controller.selectTarget('organization', null);
    expect(f.controller.snapshot()).toMatchObject({
      pending: null,
      renewal: null,
      secret: sentinel,
      result: before.result,
      issuanceDraft: before.issuanceDraft,
    });
  });

  it.each(['confirm', 'decline'] as const)(
    'restores a guided draft after %s without changing the list target',
    async (action) => {
      const f = setup(403, 'reauth_required');
      await f.controller.load('organization', null);
      await f.controller.issueFor('personal', null, { ...draft, name: 'Laptop draft' });
      const next = createTokensController(f.services, f.deps);
      await next.start('personal', null);
      expect(next.snapshot().target).toBe('organization');
      expect(next.snapshot().issuanceDraft?.draft.name).toBe('Laptop draft');
      expect(
        renderToString(createElement(IssueTokenForm, { state: next.snapshot(), controller: next })),
      ).toContain('value="Laptop draft"');
      if (action === 'confirm') {
        const original = f.fetch.getMockImplementation()!;
        f.fetch.mockImplementation(async (url, init) =>
          init.method === 'POST'
            ? Response.json({ id, token: sentinel }, { status: 201 })
            : original(url, init),
        );
        await next.confirm();
        expect(next.snapshot().secret).toBe(sentinel);
      } else next.decline();
      expect(next.snapshot().pending).toBeNull();
      expect(next.snapshot().target).toBe('organization');
      expect(next.snapshot().issuanceDraft?.draft.name).toBe('Laptop draft');
    },
  );

  it('clears an unrelated pending confirmation on list selection', async () => {
    const f = setup(403, 'reauth_required');
    await f.controller.issueFor('personal', null, draft);
    f.controller.restore();
    const before = f.controller.snapshot().issuanceDraft;
    expect(f.controller.snapshot().pending).not.toBeNull();
    await f.controller.selectTarget('organization', null);
    expect(f.controller.snapshot().pending).toBeNull();
    expect(f.controller.snapshot().issuanceDraft).toEqual(before);
    const calls = f.fetch.mock.calls.length;
    await f.controller.confirm();
    expect(f.fetch).toHaveBeenCalledTimes(calls);
  });

  it('loads only requested projects, limits policy concurrency to four, and retries failures', async () => {
    const f = setup();
    const original = f.fetch.getMockImplementation()!;
    let active = 0;
    let peak = 0;
    let failed = true;
    f.fetch.mockImplementation(async (url, init) => {
      if (url === '/_pb/projects')
        return Response.json({
          items: Array.from({ length: 12 }, (_, i) => ({
            id: `id-${i}`,
            slug: `project-${i}`,
            name: `Project ${i}`,
            status: 'active',
          })),
          next: null,
        });
      if (url.startsWith('/_pb/projects/project-')) {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (failed && url.includes('project-0')) return new Response(null, { status: 403 });
        return Response.json(
          url.endsWith('/permissions')
            ? { project: ['project:packages:read'] }
            : { tokenMaxScope: 'read' },
        );
      }
      return original(url, init);
    });
    await f.controller.identity();
    expect(peak).toBe(0);
    f.controller.loadProjectPolicies(Array.from({ length: 10 }, (_, i) => `id-${i}`));
    await vi.waitFor(() =>
      expect(
        f.controller.snapshot().projects.filter((p) => p.policyState === 'loading'),
      ).toHaveLength(0),
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
    expect(f.controller.snapshot().projects[10]?.policyState).toBe('idle');
    expect(f.controller.snapshot().projects[0]?.policyState).toBe('error');
    failed = false;
    f.controller.loadProjectPolicies(['id-0'], true);
    await vi.waitFor(() => expect(f.controller.snapshot().projects[0]?.policyState).toBe('loaded'));
  });
});

it('keeps the UI permission picker aligned with the core token-eligible metadata', () => {
  const source = readFileSync(
    new URL('../../../core/src/authz/permissions.ts', import.meta.url),
    'utf8',
  );
  const eligible = [...source.matchAll(/permission\('([^']+)', '[^']+', false\)/g)].map(
    (match) => match[1],
  );
  expect([...tokenEligiblePermissions].sort()).toEqual(eligible.sort());
});

it.each(['ci', 'personal'] as const)(
  'uses API lifetime presets in the main %s issuance form',
  async (initialAudience) => {
    const { controller } = setup();
    await controller.load();
    const state = controller.snapshot();
    const html = renderToString(
      createElement(IssueTokenForm, { state, controller, initialAudience, defaultOpen: true }),
    );
    const policy = lifetime[initialAudience === 'personal' ? 'personal' : 'service'];
    for (const days of lifetimeChoices(policy)) expect(html).toContain(`value="${days}"`);
    expect(html).toContain(`value="${policy.defaultDays}" selected=""`);
    expect(html).toContain(`Maximum: ${policy.maxDays} days`);
    expect(html).not.toContain('value="3650"');
  },
);

it('filters the main service identity picker by the chosen named project and active status', async () => {
  const { controller } = setup();
  await controller.load();
  await controller.loadPrincipals();
  const state = controller.snapshot();
  const base = state.principals[0]!;
  const html = renderToString(
    createElement(IssueTokenForm, {
      state: {
        ...state,
        issuanceProject: 'storefront',
        projects: [
          {
            id: 'storefront-id',
            slug: 'storefront',
            name: 'Storefront',
            cap: 'full',
            permissions: ['project:read', 'project:packages:read', 'project:tokens:create'],
          },
        ],
        principals: [
          {
            ...base,
            id: 'local',
            name: 'Local identity',
            projectId: 'storefront-id',
            status: 'active',
            permissions: ['project:read', 'project:packages:read'],
          },
          {
            ...base,
            id: 'foreign',
            name: 'Foreign identity',
            projectId: 'other-id',
            status: 'active',
          },
          {
            ...base,
            id: 'organization',
            name: 'Organization identity',
            projectId: null,
            status: 'active',
          },
          {
            ...base,
            id: 'suspended',
            name: 'Suspended identity',
            projectId: 'storefront-id',
            status: 'suspended',
          },
        ],
      },
      controller,
      defaultOpen: true,
    }),
  );
  expect(html).toContain('value="local"');
  expect(html).not.toContain('value="foreign"');
  expect(html).not.toContain('value="organization"');
  expect(html).not.toContain('value="suspended"');
});

describe('round 5 regressions', () => {
  function projectFetch(f: ReturnType<typeof setup>, hold?: Promise<void>) {
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (url === '/_pb/projects')
        return Response.json({
          items: [
            { id: 'a-id', slug: 'a', name: 'Alpha', status: 'active' },
            { id: 'b-id', slug: 'b', name: 'Beta', status: 'active' },
          ],
          next: null,
        });
      if (/^\/_pb\/projects\/[ab]\/permissions$/.test(url)) {
        await hold;
        return Response.json({ project: ['project:read', 'project:packages:read'] });
      }
      if (/^\/_pb\/projects\/[ab]$/.test(url)) {
        await hold;
        return Response.json({ tokenMaxScope: 'full' });
      }
      return original(url, init);
    });
  }

  it('treats an organization-wide result like all projects when configuring a client', async () => {
    const f = setup();
    projectFetch(f);
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) =>
      url === '/_pb/service-principals'
        ? Response.json({
            items: [
              {
                id,
                name: 'robot',
                status: 'active',
                projectId: null,
                permissions: ['project:read', 'project:packages:read'],
              },
            ],
            next: null,
          })
        : original(url, init),
    );
    await f.controller.identity();
    await f.controller.loadPrincipals();
    f.controller.loadProjectPolicies(['a-id', 'b-id']);
    await vi.waitFor(() =>
      expect(f.controller.snapshot().projects.every((p) => p.policyState === 'loaded')).toBe(true),
    );
    await f.controller.issueFor('organization', null, {
      ...draft,
      projectMode: 'selected',
      projectIds: [],
      servicePrincipalId: id,
    });
    const html = markup(f.controller);
    expect(html).toContain('Organization-wide');
    expect(html).toContain('<option value="a">Alpha</option>');
    expect(html).toContain('<option value="b">Beta</option>');
    f.controller.configureProject('b');
    expect(f.controller.snapshot().secretProject).toBe('b');
  });

  it('does not leave project policies loading after a navigation mid-request', async () => {
    const f = setup();
    let release!: () => void;
    projectFetch(f, new Promise((resolve) => (release = resolve)));
    await f.controller.identity();
    f.controller.loadProjectPolicies(['a-id', 'b-id']);
    expect(f.controller.snapshot().projects.map((p) => p.policyState)).toEqual([
      'loading',
      'loading',
    ]);
    f.controller.navigate();
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.controller.snapshot().projects.map((p) => p.policyState)).toEqual(['idle', 'idle']);
    f.controller.loadProjectPolicies(['a-id']);
    await vi.waitFor(() => expect(f.controller.snapshot().projects[0]?.policyState).toBe('loaded'));
  });

  it('does not leave principals loading after a navigation mid-request', async () => {
    const f = setup();
    let release!: () => void;
    const hold = new Promise<void>((resolve) => (release = resolve));
    const original = f.fetch.getMockImplementation()!;
    f.fetch.mockImplementation(async (url, init) => {
      if (url.startsWith('/_pb/service-principals')) await hold;
      return original(url, init);
    });
    const loading = f.controller.loadPrincipals();
    expect(f.controller.snapshot().principalsLoading).toBe(true);
    f.controller.navigate();
    expect(f.controller.snapshot().principalsLoading).toBe(false);
    release();
    await loading;
    expect(f.controller.snapshot().principalsLoading).toBe(false);
    expect(f.controller.snapshot().principals).toEqual([]);
    await f.controller.loadPrincipals();
    expect(f.controller.snapshot().principals).toHaveLength(1);
  });

  it('restarts loads from a restored page after a persisted pageshow', () => {
    const f = setup();
    const handlers = new Map<string, (event: Event) => void>();
    const reload = vi.fn();
    bindTokensLifecycle(
      f.controller,
      {
        addEventListener: (name: string, handler: EventListenerOrEventListenerObject) =>
          handlers.set(name, handler as (event: Event) => void),
        removeEventListener: vi.fn(),
      },
      reload,
    );
    handlers.get('pageshow')!(new Event('pageshow'));
    expect(reload).not.toHaveBeenCalled();
    handlers.get('pageshow')!(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(reload).toHaveBeenCalledOnce();
  });

  it('marks requested projects loading in a single state update', async () => {
    const f = setup();
    projectFetch(f);
    await f.controller.identity();
    const seen = vi.fn();
    f.controller.subscribe(seen);
    f.controller.loadProjectPolicies(['a-id', 'b-id']);
    expect(seen).toHaveBeenCalledOnce();
  });

  it('mirrors server conferral for organization principals at every access level', async () => {
    const { organizationScopeReason } = await import('./tokens/issue-token-form.js');
    const live = ['project:read', 'project:packages:read', 'org:read', 'org:audit:read'];
    expect(organizationScopeReason('read', undefined, live)).toBe(
      'Choose a service identity first.',
    );
    expect(organizationScopeReason('read', [], live)).toContain('no permissions');
    expect(organizationScopeReason('read', ['project:read', 'project:packages:read'], live)).toBe(
      null,
    );
    expect(
      organizationScopeReason('write', ['project:read', 'project:packages:read'], live),
    ).toContain('required package permission');
    expect(organizationScopeReason('read', ['org:read'], live)).toContain('required package');
    expect(organizationScopeReason('full', ['org:read'], live)).toBe(null);
    expect(organizationScopeReason('full', ['org:read', 'org:users:read'], live)).toContain(
      'cannot confer',
    );
    expect(organizationScopeReason('full', ['org:unknown'], live)).toContain('no token-eligible');
    expect(organizationScopeReason('full', ['org:read', 'org:unknown'], ['org:read'])).toBe(null);
  });

  it('shows singular day labels in lifetime options and the summary', () => {
    const f = setup();
    const state = {
      ...f.controller.snapshot(),
      lifetime: { personal: { maxDays: 30, defaultDays: 1 }, service: lifetime.service },
    };
    const html = renderToString(
      createElement(IssueTokenForm, {
        state,
        controller: f.controller,
        initialAudience: 'personal',
        defaultOpen: true,
      }),
    );
    const text = html.replaceAll('<!-- -->', '');
    expect(text).toContain('>1 day (organization default)<');
    expect(text).toContain('Install and download · 1 day');
    expect(text).not.toContain('1 days');
  });

  it('keeps the draft through reauthentication and clears it when Done is pressed', async () => {
    const f = setup();
    await f.controller.issueFor('personal', null, draft);
    expect(f.controller.snapshot().issuanceDraft).not.toBeNull();
    f.controller.closeSecret();
    expect(f.controller.snapshot().issuanceDraft).toBeNull();
  });

  it('re-announces a repeated principal choice with a new nonce and keeps unknown projects distinct', () => {
    const f = setup();
    f.controller.choosePrincipal('p1', 'demo');
    const first = f.controller.snapshot();
    f.controller.choosePrincipal('p1', 'demo');
    expect(f.controller.snapshot().issuanceNonce).toBe(first.issuanceNonce + 1);
    f.controller.choosePrincipal('p2', null, false);
    expect(f.controller.snapshot().issuanceProject).toBe('');
    f.controller.choosePrincipal('p3', null, true);
    expect(f.controller.snapshot().issuanceProject).toBe('__organization');
  });
});
