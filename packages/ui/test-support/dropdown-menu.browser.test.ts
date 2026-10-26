import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

describe('portalled row menus in Chromium', () => {
  let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
  let bundle: string;
  let browserExpect: NonNullable<typeof fixture>['browserExpect'];

  beforeAll(async () => {
    const result = await build({
      stdin: {
        resolveDir: fileURLToPath(new URL('../src/components/ui/', import.meta.url)),
        loader: 'tsx',
        contents: `
          import React, { useState } from 'react';
          import { createRoot } from 'react-dom/client';
          import { SourceActions } from '../../pages/sources';
          import { Dialog, DialogContent, DialogTitle, DialogTrigger } from './dialog';
          import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from './dropdown-menu';
          const link = document.createElement('link');
          link.rel = 'stylesheet'; link.href = '/fixture-layout.css'; document.head.append(link);
          globalThis.cspViolations = [];
          document.addEventListener('securitypolicyviolation', (event) => globalThis.cspViolations.push(event.violatedDirective));
          const initialSource = { id: 'alpha', name: 'Alpha', projectId: null, type: 'npm_registry', status: 'active' };
          function Fixture() {
            const [row, setRow] = useState(true);
            const [source, setSource] = useState(globalThis.source ?? initialSource);
            globalThis.refreshSource = (patch = {}) => setSource((previous) => ({ ...previous, ...patch }));
            const [selected, setSelected] = useState('');
            const model = { project: globalThis.project ?? null, enableNeedsAdmin: () => globalThis.enableDenied === true, snapshot: () => ({ enableConflicts: globalThis.enableConflict ? [source.id] : [] }), names: () => setSelected('Registered names'), chooseCredential: () => setSelected('Set credential'), syncNow: () => setSelected('Sync now'), togglePause: () => setSelected(source.status === 'paused' ? 'Enabled' : 'Paused') };
            return <>
              <h1 id="page-heading" tabIndex={-1}>Sources</h1>
              <button onClick={() => setRow(false)}>Remove row</button>
              <button>Outside control</button>
              <output>{selected}</output>
              {row && <section className={globalThis.edge ? 'fixture-edge' : 'fixture-table'}>
                <div className="list-card"><div className="table-container"><div className="table-scroll">
                  <table><tbody><tr><td>Alpha</td><td><SourceActions source={source} model={model} busy={false} /></td></tr></tbody></table>
                </div></div></div>
              </section>}
              <Dialog><DialogTrigger>Open modal</DialogTrigger><DialogContent>
                <DialogTitle>Menu in modal</DialogTitle>
                <div className="fixture-modal-scroll">
                  <DropdownMenu><DropdownMenuTrigger>Modal actions</DropdownMenuTrigger><DropdownMenuContent>
                    <DropdownMenuItem onClick={() => setSelected('Alpha action')}>Alpha action</DropdownMenuItem>
                    <DropdownMenuItem disabled onClick={() => setSelected('Disabled')}>Disabled action</DropdownMenuItem>
                    <DropdownMenuItem onClick={(event) => event.preventDefault()}>Keep open</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setSelected('Zulu action')}>Zulu action</DropdownMenuItem>
                    {globalThis.long && Array.from({ length: 40 }, (_, i) => <DropdownMenuItem key={i}>Extra action {i}</DropdownMenuItem>)}
                  </DropdownMenuContent></DropdownMenu>
                </div>
              </DialogContent></Dialog>
            </>;
          }
          createRoot(document.getElementById('root')).render(<Fixture />);
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
    if (fixture) browserExpect = fixture.browserExpect;
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  async function mounted(context: TestContext, query = '', globals: Record<string, unknown> = {}) {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page } = fixture!;
    await page.setViewportSize({ width: 1000, height: 720 });
    await page.route(
      '**/fixture-layout.css',
      (route: { fulfill(options: { contentType: string; body: string }): Promise<void> }) =>
        route.fulfill({
          contentType: 'text/css',
          body: `
      body { min-height: 1600px; }
      .fixture-table { margin: 80px 24px 0; width: 480px; }
      .fixture-edge { position: fixed; right: 0; bottom: 24px; width: 480px; }
      .fixture-edge table { width: 100%; }
      .fixture-edge td:last-child { text-align: right; padding-right: 0; }
      .fixture-modal-scroll { overflow: auto; height: 48px; }
      td { padding: 8px; }
    `,
        }),
    );
    await fixture!.mount(bundle, {
      edge: query.includes('edge'),
      long: query.includes('long'),
      ...globals,
    });
    await browserExpect(page.getByRole('heading', { name: 'Sources' })).toBeVisible();
    return page;
  }

  it(
    'clicks the last row item beyond the table frame without changing table scrollTop under production CSP',
    { timeout: 30_000 },
    async (context) => {
      const page = await mounted(context);
      try {
        const trigger = page.getByRole('button', { name: 'More actions for Alpha' });
        const scroll = page.locator('.table-scroll');
        expect(await scroll.evaluate((element: HTMLElement) => element.scrollTop)).toBe(0);
        await trigger.click();
        const menu = page.getByRole('menu');
        await browserExpect(menu).toBeVisible();
        expect(
          await menu.evaluate((element: HTMLElement) =>
            element.closest('.list-card, .table-scroll'),
          ),
        ).toBeNull();
        const last = page.getByRole('menuitem', { name: 'Registered names' });
        const box = await last.boundingBox();
        const frame = await page.locator('.list-card').boundingBox();
        expect(box!.y + box!.height / 2).toBeGreaterThan(frame!.y + frame!.height);
        expect((await trigger.boundingBox())!.width).toBeLessThan(frame!.width / 2);
        expect(
          await last.evaluate((element: HTMLElement) => {
            const box = element.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return hit === element || element.contains(hit);
          }),
        ).toBe(true);
        expect(await scroll.evaluate((element: HTMLElement) => element.scrollTop)).toBe(0);
        await last.click();
        await browserExpect(page.locator('output')).toHaveText('Registered names');
        await browserExpect(menu).toHaveCount(0);
        await browserExpect(trigger).toBeFocused();
        expect(await page.locator('style').count()).toBe(0);
        expect(await page.evaluate('globalThis.cspViolations')).toEqual([]);
      } finally {
        await page.goto('about:blank');
      }
    },
  );

  it(
    'flips above the last row and shifts within the right viewport edge',
    { timeout: 30_000 },
    async (context) => {
      const page = await mounted(context, '?edge');
      try {
        const trigger = page.getByRole('button', { name: 'More actions for Alpha' });
        await trigger.click();
        const menu = page.getByRole('menu');
        await browserExpect(menu).toHaveAttribute('data-side', 'top');
        const box = await menu.boundingBox();
        const anchor = await trigger.boundingBox();
        expect(anchor!.x + anchor!.width).toBeGreaterThan(992);
        expect(box!.y + box!.height).toBeLessThanOrEqual(anchor!.y);
        expect(box!.x).toBeGreaterThanOrEqual(8);
        expect(box!.x + box!.width).toBeLessThanOrEqual(992);
      } finally {
        await page.goto('about:blank');
      }
    },
  );

  it(
    'tracks the trigger while the document scrolls and dismisses on an outside click',
    { timeout: 30_000 },
    async (context) => {
      const page = await mounted(context);
      try {
        const trigger = page.getByRole('button', { name: 'More actions for Alpha' });
        await trigger.click();
        await page.evaluate(() => window.scrollBy(0, 30));
        await browserExpect
          .poll(async () => {
            const menu = await page.getByRole('menu').boundingBox();
            const anchor = await trigger.boundingBox();
            return Math.abs(menu!.y - anchor!.y - anchor!.height - 4);
          })
          .toBeLessThan(2);
        await page.getByRole('button', { name: 'Outside control' }).click();
        await browserExpect(page.getByRole('menu')).toHaveCount(0);
        await browserExpect(page.getByRole('button', { name: 'Outside control' })).toBeFocused();
      } finally {
        await page.goto('about:blank');
      }
    },
  );

  it(
    'navigates arrows, Home/End and typeahead, prevents disabled activation, and consumes only the first modal Escape',
    { timeout: 30_000 },
    async (context) => {
      const page = await mounted(context);
      try {
        await page.getByRole('button', { name: 'Open modal' }).click();
        const dialog = page.getByRole('dialog', { name: 'Menu in modal' });
        const trigger = dialog.getByRole('button', { name: 'Modal actions' });
        await trigger.focus();
        await page.keyboard.press('ArrowDown');
        const menu = dialog.getByRole('menu');
        await browserExpect(menu).toBeVisible();
        expect(
          await menu.evaluate((element: HTMLElement) => element.closest('.fixture-modal-scroll')),
        ).toBeNull();
        const host = dialog.locator('[data-overlay-host]');
        await browserExpect(host.getByRole('menu')).toBeVisible();
        await browserExpect(dialog.getByRole('menuitem', { name: 'Alpha action' })).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await browserExpect(
          dialog.getByRole('menuitem', { name: 'Disabled action' }),
        ).toBeFocused();
        await page.keyboard.press('Enter');
        await browserExpect(page.locator('output')).toHaveText('');
        await browserExpect(menu).toBeVisible();
        await page.keyboard.press('ArrowDown');
        await browserExpect(dialog.getByRole('menuitem', { name: 'Keep open' })).toBeFocused();
        await page.keyboard.press('Enter');
        await browserExpect(menu).toBeVisible();
        await page.keyboard.press('End');
        await browserExpect(dialog.getByRole('menuitem', { name: 'Zulu action' })).toBeFocused();
        await page.keyboard.press('ArrowUp');
        await browserExpect(dialog.getByRole('menuitem', { name: 'Keep open' })).toBeFocused();
        await page.keyboard.press('Home');
        await browserExpect(dialog.getByRole('menuitem', { name: 'Alpha action' })).toBeFocused();
        await page.keyboard.press('z');
        await browserExpect(dialog.getByRole('menuitem', { name: 'Zulu action' })).toBeFocused();
        await page.keyboard.press('Escape');
        await browserExpect(menu).toHaveCount(0);
        await browserExpect(trigger).toBeFocused();
        await browserExpect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await browserExpect(dialog).not.toBeVisible();
        expect(await page.locator('style').count()).toBe(0);
        expect(await page.evaluate('globalThis.cspViolations')).toEqual([]);
      } finally {
        await page.goto('about:blank');
      }
    },
  );

  it(
    'keeps a tall modal menu inside the viewport with reachable final items',
    { timeout: 30_000 },
    async (context) => {
      const page = await mounted(context, '?long');
      try {
        await page.getByRole('button', { name: 'Open modal' }).click();
        await page.getByRole('button', { name: 'Modal actions' }).click();
        const menu = page.getByRole('menu');
        await browserExpect(menu).toBeVisible();
        const box = await menu.boundingBox();
        expect(box!.y).toBeGreaterThanOrEqual(8);
        expect(box!.y + box!.height).toBeLessThanOrEqual(712);
        await menu.focus();
        await page.keyboard.press('End');
        const last = page.getByRole('menuitem', { name: 'Extra action 39' });
        await browserExpect(last).toBeFocused();
        await browserExpect(last).toBeInViewport();
      } finally {
        await page.goto('about:blank');
      }
    },
  );

  it(
    'keeps Pause confirmation alive after selection and restores More or the heading after row removal',
    { timeout: 30_000 },
    async (context) => {
      const page = await mounted(context);
      try {
        const trigger = page.getByRole('button', { name: 'More actions for Alpha' });
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Pause source…' }).click();
        const dialog = page.getByRole('dialog', { name: 'Pause?' });
        await browserExpect(page.getByRole('menu')).toHaveCount(0);
        await browserExpect(dialog).toBeVisible();
        expect(
          await dialog.evaluate((element: HTMLElement) => element.closest('[role="menu"]')),
        ).toBeNull();
        await browserExpect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
        await page.keyboard.press('Escape');
        await browserExpect(trigger).toBeFocused();
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Pause source…' }).click();
        await dialog.getByRole('button', { name: 'Confirm pause' }).click();
        await browserExpect(page.locator('output')).toHaveText('Paused');
        await browserExpect(trigger).toBeFocused();
        await trigger.click();
        await page.getByRole('menuitem', { name: 'Pause source…' }).click();
        await page
          .getByRole('button', { name: 'Remove row' })
          .evaluate((element: HTMLButtonElement) => element.click());
        await browserExpect(dialog).not.toBeVisible();
        await browserExpect(page.locator('#page-heading')).toBeFocused();
      } finally {
        await page.goto('about:blank');
      }
    },
  );
  it(
    'closes More with Escape and restores focus to its trigger',
    { timeout: 30_000 },
    async (context) => {
      const page = await mounted(context);
      const trigger = page.getByRole('button', { name: 'More actions for Alpha' });
      await trigger.click();
      await page.getByRole('menuitem', { name: 'Registered names' }).focus();
      await page.keyboard.press('Escape');
      await browserExpect(page.getByRole('menu')).toHaveCount(0);
      await browserExpect(trigger).toBeFocused();
      const cancelled = await trigger.evaluate(
        (element: HTMLElement) =>
          !element.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
          ),
      );
      expect(cancelled).toBe(false);
    },
  );

  it('Escape from outside the menu does not close it', { timeout: 30_000 }, async (context) => {
    const page = await mounted(context);
    await page.getByRole('button', { name: 'More actions for Alpha' }).click();
    const cancelled = await page
      .getByRole('button', { name: 'Outside control' })
      .evaluate(
        (element: HTMLElement) =>
          !element.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
          ),
      );
    expect(cancelled).toBe(false);
    await browserExpect(page.getByRole('menu')).toBeVisible();
  });

  for (const focused of ['item', 'trigger']) {
    it(
      `consumes Escape in a DropdownMenu rendered inside a Dialog with focus on the ${focused}`,
      { timeout: 30_000 },
      async (context) => {
        const page = await mounted(context);
        await page.getByRole('button', { name: 'Open modal' }).click();
        const dialog = page.getByRole('dialog', { name: 'Menu in modal' });
        const trigger = dialog.getByRole('button', { name: 'Modal actions' });
        await trigger.click();
        await browserExpect(dialog.getByRole('menu')).toBeVisible();
        if (focused === 'trigger') await trigger.focus();
        else await dialog.getByRole('menuitem', { name: 'Alpha action' }).focus();
        await page.keyboard.press('Escape');
        await browserExpect(dialog.getByRole('menu')).toHaveCount(0);
        await browserExpect(trigger).toBeFocused();
        await browserExpect(dialog).toBeVisible();
        await page.keyboard.press('Escape');
        await browserExpect(dialog).not.toBeVisible();
      },
    );
  }

  for (const status of ['degraded', 'failing']) {
    it(
      `pauses a ${status} source only after confirmation`,
      { timeout: 30_000 },
      async (context) => {
        const page = await mounted(context, '', {
          source: { id: 'alpha', name: 'Alpha', projectId: null, type: 'npm_registry', status },
        });
        await page.getByRole('button', { name: 'More actions for Alpha' }).click();
        await page.getByRole('menuitem', { name: 'Pause source…' }).click();
        const dialog = page.getByRole('dialog', { name: 'Pause?' });
        await browserExpect(dialog).toBeVisible();
        await browserExpect(page.getByRole('menu')).toHaveCount(0);
        await browserExpect(page.locator('output')).toHaveText('');
        await dialog.getByRole('button', { name: 'Confirm pause' }).click();
        await browserExpect(page.locator('output')).toHaveText('Paused');
        await browserExpect(dialog).not.toBeVisible();
      },
    );
  }

  it(
    'keeps Pause confirmation on a same-id refresh, closes on status or id change, and mutates only on confirmation',
    { timeout: 30_000 },
    async (context) => {
      const page = await mounted(context);
      const trigger = page.getByRole('button', { name: 'More actions for Alpha' });
      await trigger.click();
      await page.getByRole('menuitem', { name: 'Pause source…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Pause?' });
      await browserExpect(dialog).toBeVisible();
      await browserExpect(page.locator('output')).toHaveText('');
      await page.evaluate('globalThis.refreshSource()');
      await browserExpect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Confirm pause' }).click();
      await browserExpect(page.locator('output')).toHaveText('Paused');
      await trigger.click();
      await page.getByRole('menuitem', { name: 'Pause source…' }).click();
      await page.evaluate("globalThis.refreshSource({ status: 'paused' })");
      await browserExpect(dialog).not.toBeVisible();
      await page.evaluate("globalThis.refreshSource({ status: 'active' })");
      await trigger.click();
      await page.getByRole('menuitem', { name: 'Pause source…' }).click();
      await page.evaluate("globalThis.refreshSource({ id: 'beta' })");
      await browserExpect(dialog).not.toBeVisible();
    },
  );

  for (const [name, globals, label, message, disabled] of [
    [
      'admin',
      {
        source: {
          id: 'alpha',
          name: 'Alpha',
          projectId: 'acme',
          status: 'paused',
          type: 'npm_registry',
        },
        enableDenied: true,
      },
      'Enable',
      'An organization admin must enable this source.',
      true,
    ],
    [
      'conflict',
      {
        source: {
          id: 'alpha',
          name: 'Alpha',
          projectId: null,
          status: 'paused',
          type: 'npm_registry',
        },
        enableConflict: true,
      },
      'Enable',
      'Register package names, then enable the source.',
      false,
    ],
    [
      'admin and conflict',
      {
        source: {
          id: 'alpha',
          name: 'Alpha',
          projectId: 'acme',
          status: 'paused',
          type: 'npm_registry',
        },
        enableDenied: true,
        enableConflict: true,
      },
      'Enable',
      'An organization admin must enable this source. Register package names, then enable the source.',
      true,
    ],
    [
      'organization',
      { project: 'acme' },
      'Manage source',
      'Manage this organization source in organization scope.',
      true,
    ],
  ] as const) {
    it(
      `places the ${name} explanation outside role=menu and describes its item`,
      { timeout: 30_000 },
      async (context) => {
        const page = await mounted(context, '', globals);
        await page.getByRole('button', { name: 'More actions for Alpha' }).click();
        const menu = page.getByRole('menu');
        const item = menu.getByRole('menuitem', { name: label, exact: true });
        await browserExpect(item).toHaveAccessibleDescription(message);
        if (disabled) await browserExpect(item).toHaveAttribute('aria-disabled', 'true');
        else await browserExpect(item).not.toHaveAttribute('aria-disabled', 'true');
        expect(await menu.locator('p').count()).toBe(0);
        await browserExpect(page.getByText(message, { exact: true })).toBeVisible();
      },
    );
  }
});
