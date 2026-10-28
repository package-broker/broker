import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
let write = true;
let status = 202;
const requests: { path: string; body: unknown }[] = [];
const source = {
  id: 'mirror',
  projectId: null,
  name: 'Packagist',
  ecosystem: 'composer',
  type: 'packagist_proxy',
  status: 'active',
  attached: true,
  precedence: 0,
  lastSuccessAt: null,
  lastError: null,
  lastPolledAt: null,
  nextPollAt: null,
  hasCredential: false,
  removalPolicy: 'flag',
  pollIntervalSeconds: 300,
  url: null,
  lastRemovalRefusal: null,
  removalAcceptanceArmed: false,
};
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { createApiClient } from '../src/api';
    import { PackageSourceControls } from '../src/pages/packages/source-actions';
    const services = { client: createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined }), requireReauth: () => {} };
    createRoot(document.getElementById('root')).render(<PackageSourceControls services={services} project={globalThis.fixtureProject} />);
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
      const path = new URL(request.url).pathname;
      if (request.method === 'POST') {
        const body: unknown = await request.json().catch(() => null);
        requests.push({ path, body });
        return path.endsWith('/sync')
          ? new Response(null, { status: 202 })
          : Response.json(
              { name: 'vendor/name', state: status === 200 ? 'present' : 'queued' },
              { status },
            );
      }
      if (path === '/_pb/me/permissions')
        return Response.json({
          organization: write ? ['org:sources:write', 'org:import:write'] : [],
        });
      if (path.endsWith('/permissions'))
        return Response.json({ project: write ? ['project:sources:write'] : [] });
      if (path === '/_pb/projects/demo')
        return Response.json({ id: 'project', slug: 'demo', name: 'Checkout', status: 'active' });
      if (path === '/_pb/projects')
        return Response.json({
          items: [{ id: 'project', slug: 'demo', name: 'Checkout', status: 'active' }],
          next: null,
        });
      return Response.json({
        items: [
          source,
          {
            ...source,
            id: 'vcs',
            name: 'Acme GitHub',
            type: 'vcs',
            projectId: 'project',
            attached: true,
          },
        ],
        next: null,
      });
    },
  });
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

