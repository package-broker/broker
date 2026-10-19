import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '@package-broker/core/auth/cookies';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import {
  createAuthorizationEngine,
  patValidationGate,
  type EngineProviderAnchor,
} from '@package-broker/core/authz/engine';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { ActorContext } from '@package-broker/core/authz/actor';
import type { ProjectActor } from '@package-broker/core/authz/project-actor';
import { PERMISSIONS } from '@package-broker/core/authz/permissions';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import {
  authorizeRoute,
  denyAllEngine,
  type AuthorizationDecision,
  type AuthorizationEngine,
  type AuthorizationRequest,
} from '@package-broker/core/kernel/authorize';
import { routeBoundaryProblems } from '@package-broker/core/kernel/routes';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { formatToken } from '@package-broker/core/secrets/token-format';
import { hashToken } from '@package-broker/core/secrets/token-hash';
import { assertGuard } from '../kysely.js';
import { createAccessRepository } from '../repositories/access.js';
import { rebindProvider } from '../repositories/provider-binding.js';
import { createRoleRepository } from '../repositories/role.js';
import { createServicePrincipalAuthority } from '../repositories/service-principal-authority.js';
import { createTokenRepository } from '../repositories/token.js';
import { seedTwoOrganizations } from './two-organizations.js';

export interface OpenedAccessDatabase {
  readonly executor: SqlExecutor;
  second?(): Promise<SqlExecutor>;
  close(): Promise<void>;
}

type Open = () => Promise<OpenedAccessDatabase>;
type Wrap = (executor: SqlExecutor) => SqlExecutor;
type Case = (open: Open, wrap?: Wrap) => Promise<void>;

const NOT_FOUND = { allow: false, status: 404 } as const;
const FORBIDDEN = { allow: false, status: 403 } as const;
const UNAUTHORIZED = { allow: false, status: 401 } as const;

const ORIGIN = 'https://broker.example.test';
const SESSION_SECRET = 'S'.repeat(43);
const CSRF_SECRET = 'C'.repeat(43);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const USER = 'user-a';
const SESSION = 'session-a';
const IDENTITY = 'identity-a0';
const EMAIL = 'member@example.test';
const ALPHA = 'project-alpha';
const BETA = 'project-beta';
const OLD = 'project-old';
const FOREIGN = 'project-foreign';
const SHARED_A = 'project-shared-a';
const SHARED_B = 'project-shared-b';
const ROLE_ALL = 'role-all';
const ROLE_PROJECT = 'role-project';
const PRINCIPAL = 'principal-a';

