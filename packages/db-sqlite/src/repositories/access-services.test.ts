import { createFailureEvents } from '@package-broker/core/audit/failure-events';
import { createAuditFailureRepository } from './audit-failure.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveTokenLifetimePolicy } from '@package-broker/core/authz/token-lifetime';
import { systemClock, ulid } from '@package-broker/core/ids';
import { buildIdentityProviders } from '@package-broker/core/identity/providers';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { SUPPORTED_PLUGIN_API, type PluginDefinition } from '@package-broker/core/plugin';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createAccessServices, type AccessServicesOptions } from './access-services.js';
import * as access from './access.js';
import * as project from './project.js';
import * as tokens from './token-read.js';
import * as users from './user.js';
import * as grants from './grant.js';

const ANCHOR = 'oidc:https://idp.example.test';
const HOUR = 3_600_000;
const plugin: PluginDefinition = {
  id: 'identity',
  package: '@test/identity',
  apiVersion: SUPPORTED_PLUGIN_API[0],
  platforms: ['node', 'cloudflare'],
  binds: ['identity'],
  identityProviders: () => [
    {
      id: 'oidc',
      kind: 'oidc',
      displayName: 'Example',
      trustAnchor: ANCHOR,
      policy: {
        verifiedDomains: ['example.test'],
        emailAuthoritativeDomains: ['example.test'],
        autoJoin: false,
      },
      supportsReauth: true,
      start: () => Promise.resolve({ kind: 'direct' }),
      finish: () => Promise.resolve({ ok: false, reason: 'invalid_token' }),
    },
  ],
  register() {},
};

