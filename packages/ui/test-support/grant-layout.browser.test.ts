import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { GrantForm, ChangeRoleForm } from '../src/pages/access/grant-form';
        const role = {
          id: 'developer', key: 'project_developer', name: 'Project Developer',
          scope: 'project', isSystem: true, permissions: ['project:read']
        };
        const props = {
          catalogue: { roles: [role], status: 'ready' }, project: 'storefront',
          busy: false, retry: () => {}, submit: async () => {}
        };
        createRoot(document.getElementById('root')).render(<main className="p-4">
          <GrantForm {...props} organization="Acme Company" providerStatus="ready"
            providers={[
              { id: 'dex', displayName: 'Dex' },
              { id: 'sso', displayName: 'Corporate SSO' }
            ]} />
          <ChangeRoleForm {...props} currentRole="developer" />
        </main>);
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
  fixture = await createBrowserFixture();
}, 20_000);
afterAll(async () => {
  await fixture?.close();
});

it.for([1440, 1024, 768, 390])(
  'lays out grant fields, errors, permissions and actions at %ipx',
  async (width, context) => {
    if (!fixture) return context.skip();
    const { page, browserExpect } = fixture;
    await page.setViewportSize({ width, height: 1000 });
    await fixture.mount(script);
    const create = page.locator('form').first();
    const change = page.locator('form').last();
    const email = create.getByRole('textbox', { name: 'Email address', exact: true });
    await browserExpect(email).toBeVisible();
    const role = create.getByRole('combobox', { name: 'Role', exact: true });
    const emailBox = (await email.boundingBox())!;
    const roleBox = (await role.boundingBox())!;
    if (width >= 1024) {
      expect(roleBox.y).toBe(emailBox.y);
      expect(roleBox.x).toBeGreaterThan(emailBox.x + emailBox.width);
    } else {
      expect(roleBox.y).toBeGreaterThan(emailBox.y + emailBox.height);
      expect(roleBox.x).toBe(emailBox.x);
    }
    await create.getByRole('button', { name: /^Create grant$/ }).click();
    await browserExpect(email).toHaveAttribute('aria-invalid', 'true');
    if (width >= 1024) expect((await role.boundingBox())!.y).toBe(roleBox.y);

    await create.getByRole('radio', { name: 'Group (from your sign-in provider)' }).click();
    const provider = create.getByRole('combobox', { name: 'Sign-in provider' });
    await provider.selectOption('dex');
    const group = create.getByRole('textbox', { name: 'Group value' });
    await group.fill(' Dev-All ');
    const groupBox = (await group.boundingBox())!;
    const groupRoleBox = (await role.boundingBox())!;
    expect((await provider.boundingBox())!.y).toBeLessThan(groupBox.y);
    if (width >= 1024) {
      expect(groupRoleBox.y).toBe(groupBox.y);
      expect(groupRoleBox.x).toBeGreaterThan(groupBox.x + groupBox.width);
    } else {
      expect(groupRoleBox.y).toBeGreaterThan(groupBox.y + groupBox.height);
    }
    await create.getByRole('button', { name: /^Create grant$/ }).click();
    await browserExpect(group).toHaveAttribute('aria-invalid', 'true');
    if (width >= 1024) expect((await role.boundingBox())!.y).toBe(groupRoleBox.y);
    await group.fill('A'.repeat(256));

    for (const form of [create, change]) {
      const formBox = (await form.boundingBox())!;
      expect(formBox.width).toBeLessThanOrEqual(1024);
      const details = form.locator('details');
      await details.locator('summary').click();
      await browserExpect(details.getByText('Read project details', { exact: true })).toBeVisible();
      const detailsBox = (await details.boundingBox())!;
      expect(detailsBox.x).toBe(formBox.x);
      expect(detailsBox.width).toBe(formBox.width);
      const buttonBox = (await form
        .getByRole('button', { name: /^(Create grant|Save role)$/ })
        .boundingBox())!;
      expect(buttonBox.x).toBe(formBox.x);
      if (width < 640) expect(buttonBox.width).toBe(formBox.width);
      else expect(buttonBox.width).toBeLessThan(formBox.width / 2);
      if (width >= 1024) {
        const pickerBox = (await form
          .getByRole('combobox', { name: 'Role', exact: true })
          .boundingBox())!;
        expect(pickerBox.width).toBeLessThan(formBox.width / 2);
      }
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  },
);