const ANCHORS = {
  idp0: 'oidc:https://idp0.example.test',
  idp1: 'oidc:https://idp1.example.test',
  idp2: 'oidc:https://idp2.example.test',
} as const;
const anchors: readonly (EngineProviderAnchor & {
  readonly emailAuthoritativeDomains?: readonly string[];
})[] = [
  {
    provider: 'idp0',
    anchor: ANCHORS.idp0,
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
  {
    provider: 'idp1',
    anchor: ANCHORS.idp1,
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
  { provider: 'idp2', anchor: ANCHORS.idp2, emailAuthoritative: false },
];

const keyBytes = (version: number) => new Uint8Array(32).fill(version);
const keyring = createKeyring(
  [4, 3, 2, 1].map((version) => ({ version, bytes: keyBytes(version) })),
);
const outsideKeyring = createKeyring([{ version: 9, bytes: keyBytes(9) }]);

function st(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

function iso(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function selector(n: number): string {
  const letters = 'abcdefgh';
  return `tk${letters[Math.floor(n / 8)] ?? 'a'}${letters[n % 8] ?? 'a'}aaaaaaaa`;
}

interface World {
  readonly executor: SqlExecutor;
  readonly second: () => Promise<SqlExecutor>;
  readonly a: OrgContext;
  readonly b: OrgContext;
}

async function fixture(
  open: Open,
  body: (world: World) => Promise<void>,
  wrap: Wrap = (executor) => executor,
): Promise<void> {
  const database = await open();
  try {
    const executor = wrap(database.executor);
    const { a, b } = await seedTwoOrganizations(executor);
    const now = iso(-60_000);
    const statements: Statement[] = [
      st('INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)', USER, a.orgId, EMAIL),
      st(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        'user-b',
        b.orgId,
        'other@example.test',
      ),
      ...(['idp0', 'idp1', 'idp2'] as const).map((provider) =>
        st(
          'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
          a.orgId,
          provider,
          ANCHORS[provider],
        ),
      ),
      ...(['idp0', 'idp1', 'idp2'] as const).map((provider, index) =>
        st(
          'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
          `identity-a${index}`,
          a.orgId,
          USER,
          provider,
          `subject-${provider}`,
          EMAIL,
          now,
        ),
      ),
      st(
        'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        SESSION,
        a.orgId,
        USER,
        IDENTITY,
        await sha256Hex(SESSION_SECRET),
        await sha256Hex(CSRF_SECRET),
        iso(HOUR),
        now,
      ),
      ...(
        [
          [ALPHA, 'alpha', a, 'active'],
          [BETA, 'beta', a, 'active'],
          [OLD, 'old', a, 'archived'],
          [SHARED_A, 'shared', a, 'active'],
          [FOREIGN, 'foreign', b, 'active'],
          [SHARED_B, 'shared', b, 'active'],
        ] as const
      ).map(([id, slug, org, status]) =>
        st(
          'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
          id,
          org.orgId,
          slug,
          slug,
          status,
        ),
      ),
      st(
        'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
        ROLE_ALL,
        a.orgId,
        'all',
        'All',
        'organization',
      ),
      st(
        'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
        ROLE_PROJECT,
        a.orgId,
        'project',
        'Project',
        'project',
      ),
      ...PERMISSIONS.map(({ name }) =>
        st(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          a.orgId,
          ROLE_ALL,
          name,
        ),
      ),
      ...[
        'project:read',
        'project:packages:read',
        'project:packages:write',
        'project:tokens:revoke',
      ].map((name) =>
        st(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          a.orgId,
          ROLE_PROJECT,
          name,
        ),
      ),
    ];
    await executor.batch(statements);
    await body({
      executor,
      second: async () =>
        database.second === undefined ? executor : wrap(await database.second()),
      a,
      b,
    });
  } finally {
    await database.close();
  }
}

type Subject =
  | { readonly type: 'email'; readonly value: string }
  | { readonly type: 'group'; readonly provider: string; readonly value: string };

let grantCounter = 0;
function grant(world: World, role: string, subject: Subject, projectId: string | null): Statement {
  grantCounter += 1;
  return st(
    'INSERT INTO access_grant (id, org_id, subject_type, subject_provider, subject_value, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    `grant-${grantCounter}`,
    world.a.orgId,
    subject.type,
    subject.type === 'group' ? subject.provider : null,
    subject.value,
    projectId === null ? 'organization' : 'project',
    projectId,
    role,
  );
}

const orgWide = (world: World, role = ROLE_ALL): Statement =>
  grant(world, role, { type: 'email', value: EMAIL }, null);

function membership(world: World, provider: string, group: string, refreshedAt = iso(-60_000)) {
  return st(
    'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
    world.a.orgId,
    USER,
    provider,
    group,
    refreshedAt,
  );
}

interface Probe {
  readonly slug?: string;
  readonly permission?: string;
  readonly method?: string;
  readonly boundary?: 'organization' | 'project';
  readonly org?: OrgContext;
  readonly bearer?: string;
  readonly basic?: string;
  readonly authorization?: string;
  readonly cookie?: boolean;
  readonly origin?: string | null;
  readonly csrf?: string | null;
  readonly anchors?: readonly EngineProviderAnchor[];
  readonly engineKeyring?: ReturnType<typeof createKeyring>;
}

function engineFor(executor: SqlExecutor, probe: Probe = {}): AuthorizationEngine {
  return createAuthorizationEngine({
    access: createAccessRepository(executor),
    patValidation: patValidationGate,
    publicOrigin: ORIGIN,
    providerAnchors: async () => probe.anchors ?? anchors,
    tokenUse: {
      keyring: probe.engineKeyring ?? keyring,
      nowMs: Date.now,
      dispatch: () => {},
      log: () => {},
    },
  });
}

function requestFor(world: World, probe: Probe): AuthorizationRequest {
  const method = probe.method ?? 'GET';
  const boundary = probe.boundary ?? 'project';
  const slug = probe.slug ?? 'alpha';
  const headers = new Headers();
  if (probe.bearer !== undefined) headers.set('authorization', `Bearer ${probe.bearer}`);
  if (probe.basic !== undefined) headers.set('authorization', `Basic ${btoa(`${probe.basic}:`)}`);
  if (probe.authorization !== undefined) headers.set('authorization', probe.authorization);
  if (probe.cookie === true) headers.set('cookie', `${SESSION_COOKIE}=${SESSION_SECRET}`);
  if (probe.origin !== undefined && probe.origin !== null) headers.set('origin', probe.origin);
  if (probe.csrf !== undefined && probe.csrf !== null) headers.set('x-csrf-token', probe.csrf);
  return {
    org: probe.org ?? world.a,
    params: boundary === 'project' ? { project: slug } : {},
    route: {
      plugin: 'contract',
      method,
      path: boundary === 'project' ? '/:project/packages' : '/organization',
      permission: probe.permission ?? (boundary === 'project' ? 'project:read' : 'org:read'),
      boundary,
    },
    request: new Request(`${ORIGIN}/${slug}/packages`, { method, headers }),
  };
}

function decide(world: World, probe: Probe): Promise<AuthorizationDecision> {
  return engineFor(world.executor, probe).authorize(requestFor(world, probe));
}

const session = (extra: Probe = {}): Probe => ({ cookie: true, ...extra });

interface TokenSpec {
  readonly id: string;
  readonly kind?: 'pat' | 'svc';
  readonly selectorNo: number;
  readonly version?: number;
  readonly hashKeyring?: ReturnType<typeof createKeyring>;
  readonly scope?: 'read' | 'write' | 'full';
  readonly mode?: 'all' | 'selected';
  readonly projects?: readonly string[];
  readonly principal?: string;
  readonly projectId?: string | null;
  readonly expiresAt?: string;
  readonly revokedAt?: string | null;
  readonly lastUsedAt?: string | null;
  readonly identityId?: string | null;
  readonly userId?: string;
  readonly hash?: string;
}

async function addToken(world: World, spec: TokenSpec): Promise<string> {
  const kind = spec.kind ?? 'pat';
  const plaintext = formatToken(kind, selector(spec.selectorNo), new Uint8Array(32).fill(9));
  const version = spec.version ?? 1;
  const hash = spec.hash ?? (await hashToken(spec.hashKeyring ?? keyring, version, plaintext));
  const scope = spec.scope ?? 'full';
  const identityId = spec.identityId === undefined ? IDENTITY : spec.identityId;
  await world.executor.batch([
    st(
      'INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only, user_id, service_principal_id, project_id, project_mode, validation_kind, validation_identity_id, expires_at, revoked_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      spec.id,
      world.a.orgId,
      kind,
      selector(spec.selectorNo),
      hash,
      version,
      spec.id,
      JSON.stringify([scope]),
      scope === 'read' ? 1 : 0,
      kind === 'pat' ? (spec.userId ?? USER) : null,
      kind === 'svc' ? (spec.principal ?? PRINCIPAL) : null,
      kind === 'svc' ? (spec.projectId ?? null) : null,
      spec.mode ?? 'all',
      kind === 'pat' ? 'sso' : null,
      kind === 'pat' ? identityId : null,
      spec.expiresAt ?? iso(HOUR),
      spec.revokedAt ?? null,
      spec.lastUsedAt ?? null,
    ),
    ...(spec.projects ?? []).map((project) =>
      st(
        'INSERT INTO token_project (org_id, token_id, project_id) VALUES (?, ?, ?)',
        world.a.orgId,
        spec.id,
        project,
      ),
    ),
  ]);
  return plaintext;
}

async function addPrincipal(
  world: World,
  permissions: readonly string[],
  projectId: string | null = null,
  id = PRINCIPAL,
): Promise<void> {
  await world.executor.batch([
    st(
      'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id) VALUES (?, ?, ?, ?, ?)',
      id,
      world.a.orgId,
      id,
      projectId,
      USER,
    ),
    ...permissions.map((permission) =>
      st(
        'INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, ?)',
        world.a.orgId,
        id,
        permission,
      ),
    ),
  ]);
}

const crossOrganization: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([
        orgWide(world),
        st(
          'INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, ?)',
          'role-b',
          world.b.orgId,
          'all',
          'All',
          'organization',
        ),
        st(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          world.b.orgId,
          'role-b',
          'project:read',
        ),
        st(
          'INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, ?, ?, ?, ?)',
          'grant-b',
          world.b.orgId,
          'email',
          EMAIL,
          'organization',
          'role-b',
        ),
      ]);
      const pat = await addToken(world, { id: 'pat-a', selectorNo: 1 });
      const selected = await addToken(world, {
        id: 'pat-selected',
        selectorNo: 2,
        mode: 'selected',
        projects: [ALPHA, FOREIGN],
      });

      expect(await decide(world, { bearer: pat })).toMatchObject({ allow: true, projectId: ALPHA });
      expect(await decide(world, { bearer: pat, slug: 'foreign' })).toEqual(NOT_FOUND);
      expect(await decide(world, { bearer: selected, slug: 'foreign' })).toEqual(NOT_FOUND);
      expect(await decide(world, { bearer: pat, slug: 'foreign', org: world.b })).toEqual(
        UNAUTHORIZED,
      );
      expect(await decide(world, session({ slug: 'foreign' }))).toEqual(NOT_FOUND);
      expect(await decide(world, session({ org: world.b }))).toEqual(UNAUTHORIZED);
      expect(await decide(world, { bearer: pat, slug: 'shared' })).toMatchObject({
        allow: true,
        projectId: SHARED_A,
      });
      expect(await decide(world, session({ slug: 'shared' }))).toMatchObject({
        allow: true,
        projectId: SHARED_A,
      });
      expect(
        await createAccessRepository(world.executor).lookupToken(world.b, {
          selector: selector(1),
          boundary: 'project',
          projectSlug: 'foreign',
          providerAnchors: anchors,
        }),
      ).toBeNull();
    },
    wrap,
  );

const projectBinding: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const selected = await addToken(world, {
        id: 'pat-selected',
        selectorNo: 1,
        mode: 'selected',
        projects: [ALPHA],
      });
      expect(await decide(world, { bearer: selected })).toMatchObject({ allow: true });
      expect(await decide(world, { bearer: selected, slug: 'beta' })).toEqual(FORBIDDEN);

      const permissions = ['project:read', 'project:packages:read', 'project:packages:write'];
      await addPrincipal(world, permissions, ALPHA);
      await addPrincipal(world, permissions, null, 'principal-open');
      const bound = await addToken(world, {
        id: 'svc-bound',
        kind: 'svc',
        selectorNo: 2,
        projectId: ALPHA,
      });
      const open = await addToken(world, {
        id: 'svc-open',
        kind: 'svc',
        selectorNo: 3,
        principal: 'principal-open',
      });
      const drifted = await addToken(world, {
        id: 'svc-drifted',
        kind: 'svc',
        selectorNo: 4,
        projectId: BETA,
      });

      expect(await decide(world, { bearer: bound })).toMatchObject({
        allow: true,
        principal: { kind: 'service', id: PRINCIPAL },
        projectId: ALPHA,
      });
      expect(await decide(world, { bearer: bound, slug: 'beta' })).toEqual(NOT_FOUND);
      expect(await decide(world, { bearer: bound, slug: 'shared' })).toEqual(NOT_FOUND);
      expect(await decide(world, { bearer: open, slug: 'beta' })).toMatchObject({ allow: true });
      expect(await decide(world, { bearer: drifted })).toEqual(FORBIDDEN);
      expect(await decide(world, { bearer: drifted, slug: 'beta' })).toEqual(NOT_FOUND);
      expect(
        await decide(world, { bearer: bound, permission: 'project:packages:write' }),
      ).toMatchObject({ allow: true });
      expect(await decide(world, { bearer: bound, permission: 'project:settings:write' })).toEqual(
        FORBIDDEN,
      );
      expect(
        await decide(world, { bearer: bound, boundary: 'organization', permission: 'org:read' }),
      ).toEqual(FORBIDDEN);

      await world.executor.batch([
        st(
          'DELETE FROM service_principal_permission WHERE service_principal_id = ? AND permission = ?',
          PRINCIPAL,
          'project:packages:write',
        ),
      ]);
      expect(await decide(world, { bearer: bound, permission: 'project:packages:write' })).toEqual(
        FORBIDDEN,
      );
      expect(await decide(world, { bearer: bound })).toMatchObject({ allow: true });

      await world.executor.batch([
        st("UPDATE service_principal SET status = 'suspended' WHERE id = ?", PRINCIPAL),
      ]);
      expect(await decide(world, { bearer: bound })).toEqual(UNAUTHORIZED);
      expect(
        await createAccessRepository(world.executor).touchToken(world.a, 'svc-bound', 'svc'),
      ).toBe(false);
    },
    wrap,
  );

