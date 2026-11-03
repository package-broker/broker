import { CAPTURE_STATEMENTS } from '@package-broker/core/db/notifications';
import { describe, expect, it } from 'vitest';
import { auditEvent, type AuditEvent } from '@package-broker/core/audit/actions';
import {
  mutationFence,
  systemMutationFence,
  type AuthenticatedActor,
} from '@package-broker/core/authz/fence';
import type { PublishVersionInput } from '@package-broker/core/db/catalogue';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { ulid } from '@package-broker/core/ids';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { createPublishWriteGuard } from '../repositories/catalogue-publish-guard.js';
import { createCatalogueWriter, createVisibilityStore } from '../repositories/catalogue-writer.js';
import { createDeprecationStore } from '../repositories/npm-deprecate.js';
import { createDistTagStore } from '../repositories/npm-dist-tags.js';
import { createUnpublishStore } from '../repositories/npm-unpublish.js';
import { createPublishesRepository } from '../repositories/publishes.js';
import type { OpenedNotificationOrgs } from './notification-read-contract.js';
import {
  NOW,
  PROJECT_A,
  PROJECT_B,
  SOURCE,
  rows,
  run,
  seedEndpoint,
  seedNotificationWorld,
} from './notification-fixture.js';

const ALL = [
  'npm.package.published',
  'npm.package.released',
  'npm.package.unpublished',
  'npm.package.deprecation_changed',
  'npm.package.dist_tag_changed',
] as const;
const ANCHORS = [
  {
    provider: 'oidc',
    anchor: 'oidc:https://idp.example.test',
    emailAuthoritative: true,
    emailAuthoritativeDomains: ['example.test'],
  },
];

/** Records every batch so a test can compare statement shapes with the flag on and off. */
function recording(executor: SqlExecutor) {
  const batches: (readonly Statement[])[] = [];
  return {
    batches,
    executor: {
      driver: executor.driver,
      all: executor.all.bind(executor),
      batch: (statements: readonly Statement[]) => {
        batches.push(statements);
        return executor.batch(statements);
      },
    } as SqlExecutor,
  };
}

async function world(executor: SqlExecutor, ctx: OrgContext) {
  await seedNotificationWorld(executor, ctx);
  const org = ctx.orgId;
  for (const [sql, ...params] of [
    [
      "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('claim',?,?,'npm','widget')",
      org,
      SOURCE,
    ],
    ["INSERT INTO user_account (id,org_id,email) VALUES ('user',?,'test@example.test')", org],
    [
      "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('principal',?,'Publisher','user')",
      org,
    ],
    [
      "INSERT INTO token (id,org_id,kind,service_principal_id,selector,hash,pepper_version,name,project_mode,scopes_json,expires_at) VALUES ('token',?,'svc','principal','abcdefghijkl',?,1,'publish','all','[\"full\"]','2099-01-01T00:00:00.000Z')",
      org,
      'b'.repeat(64),
    ],
    [
      "INSERT INTO blob (id,org_id,sha256,size_bytes,media_type,storage_key,refetchable) VALUES ('blob',?,?,10,'application/gzip','npm-publish/test',0)",
      org,
      'a'.repeat(64),
    ],
    [
      "INSERT INTO service_principal_permission (org_id,service_principal_id,permission) VALUES (?,'principal','org:packages:publish')",
      org,
    ],
    [
      "INSERT INTO service_principal_permission (org_id,service_principal_id,permission) VALUES (?,'principal','project:packages:manage')",
      org,
    ],
    [
      "INSERT INTO job (id,org_id,type,idempotency_key,state,lease_owner,lease_until,fence) VALUES ('job',?,'test:v1','test','running','owner','2099-01-01T00:00:00.000Z',1)",
      org,
    ],
  ] as const)
    await run(executor, sql, ...params);
  const guardInput = {
    tokenId: 'token',
    selector: 'abcdefghijkl',
    projectSlug: 'project-a',
    routeProjectId: PROJECT_A,
    sourceId: SOURCE,
    key: 'widget',
  };
  const audit = (action: AuditEvent['action'], target = 'widget'): AuditEvent => {
    const result = auditEvent({
      id: ulid(),
      now: NOW,
      action,
      actor: { type: 'service_principal', id: 'principal' },
      target: { type: 'version', id: target },
      context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    });
    if (!result.ok) throw new Error('invalid test audit');
    return result.event;
  };
  function input(
    version: string,
    hold: { approval?: boolean; scan?: boolean } = {},
    tags: Record<string, string> = { latest: version },
  ): PublishVersionInput {
    const held = hold.approval === true || hold.scan === true;
    return {
      sourceId: SOURCE,
      key: 'widget',
      description: 'Widget',
      versionId: `version-${version}`,
      version: {
        version,
        versionNormalized: version,
        license: null,
        distType: 'tgz',
        sourceRef: null,
        upstreamReleasedAt: null,
        history: { at: NOW, basis: 'release_date' },
        metadata: normalizeVersionMetadata('npm', { name: 'widget', version }),
      },
      blob: {
        id: 'blob',
        sha256: 'a'.repeat(64) as Sha256,
        sizeBytes: 10,
        mediaType: 'application/gzip',
        refetchable: false,
      },
      integrity: 'sha512-test',
      distTags: tags,
      readme: { filename: 'README.md', body: '# Widget' },
      approval: held
        ? {
            id: `approval-${version}`,
            packageId: '',
            versionId: `version-${version}`,
            sourceId: SOURCE,
            holdApproval: hold.approval === true,
            holdScan: hold.scan === true,
            approvalState: hold.approval === true ? 'pending' : 'not_required',
            scanState: hold.scan === true ? 'queued' : 'not_required',
            requiredScanners: hold.scan === true ? ['scanner'] : [],
            requestedByType: 'service',
            requestedById: 'principal',
            tokenId: 'token',
            routeProjectId: PROJECT_A,
            distTags: tags,
            readmePending: true,
            scanVerdicts: [],
            expiresAt: '2099-01-01T00:00:00.000Z',
          }
        : null,
      scanJobStatements: hold.scan === true ? [{ sql: 'SELECT 1', params: [] }] : [],
      requirePublishApproval: hold.approval === true,
      routeProjectId: PROJECT_A,
      tokenId: 'token',
      now: NOW,
      event: audit('package.publish', `version-${version}`),
    };
  }
  const publish = createPublishWriteGuard(ctx, guardInput, []);
  const manage = createPublishWriteGuard(
    ctx,
    { ...guardInput, permission: 'project:packages:manage' },
    [],
  );
  return { input, audit, publish, manage, guardInput };
}

