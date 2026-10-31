import { expect } from 'vitest';
import {
  createOidcRepository,
  findTrustedPublishersStatement,
  oidcReplayStatements,
  purgeOidcReplayStatement,
} from '../../repositories/oidc.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { ref, NOT_NULL } from './fixtures.js';
const issuer = 'https://token.actions.githubusercontent.com';
const match = {
  packageName: 'test',
  repositoryId: '123',
  repositoryOwnerId: '456',
  workflow: 'publish.yml',
  environment: '',
};
async function seedForeign(context: CaseContext) {
  const { foreign } = orgOf(context);
  const seed = seeder(context.executor);
  await seed(
    'INSERT INTO user_account (id, org_id, email) VALUES (?, ?, ?)',
    'oidc-user',
    foreign.orgId,
    'fixture@example.test',
  );
  await seed(
    'INSERT INTO service_principal (id, org_id, name, created_by_user_id) VALUES (?, ?, ?, ?)',
    'oidc-principal',
    foreign.orgId,
    'publisher',
    'oidc-user',
  );
  await seed(
    "INSERT INTO trusted_publisher (id, org_id, package_name, repository_id, repository_owner_id, repository, workflow, environment, service_principal_id, created_by_user_id) VALUES ('oidc-publisher', ?, 'test', '123', '456', 'owner/repo', 'publish.yml', '', 'oidc-principal', 'oidc-user')",
    foreign.orgId,
  );
}
const findCase: ContractCase = {
  name: 'OIDC binding lookup excludes a foreign matching publisher',
  async run(context) {
    await seedForeign(context);
    const { own } = orgOf(context);
    expect(
      await context.executor.all(context.mutate(findTrustedPublishersStatement(own, match))),
    ).toEqual([]);
  },
};
const reserveCase: ContractCase = {
  name: 'OIDC replay cannot reserve a foreign publisher',
  async run(context) {
    await seedForeign(context);
    const { own, foreign } = orgOf(context);
    try {
      await context.executor.batch(
        context.mutateBatch(
          oidcReplayStatements(own, {
            issuer,
            jti: 'unique',
            trustedPublisherId: 'oidc-publisher',
            expectedRevision: 1,
            expiresAt: 1800000000,
            now: '2026-10-31T00:00:00.000Z',
          }),
        ),
      );
    } catch {
      /* The fence aborts the entire batch. */
    }
    expect(
      await context.executor.all({
        sql: 'SELECT jti FROM oidc_replay WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([]);
  },
};
const purgeCase: ContractCase = {
  name: 'OIDC replay purge preserves expired foreign entries',
  async run(context) {
    await seedForeign(context);
    const { own, foreign } = orgOf(context);
    await context.executor.all({
      sql: 'INSERT INTO oidc_replay VALUES (?, ?, ?, ?, ?)',
      params: [issuer, 'unique', foreign.orgId, 'oidc-publisher', '2026-01-01T00:00:00.000Z'],
    });
    await context.executor.all(
      context.mutate(purgeOidcReplayStatement(own, '2026-10-31T00:00:00.000Z')),
    );
    expect(
      await context.executor.all({
        sql: 'SELECT jti FROM oidc_replay WHERE org_id = ?',
        params: [foreign.orgId],
      }),
    ).toEqual([{ jti: 'unique' }]);
  },
};
const factoryCase: ContractCase = {
  name: 'OIDC repository lookup excludes a foreign matching publisher',
  async run(context) {
    await seedForeign(context);
    const { own } = orgOf(context);
    const repo = createOidcRepository({
      ...context.executor,
      all: (statement) => context.executor.all(context.mutate(statement)),
    });
    expect(await repo.find(own, match)).toEqual([]);
  },
};
export const entries: readonly MutationEntry[] = [
  ...[
    { builder: 'findTrustedPublishersStatement', contract: findCase },
    { builder: 'oidcReplayStatements', contract: reserveCase },
    { builder: 'createOidcRepository', contract: factoryCase },
  ].map(({ builder, contract }) => ({
    builder,
    file: 'repositories/oidc.ts',
    cases: [contract],
    predicates: [
      {
        name: 'publisher belongs to the organization',
        locate: ref('trusted_publisher', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: contract.name,
      },
    ],
    ...(builder === 'oidcReplayStatements'
      ? {
          waivers: [
            {
              locate: /service_principal\.org_id = trusted_publisher\.org_id/,
              reason: 'The principal is joined to the organization-scoped publisher.',
            },
          ],
        }
      : {}),
  })),
  {
    builder: 'purgeOidcReplayStatement',
    file: 'repositories/oidc.ts',
    cases: [purgeCase],
    predicates: [
      {
        name: 'replay purge belongs to the organization',
        locate: ref('oidc_replay', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: purgeCase.name,
      },
    ],
  },
];
