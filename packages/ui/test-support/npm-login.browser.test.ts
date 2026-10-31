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
        import { NpmLoginPage } from './pages/npm-login';
        import { ServicesContext } from './auth';
        const first = 'a'.repeat(43);
        let approval;
        globalThis.posts = [];
        globalThis.finishApproval = (ok) => approval({ ok, code: 'unavailable' });
        globalThis.finishReview = () => review({ ok: true, data: {
          project: { name: 'Second', slug: 'second' }, createdAt: '2026-10-31T00:00:00Z', expiresAt: '2026-10-31T00:05:00Z'
        }});
        let review;
        const services = { client: { request: async (method, path, input) => {
          if (method === 'post') { posts.push(input); return new Promise(resolve => approval = resolve); }
          if (path.includes('permissions')) return { ok: true, data: { project: input.params.project === 'first' ? ['project:packages:write'] : [] }};
          if (input.params.selector !== first) return new Promise(resolve => review = resolve);
          return { ok: true, data: { project: { name: 'First', slug: 'first' }, createdAt: '2026-10-31T00:00:00Z', expiresAt: '2026-10-31T00:05:00Z' }};
        }}};
        const root = createRoot(document.getElementById('root'));
        const render = () => root.render(<ServicesContext.Provider value={services}><NpmLoginPage /></ServicesContext.Provider>);
        globalThis.nextSelector = () => { location.hash = '#/npm-login/' + 'b'.repeat(43); render(); };
        location.hash = '#/npm-login/' + first;
        render();`,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  script = bundle.outputFiles[0]!.text;
  fixture = await createBrowserFixture();
}, 60_000);
afterAll(async () => fixture?.close());

it('retries a failed approval with the enabled approval button', async (context) => {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  const { page, browserExpect } = fixture!;
  await fixture!.mount(script);
  await page.getByRole('button', { name: 'Approve login', exact: true }).click();
  await page.evaluate('finishApproval(false)');
  await browserExpect(
    page.getByRole('alert').filter({ hasText: 'Login could not be approved' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Approve login', exact: true }).click();
  await browserExpect(page.getByRole('button', { name: 'Approving login…' })).toBeVisible();
  expect(await page.evaluate('posts.length')).toBe(2);
  await page.evaluate('finishApproval(true)');
  await browserExpect(page.getByRole('status')).toContainText('Login approved');
});

it.for(['ready', 'busy', 'done'])(
  'resets every state on selector change from %s and ignores stale completion',
  async (state, context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await fixture!.mount(script);
    await page.getByLabel('Token access').selectOption('write');
    if (state !== 'ready')
      await page.getByRole('button', { name: 'Approve login', exact: true }).click();
    if (state === 'done') {
      await page.evaluate('finishApproval(true)');
      await browserExpect(page.getByRole('status')).toContainText('Login approved');
    }
    await page.evaluate('nextSelector()');
    await browserExpect(page.getByRole('status')).toContainText('Loading login request');
    await browserExpect(
      page.getByRole('button', { name: 'Approve login', exact: true }),
    ).toHaveCount(0);
    await browserExpect(page.locator('body')).not.toContainText('First (first)');
    if (state === 'busy') await page.evaluate('finishApproval(true)');
    await page.evaluate('finishReview()');
    await browserExpect(page.locator('body')).toContainText('Second (second)');
    await browserExpect(page.getByLabel('Token access')).toHaveValue('read');
    await browserExpect(
      page.getByRole('option', { name: 'Install, download and publish' }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Approve login', exact: true }).click();
    expect(await page.evaluate('posts.at(-1)')).toEqual({
      params: { selector: 'b'.repeat(43) },
      body: { scope: 'read' },
    });
  },
);
