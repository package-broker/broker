import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
let appScript: string;

const KEY = 'S'.repeat(42) + 'A';
const URL_SECRET = 'https://hooks.example.com/SENTINELPATH?token=SENTINELQUERY';
type BrowserRoute = {
  request(): { method(): string };
  continue(): Promise<void>;
  fulfill(options: { status?: number; json?: unknown }): Promise<void>;
};
type Row = Record<string, unknown> & { id: string; revision: number; state: string };
let rows: Row[] = [];
let listStatus = 200;
let reauthOnce: Set<string> = new Set();
let staleOnce = false;
const writes: { method: string; path: string; ifMatch: string | null; body: unknown }[] = [];

const row = (over: Partial<Row> = {}): Row => ({
  id: '01JB0000000000000000000001',
  name: 'Release hook',
  method: 'POST',
  events: ['npm.package.published'],
  packagePattern: '@acme/*',
  state: 'disabled',
  disabledReason: null,
  failureStreak: 0,
  revision: 1,
  destinationConfigured: true,
  signingConfigured: true,
  headersConfigured: false,
  templateConfigured: false,
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...over,
});
const delivery = {
  id: '0b8f3c2a-1d4e-4f6a-9b7c-2e5d8a1f3c4b',
  eventId: '01JC0000000000000000000001',
  eventType: 'npm.package.published',
  state: 'delivered',
  attempts: 1,
  nextAttemptAt: null,
  lastStatus: 204,
  outcomeCode: 'ok',
  createdAt: '2026-11-01T00:00:00.000Z',
  finishedAt: '2026-11-01T00:00:01.000Z',
};
const error = (code: string, status: number) =>
  Response.json({ error: { code, message: 'x', requestId: 'r' } }, { status });

