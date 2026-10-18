import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { countCalls } from '@package-broker/db-sqlite/contract/count-calls';
import { seedTwoOrganizations } from '@package-broker/db-sqlite/contract/two-organizations';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { createSourceRepository } from '@package-broker/db-sqlite/repositories/source';
import { createD1Executor, type D1DatabaseLike } from './d1-executor.js';

let mf: Miniflare;
let executor: SqlExecutor;
let a: OrgContext;
let b: OrgContext;

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      compatibilityDate: '2026-10-01',
      d1Databases: ['SOURCE'],
    } as Parameters<typeof convertV4MiniflareOptions>[0]),
  );
  executor = createD1Executor((await mf.getD1Database('SOURCE')) as unknown as D1DatabaseLike);
  const sources = await Promise.all(
    readdirSync(migrationsDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()
      .map((name) =>
        loadMigrationSource('core', name, readFileSync(join(migrationsDirectory, name), 'utf8')),
      ),
  );
  await migrate(executor, sources, { holder: 'source-lookup-test' });
  ({ a, b } = await seedTwoOrganizations(executor));
});

afterEach(async () => {
  await mf.dispose();
});

describe('source repository lookup', () => {
  async function insert(
    id: string,
    configJson = JSON.stringify({ provider: 'github', repository: 'Acme/Widget' }),
    options: { org?: OrgContext; projectId?: string; type?: string } = {},
  ) {
    await executor.batch([
      stmt(
        `INSERT INTO source (id, org_id, project_id, name, ecosystem, type, config_json)
         VALUES (?, ?, ?, ?, 'composer', ?, ?)`,
        id,
        (options.org ?? a).orgId,
        options.projectId ?? null,
        id,
        options.type ?? 'vcs',
        configJson,
      ),
    ]);
  }

  async function lookup(repositoryName = 'acme/widget', provider = 'github') {
    const counted = countCalls(executor);
    const result = await createSourceRepository(counted.executor).findByRepository(a, {
      provider,
      repository: repositoryName,
    });
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    return result;
  }

  it('finds the stored id with either repository case and compares providers exactly', async () => {
    await insert('LOOKUP-ORG');
    expect(await lookup()).toEqual(await createSourceRepository(executor).get(a, 'LOOKUP-ORG'));
    expect((await lookup('ACME/WIDGET'))?.id).toBe('LOOKUP-ORG');
    expect(await lookup('acme/widget', 'git')).toBeNull();
    expect(await lookup('acme/widget', 'GitHub')).toBeNull();
    expect(await lookup('acme/missing')).toBeNull();
  });

  it('does not find a matching source of another real organization', async () => {
    await insert('LOOKUP-FOREIGN', undefined, { org: b });
    expect(await lookup()).toBeNull();
  });

  it('ignores non-vcs, malformed and non-object configurations without throwing', async () => {
    await insert('LOOKUP-NON-VCS', undefined, { type: 'composer_repository' });
    await executor.all(stmt('PRAGMA ignore_check_constraints = ON'));
    for (const [index, config] of ['{broken', 'null', '[]', '"Acme/Widget"', '42'].entries()) {
      await insert(`LOOKUP-INVALID-${String(index)}`, config);
    }
    await executor.all(stmt('PRAGMA ignore_check_constraints = OFF'));
    expect(await lookup()).toBeNull();
    await insert('LOOKUP-VALID');
    expect((await lookup())?.id).toBe('LOOKUP-VALID');
  });

  it('finds project and organization sources and returns the lower id regardless of insertion order', async () => {
    const projectId = 'LOOKUP-PROJECT';
    await executor.batch([
      stmt(
        'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        projectId,
        a.orgId,
        'lookup-project',
        'Lookup',
      ),
    ]);
    await insert('LOOKUP-Z-PROJECT', undefined, { projectId });
    expect(await lookup()).toMatchObject({ id: 'LOOKUP-Z-PROJECT', projectId });
    await insert('LOOKUP-A-ORG');
    expect(await lookup()).toMatchObject({ id: 'LOOKUP-A-ORG', projectId: null });
    await insert('LOOKUP-0-PROJECT', undefined, { projectId });
    expect(await lookup()).toMatchObject({ id: 'LOOKUP-0-PROJECT', projectId });
  });
});
