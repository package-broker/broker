import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { Shell } from './app';
        createRoot(document.getElementById('root')).render(
          <Shell route={globalThis.fixtureRoute ?? 'projects'} project="acme" projects={[]}
            unknown={null} onScope={() => {}} onSignOut={() => {}}
            visibleRoutes={['projects', 'access', 'sources', 'packages', 'tokens',
              ...(globalThis.fixtureAdministration ?? ['audit', 'import'])]} />
        );`,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('../src/', import.meta.url)),
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  script = bundle.outputFiles[0]!.text;
  fixture = await createBrowserFixture();
}, 60_000);
afterAll(async () => fixture?.close());

describe('shell navigation', () => {
  it('aligns administration right on desktop and keeps link and control keyboard order', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await page.setViewportSize({ width: 1440, height: 800 });
    await fixture!.mount(script, { fixtureRoute: 'audit' });
    const nav = page.getByRole('navigation', { name: 'Main', exact: true });
    await browserExpect(page.getByRole('navigation')).toHaveCount(1);
    await browserExpect(nav.getByRole('list')).toHaveCount(2);
    await browserExpect(nav.getByRole('list').first().getByRole('link')).toHaveText([
      'Projects',
      'Access',
      'Sources',
      'Packages',
      'Tokens',
    ]);
    await browserExpect(
      nav.getByRole('list', { name: 'Administration' }).getByRole('link'),
    ).toHaveText(['Audit', 'Import']);
    await browserExpect(nav.getByRole('separator')).toBeHidden();
    await browserExpect(nav.getByRole('link', { name: 'Audit', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const tokens = await nav.getByRole('link', { name: 'Tokens', exact: true }).boundingBox();
    const audit = await nav.getByRole('link', { name: 'Audit', exact: true }).boundingBox();
    const imported = await nav.getByRole('link', { name: 'Import', exact: true }).boundingBox();
    const scope = await page.getByRole('combobox', { name: 'Scope' }).boundingBox();
    expect(audit!.x - (tokens!.x + tokens!.width)).toBeGreaterThan(50);
    expect(imported!.x + imported!.width).toBeLessThan(scope!.x);
    expect(audit!.y).toBe(tokens!.y);
    await nav.getByRole('link', { name: 'Projects', exact: true }).focus();
    for (const name of ['Access', 'Sources', 'Packages', 'Tokens', 'Audit', 'Import']) {
      await page.keyboard.press('Tab');
      await browserExpect(nav.getByRole('link', { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press('Tab');
    await browserExpect(page.getByRole('combobox', { name: 'Scope' })).toBeFocused();
    await page.keyboard.press('Tab');
    await browserExpect(page.getByRole('button', { name: 'Account', exact: true })).toBeFocused();
  });

  for (const administration of [[], ['audit'], ['import'], ['audit', 'import']]) {
    it(`shows the mobile divider only with visible administration items: ${administration.join(', ')}`, async (context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await page.setViewportSize({ width: 390, height: 800 });
      await fixture!.mount(script, {
        fixtureAdministration: administration,
        fixtureRoute: 'tokens',
      });
      const nav = page.getByRole('navigation', { name: 'Main', exact: true });
      await browserExpect(nav).toBeHidden();
      await page.getByRole('button', { name: 'Main menu', exact: true }).click();
      await browserExpect(nav).toBeVisible();
      await browserExpect(nav.getByRole('link')).toHaveText([
        'Projects',
        'Access',
        'Sources',
        'Packages',
        'Tokens',
        ...administration.map((route) => (route === 'audit' ? 'Audit' : 'Import')),
      ]);
      await browserExpect(nav.getByRole('list')).toHaveCount(administration.length ? 2 : 1);
      await browserExpect(nav.getByRole('separator')).toHaveCount(administration.length ? 1 : 0);
      if (administration.length) {
        await browserExpect(nav.getByRole('separator')).toBeVisible();
        const primary = await nav.getByRole('list').first().boundingBox();
        const divider = await nav.getByRole('separator').boundingBox();
        const secondary = await nav.getByRole('list', { name: 'Administration' }).boundingBox();
        expect(divider!.y).toBeGreaterThanOrEqual(primary!.y + primary!.height);
        expect(secondary!.y).toBeGreaterThan(divider!.y);
      } else {
        await browserExpect(nav.getByRole('list', { name: 'Administration' })).toHaveCount(0);
      }
      await browserExpect(nav.getByRole('link', { name: 'Tokens', exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      await nav.getByRole('link', { name: 'Tokens', exact: true }).click();
      await browserExpect(nav).toBeHidden();
      await browserExpect(
        page.getByRole('button', { name: 'Main menu', exact: true }),
      ).toHaveAttribute('aria-expanded', 'false');
    });
  }
});
