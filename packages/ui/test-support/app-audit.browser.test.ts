import { afterAll, beforeAll, expect, it } from 'vitest';
import { browserRenderer } from './browser-renderer.js';

let renderer: Awaited<ReturnType<typeof browserRenderer>>;
beforeAll(async () => {
  renderer = await browserRenderer(`
    import { useAuditCapabilities } from './app';
    import { ServicesContext } from './auth';
    import { AuditPage } from './pages/audit';
    globalThis.calls = []; globalThis.pending = {}; globalThis.auditPending = [];
    const client = { request: async (_method, path) => {
      globalThis.calls.push(path);
      if (globalThis.defer && (path === '/_pb/me' || path === '/_pb/me/permissions')) {
        return new Promise(resolve => { globalThis.pending[path] = resolve; });
      }
      if (path === '/_pb/me' && globalThis.failure) return { ok: false, status: 503 };
      const response = { ok: true, data: path === '/_pb/me' ? { features: { auditTrail: globalThis.auditTrail } } :
        path === '/_pb/me/permissions' ? { organization: globalThis.organizationAuditor ? ['org:audit:read'] : [] } : { items: [], next: null } };
      if (globalThis.holdAudit && path.startsWith('/_pb/audit')) return new Promise(resolve => globalThis.auditPending.push(() => resolve(response)));
      return response;
    }};
    function Fixture() {
      const [location, setLocation] = React.useState({ session: 'in', hash: globalThis.direct ? '#/audit' : '#/projects' });
      globalThis.navigate = (session, hash) => setLocation({ session, hash });
      const { audit, refreshAuditCapabilities } = useAuditCapabilities(client, location.session, location.hash);
      globalThis.snapshot = audit;
      return globalThis.direct ? <ServicesContext.Provider value={{ client, ...audit, refreshAuditCapabilities }}><AuditPage /></ServicesContext.Provider> : <output>{JSON.stringify(audit)}</output>;
    }
    createRoot(document.getElementById('root')).render(<Fixture />);
  `);
}, 60_000);
afterAll(async () => {
  await renderer?.fixture?.close();
});

async function mount(context: { skip(message: string): never }, globals = {}) {
  if (!renderer.fixture) context.skip('Chromium cannot start in this environment');
  await renderer.fixture.mount(renderer.script, {
    auditTrail: true,
    organizationAuditor: false,
    ...globals,
  });
  return renderer.fixture;
}
async function snapshot(page: NonNullable<typeof renderer.fixture>['page']) {
  return page.evaluate(() => Reflect.get(globalThis, 'snapshot'));
}
async function calls(page: NonNullable<typeof renderer.fixture>['page']) {
  return page.evaluate(() => Reflect.get(globalThis, 'calls'));
}
async function navigate(
  page: NonNullable<typeof renderer.fixture>['page'],
  session: string,
  hash: string,
) {
  await page.evaluate(
    ([s, h]: string[]) => Reflect.get(globalThis, 'navigate')(s, h),
    [session, hash],
  );
}
async function respond(page: NonNullable<typeof renderer.fixture>['page'], path: string) {
  await page.evaluate(
    (p: string) =>
      Reflect.get(globalThis, 'pending')[p]({
        ok: true,
        data:
          p === '/_pb/me'
            ? { features: { auditTrail: true } }
            : { organization: ['org:audit:read'] },
      }),
    path,
  );
}

async function commit(page: NonNullable<typeof renderer.fixture>['page']) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

it.for<[boolean, boolean]>([
  [true, false],
  [false, false],
  [false, true],
])(
  'loads the navigation effect for active trail %s and organization auditor %s',
  async ([auditTrail, organizationAuditor], context) => {
    const { page } = await mount(context, { auditTrail, organizationAuditor });
    await expect
      .poll(() => snapshot(page))
      .toEqual({ features: { auditTrail }, organizationAuditor });
    await navigate(page, 'in', '#/audit');
    await commit(page);
    await expect
      .poll(() => snapshot(page))
      .toEqual({ features: { auditTrail }, organizationAuditor });
    expect(await calls(page)).toHaveLength(2);
    await navigate(page, 'out', '#/login');
    await expect
      .poll(() => snapshot(page))
      .toEqual({ features: undefined, organizationAuditor: null });
  },
);

