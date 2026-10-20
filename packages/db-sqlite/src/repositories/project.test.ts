import type { IdempotencyRecord } from '@package-broker/core/api/idempotency';
import { auditEvent, type AuditAction } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
const call = {
  audit: {
    opId: '01K00000000000000000000001',
    requestId: '01K00000000000000000000002',
    sourceIp: null,
    tokenSelector: null,
  },
};
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  type AuthenticatedActor,
  type MutationFence,
} from '@package-broker/core/authz/fence';
import type { DefaultRoleKey } from '@package-broker/core/authz/permissions';
import type { ActorContext } from '@package-broker/core/authz/administration';
import type { ProjectActor } from '@package-broker/core/authz/project-actor';
import { createProjectService } from '@package-broker/core/authz/project-service';
import { fixedClock, isUlid } from '@package-broker/core/ids';
import { type OrgContext, type SqlExecutor, type Statement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createProjectRepository, ProjectSetupError, type ProjectRepository } from './project.js';
import { seedDefaultsStatements } from './role.js';

const NOW = '2026-10-15T12:00:00.000Z';
const LATER = '2026-10-15T13:00:00.000Z';

function uid(tag: string): string {
  return `01J${'0'.repeat(23 - tag.length)}${tag}`;
}

const U1 = uid('U1');
const U2 = uid('U2');
const UB = uid('UB');
const U3 = uid('U3');
const P1 = uid('P1');
const P2 = uid('P2');
const PB = uid('PB');
const S1 = uid('S1');
const S_FRESH = uid('S2');
const S_REVOKED = uid('S3');
const S_EXPIRED = uid('S4');
const S_OTHER = uid('S5');
const S_U3 = uid('S6');
const S_IDLE = uid('S7');

function roleIds(prefix: string): Record<DefaultRoleKey, string> {
  return {
    organization_admin: uid(`${prefix}RA`),
    organization_auditor: uid(`${prefix}RU`),
    project_owner: uid(`${prefix}RO`),
    project_developer: uid(`${prefix}RD`),
    project_auditor: uid(`${prefix}RX`),
  };
}

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let projects: ProjectRepository;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

async function rows(sql: string, ...params: Statement['params']): Promise<unknown[]> {
  return executor.all(stmt(sql, ...params));
}

async function snapshot(): Promise<string> {
  return JSON.stringify([
    await rows('SELECT * FROM project ORDER BY id'),
    await rows('SELECT * FROM access_grant ORDER BY id'),
    await rows('SELECT * FROM cache_epoch ORDER BY org_id'),
    await rows('SELECT * FROM access_mutation_guard'),
  ]);
}

function fence(expected: Record<string, number> = {}, userId = U1, sessionId = S1): MutationFence {
  return mutationFence({ userId, sessionId } as unknown as AuthenticatedActor, expected);
}

function create(
  overrides: Partial<Parameters<ProjectRepository['create']>[2]> = {},
  f = fence(),
  ctx = a,
  repository = projects,
) {
  return repository.create(ctx, f, {
    id: P1,
    slug: 'alpha',
    name: 'Alpha',
    now: NOW,
    audit: mutationAudit('project.create', overrides.id || P1, overrides.id || P1),
    ...overrides,
  });
}

const at = (offsetSeconds: number) =>
  `strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '${offsetSeconds} seconds')`;

async function seedSession(
  id: string,
  userId: string,
  orgId: string,
  options: {
    reauth?: number | null;
    revoked?: boolean;
    expires?: number;
    seen?: number;
    identityId?: string;
  } = {},
): Promise<void> {
  await rows(
    `INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at, last_seen_at, reauth_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ${at(options.seen ?? -60)}, ${at(options.expires ?? 3600)}, ${at(options.seen ?? -60)}, ${options.reauth === undefined || options.reauth === null ? 'NULL' : at(options.reauth)}, ${options.revoked === true ? at(-5) : 'NULL'})`,
    id,
    orgId,
    userId,
    options.identityId ?? null,
    id
      .toLowerCase()
      .padEnd(64, '0')
      .replace(/[^0-9a-f]/g, 'a')
      .slice(0, 64),
    `${id}`
      .toLowerCase()
      .padEnd(64, '1')
      .replace(/[^0-9a-f]/g, 'b')
      .slice(0, 64),
  );
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  projects = createProjectRepository(executor);
  await executor.batch([
    ...seedDefaultsStatements(a, { now: NOW, ids: roleIds('A') }),
    ...seedDefaultsStatements(b, { now: NOW, ids: roleIds('B') }),
    stmt(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      U1,
      a.orgId,
      'u1@example.test',
    ),
    stmt(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      U2,
      a.orgId,
      'u2@example.test',
    ),
    stmt(
      "INSERT INTO user_account (id, org_id, email, status) VALUES (?, ?, ?, 'suspended')",
      U3,
      a.orgId,
      'u3@example.test',
    ),
    stmt(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      UB,
      b.orgId,
      'b@example.test',
    ),
    stmt(
      "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
      uid('C1'),
      a.orgId,
    ),
    stmt(
      "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, 'pbkdf2-sha256$test', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours'))",
      U1,
      a.orgId,
      uid('C1'),
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', 'u1@example.test', 'organization', ?)",
      uid('G1'),
      a.orgId,
      roleIds('A').organization_admin,
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      PB,
      b.orgId,
      'beta',
      'Beta',
    ),
  ]);
  await seedSession(S1, U1, a.orgId);
  await seedSession(S_FRESH, U1, a.orgId, { reauth: -60 });
  await seedSession(S_REVOKED, U1, a.orgId, { revoked: true });
  await seedSession(S_EXPIRED, U1, a.orgId, { expires: -10 });
  await seedSession(S_IDLE, U1, a.orgId, { seen: -86400 });
  await seedSession(S_OTHER, U2, a.orgId);
  await seedSession(S_U3, U3, a.orgId);
});

