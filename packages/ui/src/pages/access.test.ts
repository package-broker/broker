import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../api.js';
import type { paths } from '../api-types.js';
import { createReauthFlow } from '../auth.js';
import {
  AccessView,
  accessViewModel,
  buildAccessHash,
  createAccessController,
  parseAccessHash,
} from './access.js';

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
  subject: { type: 'email', visibility: 'visible', value: 'person@acme-company.example' },
  revision: 4,
  createdAt: '2026-10-22',
};
const member = {
  id: 'g_1',
  principal: {
    id: 'u_1',
    kind: 'user',
    displayName: 'Acme Company',
    visibility: 'visible',
    email: 'person@acme-company.example',
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
    if (url === '/_pb/auth/providers') return Response.json({ providers: [], local: true });
    if (url === '/_pb/organization') return Response.json({ name: 'Acme Company' });
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
  renderToString(
    createElement(AccessView, { state: controller.snapshot(), controller }),
  ).replaceAll('<!-- -->', '');

describe('access', () => {
  it('round trips scope, view, prefix and cursor in the hash', () => {
    const query = parseAccessHash('#/access?project=web&status=grants&q=ab&after=p_9');
    expect(parseAccessHash(buildAccessHash(query))).toEqual(query);
    expect(buildAccessHash(query)).toBe('#/access?project=web&status=grants&q=ab&after=p_9');
  });
  it('drops malformed view keys', () => {
    expect(buildAccessHash(parseAccessHash('#/access?status=<script>&other=bad'))).toBe('#/access');
  });
  it('preserves authorized project subjects from the grant response', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: 'web' });
    expect(fetch.mock.calls.some(([url]) => url.startsWith('/_pb/projects/web/grants'))).toBe(true);
    expect(markup(controller)).not.toContain('u_1');
    expect(markup(controller)).toContain('person@acme-company.example');
    expect(controller.snapshot().grants[0]?.principalName).toBe('person@acme-company.example');
  });
  it('displays the authorized subject while mutations use grant IDs', async () => {
    const { controller, fetch } = fixture();
    await controller.load({ project: 'web' });
    expect(markup(controller)).toContain('person@acme-company.example');
    expect(markup(controller)).not.toContain('u_1');
    await controller.changeGrant('g_1', 'r_2');
    await controller.revoke('g_1');
    const writes = fetch.mock.calls.filter(([, init]) => init.method !== 'GET');
    expect(writes).toHaveLength(2);
    expect(writes.map(([url]) => url)).toEqual([
      '/_pb/projects/web/grants/g_1',
      '/_pb/projects/web/grants/g_1',
    ]);
    expect(writes[0]![1].body).toBe(JSON.stringify({ roleId: 'r_2' }));
    expect(JSON.stringify(writes)).not.toContain('person@acme-company.example');
  });
  it('filters project grants by their visible subject', async () => {
    const { controller } = fixture();
    await controller.load({ project: 'web', q: 'person@' });
    expect(markup(controller)).toContain('person@acme-company.example');
  });
  it('keeps the authorized email when the display name is missing', async () => {
    const { controller } = fixture({ displayName: null });
    await controller.load({ project: 'web' });
    expect(markup(controller)).not.toContain('u_1');
    expect(markup(controller)).toContain('person@acme-company.example');
    expect(controller.snapshot().grants[0]?.principalName).toBe('person@acme-company.example');
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
    expect(markup(controller)).toContain('This grant changed. Reload it before saving.');
    expect(markup(controller)).toContain('>Create grant<');
    expect(markup(controller)).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Change role/);
    expect(markup(controller)).toMatch(/<button[^>]*disabled=""[^>]*>Create grant<\/button>/);
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
    expect(markup(controller)).not.toContain('>Revoke grant<');
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
    expect(markup(controller)).not.toContain('>Remove role<');
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

describe('access list presentation', () => {
  it('renders authorized subjects, mobile facts and exact dates with IDs inside More', async () => {
    const { controller } = fixture();
    await controller.load({ project: 'web' });
    const html = markup(controller);
    expect(html).toContain('readable-desktop');
    expect(html).toContain('readable-mobile');
    expect(html).toContain('>Added</dt>');
    expect(html).toContain(`dateTime="${grant.createdAt}"`);
    expect(html).not.toContain('Copy principal ID');
    expect(html).toContain('aria-label="More actions for person@acme-company.example"');
    expect(html).not.toContain('g_1');
    expect(html).toContain(member.principal.email);
    expect(html).not.toContain('<dialog');
  });
  it('shows denied list access as an error without claiming the list is empty', async () => {
    const { controller } = fixture({ permissions: false });
    await controller.load({ project: null });
    expect(markup(controller)).toContain('data-list-state="error"');
    expect(markup(controller)).not.toContain('data-list-state="empty"');
  });
});

describe('grant subjects and role summaries', () => {
  it.each([null, 'web'])(
    'preserves visible group values and providers in scope %s',
    async (project) => {
      const { controller, fetch } = fixture();
      const original = fetch.getMockImplementation()!;
      fetch.mockImplementation(async (url, init) => {
        if (url === '/_pb/auth/providers')
          return Response.json({
            providers: [{ id: 'sso', displayName: 'Sample Business SSO', kind: 'oidc' }],
            local: true,
          });
        if (url.includes('/grants'))
          return Response.json({
            items: [
              {
                ...grant,
                subject: {
                  type: 'group',
                  provider: 'sso',
                  value: 'dev-all@acme-company.example',
                  visibility: 'visible',
                },
                principal: {
                  kind: 'group',
                  id: 'hidden-principal-id',
                  provider: 'sso',
                  displayName: 'Group',
                  groupValue: 'dev-all@acme-company.example',
                  visibility: 'visible',
                },
                role: {
                  id: 'custom-role-id',
                  name: 'Sample Business',
                  permissions: ['project:read'],
                },
              },
            ],
            next: null,
          });
        return original(url, init);
      });
      await controller.load({ project });
      await vi.waitFor(() => expect(controller.snapshot().organizationName).toBe('Acme Company'));
      const html = markup(controller);
      expect(html).toContain('dev-all@acme-company.example');
      expect(html).toMatch(
        /<span class="text-xs text-neutral-600">Group · Sample Business SSO<\/span>/,
      );
      expect(controller.snapshot().organizationName).toBe('Acme Company');
      expect(
        accessViewModel({ ...controller.snapshot(), query: { project, q: 'sample business sso' } })
          .grants,
      ).toHaveLength(1);
      expect(html).toContain('Sample Business');
      expect(html).toContain('View permissions (1)');
      expect(html).not.toContain('custom-role-id');
      expect(html).not.toContain('hidden-principal-id');
    },
  );
  it.each([null, 'web'])(
    'honors redaction even if a response includes an inconsistent value in scope %s',
    async (project) => {
      const { controller, fetch } = fixture();
      const original = fetch.getMockImplementation()!;
      fetch.mockImplementation(async (url, init) =>
        url.includes('/grants')
          ? Response.json({
              items: [
                {
                  ...grant,
                  subject: {
                    type: 'group',
                    provider: 'removed-provider',
                    visibility: 'redacted',
                    value: 'hidden@acme-company.example',
                  },
                  principal: {
                    kind: 'group',
                    id: 'principal-id',
                    provider: 'removed-provider',
                    visibility: 'redacted',
                    groupValue: 'hidden@acme-company.example',
                    displayName: 'hidden@acme-company.example',
                  },
                  role: { id: role.id, name: role.name, permissions: [] },
                },
              ],
              next: null,
            })
          : original(url, init),
      );
      await controller.load({ project });
      expect(markup(controller)).toContain('Group value hidden');
      expect(markup(controller)).toContain('Provider: removed-provider');
      expect(JSON.stringify(controller.snapshot())).not.toContain('hidden@');
      expect(markup(controller)).not.toContain('Verified');
    },
  );
  it.each([null, 'web'])(
    'shows grants while enrichment is stalled in scope %s',
    async (project) => {
      const { controller, fetch } = fixture();
      const original = fetch.getMockImplementation()!;
      let release!: (response: Response) => void;
      const stalled = new Promise<Response>((resolve) => {
        release = resolve;
      });
      fetch.mockImplementation(async (url, init) => {
        if (
          url.startsWith('/_pb/roles') ||
          url === '/_pb/auth/providers' ||
          url === '/_pb/organization'
        )
          return stalled;
        if (url.includes('/grants'))
          return Response.json({ items: [{ ...grant, ...member }], next: null });
        return original(url, init);
      });
      try {
        await controller.load({ project });
        expect(controller.snapshot().loading).toBe(false);
        expect(controller.snapshot().grants).toHaveLength(1);
        expect(markup(controller)).toContain('View permissions (0)');
        expect(controller.snapshot().catalogue.status).toBe('loading');
      } finally {
        release(Response.json({ items: [role], next: null, providers: [], name: 'Acme Company' }));
      }
      await vi.waitFor(() => expect(controller.snapshot().catalogue.status).toBe('ready'));
      expect(controller.snapshot().grants[0]?.rolePermissions).toEqual([]);
      expect(markup(controller)).toContain('View permissions (0)');
    },
  );
  it('applies role fallback before a stalled provider finishes', async () => {
    const { controller, fetch } = fixture();
    const original = fetch.getMockImplementation()!;
    let release!: (response: Response) => void;
    const stalled = new Promise<Response>((resolve) => {
      release = resolve;
    });
    fetch.mockImplementation(async (url, init) =>
      url === '/_pb/auth/providers' ? stalled : original(url, init),
    );
    try {
      await controller.load({ project: null });
      await vi.waitFor(() => expect(controller.snapshot().grants[0]?.roleName).toBe(role.name));
      expect(markup(controller)).toContain('View permissions (1)');
      expect(controller.snapshot().providerStatus).toBe('loading');
      expect(controller.snapshot().organizationName).toBe('Acme Company');
    } finally {
      release(Response.json({ providers: [], local: true }));
    }
  });
  it('resolves organization role names across catalogue pages without using IDs as names', async () => {
    const { controller, fetch } = fixture();
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) => {
      if (url.startsWith('/_pb/roles'))
        return Response.json(
          url.includes('after=second')
            ? { items: [role], next: null }
            : { items: [], next: 'second' },
        );
      return original(url, init);
    });
    await controller.load({ project: null });
    await vi.waitFor(() => expect(controller.snapshot().grants[0]?.roleName).toBe(role.name));
    expect(markup(controller)).toContain('View permissions (1)');
    expect(fetch.mock.calls.some(([url]) => url.includes('after=second'))).toBe(true);
  });
  it('keeps grants and embedded permissions readable when the role catalogue is forbidden', async () => {
    const { controller, fetch } = fixture();
    const original = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (url, init) =>
      url.startsWith('/_pb/roles')
        ? Response.json({ error: { code: 'forbidden' } }, { status: 403 })
        : original(url, init),
    );
    await controller.load({ project: null });
    expect(markup(controller)).toContain('Role name unavailable');
    expect(markup(controller)).not.toContain(role.id);
    expect(controller.snapshot().listError).toBe(false);
    await controller.load({ project: 'web' });
    expect(markup(controller)).toContain(role.name);
    expect(markup(controller)).toContain('View permissions (0)');
  });
});

it.each([null, 'web'])('keeps redacted person emails hidden in scope %s', async (project) => {
  const { controller, fetch } = fixture();
  const original = fetch.getMockImplementation()!;
  fetch.mockImplementation(async (url, init) =>
    url.includes('/grants')
      ? Response.json({
          items: [
            {
              ...grant,
              subject: {
                type: 'email',
                visibility: 'redacted',
                value: 'hidden@acme-company.example',
              },
              principal: {
                kind: 'user',
                id: 'person-id',
                visibility: 'redacted',
                email: 'hidden@acme-company.example',
                displayName: 'hidden@acme-company.example',
              },
              role: member.role,
            },
          ],
          next: null,
        })
      : original(url, init),
  );
  await controller.load({ project });
  expect(markup(controller)).toContain('Email address hidden');
  expect(JSON.stringify(controller.snapshot())).not.toContain('hidden@');
});
it('does not claim organization email rules have no account', async () => {
  const { controller } = fixture();
  await controller.load({ project: null });
  expect(markup(controller)).toContain('person@acme-company.example');
  expect(markup(controller)).not.toContain('No account yet');
});
