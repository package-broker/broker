import { expect } from 'vitest';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { createAccessRepository } from '../../repositories/access.js';
import { createAuthRepositories } from '../../repositories/auth.js';
import { createOrganizationRepository } from '../../repositories/organization.js';
import { createProjectRepository } from '../../repositories/project.js';
import { createProjectGrantRepository } from '../../repositories/project-grant.js';
import { createReadableProjectRepository } from '../../repositories/project-readable.js';
import { createServicePrincipalRepository } from '../../repositories/service-principal.js';
import { createServicePrincipalAuthority } from '../../repositories/service-principal-authority.js';
import { createTokenRepository } from '../../repositories/token.js';
import { createTokenReader } from '../../repositories/token-read.js';
import { createUnlinkRepository } from '../../repositories/unlink.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import {
  ALWAYS,
  ANCHORS,
  FUTURE,
  HASH,
  NOT_NULL,
  OTHER_HASH,
  fenceOf,
  ref,
  seedBindings,
  seedProject,
  seedSubject,
  seedUser,
} from './fixtures.js';

function executing(context: CaseContext): SqlExecutor {
  return {
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  };
}

const access: ContractCase = {
  name: 'the access factory rejects a session referencing a foreign user',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', foreign.orgId);
    await seed(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at) VALUES ('S', ?, 'U', ?, ?, ?)",
      own.orgId,
      HASH,
      OTHER_HASH,
      FUTURE,
    );
    expect(
      await createAccessRepository(executing(context)).lookupSession(own, {
        secretHash: HASH,
        boundary: 'organization',
        projectSlug: null,
        providerAnchors: [],
      }),
    ).toBeNull();
  },
};

const auth: ContractCase = {
  name: 'the auth factory rejects a foreign identity referencing its own user',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', own.orgId);
    await seed(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email) VALUES ('I', ?, 'U', 'oidc', 'sub', 'u@example.test')",
      foreign.orgId,
    );
    expect(await createAuthRepositories(executing(context)).users.getIdentity(own, 'I')).toBeNull();
  },
};

const project: ContractCase = {
  name: 'the project factory rejects a project child of another organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const id = '01J0PR0J000000000000000001';
    await seedProject(seeder(context.executor), id, foreign.orgId);
    expect(await createProjectRepository(executing(context)).get(own, id)).toBeNull();
  },
};

const organization: ContractCase = {
  name: 'updating organization A settings leaves organization B unchanged',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const before = await createOrganizationRepository(context.executor).get(foreign);
    await createOrganizationRepository(executing(context)).updateSettings(
      own,
      { name: 'Changed' },
      '2030-01-01T00:00:00.000Z',
    );
    expect(await createOrganizationRepository(context.executor).get(foreign)).toEqual(before);
    expect((await createOrganizationRepository(context.executor).get(own))?.name).toBe('Changed');
  },
};

async function tokenFixture(context: CaseContext): Promise<void> {
  const { own, foreign } = orgOf(context);
  const seed = seeder(context.executor);
  await seedUser(seed, 'U', own.orgId);
  await seed(
    `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at)
    VALUES ('T', ?, 'pat', 'abcdefabcdef', ?, 1, 'ci', '["read"]', 'U', ?)`,
    foreign.orgId,
    HASH,
    FUTURE,
  );
}

const token: ContractCase = {
  name: 'the token factory rejects a foreign token referencing its own user',
  async run(context) {
    await tokenFixture(context);
    expect(await createTokenRepository(executing(context)).get(orgOf(context).own, 'T')).toBeNull();
  },
};

const tokenReader: ContractCase = {
  name: 'the token reader rejects a foreign token referencing its own user',
  async run(context) {
    await tokenFixture(context);
    expect(
      await createTokenReader(executing(context)).getOwn(
        orgOf(context).own,
        'U',
        'T',
        '2030-01-01T00:00:00.000Z',
      ),
    ).toBeNull();
  },
};

const principal: ContractCase = {
  name: 'the principal factory rejects a foreign principal referencing its own creator',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', own.orgId);
    await seed(
      "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES ('SP', ?, 'deploy', 'U')",
      foreign.orgId,
    );
    expect(await createServicePrincipalRepository(executing(context)).get(own, 'SP')).toBeNull();
  },
};

