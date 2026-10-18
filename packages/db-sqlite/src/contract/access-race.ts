import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import { completeIdentityLogin } from '@package-broker/core/auth/identity-login';
import type { IdentityLoginDeps } from '@package-broker/core/auth/identity-login';
import { createSessionService } from '@package-broker/core/auth/session';
import type { AuthenticatedSession, SessionMeta } from '@package-broker/core/auth/session';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineProviderAnchor,
} from '@package-broker/core/authz/engine';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import { createTokenRevokeService } from '@package-broker/core/authz/token-revoke';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { IdentityProvider, VerifiedIdentity } from '@package-broker/core/identity/port';
import type { AuthorizationDecision } from '@package-broker/core/kernel/authorize';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { seedTwoOrganizations } from './two-organizations.js';
import { createAccessRepository } from '../repositories/access.js';
import { createLoginWriter } from '../repositories/login.js';
import { createServicePrincipalAuthority } from '../repositories/service-principal-authority.js';
import { createSessionRepository } from '../repositories/session.js';
import { createTokenRepository } from '../repositories/token.js';
import { createUnlinkRepository } from '../repositories/unlink.js';
import { createUserRepository } from '../repositories/user.js';

const ORIGIN = 'https://broker.example.test';
const SESSION_SECRET = 'S'.repeat(43);
const CSRF_SECRET = 'C'.repeat(43);
const HOUR = 3_600_000;

const ADMIN = 'user-admin';
const ADMIN_SESSION = 'session-admin';
const ADMIN_EMAIL = 'admin@example.test';
const ADMIN_IDENTITY = 'identity-admin';
const ADMIN_SUBJECT = 'sub-admin';
const PROVIDER = 'idp0';
const ANCHOR = 'oidc:https://idp0.example.test';
const ALPHA = 'project-alpha';
const ROLE_ALL = 'role-all';
const ROLE_PROJECT = 'role-project';
const GRANT = 'grant-admin';
const PRINCIPAL = 'principal-a';

const anchors: readonly (EngineProviderAnchor & {
  readonly emailAuthoritativeDomains: readonly string[];
})[] = [
  {
    provider: PROVIDER,
    anchor: ANCHOR,
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(1) }]);

const UNAUTHORIZED = { allow: false, status: 401 } as const;

