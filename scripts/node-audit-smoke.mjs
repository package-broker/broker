import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export async function checkNodeAuditModes({ root, startBundle, stopChild, mintSession }) {
  const alerts = createServer((request, response) => {
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
  plugins: ${mode === 'export' ? "[auditWebhook({ id: 'archive' })]" : '[auditTrail()]'},
  audit: {
    capacity: { maxJournalBytes: 67108864 },
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
      if (mode === 'export') {
        assert.notEqual(built.status, 0);
        const { collectRegistrations } = await import(
          pathToFileURL(join(root, 'packages/core/dist/kernel/registry.js')).href
        );
        const { default: auditWebhook } = await import(
          pathToFileURL(join(root, 'packages/plugin-audit-webhook/dist/index.js')).href
        );
        assert.throws(
          () => collectRegistrations([auditWebhook({ id: 'archive' })]),
          (error) =>
            Array.isArray(error.problems) &&
            error.problems.some((problem) =>
              /audit plugins are not available in this build/.test(problem),
            ),
        );
        assert.match(built.stderr + built.stdout, /invalid broker config: plugins/);
        console.log('smoke:node export-only is gated (sink rollout unavailable)');
        continue;
      }
      assert.equal(built.status, 0, built.stderr);
      const { base, env } = await startBundle(out, {
        PB_AUDIT_TRAIL: mode === 'trail' ? 'on' : 'off',
        PB_AUDIT_POLICY: mode === 'required' ? 'required' : 'availability',
        AUDIT_ALERT_ENDPOINT: alertUrl,
        PB_AUDIT_ACCEPT_NO_DURABLE_AUDIT: mode === 'none' ? 'true' : 'false',
      });
      try {
        const cookie = await mintSession(base, env.PB_SQLITE_PATH);
        const get = (path) =>
          fetch(`${base}/_pb/${path}`, { headers: { cookie }, signal: AbortSignal.timeout(2000) });
        const me = await get('me');
        assert.equal(me.status, 200);
        assert.equal((await me.json()).features.auditTrail, mode !== 'none');
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
        assert.equal(body.mode, mode === 'none' ? 'none' : 'trail');
        assert.equal(body.policy, mode === 'required' ? 'required' : 'availability');
        assert.equal((await get('audit/head')).status, mode === 'none' ? 404 : 200);
        assert.equal((await get('audit/health')).status, 200);
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