const emptySelected: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const plaintext = await addToken(world, {
        id: 'pat-empty',
        selectorNo: 1,
        mode: 'selected',
      });
      const repository = createAccessRepository(world.executor);
      for (const slug of ['alpha', 'beta', 'missing', 'old']) {
        const found = await repository.lookupToken(world.a, {
          selector: selector(1),
          boundary: 'project',
          projectSlug: slug,
          providerAnchors: anchors,
        });
        expect(found).not.toBeNull();
        expect(found?.validation?.fresh).toBe(true);
        expect(found?.project).toBeNull();
        expect(found?.projectPermissions).toEqual([]);
        expect(await decide(world, { bearer: plaintext, slug })).toEqual(
          slug === 'alpha' || slug === 'beta' ? FORBIDDEN : NOT_FOUND,
        );
      }
      expect(
        await decide(world, {
          bearer: plaintext,
          boundary: 'organization',
          permission: 'org:read',
        }),
      ).toEqual(FORBIDDEN);
    },
    wrap,
  );

const concealedSlugs: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const pat = await addToken(world, { id: 'pat', selectorNo: 1 });
      const concealed = [
        'missing',
        'foreign',
        'old',
        '%61lpha',
        'alph%61',
        '%2561lpha',
        'alpha%2fbeta',
        'ALPHA',
        'alpha ',
        'alpha/',
        '',
      ];
      for (const slug of concealed) {
        for (const permission of ['project:read', 'project:settings:write']) {
          expect(await decide(world, session({ slug, permission }))).toEqual(NOT_FOUND);
          expect(await decide(world, { bearer: pat, slug, permission })).toEqual(NOT_FOUND);
        }
      }
      const archived = await createAccessRepository(world.executor).lookupSession(world.a, {
        secretHash: await sha256Hex(SESSION_SECRET),
        boundary: 'project',
        projectSlug: 'old',
        providerAnchors: anchors,
      });
      expect(archived).not.toBeNull();
      expect(archived?.project).toBeNull();
      expect(archived?.projectPermissions).toEqual([]);
      expect(await decide(world, session())).toMatchObject({ allow: true, projectId: ALPHA });
    },
    wrap,
  );

const grantInheritance: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      const email: Subject = { type: 'email', value: EMAIL };
      await world.executor.batch([grant(world, ROLE_PROJECT, email, ALPHA)]);
      expect(await decide(world, session())).toMatchObject({ allow: true, projectId: ALPHA });
      expect(await decide(world, session({ slug: 'beta' }))).toEqual(NOT_FOUND);
      expect(await decide(world, session({ permission: 'project:settings:write' }))).toEqual(
        FORBIDDEN,
      );
      expect(await decide(world, session({ boundary: 'organization' }))).toEqual(FORBIDDEN);

      await world.executor.batch([orgWide(world)]);
      for (const slug of ['alpha', 'beta']) {
        expect(await decide(world, session({ slug }))).toMatchObject({ allow: true });
      }
      expect(await decide(world, session({ boundary: 'organization' }))).toMatchObject({
        allow: true,
        projectId: null,
      });
      expect(await decide(world, session({ slug: 'old' }))).toEqual(NOT_FOUND);

      await world.executor.batch([
        st("DELETE FROM access_grant WHERE scope = 'organization' AND org_id = ?", world.a.orgId),
      ]);
      expect(await decide(world, session({ slug: 'beta' }))).toEqual(NOT_FOUND);
      expect(await decide(world, session())).toMatchObject({ allow: true });
    },
    wrap,
  );

const groupsAcrossProviders: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([
        grant(world, ROLE_ALL, { type: 'group', provider: 'idp0', value: 'ops' }, null),
        membership(world, 'idp1', 'ops'),
      ]);
      expect(await decide(world, session())).toEqual(NOT_FOUND);
      await world.executor.batch([membership(world, 'idp0', 'ops')]);
      expect(await decide(world, session())).toMatchObject({ allow: true, projectId: ALPHA });
      await world.executor.batch([
        st("DELETE FROM user_group WHERE provider = 'idp0' AND group_name = 'ops'"),
      ]);
      expect(await decide(world, session())).toEqual(NOT_FOUND);
      await world.executor.batch([
        st("DELETE FROM identity WHERE id = 'identity-a1'"),
        membership(world, 'idp0', 'ops'),
        grant(world, ROLE_ALL, { type: 'group', provider: 'idp1', value: 'other' }, null),
        membership(world, 'idp1', 'other'),
      ]);
      expect(await decide(world, session({ slug: 'beta' }))).toMatchObject({ allow: true });
      await world.executor.batch([st("DELETE FROM user_group WHERE provider = 'idp0'")]);
      expect(await decide(world, session({ slug: 'beta' }))).toEqual(NOT_FOUND);
    },
    wrap,
  );

const staleEvidence: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([
        grant(world, ROLE_ALL, { type: 'group', provider: 'idp0', value: 'ops' }, null),
        membership(world, 'idp0', 'ops', iso(-DAY + 1000)),
      ]);
      expect(await decide(world, session())).toMatchObject({ allow: true });
      const refresh = (offset: number) =>
        world.executor.batch([
          st('UPDATE user_group SET refreshed_at = ?', iso(offset)),
          st('UPDATE identity SET validated_at = ?', iso(-60_000)),
        ]);
      await refresh(-DAY - 1000);
      expect(await decide(world, session())).toEqual(NOT_FOUND);
      await refresh(59_000);
      expect(await decide(world, session())).toMatchObject({ allow: true });
      await refresh(61_000);
      expect(await decide(world, session())).toEqual(NOT_FOUND);
      await refresh(-60_000);
      await world.executor.batch([st('UPDATE identity SET validated_at = ?', iso(-DAY - 1000))]);
      expect(await decide(world, session())).toEqual(NOT_FOUND);
      await world.executor.batch([st('UPDATE identity SET validated_at = ?', iso(-DAY + 1000))]);
      expect(await decide(world, session())).toMatchObject({ allow: true });
    },
    wrap,
  );

