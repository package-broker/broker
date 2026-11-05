/* eslint-disable no-restricted-syntax -- Organization-scoped infrastructure fixtures and observations, never application writes. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { FIXTURE_PASSWORD, requireStatus } from './evidence.js';
import { repository, startLocal, until } from './local.js';
import type { LocalBroker, Runtime } from './local.js';

// A public literal passes production URL validation; both launchers route it exclusively
// to the loopback receiver. No DNS or external connection is made.
const receiverOrigin = 'https://93.184.216.34';
const credential = 'audit-required-fixture';
const budget = 64 * 1024 * 1024;

function replaceOnce(bundle: string, target: string, value: string): string {
  assert.equal(bundle.split(target).length, 2, 'RequiredFixturePatchTargetChanged');
  return bundle.replace(target, () => value);
}

export async function postponeRequiredSchedules(
  broker: Pick<LocalBroker, 'tick' | 'read'>,
  orgId: string,
  postpone: () => void,
  drain = true,
) {
  // Worker schedules do not exist until the first scheduled invocation.
  await broker.tick();
  postpone();
  if (drain)
    await until(
      async () => {
        await broker.tick();
        const [row] = await broker.read<{ count: number }>(
          "SELECT count(*) AS count FROM job WHERE org_id = ? AND type LIKE 'core:audit-%' AND state IN ('queued', 'running')",
          [orgId],
        );
        return row?.count === 0;
      },
      'required-startup-jobs',
      60_000,
    );
  const rows = await broker.read<{ name: string; next_run_at: string }>(
    "SELECT name, next_run_at FROM job_schedule WHERE org_id = ? AND name LIKE 'core:audit-%'",
    [orgId],
  );
  assert(
    ['core:audit-seal:v1', 'core:audit-maintain:v1'].every((name) =>
      rows.some((row) => row.name === name),
    ) && rows.every((row) => row.next_run_at === '2099-01-01T00:00:00.000Z'),
    'RequiredSchedulesNotPostponed',
  );
  return rows;
}

export function requiredBundle(
  bundle: string,
  env: Record<string, string>,
  noPath: boolean,
  marker: string,
): string {
  bundle = replaceOnce(
    bundle,
    'audit: { policy: "availability" }',
    `audit: ${JSON.stringify({
      policy: noPath ? 'availability' : 'required',
      capacity: { maxJournalBytes: budget },
      alerts: { webhookEnv: 'AUD40D_ALERT_URL' },
    })}`,
  );
  bundle = replaceOnce(
    bundle,
    'auditWebhook({ id: "webhook", activation: "env" })',
    `auditWebhook({ id: "webhook", activation: "env", durableAck: ${!noPath} })`,
  );
  if (noPath)
    bundle = replaceOnce(
      bundle,
      'auditTrail({ toggleEnv: "PB_AUDIT_TRAIL" })',
      '({ ...auditTrail({ toggleEnv: "PB_AUDIT_TRAIL" }), binds: [], auditTrail: undefined })',
    );
  // The Workers launcher intentionally has no arbitrary env binding option.
  if (bundle.includes('async function applicationFor(env) {'))
    bundle = replaceOnce(
      bundle,
      'async function applicationFor(env) {',
      `async function applicationFor(env) { Object.assign(env, ${JSON.stringify(env)});`,
    );
  return `${bundle}\n/* ${marker} */\n`;
}

async function descendants(directory: string): Promise<string[]> {
  const paths: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await descendants(path)));
    else paths.push(path);
  }
  return paths;
}

export async function requiredControlEvents(
  read: <T extends Record<string, unknown>>(
    sql: string,
    params?: (string | number)[],
  ) => Promise<T[]>,
) {
  return read<{
    action: string;
    operation: string | null;
    alert_code: string | null;
    revision: number | null;
    sink_id: string | null;
  }>(`SELECT action,
    json_extract(payload_json, '$.changes.operation.new') AS operation,
    json_extract(payload_json, '$.changes.alert_code.new') AS alert_code,
    json_extract(payload_json, '$.changes.revision.new') AS revision,
    json_type(payload_json, '$.changes.sink_id') AS sink_id
    FROM audit_pending WHERE org_id = ?`);
}

export async function requiredFixture(runtime: Runtime, noPath: boolean | 'none' = false) {
  const batches: Record<string, unknown>[] = [];
  const alerts: string[] = [];
  let rejecting = false;
  let invalid = false;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      try {
        assert.equal(incoming.method, 'POST', 'UnexpectedAuditMethod');
        assert(!incoming.headers.cookie, 'CookieReachedAuditReceiver');
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        if (incoming.url === '/alerts') {
          assert.equal(typeof body.code, 'string', 'InvalidAuditAlert');
          alerts.push(body.code as string);
          outgoing.writeHead(204).end();
          return;
        }
        assert.equal(incoming.url, '/audit', 'UnexpectedAuditDestination');
        assert.equal(incoming.headers.authorization, credential, 'MissingAuditCredential');
        if (body.probe === 'frontier') {
          outgoing
            .writeHead(200, { 'content-type': 'application/json' })
            .end(JSON.stringify({ frontier: null }));
          return;
        }
        assert(Array.isArray(body.records) && body.records.length > 0, 'EmptyAuditBatch');
        batches.push(body);
        if (rejecting) {
          outgoing.writeHead(422).end();
          return;
        }
        const last = body.records.at(-1) as { seq?: number; hash?: string; through_seq?: number };
        outgoing.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            acked: {
              chain_id: body.chain_id,
              epoch: body.epoch,
              seq: last.seq ?? last.through_seq,
              hash: last.hash,
            },
          }),
        );
      } catch {
        invalid = true;
        outgoing.writeHead(500).end();
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'MissingAuditReceiver');
  const origin = `http://127.0.0.1:${address.port}`;
  const closeReceiver = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  };
  const marker = `AUD40d-${randomUUID()}`;
  const env = {
    PB_AUDIT_TRAIL: 'off',
    AUD40D_ALERT_URL: `${receiverOrigin}/alerts`,
    ...(noPath === 'none'
      ? {}
      : {
          PB_AUDIT_WEBHOOK_URL: `${receiverOrigin}/audit`,
          PB_AUDIT_WEBHOOK_HEADERS: `Authorization=${credential}`,
        }),
  };
  let broker: Awaited<ReturnType<typeof startLocal>> | undefined;
  try {
    broker = await startLocal(runtime, origin, {
      reader: true,
      nodeEnv: env,
      patchBundle: (bundle) => requiredBundle(bundle, env, Boolean(noPath), marker),
      outboundDestination(url) {
        const target = new URL(url);
        assert.equal(target.origin, receiverOrigin, 'UnexpectedAuditEgress');
        return origin + target.pathname;
      },
      nodeTransport: `https.request = (options) => {
        if (options.host !== '93.184.216.34') throw new Error('UnexpectedAuditEgress');
        return http.request({ hostname: '127.0.0.1', port: ${address.port},
          path: options.path, method: options.method, headers: options.headers, agent: false });
      };`,
    });
    // Find only this launcher's marked copy; parallel e2e tests may create other directories.
    const copies: string[] = [];
    for (const name of await readdir(join(repository, '.pb'))) {
      if (!name.startsWith('e2e-')) continue;
      const directory = join(repository, '.pb', name);
      const script = join(directory, 'bundle', runtime === 'node' ? 'server.js' : 'worker.js');
      const text = await readFile(script, 'utf8').catch(() => '');
      if (text.includes(`/* ${marker} */`)) copies.push(directory);
    }
    assert.equal(copies.length, 1, 'RequiredFixtureCopyMissing');
    const databases =
      runtime === 'node'
        ? [join(copies[0]!, 'db.sqlite')]
        : (await descendants(join(copies[0]!, 'state', 'd1'))).filter(
            (path) => path.endsWith('.sqlite') && !path.endsWith('/metadata.sqlite'),
          );
    assert.equal(databases.length, 1, 'RequiredFixtureDatabaseMissing');
    const database = databases[0]!;
    const db = new DatabaseSync(database, { timeout: 5000 });
    let orgId: string;
    try {
      const orgs = db.prepare('SELECT id FROM organization').all() as { id: string }[];
      assert.equal(orgs.length, 1, 'RequiredFixtureOrganizationMissing');
      orgId = orgs[0]!.id;
    } finally {
      db.close();
    }
    const local = broker;
    const run = (sql: string, params: (string | number)[] = [orgId]) => {
      assert(/\borg_id\s*=\s*\?/.test(sql), 'UnscopedRequiredFixtureWrite');
      assert.equal(params[0], orgId, 'ForeignRequiredFixtureWrite');
      const db = new DatabaseSync(database, { timeout: 5000 });
      try {
        db.prepare(sql).run(...params);
      } finally {
        db.close();
      }
    };
    const postponed = await postponeRequiredSchedules(
      local,
      orgId,
      () => {
        run("UPDATE job_schedule SET next_run_at = '2099-01-01T00:00:00.000Z' WHERE org_id = ?");
      },
      noPath !== 'none',
    );
    const read = <T extends Record<string, unknown>>(
      sql: string,
      params: (string | number)[] = [],
    ) => local.read<T>(sql, [orgId, ...params]);
    const job = async (
      kind: 'seal' | 'verify' | 'maintain' | 'export-webhook' | 'health-observe',
    ) => {
      const id = '01' + randomBytes(12).toString('hex').toUpperCase();
      const db = new DatabaseSync(database, { timeout: 5000 });
      try {
        // Same infrastructure dispatch as audit.spec.ts; only the job types differ.
        db.prepare(
          'INSERT INTO job (org_id, id, type, resource_key) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM audit_chain WHERE org_id = ?)',
        ).run(
          orgId,
          id,
          `core:audit-${kind}:v1`,
          kind === 'export-webhook' ? 'audit-export:webhook' : `audit-${kind}`,
          orgId,
        );
      } finally {
        db.close();
      }
      await until(
        async () => {
          await local.tick();
          const [row] = await local.read<{ state: string }>(
            'SELECT state FROM job WHERE org_id = ? AND id = ?',
            [orgId, id],
          );
          assert(row && row.state !== 'dead', 'RequiredAuditJobFailed');
          return row.state === 'succeeded';
        },
        `required-audit-${kind}`,
        60_000,
      );
    };
    const control = async (args: string[], actorId: string, applied = true) => {
      const [sink] = await read<{ generation: number }>(
        'SELECT generation FROM audit_sink WHERE org_id = ? ORDER BY generation DESC LIMIT 1',
      );
      assert(sink, 'MissingControlGeneration');
      const result = await promisify(execFile)(
        process.execPath,
        [
          join(repository, 'packages/cli/dist/bin.js'),
          'audit',
          ...args,
          '--sqlite',
          database,
          '--generation',
          String(sink.generation),
          '--actor-type',
          'user',
          '--actor-id',
          actorId,
        ],
        { cwd: repository, timeout: 10_000 },
      ).then(
        () => true,
        () => false,
      );
      assert.equal(result, applied, 'RequiredAuditControlOutcome');
    };
    return {
      broker: local,
      orgId,
      read,
      job,
      control,
      batches,
      alerts,
      reject: () => {
        rejecting = true;
      },
      async capacity() {
        const rows = await read<{ name: string; next_run_at: string }>(
          "SELECT name, next_run_at FROM job_schedule WHERE org_id = ? AND name LIKE 'core:audit-%'",
        );
        assert(
          rows.length === postponed.length &&
            rows.every((row) => row.next_run_at === '2099-01-01T00:00:00.000Z'),
          'RequiredSchedulesNotPostponed',
        );
        run("UPDATE audit_chain SET capacity_state = 'refusing' WHERE org_id = ?");
      },
      noDurablePath: () =>
        run(
          `UPDATE audit_chain SET policy = 'required', mode = '${noPath === 'none' ? 'none' : 'export'}' WHERE org_id = ?`,
        ),
      async close(secrets: readonly string[] = []) {
        try {
          assert(!invalid, 'AuditReceiverProtocolFailed');
          assert(
            batches.every((batch) => batch.org_id === orgId),
            'ForeignRequiredAuditBatch',
          );
          const output = local.logs() + JSON.stringify({ batches, alerts });
          for (const secret of [
            ...local.secrets(),
            ...secrets,
            credential,
            FIXTURE_PASSWORD,
            'admin@example.test',
            'reader@example.test',
          ])
            assert(!secret || !output.includes(secret), 'SensitiveRequiredAuditOutput');
        } finally {
          await local.close();
          await closeReceiver();
        }
      },
    };
  } catch (error) {
    await broker?.close();
    await closeReceiver();
    throw error;
  }
}

