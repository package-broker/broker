import { afterEach, beforeEach, expect, it } from 'vitest';
import { auditEvent } from '@package-broker/core/audit/actions';
import { seedEndpoint } from '../contract/notification-fixture.js';
import {
  seedProject,
  seedSource,
  seedPackage,
  seedVersion,
} from '../testing/mutation-table/fixtures.js';
import { createPublishWriteGuard } from './catalogue-publish-guard.js';
import { createUnpublishStore } from './npm-unpublish.js';
import { createDeprecationStore } from './npm-deprecate.js';
import { createVisibilityStore } from './catalogue-writer.js';
import { systemMutationFence } from '@package-broker/core/authz/fence';
import { ulid } from '@package-broker/core/ids';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { accessFixture } from '../contract/package-access-requests-fixture.js';
import { ANCHORS } from '../testing/mutation-table/fixtures.js';
import {
  RULE_ID,
  RULE_OPTIONS,
  seedDiscoveryRule,
  ruleAudit,
} from '../testing/discovery-rules-fixture.js';
import { createDiscoveryRuleRepository } from './discovery-rules.js';
import { createTrustedPublisherStore } from './trusted-publishers.js';
import { createPackageDetailRepository } from './package-detail.js';
import { createRoleRepository } from './role.js';
import { createOidcRepository } from './oidc.js';
import { matchesRef } from '@package-broker/core/registry/npm/oidc/publisher';

let database: MigratedDatabase;
let f: Awaited<ReturnType<typeof accessFixture>>;
beforeEach(async () => {
  database = await openMigratedDatabase();
  f = await accessFixture(database.executor);
});
afterEach(async () => database.close());
async function refuse() {
  await f.seed(
    "UPDATE audit_chain SET policy='required',capacity_state='refusing' WHERE org_id=?",
    f.org.orgId,
  );
}
const auditRows = () =>
  database.executor.all<{ action: string; payload_json: string }>({
    sql: 'SELECT action,payload_json FROM audit_pending WHERE org_id=? ORDER BY id',
    params: [f.org.orgId],
  });

it.each(['approved', 'rejected', 'expired'] as const)(
  'admits only restrictive access decision %s while refusing',
  async (state) => {
    const row = await f.repo.request(f.org, f.requestFence, f.input());
    if (state === 'expired') {
      await f.seed("UPDATE package_access_request SET expires_at='2000-01-01T00:00:00.000Z'");
      await f.seed(
        "INSERT INTO job(id,org_id,type,state,lease_owner,lease_until,fence) VALUES('expiry',?,'core:package-access-expire:v1','running','worker','2999-01-01T00:00:00.000Z',1)",
        f.org.orgId,
      );
    }
    await refuse();
    const operation = f.repo.decide(
      f.org,
      state === 'expired'
        ? systemMutationFence('purge', { id: 'expiry', owner: 'worker', fence: 1 }, {})
        : f.decideFence,
      {
        id: row.id,
        state,
        expectedRevision: 1,
        decidedByUserId: state === 'expired' ? null : f.decider.userId,
        now: f.now,
        event: f.event('package.access_decide', state === 'expired'),
      },
    );
    if (state === 'approved') {
      await expect(operation).rejects.toMatchObject({ kind: 'backlog_full' });
      expect((await f.repo.get(f.org, row.id))?.state).toBe('pending');
      expect(await auditRows()).toHaveLength(1);
    } else {
      expect((await operation).changed).toBe(true);
      expect((await f.repo.get(f.org, row.id))?.state).toBe(state);
      expect(await auditRows()).toHaveLength(2);
    }
    expect(
      await database.executor.all({ sql: 'SELECT * FROM project_package', params: [] }),
    ).toEqual([]);
  },
);