afterEach(async () => {
  await database.close();
});

describe('create', () => {
  it('inserts the project and the creator owner grant in one batch, with a generated opId', async () => {
    expect(await create()).toBe('created');
    expect(await projects.get(a, P1)).toEqual({
      id: P1,
      slug: 'alpha',
      name: 'Alpha',
      status: 'active',
      tokenMaxScope: 'full',
      requirePublishApproval: false,
      revision: 1,
    });
    const [row] = (await rows('SELECT last_op_id FROM project WHERE id = ?', P1)) as {
      last_op_id: string;
    }[];
    expect(isUlid(row?.last_op_id ?? '')).toBe(true);
    expect(
      await rows(
        'SELECT subject_type, subject_value, scope, project_id, role_id, created_by FROM access_grant WHERE project_id = ?',
        P1,
      ),
    ).toEqual([
      {
        subject_type: 'email',
        subject_value: 'u1@example.test',
        scope: 'project',
        project_id: P1,
        role_id: roleIds('A').project_owner,
        created_by: U1,
      },
    ]);
  });

  it('honours the optional policy fields', async () => {
    await create({ tokenMaxScope: 'read', requirePublishApproval: true });
    expect(await projects.get(a, P1)).toMatchObject({
      tokenMaxScope: 'read',
      requirePublishApproval: true,
    });
  });

  it('refuses a duplicate slug with nothing written, epoch included', async () => {
    await create();
    const before = await snapshot();
    expect(await create({ id: P2 })).toBe('duplicate');
    expect(await snapshot()).toBe(before);
  });

  it('refuses a duplicate id with nothing written', async () => {
    await create();
    const before = await snapshot();
    expect(await create({ slug: 'other' })).toBe('duplicate');
    expect(await snapshot()).toBe(before);
  });

  it('allows a slug that exists only in another organization', async () => {
    expect(await create({ slug: 'beta' })).toBe('created');
  });

  it.each(['health', '_pb', 'auth', 'login', 'setup', 'callback', '.well-known'])(
    'refuses the reserved first segment %j',
    async (slug) => {
      const before = await snapshot();
      expect(await create({ slug })).toBe(
        slug.startsWith('.') || slug.startsWith('_') ? 'invalid_slug' : 'reserved_slug',
      );
      expect(await snapshot()).toBe(before);
    },
  );

  it.each(['Alpha', 'a_b', '-a', 'a-', '', 'a'.repeat(65), 'a/b', '..'])(
    'refuses the invalid slug %j',
    async (slug) => {
      const before = await snapshot();
      expect(await create({ slug })).toBe('invalid_slug');
      expect(await snapshot()).toBe(before);
    },
  );

  it('honours extra reserved slugs', async () => {
    const extra = createProjectRepository(executor, { reservedSlugs: ['billing'] });
    expect(await create({ slug: 'billing' }, fence(), a, extra)).toBe('reserved_slug');
  });

  it('throws TypeError for malformed input and a non-ULID id', async () => {
    await expect(create({ name: '' })).rejects.toThrow(TypeError);
    await expect(create({ name: 'x'.repeat(101) })).rejects.toThrow(TypeError);
    await expect(create({ name: 'a\u0000b' })).rejects.toThrow(TypeError);
    await expect(create({ now: 'yesterday' })).rejects.toThrow(TypeError);
    await expect(create({ id: '' })).rejects.toThrow(TypeError);
    await expect(create({ id: 'not-a-ulid' })).rejects.toThrow(TypeError);
  });

  it('bumps the epoch of that organization only', async () => {
    const before = (await rows('SELECT * FROM cache_epoch')) as {
      org_id: string;
      version: string;
    }[];
    await create();
    const after = (await rows('SELECT * FROM cache_epoch')) as {
      org_id: string;
      version: string;
    }[];
    const pick = (list: typeof before, id: string) => list.find((r) => r.org_id === id)?.version;
    expect(pick(after, a.orgId)).not.toBe(pick(before, a.orgId));
    expect(pick(after, b.orgId)).toBe(pick(before, b.orgId));
  });

  it('refuses a user without org:projects:create and writes nothing, grant included', async () => {
    const before = await snapshot();
    expect(await create({}, fence({}, U2, S_OTHER))).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('refuses a suspended actor', async () => {
    const before = await snapshot();
    expect(await create({}, fence({}, U3, S_U3))).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it.each([
    ['revoked', S_REVOKED],
    ['expired', S_EXPIRED],
    ['idle', S_IDLE],
    ['unknown', uid('S9')],
    ['owned by another user', S_OTHER],
  ])('refuses a %s session', async (_label, session) => {
    const before = await snapshot();
    expect(await create({}, fence({}, U1, session))).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('refuses an actor of another organization (context mismatch)', async () => {
    const before = await snapshot();
    expect(await create({}, fence(), b)).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('fails without a trace when the organization has no project_owner role', async () => {
    await rows('DELETE FROM role_permission WHERE role_id = ?', roleIds('A').project_owner);
    await rows('DELETE FROM role WHERE id = ?', roleIds('A').project_owner);
    const before = await snapshot();
    await expect(create()).rejects.toThrow();
    expect(await snapshot()).toBe(before);
  });

  it('throws when the organization has no cache_epoch row', async () => {
    await rows('DELETE FROM cache_epoch WHERE org_id = ?', a.orgId);
    await expect(create()).rejects.toThrow(/cache_epoch/);
    expect(await rows('SELECT id FROM project WHERE org_id = ?', a.orgId)).toEqual([]);
  });
});

describe('reads', () => {
  beforeEach(async () => {
    await create();
    await create({ id: P2, slug: 'gamma', name: 'Gamma' });
  });

  it('is organization scoped', async () => {
    expect(await projects.get(a, PB)).toBeNull();
    expect(await projects.get(b, P1)).toBeNull();
    expect(await projects.getBySlug(a, 'beta')).toBeNull();
    expect(await projects.getBySlug(a, 'alpha')).toMatchObject({ id: P1 });
    expect(await projects.getBySlug(b, 'beta')).toMatchObject({ id: PB });
  });

  it('getBySlug returns archived projects unless activeOnly is set', async () => {
    await projects.archive(a, fence({ project: 1 }), {
      audit: mutationAudit('project.archive', P1),
      id: P1,
      now: LATER,
    });
    expect(await projects.getBySlug(a, 'alpha')).toMatchObject({ status: 'archived' });
    expect(await projects.getBySlug(a, 'alpha', { activeOnly: true })).toBeNull();
    expect(await projects.getBySlug(a, 'gamma', { activeOnly: true })).toMatchObject({ id: P2 });
  });

  it('lists by id with a bounded page and status filter', async () => {
    expect((await projects.list(a, { limit: 1 })).map((p) => p.id)).toEqual([P1]);
    expect((await projects.list(a, { afterId: P1, limit: 10 })).map((p) => p.id)).toEqual([P2]);
    await projects.archive(a, fence({ project: 1 }), {
      audit: mutationAudit('project.archive', P1),
      id: P1,
      now: LATER,
    });
    expect((await projects.list(a, { limit: 10, status: 'active' })).map((p) => p.id)).toEqual([
      P2,
    ]);
    await expect(projects.list(a, { limit: 0 })).rejects.toThrow(TypeError);
    await expect(projects.list(a, { limit: 201 })).rejects.toThrow(TypeError);
  });
});

describe('update', () => {
  beforeEach(async () => {
    await create();
  });

  const update = (
    expected: number | null,
    changes: Parameters<ProjectRepository['update']>[2]['changes'],
    f?: MutationFence,
    id = P1,
  ) =>
    projects.update(a, f ?? fence(expected === null ? {} : { project: expected }), {
      audit: mutationAudit('project.update', id),
      id: id,
      changes: changes,
      now: LATER,
    });

  it('increments the revision exactly once and records a fresh opId', async () => {
    expect(
      await update(1, { name: 'Renamed', tokenMaxScope: 'write', requirePublishApproval: true }),
    ).toBe('updated');
    expect(await projects.get(a, P1)).toMatchObject({
      name: 'Renamed',
      tokenMaxScope: 'write',
      requirePublishApproval: true,
      revision: 2,
      slug: 'alpha',
    });
    const [row] = (await rows('SELECT last_op_id, updated_at FROM project WHERE id = ?', P1)) as {
      last_op_id: string;
      updated_at: string;
    }[];
    expect(isUlid(row?.last_op_id ?? '')).toBe(true);
    expect(row?.updated_at).toBe(LATER);
  });

  it('answers conflict for a stale or future revision and changes nothing', async () => {
    await update(1, { name: 'One' });
    const before = await snapshot();
    expect(await update(1, { name: 'Two' })).toBe('conflict');
    expect(await update(9, { name: 'Two' })).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('answers unchanged without any write, epoch included', async () => {
    const before = await snapshot();
    expect(await update(1, { name: 'Alpha' })).toBe('unchanged');
    expect(await update(1, {})).toBe('unchanged');
    expect(await snapshot()).toBe(before);
  });

  it('requires an expected project revision in the fence', async () => {
    await expect(update(null, { name: 'x' })).rejects.toThrow(TypeError);
  });

  it('refuses without project:settings:write, a revoked session or a suspended actor', async () => {
    const before = await snapshot();
    expect(await update(1, { name: 'x' }, fence({ project: 1 }, U2, S_OTHER))).toBe('authority');
    expect(await update(1, { name: 'x' }, fence({ project: 1 }, U1, S_REVOKED))).toBe('authority');
    expect(await update(1, { name: 'x' }, fence({ project: 1 }, U3, S_U3))).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('answers not_found for an unknown id or one of another organization', async () => {
    expect(await update(1, { name: 'x' }, undefined, uid('ZZ'))).toBe('not_found');
    expect(await update(1, { name: 'x' }, undefined, PB)).toBe('not_found');
    expect(await rows('SELECT name FROM project WHERE id = ?', PB)).toEqual([{ name: 'Beta' }]);
  });

  it('refuses an archived project and rolls the batch back', async () => {
    await projects.archive(a, fence({ project: 1 }), {
      audit: mutationAudit('project.archive', P1),
      id: P1,
      now: LATER,
    });
    const before = await snapshot();
    expect(await update(2, { name: 'x' })).toBe('archived');
    expect(await snapshot()).toBe(before);
  });

  it('rejects an invalid name or scope before SQL', async () => {
    await expect(update(1, { name: '' })).rejects.toThrow(TypeError);
    await expect(update(1, { tokenMaxScope: 'root' as unknown as 'full' })).rejects.toThrow(
      TypeError,
    );
  });

  it('never changes the slug', async () => {
    await update(1, { slug: 'hacked' } as never);
    expect(await projects.get(a, P1)).toMatchObject({ slug: 'alpha' });
  });
});

describe('archive and restore', () => {
  beforeEach(async () => {
    await create();
  });

  const archive = (expected: number, f = fence({ project: expected }), id = P1) =>
    projects.archive(a, f, { audit: mutationAudit('project.archive', id), id: id, now: LATER });
  const restore = (expected: number, session = S_FRESH, id = P1, user = U1) =>
    projects.restore(a, fence({ project: expected }, user, session), {
      audit: mutationAudit('project.restore', id),
      id: id,
      now: LATER,
    });

  it('keeps the row and its slug, bumps the revision once', async () => {
    expect(await archive(1)).toBe('archived');
    expect(await projects.get(a, P1)).toMatchObject({
      status: 'archived',
      revision: 2,
      slug: 'alpha',
    });
    expect(await rows('SELECT id FROM project WHERE org_id = ?', a.orgId)).toHaveLength(1);
  });

  it('keeps the slug reserved: a new project cannot take it', async () => {
    await archive(1);
    expect(await create({ id: P2 })).toBe('duplicate');
  });

  it('restores under the same CAS rules and with fresh reauth', async () => {
    await archive(1);
    expect(await restore(1)).toBe('conflict');
    expect(await projects.get(a, P1)).toMatchObject({ status: 'archived', revision: 2 });
    expect(await restore(2)).toBe('restored');
    expect(await projects.get(a, P1)).toMatchObject({ status: 'active', revision: 3 });
  });

  it('refuses restore without recent reauth and changes nothing', async () => {
    await archive(1);
    const before = await snapshot();
    expect(await restore(2, S1)).toBe('reauth_required');
    await rows(`UPDATE session SET reauth_at = ${at(-601)} WHERE id = ?`, S_FRESH);
    expect(await restore(2)).toBe('reauth_required');
    expect(await snapshot()).toBe(before);
  });

  it('keeps authority for a restore the actor could not make with any reauth', async () => {
    await archive(1);
    const before = await snapshot();
    expect(await restore(2, S_OTHER, P1, U2)).toBe('authority');
    expect(await restore(2, S_REVOKED, P1, U1)).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('answers conflict for a stale archive and changes nothing', async () => {
    const before = await snapshot();
    expect(await archive(9)).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('refuses a status mismatch with nothing written, epoch included', async () => {
    const active = await snapshot();
    expect(await restore(1)).toBe('not_archived');
    expect(await snapshot()).toBe(active);
    await archive(1);
    const archived = await snapshot();
    expect(await archive(2)).toBe('not_active');
    expect(await snapshot()).toBe(archived);
  });

  it('a refused actor changes nothing for archive and restore', async () => {
    const before = await snapshot();
    expect(await archive(1, fence({ project: 1 }, U2, S_OTHER))).toBe('authority');
    expect(await archive(1, fence({ project: 1 }, U1, S_REVOKED))).toBe('authority');
    expect(await snapshot()).toBe(before);
    await archive(1);
    const archived = await snapshot();
    expect(await restore(2, S_OTHER, P1, U2)).toBe('authority');
    expect(await snapshot()).toBe(archived);
  });

  it('answers not_found across organizations', async () => {
    expect(await archive(1, fence({ project: 1 }), PB)).toBe('not_found');
    expect(await restore(1, S_FRESH, PB)).toBe('not_found');
    expect(await rows('SELECT status FROM project WHERE id = ?', PB)).toEqual([
      { status: 'active' },
    ]);
  });
});

describe('initial role and identity-backed actors', () => {
  const U4 = uid('U4');
  const I4 = uid('I4');
  const S4 = uid('S8');
  const R_CREATE = uid('RC');
  const R_BOTH = uid('RB');
  const R_NARROW = uid('RN');
  const R_ORG = uid('RG');
  const OIDC = {
    provider: 'oidc',
    anchor: 'https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  };
  let sso: ProjectRepository;

  async function role(id: string, key: string, scope: string, permissions: string[]) {
    await executor.batch([
      stmt(
        'INSERT INTO role (id, org_id, key, name, scope, is_system, protects_last_holder) VALUES (?, ?, ?, ?, ?, 0, 0)',
        id,
        a.orgId,
        key,
        key,
        scope,
      ),
      ...permissions.map((permission) =>
        stmt(
          'INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, ?, ?)',
          a.orgId,
          id,
          permission,
        ),
      ),
    ]);
  }

  async function giveU4(roleId: string) {
    await rows('DELETE FROM access_grant WHERE id = ?', uid('G4'));
    await rows(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', 'u4@example.test', 'organization', ?)",
      uid('G4'),
      a.orgId,
      roleId,
    );
  }

  beforeEach(async () => {
    sso = createProjectRepository(executor, { providerAnchors: [OIDC] });
    await rows(
      'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
      a.orgId,
      OIDC.provider,
      OIDC.anchor,
    );
    await rows(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      U4,
      a.orgId,
      'u4@example.test',
    );
    await rows(
      `INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, 'oidc', 'sub-u4', 'u4@example.test', 1, ${at(-3600)})`,
      I4,
      a.orgId,
      U4,
    );
    await role(R_CREATE, 'creator', 'organization', ['org:projects:create']);
    await role(R_BOTH, 'creator-read', 'organization', ['org:projects:create', 'project:read']);
    await role(R_NARROW, 'narrow', 'project', ['project:read']);
    await role(R_ORG, 'orgish', 'organization', ['org:read']);
    await seedSession(S4, U4, a.orgId, { identityId: I4 });
  });

  const createAs = (overrides: Partial<Parameters<ProjectRepository['create']>[2]> = {}) =>
    create(overrides, fence({}, U4, S4), a, sso);

  it('gives an organization admin the stored project_owner role by default', async () => {
    expect(await create()).toBe('created');
    expect(await rows('SELECT role_id FROM access_grant WHERE project_id = ?', P1)).toEqual([
      { role_id: roleIds('A').project_owner },
    ]);
  });

  it('refuses project_owner for a creator who lacks its permissions, writing nothing', async () => {
    await giveU4(R_CREATE);
    const before = await snapshot();
    expect(await createAs()).toBe('initial_role_not_allowed');
    expect(await snapshot()).toBe(before);
  });

  it('accepts a narrower project role the creator fully holds', async () => {
    await giveU4(R_BOTH);
    expect(await createAs({ initialRoleId: R_NARROW })).toBe('created');
    expect(
      await rows('SELECT role_id, subject_value FROM access_grant WHERE project_id = ?', P1),
    ).toEqual([{ role_id: R_NARROW, subject_value: 'u4@example.test' }]);
  });

  it('refuses an initial role the creator only partly holds', async () => {
    await giveU4(R_CREATE);
    const before = await snapshot();
    expect(await createAs({ initialRoleId: R_NARROW })).toBe('initial_role_not_allowed');
    expect(await snapshot()).toBe(before);
  });

  it('refuses an organization-scoped, unknown or foreign initial role', async () => {
    await giveU4(R_BOTH);
    const before = await snapshot();
    expect(await createAs({ initialRoleId: R_ORG })).toBe('initial_role_not_allowed');
    expect(await createAs({ initialRoleId: uid('ZZ') })).toBe('initial_role_not_allowed');
    await rows(
      "INSERT INTO role (id, org_id, key, name, scope, is_system, protects_last_holder) VALUES (?, ?, 'foreign', 'foreign', 'project', 0, 0)",
      uid('RF'),
      b.orgId,
    );
    expect(await createAs({ initialRoleId: uid('RF') })).toBe('initial_role_not_allowed');
    expect(await snapshot()).toBe(before);
  });

  it('refuses a session whose identity belongs to another user', async () => {
    await seedSession(uid('SA'), U1, a.orgId, { identityId: I4 });
    const before = await snapshot();
    expect(await create({}, fence({}, U1, uid('SA')))).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('refuses a session whose identity row is gone', async () => {
    await rows('PRAGMA foreign_keys = OFF');
    await rows('DELETE FROM identity WHERE id = ?', I4);
    await giveU4(R_BOTH);
    const before = await snapshot();
    expect(await createAs({ initialRoleId: R_NARROW })).toBe('authority');
    expect(await snapshot()).toBe(before);
  });
});

describe('construction and setup faults', () => {
  it.each([59, 86401, 1.5, Number.NaN])('rejects idleSeconds %s', (idleSeconds) => {
    expect(() => createProjectRepository(executor, { idleSeconds })).toThrow(RangeError);
  });

  it('throws a typed error when the organization has no project_owner role', async () => {
    await rows('DELETE FROM role_permission WHERE role_id = ?', roleIds('A').project_owner);
    await rows('DELETE FROM role WHERE id = ?', roleIds('A').project_owner);
    await expect(create()).rejects.toBeInstanceOf(ProjectSetupError);
  });

  it('answers authority, not a setup error, for an unknown creator', async () => {
    expect(await create({}, fence({}, uid('UX'), S1))).toBe('authority');
  });
});

describe('update shortcuts', () => {
  beforeEach(async () => {
    await create();
    await projects.update(a, fence({ project: 1 }), {
      audit: mutationAudit('project.update', P1),
      id: P1,
      changes: { name: 'Two' },
      now: LATER,
    });
  });

  it('answers conflict for a stale revision even when the values are identical', async () => {
    const before = await snapshot();
    expect(
      await projects.update(a, fence({ project: 1 }), {
        audit: mutationAudit('project.update', P1),
        id: P1,
        changes: { name: 'Two' },
        now: LATER,
      }),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('does not leak unchanged to an actor without the permission', async () => {
    expect(
      await projects.update(a, fence({ project: 2 }, U2, S_OTHER), {
        audit: mutationAudit('project.update', P1),
        id: P1,
        changes: { name: 'Two' },
        now: LATER,
      }),
    ).toBe('authority');
    expect(
      await projects.update(a, fence({ project: 2 }, U1, S_REVOKED), {
        audit: mutationAudit('project.update', P1),
        id: P1,
        changes: { name: 'Two' },
        now: LATER,
      }),
    ).toBe('authority');
    expect(
      await projects.update(a, fence({ project: 2 }), {
        audit: mutationAudit('project.update', P1),
        id: P1,
        changes: { name: 'Two' },
        now: LATER,
      }),
    ).toBe('unchanged');
  });
});

describe('concurrency', () => {
  it('lets exactly one of two connections win the same revision', async () => {
    await database.close();
    const { mkdtemp, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'pb-project-'));
    try {
      database = await openMigratedDatabase({
        twoOrganizations: true,
        file: join(directory, 'race.sqlite'),
      });
      ({ a, b } =
        database.orgs ??
        (() => {
          throw new Error('orgs');
        })());
      executor = database.executor;
      projects = createProjectRepository(executor);
      await executor.batch([
        ...seedDefaultsStatements(a, { now: NOW, ids: roleIds('A') }),
        stmt(
          'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
          U1,
          a.orgId,
          'u1@example.test',
        ),
        stmt(
          "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'totp', x'00', x'000000000000000000000000', 1, 'test')",
          uid('C1'),
          a.orgId,
        ),
        stmt(
          "INSERT INTO local_login (user_id, org_id, password_hash, totp_credential_id, totp_enabled_at) VALUES (?, ?, 'pbkdf2-sha256$test', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hours'))",
          U1,
          a.orgId,
          uid('C1'),
        ),
        stmt(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES (?, ?, 'email', 'u1@example.test', 'organization', ?)",
          uid('G1'),
          a.orgId,
          roleIds('A').organization_admin,
        ),
      ]);
      await seedSession(S1, U1, a.orgId);
      expect(await create()).toBe('created');
      const other = createProjectRepository(await database.second());
      const results = await Promise.all([
        projects.update(a, fence({ project: 1 }), {
          audit: mutationAudit('project.update', P1),
          id: P1,
          changes: { name: 'One' },
          now: LATER,
        }),
        other.update(a, fence({ project: 1 }), {
          audit: mutationAudit('project.update', P1),
          id: P1,
          changes: { name: 'Two' },
          now: LATER,
        }),
      ]);
      expect([...results].sort()).toEqual(['conflict', 'updated']);
      expect(await projects.get(a, P1)).toMatchObject({ revision: 2 });
    } finally {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('authority before existence', () => {
  const MISSING = uid('ZZ');
  const refused = () => fence({}, U2, S_OTHER);
  const withRevision = (f: MutationFence, project: number) =>
    mutationFence({ userId: f.userId, sessionId: f.sessionId } as unknown as AuthenticatedActor, {
      project,
    });
  const methods = {
    update: (f: MutationFence, id: string) =>
      projects.update(a, f, {
        audit: mutationAudit('project.update', id),
        id: id,
        changes: { name: 'Renamed' },
        now: LATER,
      }),
    archive: (f: MutationFence, id: string) =>
      projects.archive(a, f, { audit: mutationAudit('project.archive', id), id: id, now: LATER }),
    restore: (f: MutationFence, id: string) =>
      projects.restore(a, f, { audit: mutationAudit('project.restore', id), id: id, now: LATER }),
  } as const;
  const current = { update: 1, archive: 1, restore: 2 } as const;
  const permitted = { update: fence(), archive: fence(), restore: fence({}, U1, S_FRESH) };

  beforeEach(async () => {
    await create();
  });

  async function prepare(method: keyof typeof methods): Promise<void> {
    if (method === 'restore') {
      expect(
        await projects.archive(a, fence({ project: 1 }), {
          audit: mutationAudit('project.archive', P1),
          id: P1,
          now: LATER,
        }),
      ).toBe('archived');
    }
  }

  const cases = (['update', 'archive', 'restore'] as const).flatMap((method) => [
    { method, row: 'an existing id', id: () => P1, revision: current[method] },
    { method, row: 'a missing id', id: () => MISSING, revision: current[method] },
    { method, row: 'another organization id', id: () => PB, revision: current[method] },
    { method, row: 'a stale revision', id: () => P1, revision: 9 },
  ]);

  it.each(cases)(
    '$method answers authority for $row to an actor without the permission',
    async ({ method, id, revision }) => {
      await prepare(method);
      const before = await snapshot();
      expect(await methods[method](withRevision(refused(), revision), id())).toBe('authority');
      expect(await snapshot()).toBe(before);
    },
  );

  it.each(['update', 'archive', 'restore'] as const)(
    '%s answers authority to a revoked session for a missing id and a stale revision',
    async (method) => {
      await prepare(method);
      const revoked = fence({}, U1, S_REVOKED);
      expect(await methods[method](withRevision(revoked, current[method]), MISSING)).toBe(
        'authority',
      );
      expect(await methods[method](withRevision(revoked, 9), P1)).toBe('authority');
    },
  );

  it.each(['update', 'archive', 'restore'] as const)(
    '%s still answers not_found and conflict to a permitted actor',
    async (method) => {
      await prepare(method);
      const f = permitted[method];
      expect(await methods[method](withRevision(f, current[method]), MISSING)).toBe('not_found');
      expect(await methods[method](withRevision(f, current[method]), PB)).toBe('not_found');
      expect(await methods[method](withRevision(f, 9), P1)).toBe('conflict');
    },
  );

  it('restore answers reauth_required without a fresh reauth even for a missing id', async () => {
    await prepare('restore');
    expect(await methods.restore(fence({ project: 2 }, U1, S1), MISSING)).toBe('reauth_required');
  });

  it.each([
    { method: 'update', id: () => P1, revision: 1, result: 'updated', all: 1, batch: 1 },
    { method: 'update', id: () => MISSING, revision: 1, result: 'not_found', all: 1, batch: 0 },
    { method: 'update', id: () => P1, revision: 9, result: 'conflict', all: 1, batch: 0 },
    { method: 'archive', id: () => P1, revision: 1, result: 'archived', all: 1, batch: 1 },
    { method: 'archive', id: () => MISSING, revision: 1, result: 'not_found', all: 1, batch: 0 },
    { method: 'archive', id: () => P1, revision: 9, result: 'conflict', all: 4, batch: 1 },
    { method: 'restore', id: () => P1, revision: 2, result: 'restored', all: 1, batch: 1 },
    { method: 'restore', id: () => MISSING, revision: 2, result: 'not_found', all: 1, batch: 0 },
    { method: 'restore', id: () => P1, revision: 9, result: 'conflict', all: 4, batch: 1 },
  ] as const)(
    '$method answers $result with $all reads and $batch batches',
    async ({ method, id, revision, result, all, batch }) => {
      await prepare(method);
      const counted = countCalls(executor);
      const repository = createProjectRepository(counted.executor);
      const f = withRevision(permitted[method], revision);
      const call = {
        update: () =>
          repository.update(a, f, {
            audit: mutationAudit('project.update', id()),
            id: id(),
            changes: { name: 'Renamed' },
            now: LATER,
          }),
        archive: () =>
          repository.archive(a, f, {
            audit: mutationAudit('project.archive', id()),
            id: id(),
            now: LATER,
          }),
        restore: () =>
          repository.restore(a, f, {
            audit: mutationAudit('project.restore', id()),
            id: id(),
            now: LATER,
          }),
      }[method];
      expect(await call()).toBe(result);
      expect(counted.counts()).toEqual({ all, batch });
    },
  );

  it('answers a refused actor without a batch', async () => {
    const counted = countCalls(executor);
    const repository = createProjectRepository(counted.executor);
    expect(
      await repository.archive(a, withRevision(refused(), 1), {
        audit: mutationAudit('project.archive', MISSING),
        id: MISSING,
        now: LATER,
      }),
    ).toBe('authority');
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
  });

  it('answers unchanged with a single read', async () => {
    const counted = countCalls(executor);
    const repository = createProjectRepository(counted.executor);
    expect(
      await repository.update(a, fence({ project: 1 }), {
        audit: mutationAudit('project.update', P1),
        id: P1,
        changes: { name: 'Alpha' },
        now: LATER,
      }),
    ).toBe('unchanged');
    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
  });
});

describe('refusal through the project service', () => {
  const MISSING = uid('ZZ');
  const staleContext: ActorContext = {
    kind: 'organization',
    userId: U2,
    permissions: new Set(['org:projects:archive']),
    isOrganizationAdmin: false,
  };
  const projectContext = (id: string): ProjectActor => ({
    kind: 'project',
    userId: U2,
    orgId: a.orgId,
    projectId: id,
    permissions: new Set(['project:settings:write']),
  });
  const service = () =>
    createProjectService({
      projects,
      clock: fixedClock(LATER),
      ids: { ulid: () => P2 },
      log: () => undefined,
    });
  const calls = {
    update: (id: string, revision: number) =>
      service().updateSettings(
        a,
        projectContext(id),
        fence({ project: revision }, U2, S_OTHER),
        id,
        {
          name: 'Renamed',
        },
        call,
      ),
    archive: (id: string, revision: number) =>
      service().archiveProject(
        a,
        staleContext,
        fence({ project: revision }, U2, S_OTHER),
        id,
        call,
      ),
    restore: (id: string, revision: number) =>
      service().restoreProject(
        a,
        staleContext,
        fence({ project: revision }, U2, S_OTHER),
        id,
        call,
      ),
  } as const;
  const current = { update: 1, archive: 1, restore: 2 } as const;

  beforeEach(async () => {
    await create();
  });

  it.each(['update', 'archive', 'restore'] as const)(
    '%s refuses identically for an existing id, a missing id and a stale revision',
    async (method) => {
      if (method === 'restore') {
        expect(
          await projects.archive(a, fence({ project: 1 }), {
            audit: mutationAudit('project.archive', P1),
            id: P1,
            now: LATER,
          }),
        ).toBe('archived');
      }
      const before = await snapshot();
      const results = [
        await calls[method](P1, current[method]),
        await calls[method](MISSING, current[method]),
        await calls[method](PB, current[method]),
        await calls[method](P1, 9),
      ];
      expect(results).toEqual(Array(4).fill({ ok: false, error: 'forbidden' }));
      expect(await snapshot()).toBe(before);
    },
  );
});

describe('authority read parameter budget', () => {
  it.each(['update', 'archive', 'restore'] as const)(
    'binds at most 100 parameters for %s with 8 provider anchors',
    async (method) => {
      const statements: Statement[] = [];
      const recording = new Proxy(executor, {
        get(target, property, receiver) {
          if (property === 'all') {
            return async (statement: Statement) => {
              statements.push(statement);
              return target.all(statement);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const providerAnchors = Array.from({ length: 8 }, (_, index) => ({
        provider: 'oidc',
        anchor: `https://idp-${index}.example.test`,
        emailAuthoritative: true,
        emailAuthoritativeDomains: ['example.test'],
      }));
      const repository = createProjectRepository(recording, { providerAnchors });
      const f = fence({ project: 1 }, U2, S_OTHER);
      const answer = {
        update: () =>
          repository.update(a, f, {
            audit: mutationAudit('project.update', uid('ZZ')),
            id: uid('ZZ'),
            changes: { name: 'Renamed' },
            now: LATER,
          }),
        archive: () =>
          repository.archive(a, f, {
            audit: mutationAudit('project.archive', uid('ZZ')),
            id: uid('ZZ'),
            now: LATER,
          }),
        restore: () =>
          repository.restore(a, f, {
            audit: mutationAudit('project.restore', uid('ZZ')),
            id: uid('ZZ'),
            now: LATER,
          }),
      }[method];
      expect(await answer()).toBe('authority');
      expect(statements).toHaveLength(1);
      const [read] = statements;
      expect(read?.sql).toMatch(/left join "project" as "p"/);
      expect(read?.params.length).toBeLessThanOrEqual(100);
      expect(JSON.stringify(read?.params)).toContain('idp-7.example.test');
    },
  );
});

function mutationAudit(action: AuditAction, targetId: string, projectId = P1) {
  const id = ulid();
  const result = auditEvent({
    id,
    now: NOW,
    action,
    actor: { type: 'system', id: null },
    context: { opId: id, requestId: id, sourceIp: null, tokenSelector: null },
    target: { type: action.split('.')[0]!, id: targetId },
    projectId,
  });
  if (!result.ok) throw new Error('Invalid test audit event');
  return result.event;
}

function record(): IdempotencyRecord {
  return {
    principalKey: 'user:actor',
    key: 'project-request',
    route: '/projects',
    requestHash: 'a'.repeat(64),
    status: 200,
    responseJson: '{"ok":true}',
    createdAt: NOW,
    expiresAt: '2999-01-01T00:00:00.000Z',
  };
}

describe('project mutation audit and idempotency', () => {
  const cases = [
    ['create', 'project.create', 'created'],
    ['update', 'project.update', 'updated'],
    ['archive', 'project.archive', 'archived'],
    ['restore', 'project.restore', 'restored'],
  ] as const;
  type Method = (typeof cases)[number][0];

  async function prepare(method: Method) {
    if (method !== 'create') await create();
    if (method === 'restore') {
      await rows("UPDATE project SET status = 'archived' WHERE org_id = ? AND id = ?", a.orgId, P1);
    }
    await rows('DELETE FROM audit_pending WHERE org_id = ?', a.orgId);
  }

  function invoke(method: Method, action: AuditAction, idempotency?: IdempotencyRecord) {
    const input = {
      id: P1,
      now: LATER,
      audit: mutationAudit(action, P1),
      ...(idempotency === undefined ? {} : { idempotency }),
    };
    if (method === 'create') return create({ ...input });
    if (method === 'update')
      return projects.update(a, fence({ project: 1 }), { ...input, changes: { name: 'Renamed' } });
    return projects[method](a, fence({ project: 1 }, U1, S_FRESH), input);
  }

  for (const withIdempotency of [false, true]) {
    it.each(cases)(
      `%s persists one audit row (idempotency: ${withIdempotency})`,
      async (method, action, answer) => {
        await prepare(method);
        const audit = mutationAudit(action, P1);
        expect(await invoke(method, action, withIdempotency ? record() : undefined)).toBe(answer);
        expect(
          await rows(
            'SELECT org_id, action, target_type, target_id, project_id FROM audit_pending',
          ),
        ).toEqual([
          {
            org_id: a.orgId,
            action: audit.action,
            target_type: audit.target.type,
            target_id: P1,
            project_id: P1,
          },
        ]);
        expect(
          await rows(
            'SELECT principal_key AS principalKey, key, route, request_hash AS requestHash, status, response_json AS responseJson, created_at AS createdAt, expires_at AS expiresAt FROM api_idempotency',
          ),
        ).toEqual(withIdempotency ? [record()] : []);
      },
    );
  }

  it.each(cases)('%s rolls back a repeated idempotency key', async (method, action) => {
    await prepare(method);
    expect(await invoke(method, action, record())).not.toBe('conflict');
    if (method === 'create') {
      expect(
        await create({
          id: P2,
          slug: 'second',
          audit: mutationAudit(action, P2),
          idempotency: record(),
        }),
      ).toBe('conflict');
      expect(await projects.get(a, P2)).toBeNull();
    } else {
      const current = await projects.get(a, P1);
      const input = { id: P1, now: LATER, audit: mutationAudit(action, P1), idempotency: record() };
      const f = fence({ project: current!.revision }, U1, S_FRESH);
      if (method === 'update') {
        expect(await projects.update(a, f, { ...input, changes: { name: 'Again' } })).toBe(
          'conflict',
        );
      } else {
        await rows(
          'UPDATE project SET status = ? WHERE org_id = ? AND id = ?',
          method === 'archive' ? 'active' : 'archived',
          a.orgId,
          P1,
        );
        expect(await projects[method](a, f, input)).toBe('conflict');
      }
      expect((await projects.get(a, P1))?.revision).toBe(current!.revision);
    }
    expect(await rows('SELECT action FROM audit_pending')).toEqual([{ action }]);
    expect(await rows('SELECT key FROM api_idempotency')).toEqual([{ key: record().key }]);
  });

  it('authority refusal stores neither audit nor idempotency', async () => {
    expect(
      await create(
        {
          initialRoleId: uid('RN'),
          audit: mutationAudit('project.create', P1),
          idempotency: record(),
        },
        fence({}, U2, S_OTHER),
      ),
    ).toBe('authority');
    expect(await rows('SELECT id FROM audit_pending')).toEqual([]);
    expect(await rows('SELECT key FROM api_idempotency')).toEqual([]);
  });

  it('a stale revision stores neither audit nor idempotency', async () => {
    await prepare('update');
    expect(
      await projects.update(a, fence({ project: 2 }), {
        id: P1,
        changes: { name: 'Renamed' },
        now: LATER,
        audit: mutationAudit('project.update', P1),
        idempotency: record(),
      }),
    ).toBe('conflict');
    expect(await rows('SELECT id FROM audit_pending')).toEqual([]);
    expect(await rows('SELECT key FROM api_idempotency')).toEqual([]);
  });

  it('a duplicate slug stores neither audit nor idempotency', async () => {
    await prepare('update');
    expect(
      await create({ id: P2, audit: mutationAudit('project.create', P2), idempotency: record() }),
    ).toBe('duplicate');
    expect(await rows('SELECT id FROM audit_pending')).toEqual([]);
    expect(await rows('SELECT key FROM api_idempotency')).toEqual([]);
  });

  it('a duplicate slug stays duplicate with an expired record for the key', async () => {
    await prepare('update');
    await rows(
      `INSERT INTO api_idempotency (org_id, principal_key, key, route, request_hash, status, response_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 200, '{}', '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z')`,
      a.orgId,
      record().principalKey,
      record().key,
      record().route,
      'c'.repeat(64),
    );
    expect(
      await create({ id: P2, audit: mutationAudit('project.create', P2), idempotency: record() }),
    ).toBe('duplicate');
    expect(await rows('SELECT id FROM audit_pending')).toEqual([]);
  });

  it('an unchanged update writes nothing', async () => {
    await prepare('update');
    const before = await snapshot();
    expect(
      await projects.update(a, fence({ project: 1 }), {
        id: P1,
        changes: { name: 'Alpha' },
        now: LATER,
        audit: mutationAudit('project.update', P1),
        idempotency: record(),
      }),
    ).toBe('unchanged');
    expect(await snapshot()).toBe(before);
    expect(await rows('SELECT id FROM audit_pending')).toEqual([]);
    expect(await rows('SELECT key FROM api_idempotency')).toEqual([]);
  });

  it('a failing creator grant insert rolls back the project and audit', async () => {
    await rows(
      "CREATE TRIGGER refuse_creator_grant BEFORE INSERT ON access_grant WHEN NEW.scope = 'project' BEGIN SELECT RAISE(ABORT, 'injected'); END",
    );
    expect(
      await create({ audit: mutationAudit('project.create', P1), idempotency: record() }),
    ).toBe('indeterminate');
    expect(await projects.get(a, P1)).toBeNull();
    expect(await rows('SELECT id FROM audit_pending')).toEqual([]);
    expect(await rows('SELECT key FROM api_idempotency')).toEqual([]);
  });
});