const changedAnchor: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([
        grant(world, ROLE_ALL, { type: 'group', provider: 'idp0', value: 'ops' }, null),
        membership(world, 'idp0', 'ops'),
        orgWide(world, ROLE_PROJECT),
      ]);
      expect(await decide(world, session({ slug: 'beta' }))).toMatchObject({ allow: true });
      const moved = anchors.map((entry) =>
        entry.provider === 'idp0' ? { ...entry, anchor: 'oidc:https://moved.example.test' } : entry,
      );
      expect(await decide(world, session({ anchors: moved, slug: 'beta' }))).toEqual(NOT_FOUND);
      expect(await decide(world, session({ anchors: [], slug: 'beta' }))).toEqual(NOT_FOUND);
      await world.executor.batch([
        st(
          "UPDATE identity_provider_binding SET anchor = ? WHERE provider = 'idp0'",
          moved[0]!.anchor,
        ),
      ]);
      expect(await decide(world, session({ slug: 'beta' }))).toEqual(NOT_FOUND);
      expect(await decide(world, session({ anchors: moved, slug: 'beta' }))).toMatchObject({
        allow: true,
      });
    },
    wrap,
  );

const emailEvidence: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      expect(await decide(world, session())).toMatchObject({ allow: true });

      await world.executor.batch([
        st("UPDATE identity SET email_verified = 0 WHERE id = 'identity-a0'"),
      ]);
      expect(await decide(world, session())).toMatchObject({ allow: true });
      await world.executor.batch([st('UPDATE identity SET email_verified = 0')]);
      expect(await decide(world, session())).toEqual(NOT_FOUND);
      await world.executor.batch([st('UPDATE identity SET email_verified = 1')]);
      expect(await decide(world, session())).toMatchObject({ allow: true });

      await world.executor.batch([st("UPDATE identity SET email = 'changed@example.test'")]);
      expect(await decide(world, session())).toEqual(NOT_FOUND);
      await world.executor.batch([st('UPDATE identity SET email = ?', EMAIL)]);
      expect(await decide(world, session())).toMatchObject({ allow: true });

      await world.executor.batch([
        st("UPDATE user_account SET email = 'renamed@example.test' WHERE id = ?", USER),
      ]);
      expect(await decide(world, session())).toEqual(NOT_FOUND);
      await world.executor.batch([
        st('UPDATE user_account SET email = ? WHERE id = ?', EMAIL, USER),
      ]);

      await world.executor.batch([
        st("UPDATE session SET identity_id = 'identity-a2' WHERE id = ?", SESSION),
        st("DELETE FROM identity WHERE provider <> 'idp2'"),
      ]);
      expect(await decide(world, session())).toEqual(NOT_FOUND);
      await world.executor.batch([
        grant(world, ROLE_ALL, { type: 'group', provider: 'idp2', value: 'ops' }, null),
        membership(world, 'idp2', 'ops'),
      ]);
      expect(await decide(world, session())).toMatchObject({ allow: true });
    },
    wrap,
  );

const routeRegistration: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const request = requestFor(world, session());
      expect(await authorizeRoute(request, denyAllEngine, [])).toEqual(FORBIDDEN);
      expect(await decide(world, session())).toMatchObject({ allow: true });

      const real = engineFor(world.executor);
      let engineCalls = 0;
      const counting: AuthorizationEngine = {
        authorize: (candidate) => {
          engineCalls += 1;
          return real.authorize(candidate);
        },
      };
      for (const permission of ['', ' ', 'project:read\u0000']) {
        const malformed = { ...request, route: { ...request.route, permission } };
        expect(await authorizeRoute(malformed, counting, [])).toEqual(FORBIDDEN);
      }
      expect(engineCalls).toBe(0);
      expect(await authorizeRoute(request, counting, [])).toMatchObject({ allow: true });

      for (const boundary of [undefined, 'none', 'self', 'package', 'other']) {
        const route = { ...request.route, boundary } as unknown as AuthorizationRequest['route'];
        expect(await real.authorize({ ...request, route })).toEqual(FORBIDDEN);
      }
      expect(await decide(world, session({ permission: 'project:nonexistent' }))).toEqual(
        FORBIDDEN,
      );
      expect(await decide(world, session({ permission: 'org:read' }))).toEqual(FORBIDDEN);

      const problems = (route: Parameters<typeof routeBoundaryProblems>[0], apiVersion?: number) =>
        routeBoundaryProblems(route, 'GET /x', apiVersion === undefined ? {} : { apiVersion });
      expect(
        problems({ path: '/:project/x', permission: 'project:read', boundary: 'project' }, 3),
      ).toEqual([]);
      expect(problems({ path: '/x', permission: null }, 3)).toEqual([]);
      expect(problems({ path: '/:project/x', permission: 'project:read' }, 2)).toEqual([
        expect.stringContaining('explicit boundary'),
      ]);
      expect(problems({ path: '/:project/x', permission: 'project:read' })).toEqual([
        expect.stringContaining('explicit boundary'),
      ]);
      expect(
        problems({ path: '/:project/x', permission: 'project:read', boundary: 'project' }, 2),
      ).toEqual([expect.stringContaining('apiVersion')]);
      expect(problems({ path: '/x', permission: null, boundary: 'project' }, 3)).toEqual([
        expect.stringContaining('public route'),
      ]);
      expect(problems({ path: '/x', permission: null, boundary: 'organization' }, 3)).toEqual([
        expect.stringContaining('public route'),
      ]);
      expect(
        problems(
          { path: '/:project/x', permission: 'project:nonexistent', boundary: 'project' },
          3,
        ),
      ).toEqual([expect.stringContaining('unknown permission')]);
      expect(problems({ path: '/x', permission: 'org:read', boundary: 'project' }, 3)).not.toEqual(
        [],
      );
      expect(problems({ path: '/x', permission: 7, boundary: 'organization' }, 3)).not.toEqual([]);
      expect(problems({ path: '/x', permission: 'org:read', boundary: 'weird' }, 3)).not.toEqual(
        [],
      );
    },
    wrap,
  );

const credentialTransport: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const read = await addToken(world, { id: 'pat-read', selectorNo: 1, scope: 'read' });
      const full = await addToken(world, { id: 'pat-full', selectorNo: 2 });
      const write = { permission: 'project:packages:write', method: 'POST' };

      expect(await decide(world, { basic: full })).toMatchObject({ allow: true });
      expect(await decide(world, { basic: full, ...write })).toEqual(UNAUTHORIZED);
      expect(
        await decide(world, { basic: full, ...write, origin: 'https://evil.example.test' }),
      ).toEqual(UNAUTHORIZED);
      expect(await decide(world, { basic: full, ...write, origin: ORIGIN })).toMatchObject({
        allow: true,
      });
      expect(await decide(world, { bearer: full, ...write })).toMatchObject({ allow: true });
      expect(await decide(world, { bearer: full, ...write, method: 'DELETE' })).toMatchObject({
        allow: true,
      });

      expect(await decide(world, session({ ...write, bearer: read }))).toEqual(FORBIDDEN);
      expect(await decide(world, session({ bearer: full }))).toMatchObject({ allow: true });
      expect(await decide(world, session({ authorization: 'Bearer nonsense' }))).toEqual(
        UNAUTHORIZED,
      );
      expect(await decide(world, session({ authorization: 'Digest abc' }))).toEqual(UNAUTHORIZED);
      expect(await decide(world, {})).toEqual(UNAUTHORIZED);
      expect(await decide(world, { method: 'HEAD' })).toEqual(UNAUTHORIZED);
      expect(await decide(world, session({ method: 'HEAD', slug: 'beta' }))).toMatchObject({
        allow: true,
      });

      const unsafe = { ...write, origin: ORIGIN, csrf: CSRF_SECRET };
      expect(await decide(world, session(unsafe))).toMatchObject({ allow: true });
      expect(await decide(world, session({ ...unsafe, origin: null }))).toEqual(FORBIDDEN);
      expect(
        await decide(world, session({ ...unsafe, origin: 'https://evil.example.test' })),
      ).toEqual(FORBIDDEN);
      expect(await decide(world, session({ ...unsafe, csrf: null }))).toEqual(FORBIDDEN);
      expect(await decide(world, session({ ...unsafe, csrf: 'D'.repeat(43) }))).toEqual(FORBIDDEN);
      expect(await decide(world, session({ ...unsafe, csrf: 'short' }))).toEqual(FORBIDDEN);
    },
    wrap,
  );

