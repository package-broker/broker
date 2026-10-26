import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it, type TestContext } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let bundle: string;
beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: fileURLToPath(new URL('../src/components/ui/', import.meta.url)),
      loader: 'tsx',
      contents: `
        import React, { StrictMode, useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { useOverlayHost } from './overlay-host';
        import { Dialog, DialogContent, DialogTitle } from './dialog';
        import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu';
        function Consumer() { useOverlayHost(); return null; }
        globalThis.refs = { trigger: null, popup: null, dialog: null, cleanup: 0 };
        const triggerRef = { get current() { return globalThis.refs.trigger; }, set current(value) { globalThis.refs.trigger = value; } };
        function Fixture() {
          const [count, setCount] = useState(0);
          const [modal, setModal] = useState(false);
          globalThis.setConsumers = setCount;
          globalThis.setModal = setModal;
          return <>
            <output>{count}</output>
            {Array.from({ length: count }, (_, i) => <Consumer key={i} />)}
            {modal && <Dialog defaultOpen><DialogContent ref={(element: HTMLElement) => { globalThis.refs.dialog = element; }}>
              <DialogTitle>Overlay modal</DialogTitle>
              <div className="overflow-auto">
                <DropdownMenu><DropdownMenuTrigger ref={triggerRef}>Actions</DropdownMenuTrigger>
                  <DropdownMenuContent ref={(element: HTMLElement) => { globalThis.refs.popup = element; return () => { globalThis.refs.popup = null; globalThis.refs.cleanup++; }; }}>
                    <DropdownMenuItem>First action</DropdownMenuItem><DropdownMenuItem>A much longer action</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </DialogContent></Dialog>}
          </>;
        }
        createRoot(document.getElementById('root')).render(<StrictMode><Fixture /></StrictMode>);
      `,
    },
    bundle: true,
    write: false,
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  bundle = result.outputFiles[0]!.text;
  fixture = await createBrowserFixture();
}, 60_000);
afterAll(async () => {
  await fixture?.close();
});
async function mounted(context: TestContext) {
  if (!fixture) context.skip('Chromium cannot start in this environment');
  await fixture!.mount(bundle);
  await fixture!.browserExpect(fixture!.page.locator('output')).toHaveText('0');
  return fixture!;
}

it(
  'lazily shares one document-root host and releases it only after the last consumer unmounts',
  { timeout: 30_000 },
  async (context) => {
    const { page, browserExpect } = await mounted(context);
    const hosts = page.locator('body > [data-overlay-host]');
    await browserExpect(hosts).toHaveCount(0);
    await page.evaluate('globalThis.setConsumers(3)');
    await browserExpect(hosts).toHaveCount(1);
    await hosts.evaluate((element: HTMLElement) => element.setAttribute('data-original', 'true'));
    await page.evaluate('globalThis.setConsumers(1)');
    await browserExpect(hosts).toHaveAttribute('data-original', 'true');
    await page.evaluate('globalThis.setConsumers(0)');
    await browserExpect(hosts).toHaveCount(0);
    await page.evaluate('globalThis.setConsumers(2)');
    await browserExpect(hosts).toHaveCount(1);
    expect(await hosts.getAttribute('data-original')).toBeNull();
  },
);

it(
  'uses a real showModal top layer host, fills item rows and merges caller refs with internal refs',
  { timeout: 30_000 },
  async (context) => {
    const { page, browserExpect } = await mounted(context);
    await page.evaluate('globalThis.setModal(true)');
    const dialog = page.getByRole('dialog', { name: 'Overlay modal' });
    await browserExpect(dialog).toBeVisible();
    expect(await dialog.evaluate((element: HTMLElement) => element.matches(':modal'))).toBe(true);
    await browserExpect(page.locator('body > [data-overlay-host]')).toHaveCount(0);
    const trigger = dialog.getByRole('button', { name: 'Actions' });
    await trigger.click();
    const menu = dialog.getByRole('menu');
    await browserExpect(dialog.locator('[data-overlay-host]').getByRole('menu')).toBeVisible();
    expect(
      await menu.evaluate((element: HTMLElement) => element.closest('.overflow-auto')),
    ).toBeNull();
    expect(
      await page.evaluate(
        `globalThis.refs.dialog.matches(':modal') && globalThis.refs.trigger.getAttribute('aria-expanded') === 'true' && globalThis.refs.popup.getAttribute('role') === 'menu'`,
      ),
    ).toBe(true);
    const widths = await menu
      .getByRole('menuitem')
      .evaluateAll((items: HTMLElement[]) =>
        items.map((item) => item.getBoundingClientRect().width),
      );
    expect(widths[0]).toBe(widths[1]);
    await page.keyboard.press('Escape');
    await browserExpect(menu).toHaveCount(0);
    expect(
      await page.evaluate('globalThis.refs.popup === null && globalThis.refs.cleanup > 0'),
    ).toBe(true);
    await browserExpect(trigger).toBeFocused();
    await page.evaluate('globalThis.setModal(false)');
    await browserExpect(dialog).toHaveCount(0);
    expect(
      await page.evaluate('globalThis.refs.trigger === null && globalThis.refs.dialog === null'),
    ).toBe(true);
    await browserExpect(page.locator('[data-overlay-host]')).toHaveCount(0);
  },
);
