import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';
let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
let conflict = false;
let readOnly = false;
let readmeStatus = 200;
let readmeType = 'text/markdown';
let ecosystem = 'npm';
let releaseWrite: (() => void) | undefined;
let holdWrites = false;
let paginated = false;
let publishState = 'pending';
let scanState = 'queued';
const reads: string[] = [];
const writes: { path: string; body: unknown; match: string | null }[] = [];
const item = {
  id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
  name: '@team/library',
  ecosystem: 'npm',
  source: { id: 'source', name: 'Internal releases', type: 'hosted', projectId: null },
  visibleToNewProjects: false,
  newProjectAccessMode: 'request',
  revision: 3,
  status: 'active',
  latestVersion: '1.0.0',
  versionCount: 1,
  lastSyncedAt: null,
};
beforeAll(async () => {
  script = (
    await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {createApiClient} from '../src/api'; import {PackageWorkflow} from '../src/pages/packages/npm-workflow'; import {PackageDetail} from '../src/pages/packages/package-detail'; import {PackagesPage} from '../src/pages/packages'; import {ServicesContext} from '../src/auth'; const services={client:createApiClient({fetch:window.fetch.bind(window),readCookie:()=>undefined}),requireReauth:()=>{}}; createRoot(document.getElementById('root')).render(globalThis.filters ? <ServicesContext.Provider value={services}><PackagesPage /></ServicesContext.Provider> : <><h1 id="page-heading" tabIndex={-1}>Packages</h1>{globalThis.detail ? <PackageDetail services={services} id="01AAAAAAAAAAAAAAAAAAAAAAAA" project={globalThis.project ?? null} /> : <PackageWorkflow services={services} project={globalThis.project ?? null}/>}</>);`,
        loader: 'tsx',
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    })
  ).outputFiles[0]!.text;
});
beforeEach(async () => {
  conflict = false;
  readOnly = false;
  readmeStatus = 200;
  readmeType = 'text/markdown';
  ecosystem = 'npm';
  releaseWrite = undefined;
  holdWrites = false;
  paginated = false;
  publishState = 'pending';
  scanState = 'queued';
  reads.length = 0;
  writes.length = 0;
  fixture = await createBrowserFixture({
    api: async (request) => {
      const path = new URL(request.url).pathname;
      reads.push(path + new URL(request.url).search);
      if (request.method !== 'GET') {
        writes.push({ path, body: await request.json(), match: request.headers.get('if-match') });
        if (holdWrites)
          await new Promise<void>((resolve) => {
            releaseWrite = resolve;
          });
        return conflict
          ? Response.json({ error: 'conflict' }, { status: 409 })
          : Response.json({ ...item, revision: 4 });
      }
      if (path.endsWith('/permissions'))
        return Response.json({
          organization: readOnly
            ? ['org:packages:read']
            : [
                'org:packages:read',
                'org:packages:approve',
                'org:packages:manage',
                'org:sources:write',
                'org:projects:read',
              ],
          project: ['project:packages:manage'],
        });
      if (path.endsWith('/sources')) {
        const project = /^\/_pb\/projects\/(demo|other)\/sources$/.exec(path)?.[1];
        return Response.json({
          items: [
            project
              ? {
                  ...item.source,
                  id: `${project}-source`,
                  name: project === 'demo' ? 'Checkout releases' : 'Other releases',
                }
              : item.source,
          ],
          next: null,
        });
      }
      if (path === '/_pb/projects')
        return Response.json({
          items: [{ id: 'project', name: 'Checkout', slug: 'demo' }],
          next: null,
        });
      if (path.endsWith('/projects/demo'))
        return Response.json({ id: 'project', name: 'Checkout', slug: 'demo' });
      if (path.endsWith('/readme')) {
        if (readmeStatus !== 200)
          return Response.json({ error: 'unavailable' }, { status: readmeStatus });
        return Response.json({
          contentType: readmeType,
          sizeBytes: 38,
          filename: 'README.md',
          body: '<script>danger()</script>\n# Library',
        });
      }
      if (path.endsWith('/versions')) return Response.json({ items: [], next: null });
      if (path.endsWith('/packages'))
        return Response.json({ items: [{ ...item, ecosystem }], next: null });
      if (path.endsWith('/requestable-packages'))
        return Response.json({ items: [{ ...item, ecosystem }], next: paginated ? 'next' : null });
      const row = {
        id: 'request',
        packageName: item.name,
        version: '1.0.0',
        sourceName: 'Internal releases',
        requestedBy: { name: 'Release team' },
        project: { name: 'Checkout', slug: 'demo' },
        revision: 7,
        approvalState: publishState,
        state: 'pending',
        scanState,
        holdScan: true,
        reason: 'Needed for checkout',
        expiresAt: '2026-12-01T00:00:00Z',
      };
      return Response.json({ items: [row], next: paginated ? 'next' : null });
    },
  });
});
afterEach(async () => {
  holdWrites = false;
  releaseWrite?.();
  await fixture?.close();
  fixture = undefined;
});
it('reviews pending publishes with a reason and a revision, at 360 px', async (context) => {
  if (!fixture) return context.skip();
  writes.length = 0;
  conflict = false;
  await fixture.page.setViewportSize({ width: 360, height: 800 });
  await fixture.mount(script);
  await fixture.page.getByRole('heading', { name: 'Pending publishes', exact: true }).waitFor();
  await fixture.page.getByRole('button', { name: /More actions for .*1\.0\.0/ }).click();
  await fixture.page.getByRole('menuitem', { name: /Reject publish/ }).click();
  await fixture.page.getByLabel('Reason (required)').fill('Release needs review');
  await fixture.page.getByRole('button', { name: 'Confirm rejection' }).click();
  await fixture
    .browserExpect(
      fixture.page.getByRole('status').filter({ hasText: /approved|rejected|requested/ }),
    )
    .toContainText('rejected');
  expect(writes[0]).toEqual({
    path: '/_pb/publishes/request/reject',
    body: { reason: 'Release needs review' },
    match: '"r7"',
  });
  expect(
    await fixture.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBe(true);
});
it('approves access requests for named projects', async (context) => {
  if (!fixture) return context.skip();
  writes.length = 0;
  await fixture.mount(script);
  await fixture.page.getByRole('button', { name: /Approve access/ }).click();
  await fixture.page.getByRole('button', { name: 'Confirm approval' }).click();
  await fixture
    .browserExpect(
      fixture.page.getByRole('status').filter({ hasText: /approved|rejected|requested/ }),
    )
    .toContainText('approved');
  expect(writes[0]?.path).toBe('/_pb/package-access-requests/request/approve');
});
it('requests project access and explains source attachment', async (context) => {
  if (!fixture) return context.skip();
  writes.length = 0;
  await fixture.mount(script, { project: 'demo' });
  await fixture.page.getByRole('button', { name: /Request access/ }).click();
  await fixture.page.getByLabel('Reason (optional)').fill('For our checkout');
  await fixture.page.getByRole('button', { name: 'Send request' }).click();
  await fixture
    .browserExpect(
      fixture.page.getByRole('status').filter({ hasText: /approved|rejected|requested/ }),
    )
    .toContainText('requested');
  expect(writes[0]?.path).toBe('/_pb/projects/demo/package-access-requests');
});
it('renders README as text and blocks stale access edits until reload', async (context) => {
  if (!fixture) return context.skip();
  writes.length = 0;
  conflict = true;
  await fixture.mount(script, { detail: true });
  await fixture.page.getByLabel('Project for README and install instructions').selectOption('demo');
  await fixture.page.getByText('<script>danger()</script>', { exact: false }).waitFor();
  await fixture.page.getByLabel('Access for new projects').selectOption('available');
  await fixture.page.getByRole('button', { name: 'Save access policy' }).click();
  await fixture.page.getByRole('button', { name: 'Reload latest settings' }).waitFor();
  await fixture
    .browserExpect(fixture.page.getByLabel('Access for new projects'))
    .toHaveValue('available');
  await fixture
    .browserExpect(fixture.page.getByRole('button', { name: 'Save access policy' }))
    .toBeDisabled();
  expect(writes[0]?.body).toEqual({
    visibleToNewProjects: true,
    newProjectAccessMode: 'none',
    revision: 3,
  });
  await fixture.page.getByRole('button', { name: 'Reload latest settings' }).click();
  await fixture
    .browserExpect(fixture.page.getByLabel('Access for new projects'))
    .toHaveValue('request');
});

it('approves a publish without claiming its scan completed', async (context) => {
  if (!fixture) return context.skip();
  conflict = false;
  readOnly = false;
  writes.length = 0;
  await fixture.mount(script);
  await fixture.page.getByRole('button', { name: /Approve publish/ }).click();
  await fixture.page.getByRole('button', { name: 'Confirm approval' }).click();
  await fixture
    .browserExpect(fixture.page.getByRole('status').filter({ hasText: 'Publish approved' }))
    .toContainText('remains held');
  expect(writes[0]?.path).toBe('/_pb/publishes/request/approve');
});
it('retains rejection drafts on conflicts and requires renewed review', async (context) => {
  if (!fixture) return context.skip();
  conflict = true;
  readOnly = false;
  writes.length = 0;
  await fixture.mount(script);
  await fixture.page.getByRole('button', { name: /More actions for .*Checkout/ }).click();
  await fixture.page.getByRole('menuitem', { name: /Reject access/ }).click();
  await fixture.page.getByLabel('Reason (required)').fill('Project needs review');
  await fixture.page.getByRole('button', { name: 'Confirm rejection' }).click();
  await fixture.page.getByRole('button', { name: 'Reload latest requests' }).waitFor();
  await fixture
    .browserExpect(fixture.page.getByLabel('Reason (required)'))
    .toHaveValue('Project needs review');
  await fixture
    .browserExpect(fixture.page.getByRole('button', { name: 'Confirm rejection' }))
    .toBeDisabled();
  expect(writes[0]?.path).toBe('/_pb/package-access-requests/request/reject');
});
it('supports keyboard dismissal and restores focus to the decision opener', async (context) => {
  if (!fixture) return context.skip();
  conflict = false;
  readOnly = false;
  await fixture.mount(script);
  const opener = fixture.page.getByRole('button', { name: /Approve access/ });
  await opener.focus();
  await fixture.page.keyboard.press('Enter');
  await fixture.browserExpect(fixture.page.getByLabel('Reason (optional)')).toBeFocused();
  await fixture.page.keyboard.press('Escape');
  await fixture.browserExpect(opener).toBeFocused();
});
it('hides decisions when the caller has read authority only', async (context) => {
  if (!fixture) return context.skip();
  readOnly = true;
  await fixture.mount(script);
  await fixture.page.getByRole('heading', { name: 'Pending publishes', exact: true }).waitFor();
  await fixture
    .browserExpect(fixture.page.getByRole('button', { name: /Approve publish/ }))
    .toHaveCount(0);
  await fixture
    .browserExpect(fixture.page.getByRole('button', { name: /More actions for/ }))
    .toHaveCount(0);
  readOnly = false;
});

it('prevents a second submit while a decision is busy and restores focus after success', async (context) => {
  if (!fixture) return context.skip();
  conflict = false;
  writes.length = 0;
  holdWrites = true;
  await fixture.mount(script);
  const opener = fixture.page.getByRole('button', { name: /Approve access/ });
  await opener.click();
  await fixture.page.getByRole('button', { name: 'Confirm approval' }).click();
  try {
    await fixture
      .browserExpect(fixture.page.getByRole('button', { name: 'Saving decision…' }))
      .toBeDisabled();
    await fixture.browserExpect.poll(() => writes.length).toBe(1);
    await fixture.page.locator('dialog form').evaluate((form: HTMLFormElement) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    expect(writes).toHaveLength(1);
  } finally {
    holdWrites = false;
    releaseWrite?.();
  }
  await fixture.browserExpect(fixture.page.getByRole('dialog')).toHaveCount(0);
  await fixture
    .browserExpect(fixture.page.getByRole('heading', { name: 'Packages', exact: true }))
    .toBeFocused();
});

it('renders project detail at 360 px with exact snippets and README metadata for both ecosystems', async (context) => {
  if (!fixture) return context.skip();
  await fixture.page.setViewportSize({ width: 360, height: 800 });
  readmeType = 'text/plain';
  reads.length = 0;
  for (const kind of ['npm', 'composer']) {
    ecosystem = kind;
    await fixture.mount(script, { detail: true, project: 'demo' });
    await fixture.page.getByText('<script>danger()</script>', { exact: false }).waitFor();
    const origin = new URL(fixture.page.url()).origin;
    await fixture
      .browserExpect(fixture.page.locator('pre').first())
      .toHaveText(
        kind === 'npm'
          ? `npm install @team/library\n# Registry: ${origin}/demo/npm/`
          : `composer require @team/library\n# Repository: ${origin}/demo`,
      );
    await fixture
      .browserExpect(fixture.page.getByText('README.md · 38 bytes', { exact: true }))
      .toBeVisible();
    await fixture
      .browserExpect(fixture.page.getByText('Project Checkout · Source:', { exact: false }))
      .toBeVisible();
    expect(
      await fixture.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBe(true);
  }
  expect(reads).toContain('/_pb/projects/demo/packages/01AAAAAAAAAAAAAAAAAAAAAAAA/readme');
  ecosystem = 'npm';
  readmeType = 'text/markdown';
});

