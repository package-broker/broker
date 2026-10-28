import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api.js';
import type { paths } from '../../api-types.js';
import { grantBody, grantSummary, GrantForm, RolePicker, type GrantDraft } from './grant-form.js';
import {
  loadRoleCatalogue,
  roleDescription,
  scopeRoles,
  type Role,
  type Provider,
} from './role-catalogue.js';

export const developer: Role = {
  id: 'developer-id',
  key: 'project_developer',
  name: 'Project Developer',
  scope: 'project',
  isSystem: true,
  protectsLastHolder: false,
  revision: 1,
  permissions: [
    'project:read',
    'project:packages:read',
    'project:packages:write',
    'project:sources:read',
    'project:tokens:create',
  ],
};
const auditor: Role = {
  ...developer,
  id: 'auditor-id',
  key: 'organization_auditor',
  name: 'Organization Auditor',
  scope: 'organization',
  permissions: ['org:read', 'project:read'],
};
const dex: Provider = { id: 'dex-id', displayName: 'Dex', kind: 'oidc', supportsReauth: true };
const draft: GrantDraft = {
  type: 'email',
  email: '  ALEX@Example.Test  ',
  group: 'Dev-All@Example.Test',
  provider: dex.id,
  roleId: developer.id,
};

describe('grant role catalogue', () => {
  it('follows every cursor independently of the list and filters by scope', async () => {
    const fetch = vi.fn(async (url: string) =>
      Response.json(
        url.includes('after=')
          ? { items: [developer], next: null }
          : {
              items: Array.from({ length: 50 }, (_, index) => ({ ...auditor, id: `org-${index}` })),
              next: 'cursor-50',
            },
      ),
    );
    const catalogue = await loadRoleCatalogue(
      createApiClient<paths>({ fetch, readCookie: () => undefined }),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toContain('after=cursor-50');
    expect(catalogue.roles).toHaveLength(51);
    expect(scopeRoles(catalogue.roles, 'storefront')).toEqual([developer]);
    expect(scopeRoles(catalogue.roles, null)).toHaveLength(50);
  });
  it('does not expose a partial catalogue on a later refusal or repeated cursor', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ items: [developer], next: 'next' }))
      .mockResolvedValueOnce(Response.json({ error: { code: 'forbidden' } }, { status: 403 }));
    expect(
      await loadRoleCatalogue(createApiClient<paths>({ fetch, readCookie: () => undefined })),
    ).toEqual({ roles: [], status: 'forbidden' });
    const repeated = vi.fn(async () => Response.json({ items: [developer], next: 'same' }));
    expect(
      (
        await loadRoleCatalogue(
          createApiClient<paths>({ fetch: repeated, readCookie: () => undefined }),
        )
      ).status,
    ).toBe('error');
    expect(repeated).toHaveBeenCalledTimes(2);
  });
  it.each([
    [
      'project_developer',
      'Read packages, view sources and issue project tokens; includes publish permission.',
    ],
    [
      'project_auditor',
      'View project details, grants, packages, sources, tokens and audit records.',
    ],
    [
      'project_owner',
      'Manage project settings, access, packages, sources, service principals and tokens.',
    ],
    [
      'organization_auditor',
      'View organization records and project records across the organization.',
    ],
    [
      'organization_admin',
      'Manage the organization and all projects, including users, roles, grants and packages.',
    ],
  ])('describes system role %s by key, irrespective of its name', (key, description) => {
    expect(roleDescription({ ...developer, name: 'Renamed', key })).toBe(description);
  });
  it('describes custom roles by their real permission count, even with a system key', () => {
    expect(roleDescription({ ...developer, isSystem: false })).toBe('Custom role · 5 permissions');
  });
});
describe('grant input and review', () => {
  it('normalizes email and excludes hidden group fields', () => {
    expect(grantBody(draft)).toEqual({
      body: { roleId: developer.id, subject: { type: 'email', value: 'alex@example.test' } },
    });
  });
  it('preserves exact group spelling and excludes email', () => {
    expect(grantBody({ ...draft, type: 'group' })).toEqual({
      body: {
        roleId: developer.id,
        subject: { type: 'group', provider: dex.id, value: 'Dev-All@Example.Test' },
      },
    });
  });
  it.each([' dev', 'dev ', '\tdev', 'dev\n'])('refuses surrounding whitespace in %j', (group) => {
    expect(grantBody({ ...draft, type: 'group', group }).errors?.['group']).toBe(
      "Remove spaces at the start or end. Keep the group's spelling and capitalization.",
    );
  });
  it.each([
    '',
    'a@localhost',
    'a@@example.test',
    'a b@example.test',
    `${'a'.repeat(243)}@example.test`,
  ])('refuses invalid email %j', (email) => {
    expect(grantBody({ ...draft, email }).errors?.['email']).toBe(
      'Enter a valid sign-in email address.',
    );
  });
  it('requires provider, group and role independently', () => {
    expect(
      Object.keys(
        grantBody({ ...draft, type: 'group', provider: '', group: '', roleId: '' }).errors!,
      ),
    ).toEqual(['provider', 'group', 'roleId']);
  });
  it('reviews person and group grants at both scopes', () => {
    expect(grantSummary(draft, developer, dex, 'storefront', 'Fast White Cat')).toBe(
      'alex@example.test will get Project Developer on project storefront.',
    );
    expect(
      grantSummary({ ...draft, type: 'group' }, developer, dex, 'storefront', 'Fast White Cat'),
    ).toBe(
      'Members of Dev-All@Example.Test signing in with Dex will get Project Developer on project storefront.',
    );
    expect(grantSummary(draft, auditor, dex, null, 'Fast White Cat')).toBe(
      'alex@example.test will get Organization Auditor for Fast White Cat, including read access across projects.',
    );
    expect(grantSummary({ ...draft, type: 'group' }, auditor, dex, null, 'Fast White Cat')).toBe(
      'Members of Dev-All@Example.Test signing in with Dex will get Organization Auditor for Fast White Cat, including read access across projects.',
    );
  });
  it('reviews incomplete drafts with exact guidance', () => {
    expect(grantSummary({ ...draft, email: '' }, developer, dex, 'web', '')).toBe(
      'Enter an email address to review this grant.',
    );
    expect(grantSummary({ ...draft, type: 'group' }, developer, undefined, 'web', '')).toBe(
      'Choose a provider and enter a group value to review this grant.',
    );
    expect(grantSummary({ ...draft, roleId: '' }, undefined, dex, null, '')).toBe(
      'Choose a role to review this grant.',
    );
  });
  it('shows the 403 notice and an explicit role-ID field, with help', () => {
    const html = renderToString(
      createElement(RolePicker, {
        catalogue: { roles: [], status: 'forbidden' },
        project: 'web',
        id: 'role',
        value: '',
        onChange: vi.fn(),
        retry: vi.fn(),
      }),
    );
    expect(html).toContain(
      'Role choices are unavailable for your account. Ask an organization administrator to grant access.',
    );
    expect(html).toContain('Enter a role ID');
    expect(html).toContain('Ask an organization administrator for the role ID.');
    expect(html).toContain('aria-describedby="role-help"');
  });
  it('defaults only project pages to the returned developer role and shows real permissions', () => {
    const props = {
      catalogue: { roles: [developer, auditor], status: 'ready' as const },
      providers: [dex],
      providerStatus: 'ready' as const,
      organization: 'Fast White Cat',
      busy: false,
      retry: vi.fn(),
      submit: vi.fn(),
    };
    const project = renderToString(createElement(GrantForm, { ...props, project: 'web' }));
    expect(project).toContain('value="developer-id" selected=""');
    expect(project).toContain('View permissions (');
    expect(project).toContain('Publish project packages');
    const organization = renderToString(createElement(GrantForm, { ...props, project: null }));
    expect(organization).toContain('value="" selected=""');
    expect(organization).not.toContain('Project Developer');
    expect(organization).toContain('href="#/projects"');
    expect(
      renderToString(createElement(GrantForm, { ...props, project: 'web', providers: [] })),
    ).toContain(
      'Group access needs a sign-in provider that sends groups. Grant access to individual people instead.',
    );
  });
});
