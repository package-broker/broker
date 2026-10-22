import { auditEvent, type AuditAction } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mutationFence,
  type AuthenticatedActor,
  type FenceGuard,
} from '@package-broker/core/authz/fence';
import { DbError, classifySqliteError } from '@package-broker/core/db/errors';
import {
  orgContext,
  type OrgContext,
  type SqlExecutor,
  type Statement,
} from '@package-broker/core/db/port';
import type { ServicePrincipalStore } from '@package-broker/core/authz/service-principal-service';
import { assertGuard, existsGuard } from '../kysely.js';
import { describeServicePrincipalContract } from '../contract/service-principal-contract.js';
import { openNodeSqliteExecutor } from '../testing/node-sqlite-executor.js';
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
    audit: mutationAudit(),
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
        audit: mutationAudit('service_principal.create'),
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
        audit: mutationAudit('service_principal.create'),
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

it('is assignable to the service port', () => {
  const port: ServicePrincipalStore = createServicePrincipalRepository(executor);
  expect(port).toBeDefined();
});

describe('suspend and restore', () => {
  const stop = (ctx: OrgContext = a, guard: FenceGuard = actorGuard(), now = LATER) =>
    principals.suspend(ctx, NO_REVISION(), guard, {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: now,
      opId: 'op-stop',
    });
  const resume = (ctx: OrgContext = a, guard: FenceGuard = actorGuard()) =>
    principals.restore(ctx, NO_REVISION(), guard, {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: LATER,
      opId: 'op-resume',
    });

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
    expect(await stop(a, actorGuard(), '2026-10-15T14:00:00.000Z')).toBe('unchanged');
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
      principals.suspend(a, NO_REVISION(), actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: LATER,
        opId: '',
      }),
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
      await principals.setPermissions(a, fence, setGuard(SP1, 1), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['project:packages:read'],
        now: LATER,
        opId: 'op-1',
      }),
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
    await principals.suspend(a, NO_REVISION(), actorGuard(), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: LATER,
      opId: 'op-s',
    });
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(a, fence, setGuard(SP1, 1), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['project:packages:read'],
        now: LATER,
        opId: 'op-1',
      }),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('answers conflict when the expected revision is stale, and succeeds on the fresh one', async () => {
    await create();
    await principals.suspend(a, NO_REVISION(), actorGuard(), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: LATER,
      opId: 'op-s',
    });
    await principals.restore(a, NO_REVISION(), actorGuard(), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: LATER,
      opId: 'op-r',
    });
    const before = await snapshot();
    const stale = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(a, stale, setGuard(SP1, 1), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['project:packages:read'],
        now: LATER,
        opId: 'op-1',
      }),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
    const fresh = mutationFence(actor(), { service_principal: 3 });
    expect(
      await principals.setPermissions(a, fresh, setGuard(SP1, 3), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['project:packages:read'],
        now: LATER,
        opId: 'op-2',
      }),
    ).toBe('updated');
    expect((await principals.get(a, SP1))?.revision).toBe(4);
  });

  it('refuses a replayed revision after a successful change', async () => {
    await create();
    const fence = mutationFence(actor(), { service_principal: 1 });
    const guard = setGuard(SP1, 1);
    expect(
      await principals.setPermissions(a, fence, guard, {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['project:packages:read'],
        now: LATER,
        opId: 'op-1',
      }),
    ).toBe('updated');
    const before = await snapshot();
    expect(
      await principals.setPermissions(a, fence, guard, {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: [],
        now: LATER,
        opId: 'op-2',
      }),
    ).toBe('conflict');
    expect(await snapshot()).toBe(before);
  });

  it('refuses and writes nothing when the acting user is suspended', async () => {
    await create();
    await rows("UPDATE user_account SET status = 'suspended' WHERE id = ?", U1);
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(a, fence, setGuard(SP1, 1), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['project:packages:read'],
        now: LATER,
        opId: 'op-1',
      }),
    ).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('refuses when the acting user belongs to another organization', async () => {
    await create();
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(a, fence, setGuard(SP1, 1, UB), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['project:packages:read'],
        now: LATER,
        opId: 'op-1',
      }),
    ).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('throws when the fence carries no service_principal revision', async () => {
    await create();
    const before = await snapshot();
    await expect(
      principals.setPermissions(a, NO_REVISION(), actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['project:packages:read'],
        now: LATER,
        opId: 'op-1',
      }),
    ).rejects.toThrow(TypeError);
    expect(await snapshot()).toBe(before);
  });

  it('enforces its own revision check when the caller guard is for another principal', async () => {
    await create();
    await create({ id: SP2, name: 'other' });
    await principals.suspend(a, NO_REVISION(), actorGuard(), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: LATER,
      opId: 'op-s',
    });
    const before = await snapshot();
    expect(
      await principals.setPermissions(
        a,
        mutationFence(actor(), { service_principal: 1 }),
        setGuard(SP2, 1),
        {
          audit: mutationAudit('service_principal.create'),
          id: SP1,
          permissions: ['project:packages:read'],
          now: LATER,
          opId: 'op-1',
        },
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
        {
          audit: mutationAudit('service_principal.create'),
          id: SP1,
          permissions: ['project:packages:read'],
          now: LATER,
          opId: 'op-1',
        },
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
        await principals.setPermissions(a, fence, setGuard(SP1, 1), {
          audit: mutationAudit('service_principal.create'),
          id: SP1,
          permissions: [name],
          now: LATER,
          opId: 'op-1',
        }),
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
        {
          audit: mutationAudit('service_principal.create'),
          id: SP1,
          permissions: [],
          now: LATER,
          opId: '',
        },
      ),
    ).rejects.toThrow(TypeError);
  });

  it('answers not_found for another organization without writing', async () => {
    await create();
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(b, fence, setGuard(SP1, 1), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['project:packages:read'],
        now: LATER,
        opId: 'op-1',
      }),
    ).toBe('not_found');
    expect(await snapshot()).toBe(before);
  });

  it('refuses unknown permissions and organization permissions on a project principal', async () => {
    await create();
    const before = await snapshot();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await principals.setPermissions(a, fence, setGuard(SP1, 1), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['packages:fly'],
        now: LATER,
        opId: 'op-1',
      }),
    ).toBe('invalid_permissions');
    expect(
      await principals.setPermissions(a, fence, setGuard(SP1, 1), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: ['org:read'],
        now: LATER,
        opId: 'op-1',
      }),
    ).toBe('invalid_permissions');
    expect(await snapshot()).toBe(before);
  });

  it('never changes the project binding', async () => {
    await create();
    const fence = mutationFence(actor(), { service_principal: 1 });
    await principals.setPermissions(a, fence, setGuard(SP1, 1), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      permissions: [],
      now: LATER,
      opId: 'op-1',
    });
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
    await principals.setPermissions(a, fence, setGuard(SP1, 1), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      permissions: [],
      now: LATER,
      opId: 'op-1',
    });
    const updated = await epoch(a);
    expect(updated).not.toBe(created);
    await principals.suspend(a, NO_REVISION(), actorGuard(), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: LATER,
      opId: 'op-stop',
    });
    expect(await epoch(a)).not.toBe(updated);
  });

  it('leaves the epoch unchanged on authority and conflict refusals', async () => {
    await create();
    const before = await versions();
    const outsider = actorGuard('01J0USER0000000000000000ZZ');
    expect(
      await principals.suspend(a, NO_REVISION(), outsider, {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: LATER,
        opId: 'op-x',
      }),
    ).toBe('authority');
    const stale = mutationFence(actor(), { service_principal: 9 });
    expect(
      await principals.setPermissions(a, stale, actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: [],
        now: LATER,
        opId: 'op-y',
      }),
    ).toBe('conflict');
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
      await repository.setPermissions(a, fence, setGuard(SP1, 1), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        permissions: [],
        now: LATER,
        opId: 'op-1',
      }),
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
        audit: mutationAudit('service_principal.create'),
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

