/* eslint-disable no-restricted-syntax -- Read-only, organization-scoped evidence of assembled-runtime effects. */
import assert from 'node:assert/strict';
import { failureName, requireStatus } from './evidence.js';
import {
  requiredControlEvents,
  requiredFixture,
  requiredSession,
} from './audit-required-fixture.js';
import { LocalUnavailable, reserveLoopbackPort, until } from './local.js';
import type { ScenarioResult } from './runner.js';
import type { Runtime } from './local.js';

type Fixture = Awaited<ReturnType<typeof requiredFixture>>;
type Session = Awaited<ReturnType<typeof requiredSession>>;
interface Status {
  policy: string;
  mode: string;
  trailActive: boolean;
  headSeq: number;
  boundarySeq: number;
  capacity: { state: string };
  verification: { throughSeq: number; withheld: number } | null;
  sinks: { id: string; state: string; progressSeq: number; custodySeq: number }[];
}
const status = async (admin: Session) =>
  (await requireStatus(
    await admin.request('/_pb/audit/status', undefined, 'GET'),
    200,
  ).json()) as Status;

async function refused(response: Response, code: string, retryable = false) {
  requireStatus(response, 503);
  assert.equal(response.headers.has('retry-after'), retryable, 'RequiredAuditRetryClassification');
  const body = (await response.json()) as { error?: { code?: string } };
  assert(body.error?.code === code, 'RequiredAuditRefusalCode');
}

async function actor(admin: Session) {
  const me = (await requireStatus(
    await admin.request('/_pb/me', undefined, 'GET'),
    200,
  ).json()) as { principal: { id: string } };
  assert.equal(typeof me.principal.id, 'string', 'MissingAuditOperator');
  return me.principal.id;
}

async function issue(admin: Session, secrets: string[]) {
  const response = requireStatus(
    await admin.request('/_pb/me/tokens', {
      name: 'required-revocation',
      scope: 'read',
      readOnly: true,
      projectMode: 'all',
      projectIds: [],
    }),
    201,
  );
  const value = (await response.json()) as { id: string; token: string };
  assert(
    typeof value.id === 'string' && typeof value.token === 'string',
    'InvalidRevocationFixture',
  );
  secrets.push(value.token);
  return value.id;
}

async function health(fixture: Fixture, admin: Session, code: string) {
  await fixture.job('health-observe');
  const value = (await requireStatus(
    await admin.request('/_pb/audit/health', undefined, 'GET'),
    200,
  ).json()) as { status: string; codes: string[] };
  assert.equal(value.status, 'failing', 'RequiredAuditHealthNotFailing');
  assert(value.codes.includes(code), 'MissingRequiredAuditHealthCode');
  await until(async () => fixture.alerts.includes(code), 'required-alert-delivery', 10_000);
}

async function withFixture(
  runtime: Runtime,
  run: (fixture: Fixture, secrets: string[]) => Promise<void>,
  noPath: boolean | 'none' = false,
) {
  const fixture = await requiredFixture(runtime, noPath);
  const secrets: string[] = [];
  try {
    await run(fixture, secrets);
  } finally {
    await fixture.close(secrets);
  }
}

async function toggleIgnored(runtime: Runtime) {
  await withFixture(runtime, async (fixture, secrets) => {
    const admin = await requiredSession(fixture.broker, false, secrets);
    secrets.push(...admin.secrets());
    const before = await status(admin);
    assert(
      before.policy === 'required' && before.mode === 'trail' && before.trailActive,
      'RequiredTrailToggleHonoured',
    );
    const me = (await requireStatus(
      await admin.request('/_pb/me', undefined, 'GET'),
      200,
    ).json()) as { features: { auditTrail: boolean } };
    assert(me.features.auditTrail, 'RequiredTrailFeatureMissing');
    requireStatus(
      await admin.request('/_pb/projects', { slug: 'required-trail', name: 'Required trail' }),
      201,
    );
    await fixture.job('seal');
    await fixture.job('export-webhook');
    await fixture.job('maintain');
    await fixture.job('verify');
    const after = await status(admin);
    assert(after.headSeq > before.headSeq && after.boundarySeq === 1, 'RequiredTrailPruned');
    assert(
      after.verification?.throughSeq === after.headSeq && after.verification.withheld === 0,
      'RequiredTrailNotVerified',
    );
    requireStatus(await admin.request('/_pb/audit', undefined, 'GET'), 200);
    const sink = after.sinks.find((sink) => sink.id === 'webhook');
    assert(
      sink && sink.progressSeq === after.headSeq && sink.custodySeq === after.headSeq,
      'RequiredDurableAckMissing',
    );
    assert(fixture.batches.length > 0, 'RequiredSinkNeverReached');
  });
}

