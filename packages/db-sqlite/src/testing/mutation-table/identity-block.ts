import { expect } from 'vitest';
import { createIdentityBlockRepository } from '../../repositories/identity-block.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ANCHORS, fenceOf, seedBindings, seedSubject } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignBlock: ContractCase = {
  name: 'identity unblocking preserves a foreign block child of an own actor',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedBindings(context);
    const subject = await seedSubject(context, 'actor');
    await seed("UPDATE role SET protects_last_holder = 1 WHERE id = 'R-actor'");
    await seed(
      "UPDATE session SET reauth_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      subject.sessionId,
    );
    await seed(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R-actor', 'org:users:write')",
      own.orgId,
    );
    const issuer = ANCHORS[0]!.anchor;
    await seed(
      "INSERT INTO identity_block (org_id, provider, issuer, subject, blocked_by_user_id) VALUES (?, 'oidc', ?, 'blocked', ?)",
      foreign.orgId,
      issuer,
      subject.userId,
    );
    expect(
      await createIdentityBlockRepository(executing(context), {
        holderInput: () => ({ kind: 'fresh', now: new Date().toISOString(), providers: ANCHORS }),
      }).unblock(own, fenceOf(subject), { provider: 'oidc', issuer, subject: 'blocked' }),
    ).toBe('not_found');
    expect(
      await context.executor.all({
        sql: "SELECT subject FROM identity_block WHERE subject = 'blocked'",
        params: [],
      }),
    ).toEqual([{ subject: 'blocked' }]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry(
    'identity-block',
    'createIdentityBlockRepository',
    foreignBlock,
    /"identity_block"\."org_id" = \?/,
    [
      {
        locate: /(?<=cache_epoch[^;]{0,100})"org_id" = \?/,
        reason:
          'runOrgFenced delegates the unchanged epoch read and bump; cache-epoch and cache-epoch-bump have independent organization registrations.',
      },
      {
        locate: /"(?:guard_\w+|la_session|hp_session|present)"\."org_id" = |(?:au|s)\.org_id = /,
        reason:
          'The actor is an own control; live session, permissionRows and protected-holder authority are independently covered by access and service-principal authority registrations. The present probe only classifies a failed deletion.',
      },
    ],
  ),
];
