import { afterAll, beforeAll, expect, it } from 'vitest';
import { browserRenderer } from './browser-renderer.js';

let renderer: Awaited<ReturnType<typeof browserRenderer>>;
beforeAll(async () => {
  renderer = await browserRenderer(`
    import { CopyButton } from './components/ui/id-text';
    globalThis.writes = [];
    Object.defineProperty(navigator, 'clipboard', { value: globalThis.result === 'missing' ? undefined : {
      writeText(value) {
        globalThis.writes.push(value);
        if (globalThis.result === 'throws') throw new Error('private-diagnostic');
        return globalThis.result === 'rejected' ? Promise.reject(new Error('private-diagnostic')) : Promise.resolve();
      }
    }});
    createRoot(document.getElementById('root')).render(<CopyButton value="reference-id" label="Copy actor ID" manualFallback />);
  `);
}, 60_000);
afterAll(async () => {
  await renderer?.fixture?.close();
});

it.for(['success', 'rejected', 'missing', 'throws'])(
  'copies an ID with %s clipboard and provides an accessible result',
  async (result, context) => {
    if (!renderer.fixture) context.skip('Chromium cannot start in this environment');
    const { page, browserExpect } = renderer.fixture!;
    await renderer.fixture!.mount(renderer.script, { result });
    await page.getByRole('button', { name: 'Copy actor ID', exact: true }).click();
    const status = page.getByRole('status');
    await browserExpect(status).toHaveClass('basis-full');
    await browserExpect(status).toHaveText(
      result === 'success' ? 'ID copied.' : 'Could not copy ID. Copy the value below.',
    );
    const html = await page.locator('#root').innerHTML();
    expect(html).toContain('aria-label="Copy actor ID"');
    expect(html).toContain('class="basis-full" role="status"');
    expect(html).not.toContain('private-diagnostic');
    if (result === 'success') {
      expect(await page.evaluate(() => Reflect.get(globalThis, 'writes'))).toEqual([
        'reference-id',
      ]);
      expect(html).toContain('ID copied.');
      expect(html).not.toContain('reference-id');
    } else {
      expect(html).toContain('Could not copy ID. Copy the value below.');
      expect(html).toContain('<code class="basis-full break-all">reference-id</code>');
    }
  },
);
