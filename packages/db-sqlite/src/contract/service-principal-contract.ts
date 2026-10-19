import { auditEvent, type AuditAction } from '@package-broker/core/audit/actions';
import { createSessionService, type AuthenticatedSession } from '@package-broker/core/auth/session';
import { createServicePrincipalService } from '@package-broker/core/authz/service-principal-service';
import { fixedClock } from '@package-broker/core/ids';
import { ulid } from '@package-broker/core/ids';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { assertGuard, existsGuard } from '../kysely.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource, type MigrationSource } from '../migrations/source.js';
import { createServicePrincipalRepository } from '../repositories/service-principal.js';
import { createServicePrincipalAuthority } from '../repositories/service-principal-authority.js';
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

const reauthAtCommit = async (open: Open): Promise<void> => {
  await withWorld(open, async ({ executor: realExecutor, a }) => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000 + 500;
    const coreNow = new Date(nowMs - 660_000).toISOString();
    const databaseNow = new Date(nowMs).toISOString();
    // Pin database time so the millisecond boundary cases cannot race the wall clock.
    const atDatabaseTime = (statement: Statement): Statement => ({
      ...statement,
      sql: statement.sql.replaceAll("'now'", `'${databaseNow}'`),
    });
    const executor: SqlExecutor = {
      driver: realExecutor.driver,
      all: (statement) => realExecutor.all(atDatabaseTime(statement)),
      batch: (statements) => realExecutor.batch(statements.map(atDatabaseTime)),
    };
    const sessionId = 'reauth-session';
    const roleId = 'reauth-role';
    const providers = [
      {
        provider: 'oidc',
        anchor: 'oidc:https://idp.example.test',
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ];
    await executor.batch([
      {
        sql: 'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        params: [a.orgId, providers[0]!.provider, providers[0]!.anchor],
      },
      {
        sql: 'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        params: [
          'reauth-identity',
          a.orgId,
          USER,
          'oidc',
          'reauth-subject',
          'u1@example.test',
          databaseNow,
        ],
      },
      {
        sql: 'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        params: [
          sessionId,
          a.orgId,
          USER,
          'a'.repeat(64),
          'b'.repeat(64),
          databaseNow,
          databaseNow,
          '2999-01-01T00:00:00.000Z',
          coreNow,
        ],
      },
      {
        sql: "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, 'project')",
        params: [roleId, a.orgId, roleId, roleId],
      },
      ...['project:service-principals:write', 'project:read'].map((permission) => ({
        sql: 'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
        params: [a.orgId, roleId, permission],
      })),
      {
        sql: "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, 'email', ?, 'project', ?, ?)",
        params: ['reauth-grant', a.orgId, 'u1@example.test', PROJECT, roleId],
      },
    ]);
    const authenticated: AuthenticatedSession = {
      session: {
        id: sessionId,
        userId: USER,
        identityId: null,
        csrfHash: 'b'.repeat(64),
        createdAt: databaseNow,
        lastSeenAt: databaseNow,
        expiresAt: '2999-01-01T00:00:00.000Z',
        reauthAt: coreNow,
        user: { id: USER, email: 'u1@example.test', displayName: null },
      },
      principal: { kind: 'user', id: USER },
    };
    const clock = fixedClock(coreNow);
    const sessions = createSessionService({
      sessions: {} as never,
      clock,
      publicOrigin: 'https://broker.example.test',
    });
    expect(sessions.isReauthFresh(authenticated)).toBe(true);
    const fence = mutationFence({ userId: USER, sessionId } as unknown as AuthenticatedActor, {});
    const principals = createServicePrincipalRepository(executor);
    const authority = createServicePrincipalAuthority({ executor, providerAnchors: providers });
    expect(await authority.livePermissions(a, fence, PROJECT)).toEqual(
      new Set(['project:service-principals:write', 'project:read']),
    );
    const events: Readonly<Record<string, unknown>>[] = [];
    const service = createServicePrincipalService({
      principals,
      authority,
      directory: principals,
      sessions,
      clock,
      ids: { ulid },
      log: (entry) => events.push(entry),
    });
    const snapshotEffects = async () =>
      JSON.stringify(
        await Promise.all(
          [
            'service_principal',
            'service_principal_permission',
            'audit_pending',
            'api_idempotency',
            'cache_epoch',
          ].map((table) =>
            executor.all({ sql: `SELECT * FROM ${table} WHERE org_id = ?`, params: [a.orgId] }),
          ),
        ),
      );
    const before = await snapshotEffects();
    const call = {
      audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
      idempotency: {
        principalKey: `user:${USER}`,
        key: 'reauth-create',
        route: '/principals',
        requestHash: 'a'.repeat(64),
        status: 201,
        responseJson: '{}',
        createdAt: coreNow,
        expiresAt: '2999-01-01T00:00:00.000Z',
      },
    };
    for (const reauthAt of [
      coreNow,
      null,
      '2999-01-01T00:00:00.000Z',
      'invalid',
      new Date(nowMs - 600_001).toISOString(),
      new Date(nowMs + 1).toISOString(),
    ]) {
      await executor.batch([
        {
          sql: 'UPDATE session SET reauth_at = ? WHERE org_id = ? AND id = ?',
          params: [reauthAt, a.orgId, sessionId],
        },
      ]);
      expect(
        await service.create(
          a,
          authenticated,
          {
            kind: 'organization',
            userId: USER,
            permissions: new Set(),
            isOrganizationAdmin: false,
          },
          fence,
          { name: 'fresh-only', projectId: PROJECT },
          call,
        ),
      ).toEqual({ ok: false, error: 'forbidden' });
      expect(await snapshotEffects()).toBe(before);
      expect(events.some((entry) => entry['event'] === 'service_principal.changed')).toBe(false);
    }
    await executor.batch([
      {
        sql: 'UPDATE session SET reauth_at = ? WHERE org_id = ? AND id = ?',
        params: [new Date(nowMs - 600_000).toISOString(), a.orgId, sessionId],
      },
    ]);
    expect(
      (
        await service.create(
          a,
          authenticated,
          {
            kind: 'organization',
            userId: USER,
            permissions: new Set(),
            isOrganizationAdmin: false,
          },
          fence,
          { name: 'fresh-only', projectId: PROJECT },
          call,
        )
      ).ok,
    ).toBe(true);
    expect(events.filter((entry) => entry['event'] === 'service_principal.changed')).toHaveLength(
      1,
    );
  });
};

export const servicePrincipalContractCases = { replay, reauthAtCommit } as const satisfies Record<
  string,
  (open: Open) => Promise<void>
>;

export function describeServicePrincipalContract(name: string, open: Open): void {
  describe(`service principal contract: ${name}`, () => {
    it(
      'requires fresh reauth on database time and rolls back every create effect on refusal',
      () => servicePrincipalContractCases.reauthAtCommit(open),
      60_000,
    );
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
