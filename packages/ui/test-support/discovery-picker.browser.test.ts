import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
let connected = true;
let manager = true;
let retry = false;
let holdApply: (() => Promise<void>) | null = null;
const gets: string[] = [];
const requests: { path: string; body: Record<string, unknown> }[] = [];
const reasons = [
  'fork',
  'archived',
  'no_manifest',
  'invalid_name',
  'name_public',
  'name_public_unverified',
  'claim_overlap',
  'filtered_out',
  'error_451',
  'error_404',
  'unsupported_ecosystem',
];
beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
      import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {createApiClient} from '../src/api';
      import {PackageSourceControls} from '../src/pages/packages/source-actions';
      const services = {client: createApiClient({fetch: window.fetch.bind(window), readCookie: () => undefined}), requireReauth: () => {}};
      createRoot(document.getElementById('root')).render(<PackageSourceControls services={services} project={null}/>);
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
  script = result.outputFiles[0]!.text;
  fixture = await createBrowserFixture({
    api: async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET') gets.push(path);
      if (path === '/_pb/me/permissions')
        return Response.json({
          organization: manager ? ['org:sources:write', 'org:import:write'] : [],
        });
      if (path.endsWith('/connections'))
        return Response.json({
          items: connected
            ? [
                {
                  credentialId: '01JA0000000000000000000001',
                  installationId: 42,
                  sourceNames: ['Acme libraries'],
                  sourceCount: 1,
                },
              ]
            : [],
        });
      if (request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        requests.push({ path, body });
        if (path.endsWith('/plan'))
          return Response.json({
            entries: body.cursor
              ? [
                  {
                    repository: 'acme/next',
                    ecosystem: body.ecosystem,
                    packageName: '@acme/next',
                    action: 'new',
                    reason: null,
                  },
                ]
              : [
                  ...Array.from({ length: 21 }, (_, i) => ({
                    repository: `acme/repo${i}`,
                    ecosystem: body.ecosystem,
                    packageName: `@acme/pkg${i}`,
                    action: 'new',
                    reason: null,
                  })),
                  {
                    repository: 'acme/existing',
                    ecosystem: body.ecosystem,
                    packageName: '@acme/existing',
                    action: 'existing',
                    reason: null,
                  },
                  ...reasons.map((reason) => ({
                    repository: `acme/${reason}`,
                    ecosystem: body.ecosystem,
                    packageName: null,
                    action: 'skipped',
                    reason,
                  })),
                ],
            nextCursor: body.cursor ? null : '2',
          });
        if (holdApply) await holdApply();
        const repositories = body.repositories as string[];
        const repository = repositories[0]!;
        const outcome = repository === 'acme/repo1' && !retry ? 'failed' : 'created';
        return Response.json({
          created: outcome === 'created' ? 1 : 0,
          existing: 0,
          skipped: 0,
          failed: outcome === 'failed' ? 1 : 0,
          results: [
            { repository, outcome, ...(outcome === 'failed' ? { error: 'secret-sentinel' } : {}) },
          ],
          remainingRepositories: repositories.slice(1),
          nextCursor: body.nextCursor,
        });
      }
      return Response.json({ items: [], next: null });
    },
  });
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

