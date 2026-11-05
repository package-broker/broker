import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
const posts: unknown[] = [];
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React, { useSyncExternalStore } from 'react';
        import { createRoot } from 'react-dom/client';
        import { createApiClient } from '../src/api';
        import { createReauthFlow, ReauthConfirm } from '../src/auth';
        import { createPackagesController, PackagesView } from '../src/pages/packages';
        const client = createApiClient({ fetch: window.fetch.bind(window), readCookie: () => undefined });
        const flow = createReauthFlow({ client, storage: sessionStorage, now: Date.now,
          // The fixture simulates successful reauthentication; the production held-action flow
          // still persists, restores and explicitly confirms the original request.
          navigate: () => queueMicrotask(() => flow.restore()) });
        const controller = createPackagesController({ client,
          requireReauth: (request, options) => flow.requireReauth(request, options, '#/packages') });
        function App() {
          const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
          return <><PackagesView state={state} onOpen={controller.open} onAction={controller.act}
            onNext={() => {}} onVersionNext={() => {}} onRefresh={controller.refresh}
            onConfirm={(reason) => controller.confirmTombstone(reason)} onCancel={controller.cancelTombstone} />
            <ReauthConfirm flow={flow} /></>;
        }
        createRoot(document.getElementById('root')).render(<App />);
        controller.load({ project: null }).then(() => controller.open('package'));
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
        posts.push(await request.json());
        return posts.length === 1
          ? Response.json(
              { error: { code: 'reauth_required', message: 'Reauthentication required' } },
              { status: 403 },
            )
          : Response.json({ versionId: 'version', status: 'tombstoned' });
      }
      if (path === '/_pb/me/permissions')
        return Response.json({ organization: ['org:packages:manage'] });
      if (path.endsWith('/versions'))
        return Response.json({
          items: [
            {
              id: 'version',
              version: '1.0.0',
              status: 'active',
              revision: 1,
              vulnerability: { status: 'unknown', reason: 'not_checked' },
            },
          ],
          next: null,
        });
      return Response.json({
        items: [
          {
            id: 'package',
            name: 'widget',
            ecosystem: 'npm',
            latestVersion: '1.0.0',
            status: 'active',
            source: { id: 'source', name: 'Hosted', type: 'hosted', projectId: null },
            versionCount: 1,
            lastSyncedAt: null,
          },
        ],
        next: null,
      });
    },
  });
});
afterAll(async () => fixture?.close());

describe('tombstone reason in Chromium', () => {
  it(
    'validates UTF-8 bytes and preserves the reason through held-action confirmation',
    { timeout: 30_000 },
    async (context) => {
      context.skip(!fixture, 'Chromium unavailable');
      if (!fixture) return;
      posts.length = 0;
      const { page, browserExpect } = fixture;
      await fixture.mount(script);
      await page.getByRole('button', { name: 'Tombstone', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Tombstone 1.0.0?' });
      const confirm = dialog.getByRole('button', { name: 'Confirm tombstone' });
      const reason = dialog.getByLabel('Reason (required)');
      await browserExpect(confirm).toBeDisabled();
      await reason.fill('   ');
      await browserExpect(confirm).toBeDisabled();
      await reason.fill('é'.repeat(501));
      await browserExpect(reason).toHaveAttribute('aria-invalid', 'true');
      await browserExpect(confirm).toBeDisabled();
      expect(posts).toEqual([]);
      const value = 'é'.repeat(500);
      await reason.fill(value);
      await browserExpect(confirm).toBeEnabled();
      await confirm.click();
      const held = page.getByRole('dialog', { name: 'Send the held action now?' });
      await browserExpect(held).toBeVisible();
      expect(posts).toEqual([{ reason: value }]);
      await held.getByRole('button', { name: 'Tombstone version', exact: true }).click();
      await browserExpect(held).not.toBeVisible();
      expect(posts).toEqual([{ reason: value }, { reason: value }]);
    },
  );
});
