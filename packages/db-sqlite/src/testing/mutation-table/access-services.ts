import { expect } from 'vitest';
import { resolveTokenLifetimePolicy } from '@package-broker/core/authz/token-lifetime';
import { systemClock, ulid } from '@package-broker/core/ids';
import { buildIdentityProviders } from '@package-broker/core/identity/providers';
import { collectRegistrations } from '@package-broker/core/kernel/registry';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { createAccessServices } from '../../repositories/access-services.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, ref, seedUser } from './fixtures.js';

const foreignTokens: ContractCase = {
  name: 'the assembled token reader excludes foreign organization tokens',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'FOREIGN-USER', foreign.orgId);
    await seed(
      `INSERT INTO token (id, org_id, kind, selector, hash, pepper_version, name, scopes_json, user_id, expires_at)
       VALUES ('FOREIGN-TOKEN', ?, 'pat', 'abcdefghijkl', ?, 1, 'foreign', '["read"]', 'FOREIGN-USER', '2099-01-01T00:00:00.000Z')`,
      foreign.orgId,
      'a'.repeat(64),
    );
    const registration = collectRegistrations([]);
    const built = createAccessServices({
      executor: {
        ...context.executor,
        all: (statement) => context.executor.all(context.mutate(statement)),
        batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
      },
      keyring: createKeyring([
        parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
      ]),
      providers: buildIdentityProviders(registration, [], {
        fetch: (request) => fetch(request),
        clock: systemClock,
        env: () => undefined,
      }),
      clock: systemClock,
      ids: { ulid },
      log: () => undefined,
      dispatch: () => undefined,
      publicOrigin: 'https://broker.example.test',
      registration,
      tokens: { lifetime: resolveTokenLifetimePolicy(undefined), offboarding: {} },
    });
    expect(
      await built.services.tokenList.listOrganization(own, {
        after: null,
        limit: 10,
        now: systemClock.now().toISOString(),
      }),
    ).toEqual({ items: [], next: null });
  },
};

export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/access-services.ts',
    builder: 'createAccessServices',
    cases: [foreignTokens],
    predicates: [
      {
        name: 'assembled token reader scopes rows by organization',
        locate: ref('t', 'org_id', '\\?'),
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignTokens.name,
      },
    ],
    waivers: [
      {
        locate: /(?:tp\.org_id = \?|"sp"\."org_id" = "t"\."org_id")/,
        reason:
          'delegated unchanged to createTokenReader; composition adds no SQL or organization predicates',
      },
    ],
  },
];
