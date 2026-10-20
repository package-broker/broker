import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditEvent, type AuditAction } from '@package-broker/core/audit/actions';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { Statement } from '@package-broker/core/db/port';
import { systemClock, ulid } from '@package-broker/core/ids';
import { createImportCredentialService } from '@package-broker/core/import/credentials';
import {
  createImportRunService,
  IMPORT_RUN_JOB,
  IMPORT_VERIFICATION_JOB,
} from '@package-broker/core/import/run-service';
import type { BlobStore } from '@package-broker/core/platform/blob';
import type { PluginPorts } from '@package-broker/core/plugin';
import { createCredentialStore } from '@package-broker/core/secrets/credential-store';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { parseMasterKey } from '@package-broker/core/secrets/master-key';
import { auditPendingStatement } from '@package-broker/db-sqlite/repositories/audit-pending';
import { createBlobRepository } from '@package-broker/db-sqlite/repositories/blob';
import { createCredentialRepository } from '@package-broker/db-sqlite/repositories/credential';
import { createImportCredentialRepository } from '@package-broker/db-sqlite/repositories/import-credential';
import { createImportJournalStore } from '@package-broker/db-sqlite/repositories/import-journal';
import { createImportRollbackStore } from '@package-broker/db-sqlite/repositories/import-rollback';
import { createImportRunStore } from '@package-broker/db-sqlite/repositories/import-run';
import { createImportVerificationStore } from '@package-broker/db-sqlite/repositories/import-verification';
import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { createImportJobHolder, importJobRegistrations } from './import-jobs.js';
import { createJobLoop } from './jobs/loop.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const anchors = [
  {
    provider: 'oidc',
    anchor: 'test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const manifest = {
  version: 1,
  source_system: 'test',
  widening: [],
  items: [
    {
      type: 'role',
      external_ref: 'reader',
      key: 'reader',
      name: 'Reader',
      scope: 'project',
      permissions: ['project:read'],
    },
    { type: 'project', external_ref: 'project', slug: 'imported', name: 'Imported' },
    {
      type: 'source',
      external_ref: 'source',
      name: 'private',
      ecosystem: 'composer',
      source_type: 'composer_repository',
      project: { ref: 'project' },
      url: 'https://packages.example.test/',
      credential_ref: 'env:REGISTRY_TOKEN',
      config: {
        selection: { packages: [], patterns: [], expandPatterns: false },
        distHosts: [],
        mirrorsFallback: false,
      },
    },
    {
      type: 'name',
      external_ref: 'name',
      source: { ref: 'source' },
      ecosystem: 'composer',
      pattern: 'acme/*',
    },
    {
      type: 'attachment',
      external_ref: 'attachment',
      project: { ref: 'project' },
      source: { ref: 'source' },
      precedence: 10,
    },
    {
      type: 'grant',
      external_ref: 'reader-grant',
      scope: 'project',
      project: { ref: 'project' },
      role: { ref: 'reader' },
      subject: { type: 'email', value: 'reader@example.test' },
    },
  ],
};

