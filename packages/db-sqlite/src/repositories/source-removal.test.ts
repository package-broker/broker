import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createCatalogueReconciler } from './catalogue-reconcile.js';
import { createIngestFinalizer } from './ingest-finalize.js';
import { createIngestSessions, createIngestSessionWriteGuard } from './ingest-session.js';
import { createSourceRepository } from './source.js';

let database: MigratedDatabase;
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const fence = mutationFence({ userId: 'admin', sessionId: 'session' } as AuthenticatedActor, {});
const anchors = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
const honest = {
  expectedCount: 1,
  attemptedCandidates: 10,
  successfulCandidates: 1,
  definitiveAbsent: 9,
  upstreamComplete: true,
  validatorTtlSeconds: 0,
};

beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true, d1PatternLimit: true });
  const ctx = database.orgs!.a;
  const now = new Date().toISOString();
  await database.executor.batch([
    stmt(
      "INSERT INTO user_account (id, org_id, email) VALUES ('admin', ?, 'admin@example.test')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.test')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('identity', ?, 'admin', 'oidc', 'admin', 'admin@example.test', 1, ?)",
      ctx.orgId,
      now,
    ),
    stmt(
      "INSERT INTO session (id, org_id, user_id, secret_hash, csrf_hash, created_at, last_seen_at, expires_at) VALUES ('session', ?, 'admin', ?, ?, ?, ?, '2999-01-01T00:00:00.000Z')",
      ctx.orgId,
      'a'.repeat(64),
      'b'.repeat(64),
      now,
      now,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('admin-role', ?, 'organization_admin', 'Admin', 'organization', 1)",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'admin-role', 'org:sources:write')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('grant', ?, 'email', 'admin@example.test', 'organization', 'admin-role')",
      ctx.orgId,
    ),
    stmt(
      "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('S', ?, 'source', 'composer', 'composer_repository')",
      ctx.orgId,
    ),
    stmt(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10)
      INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
      SELECT 'P' || i, ?, 'S', 'composer', 'acme/p' || i, '2020-01-01T00:00:00.000Z' FROM n`,
      ctx.orgId,
    ),
  ]);
});
afterEach(async () => {
  await database.close();
});

async function open(present = 1) {
  const ctx = database.orgs!.a;
  const sessions = createIngestSessions(database.executor);
  const session = await sessions.acquire(ctx, { scope: 'source', sourceId: 'S' }, 'worker', 60);
  if (session === 'held') throw new Error('held');
  const guard = createIngestSessionWriteGuard(ctx, session);
  const reconciler = createCatalogueReconciler(database.executor);
  const scope = { kind: 'source', sourceId: 'S' } as const;
  const { stamp } = await reconciler.openListing(ctx, guard, scope);
  await sessions.start(ctx, session, { stamp, snapshot: { id: 'snapshot' } });
  if (present > 0)
    await reconciler.markListing(ctx, guard, {
      scope,
      stamp,
      present: Array.from({ length: present }, (_, i) => `acme/p${i + 1}`),
    });
  return session;
}

const refusalRow = () =>
  database.executor.all<{
    last_refusal_at: string | null;
    last_refusal_absent: number | null;
    last_refusal_listed: number | null;
    last_refusal_successful: number | null;
    removal_accepted: number;
  }>(
    stmt(
      `SELECT last_refusal_at, last_refusal_absent, last_refusal_listed, last_refusal_successful,
        removal_accepted FROM source WHERE id = 'S'`,
    ),
  );
const removed = async () =>
  (
    await database.executor.all<{ n: number }>(
      stmt("SELECT count(*) AS n FROM package WHERE status = 'removed_upstream'"),
    )
  )[0]!.n;

async function facts() {
  const [row] = await refusalRow();
  if (row?.last_refusal_at == null) throw new Error('no refusal recorded');
  return {
    at: row.last_refusal_at,
    absent: row.last_refusal_absent!,
    listed: row.last_refusal_listed!,
    successful: row.last_refusal_successful!,
  };
}

async function accept(refusal?: Awaited<ReturnType<typeof facts>>, sourceId = 'S') {
  const ctx = database.orgs!.a;
  const accepted = refusal ?? (await facts());
  const audit = auditEvent({
    id: ulid(),
    now: new Date().toISOString(),
    action: 'source.removal_accepted',
    actor: { type: 'user', id: 'admin' },
    target: { type: 'source', id: sourceId },
    context: { opId: ulid(), requestId: ulid(), tokenSelector: null, sourceIp: null },
    changes: {
      source_id: { new: sourceId },
      refused_at: { new: accepted.at },
      absent: { new: accepted.absent },
      listed: { new: accepted.listed },
      successful: { new: accepted.successful },
    },
  });
  if (!audit.ok) throw new Error('audit refused');
  return createSourceRepository(database.executor).acceptRemoval(ctx, fence, {
    id: sourceId,
    refusal: accepted,
    providerAnchors: anchors,
    audit: audit.event,
  });
}

const finalize = (session: Awaited<ReturnType<typeof open>>, input = honest) =>
  createIngestFinalizer(database.executor).finalize(database.orgs!.a, session, input);

async function refuse() {
  const session = await open();
  expect(await finalize(session)).toEqual({ status: 'refused', reason: 'mass_absence' });
  expect(await createIngestSessions(database.executor).abandon(database.orgs!.a, session)).toBe(
    true,
  );
  return session;
}

describe('recording a refusal', () => {
  it('stores the facts on the source, bumps updated_at and leaves the catalogue untouched', async () => {
    await database.executor.batch([
      stmt("UPDATE source SET updated_at = '2020-01-01T00:00:00.000Z' WHERE id = 'S'"),
    ]);
    await refuse();
    expect(await facts()).toMatchObject({ absent: 9, listed: 1, successful: 1 });
    expect(await removed()).toBe(0);
    const [row] = await database.executor.all<{ updated_at: string }>(
      stmt("SELECT updated_at FROM source WHERE id = 'S'"),
    );
    expect(row!.updated_at > '2020-01-01T00:00:00.000Z').toBe(true);
  });

  it('records the unseen rows when the evidence understates them', async () => {
    const session = await open();
    expect(
      await finalize(session, { ...honest, attemptedCandidates: 1, definitiveAbsent: 0 }),
    ).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect(await facts()).toMatchObject({ absent: 9, listed: 1, successful: 1 });
  });

  it('keeps listing on later syncs: the abandoned session is replaced by a fresh generation', async () => {
    const ctx = database.orgs!.a;
    const first = await refuse();
    const second = await open();
    expect(second.generation).toBe(first.generation + 1);
    await database.executor.batch([
      stmt(
        `INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
        VALUES ('NEW', ?, 'S', 'composer', 'acme/new', '2020-01-01T00:00:00.000Z')`,
        ctx.orgId,
      ),
    ]);
    const guard = createIngestSessionWriteGuard(ctx, second);
    const reconciler = createCatalogueReconciler(database.executor);
    const [row] = await database.executor.all<{ listing_open_stamp: string }>(
      stmt("SELECT listing_open_stamp FROM source WHERE id = 'S'"),
    );
    await reconciler.markListing(ctx, guard, {
      scope: { kind: 'source', sourceId: 'S' },
      stamp: row!.listing_open_stamp,
      present: ['acme/new'],
    });
    expect(
      await finalize(second, {
        ...honest,
        expectedCount: 2,
        attemptedCandidates: 11,
        successfulCandidates: 2,
        definitiveAbsent: 9,
      }),
    ).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect((await facts()).listed).toBe(2);
    expect(await removed()).toBe(0);
  });

  it('clears the facts when a later sync completes without a refusal', async () => {
    await refuse();
    const next = await open(10);
    expect(
      await finalize(next, {
        ...honest,
        expectedCount: 10,
        attemptedCandidates: 10,
        successfulCandidates: 10,
        definitiveAbsent: 0,
      }),
    ).toMatchObject({ status: 'complete' });
    expect(await refusalRow()).toEqual([
      {
        last_refusal_at: null,
        last_refusal_absent: null,
        last_refusal_listed: null,
        last_refusal_successful: null,
        removal_accepted: 0,
      },
    ]);
  });
});

describe('accepting a refusal', () => {
  it('conflicts without a refusal, with changed facts, when already armed and on a total wipe', async () => {
    const fake = { at: '2020-01-01T00:00:00.000Z', absent: 9, listed: 1, successful: 1 };
    expect(await accept(fake)).toBe('conflict');
    await refuse();
    const real = await facts();
    expect(await accept({ ...real, absent: real.absent + 1 })).toBe('conflict');
    expect(await accept(real)).toBe('accepted');
    expect(await accept(real)).toBe('conflict');
    expect(await database.executor.all(stmt('SELECT count(*) AS n FROM audit_pending'))).toEqual([
      { n: 1 },
    ]);
  });

  it('refuses to accept a refusal with no successful candidates', async () => {
    const session = await open(0);
    expect(
      await finalize(session, {
        ...honest,
        expectedCount: 0,
        attemptedCandidates: 10,
        successfulCandidates: 0,
        definitiveAbsent: 10,
      }),
    ).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect(await facts()).toMatchObject({ absent: 10, listed: 0, successful: 0 });
    expect(await accept()).toBe('conflict');
    expect(await database.executor.all(stmt('SELECT count(*) AS n FROM audit_pending'))).toEqual([
      { n: 0 },
    ]);
  });

  it('applies the next refused finalize once, then refuses again', async () => {
    await refuse();
    expect(await accept()).toBe('accepted');
    expect((await refusalRow())[0]).toMatchObject({ removal_accepted: 1 });
    const next = await open();
    expect(await finalize(next)).toMatchObject({ status: 'complete' });
    expect(await removed()).toBe(9);
    expect(await refusalRow()).toEqual([
      {
        last_refusal_at: null,
        last_refusal_absent: null,
        last_refusal_listed: null,
        last_refusal_successful: null,
        removal_accepted: 0,
      },
    ]);
    const audits = await database.executor.all<{ action: string; payload_json: string }>(
      stmt('SELECT action, payload_json FROM audit_pending'),
    );
    expect(audits.map((audit) => audit.action)).toEqual([
      'source.removal_accepted',
      'source.removal_applied',
    ]);
    expect(JSON.parse(audits[1]!.payload_json).changes).toMatchObject({
      source_id: { new: 'S' },
      absent: { new: 9 },
      listed: { new: 1 },
    });
    expect(JSON.parse(audits[0]!.payload_json).changes).toMatchObject({
      source_id: { new: 'S' },
      absent: { new: 9 },
      listed: { new: 1 },
      successful: { new: 1 },
    });
    await database.executor.batch([
      stmt("UPDATE package SET status = 'active', updated_at = '2020-01-01T00:00:00.000Z'"),
    ]);
    const again = await open();
    expect(await finalize(again)).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect(await removed()).toBe(0);
  });

  it('disarms and refuses again when the next refusal removes more than was accepted', async () => {
    await refuse();
    expect(await accept()).toBe('accepted');
    await database.executor.batch([
      stmt(
        `WITH RECURSIVE n(i) AS (SELECT 11 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
        INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
        SELECT 'P' || i, ?, 'S', 'composer', 'acme/p' || i, '2020-01-01T00:00:00.000Z' FROM n`,
        database.orgs!.a.orgId,
      ),
    ]);
    const next = await open();
    expect(
      await finalize(next, {
        ...honest,
        attemptedCandidates: 31,
        definitiveAbsent: 30,
      }),
    ).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect(await refusalRow()).toMatchObject([{ removal_accepted: 0, last_refusal_absent: 30 }]);
    expect(await removed()).toBe(0);
    expect(await database.executor.all(stmt('SELECT count(*) AS n FROM audit_pending'))).toEqual([
      { n: 1 },
    ]);
  });

  it('bounds the acceptance in the batch when the evidence understates the removal', async () => {
    await refuse();
    expect(await accept()).toBe('accepted');
    await database.executor.batch([
      stmt(
        `WITH RECURSIVE n(i) AS (SELECT 11 UNION ALL SELECT i + 1 FROM n WHERE i < 30)
        INSERT INTO package (id, org_id, source_id, ecosystem, name, updated_at)
        SELECT 'P' || i, ?, 'S', 'composer', 'acme/p' || i, '2020-01-01T00:00:00.000Z' FROM n`,
        database.orgs!.a.orgId,
      ),
    ]);
    const next = await open();
    expect(await finalize(next)).toEqual({ status: 'refused', reason: 'mass_absence' });
    expect(await refusalRow()).toMatchObject([{ removal_accepted: 0, last_refusal_absent: 29 }]);
    expect(await removed()).toBe(0);
  });

  it('disarms an acceptance that armed between the read and the refusal write', async () => {
    const ctx = database.orgs!.a;
    await refuse();
    const session = await open();
    let armed = false;
    const finalizer = createIngestFinalizer({
      ...database.executor,
      async batch(statements) {
        if (!armed) {
          armed = true;
          expect(await accept()).toBe('accepted');
        }
        return database.executor.batch(statements);
      },
    });
    expect(await finalizer.finalize(ctx, session, honest)).toEqual({
      status: 'refused',
      reason: 'mass_absence',
    });
    expect((await refusalRow())[0]).toMatchObject({ removal_accepted: 0 });
    expect(await removed()).toBe(0);
  });

  it('records the application in the log and counter', async () => {
    const records: unknown[] = [];
    await refuse();
    expect(await accept()).toBe('accepted');
    const session = await open();
    const observability = {
      counter: (name: string) => void records.push(['counter', name]),
      log: (record: { event: string }) => void records.push(['log', record.event]),
    };
    expect(
      await createIngestFinalizer(database.executor, { observability }).finalize(
        database.orgs!.a,
        session,
        honest,
      ),
    ).toMatchObject({ status: 'complete' });
    expect(records).toContainEqual(['counter', 'pb.ingest.removal_applied']);
    expect(records).toContainEqual(['log', 'ingest.removal_applied']);
  });

  it('applies when the armed refusal came from a different, earlier generation', async () => {
    await refuse();
    await refuse();
    expect(await accept()).toBe('accepted');
    expect(await finalize(await open())).toMatchObject({ status: 'complete' });
  });

  it('clears an unused acceptance when the next completed sync is not refused', async () => {
    await refuse();
    expect(await accept()).toBe('accepted');
    const next = await open(10);
    expect(
      await finalize(next, {
        ...honest,
        expectedCount: 10,
        attemptedCandidates: 10,
        successfulCandidates: 10,
        definitiveAbsent: 0,
      }),
    ).toMatchObject({ status: 'complete' });
    expect((await refusalRow())[0]).toMatchObject({ removal_accepted: 0, last_refusal_at: null });
    expect(await removed()).toBe(0);
    const again = await open();
    expect(await finalize(again)).toEqual({ status: 'refused', reason: 'mass_absence' });
  });

  it('hides foreign sources', async () => {
    await refuse();
    await database.executor.batch([
      stmt(
        "INSERT INTO source (id, org_id, name, ecosystem, type) VALUES ('FOREIGN', ?, 'foreign', 'composer', 'composer_repository')",
        database.orgs!.b.orgId,
      ),
    ]);
    expect(await accept(await facts(), 'FOREIGN')).toBe('not_found');
  });

  it('refuses acceptance after admin authority is revoked', async () => {
    await refuse();
    const refusal = await facts();
    await database.executor.batch([stmt("DELETE FROM access_grant WHERE id = 'grant'")]);
    expect(await accept(refusal)).toBe('forbidden');
    expect(await database.executor.all(stmt('SELECT count(*) AS n FROM audit_pending'))).toEqual([
      { n: 0 },
    ]);
  });

  it('keeps the acceptance through an incomplete finalize and consumes it only on success', async () => {
    await refuse();
    expect(await accept()).toBe('accepted');
    const next = await open();
    expect(await finalize(next, { ...honest, upstreamComplete: false })).toEqual({
      status: 'refused',
      reason: 'incomplete',
    });
    expect((await refusalRow())[0]).toMatchObject({ removal_accepted: 1 });
    expect(await finalize(next)).toMatchObject({ status: 'complete' });
    expect((await refusalRow())[0]).toMatchObject({ removal_accepted: 0 });
  });

  it('rolls back consumption when the listing is superseded inside the finalize batch', async () => {
    const ctx = database.orgs!.a;
    await refuse();
    expect(await accept()).toBe('accepted');
    const session = await open();
    let raced = false;
    const finalizer = createIngestFinalizer({
      ...database.executor,
      async batch(statements) {
        if (!raced) {
          raced = true;
          await database.executor.batch([
            stmt(
              "UPDATE source SET listing_open_stamp = '2999-01-01T00:00:00.000Z' WHERE id = 'S'",
            ),
          ]);
        }
        return database.executor.batch(statements);
      },
    });
    expect(await finalizer.finalize(ctx, session, honest)).toEqual({
      status: 'refused',
      reason: 'superseded',
    });
    expect((await refusalRow())[0]).toMatchObject({ removal_accepted: 1 });
    expect(
      await database.executor.all(
        stmt("SELECT count(*) AS n FROM package WHERE status = 'active'"),
      ),
    ).toEqual([{ n: 10 }]);
  });
});

it('does not refuse a source below the default minimum', async () => {
  await database.executor.batch([stmt("DELETE FROM package WHERE id = 'P10'")]);
  const session = await open();
  expect(
    await finalize(session, { ...honest, attemptedCandidates: 9, definitiveAbsent: 8 }),
  ).toMatchObject({ status: 'complete' });
  expect((await refusalRow())[0]).toMatchObject({ last_refusal_at: null });
});