async function rejectionBlocks(runtime: Runtime) {
  await withFixture(runtime, async (fixture, secrets) => {
    const admin = await requiredSession(fixture.broker, false, secrets);
    secrets.push(...admin.secrets());
    await fixture.job('seal');
    const before = await status(admin);
    const initial = before.sinks.find((sink) => sink.id === 'webhook');
    assert(initial, 'MissingRequiredSink');
    fixture.reject();
    // One rejection is terminal for required policy, independently of skipAfter.
    await fixture.job('export-webhook');
    const blocked = await status(admin);
    const sink = blocked.sinks.find((sink) => sink.id === 'webhook');
    assert(sink?.state === 'blocked', 'RequiredRejectionNotBlocked');
    assert(
      sink.progressSeq === initial.progressSeq && sink.custodySeq === initial.custodySeq,
      'RequiredRejectionAdvancedCursor',
    );
    assert(fixture.batches.length > 0, 'RejectionReceiverNotReached');
    const deliveries = fixture.batches.length;
    for (let attempt = 0; attempt < 4; attempt++) await fixture.job('export-webhook');
    await fixture.job('maintain');
    await fixture.job('verify');
    const retained = await status(admin);
    assert(
      retained.headSeq === before.headSeq && retained.boundarySeq === before.boundarySeq,
      'RequiredRejectionLostHistory',
    );
    assert(
      retained.verification?.throughSeq === retained.headSeq &&
        retained.verification.withheld === 0,
      'BlockedSinkTrailNotVerifiable',
    );
    assert.equal(fixture.batches.length, deliveries, 'BlockedSinkRetriedWithoutOperator');
    const dispositions = await fixture.read<{ count: number }>(
      "SELECT count(*) AS count FROM audit_ledger WHERE org_id = ? AND kind IN ('skipped', 'gap', 'uncertain')",
    );
    assert.equal(Number(dispositions[0]?.count), 0, 'RequiredRejectionAutoSkipped');
    await health(fixture, admin, 'audit.blocked');
    // Prove the control action can resume a blocked sink even while capacity refuses.
    await fixture.capacity();
    await fixture.control(['sink', 'unblock', 'webhook'], await actor(admin));
    assert(
      (await status(admin)).sinks.some((sink) => sink.id === 'webhook' && sink.state === 'active'),
      'RequiredUnblockNotApplied',
    );
    const events = await requiredControlEvents(fixture.read);
    assert.equal(
      events.filter((row) => row.action === 'audit.sink_admin' && row.operation === 'unblock')
        .length,
      1,
      'RequiredUnblockNotAudited',
    );
  });
}