function code(secret: string, step: number): string {
  let bits = '';
  for (const character of secret.replace(/=+$/, ''))
    bits += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(character).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hash = createHmac('sha1', key).update(counter).digest();
  return String((hash.readUInt32BE(hash[hash.length - 1]! & 15) & 0x7fffffff) % 1_000_000).padStart(
    6,
    '0',
  );
}

export async function requiredSession(
  broker: Awaited<ReturnType<typeof startLocal>>,
  reader = false,
  capturedSecrets: string[] = [],
) {
  let cookie = '';
  let csrf = '';
  let secret = '';
  let lastStep = -1;
  const request = async (path: string, body?: unknown, method = 'POST') => {
    const response = await fetch(broker.origin + path, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
      headers: {
        'content-type': 'application/json',
        origin: broker.publicOrigin,
        cookie,
        'x-csrf-token': csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) {
      cookie = cookies.map((line) => line.split(';')[0]).join('; ');
      csrf = /(?:^|; )__Host-pb_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
      capturedSecrets.push(
        cookie,
        csrf,
        ...cookies.map((line) => line.split(';')[0]!.split('=').slice(1).join('=')),
      );
    }
    return response;
  };
  const nextCode = async () => {
    await until(
      async () => lastStep < Math.floor(Date.now() / 30_000) + 1,
      'required-totp-window',
      35_000,
    );
    lastStep = Math.max(lastStep + 1, Math.floor(Date.now() / 30_000) - 1);
    const value = code(secret, lastStep);
    capturedSecrets.push(value);
    return value;
  };
  const token = reader ? broker.readerSetupToken : broker.setupToken;
  const started = requireStatus(await request('/_pb/auth/local/setup/start', { token }), 200);
  secret = ((await started.json()) as { secret: string }).secret;
  capturedSecrets.push(secret);
  requireStatus(
    await request('/_pb/auth/local/setup/finish', {
      token,
      password: FIXTURE_PASSWORD,
      code: await nextCode(),
    }),
    204,
  );
  const login = async () =>
    requireStatus(
      await request('/_pb/auth/local/login', {
        email: reader ? 'reader@example.test' : 'admin@example.test',
        password: FIXTURE_PASSWORD,
        code: await nextCode(),
      }),
      204,
    );
  const reauth = async () =>
    requireStatus(
      await request('/_pb/auth/local/reauth', {
        password: FIXTURE_PASSWORD,
        code: await nextCode(),
      }),
      204,
    );
  await login();
  await reauth();
  return { request, login, reauth, secrets: () => [secret, cookie, csrf, FIXTURE_PASSWORD] };
}
