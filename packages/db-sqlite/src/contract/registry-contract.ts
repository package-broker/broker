import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { AuditEvent } from '@package-broker/core/audit/actions';
import { sql } from 'kysely';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { createSourcePollJob } from '@package-broker/core/ingest/retention-jobs';
import { createRepositoryJobs } from '@package-broker/core/platform/jobs-port';
import { defineJob, type JobContext } from '@package-broker/core/platform/jobs';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { CREDENTIAL_UNAVAILABLE_REPLACES } from '@package-broker/core/sources/source-unavailable';
import { compile, db } from '../kysely.js';
import { migrate } from '../migrations/runner.js';
import { loadMigrationSource } from '../migrations/source.js';
import { createJobRepository } from '../repositories/job.js';
import { createSourceRepository } from '../repositories/source.js';
import { createScopedAdmission } from '../repositories/scoped-admission.js';
import {
  createFetchLeases,
  createFetchLeaseWriteGuard,
  leaseKey,
} from '../repositories/fetch-lease.js';
import { packageUpsertStatements } from '../repositories/catalogue-write-package.js';
import { createUpstreamStateRepository } from '../repositories/upstream-state.js';
import { replaceBlobStatements } from '../repositories/catalogue-reblob.js';
import {
  createIngestSessions,
  createIngestSessionWriteGuard,
} from '../repositories/ingest-session.js';
import { createCatalogueReconciler } from '../repositories/catalogue-reconcile.js';
import { createIngestFinalizer } from '../repositories/ingest-finalize.js';
import { createRepresentationClock } from '../repositories/representation-clock.js';
import { createExistingVersionsReader } from '../repositories/existing-versions.js';
import { createBlobReferenceReader } from '../repositories/blob-references.js';
import { createWebhookDeliveryRepository } from '../repositories/webhook-delivery.js';
import {
  createRegisteredNameRepository,
  sourceActivatable,
} from '../repositories/registered-name.js';
import { seedTwoOrganizations } from './two-organizations.js';

/** The factory supplies a fresh database with no organization rows; the suite runs migrations. */
export interface RegistryContractFixture {
  readonly executor: SqlExecutor;
  close(): Promise<void>;
}
export type RegistryExecutorFactory = () => Promise<RegistryContractFixture>;
type Wrap = (executor: SqlExecutor) => SqlExecutor;
const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const OLD = '2000-01-01T00:00:00.000Z';
const SHA = 'a'.repeat(64) as Sha256;
const NEW_SHA = 'b'.repeat(64) as Sha256;
const validators = { etag: '"complete"', lastModified: null, contentSha256: SHA };

interface World {
  executor: SqlExecutor;
  a: OrgContext;
  b: OrgContext;
  seed(sql: string, ...params: Statement['params']): Promise<unknown>;
}
async function withWorld(
  open: RegistryExecutorFactory,
  body: (w: World) => Promise<void>,
  wrap?: Wrap,
) {
  const opened = await open();
  if (
    typeof opened?.close !== 'function' ||
    typeof opened.executor?.all !== 'function' ||
    typeof opened.executor.batch !== 'function'
  ) {
    throw new Error('registry contract fixture requires an executor and close');
  }
  try {
    const directory = new URL('../../migrations/', import.meta.url);
    const sources = await Promise.all(
      readdirSync(directory)
        .filter((name) => name.endsWith('.sql'))
        .sort()
        .map((name) =>
          loadMigrationSource('core', name, readFileSync(new URL(name, directory), 'utf8')),
        ),
    );
    await migrate(opened.executor, sources, { holder: 'registry-contract' });
    const { a, b } = await seedTwoOrganizations(opened.executor);
    const seed: World['seed'] = (text, ...params) => opened.executor.batch([st(text, ...params)]);
    for (const [org, suffix] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      await seed(
        'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
        `project-${suffix}`,
        org.orgId,
        suffix,
        suffix,
      );
      await seed(
        `INSERT INTO source (id, org_id, name, ecosystem, type, config_json)
        VALUES (?, ?, ?, 'npm', 'npm_registry', '{"scopes":["@acme"]}')`,
        `source-${suffix}`,
        org.orgId,
        suffix,
      );
      await seed(
        'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
        org.orgId,
        `project-${suffix}`,
        `source-${suffix}`,
      );
      await seed(
        `INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
        VALUES (?, ?, ?, 'npm', '@acme/pkg', ?)`,
        `package-${suffix}`,
        org.orgId,
        `source-${suffix}`,
        OLD,
      );
      await seed(
        `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, updated_at)
        VALUES (?, ?, ?, '1.0.0', '1.0.0', ?, 'broker', '{}', ?)`,
        `version-${suffix}`,
        org.orgId,
        `package-${suffix}`,
        OLD,
        OLD,
      );
      await seed(
        `INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern)
        VALUES (?, ?, ?, 'npm', '@acme/*')`,
        `name-${suffix}`,
        org.orgId,
        `source-${suffix}`,
      );
    }
    await body({ executor: wrap?.(opened.executor) ?? opened.executor, a, b, seed });
  } finally {
    await opened.close();
  }
}
function acquired<T>(handle: T | 'held'): T {
  if (handle === 'held') throw new Error('registry contract fixture unexpectedly held');
  return handle;
}
const snapshot = (w: World) =>
  Promise.all(
    [
      'package',
      'version',
      'version_revision',
      'blob',
      'upstream_state',
      'ingest_session',
      'cache_epoch',
    ].map((table) => w.executor.all(st(`SELECT * FROM ${table} ORDER BY 1`))),
  );