// Both reviewed runtimes supply these same implementations.
describe.each(['node', 'cloudflare'])('%s access services contract', () => {
  let database: MigratedDatabase;
  let options: AccessServicesOptions;

  beforeEach(async () => {
    database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
    const registration = collectRegistrations([plugin]);
    options = {
      executor: database.executor,
      keyring: createKeyring([
        parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
      ]),
      providers: buildIdentityProviders(registration, [plugin], {
        fetch: (request) => fetch(request),
        clock: systemClock,
        env: () => undefined,
      }),
      clock: systemClock,
      ids: { ulid },
      log: () => undefined,
      dispatch: () => undefined,
      publicOrigin: 'https://broker.example.test',
      clientIp: () => null,
      registration,
      tokens: { lifetime: resolveTokenLifetimePolicy(undefined), offboarding: {} },
    };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await database.close();
  });

  it('builds the complete mounted service set over SQLite', async () => {
    const built = createAccessServices(options);
    expect(Object.keys(built.services).sort()).toEqual([
      'administration',
      'engine',
      'lifetime',
      'personalTokens',
      'projectGrants',
      'projectList',
      'projects',
      'servicePrincipals',
      'serviceTokens',
      'sessions',
      'tokenList',
      'tokenRevoke',
    ]);
    expect(Object.isFrozen(built.services)).toBe(true);
    for (const service of Object.values(built.services)) expect(service).toBeTypeOf('object');
    expect(built.services.engine).toBe(built.module.authorization);
    expect(built.services.sessions).toBe(built.module.sessions);
    expect(built.module.unlink).not.toBeNull();
    const ctx = database.orgs!.a;
    expect(await built.providerAnchors.anchors(ctx)).toEqual([
      {
        provider: 'oidc',
        anchor: ANCHOR,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      },
    ]);
    expect(
      await built.services.tokenList.listOrganization(ctx, {
        after: null,
        limit: 10,
        now: options.clock.now().toISOString(),
      }),
    ).toEqual({ items: [], next: null });
  });

  it.each(['slow', 'failing'] as const)(
    'keeps the login response unchanged with a %s staging store',
    async (mode) => {
      let release!: () => void;
      let started!: () => void;
      const stagingStarted = new Promise<void>((resolve) => {
        started = resolve;
      });
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const work: Promise<void>[] = [];
      const log = vi.fn();
      const counter = vi.fn();
      const executor: AccessServicesOptions['executor'] = {
        ...options.executor,
        async batch(statements) {
          if (statements.some((statement) => statement.sql.includes('audit_pending'))) {
            started();
            await hold;
            if (mode === 'failing') throw new Error('private staging failure');
          }
          return options.executor.batch(statements);
        },
      };
      const baseline = createAccessServices(options);
      const built = createAccessServices({
        ...options,
        executor,
        failureEvents: {
          recorder: createFailureEvents(),
          binding: {
            deploymentId: 'test',
            observability: { log, counter, histogram: vi.fn() },
            staging: createAuditFailureRepository(executor),
            routeTemplates: new Set(),
            now: () => options.clock.now(),
          },
        },
        dispatch: (run) => {
          work.push(Promise.resolve().then(run));
        },
      });
      const attempt = (assembly: typeof built, org = database.orgs!.a) => {
        const route = assembly.module.coreRoutes.find(
          (route) => route.path === '/_pb/auth/local/login',
        )!;
        return route.handler({
          request: new Request(`${options.publicOrigin}/_pb/auth/local/login`, {
            method: 'POST',
            headers: { origin: options.publicOrigin, 'content-type': 'application/json' },
            body: JSON.stringify({
              email: 'unknown@example.test',
              password: 'private password',
              code: '123456',
            }),
          }),
          requestId: 'request',
          org,
          principal: null,
          projectId: null,
          params: {},
          ports: {
            organizations: assembly.repositories.organizations,
            clock: options.clock,
            ids: options.ids,
          },
        });
      };
      const expected = await attempt(baseline);
      const response = await attempt(built);
      // The response is available while the staging batch is still blocked.
      await stagingStarted;
      expect(response.status).toBe(401);
      expect(response.status).toBe(expected.status);
      expect([...response.headers]).toEqual([...expected.headers]);
      expect(await response.text()).toBe(await expected.text());
      release();
      await Promise.all(work);
      if (mode === 'failing') {
        expect(log).toHaveBeenCalledWith({ level: 'error', event: 'audit.failure_event_failed' });
        expect(counter).toHaveBeenCalledWith('pb.audit.failure_events_suppressed');
        expect(JSON.stringify(log.mock.calls)).not.toContain('private staging failure');
      } else {
        await attempt(built);
        await attempt(built, database.orgs!.b);
        await Promise.all(work);
        const rows = await database.executor.all<{
          actor_type: string;
          actor_id: string | null;
          payload_json: string;
        }>({
          sql: "SELECT actor_type, actor_id, payload_json FROM audit_pending WHERE org_id = ? AND action = 'session.login_failed'",
          params: [database.orgs!.a.orgId],
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor_type: 'system', actor_id: null });
        expect(JSON.parse(rows[0]!.payload_json)).toMatchObject({
          changes: {
            method: { new: 'local' },
            reason: { new: 'unknown_account' },
            count: { new: 1 },
          },
        });
        for (const secret of ['unknown@example.test', 'private password', '123456'])
          expect(JSON.stringify(rows)).not.toContain(secret);
        expect(
          await database.executor.all({
            sql: "SELECT id FROM audit_pending WHERE org_id = ? AND action = 'session.login_failed'",
            params: [database.orgs!.b.orgId],
          }),
        ).toHaveLength(1);
      }
    },
  );

  it.each(['access', 'project', 'user', 'grant', 'token reader'] as const)(
    'fails closed with the same wired() error for %s',
    (missing) => {
      if (missing === 'access')
        vi.spyOn(access, 'createAccessRepository').mockReturnValueOnce(undefined as never);
      if (missing === 'project')
        vi.spyOn(project, 'createProjectRepository').mockReturnValueOnce(undefined as never);
      if (missing === 'user')
        vi.spyOn(users, 'createUserRepository')
          .mockReturnValueOnce(users.createUserRepository(options.executor))
          .mockReturnValueOnce(undefined as never);
      if (missing === 'grant')
        vi.spyOn(grants, 'createGrantRepository').mockReturnValueOnce(undefined as never);
      if (missing === 'token reader')
        vi.spyOn(tokens, 'createTokenReader').mockReturnValueOnce(undefined as never);
      const name = missing === 'token reader' ? missing : `${missing} repository`;
      expect(() => createAccessServices(options)).toThrow(new TypeError(`${name} is not wired`));
    },
  );

  it('forwards the supplied clock and ids to persistent services', async () => {
    const id = ulid();
    const now = '2031-06-04T03:02:01.000Z';
    const built = createAccessServices({
      ...options,
      clock: { now: () => new Date(now) },
      ids: { ulid: () => id },
    });
    const ctx = database.orgs!.a;
    const plaintext = new Uint8Array([1, 2, 3]);
    expect(
      await built.module.credentials.put(ctx, { kind: 'probe', projectId: null, plaintext }),
    ).toBe(id);
    expect(
      await database.executor.all({
        sql: 'SELECT id, created_at FROM credential WHERE org_id = ?',
        params: [ctx.orgId],
      }),
    ).toEqual([{ id, created_at: now }]);
    expect(await built.module.credentials.read(ctx, id)).toEqual(plaintext);
  });

  it.each([-48, 48])(
    'uses database time for group freshness with a host clock skewed by %i hours',
    async (hours) => {
      const ctx = database.orgs!.a;
      const stmt = (sql: string, ...params: (string | number)[]) => ({ sql, params });
      await database.executor.batch([
        stmt(
          "INSERT INTO user_account (id, org_id, email) VALUES ('U', ?, 'u@example.test')",
          ctx.orgId,
        ),
        stmt(
          "INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'alpha', 'Alpha')",
          ctx.orgId,
        ),
        stmt(
          "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', ?)",
          ctx.orgId,
          ANCHOR,
        ),
        stmt(
          "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('I', ?, 'U', 'oidc', 'sub', 'u@example.test', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          ctx.orgId,
        ),
        stmt(
          "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'reader', 'Reader', 'project')",
          ctx.orgId,
        ),
        stmt(
          "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R', 'project:read')",
          ctx.orgId,
        ),
        stmt(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('G', ?, 'group', 'team', 'oidc', 'project', 'P', 'R')",
          ctx.orgId,
        ),
        stmt(
          "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, 'U', 'oidc', 'team', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          ctx.orgId,
        ),
      ]);
      const built = createAccessServices({
        ...options,
        clock: { now: () => new Date(Date.now() + hours * HOUR) },
      });
      const list = () =>
        built.services.projectList.list(
          ctx,
          {
            kind: 'organization',
            userId: 'U',
            permissions: new Set(),
            isOrganizationAdmin: false,
          },
          { limit: 10 },
        );
      expect(await list()).toEqual({
        ok: true,
        value: {
          items: [{ id: 'P', slug: 'alpha', name: 'Alpha', status: 'active', revision: 1 }],
          nextAfterId: null,
        },
      });
      await database.executor.batch([
        stmt(
          "UPDATE user_group SET refreshed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 hours') WHERE org_id = ?",
          ctx.orgId,
        ),
      ]);
      expect(await list()).toEqual({ ok: true, value: { items: [], nextAfterId: null } });
    },
  );
});