const tokenVerification: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      await addPrincipal(world, ['project:read', 'project:packages:read']);
      const pat = await addToken(world, { id: 'pat', selectorNo: 1 });
      const svc = await addToken(world, { id: 'svc', kind: 'svc', selectorNo: 2 });
      expect(await decide(world, { bearer: pat })).toMatchObject({
        allow: true,
        principal: { kind: 'user', id: USER },
      });
      expect(await decide(world, { bearer: svc })).toMatchObject({
        allow: true,
        principal: { kind: 'service', id: PRINCIPAL },
      });

      const swap = (token: string, index: number, replacement: string) =>
        token.slice(0, index) + replacement + token.slice(index + replacement.length);
      const altered = [
        swap(pat, 3, 'xyz'),
        swap(pat, 0, 'pa'),
        pat.replace('pb_pat_', 'pb_svc_'),
        swap(pat, 7, 'z'),
        swap(pat, 7 + 12 + 1, pat.at(20) === 'A' ? 'B' : 'A'),
        pat.slice(0, -1),
        `${pat}x`,
      ];
      for (const bearer of altered) {
        expect(await decide(world, { bearer })).toEqual(UNAUTHORIZED);
      }

      const calls: string[] = [];
      const counting: Wrap = (executor) => ({
        driver: executor.driver,
        batch: executor.batch.bind(executor),
        all: (statement) => {
          calls.push(statement.sql);
          return executor.all(statement);
        },
      });
      const probeWorld: World = { ...world, executor: counting(world.executor) };
      const reserved = formatToken('cst', selector(3), new Uint8Array(32).fill(9));
      for (const bearer of [reserved, altered[0] ?? '', altered[5] ?? '']) {
        expect(await decide(probeWorld, { bearer })).toEqual(UNAUTHORIZED);
      }
      expect(calls).toEqual([]);

      const other = formatToken('pat', selector(4), new Uint8Array(32).fill(9));
      const foreignHash = await hashToken(keyring, 1, other);
      const wrongHash = await addToken(world, { id: 'pat-hash', selectorNo: 5, hash: foreignHash });
      expect(await decide(world, { bearer: wrongHash })).toEqual(UNAUTHORIZED);

      const asService = formatToken('svc', selector(6), new Uint8Array(32).fill(9));
      await addToken(world, {
        id: 'pat-kind',
        selectorNo: 6,
        hash: await hashToken(keyring, 1, asService),
      });
      expect(await decide(world, { bearer: asService })).toEqual(UNAUTHORIZED);

      for (const version of [1, 2, 3, 4]) {
        const retained = await addToken(world, {
          id: `pat-v${version}`,
          selectorNo: 10 + version,
          version,
        });
        expect(await decide(world, { bearer: retained })).toMatchObject({ allow: true });
      }
      const unknownPepper = await addToken(world, {
        id: 'pat-v9',
        selectorNo: 20,
        version: 9,
        hashKeyring: outsideKeyring,
      });
      expect(await decide(world, { bearer: unknownPepper })).toEqual(UNAUTHORIZED);
      expect(
        await decide(world, { bearer: unknownPepper, engineKeyring: outsideKeyring }),
      ).toMatchObject({ allow: true });
      const withoutThree = createKeyring(
        [4, 2, 1].map((version) => ({ version, bytes: keyBytes(version) })),
      );
      const retainedThree = await addToken(world, {
        id: 'pat-dropped',
        selectorNo: 21,
        version: 3,
      });
      expect(await decide(world, { bearer: retainedThree })).toMatchObject({ allow: true });
      expect(await decide(world, { bearer: retainedThree, engineKeyring: withoutThree })).toEqual(
        UNAUTHORIZED,
      );
    },
    wrap,
  );

const tokenLifecycle: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const live = await addToken(world, { id: 'pat-live', selectorNo: 1 });
      expect(await decide(world, { bearer: live })).toMatchObject({ allow: true });

      const expiring = await addToken(world, {
        id: 'pat-expiring',
        selectorNo: 2,
        expiresAt: iso(1000),
      });
      expect(await decide(world, { bearer: expiring })).toMatchObject({ allow: true });
      const expired = await addToken(world, {
        id: 'pat-expired',
        selectorNo: 3,
        expiresAt: iso(-1000),
      });
      expect(await decide(world, { bearer: expired })).toEqual(UNAUTHORIZED);
      const unparsable = await addToken(world, {
        id: 'pat-garbage',
        selectorNo: 4,
        expiresAt: 'tomorrow',
      });
      expect(await decide(world, { bearer: unparsable })).toEqual(UNAUTHORIZED);

      const revoked = await addToken(world, {
        id: 'pat-revoked',
        selectorNo: 5,
        revokedAt: iso(-1000),
      });
      expect(await decide(world, { bearer: revoked })).toEqual(UNAUTHORIZED);

      const evidence = (offset: number) =>
        world.executor.batch([
          st('UPDATE identity SET validated_at = ? WHERE id = ?', iso(offset), IDENTITY),
        ]);
      await evidence(-DAY + 1000);
      expect(await decide(world, { bearer: live })).toMatchObject({ allow: true });
      await evidence(-DAY - 1000);
      expect(await decide(world, { bearer: live })).toEqual(UNAUTHORIZED);
      await evidence(59_000);
      expect(await decide(world, { bearer: live })).toMatchObject({ allow: true });
      await evidence(61_000);
      expect(await decide(world, { bearer: live })).toEqual(UNAUTHORIZED);
      await evidence(-60_000);
      expect(await decide(world, { bearer: live })).toMatchObject({ allow: true });

      await world.executor.batch([
        st('UPDATE identity SET email_verified = 0 WHERE id = ?', IDENTITY),
      ]);
      expect(await decide(world, { bearer: live })).toEqual(UNAUTHORIZED);
      await world.executor.batch([
        st('UPDATE identity SET email_verified = 1 WHERE id = ?', IDENTITY),
        st("UPDATE user_account SET status = 'suspended' WHERE id = ?", USER),
      ]);
      expect(await decide(world, { bearer: live })).toEqual(UNAUTHORIZED);
      expect(await decide(world, session())).toEqual(UNAUTHORIZED);
      await world.executor.batch([
        st("UPDATE user_account SET status = 'active' WHERE id = ?", USER),
      ]);
      expect(await decide(world, { bearer: live })).toMatchObject({ allow: true });

      const repository = createAccessRepository(world.executor);
      const touchable = await addToken(world, {
        id: 'pat-touch',
        selectorNo: 6,
        lastUsedAt: iso(-300_000 + 1000),
      });
      expect(touchable).toContain('pb_pat_');
      expect(await repository.touchToken(world.a, 'pat-touch', 'pat')).toBe(false);
      await world.executor.batch([
        st('UPDATE token SET last_used_at = ? WHERE id = ?', iso(-300_000 - 1000), 'pat-touch'),
      ]);
      expect(await repository.touchToken(world.a, 'pat-touch', 'pat')).toBe(true);
      expect(await repository.touchToken(world.a, 'pat-touch', 'pat')).toBe(false);
      expect(await repository.touchToken(world.a, 'pat-revoked', 'pat')).toBe(false);
      expect(await repository.touchToken(world.a, 'pat-expired', 'pat')).toBe(false);
      expect(await repository.touchToken(world.a, 'pat-live', 'svc')).toBe(false);
    },
    wrap,
  );