describe('GitHub organization picker in Chromium', () => {
  it.for([390, 1280])(
    'supports keyboard preview, bounded selection, continuation and retry at %i px',
    { timeout: 30_000 },
    async (width, context) => {
      context.skip(!fixture, 'Chromium unavailable');
      if (!fixture) return;
      connected = true;
      manager = true;
      retry = false;
      requests.length = 0;
      const { page, browserExpect } = fixture;
      await page.setViewportSize({ width, height: 850 });
      await fixture.mount(script);
      await page.getByRole('button', { name: 'Add package', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByLabel('Ecosystem', { exact: true }).selectOption('npm');
      await browserExpect(dialog).not.toContainText('Import configuration');
      const choose = dialog.getByRole('button', {
        name: 'Choose GitHub repositories',
        exact: true,
      });
      await choose.focus();
      await page.keyboard.press('Enter');
      const connection = dialog.getByLabel('GitHub connection', { exact: true });
      await browserExpect(connection).toBeVisible();
      await browserExpect(connection).toBeFocused();
      await browserExpect(connection).toContainText('Acme libraries · Installation 42');
      await browserExpect(dialog).not.toContainText('01JA0000000000000000000001');
      await connection.focus();
      await page.keyboard.press('Tab');
      await browserExpect(dialog.getByLabel('Repository name pattern (optional)')).toBeFocused();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Space');
      await browserExpect(dialog.getByLabel('Include forks')).toBeChecked();
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await browserExpect(
        dialog.getByRole('region', { name: 'Will be added', exact: true }),
      ).toBeVisible();
      await browserExpect(
        dialog.getByRole('heading', { name: 'Repository preview', exact: true }),
      ).toBeFocused();
      expect(requests[0]?.body).toMatchObject({
        ecosystem: 'npm',
        pattern: '*',
        includeForks: true,
        cursor: null,
      });
      await dialog.getByLabel(/^Select all on page \(up to 20\)$/).check();
      await browserExpect(
        dialog.getByRole('button', { name: 'Import selected (20)', exact: true }),
      ).toBeEnabled();
      await browserExpect(dialog.getByLabel('acme/repo20', { exact: true })).toBeDisabled();
      await browserExpect(dialog.getByRole('status')).toContainText('20 repository limit reached');
      await dialog.getByLabel(/^Select all on page \(up to 20\)$/).uncheck();
      await dialog.getByLabel('acme/repo0', { exact: true }).check();
      await browserExpect(dialog.getByLabel(/^Select all on page/)).toBeChecked({
        indeterminate: true,
      });
      await dialog.getByLabel('acme/repo1', { exact: true }).check();
      await browserExpect(
        dialog.getByRole('region', { name: 'Already added', exact: true }),
      ).toContainText('No new source will be created.');
      await browserExpect(
        dialog.getByRole('region', { name: 'Skipped', exact: true }),
      ).toContainText('Name could not be verified');
      expect(
        await dialog.evaluate((node: HTMLElement) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await dialog.getByRole('button', { name: 'Import selected (2)', exact: true }).click();
      await browserExpect(dialog.getByRole('status')).toContainText(
        '2 of 2 repositories processed',
      );
      const results = dialog.getByRole('region', { name: 'Import results', exact: true });
      await browserExpect(results).toContainText('acme/repo0 · Created');
      await browserExpect(results).toContainText('acme/repo1 · Failed');
      await browserExpect(dialog).not.toContainText('secret-sentinel');
      expect(
        requests.filter((r) => r.path.endsWith('/apply')).map((r) => r.body.repositories),
      ).toEqual([['acme/repo0', 'acme/repo1'], ['acme/repo1']]);
      retry = true;
      await dialog.getByRole('button', { name: 'Retry failed repositories' }).click();
      await browserExpect(results).toContainText('acme/repo1 · Created');
      await dialog.getByRole('button', { name: 'Load more', exact: true }).click();
      await browserExpect(dialog.getByLabel('acme/next', { exact: true })).toBeVisible();
      expect(requests.at(-1)?.body.cursor).toBe('2');
      await browserExpect(
        dialog.getByRole('heading', { name: 'Repository preview', exact: true }),
      ).toBeFocused();
      await browserExpect(results).toContainText('acme/repo0 · Created');
      await browserExpect(
        dialog.getByRole('button', { name: 'Load more', exact: true }),
      ).toHaveCount(0);
    },
  );
  it('preserves editable patterns, focuses errors, keeps results across settings and offers Start over and Back', async (context) => {
    context.skip(!fixture, 'Chromium unavailable');
    if (!fixture) return;
    connected = true;
    manager = true;
    const { page, browserExpect } = fixture;
    await fixture.mount(script);
    await page.getByRole('button', { name: 'Add package', exact: true }).click();
    await page.getByRole('button', { name: 'Choose GitHub repositories', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const pattern = dialog.getByLabel('Repository name pattern (optional)');
    await pattern.fill('');
    await browserExpect(pattern).toHaveValue('');
    await pattern.fill('invalid/name');
    await dialog.getByRole('button', { name: 'Preview repositories', exact: true }).click();
    await browserExpect(pattern).toBeFocused();
    await browserExpect(pattern).toHaveAttribute('aria-invalid', 'true');
    await browserExpect(pattern).toHaveAttribute(
      'aria-describedby',
      'discovery-pattern-help discovery-pattern-error',
    );
    await browserExpect(dialog.locator('#discovery-pattern-error')).toContainText(
      'Enter a repository name pattern',
    );
    await pattern.fill('');
    await dialog.getByRole('button', { name: 'Preview repositories', exact: true }).click();
    await dialog.getByLabel('acme/repo0', { exact: true }).check();
    let release!: () => void;
    holdApply = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    try {
      await dialog.getByRole('button', { name: 'Import selected (1)', exact: true }).click();
      await browserExpect(dialog).toContainText('Wait for this batch to finish before closing');
      await browserExpect.poll(() => typeof release).toBe('function');
      await page.keyboard.press('Escape');
      await browserExpect(dialog).toBeVisible();
      await browserExpect(dialog.getByRole('button', { name: 'Back', exact: true })).toBeDisabled();
      await browserExpect(
        dialog.getByRole('button', { name: 'Start over', exact: true }),
      ).toBeDisabled();
    } finally {
      holdApply = null;
      release();
    }
    const results = dialog.getByRole('region', { name: 'Import results', exact: true });
    await browserExpect(results).toContainText('acme/repo0 · Created');
    await pattern.fill('other*');
    await browserExpect(pattern).toBeFocused();
    await browserExpect(results).toContainText('acme/repo0 · Created');
    await dialog.getByRole('button', { name: 'Start over', exact: true }).click();
    await browserExpect(results).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Back', exact: true }).click();
    await browserExpect(
      dialog.getByRole('button', { name: 'Choose GitHub repositories', exact: true }),
    ).toBeVisible();
  });
  it('explains how to establish a connection and hides the picker from readers', async (context) => {
    context.skip(!fixture, 'Chromium unavailable');
    if (!fixture) return;
    const { page, browserExpect } = fixture;
    manager = true;
    connected = false;
    requests.length = 0;
    await fixture.mount(script);
    await page.getByRole('button', { name: 'Add package', exact: true }).click();
    await page.getByRole('button', { name: 'Choose GitHub repositories', exact: true }).click();
    await browserExpect(page.getByRole('dialog')).toContainText('GitHub App authentication first');
    await browserExpect(
      page.getByRole('link', { name: 'Add a GitHub source', exact: true }),
    ).toHaveAttribute('href', '#/sources?create=vcs&provider=github');
    manager = false;
    gets.length = 0;
    await fixture.mount(script);
    await page.getByRole('button', { name: 'Add package', exact: true }).click();
    await browserExpect(page.getByRole('dialog')).toContainText(
      'Ask an organization source manager to connect GitHub.',
    );
    await browserExpect(
      page.getByRole('button', { name: 'Choose GitHub repositories', exact: true }),
    ).toHaveCount(0);
    expect(requests).toEqual([]);
    expect(gets).not.toContain('/_pb/sources/discovery/connections');
  });
});
