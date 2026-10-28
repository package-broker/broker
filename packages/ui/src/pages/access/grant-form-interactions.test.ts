import { useId, useState, type FormEvent } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccessController } from '../access.js';
import { createApiClient } from '../../api.js';
import type { paths } from '../../api-types.js';
import { GrantForm, type GrantDraft, type GrantFormProps } from './grant-form.js';
import type { Provider, Role } from './role-catalogue.js';
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: vi.fn(actual.useState), useId: vi.fn(actual.useId) };
});
afterEach(() => vi.clearAllMocks());
const role: Role = {
  id: 'role-id',
  name: 'Project Developer',
  key: 'project_developer',
  scope: 'project',
  isSystem: true,
  protectsLastHolder: false,
  revision: 1,
  permissions: ['project:read'],
};
const provider: Provider = { id: 'dex-id', kind: 'oidc', displayName: 'Dex', supportsReauth: true };
const draft: GrantDraft = {
  type: 'group',
  email: 'inactive@example.test',
  group: 'Dev-All',
  provider: '',
  roleId: role.id,
};
function view(providers: Provider[], input = draft) {
  const setDraft = vi.fn();
  const setErrors = vi.fn();
  vi.mocked(useId).mockReturnValueOnce('test-form');
  vi.mocked(useState)
    .mockReturnValueOnce([input, setDraft])
    .mockReturnValueOnce([{}, setErrors])
    .mockReturnValueOnce([true, vi.fn()]);
  const submit = vi.fn<GrantFormProps['submit']>(async () => {});
  const props: GrantFormProps = {
    catalogue: { roles: [role], status: 'ready' },
    providers,
    providerStatus: 'ready',
    project: 'storefront',
    organization: 'Fast White Cat',
    busy: false,
    retry: vi.fn(),
    submit,
  };
  const tree = GrantForm(props);
  const focus = vi.fn();
  const reset = vi.fn();
  const event = {
    preventDefault: vi.fn(),
    currentTarget: {
      querySelector: vi.fn(() => ({ focus, validity: { typeMismatch: false } })),
      reset,
    },
  } as unknown as FormEvent<HTMLFormElement>;
  return {
    tree,
    submit,
    setDraft,
    setErrors,
    focus,
    event,
    reset,
    html: renderToString(tree).replaceAll('<!-- -->', ''),
  };
}
describe('grant form interactions', () => {
  it('uses the single provider as text and submits its ID without a select', () => {
    const v = view([provider]);
    expect(v.html).toContain('Members signing in with Dex');
    expect(v.html).not.toContain('name="provider"');
    expect(v.html).not.toContain('name="email"');
    v.tree.props.onSubmit(v.event);
    expect(v.submit).toHaveBeenCalledWith({
      roleId: role.id,
      subject: { type: 'group', value: 'Dev-All', provider: provider.id },
    });
  });
  it('shows a provider select for two providers and requires an explicit choice', () => {
    const v = view([provider, { ...provider, id: 'second-id', displayName: 'Corporate SSO' }]);
    expect(v.html).toContain('name="provider"');
    v.tree.props.onSubmit(v.event);
    expect(v.submit).not.toHaveBeenCalled();
    expect(v.setErrors).toHaveBeenCalledWith({ provider: 'Choose a sign-in provider.' });
    expect(v.focus).toHaveBeenCalledOnce();
  });
  it('submits the explicitly selected second provider ID', () => {
    const second = { ...provider, id: 'second-id', displayName: 'Corporate SSO' };
    const v = view([provider, second], { ...draft, provider: second.id });
    v.tree.props.onSubmit(v.event);
    expect(v.submit).toHaveBeenCalledWith({
      roleId: role.id,
      subject: { type: 'group', value: 'Dev-All', provider: second.id },
    });
  });
  it('disables Group when no provider exists and keeps Person available', () => {
    const v = view([], { ...draft, type: 'email' });
    expect(v.html).toMatch(/<input[^>]*disabled=""[^>]*value="group"/);
    expect(v.html).toContain(
      'Group access needs a sign-in provider that sends groups. Grant access to individual people instead.',
    );
    expect(v.html).toContain('name="email"');
    expect(v.html).not.toContain('name="group"');
  });
  it('normalizes a person request and preserves the draft after an API failure', async () => {
    const input = { ...draft, type: 'email' as const, email: ' ALEX@Example.Test ' };
    const v = view([provider], input);
    const client = createApiClient<paths>({
      readCookie: () => undefined,
      fetch: async (url, init) => {
        if (init.method === 'POST')
          return Response.json(
            { error: { code: 'invalid_request', message: 'private-message' } },
            { status: 400 },
          );
        if (url.endsWith('/permissions'))
          return Response.json({
            organization: [],
            project: ['project:grants:write', 'project:grants:read'],
          });
        if (url.startsWith('/_pb/roles')) return Response.json({ items: [role], next: null });
        if (url === '/_pb/auth/providers')
          return Response.json({ providers: [provider], local: true });
        if (url === '/_pb/organization') return Response.json({ name: 'Fast White Cat' });
        return Response.json({ items: [], next: null });
      },
    });
    const controller = createAccessController({ client, requireReauth: vi.fn() });
    await controller.load({ project: 'storefront' });
    v.submit.mockImplementationOnce((body) => controller.createGrant(body));
    v.tree.props.onSubmit(v.event);
    await vi.waitFor(() =>
      expect(controller.snapshot().notice).toBe('Check the entered values and try again.'),
    );
    expect(v.submit).toHaveBeenCalledWith({
      roleId: role.id,
      subject: { type: 'email', value: 'alex@example.test' },
    });
    expect(v.reset).not.toHaveBeenCalled();
    expect(v.setDraft).not.toHaveBeenCalled();
    expect(v.html).toContain('value=" ALEX@Example.Test "');
  });
  it('focuses an unavailable provider before later invalid fields', () => {
    const v = view([provider, { ...provider, id: 'second-id' }], {
      ...draft,
      provider: 'removed-id',
      group: ' Dev-All ',
      roleId: '',
    });
    v.tree.props.onSubmit(v.event);
    expect(v.event.currentTarget.querySelector).toHaveBeenCalledWith('[id="test-form-provider"]');
    expect(v.setErrors).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'This provider is no longer available. Choose another provider.',
      }),
    );
    expect(v.submit).not.toHaveBeenCalled();
  });
  it('focuses the invalid group field without trimming or submitting', () => {
    const v = view([provider], { ...draft, group: ' Dev-All ' });
    v.tree.props.onSubmit(v.event);
    expect(v.event.currentTarget.querySelector).toHaveBeenCalledWith('[id="test-form-group"]');
    expect(v.focus).toHaveBeenCalledOnce();
    expect(v.submit).not.toHaveBeenCalled();
    expect(v.setDraft).not.toHaveBeenCalled();
  });
});
