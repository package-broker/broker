import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  type AuthenticatedActor,
  type FenceGuard,
} from '@package-broker/core/authz/fence';
import {
  orgContext,
  type OrgContext,
  type SqlExecutor,
  type Statement,
} from '@package-broker/core/db/port';
import { assertGuard, existsGuard } from '../kysely.js';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import {
  createServicePrincipalRepository,
  type ServicePrincipalRepository,
} from './service-principal.js';

const NOW = '2026-10-15T12:00:00.000Z';
const LATER = '2026-10-15T13:00:00.000Z';

const U1 = '01J0USER000000000000000001';
const UB = '01J0USER00000000000000000B';
const PROJECT = '01J0PROJECT00000000000000AA';
const PROJECT_B = '01J0PROJECT00000000000000BB';
const SP1 = '01J0SERVICEPRINCIPAL0000A1';
const SP2 = '01J0SERVICEPRINCIPAL0000A2';
const SP3 = '01J0SERVICEPRINCIPAL0000A3';

let database: MigratedDatabase;
let a: OrgContext;
let b: OrgContext;
let executor: SqlExecutor;
let principals: ServicePrincipalRepository;

function stmt(sql: string, ...params: Statement['params']): Statement {
  return { sql, params };
}

async function rows(sql: string, ...params: Statement['params']): Promise<unknown[]> {
  return executor.all(stmt(sql, ...params));
}

async function snapshot(): Promise<string> {
  return JSON.stringify([
    await rows('SELECT * FROM service_principal ORDER BY id'),
    await rows(
      'SELECT * FROM service_principal_permission ORDER BY service_principal_id, permission',
    ),
  ]);
}

function actor(): AuthenticatedActor {
  return { userId: U1, sessionId: 'session-1' } as unknown as AuthenticatedActor;
}

function setGuard(principalId: string, expectedRevision: number, userId = U1): FenceGuard {
  return assertGuard(
    existsGuard((database) =>
      database
        .selectFrom('service_principal as sp')
        .innerJoin('user_account as actor', (join) =>
          join.onRef('actor.org_id', '=', 'sp.org_id').on('actor.id', '=', userId),
        )
        .select('sp.id')
        .where('sp.org_id', '=', a.orgId)
        .where('sp.id', '=', principalId)
        .where('sp.revision', '=', expectedRevision)
        .where('actor.status', '=', 'active'),
    ),
    a,
  );
}

function actorGuard(userId = U1, orgId = a.orgId): FenceGuard {
  return assertGuard(
    existsGuard((database) =>
      database
        .selectFrom('user_account')
        .select('id')
        .where('org_id', '=', orgId)
        .where('id', '=', userId)
        .where('status', '=', 'active'),
    ),
    orgContext(orgId),
  );
}

const NO_REVISION = (): ReturnType<typeof mutationFence> => mutationFence(actor(), {});

function create(overrides: Partial<Parameters<ServicePrincipalRepository['create']>[3]> = {}) {
  return principals.create(a, NO_REVISION(), actorGuard(), {
    opId: 'op-create',
    id: SP1,
    name: 'ci',
    projectId: PROJECT,
    createdByUserId: U1,
    permissions: ['project:packages:read', 'project:packages:write'],
    now: NOW,
    ...overrides,
  });
}

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  if (database.orgs === null) throw new Error('two organizations were not seeded');
  ({ a, b } = database.orgs);
  executor = database.executor;
  principals = createServicePrincipalRepository(executor);
  await executor.batch([
    stmt(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      U1,
      a.orgId,
      'u1@example.test',
    ),
    stmt(
      'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
      UB,
      b.orgId,
      'b@example.test',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      PROJECT,
      a.orgId,
      'alpha',
      'alpha',
    ),
    stmt(
      'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
      PROJECT_B,
      b.orgId,
      'beta',
      'beta',
    ),
  ]);
});

afterEach(async () => {
  await database.close();
});