it.each([
  ['composer', 'vendor/package', 'vendor/package', 'rejected'],
  ['composer', 'vendor/package', 'vendor/package', 'expired'],
  ['npm', '@scope/!legacy', '@scope/Legacy', 'rejected'],
  ['npm', '@scope/!legacy', '@scope/Legacy', 'expired'],
] as const)(
  'requests and decides %s packages using one audit representation (%s, %s, %s)',
  async (ecosystem, key, name, state) => {
    await f.seed("DELETE FROM package WHERE id='PACKAGE'");
    await f.seed('UPDATE source SET ecosystem=?', ecosystem);
    await f.seed(
      "INSERT INTO package(id,org_id,source_id,ecosystem,name,visible_to_new_projects,new_project_access_mode) VALUES('PACKAGE',?,'SOURCE',?,?,0,'request')",
      f.org.orgId,
      ecosystem,
      key,
    );
    const row = await f.repo.request(f.org, f.requestFence, f.input());
    if (state === 'expired') {
      await f.seed("UPDATE package_access_request SET expires_at='2000-01-01T00:00:00.000Z'");
      await f.seed(
        "INSERT INTO job(id,org_id,type,state,lease_owner,lease_until,fence) VALUES('expiry',?,'core:package-access-expire:v1','running','worker','2999-01-01T00:00:00.000Z',1)",
        f.org.orgId,
      );
    }
    expect(
      (
        await f.repo.decide(
          f.org,
          state === 'expired'
            ? systemMutationFence('purge', { id: 'expiry', owner: 'worker', fence: 1 }, {})
            : f.decideFence,
          {
            id: row.id,
            state,
            expectedRevision: 1,
            decidedByUserId: state === 'expired' ? null : f.decider.userId,
            now: f.now,
            event: f.event('package.access_decide', state === 'expired'),
          },
        )
      ).changed,
    ).toBe(true);
    expect((await auditRows()).map((r) => JSON.parse(r.payload_json).changes.package.new)).toEqual([
      name,
      name,
    ]);
  },
);

it.each([false, true])(
  'package automatic visibility tightening reserves only the restrictive operation (enable=%s)',
  async (enable) => {
    await f.seed(
      "UPDATE role_permission SET permission='org:sources:write' WHERE role_id='R-decider'",
    );
    await f.seed(
      "UPDATE package SET visible_to_new_projects=?,new_project_access_mode='none'",
      enable ? 0 : 1,
    );
    await refuse();
    const call = createPackageDetailRepository(database.executor, ANCHORS).setAccess(
      f.org,
      f.decideFence,
      {
        packageId: 'PACKAGE',
        revision: 1,
        visibleToNewProjects: enable,
        newProjectAccessMode: 'none',
        audit: { ...f.event('package.access_request'), action: 'package.access_update' },
      },
    );
    if (enable) {
      await expect(call).rejects.toMatchObject({ kind: 'backlog_full' });
      expect(await auditRows()).toEqual([]);
    } else {
      expect(await call).toEqual({ ok: true });
      expect((await auditRows()).map((r) => r.action)).toEqual(['package.access_update']);
    }
  },
);

it('refuses custom role creation while bootstrap alone may reserve role.create', async () => {
  await f.seed("UPDATE role_permission SET permission='org:roles:write' WHERE role_id='R-decider'");
  await refuse();
  await expect(
    createRoleRepository(database.executor, { providerAnchors: ANCHORS }).create(
      f.org,
      f.decideFence,
      {
        id: ulid(),
        key: 'custom',
        name: 'Custom',
        scope: 'organization',
        permissions: [],
        now: f.now,
        opId: ulid(),
        audit: { ...f.event('package.access_request'), action: 'role.create' },
      },
    ),
  ).rejects.toMatchObject({ kind: 'backlog_full' });
  expect(
    await database.executor.all({ sql: "SELECT id FROM role WHERE key='custom'", params: [] }),
  ).toEqual([]);
  expect(await auditRows()).toEqual([]);
});