it('retries failed /me on navigation and reloads after signing out', async (context) => {
  const { page } = await mount(context, { failure: true });
  await expect.poll(() => snapshot(page)).toEqual({ features: null, organizationAuditor: false });
  expect(await calls(page)).toHaveLength(2);
  await page.evaluate(() => Reflect.set(globalThis, 'failure', false));
  await navigate(page, 'in', '#/tokens');
  await expect
    .poll(() => snapshot(page))
    .toEqual({ features: { auditTrail: true }, organizationAuditor: false });
  expect(await calls(page)).toHaveLength(3);
  await navigate(page, 'out', '#/login');
  await expect
    .poll(() => snapshot(page))
    .toEqual({ features: undefined, organizationAuditor: null });
  await navigate(page, 'in', '#/projects');
  await expect.poll(() => calls(page)).toHaveLength(5);
});

it('discards a capability response that finishes after sign-out', async (context) => {
  const { page } = await mount(context, { defer: true });
  await expect.poll(() => calls(page)).toHaveLength(2);
  await navigate(page, 'out', '#/login');
  await expect
    .poll(() => snapshot(page))
    .toEqual({ features: undefined, organizationAuditor: null });
  await respond(page, '/_pb/me');
  await respond(page, '/_pb/me/permissions');
  await commit(page);
  expect(await snapshot(page)).toEqual({ features: undefined, organizationAuditor: null });
});

it.for(['/_pb/me', '/_pb/me/permissions'])(
  'keeps a direct Audit link loading when %s arrives first',
  async (first, context) => {
    const { page, browserExpect } = await mount(context, {
      defer: true,
      direct: true,
      holdAudit: true,
    });
    const loading = page.getByText('Loading audit events…', { exact: true });
    await browserExpect(loading).toBeVisible();
    await browserExpect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => calls(page)).toHaveLength(2);
    await respond(page, first);
    await commit(page);
    expect((await snapshot(page)).features).toBeUndefined();
    await browserExpect(loading).toBeVisible();
    await browserExpect(page.getByRole('alert')).toHaveCount(0);
    expect(await calls(page)).toHaveLength(2);
    await respond(page, first === '/_pb/me' ? '/_pb/me/permissions' : '/_pb/me');
    await expect
      .poll(() => snapshot(page))
      .toEqual({ features: { auditTrail: true }, organizationAuditor: true });
    await browserExpect(loading).toBeVisible();
    await browserExpect(page.getByRole('alert')).toHaveCount(0);
    await expect.poll(() => calls(page)).toHaveLength(5);
    await page.evaluate(() =>
      Reflect.get(globalThis, 'auditPending').forEach((finish: () => void) => finish()),
    );
    await browserExpect(loading).toHaveCount(0);
    await browserExpect(page.getByRole('alert')).toHaveCount(0);
    expect(
      (await calls(page)).filter((path: string) => path === '/_pb/me/permissions'),
    ).toHaveLength(1);
    expect(await calls(page)).toEqual([
      '/_pb/me',
      '/_pb/me/permissions',
      '/_pb/audit/status',
      '/_pb/audit',
      '/_pb/audit/head',
    ]);
  },
);

it('shows a busy loading state while retrying failed capabilities', async (context) => {
  const { page, browserExpect } = await mount(context, { direct: true, failure: true });
  await browserExpect(page.getByRole('alert')).toContainText(
    'Audit capabilities could not be loaded. Try again.',
  );
  await page.evaluate(() => {
    Reflect.set(globalThis, 'failure', false);
    Reflect.set(globalThis, 'defer', true);
  });
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  const loading = page.locator('[data-list-state="loading"]');
  await browserExpect(loading).toContainText('Loading audit events…');
  await browserExpect(loading).toHaveAttribute('aria-busy', 'true');
  await browserExpect(page.getByRole('alert')).toHaveCount(0);
  await respond(page, '/_pb/me');
  await browserExpect(loading).toHaveCount(0);
  await browserExpect(page.getByRole('alert')).toHaveCount(0);
});
