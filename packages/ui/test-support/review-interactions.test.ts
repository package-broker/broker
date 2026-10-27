import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';

import { createBrowserFixture } from './browser-fixture.js';

const components = {
  menuDialog: `
      import { Dialog, DialogContent, DialogTitle } from './components/ui/dialog';
      import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './components/ui/dropdown-menu';
      function MenuDialog() {
        const [open, setOpen] = React.useState(true);
        return <Dialog open={open} onOpenChange={setOpen}><DialogContent>
          <DialogTitle>Menu dialog</DialogTitle>
          <DropdownMenu open><DropdownMenuTrigger>Actions</DropdownMenuTrigger>
            <DropdownMenuContent><DropdownMenuItem>Menu action</DropdownMenuItem></DropdownMenuContent>
          </DropdownMenu>
        </DialogContent></Dialog>;
      }
      createRoot(document.getElementById('root')).render(<MenuDialog />);
    `,
  githubForm: `
      import { SourceForm } from './pages/sources/source-form';
      const source = { id: 'github', name: 'GitHub', ecosystem: 'composer', type: 'vcs', config: { provider: 'github', repository: 'owner/repo', ...(globalThis.authentication === 'app' ? { installationId: 42 } : {}) }, configComplete: true, githubAuthentication: globalThis.authentication, pollIntervalSeconds: 300, removalPolicy: 'flag' };
      globalThis.submissions = [];
      createRoot(document.getElementById('root')).render(<SourceForm source={globalThis.creating ? null : source} busy={false} errors={{}} alert={null} onSubmit={(body) => globalThis.submissions.push(body)} onClose={() => {}} vcsProviders={globalThis.vcsProviders} />);
    `,
  lateProviders: `
      import { SourceForm } from './pages/sources/source-form';
      function Late() {
        const [vcsProviders, setProviders] = React.useState(undefined);
        globalThis.loadProviders = (next) => setProviders(next);
        return <SourceForm source={null} busy={false} errors={{}} alert={null} onSubmit={() => {}} onClose={() => {}} vcsProviders={vcsProviders} />;
      }
      createRoot(document.getElementById('root')).render(<Late />);
    `,
  sources: `
      import { SourcesView, createSourcesModel } from './pages/sources';
      const source = { config: { scopes: ['@fixture'], distHosts: [] }, configComplete: true, projectId: null, ecosystem: 'npm', type: 'npm_registry', url: 'https://registry.example', status: 'active', removalPolicy: 'flag', pollIntervalSeconds: 300, hasCredential: false, lastSuccessAt: null };
      const alpha = { ...source, id: 'alpha', name: 'Alpha', pollIntervalSeconds: 600, attached: true, precedence: 0 };
      const beta = { ...source, id: 'beta', name: 'Beta', attached: true, precedence: 1 };
      let state = { ...createSourcesModel({ client: {}, requireReauth: () => {} }, null).snapshot(), items: [alpha, beta], order: ['alpha', 'beta'], settingsVersion: 0, loading: false, busy: false, listError: false, next: null, credentialSource: null, names: null, preview: null, savedCredential: null, error: null, etag: '"r1"' };
      const listeners = new Set();
      globalThis.edits = [];
      const publish = (patch) => { state = { ...state, ...patch }; for (const listener of listeners) listener(); };
      const model = {
        project: null,
        snapshot: () => state,
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
        openEditor: (source) => publish({ editor: source ?? 'create' }),
        closeEditor: () => publish({ editor: null }),
        saveSource: (body) => { const saved = { ...state.editor, ...body }; globalThis.edits.push([saved.id, saved.pollIntervalSeconds, saved.removalPolicy]); publish({ editor: null }); },
      };
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

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
const bundles: Partial<Record<keyof typeof components, string>> = {};

beforeAll(async () => {
  for (const [name, contents] of Object.entries(components)) {
    const bundle = await build({
      stdin: {
        contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; ${contents}`,
        loader: 'tsx',
        resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'iife',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
    });
    bundles[name as keyof typeof components] = bundle.outputFiles[0]!.text;
  }
  fixture = await createBrowserFixture();
}, 60_000);

afterAll(async () => {
  await fixture?.close();
}, 60_000);

async function mounted(context: TestContext, component: keyof typeof components) {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  await fixture!.mount(bundles[component]!);
  return fixture!;
}