const publisherClaims = [
  { environment: '', ref: 'refs/heads/main' },
  { environment: '', ref: 'refs/tags/v1' },
  { environment: 'prod', ref: 'refs/heads/main' },
  { environment: 'prod', ref: 'refs/tags/v1' },
  { environment: 'PrOd', ref: 'refs/tags/v2' },
  { environment: 'prod', ref: 'refs/tags/release' },
  { environment: 'prod', ref: 'refs/heads/v1' },
  { environment: 'staging', ref: 'refs/tags/v1' },
  { environment: 'Ä', ref: 'refs/tags/v1' },
  { environment: 'ä', ref: 'refs/tags/v1' },
];
it.each([
  ['', 'prod', null, null, false, [0, 1], [2, 3, 4, 5, 6]],
  ['prod', '', null, null, false, [2, 3, 4, 5, 6], [0, 1]],
  ['', 'prod', null, 'refs/tags/*', false, [0, 1], [3, 4, 5]],
  ['prod', 'staging', null, 'refs/tags/*', false, [2, 3, 4, 5, 6], [7]],
  ['prod', 'prod', null, 'refs/tags/*', true, [2, 3, 4, 5, 6], [3, 4, 5]],
  ['prod', 'prod', 'refs/tags/*', 'refs/tags/v*', true, [3, 4, 5], [3, 4]],
  ['prod', 'prod', 'refs/tags/v*', 'refs/tags/*', false, [3, 4], [3, 4, 5]],
  ['prod', 'prod', 'refs/*/v?', 'refs/tags/v1', true, [3, 4, 6], [3]],
  ['prod', 'prod', 'refs/tags/*', 'refs/tags/v?', true, [3, 4, 5], [3, 4]],
  ['prod', 'prod', null, 'refs/tags/v1', true, [2, 3, 4, 5, 6], [3]],
  ['prod', 'prod', 'refs/tags/*', null, false, [3, 4, 5], [2, 3, 4, 5, 6]],
  ['prod', 'prod', null, null, false, [2, 3, 4, 5, 6], [2, 3, 4, 5, 6]],
  ['prod', 'PrOd', null, null, false, [2, 3, 4, 5, 6], [2, 3, 4, 5, 6]],
  ['PrOd', 'prod', null, 'refs/tags/*', true, [2, 3, 4, 5, 6], [3, 4, 5]],
  ['prod', 'PrOd', null, 'refs/tags/*', true, [2, 3, 4, 5, 6], [3, 4, 5]],
  ['', '', null, 'refs/tags/*', true, [0, 1], [1]],
  ['Ä', 'ä', null, 'refs/tags/*', false, [8], [9]],
  ['prod', 'prod', 'refs/tags/*', 'refs/tags/**', false, [3, 4, 5], [3, 4, 5]],
  ['prod', 'prod', null, '*', false, [2, 3, 4, 5, 6], [2, 3, 4, 5, 6]],
  ['prod', 'prod', '*', null, false, [2, 3, 4, 5, 6], [2, 3, 4, 5, 6]],
  ['prod', 'prod', 'refs/tags/**', 'refs/tags/v*', true, [3, 4, 5], [3, 4]],
] as const)(
  'trusted publisher restrictions %s -> %s, %s -> %s reserve=%s',
  async (
    beforeEnvironment,
    afterEnvironment,
    beforeRef,
    afterRef,
    restrictive,
    beforeMatches,
    afterMatches,
  ) => {
    await f.seed(
      "UPDATE role_permission SET permission='org:packages:publish' WHERE role_id='R-decider'",
    );
    await f.seed(
      "INSERT INTO role_permission VALUES(?,'R-decider','org:service-principals:write')",
      f.org.orgId,
    );
    await f.seed(
      "INSERT INTO registered_name(id,org_id,source_id,ecosystem,pattern) VALUES('claim',?,'SOURCE','npm','widget')",
      f.org.orgId,
    );
    const store = createTrustedPublisherStore(database.executor, ANCHORS);
    const write = {
      id: ulid(),
      principalId: ulid(),
      now: f.now,
      event: f.event('package.access_request'),
      input: {
        packageName: 'widget',
        repository: 'owner/repo',
        workflow: 'publish.yml',
        environment: beforeEnvironment,
        ...(beforeRef === null ? {} : { refPattern: beforeRef }),
      },
      identity: { repository: 'owner/repo', repositoryId: '123', repositoryOwnerId: '456' },
    };
    const row = await store.create(f.org, f.decideFence, write);
    await f.seed(
      'UPDATE trusted_publisher SET environment=? WHERE org_id=? AND id=?',
      beforeEnvironment,
      f.org.orgId,
      row.id,
    );
    const oidc = createOidcRepository(database.executor);
    const assertClaims = async (expected: readonly number[]) => {
      const matched = [];
      for (const [index, claim] of publisherClaims.entries()) {
        const bindings = await oidc.find(f.org, {
          packageName: 'widget',
          repositoryId: '123',
          repositoryOwnerId: '456',
          workflow: 'publish.yml',
          environment: claim.environment,
        });
        if (
          bindings.some(
            (binding) => binding.id === row.id && matchesRef(binding.refPattern, claim.ref),
          )
        )
          matched.push(index);
      }
      expect(matched).toEqual(expected);
    };
    await assertClaims(beforeMatches);
    await refuse();
    const update = () =>
      store.update(f.org, f.decideFence, {
        ...write,
        expectedRevision: 1,
        event: f.event('package.access_request'),
        input: { ...write.input, environment: afterEnvironment, refPattern: afterRef ?? undefined },
      });
    if (!restrictive) {
      await expect(update()).rejects.toMatchObject({ kind: 'backlog_full' });
      expect(await store.get(f.org, row.id)).toMatchObject({
        environment: beforeEnvironment,
        refPattern: beforeRef,
        revision: 1,
      });
      expect(await auditRows()).toHaveLength(1);
      await assertClaims(beforeMatches);
      await f.seed("UPDATE audit_chain SET capacity_state='ok' WHERE org_id=?", f.org.orgId);
    }
    expect(await update()).toMatchObject({
      environment: afterEnvironment.replace(/[A-Z]/g, (ch) => ch.toLowerCase()),
      refPattern: afterRef,
      revision: 2,
    });
    expect(await auditRows()).toHaveLength(2);
    await assertClaims(afterMatches);
  },
);