const authority: ContractCase = {
  name: 'the authority factory excludes a foreign permission child of its own role',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    const subject = await seedSubject(context, 'ok');
    await seeder(context.executor)(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-ok', 'org:users:read')",
      foreign.orgId,
    );
    await seeder(context.executor)(
      "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, 'U-ok', 'oidc', 'operators', ?)",
      own.orgId,
      new Date().toISOString(),
    );
    await seeder(context.executor)(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, subject_provider, scope, role_id) VALUES ('G-group', ?, 'group', 'operators', 'oidc', 'organization', 'R-ok')",
      own.orgId,
    );
    const permissions = await createServicePrincipalAuthority({
      executor: executing(context),
      providerAnchors: ANCHORS,
    }).livePermissions(own, fenceOf(subject), null);
    expect(permissions.has('org:settings:write')).toBe(true);
    expect(permissions.has('org:users:read')).toBe(false);
  },
};

const readable: ContractCase = {
  name: 'the readable project factory excludes a foreign project referenced by its own grant',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedBindings(context);
    await seedProject(seeder(context.executor), 'P', foreign.orgId);
    const subject = await seedSubject(context, 'ok', { projectId: 'P' });
    await seeder(context.executor)(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-ok', 'project:read')",
      own.orgId,
    );
    expect(
      await createReadableProjectRepository(executing(context), {
        providerAnchors: ANCHORS,
      }).listReadableProjects(own, subject, { status: 'active', limit: 10 }),
    ).toEqual([]);
  },
};

const grant: ContractCase = {
  name: 'the project grant factory refuses a foreign role referenced in an own project grant',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedBindings(context);
    await seedProject(seed, 'P', own.orgId);
    const subject = await seedSubject(context, 'ok', { projectId: 'P' });
    await seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-ok', 'project:grants:write')",
      own.orgId,
    );
    await seed(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R-F', ?, 'foreign', 'Foreign', 'project')",
      foreign.orgId,
    );
    expect(
      await createProjectGrantRepository(executing(context)).create(own, fenceOf(subject), {
        id: 'G-NEW',
        projectId: 'P',
        roleId: 'R-F',
        subject: { type: 'email', value: 'new@example.test' },
        now: new Date().toISOString(),
        providerAnchors: ANCHORS,
      }),
    ).toBe('role_scope_mismatch');
    expect(
      await context.executor.all({
        sql: "SELECT id FROM access_grant WHERE id = 'G-NEW'",
        params: [],
      }),
    ).toEqual([]);
  },
};

const unlink: ContractCase = {
  name: 'unlinking an own identity leaves a foreign group child of its own user unchanged',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedBindings(context);
    const subject = await seedSubject(context, 'ok');
    await seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-ok', 'org:users:write')",
      own.orgId,
    );
    await seed("UPDATE role SET protects_last_holder = 1 WHERE id = 'R-ok'");
    await seedSubject(context, 'other');
    await seed("UPDATE role SET protects_last_holder = 1 WHERE id = 'R-other'");
    await seed(
      "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, ?, 'oidc', 'foreign', ?)",
      foreign.orgId,
      subject.userId,
      new Date().toISOString(),
    );
    const groups = () =>
      context.executor.all({
        sql: "SELECT * FROM user_group WHERE user_id = ? AND provider = 'oidc' AND group_name = 'foreign'",
        params: [subject.userId],
      });
    const before = await groups();
    expect(before).toHaveLength(1);
    expect(
      await createUnlinkRepository(executing(context), {
        holderInput: () => ({ kind: 'fresh', now: new Date().toISOString(), providers: ANCHORS }),
      }).unlinkIdentity(own, fenceOf(subject), {
        identityId: 'I-ok',
        userId: subject.userId,
        provider: 'oidc',
        subject: 'sub-ok',
        anchor: ANCHORS[0]!.anchor,
        now: new Date().toISOString(),
      }),
    ).toBe('unlinked');
    expect(await groups()).toEqual(before);
  },
};

function entry(
  file: string,
  builder: string,
  contractCase: ContractCase,
  locate: RegExp,
  neutral = NOT_NULL,
  waivers: MutationEntry['waivers'] = [],
  copies = 1,
): MutationEntry {
  return {
    file: `repositories/${file}.ts`,
    builder,
    cases: [contractCase],
    predicates: [
      {
        name: 'the factory preserves the organization boundary',
        locate,
        neutral,
        copies,
        caseName: contractCase.name,
      },
    ],
    waivers,
  };
}

