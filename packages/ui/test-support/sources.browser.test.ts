import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
let sources: (typeof source)[] = [];
let projectFails = false;
let organizationFails = false;
let packageStatus = 202;
const requests: { path: string; method: string; body: unknown }[] = [];
const timeout = 5_000;
const source = {
  id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  projectId: 'project-id' as string | null,
  name: 'Private npm',
  ecosystem: 'npm',
  type: 'npm_registry',
  url: 'https://registry.example',
  status: 'active',
  removalPolicy: 'flag',
  pollIntervalSeconds: 300,
  hasCredential: false,
  lastSuccessAt: null,
  lastError: null,
  lastPolledAt: null,
  nextPollAt: null,
  lastRemovalRefusal: null,
  removalAcceptanceArmed: false,
  attached: true,
  precedence: 0,
};

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { createApiClient } from '../src/api';
        import { SourcesView, createSourcesModel } from '../src/pages/sources';
        const client = createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined });
        const model = createSourcesModel({ client, requireReauth: () => {} }, globalThis.fixtureProject);
        createRoot(document.getElementById('root')).render(<SourcesView model={model} />);
        void model.load();
        void model.loadAvailable();`,
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
      const body: unknown =
        request.method === 'POST' ? await request.json().catch(() => null) : null;
      requests.push({ path, method: request.method, body });
      if (path === '/_pb/me/permissions')
        return Response.json({ organization: ['org:sources:write'] });
      if (request.method === 'GET') {
        const failed = path.startsWith('/_pb/projects/') ? projectFails : organizationFails;
        return failed
          ? Response.json(
              { error: { code: 'unavailable', message: 'server-sentinel' } },
              { status: 503 },
            )
          : Response.json(
              { items: sources, next: null, vcsProviders: ['github'] },
              { headers: { ETag: '"1"' } },
            );
      }
      if (path.endsWith('/packages')) {
        if (packageStatus >= 400)
          return Response.json(
            { error: { code: 'invalid_request', message: 'server-sentinel' } },
            { status: packageStatus },
          );
        const { name } = body as { name: string };
        return Response.json(
          { name, state: packageStatus === 202 ? 'queued' : 'present', jobId: 'job-id' },
          { status: packageStatus },
        );
      }
      if (path.endsWith('/pause'))
        sources = sources.map((item) =>
          path.includes(item.id) ? { ...item, status: 'paused' } : item,
        );
      return new Response(null, { status: 204 });
    },
  });
}, 60_000);

afterAll(async () => {
  await fixture?.close();
});

async function mount(project: string | null = 'demo') {
  requests.length = 0;
  projectFails = false;
  organizationFails = false;
  packageStatus = 202;
  await fixture!.mount(script, { fixtureProject: project });
}

async function selectMore(name: string, label: string) {
  const { page, browserExpect } = fixture!;
  await page.getByRole('button', { name: `More actions for ${name}`, exact: true }).click();
  const item = page.getByRole('menuitem', { name: `${label} ${name}`, exact: true });
  await browserExpect(item).toBeVisible({ timeout });
  await item.focus();
  await page.keyboard.press('Enter');
  await browserExpect(page.getByRole('menu')).not.toBeVisible({ timeout });
}

describe('Sources browser workflows', () => {
  it.for([390, 1280])(
    'keeps row metrics and menu confirmations working at %i px',
    { timeout: 30_000 },
    async (width, context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await page.setViewportSize({ width, height: 720 });
      sources = (['active', 'paused', 'degraded', 'failing'] as const).map((status, index) => ({
        ...source,
        id: `${source.id.slice(0, -1)}${index}`,
        name: `Registry ${status}`,
        status,
        precedence: index,
      }));
      await mount();
      await browserExpect(page.locator('tbody tr')).toHaveCount(4, { timeout });
      for (const status of ['active', 'paused', 'degraded', 'failing']) {
        const group = page.getByRole('group', {
          name: `Actions for Registry ${status}`,
          exact: true,
        });
        const buttons = group.getByRole('button');
        await browserExpect(buttons).toHaveCount(3);
        const metrics = await buttons.evaluateAll((nodes: Element[]) =>
          nodes.map((node) => {
            const css = getComputedStyle(node);
            return {
              height: node.getBoundingClientRect().height,
              padding: css.padding,
              font: css.fontSize,
            };
          }),
        );
        expect(metrics[1]).toEqual(metrics[0]);
        expect(metrics[2]).toEqual(metrics[0]);
        expect(metrics[0]!.height).toBe(width < 640 ? 40 : 32);
      }
      for (const status of ['degraded', 'failing']) {
        const name = `Registry ${status}`;
        const target = sources.find((item) => item.name === name)!;
        const before = requests.filter((request) => request.method === 'POST').length;
        await selectMore(name, 'Pause source…');
        const dialog = page.getByRole('dialog', { name: 'Pause?', exact: true });
        await browserExpect(dialog).toBeVisible();
        await browserExpect(
          dialog.getByRole('button', { name: 'Cancel', exact: true }),
        ).toBeFocused();
        expect(requests.filter((request) => request.method === 'POST')).toHaveLength(before);
        await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
        await browserExpect(dialog).not.toBeVisible();
        await browserExpect(
          page.getByRole('button', { name: `More actions for ${name}`, exact: true }),
        ).toBeFocused();
        await selectMore(name, 'Pause source…');
        await dialog.getByRole('button', { name: 'Confirm pause', exact: true }).click();
        await browserExpect(
          page.getByRole('button', { name: `Sync now ${name}`, exact: true }),
        ).toBeDisabled();
        expect(requests.filter((request) => request.method === 'POST').slice(before)).toEqual([
          { path: `/_pb/projects/demo/sources/${target.id}/pause`, method: 'POST', body: null },
        ]);
      }
      for (const label of ['Refresh sources', 'Save source order']) {
        const button = page.getByRole('button', { name: label, exact: true });
        await browserExpect(button).toBeVisible();
        expect(
          await button.evaluate(
            (node: HTMLElement) =>
              node.getBoundingClientRect().width <
              node.parentElement!.getBoundingClientRect().width,
          ),
        ).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    },
  );

  it('uses credential actions and defaults for each registry kind', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    sources = [
      {
        ...source,
        id: 'packagist',
        name: 'Packagist',
        projectId: null,
        type: 'packagist_proxy',
        ecosystem: 'composer',
      },
      { ...source, id: 'npmjs', name: 'npmjs', projectId: null, type: 'npmjs_proxy' },
      {
        ...source,
        id: 'composer',
        name: 'Private Packagist',
        projectId: null,
        type: 'composer_repository',
        ecosystem: 'composer',
      },
    ];
    await mount(null);
    await selectMore('Packagist', 'Add GitHub token (optional)');
    const token = page.getByRole('dialog', { name: 'Add GitHub token (optional)', exact: true });
    await browserExpect(token.getByLabel('Credential kind', { exact: true })).toHaveValue('bearer');
    await browserExpect(token.locator('option')).toHaveCount(1);
    await browserExpect(token).toContainText('GitHub archive downloads');
    await page.keyboard.press('Escape');
    await browserExpect(
      page.getByRole('button', { name: 'More actions for Packagist', exact: true }),
    ).toBeFocused();
    await page.getByRole('button', { name: 'More actions for npmjs', exact: true }).click();
    await browserExpect(page.getByRole('menu')).toBeVisible();
    await browserExpect(
      page.getByRole('menuitem', { name: /credential|GitHub token|Add package/ }),
    ).toHaveCount(0);
    await page.keyboard.press('Escape');
    await selectMore('Private Packagist', 'Set credential');
    const composer = page.getByRole('dialog', { name: 'Set credential', exact: true });
    await browserExpect(composer.getByLabel('Credential kind', { exact: true })).toHaveValue(
      'http_basic',
    );
    await browserExpect(composer.getByLabel('username', { exact: true })).toBeVisible();
    await browserExpect(composer.getByLabel('password', { exact: true })).toBeVisible();
    await composer.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'More actions for Packagist', exact: true }).click();
    await browserExpect(page.getByRole('menuitem', { name: /Add package/ })).toHaveCount(0);
  });

  it(
    'retains package input through mapped errors, then announces queued and existing results',
    { timeout: 30_000 },
    async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      sources = [{ ...source, projectId: null }];
      await mount();
      await selectMore(source.name, 'Add package');
      const dialog = page.getByRole('dialog', { name: 'Add package', exact: true });
      const name = dialog.getByLabel('Package name', { exact: true });
      await browserExpect(name).toBeFocused();
      await name.fill('@acme/widget');
      for (const [status, message] of [
        [400, 'Enter a valid package name for this source.'],
        [
          404,
          'The package or attached source could not be found. Check the name and refresh sources.',
        ],
        [503, 'Package requests are temporarily unavailable. Try again shortly.'],
      ] as const) {
        packageStatus = status;
        await dialog.getByRole('button', { name: 'Add package', exact: true }).click();
        await browserExpect(dialog.getByRole('alert')).toHaveText(message);
        await browserExpect(name).toHaveValue('@acme/widget');
        await browserExpect(dialog).not.toContainText('server-sentinel');
        if (status === 400) await browserExpect(name).toHaveAttribute('aria-invalid', 'true');
      }
      packageStatus = 202;
      await dialog.getByRole('button', { name: 'Add package', exact: true }).click();
      await browserExpect(dialog).not.toBeVisible();
      await browserExpect(
        page
          .getByRole('status')
          .filter({ hasText: 'Queued: @acme/widget will appear in Packages shortly' }),
      ).toBeVisible();
      await browserExpect(
        page.getByRole('button', { name: `More actions for ${source.name}`, exact: true }),
      ).toBeFocused();
      packageStatus = 200;
      await selectMore(source.name, 'Add package');
      await name.fill('@acme/widget');
      await dialog.getByRole('button', { name: 'Add package', exact: true }).click();
      await browserExpect(
        page.getByRole('status').filter({ hasText: 'Already available' }),
      ).toBeVisible();
      expect(requests.filter((request) => request.path.endsWith('/packages'))).toEqual(
        Array.from({ length: 5 }, () => ({
          path: `/_pb/projects/demo/sources/${source.id}/packages`,
          method: 'POST',
          body: { name: '@acme/widget' },
        })),
      );
    },
  );

  it(
    'retries each failed resource independently and filters with readable scope labels',
    { timeout: 30_000 },
    async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      sources = [
        source,
        {
          ...source,
          id: 'org-source',
          name: 'Organization registry',
          projectId: null,
          precedence: 1,
        },
      ];
      await mount();
      await browserExpect(page.locator('tbody tr')).toHaveCount(2);
      projectFails = true;
      organizationFails = true;
      await page.getByRole('button', { name: 'Refresh sources', exact: true }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Retry sources', exact: true }),
      ).toHaveCount(1);
      await browserExpect(
        page.getByRole('button', { name: 'Retry organization sources', exact: true }),
      ).toHaveCount(1);
      await browserExpect(
        page.getByRole('button', { name: 'Refresh sources', exact: true }),
      ).toHaveCount(0);
      await browserExpect(
        page.getByRole('button', { name: 'Save source order', exact: true }),
      ).toHaveCount(0);
      await browserExpect(
        page.getByText('Project sources are still shown.', { exact: false }),
      ).toHaveCount(0);
      const before = requests.length;
      projectFails = false;
      await page.getByRole('button', { name: 'Retry sources', exact: true }).click();
      await browserExpect(page.locator('tbody tr')).toHaveCount(2);
      expect(requests.slice(before).map(({ path }) => path)).toEqual([
        '/_pb/projects/demo/sources',
      ]);
      organizationFails = false;
      const next = requests.length;
      await page.getByRole('button', { name: 'Retry organization sources', exact: true }).click();
      await browserExpect(
        page.getByRole('button', { name: 'Refresh sources', exact: true }),
      ).toBeVisible();
      expect(requests.slice(next).map(({ path }) => path)).toEqual(['/_pb/sources']);
      await page
        .getByRole('combobox', { name: 'Source scope', exact: true })
        .selectOption({ label: 'Organization' });
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await browserExpect(page.locator('tbody tr')).toHaveCount(1);
      await browserExpect(page.locator('tbody tr')).toContainText('Organization registry');
      await page
        .getByRole('combobox', { name: 'Source scope', exact: true })
        .selectOption({ label: 'Project' });
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await browserExpect(page.locator('tbody tr')).toHaveCount(1);
      await browserExpect(page.locator('tbody tr')).toContainText(source.name);
    },
  );
});
