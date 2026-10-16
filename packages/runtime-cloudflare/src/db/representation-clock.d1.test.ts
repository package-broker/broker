import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createRepresentationClock } from '@package-broker/db-sqlite/repositories/representation-clock';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['CLOCK'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

afterAll(async () => {
  await mf.dispose();
});

describe('D1 representation clock', () => {
  it('keeps rev 5 for a stale rev 4, then advances to rev 6', async () => {
    const require = createRequire(import.meta.url);
    const directory = join(
      dirname(require.resolve('@package-broker/db-sqlite/package.json')),
      'migrations',
    );
    const sources = await Promise.all(
      readdirSync(directory)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) =>
          loadMigrationSource('core', name, readFileSync(join(directory, name), 'utf8')),
        ),
    );
    const executor = createD1Executor(
      (await mf.getD1Database('CLOCK')) as unknown as D1DatabaseLike,
    );
    await migrate(executor, sources, { holder: 'clock-test' });
    const { a: ctx } = await seedTwoOrganizations(executor);
    const projectId = '01J0PROJ000000000000000000';
    await executor.all({
      sql: 'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      params: [projectId, ctx.orgId, 'p', 'P'],
    });
    const clock = createRepresentationClock(executor);
    const input = {
      projectId,
      packageId: 'package-a',
      keyHash: 'a'.repeat(64),
      form: 'composer-p2' as const,
      validator: '1'.repeat(64),
      rev: 5,
    };
    const first = await clock.advance(ctx, input);
    const before = await executor.all({ sql: 'SELECT * FROM representation_clock', params: [] });
    const stale = await clock.advance(ctx, { ...input, validator: '2'.repeat(64), rev: 4 });
    expect(stale).toEqual({ ...first, stale: true });
    expect(await executor.all({ sql: 'SELECT * FROM representation_clock', params: [] })).toEqual(
      before,
    );
    const newer = await clock.advance(ctx, { ...input, validator: '3'.repeat(64), rev: 6 });
    expect(newer.stale).toBe(false);
    expect(newer.validator).toBe('3'.repeat(64));
    expect(Date.parse(newer.lastModified) - Date.parse(first.lastModified)).toBeGreaterThanOrEqual(
      1000,
    );
    expect(await executor.all({ sql: 'SELECT rev FROM representation_clock', params: [] })).toEqual(
      [{ rev: 6 }],
    );
  }, 120_000);
});