async function fixture() {
  const db = await openMigratedDatabase({ twoOrganizations: true });
  cleanup.push(db.close);
  if (db.orgs === null) throw new Error('missing organizations');
  const ctx = db.orgs.a;
  const executor = db.executor;
  const now = new Date().toISOString();
  const actor = ulid();
  const s = (sql: string, ...params: Statement['params']): Statement => ({
    sql: sql.replaceAll("'actor'", `'${actor}'`),
    params,
  });
  await executor.batch([
    s(
      "INSERT INTO user_account (id, org_id, email) VALUES ('actor', ?, 'actor@example.test')",
      ctx.orgId,
    ),
    s(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'test')",
      ctx.orgId,
    ),
    s(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'actor', 'oidc', 'actor', 'actor@example.test', 1, ?)",
      ctx.orgId,
      now,
    ),
    s(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('importer', ?, 'importer', 'Importer', 'organization')",
      ctx.orgId,
    ),
    s(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'importer', 'org:import:write'), (?, 'importer', 'org:import:approve')",
      ctx.orgId,
      ctx.orgId,
    ),
    s(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'actor@example.test', 'organization', 'importer')",
      ctx.orgId,
    ),
    s(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, expires_at, reauth_at) VALUES ('session', ?, 'actor', ?, ?, '2099-01-01T00:00:00.000Z', ?)",
      ctx.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
      now,
    ),
  ]);
  const objects = new Map<string, Uint8Array>();
  const metadata = createBlobRepository(executor);
  const blobs: BlobStore = {
    async put(org, sha, body, info) {
      objects.set(sha, new Uint8Array(await new Response(body).arrayBuffer()));
      const generation = await metadata.reserve(org, sha);
      const row = await metadata.publish(org, { ...info, sha256: sha, generation });
      if (row === null) throw new Error('blob publication refused');
      return row;
    },
    async get(_org, sha) {
      const bytes = objects.get(sha);
      return bytes === undefined
        ? null
        : {
            body: new Response(bytes).body!,
            info: {
              sha256: sha,
              generation: '',
              size: bytes.length,
              mediaType: 'application/json',
              purgeAfter: null,
            },
          };
    },
    async head() {
      return null;
    },
  };
  const fence = mutationFence({ userId: actor, sessionId: 'session' } as AuthenticatedActor, {});
  const store = createImportRunStore({ executor, blobs, providerAnchors: anchors });
  const plannedRunId = ulid();
  const runs = createImportRunService({
    store,
    ids: { ulid: () => plannedRunId },
    clock: systemClock,
  });
  const holder = createImportJobHolder();
  holder.set({
    blobs,
    applyStore: createImportJournalStore({ executor, providerAnchors: anchors }),
    rollbackStore: createImportRollbackStore({ executor, providerAnchors: anchors }),
    verificationStore: createImportVerificationStore({ executor, providerAnchors: anchors }),
  });
  const observability = {
    log: () => undefined,
    counter: () => undefined,
    histogram: () => undefined,
  };
  const loop = createJobLoop({
    executor,
    jobs: importJobRegistrations(holder),
    observability,
    scope: () => ({
      ports: {
        organizations: { get: async () => null },
        clock: systemClock,
        ids: { ulid },
      } as unknown as PluginPorts,
      observability,
    }),
  });
  cleanup.push(() => loop.stop());
  const audit = (action: AuditAction, runId: string, old: string | null, state: string) => {
    const event = auditEvent({
      id: ulid(),
      now,
      action,
      actor: { type: 'user', id: actor },
      target: { type: 'import_run', id: runId },
      changes: { state: { old, new: state } },
      context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    });
    if (!event.ok) throw new Error('audit rejected');
    return auditPendingStatement(ctx, event.event);
  };
  const created = await runs.createRun(ctx, fence, {
    manifest,
    now,
    audit: audit('import_run.create', plannedRunId, null, 'planned'),
  });
  expect(created).toMatchObject({ ok: true });
  if (!created.ok) throw new Error('creation failed');
  const runId = created.value.id;
  const input = (action: AuditAction, old: string, state: string) => ({
    runId,
    now,
    audit: audit(action, runId, old, state),
  });
  expect(
    await runs.approveRun(ctx, fence, {
      ...input('import_run.approve', 'planned', 'planned'),
      planHash: created.value.planHash,
    }),
  ).toMatchObject({ ok: true });
  expect(
    await runs.requestApply(ctx, fence, input('import_run.apply', 'planned', 'applying')),
  ).toMatchObject({ ok: true });
  loop.start();
  const row = async () =>
    (
      await executor.all<{
        state: string;
        last_error: string | null;
        accepted_at: string | null;
        before_image_expires_at: string | null;
      }>(
        s(
          'SELECT state, last_error, accepted_at, before_image_expires_at FROM import_run WHERE org_id = ? AND id = ?',
          ctx.orgId,
          runId,
        ),
      )
    )[0]!;
  const wait = async (state: string) => {
    await vi.waitFor(
      async () => {
        expect((await row()).state).toBe(state);
      },
      { timeout: 15000, interval: 25 },
    );
    await vi.waitFor(
      async () => {
        expect(
          await executor.all(
            s("SELECT id FROM job WHERE org_id = ? AND state IN ('queued', 'running')", ctx.orgId),
          ),
        ).toEqual([]);
      },
      { timeout: 15000, interval: 25 },
    );
  };
  await wait('applied');
  const credentials = createImportCredentialService({
    store: createImportCredentialRepository(executor, { blobs, providerAnchors: anchors }),
    credentials: createCredentialStore({
      repository: createCredentialRepository(executor),
      cipher: createSecretCipher(
        createKeyring([
          parseMasterKey('pbmk_v1_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', 'PB_MASTER_KEY'),
        ]),
        'credential-encryption',
      ),
      ids: { ulid },
      clock: systemClock,
    }),
    runtime: 'node',
    ids: { ulid },
    auditStatement: auditPendingStatement,
  });
  const upload = () =>
    credentials.acceptImportCredential(ctx, fence, {
      runId,
      externalRef: 'source',
      kind: 'bearer',
      material: JSON.stringify({ token: 'test-only-material' }),
      now,
      context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    });
  const verify = () =>
    runs.requestVerify(ctx, fence, input('import_run.verify', 'applied', 'verifying'));
  return { ctx, executor, s, row, runs, fence, runId, input, wait, upload, verify, store, loop };
}

