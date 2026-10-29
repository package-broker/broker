import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
const writes: { path: string; revision: string | null }[] = [];
let canWrite = true;
let longValues = false;
const longGroup = 'AcmeCompanyGroup'.repeat(40);
const longProvider = 'SampleBusinessSSO'.repeat(30);
const longRole = 'SampleBusinessReader'.repeat(30);
let projectStatus = 'active';
let hasEtag = true;
const role = {
  id: 'role-id',
  name: 'Sample Business',
  key: 'custom',
  scope: 'project',
  permissions: ['project:read'],
  revision: 1,
  isSystem: false,
  protectsLastHolder: false,
};
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React, { useSyncExternalStore } from 'react';
        import { createRoot } from 'react-dom/client';
        import { createApiClient } from '../src/api';
        import { ProjectsView, createProjectsController } from '../src/pages/projects';
        import { AccessView, createAccessController } from '../src/pages/access';
        const services = { client: createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined }), requireReauth: () => {} };
        const projects = globalThis.fixtureList === 'projects';
        const controller = projects ? createProjectsController(services) : createAccessController(services);
        function App() { const state = useSyncExternalStore(controller.subscribe, controller.snapshot); return projects ? <ProjectsView state={state} controller={controller} /> : <AccessView state={state} controller={controller} />; }
        createRoot(document.getElementById('root')).render(<><h1 id="page-heading" tabIndex={-1}>Acme Company</h1><App /></>);
        void controller.load({ project: globalThis.fixtureList === 'project-grants' ? 'sample-business' : null, ...(globalThis.fixtureStatus ? {status: globalThis.fixtureStatus} : {}) });
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
      const url = new URL(request.url),
        path = url.pathname;
      const groupValue = longValues ? longGroup : 'dev-all@acme-company.example';
      const grantRole = { ...role, name: longValues ? longRole : role.name };
      if (request.method !== 'GET') {
        writes.push({ path, revision: request.headers.get('if-match') });
        return new Response(null, { status: 204 });
      }
      if (path === '/_pb/me/permissions')
        return Response.json({
          organization: [
            'org:grants:read',
            'org:roles:read',
            ...(canWrite ? ['org:grants:write', 'org:projects:archive'] : []),
          ],
        });
      if (path.endsWith('/permissions'))
        return Response.json({
          project: ['project:grants:read', ...(canWrite ? ['project:grants:write'] : [])],
        });
      if (path === '/_pb/organization') return Response.json({ name: 'Acme Company' });
      if (path === '/_pb/auth/providers')
        return Response.json({
          providers: [
            {
              id: 'sso',
              displayName: longValues ? longProvider : 'Sample Business SSO',
              kind: 'oidc',
            },
          ],
          local: true,
        });
      if (path === '/_pb/roles')
        return Response.json({
          items: [grantRole, { ...grantRole, id: 'org-role', scope: 'organization' }],
          next: null,
        });
      if (path.endsWith('/grants'))
        return Response.json({
          items: [
            {
              id: 'grant-id',
              revision: 7,
              createdAt: '2026-10-28T09:30:00Z',
              roleId: 'org-role',
              role: grantRole,
              subject: {
                type: 'group',
                value: groupValue,
                provider: 'sso',
                visibility: 'visible',
              },
              principal: {
                id: 'principal-id',
                kind: 'group',
                groupValue,
                displayName: 'Group',
                provider: 'sso',
                visibility: 'visible',
              },
            },
            {
              id: 'hidden-grant-id',
              revision: 8,
              createdAt: '2026-01-01T09:30:00Z',
              roleId: 'org-role',
              role: grantRole,
              subject: { type: 'email', visibility: 'redacted' },
              principal: {
                id: 'hidden-person-id',
                kind: 'user',
                displayName: 'Person',
                visibility: 'redacted',
              },
            },
          ],
          next: null,
        });
      return Response.json({
        items:
          url.searchParams.get('status') !== projectStatus
            ? []
            : [
                {
                  id: 'project-id',
                  name: 'Sample Business',
                  slug: 'sample-business',
                  status: projectStatus,
                  ...(hasEtag ? { etag: '"r7"' } : {}),
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

describe('readable lists in Chromium', () => {
  it.for(['projects', 'organization-grants', 'project-grants'])(
    'keeps %s readable with one interactive representation at desktop and narrow widths',
    async (list, context) => {
      if (!fixture) return context.skip();
      canWrite = true;
      await fixture.mount(script, { fixtureList: list });
      const { page, browserExpect } = fixture;
      const name = list === 'projects' ? 'Sample Business' : 'dev-all@acme-company.example';
      for (const width of [1440, 1280, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const desktop = page.locator('.readable-desktop');
        const mobile = page.locator('.readable-mobile');
        const visible = width <= 640 ? mobile : desktop;
        const hidden = width <= 640 ? desktop : mobile;
        await browserExpect(visible).toBeVisible();
        await browserExpect(hidden).toHaveCSS('display', 'none');
        await browserExpect(hidden).toBeHidden();
        await browserExpect(
          page.locator('.readable-desktop, .readable-mobile').filter({ visible: true }),
        ).toHaveCount(1);
        await browserExpect(page.getByRole('table')).toHaveCount(width <= 640 ? 0 : 1);
        await browserExpect(page.getByRole('list', { name: /Projects|grants/ })).toHaveCount(
          width <= 640 ? 1 : 0,
        );
        const more = page.getByRole('button', { name: `More actions for ${name}`, exact: true });
        await browserExpect(more).toHaveCount(1);
        await browserExpect(more).toBeVisible();
        await browserExpect(
          page.getByRole('combobox', { name: /Sort .* on this page/ }),
        ).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        expect(await page.locator('.readable-list').innerText()).not.toMatch(
          /project-id|grant-id|principal-id|role-id/,
        );
        if (list !== 'projects') {
          await browserExpect(
            page.getByText('Email address hidden', { exact: true }).filter({ visible: true }),
          ).toHaveCount(1);
          const container =
            width <= 640
              ? page.locator('.readable-mobile li').first()
              : page.getByRole('row').nth(1);
          await container.getByText('View permissions (1)', { exact: true }).click();
          await browserExpect(
            container.getByText('Read project details', { exact: false }),
          ).toBeVisible();
          await container.getByText('View permissions (1)', { exact: true }).click();
          if (
            !(await container
              .locator('details')
              .last()
              .evaluate((element: HTMLElement) => (element as HTMLDetailsElement).open))
          )
            await container.locator('summary').last().click();
          await browserExpect(
            container.getByText('2026-10-28T09:30:00.000Z', { exact: false }),
          ).toBeVisible();
        }
        await more.focus();
        await page.keyboard.press('Enter');
        await browserExpect(
          page.getByRole('menuitem', { name: `Copy ID ${name}`, exact: true }),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await browserExpect(more).toBeFocused();
      }
    },
  );
  it.for(['projects', 'organization-grants', 'project-grants'])(
    'confirms the readable target and preserves concurrency for %s',
    async (list, context) => {
      if (!fixture) return context.skip();
      canWrite = true;
      writes.length = 0;
      await fixture.mount(script, { fixtureList: list });
      const { page, browserExpect } = fixture;
      const name = list === 'projects' ? 'Sample Business' : 'dev-all@acme-company.example';
      const action = list === 'projects' ? 'Archive project' : 'Revoke grant';
      const more = page.getByRole('button', { name: `More actions for ${name}`, exact: true });
      await more.click();
      await page.getByRole('menuitem', { name: `${action} ${name}`, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await browserExpect(dialog).toBeVisible();
      await browserExpect(dialog.getByText(name, { exact: true })).toBeVisible();
      expect(await dialog.innerText()).not.toMatch(/project-id|grant-id/);
      if (list !== 'projects')
        await browserExpect(dialog.getByText(/Other grants still apply/)).toBeVisible();
      await page.keyboard.press('Escape');
      await browserExpect(more).toBeFocused();
      expect(writes).toHaveLength(0);
      await more.click();
      await page.getByRole('menuitem', { name: `${action} ${name}`, exact: true }).click();
      await dialog
        .getByRole('button', { name: `Confirm ${action.toLowerCase()}`, exact: true })
        .click();
      await browserExpect(dialog).toHaveCount(0);
      expect(writes).toEqual([
        {
          path:
            list === 'projects'
              ? '/_pb/projects/sample-business/archive'
              : list === 'project-grants'
                ? '/_pb/projects/sample-business/grants/grant-id'
                : '/_pb/grants/grant-id',
          revision: '"r7"',
        },
      ]);
    },
  );
  it.for(['organization-grants', 'project-grants'])(
    'retains Copy ID and permission details for %s readers without mutation controls',
    async (list, context) => {
      if (!fixture) return context.skip();
      canWrite = false;
      await fixture.page.setViewportSize({ width: 1280, height: 900 });
      await fixture.mount(script, { fixtureList: list });
      const { page, browserExpect } = fixture;
      await browserExpect(page.getByRole('button', { name: /^Change role/ })).toHaveCount(0);
      const more = page.getByRole('button', {
        name: 'More actions for dev-all@acme-company.example',
        exact: true,
      });
      await more.click();
      await browserExpect(page.getByRole('menuitem', { name: /^Revoke grant/ })).toHaveCount(0);
      await browserExpect(page.getByRole('menuitem', { name: /^Copy ID/ })).toBeVisible();
      await page.keyboard.press('Escape');
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        const representation = page
          .locator('.readable-desktop, .readable-mobile')
          .filter({ visible: true });
        await browserExpect(representation).toHaveCount(1);
        const grant = representation.locator('tbody > tr, li').filter({
          has: page.getByText('dev-all@acme-company.example', { exact: true }),
        });
        await browserExpect(grant).toHaveCount(1);
        const permissions = grant.getByText('View permissions (1)', { exact: true });
        await browserExpect(permissions).toHaveCount(1);
        await permissions.click();
        const details = grant.locator('details[open]');
        await browserExpect(details).toHaveCount(1);
        await browserExpect(
          details.getByText('Read project details', { exact: false }),
        ).toBeVisible();
        await browserExpect(details.getByText('project:read', { exact: true })).toBeVisible();
      }
    },
  );
  it.for(['projects', 'organization-grants', 'project-grants'])(
    'closes More and focuses its visible equivalent when %s switches layouts',
    async (list, context) => {
      if (!fixture) return context.skip();
      canWrite = true;
      const { page, browserExpect } = fixture;
      await page.setViewportSize({ width: 1440, height: 900 });
      await fixture.mount(script, { fixtureList: list });
      const name = list === 'projects' ? 'Sample Business' : 'dev-all@acme-company.example';
      const more = page.getByRole('button', { name: `More actions for ${name}`, exact: true });
      for (const width of [320, 1440]) {
        await more.click();
        await browserExpect(page.getByRole('menu')).toBeVisible();
        await page.setViewportSize({ width, height: 900 });
        await browserExpect(page.getByRole('menu')).toHaveCount(0);
        await browserExpect(more).toBeVisible();
        await browserExpect(more).toBeFocused();
        await browserExpect(more).toHaveAttribute('aria-expanded', 'false');
      }
    },
  );
  it.for(['organization-grants', 'project-grants'])(
    'wraps long subject, provider and role values in the %s role dialog at 320px',
    async (list, context) => {
      if (!fixture) return context.skip();
      longValues = true;
      canWrite = true;
      const { page, browserExpect } = fixture;
      try {
        await page.setViewportSize({ width: 320, height: 900 });
        await fixture.mount(script, { fixtureList: list });
        await page.getByRole('button', { name: `Change role ${longGroup}`, exact: true }).click();
        const dialog = page.getByRole('dialog');
        await browserExpect(dialog).toBeVisible();
        const description = dialog.locator('p').filter({ hasText: longGroup });
        await browserExpect(description).toContainText(longProvider);
        await browserExpect(description).toContainText(longRole);
        expect(
          await dialog.evaluate((element: HTMLElement) => {
            const description = element.querySelector('[id][class*="text-neutral-600"]')!;
            return (
              getComputedStyle(description).overflowWrap === 'anywhere' &&
              Array.from(element.querySelectorAll('form, form > *, select, p')).every(
                (child) => child.scrollWidth <= child.clientWidth + 1,
              ) &&
              element.scrollWidth <= element.clientWidth + 1 &&
              document.documentElement.scrollWidth <= innerWidth
            );
          }),
        ).toBe(true);
        await browserExpect(
          dialog.getByRole('button', { name: 'Save role', exact: true }),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await browserExpect(
          page.getByRole('button', { name: `Change role ${longGroup}`, exact: true }),
        ).toBeFocused();
      } finally {
        longValues = false;
      }
    },
  );
  it.for([true, false])(
    'announces repeated clipboard results (success: %s)',
    async (success, context) => {
      if (!fixture) return context.skip();
      const { page, browserExpect } = fixture;
      await page.setViewportSize({ width: 1440, height: 900 });
      await fixture.mount(script, { fixtureList: 'projects' });
      await page.evaluate(
        (succeeds: boolean) =>
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
              writeText: async () => {
                if (!succeeds) throw new Error('Clipboard unavailable');
              },
            },
          }),
        success,
      );
      const more = page.getByRole('button', {
        name: 'More actions for Sample Business',
        exact: true,
      });
      const status = page.locator('.readable-desktop [role="status"]');
      const result = success ? 'ID copied.' : 'Could not copy ID.';
      await more.click();
      await page.getByRole('menuitem', { name: 'Copy ID Sample Business', exact: true }).click();
      await browserExpect(status).toHaveText(result);
      await status.evaluate((element: HTMLElement) => {
        const observer = new MutationObserver(() => {
          if (!element.textContent) element.dataset.cleared = 'true';
          else if (element.dataset.cleared) {
            element.dataset.repeated = 'true';
            observer.disconnect();
          }
        });
        observer.observe(element, { childList: true, characterData: true, subtree: true });
      });
      await more.click();
      await page.getByRole('menuitem', { name: 'Copy ID Sample Business', exact: true }).click();
      await browserExpect(status).toHaveText(result);
      await browserExpect(status).toHaveAttribute('data-repeated', 'true');
    },
  );
  it('sorts grants by date on the loaded page and offers the same order on mobile', async (context) => {
    if (!fixture) return context.skip();
    canWrite = true;
    await fixture.page.setViewportSize({ width: 1440, height: 900 });
    await fixture.mount(script, { fixtureList: 'project-grants' });
    const { page, browserExpect } = fixture;
    await page
      .getByRole('combobox', { name: 'Sort Project grants on this page' })
      .selectOption('added:asc');
    await browserExpect(page.getByRole('row').nth(1)).toContainText('Email address hidden');
    await browserExpect(page.getByRole('columnheader', { name: /Added/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await page.getByRole('columnheader', { name: /Added/ }).getByRole('button').click();
    await browserExpect(page.getByRole('row').nth(1)).toContainText('dev-all@acme-company.example');
    await page.setViewportSize({ width: 390, height: 900 });
    await browserExpect(page.locator('.readable-mobile li').first()).toContainText(
      'dev-all@acme-company.example',
    );
    await page
      .getByRole('combobox', { name: 'Sort Project grants on this page' })
      .selectOption('added:asc');
    await browserExpect(page.locator('.readable-mobile li').first()).toContainText(
      'Email address hidden',
    );
  });
  it('announces failed copying and makes the ID manually selectable', async (context) => {
    if (!fixture) return context.skip();
    await fixture.mount(script, { fixtureList: 'projects' });
    const { page, browserExpect } = fixture;
    await page.evaluate(() =>
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error('Clipboard unavailable');
          },
        },
      }),
    );
    await page
      .getByRole('button', { name: 'More actions for Sample Business', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Copy ID Sample Business', exact: true }).click();
    await browserExpect(
      page.getByText('Could not copy ID.', { exact: true }).filter({ visible: true }),
    ).toBeVisible();
    const fallback = page.getByRole('textbox', { name: 'Copy ID manually', exact: true });
    await browserExpect(fallback).toHaveValue('project-id');
    await fallback.focus();
    expect(
      await fallback.evaluate((element: HTMLElement) => (element as HTMLInputElement).selectionEnd),
    ).toBe('project-id'.length);
  });
  it('offers Restore project only with a list ETag and sends it after confirmation', async (context) => {
    if (!fixture) return context.skip();
    canWrite = true;
    projectStatus = 'archived';
    writes.length = 0;
    const { page, browserExpect } = fixture;
    try {
      hasEtag = false;
      await fixture.mount(script, { fixtureList: 'projects', fixtureStatus: 'archived' });
      await page
        .getByRole('button', { name: 'More actions for Sample Business', exact: true })
        .click();
      await browserExpect(page.getByRole('menuitem', { name: /^Restore project/ })).toHaveCount(0);
      await page.keyboard.press('Escape');
      hasEtag = true;
      await fixture.mount(script, { fixtureList: 'projects', fixtureStatus: 'archived' });
      await page
        .getByRole('button', { name: 'More actions for Sample Business', exact: true })
        .click();
      await page
        .getByRole('menuitem', { name: 'Restore project Sample Business', exact: true })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Confirm restore project', exact: true })
        .click();
      await browserExpect(page.getByRole('dialog')).toHaveCount(0);
      expect(writes).toEqual([{ path: '/_pb/projects/sample-business/restore', revision: '"r7"' }]);
    } finally {
      projectStatus = 'active';
      hasEtag = true;
    }
  });
});
