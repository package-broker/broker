import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { createUserRepository } from './user.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';

const ROLE_A = '01J0ROLEA0000000000000000A';
const ROLE_B = '01J0ROLEB0000000000000000B';
const PROJECT_A = '01J0PROJA0000000000000000A';
const PROJECT_B = '01J0PROJB0000000000000000B';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  await executor.batch([
    roleStatement(a, ROLE_A, 'viewer'),
    roleStatement(b, ROLE_B, 'viewer'),
    projectStatement(a, PROJECT_A, 'alpha'),
    projectStatement(b, PROJECT_B, 'beta'),
  ]);
});

afterEach(async () => {
  await database.close();
});

function roleStatement(ctx: OrgContext, id: string, key: string): Statement {
  return {
    sql: "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, ?, ?, 'organization')",
    params: [id, ctx.orgId, key, key],
  };
}

function projectStatement(ctx: OrgContext, id: string, slug: string): Statement {
  return {
    sql: 'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
    params: [id, ctx.orgId, slug, slug],
  };
}

function userStatement(
  ctx: OrgContext,
  id: string,
  email: string,
  options: {
    readonly displayName?: string | null;
    readonly status?: 'active' | 'suspended';
    readonly lastLoginAt?: string | null;
    readonly createdAt?: string;
  } = {},
): Statement {
  return {
    sql: 'INSERT INTO user_account (id, org_id, email, display_name, status, last_login_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [
      id,
      ctx.orgId,
      email,
      options.displayName ?? null,
      options.status ?? 'active',
      options.lastLoginAt ?? null,
      options.createdAt ?? '2026-10-01T08:00:00.000Z',
    ],
  };
}

function identityStatement(
  ctx: OrgContext,
  id: string,
  userId: string,
  provider: string,
  subject: string,
  email: string,
  validatedAt: string | null = null,
): Statement {
  return {
    sql: 'INSERT INTO identity (id, org_id, user_id, provider, subject, email, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    params: [id, ctx.orgId, userId, provider, subject, email, validatedAt],
  };
}

function bindingStatement(ctx: OrgContext, provider: string, anchor: string): Statement {
  return {
    sql: 'INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, ?, ?)',
    params: [ctx.orgId, provider, anchor],
  };
}

function emailGrant(
  ctx: OrgContext,
  id: string,
  email: string,
  scope: 'organization' | 'project',
): Statement {
  const project = ctx === a ? PROJECT_A : PROJECT_B;
  return {
    sql: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)',
    params: [
      id,
      ctx.orgId,
      'email',
      email,
      scope,
      scope === 'project' ? project : null,
      ctx === a ? ROLE_A : ROLE_B,
    ],
  };
}

function groupGrant(
  ctx: OrgContext,
  id: string,
  provider: string,
  group: string,
  scope: 'organization' | 'project',
): Statement {
  const project = ctx === a ? PROJECT_A : PROJECT_B;
  return {
    sql: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    params: [
      id,
      ctx.orgId,
      'group',
      group,
      provider,
      scope,
      scope === 'project' ? project : null,
      ctx === a ? ROLE_A : ROLE_B,
    ],
  };
}

function membershipStatement(
  ctx: OrgContext,
  userId: string,
  provider: string,
  group: string,
): Statement {
  return {
    sql: 'INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, ?, ?)',
    params: [ctx.orgId, userId, provider, group],
  };
}

const INPUT = { provider: 'okta', subject: 'sub-1', email: 'ada@example.test', groups: [] };

