import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
let providerCount = 1;
let rolesStatus = 200;
let createStatus = 204;
let providerStatus = 200;
const writes: { method: string; path: string; body: unknown; revision: string | null }[] = [];
const developer = {
  id: 'developer-id',
  key: 'project_developer',
  name: 'Project Developer',
  scope: 'project',
  isSystem: true,
  protectsLastHolder: false,
  revision: 1,
  permissions: ['project:read', 'project:packages:write'],
};
const auditor = {
  ...developer,
  id: 'auditor-id',
  key: 'project_auditor',
  name: 'Project Auditor',
  permissions: ['project:read'],
};
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
    import React, { useSyncExternalStore } from 'react';
    import { createRoot } from 'react-dom/client';
    import { createApiClient } from '../src/api';
    import { AccessView, createAccessController } from '../src/pages/access';
    const controller = createAccessController({ client: createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined }), requireReauth: () => {} });
    function App() { const state = useSyncExternalStore(controller.subscribe, controller.snapshot); return <AccessView state={state} controller={controller} />; }
    createRoot(document.getElementById('root')).render(<App />);
    void controller.load({ project: globalThis.fixtureProject === undefined ? 'storefront' : globalThis.fixtureProject });
  `,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  script = bundle.outputFiles[0]!.text;
  fixture = await createBrowserFixture({
    api: async (request) => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method !== 'GET') {
        writes.push({
          path,
          method: request.method,
          body: await request.json().catch(() => null),
          revision: request.headers.get('if-match'),
        });
        return createStatus === 204
          ? new Response(null, { status: 204 })
          : Response.json(
              { error: { code: 'invalid_request', message: 'private-server-message' } },
              { status: createStatus },
            );
      }
      if (path === '/_pb/auth/providers')
        return providerStatus === 200
          ? Response.json({
              providers: Array.from({ length: providerCount }, (_, index) => ({
                id: `provider-${index}`,
                displayName: index ? 'Corporate SSO' : 'Dex',
                kind: 'oidc',
                supportsReauth: true,
              })),
              local: true,
            })
          : Response.json({ error: { code: 'unavailable' } }, { status: providerStatus });
      if (path === '/_pb/organization') return Response.json({ name: 'Fast White Cat' });
      if (path.endsWith('/permissions'))
        return Response.json({
          organization: ['org:grants:read', 'org:grants:write'],
          project: ['project:grants:read', 'project:grants:write'],
        });
      if (path === '/_pb/roles')
        return rolesStatus === 403
          ? Response.json({ error: { code: 'forbidden' } }, { status: 403 })
          : Response.json({
              items: [
                developer,
                auditor,
                {
                  ...auditor,
                  id: 'org-role',
                  key: 'organization_auditor',
                  name: 'Organization Auditor',
                  scope: 'organization',
                },
              ],
              next: null,
            });
      return Response.json({
        items: [
          {
            id: 'grant-id',
            subject: { type: 'email' },
            roleId: developer.id,
            principal: { id: 'person-id', kind: 'user', displayName: 'Alex' },
            role: { id: developer.id, name: developer.name },
            revision: 4,
            createdAt: '2026-10-28',
          },
        ],
        next: null,
      });
    },
  });
}, 20_000);
afterAll(async () => {
  await fixture?.close();
});
async function open(project: string | null = 'storefront') {
  writes.length = 0;
  await fixture!.mount(script, { fixtureProject: project });
  await fixture!.page.getByText('New grant', { exact: true }).click();
  return fixture!.page;
}
describe('grant form in Chromium', () => {
  it('supports keyboard-only person flow and permission details; retains a failed draft', async (context) => {
    if (!fixture) return context.skip();
    providerCount = 1;
    rolesStatus = 200;
    createStatus = 400;
    const page = await open();
    const { browserExpect } = fixture;
    const email = page.getByRole('textbox', { name: 'Email address', exact: true });
    await email.focus();
    await page.keyboard.type('ALEX@Example.Test');
    await page.keyboard.press('Tab');
    await browserExpect(
      page.getByRole('combobox', { name: 'Role', exact: true }).last(),
    ).toBeFocused();
    await page.keyboard.press('Tab');
    const details = page.getByText('View permissions (2)', { exact: true }).last();
    await browserExpect(details).toBeFocused();
    await page.keyboard.press('Enter');
    await browserExpect(
      page.getByText('Publish project packages', { exact: true }).last(),
    ).toBeVisible();
    await page.keyboard.press('Tab');
    await browserExpect(page.getByRole('button', { name: /^Create grant$/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await browserExpect(
      page.getByText('Check the entered values and try again.', { exact: true }),
    ).toBeVisible();
    await browserExpect(email).toHaveValue('ALEX@Example.Test');
    expect(writes[0]?.body).toEqual({
      roleId: developer.id,
      subject: { type: 'email', value: 'alex@example.test' },
    });
    await browserExpect(
      page.getByText('alex@example.test will get Project Developer on project storefront.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(await page.textContent('body')).not.toContain('private-server-message');
  });
  it.for([0, 1, 2])(
    'handles %i providers, preserving exact group values and submitting IDs',
    async (count, context) => {
      if (!fixture) return context.skip();
      providerCount = count;
      rolesStatus = 200;
      createStatus = 204;
      const page = await open();
      const { browserExpect } = fixture;
      const group = page.getByRole('radio', {
        name: 'Group (from your sign-in provider)',
        exact: true,
      });
      if (!count) {
        await browserExpect(group).toBeDisabled();
        await browserExpect(
          page.getByText(
            'Group access needs a sign-in provider that sends groups. Grant access to individual people instead.',
            { exact: true },
          ),
        ).toBeVisible();
        return;
      }
      await group.focus();
      await page.keyboard.press('Space');
      const provider = page.getByRole('combobox', { name: 'Sign-in provider', exact: true });
      if (count === 1) {
        await browserExpect(provider).toHaveCount(0);
        await browserExpect(
          page.getByText('Members signing in with Dex', { exact: true }),
        ).toBeVisible();
      } else {
        await browserExpect(provider).toBeVisible();
        await provider.selectOption('provider-1');
      }
      await browserExpect(
        page.getByRole('textbox', { name: 'Email address', exact: true }),
      ).toHaveCount(0);
      const value = page.getByRole('textbox', { name: 'Group value', exact: true });
      await value.fill(' Dev-All@Example.Test ');
      await page.getByRole('button', { name: /^Create grant$/ }).click();
      await browserExpect(value).toBeFocused();
      await browserExpect(value).toHaveAttribute('aria-invalid', 'true');
      expect(writes).toHaveLength(0);
      await value.fill('Dev-All@Example.Test');
      await browserExpect(
        page.getByText(
          `Members of Dev-All@Example.Test signing in with ${count === 1 ? 'Dex' : 'Corporate SSO'} will get Project Developer on project storefront.`,
          { exact: true },
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: /^Create grant$/ }).click();
      await browserExpect(
        page.getByText(
          "Grant created. Access depends on the person's email or the groups their provider reports at sign-in.",
          { exact: false },
        ),
      ).toBeVisible();
      expect(writes[0]?.body).toEqual({
        roleId: developer.id,
        subject: {
          type: 'group',
          provider: `provider-${count === 1 ? 0 : 1}`,
          value: 'Dev-All@Example.Test',
        },
      });
    },
  );
  it('keeps the selected edit role after a conflict and updates its permission details', async (context) => {
    if (!fixture) return context.skip();
    providerCount = 1;
    rolesStatus = 200;
    createStatus = 412;
    const page = await open();
    const { browserExpect } = fixture;
    await page.getByText('Change role', { exact: true }).click();
    const role = page.getByRole('combobox', { name: 'Role', exact: true }).first();
    await browserExpect(role).toHaveValue(developer.id);
    await role.selectOption(auditor.id);
    await page.getByText('View permissions (1)', { exact: true }).click();
    await browserExpect(
      page.getByText('Read project details', { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Save role', exact: true }).click();
    await browserExpect(
      page.getByText('This grant changed. Reload it before saving.', { exact: true }),
    ).toBeVisible();
    await browserExpect(role).toHaveValue(auditor.id);
    await browserExpect(
      page.getByRole('button', { name: 'Save role', exact: true }),
    ).toBeDisabled();
    expect(writes[0]).toEqual({
      path: '/_pb/projects/storefront/grants/grant-id',
      method: 'PATCH',
      body: { roleId: auditor.id },
      revision: '"r4"',
    });
  });
  it('uses the explicit 403 fallback and PATCHes only the chosen role with If-Match', async (context) => {
    if (!fixture) return context.skip();
    providerCount = 1;
    rolesStatus = 403;
    createStatus = 204;
    const page = await open();
    const { browserExpect } = fixture;
    await browserExpect(
      page.getByRole('textbox', { name: 'Enter a role ID', exact: true }).last(),
    ).toBeVisible();
    await browserExpect(
      page
        .getByText(
          'Role choices are unavailable for your account. Ask an organization administrator to grant access.',
        )
        .last(),
    ).toBeVisible();
    await page.getByText('Change role', { exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Enter a role ID', exact: true }).first();
    await browserExpect(input).toHaveValue(developer.id);
    await input.fill('replacement-role');
    await page.getByRole('button', { name: 'Save role', exact: true }).click();
    await browserExpect(page.getByText('Access updated.', { exact: true })).toBeVisible();
    expect(writes[0]).toEqual({
      path: '/_pb/projects/storefront/grants/grant-id',
      method: 'PATCH',
      body: { roleId: 'replacement-role' },
      revision: '"r4"',
    });
  });
  it('retries provider failures and filters organization roles without an admin default', async (context) => {
    if (!fixture) return context.skip();
    providerCount = 1;
    providerStatus = 503;
    rolesStatus = 200;
    createStatus = 204;
    const page = await open(null);
    const { browserExpect } = fixture;
    await browserExpect(
      page.getByRole('radio', { name: 'Group (from your sign-in provider)', exact: true }),
    ).toBeDisabled();
    await browserExpect(
      page.getByText('Sign-in providers could not be loaded. Try again.', { exact: true }),
    ).toBeVisible();
    providerStatus = 200;
    await page.getByRole('button', { name: 'Retry sign-in providers', exact: true }).click();
    await browserExpect(
      page.getByRole('radio', { name: 'Group (from your sign-in provider)', exact: true }),
    ).toBeEnabled();
    const role = page.getByRole('combobox', { name: 'Role', exact: true }).last();
    await browserExpect(role).toHaveValue('');
    expect(await role.locator('option').allTextContents()).toEqual([
      'Choose a role',
      'Organization Auditor',
    ]);
    await page
      .getByRole('textbox', { name: 'Email address', exact: true })
      .fill('alex@example.test');
    await role.selectOption('org-role');
    await browserExpect(
      page.getByText(
        'alex@example.test will get Organization Auditor for Fast White Cat, including read access across projects.',
        { exact: true },
      ),
    ).toBeVisible();
  });
});