describe('create', () => {
  it('stores the principal and exactly its permission rows', async () => {
    expect(await create()).toBe('created');
    expect(await principals.get(a, SP1)).toEqual({
      id: SP1,
      name: 'ci',
      projectId: PROJECT,
      createdByUserId: U1,
      status: 'active',
      revision: 1,
      permissions: ['project:packages:read', 'project:packages:write'],
    });
    expect(
      await rows('SELECT permission FROM service_principal_permission ORDER BY permission'),
    ).toHaveLength(2);
  });

  it('stores an organization-wide principal with organization permissions', async () => {
    expect(await create({ projectId: null, permissions: ['org:read'] })).toBe('created');
    expect((await principals.get(a, SP1))?.projectId).toBeNull();
  });

  it('stores a principal with no permissions', async () => {
    expect(await create({ permissions: [] })).toBe('created');
    expect((await principals.get(a, SP1))?.permissions).toEqual([]);
  });

  it('answers duplicate for an existing name and stores nothing new', async () => {
    await create();
    const before = await snapshot();
    expect(await create({ id: SP2, permissions: ['project:packages:read'] })).toBe('duplicate');
    expect(await snapshot()).toBe(before);
  });

  it('answers duplicate for an existing id and leaves its permissions alone', async () => {
    await create();
    const before = await snapshot();
    expect(await create({ name: 'other', permissions: ['project:packages:read'] })).toBe(
      'duplicate',
    );
    expect(await snapshot()).toBe(before);
  });

  it('refuses a project of another organization and stores nothing', async () => {
    expect(await create({ projectId: PROJECT_B })).toBe('project_mismatch');
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
    expect(await rows('SELECT 1 FROM service_principal_permission')).toEqual([]);
  });

  it('refuses an unknown project', async () => {
    expect(await create({ projectId: '01J0PROJECT00000000000000ZZ' })).toBe('project_mismatch');
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
  });

  it('refuses unknown permissions and organization permissions on a project principal', async () => {
    expect(await create({ permissions: ['packages:fly'] })).toBe('invalid_permissions');
    expect(await create({ permissions: ['org:read'] })).toBe('invalid_permissions');
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
  });

  it('refuses session-only permissions for project and organization principals', async () => {
    expect(await create({ permissions: ['project:tokens:create'] })).toBe('invalid_permissions');
    expect(await create({ projectId: null, permissions: ['org:service-principals:write'] })).toBe(
      'invalid_permissions',
    );
    expect(await create({ projectId: null, permissions: ['org:roles:write'] })).toBe(
      'invalid_permissions',
    );
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
  });

  it('refuses a project that is not active', async () => {
    await executor.batch([stmt("UPDATE project SET status = 'archived' WHERE id = ?", PROJECT)]);
    expect(await create()).toBe('project_mismatch');
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
  });

  it('rolls back everything when the caller guard refuses', async () => {
    const before = await snapshot();
    expect(
      await principals.create(a, NO_REVISION(), actorGuard('01J0USER0000000000000000ZZ'), {
        id: SP1,
        name: 'ci',
        projectId: PROJECT,
        createdByUserId: U1,
        permissions: ['project:packages:read'],
        now: NOW,
        opId: 'op-create',
      }),
    ).toBe('authority');
    expect(await snapshot()).toBe(before);
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
  });

  it('does not add permission rows when an empty create is replayed with permissions', async () => {
    expect(await create({ permissions: [] })).toBe('created');
    const before = await snapshot();
    expect(await create({ permissions: ['project:packages:read'], opId: 'op-replay' })).toBe(
      'duplicate',
    );
    expect(await snapshot()).toBe(before);
    expect(await create({ permissions: ['project:packages:read'] })).toBe('duplicate');
    expect(await snapshot()).toBe(before);
  });

  it('rejects an empty id or opId', async () => {
    await expect(create({ id: '' })).rejects.toThrow(TypeError);
    await expect(create({ opId: '' })).rejects.toThrow(TypeError);
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
  });

  it('throws for a creator of another organization and stores nothing', async () => {
    await expect(create({ createdByUserId: UB })).rejects.toThrow(TypeError);
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
    expect(await rows('SELECT 1 FROM service_principal_permission')).toEqual([]);
  });

  it('rejects malformed names and timestamps', async () => {
    await expect(create({ name: '' })).rejects.toThrow(TypeError);
    await expect(create({ name: 'a\u0000b' })).rejects.toThrow(TypeError);
    await expect(create({ now: 'yesterday' })).rejects.toThrow(TypeError);
  });

  it('keeps names unique per organization only', async () => {
    await create();
    expect(
      await principals.create(b, NO_REVISION(), actorGuard(UB, b.orgId), {
        opId: 'op-b',
        id: SP3,
        name: 'ci',
        projectId: null,
        createdByUserId: UB,
        permissions: [],
        now: NOW,
      }),
    ).toBe('created');
  });
});