function st(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function selector(n: number): string {
  return `tk${'abcdefgh'[n % 8]}aaaaaaaaa`;
}

const fence = () =>
  mutationFence({ userId: ADMIN, sessionId: ADMIN_SESSION } as unknown as AuthenticatedActor, {});

interface Gate {
  readonly executor: SqlExecutor;
  readonly parked: Promise<void>;
  release(): void;
}

function gateBefore(
  inner: SqlExecutor,
  kind: 'all' | 'batch',
  matches: (statements: readonly Statement[]) => boolean = () => true,
): Gate {
  let signal: () => void = () => undefined;
  let open: () => void = () => undefined;
  const parked = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  let used = false;
  const hold = async (statements: readonly Statement[], target: 'all' | 'batch') => {
    if (used || target !== kind || !matches(statements)) return;
    used = true;
    signal();
    await opened;
  };
  const executor: SqlExecutor = {
    driver: inner.driver,
    all: async (statement) => {
      await hold([statement], 'all');
      return inner.all(statement);
    },
    batch: async (statements) => {
      await hold(statements, 'batch');
      return inner.batch(statements);
    },
  };
  return { executor, parked, release: open };
}

interface World {
  readonly database: OpenedRaceDatabase;
  readonly executor: SqlExecutor;
  readonly other: SqlExecutor;
  readonly a: OrgContext;
}

export interface OpenedRaceDatabase {
  readonly executor: SqlExecutor;
  second(): Promise<SqlExecutor>;
  close(): Promise<void>;
}

type Open = () => Promise<OpenedRaceDatabase>;

export function describeAccessRace(label: string, open: Open): void {
  let world: World;

  async function openWorld(): Promise<World> {
    const database = await open();
    const executor = database.executor;
    const { a } = await seedTwoOrganizations(executor);
    const now = iso(-60_000);
    await executor.batch([
      st(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        ADMIN,
        a.orgId,
        ADMIN_EMAIL,
      ),
      st(
        'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
        a.orgId,
        PROVIDER,
        ANCHOR,
      ),
      st(
        'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
        ADMIN_IDENTITY,
        a.orgId,
        ADMIN,
        PROVIDER,
        ADMIN_SUBJECT,
        ADMIN_EMAIL,
        now,
      ),
      st(
        'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ADMIN_SESSION,
        a.orgId,
        ADMIN,
        ADMIN_IDENTITY,
        await sha256Hex(SESSION_SECRET),
        await sha256Hex(CSRF_SECRET),
        iso(HOUR),
        now,
      ),
      st(
        'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
        ALPHA,
        a.orgId,
        'alpha',
        'alpha',
        'active',
      ),
      st(
        'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
        ROLE_ALL,
        a.orgId,
        'all',
        'All',
        'organization',
      ),
      ...PERMISSIONS.map(({ name }) =>
        st(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          a.orgId,
          ROLE_ALL,
          name,
        ),
      ),
      st(
        'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
        ROLE_PROJECT,
        a.orgId,
        'project',
        'Project',
        'project',
      ),
      ...['project:read', 'project:packages:read', 'project:packages:write'].map((name) =>
        st(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          a.orgId,
          ROLE_PROJECT,
          name,
        ),
      ),
      st(
        'INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, ?, ?, ?, ?)',
        GRANT,
        a.orgId,
        'email',
        ADMIN_EMAIL,
        'organization',
        ROLE_ALL,
      ),
      st(
        'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
        PRINCIPAL,
        a.orgId,
        PRINCIPAL,
        null,
        ADMIN,
      ),
      st(
        'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
        a.orgId,
        PRINCIPAL,
        'project:read',
      ),
    ]);
    return { database, executor, other: await database.second(), a };
  }

  async function addToken(
    id: string,
    selectorNo: number,
    kind: 'pat' | 'svc',
    extra: { lastUsedAt?: string | null } = {},
  ): Promise<string> {
    const plaintext = formatToken(kind, selector(selectorNo), new Uint8Array(32).fill(9));
    await world.executor.batch([
      st(
        'INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, user_id, service_principal_id, project_mode, validation_kind, validation_identity_id, expires_at, last_used_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)',
        id,
        world.a.orgId,
        kind,
        selector(selectorNo),
        await hashToken(keyring, 1, plaintext),
        id,
        JSON.stringify(['full']),
        kind === 'pat' ? ADMIN : null,
        kind === 'svc' ? PRINCIPAL : null,
        'all',
        kind === 'pat' ? 'sso' : null,
        kind === 'pat' ? ADMIN_IDENTITY : null,
        iso(HOUR),
        extra.lastUsedAt ?? null,
      ),
    ]);
    return plaintext;
  }

  function decide(executor: SqlExecutor, bearer: string): Promise<AuthorizationDecision> {
    const engine = createAuthorizationEngine({
      access: createAccessRepository(executor),
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => anchors,
      tokenUse: { keyring, nowMs: Date.now, dispatch: () => {}, log: () => {} },
    });
    return engine.authorize({
      org: world.a,
      params: { project: 'alpha' },
      route: {
        plugin: 'race',
        method: 'GET',
        path: '/:project/packages',
        permission: 'project:read',
        boundary: 'project',
      },
      request: new Request(`${ORIGIN}/alpha/packages`, {
        headers: { authorization: `Bearer ${bearer}` },
      }),
    });
  }

  function decideSession(executor: SqlExecutor): Promise<AuthorizationDecision> {
    const engine = createAuthorizationEngine({
      access: createAccessRepository(executor),
      patValidation: patValidationGate,
      publicOrigin: ORIGIN,
      providerAnchors: async () => anchors,
      tokenUse: { keyring, nowMs: Date.now, dispatch: () => {}, log: () => {} },
    });
    return engine.authorize({
      org: world.a,
      params: { project: 'alpha' },
      route: {
        plugin: 'race',
        method: 'GET',
        path: '/:project/packages',
        permission: 'project:read',
        boundary: 'project',
      },
      request: new Request(`${ORIGIN}/alpha/packages`, {
        headers: { cookie: `${SESSION_COOKIE}=${SESSION_SECRET}` },
      }),
    });
  }

  const orgRevoke = {
    permission: 'org:tokens:revoke',
    projectId: null,
    organizationAdmin: false,
    covers: [] as string[],
  };

  function revokeVia(executor: SqlExecutor, tokenId: string, now = iso(0)) {
    const authority = createServicePrincipalAuthority({ executor, providerAnchors: anchors });
    return createTokenRepository(executor).revoke(
      world.a,
      fence(),
      authority.guard(world.a, fence(), orgRevoke),
      tokenId,
      now,
    );
  }

  async function revokedAt(tokenId: string): Promise<string | null> {
    const rows = await world.executor.all<{ revoked_at: string | null }>(
      st('SELECT revoked_at FROM token WHERE id = ?', tokenId),
    );
    return rows[0]?.revoked_at ?? null;
  }

  describe(`access races: revoke versus use (${label}, two connections)`, () => {
    beforeEach(async () => {
      world = await openWorld();
    });
    afterEach(async () => {
      await world.database.close();
    });

    it('refuses the write when the grant is removed between lookup and attempt', async () => {
      await addToken('victim', 1, 'svc');
      const gate = gateBefore(world.executor, 'batch');
      const authority = createServicePrincipalAuthority({
        executor: gate.executor,
        providerAnchors: anchors,
      });
      const lookup = await authority.livePermissions(world.a, fence(), null);
      expect(lookup.has('org:tokens:revoke')).toBe(true);

      const attempt = revokeVia(gate.executor, 'victim');
      await gate.parked;
      await world.other.batch([st('DELETE FROM access_grant WHERE id = ?', GRANT)]);
      gate.release();

      expect(await attempt).toEqual({ status: 'refused', reason: 'unclassified' });
      expect(await revokedAt('victim')).toBeNull();
      expect(
        (await authority.livePermissions(world.a, fence(), null)).has('org:tokens:revoke'),
      ).toBe(false);
      expect(await decideSession(world.executor)).toMatchObject({ allow: false });
    });

    it('refuses the write when the session is revoked between lookup and attempt', async () => {
      await addToken('victim', 1, 'svc');
      const gate = gateBefore(world.executor, 'batch');
      const authority = createServicePrincipalAuthority({
        executor: gate.executor,
        providerAnchors: anchors,
      });
      expect((await authority.livePermissions(world.a, fence(), null)).size).toBeGreaterThan(0);

      const attempt = revokeVia(gate.executor, 'victim');
      await gate.parked;
      await world.other.batch([
        st('UPDATE session SET revoked_at = ? WHERE id = ?', iso(-1000), ADMIN_SESSION),
      ]);
      gate.release();

      expect(await attempt).toEqual({ status: 'refused', reason: 'authority' });
      expect(await revokedAt('victim')).toBeNull();
      expect(await decideSession(world.executor)).toMatchObject({ allow: false });
    });

    it('lets a write batch that committed before the grant revoke stand, and refuses the next one', async () => {
      await addToken('first', 1, 'svc');
      await addToken('second', 2, 'svc');
      const revokeGrant = gateBefore(world.other, 'batch');
      const pendingGrantRemoval = revokeGrant.executor.batch([
        st('DELETE FROM access_grant WHERE id = ?', GRANT),
      ]);
      await revokeGrant.parked;

      const committed = await revokeVia(world.executor, 'first');
      expect(committed.status).toBe('revoked');
      revokeGrant.release();
      await pendingGrantRemoval;

      expect(await revokedAt('first')).not.toBeNull();
      const next = await revokeVia(world.executor, 'second');
      expect(next.status).toBe('refused');
      expect(await revokedAt('second')).toBeNull();
    });

    it('lets an authorized read finish and denies the next lookup after the token is revoked', async () => {
      const bearer = await addToken('pat', 1, 'pat');
      await world.executor.batch([
        st(
          'INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          'grant-project',
          world.a.orgId,
          'email',
          ADMIN_EMAIL,
          'project',
          ALPHA,
          ROLE_PROJECT,
        ),
      ]);
      const gate = gateBefore(world.executor, 'all');
      const authorized = await decide(world.executor, bearer);
      expect(authorized).toMatchObject({ allow: true, projectId: ALPHA });
      const inFlight = gate.executor.all<{ slug: string }>(
        st('SELECT slug FROM project WHERE id = ?', ALPHA),
      );
      await gate.parked;

      const revoked = await revokeVia(world.other, 'pat');
      expect(revoked.status).toBe('revoked');
      gate.release();
      expect(await inFlight).toEqual([{ slug: 'alpha' }]);
      expect(await decide(world.executor, bearer)).toEqual(UNAUTHORIZED);
    });
  });

  describe(`access races: issuance policy reduction (${label}, two connections)`, () => {
    beforeEach(async () => {
      world = await openWorld();
    });
    afterEach(async () => {
      await world.database.close();
    });

    const input = (id: string) => ({
      id,
      name: id,
      scope: 'write' as const,
      projectMode: 'all' as const,
      projectIds: [] as string[],
      validation: { kind: 'sso' as const, identityId: ADMIN_IDENTITY },
      providerAnchors: anchors,
      now: iso(0),
      expiresAt: iso(HOUR),
    });

    async function mintedFor(selectorNo: number) {
      const plaintext = formatToken('pat', selector(selectorNo), new Uint8Array(32).fill(7));
      return {
        selector: selector(selectorNo),
        hash: await hashToken(keyring, 1, plaintext),
        pepperVersion: 1,
        plaintext,
      };
    }

    it('commits the issuance when nothing changed between preparation and batch', async () => {
      const outcome = await createTokenRepository(world.executor).issuePersonal(
        world.a,
        fence(),
        input('issued'),
        () => mintedFor(1),
      );
      expect(outcome.status).toBe('issued');
    });

    it('pins current behaviour: an all-project token is still issued when the issuer grant is removed between preparation and batch', async () => {
      let parkedSignal: () => void = () => undefined;
      const parked = new Promise<void>((resolve) => {
        parkedSignal = resolve;
      });
      let release: () => void = () => undefined;
      const opened = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prepared = await mintedFor(3);
      const issuing = createTokenRepository(world.executor).issuePersonal(
        world.a,
        fence(),
        input('pinned'),
        async () => {
          parkedSignal();
          await opened;
          return prepared;
        },
      );
      await parked;
      await world.other.batch([st('DELETE FROM access_grant WHERE id = ?', GRANT)]);
      release();

      expect(await issuing).toMatchObject({ status: 'issued', id: 'pinned' });
    });

    it.each([
      [
        'the project token scope is lowered',
        () => st("UPDATE project SET token_max_scope = 'read' WHERE id = ?", ALPHA),
      ],
      [
        'a permission is removed from the issuer role',
        () =>
          st(
            "DELETE FROM role_permission WHERE role_id = ? AND permission = 'project:packages:write'",
            ROLE_ALL,
          ),
      ],
      [
        'the issuer session is revoked',
        () => st('UPDATE session SET revoked_at = ? WHERE id = ?', iso(-1000), ADMIN_SESSION),
      ],
    ])(
      'refuses and stores nothing when %s between preparation and batch',
      async (_label, reduce) => {
        let parkedSignal: () => void = () => undefined;
        const parked = new Promise<void>((resolve) => {
          parkedSignal = resolve;
        });
        let release: () => void = () => undefined;
        const opened = new Promise<void>((resolve) => {
          release = resolve;
        });
        const prepared = await mintedFor(2);
        const issuing = createTokenRepository(world.executor).issuePersonal(
          world.a,
          fence(),
          input('late'),
          async () => {
            parkedSignal();
            await opened;
            return prepared;
          },
        );
        await parked;
        await world.other.batch([reduce()]);
        release();

        expect(await issuing).toEqual({ status: 'refused', reason: 'authority' });
        const rows = await world.executor.all(st("SELECT id FROM token WHERE id = 'late'"));
        expect(rows).toEqual([]);
      },
    );
  });

  describe(`access races: double revoke and stale touches (${label}, two connections)`, () => {
    beforeEach(async () => {
      world = await openWorld();
    });
    afterEach(async () => {
      await world.database.close();
    });

    it.each([
      ['the first connection', true],
      ['the second connection', false],
    ])('changes one row when both revokes are prepared and %s wins', async (_label, firstWins) => {
      await addToken('victim', 1, 'svc');
      const gateFirst = gateBefore(world.executor, 'batch');
      const gateSecond = gateBefore(world.other, 'batch');
      const stampFirst = iso(0);
      const stampSecond = iso(5000);
      const first = revokeVia(gateFirst.executor, 'victim', stampFirst);
      const second = revokeVia(gateSecond.executor, 'victim', stampSecond);
      await Promise.all([gateFirst.parked, gateSecond.parked]);
      expect(await revokedAt('victim')).toBeNull();

      const winnerGate = firstWins ? gateFirst : gateSecond;
      const loserGate = firstWins ? gateSecond : gateFirst;
      const winnerRun = firstWins ? first : second;
      const loserRun = firstWins ? second : first;
      winnerGate.release();
      const winner = await winnerRun;
      if (winner.status !== 'revoked') throw new Error('the released revoke must win');
      loserGate.release();
      const loser = await loserRun;

      expect(loser).toEqual({ status: 'already_revoked' });
      const rows = await world.executor.all<{ revoked_at: string; last_op_id: string }>(
        st("SELECT revoked_at, last_op_id FROM token WHERE id = 'victim'"),
      );
      expect(rows).toEqual([
        { revoked_at: firstWins ? stampFirst : stampSecond, last_op_id: winner.opId },
      ]);
    });

    it('emits exactly one token.revoked across both revoke attempts of the service', async () => {
      await addToken('victim', 1, 'svc');
      const events: Record<string, unknown>[] = [];
      const serviceFor = (executor: SqlExecutor) => {
        const tokens = createTokenRepository(executor);
        return createTokenRevokeService({
          tokens: {
            get: async (_ctx, id) => {
              const rows = await executor.all<{ id: string }>(
                st('SELECT id FROM token WHERE id = ? AND org_id = ?', id, world.a.orgId),
              );
              return rows.length === 0
                ? null
                : { id, kind: 'svc', userId: null, projectId: null, projectMode: null };
            },
            revoke: (ctx, actorFence, guard, id, now) =>
              tokens.revoke(ctx, actorFence, guard, id, now),
          },
          authority: createServicePrincipalAuthority({ executor, providerAnchors: anchors }),
          ownership: {
            ownPersonalToken: () => {
              throw new Error('a service token is never revoked through ownership');
            },
          },
          clock: { now: () => new Date() },
          log: (entry) => events.push(entry as Record<string, unknown>),
        });
      };
      const authenticated = {
        session: { id: ADMIN_SESSION, userId: ADMIN },
        principal: { kind: 'user', id: ADMIN },
      } as unknown as AuthenticatedSession;

      const gate = gateBefore(world.executor, 'batch');
      const parked = serviceFor(gate.executor).revoke(world.a, authenticated, fence(), {
        tokenId: 'victim',
        routeProjectId: null,
      });
      await gate.parked;
      const free = await serviceFor(world.other).revoke(world.a, authenticated, fence(), {
        tokenId: 'victim',
        routeProjectId: null,
      });
      gate.release();
      const late = await parked;

      expect(free).toEqual({ ok: true, value: { revoked: true } });
      expect(late).toEqual({ ok: true, value: { revoked: false } });
      expect(events.filter((entry) => entry.event === 'token.revoked')).toHaveLength(1);
    });

    it.each([
      ['token', 'pat'],
      ['session', 'session'],
    ])('changes one row when two stale %s touches race', async (_label, target) => {
      const stale = iso(-600_000);
      await addToken('pat', 1, 'pat', { lastUsedAt: stale });
      await world.executor.batch([
        st('UPDATE session SET last_seen_at = ? WHERE id = ?', stale, ADMIN_SESSION),
      ]);
      const touch = (executor: SqlExecutor) =>
        target === 'pat'
          ? createAccessRepository(executor).touchToken(world.a, 'pat', 'pat')
          : createAccessRepository(executor).touchSession(world.a, ADMIN_SESSION);
      const column = target === 'pat' ? 'token' : 'session';
      const probe = async () =>
        (
          await world.executor.all<{ value: string }>(
            st(
              column === 'token'
                ? "SELECT last_used_at AS value FROM token WHERE id = 'pat'"
                : 'SELECT last_seen_at AS value FROM session WHERE id = ?',
              ...(column === 'token' ? [] : [ADMIN_SESSION]),
            ),
          )
        )[0]?.value;

      const gate = gateBefore(world.executor, 'all');
      const parked = touch(gate.executor);
      await gate.parked;
      expect(await touch(world.other)).toBe(true);
      const afterFirst = await probe();
      gate.release();

      expect(await parked).toBe(false);
      expect(await probe()).toBe(afterFirst);
      expect(afterFirst).not.toBe(stale);
    });
  });

  const TARGET = 'user-target';
  const TARGET_EMAIL = 'target@example.test';
  const TARGET_IDENTITY = 'identity-target';
  const TARGET_SUBJECT = 'sub-target';
  const NEW_SUBJECT = 'sub-target-new';
  const TARGET_SESSION = 'session-target';
  const META: SessionMeta = { ip: null, userAgent: null, previousSecretHash: null };

  const provider: IdentityProvider = {
    id: PROVIDER,
    kind: 'oidc',
    displayName: 'Idp',
    trustAnchor: ANCHOR,
    policy: {
      verifiedDomains: ['example.test'],
      emailAuthoritativeDomains: ['example.test'],
      autoJoin: false,
    },
    supportsReauth: false,
    start: () => Promise.reject(new Error('unused')),
    finish: () => Promise.reject(new Error('unused')),
  };

  function verified(subject: string): VerifiedIdentity {
    return {
      provider: PROVIDER,
      subject,
      email: TARGET_EMAIL,
      emailVerified: true,
      displayName: null,
      groups: [],
      issuedAt: new Date().toISOString(),
      authTime: null,
    };
  }

  function loginDeps(writerExecutor: SqlExecutor): IdentityLoginDeps {
    const clock = { now: () => new Date() };
    return {
      users: createUserRepository(world.executor),
      writer: createLoginWriter(writerExecutor),
      sessions: createSessionService({
        sessions: createSessionRepository(writerExecutor),
        clock,
        publicOrigin: 'https://broker.test',
      }),
      hooks: { 'auth.resolveIdentity': [], 'auth.mapGroups': [] },
      clock,
      ids: { ulid: () => ulid(Date.now()) },
    };
  }

  function unlinkTarget(executor: SqlExecutor) {
    return createUnlinkRepository(executor, {
      holderInput: async () => ({
        kind: 'fresh',
        now: new Date().toISOString(),
        providers: [
          {
            provider: PROVIDER,
            anchor: ANCHOR,
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test'],
          },
        ],
      }),
    }).unlinkIdentity(world.a, fence(), {
      identityId: TARGET_IDENTITY,
      userId: TARGET,
      provider: PROVIDER,
      subject: TARGET_SUBJECT,
      anchor: ANCHOR,
      now: new Date().toISOString(),
    });
  }

  async function counts() {
    const one = async (query: string) =>
      Number((await world.executor.all<{ n: number }>(st(query)))[0]?.n);
    return {
      sessions: await one(`SELECT count(*) AS n FROM session WHERE user_id = '${TARGET}'`),
      identities: await one(`SELECT count(*) AS n FROM identity WHERE user_id = '${TARGET}'`),
      blocks: await one('SELECT count(*) AS n FROM identity_block'),
    };
  }

  describe(`access races: login against unlink and suspension (${label}, two connections)`, () => {
    beforeEach(async () => {
      world = await openWorld();
      await world.executor.batch([
        st(
          'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          TARGET,
          world.a.orgId,
          TARGET_EMAIL,
        ),
        st(
          'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
          TARGET_IDENTITY,
          world.a.orgId,
          TARGET,
          PROVIDER,
          TARGET_SUBJECT,
          TARGET_EMAIL,
          iso(-60_000),
        ),
        st(
          'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          TARGET_SESSION,
          world.a.orgId,
          TARGET,
          TARGET_IDENTITY,
          'a'.repeat(64),
          'b'.repeat(64),
          iso(HOUR),
        ),
        st('UPDATE role SET protects_last_holder = 1 WHERE id = ?', ROLE_ALL),
      ]);
    });
    afterEach(async () => {
      await world.database.close();
    });

    it('refuses the old subject when the unlink commits between login plan and batch', async () => {
      const gate = gateBefore(world.executor, 'batch');
      const login = completeIdentityLogin(
        loginDeps(gate.executor),
        world.a,
        provider,
        verified(TARGET_SUBJECT),
        META,
      );
      await gate.parked;
      expect(await unlinkTarget(world.other)).toBe('unlinked');
      gate.release();

      const outcome = await login;
      expect(outcome.ok).toBe(false);
      expect(await counts()).toEqual({ sessions: 0, identities: 0, blocks: 1 });
    });

    it('lets the old subject finish first and then removes its session with the unlink', async () => {
      const gate = gateBefore(world.other, 'batch');
      const unlinking = unlinkTarget(gate.executor);
      await gate.parked;
      const login = await completeIdentityLogin(
        loginDeps(world.executor),
        world.a,
        provider,
        verified(TARGET_SUBJECT),
        META,
      );
      expect(login.ok).toBe(true);
      gate.release();

      expect(await unlinking).toBe('unlinked');
      expect(await counts()).toEqual({ sessions: 0, identities: 0, blocks: 1 });
      const again = await completeIdentityLogin(
        loginDeps(world.executor),
        world.a,
        provider,
        verified(TARGET_SUBJECT),
        META,
      );
      expect(again.ok).toBe(false);
      expect(await counts()).toEqual({ sessions: 0, identities: 0, blocks: 1 });
    });

    it('refuses the new subject while the unlink is pending and links it once the unlink commits', async () => {
      const gate = gateBefore(world.other, 'batch');
      const unlinking = unlinkTarget(gate.executor);
      await gate.parked;
      const early = await completeIdentityLogin(
        loginDeps(world.executor),
        world.a,
        provider,
        verified(NEW_SUBJECT),
        META,
      );
      expect(early).toEqual({ ok: false, reason: 'already_linked' });
      gate.release();
      expect(await unlinking).toBe('unlinked');

      const late = await completeIdentityLogin(
        loginDeps(world.executor),
        world.a,
        provider,
        verified(NEW_SUBJECT),
        META,
      );
      expect(late.ok).toBe(true);
      expect(await counts()).toEqual({ sessions: 1, identities: 1, blocks: 1 });
      const bound = await world.executor.all<{ subject: string }>(
        st('SELECT subject FROM identity WHERE user_id = ?', TARGET),
      );
      expect(bound).toEqual([{ subject: NEW_SUBJECT }]);
    });

    it('refuses the login and creates no session when suspension commits between plan and batch', async () => {
      const gate = gateBefore(world.executor, 'batch');
      const login = completeIdentityLogin(
        loginDeps(gate.executor),
        world.a,
        provider,
        verified(TARGET_SUBJECT),
        META,
      );
      await gate.parked;
      await world.other.batch([
        st("UPDATE user_account SET status = 'suspended' WHERE id = ?", TARGET),
      ]);
      gate.release();

      const outcome = await login;
      expect(outcome.ok).toBe(false);
      const sessions = await world.executor.all<{ id: string }>(
        st('SELECT id FROM session WHERE user_id = ?', TARGET),
      );
      expect(sessions.map((row) => row.id)).toEqual([TARGET_SESSION]);
    });
  });
}
