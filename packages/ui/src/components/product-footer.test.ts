import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };
afterEach(() => vi.unstubAllGlobals());

it('renders the product, build version and three named external links in one footer', async () => {
  vi.stubGlobal('__UI_VERSION__', version);
  const { ProductFooter } = await import('./product-footer.js');
  const html = renderToStaticMarkup(createElement(ProductFooter));
  expect(html).toContain('<strong>PACKAGE.broker</strong> open-source package registry broker');
  expect(html).toContain(`Version ${version}`);
  expect(html.match(/<footer\b/g)).toHaveLength(1);
  expect(html.match(/<a\b/g)).toHaveLength(3);
  for (const [label, href] of [
    ['AGPL-3.0', 'https://github.com/package-broker/broker/blob/main/LICENSE'],
    ['Source code', 'https://github.com/package-broker/broker'],
    ['Documentation', 'https://package.broker/docs/'],
  ]) {
    expect(html).toContain(
      `href="${href}" target="_blank" rel="noopener noreferrer" aria-label="${label} (opens externally in a new tab)"`,
    );
  }
});