describe('lookupForLogin', () => {
  it('returns nulls and not invited for a fresh provider and unknown person', async () => {
    const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
    expect(lookup).toEqual({
      boundAnchor: null,
      identity: null,
      identityUser: null,
      userByEmail: null,
      invited: false,
    });
  });

  it('fills identity, identityUser and boundAnchor for a known identity', async () => {
    await executor.batch([
      userStatement(a, 'U1', 'ada@example.test'),
      identityStatement(
        a,
        'I1',
        'U1',
        'okta',
        'sub-1',
        'ada@example.test',
        '2026-10-10T10:00:00.000Z',
      ),
      bindingStatement(a, 'okta', 'anchor-okta'),
    ]);
    const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
    expect(lookup).toEqual({
      boundAnchor: 'anchor-okta',
      identity: {
        id: 'I1',
        userId: 'U1',
        provider: 'okta',
        subject: 'sub-1',
        email: 'ada@example.test',
        validatedAt: '2026-10-10T10:00:00.000Z',
      },
      identityUser: { id: 'U1', email: 'ada@example.test', status: 'active' },
      userByEmail: { id: 'U1', status: 'active', linkedAtProvider: true },
      invited: false,
    });
  });

  it('returns the identity user e-mail when it differs from the lookup e-mail', async () => {
    await executor.batch([
      userStatement(a, 'U1', 'old@example.test'),
      identityStatement(a, 'I1', 'U1', 'okta', 'sub-1', 'old@example.test'),
    ]);
    const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
    expect(lookup.identityUser).toEqual({ id: 'U1', email: 'old@example.test', status: 'active' });
    expect(lookup.userByEmail).toBeNull();
    expect(lookup.identity?.validatedAt).toBeNull();
  });

  it('returns only userByEmail for an unknown identity with an existing e-mail', async () => {
    await executor.batch([
      userStatement(a, 'U1', 'ada@example.test'),
      identityStatement(a, 'I1', 'U1', 'okta', 'other-subject', 'ada@example.test'),
      identityStatement(a, 'I2', 'U1', 'github', 'sub-1', 'ada@example.test'),
    ]);
    const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
    expect(lookup).toEqual({
      boundAnchor: null,
      identity: null,
      identityUser: null,
      userByEmail: { id: 'U1', status: 'active', linkedAtProvider: true },
      invited: false,
    });
  });

  it('reports suspended users on both paths', async () => {
    await executor.batch([
      userStatement(a, 'U1', 'ada@example.test', { status: 'suspended' }),
      identityStatement(a, 'I1', 'U1', 'okta', 'sub-1', 'ada@example.test'),
    ]);
    const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
    expect(lookup.identityUser?.status).toBe('suspended');
    expect(lookup.userByEmail?.status).toBe('suspended');
  });

  describe('userByEmail.linkedAtProvider', () => {
    it('is true when the e-mail user holds another subject at the provider', async () => {
      await executor.batch([
        userStatement(a, 'U1', 'ada@example.test'),
        identityStatement(a, 'I1', 'U1', 'okta', 'other-subject', 'ada@example.test'),
      ]);
      const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
      expect(lookup.identity).toBeNull();
      expect(lookup.userByEmail).toEqual({ id: 'U1', status: 'active', linkedAtProvider: true });
    });

    it('is false when the only identity of the e-mail user is at another provider', async () => {
      await executor.batch([
        userStatement(a, 'U1', 'ada@example.test'),
        identityStatement(a, 'I1', 'U1', 'github', 'sub-1', 'ada@example.test'),
      ]);
      const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
      expect(lookup.userByEmail).toEqual({ id: 'U1', status: 'active', linkedAtProvider: false });
    });

    it('is false when the e-mail user has no identities', async () => {
      await executor.batch([userStatement(a, 'U1', 'ada@example.test')]);
      const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
      expect(lookup.userByEmail).toEqual({ id: 'U1', status: 'active', linkedAtProvider: false });
    });

    it('ignores identities of other users at the provider', async () => {
      await executor.batch([
        userStatement(a, 'U1', 'ada@example.test'),
        userStatement(a, 'U2', 'bob@example.test'),
        identityStatement(a, 'I2', 'U2', 'okta', 'sub-2', 'bob@example.test'),
      ]);
      const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
      expect(lookup.userByEmail?.linkedAtProvider).toBe(false);
    });

    it('does not count an identity at the provider in the other organization', async () => {
      await executor.batch([
        userStatement(a, 'U1', 'ada@example.test'),
        userStatement(b, 'UB', 'ada@example.test'),
        identityStatement(b, 'IB', 'UB', 'okta', 'sub-9', 'ada@example.test'),
        identityStatement(b, 'IY', 'U1', 'okta', 'sub-y', 'ada@example.test'),
      ]);
      const repository = createUserRepository(executor);
      expect((await repository.lookupForLogin(a, INPUT)).userByEmail).toEqual({
        id: 'U1',
        status: 'active',
        linkedAtProvider: false,
      });
      expect((await repository.lookupForLogin(b, INPUT)).userByEmail).toEqual({
        id: 'UB',
        status: 'active',
        linkedAtProvider: true,
      });
    });
  });

  it('returns the binding of the asked provider only', async () => {
    await executor.batch([
      bindingStatement(a, 'github', 'anchor-github'),
      bindingStatement(a, 'okta', 'anchor-okta'),
    ]);
    const repository = createUserRepository(executor);
    expect((await repository.lookupForLogin(a, INPUT)).boundAnchor).toBe('anchor-okta');
    expect(
      (await repository.lookupForLogin(a, { ...INPUT, provider: 'gitlab' })).boundAnchor,
    ).toBeNull();
  });

  it('does not match a subject that differs in case', async () => {
    await executor.batch([
      userStatement(a, 'U1', 'ada@example.test'),
      identityStatement(a, 'I1', 'U1', 'okta', 'sub-1', 'ada@example.test'),
    ]);
    const repository = createUserRepository(executor);
    expect(
      (await repository.lookupForLogin(a, { ...INPUT, subject: 'Sub-1' })).identity,
    ).toBeNull();
    expect((await repository.lookupForLogin(a, INPUT)).identity?.id).toBe('I1');
  });

  it.each(['Ada@example.test', 'ADA@EXAMPLE.TEST', 'adA@example.test'])(
    'rejects the e-mail %s that is not lower case with TypeError',
    async (email) => {
      await expect(
        createUserRepository(executor).lookupForLogin(a, { ...INPUT, email }),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it.each([
    ['a high surrogate at the end', 'abc\ud800'],
    ['a low surrogate at the start', '\udc00abc'],
    ['a reversed pair', '\udc00\ud800'],
  ])('rejects a group with %s with TypeError', async (_name, group) => {
    await expect(
      createUserRepository(executor).lookupForLogin(a, { ...INPUT, groups: ['ok', group] }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it('accepts a group with a well-formed surrogate pair', async () => {
    await executor.batch([groupGrant(a, 'G1', 'okta', 'team-\u{1F642}', 'organization')]);
    const lookup = await createUserRepository(executor).lookupForLogin(a, {
      ...INPUT,
      groups: ['team-\u{1F642}'],
    });
    expect(lookup.invited).toBe(true);
  });

  describe('invited', () => {
    const cases: readonly {
      readonly name: string;
      readonly seed: () => Statement[];
      readonly input:
        typeof INPUT | { provider: string; subject: string; email: string; groups: string[] };
      readonly expected: boolean;
    }[] = [
      {
        name: 'organization e-mail grant',
        seed: () => [emailGrant(a, 'G1', 'ada@example.test', 'organization')],
        input: INPUT,
        expected: true,
      },
      {
        name: 'project e-mail grant',
        seed: () => [emailGrant(a, 'G1', 'ada@example.test', 'project')],
        input: INPUT,
        expected: true,
      },
      {
        name: 'e-mail grant for another e-mail',
        seed: () => [emailGrant(a, 'G1', 'bob@example.test', 'organization')],
        input: INPUT,
        expected: false,
      },
      {
        name: 'organization group grant with the same provider',
        seed: () => [groupGrant(a, 'G1', 'okta', 'admins', 'organization')],
        input: { ...INPUT, groups: ['readers', 'admins'] },
        expected: true,
      },
      {
        name: 'project group grant with the same provider',
        seed: () => [groupGrant(a, 'G1', 'okta', 'admins', 'project')],
        input: { ...INPUT, groups: ['admins'] },
        expected: true,
      },
      {
        name: 'the same group name under another provider',
        seed: () => [groupGrant(a, 'G1', 'github', 'admins', 'organization')],
        input: { ...INPUT, groups: ['admins'] },
        expected: false,
      },
      {
        name: 'a group grant when the person has no groups',
        seed: () => [groupGrant(a, 'G1', 'okta', 'admins', 'organization')],
        input: INPUT,
        expected: false,
      },
      {
        name: 'a group name differing in case',
        seed: () => [groupGrant(a, 'G1', 'okta', 'Admins', 'organization')],
        input: { ...INPUT, groups: ['admins'] },
        expected: false,
      },
      {
        name: 'a group grant whose name equals the e-mail',
        seed: () => [groupGrant(a, 'G1', 'okta', 'ada@example.test', 'organization')],
        input: INPUT,
        expected: false,
      },
      {
        name: 'an e-mail grant whose value equals a group name',
        seed: () => [emailGrant(a, 'G1', 'admins', 'organization')],
        input: { ...INPUT, groups: ['admins'] },
        expected: false,
      },
      {
        name: 'a group name with quotes, brackets and unicode',
        seed: () => [groupGrant(a, 'G1', 'okta', 'a"b\'c],[ żółć \\ 🙂', 'organization')],
        input: { ...INPUT, groups: ['x', 'a"b\'c],[ żółć \\ 🙂'] },
        expected: true,
      },
      {
        name: 'a group name that looks like a JSON array',
        seed: () => [groupGrant(a, 'G1', 'okta', '["admins"]', 'organization')],
        input: { ...INPUT, groups: ['admins'] },
        expected: false,
      },
      {
        name: 'duplicate groups in the input',
        seed: () => [groupGrant(a, 'G1', 'okta', 'admins', 'organization')],
        input: { ...INPUT, groups: ['admins', 'admins'] },
        expected: true,
      },
    ];

    for (const testCase of cases) {
      it(`is ${testCase.expected} for ${testCase.name}`, async () => {
        await executor.batch(testCase.seed());
        const lookup = await createUserRepository(executor).lookupForLogin(a, testCase.input);
        expect(lookup.invited).toBe(testCase.expected);
      });
    }

    it('is false for grants of the other organization', async () => {
      await executor.batch([
        emailGrant(b, 'G1', 'ada@example.test', 'organization'),
        groupGrant(b, 'G2', 'okta', 'admins', 'organization'),
        groupGrant(b, 'G3', 'okta', 'devs', 'project'),
      ]);
      const lookup = await createUserRepository(executor).lookupForLogin(a, {
        ...INPUT,
        groups: ['admins', 'devs'],
      });
      expect(lookup.invited).toBe(false);
      const other = await createUserRepository(executor).lookupForLogin(b, {
        ...INPUT,
        groups: ['admins'],
      });
      expect(other.invited).toBe(true);
    });

    it('ignores grants of an archived project and counts grants of an active project', async () => {
      await executor.batch([
        {
          sql: "INSERT INTO project (id, org_id, slug, name, status) VALUES (?, ?, ?, ?, 'archived')",
          params: ['01J0PROJX0000000000000000X', a.orgId, 'old', 'old'],
        },
        {
          sql: "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('GX1', ?, 'email', 'ada@example.test', NULL, 'project', '01J0PROJX0000000000000000X', ?), ('GX2', ?, 'group', 'admins', 'okta', 'project', '01J0PROJX0000000000000000X', ?)",
          params: [a.orgId, ROLE_A, a.orgId, ROLE_A],
        },
      ]);
      const repository = createUserRepository(executor);
      expect((await repository.lookupForLogin(a, INPUT)).invited).toBe(false);
      expect((await repository.lookupForLogin(a, { ...INPUT, groups: ['admins'] })).invited).toBe(
        false,
      );
      await executor.batch([emailGrant(a, 'G1', 'ada@example.test', 'project')]);
      expect((await repository.lookupForLogin(a, INPUT)).invited).toBe(true);
    });

    it('counts an organization grant while an archived project grant for the same e-mail exists', async () => {
      await executor.batch([
        {
          sql: "UPDATE project SET status = 'archived' WHERE id = ?",
          params: [PROJECT_A],
        },
        emailGrant(a, 'G1', 'ada@example.test', 'project'),
        groupGrant(a, 'G2', 'okta', 'admins', 'organization'),
      ]);
      const repository = createUserRepository(executor);
      expect((await repository.lookupForLogin(a, INPUT)).invited).toBe(false);
      expect((await repository.lookupForLogin(a, { ...INPUT, groups: ['admins'] })).invited).toBe(
        true,
      );
    });

    it('ignores project grants of this organization that reference a project of the other organization', async () => {
      await executor.batch([
        {
          sql: "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('GC1', ?, 'email', 'ada@example.test', NULL, 'project', ?, ?), ('GC2', ?, 'group', 'admins', 'okta', 'project', ?, ?)",
          params: [a.orgId, PROJECT_B, ROLE_A, a.orgId, PROJECT_B, ROLE_A],
        },
      ]);
      const repository = createUserRepository(executor);
      expect((await repository.lookupForLogin(a, INPUT)).invited).toBe(false);
      expect((await repository.lookupForLogin(a, { ...INPUT, groups: ['admins'] })).invited).toBe(
        false,
      );
      await executor.batch([
        emailGrant(a, 'G1', 'ada@example.test', 'project'),
        groupGrant(a, 'G2', 'okta', 'admins', 'project'),
      ]);
      expect((await repository.lookupForLogin(a, INPUT)).invited).toBe(true);
      expect((await repository.lookupForLogin(a, { ...INPUT, groups: ['admins'] })).invited).toBe(
        true,
      );
    });

    it('counts each branch on its own when the other branch only has a cross-organization project grant', async () => {
      await executor.batch([
        {
          sql: "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES ('GC1', ?, 'email', 'ada@example.test', NULL, 'project', ?, ?)",
          params: [a.orgId, PROJECT_B, ROLE_A],
        },
        groupGrant(a, 'G2', 'okta', 'admins', 'organization'),
      ]);
      const repository = createUserRepository(executor);
      expect((await repository.lookupForLogin(a, INPUT)).invited).toBe(false);
      expect((await repository.lookupForLogin(a, { ...INPUT, groups: ['admins'] })).invited).toBe(
        true,
      );
    });

    it('does not need an existing user', async () => {
      await executor.batch([emailGrant(a, 'G1', 'ada@example.test', 'organization')]);
      const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
      expect(lookup.userByEmail).toBeNull();
      expect(lookup.invited).toBe(true);
    });
  });

  describe('isolation', () => {
    it('sees nothing of the other organization', async () => {
      await executor.batch([
        userStatement(b, 'UB', 'ada@example.test'),
        identityStatement(b, 'IB', 'UB', 'okta', 'sub-1', 'ada@example.test'),
        bindingStatement(b, 'okta', 'anchor-b'),
      ]);
      const repository = createUserRepository(executor);
      expect(await repository.lookupForLogin(a, INPUT)).toEqual({
        boundAnchor: null,
        identity: null,
        identityUser: null,
        userByEmail: null,
        invited: false,
      });
      expect((await repository.lookupForLogin(b, INPUT)).identity?.id).toBe('IB');
    });

    it('returns no identity whose user belongs to the other organization', async () => {
      await executor.batch([
        userStatement(b, 'UB', 'ada@example.test'),
        identityStatement(a, 'IA', 'UB', 'okta', 'sub-1', 'ada@example.test'),
      ]);
      const lookup = await createUserRepository(executor).lookupForLogin(a, INPUT);
      expect(lookup.identity).toBeNull();
      expect(lookup.identityUser).toBeNull();
      expect(lookup.userByEmail).toBeNull();
    });
  });

  describe('statement shape', () => {
    function spy(): { executor: SqlExecutor; statements: Statement[]; batches: number } {
      const state = { statements: [] as Statement[], batches: 0 };
      const wrapped: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => {
          state.statements.push(statement);
          return executor.all(statement);
        },
        batch: (statements) => {
          state.batches += 1;
          return executor.batch(statements);
        },
      };
      return Object.assign(state, { executor: wrapped });
    }

    it('is one executor call with fewer than 100 parameters for 300 groups', async () => {
      const groups = Array.from({ length: 300 }, (_, index) => `group-${index}`);
      await executor.batch([groupGrant(a, 'G1', 'okta', 'group-299', 'project')]);
      const probe = spy();
      const lookup = await createUserRepository(probe.executor).lookupForLogin(a, {
        ...INPUT,
        groups,
      });
      expect(lookup.invited).toBe(true);
      expect(probe.statements).toHaveLength(1);
      expect(probe.batches).toBe(0);
      expect(probe.statements[0]?.params.length).toBeLessThan(100);
    });

    it('binds the groups as one JSON array and never ORs the grant branches', async () => {
      const probe = spy();
      await createUserRepository(probe.executor).lookupForLogin(a, {
        ...INPUT,
        groups: ['x', 'y'],
      });
      const statement = probe.statements[0];
      if (statement === undefined) throw new Error('no statement captured');
      const text = statement.sql.toLowerCase();
      expect(text).toContain('json_each');
      expect(text.match(/union all/g)).toHaveLength(1);
      expect(text).not.toMatch(/\bor\b/);
      expect(statement.params.filter((param) => param === '["x","y"]')).toHaveLength(1);
    });

    it('rejects a group that is not a string', async () => {
      await expect(
        createUserRepository(executor).lookupForLogin(a, {
          ...INPUT,
          groups: ['ok', 3 as unknown as string],
        }),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });
});

describe('getIdentity', () => {
  it('returns every field including validatedAt', async () => {
    await executor.batch([
      userStatement(a, 'U1', 'ada@example.test'),
      identityStatement(
        a,
        'I1',
        'U1',
        'okta',
        'sub-1',
        'ada@example.test',
        '2026-10-10T10:00:00.000Z',
      ),
      identityStatement(a, 'I2', 'U1', 'github', 'sub-2', 'ada@example.test'),
    ]);
    const repository = createUserRepository(executor);
    expect(await repository.getIdentity(a, 'I1')).toEqual({
      id: 'I1',
      userId: 'U1',
      provider: 'okta',
      subject: 'sub-1',
      email: 'ada@example.test',
      validatedAt: '2026-10-10T10:00:00.000Z',
    });
    expect((await repository.getIdentity(a, 'I2'))?.validatedAt).toBeNull();
  });

  it('is null for an unknown id and for an identity of the other organization', async () => {
    await executor.batch([
      userStatement(b, 'UB', 'ada@example.test'),
      identityStatement(b, 'IB', 'UB', 'okta', 'sub-1', 'ada@example.test'),
    ]);
    const repository = createUserRepository(executor);
    expect(await repository.getIdentity(a, 'missing')).toBeNull();
    expect(await repository.getIdentity(a, 'IB')).toBeNull();
    expect((await repository.getIdentity(b, 'IB'))?.userId).toBe('UB');
  });
});

describe('get', () => {
  it('returns the user with last_login_at of user_account', async () => {
    await executor.batch([
      userStatement(a, 'U1', 'ada@example.test', {
        displayName: 'Ada',
        lastLoginAt: '2026-10-12T09:00:00.000Z',
        createdAt: '2026-10-02T08:00:00.000Z',
      }),
      userStatement(a, 'U2', 'bob@example.test', { status: 'suspended' }),
    ]);
    const repository = createUserRepository(executor);
    expect(await repository.get(a, 'U1')).toEqual({
      id: 'U1',
      email: 'ada@example.test',
      displayName: 'Ada',
      status: 'active',
      lastLoginAt: '2026-10-12T09:00:00.000Z',
      createdAt: '2026-10-02T08:00:00.000Z',
    });
    expect(await repository.get(a, 'U2')).toMatchObject({
      displayName: null,
      status: 'suspended',
      lastLoginAt: null,
    });
  });

  it('is null for an unknown id and for a user of the other organization', async () => {
    await executor.batch([userStatement(b, 'UB', 'ada@example.test')]);
    const repository = createUserRepository(executor);
    expect(await repository.get(a, 'missing')).toBeNull();
    expect(await repository.get(a, 'UB')).toBeNull();
    expect((await repository.get(b, 'UB'))?.id).toBe('UB');
  });
});

describe('list', () => {
  beforeEach(async () => {
    await executor.batch([
      userStatement(a, 'U3', 'c@example.test'),
      userStatement(a, 'U1', 'a@example.test'),
      userStatement(a, 'U2', 'b@example.test', { status: 'suspended' }),
      userStatement(b, 'U0', 'z@example.test'),
      userStatement(b, 'U9', 'y@example.test'),
    ]);
  });

  it('orders by id and pages with afterId', async () => {
    const repository = createUserRepository(executor);
    expect(
      (await repository.list(a, { afterId: null, limit: 200 })).map((user) => user.id),
    ).toEqual(['U1', 'U2', 'U3']);
    expect((await repository.list(a, { afterId: null, limit: 2 })).map((user) => user.id)).toEqual([
      'U1',
      'U2',
    ]);
    expect((await repository.list(a, { afterId: 'U2', limit: 2 })).map((user) => user.id)).toEqual([
      'U3',
    ]);
    expect(await repository.list(a, { afterId: 'U3', limit: 2 })).toEqual([]);
  });

  it('maps the same fields as get', async () => {
    const repository = createUserRepository(executor);
    const [first] = await repository.list(a, { afterId: null, limit: 1 });
    expect(first).toEqual(await repository.get(a, 'U1'));
  });

  it('never returns users of the other organization', async () => {
    const repository = createUserRepository(executor);
    expect((await repository.list(b, { afterId: null, limit: 10 })).map((user) => user.id)).toEqual(
      ['U0', 'U9'],
    );
    expect(await repository.list(a, { afterId: 'U3', limit: 10 })).toEqual([]);
  });

  it.each([0, -1, 201, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects limit %s with RangeError',
    async (limit) => {
      await expect(
        createUserRepository(executor).list(a, { afterId: null, limit }),
      ).rejects.toBeInstanceOf(RangeError);
    },
  );

  it('accepts the limits 1 and 200', async () => {
    const repository = createUserRepository(executor);
    expect(await repository.list(a, { afterId: null, limit: 1 })).toHaveLength(1);
    expect(await repository.list(a, { afterId: null, limit: 200 })).toHaveLength(3);
  });
});

describe('invitation predicate at spike scale', () => {
  interface Grant {
    readonly orgId: string;
    readonly type: 'email' | 'group';
    readonly provider: string | null;
    readonly value: string;
    readonly scope: 'organization' | 'project';
  }

  function generator(seed: number): () => number {
    let state = seed;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 0x100000000;
    };
  }

  const PROVIDERS = ['okta', 'github', 'gitlab', 'access'];

  async function seedScale(): Promise<{
    grants: Grant[];
    random: () => number;
    memberships: number;
  }> {
    const random = generator(20261015);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)] as T;
    const orgs = [a, b];
    const roles = new Map([
      [a.orgId, ROLE_A],
      [b.orgId, ROLE_B],
    ]);
    const projects = new Map([
      [a.orgId, PROJECT_A],
      [b.orgId, PROJECT_B],
    ]);
    const statements: Statement[] = [];

    const users = Array.from({ length: 400 }, (_, index) => ({
      id: `SU${String(index).padStart(5, '0')}`,
      email: `person${index}@example.test`,
      org: pick(orgs),
    }));
    for (const user of users) statements.push(userStatement(user.org, user.id, user.email));

    let memberships = 0;
    const seenMembership = new Set<string>();
    while (memberships < 1200) {
      const user = pick(users);
      const provider = pick(PROVIDERS);
      const group = `group-${Math.floor(random() * 300)}`;
      const key = `${user.id}|${provider}|${group}`;
      if (seenMembership.has(key)) continue;
      seenMembership.add(key);
      statements.push(membershipStatement(user.org, user.id, provider, group));
      memberships += 1;
    }

    const grants: Grant[] = [];
    const seenGrant = new Set<string>();
    let sequence = 0;
    while (grants.length < 700) {
      const orgId = pick(orgs).orgId;
      const scope = pick(['organization', 'project'] as const);
      const grant: Grant =
        random() < 0.4
          ? {
              orgId,
              type: 'email',
              provider: null,
              value: `person${Math.floor(random() * 600)}@example.test`,
              scope,
            }
          : {
              orgId,
              type: 'group',
              provider: pick(PROVIDERS),
              value: `group-${Math.floor(random() * 500)}`,
              scope,
            };
      const key =
        grant.scope === 'organization'
          ? `${grant.orgId}|${grant.type}|${grant.provider}|${grant.value}|org`
          : `${grant.orgId}|${grant.type}|${grant.provider}|${grant.value}|project`;
      if (seenGrant.has(key)) continue;
      seenGrant.add(key);
      grants.push(grant);
      const project = grant.scope === 'project' ? projects.get(orgId) : null;
      statements.push({
        sql: 'INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, project_id, role_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        params: [
          `SG${String(sequence).padStart(5, '0')}`,
          orgId,
          grant.type,
          grant.value,
          grant.provider,
          grant.scope,
          project ?? null,
          roles.get(orgId) ?? '',
        ],
      });
      sequence += 1;
    }

    for (let start = 0; start < statements.length; start += 400) {
      await executor.batch(statements.slice(start, start + 400));
    }
    return { grants, random, memberships };
  }

  function expected(
    grants: readonly Grant[],
    ctx: OrgContext,
    input: { provider: string; email: string; groups: readonly string[] },
  ): boolean {
    return grants.some(
      (grant) =>
        grant.orgId === ctx.orgId &&
        ((grant.type === 'email' && grant.value === input.email) ||
          (grant.type === 'group' &&
            grant.provider === input.provider &&
            input.groups.includes(grant.value))),
    );
  }

  async function compareAgainstGroundTruth(
    grants: readonly Grant[],
    random: () => number,
  ): Promise<{ invited: number; refused: number }> {
    const repository = createUserRepository(executor);
    let invited = 0;
    let refused = 0;
    for (let round = 0; round < 300; round += 1) {
      const ctx = random() < 0.5 ? a : b;
      const groups = Array.from(
        { length: Math.floor(random() * 12) },
        () => `group-${Math.floor(random() * 500)}`,
      );
      const input = {
        provider: PROVIDERS[Math.floor(random() * PROVIDERS.length)] as string,
        subject: `subject-${round}`,
        email: `person${Math.floor(random() * 600)}@example.test`,
        groups,
      };
      const lookup = await repository.lookupForLogin(ctx, input);
      expect(lookup.invited, JSON.stringify({ round, input })).toBe(expected(grants, ctx, input));
      if (lookup.invited) invited += 1;
      else refused += 1;
    }
    return { invited, refused };
  }

  it('matches a JavaScript ground truth before and after ANALYZE', async () => {
    const { grants, random, memberships } = await seedScale();
    expect(memberships).toBeGreaterThanOrEqual(1000);
    expect(grants.length).toBeGreaterThanOrEqual(600);

    const before = await compareAgainstGroundTruth(grants, random);
    await database.analyze();
    const after = await compareAgainstGroundTruth(grants, random);

    for (const outcome of [before, after]) {
      expect(outcome.invited).toBeGreaterThan(20);
      expect(outcome.refused).toBeGreaterThan(20);
    }
  });

  it('searches both grant branches on the full index key, before and after ANALYZE', async () => {
    await seedScale();
    const probe: Statement[] = [];
    const wrapped: SqlExecutor = {
      driver: executor.driver,
      all: (statement) => {
        probe.push(statement);
        return executor.all(statement);
      },
      batch: (statements) => executor.batch(statements),
    };
    const repository = createUserRepository(wrapped);
    const input = { ...INPUT, groups: ['group-1', 'group-2', 'group-3'] };

    async function plan(): Promise<string[]> {
      probe.length = 0;
      await repository.lookupForLogin(a, input);
      const statement = probe[0];
      if (statement === undefined) throw new Error('no statement captured');
      const rows = await executor.all<{ detail: string }>({
        sql: `EXPLAIN QUERY PLAN ${statement.sql}`,
        params: statement.params,
      });
      return rows.map((row) => row.detail);
    }

    function searchOf(details: readonly string[], table: string): string {
      const found = details.find((detail) => detail.startsWith(`SEARCH ${table} USING`));
      if (found === undefined) throw new Error(`no SEARCH of ${table} in the plan`);
      return found;
    }

    for (const phase of ['before ANALYZE', 'after ANALYZE']) {
      if (phase === 'after ANALYZE') await database.analyze();
      const details = await plan();
      expect(
        details.filter((detail) => /^SCAN (email|group)_grant/.test(detail)),
        phase,
      ).toEqual([]);
      for (const table of ['email_grant', 'group_grant']) {
        const search = searchOf(details, table);
        expect(search, phase).toContain('INDEX');
        expect(search, phase).toContain('subject_value=?');
        expect(search, phase).not.toContain('ANY(');
      }
    }
  });
});