export const entries: readonly MutationEntry[] = [
  entry('access', 'createAccessRepository', access, ref('u', 'org_id', '"s"\\."org_id"'), ALWAYS, [
    {
      locate: ref('s', 'org_id', '\\?'),
      reason:
        'DEFERRED: root session filtering is registered under lookupSessionStatement; owner T782n',
    },
    {
      locate: ref('i', 'org_id', '"s"\\."org_id"'),
      reason: 'DEFERRED: identity join is registered under lookupSessionStatement; owner T782n',
    },
    {
      locate: /"guard_\w+"\."org_id" = /,
      reason: 'DEFERRED: permissionRows has separate predicate registrations; owner T782n',
    },
  ]),
  entry('auth', 'createAuthRepositories', auth, ref('identity', 'org_id', '\\?')),
  entry('project', 'createProjectRepository', project, /"org_id" = \?/),
  entry('organization', 'createOrganizationRepository', organization, /"id" = \?/),
  entry('token', 'createTokenRepository', token, /"org_id" = \?/),
  entry('token-read', 'createTokenReader', tokenReader, ref('t', 'org_id', '\\?'), NOT_NULL, [
    {
      locate: ref('sp', 'org_id', '"t"\\."org_id"'),
      reason: 'DEFERRED: foreign service-principal join needs a service token case; owner T782n',
    },
    {
      locate: /tp\.org_id = \?/,
      reason: 'DEFERRED: selected-project count needs a token_project mismatch case; owner T782n',
    },
  ]),
  entry(
    'service-principal',
    'createServicePrincipalRepository',
    principal,
    ref('sp', 'org_id', '\\?'),
    NOT_NULL,
    [
      {
        locate: ref('p', 'org_id', '"sp"\\."org_id"'),
        reason:
          'REDUNDANT_BY_SCHEMA: 0003_access_model.sql service_principal_permission FOREIGN KEY (org_id, service_principal_id) REFERENCES service_principal (org_id, id)',
      },
    ],
  ),
  {
    ...entry(
      'service-principal-authority',
      'createServicePrincipalAuthority',
      authority,
      ref('guard_perm', 'org_id', '"guard_role"\\."org_id"'),
      ALWAYS,
      [
        {
          locate: /"guard_(?!perm\b)\w+"\."org_id" = /,
          reason: 'DEFERRED: other permissionRows layers have separate registrations; owner T782n',
        },
        {
          locate: ref('sa_session', 'org_id', '\\?'),
          reason: 'DEFERRED: local-admin eligibility needs a local-login fixture; owner T782n',
        },
      ],
    ),
    predicates: [
      {
        name: 'permission children join in the role organization',
        locate: ref('guard_perm', 'org_id', '"guard_role"\\."org_id"'),
        neutral: ALWAYS,
        copies: 2,
        caseName: authority.name,
      },
    ],
  },
  entry(
    'project-readable',
    'createReadableProjectRepository',
    readable,
    ref('pe', 'org_id', '\\?'),
    NOT_NULL,
    [
      {
        locate: /"(?!pe"\.)\w+"\."org_id" = /,
        reason:
          'DEFERRED: remaining grantPath predicates are registered under listReadableProjectsStatement; owner T782n',
      },
    ],
  ),
  entry(
    'project-grant',
    'createProjectGrantRepository',
    grant,
    /target_role\.org_id = \?/,
    NOT_NULL,
    [
      {
        locate: /\b(?!target_role\b)\w+\.org_id = /,
        reason:
          'DEFERRED: actor, project and role coverage paths need separate mismatched-child cases; owner T782n',
      },
      {
        locate: /"\w+"\."org_id" = |(?<![\w.])"org_id" = \?/,
        reason:
          'DEFERRED: nested permissionRows and epoch predicates are registered separately; owner T782n',
      },
    ],
    2,
  ),
  entry('unlink', 'createUnlinkRepository', unlink, ref('user_group', 'org_id', '\\?'), NOT_NULL, [
    {
      locate: /"(?!user_group"\.)\w+"\."org_id" = |(?<![\w.])"org_id" = \?/,
      reason:
        'DEFERRED: other unlink guards and cleanup paths need independent child fixtures; owner T782n',
    },
    {
      locate: /\b\w+\.org_id = /,
      reason:
        'DEFERRED: actor and holder guards are unchanged and need separate unlink cases; owner T782n',
    },
  ]),
];