describe('createdBy', () => {
  function principalRow(
    id: string,
    orgId: string,
    name: string,
    projectId: string | null,
    by: string,
  ) {
    return stmt(
      'INSERT INTO service_principal (id, org_id, name, project_id, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id,
      orgId,
      name,
      projectId,
      by,
      NOW,
      NOW,
    );
  }

  it('lists the ids and project ids of the principals the user created, ordered by id', async () => {
    await executor.batch([
      principalRow(SP2, a.orgId, 'org-wide', null, U1),
      principalRow(SP1, a.orgId, 'ci', PROJECT, U1),
    ]);
    expect(await principals.createdBy(a, U1)).toEqual([
      { id: SP1, projectId: PROJECT },
      { id: SP2, projectId: null },
    ]);
  });

  it('never returns a principal of another organization, even one naming the same creator', async () => {
    await executor.batch([
      principalRow(SP1, a.orgId, 'ci', PROJECT, U1),
      principalRow(SP2, b.orgId, 'foreign', PROJECT_B, U1),
      principalRow(SP3, b.orgId, 'b-own', null, UB),
    ]);
    expect(await principals.createdBy(a, U1)).toEqual([{ id: SP1, projectId: PROJECT }]);
    expect(await principals.createdBy(a, UB)).toEqual([]);
    expect(await principals.createdBy(b, UB)).toEqual([{ id: SP3, projectId: null }]);
  });

  it('answers an empty list for a user who created nothing', async () => {
    await executor.batch([principalRow(SP1, a.orgId, 'ci', PROJECT, U1)]);
    expect(await principals.createdBy(a, '01J0USER000000000000000009')).toEqual([]);
  });
});

