import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as vitest from 'vitest';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { orgContext, type SqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import {
  provisionMcpFixture,
  runMcpContract,
  type McpContractBroker,
} from '@package-broker/core/mcp/contract';
import * as mcpTools from '@package-broker/core/mcp/tools';
import * as mcpLimit from '@package-broker/core/mcp/limit';
import {
  loadMigrationSource,
  type MigrationSource,
} from '@package-broker/db-sqlite/migrations/source';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { openBetterSqliteExecutor } from './db/better-sqlite3-executor.js';
import { startNode } from './startup.js';

const KEY = 'pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const ORIGIN = 'https://broker.test';

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
    runtime: 'node',
    async create() {
      const directory = await mkdtemp(join(tmpdir(), 'pb-mcp-contract-'));
      const path = join(directory, 'broker.sqlite');
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
      const createLimiter = mcpLimit.createInProcessMcpLimiter;
      const limiterSpy = vitest.vi
        .spyOn(mcpLimit, 'createInProcessMcpLimiter')
        .mockImplementationOnce((options) => createLimiter({ ...options, nowMs: () => 0 }));
      const broker = await startNode({
        plugins: [],
        mcp: { enabled: true },
        migrations: await migrationSources(),
        env: {
          PB_SQLITE_PATH: path,
          PB_ORG_SLUG: 'acme',
          PB_ORG_NAME: 'Acme',
          PB_MASTER_KEY: KEY,
          PB_PUBLIC_URL: ORIGIN,
        },
      }).finally(() => {
        toolsSpy.mockRestore();
        limiterSpy.mockRestore();
      });
      const opened = openBetterSqliteExecutor(path);
      const close = async () => {
        await opened.close();
        await broker.close();
        await rm(directory, { recursive: true, force: true });
      };
      try {
        const kernel = await broker.ready();
        const org = await createOrganizationBootstrap(opened.executor).findSingleton();
        if (org === null) throw new Error('organization missing');
        const setupToken = randomBytes(32).toString('base64url');
        const now = new Date();
        await bootstrapAdmin(opened.executor, orgContext(org.id), {
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
        const rest = (request: Request) => kernel.fetch(request);
        const fixture = await provisionMcpFixture({
          origin: ORIGIN,
          call: rest,
          setupToken,
          orgId: org.id,
          seedPackages: (seed) => seedPackages(opened.executor, seed),
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
          close,
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
  },
  vitest,
);