it('explains denied README access without retry and offers retry for server and network failures', async (context) => {
  if (!fixture) return context.skip();
  for (const status of [403, 500]) {
    readmeStatus = status;
    await fixture.mount(script, { detail: true, project: 'demo' });
    await fixture
      .browserExpect(
        fixture.page.getByText(
          status === 403
            ? 'This project cannot read this package.'
            : 'README could not be loaded. Try again.',
          { exact: true },
        ),
      )
      .toBeVisible();
    await fixture
      .browserExpect(fixture.page.getByRole('button', { name: 'Try again', exact: true }))
      .toHaveCount(status === 403 ? 0 : 1);
  }
  await fixture.page.route('**/readme', (route: { abort: () => Promise<void> }) => route.abort());
  await fixture.mount(script, { detail: true, project: 'demo' });
  await fixture
    .browserExpect(fixture.page.getByRole('button', { name: 'Try again', exact: true }))
    .toBeVisible();
  await fixture.page.unroute('**/readme');
  readmeStatus = 200;
  await fixture.page.getByRole('button', { name: 'Try again', exact: true }).click();
  await fixture.page.getByText('<script>danger()</script>', { exact: false }).waitFor();
});

it('focuses the required reason on an empty rejection', async (context) => {
  if (!fixture) return context.skip();
  await fixture.mount(script);
  await fixture.page.getByRole('button', { name: /More actions for .*Checkout/ }).click();
  await fixture.page.getByRole('menuitem', { name: /Reject access/ }).click();
  await fixture.page.getByRole('button', { name: 'Confirm rejection' }).click();
  await fixture.browserExpect(fixture.page.getByLabel('Reason (required)')).toBeFocused();
  await fixture.browserExpect(fixture.page.getByRole('alert')).toContainText('Enter a reason');
});

