import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';

export async function checkNodeAuditModes({ root, startBundle, stopChild, mintSession }) {
  const batches = [];
  let receiverError;
  const alerts = createServer((request, response) => {
    if (request.url === '/archive') {
      void (async () => {
        assert.equal(request.method, 'POST');
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        response.setHeader('content-type', 'application/json');
        if (body.probe === 'frontier') {
          response.end(JSON.stringify({ frontier: null }));
          return;
        }
        assert.equal(body.deployment_id, 'smoke');
        assert.ok(body.records.length > 0, 'export: nonempty batch');
        batches.push(body);
        const last = body.records.at(-1);
        response.end(
          JSON.stringify({
            acked: {
              chain_id: body.chain_id,
              epoch: body.epoch,
              seq: last.seq ?? last.to_seq ?? last.boundary_seq - 1,
              hash: last.hash ?? last.boundary_prev_hash,
            },
          }),
        );
      })().catch((error) => {
        receiverError = error;
        response.writeHead(500);
        response.end();
      });
      return;
    }
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
  });
  await new Promise((resolve, reject) => {
    alerts.once('error', reject);
    alerts.listen(0, '127.0.0.1', resolve);
  });
  const alertUrl = `http://127.0.0.1:${alerts.address().port}/v1/logs`;
  const temporary = await mkdtemp(join(tmpdir(), 'pb-node-audit-smoke-'));
  const config = join(temporary, 'broker.config.ts');
  try {
    const scope = join(temporary, 'node_modules/@package-broker');
    await mkdir(scope, { recursive: true });
    for (const name of ['plugin-audit-trail', 'plugin-audit-webhook'])
      await symlink(join(root, 'packages', name), join(scope, name), 'dir');
    for (const mode of ['trail', 'none', 'required', 'export']) {
      const out = join(root, '.pb', `audit-${mode}-node`);
      await writeFile(
        config,
        `
import { auditTrail } from ${JSON.stringify(join(root, 'packages/plugin-audit-trail/dist/index.js'))};
import auditWebhook from ${JSON.stringify(join(root, 'packages/plugin-audit-webhook/dist/index.js'))};
export default {
  platform: 'node',
  plugins: ${mode === 'export' ? "[auditWebhook({ id: 'archive', durableAck: true })]" : '[auditTrail()]'},
  audit: {
    capacity: { maxJournalBytes: 67108864 },
    ${mode === 'export' ? "egress: { allowPrivate: ['archive'] }," : ''}
    ${mode === 'none' ? 'acceptNoDurableAudit: true,' : ''}
    ${mode === 'required' ? "policy: 'required'," : ''}
  },
  platformPorts: { node: {
    blob: { adapter: 'filesystem', rootEnv: 'PB_BLOB_ROOT', maxBytes: 67108864 },
    cache: { adapter: 'lru', maxBytes: 33554432 },
    jobs: { adapter: 'database', maxRunning: 2 },
    observability: { adapter: 'stdio', deploymentIdEnv: 'DEPLOYMENT_ID', endpointEnv: 'AUDIT_ALERT_ENDPOINT' },
  } },
};
`,
      );
      const built = spawnSync(
        process.execPath,
        [
          join(root, 'packages/cli/dist/bin.js'),
          'build',
          '--config',
          config,
          '--target',
          'node',
          '--out',
          out,
        ],
        { cwd: root, encoding: 'utf8' },
      );
      assert.equal(built.status, 0, built.stderr);
      const { base, env } = await startBundle(out, {
        PB_AUDIT_TRAIL: mode === 'trail' ? 'on' : 'off',
        PB_AUDIT_POLICY: mode === 'required' ? 'required' : 'availability',
        AUDIT_ALERT_ENDPOINT: alertUrl,
        ...(mode === 'export'
          ? { PB_AUDIT_WEBHOOK_URL: new URL('/archive', alertUrl).href, DEPLOYMENT_ID: 'smoke' }
          : {}),
        PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT: mode === 'none' ? 'true' : 'false',
      });
      try {
        const cookie = await mintSession(base, env.PB_SQLITE_PATH);
        const get = (path) =>
          fetch(`${base}/_pb/${path}`, { headers: { cookie }, signal: AbortSignal.timeout(2000) });
        const me = await get('me');
        assert.equal(me.status, 200);
        assert.equal(
          (await me.json()).features.auditTrail,
          mode === 'trail' || mode === 'required',
        );
        const csrf = cookie
          .split('; ')
          .find((entry) => entry.startsWith('__Host-pb_csrf='))
          ?.split('=')[1];
        assert.ok(csrf);
        const write = await fetch(`${base}/_pb/projects`, {
          method: 'POST',
          headers: {
            cookie,
            origin: base,
            'x-csrf-token': csrf,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ slug: 'audit-smoke', name: 'Audit smoke' }),
          signal: AbortSignal.timeout(2000),
        });
        assert.equal(write.status, 201, `ordinary write must succeed in ${mode} mode`);
        assert.equal((await write.json()).slug, 'audit-smoke');
        const status = await get('audit/status');
        assert.equal(status.status, 200);
        const body = await status.json();
        assert.equal(body.mode, mode === 'export' ? 'export' : mode === 'none' ? 'none' : 'trail');
        assert.equal(body.policy, mode === 'required' ? 'required' : 'availability');
        assert.equal(
          (await get('audit/head')).status,
          mode === 'none' || mode === 'export' ? 404 : 200,
        );
        assert.equal((await get('audit/health')).status, 200);
        if (mode === 'export') {
          const db = new DatabaseSync(env.PB_SQLITE_PATH);
          try {
            db.exec('PRAGMA busy_timeout = 5000');
            const orgId = db.prepare('SELECT id FROM organization WHERE slug = ?').get('smoke').id;
            const run = async (name, resourceKey = name) => {
              const id = randomUUID();
              db.prepare(
                'INSERT INTO job (id, org_id, type, payload_json, idempotency_key, resource_key) VALUES (?, ?, ?, ?, ?, ?)',
              ).run(id, orgId, `core:${name}:v1`, '{}', id, resourceKey);
              const deadline = Date.now() + 15000;
              while (Date.now() < deadline) {
                if (receiverError) throw receiverError;
                const job = db
                  .prepare('SELECT state FROM job WHERE org_id = ? AND id = ?')
                  .get(orgId, id);
                assert.notEqual(job?.state, 'dead', `export: ${name} must succeed`);
                if (job?.state === 'succeeded') return;
                await delay(200);
              }
              assert.fail(`export: timed out waiting for ${name}`);
            };
            await run('audit-seal');
            await run('audit-export-archive', 'audit-export:archive');
            assert.ok(batches.length > 0, 'export: listener received a batch');
            assert.ok(
              batches.every((batch) => batch.org_id === orgId),
              'export: batches belong to the smoke organization',
            );
            const chain = db
              .prepare('SELECT head_seq FROM audit_chain WHERE org_id = ?')
              .get(orgId);
            const sink = db
              .prepare('SELECT custody_seq FROM audit_sink WHERE org_id = ? AND sink_id = ?')
              .get(orgId, 'archive');
            assert.ok(chain.head_seq >= 1, 'export: nonempty journal');
            assert.equal(
              sink.custody_seq,
              chain.head_seq,
              'export: durable acknowledgement through the head',
            );
          } finally {
            db.close();
          }
        }
        console.log(`smoke:node audit ${mode} passed over HTTP`);
      } finally {
        await stopChild();
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
    alerts.closeAllConnections();
    await new Promise((resolve) => alerts.close(resolve));
  }
}
