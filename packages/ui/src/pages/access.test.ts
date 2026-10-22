import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import { createReauthFlow } from '../auth.js';
import { AccessView, buildAccessHash, createAccessController, parseAccessHash } from './access.js';

const role = {
  id: 'r_1',
  key: 'reader',
  name: 'Reader',
  scope: 'organization',
  permissions: ['org:read'],
  revision: 3,
  isSystem: false,
  protectsLastHolder: false,
};
const grant = {
  id: 'g_1',
  roleId: role.id,
  subject: { type: 'email', value: 'private-account@example.test' },
  revision: 4,
  createdAt: '2026-10-22',
};
const member = {
  id: 'g_1',
  principal: {
    id: 'u_1',
    kind: 'user',
    displayName: 'A user',
    email: 'private-account@example.test',
  },
  role: { id: role.id, name: role.name, permissions: [] },
  revision: 9,
  createdAt: grant.createdAt,
};
function fixture(
  options: {
    status?: number;
    code?: string;
    permissions?: boolean;
    system?: boolean;
    displayName?: string | null;
  } = {},
) {
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method !== 'GET')
      return options.status
        ? Response.json(
            {
              error: {
                code: options.code ?? 'invalid_request',
                message: 'private-message',
                details: [{ path: 'private-details', code: 'invalid' }],
              },
            },
            { status: options.status },
          )
        : new Response(null, { status: 204 });
    if (url === '/_pb/me/permissions')
      return Response.json({
        organization:
          options.permissions === false
            ? []
            : ['org:roles:read', 'org:roles:write', 'org:grants:read', 'org:grants:write'],
      });
    if (url.endsWith('/permissions'))
      return Response.json({
        project:
          options.permissions === false ? [] : ['project:grants:read', 'project:grants:write'],
      });
    if (url.startsWith('/_pb/roles'))
      return Response.json({ items: [{ ...role, isSystem: options.system ?? false }], next: null });
    if (url.startsWith('/_pb/projects/'))
      return Response.json({
        items: [
          {
            ...member,
            principal: {
              ...member.principal,
              displayName:
                options.displayName === undefined
                  ? member.principal.displayName
                  : options.displayName,
            },
          },
        ],
        next: null,
      });
    return Response.json({ items: [grant], next: null });
  });
  const requireReauth = vi.fn();
  const client = createApiClient<paths>({ fetch, readCookie: () => undefined });
  const controller = createAccessController({
    client,
    requireReauth,
  });
  return { controller, fetch, requireReauth, client };
}
const markup = (controller: ReturnType<typeof createAccessController>) =>
  renderToString(createElement(AccessView, { state: controller.snapshot(), controller }));

