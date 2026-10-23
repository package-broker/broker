import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { describe, expect, it, type TestContext } from 'vitest';

async function mounted(context: TestContext, contents: string) {
  const require = createRequire(new URL('../../e2e/package.json', import.meta.url));
  const { chromium } = await import(require.resolve('@playwright/test'));
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
  let browser;
  try {
    browser = await chromium.launch();
  } catch (error) {
    if (/bootstrap_check_in.*Permission denied|Executable doesn't exist/.test(String(error)))
      context.skip('Chromium cannot start in this environment');
    throw error;
  }
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text });
    return { page, browser };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

describe('mounted review regressions', () => {
  it('keeps source drafts with their IDs after filtering and reordering', async (context) => {
    const { page, browser } = await mounted(
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
      expect(await row('Beta').locator('input[name="interval"]').inputValue()).toBe('300');
      await row('Beta').getByRole('button', { name: 'Save settings', exact: true }).click();
      expect(await page.evaluate('globalThis.edits')).toEqual([['beta', 300, 'flag']]);
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await row('Alpha').getByText('Edit source', { exact: true }).click();
      await row('Alpha').locator('input[name="interval"]').fill('888');
      await page.evaluate('globalThis.reorder()');
      expect(await row('Alpha').locator('input[name="interval"]').inputValue()).toBe('888');
      expect(await row('Beta').locator('input[name="interval"]').inputValue()).toBe('300');
    } finally {
      await browser.close();
    }
  });

  it('clears rendered unapplied text and select values before another submit', async (context) => {
    const { page, browser } = await mounted(
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
      await page.getByLabel('Name', { exact: true }).fill('unapplied');
      await page.getByLabel('Status', { exact: true }).selectOption('revoked');
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      expect(await page.getByLabel('Name', { exact: true }).inputValue()).toBe('');
      expect(await page.getByLabel('Status', { exact: true }).inputValue()).toBe('');
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      expect(await page.locator('output').textContent()).toBe('{"q":"","status":""}');
    } finally {
      await browser.close();
    }
  });
});
