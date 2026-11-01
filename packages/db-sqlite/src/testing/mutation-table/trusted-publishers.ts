import { expect } from 'vitest';
import { ulid } from '@package-broker/core/ids';
import type { Statement } from '@package-broker/core/db/port';
import {
  createTrustedPublisherLookup,
  createTrustedPublisherStore,
} from '../../repositories/trusted-publishers.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, seedUser } from './fixtures.js';

const readCase: ContractCase = {
  name: 'publisher admin reads exclude foreign bindings',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'publisher-user', foreign.orgId);
    await seed(
      "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('principal',?,'Publisher','publisher-user')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO trusted_publisher (id,org_id,package_name,repository_id,repository_owner_id,repository,workflow,environment,service_principal_id,created_by_user_id) VALUES ('publisher',?,'widget','123','456','owner/repo','publish.yml','','principal','publisher-user')",
      foreign.orgId,
    );
    const store = createTrustedPublisherStore(
      {
        ...context.executor,
        all: (statement) => context.executor.all(context.mutate(statement)),
      },
      [],
    );
    expect(await store.get(own, 'publisher')).toBeNull();
    expect((await store.list(own)).items).toEqual([]);
  },
};
const pagingCase: ContractCase = {
  name: 'publisher paging excludes ids before the cursor and bounds the SQL read',
  async run(context) {
    const { own } = orgOf(context);
    const seed = seeder(context.executor);
    await seedUser(seed, 'publisher-user', own.orgId);
    await seed(
      "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('principal',?,'Publisher','publisher-user')",
      own.orgId,
    );
    const ids = Array.from({ length: 4 }, () => ulid()).sort();
    for (const id of ids)
      await seed(
        "INSERT INTO trusted_publisher (id,org_id,package_name,repository_id,repository_owner_id,repository,workflow,environment,service_principal_id,created_by_user_id) VALUES (?,?,'widget','123','456','owner/repo','publish.yml',?,'principal','publisher-user')",
        id,
        own.orgId,
        id,
      );
    const store = createTrustedPublisherStore(
      {
        ...context.executor,
        async all<R>(statement: Statement): Promise<R[]> {
          const rows = await context.executor.all<R>(context.mutate(statement));
          expect(rows.length).toBeLessThanOrEqual(2);
          return rows;
        },
      },
      [],
    );
    const page = await store.list(own, { cursor: ids[0]!, limit: 1 });
    expect(page.items.map((item) => item.id)).toEqual([ids[1]]);
    expect(page.next).toBe(ids[1]);
  },
};
const lookupCase: ContractCase = {
  name: 'publisher repository identity lookup excludes foreign source credentials',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO credential (id,org_id,project_id,kind,ciphertext,nonce,key_version,aad) VALUES ('credential',?,NULL,'bearer',X'01',zeroblob(12),1,'test')",
      foreign.orgId,
    );
    await seed(
      "INSERT INTO source (id,org_id,name,ecosystem,type,credential_id,config_json) VALUES ('github',?,'GitHub','npm','vcs','credential',?)",
      foreign.orgId,
      JSON.stringify({ provider: 'github', repository: 'owner/repo' }),
    );
    const lookup = createTrustedPublisherLookup(
      {
        ...context.executor,
        all: (statement) => context.executor.all(context.mutate(statement)),
      },
      async () => ({ repository: 'owner/repo', repositoryId: '123', repositoryOwnerId: '456' }),
    );
    expect(await lookup(own, 'owner/repo', new AbortController().signal)).toBeNull();
  },
};
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/trusted-publishers.ts',
    builder: 'createTrustedPublisherStore',
    cases: [readCase],
    sqlDecisions: [
      {
        name: 'publisher list applies the cursor',
        pattern: /"tp"\."id" > \?/,
        replacement: '? is not null',
        expected: 1,
        case: pagingCase,
      },
      {
        name: 'publisher list bounds its database read',
        pattern: /limit \?/,
        replacement: 'limit (? + 100)',
        expected: 1,
        case: pagingCase,
      },
    ],
    predicates: [
      {
        name: 'publisher reads scope bindings by organization',
        locate: /"tp"\."org_id" = \?/,
        neutral: NOT_NULL,
        copies: 2,
        caseName: readCase.name,
      },
    ],
    waivers: [
      {
        locate: /"sp"\."org_id" = "tp"\."org_id"/,
        reason:
          'The principal joins the organization-scoped binding by organization and principal identity.',
      },
    ],
  },
  {
    file: 'repositories/trusted-publishers.ts',
    builder: 'createTrustedPublisherLookup',
    cases: [lookupCase],
    predicates: [
      {
        name: 'GitHub credential source belongs to the organization',
        locate: /"org_id" = \?/,
        neutral: NOT_NULL,
        copies: 1,
        caseName: lookupCase.name,
      },
    ],
  },
];
