import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createNodeServer } from './index.js';

it('serves the committed OpenAPI document without credentials or an organization', async () => {
  const broker = createNodeServer([], { log: () => undefined });
  try {
    const response = await (
      await broker.ready()
    ).fetch(new Request('https://broker.invalid/_pb/openapi.json'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe(
      await readFile(new URL('../../ui/openapi.json', import.meta.url), 'utf8'),
    );
  } finally {
    await broker.close();
  }
});
