import { createHash, randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import * as vitest from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext, type SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import {
  provisionMcpFixture,
  runMcpContract,
  type McpContractBroker,
} from '@package-broker/core/mcp/contract';
import * as mcpTools from '@package-broker/core/mcp/tools';
import { loadMigrationSource } from '@package-broker/db-sqlite/migrations/source';
import type { MigrationSource } from '@package-broker/db-sqlite/migrations/source';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createD1Executor, type D1DatabaseLike } from './db/d1-executor.js';
import { createWorker, type Env } from './index.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ORIGIN = 'https://broker.test';

const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    compatibilityDate: '2026-10-01',
    d1Databases: ['MCPDB0'],
  } as Parameters<typeof convertV4MiniflareOptions>[0]),
);

vitest.afterAll(async () => {
  await mf.dispose();
});

const require = createRequire(import.meta.url);
const migrationsDirectory = join(
  dirname(require.resolve('@package-broker/db-sqlite/package.json')),
  'migrations',
);

async function migrationSources(): Promise<MigrationSource[]> {
  const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  return Promise.all(
    names.map(async (name) =>
      loadMigrationSource('core', name, await readFile(join(migrationsDirectory, name), 'utf8')),
    ),
  );
}

async function seedPackages(
  executor: SqlExecutor,
  seed: { orgId: string; projectId: string; count: number },
): Promise<void> {
  const sourceId = ulid();
  await executor.batch([
    {
      sql: "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES (?, ?, 'seed', 'composer', 'composer_repository')",
      params: [sourceId, seed.orgId],
    },
    {
      sql: 'INSERT INTO project_source (org_id, project_id, source_id, precedence) VALUES (?, ?, ?, 0)',
      params: [seed.orgId, seed.projectId, sourceId],
    },
    ...Array.from({ length: seed.count }, (_, index) => {
      const id = ulid();
      const name = `vendor/package-${String(index).padStart(3, '0')}`;
      return [
        {
          sql: "INSERT INTO package (id, org_id, source_id, ecosystem, name) VALUES (?, ?, ?, 'composer', ?)",
          params: [id, seed.orgId, sourceId, name],
        },
        {
          sql: "INSERT INTO project_package (org_id, project_id, package_id, origin, ecosystem, name) VALUES (?, ?, ?, 'explicit', 'composer', ?)",
          params: [seed.orgId, seed.projectId, id, name],
        },
      ];
    }).flat(),
  ]);
}

runMcpContract(
  {
    runtime: 'workers',
    async create({ binding }) {
      const raw = (await mf.getD1Database('MCPDB0')) as unknown as D1DatabaseLike;
      const executor = createD1Executor(raw);
      await migrate(executor, await migrationSources(), { holder: 'mcp-contract' });
      const env: Env = {
        DB: raw,
        PB_MASTER_KEY: KEY,
        PB_PUBLIC_URL: ORIGIN,
        ...(binding === undefined ? {} : { MCP_RATE_LIMIT: binding }),
      };
      const worker = createWorker([], { mcp: { enabled: true }, log: () => undefined });
      let stub: Parameters<McpContractBroker['stubRest']>[0] = null;
      const createTools = mcpTools.createMcpTools;
      const toolsSpy = vitest.vi
        .spyOn(mcpTools, 'createMcpTools')
        .mockImplementationOnce((options) =>
          createTools({
            ...options,
            kernel: {
              fetch: async (request) =>
                stub === null ? options.kernel.fetch(request) : stub(request),
            },
          }),
        );
      await worker.services(env).finally(() => toolsSpy.mockRestore());
      const rest = (request: Request) => worker.fetch(request, env);
      const orgId = ulid();
      const now = new Date();
      await createOrganizationBootstrap(executor).bootstrap({
        id: orgId,
        slug: 'acme',
        name: 'Acme',
        now: now.toISOString(),
      });
      const setupToken = randomBytes(32).toString('base64url');
      await bootstrapAdmin(executor, orgContext(orgId), {
        email: 'admin@example.test',
        userId: ulid(),
        setupHash: createHash('sha256').update(setupToken).digest('hex'),
        setupExpiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
        grantId: ulid(),
        roleIds: Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, ulid()])) as Record<
          DefaultRoleKey,
          string
        >,
        opId: ulid(),
        now: now.toISOString(),
      });
      const fixture = await provisionMcpFixture({
        origin: ORIGIN,
        call: rest,
        setupToken,
        orgId,
        seedPackages: (seed) => seedPackages(executor, seed),
      });
      return {
        origin: ORIGIN,
        tokens: fixture.tokens,
        cookie: fixture.cookie,
        packagesInAlpha: fixture.packagesInAlpha,
        mcp: rest,
        rest,
        stubRest: (handler) => {
          stub = handler;
        },
        close: async () => undefined,
      };
    },
  },
  vitest,
);