describe('creator independence', () => {
  it('leaves the principal active in storage when the creator is suspended', async () => {
    await create();
    await executor.batch([stmt("UPDATE user_account SET status = 'suspended' WHERE id = ?", U1)]);
    const found = await principals.get(a, SP1);
    expect(found?.status).toBe('active');
    expect(found?.permissions).toEqual(['project:packages:read', 'project:packages:write']);
    expect(found?.revision).toBe(1);
  });
});

describe('suspend and restore', () => {
  const stop = (ctx: OrgContext = a, guard: FenceGuard = actorGuard(), now = LATER) =>
    principals.suspend(ctx, NO_REVISION(), guard, SP1, now, 'op-stop');
  const resume = (ctx: OrgContext = a, guard: FenceGuard = actorGuard()) =>
    principals.restore(ctx, NO_REVISION(), guard, SP1, LATER, 'op-resume');

  it('suspends without touching permissions, stamps the op, and restores', async () => {
    await create();
    expect(await stop()).toBe('suspended');
    const suspended = await principals.get(a, SP1);
    expect(suspended?.status).toBe('suspended');
    expect(suspended?.permissions).toEqual(['project:packages:read', 'project:packages:write']);
    expect(suspended?.revision).toBe(2);
    expect(await rows('SELECT last_op_id FROM service_principal WHERE id = ?', SP1)).toEqual([
      { last_op_id: 'op-stop' },
    ]);
    expect(await resume()).toBe('restored');
    expect((await principals.get(a, SP1))?.status).toBe('active');
  });

  it('does not rewrite a suspended principal and reports not_suspended on restore of an active one', async () => {
    await create();
    expect(await resume()).toBe('not_suspended');
    await stop();
    const before = await snapshot();
    expect(await stop(a, actorGuard(), '2026-10-15T14:00:00.000Z')).toBe('suspended');
    expect(await snapshot()).toBe(before);
  });

  it('rolls back when the caller guard refuses', async () => {
    await create();
    const before = await snapshot();
    const outsider = actorGuard('01J0USER0000000000000000ZZ');
    expect(await stop(a, outsider)).toBe('authority');
    expect(await snapshot()).toBe(before);
    await stop();
    const suspended = await snapshot();
    expect(await resume(a, outsider)).toBe('authority');
    expect(await snapshot()).toBe(suspended);
  });

  it('does not reach a principal of another organization', async () => {
    await create();
    const before = await snapshot();
    const guard = actorGuard(UB, b.orgId);
    expect(await stop(b, guard)).toBe('not_found');
    expect(await resume(b, guard)).toBe('not_found');
    expect(await principals.get(b, SP1)).toBeNull();
    expect(await snapshot()).toBe(before);
  });

  it('rejects an empty opId', async () => {
    await create();
    await expect(
      principals.suspend(a, NO_REVISION(), actorGuard(), SP1, LATER, ''),
    ).rejects.toThrow(TypeError);
  });

  it('leaves other principals and tokens alone', async () => {
    await create();
    await create({ id: SP2, name: 'other' });
    await stop();
    expect((await principals.get(a, SP2))?.status).toBe('active');
  });
});

describe('creator retention', () => {
  it('refuses to delete the creator while the principal exists', async () => {
    await create();
    await expect(
      executor.batch([stmt('DELETE FROM user_account WHERE id = ?', U1)]),
    ).rejects.toThrow();
    expect(await rows('SELECT id FROM user_account WHERE id = ?', U1)).toHaveLength(1);
  });
});

