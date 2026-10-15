import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createLoginWriter, type LoginPlanWithAutoJoin } from './login.js';

const EVIDENCE = '2026-10-15T11:59:00.000Z';
const NOW = '2026-10-15T12:00:00.000Z';
const EXPIRES = '2026-10-16T00:00:00.000Z';
const OLD = '2026-10-14T08:00:00.000Z';
const PROVIDER = 'dex';
const OTHER_PROVIDER = 'access';
const ANCHOR = 'oidc:https://dex.example.test';
const SUBJECT = 'sub-1';

const USER_X = '01J0USERX0000000000000000X';
const USER_Y = '01J0USERY0000000000000000Y';
const USER_Z = '01J0USERZ0000000000000000Z';
const USER_NEW = '01J0USERN0000000000000000N';
const IDENTITY_X = '01J0IDENTX000000000000000X';
const IDENTITY_NEW = '01J0IDENTN000000000000000N';
const SESSION_NEW = '01J0SESSN000000000000000NN';
const SESSION_OLD = '01J0SESSO000000000000000OO';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

function hash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

const NEW_SECRET = hash('new-secret');
const OLD_SECRET = hash('old-secret');

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
});

afterEach(async () => {
  await database.close();
});

async function exec(statements: readonly Statement[]): Promise<void> {
  await executor.batch(statements);
}

async function rows<R = Record<string, unknown>>(sql: string, ...params: string[]): Promise<R[]> {
  return executor.all<R>({ sql, params });
}

function user(
  ctx: OrgContext,
  id: string,
  email: string,
  options: { name?: string | null; status?: string } = {},
): Statement {
  return {
    sql: 'INSERT INTO user_account (id, org_id, email, display_name, status, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
    params: [id, ctx.orgId, email, options.name ?? null, options.status ?? 'active', OLD],
  };
}

function identity(
  ctx: OrgContext,
  id: string,
  userId: string,
  options: { subject?: string; provider?: string; email?: string } = {},
): Statement {
  return {
    sql: 'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
    params: [
      id,
      ctx.orgId,
      userId,
      options.provider ?? PROVIDER,
      options.subject ?? SUBJECT,
      options.email ?? 'old@example.test',
      OLD,
    ],
  };
}

function binding(ctx: OrgContext, anchor: string, provider = PROVIDER): Statement {
  return {
    sql: 'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    params: [ctx.orgId, provider, anchor],
  };
}

function group(ctx: OrgContext, userId: string, provider: string, name: string): Statement {
  return {
    sql: 'INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, ?, ?, ?)',
    params: [ctx.orgId, userId, provider, name, OLD],
  };
}

function session(ctx: OrgContext, id: string, userId: string, secretHash: string): Statement {
  return {
    sql: 'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [id, ctx.orgId, userId, secretHash, hash('csrf'), OLD, EXPIRES],
  };
}

function plan(overrides: Partial<LoginPlanWithAutoJoin> = {}): LoginPlanWithAutoJoin {
  const userId = overrides.userId ?? USER_NEW;
  const identityId = overrides.identityId ?? IDENTITY_NEW;
  return {
    userId,
    createUser: true,
    autoJoin: true,
    email: 'ada@example.test',
    displayName: 'Ada',
    identityId,
    provider: PROVIDER,
    trustAnchor: ANCHOR,
    subject: SUBJECT,
    emailVerified: true,
    groups: ['admins', 'readers'],
    evidenceTime: EVIDENCE,
    session: {
      id: SESSION_NEW,
      userId,
      identityId,
      secretHash: NEW_SECRET,
      csrfHash: hash('new-csrf'),
      expiresAt: EXPIRES,
      ip: '203.0.113.7',
      userAgent: 'test-agent',
      now: NOW,
    },
    previousSecretHash: null,
    now: NOW,
    ...overrides,
  };
}

function returningPlan(overrides: Partial<LoginPlanWithAutoJoin> = {}): LoginPlanWithAutoJoin {
  return plan({
    userId: USER_X,
    createUser: false,
    identityId: IDENTITY_X,
    email: 'x@example.test',
    displayName: null,
    ...overrides,
  });
}

async function seedReturning(): Promise<void> {
  await exec([
    user(a, USER_X, 'x@example.test', { name: 'Old Name' }),
    identity(a, IDENTITY_X, USER_X, { email: 'x@example.test' }),
    binding(a, ANCHOR),
    group(a, USER_X, PROVIDER, 'old-group'),
    group(a, USER_X, PROVIDER, 'readers'),
    group(a, USER_X, OTHER_PROVIDER, 'access-group'),
    session(a, SESSION_OLD, USER_X, OLD_SECRET),
  ]);
}

