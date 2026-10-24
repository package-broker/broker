import { ulid } from '@package-broker/core/ids';
import { expect } from 'vitest';
import { createLoginWriter } from '../../repositories/login.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { ANCHORS, FUTURE, HASH, OTHER_HASH, seedUser } from './fixtures.js';
import { executing, factoryEntry } from './factory-cases.js';
const foreignGroup: ContractCase = {
  name: 'login refresh preserves a foreign group child of an own user',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'U', own.orgId);
    await seed(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', ?)",
      own.orgId,
      ANCHORS[0]!.anchor,
    );
    await seed(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified) VALUES ('I', ?, 'U', 'oidc', 'sub', 'u@example.test', 1)",
      own.orgId,
    );
    await seed(
      "INSERT INTO user_group (org_id, user_id, provider, group_name, refreshed_at) VALUES (?, 'U', 'oidc', 'foreign', ?)",
      foreign.orgId,
      FUTURE,
    );
    const now = new Date().toISOString();
    expect(
      await createLoginWriter(executing(context)).commit(own, {
        audit: {
          id: ulid(),
          occurredAt: now,
          action: 'session.login',
          actor: { type: 'user', id: 'U' },
          target: { type: 'session', id: 'NEW' },
          tokenSelector: null,
          sourceIp: null,
          projectId: null,
          payloadJson: '{"op_id":"fixture","request_id":"fixture"}',
        },
        userId: 'U',
        createUser: false,
        email: 'u@example.test',
        displayName: null,
        identityId: 'I',
        provider: 'oidc',
        trustAnchor: ANCHORS[0]!.anchor,
        subject: 'sub',
        emailVerified: true,
        groups: [],
        evidenceTime: now,
        previousSecretHash: null,
        now,
        autoJoin: false,
        session: {
          id: 'NEW',
          userId: 'U',
          identityId: 'I',
          secretHash: HASH,
          csrfHash: OTHER_HASH,
          expiresAt: FUTURE,
          ip: null,
          userAgent: null,
          now,
        },
      }),
    ).toBe('created');
    expect(
      await context.executor.all({
        sql: "SELECT group_name FROM user_group WHERE user_id = 'U'",
        params: [],
      }),
    ).toEqual([{ group_name: 'foreign' }]);
  },
};
export const entries: readonly MutationEntry[] = [
  factoryEntry('login', 'createLoginWriter', foreignGroup, /"user_group"\."org_id" = \?/, [
    {
      locate: /(?:owner|token|lost|removed|member|bound|reach|via)\.org_id = /,
      reason:
        'Selected PAT invalidation scopes are covered by selectedPatInvalidationStatement and its membership-removal case.',
    },
    {
      locate:
        /"(?:identity|identity_block|identity_provider_binding|user_account|session|created|guard_\w+)"\."org_id" = /,
      reason:
        'The user, identity, binding and new session are own controls; shared ownsIdentity, anchorMatches and sessionInsertStatement predicates have independent registrations. The created-session guard scopes the audit to the session just inserted.',
    },
  ]),
];
