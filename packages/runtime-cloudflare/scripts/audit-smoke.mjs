import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ulid } from '@package-broker/core/ids';
import { orgContext } from '@package-broker/core/db/port';
import { base32Decode, totpCode } from '@package-broker/core/auth/totp';
import { DEFAULT_ROLES } from '@package-broker/core/authz/permissions';
import { migrate } from '@package-broker/db-sqlite/migrations/runner';
import { bootstrapAdmin } from '@package-broker/db-sqlite/repositories/admin-bootstrap';
import { createOrganizationBootstrap } from '@package-broker/db-sqlite/repositories/organization';
import { createJobRepository } from '@package-broker/db-sqlite/repositories/job';
import { createD1Executor } from '@package-broker/runtime-cloudflare/db/d1-executor';

const PUBLIC_ORIGIN = 'https://broker.test';

async function expectStatus(label, response, expected, maximum = expected) {
  if (response.status >= expected && response.status <= maximum) return;
  const body = await response
    .clone()
    .json()
    .catch(() => null);
  const code = body?.error?.code;
  const safeCode = typeof code === 'string' && /^[a-z_]{1,80}$/.test(code) ? code : 'unknown';
  assert.fail(`${label}: unexpected status ${response.status} (error code: ${safeCode})`);
}

export async function buildAuditMode(root, mode) {
  const fixture = join(root, '.pb', 'audit-cloudflare-smoke');
  const scope = join(fixture, 'node_modules', '@package-broker');
  await mkdir(scope, { recursive: true });
  for (const name of ['plugin-audit-trail', 'plugin-audit-webhook']) {
    try {
      await symlink(join(root, 'packages', name), join(scope, name), 'dir');
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const out = join(fixture, mode);
  const config = join(fixture, `${mode}.config.ts`);
  const exported = mode === 'export' || mode === 'required-refused';
  await writeFile(
    config,
    `
import { defineConfig } from '../../packages/core/dist/config.js';
import { auditTrail } from '../../packages/plugin-audit-trail/dist/index.js';
import auditWebhook from '../../packages/plugin-audit-webhook/dist/index.js';
export default defineConfig({
platform: 'cloudflare',
plugins: ${mode === 'required-refused' ? "[auditWebhook({ id: 'archive', durableAck: true, activation: 'env' })]" : exported ? "[auditWebhook({ id: 'archive', durableAck: true })]" : mode === 'none' ? '[]' : '[auditTrail()]'},
audit: { capacity: { maxJournalBytes: 67108864 },
  ${mode === 'none' ? 'acceptNoDurableAudit: true,' : ''}
  ${mode === 'required' ? "policy: 'required', alerts: { webhookEnv: 'ALERT_URL' }," : ''}
},
platformPorts: { cloudflare: {
  blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 67108864 },
  cache: { adapter: 'cache-api', namespace: 'audit-smoke' },
  jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
  observability: { adapter: 'workers', deploymentIdEnv: 'DEPLOYMENT_ID' },
} },
});
`,
  );
  const build = spawn(
    process.execPath,
    [
      join(root, 'packages/cli/dist/bin.js'),
      'build',
      '--config',
      config,
      '--target',
      'cloudflare',
      '--out',
      out,
    ],
    { cwd: root, stdio: 'inherit' },
  );
  const [code, signal] = await once(build, 'exit');
  assert.equal(code, 0, `${mode}: pb build failed (${signal ?? code})`);
  return out;
}

export async function checkAuditModes({
  root,
  createMiniflare,
  disposeMiniflare,
  readMigrations,
  limitMs,
}) {
  for (const mode of ['trail', 'export', 'none', 'required', 'required-refused']) {
    const out = await buildAuditMode(root, mode);
    const exported = mode === 'export' || mode === 'required-refused';
    const alerts = [];
    const instance = await createMiniflare(
      join(out, 'worker.js'),
      'worker.js',
      {
        PB_PUBLIC_URL: PUBLIC_ORIGIN,
        PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT: 'false',
        PB_AUDIT_TRAIL: mode === 'required' ? 'off' : 'on',
        ...(exported && mode !== 'required-refused'
          ? {
              PB_AUDIT_WEBHOOK_URL: 'https://archive.example.test',
              PB_AUDIT_WEBHOOK_HEADERS: 'Authorization=fixture',
            }
          : {}),
        ALERT_URL: 'https://alerts.example.test',
      },
      {
        outboundService: async (request) => {
          const url = new URL(request.url);
          assert.equal(request.method, 'POST');
          if (url.hostname === 'alerts.example.test') {
            alerts.push(await request.json());
            return new Response(null, { status: 204 });
          }
          assert.equal(url.hostname, 'archive.example.test');
          assert.equal(request.headers.get('authorization'), 'fixture');
          const body = await request.json();
          if (body.probe === 'frontier') return Response.json({ frontier: null });
          assert.equal(body.deployment_id, 'smoke');
          const last = body.records.at(-1);
          return Response.json({
            acked: {
              chain_id: body.chain_id,
              epoch: body.epoch,
              seq: last.seq ?? last.to_seq ?? last.boundary_seq - 1,
              hash: last.hash ?? last.boundary_prev_hash,
            },
          });
        },
      },
    );
    try {
      const executor = createD1Executor(await instance.getD1Database('DB'));
      await migrate(executor, await readMigrations(out), { holder: 'audit-smoke' });
      const org = orgContext(ulid());
      const now = new Date();
      await createOrganizationBootstrap(executor).bootstrap({
        id: org.orgId,
        slug: 'audit',
        name: 'Audit',
        now: now.toISOString(),
      });
      if (mode === 'required-refused')
        await executor.batch([
          {
            sql: "UPDATE audit_chain SET policy = 'required' WHERE org_id = ?",
            params: [org.orgId],
          },
        ]);
      const user = ulid();
      const setupToken = randomBytes(32).toString('base64url');
      assert.equal(
        await bootstrapAdmin(executor, org, {
          email: 'audit-smoke@example.test',
          userId: user,
          setupHash: createHash('sha256').update(setupToken).digest('hex'),
          setupExpiresAt: new Date(now.getTime() + 3600000).toISOString(),
          grantId: ulid(),
          roleIds: Object.fromEntries(DEFAULT_ROLES.map(({ key }) => [key, ulid()])),
          opId: ulid(),
          now: now.toISOString(),
        }),
        'created',
      );
      const setupRequest = (path, body) =>
        instance.dispatchFetch(`${PUBLIC_ORIGIN}/_pb/auth/local/setup/${path}`, {
          method: 'POST',
          headers: { origin: PUBLIC_ORIGIN, 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(limitMs),
        });
      const started = await setupRequest('start', { token: setupToken });
      await expectStatus(`${mode}: local setup start`, started, 200);
      const totpSecret = base32Decode((await started.json()).secret);
      const finished = await setupRequest('finish', {
        token: setupToken,
        password: 'correct horse battery staple',
        code: await totpCode(totpSecret, Math.floor(Date.now() / 30_000)),
      });
      await expectStatus(`${mode}: local setup finish`, finished, 204);
      const cookies = finished.headers.getSetCookie().map((line) => line.split(';')[0]);
      assert.ok(
        cookies.some((cookie) => cookie.startsWith('__Host-pb_session=')),
        `${mode}: setup session cookie missing`,
      );
      const csrf = cookies
        .find((cookie) => cookie.startsWith('__Host-pb_csrf='))
        ?.slice('__Host-pb_csrf='.length);
      assert.ok(csrf, `${mode}: setup CSRF cookie missing`);
      const request = (path, init = {}) =>
        instance.dispatchFetch(`${PUBLIC_ORIGIN}/_pb/${path}`, {
          ...init,
          headers: {
            cookie: cookies.join('; '),
            origin: PUBLIC_ORIGIN,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
          },
          signal: AbortSignal.timeout(limitMs),
        });
      const write = await request('projects', {
        method: 'POST',
        body: JSON.stringify({ slug: 'ordinary', name: 'Ordinary' }),
      });
      if (mode === 'required-refused') {
        await expectStatus(`${mode}: ordinary write`, write, 503);
        assert.equal(write.headers.has('retry-after'), false);
        assert.equal((await write.json()).error.code, 'durable_path_required');
        continue;
      }
      await expectStatus(`${mode}: ordinary write`, write, 200, 299);
      const active = mode === 'trail' || mode === 'required';
      const me = await request('me');
      await expectStatus(`${mode}: me`, me, 200);
      assert.equal((await me.json()).features.auditTrail, active);
      const status = await request('audit/status');
      await expectStatus(`${mode}: audit/status`, status, 200);
      assert.equal((await status.json()).mode, active ? 'trail' : mode);
      await expectStatus(`${mode}: audit/head`, await request('audit/head'), active ? 200 : 404);
      await expectStatus(`${mode}: audit/health`, await request('audit/health'), 200);
      const entrypoint = await instance.getWorker();
      await entrypoint.scheduled();
      const schedules = await executor.all({
        sql: "SELECT name FROM job_schedule WHERE org_id = ? AND name LIKE 'core:audit-%'",
        params: [org.orgId],
      });
      for (const name of [
        'audit-seal',
        'audit-verify',
        'audit-maintain',
        'audit-health-observe',
        'audit-frontier',
        ...(mode === 'export' ? ['audit-export-archive'] : []),
      ])
        assert.ok(
          schedules.some((row) => row.name === `core:${name}:v1`),
          `${mode}: ${name} schedule`,
        );
      const jobs = createJobRepository(executor);
      async function run(name) {
        const queued = await jobs.enqueue(org, {
          id: ulid(),
          type: `core:${name}:v1`,
          payloadJson: '{}',
          idempotencyKey: ulid(),
          maxAttempts: 3,
          resourceKey: name.startsWith('audit-export-')
            ? `audit-export:${name.slice('audit-export-'.length)}`
            : name,
          projectId: null,
          initiatorTokenId: null,
          runAt: new Date().toISOString(),
        });
        await entrypoint.queue('pb-smoke-jobs', [
          {
            id: ulid(),
            timestamp: new Date(),
            body: { v: 1, org: org.orgId, job: queued.id },
            attempts: 1,
          },
        ]);
        assert.equal((await jobs.status(org, queued.id)).state, 'succeeded', `${mode}: ${name}`);
      }
      if (mode === 'required') {
        await executor.batch([
          {
            sql: 'UPDATE audit_pending SET created_at = ? WHERE org_id = ?',
            params: [new Date(now.getTime() - 600000).toISOString(), org.orgId],
          },
        ]);
        await run('audit-health-observe');
        assert.ok(
          alerts.some(({ code }) => code === 'audit.pending_old'),
          'required: alert webhook delivered',
        );
      }
      await run('audit-seal');
      if (mode === 'export') {
        await run('audit-export-archive');
        const [sink] = await executor.all({
          sql: "SELECT custody_seq FROM audit_sink WHERE org_id = ? AND sink_id = 'archive'",
          params: [org.orgId],
        });
        const [chain] = await executor.all({
          sql: 'SELECT head_seq FROM audit_chain WHERE org_id = ?',
          params: [org.orgId],
        });
        assert.ok(chain.head_seq >= 1, 'export: nonempty journal');
        assert.equal(
          sink.custody_seq,
          chain.head_seq,
          'export: durable acknowledgement through the head',
        );
        await run('audit-maintain');
        assert.deepEqual(
          await executor.all({
            sql: 'SELECT seq FROM audit_event WHERE org_id = ?',
            params: [org.orgId],
          }),
          [],
          'export: custody releases pruning',
        );
      }
      console.log(`smoke:cloudflare audit ${mode} passed`);
    } finally {
      await disposeMiniflare(instance);
    }
  }
}