it(
  'renders the mounted sources fixture with all model state initialized without a browser',
  { timeout: 30_000 },
  async () => {
    const contents = components.sources.replace(
      "createRoot(document.getElementById('root')).render",
      'globalThis.fixtureHtml = renderToString',
    );
    const bundle = await build({
      stdin: {
        contents: `import React from 'react'; import { renderToString } from 'react-dom/server'; ${contents}`,
        loader: 'tsx',
        resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
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
  },
);

describe('mounted review regressions', () => {
  for (const [activation, click] of [
    ['without prior user activation', false],
    ['after a pointer click inside the dialog', true],
  ] as const) {
    it(
      `Escape closes only the open menu inside a native modal dialog in Chromium ${activation}`,
      { timeout: 30_000 },
      async (context) => {
        const { page, browserExpect } = await mounted(context, 'menuDialog');
        const dialog = page.getByRole('dialog', { name: 'Menu dialog' });
        await browserExpect(dialog).toBeVisible();
        await browserExpect(dialog.getByRole('menu')).toBeVisible();
        if (click) {
          await dialog.getByRole('heading', { name: 'Menu dialog' }).click();
          await browserExpect(dialog.getByRole('menu')).toHaveCount(0);
          await browserExpect(dialog).toBeVisible();
          await dialog.getByRole('button', { name: 'Actions' }).click();
          await browserExpect(dialog.getByRole('menu')).toBeVisible();
        }
        const item = dialog.getByRole('menuitem', { name: 'Menu action' });
        await item.focus();
        await browserExpect(item).toBeFocused();
        await page.keyboard.press('Escape');
        await browserExpect(dialog.getByRole('menu')).toHaveCount(0);
        await browserExpect(dialog.getByRole('button', { name: 'Actions' })).toBeFocused();
        await browserExpect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await browserExpect(dialog).not.toBeVisible();
      },
    );
  }

  it(
    'keeps source drafts with their IDs after filtering and reordering',
    { timeout: 30_000 },
    async (context) => {
      let step = 'mount sources';
      context.onTestFailed(() => console.error(`Mounted source regression stopped at: ${step}`));
      const { page, browserExpect } = await mounted(context, 'sources');
      await browserExpect(page.locator('tbody tr')).toHaveCount(2);
      await browserExpect(page.locator('dialog[open]')).toHaveCount(0);
      const row = (name: string) => page.locator('tbody tr').filter({ hasText: name });
      const dialog = page.locator('dialog[open]');
      const interval = dialog.getByLabel('Sync interval (seconds)', { exact: true });
      const openEdit = async (name: string) => {
        await row(name)
          .getByRole('button', { name: `Edit ${name}`, exact: true })
          .click();
        await browserExpect(dialog).toHaveCount(1);
        await browserExpect(dialog.getByRole('heading', { name: 'Edit source' })).toBeVisible();
        await dialog.getByText('Advanced settings', { exact: true }).click();
      };
      step = 'open Alpha edit dialog';
      await openEdit('Alpha');
      step = 'fill Alpha draft';
      await browserExpect(interval).toHaveValue('600');
      await interval.fill('777');
      step = 'cancel Alpha edit';
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
      await browserExpect(dialog).toHaveCount(0);
      step = 'filter to Beta';
      await page.getByLabel('Name (loaded sources)', { exact: true }).fill('Beta');
      step = 'submit filters';
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await browserExpect(page.locator('tbody tr')).toHaveCount(1);
      step = 'open Beta edit dialog';
      await openEdit('Beta');
      step = 'verify Beta shows its own value';
      await browserExpect(interval).toHaveValue('300');
      step = 'save Beta settings';
      await dialog.getByRole('button', { name: 'Save source', exact: true }).click();
      await browserExpect(dialog).toHaveCount(0);
      step = 'verify submitted source ID and settings';
      expect(await page.evaluate('globalThis.edits')).toEqual([['beta', 300, 'flag']]);
      step = 'clear filters';
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
      await browserExpect(page.locator('tbody tr')).toHaveCount(2);
      step = 'reorder sources';
      await page.evaluate('globalThis.reorder()');
      await browserExpect(page.locator('tbody tr').first()).toContainText('Beta');
      step = 'open Alpha edit dialog after reorder';
      await openEdit('Alpha');
      step = 'verify Alpha shows its stored value, not the cancelled draft';
      await browserExpect(interval).toHaveValue('600');
    },
  );

  it(
    'clears rendered unapplied text and select values before another submit',
    { timeout: 30_000 },
    async (context) => {
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
    },
  );
});

it.for(['app', 'token'])(
  'fixes the edited GitHub form in %s mode',
  { timeout: 30_000 },
  async (mode, context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await fixture!.mount(bundles.githubForm!, { authentication: mode });
    await page
      .getByLabel('GitHub repository (required)', { exact: true })
      .waitFor({ state: 'visible' });
    await browserExpect(page.locator('select[name="githubAuthentication"]')).toHaveCount(0);
    await browserExpect(page.locator('input[name="githubAuthentication"]')).toHaveValue(mode);
    await browserExpect(page.locator('input[name="githubAuthenticationDisplay"]')).toHaveValue(
      mode === 'app' ? 'GitHub App' : 'Personal access token',
    );
    await browserExpect(page.locator('input[name="githubAuthenticationDisplay"]')).toHaveAttribute(
      'readonly',
      '',
    );
    await browserExpect(page.locator('input[name="config/installationId"]')).toHaveCount(
      mode === 'app' ? 1 : 0,
    );
  },
);

it(
  'offers both GitHub authentication modes when creating a source',
  { timeout: 30_000 },
  async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await fixture!.mount(bundles.githubForm!, { creating: true });
    await page.getByRole('radio', { name: 'Git repository', exact: false }).check();
    const authentication = page.locator('input[name="githubAuthentication"]:checked');
    await browserExpect(authentication).toHaveValue('app');
    await browserExpect(page.locator('input[name="config/installationId"]')).toHaveCount(1);
    await page.getByRole('radio', { name: 'Personal access token', exact: false }).check();
    await browserExpect(authentication).toHaveValue('token');
    await browserExpect(page.locator('input[name="config/installationId"]')).toHaveCount(0);
    await page.getByRole('radio', { name: 'GitHub App', exact: false }).check();
    await browserExpect(authentication).toHaveValue('app');
  },
);

it.for([
  [['github'], ['github']],
  [
    ['github', 'git'],
    ['github', 'git'],
  ],
  [
    ['ssh', 'git', 'github'],
    ['github', 'git', 'ssh'],
  ],
] as const)(
  'offers only the reported repository providers %j',
  { timeout: 30_000 },
  async ([reported, offered], context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await fixture!.mount(bundles.githubForm!, { creating: true, vcsProviders: reported });
    await page.getByRole('radio', { name: 'Git repository', exact: false }).check();
    const provider = page.locator('select[name="config/provider"]');
    await browserExpect(provider).toHaveValue('github');
    expect(
      await provider
        .locator('option')
        .evaluateAll((options: Element[]) =>
          options.map((option) => (option as HTMLOptionElement).value),
        ),
    ).toEqual(offered);
    await browserExpect(page.getByText(/Node runtime/)).toHaveCount(0);
  },
);

it(
  'switches to an offered provider when the reported list arrives late',
  { timeout: 30_000 },
  async (context) => {
    const { page, browserExpect } = await mounted(context, 'lateProviders');
    await page.getByRole('radio', { name: 'Git repository', exact: false }).check();
    await browserExpect(
      page.getByLabel('GitHub repository (required)', { exact: true }),
    ).toBeVisible();
    await page.evaluate(() => {
      (globalThis as unknown as { loadProviders(next: string[]): void }).loadProviders(['git']);
    });
    await browserExpect(
      page.getByLabel('Git repository URL (required)', { exact: true }),
    ).toBeVisible();
    await browserExpect(page.locator('select[name="config/provider"]')).toHaveValue('git');
    await browserExpect(page.locator('input[name="config/installationId"]')).toHaveCount(0);
  },
);

it(
  'blocks empty Composer selection and opens Advanced to focus an invalid interval',
  { timeout: 30_000 },
  async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await fixture!.mount(bundles.githubForm!, { creating: true });
    await page.getByRole('radio', { name: 'Composer repository', exact: false }).check();
    await page.getByLabel('Source name (required)', { exact: true }).fill('Composer');
    await page
      .getByLabel('Repository URL (required)', { exact: true })
      .fill('https://composer.example.com');
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    await browserExpect(
      page.getByText('Add at least one package name or pattern', { exact: true }),
    ).toBeVisible();
    await browserExpect(
      page.getByLabel('Package names (one per line)', { exact: true }),
    ).toBeFocused();
    await page.getByLabel('Package patterns (one per line)', { exact: true }).fill('acme/*');
    await page.getByText('Advanced settings', { exact: true }).click();
    await page.getByLabel('Sync interval (seconds)', { exact: true }).fill('0');
    await page.getByText('Advanced settings', { exact: true }).click();
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    await browserExpect(page.getByLabel('Sync interval (seconds)', { exact: true })).toBeVisible();
    await browserExpect(page.getByLabel('Sync interval (seconds)', { exact: true })).toBeFocused();
    expect(await page.evaluate('globalThis.submissions')).toEqual([]);
  },
);

it(
  'preserves the name across ecosystems and submits only the chosen type fields',
  { timeout: 30_000 },
  async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await fixture!.mount(bundles.githubForm!, { creating: true });
    await page.getByLabel('Source name (required)', { exact: true }).fill('Public packages');
    await page.getByRole('radio', { name: 'Git repository', exact: false }).check();
    await page.getByLabel('GitHub App installation ID (required)', { exact: true }).fill('42');
    await page.getByRole('radio', { name: 'npm', exact: true }).check();
    await browserExpect(
      page.getByRole('radio', { name: 'npmjs proxy', exact: false }),
    ).toBeChecked();
    await browserExpect(page.getByLabel('Source name (required)', { exact: true })).toHaveValue(
      'Public packages',
    );
    await page.getByRole('button', { name: 'Add source', exact: true }).click();
    expect(await page.evaluate('globalThis.submissions')).toEqual([
      {
        name: 'Public packages',
        ecosystem: 'npm',
        type: 'npmjs_proxy',
        url: 'https://registry.npmjs.org',
        userAgent: null,
        pollIntervalSeconds: 300,
        removalPolicy: 'flag',
        defaultVisibleToNewProjects: false,
        retentionDaysOverride: null,
        config: {},
      },
    ]);
  },
);
