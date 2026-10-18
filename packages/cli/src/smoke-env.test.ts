import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = (file: string) => fileURLToPath(new URL(`../../../${file}`, import.meta.url));

describe('node bundle smoke environment', () => {
  it('sets every variable the node ports stanza of the repository broker config reads', async () => {
    const config = await readFile(root('broker.config.ts'), 'utf8');
    const smoke = await readFile(root('scripts/node-bundle-smoke.mjs'), 'utf8');
    const names = [
      ...config.slice(config.indexOf('node: {')).matchAll(/\w+Env:\s*'([A-Z][A-Z0-9_]+)'/g),
    ].map((match) => match[1] ?? '');
    expect(names).toEqual(expect.arrayContaining(['PB_BLOB_ROOT', 'DEPLOYMENT_ID']));
    for (const name of names) expect(smoke).toMatch(new RegExp(`\\b${name}:\\s*\\S`));
  });
});
