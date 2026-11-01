interface Controller {
  navigate(): void;
  start(target: 'personal', project: null): Promise<void>;
}
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

// eslint-disable-next-line no-restricted-syntax -- Button copy, not SQL.
const createTokenLabel = 'Create token';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
let failIssue = false;
let reauthIssue = false;
let emptyProjects = false;
let failPolicy = false;
let failPublisher = false;
const publisher = {
  id: 'publisher',
  revision: 1,
  packageName: '@scope/widget',
  repository: 'owner/repo',
  workflow: 'publish.yml',
  environment: '',
  refPattern: null,
  disabledAt: null,
  lastUsedAt: null,
};
let organizationPermissions = ['org:service-principals:write', 'org:settings:write'];
let createdPrincipal: {
  id: string;
  name: string;
  projectId: string;
  status: string;
  permissions: string[];
} | null = null;
const writes: { path: string; body: Record<string, unknown> }[] = [];
const secret = 'pb-test-show-once-secret';
const lifetime = {
  personal: { defaultDays: 45, maxDays: 120 },
  service: { defaultDays: 90, maxDays: 180 },
};
const permissions = ['project:read', 'project:packages:read', 'project:tokens:create'];

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { createApiClient } from '../src/api';
      import { TokensView, createTokensController } from '../src/pages/tokens';
      const controller = createTokensController({client: createApiClient({fetch: window.fetch.bind(window), readCookie: () => undefined}), requireReauth: () => {}}, {
        storage: sessionStorage, origin: location.origin, clipboard: async (text) => { globalThis.copied = text; }, navigate: () => {}, newKey: () => crypto.randomUUID(), now: Date.now
      });
      globalThis.controller = controller;
      const root = createRoot(document.getElementById('root'));
      const render = () => root.render(<TokensView state={controller.snapshot()} controller={controller} />);
      controller.subscribe(render);
      render();
      void controller.load(); void controller.identity(); void controller.loadPrincipals();`,
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
      const path = new URL(request.url).pathname;
      if (path.startsWith('/_pb/trusted-publishers')) {
        if (request.method === 'GET') return Response.json({ items: [publisher] });
        writes.push({ path, body: (await request.json()) as Record<string, unknown> });
        return failPublisher
          ? Response.json({ error: { code: 'github_credentials_required' } }, { status: 409 })
          : Response.json(publisher, { status: request.method === 'POST' ? 201 : 200 });
      }
      if (request.method === 'POST') {
        writes.push({ path, body: (await request.json()) as Record<string, unknown> });
        if (path === '/_pb/service-principals') {
          const body = writes.at(-1)!.body;
          createdPrincipal = {
            id: 'created-principal',
            name: String(body.name),
            projectId: String(body.project),
            status: 'active',
            permissions: body.permissions as string[],
          };
          return Response.json(createdPrincipal, { status: 201 });
        }
        if (reauthIssue)
          return Response.json({ error: { code: 'reauth_required' } }, { status: 403 });
        return failIssue
          ? Response.json({ error: { code: 'forbidden', message: secret } }, { status: 403 })
          : Response.json({ id: 'new-token', token: secret }, { status: 201 });
      }
      if (path === '/_pb/session') return Response.json({ user: { id: 'me' } });
      if (path === '/_pb/me/permissions')
        return Response.json({ organization: organizationPermissions });
      if (failPolicy && path.startsWith('/_pb/projects/'))
        return new Response(null, { status: 403 });
      if (path === '/_pb/projects' && emptyProjects)
        return Response.json({ items: [], next: null });
      if (path === '/_pb/projects')
        return Response.json({
          items: [
            { id: 'storefront-id', name: 'Storefront', slug: 'storefront', status: 'active' },
            { id: 'docs-id', name: 'Documentation', slug: 'docs', status: 'active' },
          ],
          next: null,
        });
      if (path.endsWith('/permissions')) return Response.json({ project: permissions });
      if (path === '/_pb/service-principals')
        return Response.json({
          items: [
            ...(createdPrincipal ? [createdPrincipal] : []),
            {
              id: 'ci-principal',
              name: 'Storefront build',
              projectId: 'storefront-id',
              status: 'active',
              permissions: ['project:read', 'project:packages:read'],
            },
            {
              id: 'org-principal',
              name: 'Organization robot',
              projectId: null,
              status: 'active',
              permissions,
            },
          ],
          next: null,
        });
      if (path.includes('/projects/') && !path.endsWith('/tokens'))
        return Response.json({ tokenMaxScope: 'read' });
      return Response.json({ items: [], next: null, lifetime });
    },
  });
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

async function enterButton(name: string) {
  const { page } = fixture!;
  await page.getByRole('button', { name, exact: true }).focus();
  await page.keyboard.press('Enter');
}

describe('guided token browser flows', () => {
  beforeEach(() => {
    failIssue = false;
    reauthIssue = false;
    emptyProjects = false;
    failPolicy = false;
    failPublisher = false;
    organizationPermissions = ['org:service-principals:write', 'org:settings:write'];
    createdPrincipal = null;
    writes.length = 0;
  });

  it.for([1440, 1024, 768, 390, 320])(
    'keeps publisher controls after the token list and supports keyboard create, edit and focus at %i px',
    { timeout: 30_000 },
    async (width, context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      organizationPermissions.push('org:packages:publish');
      await page.setViewportSize({ width, height: 900 });
      await fixture!.mount(script);
      const details = page.locator('details#trusted-publishers');
      const summary = page.locator('details#trusted-publishers > summary');
      await browserExpect(summary).toBeVisible();
      expect(await details.evaluate((node: Element) => (node as HTMLDetailsElement).open)).toBe(
        false,
      );
      expect(
        await page
          .getByLabel('Name (this page)')
          .evaluate(
            (node: Element) =>
              !!(
                node.compareDocumentPosition(document.getElementById('trusted-publishers')!) &
                Node.DOCUMENT_POSITION_FOLLOWING
              ),
          ),
      ).toBe(true);
      expect(
        await details.evaluate(
          (node: Element) =>
            !!(
              node.compareDocumentPosition(
                [...document.querySelectorAll('summary')].find(
                  (summary) => summary.textContent === 'Service principals',
                )!,
              ) & Node.DOCUMENT_POSITION_FOLLOWING
            ),
        ),
      ).toBe(true);
      await summary.focus();
      await page.keyboard.press('Enter');
      await browserExpect(details.getByRole('form')).toHaveCount(0);
      await browserExpect(
        page.getByRole('button', { name: 'Add trusted publisher' }),
      ).toBeEnabled();
      await page.keyboard.press('Tab');
      await browserExpect(
        page.getByRole('button', { name: 'Add trusted publisher' }),
      ).toBeFocused();
      await page.keyboard.press('Enter');
      const packageName = page.getByLabel('npm package', { exact: true });
      await browserExpect(packageName).toBeFocused();
      await packageName.fill('@scope/widget');
      await page.getByLabel('GitHub repository (owner/name)', { exact: true }).fill('owner/repo');
      await page.getByLabel('Workflow filename', { exact: true }).fill('publish.yml');
      failPublisher = true;
      await enterButton('Save trusted publisher');
      await browserExpect(details.getByRole('status')).toContainText('Configure a GitHub source');
      await browserExpect(packageName).toHaveValue('@scope/widget');
      failPublisher = false;
      await enterButton('Save trusted publisher');
      await browserExpect(
        page.getByRole('button', { name: 'Add trusted publisher' }),
      ).toBeFocused();
      await browserExpect(details.getByRole('form')).toHaveCount(0);
      expect(writes.at(-1)).toEqual({
        path: '/_pb/trusted-publishers',
        body: {
          packageName: '@scope/widget',
          repository: 'owner/repo',
          workflow: 'publish.yml',
          environment: '',
        },
      });
      await enterButton('Add trusted publisher');
      await enterButton('Cancel');
      await browserExpect(
        page.getByRole('button', { name: 'Add trusted publisher' }),
      ).toBeFocused();
      await enterButton('Edit publisher');
      await browserExpect(packageName).toBeFocused();
      await enterButton('Cancel edit');
      await browserExpect(page.getByRole('button', { name: 'Edit publisher' })).toBeFocused();
      await enterButton('Edit publisher');
      await enterButton('Save trusted publisher');
      await browserExpect(
        page.getByRole('button', { name: 'Add trusted publisher' }),
      ).toBeFocused();
      expect(writes.at(-1)?.path).toBe('/_pb/trusted-publishers/publisher');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    },
  );

  it('opens publishers when the URL targets the section without opening its create form', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    organizationPermissions.push('org:packages:publish');
    await fixture!.mount(script);
    await page.evaluate(() => {
      location.hash = '/tokens?section=trusted-publishers';
    });
    await browserExpect(page.getByRole('button', { name: 'Add trusted publisher' })).toBeVisible();
    await browserExpect(page.locator('#trusted-publishers form')).toHaveCount(0);
    await page.evaluate(() => {
      location.hash = '';
    });
  });

  it.for([1440, 1024, 768, 390])(
    'creates a CI token by keyboard and copies every setup block at %i px',
    { timeout: 30_000 },
    async (width, context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      writes.length = 0;
      failIssue = false;
      await page.setViewportSize({ width, height: 900 });
      await fixture!.mount(script);
      await enterButton('New token');
      await page.getByLabel('Token name', { exact: true }).fill('Storefront CI');
      await browserExpect(
        page.getByRole('option', { name: 'Storefront', exact: true }),
      ).toHaveCount(1);
      await page.getByLabel('Project', { exact: true }).selectOption('storefront');
      await browserExpect(page.getByLabel('Project', { exact: true })).toHaveValue('storefront');
      await page.getByLabel('Service identity', { exact: true }).selectOption('ci-principal');
      await browserExpect(page.getByLabel('Service identity', { exact: true })).toHaveValue(
        'ci-principal',
      );
      await page.getByLabel('Token list', { exact: true }).selectOption('organization');
      await browserExpect(page.getByLabel('Token name', { exact: true })).toHaveValue(
        'Storefront CI',
      );
      await browserExpect(page.getByLabel('Project', { exact: true })).toHaveValue('storefront');
      await browserExpect(page.getByLabel('Service identity', { exact: true })).toHaveValue(
        'ci-principal',
      );
      await browserExpect(page.getByRole('option', { name: 'Organization robot' })).toHaveCount(0);
      await browserExpect(
        page.getByRole('radio', { name: 'Include publish permission', exact: true }),
      ).toBeDisabled();
      await browserExpect(page.getByLabel('Expires after', { exact: true })).toHaveValue('90');
      await enterButton(createTokenLabel);
      await browserExpect(page.getByRole('heading', { name: 'Token created' })).toBeFocused();
      expect(writes[0]).toEqual({
        path: '/_pb/projects/storefront/tokens',
        body: {
          name: 'Storefront CI',
          scope: 'read',
          lifetimeDays: 90,
          servicePrincipalId: 'ci-principal',
        },
      });
      await page.getByText('npm', { exact: true }).click();
      await page.getByText('CI environment', { exact: true }).click();
      for (const label of [
        'Copy token',
        'Copy Composer configuration',
        'Copy auth.json',
        'Copy npm configuration',
        'Copy CI Composer',
        'Copy CI npm',
      ]) {
        await enterButton(label);
        const copied = await page.evaluate(
          () => (globalThis as typeof globalThis & { copied: string }).copied,
        );
        if (label === 'Copy token') expect(copied).toBe(secret);
        if (label === 'Copy auth.json')
          expect(Object.values(JSON.parse(copied).bearer)).toEqual([secret]);
        if (label.includes('CI')) {
          expect(copied).toContain('PACKAGE_BROKER_TOKEN');
          expect(copied).not.toContain(secret);
        }
        if (label === 'Copy npm configuration') expect(copied.split('\n')).toHaveLength(2);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      if (width === 1440) {
        await page.evaluate(() => {
          document.body.style.zoom = '2';
        });
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await page.evaluate(() => {
          document.body.style.zoom = '';
        });
      }
      expect(
        await page.evaluate(() =>
          JSON.stringify({
            local: { ...localStorage },
            session: { ...sessionStorage },
            url: location.href,
          }),
        ),
      ).not.toContain(secret);
      await enterButton('Done');
      await browserExpect(
        page.getByRole('button', { name: 'New token', exact: true }),
      ).toBeFocused();
      await browserExpect(page.getByText(secret, { exact: true })).toHaveCount(0);
    },
  );

  it(
    'keeps personal drafts and errors, selects named projects and keeps result during refresh',
    { timeout: 30_000 },
    async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await fixture!.mount(script);
      writes.length = 0;
      await enterButton('New token');
      await page.getByRole('radio', { name: 'Me', exact: true }).focus();
      await page.keyboard.press('Space');
      await browserExpect(page.getByLabel('Service identity', { exact: true })).toHaveCount(0);
      await page.getByLabel('Token name', { exact: true }).fill('My laptop');
      await page.getByRole('checkbox', { name: 'Storefront', exact: true }).focus();
      await page.keyboard.press('Space');
      await page.getByRole('radio', { name: 'A CI pipeline or service', exact: true }).focus();
      await page.keyboard.press('Space');
      await page.getByRole('radio', { name: 'Me', exact: true }).focus();
      await page.keyboard.press('Space');
      await browserExpect(page.getByLabel('Token name', { exact: true })).toHaveValue('My laptop');
      await browserExpect(
        page.getByRole('checkbox', { name: 'Storefront', exact: true }),
      ).toBeChecked();
      await browserExpect(page.getByLabel('Expires after', { exact: true })).toHaveValue('45');
      await browserExpect(
        page.getByText('Storefront allows install and download only.', { exact: true }),
      ).toBeVisible();
      failIssue = true;
      await enterButton(createTokenLabel);
      await browserExpect(
        page.getByRole('status').filter({ hasText: 'Unable to update tokens' }),
      ).toBeVisible();
      await browserExpect(page.getByLabel('Token name', { exact: true })).toHaveValue('My laptop');
      await browserExpect(page.getByText(secret, { exact: true })).toHaveCount(0);
      failIssue = false;
      await enterButton(createTokenLabel);
      await browserExpect(page.getByRole('heading', { name: 'Token created' })).toBeVisible();
      expect(writes.at(-1)).toEqual({
        path: '/_pb/me/tokens',
        body: {
          name: 'My laptop',
          scope: 'read',
          lifetimeDays: 45,
          projectMode: 'selected',
          projectIds: ['storefront-id'],
        },
      });
      await browserExpect(page.getByLabel('Configure for project')).toHaveValue('storefront');
      await enterButton('Reload tokens');
      await browserExpect(page.getByText(secret, { exact: true })).toBeVisible();
      await enterButton('Done');
    },
  );
  it('focuses summary errors without changing the hash or losing the draft', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await fixture!.mount(script);
    await enterButton('New token');
    await page.getByLabel('Token name', { exact: true }).fill('Keep this draft');
    const hash = await page.evaluate(() => location.hash);
    await enterButton(createTokenLabel);
    await page.getByRole('button', { name: 'Choose a project first.', exact: true }).click();
    await browserExpect(page.getByLabel('Project', { exact: true })).toBeFocused();
    expect(await page.evaluate(() => location.hash)).toBe(hash);
    await browserExpect(page.getByLabel('Token name', { exact: true })).toHaveValue(
      'Keep this draft',
    );
  });

  it.for(['confirm', 'decline'] as const)(
    'retains the guided draft after reauthentication %s and keeps the list target',
    { timeout: 30_000 },
    async (action, context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      failIssue = false;
      reauthIssue = true;
      await fixture!.mount(script);
      await enterButton('New token');
      await page.getByRole('radio', { name: 'Me', exact: true }).check();
      await page.getByLabel('Token name', { exact: true }).fill('Reauth laptop');
      await page.getByRole('radio', { name: 'All projects I can access', exact: true }).check();
      await page.getByLabel('Expires after', { exact: true }).selectOption('120');
      await page.getByLabel('Token list', { exact: true }).selectOption('organization');
      await browserExpect(page.getByLabel('Expires after', { exact: true })).toBeEnabled();
      await enterButton(createTokenLabel);
      await browserExpect(
        page.getByRole('status').filter({ hasText: 'Confirm your identity' }),
      ).toBeVisible();
      await page.evaluate(async () => {
        const c = (globalThis as typeof globalThis & { controller: Controller }).controller;
        c.navigate();
        await c.start('personal', null);
      });
      await browserExpect(
        page.getByRole('region', { name: 'Confirm token issue', exact: true }),
      ).toBeVisible();
      reauthIssue = false;
      if (action === 'confirm') {
        await enterButton('Confirm token issue');
        await browserExpect(page.getByRole('heading', { name: 'Token created' })).toBeVisible();
        await enterButton('Done');
      } else
        await page
          .getByRole('region', { name: 'Confirm token issue', exact: true })
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
      await browserExpect(page.getByLabel('Token name', { exact: true })).toHaveValue(
        'Reauth laptop',
      );
      await browserExpect(page.getByLabel('Expires after', { exact: true })).toHaveValue('120');
      await browserExpect(page.getByLabel('Token list', { exact: true })).toHaveValue(
        'organization',
      );
    },
  );

  it('allows all-project personal issuance with no projects', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    emptyProjects = true;
    failIssue = false;
    await fixture!.mount(script);
    await enterButton('New token');
    await page.getByRole('radio', { name: 'Me', exact: true }).check();
    await page.getByLabel('Token name', { exact: true }).fill('Future access');
    await page.getByRole('radio', { name: 'All projects I can access', exact: true }).check();
    await enterButton(createTokenLabel);
    await browserExpect(page.getByRole('heading', { name: 'Token created' })).toBeVisible();
    expect(writes.at(-1)?.body.projectIds).toEqual([]);
    emptyProjects = false;
  });

  it('allows all-project personal issuance despite failed selected-project permissions and offers retry', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    failPolicy = true;
    await fixture!.mount(script);
    await enterButton('New token');
    await page.getByRole('radio', { name: 'Me', exact: true }).check();
    await page.getByLabel('Token name', { exact: true }).fill('All access');
    await page.getByRole('checkbox', { name: 'Storefront', exact: true }).check();
    await browserExpect(
      page.getByRole('button', { name: 'Try again loading project access' }),
    ).toBeVisible();
    await page.getByRole('radio', { name: 'All projects I can access', exact: true }).check();
    await browserExpect(
      page.getByRole('button', { name: 'Try again loading project access' }),
    ).toBeVisible();
    await enterButton(createTokenLabel);
    await browserExpect(page.getByRole('heading', { name: 'Token created' })).toBeVisible();
    failPolicy = false;
  });
  it('creates a standalone principal with presets and preselects it in the main issuance form', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    createdPrincipal = null;
    failPolicy = false;
    failIssue = false;
    reauthIssue = false;
    await fixture!.mount(script);
    await page.locator('summary', { hasText: 'Service principals' }).click();
    await enterButton('New service principal');
    const form = page.getByRole('form', { name: 'New service principal', exact: true });
    await form.getByLabel('Service identity name', { exact: true }).fill('ci-test');
    await form.getByLabel('Project', { exact: true }).selectOption('storefront-id');
    const packages = form.getByRole('checkbox', { name: /^Install and download packages/ });
    await browserExpect(packages).toBeEnabled();
    await form.getByRole('button', { name: 'Read project records', exact: true }).click();
    await browserExpect(packages).not.toBeChecked();
    await browserExpect(
      form.getByText(
        'To issue an Install and download token, also select Install and download packages.',
        { exact: true },
      ),
    ).toBeVisible();
    await form.getByRole('button', { name: 'Install packages', exact: true }).click();
    await browserExpect(packages).toBeChecked();
    // eslint-disable-next-line no-restricted-syntax -- Button copy, not SQL.
    await form.getByRole('button', { name: 'Create service principal', exact: true }).click();
    await browserExpect(
      page
        .getByText('Service principal created. Create a token to use it.', { exact: true })
        .last(),
    ).toBeVisible();
    expect(writes.at(-1)?.body).toEqual({
      name: 'ci-test',
      project: 'storefront-id',
      permissions: ['project:read', 'project:packages:read'],
    });
    await enterButton(createTokenLabel);
    await browserExpect(page.getByLabel('Service identity', { exact: true })).toHaveValue(
      'created-principal',
    );
    await browserExpect(page.getByLabel('Project', { exact: true })).toHaveValue('storefront');
  });
  it(
    'offers organization-wide levels by the conferred permissions and configures every project',
    { timeout: 30_000 },
    async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      organizationPermissions = [
        'org:service-principals:write',
        'org:settings:write',
        'project:read',
        'project:packages:read',
      ];
      await fixture!.mount(script);
      await enterButton('New token');
      await page.getByLabel('Token name', { exact: true }).fill('Org robot');
      await page.getByLabel('Project', { exact: true }).selectOption('__organization');
      await page.getByLabel('Service identity', { exact: true }).selectOption('org-principal');
      const read = page.getByRole('radio', { name: 'Install and download', exact: true });
      await browserExpect(read).toBeEnabled();
      await browserExpect(
        page.getByRole('radio', { name: 'Include publish permission', exact: true }),
      ).toBeDisabled();
      await read.check();
      await enterButton(createTokenLabel);
      await browserExpect(page.getByRole('heading', { name: 'Token created' })).toBeVisible();
      expect(writes.at(-1)).toMatchObject({ path: '/_pb/tokens', body: { scope: 'read' } });
      await browserExpect(
        page.getByText('Org robot · Organization-wide · Install and download'),
      ).toBeVisible();
      await browserExpect(
        page.locator('#configure-project option[value="storefront"]'),
      ).toHaveCount(1);
      await browserExpect(page.locator('#configure-project option[value="docs"]')).toHaveCount(1);
    },
  );

  it(
    'submits the service principal form on Enter and reports why it cannot proceed',
    { timeout: 30_000 },
    async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await fixture!.mount(script);
      await page.locator('summary', { hasText: 'Service principals' }).click();
      await enterButton('New service principal');
      const form = page.getByRole('form', { name: 'New service principal', exact: true });
      // eslint-disable-next-line no-restricted-syntax -- Button copy, not SQL.
      const submit = form.getByRole('button', { name: 'Create service principal', exact: true });
      await browserExpect(submit).toBeEnabled();
      await form.getByLabel('Service identity name', { exact: true }).fill('ci-enter');
      await page.keyboard.press('Enter');
      await browserExpect(
        form.getByRole('alert').getByRole('button', { name: 'Choose a project.' }),
      ).toBeVisible();
      failPolicy = true;
      await form.getByLabel('Project', { exact: true }).selectOption('storefront-id');
      await browserExpect(
        form.getByRole('button', { name: 'Try again loading project access' }),
      ).toBeVisible();
      await browserExpect(submit).toBeEnabled();
      await page.getByLabel('Service identity name', { exact: true }).press('Enter');
      await browserExpect(
        form.getByRole('alert').getByRole('button', {
          name: 'Project access could not be loaded. Try again.',
        }),
      ).toBeVisible();
      expect(writes).toHaveLength(0);
    },
  );

  it(
    'announces removed permissions only when the project change removed some',
    { timeout: 30_000 },
    async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      organizationPermissions = ['org:service-principals:write', 'org:settings:write', 'org:read'];
      await fixture!.mount(script);
      await page.locator('summary', { hasText: 'Service principals' }).click();
      await enterButton('New service principal');
      const form = page.getByRole('form', { name: 'New service principal', exact: true });
      await form.getByLabel('Project', { exact: true }).selectOption('organization');
      await browserExpect(page.getByText('Incompatible permissions were removed.')).toHaveCount(0);
      await form.getByRole('checkbox', { name: /^Read organization details/ }).check();
      await form.getByLabel('Project', { exact: true }).selectOption('storefront-id');
      await browserExpect(page.getByText(/Incompatible permissions were removed\./)).toBeVisible();
    },
  );

  it(
    'shows no per-project lines for all accessible projects and marks the invalid radios',
    { timeout: 30_000 },
    async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await fixture!.mount(script);
      await enterButton('New token');
      await page.getByRole('radio', { name: 'Me', exact: true }).check();
      await page.getByLabel('Token name', { exact: true }).fill('Everything');
      await page.getByRole('radio', { name: 'All projects I can access', exact: true }).check();
      await browserExpect(page.getByText(/allows install and download only/)).toHaveCount(0);
      await browserExpect(page.getByText(/has not been loaded/)).toHaveCount(0);
      await browserExpect(page.getByText('Everything · All projects I can access')).toBeVisible();
      await page.getByRole('radio', { name: 'Choose projects', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Storefront', exact: true }).check();
      failPolicy = true;
      await page.getByRole('button', { name: 'Try again loading project access' }).click();
      await enterButton(createTokenLabel);
      await browserExpect(page.getByRole('alert').getByRole('button')).toBeVisible();
      await browserExpect(page.locator('fieldset[aria-invalid]')).toHaveCount(0);
      await browserExpect(page.locator('input[name="access"][aria-invalid="true"]')).toHaveCount(3);
    },
  );

  it(
    'reopens the form for a repeated principal choice and flags a missing project',
    { timeout: 30_000 },
    async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await fixture!.mount(script);
      const choose = (project: string | null, organization: boolean) =>
        page.evaluate(
          ([slug, org]: readonly [string | null, boolean]) =>
            (
              globalThis as typeof globalThis & {
                controller: {
                  choosePrincipal(id: string, slug: string | null, org: boolean): void;
                };
              }
            ).controller.choosePrincipal('ci-principal', slug, org),
          [project, organization] as const,
        );
      await choose('storefront', false);
      await browserExpect(page.getByLabel('Project', { exact: true })).toHaveValue('storefront');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(page.getByLabel('Project', { exact: true })).toHaveCount(0);
      await choose('storefront', false);
      await browserExpect(page.getByLabel('Project', { exact: true })).toHaveValue('storefront');
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await choose(null, false);
      await browserExpect(page.getByLabel('Project', { exact: true })).toHaveValue('');
      await browserExpect(page.getByText(/Project name unavailable/)).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    },
  );
});