describe('replay gate', () => {
  it('never reads changes() of the previous statement', () => {
    const source = readFileSync(new URL('./service-principal.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/changes\(\)/);
  });

  it('adds no permission rows when an empty create is replayed with the same op id', async () => {
    expect(await create({ permissions: [] })).toBe('created');
    const before = await snapshot();
    expect(await create({ permissions: ['project:packages:read'] })).toBe('duplicate');
    expect(await snapshot()).toBe(before);
  });
});

describe('a create that inserts no principal', () => {
  it('writes no permissions when the project was archived before the same-op replay', async () => {
    expect(await create({ permissions: [] })).toBe('created');
    await executor.batch([stmt("UPDATE project SET status = 'archived' WHERE id = ?", PROJECT)]);
    const before = await snapshot();
    expect(await create({ permissions: ['project:packages:read'] })).toBe('project_mismatch');
    expect(await snapshot()).toBe(before);
    expect(await rows('SELECT 1 FROM service_principal_permission')).toEqual([]);
  });
});

describe('node:sqlite service principal contract', () => {
  describeServicePrincipalContract('node:sqlite', async () => {
    const opened = openNodeSqliteExecutor();
    return { executor: opened.executor, close: opened.close };
  });
});

interface Hooks {
  beforeBatch?: () => Promise<void>;
  failBatch?: DbError;
}

function instrumented(
  inner: SqlExecutor,
  hooks: Hooks,
): { executor: SqlExecutor; reads: string[] } {
  const reads: string[] = [];
  let failed = false;
  let latched = false;
  return {
    reads,
    executor: {
      driver: inner.driver,
      async all(statement: Statement) {
        reads.push(statement.sql);
        return inner.all(statement);
      },
      async batch(statements: readonly Statement[]) {
        if (hooks.beforeBatch !== undefined && !latched) {
          latched = true;
          await hooks.beforeBatch();
        }
        if (hooks.failBatch !== undefined && !failed) {
          failed = true;
          throw hooks.failBatch;
        }
        return inner.batch(statements);
      },
    } as SqlExecutor,
  };
}

const FOREIGN_KEY = classifySqliteError(new Error('FOREIGN KEY constraint failed'));
const CHECK = classifySqliteError(new Error('CHECK constraint failed: status'));
const AUTHORITY_PROBE = 'SELECT 1 AS refused';

describe('constraint failures', () => {
  function over(hooks: Hooks) {
    const wrapped = instrumented(executor, hooks);
    return { ...wrapped, repository: createServicePrincipalRepository(wrapped.executor) };
  }

  const input = {
    audit: mutationAudit(),
    opId: 'op-create',
    id: SP1,
    name: 'ci',
    projectId: PROJECT,
    createdByUserId: U1,
    permissions: ['project:packages:read'],
    now: NOW,
  };

  it('answers a foreign key failure in create as indeterminate without asking the authority probe', async () => {
    const { repository, reads } = over({ failBatch: FOREIGN_KEY });
    expect(await repository.create(a, NO_REVISION(), actorGuard(), input)).toBe('indeterminate');
    expect(reads).not.toContain(AUTHORITY_PROBE);
    expect(await rows('SELECT id FROM service_principal')).toEqual([]);
  });

  it('answers a check failure in create as indeterminate without asking the authority probe', async () => {
    const { repository, reads } = over({ failBatch: CHECK });
    expect(await repository.create(a, NO_REVISION(), actorGuard(), input)).toBe('indeterminate');
    expect(reads).not.toContain(AUTHORITY_PROBE);
  });

  it('still answers authority and asks the probe when the guard is what failed', async () => {
    const { repository, reads } = over({});
    expect(
      await repository.create(a, NO_REVISION(), actorGuard('01J0USER0000000000000000ZZ'), input),
    ).toBe('authority');
    expect(reads).toContain(AUTHORITY_PROBE);
  });

  it('does not look for a clash after a failure that is not a unique violation', async () => {
    await create();
    const busy = classifySqliteError(new Error('SQLITE_BUSY: database is locked'));
    const { repository } = over({ failBatch: busy });
    await expect(
      repository.create(a, NO_REVISION(), actorGuard(), { ...input, id: SP2 }),
    ).rejects.toThrow(/unclassified/);
  });

  it('answers duplicate, not authority, for a name clash', async () => {
    await create();
    const { repository, reads } = over({});
    expect(await repository.create(a, NO_REVISION(), actorGuard(), { ...input, id: SP2 })).toBe(
      'duplicate',
    );
    expect(reads).not.toContain(AUTHORITY_PROBE);
  });

  it('answers a foreign key failure in suspend, restore and setPermissions as indeterminate with no probe', async () => {
    await create();
    for (const run of [
      (r: ServicePrincipalRepository) =>
        r.suspend(a, NO_REVISION(), actorGuard(), {
          audit: mutationAudit('service_principal.create'),
          id: SP1,
          now: LATER,
          opId: 'op-stop',
        }),
      (r: ServicePrincipalRepository) =>
        r.restore(a, NO_REVISION(), actorGuard(), {
          audit: mutationAudit('service_principal.create'),
          id: SP1,
          now: LATER,
          opId: 'op-resume',
        }),
      (r: ServicePrincipalRepository) =>
        r.setPermissions(a, mutationFence(actor(), { service_principal: 1 }), actorGuard(), {
          audit: mutationAudit('service_principal.create'),
          id: SP1,
          permissions: ['project:packages:read'],
          now: LATER,
          opId: 'op-set',
        }),
    ]) {
      const { repository, reads } = over({ failBatch: FOREIGN_KEY });
      expect(await run(repository)).toBe('indeterminate');
      expect(reads.filter((sql) => /"holds"|"present"/.test(sql))).toEqual([]);
    }
  });

  it('answers authority for a refusing guard on a transition with no expected revision', async () => {
    await create();
    const { repository } = over({});
    expect(
      await repository.suspend(a, NO_REVISION(), actorGuard('01J0USER0000000000000000ZZ'), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: LATER,
        opId: 'op-stop',
      }),
    ).toBe('authority');
  });
});

describe('a principal deleted between the load and the batch', () => {
  const remove = async (): Promise<void> => {
    await executor.batch([stmt('DELETE FROM service_principal WHERE id = ?', SP1)]);
  };

  function latched() {
    return createServicePrincipalRepository(
      instrumented(executor, { beforeBatch: remove }).executor,
    );
  }

  it('answers not_found from suspend without a revision', async () => {
    await create();
    expect(
      await latched().suspend(a, NO_REVISION(), actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: LATER,
        opId: 'op-stop',
      }),
    ).toBe('not_found');
  });

  it('answers not_found from restore without a revision', async () => {
    await create();
    expect(
      await latched().restore(a, NO_REVISION(), actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: LATER,
        opId: 'op-resume',
      }),
    ).toBe('not_found');
  });

  it('answers not_found from suspend and restore with a revision', async () => {
    await create();
    const fence = mutationFence(actor(), { service_principal: 1 });
    expect(
      await latched().suspend(a, fence, actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: LATER,
        opId: 'op-stop',
      }),
    ).toBe('not_found');
    await create();
    expect(
      await latched().restore(a, fence, actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: LATER,
        opId: 'op-resume',
      }),
    ).toBe('not_found');
  });

  it('answers not_found from setPermissions', async () => {
    await create();
    expect(
      await latched().setPermissions(
        a,
        mutationFence(actor(), { service_principal: 1 }),
        actorGuard(),
        {
          audit: mutationAudit('service_principal.create'),
          id: SP1,
          permissions: ['project:packages:read'],
          now: LATER,
          opId: 'op-set',
        },
      ),
    ).toBe('not_found');
  });
});

