/* eslint-disable no-restricted-syntax -- Test infrastructure uses fixed SQL scoped to the pinned organization; no production SQL is added. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { auditHash, type AuditRecord } from './audit.spec.js';
import { requireStatus, session, failureName } from './evidence.js';
import { LocalUnavailable, repository, reserveLoopbackPort, until } from './local.js';
import type { Runtime } from './local.js';
import { startRetentionLocal, type RetentionBroker } from './audit-retention-local.js';
import type { ScenarioResult } from './runner.js';

const budget = 64 * 1024 * 1024;
const receiverOrigin = 'https://retention.audit.test';
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
  probe?: string;
  records: Record<string, unknown>[];
}

async function receiver() {
  let accepting = false;
  let observed = 0;
  let frontier: Position | null = null;
  const gaps: Record<string, unknown>[] = [];
  const organizations = new Set<string>();
  let failure = false;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        assert(bytes <= 1024 * 1024, 'ReceiverBodyTooLarge');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Envelope;
      organizations.add(body.org_id);
      response.setHeader('content-type', 'application/json');
      if (body.probe === 'frontier') {
        response.end(JSON.stringify({ frontier }));
        return;
      }
      observed++;
      if (!accepting) {
        response.writeHead(503);
        response.end('{}');
        return;
      }
      let seq = frontier?.seq ?? 0;
      let hash = frontier?.hash ?? '0'.repeat(64);
      for (const record of body.records) {
        if (record['kind'] === 'gap') gaps.push(record);
        if (record['kind'] === 'boundary') {
          seq = Number(record['boundary_seq']) - 1;
          hash = String(record['boundary_prev_hash']);
        } else if (record['seq'] !== undefined) {
          seq = Number(record['seq']);
          hash = String(record['hash']);
        } else if (record['to_seq'] !== undefined) {
          seq = Number(record['to_seq']);
          hash = String(record['hash']);
        }
      }
      frontier = { chain_id: body.chain_id, epoch: body.epoch, seq, hash };
      response.end(JSON.stringify({ acked: frontier }));
    } catch {
      failure = true;
      response.writeHead(500);
      response.end('{}');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'ReceiverAddressMissing');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    accept(value: boolean) {
      accepting = value;
    },
    observed: () => observed,
    gaps,
    assertHealthy(orgId: string) {
      assert(
        !failure && organizations.size === 1 && organizations.has(orgId),
        'ReceiverEvidenceInvalid',
      );
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

type Chain = Record<string, unknown> & {
  head_seq: number;
  head_hash: string;
  boundary_seq: number;
  boundary_prev_hash: string;
  mode: string;
  pending_mode: string | null;
  cutover_seq: number | null;
  journal_rows: number;
  journal_bytes: number;
};

export async function auditRetentionScenario(runtime: Runtime): Promise<ScenarioResult> {
  let directory: string | undefined;
  let broker: RetentionBroker | undefined;
  let sink: Awaited<ReturnType<typeof receiver>> | undefined;
  let stage = 'startup';
  let stale: Awaited<ReturnType<RetentionBroker['staleSeal']>> | undefined;
  const deadline = Date.now() + 270_000;
  const headerCanary = randomBytes(24).toString('hex');
  try {
    await reserveLoopbackPort();
    sink = await receiver();
    directory = await mkdtemp(join(repository, '.pb/audit-retention-build-'));
    await promisify(execFile)(
      process.execPath,
      [
        join(repository, 'packages/cli/dist/bin.js'),
        'build',
        '--config',
        'fixtures/audit-retention.config.ts',
        '--target',
        runtime,
        '--out',
        directory,
      ],
      {
        cwd: repository,
        env: { ...process.env, AUD40B_RUNTIME: runtime },
        timeout: 90_000,
        maxBuffer: 1024 * 1024,
      },
    );
    // Both runtimes send the real webhook protocol to this loopback receiver. The Node
    // preload supplies a public DNS answer and redirects only that declared destination.
    broker = await startRetentionLocal(runtime, sink.origin, {
      output: directory,
      runtimeEnv: {
        PB_AUDIT_WEBHOOK_URL: receiverOrigin,
        PB_AUDIT_WEBHOOK_HEADERS: `X-Retention=${headerCanary}`,
      },
      outboundDestination(url) {
        assert(new URL(url).origin === receiverOrigin, 'UnexpectedRetentionDestination');
        return sink!.origin;
      },
      nodeTransport: `
const dns = (await import('node:dns/promises')).default;
dns.lookup = async (hostname) => {
  if (hostname !== 'retention.audit.test') throw new Error('UnexpectedRetentionDNS');
  return [{ address: '93.184.216.34', family: 4 }];
};
https.request = (options) => {
  if (options.host !== 'retention.audit.test') throw new Error('UnexpectedRetentionDestination');
  return http.request({ hostname: '127.0.0.1', port: ${sink.port}, path: '/', method: options.method, headers: options.headers, agent: false });
};`,
    });
    const local = broker;
    const admin = await session(local);
    const { id: orgId } = (await requireStatus(
      await admin.request('/_pb/organization', undefined, 'GET'),
      200,
    ).json()) as { id: string };
    const chain = async () => {
      const [value] = await local.read<Chain>('SELECT * FROM audit_chain WHERE org_id = ?', [
        orgId,
      ]);
      assert(value, 'RetentionChainMissing');
      return value;
    };
    const job = async (kind: Parameters<RetentionBroker['enqueue']>[0]) => {
      assert(Date.now() < deadline, 'RetentionDeadline');
      const id = await local.enqueue(kind);
      await until(
        async () => {
          await local.tick();
          const [row] = await local.read<{ state: string }>(
            'SELECT state FROM job WHERE org_id = ? AND id = ?',
            [orgId, id],
          );
          assert(row?.state !== 'dead', 'RetentionJobDead');
          return row?.state === 'succeeded';
        },
        `retention-${kind}`,
        Math.max(1, Math.min(60_000, deadline - Date.now())),
      );
    };
    const project = async (slug: string) =>
      requireStatus(await admin.request('/_pb/projects', { slug, name: slug }), 201);
    const status = async () =>
      (await requireStatus(
        await admin.request('/_pb/audit/status', undefined, 'GET'),
        200,
      ).json()) as {
        mode: string;
        trailActive: boolean;
        verification: {
          fromSeq: number;
          throughSeq: number;
          bodies: number;
          withheld: number;
        } | null;
      };
    const retryNow = async () => {
      await local.fixture(
        'UPDATE audit_sink SET next_attempt_at = NULL WHERE org_id = ? AND sink_id = ?',
        [orgId, 'webhook'],
      );
    };
    const suffix = async () => {
      const c = await chain();
      let seq = Number(c.boundary_seq);
      let hash = c.boundary_prev_hash;
      let count = 0;
      while (seq <= Number(c.head_seq)) {
        assert(Date.now() < deadline, 'RetentionDeadline');
        const rows = await local.read<AuditRecord>(
          'SELECT * FROM audit_event WHERE org_id = ? AND seq >= ? AND seq <= ? ORDER BY seq LIMIT 500',
          [orgId, seq, Number(c.head_seq)],
        );
        assert(rows.length > 0, 'RetainedSuffixMissing');
        for (const row of rows) {
          assert(
            row.seq === seq++ && row.prev_hash === hash && auditHash(row) === row.hash,
            'InvalidRetainedSuffix',
          );
          hash = row.hash;
          count++;
        }
      }
      assert(seq === Number(c.head_seq) + 1 && hash === c.head_hash, 'RetainedHeadMismatch');
      assert(count === Number(c.journal_rows), 'JournalCounterMismatch');
    };

    stage = 'trail-retains-without-custody';
    await project('retention-before');
    await job('seal');
    const initial = await chain();
    await job('export-webhook');
    assert(sink.observed() > 0, 'ReceiverNotExercised');
    const [unacknowledged] = await local.read<{ progress_seq: number; custody_seq: number }>(
      'SELECT progress_seq, custody_seq FROM audit_sink WHERE org_id = ? AND sink_id = ?',
      [orgId, 'webhook'],
    );
    assert(
      unacknowledged?.progress_seq === 0 && unacknowledged.custody_seq === 0,
      'RejectingReceiverGrantedCustody',
    );
    assert(Number(initial.head_seq) > 0, 'RetentionBacklogMissing');
    await job('maintain');
    assert((await chain()).boundary_seq === initial.boundary_seq, 'ActiveTrailPruned');

    stage = 'toggle-off-cutover-waits-for-durable-ack';
    await local.configure({ PB_AUDIT_TRAIL: 'off' });
    const off = await status();
    assert(off.mode === 'export' && !off.trailActive, 'TrailToggleNotApplied');
    requireStatus(await admin.request('/_pb/audit/head', undefined, 'GET'), 404);
    const cutting = await chain();
    assert(
      cutting.pending_mode === 'export' && Number(cutting.cutover_seq) >= Number(initial.head_seq),
      'CutoverNotFenced',
    );
    await job('maintain');
    assert((await chain()).boundary_seq === initial.boundary_seq, 'CutoverPrunedWithoutCustody');
    await project('retention-during-cutover');
    await job('seal');

    stage = 'stale-sealer-after-prune';
    await project('retention-stale');
    stale = await local.staleSeal();
    await job('seal');
    const sealed = await chain();
    sink.accept(true);
    await retryNow();
    await job('export-webhook');
    const [ack] = await local.read<{ progress_seq: number; custody_seq: number }>(
      'SELECT progress_seq, custody_seq FROM audit_sink WHERE org_id = ? AND sink_id = ?',
      [orgId, 'webhook'],
    );
    assert(
      ack && ack.progress_seq >= sealed.head_seq && ack.custody_seq >= sealed.head_seq,
      'DurableCustodyMissing',
    );
    await job('maintain');
    const pruned = await chain();
    assert(
      pruned.boundary_seq > initial.boundary_seq &&
        pruned.mode === 'export' &&
        pruned.pending_mode === null,
      'CutoverNotCompleted',
    );
    stale.release();
    const outcome = await stale.settled;
    stale = undefined;
    assert(outcome.outcome === 'contended', 'StaleSealerWasNotRefused');
    assert((await chain()).head_seq === pruned.head_seq, 'StaleSealerMovedHead');
    await project('retention-after-prune');
    await job('seal');
    const after = await chain();
    assert(after.head_seq > sealed.head_seq, 'PrunedSequenceReused');
    await suffix();
    await job('verify');
    const verified = await status();
    assert(
      verified.verification?.fromSeq === after.boundary_seq &&
        verified.verification.throughSeq === after.head_seq &&
        verified.verification.bodies > 0 &&
        verified.verification.withheld === 0,
      'SuffixVerificationMissing',
    );

    stage = 'toggle-on-restores-trail';
    await local.configure({ PB_AUDIT_TRAIL: 'on' });
    assert((await status()).trailActive, 'TrailNotReactivated');
    requireStatus(await admin.request('/_pb/audit/head', undefined, 'GET'), 200);
    await job('maintain');
    assert((await chain()).boundary_seq === after.boundary_seq, 'ReactivatedTrailPruned');

    stage = 'availability-capacity-gap';
    await project('retention-capacity');
    await job('seal');
    sink.accept(false);
    await local.fillCapacity(budget);
    const full = await chain();
    const [lagging] = await local.read<{ progress_seq: number }>(
      'SELECT progress_seq FROM audit_sink WHERE org_id = ? AND sink_id = ?',
      [orgId, 'webhook'],
    );
    assert(lagging, 'CapacitySinkMissing');
    const missingFrom = Math.max(Number(full.boundary_seq), Number(lagging.progress_seq) + 1);
    assert(full.journal_bytes >= budget, 'CapacityFixtureBelowBudget');
    await until(
      async () => {
        await job('maintain');
        return Number((await chain()).journal_bytes) <= budget - Math.ceil(budget / 20);
      },
      'capacity-low-water',
      Math.max(1, deadline - Date.now()),
    );
    const evicted = await chain();
    assert(
      evicted.boundary_seq > full.boundary_seq && evicted.head_seq === full.head_seq,
      'CapacityDidNotEvictPrefix',
    );
    const gaps = await local.read<{ from_seq: number; to_seq: number; count: number }>(
      "SELECT from_seq, to_seq, count FROM audit_ledger WHERE org_id = ? AND kind = 'gap' AND reason_code = 'capacity' AND superseded_by IS NULL",
      [orgId],
    );
    assert(
      gaps.length === 1 &&
        gaps[0]!.from_seq === full.boundary_seq &&
        gaps[0]!.to_seq === evicted.boundary_seq - 1 &&
        gaps[0]!.count === evicted.boundary_seq - full.boundary_seq,
      'CapacityLossNotRecorded',
    );
    assert(missingFrom < evicted.boundary_seq, 'CapacityDidNotExerciseLaggingSink');
    await suffix();
    sink.accept(true);
    await retryNow();
    await job('export-webhook');
    assert(
      sink.gaps.some(
        (gap) =>
          Number(gap['from_seq']) <= missingFrom &&
          Number(gap['to_seq']) >= evicted.boundary_seq - 1 &&
          gap['reason'] === 'capacity',
      ),
      'CapacityMarkerNotDelivered',
    );
    await project('retention-availability-write');

    stage = 'none-without-verified-export-keeps-history';
    await local.configure({
      PB_AUDIT_TRAIL: 'off',
      PB_AUDIT_WEBHOOK_URL: '',
      PB_AUDIT_WEBHOOK_HEADERS: '',
    });
    const none = await status();
    assert(none.mode === 'none' && !none.trailActive, 'NoneModeNotApplied');
    const retained = await chain();
    await job('maintain');
    assert(
      (await chain()).boundary_seq === retained.boundary_seq &&
        (await chain()).pending_mode === 'none',
      'NonePrunedWithoutVerifiedExport',
    );
    await project('retention-none-write');
    await local.moduleEvidence();
    sink.assertHealthy(orgId);
    for (const secret of [headerCanary, ...local.secrets(), local.setupToken, ...admin.secrets()])
      assert(!secret || !local.logs().includes(secret), 'SensitiveDataInOutput');
    return {
      status: 'PASS',
      reason: `${runtime}: audit retention, cutover, stale sealer and capacity gap verified.`,
    };
  } catch (error) {
    return {
      status: error instanceof LocalUnavailable ? 'NOT RUN' : 'FAIL',
      reason: `${runtime}: audit-retention:${stage} (${failureName(error)})`,
    };
  } finally {
    if (stale) {
      stale.release();
      await stale.settled.catch(() => undefined);
    }
    await broker?.close();
    await sink?.close();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
