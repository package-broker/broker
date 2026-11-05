/* eslint-disable no-restricted-syntax -- Organization-scoped observations of real runtime jobs and audit state. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { assertWireIdentity, decodeOtlp } from './audit-wire-fixture.js';
import { deliveryBuild, deliveryInfrastructure } from './audit-delivery-fixture.js';
import { failureName, requireStatus, session } from './evidence.js';
import { LocalUnavailable, reserveLoopbackPort, startLocal, until } from './local.js';
import type { LocalBroker, Runtime } from './local.js';
import type { ScenarioResult } from './runner.js';

const endpoint = 'https://93.184.216.34/audit';
const receiverCredential = 'audit-restore-fixture-credential';
interface Position {
  chain_id: string;
  epoch: number;
  seq: number;
  hash: string;
}
interface Envelope {
  chain_id: string;
  epoch: number;
  org_id: string;
  records: Record<string, unknown>[];
}

// Retains receiver state independently of every broker process and database snapshot.
export class RestoreReceiver {
  frontier: Position | null = null;
  readonly deliveries: Envelope[] = [];
  probes = 0;
  readonly otlp: Envelope[] = [];
  get otlpDeliveries() {
    return this.otlp.length;
  }
  pin(orgId: string) {
    assert(!this.orgId || this.orgId === orgId, 'ReceiverOrganizationAlreadyPinned');
    this.orgId = orgId;
  }
  private orgId: string | undefined;

  receive(path: string, body: unknown): object {
    assert(body !== null && typeof body === 'object', 'InvalidReceiverBody');
    if (path === '/otlp') {
      const value = decodeOtlp(body as Record<string, unknown>);
      assertWireIdentity(value, this.orgId);
      this.otlp.push(value);
      return {};
    }
    assert(path === '/audit', 'UnexpectedReceiverPath');
    const value = body as Envelope & { probe?: string };
    assert(
      typeof value.org_id === 'string' && typeof value.chain_id === 'string',
      'MissingReceiverIdentity',
    );
    assert(this.orgId && value.org_id === this.orgId, 'ForeignReceiverOrganization');
    if (value.probe === 'frontier') {
      this.probes++;
      return { frontier: this.frontier };
    }
    assertWireIdentity(value, this.orgId);
    assert(this.deliveries.length < 1000, 'ReceiverEvidenceOverflow');
    const last = value.records.at(-1)!;
    let seq: unknown = last['seq'];
    let hash: unknown = last['hash'];
    if (last['kind'] === 'fork') {
      seq = last['last_common_seq'];
      hash = last['last_common_hash'];
    } else if (last['kind'] === 'boundary') {
      seq = Number(last['boundary_seq']) - 1;
      hash = last['boundary_prev_hash'];
    } else if (last['kind'] === 'receiver_changed') {
      seq = this.frontier?.seq ?? 0;
      hash = this.frontier?.hash ?? '0'.repeat(64);
    }
    assert(
      Number.isSafeInteger(seq) &&
        Number(seq) >= 0 &&
        typeof hash === 'string' &&
        /^[a-f0-9]{64}$/.test(hash),
      'InvalidReceiverPosition',
    );
    const acked = { chain_id: value.chain_id, epoch: value.epoch, seq: Number(seq), hash };
    this.deliveries.push(value);
    this.frontier = acked;
    return { acked };
  }
}

async function startReceiver() {
  const receiver = new RestoreReceiver();
  let invalid = false;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        assert(request.method === 'POST' && !request.headers.cookie, 'InvalidReceiverRequest');
        assert(
          request.headers.authorization === `Bearer ${receiverCredential}`,
          'MissingReceiverCredential',
        );
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += Buffer.byteLength(chunk);
          assert(size <= 1_048_576, 'ReceiverBodyOverflow');
          chunks.push(Buffer.from(chunk));
        }
        const result = receiver.receive(
          request.url ?? '',
          JSON.parse(Buffer.concat(chunks).toString()),
        );
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(result));
      } catch {
        invalid = true;
        response.writeHead(500);
        response.end('ReceiverProtocolFailure');
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'ReceiverAddressMissing');
  return {
    receiver,
    origin: `http://127.0.0.1:${address.port}`,
    healthy: () => assert(!invalid, 'ReceiverProtocolFailure'),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}

interface Chain extends Record<string, unknown> {
  chain_id: string;
  epoch: number;
  incarnation: number;
  head_seq: number;
  head_hash: string;
  boundary_seq: number;
  restore_pending: number;
}
interface Sink extends Record<string, unknown> {
  sink_id: string;
  state: string;
  blocked_reason: string | null;
  progress_seq: number;
  custody_seq: number;
  generation: number;
}

export async function auditRestoreScenario(
  runtime: Runtime,
  detection: 'tooling' | 'frontier',
): Promise<ScenarioResult> {
  let broker: LocalBroker | undefined;
  let fixture: Awaited<ReturnType<typeof startReceiver>> | undefined;
  const logs: string[] = [];
  const sensitive = [receiverCredential, 'admin@example.test'];
  const deadline = Date.now() + 240_000;
  try {
    await reserveLoopbackPort();
    fixture = await startReceiver();
    const receiver = fixture.receiver;
    const options = {
      bundleDirectory: await deliveryBuild(runtime, false),
      onOrganization: (orgId: string) => receiver.pin(orgId),
      auditEnv: {
        PB_AUDIT_TRAIL: 'off',
        PB_AUDIT_WEBHOOK_URL: endpoint,
        PB_AUDIT_WEBHOOK_HEADERS: `Authorization=Bearer ${receiverCredential}`,
        PB_AUDIT_OTLP_ENDPOINT: 'https://93.184.216.34/otlp',
        PB_AUDIT_OTLP_HEADERS: `Authorization=Bearer ${receiverCredential}`,
      },
      outboundDestination(url: string) {
        assert(
          url === endpoint || url === 'https://93.184.216.34/otlp',
          'UnexpectedAuditDestination',
        );
        return fixture!.origin + new URL(url).pathname;
      },
      nodeTransport: `https.request = (options) => {
        if (options.host !== '93.184.216.34' || !['/audit', '/otlp'].includes(options.path)) throw new Error('UnexpectedAuditDestination');
        return http.request({ hostname: '127.0.0.1', port: ${new URL(fixture.origin).port},
          path: options.path, method: options.method, headers: options.headers, agent: false });
      };`,
    };
    broker = await startLocal(runtime, fixture.origin, options);
    // The session survives a complete broker restart; request() reads the current origin.
    const current = new Proxy({} as LocalBroker, {
      get: (_target, key) => Reflect.get(broker!, key),
    });
    const admin = await session(current);
    sensitive.push(...broker.secrets(), broker.setupToken, ...admin.secrets());
    const { id: orgId } = (await requireStatus(
      await admin.request('/_pb/organization', undefined, 'GET'),
      200,
    ).json()) as { id: string };
    await deliveryInfrastructure(broker, orgId);
    const chain = async () => {
      const [row] = await broker!.read<Chain>(
        'SELECT chain_id, epoch, incarnation, head_seq, head_hash, boundary_seq, restore_pending FROM audit_chain WHERE org_id = ?',
        [orgId],
      );
      assert(row, 'AuditChainMissing');
      return row;
    };
    const sinks = () =>
      broker!.read<Sink>(
        'SELECT sink_id, state, blocked_reason, progress_seq, custody_seq, generation FROM audit_sink WHERE org_id = ? ORDER BY sink_id',
        [orgId],
      );
    const job = async (type: Parameters<LocalBroker['jobs']['enqueue']>[0]) => {
      assert(Date.now() < deadline, 'ScenarioDeadline');
      const id = await broker!.jobs.enqueue(type);
      await until(
        async () => {
          await broker!.tick();
          const [row] = await broker!.read<{ state: string }>(
            'SELECT state FROM job WHERE org_id = ? AND id = ?',
            [orgId, id],
          );
          assert(row && row.state !== 'dead', 'AuditRestoreJobFailed');
          return row.state === 'succeeded';
        },
        'audit-restore-job',
        Math.max(1, Math.min(60_000, deadline - Date.now())),
      );
    };
    const sealAndDeliver = async () => {
      await job('core:audit-seal:v1');
      await job('core:audit-export-webhook:v1');
      await job('core:audit-export-otlp:v1');
      const head = await chain();
      await until(
        async () => {
          const rows = await sinks();
          return rows.length === 2 && rows.every((sink) => sink.progress_seq === head.head_seq);
        },
        'audit-receiver-caught-up',
        Math.max(1, Math.min(30_000, deadline - Date.now())),
      );
      assert(
        receiver.frontier?.seq === head.head_seq && receiver.frontier.hash === head.head_hash,
        'ReceiverHeadMismatch',
      );
      return head;
    };
    requireStatus(
      await admin.request('/_pb/projects', { slug: 'restore-base', name: 'Restore base' }),
      201,
    );
    let common = await sealAndDeliver();
    let baseline = common;
    let savedSinks: Sink[] = [];
    let saved: Awaited<ReturnType<LocalBroker['databaseSnapshot']>> | undefined;
    // A periodic exporter may coincide with sealing. Retry fixture acquisition with real jobs
    // so a minute boundary cannot turn the blocking check into an empty-backlog observation.
    for (let attempt = 0; attempt < 3; attempt++) {
      requireStatus(
        await admin.request('/_pb/projects', {
          slug: `restore-retained-${attempt}`,
          name: 'Restore retained',
        }),
        201,
      );
      await job('core:audit-seal:v1');
      baseline = await chain();
      await job('core:audit-verify:v1');
      savedSinks = await sinks();
      assert(
        savedSinks.length === 2 && savedSinks.every((sink) => sink.state === 'active'),
        'ActiveSinksMissing',
      );
      const candidate = await broker.databaseSnapshot();
      const afterSnapshot = await sinks();
      if (
        savedSinks.every(
          (sink, index) =>
            sink.progress_seq === common.head_seq &&
            sink.progress_seq < baseline.head_seq &&
            afterSnapshot[index]!.progress_seq === sink.progress_seq,
        )
      ) {
        saved = candidate;
        break;
      }
      common = await sealAndDeliver();
    }
    assert(saved, 'MissingDeliverableRestoreBacklog');
    assert(receiver.otlpDeliveries > 0, 'OtlpReceiverNotExercised');
    const [actor] = await broker.read<{ id: string }>(
      'SELECT id FROM user_account WHERE org_id = ?',
      [orgId],
    );
    assert(actor, 'OperatorMissing');
    requireStatus(
      await admin.request('/_pb/projects', { slug: 'restore-tail', name: 'Restore tail' }),
      201,
    );
    const advanced = await sealAndDeliver();
    assert(advanced.head_seq > baseline.head_seq, 'ReceiverDidNotAdvance');
    const deliveryOffset = receiver.deliveries.length;
    const otlpOffset = receiver.otlpDeliveries;
    const probeOffset = receiver.probes;
    logs.push(broker.logs());
    await broker.close();
    broker = undefined;
    broker = await startLocal(runtime, fixture.origin, {
      ...options,
      databaseSnapshot: { statements: saved, tooling: detection === 'tooling' },
    });
    const restored = await chain();
    assert(
      restored.head_seq === baseline.head_seq &&
        restored.head_hash === baseline.head_hash &&
        restored.chain_id === baseline.chain_id,
      'JournalNotRolledBack',
    );
    const rolledSinks = await sinks();
    assert(
      rolledSinks.length === savedSinks.length &&
        rolledSinks.every(
          (sink, index) =>
            sink.sink_id === savedSinks[index]!.sink_id &&
            sink.progress_seq === savedSinks[index]!.progress_seq &&
            sink.custody_seq === savedSinks[index]!.custody_seq,
        ),
      'CursorsNotRolledBack',
    );
    if (detection === 'tooling') {
      assert(
        restored.restore_pending === 1 &&
          restored.incarnation === baseline.incarnation + 1 &&
          restored.epoch === baseline.epoch + 1,
        'RestoreToolingNotDetected',
      );
    } else {
      assert(restored.incarnation === baseline.incarnation, 'ExternalRestoreMarkedByTooling');
      await job('core:audit-frontier:v1');
      assert(receiver.probes > probeOffset, 'FrontierNotQueried');
    }
    const blocked = await chain();
    assert(
      blocked.restore_pending === 1 && blocked.epoch === baseline.epoch + 1,
      'RestoreNotBlocked',
    );
    const blockedSinks = await sinks();
    assert(
      blockedSinks.length === 2 &&
        blockedSinks.every((sink) => sink.state === 'blocked' && sink.blocked_reason === 'fork'),
      'SinkEscapedRestoreBlock',
    );
    // Retained rows above both restored cursors make these export attempts observable if the block is bypassed.
    await job('core:audit-export-webhook:v1');
    await job('core:audit-export-otlp:v1');
    await job('core:audit-maintain:v1');
    await job('core:audit-seal:v1');
    assert(
      receiver.deliveries.length === deliveryOffset && receiver.otlpDeliveries === otlpOffset,
      'DeliveryBeforeConfirmation',
    );
    const held = await chain();
    assert(
      held.head_seq === baseline.head_seq && held.boundary_seq === baseline.boundary_seq,
      'BlockedJournalMoved',
    );
    const ledger = await broker.read<{ reason_code: string }>(
      "SELECT reason_code FROM audit_ledger WHERE org_id = ? AND kind = 'epoch_bump' AND chain_id = ? AND epoch = ?",
      [orgId, blocked.chain_id, blocked.epoch],
    );
    assert(
      ledger.some(
        (row) =>
          row.reason_code === (detection === 'tooling' ? 'restore_detected' : 'receiver_fork'),
      ),
      'MissingRestoreEvidence',
    );
    await broker.confirmAuditRestore(
      actor.id,
      Math.max(...blockedSinks.map((sink) => sink.generation)),
      common.head_seq + 1,
    );
    assert((await chain()).restore_pending === 0, 'ConfirmationDidNotClearBlock');
    const confirmedSinks = await sinks();
    assert(
      confirmedSinks.length === blockedSinks.length &&
        confirmedSinks.every(
          (sink, index) =>
            sink.sink_id === blockedSinks[index]!.sink_id &&
            sink.state === 'active' &&
            sink.progress_seq <= blockedSinks[index]!.progress_seq &&
            sink.custody_seq <= blockedSinks[index]!.custody_seq,
        ),
      'ConfirmationAdvancedCustody',
    );
    const confirmation = await broker.read<{ from_seq: number; actor_id: string }>(
      "SELECT from_seq, actor_id FROM audit_ledger WHERE org_id = ? AND kind = 'restore_confirmed' AND chain_id = ? AND epoch = ?",
      [orgId, blocked.chain_id, blocked.epoch],
    );
    assert(
      confirmation.length === 1 &&
        confirmation[0]!.from_seq === common.head_seq + 1 &&
        confirmation[0]!.actor_id === actor.id,
      'MissingConfirmationLedger',
    );
    requireStatus(
      await admin.request('/_pb/projects', { slug: 'restore-resumed', name: 'Restore resumed' }),
      201,
    );
    const resumed = await sealAndDeliver();
    for (const deliveries of [
      receiver.deliveries.slice(deliveryOffset),
      receiver.otlp.slice(otlpOffset),
    ]) {
      const first = deliveries[0]?.records[0];
      assert(
        first?.['kind'] === 'fork' &&
          first['last_common_seq'] === common.head_seq &&
          first['last_common_hash'] === common.head_hash,
        'MissingForkMarkerBeforeReplay',
      );
      assert(
        deliveries.every(
          (batch) =>
            batch.chain_id === baseline.chain_id &&
            batch.epoch === blocked.epoch &&
            batch.org_id === orgId,
        ),
        'WrongResumedIdentity',
      );
      const events = deliveries
        .flatMap((batch) => batch.records)
        .filter((record) => record['kind'] === 'event');
      assert(
        events.some(
          (record) =>
            record['seq'] === common.head_seq + 1 && record['hash'] === baseline.head_hash,
        ) &&
          events.some((record) => record['action'] === 'project.create') &&
          events.some(
            (record) =>
              record['action'] === 'audit.sink_admin' &&
              String(record['payload_json']).includes('confirm_restore'),
          ),
        'MissingResumedEvents',
      );
      const retained = (await broker.audit.snapshot()).filter(
        (row) => row.seq > common.head_seq && row.seq <= baseline.head_seq,
      );
      assert(
        retained.length > 0 &&
          retained.every((row) =>
            events.some((record) => record['seq'] === row.seq && record['hash'] === row['hash']),
          ),
        'MissingRetainedReplay',
      );
      assert(
        events.every(
          (record) =>
            record['chain_id'] === baseline.chain_id &&
            record['epoch'] === blocked.epoch &&
            record['org_id'] === orgId,
        ),
        'WrongResumedEventIdentity',
      );
    }
    assert(resumed.head_seq > baseline.head_seq, 'JournalDidNotResume');
    const epoch = (await chain()).epoch;
    await job('core:audit-frontier:v1');
    assert(
      (await chain()).epoch === epoch && (await sinks()).every((sink) => sink.state === 'active'),
      'ConfirmedFrontierReblocked',
    );
    await job('core:audit-verify:v1');
    const verification = await broker.read<{
      verified_through_seq: number;
      verified_at: string | null;
    }>('SELECT verified_through_seq, verified_at FROM audit_chain WHERE org_id = ?', [orgId]);
    assert(
      verification[0]?.verified_at !== null &&
        verification[0]?.verified_through_seq === resumed.head_seq,
      'ResumedJournalNotVerified',
    );
    const pruneSnapshot = await broker.databaseSnapshot();
    const pruneHead = await chain();
    assert(
      (await sinks()).every((sink) => sink.progress_seq === pruneHead.head_seq) &&
        (await sinks()).some(
          (sink) => sink.sink_id === 'webhook' && sink.custody_seq === pruneHead.head_seq,
        ),
      'RestorePruneCustodyMissing',
    );
    logs.push(broker.logs());
    await broker.close();
    broker = await startLocal(runtime, fixture.origin, {
      ...options,
      auditEnv: { ...options.auditEnv, PB_AUDIT_TRAIL: 'off' },
      databaseSnapshot: { statements: pruneSnapshot, tooling: true },
    });
    // Warm reconciliation before isolating the restore-specific repository guard.
    const pruneStatus = (await requireStatus(
      await admin.request('/_pb/audit/status', undefined, 'GET'),
      200,
    ).json()) as { trailActive: boolean };
    assert(pruneStatus.trailActive === false, 'RestorePruneTrailStillActive');
    const pruning = await deliveryInfrastructure(broker, orgId);
    pruning.isolateRestorePruneGuard();
    const pruneBefore = await chain();
    const custody = await sinks();
    assert(
      pruneBefore.restore_pending === 1 &&
        pruneBefore.boundary_seq <= pruneBefore.head_seq &&
        custody.every(
          (sink) => sink.state === 'active' && sink.progress_seq >= pruneBefore.head_seq,
        ) &&
        custody.some(
          (sink) => sink.sink_id === 'webhook' && sink.custody_seq >= pruneBefore.head_seq,
        ),
      'RestorePruneFixtureNotEligible',
    );
    await job('core:audit-maintain:v1');
    assert(
      (await chain()).boundary_seq === pruneBefore.boundary_seq,
      'RestorePrunedBeforeConfirmation',
    );
    await broker.confirmAuditRestore(
      actor.id,
      Math.max(...custody.map((sink) => sink.generation)),
      pruneBefore.head_seq + 1,
    );
    assert((await chain()).restore_pending === 0, 'PruneConfirmationDidNotClearBlock');
    await job('core:audit-maintain:v1');
    const pruneAfter = await chain();
    assert(
      pruneAfter.boundary_seq > pruneBefore.boundary_seq &&
        pruneAfter.head_seq === pruneBefore.head_seq,
      'RestorePruneDidNotResume',
    );
    fixture.healthy();
    await broker.moduleEvidence();
    logs.push(broker.logs());
    assert(
      sensitive.every((secret) => !secret || !logs.join('\n').includes(secret)),
      'SensitiveDataInOutput',
    );
    return { status: 'PASS', reason: `${runtime}: audit restore ${detection} executed.` };
  } catch (error) {
    return {
      status: error instanceof LocalUnavailable ? 'NOT RUN' : 'FAIL',
      reason: `${runtime}: audit restore ${detection}: ${failureName(error)}`,
    };
  } finally {
    await broker?.close();
    await fixture?.close();
  }
}
