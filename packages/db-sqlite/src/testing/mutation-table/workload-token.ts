import { expect } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import { ulid } from '@package-broker/core/ids';
import type { WorkloadTokenFence } from '@package-broker/core/authz/service-token-service';
import {
  createWorkloadTokenStore,
  workloadTokenStatements,
  disableTrustedPublisherStatements,
} from '../../repositories/workload-token.js';
import { createOidcRepository } from '../../repositories/oidc.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { seedUser, seedSource, NOT_NULL, ref } from './fixtures.js';
const minted = {
  selector: 'abcdefghijkl',
  hash: 'a'.repeat(64),
  pepperVersion: 1,
  plaintext: 'pb_svc_abcdefghijkl_' + 'a'.repeat(43),
};
function event(action: 'token.workload_issue' | 'trusted_publisher.disable', now: string) {
  const result = auditEvent({
    id: ulid(),
    now,
    action,
    actor: { type: 'system', id: null },
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    target: { type: 'trusted_publisher', id: 'publisher' },
  });
  if (!result.ok) throw new Error('fixture');
  return result.event;
}
async function publisher(context: CaseContext, orgId: string, suffix: string) {
  const seed = seeder(context.executor);
  await seedUser(seed, 'user-' + suffix, orgId);
  await seed(
    'INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES (?,?,?,?)',
    'principal-' + suffix,
    orgId,
    'Publisher',
    'user-' + suffix,
  );
  await seed(
    "INSERT INTO service_principal_permission VALUES (?,?,'org:packages:publish')",
    orgId,
    'principal-' + suffix,
  );
  await seedSource(seed, 'source-' + suffix, orgId, 'hosted', 'npm');
  await seed(
    "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES (?,?,?,'npm','test')",
    'claim-' + suffix,
    orgId,
    'source-' + suffix,
  );
  await seed(
    "INSERT INTO trusted_publisher (id,org_id,package_name,repository_id,repository_owner_id,repository,workflow,environment,service_principal_id,created_by_user_id) VALUES (?,?,'test','123','456','owner/repo','publish.yml','',?,?)",
    'publisher-' + suffix,
    orgId,
    'principal-' + suffix,
    'user-' + suffix,
  );
}
const guardCase: ContractCase = {
  name: 'workload admission guard refuses an enabled foreign publisher with otherwise valid claims',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await publisher(context, foreign.orgId, 'foreign');
    const now = new Date().toISOString();
    const row = (
      await createOidcRepository(context.executor).find(foreign, {
        packageName: 'test',
        repositoryId: '123',
        repositoryOwnerId: '456',
        workflow: 'publish.yml',
        environment: '',
      })
    )[0]!;
    const fence: WorkloadTokenFence = { publisher: row, replay: { appendTo: (batch) => batch } };
    const input = {
      id: 'workload',
      now,
      expiresAt: new Date(Date.parse(now) + 900000).toISOString(),
      audit: event('token.workload_issue', now),
    };
    // Isolate admission so the token's foreign-key trigger cannot mask a lost organization fence.
    await expect(
      context.executor.batch(
        context.mutateBatch(workloadTokenStatements(own, fence, input, minted).slice(0, 1)),
      ),
    ).rejects.toThrow();
  },
};
const factoryCase: ContractCase = {
  name: 'workload store refuses a foreign publisher at its admission guard',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await publisher(context, foreign.orgId, 'foreign');
    const now = new Date().toISOString();
    const row = (
      await createOidcRepository(context.executor).find(foreign, {
        packageName: 'test',
        repositoryId: '123',
        repositoryOwnerId: '456',
        workflow: 'publish.yml',
        environment: '',
      })
    )[0]!;
    const store = createWorkloadTokenStore({
      ...context.executor,
      batch: (statements) => context.executor.batch(context.mutateBatch(statements.slice(0, 1))),
    });
    expect(
      (
        await store.issueWorkload(
          own,
          { publisher: row, replay: { appendTo: (batch) => batch } },
          {
            id: 'workload',
            now,
            expiresAt: new Date(Date.parse(now) + 900000).toISOString(),
            audit: event('token.workload_issue', now),
          },
          () => minted,
        )
      ).status,
    ).not.toBe('issued');
  },
};
const disablePublisher: ContractCase = {
  name: 'publisher disable cannot change a foreign publisher',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await publisher(context, foreign.orgId, 'foreign');
    const now = new Date().toISOString();
    try {
      await context.executor.batch(
        context.mutateBatch(
          disableTrustedPublisherStatements(own, {
            id: 'publisher-foreign',
            expectedRevision: 1,
            now,
            audit: event('trusted_publisher.disable', now),
          }),
        ),
      );
    } catch {
      /* A foreign publisher loses the compare-and-set. */
    }
    expect(
      await context.executor.all({
        sql: "SELECT disabled_at FROM trusted_publisher WHERE id='publisher-foreign'",
        params: [],
      }),
    ).toEqual([{ disabled_at: null }]);
  },
};
const disableToken: ContractCase = {
  name: 'publisher disable preserves a foreign token with a forged own publisher binding',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await publisher(context, own.orgId, 'own');
    await publisher(context, foreign.orgId, 'foreign');
    const seed = seeder(context.executor);
    await context.executor.all({ sql: 'DROP TRIGGER token_trusted_publisher_insert', params: [] });
    await seed.forged(
      "INSERT INTO token (id,org_id,kind,service_principal_id,selector,hash,pepper_version,name,project_mode,scopes_json,expires_at,trusted_publisher_id) VALUES ('foreign',?,'svc','principal-foreign','abcdefghijkl',?,1,'workload','all','[\"write\"]','2099-01-01T00:00:00.000Z','publisher-own')",
      foreign.orgId,
      'a'.repeat(64),
    );
    const now = new Date().toISOString();
    await context.executor.batch(
      context.mutateBatch(
        disableTrustedPublisherStatements(own, {
          id: 'publisher-own',
          expectedRevision: 1,
          now,
          audit: event('trusted_publisher.disable', now),
        }),
      ),
    );
    expect(
      await context.executor.all({
        sql: "SELECT revoked_at FROM token WHERE id='foreign'",
        params: [],
      }),
    ).toEqual([{ revoked_at: null }]);
  },
};
export const entries: readonly MutationEntry[] = [
  ...[
    { builder: 'workloadTokenStatements', contract: guardCase },
    { builder: 'createWorkloadTokenStore', contract: factoryCase },
  ].map(({ builder, contract }) => ({
    file: 'repositories/workload-token.ts',
    builder,
    cases: [contract],
    predicates: [
      {
        name: 'workload publisher organization',
        locate: /tp\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: contract.name,
      },
    ],
    waivers: [
      {
        locate: /(?:sp|spp|rn|s)\.org_id = (?:tp|s)\.org_id/,
        reason:
          'Child rows join the organization-scoped publisher and source; these relation identities are also exercised by the workload issuance contract.',
      },
    ],
  })),
  {
    file: 'repositories/workload-token.ts',
    builder: 'disableTrustedPublisherStatements',
    cases: [disablePublisher, disableToken],
    predicates: [
      {
        name: 'disabled publisher organization',
        locate: ref('trusted_publisher', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: disablePublisher.name,
      },
      {
        name: 'revoked workload token organization',
        locate: ref('token', 'org_id', '\\?'),
        neutral: NOT_NULL,
        caseName: disableToken.name,
      },
    ],
  },
];