describe('Packages source actions in Chromium', () => {
  it.for([1440, 1024, 768, 390])(
    'supports keyboard requests and contained layouts at %i px',
    { timeout: 30_000 },
    async (width, context) => {
      context.skip(!fixture, 'Chromium unavailable');
      if (!fixture) return;
      write = true;
      status = 202;
      requests.length = 0;
      const { page, browserExpect } = fixture;
      await page.setViewportSize({ width, height: 850 });
      await fixture.mount(script, { fixtureProject: 'demo' });
      const add = page.getByRole('button', { name: 'Add package', exact: true });
      await add.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog');
      await browserExpect(dialog).toBeVisible();
      await browserExpect(
        dialog.getByRole('link', { name: 'By repository URL', exact: true }),
      ).toHaveAttribute('href', '#/sources?create=vcs&project=demo');
      await browserExpect(
        dialog.getByRole('link', { name: 'Set up a GitHub repository source', exact: true }),
      ).toHaveAttribute('href', '#/sources?create=vcs&project=demo&provider=github');
      await browserExpect(dialog.getByLabel('Ecosystem', { exact: true })).toBeFocused();
      await page.keyboard.press('Tab');
      await browserExpect(
        dialog.getByRole('button', { name: 'From a mirror', exact: true }),
      ).toBeFocused();
      await page.keyboard.press('Enter');
      const select = dialog.getByLabel('Source', { exact: true });
      await select.focus();
      await select.selectOption('mirror');
      await browserExpect(select).toHaveValue('mirror');
      await page.keyboard.press('Tab');
      await browserExpect(dialog.getByLabel('Find a package')).toBeFocused();
      await page.keyboard.type('vendor/name');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      expect(
        await dialog.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
      await page.keyboard.press('Enter');
      await browserExpect(dialog.getByRole('status')).toContainText('Waiting for a worker');
      await browserExpect(dialog.getByRole('status')).toBeFocused();
      expect(requests).toEqual([
        { path: '/_pb/projects/demo/sources/mirror/packages', body: { name: 'vendor/name' } },
      ]);
      await page.keyboard.press('Escape');
      await browserExpect(add).toBeFocused();
      const sync = page.getByRole('button', { name: 'Sync from source', exact: true });
      await sync.focus();
      await page.keyboard.press('Enter');
      await browserExpect(select).toBeFocused();
      await select.selectOption('mirror');
      await browserExpect(select).toHaveValue('mirror');
      await browserExpect(dialog).toContainText('Checks packages already held from this source');
      await browserExpect(dialog).toContainText('This source is shared.');
      await dialog.getByRole('button', { name: 'Request source sync' }).focus();
      await page.keyboard.press('Enter');
      await browserExpect(dialog.getByRole('status')).toContainText('Sync requested');
      expect(requests.at(-1)).toEqual({ path: '/_pb/sources/mirror/sync', body: null });
      await browserExpect(
        dialog.getByRole('button', { name: 'Request source sync' }),
      ).toBeDisabled();
      await page.keyboard.press('Escape');
      await browserExpect(sync).toBeFocused();
    },
  );
  it('shows a field error when the required source is missing', async (context) => {
    context.skip(!fixture, 'Chromium unavailable');
    if (!fixture) return;
    write = true;
    requests.length = 0;
    const { page, browserExpect } = fixture;
    await fixture.mount(script, { fixtureProject: 'demo' });
    await page.getByRole('button', { name: 'Add package', exact: true }).click();
    await page.getByRole('button', { name: 'From a mirror', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const select = dialog.getByLabel('Source', { exact: true });
    await dialog.getByLabel('Find a package').fill('vendor/name');
    await dialog.locator('form').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await browserExpect(select).toHaveValue('');
    await browserExpect(select).toHaveAttribute('aria-invalid', 'true');
    await browserExpect(select).toHaveAttribute('aria-describedby', 'package-source-error');
    await browserExpect(dialog.getByRole('alert')).toHaveText('Choose a source.');
    expect(requests).toEqual([]);
    await select.selectOption('mirror');
    await browserExpect(select).toHaveValue('mirror');
    await browserExpect(select).not.toHaveAttribute('aria-invalid', 'true');
    await browserExpect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Add package', exact: true }).click();
    await page.getByRole('button', { name: 'From a mirror', exact: true }).click();
    await browserExpect(select).toHaveValue('');
    await browserExpect(dialog.getByRole('alert')).toHaveCount(0);
  });
  it('requires an explicit destination and shows already available without claiming a refresh', async (context) => {
    context.skip(!fixture, 'Chromium unavailable');
    if (!fixture) return;
    write = true;
    status = 200;
    requests.length = 0;
    const { page, browserExpect } = fixture;
    await fixture.mount(script, { fixtureProject: null });
    await page.getByRole('button', { name: 'Add package', exact: true }).click();
    await page.getByRole('button', { name: 'From a mirror', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog.getByLabel('Project', { exact: true })).toHaveValue('');
    await browserExpect(
      dialog.getByRole('button', { name: 'Add package', exact: true }),
    ).toHaveCount(0);
    await dialog.getByLabel('Project', { exact: true }).selectOption('demo');
    await dialog.getByLabel('Source', { exact: true }).selectOption('mirror');
    await dialog.getByLabel('Find a package').fill('vendor/name');
    await dialog.getByRole('button', { name: 'Add package', exact: true }).click();
    await browserExpect(dialog.getByRole('status')).toContainText(
      'vendor/name is already available from Packagist.',
    );
    await browserExpect(dialog).not.toContainText('refreshed');
  });
  it('shows explanations and no mutation controls to readers', async (context) => {
    context.skip(!fixture, 'Chromium unavailable');
    if (!fixture) return;
    write = false;
    requests.length = 0;
    const { page, browserExpect } = fixture;
    await fixture.mount(script, { fixtureProject: 'demo' });
    await page.getByRole('button', { name: 'Add package', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await browserExpect(
      dialog.getByRole('button', { name: 'From a mirror', exact: true }),
    ).toHaveCount(0);
    await browserExpect(dialog.getByRole('link')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Sync from source', exact: true }).click();
    await dialog.getByLabel('Source', { exact: true }).selectOption('mirror');
    await browserExpect(dialog).toContainText(
      'An organization source manager can sync this source.',
    );
    await browserExpect(dialog.getByRole('button', { name: 'Request source sync' })).toHaveCount(0);
    expect(requests).toEqual([]);
  });
});
