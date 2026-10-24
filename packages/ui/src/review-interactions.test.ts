import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';

async function launchBrowser() {
  const require = createRequire(new URL('../../e2e/package.json', import.meta.url));
  const { chromium, expect: browserExpect } = await import(require.resolve('@playwright/test'));
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    return { browser, page, browserExpect };
  } catch (error) {
    await browser?.close();
    if (/bootstrap_check_in.*Permission denied|Executable doesn't exist/.test(String(error)))
      return undefined;
    throw error;
  }
}

const components = {
  githubForm: `
      import { SourceForm } from './pages/sources/source-form';
      const source = { id: 'github', name: 'GitHub', ecosystem: 'composer', type: 'vcs', githubAuthentication: globalThis.authentication, pollIntervalSeconds: 300, removalPolicy: 'flag' };
      createRoot(document.getElementById('root')).render(<SourceForm source={globalThis.creating ? null : source} busy={false} errors={{}} alert={null} onSubmit={() => {}} onClose={() => {}} />);
    `,
  sources: `
      import { SourcesView, createSourcesModel } from './pages/sources';
      const source = { projectId: null, ecosystem: 'npm', type: 'npm_registry', url: 'https://registry.example', status: 'active', removalPolicy: 'flag', pollIntervalSeconds: 300, hasCredential: false, lastSuccessAt: null };
      const alpha = { ...source, id: 'alpha', name: 'Alpha', attached: true, precedence: 0 };
      const beta = { ...source, id: 'beta', name: 'Beta', attached: true, precedence: 1 };
      let state = { ...createSourcesModel({ client: {}, requireReauth: () => {} }, null).snapshot(), items: [alpha, beta], order: ['alpha', 'beta'], settingsVersion: 0, loading: false, busy: false, listError: false, next: null, credentialSource: null, names: null, preview: null, savedCredential: null, error: null, etag: '"r1"' };
      const listeners = new Set();
      globalThis.edits = [];
      const model = { project: null, snapshot: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, edit: (...args) => globalThis.edits.push(args) };
      globalThis.reorder = () => { state = { ...state, items: [beta, alpha], order: ['beta', 'alpha'] }; for (const listener of listeners) listener(); };
      createRoot(document.getElementById('root')).render(<SourcesView model={model} />);
    `,
  filters: `
      import { LoadedListFilters } from './components/ui/toolbar';
      function Filters() {
        const [values, setValues] = React.useState({ q: '', status: '' });
        return <><LoadedListFilters values={values} fields={[{ key: 'q', label: 'Name' }, { key: 'status', label: 'Status', options: ['active', 'revoked'] }]} onChange={setValues} /><output>{JSON.stringify(values)}</output></>;
      }
      createRoot(document.getElementById('root')).render(<Filters />);
    `,
};

let fixture: Awaited<ReturnType<typeof launchBrowser>>;
const bundles: Partial<Record<keyof typeof components, string>> = {};