async function begin(w: World, kind: 'source' | 'package') {
  const sessions = createIngestSessions(w.executor);
  const handle = acquired(
    await sessions.acquire(
      w.a,
      kind === 'source'
        ? { scope: kind, sourceId: 'source-a' }
        : { scope: kind, sourceId: 'source-a', packageKey: '@acme/pkg' },
      'worker',
      60,
    ),
  );
  const guard = createIngestSessionWriteGuard(w.a, handle);
  const scope =
    kind === 'source'
      ? ({ kind, sourceId: 'source-a' } as const)
      : ({ kind, packageId: 'package-a' } as const);
  const reconciler = createCatalogueReconciler(w.executor);
  const { stamp } = await reconciler.openListing(w.a, guard, scope);
  expect(await sessions.start(w.a, handle, { snapshot: { id: 'snapshot' }, stamp })).toBe(true);
  if (kind === 'package')
    expect(await sessions.setPendingValidators(w.a, handle, { 'npm-packument': validators })).toBe(
      true,
    );
  return {
    handle,
    mark: (present: readonly string[]) =>
      reconciler.markListing(w.a, guard, { scope, stamp, present }),
  };
}
const evidence = (count: number) => ({
  expectedCount: count,
  upstreamComplete: true,
  validatorTtlSeconds: 60,
  attemptedCandidates: count,
  successfulCandidates: count,
  definitiveAbsent: 0,
});