it('keeps each pagination action inside its matching section', async (context) => {
  if (!fixture) return context.skip();
  paginated = true;
  await fixture.mount(script);
  for (const [section, label] of [
    ['Pending publishes', 'Next publishes'],
    ['Access requests', 'Next access requests'],
  ]) {
    await fixture
      .browserExpect(
        fixture.page
          .getByRole('region', { name: section })
          .getByRole('button', { name: label, exact: true }),
      )
      .toBeVisible();
  }
  await fixture.mount(script, { project: 'demo' });
  await fixture
    .browserExpect(
      fixture.page
        .getByRole('region', { name: 'Request package access' })
        .getByRole('button', { name: 'Next requestable packages', exact: true }),
    )
    .toBeVisible();
  await fixture
    .browserExpect(fixture.page.getByRole('button', { name: 'Next access requests', exact: true }))
    .toHaveCount(0);
  paginated = false;
  publishState = 'pending';
  scanState = 'queued';
});

it('preserves filter controls and cached named choices across hash navigation per scope', async (context) => {
  if (!fixture) return context.skip();
  reads.length = 0;
  await fixture.mount(script, { filters: true });
  const source = fixture.page.getByLabel('Source', { exact: true });
  await fixture.browserExpect(source).toBeEnabled();
  await fixture
    .browserExpect(source.locator('option'))
    .toHaveText(['All sources', 'Internal releases']);
  await fixture
    .browserExpect(fixture.page.getByLabel('Project', { exact: true }).locator('option'))
    .toHaveText(['All projects', 'Checkout']);
  await fixture.page.evaluate(() => {
    (window as unknown as { filterNode: Element | null }).filterNode =
      document.getElementById('package-source');
  });
  await fixture.page.getByLabel('Name prefix', { exact: true }).fill('library');
  await fixture.page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await fixture.browserExpect(fixture.page).toHaveURL(/q=library/);
  await fixture.page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await fixture
    .browserExpect(fixture.page.getByLabel('Name prefix', { exact: true }))
    .toHaveValue('');
  expect(
    await fixture.page.evaluate(
      () =>
        (window as unknown as { filterNode: Element }).filterNode ===
        document.getElementById('package-source'),
    ),
  ).toBe(true);
  expect(reads.filter((path) => path === '/_pb/sources')).toHaveLength(1);
  expect(reads.filter((path) => path === '/_pb/projects')).toHaveLength(1);
  await fixture.page.evaluate(() => {
    location.hash = '#/packages?project=demo';
  });
  await fixture.browserExpect
    .poll(() => reads.filter((path) => path === '/_pb/projects/demo/sources').length)
    .toBe(1);
  await fixture.browserExpect(source).toBeEnabled();
  await fixture
    .browserExpect(source.locator('option'))
    .toHaveText(['All sources', 'Checkout releases']);
  await fixture.page.evaluate(() => {
    location.hash = '#/packages?project=other';
  });
  await fixture.browserExpect
    .poll(() => reads.filter((path) => path === '/_pb/projects/other/sources').length)
    .toBe(1);
  await fixture.browserExpect(source).toBeEnabled();
  await fixture
    .browserExpect(source.locator('option'))
    .toHaveText(['All sources', 'Other releases']);
  await fixture.page.evaluate(() => {
    location.hash = '#/packages?project=demo';
  });
  await fixture.browserExpect(source).toBeEnabled();
  await fixture
    .browserExpect(source.locator('option'))
    .toHaveText(['All sources', 'Checkout releases']);
  expect(reads.filter((path) => path === '/_pb/projects/demo/sources')).toHaveLength(1);
  expect(reads.filter((path) => path === '/_pb/projects/other/sources')).toHaveLength(1);
  await fixture.page.evaluate(() => {
    location.hash = '#/packages';
  });
  await fixture
    .browserExpect(source.locator('option'))
    .toHaveText(['All sources', 'Internal releases']);
  await fixture
    .browserExpect(fixture.page.getByLabel('Project', { exact: true }).locator('option'))
    .toHaveText(['All projects', 'Checkout']);
  expect(reads.filter((path) => path === '/_pb/sources')).toHaveLength(1);
  expect(reads.filter((path) => path === '/_pb/projects')).toHaveLength(1);
});