async function events(executor: SqlExecutor, ctx: OrgContext) {
  const found = await rows<{ project_id: string; payload_json: string }>(
    executor,
    'SELECT project_id, payload_json FROM notification_event WHERE org_id = ? ORDER BY operation_id, ordinal',
    ctx.orgId,
  );
  return found.map((row) => {
    const event = JSON.parse(row.payload_json) as {
      type: string;
      projectId: string;
      package: { version: string | null };
      data: Record<string, unknown>;
    };
    expect(event.projectId).toBe(row.project_id);
    return { type: event.type, version: event.package.version, data: event.data };
  });
}

async function deliveredTo(executor: SqlExecutor, ctx: OrgContext) {
  return (
    await rows<{ endpoint_id: string }>(
      executor,
      'SELECT DISTINCT endpoint_id FROM notification_delivery WHERE org_id = ? ORDER BY endpoint_id',
      ctx.orgId,
    )
  ).map((row) => row.endpoint_id);
}

const touchesNotifications = (batch: readonly Statement[]) =>
  batch.some((statement) => /notification_/i.test(statement.sql));

export function describeNotificationNpmContract(
  name: string,
  open: () => Promise<OpenedNotificationOrgs>,
): void {
  async function withWorld(
    body: (
      executor: SqlExecutor,
      ctx: OrgContext,
      w: Awaited<ReturnType<typeof world>>,
    ) => Promise<void>,
  ) {
    const opened = await open();
    try {
      const ctx = opened.orgs.a;
      const w = await world(opened.executor, ctx);
      await seedEndpoint(opened.executor, ctx, { id: 'EA', events: ALL });
      await seedEndpoint(opened.executor, ctx, { id: 'EB', projectId: PROJECT_B, events: ALL });
      await body(opened.executor, ctx, w);
    } finally {
      await opened.close();
    }
  }

  async function manageable(executor: SqlExecutor, ctx: OrgContext) {
    await run(
      executor,
      "UPDATE version SET published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 minute') WHERE org_id = ?",
      ctx.orgId,
    );
    const snapshot = await createDeprecationStore(executor).snapshot(ctx, SOURCE, 'widget');
    if (snapshot === null) throw new Error('no snapshot');
    return snapshot;
  }

  /** Grants a fresh organization admin and returns a tombstone call for one version. */
  async function adminTombstone(
    executor: SqlExecutor,
    ctx: OrgContext,
    w: Awaited<ReturnType<typeof world>>,
    packageId: string,
  ) {
    const org = ctx.orgId;
    for (const [sql, ...params] of [
      [
        "INSERT INTO identity_provider_binding (org_id,provider,anchor) VALUES (?,'oidc','oidc:https://idp.example.test')",
        org,
      ],
      [
        "INSERT INTO identity (id,org_id,user_id,provider,subject,email,email_verified,validated_at) VALUES ('admin-identity',?,'user','oidc','admin','test@example.test',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        org,
      ],
      [
        "INSERT INTO session (id,org_id,user_id,identity_id,secret_hash,csrf_hash,expires_at,last_seen_at,reauth_at) VALUES ('admin-session',?,'user','admin-identity',?,?,'2099-01-01T00:00:00.000Z',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        org,
        'a'.repeat(64),
        'b'.repeat(64),
      ],
      [
        "INSERT INTO role (id,org_id,key,name,scope,protects_last_holder) VALUES ('admin-role',?,'admin','Admin','organization',1)",
        org,
      ],
      ["INSERT INTO role_permission VALUES (?,'admin-role','org:packages:manage')", org],
      [
        "INSERT INTO access_grant (id,org_id,role_id,scope,subject_type,subject_value) VALUES ('admin-grant',?,'admin-role','organization','email','test@example.test')",
        org,
      ],
    ] as const)
      await run(executor, sql, ...params);
    const fence = mutationFence(
      { userId: 'user', sessionId: 'admin-session' } as AuthenticatedActor,
      {},
    );
    return (
      notifications: boolean,
      revision = 1,
      options: {
        readonly version?: string;
        readonly expectedStatus?: 'active' | 'quarantined';
        readonly executor?: SqlExecutor;
      } = {},
    ) =>
      createVisibilityStore(options.executor ?? executor, {
        providerAnchors: ANCHORS,
        notifications,
      }).tombstoneVersion(ctx, fence, {
        packageId,
        versionId: `version-${options.version ?? '2.0.0'}`,
        expectedStatus: options.expectedStatus ?? 'active',
        expectedRevision: revision,
        manage: { kind: 'organization' },
        reason: 'admin_tombstone',
        tombstoneReason: 'retired',
        audit: { ...w.audit('version.state_change', `version-${options.version ?? '2.0.0'}`) },
      });
  }

  describe(`npm notification capture: ${name}`, () => {
    it('captures an organization-admin tombstone with removalKind tombstone for each attached project', async () => {
      await withWorld(async (executor, ctx, w) => {
        const writer = createCatalogueWriter(executor);
        await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        await writer.publishVersion(ctx, w.publish, w.input('2.0.0'));
        const snapshot = await manageable(executor, ctx);
        const tombstone = await adminTombstone(executor, ctx, w, snapshot.packageId);
        expect((await tombstone(true, 7)).ok).toBe(false);
        expect(await events(executor, ctx)).toEqual([]);
        expect((await tombstone(true)).ok).toBe(true);
        const unpublished = {
          type: 'npm.package.unpublished',
          version: '2.0.0',
          data: { removalScope: 'version', removalKind: 'tombstone' },
        };
        const moved = {
          type: 'npm.package.dist_tag_changed',
          version: '1.0.0',
          data: { tag: 'latest', previousVersion: '2.0.0', version: '1.0.0', cause: 'unpublish' },
        };
        expect(await events(executor, ctx)).toEqual([unpublished, moved, unpublished, moved]);
        expect(await deliveredTo(executor, ctx)).toEqual(['EA', 'EB']);
      });
    });

    async function attachProjects(executor: SqlExecutor, ctx: OrgContext, count: number) {
      for (let index = 0; index < count; index += 1) {
        const id = `01J0PR0JECTX00000000000${String(index).padStart(3, '0')}`;
        await run(
          executor,
          'INSERT INTO project (id, org_id, slug, name) VALUES (?, ?, ?, ?)',
          id,
          ctx.orgId,
          `extra-${String(index)}`,
          `extra-${String(index)}`,
        );
        await run(
          executor,
          'INSERT INTO project_source (org_id, project_id, source_id) VALUES (?, ?, ?)',
          ctx.orgId,
          id,
          SOURCE,
        );
        await seedEndpoint(executor, ctx, { id: `EX${String(index)}`, projectId: id, events: ALL });
      }
    }

    it('splits a tombstone fan-out over 64 events into several operations in one batch', async () => {
      await withWorld(async (executor, ctx, w) => {
        await attachProjects(executor, ctx, 31);
        const writer = createCatalogueWriter(executor);
        await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        await writer.publishVersion(
          ctx,
          w.publish,
          w.input('2.0.0', {}, { latest: '2.0.0', next: '2.0.0', beta: '2.0.0' }),
        );
        const snapshot = await manageable(executor, ctx);
        const tombstone = await adminTombstone(executor, ctx, w, snapshot.packageId);
        const recorded = recording(executor);
        expect((await tombstone(true, 1, { executor: recorded.executor })).ok).toBe(true);
        expect(recorded.batches.at(-1)!.length).toBeLessThanOrEqual(40);
        const operations = await rows<{ operation_id: string; n: number }>(
          executor,
          'SELECT operation_id, count(*) AS n FROM notification_event WHERE org_id = ? GROUP BY operation_id ORDER BY n DESC',
          ctx.orgId,
        );
        expect(operations.map((operation) => operation.n)).toEqual([64, 64, 4]);
        expect(
          await rows(
            executor,
            'SELECT count(DISTINCT project_id) AS projects, count(*) AS deliveries FROM notification_delivery WHERE org_id = ?',
            ctx.orgId,
          ),
        ).toEqual([{ projects: 33, deliveries: 132 }]);
        expect(
          await rows(
            executor,
            "SELECT count(*) AS n FROM audit_pending WHERE org_id = ? AND action = 'notification.overflow'",
            ctx.orgId,
          ),
        ).toEqual([{ n: 0 }]);
      });
    });

    it('records one overflow attributed to the source when a tombstone fan-out exceeds the bound', async () => {
      await withWorld(async (executor, ctx, w) => {
        await attachProjects(executor, ctx, 63);
        const writer = createCatalogueWriter(executor);
        await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        await writer.publishVersion(ctx, w.publish, w.input('2.0.0'));
        const snapshot = await manageable(executor, ctx);
        const tombstone = await adminTombstone(executor, ctx, w, snapshot.packageId);
        expect((await tombstone(true)).ok).toBe(true);
        expect(await events(executor, ctx)).toEqual([]);
        const overflow = await rows<{
          project_id: string | null;
          target_type: string;
          target_id: string;
          actor_type: string;
          payload_json: string;
        }>(
          executor,
          "SELECT project_id, target_type, target_id, actor_type, payload_json FROM audit_pending WHERE org_id = ? AND action = 'notification.overflow'",
          ctx.orgId,
        );
        expect(overflow).toHaveLength(1);
        expect(overflow[0]).toMatchObject({
          project_id: null,
          target_type: 'source',
          target_id: SOURCE,
          actor_type: 'system',
        });
        expect(JSON.parse(overflow[0]!.payload_json)).toMatchObject({
          changes: {
            event_type: { new: 'npm.package.unpublished' },
            event_count: { new: 130 },
          },
        });
      });
    });

    it('refuses a tombstone whose tag moves concurrently instead of reporting a stale tag', async () => {
      await withWorld(async (executor, ctx, w) => {
        const writer = createCatalogueWriter(executor);
        await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        const snapshot = await manageable(executor, ctx);
        await run(
          executor,
          "UPDATE version SET status = 'quarantined' WHERE org_id = ? AND id = 'version-1.0.0'",
          ctx.orgId,
        );
        const tombstone = await adminTombstone(executor, ctx, w, snapshot.packageId);
        let reads = 0;
        const racing = {
          driver: executor.driver,
          all: executor.all.bind(executor),
          batch: async (statements: readonly Statement[]) => {
            const result = await executor.batch(statements);
            if (statements.length === 1 && /tomb_tag/.test(statements[0]!.sql) && reads++ === 0) {
              await run(
                executor,
                'DELETE FROM dist_tag WHERE org_id = ? AND package_id = ?',
                ctx.orgId,
                snapshot.packageId,
              );
              await run(
                executor,
                'UPDATE package SET rev = rev + 1 WHERE org_id = ? AND id = ?',
                ctx.orgId,
                snapshot.packageId,
              );
            }
            return result;
          },
        } as SqlExecutor;
        const result = await tombstone(true, 1, {
          version: '1.0.0',
          expectedStatus: 'quarantined',
          executor: racing,
        });
        expect(reads).toBe(1);
        expect(result.ok).toBe(false);
        expect(await events(executor, ctx)).toEqual([]);
      });
    });

    it('captures one published event for an immediately active local publish, for the originating project only', async () => {
      await withWorld(async (executor, ctx, w) => {
        const writer = createCatalogueWriter(executor, { notifications: true });
        await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        await expect(writer.publishVersion(ctx, w.publish, w.input('1.0.0'))).rejects.toThrow();
        expect(await events(executor, ctx)).toEqual([
          { type: 'npm.package.published', version: '1.0.0', data: {} },
        ]);
        expect(await deliveredTo(executor, ctx)).toEqual(['EA']);
      });
    });

    it('captures nothing for a held publish', async () => {
      await withWorld(async (executor, ctx, w) => {
        await run(
          executor,
          'UPDATE source SET require_publish_approval = 1 WHERE org_id = ?',
          ctx.orgId,
        );
        const on = recording(executor);
        await createCatalogueWriter(on.executor, { notifications: true }).publishVersion(
          ctx,
          w.publish,
          w.input('1.0.0', { approval: true }),
        );
        expect(await events(executor, ctx)).toEqual([]);
        expect(touchesNotifications(on.batches[0]!)).toBe(false);
      });
    });

    it('with the flag off adds no statement and no row to publish', async () => {
      await withWorld(async (executor, ctx, w) => {
        const off = recording(executor);
        const first = await createCatalogueWriter(off.executor).publishVersion(
          ctx,
          w.publish,
          w.input('1.0.0'),
        );
        const on = recording(executor);
        const second = await createCatalogueWriter(on.executor, {
          notifications: true,
        }).publishVersion(ctx, w.publish, w.input('2.0.0'));
        expect(touchesNotifications(off.batches[0]!)).toBe(false);
        expect(off.batches[0]!.at(-1)!.sql).toMatch(/^select "id", "rev" from "package"/);
        expect(on.batches[0]!.length).toBe(off.batches[0]!.length - 1 + CAPTURE_STATEMENTS);
        expect(second.rev).toBe(first.rev + 2);
        expect(await events(executor, ctx)).toEqual([
          { type: 'npm.package.published', version: '2.0.0', data: {} },
        ]);
      });
    });

    it('captures a publish without dist-tags and returns the package revision', async () => {
      await withWorld(async (executor, ctx, w) => {
        const writer = createCatalogueWriter(executor, { notifications: true });
        const first = await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        const second = await writer.publishVersion(ctx, w.publish, w.input('2.0.0', {}, {}));
        expect(second.packageId).toBe(first.packageId);
        expect(
          await rows(executor, 'SELECT id, rev FROM package WHERE org_id = ?', ctx.orgId),
        ).toEqual([{ id: second.packageId, rev: second.rev }]);
        expect(await events(executor, ctx)).toEqual([
          { type: 'npm.package.published', version: '1.0.0', data: {} },
          { type: 'npm.package.published', version: '2.0.0', data: {} },
        ]);
      });
    });

    it('keeps the largest publish batch with capture at 35 of 40 statements', async () => {
      await withWorld(async (executor, ctx, w) => {
        const tags = (version: string) =>
          Object.fromEntries(
            ['latest', 'next', 'beta', 'alpha', 'canary', 'rc', 'lts', 'edge'].map((tag) => [
              tag,
              version,
            ]),
          );
        const off = recording(executor);
        await createCatalogueWriter(off.executor).publishVersion(
          ctx,
          w.publish,
          w.input('1.0.0', {}, tags('1.0.0')),
        );
        const on = recording(executor);
        const result = await createCatalogueWriter(on.executor, {
          notifications: true,
        }).publishVersion(ctx, w.publish, w.input('2.0.0', {}, tags('2.0.0')));
        expect(off.batches[0]!.length).toBe(30);
        expect(on.batches[0]!.length).toBe(35);
        expect(await events(executor, ctx)).toHaveLength(1);
        expect(
          await rows(executor, 'SELECT id, rev FROM package WHERE org_id = ?', ctx.orgId),
        ).toEqual([{ id: result.packageId, rev: result.rev }]);
      });
    });

    async function approver(executor: SqlExecutor, ctx: OrgContext) {
      const org = ctx.orgId;
      for (const [sql, ...params] of [
        [
          "INSERT INTO user_account (id,org_id,email) VALUES ('approver',?,'approver@example.test')",
          org,
        ],
        [
          "INSERT INTO identity_provider_binding (org_id,provider,anchor) VALUES (?,'oidc','oidc:https://idp.example.test')",
          org,
        ],
        [
          "INSERT INTO identity (id,org_id,user_id,provider,subject,email,email_verified,validated_at) VALUES ('approver-identity',?,'approver','oidc','approver','approver@example.test',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          org,
        ],
        [
          "INSERT INTO session (id,org_id,user_id,secret_hash,csrf_hash,expires_at,last_seen_at) VALUES ('session',?,'approver',?,?,'2099-01-01T00:00:00.000Z',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          org,
          'a'.repeat(64),
          'b'.repeat(64),
        ],
        [
          "INSERT INTO role (id,org_id,key,name,scope) VALUES ('approver-role',?,'approver','Approver','organization')",
          org,
        ],
        ["INSERT INTO role_permission VALUES (?,'approver-role','org:packages:approve')", org],
        [
          "INSERT INTO access_grant (id,org_id,role_id,scope,subject_type,subject_value) VALUES ('grant',?,'approver-role','organization','email','approver@example.test')",
          org,
        ],
      ] as const)
        await run(executor, sql, ...params);
      return mutationFence({ userId: 'approver', sessionId: 'session' } as AuthenticatedActor, {});
    }

    async function held(
      executor: SqlExecutor,
      ctx: OrgContext,
      w: Awaited<ReturnType<typeof world>>,
      hold: { approval?: boolean; scan?: boolean },
    ) {
      if (hold.approval === true)
        await run(
          executor,
          'UPDATE source SET require_publish_approval = 1 WHERE org_id = ?',
          ctx.orgId,
        );
      const fence = await approver(executor, ctx);
      await createCatalogueWriter(executor, { notifications: true }).publishVersion(
        ctx,
        w.publish,
        w.input('1.0.0', hold),
      );
      const repo = createPublishesRepository(executor, ANCHORS, { notifications: true });
      const current = async () => (await repo.get(ctx, 'approval-1.0.0'))!;
      const base = async () => {
        const item = await current();
        return {
          id: item.id,
          expectedRevision: item.revision,
          expectedApprovalState: item.approvalState,
          expectedScanState: item.scanState,
          now: NOW,
        };
      };
      const verifier = systemMutationFence('verifier', { id: 'job', owner: 'owner', fence: 1 }, {});
      return {
        approve: async () =>
          repo.decide(ctx, fence, {
            ...(await base()),
            event: w.audit('publish.approve'),
            decision: 'approved',
            decidedByUserId: 'approver',
          }),
        reject: async () =>
          repo.decide(ctx, fence, {
            ...(await base()),
            event: w.audit('publish.reject'),
            decision: 'rejected',
            decidedByUserId: 'approver',
            reason: 'Policy',
          }),
        scan: async () => {
          await repo.scan(ctx, verifier, {
            ...(await base()),
            event: w.audit('publish.scan'),
            scanState: 'running',
            verdicts: [],
          });
          return repo.scan(ctx, verifier, {
            ...(await base()),
            event: w.audit('publish.scan'),
            scanState: 'allowed',
            verdicts: [{ plugin: 'scanner', verdict: 'allow' }],
          });
        },
      };
    }

    for (const [label, hold, steps, cause] of [
      ['approval', { approval: true }, ['approve'], 'approval'],
      ['scan', { scan: true }, ['scan'], 'scan'],
      [
        'approval then scan',
        { approval: true, scan: true },
        ['approve', 'scan'],
        'approval_and_scan',
      ],
      [
        'scan then approval',
        { approval: true, scan: true },
        ['scan', 'approve'],
        'approval_and_scan',
      ],
    ] as const)
      it(`captures one released event after ${label}, never a published duplicate`, async () => {
        await withWorld(async (executor, ctx, w) => {
          const h = await held(executor, ctx, w, hold);
          for (const step of steps) {
            expect(await events(executor, ctx)).toEqual([]);
            await (step === 'approve' ? h.approve() : h.scan());
          }
          expect(await events(executor, ctx)).toEqual([
            { type: 'npm.package.released', version: '1.0.0', data: { releaseCause: cause } },
          ]);
          expect(await deliveredTo(executor, ctx)).toEqual(['EA']);
        });
      });

    it('captures one released event when the last two holds clear concurrently', async () => {
      await withWorld(async (executor, ctx, w) => {
        const h = await held(executor, ctx, w, { approval: true, scan: true });
        await Promise.allSettled([h.approve(), h.scan()]);
        await Promise.allSettled([h.approve(), h.scan()]);
        expect(await events(executor, ctx)).toEqual([
          {
            type: 'npm.package.released',
            version: '1.0.0',
            data: { releaseCause: 'approval_and_scan' },
          },
        ]);
      });
    });

    it('captures nothing for a rejected publish', async () => {
      await withWorld(async (executor, ctx, w) => {
        const h = await held(executor, ctx, w, { approval: true });
        await h.reject();
        expect(await events(executor, ctx)).toEqual([]);
      });
    });

    it('captures version unpublish with the tag it moved, before the rows change', async () => {
      await withWorld(async (executor, ctx, w) => {
        const writer = createCatalogueWriter(executor);
        await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        await writer.publishVersion(ctx, w.publish, w.input('2.0.0'));
        const snapshot = await manageable(executor, ctx);
        const off = recording(executor);
        await expect(
          createUnpublishStore(off.executor).remove(ctx, w.manage, {
            tokenId: 'token',
            routeProjectId: PROJECT_A,
            sourceId: SOURCE,
            key: 'widget',
            snapshot: { ...snapshot, rev: snapshot.rev + 1 },
            versions: ['2.0.0'],
            whole: false,
            event: w.audit('package.unpublish'),
          }),
        ).rejects.toThrow();
        await expect(
          createUnpublishStore(executor, { notifications: true }).remove(ctx, w.manage, {
            tokenId: 'token',
            routeProjectId: PROJECT_A,
            sourceId: SOURCE,
            key: 'widget',
            snapshot: { ...snapshot, rev: snapshot.rev + 1 },
            versions: ['2.0.0'],
            whole: false,
            event: w.audit('package.unpublish'),
          }),
        ).rejects.toThrow();
        expect(touchesNotifications(off.batches[0]!)).toBe(false);
        expect(await events(executor, ctx)).toEqual([]);
        await createUnpublishStore(executor, { notifications: true }).remove(ctx, w.manage, {
          tokenId: 'token',
          routeProjectId: PROJECT_A,
          sourceId: SOURCE,
          key: 'widget',
          snapshot,
          versions: ['2.0.0'],
          whole: false,
          event: w.audit('package.unpublish'),
        });
        expect(await events(executor, ctx)).toEqual([
          {
            type: 'npm.package.unpublished',
            version: '2.0.0',
            data: { removalScope: 'version', removalKind: 'window' },
          },
          {
            type: 'npm.package.dist_tag_changed',
            version: '1.0.0',
            data: { tag: 'latest', previousVersion: '2.0.0', version: '1.0.0', cause: 'unpublish' },
          },
        ]);
        expect(await deliveredTo(executor, ctx)).toEqual(['EA']);
      });
    });

    it('captures a whole-package unpublish as one event without a version list', async () => {
      await withWorld(async (executor, ctx, w) => {
        const writer = createCatalogueWriter(executor);
        await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        await writer.publishVersion(ctx, w.publish, w.input('2.0.0'));
        const snapshot = await manageable(executor, ctx);
        await createUnpublishStore(executor, { notifications: true }).remove(ctx, w.manage, {
          tokenId: 'token',
          routeProjectId: PROJECT_A,
          sourceId: SOURCE,
          key: 'widget',
          snapshot,
          versions: ['1.0.0', '2.0.0'],
          whole: true,
          event: w.audit('package.unpublish'),
        });
        expect(await events(executor, ctx)).toEqual([
          {
            type: 'npm.package.unpublished',
            version: null,
            data: { removalScope: 'package', removalKind: 'window' },
          },
          {
            type: 'npm.package.dist_tag_changed',
            version: null,
            data: { tag: 'latest', previousVersion: '2.0.0', version: null, cause: 'unpublish' },
          },
        ]);
        expect(
          await rows(executor, "SELECT count(*) AS n FROM version WHERE status = 'tombstoned'"),
        ).toEqual([{ n: 2 }]);
      });
    });

    it('with the flag off adds no statement to deprecate, dist-tag or unpublish batches', async () => {
      await withWorld(async (executor, ctx, w) => {
        const writer = createCatalogueWriter(executor);
        for (const version of ['1.0.0', '2.0.0', '3.0.0'])
          await writer.publishVersion(ctx, w.publish, w.input(version));
        const base = {
          tokenId: 'token',
          routeProjectId: PROJECT_A,
          sourceId: SOURCE,
          key: 'widget',
        };
        const lengths: number[][] = [];
        for (const notifications of [false, true]) {
          const recorded = recording(executor);
          const deprecate = async (version: string, message: string) => {
            const snapshot = await manageable(executor, ctx);
            const old = snapshot.versions.find((v) => v.version === version)!.deprecatedMessage;
            await createDeprecationStore(recorded.executor, { notifications }).update(
              ctx,
              w.manage,
              {
                ...base,
                snapshot,
                edits: [{ version, old, message, event: w.audit('package.deprecate') }],
              },
            );
          };
          await deprecate('1.0.0', notifications ? 'b' : 'a');
          await createDistTagStore(recorded.executor, { notifications }).update(ctx, w.manage, {
            ...base,
            snapshot: await manageable(executor, ctx),
            tag: notifications ? 'beta' : 'next',
            version: '1.0.0',
            event: w.audit('package.dist_tag'),
          });
          await createUnpublishStore(recorded.executor, { notifications }).remove(ctx, w.manage, {
            ...base,
            snapshot: await manageable(executor, ctx),
            versions: [notifications ? '2.0.0' : '3.0.0'],
            whole: false,
            event: w.audit('package.unpublish'),
          });
          if (!notifications)
            for (const batch of recorded.batches) expect(touchesNotifications(batch)).toBe(false);
          lengths.push(recorded.batches.map((batch) => batch.length));
        }
        expect(lengths[1]).toEqual(lengths[0]!.map((length) => length + CAPTURE_STATEMENTS));
      });
    });

    it('captures actual deprecation changes without the message text', async () => {
      await withWorld(async (executor, ctx, w) => {
        const writer = createCatalogueWriter(executor);
        await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        await writer.publishVersion(ctx, w.publish, w.input('2.0.0'));
        const store = createDeprecationStore(executor, { notifications: true });
        const edit = async (version: string, message: string) => {
          const snapshot = await manageable(executor, ctx);
          const old = snapshot.versions.find((v) => v.version === version)!.deprecatedMessage;
          await store.update(ctx, w.manage, {
            tokenId: 'token',
            routeProjectId: PROJECT_A,
            sourceId: SOURCE,
            key: 'widget',
            snapshot,
            edits: [{ version, old, message, event: w.audit('package.deprecate') }],
          });
        };
        await edit('1.0.0', '');
        await edit('1.0.0', 'secret marker one');
        await edit('1.0.0', 'secret marker two');
        await edit('1.0.0', '');
        expect(await events(executor, ctx)).toEqual([
          { type: 'npm.package.deprecation_changed', version: '1.0.0', data: { deprecated: true } },
          { type: 'npm.package.deprecation_changed', version: '1.0.0', data: { deprecated: true } },
          {
            type: 'npm.package.deprecation_changed',
            version: '1.0.0',
            data: { deprecated: false },
          },
        ]);
        expect(
          await rows(
            executor,
            "SELECT count(*) AS n FROM notification_event WHERE instr(payload_json, 'secret marker') > 0",
          ),
        ).toEqual([{ n: 0 }]);
      });
    });

    it('refuses a deprecation request above the per-request version cap before any write', async () => {
      await withWorld(async (executor, ctx, w) => {
        await createCatalogueWriter(executor).publishVersion(ctx, w.publish, w.input('1.0.0'));
        const [pkg] = await rows<{ id: string }>(
          executor,
          'SELECT id FROM package WHERE org_id = ?',
          ctx.orgId,
        );
        for (let i = 1; i <= 64; i++)
          await run(
            executor,
            "INSERT INTO version (id,org_id,package_id,version,version_normalized,published_at,published_at_basis,metadata_json,blob_id,dist_type) VALUES (?,?,?,?,?,?,'upstream',?,'blob','tgz')",
            `bulk-${i}`,
            ctx.orgId,
            pkg!.id,
            `2.0.${i}`,
            `2.0.${i}`,
            NOW,
            JSON.stringify({ name: 'widget', version: `2.0.${i}` }),
          );
        const snapshot = await manageable(executor, ctx);
        expect(snapshot.versions).toHaveLength(65);
        const edits = snapshot.versions.map((v) => ({
          version: v.version,
          old: null,
          message: 'old',
          event: w.audit('package.deprecate'),
        }));
        await expect(
          createDeprecationStore(executor, { notifications: true }).update(ctx, w.manage, {
            tokenId: 'token',
            routeProjectId: PROJECT_A,
            sourceId: SOURCE,
            key: 'widget',
            snapshot,
            edits,
          }),
        ).rejects.toThrow('invalid deprecation snapshot');
      });
    });

    it('captures explicit dist-tag additions, retargets and deletions once each', async () => {
      await withWorld(async (executor, ctx, w) => {
        const writer = createCatalogueWriter(executor, { notifications: true });
        await writer.publishVersion(ctx, w.publish, w.input('1.0.0'));
        await writer.publishVersion(ctx, w.publish, w.input('2.0.0', {}, { latest: '2.0.0' }));
        const store = createDistTagStore(executor, { notifications: true });
        const off = recording(executor);
        const set = async (tag: string, version: string | null, target = store) =>
          target.update(ctx, w.manage, {
            tokenId: 'token',
            routeProjectId: PROJECT_A,
            sourceId: SOURCE,
            key: 'widget',
            snapshot: await manageable(executor, ctx),
            tag,
            version,
            event: w.audit('package.dist_tag'),
          });
        await set('beta', '1.0.0');
        await set('beta', '2.0.0');
        await set('beta', '2.0.0');
        await set('beta', null);
        await set('next', '1.0.0', createDistTagStore(off.executor));
        expect(touchesNotifications(off.batches[0]!)).toBe(false);
        expect(
          (await events(executor, ctx)).filter((e) => e.type !== 'npm.package.published'),
        ).toEqual([
          {
            type: 'npm.package.dist_tag_changed',
            version: '1.0.0',
            data: { tag: 'beta', previousVersion: null, version: '1.0.0', cause: 'explicit' },
          },
          {
            type: 'npm.package.dist_tag_changed',
            version: '2.0.0',
            data: { tag: 'beta', previousVersion: '1.0.0', version: '2.0.0', cause: 'explicit' },
          },
          {
            type: 'npm.package.dist_tag_changed',
            version: null,
            data: { tag: 'beta', previousVersion: '2.0.0', version: null, cause: 'explicit' },
          },
        ]);
        expect(
          (await events(executor, ctx)).filter((e) => e.type === 'npm.package.published'),
        ).toHaveLength(2);
        expect(await deliveredTo(executor, ctx)).toEqual(['EA']);
      });
    });
  });
}
