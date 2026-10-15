import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  OrgContext,
  ScalarSqlExecutor,
  ScalarStatement,
  SqlExecutor,
  Statement,
  StatementResult,
} from '@package-broker/core/db/port';
import { countCalls } from '../contract/count-calls.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createLoginWriter, type LoginPlanWithAutoJoin } from './login.js';
import { readProviderBinding, rebindProvider } from './provider-binding.js';
import { createUserRepository } from './user.js';

const OLD = '2026-10-14T08:00:00.000Z';
const EVIDENCE = '2026-10-15T11:59:00.000Z';
const NOW = '2026-10-15T12:00:00.000Z';
const EXPIRES = '2026-10-16T00:00:00.000Z';
const DEX = 'dex';
const CF = 'cf';
const DEX_ANCHOR = 'oidc:https://dex.example.test';
const DEX_ANCHOR_NEW = 'oidc:https://dex-new.example.test';
const CF_ANCHOR = `access:team.example.test/${'a'.repeat(64)}`;

const USER_X = '01J0USERX0000000000000000X';
const USER_Y = '01J0USERY0000000000000000Y';
const USER_B = '01J0USERB0000000000000000B';
const IDENTITY_X_DEX = '01J0IDENTXD00000000000000X';
const IDENTITY_X_CF = '01J0IDENTXC00000000000000X';
const IDENTITY_Y_DEX = '01J0IDENTYD00000000000000Y';
const IDENTITY_B_DEX = '01J0IDENTBD00000000000000B';
const IDENTITY_RELINKED = '01J0IDENTN000000000000000N';
const SESSION_X_DEX = '01J0SESSXD00000000000000XX';
const SESSION_Y_DEX = '01J0SESSYD00000000000000YY';
const SESSION_X_CF = '01J0SESSXC00000000000000XX';
const SESSION_X_LOCAL = '01J0SESSXL00000000000000XX';
const SESSION_B_DEX = '01J0SESSBD00000000000000BB';
const SESSION_RELINKED = '01J0SESSN000000000000000NN';
const ROLE = '01J0ROLE0000000000000000RR';
const GRANT = '01J0GRANT00000000000000GG';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

function hash(label: string): string {
  return Buffer.from(label).toString('hex').padEnd(64, '0');
}

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

function user(ctx: OrgContext, id: string, email: string): Statement {
  return {
    sql: "INSERT INTO user_account (id, org_id, email, status, last_login_at) VALUES (?, ?, ?, 'active', ?)",
    params: [id, ctx.orgId, email, OLD],
  };
}

function identity(
  ctx: OrgContext,
  id: string,
  userId: string,
  provider: string,
  subject: string,
  email: string,
): Statement {
  return {
    sql: 'INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    params: [id, ctx.orgId, userId, provider, subject, email, OLD],
  };
}

