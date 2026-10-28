import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
let status = 409;
let code = 'duplicate';
let details: { path: string; code: string }[] = [];
const requests: { method: string; body: unknown }[] = [];
const project = {
  id: 'project-id',
  slug: 'saved',
  name: 'Saved name',
  status: 'active',
  revision: 7,
  tokenMaxScope: 'full',
  requirePublishApproval: true,
};
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React, { useSyncExternalStore } from 'react';
        import { createRoot } from 'react-dom/client';
        import { createApiClient } from '../../api';
        import { ProjectsView, createProjectsController } from '../projects';
        const client = createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined });
        const controller = createProjectsController({ client, requireReauth: () => {} });
        function App() {
          const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
          return <ProjectsView state={state} controller={controller} />;
        }
        createRoot(document.getElementById('root')).render(<App />);
        void controller.load({ project: globalThis.fixtureEditing ? 'saved' : null });`,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('../src/pages/projects/', import.meta.url)),
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
      if (request.method !== 'GET') {
        requests.push({
          method: request.method,
          body: await request.json(),
        });
        return status >= 400
          ? Response.json(
              { error: { code, details, message: 'private-server-message' } },
              { status },
            )
          : new Response(null, { status: 204 });
      }
      if (path === '/_pb/me/permissions')
        return Response.json({ organization: ['org:projects:create'] });
      if (path.endsWith('/permissions'))
        return Response.json({ project: ['project:settings:write'] });
      if (path === '/_pb/projects/saved')
        return Response.json(project, { headers: { ETag: '"r7"' } });
      return Response.json({ items: [], next: null });
    },
  });
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

async function mount(editing = false) {
  requests.length = 0;
  status = 409;
  code = 'duplicate';
  details = [];
  await fixture!.mount(script, { fixtureEditing: editing });
  if (!editing) await fixture!.page.getByText('New project', { exact: true }).click();
}
describe('project form browser interactions', () => {
  it('retains failed create values, suggests slugs and restores suggestions', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await mount();
    const form = page.getByRole('form', { name: 'New project', exact: true });
    const name = form.getByLabel('Project name', { exact: true });
    const slug = form.getByLabel('Project slug', { exact: true });
    await name.fill('FastWhiteCat');
    await browserExpect(slug).toHaveValue('fastwhitecat');
    await browserExpect(
      form.getByText(`${fixture!.origin}/fastwhitecat`, { exact: true }),
    ).toBeVisible();
    await slug.fill('chosen');
    await name.fill('New name');
    await browserExpect(slug).toHaveValue('chosen');
    await form.getByRole('button', { name: 'Use suggested slug' }).click();
    await browserExpect(slug).toHaveValue('new-name');
    await name.fill('FastWhiteCat');
    await form.getByRole('button', { name: /^Create project$/ }).click();
    await browserExpect(slug).toBeFocused();
    await browserExpect(slug).toHaveAttribute('aria-invalid', 'true');
    await browserExpect(
      form.getByText('This project slug is already in use. Choose another.'),
    ).toBeVisible();
    expect(requests).toEqual([
      {
        method: 'POST',
        body: { name: 'FastWhiteCat', slug: 'fastwhitecat', tokenMaxScope: 'read' },
      },
    ]);
    await browserExpect(name).toHaveValue('FastWhiteCat');
    await browserExpect(slug).toHaveValue('fastwhitecat');
    await browserExpect(page.getByText('private-server-message')).toHaveCount(0);
    await slug.fill('invalid!');
    await browserExpect(
      form.getByText(`${fixture!.origin}/{project-slug}`, { exact: true }),
    ).toBeVisible();
    await form.getByRole('button', { name: /^Create project$/ }).click();
    expect(requests).toHaveLength(1);
    await browserExpect(slug).toBeFocused();
  });
  it('keeps legacy approval and the edit draft through a stale revision', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await mount(true);
    const form = page.getByRole('form', { name: 'Project settings', exact: true });
    await browserExpect(
      form.getByText(
        'Publish approval is saved as required, but approval is not enforced in this version.',
      ),
    ).toBeVisible();
    await form.locator('summary').click();
    await browserExpect(
      form.getByRole('radio', { name: 'Include grants, sources and audit access', exact: false }),
    ).toBeChecked();
    await form.getByRole('radio', { name: 'Install and download', exact: false }).check();
    await browserExpect(
      form.getByText(
        'This change limits existing personal and service tokens on their next request. Downloads can continue, but access above this limit will stop. Check any CI jobs that use these tokens.',
      ),
    ).toBeVisible();
    await form.getByLabel('Project name', { exact: true }).fill('Draft name');
    status = 412;
    code = 'precondition_failed';
    const pendingRequest = page.waitForRequest(
      (request: { method(): string }) => request.method() === 'PATCH',
    );
    await form.getByRole('button', { name: 'Save settings' }).click();
    const sent = await pendingRequest;
    expect(sent.headers()['if-match']).toBe('"r7"');
    await browserExpect(form.getByRole('status')).toHaveText(
      'This project changed while you were editing. Reload the latest settings before saving.',
    );
    await browserExpect(form.getByLabel('Project name', { exact: true })).toHaveValue('Draft name');
    expect(requests).toEqual([
      { method: 'PATCH', body: { name: 'Draft name', tokenMaxScope: 'read' } },
    ]);
    await browserExpect(form.getByRole('button', { name: 'Save settings' })).toBeDisabled();
  });
  it('opens access policy before focusing a server field error', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await mount();
    const form = page.getByRole('form', { name: 'New project', exact: true });
    await form.getByLabel('Project name', { exact: true }).fill('Valid name');
    status = 400;
    code = 'invalid_request';
    details = [{ path: '/body/tokenMaxScope', code: 'invalid' }];
    await form.getByRole('button', { name: /^Create project$/ }).click();
    await browserExpect(form.locator('details')).toHaveAttribute('open', '');
    await browserExpect(
      form.getByRole('radio', { name: 'Install and download', exact: false }),
    ).toBeFocused();
    await browserExpect(
      form.getByRole('radio', { name: 'Install and download', exact: false }),
    ).toHaveAttribute('aria-invalid', 'true');
  });
  it('focuses the first invalid field and keeps radio keyboard behavior and mobile wrapping', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await page.setViewportSize({ width: 320, height: 700 });
    await mount();
    const form = page.getByRole('form', { name: 'New project', exact: true });
    await form.getByRole('button', { name: /^Create project$/ }).click();
    await browserExpect(form.getByLabel('Project name', { exact: true })).toBeFocused();
    expect(requests).toHaveLength(0);
    await form.locator('summary').click();
    const read = form.getByRole('radio', { name: 'Install and download', exact: false });
    await read.focus();
    await page.keyboard.press('ArrowDown');
    await browserExpect(
      form.getByRole('radio', { name: 'Include publish permission', exact: false }),
    ).toBeChecked();
    await form.locator('summary').click();
    await browserExpect(
      form.getByText('Publish permission included', { exact: true }),
    ).toBeVisible();
    await form.getByLabel('Project name', { exact: true }).fill('a'.repeat(100));
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
});
