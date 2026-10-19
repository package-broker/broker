import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { describeServicePrincipalContract } from '@package-broker/db-sqlite/contract/service-principal-contract';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const bindings = ['SPDB0', 'SPDB1'];
let next = 0;

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: bindings,
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

describeServicePrincipalContract('d1', async () => {
  const binding = bindings[next++];
  if (binding === undefined) throw new Error('out of D1 bindings');
  const db = (await mf.getD1Database(binding)) as unknown as D1DatabaseLike;
  return { executor: createD1Executor(db), close: async () => {} };
});