describe('import verification lifecycle on the real SQLite job runner', () => {
  it('atomically changes applied to verifying with its audit and queued job', async () => {
    const f = await fixture();
    await f.loop.stop();
    await f.executor.batch([
      f.s(
        "DELETE FROM role_permission WHERE org_id = ? AND permission = 'org:import:approve'",
        f.ctx.orgId,
      ),
    ]);
    expect(await f.verify()).toMatchObject({ ok: true });
    expect(await f.row()).toMatchObject({ state: 'verifying', before_image_expires_at: null });
    expect(
      await f.executor.all(
        f.s(
          'SELECT state FROM job WHERE org_id = ? AND type = ?',
          f.ctx.orgId,
          IMPORT_VERIFICATION_JOB.type,
        ),
      ),
    ).toEqual([{ state: 'queued' }]);
    expect(
      await f.executor.all(
        f.s(
          "SELECT action FROM audit_pending WHERE org_id = ? AND action = 'import_run.verify'",
          f.ctx.orgId,
        ),
      ),
    ).toEqual([{ action: 'import_run.verify' }]);
    expect(await f.verify()).toEqual({ ok: false, error: 'conflict' });
  });
  it.each(['verify', 'rollback'] as const)(
    'recovers a stranded verifying run after a dead job by requesting %s with audit',
    async (operation) => {
      const f = await fixture();
      await f.loop.stop();
      expect(await f.verify()).toMatchObject({ ok: true });
      await f.executor.batch([
        f.s(
          "UPDATE job SET state = 'dead' WHERE org_id = ? AND type = ?",
          f.ctx.orgId,
          IMPORT_VERIFICATION_JOB.type,
        ),
      ]);
      const result =
        operation === 'verify'
          ? await f.verify()
          : await f.runs.requestRollback(
              f.ctx,
              f.fence,
              f.input('import_run.rollback', 'verifying', 'verifying'),
            );
      expect(result).toMatchObject({ ok: true });
      expect(await f.row()).toMatchObject({ state: 'verifying', before_image_expires_at: null });
      expect(
        await f.executor.all(
          f.s("SELECT type FROM job WHERE org_id = ? AND state = 'queued'", f.ctx.orgId),
        ),
      ).toEqual([
        { type: operation === 'verify' ? IMPORT_VERIFICATION_JOB.type : IMPORT_RUN_JOB.rollback },
      ]);
      expect(
        await f.executor.all(
          f.s(
            "SELECT action FROM audit_pending WHERE org_id = ? AND action IN ('import_run.verify', 'import_run.rollback') ORDER BY rowid",
            f.ctx.orgId,
          ),
        ),
      ).toEqual([
        { action: 'import_run.verify' },
        { action: operation === 'verify' ? 'import_run.verify' : 'import_run.rollback' },
      ]);
    },
  );
  it.each(['verify', 'rollback'] as const)(
    'refuses recovery by %s while either import resource has an active job',
    async (operation) => {
      const f = await fixture();
      await f.loop.stop();
      expect(await f.verify()).toMatchObject({ ok: true });
      const [job] = await f.executor.all<{ id: string }>(
        f.s(
          'SELECT id FROM job WHERE org_id = ? AND type = ?',
          f.ctx.orgId,
          IMPORT_VERIFICATION_JOB.type,
        ),
      );
      for (const state of ['queued', 'running']) {
        for (const resource of [
          IMPORT_RUN_JOB.resourceKey(f.runId),
          IMPORT_VERIFICATION_JOB.resourceKey(f.runId),
        ]) {
          await f.executor.batch([
            f.s(
              "UPDATE job SET resource_key = ?, state = ?, lease_owner = 'other-worker', lease_until = '2099-01-01T00:00:00.000Z' WHERE org_id = ? AND id = ?",
              resource,
              state,
              f.ctx.orgId,
              job!.id,
            ),
          ]);
          const result =
            operation === 'verify'
              ? await f.verify()
              : await f.runs.requestRollback(
                  f.ctx,
                  f.fence,
                  f.input('import_run.rollback', 'verifying', 'verifying'),
                );
          expect(result, `${operation}: ${resource}, ${state}`).toEqual({
            ok: false,
            error: 'conflict',
          });
          expect(await f.row()).toMatchObject({
            state: 'verifying',
            before_image_expires_at: null,
          });
        }
      }
      expect(
        await f.executor.all(
          f.s(
            "SELECT action FROM audit_pending WHERE org_id = ? AND action IN ('import_run.verify', 'import_run.rollback')",
            f.ctx.orgId,
          ),
        ),
      ).toEqual([{ action: 'import_run.verify' }]);
    },
  );
  it('maps a replayed verification request to the same job idempotency key', async () => {
    const f = await fixture();
    await f.loop.stop();
    const request = f.input('import_run.verify', 'applied', 'verifying');
    const requestId = (JSON.parse(String(request.audit.params[11])) as { request_id: string })
      .request_id;
    expect(await f.runs.requestVerify(f.ctx, f.fence, request)).toMatchObject({ ok: true });
    const jobs = () =>
      f.executor.all<{ idempotency_key: string }>(
        f.s(
          'SELECT idempotency_key FROM job WHERE org_id = ? AND type = ?',
          f.ctx.orgId,
          IMPORT_VERIFICATION_JOB.type,
        ),
      );
    const original = await jobs();
    expect(original).toEqual([
      { idempotency_key: IMPORT_VERIFICATION_JOB.idempotencyKey(f.runId, requestId) },
    ]);
    // Remove persisted effects so the replay exercises key derivation again.
    await f.executor.batch([
      f.s(
        'DELETE FROM job WHERE org_id = ? AND type = ?',
        f.ctx.orgId,
        IMPORT_VERIFICATION_JOB.type,
      ),
      f.s(
        "DELETE FROM audit_pending WHERE org_id = ? AND action = 'import_run.verify'",
        f.ctx.orgId,
      ),
    ]);
    expect(await f.runs.requestVerify(f.ctx, f.fence, request)).toMatchObject({ ok: true });
    expect(await jobs()).toEqual(original);
  });
  it('refuses verification at the store when the before-image expiry is already set', async () => {
    const f = await fixture();
    await f.loop.stop();
    await f.executor.batch([
      f.s(
        "UPDATE import_run SET before_image_expires_at = '2099-01-01T00:00:00.000Z' WHERE org_id = ? AND id = ?",
        f.ctx.orgId,
        f.runId,
      ),
    ]);
    const access = await f.store.inspect(
      f.ctx,
      f.fence,
      'requestVerify',
      f.runId,
      new Date().toISOString(),
    );
    expect(
      await f.store.requestVerify(f.ctx, f.fence, {
        ...f.input('import_run.verify', 'applied', 'verifying'),
        expected: access.run!,
      }),
    ).toMatchObject({ ok: false });
    expect(await f.row()).toMatchObject({
      state: 'applied',
      before_image_expires_at: '2099-01-01T00:00:00.000Z',
    });
    expect(
      await f.executor.all(
        f.s(
          'SELECT id FROM job WHERE org_id = ? AND type = ?',
          f.ctx.orgId,
          IMPORT_VERIFICATION_JOB.type,
        ),
      ),
    ).toEqual([]);
    expect(
      await f.executor.all(
        f.s(
          "SELECT id FROM audit_pending WHERE org_id = ? AND action = 'import_run.verify'",
          f.ctx.orgId,
        ),
      ),
    ).toEqual([]);
  });
  it('rolls back the request state and job if the request audit fails', async () => {
    const f = await fixture();
    await f.loop.stop();
    await f.executor.batch([
      f.s(
        "CREATE TRIGGER refuse_request_audit BEFORE INSERT ON audit_pending WHEN NEW.action = 'import_run.verify' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
      ),
    ]);
    expect(await f.verify()).toMatchObject({ ok: false });
    expect(await f.row()).toMatchObject({ state: 'applied', before_image_expires_at: null });
    expect(
      await f.executor.all(
        f.s(
          'SELECT id FROM job WHERE org_id = ? AND type = ?',
          f.ctx.orgId,
          IMPORT_VERIFICATION_JOB.type,
        ),
      ),
    ).toEqual([]);
  });
  it('refuses verification without live org:import:write', async () => {
    const f = await fixture();
    await f.loop.stop();
    await f.executor.batch([
      f.s(
        "DELETE FROM role_permission WHERE org_id = ? AND permission = 'org:import:write'",
        f.ctx.orgId,
      ),
    ]);
    expect(await f.verify()).toEqual({ ok: false, error: 'forbidden' });
    expect(await f.row()).toMatchObject({ state: 'applied' });
  });
  it('creates, approves, applies, uploads credentials, verifies and accepts with immutable expiry', async () => {
    const f = await fixture();
    expect(await f.upload()).toMatchObject({ ok: true });
    expect(await f.verify()).toMatchObject({ ok: true });
    await f.wait('verified');
    const verified = await f.row();
    expect(Date.parse(verified.before_image_expires_at!)).toBeGreaterThan(
      Date.now() + 89 * 86400000,
    );
    expect(
      await f.runs.acceptRun(f.ctx, f.fence, f.input('import_run.accept', 'verified', 'verified')),
    ).toMatchObject({ ok: true });
    expect(await f.row()).toEqual({ ...verified, accepted_at: expect.any(String) });
    expect(await f.verify()).toEqual({ ok: false, error: 'conflict' });
    const jobs = await f.executor.all<{
      type: string;
      resource_key: string;
      idempotency_key: string;
      payload_json: string;
    }>(
      f.s(
        'SELECT type, resource_key, idempotency_key, payload_json FROM job WHERE org_id = ? AND type = ?',
        f.ctx.orgId,
        IMPORT_VERIFICATION_JOB.type,
      ),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      resource_key: IMPORT_VERIFICATION_JOB.resourceKey(f.runId),
      idempotency_key: expect.stringContaining(f.runId),
    });
    expect(JSON.parse(jobs[0]!.payload_json)).toEqual({ runId: f.runId });
    expect(
      await f.executor.all(
        f.s(
          "SELECT action FROM audit_pending WHERE org_id = ? AND target_type = 'import_run'",
          f.ctx.orgId,
        ),
      ),
    ).toEqual(
      expect.arrayContaining([
        { action: 'import_run.create' },
        { action: 'import_run.approve' },
        { action: 'import_run.apply' },
        { action: 'import_run.credential_set' },
        { action: 'import_run.verify' },
        { action: 'import_run.accept' },
      ]),
    );
  });
  it('allows a new verification request after credential failure and sets expiry only on success', async () => {
    const f = await fixture();
    expect(await f.verify()).toMatchObject({ ok: true });
    await f.wait('applied');
    expect(await f.row()).toMatchObject({
      last_error: 'credential_missing',
      before_image_expires_at: null,
    });
    expect(await f.upload()).toMatchObject({ ok: true });
    expect(await f.verify()).toMatchObject({ ok: true });
    await f.wait('verified');
    expect(await f.row()).toMatchObject({
      last_error: null,
      before_image_expires_at: expect.any(String),
    });
    const jobs = await f.executor.all<{ idempotency_key: string }>(
      f.s(
        'SELECT idempotency_key FROM job WHERE org_id = ? AND type = ?',
        f.ctx.orgId,
        IMPORT_VERIFICATION_JOB.type,
      ),
    );
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.idempotency_key)).size).toBe(2);
  });
  it('rolls back after failed verification', async () => {
    const f = await fixture();
    expect(await f.verify()).toMatchObject({ ok: true });
    await f.wait('applied');
    expect(await f.row()).toMatchObject({
      last_error: 'credential_missing',
      before_image_expires_at: null,
    });
    expect(
      await f.runs.requestRollback(
        f.ctx,
        f.fence,
        f.input('import_run.rollback', 'applied', 'applied'),
      ),
    ).toMatchObject({ ok: true });
    await f.wait('rolled_back');
    expect(
      await f.executor.all(f.s('SELECT id FROM source WHERE org_id = ?', f.ctx.orgId)),
    ).toEqual([]);
    expect(
      await f.executor.all(f.s('SELECT id FROM project WHERE org_id = ?', f.ctx.orgId)),
    ).toEqual([]);
  });
  it('uses org:import:write and refuses a stale compare-and-set without audit or job', async () => {
    const f = await fixture();
    await f.executor.batch([
      f.s(
        "DELETE FROM role_permission WHERE org_id = ? AND permission = 'org:import:approve'",
        f.ctx.orgId,
      ),
    ]);
    const access = await f.store.inspect(
      f.ctx,
      f.fence,
      'requestVerify',
      f.runId,
      new Date().toISOString(),
    );
    expect(access.allowed).toBe(true);
    expect(access.run).not.toBeNull();
    await f.executor.batch([
      f.s(
        "UPDATE import_run SET state = 'verifying' WHERE org_id = ? AND id = ?",
        f.ctx.orgId,
        f.runId,
      ),
    ]);
    expect(
      await f.store.requestVerify(f.ctx, f.fence, {
        ...f.input('import_run.verify', 'applied', 'verifying'),
        expected: access.run!,
      }),
    ).toMatchObject({ ok: false, reason: 'conflict' });
    expect(
      await f.executor.all(
        f.s(
          'SELECT id FROM job WHERE org_id = ? AND type = ?',
          f.ctx.orgId,
          IMPORT_VERIFICATION_JOB.type,
        ),
      ),
    ).toEqual([]);
  });
});