describe('access', () => {
  it('round trips scope, view, prefix and cursor in the hash', () => {
    const query = parseAccessHash('#/access?project=web&status=grants&q=ab&after=p_9');
    expect(parseAccessHash(buildAccessHash(query))).toEqual(query);
    expect(buildAccessHash(query)).toBe('#/access?project=web&status=grants&q=ab&after=p_9');
  });
  it('drops malformed view keys', () => {
    expect(buildAccessHash(parseAccessHash('#/access?status=<script>&other=bad'))).toBe('#/access');
  });
  it('lists project principals using grants, without retaining email fields', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: 'web' });
    expect(fetch.mock.calls.some(([url]) => url.startsWith('/_pb/projects/web/grants'))).toBe(true);
    expect(markup(controller)).toContain('u_1');
    expect(JSON.stringify(controller.snapshot())).not.toContain('private-account');
  });
  it('displays principal names and IDs while mutations use grant IDs', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: 'web' });
    expect(markup(controller)).toContain('A user');
    expect(markup(controller)).toContain('u_1');
    await controller.changeGrant('g_1', 'r_2');
    await controller.revoke('g_1');
    const writes = fetch.mock.calls.filter(([, init]) => init.method !== 'GET');
    expect(writes).toHaveLength(2);
    expect(writes.map(([url]) => url)).toEqual([
      '/_pb/projects/web/grants/g_1',
      '/_pb/projects/web/grants/g_1',
    ]);
    expect(writes[0]![1].body).toBe(JSON.stringify({ roleId: 'r_2' }));
    expect(JSON.stringify(writes)).not.toContain('A user');
  });
  it('filters project principals by display name', async () => {
    const { controller } = fixture();
    await controller.load({ project: 'web', q: 'a u' });
    expect(markup(controller)).toContain('A user');
  });
  it('falls back to the principal ID when its display name is missing', async () => {
    const { controller } = fixture({ displayName: null });
    await controller.load({ project: 'web' });
    expect(markup(controller)).toContain('u_1');
    expect(markup(controller)).not.toContain('private-account');
  });
  it.each([
    ['last_holder', 'The last holder of this role cannot be removed.'],
    ['forbidden', 'You do not have permission for this action.'],
    ['private-unknown-code', 'The request could not be completed.'],
  ])('preserves the closed %s error through reauth replay', async (code, message) => {
    const { controller, client, fetch } = fixture({ status: 409, code });
    await controller.load({ project: 'web' });
    const stored = new Map<string, string>();
    const flow = createReauthFlow({
      client,
      now: Date.now,
      navigate: vi.fn(),
      storage: {
        getItem: (key) => stored.get(key) ?? null,
        setItem: (key, value) => void stored.set(key, value),
        removeItem: (key) => void stored.delete(key),
      },
    });
    const listener = vi.fn((result) => void controller.replayed(result));
    flow.subscribeReplay(listener);
    flow.requireReauth(
      { method: 'DELETE', path: '/_pb/projects/web/grants/g_1', headers: { 'If-Match': '"r9"' } },
      { credential: false, secretFields: [] },
      '#/access?project=web',
    );
    flow.restore();
    await flow.confirm();
    await flow.confirm();
    await controller.revoke('g_1');
    expect(listener).toHaveBeenCalledExactlyOnceWith({
      path: '/_pb/projects/web/grants/g_1',
      ok: false,
      status: 409,
      code: code === 'private-unknown-code' ? 'unknown_error' : code,
    });
    expect(markup(controller)).toContain(message);
    expect(markup(controller)).not.toContain('private-');
    expect(JSON.stringify(listener.mock.calls)).not.toContain('private-');
    expect(controller.snapshot().stale).toBe(true);
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
  });
  it('sends the grant revision as If-Match on DELETE', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: null });
    await controller.revoke('g_1');
    expect(fetch.mock.calls.find(([, init]) => init.method === 'DELETE')).toMatchObject([
      '/_pb/grants/g_1',
      { headers: { 'If-Match': '"r4"' } },
    ]);
  });
  it('sends the project grant revision on PATCH', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: 'web' });
    await controller.changeGrant('g_1', 'r_2');
    expect(fetch.mock.calls.find(([, init]) => init.method === 'PATCH')).toMatchObject([
      '/_pb/projects/web/grants/g_1',
      { headers: { 'If-Match': '"r9"' }, body: JSON.stringify({ roleId: 'r_2' }) },
    ]);
  });
  it('shows a fixed last-holder message', async () => {
    const { controller } = fixture({ status: 409, code: 'last_holder' });
    await controller.load({ project: null });
    await controller.revoke('g_1');
    expect(markup(controller)).toContain('The last holder of this role cannot be removed.');
    expect(markup(controller)).not.toContain('private-message');
  });
  it('locks writes after 412 until reload and never retries', async () => {
    const { controller, fetch } = fixture({ status: 412, code: 'precondition_failed' });
    await controller.load({ project: null });
    await controller.revoke('g_1');
    await controller.revoke('g_1');
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
    expect(markup(controller)).toContain('Changed elsewhere. Reload');
  });
  it('does not render response details', async () => {
    const { controller } = fixture({ status: 400 });
    await controller.load({ project: null });
    await controller.changeGrant('g_1', 'r_2');
    expect(markup(controller)).not.toContain('private-details');
  });
  it('does not render response messages', async () => {
    const { controller } = fixture({ status: 409, code: 'conflict' });
    await controller.load({ project: null });
    await controller.revoke('g_1');
    expect(markup(controller)).not.toContain('private-message');
  });
  it('does not offer or execute writes without permissions', async () => {
    const { controller, fetch } = fixture({ permissions: false });
    await controller.load({ project: null });
    expect(markup(controller)).not.toContain('>Revoke<');
    expect(markup(controller)).not.toContain('>Create grant<');
    await controller.revoke('g_1');
    await controller.createGrant({
      roleId: role.id,
      subject: { type: 'email', value: 'input@example.test' },
    });
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it('does not allow mutation of system roles', async () => {
    const { controller, fetch } = fixture({ system: true });
    await controller.load({ project: null, status: 'roles' });
    expect(markup(controller)).not.toContain('>Delete role<');
    await controller.deleteRole(role.id);
    await controller.updateRole(role.id, { name: 'Changed' });
    expect(fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  });
  it('uses role revisions for both supported PATCH bodies and DELETE', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: null, status: 'roles' });
    await controller.updateRole(role.id, { name: 'Renamed' });
    await controller.updateRole(role.id, { permissions: ['org:read'] });
    await controller.deleteRole(role.id);
    const writes = fetch.mock.calls.filter(([, init]) => init.method !== 'GET');
    expect(writes).toHaveLength(3);
    for (const [, init] of writes) expect(init.headers).toMatchObject({ 'If-Match': '"r3"' });
  });
  it('adds idempotency keys to both kinds of POST and retains no subject input', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: null });
    await controller.createGrant({
      roleId: role.id,
      subject: { type: 'email', value: 'input@example.test' },
    });
    await controller.load({ project: null, status: 'roles' });
    await controller.createRole({
      key: 'custom',
      name: 'Custom',
      scope: 'organization',
      permissions: ['org:read'],
    });
    const writes = fetch.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(writes).toHaveLength(2);
    for (const [, init] of writes) expect(init.headers).toHaveProperty('Idempotency-Key');
    expect(JSON.stringify(controller.snapshot())).not.toContain('input@example.test');
  });
  it('hands a project revoke to reauth once, with its concurrency header', async () => {
    const { controller, fetch, requireReauth } = fixture({ status: 403, code: 'reauth_required' });
    await controller.load({ project: 'web' });
    await controller.revoke('g_1');
    await controller.revoke('g_1');
    expect(requireReauth).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: 'DELETE',
        path: '/_pb/projects/web/grants/g_1',
        headers: { 'If-Match': '"r9"' },
      }),
      { credential: false, secretFields: [] },
    );
    expect(fetch.mock.calls.filter(([, init]) => init.method === 'DELETE')).toHaveLength(1);
  });
  it('sends a project grant POST to the scoped route with an idempotency key', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: 'web' });
    await controller.createGrant({
      roleId: role.id,
      subject: { type: 'group', provider: 'sso', value: 'engineering' },
    });
    expect(fetch.mock.calls.find(([, init]) => init.method === 'POST')).toMatchObject([
      '/_pb/projects/web/grants',
      { headers: { 'Idempotency-Key': expect.any(String) } },
    ]);
  });
  it('shows role IDs so administrators can use them when assigning a grant', async () => {
    const { controller } = fixture();
    await controller.load({ project: null, status: 'roles' });
    expect(markup(controller)).toContain(role.id);
  });
});