async function capacityReserve(runtime: Runtime) {
  await withFixture(runtime, async (fixture, secrets) => {
    const admin = await requiredSession(fixture.broker, false, secrets);
    secrets.push(...admin.secrets());
    const tokenId = await issue(admin, secrets);
    await fixture.job('seal');
    await fixture.job('export-webhook');
    const before = await status(admin);
    // Pin the refusal state instead of generating 64 MiB of traffic. All subsequent
    // business writes, reserve guards, controls and health run through production code.
    await fixture.capacity();
    const pending = async () =>
      Number(
        (
          await fixture.read<{ count: number }>(
            'SELECT count(*) AS count FROM audit_pending WHERE org_id = ?',
          )
        )[0]?.count,
      );
    const pendingBefore = await pending();
    await refused(
      await admin.request('/_pb/projects', { slug: 'required-refused', name: 'Refused' }),
      'audit_backlog_full',
    );
    assert.equal(await pending(), pendingBefore, 'CapacityRefusalCommittedAuditEvent');
    const projects = await fixture.read<{ count: number }>(
      "SELECT count(*) AS count FROM project WHERE org_id = ? AND slug = 'required-refused'",
    );
    assert.equal(Number(projects[0]?.count), 0, 'CapacityRefusalCommittedBusinessWrite');
    requireStatus(await admin.request('/_pb/me/tokens/' + tokenId, undefined, 'DELETE'), 204);
    const revoked = (await requireStatus(
      await admin.request('/_pb/me/tokens/' + tokenId, undefined, 'GET'),
      200,
    ).json()) as { status: string };
    assert.equal(revoked.status, 'revoked', 'CapacityRevocationNotApplied');
    await admin.reauth();
    const operator = await actor(admin);
    for (const operation of ['replay', 'rebind'])
      await fixture.control(['sink', operation, 'webhook', '--from', '1'], operator);
    requireStatus(await admin.request('/_pb/audit/export', undefined, 'GET'), 200);
    await health(fixture, admin, 'audit.capacity');
    const events = await requiredControlEvents(fixture.read);
    for (const operation of ['replay', 'rebind'])
      assert(
        events.some((row) => row.action === 'audit.sink_admin' && row.operation === operation),
        'CapacityControlNotAudited',
      );
    for (const action of ['token.revoke', 'session.reauth', 'audit.export'])
      assert(
        events.some((row) => row.action === action),
        'CapacityReserveNotAudited',
      );
    requireStatus(await admin.request('/_pb/auth/logout'), 204);
    requireStatus(await admin.request('/_pb/me', undefined, 'GET'), 401);
    await admin.login();
    requireStatus(await admin.request('/_pb/me', undefined, 'GET'), 200);
    secrets.push(...admin.secrets());
    const after = await status(admin);
    assert(
      after.capacity.state === 'refusing' &&
        after.headSeq === before.headSeq &&
        after.boundarySeq === before.boundarySeq,
      'CapacityReserveLostHistory',
    );
  });
}

async function setupReserve(runtime: Runtime) {
  await withFixture(runtime, async (fixture, secrets) => {
    // First-admin setup and sign-in must succeed with the reserve already in effect.
    await fixture.capacity();
    const admin = await requiredSession(fixture.broker, false, secrets);
    secrets.push(...admin.secrets());
    assert.equal((await status(admin)).capacity.state, 'refusing', 'SetupClearedCapacityRefusal');
    const rows = await fixture.read<{ action: string }>(
      'SELECT action FROM audit_pending WHERE org_id = ?',
    );
    for (const action of ['setup.complete', 'session.login', 'session.reauth'])
      assert(
        rows.some((row) => row.action === action),
        'SetupReserveEventMissing',
      );
  });
}

async function alertAcknowledgement(runtime: Runtime) {
  await withFixture(runtime, async (fixture, secrets) => {
    const admin = await requiredSession(fixture.broker, false, secrets);
    secrets.push(...admin.secrets());
    await fixture.capacity();
    await health(fixture, admin, 'audit.capacity');
    const [alert] = await fixture.read<{ revision: number }>(
      "SELECT revision FROM audit_health WHERE org_id = ? AND code = 'audit.capacity'",
    );
    assert(alert, 'MissingCapacityAlertRevision');
    const countLedger = async () =>
      Number(
        (
          await fixture.read<{ count: number }>(
            'SELECT count(*) AS count FROM audit_ledger WHERE org_id = ?',
          )
        )[0]?.count,
      );
    const before = await countLedger();
    const operator = await actor(admin);
    await fixture.control(
      ['alert', 'ack', 'audit.capacity', '--revision', String(alert.revision - 1)],
      operator,
      false,
    );
    await fixture.control(
      ['alert', 'ack', 'audit.capacity', '--revision', String(alert.revision)],
      operator,
    );
    const [acknowledged] = await fixture.read<{ revision: number; acknowledged_revision: number }>(
      "SELECT revision, acknowledged_revision FROM audit_health WHERE org_id = ? AND code = 'audit.capacity'",
    );
    assert(
      acknowledged &&
        acknowledged.acknowledged_revision === alert.revision &&
        acknowledged.revision === alert.revision,
      'CapacityAlertNotAcknowledged',
    );
    assert.equal(await countLedger(), before, 'AlertAcknowledgementWroteLedger');
    const events = await requiredControlEvents(fixture.read);
    assert.equal(
      events.filter(
        (row) =>
          row.action === 'audit.sink_admin' &&
          row.operation === 'alert_ack' &&
          row.alert_code === 'audit.capacity' &&
          row.revision === alert.revision &&
          row.sink_id === null,
      ).length,
      1,
      'CapacityAlertAckNotAudited',
    );
  });
}

