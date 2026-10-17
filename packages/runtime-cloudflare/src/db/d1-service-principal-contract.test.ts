import { afterAll } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { describeServicePrincipalContract } from '@package-broker/db-sqlite/contract/service-principal-contract';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['SPDB'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

describeServicePrincipalContract('d1', async () => {
  const db = (await mf.getD1Database('SPDB')) as unknown as D1DatabaseLike;
  return { executor: createD1Executor(db), close: async () => {} };
});