async function snapshot(): Promise<Record<string, unknown[]>> {
  return {
    users: await rows('SELECT * FROM user_account ORDER BY id'),
    identities: await rows('SELECT * FROM identity ORDER BY id'),
    bindings: await rows('SELECT * FROM identity_provider_binding ORDER BY org_id, provider'),
    groups: await rows('SELECT * FROM user_group ORDER BY user_id, provider, group_name'),
    sessions: await rows('SELECT * FROM session ORDER BY id'),
  };
}

describe('createLoginWriter', () => {
  describe('new user', () => {
    it('creates binding, user, identity, groups and session in one batch', async () => {
      const counted = countCalls(executor);
      const result = await createLoginWriter(counted.executor).commit(a, plan());
      expect(result).toBe('created');
      expect(counted.counts()).toEqual({ all: 0, batch: 1 });

      expect(await rows('SELECT org_id, provider, anchor FROM identity_provider_binding')).toEqual([
        { org_id: a.orgId, provider: PROVIDER, anchor: ANCHOR },
      ]);
      expect(
        await rows(
          'SELECT id, org_id, email, display_name, status, last_login_at, idp_validated_at FROM user_account',
        ),
      ).toEqual([
        {
          id: USER_NEW,
          org_id: a.orgId,
          email: 'ada@example.test',
          display_name: 'Ada',
          status: 'active',
          last_login_at: NOW,
          idp_validated_at: null,
        },
      ]);
      expect(
        await rows(
          'SELECT id, org_id, user_id, provider, subject, email, email_verified, validated_at FROM identity',
        ),
      ).toEqual([
        {
          id: IDENTITY_NEW,
          org_id: a.orgId,
          user_id: USER_NEW,
          provider: PROVIDER,
          subject: SUBJECT,
          email: 'ada@example.test',
          email_verified: 1,
          validated_at: EVIDENCE,
        },
      ]);
      expect(
        await rows(
          'SELECT user_id, provider, group_name, refreshed_at FROM user_group ORDER BY group_name',
        ),
      ).toEqual([
        { user_id: USER_NEW, provider: PROVIDER, group_name: 'admins', refreshed_at: EVIDENCE },
        { user_id: USER_NEW, provider: PROVIDER, group_name: 'readers', refreshed_at: EVIDENCE },
      ]);
      expect(
        await rows(
          'SELECT id, user_id, identity_id, secret_hash, created_at, expires_at, revoked_at FROM session',
        ),
      ).toEqual([
        {
          id: SESSION_NEW,
          user_id: USER_NEW,
          identity_id: IDENTITY_NEW,
          secret_hash: NEW_SECRET,
          created_at: NOW,
          expires_at: EXPIRES,
          revoked_at: null,
        },
      ]);
    });

    it('stores email_verified as 0 for an unverified e-mail', async () => {
      expect(await createLoginWriter(executor).commit(a, plan({ emailVerified: false }))).toBe(
        'created',
      );
      expect(await rows('SELECT email_verified FROM identity')).toEqual([{ email_verified: 0 }]);
    });

    it('works with no groups', async () => {
      expect(await createLoginWriter(executor).commit(a, plan({ groups: [] }))).toBe('created');
      expect(await rows('SELECT * FROM user_group')).toEqual([]);
    });

    it('stores group names that look like JSON or SQL verbatim', async () => {
      const names = ['["x"]', "o'brien", 'a"b', 'ünï 🙂', 'a,b'];
      await createLoginWriter(executor).commit(a, plan({ groups: names }));
      const stored = await rows<{ group_name: string }>('SELECT group_name FROM user_group');
      expect(stored.map((row) => row.group_name).sort()).toEqual([...names].sort());
    });

    it('does not insert a second user when the plan creates one for an existing e-mail', async () => {
      await exec([user(a, USER_Z, 'ada@example.test')]);
      expect(await createLoginWriter(executor).commit(a, plan())).toBe('refused');
      expect(await rows('SELECT id FROM user_account')).toEqual([{ id: USER_Z }]);
    });
  });

  describe('returning user', () => {
    it('replaces the groups of this provider only and revokes the previous session', async () => {
      await seedReturning();
      const counted = countCalls(executor);
      const result = await createLoginWriter(counted.executor).commit(
        a,
        returningPlan({ groups: ['readers', 'writers'], previousSecretHash: OLD_SECRET }),
      );
      expect(result).toBe('created');
      expect(counted.counts()).toEqual({ all: 0, batch: 1 });

      expect(
        await rows('SELECT provider, group_name, refreshed_at FROM user_group ORDER BY 1, 2'),
      ).toEqual([
        { provider: OTHER_PROVIDER, group_name: 'access-group', refreshed_at: OLD },
        { provider: PROVIDER, group_name: 'readers', refreshed_at: EVIDENCE },
        { provider: PROVIDER, group_name: 'writers', refreshed_at: EVIDENCE },
      ]);
      expect(await rows('SELECT id, revoked_at FROM session ORDER BY id')).toEqual([
        { id: SESSION_NEW, revoked_at: null },
        { id: SESSION_OLD, revoked_at: NOW },
      ]);
    });

    it('updates the identity without changing its user, id or creation', async () => {
      await seedReturning();
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({ emailVerified: true, identityId: IDENTITY_X }),
      );
      expect(result).toBe('created');
      expect(
        await rows(
          'SELECT id, user_id, email, email_verified, validated_at, updated_at FROM identity',
        ),
      ).toEqual([
        {
          id: IDENTITY_X,
          user_id: USER_X,
          email: 'x@example.test',
          email_verified: 1,
          validated_at: EVIDENCE,
          updated_at: NOW,
        },
      ]);
    });

    it('sets user_account.last_login_at and keeps the display name when the plan has none', async () => {
      await seedReturning();
      await createLoginWriter(executor).commit(a, returningPlan({ identityId: IDENTITY_X }));
      expect(
        await rows('SELECT display_name, last_login_at, updated_at FROM user_account'),
      ).toEqual([{ display_name: 'Old Name', last_login_at: NOW, updated_at: NOW }]);
    });

    it('takes a new display name from the plan', async () => {
      await seedReturning();
      await createLoginWriter(executor).commit(
        a,
        returningPlan({ displayName: 'New Name', identityId: IDENTITY_X }),
      );
      expect(await rows('SELECT display_name FROM user_account')).toEqual([
        { display_name: 'New Name' },
      ]);
    });

    it('links an unknown identity to the existing user with the plan e-mail', async () => {
      await exec([user(a, USER_X, 'x@example.test'), binding(a, ANCHOR)]);
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({ identityId: IDENTITY_NEW }),
      );
      expect(result).toBe('created');
      expect(await rows('SELECT id, user_id FROM identity')).toEqual([
        { id: IDENTITY_NEW, user_id: USER_X },
      ]);
      expect(await rows('SELECT id, identity_id FROM session')).toEqual([
        { id: SESSION_NEW, identity_id: IDENTITY_NEW },
      ]);
    });

    it('leaves the previous session alone when none is named', async () => {
      await seedReturning();
      expect(
        await createLoginWriter(executor).commit(a, returningPlan({ identityId: IDENTITY_X })),
      ).toBe('created');
      expect(await rows('SELECT revoked_at FROM session WHERE id = ?', SESSION_OLD)).toEqual([
        { revoked_at: null },
      ]);
    });

    it('does not touch a user of another organization with the same identity key', async () => {
      await seedReturning();
      await exec([
        user(b, USER_Y, 'x@example.test', { name: 'Other' }),
        identity(b, '01J0IDENTB000000000000000B', USER_Y, { email: 'x@example.test' }),
        group(b, USER_Y, PROVIDER, 'b-group'),
      ]);
      expect(
        await createLoginWriter(executor).commit(a, returningPlan({ identityId: IDENTITY_X })),
      ).toBe('created');
      expect(
        await rows('SELECT user_id, group_name FROM user_group WHERE org_id = ?', b.orgId),
      ).toEqual([{ user_id: USER_Y, group_name: 'b-group' }]);
      expect(await rows('SELECT last_login_at FROM user_account WHERE id = ?', USER_Y)).toEqual([
        { last_login_at: OLD },
      ]);
    });
  });

  describe('identity owned by another user', () => {
    async function seedForeign(): Promise<void> {
      await exec([
        user(a, USER_X, 'x@example.test'),
        user(a, USER_Y, 'y@example.test', { name: 'Y' }),
        identity(a, IDENTITY_X, USER_X, { email: 'x@example.test' }),
        binding(a, ANCHOR),
        group(a, USER_Y, PROVIDER, 'y-old'),
        session(a, SESSION_OLD, USER_Y, OLD_SECRET),
      ]);
    }

    it('refuses an existing user whose plan names an identity owned by someone else', async () => {
      await seedForeign();
      const before = await snapshot();
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({
          userId: USER_Y,
          email: 'y@example.test',
          previousSecretHash: OLD_SECRET,
        }),
      );
      expect(result).toBe('refused');
      expect(await snapshot()).toEqual(before);
      expect(await rows('SELECT revoked_at FROM session WHERE id = ?', SESSION_OLD)).toEqual([
        { revoked_at: null },
      ]);
    });

    it('refuses and creates no user when the plan would create one for an owned identity', async () => {
      await seedForeign();
      const before = await snapshot();
      const result = await createLoginWriter(executor).commit(
        a,
        plan({ userId: USER_NEW, email: 'new@example.test', previousSecretHash: OLD_SECRET }),
      );
      expect(result).toBe('refused');
      expect(await snapshot()).toEqual(before);
    });

    it('writes nothing for a lost e-mail race and links nothing', async () => {
      await exec([user(a, USER_Z, 'ada@example.test'), binding(a, ANCHOR)]);
      const before = await snapshot();
      expect(await createLoginWriter(executor).commit(a, plan())).toBe('refused');
      expect(await snapshot()).toEqual(before);
    });

    it('writes nothing for a lost e-mail race against a suspended winner', async () => {
      await exec([
        user(a, USER_Z, 'ada@example.test', { status: 'suspended' }),
        binding(a, ANCHOR),
      ]);
      const before = await snapshot();
      expect(await createLoginWriter(executor).commit(a, plan())).toBe('refused');
      expect(await snapshot()).toEqual(before);
    });

    it('keeps one identity and one user for two first logins with different planned user ids', async () => {
      const writer = createLoginWriter(executor);
      expect(await writer.commit(a, plan())).toBe('created');
      const second = plan({
        userId: USER_Z,
        identityId: '01J0IDENTZ000000000000000Z',
        session: {
          ...plan().session,
          id: '01J0SESSZ000000000000000ZZ',
          userId: USER_Z,
          identityId: '01J0IDENTZ000000000000000Z',
          secretHash: hash('second-secret'),
        },
      });
      expect(await writer.commit(a, second)).toBe('refused');
      expect(await rows('SELECT id, user_id FROM identity')).toEqual([
        { id: IDENTITY_NEW, user_id: USER_NEW },
      ]);
      expect(await rows('SELECT id FROM user_account')).toEqual([{ id: USER_NEW }]);
      expect(await rows('SELECT id FROM session')).toEqual([{ id: SESSION_NEW }]);
    });

    it('keeps one identity and one user when the second plan carries another e-mail', async () => {
      const writer = createLoginWriter(executor);
      expect(await writer.commit(a, plan())).toBe('created');
      const identityZ = '01J0IDENTZ000000000000000Z';
      const second = plan({
        userId: USER_Z,
        email: 'other@example.test',
        identityId: identityZ,
        session: {
          ...plan().session,
          id: '01J0SESSZ000000000000000ZZ',
          userId: USER_Z,
          identityId: identityZ,
          secretHash: hash('second-secret'),
        },
      });
      expect(await writer.commit(a, second)).toBe('refused');
      expect(await rows('SELECT id FROM identity')).toEqual([{ id: IDENTITY_NEW }]);
      expect(await rows('SELECT id FROM user_account')).toEqual([{ id: USER_NEW }]);
    });
  });

  describe('stale plan', () => {
    it('refuses and writes nothing when the user e-mail changed since the lookup', async () => {
      await seedReturning();
      const before = await snapshot();
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({ identityId: IDENTITY_X, email: 'changed@example.test' }),
      );
      expect(result).toBe('refused');
      expect(await snapshot()).toEqual(before);
    });

    it('does not link an unknown identity to a user whose e-mail differs from the plan', async () => {
      await exec([user(a, USER_X, 'x@example.test'), binding(a, ANCHOR)]);
      const before = await snapshot();
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({ identityId: IDENTITY_NEW, email: 'moved@example.test' }),
      );
      expect(result).toBe('refused');
      expect(await snapshot()).toEqual(before);
    });

    it('refuses without any identity write when the planned identity id is not the stored one', async () => {
      await seedReturning();
      const before = await snapshot();
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({ identityId: IDENTITY_NEW, previousSecretHash: OLD_SECRET }),
      );
      expect(result).toBe('refused');
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('evidence time', () => {
    const NEWER = '2026-10-15T11:59:30.000Z';

    it('keeps newer stored evidence and groups but still logs the user in', async () => {
      await seedReturning();
      await exec([{ sql: 'UPDATE identity SET validated_at = ?', params: [NEWER] }]);
      const groupsBefore = await rows('SELECT * FROM user_group ORDER BY 1, 2, 3, 4');
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({
          identityId: IDENTITY_X,
          groups: ['stale-group'],
          previousSecretHash: OLD_SECRET,
        }),
      );
      expect(result).toBe('created');
      expect(await rows('SELECT email, validated_at FROM identity')).toEqual([
        { email: 'x@example.test', validated_at: NEWER },
      ]);
      expect(await rows('SELECT * FROM user_group ORDER BY 1, 2, 3, 4')).toEqual(groupsBefore);
      expect(await rows('SELECT id, revoked_at FROM session ORDER BY id')).toEqual([
        { id: SESSION_NEW, revoked_at: null },
        { id: SESSION_OLD, revoked_at: NOW },
      ]);
      expect(await rows('SELECT last_login_at FROM user_account')).toEqual([
        { last_login_at: NOW },
      ]);
    });

    it('applies evidence equal to the stored one', async () => {
      await seedReturning();
      await exec([{ sql: 'UPDATE identity SET validated_at = ?', params: [EVIDENCE] }]);
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({ identityId: IDENTITY_X, groups: ['fresh'] }),
      );
      expect(result).toBe('created');
      expect(await rows('SELECT group_name FROM user_group WHERE provider = ?', PROVIDER)).toEqual([
        { group_name: 'fresh' },
      ]);
    });
  });

  describe('invitation', () => {
    const ROLE = '01J0ROLE0000000000000000RR';
    const PROJECT = '01J0PROJ0000000000000000PP';

    async function seedGrant(
      kind: 'email' | 'group',
      options: { project?: 'active' | 'archived'; org?: OrgContext } = {},
    ): Promise<void> {
      const org = options.org ?? a;
      const statements: Statement[] = [
        {
          sql: "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, 'viewer', 'Viewer', 'organization')",
          params: [ROLE, org.orgId],
        },
      ];
      if (options.project !== undefined) {
        statements.push({
          sql: 'INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, ?)',
          params: [PROJECT, org.orgId, 'p', 'P', options.project],
        });
      }
      statements.push({
        sql: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [
          '01J0GRANT00000000000000GG',
          org.orgId,
          kind,
          kind === 'email' ? 'ada@example.test' : 'admins',
          kind === 'email' ? null : PROVIDER,
          options.project === undefined ? 'organization' : 'project',
          options.project === undefined ? null : PROJECT,
          ROLE,
        ],
      });
      await exec(statements);
    }

    it('refuses to create a user without auto-join and without an invitation', async () => {
      const before = await snapshot();
      expect(await createLoginWriter(executor).commit(a, plan({ autoJoin: false }))).toBe(
        'refused',
      );
      expect(await rows('SELECT * FROM user_account')).toEqual(before.users);
      expect(await rows('SELECT * FROM identity')).toEqual([]);
    });

    it('treats a plan without autoJoin as false', async () => {
      const { autoJoin, ...rest } = plan();
      expect(autoJoin).toBe(true);
      expect(await createLoginWriter(executor).commit(a, rest)).toBe('refused');
      expect(await rows('SELECT * FROM user_account')).toEqual([]);
    });

    it.each([
      ['an organization e-mail grant', 'email', undefined],
      ['an organization group grant', 'group', undefined],
      ['an e-mail grant on an active project', 'email', 'active'],
    ] as const)('creates the user with %s', async (_label, kind, project) => {
      await seedGrant(kind, project === undefined ? {} : { project });
      expect(await createLoginWriter(executor).commit(a, plan({ autoJoin: false }))).toBe(
        'created',
      );
    });

    it('refuses once the invitation was revoked', async () => {
      await seedGrant('email');
      await exec([{ sql: 'DELETE FROM access_grant', params: [] }]);
      expect(await createLoginWriter(executor).commit(a, plan({ autoJoin: false }))).toBe(
        'refused',
      );
      expect(await rows('SELECT * FROM user_account')).toEqual([]);
      expect(await rows('SELECT * FROM identity')).toEqual([]);
      expect(await rows('SELECT * FROM session')).toEqual([]);
    });

    it('does not count a grant on an archived project', async () => {
      await seedGrant('email', { project: 'archived' });
      expect(await createLoginWriter(executor).commit(a, plan({ autoJoin: false }))).toBe(
        'refused',
      );
    });

    it('does not count a group grant on an archived project', async () => {
      await seedGrant('group', { project: 'archived' });
      expect(await createLoginWriter(executor).commit(a, plan({ autoJoin: false }))).toBe(
        'refused',
      );
      expect(await rows('SELECT * FROM user_account')).toEqual([]);
    });

    it('does not count an e-mail invitation of another organization', async () => {
      await seedGrant('email', { org: b });
      expect(await createLoginWriter(executor).commit(a, plan({ autoJoin: false }))).toBe(
        'refused',
      );
      expect(await rows('SELECT * FROM user_account')).toEqual([]);
    });

    it('needs no invitation for a returning user', async () => {
      await seedReturning();
      expect(
        await createLoginWriter(executor).commit(
          a,
          returningPlan({ identityId: IDENTITY_X, autoJoin: false }),
        ),
      ).toBe('created');
    });
  });

  describe('one subject per provider and user', () => {
    const ATTACKER = 'attacker-sub';
    const VICTIM = 'victim-sub';
    const IDENTITY_VICTIM = '01J0IDENTV000000000000000V';
    const IDENTITY_ATTACKER = '01J0IDENTA000000000000000A';
    const SESSION_VICTIM = '01J0SESSV000000000000000VV';
    const SESSION_ATTACKER = '01J0SESSA000000000000000AA';
    let directory: string;
    let second: SqlExecutor;

    beforeEach(async () => {
      await database.close();
      directory = await mkdtemp(join(tmpdir(), 'pb-login-'));
      database = await openMigratedDatabase({
        twoOrganizations: true,
        file: join(directory, 'store.sqlite'),
      });
      if (database.orgs === null) throw new Error('two organizations were not seeded');
      ({ a, b } = database.orgs);
      executor = database.executor;
      second = await database.second();
    });

    afterEach(async () => {
      await database.close();
      await rm(directory, { recursive: true, force: true });
    });

    function linkPlan(
      subject: string,
      identityId: string,
      sessionId: string,
      secret: string,
      overrides: Partial<LoginPlanWithAutoJoin> = {},
    ): LoginPlanWithAutoJoin {
      return returningPlan({
        subject,
        identityId,
        session: {
          ...plan().session,
          id: sessionId,
          userId: USER_X,
          identityId,
          secretHash: hash(secret),
        },
        ...overrides,
      });
    }

    it('refuses a link planned before another subject of the user committed at the provider', async () => {
      await exec([user(a, USER_X, 'x@example.test'), binding(a, ANCHOR)]);
      const attacker = linkPlan(ATTACKER, IDENTITY_ATTACKER, SESSION_ATTACKER, 'attacker');
      const victim = linkPlan(VICTIM, IDENTITY_VICTIM, SESSION_VICTIM, 'victim');

      expect(await createLoginWriter(second).commit(a, victim)).toBe('created');
      const before = await snapshot();
      expect(await createLoginWriter(executor).commit(a, attacker)).toBe('refused');

      expect(await snapshot()).toEqual(before);
      expect(await rows('SELECT id, subject FROM identity')).toEqual([
        { id: IDENTITY_VICTIM, subject: VICTIM },
      ]);
      expect(await rows('SELECT id FROM session')).toEqual([{ id: SESSION_VICTIM }]);
    });

    it('commits the link when the only other identity of the user is at another provider', async () => {
      await exec([
        user(a, USER_X, 'x@example.test'),
        binding(a, ANCHOR),
        identity(a, '01J0IDENTO000000000000000O', USER_X, {
          provider: OTHER_PROVIDER,
          subject: VICTIM,
          email: 'x@example.test',
        }),
      ]);
      const result = await createLoginWriter(executor).commit(
        a,
        linkPlan(ATTACKER, IDENTITY_ATTACKER, SESSION_ATTACKER, 'attacker'),
      );
      expect(result).toBe('created');
      expect(await rows('SELECT id FROM identity ORDER BY id')).toEqual([
        { id: IDENTITY_ATTACKER },
        { id: '01J0IDENTO000000000000000O' },
      ]);
    });

    it('does not count an identity of the same provider in another organization', async () => {
      await exec([
        user(a, USER_X, 'x@example.test'),
        binding(a, ANCHOR),
        user(b, USER_Y, 'x@example.test'),
        identity(b, '01J0IDENTB000000000000000B', USER_Y, {
          subject: VICTIM,
          email: 'x@example.test',
        }),
      ]);
      expect(
        await createLoginWriter(executor).commit(
          a,
          linkPlan(ATTACKER, IDENTITY_ATTACKER, SESSION_ATTACKER, 'attacker'),
        ),
      ).toBe('created');
    });

    it('lets a known identity log in again', async () => {
      await exec([
        user(a, USER_X, 'x@example.test'),
        binding(a, ANCHOR),
        identity(a, IDENTITY_VICTIM, USER_X, { subject: VICTIM, email: 'x@example.test' }),
      ]);
      const writer = createLoginWriter(executor);
      expect(
        await writer.commit(a, linkPlan(VICTIM, IDENTITY_VICTIM, SESSION_VICTIM, 'victim')),
      ).toBe('created');
      expect(
        await writer.commit(
          a,
          linkPlan(VICTIM, IDENTITY_VICTIM, '01J0SESSV2000000000000000V', 'victim-again'),
        ),
      ).toBe('created');
      expect(await rows('SELECT id FROM identity')).toEqual([{ id: IDENTITY_VICTIM }]);
    });
  });

  describe('provider trust anchor', () => {
    it('refuses a returning user when the binding holds another anchor and writes nothing', async () => {
      await seedReturning();
      await exec([
        { sql: 'UPDATE identity_provider_binding SET anchor = ?', params: ['oidc:https://evil'] },
      ]);
      const before = await snapshot();
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({ identityId: IDENTITY_X, previousSecretHash: OLD_SECRET }),
      );
      expect(result).toBe('refused');
      expect(await snapshot()).toEqual(before);
    });

    it('refuses a new user when the binding holds another anchor and creates nothing', async () => {
      await exec([binding(a, 'oidc:https://evil')]);
      const before = await snapshot();
      expect(await createLoginWriter(executor).commit(a, plan())).toBe('refused');
      expect(await snapshot()).toEqual(before);
    });

    it('does not replace a binding of another provider or organization', async () => {
      await exec([binding(a, 'access:team/aud', OTHER_PROVIDER), binding(b, 'oidc:https://b')]);
      expect(await createLoginWriter(executor).commit(a, plan())).toBe('created');
      expect(
        await rows('SELECT org_id, provider, anchor FROM identity_provider_binding ORDER BY 1, 2'),
      ).toEqual([
        { org_id: a.orgId, provider: OTHER_PROVIDER, anchor: 'access:team/aud' },
        { org_id: a.orgId, provider: PROVIDER, anchor: ANCHOR },
        { org_id: b.orgId, provider: PROVIDER, anchor: 'oidc:https://b' },
      ]);
    });

    it('keeps the stored binding row when the anchor already matches', async () => {
      await exec([binding(a, ANCHOR)]);
      const [stored] = await rows<{ created_at: string }>(
        'SELECT created_at FROM identity_provider_binding',
      );
      expect(await createLoginWriter(executor).commit(a, plan())).toBe('created');
      expect(await rows('SELECT created_at FROM identity_provider_binding')).toEqual([stored]);
    });
  });

  describe('suspended user', () => {
    it('refuses and writes nothing but the binding', async () => {
      await exec([
        user(a, USER_X, 'x@example.test', { status: 'suspended' }),
        identity(a, IDENTITY_X, USER_X, { email: 'x@example.test' }),
        group(a, USER_X, PROVIDER, 'old-group'),
        session(a, SESSION_OLD, USER_X, OLD_SECRET),
      ]);
      const before = await snapshot();
      const counted = countCalls(executor);
      const result = await createLoginWriter(counted.executor).commit(
        a,
        returningPlan({ identityId: IDENTITY_X, previousSecretHash: OLD_SECRET }),
      );
      expect(result).toBe('refused');
      expect(counted.counts()).toEqual({ all: 0, batch: 1 });
      expect(await snapshot()).toEqual({
        ...before,
        bindings: [expect.objectContaining({ provider: PROVIDER, anchor: ANCHOR })],
      });
    });
  });

  describe('groups', () => {
    function names(count: number): string[] {
      return Array.from({ length: count }, (_, index) => `group-${String(index)}`);
    }

    it('accepts 1 000 groups and 256-character names', async () => {
      const groups = [...names(999), 'x'.repeat(256)];
      const counted = countCalls(executor);
      expect(await createLoginWriter(counted.executor).commit(a, plan({ groups }))).toBe('created');
      expect(counted.counts()).toEqual({ all: 0, batch: 1 });
      expect(await rows('SELECT count(*) AS n FROM user_group')).toEqual([{ n: 1000 }]);
    });

    it('counts group name length in code points', async () => {
      const astral = '\u{1F642}'.repeat(256);
      expect(await createLoginWriter(executor).commit(a, plan({ groups: [astral] }))).toBe(
        'created',
      );
      await expect(
        createLoginWriter(executor).commit(a, plan({ groups: ['\u{1F642}'.repeat(257)] })),
      ).rejects.toBeInstanceOf(RangeError);
    });

    it('throws RangeError for 1 001 groups before any executor call', async () => {
      const counted = countCalls(executor);
      await expect(
        createLoginWriter(counted.executor).commit(a, plan({ groups: names(1001) })),
      ).rejects.toBeInstanceOf(RangeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
      expect(await rows('SELECT * FROM user_account')).toEqual([]);
    });

    it('counts distinct names: duplicates are removed first', async () => {
      const groups = [...names(1000), ...names(1000)];
      expect(await createLoginWriter(executor).commit(a, plan({ groups }))).toBe('created');
      expect(await rows('SELECT count(*) AS n FROM user_group')).toEqual([{ n: 1000 }]);
    });

    it('stores a repeated name once', async () => {
      await createLoginWriter(executor).commit(a, plan({ groups: ['dup', 'dup', 'other'] }));
      expect(await rows('SELECT group_name FROM user_group ORDER BY 1')).toEqual([
        { group_name: 'dup' },
        { group_name: 'other' },
      ]);
    });

    it.each([
      ['empty', ''],
      ['257 characters', 'x'.repeat(257)],
    ])('throws RangeError for a name that is %s, before any call', async (_label, name) => {
      const counted = countCalls(executor);
      await expect(
        createLoginWriter(counted.executor).commit(a, plan({ groups: ['ok', name] })),
      ).rejects.toBeInstanceOf(RangeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    });

    it.each([
      ['a number', 1],
      ['null', null],
      ['a lone surrogate', 'a\ud800'],
    ])('throws TypeError for a group that is %s, before any call', async (_label, value) => {
      const counted = countCalls(executor);
      await expect(
        createLoginWriter(counted.executor).commit(
          a,
          plan({ groups: ['ok', value as unknown as string] }),
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    });
  });

  describe('plan validation', () => {
    it.each([
      ['evidenceTime', { evidenceTime: '2026-10-15 11:59:00' }],
      ['now', { now: '2026-10-15T12:00:00Z' }],
    ])('throws TypeError for a malformed %s before any call', async (_label, override) => {
      const counted = countCalls(executor);
      await expect(
        createLoginWriter(counted.executor).commit(a, plan(override)),
      ).rejects.toBeInstanceOf(TypeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    });

    it('throws TypeError when the session belongs to another user than the plan', async () => {
      const counted = countCalls(executor);
      const base = plan();
      await expect(
        createLoginWriter(counted.executor).commit(a, {
          ...base,
          session: { ...base.session, userId: USER_Y },
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    });

    it('throws TypeError when the session identity is not the plan identity', async () => {
      const counted = countCalls(executor);
      const base = plan();
      await expect(
        createLoginWriter(counted.executor).commit(a, {
          ...base,
          session: { ...base.session, identityId: IDENTITY_X },
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        createLoginWriter(counted.executor).commit(a, {
          ...base,
          session: { ...base.session, identityId: null },
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    });

    it('throws TypeError when the session time is not the plan time', async () => {
      const counted = countCalls(executor);
      const base = plan();
      await expect(
        createLoginWriter(counted.executor).commit(a, {
          ...base,
          session: { ...base.session, now: '2026-10-15T12:00:00.001Z' },
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    });

    it.each([
      ['empty', ''],
      ['upper case', 'Ada@example.test'],
    ])('throws TypeError for an e-mail that is %s, before any call', async (_label, email) => {
      const counted = countCalls(executor);
      await expect(
        createLoginWriter(counted.executor).commit(a, plan({ email })),
      ).rejects.toBeInstanceOf(TypeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    });

    it('cuts a display name to 200 code points', async () => {
      await createLoginWriter(executor).commit(
        a,
        plan({ displayName: `${'\u{1F642}'.repeat(199)}ab` }),
      );
      const [row] = await rows<{ display_name: string }>('SELECT display_name FROM user_account');
      expect(Array.from(row?.display_name ?? '')).toHaveLength(200);
      expect(row?.display_name.endsWith('a')).toBe(true);
    });

    it('throws TypeError for a previous secret hash that is not 64 lowercase hex', async () => {
      await expect(
        createLoginWriter(executor).commit(a, plan({ previousSecretHash: 'nope' })),
      ).rejects.toBeInstanceOf(TypeError);
    });

    it('keeps the previous session when a refused commit meets a row with the new session id', async () => {
      await exec([
        user(a, USER_X, 'x@example.test', { status: 'suspended' }),
        identity(a, IDENTITY_X, USER_X, { email: 'x@example.test' }),
        session(a, SESSION_OLD, USER_X, OLD_SECRET),
        {
          sql: 'INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          params: [SESSION_NEW, a.orgId, USER_X, NEW_SECRET, hash('csrf'), NOW, EXPIRES],
        },
      ]);
      const result = await createLoginWriter(executor).commit(
        a,
        returningPlan({ identityId: IDENTITY_X, previousSecretHash: OLD_SECRET }),
      );
      expect(result).toBe('refused');
      expect(await rows('SELECT id, revoked_at FROM session ORDER BY id')).toEqual([
        { id: SESSION_NEW, revoked_at: null },
        { id: SESSION_OLD, revoked_at: null },
      ]);
    });

    it('does not use the previous session of another organization', async () => {
      await exec([user(b, USER_Y, 'y@example.test'), session(b, SESSION_OLD, USER_Y, OLD_SECRET)]);
      expect(
        await createLoginWriter(executor).commit(a, plan({ previousSecretHash: OLD_SECRET })),
      ).toBe('created');
      expect(await rows('SELECT revoked_at FROM session WHERE id = ?', SESSION_OLD)).toEqual([
        { revoked_at: null },
      ]);
    });
  });
});
