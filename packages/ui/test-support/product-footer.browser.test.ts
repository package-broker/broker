import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import { createRoot } from 'react-dom/client';
        import { App, Shell } from './app';
        import { ReauthView } from './auth';
        const root = document.getElementById('root');
        if (globalThis.fixtureScreen === 'local-setup') {
          void import('./setup');
        } else {
          const client = { request: async () => ({ ok: false, status: 401, code: 'unauthorized', details: [] }) };
          if (globalThis.fixtureScreen === 'setup') location.hash = '#/setup';
          const content = ['login', 'setup'].includes(globalThis.fixtureScreen)
            ? <App client={client} />
            : <Shell route="projects" project={null} projects={[]} unknown={null} onScope={() => {}} onSignOut={() => {}}>
                {globalThis.fixtureScreen === 'reauth' ? <ReauthView providers={[]} local={true} error={false} busy={false} onSubmit={() => {}} onSso={() => {}} /> : <h1>Projects</h1>}
              </Shell>;
          createRoot(root).render(content);
        }`,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"', __UI_VERSION__: JSON.stringify(version) },
  });
  script = bundle.outputFiles[0]!.text;
  fixture = await createBrowserFixture();
}, 60_000);
afterAll(async () => fixture?.close());

for (const [screen, heading] of [
  ['login', 'Sign in'],
  ['projects', 'Projects'],
  ['reauth', 'Confirm it is you'],
  ['setup', 'First-run setup'],
  ['local-setup', 'Set up the administrator account'],
] as const) {
  it(`shows one footer outside main on ${screen}, with readable targets and responsive reflow`, async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await fixture!.mount(script, { fixtureScreen: screen });
      await browserExpect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
      const footer = page.getByRole('contentinfo');
      await browserExpect(footer).toHaveCount(1);
      await browserExpect(footer).toBeVisible();
      await browserExpect(footer).toContainText(
        'PACKAGE.broker open-source package registry broker',
      );
      await browserExpect(footer).toContainText(`Version ${version}`);
      await browserExpect(page.getByRole('main').getByRole('contentinfo')).toHaveCount(0);
      await browserExpect(footer.getByRole('link')).toHaveCount(3);
      for (const link of await footer.getByRole('link').all()) {
        await browserExpect(link).toHaveAccessibleName(/opens externally in a new tab/);
        const box = await link.boundingBox();
        expect(box!.height).toBeGreaterThanOrEqual(44);
        expect(box!.width).toBeGreaterThanOrEqual(24);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (width === 1440) {
        const positions = await footer.locator(':scope > *').evaluateAll((nodes: Element[]) =>
          nodes.map((node) => {
            const rect = node.getBoundingClientRect();
            return rect.y + rect.height / 2;
          }),
        );
        expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
      }
    }
  });
}
