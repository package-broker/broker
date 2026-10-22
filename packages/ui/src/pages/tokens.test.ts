import { Children, createElement, isValidElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import {
  TokensView,
  bindTokensLifecycle,
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

describe('tokens show once', () => {
  it('clears the secret from state and second render on navigate', async () => {
    const { controller } = setup();
    await controller.issue(draft);
    expect(markup(controller)).toContain(sentinel);
    expect(markup(controller)).toContain('shown once');
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
    expect(controller.snapshot().notice).toBe('Unable to copy token.');
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
      const picker = control(controller, (props) => props.id === 'token-principal');
      const html = renderToString(createElement('select', {}, picker.children as ReactNode));
      expect(html).toContain(`value="${target === 'project' ? 'local' : 'org'}-principal"`);
      expect(html).not.toContain(`value="${target === 'project' ? 'org' : 'local'}-principal"`);
      expect(html).not.toContain('value="foreign-principal"');
      expect(html).not.toContain('value="suspended-principal"');
    },
  );

  it('uses visible token principals when organization principal discovery is forbidden', async () => {
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
    const picker = control(controller, (props) => props.id === 'token-principal');
    expect(renderToString(createElement('select', {}, picker.children as ReactNode))).toContain(
      'value="visible-principal"',
    );
    expect(controller.snapshot().notice).toBeNull();
    await controller.issue({ ...draft, servicePrincipalId: 'visible-principal' });
    expect(fetch.mock.calls.at(-1)![0]).toBe('/_pb/projects/demo/tokens');
    expect(controller.snapshot().secret).toBe(sentinel);
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