describe('suspending an already suspended principal', () => {
  it('answers unchanged for a stale revision and rewrites nothing', async () => {
    await create();
    await principals.suspend(a, NO_REVISION(), actorGuard(), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: LATER,
      opId: 'op-stop',
    });
    const before = await snapshot();
    expect(
      await principals.suspend(a, mutationFence(actor(), { service_principal: 1 }), actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: '2026-10-15T14:00:00.000Z',
        opId: 'op-again',
      }),
    ).toBe('unchanged');
    expect(await snapshot()).toBe(before);
  });

  it('answers authority, not unchanged, when the guard refuses a stale-revision suspend', async () => {
    await create();
    await principals.suspend(a, NO_REVISION(), actorGuard(), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: LATER,
      opId: 'op-stop',
    });
    const before = await snapshot();
    expect(
      await principals.suspend(
        a,
        mutationFence(actor(), { service_principal: 1 }),
        actorGuard('01J0USER0000000000000000ZZ'),
        { audit: mutationAudit('service_principal.create'), id: SP1, now: LATER, opId: 'op-again' },
      ),
    ).toBe('authority');
    expect(await snapshot()).toBe(before);
  });

  it('answers conflict and writes nothing when a restore commits between the status read and the rerun', async () => {
    await create();
    await principals.suspend(a, NO_REVISION(), actorGuard(), {
      audit: mutationAudit('service_principal.create'),
      id: SP1,
      now: LATER,
      opId: 'op-stop',
    });
    let batches = 0;
    const racing = createServicePrincipalRepository({
      driver: executor.driver,
      all: (statement: Statement) => executor.all(statement),
      async batch(statements: readonly Statement[]) {
        batches += 1;
        if (batches === 2) {
          expect(
            await principals.restore(
              a,
              mutationFence(actor(), { service_principal: 2 }),
              actorGuard(),
              {
                audit: mutationAudit('service_principal.create'),
                id: SP1,
                now: LATER,
                opId: 'op-resume',
              },
            ),
          ).toBe('restored');
        }
        return executor.batch(statements);
      },
    } as SqlExecutor);
    expect(
      await racing.suspend(a, mutationFence(actor(), { service_principal: 1 }), actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: LATER,
        opId: 'op-again',
      }),
    ).toBe('conflict');
    expect(batches).toBe(2);
    const found = await principals.get(a, SP1);
    expect(found?.status).toBe('active');
    expect(found?.revision).toBe(3);
  });

  it('still answers conflict for a stale revision on an active principal', async () => {
    await create();
    await executor.batch([stmt('UPDATE service_principal SET revision = 5 WHERE id = ?', SP1)]);
    expect(
      await principals.suspend(a, mutationFence(actor(), { service_principal: 1 }), actorGuard(), {
        audit: mutationAudit('service_principal.create'),
        id: SP1,
        now: LATER,
        opId: 'op-stop',
      }),
    ).toBe('conflict');
  });
});

