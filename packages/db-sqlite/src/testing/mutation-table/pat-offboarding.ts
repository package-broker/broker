import { expect } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import type { SqlExecutor, SqlValue } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import {
  createPatOffboardingRepository,
  patInvalidationStatement,
} from '../../repositories/pat-offboarding.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';

const USER = '01HZX3VQ7N5R8T2W4Y6A9B1C2D';
const EMAIL = 'leaver@example.test';
const CUTOFF = '2999-01-01T00:00:00.000Z';
const NOW = '2026-10-20T12:00:00.000Z';
const BEFORE = '2026-10-20T10:00:00.000Z';

function mutating(context: CaseContext): SqlExecutor {
  const { executor } = context;
  return {
    driver: executor.driver,
    all: (statement) => executor.all(context.mutate(statement)),
    batch: (statements) => executor.batch(context.mutateBatch(statements)),
  };
}

async function base(context: CaseContext) {
  const { own, foreign } = orgOf(context);
  const seed = seeder(context.executor);
  await seed(
    'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
    USER,
    own.orgId,
    EMAIL,
  );
  for (const [id, org] of [
    ['role-own', own],
    ['role-foreign', foreign],
  ] as const) {
    await seed(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES (?, ?, 'viewer', 'Viewer', 'organization')",
      id,
      org.orgId,
    );
  }
  let counter = 0;
  const token = async (
    org: { orgId: string },
    options: { revokedAt?: string; lastOpId?: string } = {},
  ): Promise<string> => {
    counter += 1;
    const id = `01J0TOKEN${String(counter).padStart(17, '0')}`;
    await seed(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, read_only,
         user_id, created_by_user_id, expires_at, revoked_at, last_op_id, project_mode, created_at)
       VALUES (?, ?, 'pat', ?, ?, 1, ?, '["write"]', 0, ?, ?, '2027-01-01T00:00:00.000Z', ?, ?, 'all', ?)`,
      id,
      org.orgId,
      String(counter).padStart(12, 's'),
      'a'.repeat(64),
      `name-${counter}`,
      USER,
      USER,
      options.revokedAt ?? null,
      options.lastOpId ?? null,
      BEFORE,
    );
    return id;
  };
  const job = (id: string, org: { orgId: string }) =>
    seed(
      `INSERT INTO job (id, org_id, type, idempotency_key, state, lease_owner, lease_until, fence)
       VALUES (?, ?, 'core:pat-offboarding:v1', ?, 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)`,
      id,
      org.orgId,
      `key-${id}`,
    );
  const grant = (
    id: string,
    org: { orgId: string },
    type: 'email' | 'group',
    value: string,
    provider: string | null = null,
  ) =>
    seed(
      `INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, role_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'organization', ?, ?)`,
      id,
      org.orgId,
      type,
      value,
      provider,
      org === own ? 'role-own' : 'role-foreign',
      BEFORE,
    );
  const membership = (org: { orgId: string }) =>
    seed(
      "INSERT INTO user_group (org_id, user_id, provider, group_name) VALUES (?, ?, 'oidc', 'staff')",
      org.orgId,
      USER,
    );
  return { own, foreign, seed, token, job, grant, membership };
}

function page(ids: readonly string[], jobId: string, opId = ulid()) {
  return {
    userId: USER,
    cutoff: CUTOFF,
    ids,
    now: NOW,
    opId,
    lease: { jobId, fence: 1 },
    audits: ids.map((id) => {
      const built = auditEvent({
        id: ulid(),
        now: NOW,
        action: 'token.revoke',
        actor: { type: 'system', id: null },
        context: { opId, requestId: opId, sourceIp: null, tokenSelector: null },
        target: { type: 'token', id },
        projectId: null,
        changes: { cause: { new: 'suspended' } },
      });
      if (!built.ok) throw new Error('audit event rejected');
      return built.event;
    }),
  };
}

async function auditedTargets(context: CaseContext): Promise<string[]> {
  const rows = await context.executor.all<{ target_id: string }>({
    sql: 'SELECT target_id FROM audit_pending ORDER BY target_id',
    params: [],
  });
  return rows.map((row) => row.target_id);
}

const holdsSubject: ContractCase = {
  name: 'holdsAnyGrant resolves the user inside the context organization only',
  async run(context) {
    const { own, foreign, grant } = await base(context);
    await grant('G1', own, 'email', EMAIL);
    const repo = createPatOffboardingRepository(mutating(context));

    expect(await repo.holdsAnyGrant(foreign, USER, CUTOFF)).toBe(false);
  },
};

const holdsGrantOrg: ContractCase = {
  name: 'holdsAnyGrant ignores grants of another organization on the same e-mail',
  async run(context) {
    const { own, foreign, grant } = await base(context);
    await context.executor.batch([
      {
        sql: "INSERT INTO user_account (id, org_id, email) VALUES ('mirror', ?, ?)",
        params: [foreign.orgId, EMAIL],
      },
    ]);
    await grant('G1', foreign, 'email', EMAIL);
    const repo = createPatOffboardingRepository(mutating(context));

    expect(await repo.holdsAnyGrant(own, USER, CUTOFF)).toBe(false);
  },
};

const holdsMembershipOrg: ContractCase = {
  name: 'holdsAnyGrant ignores group memberships stored under another organization',
  async run(context) {
    const { own, foreign, grant, membership } = await base(context);
    await grant('G1', own, 'group', 'staff', 'oidc');
    await membership(foreign);
    const repo = createPatOffboardingRepository(mutating(context));

    expect(await repo.holdsAnyGrant(own, USER, CUTOFF)).toBe(false);
  },
};

const candidatesOrg: ContractCase = {
  name: 'candidates lists only tokens of the context organization',
  async run(context) {
    const { own, foreign, token } = await base(context);
    const mine = [await token(own), await token(own)];
    await token(foreign);
    const repo = createPatOffboardingRepository(mutating(context));

    expect(await repo.candidates(own, { userId: USER, cutoff: CUTOFF, limit: 25 })).toEqual(mine);
  },
};

const sweepUserOrg: ContractCase = {
  name: 'suspendedUsersWithLivePats lists only users of the context organization',
  async run(context) {
    const { own, foreign, token } = await base(context);
    await context.executor.batch([
      { sql: "UPDATE user_account SET status = 'suspended' WHERE id = ?", params: [USER] },
    ]);
    await token(own);
    const repo = createPatOffboardingRepository(mutating(context));

    expect(await repo.suspendedUsersWithLivePats(foreign, '', 100)).toEqual([]);
  },
};

const sweepTokenOrg: ContractCase = {
  name: 'suspendedUsersWithLivePats counts only personal tokens of the context organization',
  async run(context) {
    const { own, foreign, token } = await base(context);
    await context.executor.batch([
      { sql: "UPDATE user_account SET status = 'suspended' WHERE id = ?", params: [USER] },
    ]);
    await token(foreign);
    const repo = createPatOffboardingRepository(mutating(context));

    expect(await repo.suspendedUsersWithLivePats(own, '', 100)).toEqual([]);
  },
};

const sweepCursor: ContractCase = {
  name: 'suspendedUsersWithLivePats returns only users above the cursor',
  async run(context) {
    const { own, token } = await base(context);
    await context.executor.batch([
      { sql: "UPDATE user_account SET status = 'suspended' WHERE id = ?", params: [USER] },
    ]);
    await token(own);
    const repo = createPatOffboardingRepository(mutating(context));

    expect(await repo.suspendedUsersWithLivePats(own, USER, 100)).toEqual([]);
  },
};

const revokeOrg: ContractCase = {
  name: 'revokePage revokes only tokens of the context organization',
  async run(context) {
    const { own, foreign, token, job } = await base(context);
    const mine = await token(own);
    const theirs = await token(foreign);
    await job('J', own);
    const repo = createPatOffboardingRepository(mutating(context));

    const outcome = await repo.revokePage(own, page([theirs, mine].sort(), 'J'));

    expect(outcome).toEqual({ status: 'ok', revoked: [mine] });
    const left = await context.executor.all<{ revoked_at: string | null }>({
      sql: 'SELECT revoked_at FROM token WHERE id = ?',
      params: [theirs],
    });
    expect(left).toEqual([{ revoked_at: null }]);
  },
};

const auditOrg: ContractCase = {
  name: 'revokePage stages an audit row only for tokens of the context organization',
  async run(context) {
    const { own, foreign, token, job } = await base(context);
    const opId = ulid();
    const first = await token(foreign, { revokedAt: BEFORE, lastOpId: opId });
    const second = await token(foreign, { revokedAt: BEFORE, lastOpId: opId });
    await job('J', own);
    const repo = createPatOffboardingRepository(mutating(context));

    const outcome = await repo.revokePage(own, page([first, second], 'J', opId));

    expect(outcome).toEqual({ status: 'ok', revoked: [] });
    expect(await auditedTargets(context)).toEqual([]);
  },
};

const leaseOrg: ContractCase = {
  name: 'revokePage accepts only a lease of a job of the context organization',
  async run(context) {
    const { own, foreign, token, job } = await base(context);
    const mine = await token(own);
    await job('JB', foreign);
    const repo = createPatOffboardingRepository(mutating(context));

    expect(await repo.revokePage(own, page([mine], 'JB'))).toBe('lease_lost');
    expect(await auditedTargets(context)).toEqual([]);
  },
};

async function stamps(context: CaseContext, userId: string): Promise<unknown> {
  const rows = await context.executor.all<{ pat_invalid_before: string | null }>({
    sql: 'SELECT pat_invalid_before FROM user_account WHERE id = ?',
    params: [userId],
  });
  return rows[0]?.pat_invalid_before ?? null;
}

async function stamp(context: CaseContext, org: { orgId: string }, grantId: string) {
  const { own } = orgOf(context);
  const statement = patInvalidationStatement(own, grantId, {
    sql: 'removed.revision = ?',
    params: [1 as SqlValue],
  });
  void org;
  await context.executor.batch([context.mutate(statement)]);
}

const stampUserOrg: ContractCase = {
  name: 'the stamp reaches only the account of the context organization',
  async run(context) {
    const { own, foreign, grant } = await base(context);
    await context.executor.batch([
      {
        sql: "INSERT INTO user_account (id, org_id, email) VALUES ('mirror', ?, ?)",
        params: [foreign.orgId, EMAIL],
      },
    ]);
    await grant('G1', own, 'email', EMAIL);

    await stamp(context, own, 'G1');

    expect(await stamps(context, USER)).not.toBeNull();
    expect(await stamps(context, 'mirror')).toBeNull();
  },
};

const stampRemovedOrg: ContractCase = {
  name: 'the stamp follows only a removed grant of the context organization',
  async run(context) {
    const { foreign, grant } = await base(context);
    await grant('GF', foreign, 'email', EMAIL);

    await stamp(context, foreign, 'GF');

    expect(await stamps(context, USER)).toBeNull();
  },
};

const stampRemainingOrg: ContractCase = {
  name: 'the stamp ignores remaining e-mail grants of another organization',
  async run(context) {
    const { own, foreign, grant } = await base(context);
    await grant('G1', own, 'email', EMAIL);
    await grant('GF', foreign, 'email', EMAIL);

    await stamp(context, own, 'G1');

    expect(await stamps(context, USER)).not.toBeNull();
  },
};

const stampMembershipOrg: ContractCase = {
  name: 'the stamp ignores group memberships stored under another organization',
  async run(context) {
    const { own, foreign, grant, membership } = await base(context);
    await grant('G1', own, 'email', EMAIL);
    await grant('G2', own, 'group', 'staff', 'oidc');
    await membership(foreign);

    await stamp(context, own, 'G1');

    expect(await stamps(context, USER)).not.toBeNull();
  },
};

const stampGroupRemovedOrg: ContractCase = {
  name: 'the stamp follows only a removed group grant of the context organization',
  async run(context) {
    const { foreign, grant, membership } = await base(context);
    await grant('GF', foreign, 'group', 'staff', 'oidc');
    await membership(foreign);

    await stamp(context, foreign, 'GF');

    expect(await stamps(context, USER)).toBeNull();
  },
};

const stampGroupMemberOrg: ContractCase = {
  name: 'the stamp reaches only stored members of the removed group in the context organization',
  async run(context) {
    const { own, foreign, grant, membership } = await base(context);
    await grant('GG', own, 'group', 'staff', 'oidc');
    await membership(foreign);

    await stamp(context, own, 'GG');

    expect(await stamps(context, USER)).toBeNull();
  },
};

const NEUTRAL = '(? is not null)';

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createPatOffboardingRepository',
    file: 'repositories/pat-offboarding.ts',
    cases: [
      holdsSubject,
      holdsGrantOrg,
      holdsMembershipOrg,
      candidatesOrg,
      sweepUserOrg,
      sweepTokenOrg,
      sweepCursor,
      revokeOrg,
      auditOrg,
      leaseOrg,
    ],
    predicates: [
      {
        name: 'holdsAnyGrant user organization',
        locate: /subject\.org_id = \?/,
        neutral: NEUTRAL,
        copies: 1,
        caseName: holdsSubject.name,
      },
      {
        name: 'holdsAnyGrant grant organization',
        locate: /held\.org_id = subject\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: holdsGrantOrg.name,
      },
      {
        name: 'holdsAnyGrant membership organization',
        locate: /membership\.org_id = subject\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: holdsMembershipOrg.name,
      },
      {
        name: 'candidates organization',
        locate: /org_id = \?(?= AND kind = 'pat' AND user_id = \?)/,
        neutral: NEUTRAL,
        copies: 1,
        caseName: candidatesOrg.name,
      },
      {
        name: 'sweep user organization',
        locate: /u\.org_id = \?/,
        neutral: NEUTRAL,
        copies: 1,
        caseName: sweepUserOrg.name,
      },
      {
        name: 'sweep token organization',
        locate: /t\.org_id = u\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: sweepTokenOrg.name,
      },
      {
        name: 'sweep cursor',
        locate: /u\.id > \?/,
        neutral: NEUTRAL,
        copies: 1,
        caseName: sweepCursor.name,
      },
      {
        name: 'revoke update organization',
        locate: /org_id = \?(?= AND kind = 'pat' AND user_id = \?)/,
        neutral: NEUTRAL,
        copies: 1,
        caseName: revokeOrg.name,
      },
      {
        name: 'audit condition organization',
        locate: /org_id = \?(?= AND id = \? AND last_op_id = \?)/,
        neutral: NEUTRAL,
        copies: 2,
        caseName: auditOrg.name,
      },
      {
        name: 'lease job organization',
        locate: /job\.org_id = \?/,
        neutral: NEUTRAL,
        copies: 1,
        caseName: leaseOrg.name,
      },
    ],
  },
  {
    builder: 'patInvalidationStatement',
    file: 'repositories/pat-offboarding.ts',
    cases: [
      stampUserOrg,
      stampRemovedOrg,
      stampRemainingOrg,
      stampMembershipOrg,
      stampGroupRemovedOrg,
      stampGroupMemberOrg,
    ],
    predicates: [
      {
        name: 'stamped account organization',
        locate: /\borg_id = \?(?= AND \(\s*email IN)/,
        neutral: NEUTRAL,
        copies: 1,
        caseName: stampUserOrg.name,
      },
      {
        name: 'removed e-mail grant organization',
        locate: /removed\.org_id = \?(?= AND removed\.subject_type = 'email')/,
        neutral: NEUTRAL,
        copies: 1,
        caseName: stampRemovedOrg.name,
      },
      {
        name: 'removed group grant organization',
        locate: /removed\.org_id = \?(?= AND removed\.subject_type = 'group')/,
        neutral: NEUTRAL,
        copies: 1,
        caseName: stampGroupRemovedOrg.name,
      },
      {
        name: 'removed group member organization',
        locate: /removed_member\.org_id = removed\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: stampGroupMemberOrg.name,
      },
      {
        name: 'remaining grant organization',
        locate: /remaining\.org_id = user_account\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: stampRemainingOrg.name,
      },
      {
        name: 'stamp membership organization',
        locate: /membership\.org_id = user_account\.org_id/,
        neutral: '1',
        copies: 1,
        caseName: stampMembershipOrg.name,
      },
    ],
  },
];