it.for(['not_required', 'approved'])(
  'rescans a failed %s hold with its revision and queued feedback',
  async (state, context) => {
    if (!fixture) return context.skip();
    publishState = state;
    scanState = 'failed';
    await fixture.mount(script);
    await fixture.page.getByRole('button', { name: /^Rescan / }).click();
    await fixture.page.getByRole('button', { name: 'Queue rescan' }).click();
    await fixture
      .browserExpect(fixture.page.getByRole('status').filter({ hasText: 'Security scan queued.' }))
      .toContainText('remains held');
    expect(reads).toContain('/_pb/publishes?actionable=true');
    expect(writes[0]).toEqual({ path: '/_pb/publishes/request/rescan', body: {}, match: '"r7"' });
  },
);
it('disposes an approved failed scan with a required reason', async (context) => {
  if (!fixture) return context.skip();
  publishState = 'approved';
  scanState = 'failed';
  await fixture.page.setViewportSize({ width: 390, height: 800 });
  await fixture.mount(script);
  await fixture.page.getByRole('button', { name: /More actions for .*1\.0\.0/ }).click();
  await fixture.page.getByRole('menuitem', { name: /^Dispose failed publish / }).click();
  await fixture.page.getByLabel('Reason (required)').fill('Failed security review');
  await fixture.page.getByRole('button', { name: 'Confirm rejection' }).click();
  await fixture
    .browserExpect(fixture.page.getByRole('status').filter({ hasText: 'Publish rejected.' }))
    .toContainText('rejected');
  expect(writes[0]).toEqual({
    path: '/_pb/publishes/request/reject',
    body: { reason: 'Failed security review' },
    match: '"r7"',
  });
});

it('blocks rescan resubmission after a revision conflict until renewed review', async (context) => {
  if (!fixture) return context.skip();
  publishState = 'approved';
  scanState = 'failed';
  conflict = true;
  await fixture.mount(script);
  await fixture.page.getByRole('button', { name: /^Rescan / }).click();
  await fixture.page.getByRole('button', { name: 'Queue rescan' }).click();
  await fixture.page.getByRole('button', { name: 'Reload latest requests' }).waitFor();
  await fixture
    .browserExpect(fixture.page.getByRole('button', { name: 'Queue rescan' }))
    .toBeDisabled();
  expect(writes).toHaveLength(1);
});

it('hides failed-scan recovery controls from readers', async (context) => {
  if (!fixture) return context.skip();
  readOnly = true;
  publishState = 'approved';
  scanState = 'failed';
  await fixture.mount(script);
  await fixture.page.getByRole('heading', { name: 'Pending publishes', exact: true }).waitFor();
  expect(await fixture.page.getByRole('button', { name: /^Rescan / }).count()).toBe(0);
  expect(
    await fixture.page.getByRole('button', { name: /More actions for .*1\.0\.0/ }).count(),
  ).toBe(0);
  expect(writes).toHaveLength(0);
});
