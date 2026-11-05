import { auditRaceBundle, overlapRace } from './audit-race-fixture.js';
import assert from 'node:assert/strict';
import { assertWireIdentity, decodeOtlp } from './audit-wire-fixture.js';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { repository, until, type LocalBroker, type Runtime } from './local.js';

export interface WireRecord extends Record<string, unknown> {
  kind: string;
  seq?: number;
  hash?: string;
  prev_hash?: string;
  marker_id?: string;
  id?: string;
  from_seq?: number;
  to_seq?: number;
}
export interface Receipt {
  sink: string;
  raw: string;
  chain: string;
  org: string;
  epoch: number;
  through: number;
  hash: string;
  records: WireRecord[];
}
export type ResponseMode = 'accept' | 'bad-ack' | 'reject' | 'partial' | 'warning' | 'retry';

export async function deliveryReceiver() {
  const receipts: Receipt[] = [];
  const saves: { job: string; sink: string; saved: boolean }[] = [];
  const modes: Record<string, ResponseMode> = { webhook: 'accept', otlp: 'accept' };
  let fault: 'none' | 'crash' | 'cas' = 'none';
  let faultCount = 0;
  let registry: 'active' | 'inactive' | 'disabled' | 'changed' = 'active';
  let invalid = false;
  let expectedOrg: string | undefined;
  const recovered = new Set<string>();
  const identities = new Map<string, { hash: string; disposed: boolean }>();
  const gates: (() => void)[] = [];
  let hold = false;
  const server = createServer((request, response) => {
    void (async () => {
      try {
        const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(raw || '{}') as Record<string, unknown>;
        const send = (value: unknown, status = 200) => {
          response.writeHead(status, { 'content-type': 'application/json' });
          response.end(JSON.stringify(value));
        };
        if (path === '/saved') {
          saves.push(body as unknown as (typeof saves)[number]);
          send({});
          return;
        }
        if (path === '/cas') {
          const action = body['sink'] === 'webhook' && fault !== 'none' ? fault : 'none';
          if (action !== 'none') {
            fault = 'none';
            faultCount++;
          }
          send({ action });
          return;
        }
        if (path === '/registry') {
          send({ state: registry });
          return;
        }
        const sink = path.slice(1);
        assert(['webhook', 'otlp'].includes(sink), 'UnexpectedDeliveryPath');
        if (body['probe'] === 'frontier') {
          assert(expectedOrg && body['org_id'] === expectedOrg, 'ForeignReceiverOrganization');
          send({ frontier: null });
          return;
        }
        let receipt: Receipt;
        if (sink === 'webhook') {
          const records = body['records'] as WireRecord[];
          assert(Array.isArray(records) && records.length > 0, 'EmptyWebhookBatch');
          const last = records.at(-1)!;
          // Marker-only ACKs name the existing frontier, not the marker's range.
          const events = records.filter((row) => row.kind === 'event' || row.kind === 'withheld');
          const prior = receipts.filter((row) => row.sink === sink).at(-1);
          receipt = {
            sink,
            raw,
            chain: String(body['chain_id']),
            org: String(body['org_id']),
            epoch: Number(body['epoch']),
            through: events.at(-1)?.seq ?? prior?.through ?? 0,
            hash: events.at(-1)?.hash ?? prior?.hash ?? '0'.repeat(64),
            records,
          };
          if (last.kind === 'tombstone') {
            receipt.through = last.seq!;
            receipt.hash = last.hash!;
          }
        } else {
          const value = decodeOtlp(body);
          receipt = {
            sink,
            raw,
            chain: value.chain_id,
            org: value.org_id,
            epoch: value.epoch,
            through: value.through_seq,
            hash: value.through_hash,
            records: value.records as WireRecord[],
          };
        }
        assertWireIdentity(
          {
            chain_id: receipt.chain,
            org_id: receipt.org,
            epoch: receipt.epoch,
            records: receipt.records,
          },
          expectedOrg,
        );
        for (const record of receipt.records) {
          if (!['event', 'tombstone'].includes(record.kind)) continue;
          const key = `${receipt.org}:${sink}:${receipt.chain}:${receipt.epoch}:${record.seq}`;
          const old = identities.get(key);
          assert(!old || old.hash === record.hash, 'ReceiverIdentityHashConflict');
          if (record.kind === 'event' && old?.disposed) recovered.add(key);
          identities.set(key, { hash: record.hash!, disposed: record.kind === 'tombstone' });
        }
        receipts.push(receipt);
        const mode = modes[sink]!;
        if (hold && sink === 'webhook') await new Promise<void>((resolve) => gates.push(resolve));
        if (mode === 'reject' && receipt.records.some((row) => row.kind === 'event')) {
          send({}, 422);
        } else if (mode === 'retry') {
          send({}, 503);
        } else if (sink === 'otlp') {
          send(
            mode === 'partial' && receipt.records.some((row) => row.kind === 'event')
              ? { partialSuccess: { rejectedLogRecords: 1 } }
              : mode === 'warning'
                ? { partialSuccess: { rejectedLogRecords: 0, errorMessage: 'fixture-warning' } }
                : {},
          );
        } else {
          send({
            acked: {
              chain_id: receipt.chain,
              epoch: receipt.epoch,
              seq: mode === 'bad-ack' ? receipt.through + 1 : receipt.through,
              hash: receipt.hash,
            },
          });
        }
      } catch {
        invalid = true;
        response.writeHead(500);
        response.end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'MissingReceiverAddress');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    receipts,
    saves,
    pin(orgId: string) {
      assert(!expectedOrg || expectedOrg === orgId, 'ReceiverOrganizationAlreadyPinned');
      expectedOrg = orgId;
    },
    mode(sink: string, mode: ResponseMode) {
      modes[sink] = mode;
    },
    fault(value: typeof fault) {
      fault = value;
    },
    faults: () => faultCount,
    recoveries: () => recovered.size,
    registry(value: typeof registry) {
      registry = value;
    },
    hold(value: boolean) {
      hold = value;
    },
    held: () => gates.length,
    release() {
      assert(gates.length > 0, 'MissingHeldDelivery');
      gates.shift()!();
    },
    healthy() {
      assert(!invalid, 'DeliveryReceiverProtocolFailure');
    },
    async close() {
      for (const release of gates.splice(0)) release();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

export function deliveryEntry(bundle: string, runtime: Runtime, receiver: string): string {
  const origin = runtime === 'node' ? receiver : 'https://audit.fixture.test';
  return `
const fixtureRequest = (path, body) => fetch(${JSON.stringify(origin)} + path, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
});
globalThis.__pbAuditFixture = {
  transport(options) {
    const env = options.env;
    return { ...options,
      env: name => name === 'PB_AUDIT_WEBHOOK_URL' ? 'https://audit.fixture.test/webhook'
        : name === 'PB_AUDIT_OTLP_ENDPOINT' ? 'https://audit.fixture.test/otlp'
        : ['PB_AUDIT_WEBHOOK_HEADERS', 'PB_AUDIT_OTLP_HEADERS'].includes(name) ? 'X-Audit-Fixture=delivery' : env(name),
      fetchImpl: (_url, init) => fixtureRequest('/' + options.id, JSON.parse(init.body))
    };
  },
  async registry(configured) {
    const { state } = await fixtureRequest('/registry', {}).then(r => r.json());
    return configured.filter(sink => state !== 'disabled' || sink.id !== 'webhook').map(sink =>
      sink.id !== 'webhook' ? sink : { ...sink, destination: state === 'inactive' ? null
        : state === 'changed' ? { ...sink.destination, receiverFingerprint: 'f'.repeat(64) } : sink.destination });
  },
  async beforeSave(sink) { return (await fixtureRequest('/cas', { sink }).then(r => r.json())).action; },
  async afterSave(job, sink, saved) { await fixtureRequest('/saved', { job, sink, saved }); }
};
${bundle ? auditRaceBundle(bundle, '/__fixture/overlapping-leases', overlapRace) : ''}`;
}

export async function deliveryBuild(runtime: Runtime, hooks = true): Promise<string> {
  await mkdir(join(repository, '.pb'), { recursive: true });
  const output = await mkdtemp(
    join(repository, '.pb', `audit-${hooks ? 'delivery' : 'restore'}-${runtime}-`),
  );
  await promisify(execFile)(
    process.execPath,
    [
      join(repository, 'packages/cli/dist/bin.js'),
      'build',
      '--config',
      'fixtures/audit-delivery.config.ts',
      '--target',
      runtime,
      '--out',
      output,
    ],
    { cwd: repository, env: { ...process.env, PB_E2E_AUDIT_FIXTURE: hooks ? '1' : '0' } },
  );
  const bundle = await readFile(
    join(output, runtime === 'node' ? 'server.js' : 'worker.js'),
    'utf8',
  );
  assert(bundle.includes('__pbAuditFixture') === hooks, 'DeliveryFixtureHookMismatch');
  return output;
}

/* eslint-disable no-restricted-syntax -- Test infrastructure pins all queue and fault writes to the bootstrapped organization. */
export async function deliveryInfrastructure(
  broker: Pick<LocalBroker, 'databaseControl' | 'tick' | 'read'>,
  orgId: string,
) {
  const { path: database, orgId: pinnedOrgId, sql } = broker.databaseControl;
  assert(orgId === pinnedOrgId, 'ForeignDeliveryOrganization');
  const run = (statement: string, params: (string | number)[]) => sql.run(statement, params);
  await broker.tick();
  await run("UPDATE job_schedule SET next_run_at = '2099-01-01T00:00:00.000Z' WHERE org_id = ?", [
    orgId,
  ]);
  await until(
    async () => {
      await broker.tick();
      const [row] = await broker.read<{ count: number }>(
        "SELECT count(*) AS count FROM job WHERE org_id = ? AND type LIKE 'core:audit-%' AND state IN ('queued', 'running')",
        [orgId],
      );
      return row?.count === 0;
    },
    'delivery-startup-jobs',
    60_000,
  );
  return {
    async isolateRestorePruneGuard() {
      // Detection already proved the normal sink block. Remove that independent gate
      // without changing the real receiver-backed progress or custody evidence.
      await run(
        "UPDATE audit_sink SET state = 'active' WHERE org_id = ? AND state = 'blocked' AND blocked_reason = 'fork'",
        [orgId],
      );
    },
    async enqueue(kind: 'seal' | 'verify' | 'maintain' | 'export-webhook' | 'export-otlp') {
      const id = '01' + randomBytes(12).toString('hex').toUpperCase();
      const resource = kind.startsWith('export-')
        ? `audit-export:${kind.slice(7)}`
        : `audit-${kind}`;
      await run('INSERT INTO job (id, org_id, type, resource_key) VALUES (?, ?, ?, ?)', [
        id,
        orgId,
        `core:audit-${kind}:v1`,
        resource,
      ]);
      return id;
    },
    async settled(id: string) {
      await until(
        async () => {
          await broker.tick();
          const [job] = await broker.read<{ state: string }>(
            'SELECT state FROM job WHERE org_id = ? AND id = ?',
            [orgId, id],
          );
          assert(job && job.state !== 'dead', 'DeliveryJobFailed');
          return job.state === 'succeeded';
        },
        'delivery-job',
        90_000,
      );
    },
    async due(sink: string) {
      assert(['webhook', 'otlp'].includes(sink), 'InvalidFixtureSink');
      await run('UPDATE audit_sink SET next_attempt_at = NULL WHERE org_id = ? AND sink_id = ?', [
        orgId,
        sink,
      ]);
    },
    async admin(operation: 'replay' | 'retire' | 'rebind', argument: string) {
      const [actor] = await broker.read<{ id: string }>(
        'SELECT id FROM user_account WHERE org_id = ? LIMIT 1',
        [orgId],
      );
      const [sink] = await broker.read<{ generation: number }>(
        'SELECT generation FROM audit_sink WHERE org_id = ? AND sink_id = ?',
        [orgId, 'webhook'],
      );
      assert(actor && sink, 'MissingDeliveryAdminContext');
      await promisify(execFile)(
        process.execPath,
        [
          join(repository, 'packages/cli/dist/bin.js'),
          'audit',
          'sink',
          operation,
          'webhook',
          '--sqlite',
          database,
          '--generation',
          String(sink.generation),
          '--actor-type',
          'user',
          '--actor-id',
          actor.id,
          operation === 'retire' ? '--confirm' : '--from',
          argument,
        ],
        { cwd: repository, timeout: 20_000 },
      ).catch(() => {
        throw new Error('DeliveryAdminCommandFailed');
      });
    },
  };
}
/* eslint-enable no-restricted-syntax */