function binding(ctx: OrgContext, provider: string, anchor: string): Statement {
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

function session(
  ctx: OrgContext,
  id: string,
  userId: string,
  identityId: string | null,
  label: string,
): Statement {
  return {
    sql: 'INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    params: [id, ctx.orgId, userId, identityId, hash(label), hash(`csrf-${label}`), OLD, EXPIRES],
  };
}

async function seed(): Promise<void> {
  await exec([
    user(a, USER_X, 'x@example.test'),
    user(a, USER_Y, 'y@example.test'),
    identity(a, IDENTITY_X_DEX, USER_X, DEX, 'sub-x', 'x@example.test'),
    identity(a, IDENTITY_X_CF, USER_X, CF, 'sub-xc', 'x@example.test'),
    identity(a, IDENTITY_Y_DEX, USER_Y, DEX, 'sub-y', 'y@example.test'),
    binding(a, DEX, DEX_ANCHOR),
    binding(a, CF, CF_ANCHOR),
    group(a, USER_X, DEX, 'admins'),
    group(a, USER_X, DEX, 'readers'),
    group(a, USER_X, CF, 'cf-admins'),
    group(a, USER_Y, DEX, 'readers'),
    session(a, SESSION_X_DEX, USER_X, IDENTITY_X_DEX, 'x-dex'),
    session(a, SESSION_Y_DEX, USER_Y, IDENTITY_Y_DEX, 'y-dex'),
    session(a, SESSION_X_CF, USER_X, IDENTITY_X_CF, 'x-cf'),
    session(a, SESSION_X_LOCAL, USER_X, null, 'x-local'),
    {
      sql: "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, 'viewer', 'Viewer', 'organization')",
      params: [ROLE, a.orgId],
    },
    {
      sql: "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, 'group', 'readers', ?, 'organization', NULL, ?)",
      params: [GRANT, a.orgId, DEX, ROLE],
    },
    user(b, USER_B, 'x@example.test'),
    identity(b, IDENTITY_B_DEX, USER_B, DEX, 'sub-x', 'x@example.test'),
    binding(b, DEX, DEX_ANCHOR),
    group(b, USER_B, DEX, 'admins'),
    session(b, SESSION_B_DEX, USER_B, IDENTITY_B_DEX, 'b-dex'),
  ]);
}

type Table = 'users' | 'identities' | 'bindings' | 'groups' | 'sessions' | 'grants';

async function snapshot(): Promise<Record<Table, unknown[]>> {
  return {
    users: await rows('SELECT * FROM user_account ORDER BY id'),
    identities: await rows('SELECT * FROM identity ORDER BY id'),
    bindings: await rows('SELECT * FROM identity_provider_binding ORDER BY org_id, provider'),
    groups: await rows('SELECT * FROM user_group ORDER BY org_id, user_id, provider, group_name'),
    sessions: await rows('SELECT * FROM session ORDER BY id'),
    grants: await rows('SELECT * FROM access_grant ORDER BY id'),
  };
}

function recording(inner: SqlExecutor): { executor: ScalarSqlExecutor; seen: ScalarStatement[] } {
  const seen: ScalarStatement[] = [];
  const executor: ScalarSqlExecutor = {
    driver: inner.driver,
    all: (statement) => inner.all(statement),
    async batch(statements): Promise<StatementResult[]> {
      seen.push(...statements);
      return inner.batch(statements);
    },
  };
  return { executor, seen };
}

function recordingReads(inner: SqlExecutor): {
  executor: ScalarSqlExecutor;
  seen: ScalarStatement[];
} {
  const seen: ScalarStatement[] = [];
  const executor: ScalarSqlExecutor = {
    driver: inner.driver,
    async all<R = Record<string, unknown>>(statement: ScalarStatement): Promise<R[]> {
      seen.push(statement);
      return inner.all<R>(statement);
    },
    batch: (statements) => inner.batch(statements),
  };
  return { executor, seen };
}

function rebind(
  ctx: OrgContext = a,
  options: {
    provider?: unknown;
    expected?: unknown;
    next?: unknown;
    exec?: ScalarSqlExecutor;
  } = {},
) {
  const pick = (key: 'provider' | 'expected' | 'next', fallback: string): string =>
    (key in options ? options[key] : fallback) as string;
  return rebindProvider(
    options.exec ?? executor,
    ctx,
    pick('provider', DEX),
    pick('expected', DEX_ANCHOR),
    pick('next', DEX_ANCHOR_NEW),
    NOW,
  );
}

function bindingRows(ctx: OrgContext): Promise<Record<string, unknown>[]> {
  return rows(
    'SELECT provider, anchor, created_at FROM identity_provider_binding WHERE org_id = ? ORDER BY provider',
    ctx.orgId,
  );
}

describe('rebindProvider', () => {
  it('swaps the anchor and removes identities, groups and sessions of the provider', async () => {
    await seed();
    expect(await rebind()).toEqual({ swapped: true, identities: 2, sessions: 2 });

    expect(await bindingRows(a)).toEqual([
      { provider: CF, anchor: CF_ANCHOR, created_at: expect.any(String) as string },
      { provider: DEX, anchor: DEX_ANCHOR_NEW, created_at: NOW },
    ]);
    expect(await rows('SELECT id FROM identity WHERE org_id = ? ORDER BY id', a.orgId)).toEqual([
      { id: IDENTITY_X_CF },
    ]);
    expect(
      await rows(
        'SELECT user_id, provider, group_name FROM user_group WHERE org_id = ? ORDER BY group_name',
        a.orgId,
      ),
    ).toEqual([{ user_id: USER_X, provider: CF, group_name: 'cf-admins' }]);
    expect(await rows('SELECT id FROM session WHERE org_id = ? ORDER BY id', a.orgId)).toEqual([
      { id: SESSION_X_CF },
      { id: SESSION_X_LOCAL },
    ]);
  });

  it('keeps users, grants and every row of other providers', async () => {
    await seed();
    const before = await snapshot();
    await rebind();
    const after = await snapshot();
    const keep = (row: unknown): boolean =>
      (row as { provider: string }).provider !== DEX ||
      (row as { org_id: string }).org_id === b.orgId;

    expect(after.users).toEqual(before.users);
    expect(after.grants).toEqual(before.grants);
    expect(after.grants).toHaveLength(1);
    expect(after.identities).toEqual(before.identities.filter(keep));
    expect(after.groups).toEqual(before.groups.filter(keep));
    expect(after.bindings.filter((row) => (row as { provider: string }).provider !== DEX)).toEqual(
      before.bindings.filter((row) => (row as { provider: string }).provider !== DEX),
    );
  });

  it('counts identities and sessions separately', async () => {
    await seed();
    await exec([
      session(a, '01J0SESSXD200000000000000X', USER_X, IDENTITY_X_DEX, 'x-dex-2'),
      session(a, '01J0SESSXD300000000000000X', USER_X, IDENTITY_X_DEX, 'x-dex-3'),
    ]);
    expect(await rebind()).toEqual({ swapped: true, identities: 2, sessions: 4 });
  });

  it('counts an identity without sessions', async () => {
    await exec([
      user(a, USER_X, 'x@example.test'),
      identity(a, IDENTITY_X_DEX, USER_X, DEX, 'sub-x', 'x@example.test'),
      binding(a, DEX, DEX_ANCHOR),
    ]);
    expect(await rebind()).toEqual({ swapped: true, identities: 1, sessions: 0 });
  });

  it('swaps a binding that has no identities', async () => {
    await exec([binding(a, DEX, DEX_ANCHOR)]);
    expect(await rebind()).toEqual({ swapped: true, identities: 0, sessions: 0 });
    expect(await bindingRows(a)).toEqual([
      { provider: DEX, anchor: DEX_ANCHOR_NEW, created_at: NOW },
    ]);
  });

  it('deletes revoked sessions of the provider as well', async () => {
    await seed();
    await exec([
      { sql: 'UPDATE session SET revoked_at = ? WHERE id = ?', params: [NOW, SESSION_X_DEX] },
    ]);
    expect(await rebind()).toEqual({ swapped: true, identities: 2, sessions: 2 });
  });

  it('leaves the other organization untouched even with the same provider, anchor and subject', async () => {
    await seed();
    const other = async (): Promise<unknown[]> => [
      await rows('SELECT * FROM identity WHERE org_id = ?', b.orgId),
      await rows('SELECT * FROM identity_provider_binding WHERE org_id = ?', b.orgId),
      await rows('SELECT * FROM user_group WHERE org_id = ?', b.orgId),
      await rows('SELECT * FROM session WHERE org_id = ?', b.orgId),
    ];
    const before = await other();

    expect(await rebind(a)).toEqual({ swapped: true, identities: 2, sessions: 2 });
    expect(await other()).toEqual(before);

    expect(await rebind(b)).toEqual({ swapped: true, identities: 1, sessions: 1 });
    expect(await rows('SELECT id FROM identity WHERE org_id = ?', a.orgId)).toEqual([
      { id: IDENTITY_X_CF },
    ]);
  });

  it('uses one executor call with one batch of four scalar statements, the binding update last', async () => {
    await seed();
    const counted = countCalls(executor);
    const spy = recording(counted.executor);
    await rebind(a, { exec: spy.executor });

    expect(counted.counts()).toEqual({ all: 0, batch: 1 });
    expect(spy.seen).toHaveLength(4);
    expect(spy.seen.map((statement) => /^\w+/.exec(statement.sql)?.[0])).toEqual([
      'delete',
      'delete',
      'delete',
      'update',
    ]);
    for (const statement of spy.seen) {
      for (const param of statement.params) {
        expect(['string', 'number'].includes(typeof param) || param === null).toBe(true);
      }
      expect(statement.params).toContain(a.orgId);
      expect(statement.params).toContain(DEX);
      expect(statement.sql).not.toContain(DEX);
      expect(statement.sql).not.toContain(a.orgId);
    }
  });

  describe('binding missing or different', () => {
    it('does nothing for a provider with no binding, even if identities exist', async () => {
      await seed();
      await exec([
        identity(a, '01J0IDENTO00000000000000OO', USER_Y, 'orphan', 'sub-o', 'y@example.test'),
        session(a, '01J0SESSO00000000000000OOO', USER_Y, '01J0IDENTO00000000000000OO', 'orphan'),
      ]);
      const before = await snapshot();
      expect(await rebind(a, { provider: 'orphan' })).toEqual({
        swapped: false,
        identities: 0,
        sessions: 0,
      });
      expect(await snapshot()).toEqual(before);
    });

    it('does nothing when the stored anchor is not the expected one', async () => {
      await seed();
      const before = await snapshot();
      expect(await rebind(a, { expected: DEX_ANCHOR_NEW, next: CF_ANCHOR })).toEqual({
        swapped: false,
        identities: 0,
        sessions: 0,
      });
      expect(await snapshot()).toEqual(before);
    });

    it('does nothing when the binding exists only in the other organization', async () => {
      await exec([user(b, USER_B, 'x@example.test'), binding(b, DEX, DEX_ANCHOR)]);
      const before = await snapshot();
      expect(await rebind(a)).toEqual({ swapped: false, identities: 0, sessions: 0 });
      expect(await snapshot()).toEqual(before);
    });

    it('is not repeatable: the second call with the same arguments changes nothing', async () => {
      await seed();
      expect(await rebind()).toEqual({ swapped: true, identities: 2, sessions: 2 });
      const before = await snapshot();
      expect(await rebind()).toEqual({ swapped: false, identities: 0, sessions: 0 });
      expect(await snapshot()).toEqual(before);
    });
  });

  describe('invalid input', () => {
    async function expectRejected(call: (e: ScalarSqlExecutor) => Promise<unknown>): Promise<void> {
      await seed();
      const before = await snapshot();
      const counted = countCalls(executor);
      await expect(call(counted.executor)).rejects.toBeInstanceOf(TypeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
      expect(await snapshot()).toEqual(before);
    }

    it.each([
      ['empty', ''],
      ['upper case', 'Dex'],
      ['space', 'de x'],
      ['leading dash', '-dex'],
      ['trailing dash', 'dex-'],
      ['SQL-looking', "dex' OR '1'='1"],
      ['too long', 'a'.repeat(65)],
      ['reserved', 'local'],
      ['number', 42],
      ['null', null],
      ['undefined', undefined],
    ])('throws TypeError for a provider id that is %s', async (_label, provider) => {
      await expectRejected((e) => rebind(a, { provider, exec: e }));
    });

    const badAnchors: [string, unknown][] = [
      ['empty', ''],
      ['no scheme', 'dex.example.test'],
      ['bare prefix', 'oidc:'],
      ['plain http issuer', 'oidc:http://dex.example.test'],
      ['too long', `oidc:https://${'a'.repeat(600)}.example.test`],
      ['number', 7],
      ['null', null],
    ];

    it.each(badAnchors)(
      'throws TypeError for an expected anchor that is %s',
      async (_l, anchor) => {
        await expectRejected((e) => rebind(a, { expected: anchor, exec: e }));
      },
    );

    it('throws TypeError when the new anchor equals the expected one, with no executor call', async () => {
      await expectRejected((e) => rebind(a, { next: DEX_ANCHOR, exec: e }));
    });

    it.each(badAnchors)('throws TypeError for a new anchor that is %s', async (_l, anchor) => {
      await expectRejected((e) => rebind(a, { next: anchor, exec: e }));
    });

    it.each([
      ['empty', ''],
      ['date only', '2026-10-15'],
      ['no milliseconds', '2026-10-15T12:00:00Z'],
      ['impossible day', '2026-02-30T12:00:00.000Z'],
      ['month 13', '2026-13-01T12:00:00.000Z'],
      ['minute 60', '2026-10-15T12:60:00.000Z'],
      ['year zero date', '0000-00-00T00:00:00.000Z'],
      ['number', 1],
    ])('throws TypeError for a timestamp that is %s', async (_label, now) => {
      await expectRejected((e) =>
        rebindProvider(e, a, DEX, DEX_ANCHOR, DEX_ANCHOR_NEW, now as string),
      );
    });
  });

  describe('logins around a rebind', () => {
    const lookupInput = {
      provider: DEX,
      subject: 'sub-new',
      email: 'x@example.test',
      groups: ['new-group'],
    };

    function loginPlan(overrides: Partial<LoginPlanWithAutoJoin> = {}): LoginPlanWithAutoJoin {
      return {
        userId: USER_X,
        createUser: false,
        email: 'x@example.test',
        displayName: null,
        identityId: IDENTITY_RELINKED,
        provider: DEX,
        trustAnchor: DEX_ANCHOR_NEW,
        subject: 'sub-new',
        emailVerified: true,
        groups: ['new-group'],
        evidenceTime: EVIDENCE,
        session: {
          id: SESSION_RELINKED,
          userId: USER_X,
          identityId: IDENTITY_RELINKED,
          secretHash: hash('relinked'),
          csrfHash: hash('relinked-csrf'),
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

    async function dexState(): Promise<unknown[]> {
      return [
        await rows('SELECT * FROM identity WHERE org_id = ? AND provider = ?', a.orgId, DEX),
        await rows('SELECT * FROM user_group WHERE org_id = ? AND provider = ?', a.orgId, DEX),
        await rows('SELECT id FROM session WHERE id = ?', SESSION_RELINKED),
        await bindingRows(a),
      ];
    }

    it('sees the old anchor before the rebind and the new one after it', async () => {
      await seed();
      const users = createUserRepository(executor);
      const before = await users.lookupForLogin(a, lookupInput);
      expect(before.boundAnchor).toBe(DEX_ANCHOR);
      expect(before.identity).toBeNull();
      await rebind();
      const after = await users.lookupForLogin(a, lookupInput);
      expect(after.boundAnchor).toBe(DEX_ANCHOR_NEW);
      expect(after.identity).toBeNull();
      expect(after.userByEmail).toEqual({ id: USER_X, status: 'active', linkedAtProvider: false });
    });

    it('links the existing user by e-mail on the next login under the new anchor', async () => {
      await seed();
      await rebind();

      expect(await createLoginWriter(executor).commit(a, loginPlan())).toBe('created');

      expect(await bindingRows(a)).toContainEqual({
        provider: DEX,
        anchor: DEX_ANCHOR_NEW,
        created_at: NOW,
      });
      expect(
        await rows(
          'SELECT id, user_id, subject, email_verified, validated_at FROM identity WHERE org_id = ? AND provider = ?',
          a.orgId,
          DEX,
        ),
      ).toEqual([
        {
          id: IDENTITY_RELINKED,
          user_id: USER_X,
          subject: 'sub-new',
          email_verified: 1,
          validated_at: EVIDENCE,
        },
      ]);
      expect(
        await rows('SELECT id FROM user_account WHERE org_id = ? ORDER BY id', a.orgId),
      ).toEqual([{ id: USER_X }, { id: USER_Y }]);
      expect(
        await rows(
          'SELECT group_name FROM user_group WHERE org_id = ? AND provider = ? ORDER BY group_name',
          a.orgId,
          DEX,
        ),
      ).toEqual([{ group_name: 'new-group' }]);
      expect(await rows('SELECT identity_id FROM session WHERE id = ?', SESSION_RELINKED)).toEqual([
        { identity_id: IDENTITY_RELINKED },
      ]);
    });

    it('refuses a login planned under the old anchor that commits after the rebind', async () => {
      await seed();
      const lookup = await createUserRepository(executor).lookupForLogin(a, lookupInput);
      expect(lookup.boundAnchor).toBe(DEX_ANCHOR);
      const stale = loginPlan({ trustAnchor: DEX_ANCHOR });

      expect(await rebind()).toEqual({ swapped: true, identities: 2, sessions: 2 });
      const before = await snapshot();
      const dexBefore = await dexState();

      expect(await createLoginWriter(executor).commit(a, stale)).toBe('refused');

      expect(await snapshot()).toEqual(before);
      expect(await dexState()).toEqual(dexBefore);
      expect(dexBefore[0]).toEqual([]);
      expect(dexBefore[1]).toEqual([]);
      expect(dexBefore[2]).toEqual([]);
      expect(
        await rows(
          'SELECT anchor FROM identity_provider_binding WHERE org_id = ? AND provider = ?',
          a.orgId,
          DEX,
        ),
      ).toEqual([{ anchor: DEX_ANCHOR_NEW }]);
    });

    it('refuses a login planned for an existing identity that commits after the rebind', async () => {
      await seed();
      const lookup = await createUserRepository(executor).lookupForLogin(a, {
        provider: DEX,
        subject: 'sub-x',
        email: 'x@example.test',
        groups: ['admins'],
      });
      expect(lookup.boundAnchor).toBe(DEX_ANCHOR);
      expect(lookup.identity?.id).toBe(IDENTITY_X_DEX);
      const stale = loginPlan({
        trustAnchor: DEX_ANCHOR,
        identityId: IDENTITY_X_DEX,
        subject: 'sub-x',
        groups: ['admins'],
        session: {
          ...loginPlan().session,
          identityId: IDENTITY_X_DEX,
        },
      });

      expect(await rebind()).toEqual({ swapped: true, identities: 2, sessions: 2 });
      const before = await snapshot();

      expect(await createLoginWriter(executor).commit(a, stale)).toBe('refused');

      expect(await snapshot()).toEqual(before);
      expect(
        await rows('SELECT id FROM identity WHERE org_id = ? AND provider = ?', a.orgId, DEX),
      ).toEqual([]);
      expect(await rows('SELECT id FROM session WHERE id = ?', SESSION_RELINKED)).toEqual([]);
      expect(await bindingRows(a)).toContainEqual({
        provider: DEX,
        anchor: DEX_ANCHOR_NEW,
        created_at: NOW,
      });
    });

    it('refuses a stale login that would create a user after the rebind', async () => {
      await seed();
      await rebind();
      const before = await snapshot();
      const stale = loginPlan({
        trustAnchor: DEX_ANCHOR,
        createUser: true,
        autoJoin: true,
        userId: '01J0USERN0000000000000000N',
        email: 'new@example.test',
        session: {
          ...loginPlan().session,
          userId: '01J0USERN0000000000000000N',
        },
      });
      expect(await createLoginWriter(executor).commit(a, stale)).toBe('refused');
      expect(await snapshot()).toEqual(before);
    });

    it('accepts a plan under the new anchor after the same rebind (control)', async () => {
      await seed();
      await createUserRepository(executor).lookupForLogin(a, lookupInput);
      await rebind();
      expect(await createLoginWriter(executor).commit(a, loginPlan())).toBe('created');
      expect(await rows('SELECT id FROM session WHERE id = ?', SESSION_RELINKED)).toEqual([
        { id: SESSION_RELINKED },
      ]);
    });
  });
});

describe('readProviderBinding', () => {
  function read(
    ctx: OrgContext = a,
    options: { readonly provider?: unknown; readonly exec?: ScalarSqlExecutor } = {},
  ) {
    const provider = 'provider' in options ? options.provider : DEX;
    return readProviderBinding(options.exec ?? executor, ctx, provider as string);
  }

  it('returns the stored anchor and createdAt for the organization and provider', async () => {
    await seed();
    const stored = await rows<{ created_at: string }>(
      'SELECT created_at FROM identity_provider_binding WHERE org_id = ? AND provider = ?',
      a.orgId,
      DEX,
    );
    expect(await read()).toEqual({ anchor: DEX_ANCHOR, createdAt: stored[0]?.created_at });
  });

  it('reads the other provider of the same organization', async () => {
    await seed();
    expect(await read(a, { provider: CF })).toEqual({
      anchor: CF_ANCHOR,
      createdAt: expect.any(String) as string,
    });
  });

  it('returns null for a binding that exists only in another organization', async () => {
    await exec([binding(b, DEX, DEX_ANCHOR)]);
    expect(await read(a, { provider: DEX })).toBeNull();
    expect(await read(b, { provider: DEX })).toEqual({
      anchor: DEX_ANCHOR,
      createdAt: expect.any(String) as string,
    });
  });

  it('returns null for a provider with no binding even when identities exist', async () => {
    await seed();
    await exec([
      identity(a, '01J0IDENTO00000000000000OO', USER_Y, 'orphan', 'sub-o', 'y@example.test'),
    ]);
    expect(await read(a, { provider: 'orphan' })).toBeNull();
  });

  it('uses one executor all call with scalar parameters and no literals', async () => {
    await seed();
    const counted = countCalls(executor);
    const spy = recordingReads(counted.executor);
    await read(a, { provider: DEX, exec: spy.executor });

    expect(counted.counts()).toEqual({ all: 1, batch: 0 });
    expect(spy.seen).toHaveLength(1);
    const statement = spy.seen[0] as ScalarStatement;
    for (const param of statement.params) {
      expect(['string', 'number'].includes(typeof param) || param === null).toBe(true);
    }
    expect(statement.params).toContain(a.orgId);
    expect(statement.params).toContain(DEX);
    expect(statement.sql).not.toContain(DEX);
    expect(statement.sql).not.toContain(a.orgId);
  });

  it.each([
    ['empty', ''],
    ['upper case', 'Dex'],
    ['space', 'de x'],
    ['leading dash', '-dex'],
    ['trailing dash', 'dex-'],
    ['SQL-looking', "dex' OR '1'='1"],
    ['too long', 'a'.repeat(65)],
    ['reserved', 'local'],
    ['number', 42],
    ['null', null],
    ['undefined', undefined],
  ])(
    'throws TypeError for a provider id that is %s, with no executor call',
    async (_l, provider) => {
      await seed();
      const counted = countCalls(executor);
      await expect(read(a, { provider, exec: counted.executor })).rejects.toBeInstanceOf(TypeError);
      expect(counted.counts()).toEqual({ all: 0, batch: 0 });
    },
  );
});