it.each([false, true])('discovery update admits disabling only (enable=%s)', async (enable) => {
  await f.seed(
    "UPDATE role_permission SET permission='org:sources:write' WHERE role_id='R-decider'",
  );
  const admin = { fence: f.decideFence, anchors: ANCHORS };
  await seedDiscoveryRule(database.executor, f.org);
  if (enable) await f.seed('UPDATE source_discovery_rule SET enabled=0');
  await refuse();
  const repo = createDiscoveryRuleRepository(database.executor, admin.anchors);
  const call = repo.update(f.org, admin.fence, {
    id: RULE_ID,
    revision: 1,
    options: { ...RULE_OPTIONS, enabled: enable },
    now: f.now,
    audit: { ...ruleAudit(), action: 'discovery_rule.update' },
    call: { audit: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null } },
    credentialChanged: false,
  });
  if (enable) {
    await expect(call).rejects.toMatchObject({ kind: 'backlog_full' });
    expect((await repo.get(f.org, RULE_ID))?.enabled).toBe(false);
    expect(await auditRows()).toEqual([]);
  } else {
    expect(await call).toBe('ok');
    expect((await repo.get(f.org, RULE_ID))?.enabled).toBe(false);
    expect((await auditRows()).map((r) => r.action)).toEqual(['discovery_rule.update']);
  }
});

