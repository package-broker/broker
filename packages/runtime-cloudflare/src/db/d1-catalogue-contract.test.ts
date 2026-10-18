import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { describeCatalogueContract } from '../../../db-sqlite/src/contract/catalogue-contract.js';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = Array.from({ length: 32 }, (_, i) => `CATALOGUE${i}`);
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);
let next = 0;

afterAll(async () => {
  await mf.dispose();
});

describeCatalogueContract('Miniflare D1', async () => {
  const binding = bindings[next++];
  if (binding === undefined) throw new Error('out of D1 bindings');
  const database = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  return { executor: createD1Executor(database), close: async () => {} };
});
