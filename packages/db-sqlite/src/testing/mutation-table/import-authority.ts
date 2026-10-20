import { expect } from 'vitest';
import { tokenMutationFence, type AuthenticatedTokenActor } from '@package-broker/core/authz/fence';
import { importWriteAuthority } from '../../repositories/import-authority.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { FUTURE, HASH, held, seedUser } from './fixtures.js';
import { factoryEntry } from './factory-cases.js';

const foreignToken: ContractCase = {
  name: 'import authority refuses a foreign token and its principal',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', own.orgId);
    await seed(
      "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES ('SP', ?, 'importer', 'U')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, 'SP', 'org:import:write')",
      foreign.orgId,
    );
    await seed(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, service_principal_id, project_mode, expires_at) VALUES ('T', ?, 'svc', 'abcdefabcdef', ?, 1, 'importer', '["full"]', 'SP', 'all', ?)`,
      foreign.orgId,
      HASH,
      FUTURE,
    );
    const fence = tokenMutationFence(
      { tokenId: 'T', tokenKind: 'svc', principalId: 'SP' } as AuthenticatedTokenActor,
      'org:import:write',
      {},
    );
    expect(await held(context, importWriteAuthority(foreign, fence, []), false)).toBe(true);
    expect(await held(context, importWriteAuthority(own, fence, []), true)).toBe(false);
  },
};
const foreignPrincipal: ContractCase = {
  name: 'import authority refuses an own token whose service principal is foreign',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', own.orgId);
    for (const [principal, token, selector, orgId] of [
      ['SP-F', 'T-F', 'abcdefabcdef', foreign.orgId],
      ['SP-O', 'T-O', 'fedcbafedcba', own.orgId],
    ] as const) {
      await seed(
        "INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, 'importer', 'U')",
        principal,
        orgId,
      );
      await seed(
        "INSERT INTO service_principal_permission (org_id, service_principal_id, permission) VALUES (?, ?, 'org:import:write')",
        orgId,
        principal,
      );
      await seed(
        `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, service_principal_id, project_mode, expires_at) VALUES (?, ?, 'svc', ?, ?, 1, 'importer', '["full"]', ?, 'all', ?)`,
        token,
        own.orgId,
        selector,
        selector === 'abcdefabcdef' ? HASH : 'b'.repeat(64),
        principal,
        FUTURE,
      );
    }
    await seedUser(seed, 'U-F', foreign.orgId);
    await seed(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, project_mode, expires_at, validation_kind) VALUES ('T-U', ?, 'pat', 'cafecafecafe', ?, 1, 'importer', '["full"]', 'U-F', 'all', ?, 'local')`,
      own.orgId,
      'c'.repeat(64),
      FUTURE,
    );
    const fenceFor = (tokenId: string, principalId: string) =>
      tokenMutationFence(
        { tokenId, tokenKind: 'svc', principalId } as AuthenticatedTokenActor,
        'org:import:write',
        {},
      );
    expect(await held(context, importWriteAuthority(own, fenceFor('T-O', 'SP-O'), []), false)).toBe(
      true,
    );
    expect(
      await held(
        context,
        importWriteAuthority(
          own,
          tokenMutationFence(
            { tokenId: 'T-U', tokenKind: 'pat', principalId: 'U-F' } as AuthenticatedTokenActor,
            'org:import:write',
            {},
          ),
          [],
        ),
        true,
      ),
    ).toBe(false);
    expect(await held(context, importWriteAuthority(own, fenceFor('T-F', 'SP-F'), []), true)).toBe(
      false,
    );
  },
};
const base = factoryEntry(
  'import-authority',
  'importWriteAuthority',
  foreignToken,
  /irt\.org_id = \?/,
  [
    {
      locate: /iru\.org_id = irt\.org_id/,
      reason:
        'The pat branch also requires the permission guard, whose permissionRows, verified identity and local login conditions bind the user through the context organization, so a foreign iru row cannot hold; the foreign-principal case asserts the combined outcome.',
    },
    {
      locate: /(?:irp|irpp)\.org_id = irt\.org_id/,
      reason:
        '0003_access_model.sql service_principal_permission FOREIGN KEY (org_id, service_principal_id) REFERENCES service_principal (org_id, id) ties irpp.org_id to the principal organization, so irp.org_id = irt.org_id and irpp.org_id = irt.org_id each imply the other and neither can be removed alone observably; the foreign-principal case asserts the combined outcome.',
    },
    {
      locate: /"guard_\w+"\."org_id" = /,
      reason:
        'permissionRows and local eligibility are delegated unchanged and have independent registrations.',
    },
  ],
);
export const entries: readonly MutationEntry[] = [
  { ...base, cases: [foreignToken, foreignPrincipal] },
];
