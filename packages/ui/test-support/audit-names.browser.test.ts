import { afterAll, beforeAll, expect, it } from 'vitest';
import { browserRenderer } from './browser-renderer.js';

let renderer: Awaited<ReturnType<typeof browserRenderer>>;
beforeAll(async () => {
  renderer = await browserRenderer(`
    import { createApiClient } from './api';
    import { ServicesContext } from './auth';
    import { AuditPage, clearAuditNames } from './pages/audit';
    globalThis.calls = []; globalThis.pending = {}; globalThis.refreshed = false;
    globalThis.account = 'a';
    const event = (seq, type, id) => ({ seq, actor: { type, id }, targetType: 'project',
      targetId: 'web', projectId: 'web', action: 'project.update', createdAt: '2026-10-22T10:00:00Z' });
    const fetch = async (url) => {
      globalThis.calls.push(url);
      const path = url.split('?')[0];
      if (globalThis.refreshed && path === '/_pb/me' && !globalThis.identityReleased)
        await new Promise(resolve => globalThis.pending.identity = resolve);
      if (globalThis.refreshed && path === '/_pb/me/permissions')
        await new Promise(resolve => globalThis.pending.names = resolve);
      return Response.json(path === '/_pb/me' ? { user: { id: globalThis.account, displayName: globalThis.account } } :
        path === '/_pb/me/permissions' ? { organization: ['org:users:read'] } :
        { items: path === '/_pb/users' ? (globalThis.refreshed ? [{ id: 'fresh', displayName: 'Fresh name' }] : [{ id: 'other', displayName: 'Private name' }]) :
          path === '/_pb/me/tokens' ? (globalThis.refreshed ? [] : [{ id: 'token', name: 'Private token' }]) :
          path.endsWith('/audit') ? [event(1, 'user', 'other'), event(2, 'user', 'fresh'), event(3, 'token', 'token'), event(4, 'user', 'a'), event(5, 'user', 'b')] : [], next: null });
    };
    const makeClient = () => createApiClient({ fetch, readCookie: () => undefined });
    let client = makeClient();
    function Fixture() {
      const [services, setServices] = React.useState({ client, features: { auditTrail: true }, organizationAuditor: false });
      globalThis.refresh = change => {
        globalThis.refreshed = true;
        globalThis.account = change === 'user' ? 'b' : 'a';
        clearAuditNames(client);
        if (change === 'client') {
          client = makeClient();
          setServices({ ...services, client });
        } else if (change === 'scope') window.location.hash = '#/audit?project=other&limit=50';
        else document.querySelector('button[type="submit"]').click();
      };
      return <ServicesContext.Provider value={services}><AuditPage /></ServicesContext.Provider>;
    }
    window.location.hash = '#/audit?project=web&limit=50';
    createRoot(document.getElementById('root')).render(<Fixture />);
  `);
}, 60_000);
afterAll(async () => {
  await renderer?.fixture?.close();
});

it.for(['same', 'user', 'client', 'scope'])(
  'retains names during rechecking only for the same user, client and scope (%s)',
  async (change, context) => {
    if (!renderer.fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = renderer.fixture!;
    await renderer.fixture!.mount(renderer.script);
    const root = page.locator('#root');
    await browserExpect(root).toContainText('Private name');
    await browserExpect(root).toContainText('Private token');
    await page.evaluate((value: string) => Reflect.get(globalThis, 'refresh')(value), change);
    await expect
      .poll(() => page.evaluate(() => !!Reflect.get(globalThis, 'pending').identity))
      .toBe(true);
    await commit(page);
    if (change === 'client' || change === 'scope') {
      await browserExpect(root).not.toContainText('Private name');
      await browserExpect(root).not.toContainText('Private token');
    } else {
      await browserExpect(root).toContainText('Private name');
      await browserExpect(root).toContainText('Private token');
    }
    await page.evaluate(() => {
      Reflect.set(globalThis, 'identityReleased', true);
      Reflect.get(globalThis, 'pending').identity();
    });
    await expect
      .poll(() => page.evaluate(() => !!Reflect.get(globalThis, 'pending').names))
      .toBe(true);
    await commit(page);
    if (change === 'same') {
      await browserExpect(root).toContainText('Private name');
      await browserExpect(root).toContainText('Private token');
    } else {
      await browserExpect(root).not.toContainText('Private name');
      await browserExpect(root).not.toContainText('Private token');
    }
    await page.evaluate(() => Reflect.get(globalThis, 'pending').names());
    await browserExpect(root).toContainText('Fresh name');
    await browserExpect(root).not.toContainText('Private name');
    await browserExpect(root).not.toContainText('Private token');
    await browserExpect(
      page.getByRole('button', { name: `Copy ID: ${change === 'user' ? 'b' : 'a'}`, exact: true }),
    ).toHaveCount(1);
    if (change === 'user')
      await browserExpect(
        page.getByRole('button', { name: 'Copy ID: a', exact: true }),
      ).toHaveCount(0);
  },
);

async function commit(page: NonNullable<typeof renderer.fixture>['page']) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