async function noDurablePath(runtime: Runtime) {
  await withFixture(
    runtime,
    async (fixture, secrets) => {
      const admin = await requiredSession(fixture.broker, false, secrets);
      secrets.push(...admin.secrets());
      const tokenId = await issue(admin, secrets);
      fixture.noDurablePath();
      // The stored ratchet is a fixture change external to the process: allow its bounded
      // 30-second org-resolution cache to expire, without writing a project while polling.
      await until(
        async () => {
          const response = await admin.request('/_pb/projects', {});
          if (response.status !== 503) {
            requireStatus(response, 400);
            return false;
          }
          await refused(response, 'durable_path_required');
          return true;
        },
        'stored-required-refusal',
        40_000,
      );
      await refused(
        await admin.request('/_pb/projects', { slug: 'no-durable-path', name: 'Refused' }),
        'durable_path_required',
      );
      const projects = await fixture.read<{ count: number }>(
        "SELECT count(*) AS count FROM project WHERE org_id = ? AND slug = 'no-durable-path'",
      );
      assert.equal(Number(projects[0]?.count), 0, 'DurablePathRefusalCommittedWrite');
      requireStatus(await admin.request('/_pb/me/tokens/' + tokenId, undefined, 'DELETE'), 204);
      await admin.reauth();
      requireStatus(await admin.request('/_pb/auth/logout'), 204);
      requireStatus(await admin.request('/_pb/me', undefined, 'GET'), 401);
      await admin.login();
      secrets.push(...admin.secrets());
      // A second bootstrap account exercises both setup endpoints under the refusal.
      const reader = await requiredSession(fixture.broker, true, secrets);
      secrets.push(...reader.secrets());
      requireStatus(await reader.request('/_pb/me', undefined, 'GET'), 200);
      await refused(
        await reader.request('/_pb/projects', { slug: 'still-refused', name: 'Refused' }),
        'durable_path_required',
      );
    },
    true,
  );
}

async function noneRefused(runtime: Runtime) {
  await withFixture(
    runtime,
    async (fixture, secrets) => {
      fixture.noDurablePath();
      await until(
        async () => {
          const response = await fetch(fixture.broker.origin + '/_pb/projects', {
            method: 'POST',
            headers: { 'content-type': 'application/json', origin: fixture.broker.publicOrigin },
            body: '{}',
            signal: AbortSignal.timeout(10_000),
          });
          requireStatus(response, 503);
          const body = (await response.json()) as { error: { code: string } };
          assert(!response.headers.has('retry-after'), 'NoneRefusalRetryAfter');
          return body.error.code === 'durable_path_required';
        },
        'required-none-refusal',
        40_000,
      );
      const admin = await requiredSession(fixture.broker, false, secrets);
      secrets.push(...admin.secrets());
      await refused(
        await admin.request('/_pb/projects', { slug: 'none-refused', name: 'Refused' }),
        'durable_path_required',
      );
      requireStatus(await admin.request('/_pb/audit', undefined, 'GET'), 404);
      const [chain] = await fixture.read<{ mode: string; policy: string }>(
        'SELECT mode, policy FROM audit_chain WHERE org_id = ?',
      );
      assert(chain?.mode === 'none' && chain.policy === 'required', 'RequiredNoneFixtureChanged');
    },
    'none',
  );
}

export const requiredAuditCases = [
  ['required refuses mode none and still completes first-admin setup', noneRefused],
  ['required ignores trail toggle, delivers, retains and verifies', toggleIgnored],
  [
    'required rejection blocks with alerts and permits unblock under capacity refusal',
    rejectionBlocks,
  ],
  ['capacity refuses ordinary writes and reserves security and control actions', capacityReserve],
  ['capacity reserves first-admin setup finish and sign-in', setupReserve],
  ['capacity reserves alert acknowledgement without a ledger row', alertAcknowledgement],
  [
    'stored required without a durable path refuses writes and reserves authentication and revocation',
    noDurablePath,
  ],
] as const;

export async function auditRequiredScenario(runtime: Runtime): Promise<ScenarioResult> {
  try {
    await reserveLoopbackPort();
    for (const [, run] of requiredAuditCases) await run(runtime);
    return { status: 'PASS', reason: `${runtime}: required audit policy cases passed.` };
  } catch (error) {
    return {
      status: error instanceof LocalUnavailable ? 'NOT RUN' : 'FAIL',
      reason: `${runtime}: audit required: ${failureName(error)}`,
    };
  }
}
