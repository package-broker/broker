import { auditEvent, type AuditAction } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor } from '@package-broker/core/db/port';
import { assertGuard, existsGuard } from '../kysely.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { createServicePrincipalRepository } from '../repositories/service-principal.js';
import { seedTwoOrganizations } from './two-organizations.js';

export interface OpenedServicePrincipalDatabase {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}

type Open = () => Promise<OpenedServicePrincipalDatabase>;

const NOW = '2026-10-15T12:00:00.000Z';
const USER = '01J0USER000000000000000001';
const PROJECT = '01J0PROJECT00000000000000AA';
const PRINCIPAL = '01J0SERVICEPRINCIPAL0000A1';

async function loadSources(): Promise<MigrationSource[]> {
  const directory = new URL('../../migrations/', import.meta.url);
  const names = readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  return Promise.all(
    names.map((name) =>
      loadMigrationSource('core', name, readFileSync(new URL(name, directory), 'utf8')),
    ),
  );
}

async function withWorld(
  open: Open,
  body: (world: { executor: SqlExecutor; a: OrgContext }) => Promise<void>,
): Promise<void> {
  const database = await open();
  try {
    const { executor } = database;
    await migrate(executor, await loadSources(), { holder: 'service-principal-contract' });
    const { a } = await seedTwoOrganizations(executor);
    await executor.batch([
      {
        sql: 'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        params: [USER, a.orgId, 'u1@example.test'],
      },
      {
        sql: 'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        params: [PROJECT, a.orgId, 'alpha', 'alpha'],
      },
    ]);
    await body({ executor, a });
  } finally {
    await database.close();
  }
}

async function snapshot(executor: SqlExecutor): Promise<string> {
  return JSON.stringify([
    await executor.all({ sql: 'SELECT * FROM service_principal ORDER BY id', params: [] }),
    await executor.all({
      sql: 'SELECT * FROM service_principal_permission ORDER BY service_principal_id, permission',
      params: [],
    }),
  ]);
}

const replay = async (open: Open): Promise<void> => {
  await withWorld(open, async ({ executor, a }) => {
    const principals = createServicePrincipalRepository(executor);
    const actor = { userId: USER, sessionId: 'session-1' } as unknown as AuthenticatedActor;
    const create = (opId: string, permissions: readonly string[]) =>
      principals.create(
        a,
        mutationFence(actor, {}),
        assertGuard(
          existsGuard((database) =>
            database
              .selectFrom('user_account')
              .select('id')
              .where('org_id', '=', a.orgId)
              .where('id', '=', USER)
              .where('status', '=', 'active'),
          ),
          a,
        ),
        {
          audit: mutationAudit('service_principal.create', null),
          id: PRINCIPAL,
          name: 'ci',
          projectId: PROJECT,
          createdByUserId: USER,
          permissions,
          now: NOW,
          opId,
        },
      );

    expect(await create('op-create', [])).toBe('created');
    const stored = await snapshot(executor);

    expect(await create('op-create', ['project:packages:read'])).toBe('duplicate');
    expect(await snapshot(executor)).toBe(stored);
    expect(await create('op-other', ['project:packages:read'])).toBe('duplicate');
    expect(await snapshot(executor)).toBe(stored);
    expect(
      await executor.all({ sql: 'SELECT 1 FROM service_principal_permission', params: [] }),
    ).toEqual([]);
  });
};

export const servicePrincipalContractCases = { replay } as const satisfies Record<
  string,
  (open: Open) => Promise<void>
>;

export function describeServicePrincipalContract(name: string, open: Open): void {
  describe(`service principal contract: ${name}`, () => {
    it(
      'a create replayed with the same or another op id adds no permission rows',
      () => servicePrincipalContractCases.replay(open),
      60_000,
    );
  });
}

function mutationAudit(action: AuditAction = 'token.issue', targetId: string | null = null) {
  const id = ulid();
  const result = auditEvent({
    id,
    now: '2026-10-19T00:00:00.000Z',
    action,
    actor: { type: 'system', id: null },
    context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
    target: { type: action.split('.')[0]!, id: targetId },
  });
  if (!result.ok) throw new Error('Invalid test audit event');
  return result.event;
}