describe('setPermissions', () => {
  it('replaces the set and bumps the revision when the expected revision holds', async () => {
    await create();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(
        a,
        fence,
        setGuard(SP1, 1),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).toBe('updated');
    const found = await principals.get(a, SP1);
    expect(found?.permissions).toEqual(['project:packages:read']);
    expect(found?.revision).toBe(2);
    expect(await rows('SELECT last_op_id FROM service_principal WHERE id = ?', SP1)).toEqual([
      { last_op_id: 'op-1' },
    ]);
  });

  it('answers conflict and changes nothing when the guard refuses on a stale revision', async () => {
    await create();
    await principals.suspend(a, NO_REVISION(), actorGuard(), SP1, LATER, 'op-s');
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(
        a,
        fence,
        setGuard(SP1, 1),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('answers conflict when the expected revision is stale, and succeeds on the fresh one', async () => {
    await create();
    await principals.suspend(a, NO_REVISION(), actorGuard(), SP1, LATER, 'op-s');
    await principals.restore(a, NO_REVISION(), actorGuard(), SP1, LATER, 'op-r');
    const before = await snapshot();
    const stale = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(
        a,
        stale,
        setGuard(SP1, 1),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
    const fresh = mutationFence(actor(), { service_principal: 3 });
    expect(
      await principals.setPermissions(
        a,
        fresh,
        setGuard(SP1, 3),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-2',
      ),
    ).toBe('updated');
    expect((await principals.get(a, SP1))?.revision).toBe(4);
  });

  it('refuses a replayed revision after a successful change', async () => {
    await create();
    const fence = mutationFence(actor(), { service_principal: 1 });
    const guard = setGuard(SP1, 1);
    expect(
      await principals.setPermissions(
        a,
        fence,
        guard,
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).toBe('updated');
    const before = await snapshot();
    expect(await principals.setPermissions(a, fence, guard, SP1, [], LATER, 'op-2')).toBe(
      'conflict',
    );
    expect(await snapshot()).toBe(before);
  });

  it('refuses and writes nothing when the acting user is suspended', async () => {
    await create();
    await rows("UPDATE user_account SET status = 'suspended' WHERE id = ?", U1);
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(
        a,
        fence,
        setGuard(SP1, 1),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('refuses when the acting user belongs to another organization', async () => {
    await create();
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(
        a,
        fence,
        setGuard(SP1, 1, UB),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('throws when the fence carries no service_principal revision', async () => {
    await create();
    const before = await snapshot();
    await expect(
      principals.setPermissions(
        a,
        NO_REVISION(),
        actorGuard(),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).rejects.toThrow(TypeError);
    expect(await snapshot()).toBe(before);
  });

  it('enforces its own revision check when the caller guard is for another principal', async () => {
    await create();
    await create({ id: SP2, name: 'other' });
    await principals.suspend(a, NO_REVISION(), actorGuard(), SP1, LATER, 'op-s');
    const before = await snapshot();
    expect(
      await principals.setPermissions(
        a,
        mutationFence(actor(), { service_principal: 1 }),
        setGuard(SP2, 1),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('answers authority when the revision is current but the caller guard refuses', async () => {
    await create();
    const before = await snapshot();
    expect(
      await principals.setPermissions(
        a,
        mutationFence(actor(), { service_principal: 1 }),
        actorGuard('01J0USER0000000000000000ZZ'),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('refuses session-only permissions', async () => {
    await create();
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    for (const name of ['project:tokens:create', 'project:packages:manage']) {
      expect(
        await principals.setPermissions(a, fence, setGuard(SP1, 1), SP1, [name], LATER, 'op-1'),
      ).toBe('invalid_permissions');
    }
    expect(await snapshot()).toBe(before);
  });

  it('rejects an empty opId', async () => {
    await create();
    await expect(
      principals.setPermissions(
        a,
        mutationFence(actor(), { service_principal: 1 }),
        setGuard(SP1, 1),
        SP1,
        [],
        LATER,
        '',
      ),
    ).rejects.toThrow(TypeError);
  });

  it('answers not_found for another organization without writing', async () => {
    await create();
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(
        b,
        fence,
        setGuard(SP1, 1),
        SP1,
        ['project:packages:read'],
        LATER,
        'op-1',
      ),
    ).toBe('not_found');
    expect(await snapshot()).toBe(before);
  });

  it('refuses unknown permissions and organization permissions on a project principal', async () => {
    await create();
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(
        a,
        fence,
        setGuard(SP1, 1),
        SP1,
        ['packages:fly'],
        LATER,
        'op-1',
      ),
    ).toBe('invalid_permissions');
    expect(
      await principals.setPermissions(a, fence, setGuard(SP1, 1), SP1, ['org:read'], LATER, 'op-1'),
    ).toBe('invalid_permissions');
    expect(await snapshot()).toBe(before);
  });

  it('never changes the project binding', async () => {
    await create();
    const fence = mutationFence(actor(), { service_principal: 1 });
    await principals.setPermissions(a, fence, setGuard(SP1, 1), SP1, [], LATER, 'op-1');
    expect((await principals.get(a, SP1))?.projectId).toBe(PROJECT);
  });
});

describe('cache_epoch', () => {
  const epoch = async (ctx: OrgContext): Promise<string | undefined> =>
    (
      (await rows('SELECT version FROM cache_epoch WHERE org_id = ?', ctx.orgId)) as {
        version: string;
      }[]
    )[0]?.version;

  async function versions(): Promise<[string | undefined, string | undefined]> {
    return [await epoch(a), await epoch(b)];
  }

  it('changes only the ctx organization epoch after a committed create', async () => {
    const [beforeA, beforeB] = await versions();
    expect(await create()).toBe('created');
    const [afterA, afterB] = await versions();
    expect(afterA).not.toBe(beforeA);
    expect(afterB).toBe(beforeB);
  });

  it('changes the epoch after committed setPermissions and suspend', async () => {
    await create();
    const created = await epoch(a);
    const fence = mutationFence(actor(), { service_principal: 1 });
    await principals.setPermissions(a, fence, setGuard(SP1, 1), SP1, [], LATER, 'op-1');
    const updated = await epoch(a);
    expect(updated).not.toBe(created);
    await principals.suspend(a, NO_REVISION(), actorGuard(), SP1, LATER, 'op-stop');
    expect(await epoch(a)).not.toBe(updated);
  });

  it('leaves the epoch unchanged on authority and conflict refusals', async () => {
    await create();
    const before = await versions();
    const outsider = actorGuard('01J0USER0000000000000000ZZ');
    expect(await principals.suspend(a, NO_REVISION(), outsider, SP1, LATER, 'op-x')).toBe(
      'authority',
    );
    const stale = mutationFence(actor(), { service_principal: 9 });
    expect(await principals.setPermissions(a, stale, actorGuard(), SP1, [], LATER, 'op-y')).toBe(
      'conflict',
    );
    expect(await versions()).toEqual(before);
  });

  it('bumps exactly once in a setPermissions batch', async () => {
    await create();
    const batches: (readonly Statement[])[] = [];
    const spy = new Proxy(executor, {
      get(target, property, receiver) {
        if (property === 'batch') {
          return (statements: readonly Statement[]) => {
            batches.push(statements);
            return target.batch(statements);
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const repository = createServicePrincipalRepository(spy);
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await repository.setPermissions(a, fence, setGuard(SP1, 1), SP1, [], LATER, 'op-1'),
    ).toBe('updated');
    const bumps = (batches[0] ?? []).filter((s) => s.sql.startsWith('update "cache_epoch"'));
    expect(bumps).toHaveLength(1);
  });

  it('refuses a guard built for another organization and stores nothing', async () => {
    const before = await snapshot();
    const epochs = await versions();
    const foreign = actorGuard(UB, b.orgId);
    await expect(
      principals.create(a, NO_REVISION(), foreign, {
        opId: 'op-create',
        id: SP1,
        name: 'ci',
        projectId: PROJECT,
        createdByUserId: U1,
        permissions: ['project:packages:read'],
        now: NOW,
      }),
    ).rejects.toThrow(TypeError);
    expect(await snapshot()).toBe(before);
    expect(await versions()).toEqual(epochs);
  });

  it('throws a deployment fault, not authority, when the epoch row is missing', async () => {
    await executor.batch([stmt('DELETE FROM cache_epoch WHERE org_id = ?', a.orgId)]);
    await expect(create()).rejects.toThrow(/cache_epoch/);
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
  });
});
