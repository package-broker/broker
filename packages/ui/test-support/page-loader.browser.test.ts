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
        import { PageLoader } from './page-loader';
        let resolve, reject;
        let calls = 0;
        const load = () => { calls++; return new Promise((yes, no) => { resolve = yes; reject = no; }); };
        globalThis.failPage = () => reject(new Error('private diagnostic'));
        globalThis.finishPage = () => resolve(() => <h1>Loaded page</h1>);
        globalThis.loadCalls = () => calls;
        const root = createRoot(document.getElementById('root'));
        globalThis.leavePage = () => root.render(<h1>Another page</h1>);
        root.render(<PageLoader load={load} />);`,
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

it('announces loading, hides chunk diagnostics and retries a failed load', async (context) => {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  const { page, browserExpect } = fixture!;
  await fixture!.mount(script);
  await browserExpect(page.getByRole('status')).toHaveText('Loading page…');
  await browserExpect(page.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  await page.evaluate('failPage()');
  await browserExpect(page.getByRole('alert')).toContainText('This page could not be loaded.');
  await browserExpect(page.locator('body')).not.toContainText('private diagnostic');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await browserExpect(page.getByRole('status')).toBeVisible();
  expect(await page.evaluate('loadCalls()')).toBe(2);
  await page.evaluate('finishPage()');
  await browserExpect(page.getByRole('heading', { name: 'Loaded page' })).toBeVisible();
  await browserExpect(page.getByRole('status')).toHaveCount(0);
});

it('ignores completion after navigating away', async (context) => {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  const { page, browserExpect } = fixture!;
  await fixture!.mount(script);
  await browserExpect(page.getByRole('status')).toBeVisible();
  await page.evaluate('leavePage()');
  await browserExpect(page.getByRole('heading', { name: 'Another page' })).toBeVisible();
  await page.evaluate('finishPage()');
  await browserExpect(page.getByRole('heading', { name: 'Loaded page' })).toHaveCount(0);
});