describe('creator retention control', () => {
  it('deletes a user who created no principal', async () => {
    const other = '01J0USER000000000000000002';
    await executor.batch([
      stmt(
        'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
        other,
        a.orgId,
        'u2@example.test',
      ),
    ]);
    await create();
    await executor.batch([stmt('DELETE FROM user_account WHERE id = ?', other)]);
    expect(await rows('SELECT id FROM user_account WHERE id = ?', other)).toEqual([]);
    expect(await rows('SELECT id FROM user_account WHERE id = ?', U1)).toHaveLength(1);
  });
});

function mutationAudit(action: AuditAction = 'service_principal.create') {
  const result = auditEvent({
    id: ulid(),
    now: NOW,
    action,
    actor: { type: 'user', id: U1 },
    target: { type: 'service_principal', id: SP1 },
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
  });
  if (!result.ok) throw new Error('Invalid test audit');
  return result.event;
}

describe('atomic principal audit', () => {
  it.each(['create', 'permissions_set', 'suspend', 'restore'] as const)(
    'stages exactly one event for %s',
    async (operation) => {
      if (operation !== 'create') await create();
      if (operation === 'restore')
        await principals.suspend(a, NO_REVISION(), actorGuard(), {
          id: SP1,
          now: LATER,
          opId: 'setup-suspend',
          audit: mutationAudit('service_principal.suspend'),
        });
      await executor.batch([stmt('DELETE FROM audit_pending')]);
      const action: AuditAction = `service_principal.${operation}`;
      const input = {
        id: SP1,
        now: LATER,
        opId: ulid(),
        audit: mutationAudit(action),
        idempotency: {
          principalKey: `user:${U1}`,
          key: operation,
          route: 'POST /principals',
          requestHash: 'a'.repeat(64),
          status: 200,
          responseJson: '{}',
          createdAt: NOW,
          expiresAt: LATER,
        },
      };
      const result =
        operation === 'create'
          ? await create(input)
          : operation === 'permissions_set'
            ? await principals.setPermissions(
                a,
                mutationFence(actor(), { service_principal: 1 }),
                actorGuard(),
                { ...input, permissions: [] },
              )
            : await principals[operation](a, NO_REVISION(), actorGuard(), input);
      expect(result).toBe(
        operation === 'create'
          ? 'created'
          : operation === 'permissions_set'
            ? 'updated'
            : operation === 'suspend'
              ? 'suspended'
              : 'restored',
      );
      expect(await rows('SELECT action, target_type, target_id FROM audit_pending')).toEqual([
        { action, target_type: 'service_principal', target_id: SP1 },
      ]);
      expect(await rows('SELECT key FROM api_idempotency')).toEqual([{ key: operation }]);
    },
  );
});

