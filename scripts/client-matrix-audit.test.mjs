import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { orgContext } from '../packages/core/dist/db/port.js';
import { ulid } from '../packages/core/dist/ids.js';
import { createJobRepository } from '../packages/db-sqlite/dist/repositories/job.js';
import { openMigratedDatabase } from '../packages/db-sqlite/dist/testing/migrated-database.js';
import { createJobLoop } from '../packages/runtime-node/dist/jobs/loop.js';
import { createMatrixNodeBroker, seed } from './client-matrix-runtime.mjs';
import { fixtureReply } from './client-matrix.mjs';

for (const joined of [false, true]) {
  test(`Node matrix composition retains audit while admitting hosted setup and jobs (joined=${joined})`, async () => {
    const directory = await mkdtemp(join(await realpath(tmpdir()), 'matrix-audit-'));
    const database = await openMigratedDatabase();
    let broker;
    let loop;
    try {
      const origin = 'https://broker.test';
      const seeded = await seed(database.executor, { joined });
      const outbound = [];
      const audits = [];
      broker = await createMatrixNodeBroker(
        database.executor,
        directory,
        origin,
        async (request) => {
          outbound.push(request.url);
          return fixtureReply(request, audits);
        },
        { joined },
      );
      const kernel = await broker.ready();
      const call = (method, path, body, headers = {}) =>
        kernel.fetch(
          new Request(origin + path, {
            method,
            headers: { ...seeded.browserHeaders(origin), ...headers },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const created = await call('POST', '/_pb/sources', {
        name: 'Matrix audit regression',
        ecosystem: 'npm',
        type: 'hosted',
        requirePublishApproval: false,
        defaultVisibleToNewProjects: true,
      });
      assert.equal(created.status, 201);
      const { id } = await created.json();
      const listed = await call('GET', '/_pb/sources');
      assert.equal(listed.status, 200);
      const source = (await listed.json()).items.find((item) => item.id === id);
      assert.ok(source);
      assert.equal(
        (
          await call(
            'PATCH',
            `/_pb/sources/${id}`,
            { requirePublishApproval: true },
            {
              'If-Match': `"r${source.revision}"`,
            },
          )
        ).status,
        204,
      );
      assert.equal(
        (await call('POST', `/_pb/sources/${id}/names`, { pattern: 'matrix-publish-active' }))
          .status,
        201,
      );
      assert.equal((await call('POST', `/_pb/sources/${id}/enable`)).status, 204);
      assert.equal(
        (await call('PUT', `/_pb/projects/alpha/sources/${id}/attachment`, {})).status,
        204,
      );
      const me = await call('GET', '/_pb/me');
      assert.equal(me.status, 200);
      assert.equal((await me.json()).features.auditTrail, true);
      assert.equal((await kernel.fetch(new Request(origin + '/alpha/npm/widget'))).status, 401);
      const auditPath = '/alpha/npm/-/npm/v1/security/advisories/bulk';
      assert.equal((await call('GET', '/alpha/npm/matrix-public')).status, 200);
      assert.equal(
        (
          await call('POST', auditPath, {
            'matrix-public': ['1.0.0'],
            '@matrix/hidden': ['1.0.0'],
          })
        ).status,
        200,
      );
      assert.deepEqual(audits, [{ 'matrix-public': ['1.0.0'] }]);
      await database.executor.batch([
        {
          sql: "DELETE FROM project_source WHERE org_id = ? AND source_id IN (SELECT id FROM source WHERE org_id = ? AND type = 'npmjs_proxy')",
          params: [seeded.orgId, seeded.orgId],
        },
      ]);
      assert.equal((await call('POST', auditPath, {})).status, 501);
      assert.ok(
        (
          await database.executor.all({
            sql: "SELECT id FROM audit_pending WHERE org_id = ? AND action = 'source.create' AND target_id = ?",
            params: [seeded.orgId, id],
          })
        ).length > 0,
      );
      const org = orgContext(seeded.orgId);
      const jobs = createJobRepository(database.executor);
      const queued = await jobs.enqueue(org, {
        id: ulid(),
        type: 'core:package-access-expire:v1',
        payloadJson: '{}',
        idempotencyKey: ulid(),
        resourceKey: null,
        runAt: null,
        maxAttempts: 1,
        projectId: null,
        initiatorTokenId: null,
      });
      loop = createJobLoop({
        executor: database.executor,
        jobs: kernel.registration.jobs,
        scope: kernel.jobScope,
        observability: { log() {}, counter() {}, histogram() {} },
      });
      loop.start();
      const deadline = Date.now() + 5000;
      while ((await jobs.status(org, queued.id)).state !== 'succeeded' && Date.now() < deadline)
        await delay(20);
      assert.equal((await jobs.status(org, queued.id)).state, 'succeeded');
      assert.deepEqual(outbound, [
        'https://registry.npmjs.org/matrix-publish-active',
        'https://registry.npmjs.org/matrix-public',
        'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk',
      ]);
    } finally {
      await loop?.stop();
      await broker?.close();
      await database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