beforeAll(async () => {
  for (const [name, contents] of Object.entries(components)) {
    const bundle = await build({
      stdin: {
        contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; ${contents}`,
        loader: 'tsx',
        resolveDir: fileURLToPath(new URL('.', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    bundles[name as keyof typeof components] = bundle.outputFiles[0]!.text;
  }
  fixture = await launchBrowser();
}, 60_000);

afterAll(async () => {
  try {
    await fixture?.page.close();
  } finally {
    await fixture?.browser.close();
  }
}, 60_000);

async function mounted(context: TestContext, component: keyof typeof components) {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  const { page, browserExpect } = fixture!;
  await page.goto('about:blank');
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundles[component]! });
  return { page, browserExpect };
}

it('renders the mounted sources fixture with all model state initialized without a browser', async () => {
  const contents = components.sources.replace(
    "createRoot(document.getElementById('root')).render",
    'globalThis.fixtureHtml = renderToString',
  );
  const bundle = await build({
    stdin: {
      contents: `import React from 'react'; import { renderToString } from 'react-dom/server'; ${contents}`,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
    },
    bundle: true,
    write: false,
    platform: 'node',
    external: ['react', 'react-dom', 'react-dom/*'],
    format: 'cjs',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const context = { require: createRequire(import.meta.url), queueMicrotask, fixtureHtml: '' };
  runInNewContext(bundle.outputFiles[0]!.text, context);
  expect(context.fixtureHtml).toContain('Alpha');
  expect(context.fixtureHtml).toContain('Beta');
  expect(context.fixtureHtml).not.toContain('<dialog');
});

describe('mounted review regressions', () => {
  it('keeps source drafts with their IDs after filtering and reordering', async (context) => {
    let step = 'mount sources';
    context.onTestFailed(() => console.error(`Mounted source regression stopped at: ${step}`));
    const { page, browserExpect } = await mounted(context, 'sources');
    await browserExpect(page.locator('tbody tr')).toHaveCount(2);
    await browserExpect(page.locator('dialog[open]')).toHaveCount(0);
    const row = (name: string) => page.locator('tbody tr').filter({ hasText: name });
    step = 'open Alpha settings';
    await row('Alpha').getByText('Edit source', { exact: true }).click();
    step = 'fill Alpha draft';
    await row('Alpha').locator('input[name="interval"]').fill('777');
    step = 'filter to Beta';
    await page.getByLabel('Name (loaded sources)', { exact: true }).fill('Beta');
    step = 'submit filters';
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    step = 'open Beta settings';
    await row('Beta').getByText('Edit source', { exact: true }).click();
    step = 'verify Beta draft';
    await browserExpect(row('Beta').locator('input[name="interval"]')).toHaveValue('300');
    step = 'save Beta settings';
    await row('Beta').getByRole('button', { name: 'Save settings', exact: true }).click();
    step = 'verify submitted source ID and settings';
    expect(await page.evaluate('globalThis.edits')).toEqual([['beta', 300, 'flag']]);
    step = 'clear filters';
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    step = 'open Alpha settings';
    await row('Alpha').getByText('Edit source', { exact: true }).click();
    step = 'fill Alpha draft';
    await row('Alpha').locator('input[name="interval"]').fill('888');
    step = 'reorder sources and verify both drafts';
    await page.evaluate('globalThis.reorder()');
    await browserExpect(page.locator('tbody tr').first()).toContainText('Beta');
    await browserExpect(row('Alpha').locator('input[name="interval"]')).toHaveValue('888');
    step = 'verify Beta draft';
    await browserExpect(row('Beta').locator('input[name="interval"]')).toHaveValue('300');
  });

  it('clears rendered unapplied text and select values before another submit', async (context) => {
    let step = 'mount filters';
    context.onTestFailed(() => console.error(`Mounted filter regression stopped at: ${step}`));
    const { page, browserExpect } = await mounted(context, 'filters');
    const name = page.getByLabel('Name', { exact: true });
    // A wrapping label includes its select's option text in getByLabel's match.
    const status = page.locator('select[name="status"]');
    step = 'wait for Name field';
    await name.waitFor({ state: 'visible' });
    step = 'fill unapplied Name';
    await name.fill('unapplied');
    step = 'choose revoked Status';
    await status.selectOption('revoked');
    step = 'verify unapplied text and select values';
    await browserExpect(name).toHaveValue('unapplied');
    await browserExpect(status).toHaveValue('revoked');
    step = 'clear filters';
    await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
    step = 'verify cleared text and select values';
    await browserExpect(name).toHaveValue('');
    await browserExpect(status).toHaveValue('');
    step = 'submit filters';
    await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
    step = 'verify empty values after submitting again';
    await browserExpect(page.locator('output')).toHaveText('{"q":"","status":""}');
  });
});

it.for(['app', 'token'])('fixes the edited GitHub form in %s mode', async (mode, context) => {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  const { page, browserExpect } = fixture!;
  await page.goto('about:blank');
  await page.setContent('<div id="root"></div>');
  await page.evaluate((value: string) => {
    Object.assign(globalThis, { authentication: value });
  }, mode);
  await page.addScriptTag({ content: bundles.githubForm! });
  await page.getByLabel('Replace type-specific configuration', { exact: true }).check();
  await browserExpect(page.locator('select[name="githubAuthentication"]')).toHaveCount(0);
  await browserExpect(page.locator('input[name="githubAuthentication"]')).toHaveValue(mode);
  await browserExpect(page.locator('input[name="githubAuthentication"]')).toHaveAttribute(
    'readonly',
    '',
  );
  await browserExpect(page.locator('input[name="config/installationId"]')).toHaveCount(
    mode === 'app' ? 1 : 0,
  );
});

it('offers both GitHub authentication modes when creating a source', async (context) => {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  const { page, browserExpect } = fixture!;
  await page.goto('about:blank');
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    Object.assign(globalThis, { creating: true });
  });
  await page.addScriptTag({ content: bundles.githubForm! });
  await page.locator('select[name="type"]').selectOption('vcs');
  const authentication = page.locator('select[name="githubAuthentication"]');
  await browserExpect(authentication).toHaveValue('app');
  await browserExpect(page.locator('input[name="config/installationId"]')).toHaveCount(1);
  await authentication.selectOption('token');
  await browserExpect(authentication).toHaveValue('token');
  await browserExpect(page.locator('input[name="config/installationId"]')).toHaveCount(0);
  await authentication.selectOption('app');
  await browserExpect(authentication).toHaveValue('app');
});