async function api(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  const base = '/_pb/projects/demo/notifications';
  if (path === '/_pb/session') return Response.json({ reauthFresh: true });
  if (path === '/_pb/auth/providers') return Response.json({ providers: [], local: true });
  if (path === '/_pb/auth/local/reauth') return new Response(null, { status: 204 });
  if (path === '/_pb/projects/demo')
    return Response.json({ id: 'demo-id', slug: 'demo', name: 'Demo' });
  if (path === '/_pb/projects')
    return Response.json({
      items: [{ id: 'demo-id', slug: 'demo', name: 'Demo', status: 'active' }],
      next: null,
    });
  if (!path.startsWith(base)) return Response.json({ items: [], next: null });
  const rest = path.slice(base.length).split('/').filter(Boolean);
  if (request.method === 'GET') {
    if (rest.length === 0)
      return listStatus === 200
        ? Response.json({ items: rows, next: null })
        : error('x', listStatus);
    if (rest[1] === 'deliveries' && rest.length === 2)
      return Response.json({ items: [delivery], next: null });
    if (rest[1] === 'deliveries')
      return Response.json({
        ...delivery,
        history: [
          {
            attempt: 1,
            outcome: 'delivered',
            outcomeCode: 'ok',
            status: 204,
            durationMs: 20,
            startedAt: '2026-11-01T00:00:00.000Z',
            finishedAt: '2026-11-01T00:00:00.020Z',
          },
        ],
      });
    return Response.json(rows.find((item) => item.id === rest[0]));
  }
  const text = await request.text();
  const body: unknown = text === '' ? undefined : JSON.parse(text);
  const ifMatch = request.headers.get('if-match');
  writes.push({ method: request.method, path, ifMatch, body });
  const kind = `${request.method} ${rest[1] ?? ''}`.trim();
  if (reauthOnce.delete(kind)) return error('reauth_required', 403);
  if (request.method === 'POST' && rest.length === 0) {
    const created = row({
      id: '01JB0000000000000000000002',
      name: (body as { name: string }).name,
    });
    rows.push(created);
    return Response.json(created, { status: 201 });
  }
  const target = rows.find((item) => item.id === rest[0]);
  if (target === undefined) return error('not_found', 404);
  if (staleOnce || ifMatch !== `"r${target.revision}"`) {
    staleOnce = false;
    return error('precondition_failed', 412);
  }
  const index = rows.indexOf(target);
  if (request.method === 'DELETE') {
    rows.splice(index, 1);
    return new Response(null, { status: 204 });
  }
  const change = body as { options?: { name: string }; secret?: unknown } | undefined;
  rows[index] = {
    ...target,
    revision: target.revision + 1,
    ...(rest[1] === 'enable' ? { state: 'enabled', disabledReason: null } : {}),
    ...(rest[1] === 'disable' ? { state: 'disabled', disabledReason: 'manual' } : {}),
    ...(change?.options ? { name: change.options.name } : {}),
    ...(change?.secret ? { state: 'disabled', disabledReason: 'configuration_changed' } : {}),
  };
  return Response.json(rows[index]);
}

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { createApiClient } from '../src/api';
      import { NotificationsView } from '../src/pages/notifications';
      import { createNotificationsController } from '../src/pages/notifications-controller';
      globalThis.reauth = [];
      const services = {
        client: createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined }),
        requireReauth: (request, options) => { globalThis.reauth.push({ request, options }); },
      };
      const controller = createNotificationsController(services);
      function Harness() {
        const [project, setProject] = useState('demo');
        globalThis.switchProject = setProject;
        return <NotificationsView services={services} controller={controller} project={project} projectName={project === 'demo' ? 'Demo' : project} />;
      }
      createRoot(document.getElementById('root')).render(<Harness />);`,
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
  const app = await build({
    stdin: {
      contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { App } from '../src/app';
      import { createApiClient } from '../src/api';
      location.hash = '#/notifications?project=demo';
      createRoot(document.getElementById('root')).render(<App client={createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined })} />);
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
  appScript = app.outputFiles[0]!.text;
  fixture = await createBrowserFixture({ api });
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});

beforeEach(async () => {
  rows = [row()];
  listStatus = 200;
  reauthOnce = new Set();
  staleOnce = false;
  writes.length = 0;
  await fixture?.page.evaluate(() => {
    if (location.origin !== 'null') sessionStorage.clear();
  });
});

async function more(action: string) {
  const { page } = fixture!;
  const trigger = page.getByRole('button', { name: 'More actions for Release hook' }).first();
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: `${action} Release hook` }).click();
}

const reauthCalls = () =>
  fixture!.page.evaluate(() => (globalThis as unknown as { reauth: unknown[] }).reauth);

describe('notification endpoints in the browser', () => {
  it.for(['create', 'update', 'enable', 'delete'] as const)(
    'discards a late %s response after switching project and back',
    { timeout: 30_000 },
    async (action, context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await fixture!.mount(script);
      await browserExpect(page.getByText('Release hook').first()).toBeVisible();
      let release!: () => void;
      await page.route('**/_pb/projects/demo/notifications**', async (route: BrowserRoute) => {
        if (route.request().method() === 'GET') return route.continue();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.fulfill(
          action === 'delete'
            ? { status: 204 }
            : { json: row({ name: 'Late A response', revision: 2 }) },
        );
      });
      if (action === 'create') {
        await page.getByRole('button', { name: 'Add endpoint' }).click();
        await page.getByLabel('Name').fill('Draft');
        await page.getByLabel('Destination URL').fill(URL_SECRET);
        await page.getByLabel('Signing key').fill(KEY);
        await page.getByRole('button', { name: 'Add endpoint' }).click();
      } else if (action === 'update') {
        await more('Edit');
        await page.getByLabel('Name').fill('Draft');
        await page.getByRole('button', { name: 'Save endpoint' }).click();
      } else if (action === 'enable') await more('Enable');
      else {
        await more('Remove');
        await page.getByRole('button', { name: 'Confirm remove endpoint' }).click();
      }
      await expect.poll(() => typeof release).toBe('function');
      const switchTo = (project: string) =>
        page.evaluate(
          (value: string) =>
            (globalThis as unknown as { switchProject: (project: string) => void }).switchProject(
              value,
            ),
          project,
        );
      await switchTo('other');
      await browserExpect(
        page.getByText('No notification endpoints yet.', { exact: false }),
      ).toBeVisible();
      await switchTo('demo');
      await browserExpect(page.getByText('Release hook').first()).toBeVisible();
      const response = page.waitForResponse(
        (response: { request(): { method(): string } }) => response.request().method() !== 'GET',
      );
      release();
      const late = await response;
      // The client never reads a 204 body, so Chromium never reports the intercepted request finished.
      if (late.status() !== 204) await late.finished();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.unroute('**/_pb/projects/demo/notifications**');
      await browserExpect(page.getByText('Late A response')).toHaveCount(0);
      await browserExpect(page.getByText('Release hook').first()).toBeVisible();
      await browserExpect(page.getByRole('status')).toHaveText('');
    },
  );

  it.for(['create', 'replace'] as const)(
    'restores the non-secret %s draft through the real shell reauthentication route',
    { timeout: 30_000 },
    async (action, context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      reauthOnce.add(action === 'create' ? 'POST' : 'PATCH');
      await fixture!.mount(appScript);
      if (action === 'create') await page.getByRole('button', { name: 'Add endpoint' }).click();
      else {
        await more('Edit');
        await page.getByLabel(/Replace delivery settings/).check();
      }
      await page.getByLabel('Name').fill('Restored draft');
      await page.getByLabel('Package filter').fill('@draft/*');
      await page.getByRole('radio', { name: 'PUT', exact: true }).check();
      await page.getByRole('checkbox', { name: /Held version released/ }).check();
      await page.getByLabel('Destination URL').fill(URL_SECRET);
      await page.getByLabel('Signing key').fill(KEY);
      await page.getByLabel('Body template (optional)').fill('{"secret":"SENTINELTEMPLATE"}');
      await page
        .getByRole('button', {
          name: action === 'create' ? 'Add endpoint' : 'Save endpoint',
          exact: true,
        })
        .click();
      await browserExpect(page.getByRole('heading', { name: 'Confirm it is you' })).toBeVisible();
      await browserExpect(page.getByLabel('Name', { exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => JSON.stringify(sessionStorage))).not.toMatch(
        /SENTINEL|hooks.example|SSSSSS/,
      );
      await page.getByLabel('Password', { exact: true }).fill('password');
      await page.getByLabel('Authenticator code', { exact: true }).fill('123456');
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await browserExpect(page.getByLabel('Name', { exact: true })).toHaveValue('Restored draft');
      await browserExpect(page.getByLabel('Package filter')).toHaveValue('@draft/*');
      await browserExpect(page.getByRole('radio', { name: 'PUT', exact: true })).toBeChecked();
      await browserExpect(
        page.getByRole('checkbox', { name: /Held version released/ }),
      ).toBeChecked();
      await browserExpect(page.getByLabel('Destination URL')).toHaveValue('');
      await browserExpect(page.getByLabel('Signing key')).toHaveValue('');
      await browserExpect(page.getByLabel('Body template (optional)')).toHaveValue('');
      expect(writes).toHaveLength(1);
      await page
        .getByRole('button', {
          name: action === 'create' ? 'Add endpoint' : 'Save endpoint',
          exact: true,
        })
        .click();
      expect(writes).toHaveLength(1); // Native validation requires the secret again.
    },
  );

  it.for([1440, 1024, 768, 390, 320])(
    'lists endpoints without page overflow and enables then disables without reauthentication at %i px',
    { timeout: 30_000 },
    async (width, context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await page.setViewportSize({ width, height: 900 });
      await fixture!.mount(script);
      await browserExpect(page.getByText('Not enabled yet.').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
      await more('Enable');
      await browserExpect(page.getByRole('status')).toContainText(
        'earlier events are not replayed',
      );
      await more('Disable');
      await browserExpect(page.getByRole('status')).toContainText('Endpoint disabled.');
      expect(writes.map((write) => [write.path.split('/').pop(), write.ifMatch])).toEqual([
        ['enable', '"r1"'],
        ['disable', '"r2"'],
      ]);
      expect(await reauthCalls()).toEqual([]);
    },
  );

  it('adds a disabled endpoint, sends delivery settings once and clears them', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await page.setViewportSize({ width: 1280, height: 900 });
    await fixture!.mount(script);
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await page.getByLabel('Name').fill('Deploy hook');
    await page.getByLabel('Destination URL').fill(URL_SECRET);
    await page.getByLabel('Signing key').fill(KEY);
    await page.getByLabel('Held version released').check();
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await browserExpect(page.getByRole('status')).toContainText('stays disabled');
    await browserExpect(page.getByText('Deploy hook')).toBeVisible();
    expect(writes[0]!.body).toMatchObject({
      name: 'Deploy hook',
      events: ['npm.package.published', 'npm.package.released'],
      secret: { url: URL_SECRET, signingKey: KEY, headers: [], template: null },
    });
    await browserExpect(page.getByLabel('Destination URL')).toHaveCount(0);
    expect(await page.content()).not.toContain('SENTINEL');
  });

  it('asks for reauthentication on create without keeping the delivery settings', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    reauthOnce.add('POST');
    await fixture!.mount(script);
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await page.getByLabel('Name').fill('Deploy hook');
    await page.getByLabel('Destination URL').fill(URL_SECRET);
    await page.getByLabel('Signing key').fill(KEY);
    await page.getByRole('button', { name: 'Add endpoint' }).click();
    await browserExpect(page.getByRole('alert').first()).toContainText(
      'enter the delivery settings again',
    );
    expect(JSON.stringify(await reauthCalls())).not.toContain('SENTINEL');
    expect(await reauthCalls()).toEqual([
      {
        request: { method: 'POST', path: '/_pb/projects/demo/notifications' },
        options: { credential: true, secretFields: [] },
      },
    ]);
    await browserExpect(page.getByLabel('Destination URL')).toHaveValue('');
    await browserExpect(page.getByLabel('Signing key')).toHaveValue('');
    await browserExpect(page.getByLabel('Name')).toHaveValue('Deploy hook');
  });

  it('edits options without delivery settings and replaces them only on request', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await fixture!.mount(script);
    await more('Edit');
    await browserExpect(page.getByLabel('Destination URL')).toHaveCount(0);
    await page.getByLabel('Name').fill('Renamed hook');
    await page.getByRole('button', { name: 'Save endpoint' }).click();
    await browserExpect(page.getByRole('status')).toContainText('Endpoint saved.');
    expect(writes[0]).toMatchObject({ method: 'PATCH', ifMatch: '"r1"' });
    expect(writes[0]!.body).not.toHaveProperty('secret');

    await page.getByRole('button', { name: 'More actions for Renamed hook' }).click();
    await page.getByRole('menuitem', { name: 'Edit Renamed hook' }).click();
    await page.getByLabel(/Replace delivery settings/).check();
    await browserExpect(page.getByLabel('Destination URL')).toHaveValue('');
    await page.getByLabel('Destination URL').fill(URL_SECRET);
    await page.getByLabel('Signing key').fill(KEY);
    await page.getByRole('button', { name: 'Save endpoint' }).click();
    await browserExpect(page.getByRole('status')).toContainText('The endpoint is disabled');
    expect(writes[1]).toMatchObject({ method: 'PATCH', ifMatch: '"r2"' });
    expect(writes[1]!.body).toMatchObject({ secret: { url: URL_SECRET } });
  });

  it('keeps the draft and requires a reload after a revision conflict', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    staleOnce = true;
    await fixture!.mount(script);
    await more('Edit');
    await page.getByLabel('Name').fill('Draft name');
    await page.getByRole('button', { name: 'Save endpoint' }).click();
    await browserExpect(page.getByRole('alert').first()).toContainText(
      'changed while you were editing',
    );
    await browserExpect(page.getByLabel('Name')).toHaveValue('Draft name');
    await browserExpect(page.getByRole('button', { name: 'Save endpoint' })).toBeDisabled();
    await page.getByRole('button', { name: 'Reload latest settings' }).click();
    await browserExpect(page.getByRole('button', { name: 'Save endpoint' })).toHaveCount(0);
  });

  it('confirms removal with Cancel first and replays it after reauthentication', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    reauthOnce.add('DELETE');
    await page.setViewportSize({ width: 390, height: 800 });
    await fixture!.mount(script);
    await more('Remove');
    const dialog = page.getByRole('dialog');
    await browserExpect(dialog).toContainText('Project Demo');
    await browserExpect(dialog).toContainText('cannot be recalled');
    const buttons = await dialog.getByRole('button').allTextContents();
    expect(buttons.indexOf('Cancel')).toBeLessThan(buttons.indexOf('Confirm remove endpoint'));
    await page.keyboard.press('Escape');
    await browserExpect(dialog).toHaveCount(0);
    expect(writes).toEqual([]);
    await more('Remove');
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm remove endpoint' }).click();
    await browserExpect(page.getByRole('alert').first()).toContainText(
      'Reauthentication is required',
    );
    expect(await reauthCalls()).toEqual([
      {
        request: expect.objectContaining({
          method: 'DELETE',
          headers: { 'If-Match': '"r1"' },
        }),
        options: { credential: false, secretFields: [] },
      },
    ]);
  });

  it('shows delivery history and attempts', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await fixture!.mount(script);
    await page.getByRole('button', { name: 'Delivery history Release hook' }).click();
    await browserExpect(
      page.getByRole('heading', { name: 'Delivery history: Release hook' }),
    ).toBeVisible();
    await browserExpect(page.getByText('Delivered (HTTP 204)')).toBeVisible();
    await page.getByRole('button', { name: /Show attempts/ }).click();
    await browserExpect(page.getByText(/Delivered \(HTTP 204\), 20 ms/)).toBeVisible();
  });

  it.for([
    [403, 'You cannot manage notifications in this project.'],
    [404, 'Notifications are not available.'],
    [500, 'Notification endpoints could not be loaded. Try again.'],
  ] as const)('explains a %i list answer', async ([status, copy], context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    listStatus = status;
    await fixture!.mount(script);
    await browserExpect(page.getByText(copy)).toBeVisible();
    await browserExpect(page.getByRole('button', { name: 'Add endpoint' })).toHaveCount(0);
  });

  it('shows the first-use state', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    rows = [];
    await fixture!.mount(script);
    await browserExpect(
      page.getByText('No notification endpoints yet.', { exact: false }),
    ).toBeVisible();
    await browserExpect(page.getByRole('button', { name: 'Add endpoint' })).toBeEnabled();
  });
});