const policyEscalation: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const tokens = {
        read: await addToken(world, { id: 'pat-read', selectorNo: 1, scope: 'read' }),
        write: await addToken(world, { id: 'pat-write', selectorNo: 2, scope: 'write' }),
        full: await addToken(world, { id: 'pat-full', selectorNo: 3, scope: 'full' }),
      };
      const allowedProject: Record<keyof typeof tokens, readonly string[]> = {
        read: ['project:read', 'project:packages:read'],
        write: ['project:read', 'project:packages:read', 'project:packages:write'],
        full: PERMISSIONS.filter(
          ({ scope, sessionOnly }) => scope === 'project' && !sessionOnly,
        ).map(({ name }) => name),
      };
      for (const [level, bearer] of Object.entries(tokens) as [keyof typeof tokens, string][]) {
        for (const info of PERMISSIONS) {
          const boundary = info.scope === 'project' ? 'project' : 'organization';
          const expected =
            boundary === 'project'
              ? allowedProject[level].includes(info.name)
              : level === 'full' && !info.sessionOnly;
          const decision = await decide(world, { bearer, permission: info.name, boundary });
          expect(decision.allow, `${level} token on ${info.name}`).toBe(expected);
          if (!expected) expect(decision).toEqual(FORBIDDEN);
          const viaSession = await decide(world, session({ permission: info.name, boundary }));
          expect(viaSession.allow, `session on ${info.name}`).toBe(true);
        }
      }
      const sessionOnly = PERMISSIONS.filter((info) => info.sessionOnly);
      expect(sessionOnly.length).toBeGreaterThan(0);
      for (const info of sessionOnly) {
        const boundary = info.scope === 'project' ? 'project' : 'organization';
        expect(
          await decide(world, { bearer: tokens.full, permission: info.name, boundary }),
        ).toEqual(FORBIDDEN);
      }

      await world.executor.batch([st("UPDATE token SET read_only = 0 WHERE id = 'pat-read'")]);
      expect(await decide(world, { bearer: tokens.read })).toEqual(FORBIDDEN);
      await world.executor.batch([
        st("UPDATE token SET read_only = 1 WHERE id = 'pat-read'"),
        st('UPDATE token SET scopes_json = \'["read","full"]\' WHERE id = \'pat-full\''),
      ]);
      expect(await decide(world, { bearer: tokens.full })).toEqual(FORBIDDEN);
      await world.executor.batch([
        st("UPDATE token SET scopes_json = '[\"full\"]' WHERE id = 'pat-full'"),
        st("UPDATE project SET token_max_scope = 'read' WHERE id = ?", ALPHA),
      ]);
      expect(
        await decide(world, { bearer: tokens.full, permission: 'project:packages:write' }),
      ).toEqual(FORBIDDEN);
      expect(
        await decide(world, { bearer: tokens.full, permission: 'project:packages:read' }),
      ).toMatchObject({
        allow: true,
      });
      expect(
        await decide(world, {
          bearer: tokens.full,
          permission: 'project:packages:write',
          slug: 'beta',
        }),
      ).toMatchObject({ allow: true });
    },
    wrap,
  );

const FENCE = (): ReturnType<typeof mutationFence> =>
  mutationFence({ userId: USER, sessionId: SESSION } as unknown as AuthenticatedActor, {});

function minted(selectorNo: number, byte = 9) {
  const plaintext = formatToken('pat', selector(selectorNo), new Uint8Array(32).fill(byte));
  return hashToken(keyring, 1, plaintext).then((hash) => ({
    selector: selector(selectorNo),
    hash,
    pepperVersion: 1,
    plaintext,
  }));
}

function issueInput(
  overrides: Partial<Parameters<ReturnType<typeof createTokenRepository>['issuePersonal']>[2]> = {},
) {
  return {
    id: 'issued',
    name: 'Issued',
    scope: 'write' as const,
    projectMode: 'all' as const,
    projectIds: [] as string[],
    validation: { kind: 'sso' as const, identityId: IDENTITY },
    providerAnchors: anchors,
    now: iso(0),
    expiresAt: iso(HOUR),
    ...overrides,
  };
}

const issuance: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const tokens = createTokenRepository(world.executor);
      const count = async (sql: string) =>
        Number((await world.executor.all<{ n: number }>(st(sql)))[0]?.n);

      await addToken(world, { id: 'occupied', selectorNo: 1 });
      let mints = 0;
      const colliding = await tokens.issuePersonal(world.a, FENCE(), issueInput(), async () => {
        mints += 1;
        return minted(1);
      });
      expect(colliding).toEqual({ status: 'refused', reason: 'selector_collision' });
      expect(mints).toBe(3);
      expect(await count("SELECT count(*) AS n FROM token WHERE id = 'issued'")).toBe(0);
      expect('plaintext' in colliding).toBe(false);

      mints = 0;
      const recovered = await tokens.issuePersonal(world.a, FENCE(), issueInput(), async () => {
        mints += 1;
        return minted(mints === 1 ? 1 : 2, mints === 1 ? 9 : 8);
      });
      expect(mints).toBe(2);
      if (recovered.status !== 'issued') throw new Error('issuance must recover from a collision');
      const stored = JSON.stringify(await world.executor.all(st('SELECT * FROM token')));
      expect(stored).not.toContain(recovered.plaintext);
      expect(stored).not.toContain(recovered.plaintext.slice(-43));
      expect(await decide(world, { bearer: recovered.plaintext })).toMatchObject({ allow: true });

      const duplicate = await tokens.issuePersonal(world.a, FENCE(), issueInput(), () => minted(3));
      expect(duplicate).toEqual({ status: 'refused', reason: 'id_conflict' });
      expect(await count('SELECT count(*) AS n FROM token')).toBe(2);

      const partial = await tokens.issuePersonal(
        world.a,
        FENCE(),
        issueInput({ id: 'partial', projectMode: 'selected', projectIds: [ALPHA, FOREIGN] }),
        () => minted(4),
      );
      expect(partial).toEqual({ status: 'refused', reason: 'authority' });
      expect(await count("SELECT count(*) AS n FROM token WHERE id = 'partial'")).toBe(0);
      expect(
        await count("SELECT count(*) AS n FROM token_project WHERE token_id = 'partial'"),
      ).toBe(0);
      const dropsBindings: SqlExecutor = {
        driver: world.executor.driver,
        all: (statement) => world.executor.all(statement),
        batch: (statements) =>
          world.executor.batch(
            statements.map((statement) =>
              statement.sql.startsWith('insert into "token_project"')
                ? st('select 1 where 0')
                : statement,
            ),
          ),
      };
      const interrupted = await createTokenRepository(dropsBindings).issuePersonal(
        world.a,
        FENCE(),
        issueInput({ id: 'interrupted', projectMode: 'selected', projectIds: [ALPHA, BETA] }),
        () => minted(8),
      );
      expect(interrupted.status).toBe('refused');
      expect(await count("SELECT count(*) AS n FROM token WHERE id = 'interrupted'")).toBe(0);

      const archivedBinding = await tokens.issuePersonal(
        world.a,
        FENCE(),
        issueInput({ id: 'archived', projectMode: 'selected', projectIds: [ALPHA, OLD] }),
        () => minted(5),
      );
      expect(archivedBinding).toEqual({ status: 'refused', reason: 'authority' });
      expect(
        await count("SELECT count(*) AS n FROM token_project WHERE token_id = 'archived'"),
      ).toBe(0);

      const selected = await tokens.issuePersonal(
        world.a,
        FENCE(),
        issueInput({ id: 'selected', projectMode: 'selected', projectIds: [ALPHA] }),
        () => minted(6, 7),
      );
      expect(selected.status).toBe('issued');
      expect(
        await count("SELECT count(*) AS n FROM token_project WHERE token_id = 'selected'"),
      ).toBe(1);

      await world.executor.batch([
        st('UPDATE session SET revoked_at = ? WHERE id = ?', iso(-1000), SESSION),
      ]);
      const revokedSession = await tokens.issuePersonal(
        world.a,
        FENCE(),
        issueInput({ id: 'late' }),
        () => minted(7),
      );
      expect(revokedSession).toEqual({ status: 'refused', reason: 'authority' });
      expect('plaintext' in revokedSession).toBe(false);
      expect(await count("SELECT count(*) AS n FROM token WHERE id = 'late'")).toBe(0);
    },
    wrap,
  );

