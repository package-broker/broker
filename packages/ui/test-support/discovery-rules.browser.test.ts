import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
let manager = true;
let failStatus = 0;
let revision = 1;
let name = 'Shared libraries';
const writes: { method: string; body: Record<string, unknown>; revision: string | null }[] = [];
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import React, {useEffect, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {createApiClient} from '../src/api';
      import {DiscoveryRules} from '../src/pages/sources/discovery-rules-view';
      import {DiscoveryPicker} from '../src/pages/packages/discovery-picker-view';
      const services = {client:createApiClient({fetch:window.fetch.bind(window),readCookie:()=>undefined}),requireReauth:()=>{}};
      function App() {
        const [hash, setHash] = useState(window.location.hash);
        useEffect(() => { const update = () => setHash(window.location.hash); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update); }, []);
        return hash === '#/picker' ? <DiscoveryPicker services={services} ecosystem="npm" onBack={()=>{}} onImportingChange={()=>{}}/> : <DiscoveryRules services={services}/>;
      }
      createRoot(document.getElementById('root')).render(<App/>);`,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  script = result.outputFiles[0]!.text;
  fixture = await createBrowserFixture({
    api: async (request) => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/permissions'))
        return Response.json({
          organization: [manager ? 'org:sources:write' : 'org:sources:read'],
        });
      if (path.endsWith('/connections'))
        return Response.json({
          items: [
            {
              credentialId: 'internal-credential',
              installationId: 42,
              sourceNames: ['Acme connection'],
              sourceCount: 1,
            },
          ],
        });
      if (request.method !== 'GET') {
        writes.push({
          method: request.method,
          body:
            request.method === 'DELETE' ? {} : ((await request.json()) as Record<string, unknown>),
          revision: request.headers.get('If-Match'),
        });
        if (failStatus)
          return Response.json(
            {
              error: {
                code: failStatus === 409 ? 'duplicate' : 'conflict',
                message: 'secret-sentinel',
              },
            },
            { status: failStatus },
          );
        return request.method === 'DELETE'
          ? new Response(null, { status: 204 })
          : Response.json({ id: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
      }
      const rule = {
        id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        name,
        ecosystem: 'npm',
        pattern: 'lib*',
        includeForks: false,
        enabled: true,
        intervalSeconds: 86400,
        revision,
        createdAt: '2026-10-31T10:00:00Z',
        updatedAt: '2026-10-31T10:00:00Z',
        completed: {
          lastRunAt: '2026-10-31T10:00:00Z',
          outcome: 'succeeded',
          created: 2,
          existing: 1,
          skipped: 1,
          failed: 0,
          skips: [{ repository: 'acme/old', reason: 'archived' }],
        },
        ...(manager
          ? {
              credentialId: 'internal-credential',
              installationId: 42,
              outcome: 'rate_limited',
              created: 3,
              existing: 2,
              skipped: 1,
              failed: 1,
              remaining: ['acme/pending'],
              cursor: null,
              nextRunAt: '2026-11-05T10:00:00Z',
            }
          : {}),
      };
      return Response.json(
        path.endsWith('/01ARZ3NDEKTSV4RRFFQ69G5FAV') ? rule : { items: [rule], next: null },
      );
    },
  });
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

describe('Discovery rules in Chromium', () => {
  it.for([390, 1280])(
    'retains failed edits, reviews stale settings and confirms deletion at %i px',
    { timeout: 30_000 },
    async (width, context) => {
      context.skip(!fixture, 'Chromium unavailable');
      if (!fixture) return;
      manager = true;
      failStatus = 0;
      revision = 1;
      name = 'Shared libraries';
      writes.length = 0;
      const { page, browserExpect: expect } = fixture;
      await page.setViewportSize({ width, height: 850 });
      await fixture.mount(script);
      await expect(page.getByRole('heading', { name: 'Shared libraries' })).toBeVisible();
      await expect(page.getByText('Waiting for GitHub rate limit', { exact: false })).toBeVisible();
      await expect(page.getByText('internal-credential', { exact: false })).toHaveCount(0);
      await page.getByText('Last-run details', { exact: true }).click();
      await expect(page.getByText('2 created · 1 existing · 1 skipped · 0 failed')).toBeVisible();
      await expect(
        page.getByText('Archived — Archived repositories are not imported.', { exact: false }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'More actions for Shared libraries' }).click();
      await page.getByRole('menuitem', { name: 'Edit Shared libraries', exact: true }).click();
      await expect(page.getByLabel('Name (required)', { exact: true })).toBeFocused();
      await page.getByLabel('Repository name pattern (optional)').fill('future*');
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      ).toBe(false);
      await expect(page.getByRole('status')).toHaveCount(1);
      await expect(
        page.getByText(
          'Changing the connection, ecosystem, pattern or forks restarts the scan. Imported sources stay.',
        ),
      ).toBeVisible();
      failStatus = 409;
      await page.getByRole('button', { name: 'Save rule', exact: true }).click();
      await expect(page.getByRole('alert')).toHaveText(
        'A discovery rule with this name already exists. Choose another name.',
      );
      await expect(page.getByLabel('Repository name pattern (optional)')).toHaveValue('future*');
      await expect(page.getByText('secret-sentinel', { exact: false })).toHaveCount(0);
      failStatus = 412;
      revision = 2;
      name = 'Newer libraries';
      await page.getByRole('button', { name: 'Save rule', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Newer libraries' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save rule', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Use latest settings and review' }).click();
      await expect(page.getByLabel('Repository name pattern (optional)')).toHaveValue('lib*');
      failStatus = 0;
      await page.getByRole('button', { name: 'Save rule', exact: true }).click();
      await expect(page.getByRole('form', { name: 'Edit discovery rule' })).toHaveCount(0);
      await expect(page.getByRole('status')).toBeFocused();
      await page.getByRole('button', { name: 'Run now Newer libraries' }).click();
      await expect(page.getByText('Scan requested.', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: 'More actions for Newer libraries' }).click();
      await page.getByRole('menuitem', { name: /^Delete Newer libraries$/, exact: true }).click();
      await expect(page.getByRole('dialog')).toContainText('Imported sources stay.');
      await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'More actions for Newer libraries' }).click();
      await page.getByRole('menuitem', { name: /^Delete Newer libraries$/, exact: true }).click();
      failStatus = 409;
      await page.getByRole('button', { name: /^Delete rule$/, exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('alert')).toHaveText(
        'A discovery rule with this name already exists. Choose another name.',
      );
      await expect(page.getByRole('alert')).toHaveCount(1);
      failStatus = 0;
      await page.getByRole('button', { name: /^Delete rule$/, exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(
        page.getByRole('heading', { name: 'Discovery rules', exact: true }),
      ).toBeFocused();
      await expect.poll(() => writes.at(-1)?.revision).toBe('"r2"');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect(overflow).toBe(false);
    },
  );
  it(
    'shows only the reader projection and hides every mutation',
    { timeout: 30_000 },
    async (context) => {
      context.skip(!fixture, 'Chromium unavailable');
      if (!fixture) return;
      manager = false;
      name = 'Reader libraries';
      revision = 1;
      failStatus = 0;
      writes.length = 0;
      const { page, browserExpect: expect } = fixture;
      await fixture.mount(script);
      await expect(page.getByRole('heading', { name })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Create discovery rule$/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Run now|More actions/ })).toHaveCount(0);
      await expect(
        page.getByText('Current run information is available to source managers.'),
      ).toBeVisible();
      await expect(page.getByText('internal-credential', { exact: false })).toHaveCount(0);
    },
  );
  it('opens a prefilled rule form from the picker link', { timeout: 30_000 }, async (context) => {
    context.skip(!fixture, 'Chromium unavailable');
    if (!fixture) return;
    manager = true;
    failStatus = 0;
    const { page, browserExpect: expect } = fixture;
    await fixture.mount(script);
    await page.evaluate(() => {
      window.location.hash = '#/picker';
    });
    await page.getByLabel('Repository name pattern (optional)').fill('future*');
    await page.getByLabel('Include forks').check();
    await page.getByRole('link', { name: 'Keep this selection up to date' }).click();
    await expect(page.getByRole('form', { name: 'New discovery rule' })).toBeVisible();
    await expect(page.getByLabel('Repository name pattern (optional)')).toHaveValue('future*');
    await expect(page.getByLabel('Include forks')).toBeChecked();
    await expect(page.getByLabel('Package ecosystem')).toHaveValue('npm');
    await expect(page.getByLabel('GitHub connection (required)')).toHaveValue('0');
  });
});