type Case = (open: RegistryExecutorFactory, wrap?: Wrap) => Promise<void>;
export const registryContractCases = {
  completedPollKeepsSameMinuteRequestDue: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const sources = createSourceRepository(w.executor);
        const store = createJobRepository(w.executor);
        const type = 'core:source-sync:v1';
        let now = new Date(OLD);
        let sequence = 0;
        const clock = { now: () => now };
        const jobs = createRepositoryJobs({
          store,
          clock,
          ids: { ulid: () => `poll-sync-${String(++sequence)}` },
          jobs: [
            {
              qualifiedName: type,
              definition: defineJob({
                name: 'source-sync',
                version: 1,
                validate: (input) => input,
                handler: async () => {},
              }),
            },
          ],
        })('core', { projectId: null, tokenId: null });
        const poll = createSourcePollJob({ sources });
        const context = {
          org: w.a,
          signal: new AbortController().signal,
          ports: { clock, platform: { jobs } },
          observability: {
            counter: () => {
              throw new Error('unexpected poll failure');
            },
          },
        } as unknown as JobContext;
        await w.seed(
          `INSERT INTO source (id, org_id, name, ecosystem, type, poll_interval_seconds, next_poll_at)
          VALUES ('poll-source', ?, 'Poll source', 'composer', 'composer_repository', 86400, ?)`,
          w.a.orgId,
          OLD,
        );
        await poll.handler({}, context);
        expect(await sources.listDue(w.a, 50)).toEqual([]);
        const first = await store.claim(w.a, '01J00000000000000000000001', {
          types: [type],
          leaseSeconds: 60,
          maxRunning: 1,
        });
        expect(first).not.toBeNull();
        await store.settle(w.a, first!, { outcome: 'succeeded' });

        // A new sync/enable request arrives after completion in the same minute.
        now = new Date('2000-01-01T00:00:10.000Z');
        await w.seed(
          "UPDATE source SET next_poll_at = ? WHERE org_id = ? AND id = 'poll-source'",
          now.toISOString(),
          w.a.orgId,
        );
        await poll.handler({}, context);
        expect(await sources.listDue(w.a, 50)).toMatchObject([
          { id: 'poll-source', nextPollAt: now.toISOString() },
        ]);
        expect(
          await w.executor.all(st('SELECT id, state FROM job WHERE org_id = ?', w.a.orgId)),
        ).toEqual([{ id: first!.id, state: 'succeeded' }]);

        now = new Date('2000-01-01T00:01:00.000Z');
        await poll.handler({}, context);
        expect(await sources.listDue(w.a, 50)).toEqual([]);
        const second = await store.claim(w.a, '01J00000000000000000000002', {
          types: [type],
          leaseSeconds: 60,
          maxRunning: 1,
        });
        expect(second).not.toBeNull();
        expect(second!.id).not.toBe(first!.id);
        expect(JSON.parse(second!.payloadJson)).toEqual({
          sourceId: 'poll-source',
          reason: 'poll',
        });
        const source = (await sources.get(w.a, 'poll-source'))!;
        expect(source.pollIntervalSeconds).toBe(86400);
        expect(Date.parse(source.nextPollAt!)).toBeGreaterThan(Date.now() + 86_390_000);
        expect(await store.status(w.b, second!.id)).toBeNull();
      },
      wrap,
    ),
  registeredNameEnableOperation: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const now = new Date().toISOString();
        const address = ['admin', 'example.test'].join('@');
        const anchors = [
          {
            provider: 'oidc',
            anchor: 'oidc:https://idp.example.test',
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test'],
          },
        ];
        await w.seed(
          "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', ?)",
          w.a.orgId,
          anchors[0]!.anchor,
        );
        await w.seed(
          "INSERT INTO user_account (id, org_id, email, status) VALUES ('admin', ?, ?, 'active')",
          w.a.orgId,
          address,
        );
        await w.seed(
          "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'admin', 'oidc', 'admin', ?, 1, ?)",
          w.a.orgId,
          address,
          OLD,
        );
        await w.seed(
          "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('role', ?, 'admin', 'Admin', 'organization', 0)",
          w.a.orgId,
        );
        await w.seed(
          "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'role', 'org:sources:write')",
          w.a.orgId,
        );
        await w.seed(
          "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', ?, 'organization', 'role')",
          w.a.orgId,
          address,
        );
        await w.seed(
          "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'admin', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
          w.a.orgId,
          SHA,
          NEW_SHA,
          now,
          now,
        );
        const fence = mutationFence(
          { userId: 'admin', sessionId: 'session' } as AuthenticatedActor,
          {},
        );
        const audit: AuditEvent = {
          id: '01J00000000000000000000001',
          occurredAt: now,
          action: 'source.resume',
          actor: { type: 'user', id: 'admin' },
          tokenSelector: null,
          sourceIp: null,
          target: { type: 'source', id: 'source-a' },
          projectId: null,
          payloadJson: '{}',
        };
        const names = createRegisteredNameRepository(w.executor);
        const input = { id: 'source-a', providerAnchors: anchors, audit };
        await w.seed("UPDATE source SET status = 'paused' WHERE id = 'source-a'");
        await w.seed("DELETE FROM registered_name WHERE id = 'name-a'");
        expect(await names.enable(w.a, fence, input)).toBe('activation_requires_registered_names');
        expect(await w.executor.all(st('SELECT * FROM audit_pending'))).toEqual([]);
        await w.seed(
          "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('restored', ?, 'source-a', 'npm', '@acme/*')",
          w.a.orgId,
        );
        expect(await names.enable(w.b, fence, input)).toBe('forbidden');
        await w.seed(
          "UPDATE source SET next_poll_at = '2999-01-01T00:00:00.000Z' WHERE id = 'source-a'",
        );
        expect(await names.enable(w.a, fence, input)).toBe('enabled');
        const sources = createSourceRepository(w.executor);
        expect(Date.parse((await sources.get(w.a, 'source-a'))!.nextPollAt!)).toBeLessThanOrEqual(
          Date.now(),
        );
        expect(await names.enable(w.a, fence, input)).toBe('already_enabled');
        expect(await w.executor.all(st('SELECT action FROM audit_pending'))).toEqual([
          { action: 'source.resume' },
        ]);
        const syncInput = {
          ...input,
          audit: {
            ...audit,
            id: '01J00000000000000000000002',
            action: 'source.sync_requested' as const,
          },
        };
        await w.seed(
          "UPDATE source SET next_poll_at = '2999-01-01T00:00:00.000Z' WHERE id = 'source-a'",
        );
        expect(await sources.syncNow(w.b, fence, syncInput)).toBe('forbidden');
        expect(await sources.syncNow(w.a, fence, syncInput)).toBe('requested');
        expect(await sources.get(w.a, 'source-a')).toMatchObject({ pollIntervalSeconds: 86400 });
        expect(Date.parse((await sources.get(w.a, 'source-a'))!.nextPollAt!)).toBeLessThanOrEqual(
          Date.now(),
        );
        expect(await w.executor.all(st('SELECT action FROM audit_pending ORDER BY id'))).toEqual([
          { action: 'source.resume' },
          { action: 'source.sync_requested' },
        ]);
        await w.seed(
          "INSERT INTO job (id, org_id, type, idempotency_key, resource_key, state, lease_owner, lease_until, fence) VALUES ('sync-job', ?, 'core:source-sync:v1', 'sync', 'source:source-a', 'running', 'worker', '2999-01-01T00:00:00.000Z', 1)",
          w.a.orgId,
        );
        const guard = { id: 'sync-job', owner: 'worker', fence: 1 };
        expect(
          await sources.pollState(w.a, guard, {
            id: 'source-a',
            outcome: 'failure',
            error: 'credential_unavailable',
          }),
        ).toBe('written');
        expect(await sources.get(w.a, 'source-a')).toMatchObject({
          lastError: 'credential_unavailable',
          lastPolledAt: expect.any(String),
          nextPollAt: expect.any(String),
        });
        expect(await sources.pollState(w.a, guard, { id: 'source-a', outcome: 'success' })).toBe(
          'written',
        );
        expect(await sources.get(w.a, 'source-a')).toMatchObject({
          lastError: null,
          lastSuccessAt: expect.any(String),
        });
        await w.seed("UPDATE source SET status = 'paused' WHERE id = 'source-a'");
        expect(
          await sources.syncNow(w.a, fence, {
            ...syncInput,
            audit: { ...syncInput.audit, id: '01J00000000000000000000003' },
          }),
        ).toBe('source_paused');
      },
      wrap,
    ),
  credentialUnavailableMark: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const sources = createSourceRepository(w.executor);
        const before = (await sources.get(w.a, 'source-a'))!;
        expect(before.lastError).not.toBe('credential_unavailable');
        await sources.markCredentialUnavailable(w.b, 'source-a');
        expect(await sources.get(w.a, 'source-a')).toEqual(before);
        await sources.markCredentialUnavailable(w.a, 'source-a');
        const marked = { ...before, lastError: 'credential_unavailable' };
        expect(await sources.get(w.a, 'source-a')).toEqual(marked);
        await sources.markCredentialUnavailable(w.a, 'source-a');
        expect(await sources.get(w.a, 'source-a')).toEqual(marked);
        for (const transient of CREDENTIAL_UNAVAILABLE_REPLACES) {
          await w.seed(`UPDATE source SET last_error = '${transient}' WHERE id = 'source-a'`);
          await sources.markCredentialUnavailable(w.a, 'source-a');
          expect(await sources.get(w.a, 'source-a')).toEqual(marked);
        }
        for (const specific of [
          'unauthorized',
          'mass_absence',
          'policy_denied',
          'not_found',
          'invalid_response',
          'too_large',
          'internal',
        ]) {
          await w.seed(`UPDATE source SET last_error = '${specific}' WHERE id = 'source-a'`);
          await sources.markCredentialUnavailable(w.a, 'source-a');
          expect(await sources.get(w.a, 'source-a')).toEqual({ ...before, lastError: specific });
        }
        await expect(sources.markCredentialUnavailable(w.a, 'missing')).resolves.toBeUndefined();
      },
      wrap,
    ),
  sourceFinalization: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const { handle, mark } = await begin(w, 'source');
        const before = await snapshot(w);
        const finalizer = createIngestFinalizer(w.executor);
        expect(
          await finalizer.finalize(w.a, handle, { ...evidence(0), upstreamComplete: false }),
        ).toEqual({ status: 'refused', reason: 'incomplete' });
        expect(await snapshot(w)).toEqual(before);
        await mark(['@acme/pkg']);
        expect(await finalizer.finalize(w.a, handle, evidence(1))).toMatchObject({
          status: 'complete',
          empty: false,
          validatorsPublished: 0,
        });
        expect(
          await w.executor.all(st('SELECT status FROM package WHERE org_id = ?', w.b.orgId)),
        ).toEqual([{ status: 'active' }]);
        expect(await finalizer.finalize(w.a, handle, evidence(1))).toEqual({
          status: 'refused',
          reason: 'session_unavailable',
        });
      },
      wrap,
    ),
  sourceOwnership: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const sources = createSourceRepository(w.executor);
        expect(await sources.get(w.a, 'source-b')).toBeNull();
        expect(await sources.get(w.b, 'source-a')).toBeNull();
        expect(await sources.get(w.a, 'source-a')).toMatchObject({ id: 'source-a' });
        expect(await sources.get(w.a, 'missing')).toBeNull();
      },
      wrap,
    ),
  scopedAdmission: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const admit = (ctx = w.a, key = '@acme/new') =>
          createScopedAdmission(w.executor).admitScoped(ctx, { projectId: 'project-a', key });
        expect(await admit()).toEqual(['source-a']);
        expect(await admit(w.b)).toEqual([]);
        for (const key of ['plain', '@other/new', '@acme/', '@acme/new/extra', '@acme/pkg'])
          expect(await admit(w.a, key)).toEqual([]);
        await w.seed(
          "INSERT INTO project (id, org_id, slug, name) VALUES ('project-other', ?, 'other', 'Other')",
          w.a.orgId,
        );
        await w.seed("UPDATE source SET project_id = 'project-other' WHERE id = 'source-a'");
        expect(await admit()).toEqual([]);
        await w.seed(
          "UPDATE source SET project_id = NULL, status = 'paused' WHERE id = 'source-a'",
        );
        expect(await admit()).toEqual([]);
        await w.seed("UPDATE source SET status = 'active' WHERE id = 'source-a'");
        await w.seed("DELETE FROM registered_name WHERE id = 'name-a'");
        expect(await admit()).toEqual([]);
      },
      wrap,
    ),
  fetchLease: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const leases = createFetchLeases(w.executor);
        const key = await leaseKey([w.a.orgId, 'metadata', 'source-a', '@acme/pkg']);
        const first = acquired(await leases.acquire(w.a, key, 'first', 60));
        expect(await leases.acquire(w.a, key, 'second', 60)).toBe('held');
        expect(await leases.renew(w.b, first, 60)).toBe(false);
        await w.seed('UPDATE fetch_lease SET lease_until = ? WHERE lease_key = ?', OLD, key);
        expect(await leases.acquire(w.b, key, 'foreign', 60)).toBe('held');
        const second = acquired(await leases.acquire(w.a, key, 'second', 60));
        expect(second.fence).toBe(first.fence + 1);
        await leases.release(w.a, first);
        expect(await leases.acquire(w.a, key, 'third', 60)).toBe('held');
        const input = {
          sourceId: 'source-a',
          ecosystem: 'npm' as const,
          key: 'new-package',
          description: null,
        };
        const stale = packageUpsertStatements(w.a, createFetchLeaseWriteGuard(w.a, first), input);
        const before = await snapshot(w);
        await expect(
          w.executor.batch([
            st("UPDATE package SET description = 'uncommitted' WHERE org_id = ?", w.a.orgId),
            ...stale.statements,
          ]),
        ).rejects.toThrow();
        expect(await snapshot(w)).toEqual(before);
        const live = packageUpsertStatements(w.a, createFetchLeaseWriteGuard(w.a, second), input);
        await w.executor.batch(live.statements);
        expect(await createSourceRepository(w.executor).get(w.a, 'source-a')).not.toBeNull();
        expect(
          await w.executor.all(st('SELECT name FROM package WHERE id = ?', live.candidateId)),
        ).toEqual([{ name: 'new-package' }]);
      },
      wrap,
    ),
  upstreamCompletion: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const upstream = createUpstreamStateRepository(w.executor);
        const { handle, mark } = await begin(w, 'package');
        expect(await upstream.get(w.a, 'package-a', 'npm-packument')).toBeNull();
        await mark(['1.0.0']);
        expect(
          await createIngestFinalizer(w.executor).finalize(w.a, handle, evidence(1)),
        ).toMatchObject({ status: 'complete' });
        expect(await upstream.get(w.a, 'package-a', 'npm-packument')).toMatchObject({
          ...validators,
          notFoundCount: 0,
        });
        expect(await upstream.get(w.b, 'package-a', 'npm-packument')).toBeNull();
        await w.executor.batch(upstream.notFoundStatements(w.a, 'package-a', 'npm-packument', 60));
        expect(await upstream.get(w.a, 'package-a', 'npm-packument')).toMatchObject({
          etag: validators.etag,
          notFoundCount: 1,
        });
        await w.executor.batch(upstream.notFoundStatements(w.a, 'package-a', 'npm-packument', 60));
        expect(await upstream.get(w.a, 'package-a', 'npm-packument')).toMatchObject({
          notFoundCount: 2,
        });
        await w.executor.batch(
          upstream.publishStatements(w.a, 'package-a', 'npm-packument', validators, 60),
        );
        expect(await upstream.get(w.a, 'package-a', 'npm-packument')).toMatchObject({
          notFoundCount: 0,
          firstNotFoundAt: null,
        });
      },
      wrap,
    ),
  reblob: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const upstream = createUpstreamStateRepository(w.executor);
        await w.executor.batch(
          upstream.publishStatements(w.b, 'package-b', 'npm-packument', validators, 60),
        );
        const foreignRows = () =>
          Promise.all([
            w.executor.all(
              st('SELECT blob_id, revision FROM version WHERE org_id = ? ORDER BY id', w.b.orgId),
            ),
            w.executor.all(
              st(
                'SELECT * FROM upstream_state WHERE org_id = ? ORDER BY package_id, form',
                w.b.orgId,
              ),
            ),
          ]);
        const foreignBefore = await foreignRows();
        for (const [id, sha] of [
          ['blob-old', SHA],
          ['blob-new', NEW_SHA],
        ] as const)
          await w.seed(
            'INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key) VALUES (?, ?, ?, 1, ?)',
            id,
            w.a.orgId,
            sha,
            id,
          );
        await w.seed(
          "UPDATE version SET blob_id = 'blob-old', npm_integrity = 'sha512-published' WHERE id = 'version-a'",
        );
        const leases = createFetchLeases(w.executor);
        const handle = acquired(
          await leases.acquire(w.a, await leaseKey([w.a.orgId, 'reblob']), 'worker', 60),
        );
        const guard = createFetchLeaseWriteGuard(w.a, handle);
        const plan = () =>
          replaceBlobStatements(w.a, guard, {
            versionId: 'version-a',
            expectedRevision: 1,
            oldBlobId: 'blob-old',
            newSha256: NEW_SHA,
            reason: 'refetch_changed',
          });
        const before = await snapshot(w);
        await expect(w.executor.batch(plan().statements)).rejects.toThrow();
        expect(await snapshot(w)).toEqual(before);
        await w.seed(
          'UPDATE version SET npm_integrity = NULL, metadata_json = \'{"dist":{"shasum":"published"}}\' WHERE id = \'version-a\'',
        );
        const digestBefore = await snapshot(w);
        await expect(w.executor.batch(plan().statements)).rejects.toThrow();
        expect(await snapshot(w)).toEqual(digestBefore);
        await w.seed("UPDATE version SET metadata_json = '{}' WHERE id = 'version-a'");
        await w.seed(
          "INSERT INTO source (id, org_id, name, ecosystem, type) SELECT 'source-composer', org_id, 'Composer', 'composer', 'composer_repository' FROM source WHERE id = 'source-a'",
        );
        await w.seed(
          "UPDATE package SET source_id = 'source-composer', ecosystem = 'composer' WHERE id = 'package-a'",
        );
        await w.seed("UPDATE version SET composer_shasum = 'published' WHERE id = 'version-a'");
        const composerBefore = await snapshot(w);
        await expect(w.executor.batch(plan().statements)).rejects.toThrow();
        expect(await snapshot(w)).toEqual(composerBefore);
        await w.seed("UPDATE version SET composer_shasum = '' WHERE id = 'version-a'");
        const live = plan();
        expect(live.result(await w.executor.batch(live.statements))).toMatchObject({
          changed: true,
        });
        expect(
          await w.executor.all(st("SELECT blob_id, revision FROM version WHERE id = 'version-a'")),
        ).toEqual([{ blob_id: 'blob-new', revision: 2 }]);
        expect(await foreignRows()).toEqual(foreignBefore);
      },
      wrap,
    ),
  ingestTakeover: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const sessions = createIngestSessions(w.executor);
        const scope = { scope: 'package', sourceId: 'source-a', packageKey: '@acme/pkg' } as const;
        const first = acquired(await sessions.acquire(w.a, scope, 'first', 60));
        expect(await sessions.acquire(w.a, scope, 'second', 60)).toBe('held');
        await expect(sessions.acquire(w.b, scope, 'foreign', 60)).rejects.toThrow(RangeError);
        expect(
          await sessions.start(w.a, first, { snapshot: { id: 'snapshot' }, stamp: 'stamp' }),
        ).toBe(true);
        expect(await sessions.advance(w.a, first, { cursor: 'page-2', addSeen: 1 })).toEqual({
          seenCount: 1,
          pagesSoFar: 1,
        });
        await w.seed('UPDATE ingest_session SET lease_until = ? WHERE id = ?', OLD, first.id);
        const second = acquired(await sessions.acquire(w.a, scope, 'second', 60));
        expect(second).toMatchObject({
          fence: first.fence + 1,
          generation: first.generation,
          snapshotId: 'snapshot',
          stamp: 'stamp',
          cursor: 'page-2',
          seenCount: 1,
        });
        expect(await sessions.advance(w.a, first, { cursor: 'stale', addSeen: 1 })).toBeNull();
        expect(await sessions.abandon(w.b, second)).toBe(false);
        const plan = packageUpsertStatements(w.a, createIngestSessionWriteGuard(w.a, first), {
          sourceId: 'source-a',
          ecosystem: 'npm',
          key: 'stale',
          description: null,
        });
        const before = await snapshot(w);
        await expect(w.executor.batch(plan.statements)).rejects.toThrow();
        expect(await snapshot(w)).toEqual(before);
        expect(await sessions.abandon(w.a, second)).toBe(true);
        const next = acquired(await sessions.acquire(w.a, scope, 'third', 60));
        expect(next.generation).toBe(second.generation + 1);
      },
      wrap,
    ),
  finalizeProofs: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const { handle, mark } = await begin(w, 'package');
        const finalizer = createIngestFinalizer(w.executor);
        const before = await snapshot(w);
        expect(
          await finalizer.finalize(w.a, handle, { ...evidence(0), upstreamComplete: false }),
        ).toEqual({ status: 'refused', reason: 'incomplete' });
        expect(await finalizer.finalize(w.a, handle, evidence(1))).toEqual({
          status: 'refused',
          reason: 'count_mismatch',
        });
        expect(await finalizer.finalize(w.b, handle, evidence(0))).toEqual({
          status: 'refused',
          reason: 'session_unavailable',
        });
        expect(await snapshot(w)).toEqual(before);
        await mark(['1.0.0']);
        expect(
          await finalizer.finalize(w.a, handle, {
            ...evidence(1),
            attemptedCandidates: 4,
            definitiveAbsent: 3,
          }),
        ).toEqual({ status: 'refused', reason: 'mass_absence' });
        const marked = await snapshot(w);
        await w.seed(
          "UPDATE package SET listing_open_stamp = '2999-01-01T00:00:00.000Z' WHERE id = 'package-a'",
        );
        const superseded = await snapshot(w);
        expect(await finalizer.finalize(w.a, handle, evidence(1))).toEqual({
          status: 'refused',
          reason: 'superseded',
        });
        expect(await snapshot(w)).toEqual(superseded);
        expect(marked).not.toEqual(before);
      },
      wrap,
    ),
  emptyListing: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const upstream = createUpstreamStateRepository(w.executor);
        await w.executor.batch(
          upstream.publishStatements(w.b, 'package-b', 'npm-packument', validators, 60),
        );
        const foreignRows = () =>
          Promise.all(
            ['package', 'upstream_state'].map((table) =>
              w.executor.all(st(`SELECT * FROM ${table} WHERE org_id = ? ORDER BY 1`, w.b.orgId)),
            ),
          );
        const foreignBefore = await foreignRows();
        const { handle } = await begin(w, 'package');
        const before = await w.executor.all(st('SELECT * FROM version ORDER BY id'));
        expect(
          await createIngestFinalizer(w.executor).finalize(w.a, handle, evidence(0)),
        ).toMatchObject({ status: 'complete', empty: true });
        expect(await w.executor.all(st('SELECT * FROM version ORDER BY id'))).toEqual(before);
        expect(await upstream.get(w.a, 'package-a', 'npm-packument')).toMatchObject(validators);
        expect(await upstream.get(w.b, 'package-a', 'npm-packument')).toBeNull();
        expect(await foreignRows()).toEqual(foreignBefore);
      },
      wrap,
    ),
  representationClock: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const clock = createRepresentationClock(w.executor);
        const input = {
          projectId: 'project-a',
          packageId: 'package-a',
          keyHash: SHA,
          form: 'composer-p2' as const,
          validator: SHA,
          rev: 1,
        };
        const first = await clock.advance(w.a, input);
        expect(await clock.advance(w.a, input)).toEqual(first);
        const second = await clock.advance(w.a, { ...input, rev: 2, validator: NEW_SHA });
        expect(second.lastModified > first.lastModified).toBe(true);
        expect(await clock.advance(w.a, input)).toEqual({ ...second, stale: true });
        await expect(clock.advance(w.b, input)).rejects.toThrow(/project not found/);
        expect(await clock.advance(w.a, { ...input, rev: 2, validator: NEW_SHA })).toEqual(second);
        expect((await clock.advance(w.a, { ...input, form: 'composer-p2-dev' })).stale).toBe(false);
      },
      wrap,
    ),
  existingVersions: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        await w.seed(
          `INSERT INTO version (id, org_id, package_id, version, version_normalized, published_at, published_at_basis, metadata_json, status)
      VALUES ('version-a2', ?, 'package-a', '2.0.0', '2.0.0', ?, 'broker', '{}', 'quarantined')`,
          w.a.orgId,
          OLD,
        );
        const reader = createExistingVersionsReader(w.executor);
        const query = { packageId: 'package-a', after: null, limit: 1, withMetadata: false };
        const page = await reader.existingVersions(w.a, query);
        expect(page.rows).toEqual([
          expect.objectContaining({ id: 'version-a', versionNormalized: '1.0.0' }),
        ]);
        expect(page.rows[0]).not.toHaveProperty('metadataJson');
        expect(page.next).toBe('1.0.0');
        expect(await reader.existingVersions(w.b, query)).toEqual({ rows: [], next: null });
        const next = await reader.existingVersions(w.a, {
          ...query,
          after: page.next,
          withMetadata: true,
        });
        expect(next.rows).toEqual([
          expect.objectContaining({ id: 'version-a2', status: 'quarantined', metadataJson: '{}' }),
        ]);
        expect(next.next).toBeNull();
        expect(await reader.existingVersions(w.a, { ...query, keys: [] })).toEqual({
          rows: [],
          next: null,
        });
      },
      wrap,
    ),
  blobCandidates: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        for (const [id, org, sha] of [
          ['old', w.a, SHA],
          ['foreign', w.b, SHA],
          ['young', w.a, NEW_SHA],
        ] as const)
          await w.seed(
            `INSERT INTO blob (id, org_id, sha256, size_bytes, storage_key, created_at) VALUES (?, ?, ?, 1, ?, ?)`,
            id,
            org.orgId,
            sha,
            id,
            id === 'young' ? new Date().toISOString() : OLD,
          );
        const reader = createBlobReferenceReader(w.executor);
        expect(await reader.candidates(w.a, { limit: 50 })).toEqual([
          expect.objectContaining({ id: 'old', orphan: true }),
        ]);
        expect(await reader.stillEligible(w.a, NEW_SHA)).toBe(false);
        await w.seed("UPDATE version SET blob_id = 'old' WHERE id = 'version-a'");
        expect(await reader.candidates(w.a, { limit: 50 })).toEqual([]);
        await w.seed(
          "UPDATE version SET status = 'removed_upstream', removed_upstream_at = ? WHERE id = 'version-a'",
          OLD,
        );
        expect(await reader.stillEligible(w.a, SHA)).toBe(true);
        await w.seed("UPDATE version SET status = 'quarantined' WHERE id = 'version-a'");
        expect(await reader.stillEligible(w.a, SHA)).toBe(false);
      },
      wrap,
    ),
  webhookDedupe: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const deliveries = createWebhookDeliveryRepository(w.executor);
        const input = {
          provider: 'github',
          deliveryId: 'credential-a:body-hash',
          event: 'push' as const,
        };
        expect(await deliveries.record(w.a, input)).toEqual({ state: 'new' });
        expect(await deliveries.record(w.a, input)).toEqual({
          state: 'duplicate',
          outcome: 'received',
        });
        await deliveries.settle(w.b, { ...input, outcome: 'ignored' });
        expect(await deliveries.record(w.a, input)).toEqual({
          state: 'duplicate',
          outcome: 'received',
        });
        await deliveries.settle(w.a, { ...input, outcome: 'processed' });
        await deliveries.settle(w.a, { ...input, outcome: 'ignored' });
        expect(await deliveries.record(w.a, input)).toEqual({
          state: 'duplicate',
          outcome: 'processed',
        });
        expect(
          await deliveries.record(w.a, { ...input, deliveryId: 'credential-b:body-hash' }),
        ).toEqual({ state: 'new' });
        await expect(deliveries.record(w.b, input)).rejects.toThrow(/unavailable/);
      },
      wrap,
    ),
  registeredNameEnablement: (open, wrap: Wrap | undefined = undefined) =>
    withWorld(
      open,
      async (w) => {
        const enabled = async (ctx = w.a) =>
          w.executor.all<{ enabled: number }>(
            compile(
              db.selectNoFrom(sql<number>`(${sourceActivatable(ctx, 'source-a')})`.as('enabled')),
            ),
          );
        expect(await enabled()).toEqual([{ enabled: 1 }]);
        expect(await enabled(w.b)).toEqual([{ enabled: 0 }]);
        await w.seed(
          'UPDATE source SET config_json = \'{"scopes":["@acme","@tools"]}\' WHERE id = \'source-a\'',
        );
        expect(await enabled()).toEqual([{ enabled: 0 }]);
        await w.seed(
          "INSERT INTO registered_name (id, org_id, source_id, ecosystem, pattern) VALUES ('tools', ?, 'source-a', 'npm', '@tools/*')",
          w.a.orgId,
        );
        expect(await enabled()).toEqual([{ enabled: 1 }]);
        await w.seed("DELETE FROM registered_name WHERE source_id = 'source-a'");
        expect(await enabled()).toEqual([{ enabled: 0 }]);
        await w.seed("UPDATE source SET type = 'npmjs_proxy' WHERE id = 'source-a'");
        expect(await enabled()).toEqual([{ enabled: 1 }]);
      },
      wrap,
    ),
} satisfies Record<string, Case>;

export function describeRegistryContract(name: string, open: RegistryExecutorFactory): void {
  describe(`registry repository contract: ${name}`, () => {
    for (const [name, run] of Object.entries(registryContractCases)) it(name, () => run(open));
  });
}