const issuanceBoundaries: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const now = Date.now();
      const iso = (offset: number) => new Date(now + offset).toISOString();
      // Pin SQL and fixture timestamps together: a pause can cross the one-second boundaries.
      const atDatabaseTime = (statement: Statement): Statement => ({
        ...statement,
        sql: statement.sql.replaceAll("'now'", `'${iso(0)}'`),
      });
      const clock: SqlExecutor = {
        driver: world.executor.driver,
        all: (statement) => world.executor.all(atDatabaseTime(statement)),
        batch: (statements) => world.executor.batch(statements.map(atDatabaseTime)),
      };
      const tokens = createTokenRepository(clock);
      let next = 0;
      const attempt = async (reauthOffset: number, expiresOffset: number) => {
        next += 1;
        await world.executor.batch([
          st('UPDATE session SET reauth_at = ? WHERE id = ?', iso(reauthOffset), SESSION),
        ]);
        const result = await tokens.issuePersonal(
          world.a,
          FENCE(),
          issueInput({ id: `issued-${next}`, now: iso(0), expiresAt: iso(expiresOffset) }),
          () => minted(next),
        );
        return result.status === 'issued' ? 'issued' : result;
      };
      expect(await attempt(-600_000 + 1000, HOUR)).toBe('issued');
      expect(await attempt(-600_000 - 1000, HOUR)).toEqual({
        status: 'refused',
        reason: 'authority',
      });
      expect(await attempt(-60_000, 90 * DAY - 1000)).toBe('issued');
      expect(await attempt(-60_000, 90 * DAY + 1000)).toEqual({
        status: 'refused',
        reason: 'authority',
      });
      expect(await attempt(-60_000, 1000)).toBe('issued');
      const days = (count: number) =>
        world.executor.batch([
          st(
            'UPDATE organization SET token_default_expiry_days = ? WHERE id = ?',
            count,
            world.a.orgId,
          ),
        ]);
      await days(400);
      expect(await attempt(-60_000, 90 * DAY - 1000)).toBe('issued');
      expect(await attempt(-60_000, 91 * DAY)).toEqual({ status: 'refused', reason: 'authority' });
      await days(30);
      expect(await attempt(-60_000, 30 * DAY - 1000)).toBe('issued');
      expect(await attempt(-60_000, 30 * DAY + 1000)).toEqual({
        status: 'refused',
        reason: 'authority',
      });
      await days(90);
      expect(await attempt(-60_000, -1000).catch((error: unknown) => String(error))).toContain(
        'expiresAt must be in the future',
      );

      const evidence = (offset: number) =>
        world.executor.batch([
          st('UPDATE identity SET validated_at = ? WHERE id = ?', iso(offset), IDENTITY),
        ]);
      await evidence(-DAY + 1000);
      expect(await attempt(-60_000, HOUR)).toBe('issued');
      await evidence(-DAY - 1000);
      expect(await attempt(-60_000, HOUR)).toEqual({ status: 'refused', reason: 'authority' });
      await evidence(59_000);
      expect(await attempt(-60_000, HOUR)).toBe('issued');
      await evidence(61_000);
      expect(await attempt(-60_000, HOUR)).toEqual({ status: 'refused', reason: 'authority' });
    },
    wrap,
  );

const selectedIssuance: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const ids = Array.from(
        { length: 200 },
        (_, index) => `bulk-${String(index).padStart(3, '0')}`,
      );
      for (let offset = 0; offset < ids.length; offset += 50) {
        await world.executor.batch(
          ids
            .slice(offset, offset + 50)
            .map((id) =>
              st(
                'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
                id,
                world.a.orgId,
                id,
                id,
              ),
            ),
        );
      }
      const lengths: number[] = [];
      const measure = (statement: Statement) => {
        lengths.push(statement.params.length);
        return statement;
      };
      const measured: SqlExecutor = {
        driver: world.executor.driver,
        all: (statement) => world.executor.all(measure(statement)),
        batch: (statements) => world.executor.batch(statements.map(measure)),
      };
      const tokens = createTokenRepository(measured);
      const result = await tokens.issuePersonal(
        world.a,
        FENCE(),
        issueInput({ id: 'bulk', projectMode: 'selected', projectIds: ids }),
        () => minted(1),
      );
      expect(result.status).toBe('issued');
      const bound = await world.executor.all<{ n: number }>(
        st("SELECT count(*) AS n FROM token_project WHERE token_id = 'bulk'"),
      );
      expect(bound[0]?.n).toBe(200);
      expect(Math.max(...lengths)).toBeLessThanOrEqual(100);
      if (result.status !== 'issued') return;
      for (const slug of ['bulk-000', 'bulk-199']) {
        expect(await decide(world, { bearer: result.plaintext, slug })).toMatchObject({
          allow: true,
        });
      }
      expect(await decide(world, { bearer: result.plaintext, slug: 'alpha' })).toEqual(FORBIDDEN);

      await expect(
        tokens.issuePersonal(
          world.a,
          FENCE(),
          issueInput({ id: 'too-many', projectMode: 'selected', projectIds: [...ids, ALPHA] }),
          () => minted(2),
        ),
      ).rejects.toThrow(TypeError);
      await expect(
        tokens.issuePersonal(
          world.a,
          FENCE(),
          issueInput({ id: 'duplicates', projectMode: 'selected', projectIds: [ALPHA, ALPHA] }),
          () => minted(3),
        ),
      ).rejects.toThrow(TypeError);
      expect(
        await world.executor.all(st("SELECT id FROM token WHERE id IN ('too-many', 'duplicates')")),
      ).toEqual([]);
    },
    wrap,
  );

const providerRebind: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const pat = await addToken(world, { id: 'pat-sso', selectorNo: 1 });
      const survivor = await addToken(world, {
        id: 'pat-other-provider',
        selectorNo: 2,
        identityId: 'identity-a1',
      });
      expect(await decide(world, { bearer: pat })).toMatchObject({ allow: true });
      expect(await decide(world, { bearer: survivor })).toMatchObject({ allow: true });
      const moved = 'oidc:https://moved.example.test';
      const now = iso(0);

      expect(
        await rebindProvider(world.executor, world.a, 'idp0', ANCHORS.idp1, moved, now),
      ).toMatchObject({
        swapped: false,
      });
      expect(await decide(world, { bearer: pat })).toMatchObject({ allow: true });

      expect(
        await rebindProvider(world.executor, world.a, 'idp0', ANCHORS.idp0, moved, now),
      ).toMatchObject({
        swapped: true,
        identities: 1,
        sessions: 1,
      });
      const row = await world.executor.all<{
        revoked_at: string | null;
        validation_identity_id: string | null;
      }>(st("SELECT revoked_at, validation_identity_id FROM token WHERE id = 'pat-sso'"));
      expect(row[0]?.revoked_at).toBe(now);
      expect(row[0]?.validation_identity_id).toBeNull();
      const rebound = anchors.map((entry) =>
        entry.provider === 'idp0' ? { ...entry, anchor: moved } : entry,
      );
      expect(await decide(world, { bearer: pat, anchors: rebound })).toEqual(UNAUTHORIZED);
      expect(await decide(world, { bearer: pat })).toEqual(UNAUTHORIZED);
      expect(await decide(world, session({ anchors: rebound }))).toEqual(UNAUTHORIZED);
      expect(await decide(world, { bearer: survivor })).toMatchObject({ allow: true });
      expect(
        await world.executor.all(st("SELECT provider FROM identity_block WHERE provider = 'idp0'")),
      ).toHaveLength(1);
    },
    wrap,
  );

