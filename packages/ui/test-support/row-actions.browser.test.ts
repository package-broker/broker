import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBrowserFixture } from './browser-fixture.js';

let fixture: Awaited<ReturnType<typeof createBrowserFixture>>;
let script: string;
const timeout = 5_000;

beforeAll(async () => {
  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { RowActions } from '../src/components/ui/row-actions';
        globalThis.calls = []; globalThis.submits = 0;
        function Fixture() {
          const [state, setState] = React.useState({});
          globalThis.setRowState = setState;
          const action = (id, label) => ({ id, label, onSelect: () => {
            globalThis.calls.push(id);
            setState({ pending: true });
          }, ...state });
          return <form onSubmit={e => { e.preventDefault(); globalThis.submits++; }}>
            <p id="reason">Unavailable while syncing</p>
            <RowActions entityLabel="Alpha" actions={[
              action('edit', state.long ? 'A very long translated action label that can wrap across several lines' : 'Edit'),
              action('sync', 'Sync now')
            ]} overflow={[{ ...action('remove', 'Remove'), describedBy: 'reason', variant: 'destructive' }]} />
          </form>;
        }
        createRoot(document.getElementById('root')).render(<Fixture />);`,
      loader: 'tsx',
      resolveDir: fileURLToPath(new URL('.', import.meta.url)),
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

afterAll(async () => {
  await fixture?.close();
});

async function setState(state: Record<string, boolean>) {
  await fixture!.page.evaluate(
    (next: Record<string, boolean>) =>
      (globalThis as unknown as { setRowState(state: unknown): void }).setRowState(next),
    state,
  );
}

describe('RowActions browser', () => {
  it.for<[number, number]>([
    [1280, 32],
    [390, 40],
  ])(
    'shares computed metrics at %i px across action states',
    { timeout: 30_000 },
    async ([width, height], context) => {
      if (!fixture) context.skip('Chromium cannot start in this environment');
      const { page, browserExpect } = fixture!;
      await page.setViewportSize({ width, height: 720 });
      await fixture!.mount(script);
      const controls = page.getByRole('group', { name: 'Actions for Alpha' }).getByRole('button');
      await browserExpect(controls).toHaveCount(3, { timeout });
      const edit = page.getByRole('button', { name: 'Edit Alpha', exact: true });
      for (const state of [{}, { pending: true }, { disabled: true }]) {
        await setState(state);
        if ('disabled' in state) await browserExpect(edit).toBeDisabled({ timeout });
        else if ('pending' in state)
          await browserExpect(edit).not.toHaveAttribute('disabled', { timeout });
        else await browserExpect(edit).toBeEnabled({ timeout });
        if ('pending' in state)
          await browserExpect(edit).toHaveAttribute('aria-disabled', 'true', { timeout });
        else await browserExpect(edit).not.toHaveAttribute('aria-disabled', 'true', { timeout });
        const metrics = await controls.evaluateAll((nodes: Element[]) =>
          nodes.map((node) => {
            const css = getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return {
              height: rect.height,
              top: rect.top,
              font: css.fontSize,
              lineHeight: css.lineHeight,
              padding: css.padding,
              width: rect.width,
            };
          }),
        );
        for (const metric of metrics) {
          expect(metric.height).toBe(height);
          expect(metric.top).toBe(metrics[0]!.top);
          expect(metric.font).toBe(metrics[0]!.font);
          expect(metric.lineHeight).toBe(metrics[0]!.lineHeight);
          expect(metric.padding).toBe(metrics[0]!.padding);
          expect(metric.width).toBeLessThan(width);
        }
      }
    },
  );

  it('opens overflow, preserves pending focus, guards activation and never submits', async (context) => {
    if (!fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = fixture!;
    await page.setViewportSize({ width: 390, height: 720 });
    await fixture!.mount(script);
    const edit = page.getByRole('button', { name: 'Edit Alpha', exact: true });
    await edit.focus();
    await page.keyboard.press('Enter');
    await browserExpect(edit).toHaveAttribute('aria-disabled', 'true', { timeout });
    await browserExpect(edit).not.toHaveAttribute('disabled', { timeout });
    await browserExpect(edit).toBeFocused({ timeout });
    await page.keyboard.press('Enter');
    await edit.evaluate((node: HTMLButtonElement) => node.click());
    await browserExpect(edit).toBeFocused({ timeout });
    const more = page.getByRole('button', { name: 'More actions for Alpha', exact: true });
    await more.focus();
    await page.keyboard.press('Enter');
    const remove = page.getByRole('menuitem', { name: 'Remove Alpha', exact: true });
    await browserExpect(remove).toBeVisible({ timeout });
    await browserExpect(remove).toHaveAttribute('aria-disabled', 'true', { timeout });
    await browserExpect(remove).toHaveAttribute('aria-busy', 'true', { timeout });
    await browserExpect(remove).toHaveAttribute('aria-describedby', 'reason', { timeout });
    // Exercise the guard directly because Playwright respects aria-disabled on click.
    await remove.evaluate((node: HTMLElement) => node.click());
    await browserExpect(remove).toBeVisible({ timeout });
    await page.keyboard.press('Escape');
    await browserExpect(more).toBeFocused({ timeout });
    await setState({});
    await browserExpect(edit).not.toHaveAttribute('aria-disabled', 'true', { timeout });
    await more.click();
    await browserExpect(remove).toBeVisible({ timeout });
    await remove.click();
    await browserExpect(remove).not.toBeVisible({ timeout });
    expect(
      await page.evaluate(() => ({
        calls: (globalThis as unknown as { calls: string[] }).calls,
        submits: (globalThis as unknown as { submits: number }).submits,
      })),
    ).toEqual({ calls: ['edit', 'remove'], submits: 0 });
    await setState({ long: true });
    const long = page.getByRole('button', { name: /^A very long/ });
    await browserExpect(long).toBeVisible({ timeout });
    expect(
      await long.evaluate(
        (node: HTMLElement) =>
          node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight,
      ),
    ).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );
  }, 30_000);
});