it.each(['live', 'expired', 'stale', 'foreign', 'wrong-type'] as const)(
  'credential failures require a %s scheduler lease',
  async (mode) => {
    await seedDiscoveryRule(database.executor, f.org);
    await f.seed("UPDATE credential SET kind='github_token' WHERE org_id=?", f.org.orgId);
    const repo = createDiscoveryRuleRepository(database.executor, ANCHORS);
    expect(await repo.due(f.org, f.now)).toEqual([]);
    expect((await repo.get(f.org, RULE_ID))?.outcome).toBeNull();
    expect(await auditRows()).toEqual([]);
    await f.seed(
      "INSERT INTO job(id,org_id,type,state,lease_owner,lease_until,fence) VALUES('scheduler',?,?,'running','worker',?,1)",
      mode === 'foreign' ? f.orgs.b.orgId : f.org.orgId,
      mode === 'wrong-type' ? 'core:discovery-rule:v1' : 'core:discovery-rules:v1',
      mode === 'expired' ? '2000-01-01T00:00:00.000Z' : '2999-01-01T00:00:00.000Z',
    );
    const call = () =>
      repo.failUnavailableCredentials(
        f.org,
        { id: 'scheduler', owner: 'worker', fence: mode === 'stale' ? 2 : 1 },
        f.now,
      );
    if (mode === 'live') {
      await call();
      await call();
      expect(await repo.get(f.org, RULE_ID)).toMatchObject({
        outcome: 'failed',
        failureReason: 'credential_unavailable',
      });
      expect((await auditRows()).map((r) => r.action)).toEqual(['discovery_rule.run_finished']);
    } else {
      await expect(call()).rejects.toMatchObject({
        kind: 'unique',
        constraint: 'access_mutation_guard.key',
      });
      expect((await repo.get(f.org, RULE_ID))?.outcome).toBeNull();
      expect(await auditRows()).toEqual([]);
    }
  },
);