const nullGuardKey: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      const guards = () =>
        world.executor
          .all<{ n: number }>(st('SELECT count(*) AS n FROM access_mutation_guard'))
          .then((rows) => rows[0]?.n);
      const addUser = (id: string): Statement =>
        st(
          'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          id,
          world.a.orgId,
          `${id}@example.test`,
        );
      const condition = (value: 0 | 1 | null) => sql<boolean>`(select ${sql.lit(value)})`;
      await world.executor.batch([...assertGuard(condition(1), world.a), addUser('guard-ok')]);
      expect(await guards()).toBe(0);
      for (const value of [0, null] as const) {
        await expect(
          world.executor.batch([
            addUser(`guard-${String(value)}`),
            ...assertGuard(condition(value), world.a),
          ]),
        ).rejects.toMatchObject({ kind: 'unique' });
        expect(
          await world.executor.all(
            st('SELECT id FROM user_account WHERE id = ?', `guard-${String(value)}`),
          ),
        ).toEqual([]);
        expect(await guards()).toBe(0);
      }
      await expect(
        world.executor.batch([st('INSERT INTO access_mutation_guard (key) VALUES (NULL)')]),
      ).rejects.toBeDefined();
    },
    wrap,
  );

const projectRoleCarriesOrg: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      const roles = createRoleRepository(world.executor, { providerAnchors: anchors });
      const snapshot = async () =>
        JSON.stringify([
          await world.executor.all(st('SELECT * FROM role ORDER BY id')),
          await world.executor.all(
            st('SELECT * FROM role_permission ORDER BY role_id, permission'),
          ),
        ]);
      const before = await snapshot();
      let n = 0;
      for (const permission of ['org:*', 'org:read', 'org:roles:write', 'project:unknown']) {
        n += 1;
        expect(
          await roles.create(world.a, FENCE(), {
            id: `invalid-${n}`,
            key: `invalid_${n}`,
            name: 'Invalid',
            scope: 'project',
            permissions: [permission],
            now: iso(0),
            opId: `op-${n}`,
          }),
        ).toBe('invalid_permissions');
      }
      expect(await snapshot()).toBe(before);

      const widened = await roles.setPermissions(
        world.a,
        mutationFence({ userId: USER, sessionId: SESSION } as unknown as AuthenticatedActor, {
          role: 1,
        }),
        ROLE_PROJECT,
        ['project:read', 'org:read'],
        iso(0),
        'op-widen',
      );
      expect(widened).toBe('invalid_permissions');
      expect(await snapshot()).toBe(before);
    },
    wrap,
  );

export function projectActorIsNotAnActorContext(actor: ProjectActor): void {
  // @ts-expect-error a project actor carries no organization authority
  const widened: ActorContext = actor;
  void widened;
}

const archivedProjectRevocation: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await addPrincipal(world, ['project:read'], OLD);
      const first = await addToken(world, {
        id: 'svc-old',
        kind: 'svc',
        selectorNo: 1,
        projectId: OLD,
      });
      expect(first).toContain('pb_svc_');
      await world.executor.batch([
        grant(world, ROLE_PROJECT, { type: 'email', value: EMAIL }, OLD),
      ]);
      const authority = createServicePrincipalAuthority({
        executor: world.executor,
        providerAnchors: anchors,
      });
      const tokens = createTokenRepository(world.executor);
      const live = await authority.livePermissions(world.a, FENCE(), OLD);
      expect(live.has('project:tokens:revoke')).toBe(true);
      expect(live.has('org:tokens:revoke')).toBe(false);

      const requirement = (allowArchived?: boolean) => ({
        permission: 'project:tokens:revoke',
        projectId: OLD,
        organizationAdmin: false,
        covers: [] as string[],
        ...(allowArchived === true ? { allowArchived: true } : {}),
      });
      const blocked = await tokens.revoke(
        world.a,
        FENCE(),
        authority.guard(world.a, FENCE(), requirement()),
        'svc-old',
        iso(0),
      );
      expect(blocked.status).toBe('refused');
      const untouched = await world.executor.all<{ revoked_at: string | null }>(
        st("SELECT revoked_at FROM token WHERE id = 'svc-old'"),
      );
      expect(untouched[0]?.revoked_at).toBeNull();

      const allowed = await tokens.revoke(
        world.a,
        FENCE(),
        authority.guard(world.a, FENCE(), requirement(true)),
        'svc-old',
        iso(0),
      );
      expect(allowed.status).toBe('revoked');
      const archivedLookup = await createAccessRepository(world.executor).lookupToken(world.a, {
        selector: selector(1),
        boundary: 'project',
        projectSlug: 'old',
        providerAnchors: anchors,
      });
      expect(archivedLookup?.token.revoked).toBe(true);
      expect(archivedLookup?.project).toBeNull();
    },
    wrap,
  );

const doubleRevoke: Case = (open, wrap) =>
  fixture(
    open,
    async (world) => {
      await world.executor.batch([orgWide(world)]);
      await addToken(world, { id: 'victim', selectorNo: 1 });
      const other = await world.second();
      const authority = (executor: SqlExecutor) =>
        createServicePrincipalAuthority({ executor, providerAnchors: anchors });
      const revoke = (executor: SqlExecutor, now: string) =>
        createTokenRepository(executor).revoke(
          world.a,
          FENCE(),
          authority(executor).guard(world.a, FENCE(), {
            permission: 'org:tokens:revoke',
            projectId: null,
            organizationAdmin: false,
            covers: [],
          }),
          'victim',
          now,
        );
      const stampA = iso(0);
      const stampB = iso(5000);
      const results = await Promise.all([revoke(world.executor, stampA), revoke(other, stampB)]);
      const winners = results.filter((result) => result.status === 'revoked');
      expect(winners).toHaveLength(1);
      expect(results.filter((result) => result.status === 'already_revoked')).toHaveLength(1);
      const rows = await world.executor.all<{ revoked_at: string; last_op_id: string }>(
        st("SELECT revoked_at, last_op_id FROM token WHERE id = 'victim'"),
      );
      expect(rows).toHaveLength(1);
      const winner = winners[0];
      if (winner?.status !== 'revoked') throw new Error('one revoke must win');
      expect(rows[0]?.last_op_id).toBe(winner.opId);
      expect([stampA, stampB]).toContain(rows[0]?.revoked_at);

      const again = await revoke(world.executor, iso(9000));
      expect(again).toEqual({ status: 'already_revoked' });
      const after = await world.executor.all(
        st("SELECT revoked_at, last_op_id FROM token WHERE id = 'victim'"),
      );
      expect(after).toEqual(rows);
      expect(
        await decide(world, {
          bearer: formatToken('pat', selector(1), new Uint8Array(32).fill(9)),
        }),
      ).toEqual(UNAUTHORIZED);
    },
    wrap,
  );

export const accessContractCases = {
  crossOrganization,
  projectBinding,
  emptySelected,
  concealedSlugs,
  grantInheritance,
  groupsAcrossProviders,
  staleEvidence,
  changedAnchor,
  emailEvidence,
  routeRegistration,
  credentialTransport,
  tokenVerification,
  tokenLifecycle,
  policyEscalation,
  issuance,
  issuanceBoundaries,
  selectedIssuance,
  providerRebind,
  nullGuardKey,
  projectRoleCarriesOrg,
  archivedProjectRevocation,
  doubleRevoke,
} as const satisfies Record<string, Case>;

export type AccessContractCase = keyof typeof accessContractCases;

export function runAccessContract(
  name: AccessContractCase,
  open: Open,
  wrap?: Wrap,
): Promise<void> {
  return accessContractCases[name](open, wrap);
}

export function describeAccessContract(label: string, open: Open): void {
  describe(`access contract: ${label}`, () => {
    for (const name of Object.keys(accessContractCases) as AccessContractCase[]) {
      it(name, () => runAccessContract(name, open), 120_000);
    }
  });
}

export { describeAccessRace, type OpenedRaceDatabase } from './access-race.js';
