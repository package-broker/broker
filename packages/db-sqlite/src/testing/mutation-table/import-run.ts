import { expect } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import { createImportRunStore } from '../../repositories/import-run.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
} from './harness.js';
import { NOT_NULL } from './fixtures.js';

const read: ContractCase = {
  name: 'an import run in another organization is indistinguishable from an absent run',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seeder(context.executor)(
      "INSERT INTO import_run (id, org_id, source_system) VALUES ('foreign-run', ?, 'test')",
      foreign.orgId,
    );
    const store = storeFor(context);
    const fence = mutationFence(
      { userId: 'missing', sessionId: 'missing' } as AuthenticatedActor,
      {},
    );
    const result = await store.inspect(
      own,
      fence,
      'approveRun',
      'foreign-run',
      new Date().toISOString(),
    );
    expect(result.run).toBeNull();
  },
};

const reauth: ContractCase = {
  name: 'a matching foreign session cannot supply import reauthentication',
  async run(context) {
    const { own, foreign } = orgOf(context);
    const seed = seeder(context.executor);
    await seed(
      "INSERT INTO user_account (id, org_id, email) VALUES ('foreign-actor', ?, 'foreign@example.test')",
      foreign.orgId,
    );
    await seed(
      `INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, reauth_at)
       VALUES ('foreign-session', ?, 'foreign-actor', ?, ?,
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 hour'),
         strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
      foreign.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
    );
    const fence = mutationFence(
      { userId: 'foreign-actor', sessionId: 'foreign-session' } as AuthenticatedActor,
      {},
    );
    const store = storeFor(context);
    const now = new Date().toISOString();
    expect((await store.inspect(own, fence, 'approveRun', null, now)).reauthFresh).toBe(false);
  },
};

const windows: ContractCase = {
  name: 'a foreign import run has no credential window in the organization',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seeder(context.executor)(
      "INSERT INTO import_run (id, org_id, source_system, credential_window_until) VALUES ('foreign-window', ?, 'test', ?)",
      foreign.orgId,
      new Date(Date.now() + 3600000).toISOString(),
    );
    expect([...(await storeFor(context).credentialWindows(own, ['foreign-window']))]).toEqual([]);
  },
};

function storeFor(context: CaseContext) {
  return createImportRunStore({
    executor: {
      driver: context.executor.driver,
      all: (statement) => context.executor.all(context.mutate(statement)),
      batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
    },
    providerAnchors: [],
    blobs: {
      async stage() {
        throw new Error('not_implemented');
      },
      async openStaged() {
        throw new Error('not_implemented');
      },
      async promote() {
        throw new Error('not_implemented');
      },
      async discard() {
        throw new Error('not_implemented');
      },
      async put() {
        throw new Error('unexpected blob upload');
      },
      async get() {
        return null;
      },
      async head() {
        return null;
      },
    },
  });
}

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createImportRunStore',
    file: 'repositories/import-run.ts',
    cases: [read, reauth, windows],
    predicates: [
      {
        name: 'credential window reads are scoped to the organization',
        locate: /(?<!\.)\borg_id = \?/,
        neutral: NOT_NULL,
        caseName: windows.name,
        copies: 1,
      },
      {
        name: 'run reads are scoped to the organization',
        locate: /(?<!\.)\borg_id = \?/,
        neutral: NOT_NULL,
        caseName: read.name,
      },
      {
        name: 'session reauthentication is scoped to the organization',
        locate: /irs\.org_id = \?/,
        neutral: NOT_NULL,
        caseName: reauth.name,
        copies: 1,
      },
    ],
    waivers: [
      {
        locate:
          /"[^"]+"\."org_id" = (?:\?|"[^"]+"\."org_id"|\(select "guard_values"\."org_id" from "guard_values"\))/,
        reason:
          'shared actorHolds and permissionRows predicates have their own mutation registrations',
      },
    ],
  },
];