it.each(['publisher', 'administrator'] as const)(
  'reserved %s unpublish commits full notification queue overflow',
  async (kind) => {
    const projectId = ulid(),
      sourceId = ulid(),
      packageId = ulid(),
      versionId = ulid();
    await seedProject(f.seed, projectId, f.org.orgId);
    await seedSource(f.seed, sourceId, f.org.orgId, 'hosted', 'npm');
    await seedPackage(f.seed, packageId, f.org.orgId, sourceId, 'library', 'npm');
    await seedVersion(f.seed, versionId, f.org.orgId, packageId, '1.0.0');
    await f.seed(
      "UPDATE version SET published_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      versionId,
    );
    await f.seed(
      'INSERT INTO project_source(org_id,project_id,source_id) VALUES(?,?,?)',
      f.org.orgId,
      projectId,
      sourceId,
    );
    await seedEndpoint(database.executor, f.org, {
      id: 'full-hook',
      projectId,
      events: ['npm.package.unpublished'],
    });
    await f.seed(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<10000)
    INSERT INTO notification_event(org_id,project_id,id,operation_id,event_type,source_id,package_key,payload_json,occurred_at)
    SELECT ?,?,'full-'||i,'full-'||i,'npm.package.unpublished',?,'library','{}',? FROM n`,
      f.org.orgId,
      projectId,
      sourceId,
      f.now,
    );
    await f.seed(
      `INSERT INTO notification_delivery(org_id,project_id,id,event_id,endpoint_id,endpoint_revision,configuration_credential_id,state,next_attempt_at,expires_at,created_at)
    SELECT org_id,project_id,id,id,'full-hook',1,'C-full-hook','pending',?,?,? FROM notification_event WHERE org_id=?`,
      f.now,
      f.now,
      f.now,
      f.org.orgId,
    );
    const opId = ulid();
    const result = auditEvent({
      id: ulid(),
      now: f.now,
      action: kind === 'publisher' ? 'package.unpublish' : 'version.state_change',
      actor: { type: 'user', id: f.decider.userId },
      target: { type: 'package', id: packageId },
      context: { opId, requestId: ulid(), sourceIp: null, tokenSelector: null },
    });
    if (!result.ok) throw new Error('fixture audit refused');
    if (kind === 'administrator') {
      await f.seed("UPDATE role SET protects_last_holder=1 WHERE id='R-decider'");
      await f.seed(
        "UPDATE session SET reauth_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        f.decider.sessionId,
      );
    }
    await refuse();
    if (kind === 'publisher') {
      const snapshot = await createDeprecationStore(database.executor).snapshot(
        f.org,
        sourceId,
        'library',
      );
      if (!snapshot) throw new Error('fixture package missing');
      await f.seed("UPDATE project SET token_max_scope='full' WHERE id=?", projectId);
      await f.seed(
        "INSERT INTO registered_name(id,org_id,source_id,ecosystem,pattern) VALUES(?,?,?,'npm','library')",
        ulid(),
        f.org.orgId,
        sourceId,
      );
      await f.seed(
        'INSERT INTO service_principal(id,org_id,name,created_by_user_id) VALUES(?,?,?,?)',
        'publisher',
        f.org.orgId,
        'Publisher',
        f.decider.userId,
      );
      await f.seed(
        "INSERT INTO service_principal_permission VALUES(?,'publisher','project:packages:manage')",
        f.org.orgId,
      );
      await f.seed(
        "INSERT INTO token(id,org_id,kind,service_principal_id,selector,hash,pepper_version,name,project_mode,scopes_json,expires_at) VALUES('token',?,'svc','publisher','abcdefghijkl',?,1,'Publisher','all',?,'2999-01-01T00:00:00.000Z')",
        f.org.orgId,
        'b'.repeat(64),
        JSON.stringify(['full']),
      );
      const input = {
        tokenId: 'token',
        routeProjectId: projectId,
        sourceId,
        key: 'library',
        snapshot,
        versions: ['1.0.0'],
        whole: true,
        event: result.event,
      };
      const guard = createPublishWriteGuard(
        f.org,
        {
          ...input,
          selector: 'abcdefghijkl',
          projectSlug: projectId.toLowerCase(),
          permission: 'project:packages:manage',
        },
        ANCHORS,
      );
      await createUnpublishStore(database.executor, { notifications: true }).remove(
        f.org,
        guard,
        input,
      );
    } else {
      expect(
        await createVisibilityStore(database.executor, {
          providerAnchors: ANCHORS,
          notifications: true,
        }).tombstoneVersion(f.org, f.decideFence, {
          packageId,
          versionId,
          expectedStatus: 'active',
          expectedRevision: 1,
          manage: { kind: 'organization' },
          reason: 'admin_tombstone',
          tombstoneReason: 'retired',
          audit: result.event,
        }),
      ).toMatchObject({ ok: true });
    }
    expect(
      await database.executor.all({
        sql: 'SELECT status FROM version WHERE id=?',
        params: [versionId],
      }),
    ).toEqual([{ status: 'tombstoned' }]);
    expect((await auditRows()).map((r) => r.action).sort()).toEqual(
      ['notification.overflow', result.event.action].sort(),
    );
  },
);

it.each(['lease_expired', 'credential_restored'] as const)(
  'rechecks %s after selecting invalid discovery credentials',
  async (race) => {
    await seedDiscoveryRule(database.executor, f.org);
    await f.seed("UPDATE credential SET kind='github_token' WHERE org_id=?", f.org.orgId);
    await f.seed(
      "INSERT INTO job(id,org_id,type,state,lease_owner,lease_until,fence) VALUES('scheduler',?,'core:discovery-rules:v1','running','worker','2999-01-01T00:00:00.000Z',1)",
      f.org.orgId,
    );
    const executor = {
      ...database.executor,
      all: async <T>(statement: import('@package-broker/core/db/port').Statement) => {
        const rows = await database.executor.all<T>(statement);
        if (statement.sql.startsWith('select id from source_discovery_rule')) {
          if (race === 'lease_expired')
            await f.seed(
              "UPDATE job SET lease_until='2000-01-01T00:00:00.000Z' WHERE org_id=?",
              f.org.orgId,
            );
          else await f.seed("UPDATE credential SET kind='github_app' WHERE org_id=?", f.org.orgId);
        }
        return rows;
      },
    };
    const call = createDiscoveryRuleRepository(executor, ANCHORS).failUnavailableCredentials(
      f.org,
      { id: 'scheduler', owner: 'worker', fence: 1 },
      f.now,
    );
    if (race === 'lease_expired')
      await expect(call).rejects.toMatchObject({
        kind: 'unique',
        constraint: 'access_mutation_guard.key',
      });
    else await call;
    expect(
      (await createDiscoveryRuleRepository(database.executor, ANCHORS).get(f.org, RULE_ID))
        ?.outcome,
    ).toBeNull();
    expect(await auditRows()).toEqual([]);
  },
);
