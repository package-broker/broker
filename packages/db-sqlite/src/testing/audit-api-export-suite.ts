import { afterEach, beforeEach, expect, it } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import type { AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { mutationFence, type AuthenticatedActor } from '@package-broker/core/authz/fence';
import type { OrgContext, ScalarSqlExecutor } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import { createAuditApiExportStore } from '../repositories/audit-api-export.js';
import { createAuditLedgerRepository } from '../repositories/audit-ledger.js';
import { seedAuditJournal } from './audit-journal-fixture.js';
import type { MigratedDatabase } from './migrated-database.js';

export const EXPORT_USER = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
export const EXPORT_PROVIDERS = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];
export const exportFence = () =>
  mutationFence({ userId: EXPORT_USER, sessionId: 'export-session' } as AuthenticatedActor, {});
export async function seedExportAdmin(executor: ScalarSqlExecutor, org: OrgContext) {
  const now = new Date().toISOString();
  await executor.batch([
    {
      sql: "INSERT INTO user_account (id, org_id, email) VALUES (?, ?, 'exporter@example.test')",
      params: [EXPORT_USER, org.orgId],
    },
    {
      sql: "INSERT INTO identity_provider_binding (org_id, provider, anchor) VALUES (?, 'oidc', 'oidc:https://idp.test')",
      params: [org.orgId],
    },
    {
      sql: "INSERT INTO identity (id, org_id, user_id, provider, subject, email, email_verified, validated_at) VALUES ('export-identity', ?, ?, 'oidc', 'subject', 'exporter@example.test', 1, ?)",
      params: [org.orgId, EXPORT_USER, now],
    },
    {
      sql: "INSERT INTO session (id, org_id, user_id, identity_id, secret_hash, csrf_hash, created_at, expires_at, reauth_at) VALUES ('export-session', ?, ?, 'export-identity', ?, ?, ?, ?, ?)",
      params: [
        org.orgId,
        EXPORT_USER,
        'a'.repeat(64),
        'b'.repeat(64),
        now,
        new Date(Date.now() + 3600000).toISOString(),
        now,
      ],
    },
    {
      sql: "INSERT INTO role (id, org_id, key, name, scope, protects_last_holder) VALUES ('export-role', ?, 'export-admin', 'Admin', 'organization', 1)",
      params: [org.orgId],
    },
    {
      sql: "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'export-role', 'org:audit:export')",
      params: [org.orgId],
    },
    {
      sql: "INSERT INTO access_grant (id, org_id, subject_type, subject_value, scope, role_id) VALUES ('export-grant', ?, 'email', 'exporter@example.test', 'organization', 'export-role')",
      params: [org.orgId],
    },
  ]);
}
export function auditApiExportSuite(open: () => Promise<MigratedDatabase>) {
  let database: MigratedDatabase;
  const org = () => database.orgs!.a;
  const store = () => createAuditApiExportStore(database.executor, EXPORT_PROVIDERS);
  beforeEach(async () => {
    database = await open();
    await seedExportAdmin(database.executor, org());
    await seedAuditJournal(database.executor, org(), 3);
  });
  afterEach(async () => database.close());
  const input = async () => {
    const snapshot = await store().snapshot(org());
    const now = new Date().toISOString();
    const event = auditEvent({
      id: ulid(),
      now,
      action: 'audit.export',
      actor: { type: 'user', id: EXPORT_USER },
      target: { type: 'organization', id: org().orgId },
      context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
      changes: {
        from_seq: { new: 1 },
        to_seq: { new: 3 },
        count: { new: 3 },
        format: { new: 'api' },
      },
    });
    if (!event.ok) throw new Error('Invalid export fixture');
    const entry: AuditLedgerEntry = {
      id: ulid(),
      kind: 'export',
      chainId: snapshot.head.chainId,
      epoch: snapshot.head.epoch,
      fromSeq: 1,
      toSeq: 3,
      count: 3,
      sinkId: null,
      reasonCode: 'api_export',
      policy: snapshot.policy,
      modeGeneration: snapshot.modeGeneration,
      actorType: 'user',
      actorId: EXPORT_USER,
      createdAt: now,
    };
    return { snapshot, event: event.event, entry };
  };
  const record = async () => {
    const i = await input();
    return store().record(org(), exportFence(), i.snapshot, i.event, [i.entry]);
  };
  it('atomically records access in the journal outbox and ledger', async () => {
    expect(await record()).toBe('recorded');
    expect(
      await database.executor.all({
        sql: 'SELECT action FROM audit_pending WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([{ action: 'audit.export' }]);
    expect(
      (await createAuditLedgerRepository(database.executor).page(org(), null, 10)).map(
        (row) => row.kind,
      ),
    ).toEqual(['export']);
  });
  it('repeated exports of the same range add exactly one export row each and no withheld rows', async () => {
    for (let i = 0; i < 3; i++) expect(await record()).toBe('recorded');
    expect(
      await database.executor.all({
        sql: 'SELECT kind, count(*) AS n FROM audit_ledger WHERE org_id = ? GROUP BY kind',
        params: [org().orgId],
      }),
    ).toEqual([{ kind: 'export', n: 3 }]);
  });
  it('uses a ledger index for the visible export rate lookup', async () => {
    const plans = await database.executor.all<{ detail: string }>({
      sql: `EXPLAIN QUERY PLAN SELECT count(*) FROM audit_ledger WHERE org_id = ?
        AND superseded_by IS NULL AND kind = 'export' AND reason_code = 'api_export'
        AND actor_type = 'user' AND actor_id = ?
        AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-60 seconds')`,
      params: [org().orgId, EXPORT_USER],
    });
    expect(
      plans.some((plan) => /USING INDEX audit_ledger_(kind_chain|visible)/.test(plan.detail)),
    ).toBe(true);
  });
  it('allows ten requests and atomically refuses the eleventh across store instances', async () => {
    for (let i = 0; i < 10; i++) expect(await record()).toBe('recorded');
    expect(await record()).toBe('rate_limited');
    expect(
      await database.executor.all({
        sql: 'SELECT count(*) AS n FROM audit_pending WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([{ n: 10 }]);
  });
  it('atomically admits only one of two requests competing for the last slot', async () => {
    for (let i = 0; i < 9; i++) expect(await record()).toBe('recorded');
    expect((await Promise.all([record(), record()])).sort()).toEqual(['rate_limited', 'recorded']);
  });
  it('does not consume this principal budget for another principal or an expired window', async () => {
    const i = await input();
    const ledger = createAuditLedgerRepository(database.executor);
    await ledger.append(
      org(),
      Array.from({ length: 10 }, () => ({
        ...i.entry,
        id: ulid(),
        actorId: '01ARZ3NDEKTSV4RRFFQ69G5FAX',
      })),
    );
    await ledger.append(
      org(),
      Array.from({ length: 10 }, () => ({
        ...i.entry,
        id: ulid(),
        createdAt: new Date(Date.now() - 61000).toISOString(),
      })),
    );
    expect(await record()).toBe('recorded');
  });
  it('accepts an advancing head and retention up to the range start', async () => {
    const i = await input();
    await database.executor.batch([
      {
        sql: 'UPDATE audit_chain SET head_seq = head_seq + 1 WHERE org_id = ?',
        params: [org().orgId],
      },
    ]);
    expect(await store().record(org(), exportFence(), i.snapshot, i.event, [i.entry])).toBe(
      'recorded',
    );
  });
  it('refuses retention past the requested start', async () => {
    const i = await input();
    await database.executor.batch([
      {
        sql: 'UPDATE audit_chain SET boundary_seq = 2 WHERE org_id = ?',
        params: [org().orgId],
      },
    ]);
    expect(await store().record(org(), exportFence(), i.snapshot, i.event, [i.entry])).toBe(
      'conflict',
    );
  });
  it('prechecks the persisted budget with database time and ignores caller clock skew', async () => {
    expect(await store().rateAvailable(org(), EXPORT_USER)).toBe(true);
    for (let n = 0; n < 10; n++) {
      const i = await input();
      expect(
        await store().record(org(), exportFence(), i.snapshot, i.event, [
          { ...i.entry, createdAt: '2000-01-01T00:00:00.000Z' },
        ]),
      ).toBe('recorded');
    }
    expect(await store().rateAvailable(org(), EXPORT_USER)).toBe(false);
    expect(await record()).toBe('rate_limited');
  });
  it.each([
    'UPDATE session SET reauth_at = NULL WHERE org_id = ?',
    "UPDATE session SET reauth_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-11 minutes') WHERE org_id = ?",
    "UPDATE session SET reauth_at = '2099-01-01T00:00:00.000Z' WHERE org_id = ?",
    "UPDATE session SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE org_id = ?",
    'UPDATE role SET protects_last_holder = 0 WHERE org_id = ?',
    'DELETE FROM role_permission WHERE org_id = ?',
    "UPDATE user_account SET status = 'suspended' WHERE org_id = ?",
  ])('refuses changed authority at commit: %s', async (sql) => {
    const i = await input();
    await database.executor.batch([{ sql, params: [org().orgId] }]);
    expect(await store().record(org(), exportFence(), i.snapshot, i.event, [i.entry])).toBe(
      'forbidden',
    );
    expect(await createAuditLedgerRepository(database.executor).page(org(), null, 10)).toEqual([]);
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([]);
  });
  it('refuses a changed snapshot with no partial writes', async () => {
    const i = await input();
    await database.executor.batch([
      { sql: 'UPDATE audit_chain SET epoch = epoch + 1 WHERE org_id = ?', params: [org().orgId] },
    ]);
    expect(await store().record(org(), exportFence(), i.snapshot, i.event, [i.entry])).toBe(
      'conflict',
    );
    expect(await createAuditLedgerRepository(database.executor).page(org(), null, 10)).toEqual([]);
  });
  it('rolls back the ledger when staging access fails', async () => {
    const i = await input();
    const failing = createAuditApiExportStore(
      {
        ...database.executor,
        batch: (statements) =>
          database.executor.batch([
            ...statements,
            { sql: 'INSERT INTO audit_pending (id) VALUES (NULL)', params: [] },
          ]),
      },
      EXPORT_PROVIDERS,
    );
    expect(await failing.record(org(), exportFence(), i.snapshot, i.event, [i.entry])).toBe(
      'unavailable',
    );
    expect(await createAuditLedgerRepository(database.executor).page(org(), null, 10)).toEqual([]);
    expect(
      await database.executor.all({
        sql: 'SELECT id FROM audit_pending WHERE org_id = ?',
        params: [org().orgId],
      }),
    ).toEqual([]);
  });
  it('exports sanitized records and only overlapping dispositions of the bound organization', async () => {
    const i = await input();
    await createAuditLedgerRepository(database.executor).append(org(), [
      { ...i.entry, kind: 'uncertain', reasonCode: 'partial_rejected' },
    ]);
    expect((await store().dispositions(org(), i.snapshot, 2, 2)).map((row) => row.id)).toEqual([
      i.entry.id,
    ]);
    const reader = store().journal(org());
    await database.executor.batch([
      {
        sql: "UPDATE audit_event SET payload_json = json_set(payload_json, '$.changes.url.new', 'https://user:password@host.test/repo') WHERE org_id = ? AND seq = 1",
        params: [org().orgId],
      },
    ]);
    const page = await reader.list({ projectId: null, limit: 200 });
    expect(page.items[0]?.kind).toBe('withheld');
    expect(JSON.stringify(page)).not.toContain('password');
    const foreign = database.orgs!.b;
    expect(await store().dispositions(foreign, i.snapshot, 1, 3)).toEqual([]);
  });
}