describe('service principal list pages', () => {
  it('pages principals before loading all their permissions and scopes rows by organization', async () => {
    await create({
      id: SP1,
      name: 'first',
      permissions: ['project:read', 'project:packages:read'],
    });
    await create({ id: SP2, name: 'second', projectId: null, permissions: [] });
    await create({ id: SP3, name: 'foreign', projectId: null, permissions: [] });
    await executor.batch([
      stmt(
        'UPDATE service_principal SET org_id = ?, created_by_user_id = ? WHERE id = ?',
        b.orgId,
        UB,
        SP3,
      ),
    ]);
    const page = await principals.list(a, { limit: 1, includeProjects: true });
    expect(page.items.map((p) => p.id)).toEqual([SP1]);
    expect(page.items[0]?.permissions).toEqual(['project:packages:read', 'project:read']);
    expect(page.next).toBe(SP1);
    const last = await principals.list(a, { limit: 1, after: page.next!, includeProjects: true });
    expect(last.items.map((p) => p.id)).toEqual([SP2]);
    expect(last.next).toBeNull();
    expect(
      (await principals.list(b, { limit: 10, includeProjects: true })).items.map((p) => p.id),
    ).toEqual([SP3]);
  });

  it('filters a project and excludes archived projects and non-admin project rows', async () => {
    await create({ id: SP1, name: 'project' });
    await create({ id: SP2, name: 'org', projectId: null });
    expect(
      (
        await principals.list(a, { limit: 10, projectId: PROJECT, includeProjects: true })
      ).items.map((p) => p.id),
    ).toEqual([SP1]);
    expect(
      (await principals.list(a, { limit: 10, includeProjects: false })).items.map((p) => p.id),
    ).toEqual([SP2]);
    expect(
      (await principals.list(a, { limit: 10, projectId: PROJECT_B, includeProjects: true })).items,
    ).toEqual([]);
    await executor.batch([
      stmt('UPDATE service_principal SET project_id = ? WHERE id = ?', PROJECT_B, SP1),
    ]);
    expect(
      (await principals.list(a, { limit: 10, includeProjects: true })).items.map((p) => p.id),
    ).toEqual([SP2]);
    await executor.batch([
      stmt('UPDATE service_principal SET project_id = ? WHERE id = ?', PROJECT, SP1),
    ]);
    await executor.batch([stmt("UPDATE project SET status = 'archived' WHERE id = ?", PROJECT)]);
    expect(
      (await principals.list(a, { limit: 10, includeProjects: true })).items.map((p) => p.id),
    ).toEqual([SP2]);
  });
});
