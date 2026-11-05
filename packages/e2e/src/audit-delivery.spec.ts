import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import {
  deliveryEntry,
  deliveryBuild,
  deliveryInfrastructure,
  deliveryReceiver,
} from './audit-delivery-fixture.js';
import { failureName, requireStatus, session } from './evidence.js';
import {
  fixtureDestination,
  LocalUnavailable,
  reserveLoopbackPort,
  startLocal,
  until,
  type LocalBroker,
  type Runtime,
} from './local.js';
import type { ScenarioResult } from './runner.js';

interface Sink extends Record<string, unknown> {
  state: string;
  progress_seq: number;
  custody_seq: number;
  inflight_body: string | null;
  next_attempt_at: string | null;
  last_error_code: string | null;
  receiver_fingerprint: string;
}

/* eslint-disable no-restricted-syntax -- Read-only evidence is scoped to the organization created by the launcher. */
export async function auditDeliveryScenario(runtime: Runtime): Promise<ScenarioResult> {
  let broker: LocalBroker | undefined;
  let buildDirectory: string | undefined;
  let receiver: Awaited<ReturnType<typeof deliveryReceiver>> | undefined;
  let stage = 'startup';
  try {
    await reserveLoopbackPort();
    receiver = await deliveryReceiver();
    const remote = receiver;
    buildDirectory = await deliveryBuild(runtime);
    broker = await startLocal(runtime, remote.origin, {
      bundleDirectory: buildDirectory,
      onOrganization: (orgId) => remote.pin(orgId),
      patchBundle: (bundle) => deliveryEntry(bundle, runtime, remote.origin),
      outboundDestination(url) {
        const target = new URL(url);
        return target.origin === 'https://audit.fixture.test'
          ? remote.origin + target.pathname
          : fixtureDestination(url, remote.origin);
      },
    });
    const local = broker;
    const admin = await session(local);
    const { id: orgId } = (await requireStatus(
      await admin.request('/_pb/organization', undefined, 'GET'),
      200,
    ).json()) as { id: string };
    remote.pin(orgId);
    const infrastructure = await deliveryInfrastructure(local, orgId);
    const sink = async (id = 'webhook') => {
      const [row] = await local.read<Sink>(
        'SELECT state, progress_seq, custody_seq, inflight_body, next_attempt_at, last_error_code, receiver_fingerprint FROM audit_sink WHERE org_id = ? AND sink_id = ?',
        [orgId, id],
      );
      assert(row, 'MissingDeliverySink');
      return row;
    };
    const job = async (kind: Parameters<typeof infrastructure.enqueue>[0]) => {
      const id = await infrastructure.enqueue(kind);
      await infrastructure.settled(id);
    };
    const head = async () => {
      const [row] = await local.read<{ head_seq: number }>(
        'SELECT head_seq FROM audit_chain WHERE org_id = ?',
        [orgId],
      );
      assert(row, 'MissingDeliveryChain');
      return Number(row.head_seq);
    };
    let project = 0;
    const seal = async (count = 1) => {
      for (let i = 0; i < count; i++) {
        const slug = `delivery-${++project}`;
        requireStatus(await admin.request('/_pb/projects', { slug, name: slug }), 201);
      }
      await job('seal');
      return head();
    };
    const drain = async (id: 'webhook' | 'otlp', through: number) => {
      await until(
        async () => {
          await infrastructure.due(id);
          await job(`export-${id}`);
          return Number((await sink(id)).progress_seq) >= through;
        },
        'delivery-drain',
        90_000,
      );
    };
    const ledger = () =>
      local.read<{
        kind: string;
        from_seq: number;
        to_seq: number;
        sink_id: string;
        reason_code: string;
        count: number;
      }>(
        'SELECT kind, from_seq, to_seq, sink_id, reason_code, count FROM audit_ledger WHERE org_id = ? AND superseded_by IS NULL',
        [orgId],
      );
    const webhookEvents = () =>
      remote.receipts.filter(
        (receipt) =>
          receipt.sink === 'webhook' && receipt.records.some((row) => row.kind === 'event'),
      );

    stage = 'baseline';
    const baseline = await seal();
    await drain('webhook', baseline);
    await drain('otlp', baseline);
    assert.equal(Number((await sink()).custody_seq), baseline, 'DurableAckDidNotGrantCustody');
    assert.equal(Number((await sink('otlp')).custody_seq), 0, 'DeliveryOnlySinkGrantedCustody');

    stage = 'mismatched-ack-and-frozen-retry';
    remote.mode('webhook', 'bad-ack');
    const badAckHead = await seal();
    await job('export-webhook');
    const badAck = await sink();
    assert.equal(Number(badAck.progress_seq), baseline, 'MismatchedAckAdvancedProgress');
    assert.equal(Number(badAck.custody_seq), baseline, 'MismatchedAckGrantedCustody');
    assert(badAck.inflight_body && badAck.next_attempt_at, 'BadAckNotPersistedForRetry');
    const frozenWire = webhookEvents().at(-1)!.raw;
    remote.mode('webhook', 'accept');
    await drain('webhook', badAckHead);
    assert.equal(webhookEvents().at(-1)!.raw, frozenWire, 'RetryChangedFrozenBytes');

    for (const fault of ['crash', 'cas'] as const) {
      stage = `ack-before-${fault}`;
      const before = remote.receipts.length;
      const count = remote.faults();
      const beforeProgress = Number((await sink()).progress_seq);
      remote.fault(fault);
      const through = await seal();
      await job('export-webhook');
      assert.equal(remote.faults(), count + 1, 'AckPersistenceFaultNotExercised');
      if (fault === 'cas')
        assert.equal(
          Number((await sink()).progress_seq),
          beforeProgress,
          'RefusedCasAdvancedProgress',
        );
      await drain('webhook', through);
      const deliveries = remote.receipts
        .slice(before)
        .filter(
          (receipt) =>
            receipt.sink === 'webhook' && receipt.records.some((record) => record.kind === 'event'),
        );
      assert(deliveries.length >= 2, 'LostAckNotRedelivered');
      assert.equal(deliveries[0]!.raw, deliveries[1]!.raw, 'LostAckChangedFrozenBytes');
      assert.equal(Number((await sink()).custody_seq), through, 'LostAckRecoveryMissingCustody');
    }

    stage = 'overlapping-leases';
    const overlapStart = Number((await sink()).progress_seq);
    const independentHead = await seal();
    const overlapOffset = remote.receipts.length;
    const overlap = (await requireStatus(
      await fetch(local.origin + '/__fixture/overlapping-leases', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ orgId }),
        signal: AbortSignal.timeout(30_000),
      }),
      200,
    ).json()) as {
      independentOutcome: string;
      independentThrough: number;
      heartbeatRefused: boolean;
      cancelled: string;
      cancellationSaves: number;
      staleOutcome: string;
      replacementOutcome: string;
      attempts: { fence: number; saved: boolean }[];
      oldFence: number;
      replacementFence: number;
      before: number;
      afterStale: number;
      after: number;
      sameSnapshot: boolean;
      frozen: boolean;
    };
    assert.equal(overlap.independentOutcome, 'accepted', 'IndependentSinkBlocked');
    assert.equal(overlap.independentThrough, independentHead, 'IndependentSinkMissingProgress');
    assert(overlap.heartbeatRefused, 'StaleHeartbeatNotRefused');
    assert.equal(overlap.cancelled, 'idle', 'CancelledExportNotStopped');
    assert.equal(overlap.cancellationSaves, 0, 'CancelledExportAttemptedAckSave');
    assert.equal(overlap.staleOutcome, 'contended', 'StaleLeaseNotContended');
    assert.equal(overlap.replacementOutcome, 'accepted', 'ReplacementLeaseNotAccepted');
    assert.deepEqual(
      overlap.attempts,
      [
        { fence: overlap.oldFence, saved: false },
        { fence: overlap.replacementFence, saved: true },
      ],
      'StaleLeaseRepositorySaveNotFenced',
    );
    assert.equal(overlap.replacementFence, overlap.oldFence + 1, 'LeaseFenceNotAdvanced');
    assert.equal(overlap.before, overlapStart, 'OverlapStartedWithWrongCursor');
    assert.equal(overlap.afterStale, overlapStart, 'StaleLeaseAdvancedProgress');
    assert.equal(overlap.after, independentHead, 'ReplacementLeaseMissingProgress');
    const deliveries = remote.receipts.slice(overlapOffset).filter((row) => row.sink === 'webhook');
    assert.equal(deliveries.length, 3, 'OverlapExecutionsNotDelivered');
    assert(
      deliveries.every((row) => row.raw === deliveries[0]!.raw),
      'ReplacementLeaseChangedFrozenBytes',
    );
    assert(overlap.sameSnapshot, 'StaleLeaseSinkCasChanged');
    assert(overlap.frozen, 'OverlapFrozenBatchMissing');
    await drain('otlp', independentHead);
    assert.equal(
      Number((await sink()).custody_seq),
      independentHead,
      'ReplacementLeaseMissingCustody',
    );

    stage = 'otlp-partial-success-warning';
    await drain('otlp', await head());
    assert.equal((await sink('otlp')).last_error_code, null, 'UnexpectedPriorOtlpWarning');
    remote.mode('otlp', 'warning');
    const warningFrom = Number((await sink('otlp')).progress_seq) + 1;
    const warningLogs = local.logs().length;
    const warningHead = await seal();
    await drain('otlp', warningHead);
    assert(
      !(await ledger()).some(
        (row) =>
          row.sink_id === 'otlp' &&
          ['uncertain', 'gap'].includes(row.kind) &&
          Number(row.to_seq) >= warningFrom,
      ),
      'WarningCreatedLossDisposition',
    );

    if (runtime === 'cloudflare') {
      const warning = await sink('otlp');
      assert.equal(warning.last_error_code, 'partial_success', 'WarningAckNotRecorded');
      assert.equal(warning.state, 'active', 'WarningBlockedSink');
      assert.equal(Number(warning.custody_seq), 0, 'WarningGrantedCustody');
      assert.equal(warning.inflight_body, null, 'WarningKeptInflightBatch');
      assert.equal(warning.next_attempt_at, null, 'WarningScheduledRetry');
    } else {
      await until(
        async () => local.logs().slice(warningLogs).includes('audit.delivery_partial_success'),
        'partial-success-warning-log',
        10000,
      );
    }

    stage = 'otlp-partial-rejection';
    remote.mode('otlp', 'partial');
    const partialFrom = warningHead + 1;
    const partialOffset = remote.receipts.length;
    const partialHead = await seal(2);
    await drain('otlp', partialHead);
    const uncertain = (await ledger()).filter(
      (row) =>
        row.sink_id === 'otlp' &&
        row.kind === 'uncertain' &&
        Number(row.from_seq) === partialFrom &&
        Number(row.to_seq) === partialHead,
    );
    assert.equal(uncertain.length, 1, 'PartialSuccessDispositionMissing');
    assert(
      uncertain[0]!.count === 1 && uncertain[0]!.reason_code === 'partial_rejected',
      'PartialSuccessDispositionMismatch',
    );
    const partialEvents = remote.receipts
      .slice(partialOffset)
      .filter(
        (receipt) => receipt.sink === 'otlp' && receipt.records.some((row) => row.kind === 'event'),
      );
    assert.equal(partialEvents.length, 1, 'PartialSuccessReplayedOriginal');
    const rejectedBatch = partialEvents[0]!;
    const rejectedRecords = rejectedBatch.records.filter((row) => row.kind === 'event');
    assert(
      rejectedRecords.length > 1 &&
        rejectedRecords[0]!.seq === partialFrom &&
        rejectedRecords.at(-1)!.seq === partialHead,
      'PartialSuccessBatchMismatch',
    );
    const markerReceipt = remote.receipts
      .slice(partialOffset)
      .find(
        (receipt) =>
          receipt.sink === 'otlp' &&
          receipt.records.some((row) => row.kind === 'delivery_uncertain'),
      );
    const uncertainMarker = markerReceipt?.records.find((row) => row.kind === 'delivery_uncertain');
    assert(uncertainMarker, 'UncertainMarkerMissing');
    const digest = createHash('sha256')
      .update(
        JSON.stringify([
          rejectedBatch.chain,
          rejectedBatch.epoch,
          'delivery_uncertain',
          partialFrom,
          partialHead,
        ]),
      )
      .digest('hex')
      .slice(0, 30);
    let markerBits = BigInt('0x' + digest);
    let expectedMarker = '';
    for (let index = 0; index < 24; index++) {
      expectedMarker =
        '0123456789ABCDEFGHJKMNPQRSTVWXYZ'[Number(markerBits & 31n)] + expectedMarker;
      markerBits >>= 5n;
    }
    assert.equal(
      uncertainMarker.marker_id,
      '00' + expectedMarker,
      'UncertainMarkerIdentityMismatch',
    );

    assert(
      markerReceipt!.chain === rejectedBatch.chain &&
        markerReceipt!.org === orgId &&
        markerReceipt!.epoch === rejectedBatch.epoch &&
        uncertainMarker['chain_id'] === rejectedBatch.chain &&
        uncertainMarker['epoch'] === rejectedBatch.epoch &&
        typeof uncertainMarker.marker_id === 'string' &&
        uncertainMarker.marker_id.length === 26 &&
        !rejectedRecords.some((row) => row.id === uncertainMarker.marker_id) &&
        uncertainMarker.from_seq === rejectedRecords[0]!.seq &&
        uncertainMarker.to_seq === rejectedBatch.through &&
        uncertainMarker.to_seq! - uncertainMarker.from_seq! + 1 === rejectedRecords.length &&
        uncertainMarker.hash === rejectedBatch.hash &&
        uncertainMarker.hash === rejectedRecords.at(-1)!.hash &&
        uncertainMarker['reason_code'] === uncertain[0]!.reason_code,
      'UncertainMarkerMismatch',
    );
    assert(
      Number((await sink('otlp')).custody_seq) < partialFrom,
      'PartialSuccessInventedPrefixCustody',
    );
    await job('export-otlp');
    assert.equal(
      remote.receipts.filter((receipt) => receipt.raw === partialEvents[0]!.raw).length,
      1,
      'SettledPartialSuccessReplayed',
    );
    remote.mode('otlp', 'accept');

    stage = 'retryable-failure-never-skips';
    await drain('webhook', await head());
    remote.mode('webhook', 'retry');
    const retryStart = Number((await sink()).progress_seq);
    const retryHead = await seal();
    await job('export-webhook');
    assert.equal(
      Number((await sink()).progress_seq),
      retryStart,
      'RetryableFailureAdvancedProgress',
    );
    assert((await sink()).next_attempt_at, 'RetryableFailureMissingBackoff');
    assert(
      !(await ledger()).some(
        (row) =>
          row.sink_id === 'webhook' && row.kind === 'skipped' && Number(row.to_seq) > retryStart,
      ),
      'RetryableFailureSkipped',
    );
    remote.mode('webhook', 'accept');
    await drain('webhook', retryHead);

    stage = 'bisection-skip-tombstone';
    await drain('webhook', await head());
    const skipFrom = Number((await sink()).progress_seq) + 1;
    remote.mode('webhook', 'reject');
    const skipOffset = remote.receipts.length;
    const skipHead = await seal(3);
    await drain('webhook', skipHead);
    const rejected = remote.receipts
      .slice(skipOffset)
      .filter((receipt) => receipt.sink === 'webhook');
    assert(
      rejected.some((receipt) => receipt.records.filter((row) => row.kind === 'event').length > 1),
      'BisectionNotExercised',
    );
    const skips = (await ledger()).filter(
      (row) =>
        row.sink_id === 'webhook' &&
        row.kind === 'skipped' &&
        Number(row.from_seq) >= skipFrom &&
        Number(row.to_seq) <= skipHead,
    );
    assert.equal(skips.length, skipHead - skipFrom + 1, 'SkippedRangeMissingLedger');
    for (const disposition of skips) {
      assert.equal(
        Number(disposition.from_seq),
        Number(disposition.to_seq),
        'RejectionSkippedWholeBatch',
      );
      const original = rejected
        .flatMap((receipt) => receipt.records)
        .find((row) => row.kind === 'event' && row.seq === Number(disposition.from_seq));
      const tombstone = rejected
        .flatMap((receipt) => receipt.records)
        .find((row) => row.kind === 'tombstone' && row.seq === Number(disposition.from_seq));
      assert(original && tombstone, 'SkippedOriginalOrTombstoneMissing');
      assert.equal(tombstone.hash, original.hash, 'TombstoneHashMismatch');
      assert.equal(tombstone.prev_hash, original.prev_hash, 'TombstonePreviousHashMismatch');
      assert(
        rejected.filter(
          (receipt) =>
            receipt.records.length === 1 &&
            receipt.records[0]!.kind === 'event' &&
            receipt.records[0]!.seq === original.seq,
        ).length >= 2,
        'SkippedBeforeConfiguredRejectionRetry',
      );
      assert(
        tombstone.marker_id && tombstone.marker_id !== original.id,
        'TombstoneReusedEventIdentity',
      );
    }

    stage = 'late-original-recovery';
    remote.mode('webhook', 'accept');
    const recoveryOffset = remote.receipts.length;
    await infrastructure.admin('replay', String(skipFrom));
    await drain('webhook', skipHead);
    const recovered = remote.receipts
      .slice(recoveryOffset)
      .filter((receipt) => receipt.sink === 'webhook')
      .flatMap((receipt) => receipt.records)
      .filter((row) => row.kind === 'event' && row.seq! >= skipFrom && row.seq! <= skipHead);
    assert.equal(
      new Set(recovered.map((row) => row.seq)).size,
      skipHead - skipFrom + 1,
      'LateOriginalRangeMissing',
    );
    assert.equal(remote.recoveries(), skipHead - skipFrom + 1, 'ReceiverDidNotRecoverTombstones');

    stage = 'receiver-change-lifecycle';
    const beforeChange = await sink();
    remote.registry('changed');
    const reconcile = async (state: string, fingerprint?: string) => {
      await until(
        async () => {
          requireStatus(await admin.request('/_pb/audit/status', undefined, 'GET'), 200);
          const current = await sink();
          return (
            current.state === state &&
            (!fingerprint || current.receiver_fingerprint === fingerprint)
          );
        },
        'sink-lifecycle',
        45_000,
      );
    };
    await reconcile('active', 'f'.repeat(64));
    assert.equal(
      Number((await sink()).progress_seq),
      Number(beforeChange.progress_seq),
      'ReceiverChangeResetProgress',
    );
    assert.equal(
      Number((await sink()).custody_seq),
      Number(beforeChange.custody_seq),
      'ReceiverChangeLostCustody',
    );
    const markerOffset = remote.receipts.length;
    await job('export-webhook');
    assert(
      remote.receipts
        .slice(markerOffset)
        .some(
          (receipt) =>
            receipt.sink === 'webhook' &&
            receipt.records.some((row) => row.kind === 'receiver_changed'),
        ),
      'ReceiverChangedMarkerMissing',
    );
    await infrastructure.admin('rebind', '1');
    await drain('webhook', await head());
    assert(
      (await ledger()).some((row) => row.kind === 'rebind' && row.sink_id === 'webhook'),
      'RebindLedgerMissing',
    );
    remote.registry('inactive');
    await reconcile('inactive');
    const inactive = await sink();
    const inactiveHead = await seal(2);
    const inactiveBacklog = (await local.audit.snapshot()).filter(
      (row) => row.seq > Number(inactive.progress_seq),
    );
    assert(
      inactiveHead > Number(inactive.progress_seq) && inactiveBacklog.length > 0,
      'InactiveBacklogMissing',
    );
    const inactiveOffset = remote.receipts.length;
    await job('export-webhook');
    assert(
      !remote.receipts.slice(inactiveOffset).some((receipt) => receipt.sink === 'webhook'),
      'InactiveSinkDelivered',
    );
    assert.equal(
      Number((await sink()).progress_seq),
      Number(inactive.progress_seq),
      'InactiveSinkLostCursor',
    );
    assert.equal(
      Number((await sink()).custody_seq),
      Number(inactive.custody_seq),
      'InactiveSinkLostCustody',
    );
    remote.registry('changed');
    await reconcile('active', 'f'.repeat(64));
    assert.equal(
      Number((await sink()).progress_seq),
      Number(inactive.progress_seq),
      'ReactivatedSinkLostCursor',
    );
    const assertBacklog = async (backlog: typeof inactiveBacklog, through: number) => {
      const offset = remote.receipts.length;
      await drain('webhook', through);
      const events = remote.receipts
        .slice(offset)
        .filter((receipt) => receipt.sink === 'webhook')
        .flatMap((receipt) => receipt.records)
        .filter((row) => row.kind === 'event');
      assert.deepEqual(
        events.map((row) => [row.seq, row.hash]),
        backlog.map((row) => [row.seq, row['hash']]),
        'ReactivationBacklogMismatch',
      );
    };
    await assertBacklog(inactiveBacklog, inactiveHead);
    remote.registry('disabled');
    await reconcile('disabled');
    const disabled = await sink();
    const disabledHead = await seal(2);
    const disabledBacklog = (await local.audit.snapshot()).filter(
      (row) => row.seq > Number(disabled.progress_seq),
    );
    assert(
      disabledHead > Number(disabled.progress_seq) && disabledBacklog.length > 0,
      'DisabledBacklogMissing',
    );
    const disabledOffset = remote.receipts.length;
    await job('export-webhook');
    assert(
      !remote.receipts.slice(disabledOffset).some((receipt) => receipt.sink === 'webhook'),
      'DisabledSinkDelivered',
    );
    assert.equal(
      Number((await sink()).progress_seq),
      Number(disabled.progress_seq),
      'DisabledSinkLostCursor',
    );
    assert.equal(
      Number((await sink()).custody_seq),
      Number(disabled.custody_seq),
      'DisabledSinkLostCustody',
    );
    remote.registry('changed');
    await reconcile('active', 'f'.repeat(64));
    await assertBacklog(disabledBacklog, disabledHead);
    remote.registry('disabled');
    await reconcile('disabled');
    const retirementFrom = Number((await sink()).progress_seq) + 1;
    const retirementHead = await seal();
    await infrastructure.admin('retire', `webhook:${retirementFrom}-${retirementHead}`);
    assert.equal((await sink()).state, 'retired', 'RemovedSinkNotRetired');
    assert(
      (await ledger()).some((row) => row.kind === 'retire' && row.sink_id === 'webhook'),
      'RetirementLedgerMissing',
    );
    const retained = (await local.audit.snapshot()).length;
    await job('maintain');
    assert.equal((await local.audit.snapshot()).length, retained, 'ActiveTrailLostRetainedHistory');
    await job('verify');
    const [verification] = await local.read<{
      verified_at: string | null;
      verified_through_seq: number;
      verified_bodies: number;
      verified_withheld: number;
    }>(
      'SELECT verified_at, verified_through_seq, verified_bodies, verified_withheld FROM audit_chain WHERE org_id = ?',
      [orgId],
    );
    assert(
      verification?.verified_at &&
        verification.verified_through_seq === (await head()) &&
        verification.verified_bodies > 0 &&
        verification.verified_withheld === 0,
      'DeliveryJournalNotVerified',
    );

    stage = 'module-and-leak-evidence';
    await local.moduleEvidence();
    remote.healthy();
    const output = local.logs() + remote.receipts.map((receipt) => receipt.raw).join('\n');
    for (const secret of [...local.secrets(), local.setupToken, ...admin.secrets()])
      assert(!secret || !output.includes(secret), 'SensitiveDataInDeliveryEvidence');
    return {
      status: 'PASS',
      reason: `${runtime}: audit-delivery: all delivery and lifecycle oracles executed.`,
    };
  } catch (error) {
    return error instanceof LocalUnavailable
      ? { status: 'NOT RUN', reason: `${runtime}: ${error.message}` }
      : {
          status: 'FAIL',
          reason: `${runtime}: audit-delivery failed at ${stage} (${failureName(error)}).`,
        };
  } finally {
    try {
      await broker?.close();
    } finally {
      await receiver?.close();
      if (buildDirectory) await rm(buildDirectory, { recursive: true, force: true });
    }
  }
}
/* eslint-enable no-restricted-syntax */
