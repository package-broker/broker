import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';

async function launchBrowser() {
  const require = createRequire(new URL('../../e2e/package.json', import.meta.url));
  const { chromium, expect: browserExpect } = await import(require.resolve('@playwright/test'));
  try {
    return { browser: await chromium.launch(), browserExpect };
  } catch (error) {
    if (/bootstrap_check_in.*Permission denied|Executable doesn't exist/.test(String(error)))
      return undefined;
    throw error;
  }
}

let fixture: Awaited<ReturnType<typeof launchBrowser>>;

beforeAll(async () => {
  fixture = await launchBrowser();
});

afterAll(async () => {
  await fixture?.browser.close();
});

async function mounted(context: TestContext, contents: string) {
  if (!fixture) context.skip('Chromium cannot start in this environment');
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
  const page = await fixture!.browser.newPage();
  try {
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    return { page, browserExpect: fixture!.browserExpect };
  } catch (error) {
    await page.close();
    throw error;
  }
}

describe('mounted review regressions', () => {
  it('keeps source drafts with their IDs after filtering and reordering', async (context) => {
    const { page, browserExpect } = await mounted(
      context,
      `
      import { SourcesView } from './pages/sources';
      const source = { projectId: null, ecosystem: 'npm', type: 'npm_registry', url: 'https://registry.example', status: 'active', removalPolicy: 'flag', pollIntervalSeconds: 300, hasCredential: false, lastSuccessAt: null };
      const alpha = { ...source, id: 'alpha', name: 'Alpha', attached: true, precedence: 0 };
      const beta = { ...source, id: 'beta', name: 'Beta', attached: true, precedence: 1 };
      let state = { items: [alpha, beta], order: ['alpha', 'beta'], settingsVersion: 0, loading: false, busy: false, listError: false, next: null, credentialSource: null, names: null, preview: null, savedCredential: null, error: null, etag: '"r1"' };
      const listeners = new Set();
      globalThis.edits = [];
      const model = { project: null, snapshot: () => state, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }, edit: (...args) => globalThis.edits.push(args) };
      globalThis.reorder = () => { state = { ...state, items: [beta, alpha], order: ['beta', 'alpha'] }; for (const listener of listeners) listener(); };
      createRoot(document.getElementById('root')).render(<SourcesView model={model} />);
    `,
    );
    try {
      const row = (name: string) => page.locator('tbody tr').filter({ hasText: name });
      await row('Alpha').getByText('Edit source', { exact: true }).click();
      await row('Alpha').locator('input[name="interval"]').fill('777');
      await page.getByLabel('Name (loaded sources)', { exact: true }).fill('Beta');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await row('Beta').getByText('Edit source', { exact: true }).click();
      await browserExpect(row('Beta').locator('input[name="interval"]')).toHaveValue('300');
      await row('Beta').getByRole('button', { name: 'Save settings', exact: true }).click();
      expect(await page.evaluate('globalThis.edits')).toEqual([['beta', 300, 'flag']]);
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await row('Alpha').getByText('Edit source', { exact: true }).click();
      await row('Alpha').locator('input[name="interval"]').fill('888');
      await page.evaluate('globalThis.reorder()');
      await browserExpect(page.locator('tbody tr').first()).toContainText('Beta');
      await browserExpect(row('Alpha').locator('input[name="interval"]')).toHaveValue('888');
      await browserExpect(row('Beta').locator('input[name="interval"]')).toHaveValue('300');
    } finally {
      await page.close();
    }
  });

  it('clears rendered unapplied text and select values before another submit', async (context) => {
    const { page, browserExpect } = await mounted(
      context,
      `
      import { LoadedListFilters } from './components/ui/toolbar';
      function Filters() {
        const [values, setValues] = React.useState({ q: '', status: '' });
        return <><LoadedListFilters values={values} fields={[{ key: 'q', label: 'Name' }, { key: 'status', label: 'Status', options: ['active', 'revoked'] }]} onChange={setValues} /><output>{JSON.stringify(values)}</output></>;
      }
      createRoot(document.getElementById('root')).render(<Filters />);
    `,
    );
    try {
      const name = page.getByLabel('Name', { exact: true });
      const status = page.getByLabel('Status', { exact: true });
      await name.waitFor({ state: 'visible' });
      await name.fill('unapplied');
      await status.selectOption('revoked');
      await browserExpect(name).toHaveValue('unapplied');
      await browserExpect(status).toHaveValue('revoked');
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await browserExpect(name).toHaveValue('');
      await browserExpect(status).toHaveValue('');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await browserExpect(page.locator('output')).toHaveText('{"q":"","status":""}');
    } finally {
      await page.close();
    }
  });
});
