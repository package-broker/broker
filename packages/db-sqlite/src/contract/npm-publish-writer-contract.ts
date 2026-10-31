import { createPackageDetailRepository } from '../repositories/package-detail.js';
import { publishRoutes } from '@package-broker/core/api/routes/publishes';
import { sha256Hex } from '@package-broker/core/auth/primitives';
import { createPublishApprovalExpireJob } from '@package-broker/core/ingest/publish-approval-expire-job';
import { jobFences } from '@package-broker/core/platform/job-fences';
import { createBlobReferenceReader } from '../repositories/blob-references.js';
import { bootstrapAdmin } from '../repositories/admin-bootstrap.js';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { describe, expect, it } from 'vitest';
import {
  mutationFence,
  systemMutationFence,
  type AuthenticatedActor,
} from '@package-broker/core/authz/fence';
import { orgContext, type SqlExecutor, type Statement } from '@package-broker/core/db/port';
import type { PublishVersionInput } from '@package-broker/core/db/catalogue';
import { normalizeVersionMetadata } from '@package-broker/core/catalogue/metadata';
import { ulid } from '@package-broker/core/ids';
import { auditEvent } from '@package-broker/core/audit/actions';
import type { Sha256 } from '@package-broker/core/platform/blob';
import { createPackageAccess } from '@package-broker/core/catalogue/package-access';
import { createAuthorizationEngine, patValidationGate } from '@package-broker/core/authz/engine';
import { createKeyring } from '@package-broker/core/secrets/keyring';
import { createKernel } from '@package-broker/core/kernel/kernel';
import { npmRoutes } from '@package-broker/core/registry/npm/routes';
import { fixedClock } from '@package-broker/core/ids';

import { renderPackument } from '@package-broker/core/registry/npm/render';
import { createMcpTools } from '@package-broker/core/mcp/tools';
import { packageRoutes } from '@package-broker/core/api/routes/packages';
import type { RequestContext, PluginPorts } from '@package-broker/core/plugin';
import { distTagStatements } from '../repositories/catalogue-write-tags.js';
import { createCatalogueStatusRepository } from '../repositories/catalogue-status.js';
import { createVisibilityStore } from '../repositories/catalogue-writer.js';
import { createCatalogueWriter } from '../repositories/catalogue-writer.js';
import { createPublishWriteGuard } from '../repositories/catalogue-publish-guard.js';
import { createCatalogueReader } from '../repositories/catalogue.js';
import { createPackageReadmeReader } from '../repositories/package-readme.js';
import { createPublishesRepository } from '../repositories/publishes.js';
import { createPackageAdminReader } from '../repositories/package-admin-read.js';
import { migrate } from '../migrations/runner.js';
import { discoveredMigrations } from '../testing/migrated-database.js';
import type { OpenedCatalogueWriteDatabase } from './catalogue-write-contract.js';

const ctx = orgContext('org');
const NOW = '2026-10-30T00:00:00.000Z';
const st = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
const ref = { projectId: 'project', ecosystem: 'npm' as const, key: 'widget' };

async function world(executor: SqlExecutor) {
  await migrate(executor, await discoveredMigrations(), { holder: 'publish-contract' });
  await executor.batch([
    st("INSERT INTO organization (id,slug,name) VALUES ('org','org','Organization')"),
    st("INSERT INTO project (id,org_id,slug,name) VALUES ('project','org','project','Project')"),
    st(
      "INSERT INTO source (id,org_id,name,ecosystem,type) VALUES ('source','org','Hosted','npm','hosted')",
    ),
    st(
      "INSERT INTO project_source (org_id,project_id,source_id) VALUES ('org','project','source')",
    ),
    st(
      "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('claim','org','source','npm','widget')",
    ),
    st("INSERT INTO user_account (id,org_id,email) VALUES ('user','org','test@example.test')"),
    st(
      "INSERT INTO service_principal (id,org_id,name,created_by_user_id) VALUES ('principal','org','Publisher','user')",
    ),
    st(
      "INSERT INTO token (id,org_id,kind,service_principal_id,selector,hash,pepper_version,name,project_mode,scopes_json,expires_at) VALUES ('token','org','svc','principal','abcdefghijkl',?,1,'publish','all','[\"write\"]','2099-01-01T00:00:00.000Z')",
      'b'.repeat(64),
    ),
    st(
      "INSERT INTO blob (id,org_id,sha256,size_bytes,media_type,storage_key,refetchable) VALUES ('blob','org',?,10,'application/gzip','npm-publish/test',0)",
      'a'.repeat(64),
    ),
    st(
      "INSERT INTO service_principal_permission (org_id,service_principal_id,permission) VALUES ('org','principal','org:packages:publish')",
    ),
    st(
      "INSERT INTO job (id,org_id,type,idempotency_key,state,lease_owner,lease_until,fence) VALUES ('job','org','test:v1','test','running','owner','2099-01-01T00:00:00.000Z',1)",
    ),
  ]);
  const guard = createPublishWriteGuard(
    ctx,
    {
      tokenId: 'token',
      selector: 'abcdefghijkl',
      projectSlug: 'project',
      routeProjectId: 'project',
      sourceId: 'source',
      key: 'widget',
    },
    [],
  );
  const event = auditEvent({
    id: ulid(),
    now: NOW,
    action: 'package.publish',
    actor: { type: 'service_principal', id: ulid() },
    target: { type: 'version', id: 'version-1.0.0' },
    context: { opId: ulid(), requestId: ulid(), sourceIp: null, tokenSelector: null },
    changes: { version: { new: '1.0.0' } },
  });
  if (!event.ok) throw new Error('invalid test audit');
  const preparedEvent = event.event;
  function input(held = false, version = '1.0.0'): PublishVersionInput {
    return {
      sourceId: 'source',
      key: 'widget',
      description: 'Public description',
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
      distTags: { latest: version },
      readme: { filename: 'README.md', body: '# Widget' },
      approval: held
        ? {
            id: `approval-${version}`,
            packageId: '',
            versionId: `version-${version}`,
            sourceId: 'source',
            holdApproval: true,
            holdScan: false,
            approvalState: 'pending',
            scanState: 'not_required',
            requiredScanners: [],
            requestedByType: 'service',
            requestedById: 'principal',
            tokenId: 'token',
            routeProjectId: 'project',
            distTags: { latest: version },
            readmePending: true,
            scanVerdicts: [],
            expiresAt: '2099-01-01T00:00:00.000Z',
          }
        : null,
      scanJobStatements: [],
      requirePublishApproval: held,
      routeProjectId: 'project',
      tokenId: 'token',
      now: NOW,
      event: {
        ...preparedEvent,
        id: ulid(),
        actor: { type: 'service_principal', id: 'principal' },
        target: { type: 'version', id: `version-${version}` },
        payloadJson: JSON.stringify({ changes: { version: { new: version } } }),
      },
    };
  }
  return {
    guard,
    input,
    writer: createCatalogueWriter(executor),
    reader: createCatalogueReader(executor),
    admin: createPackageAdminReader(executor),
  };
}

export function describeNpmPublishWriterContract(
  name: string,
  open: () => Promise<OpenedCatalogueWriteDatabase>,
) {
  async function run(
    body: (executor: SqlExecutor, w: Awaited<ReturnType<typeof world>>) => Promise<void>,
  ) {
    const opened = await open();
    try {
      await body(opened.executor, await world(opened.executor));
    } finally {
      await opened.close();
    }
  }
  describe(`npm publish writer on ${name}`, () => {
    async function held(e: SqlExecutor, w: Awaited<ReturnType<typeof world>>) {
      await e.batch([
        st('UPDATE source SET require_publish_approval=1'),
        st(
          "INSERT INTO user_account (id,org_id,email) VALUES ('approver','org','approver@example.test')",
        ),
        st(
          "INSERT INTO identity_provider_binding (org_id,provider,anchor) VALUES ('org','oidc','oidc:https://idp.example.test')",
        ),
        st(
          "INSERT INTO identity (id,org_id,user_id,provider,subject,email,email_verified,validated_at) VALUES ('approver-identity','org','approver','oidc','approver','approver@example.test',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        ),
        st(
          "INSERT INTO session (id,org_id,user_id,secret_hash,csrf_hash,expires_at,last_seen_at) VALUES ('session','org','approver',?,?,'2099-01-01T00:00:00.000Z',strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          'a'.repeat(64),
          'b'.repeat(64),
        ),
        st(
          "INSERT INTO role (id,org_id,key,name,scope) VALUES ('approver-role','org','approver','Approver','organization')",
        ),
        st("INSERT INTO role_permission VALUES ('org','approver-role','org:packages:approve')"),
        st(
          "INSERT INTO access_grant (id,org_id,role_id,scope,subject_type,subject_value) VALUES ('grant','org','approver-role','organization','email','approver@example.test')",
        ),
      ]);
      const result = await w.writer.publishVersion(ctx, w.guard, w.input(true));
      const repo = createPublishesRepository(e, [
        {
          provider: 'oidc',
          anchor: 'oidc:https://idp.example.test',
          emailAuthoritative: true,
          emailAuthoritativeDomains: ['example.test'],
        },
      ]);
      const fence = mutationFence(
        { userId: 'approver', sessionId: 'session' } as AuthenticatedActor,
        {},
      );
      const input = {
        id: result.approvalId!,
        expectedRevision: 1,
        expectedApprovalState: 'pending' as const,
        expectedScanState: 'not_required' as const,
        now: NOW,
        event: { ...w.input().event, id: ulid(), action: 'publish.approve' as const },
        decision: 'approved' as const,
        decidedByUserId: 'approver',
      };
      return { repo, fence, input, result };
    }
    it('package detail reads latest and explicit readmes with project visibility', () =>
      run(async (e, w) => {
        const published = await w.writer.publishVersion(ctx, w.guard, w.input());
        const repo = createPackageDetailRepository(e);
        const query = { packageId: published.packageId, projectId: 'project' };
        expect(await repo.packageName(ctx, published.packageId)).toBe('widget');
        expect(await repo.packageName(orgContext('foreign'), published.packageId)).toBeNull();
        expect(await repo.readme(ctx, query)).toEqual({ filename: 'README.md', body: '# Widget' });
        expect(await repo.readme(ctx, { ...query, version: '1.0.0' })).toEqual({
          filename: 'README.md',
          body: '# Widget',
        });
        expect(await repo.readme(ctx, { ...query, version: 'missing' })).toBeNull();
        const second = w.input(false, '2.0.0');
        await w.writer.publishVersion(ctx, w.guard, {
          ...second,
          readme: { filename: 'README.txt', body: 'Second' },
        });
        expect(await repo.readme(ctx, query)).toEqual({ filename: 'README.txt', body: 'Second' });
        expect(await repo.readme(ctx, { ...query, version: '1.0.0' })).toEqual({
          filename: 'README.md',
          body: '# Widget',
        });
        await e.batch([st("DELETE FROM dist_tag WHERE org_id='org' AND tag='latest'")]);
        expect(await repo.readme(ctx, query)).toBeNull();
        expect(await repo.readme(ctx, { ...query, version: '2.0.0' })).toEqual({
          filename: 'README.txt',
          body: 'Second',
        });
        expect(await repo.readme(orgContext('foreign'), query)).toBeNull();
        await e.batch([st("DELETE FROM project_package WHERE org_id='org'")]);
        expect(await repo.readme(ctx, query)).toBeNull();
      }));
    it('package detail masks inactive readmes and does not substitute another latest', () =>
      run(async (e, w) => {
        const published = await w.writer.publishVersion(ctx, w.guard, w.input());
        const repo = createPackageDetailRepository(e);
        const query = { packageId: published.packageId, projectId: 'project' };
        await e.batch([st("UPDATE version SET status='quarantined'")]);
        expect(await repo.readme(ctx, query)).toBeNull();
        expect(await repo.readme(ctx, { ...query, version: '1.0.0' })).toBeNull();
      }));
    it('package access requires the source owning project authority', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        const repo = createPackageDetailRepository(e, [
          {
            provider: 'oidc',
            anchor: 'oidc:https://idp.example.test',
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test'],
          },
        ]);
        await e.batch([
          st("INSERT INTO cache_epoch (org_id,version) VALUES ('org','epoch')"),
          st("UPDATE source SET project_id='project' WHERE id='source'"),
          st("INSERT INTO role_permission VALUES ('org','approver-role','org:sources:write')"),
        ]);
        const input = {
          packageId: h.result.packageId,
          visibleToNewProjects: false,
          newProjectAccessMode: 'request' as const,
          revision: 2,
          audit: { ...w.input().event, id: ulid(), action: 'package.access_update' as const },
        };
        expect(await repo.setAccess(ctx, h.fence, input)).toEqual({
          ok: false,
          error: 'forbidden',
        });
        await e.batch([
          st(
            "INSERT INTO role (id,org_id,key,name,scope) VALUES ('project-admin','org','project_admin','Project admin','project')",
          ),
          ...DEFAULT_ROLES.find((role) => role.key === 'project_owner')!.permissions.map(
            (permission) =>
              st("INSERT INTO role_permission VALUES ('org','project-admin',?)", permission),
          ),
          st(
            "INSERT INTO access_grant (id,org_id,role_id,scope,project_id,subject_type,subject_value) VALUES ('project-grant','org','project-admin','project','project','email','approver@example.test')",
          ),
        ]);
        expect(await repo.setAccess(ctx, h.fence, input)).toEqual({ ok: true });
        const [row] = await e.all<{ payload_json: string }>(
          st("SELECT payload_json FROM audit_pending WHERE action='package.access_update'"),
        );
        expect(JSON.parse(row!.payload_json)).toEqual(
          expect.objectContaining({
            changes: {
              visible_to_new_projects: { old: true, new: false },
              new_project_access_mode: { old: 'none', new: 'request' },
            },
          }),
        );
        let moved = false;
        const moving: SqlExecutor = {
          ...e,
          all: async <T>(statement: Statement) => {
            const rows = await e.all<T>(statement);
            if (!moved && statement.sql.startsWith('select source.project_id')) {
              moved = true;
              await e.batch([st("UPDATE source SET project_id=NULL WHERE id='source'")]);
            }
            return rows;
          },
        };
        expect(
          await createPackageDetailRepository(moving, [
            {
              provider: 'oidc',
              anchor: 'oidc:https://idp.example.test',
              emailAuthoritative: true,
              emailAuthoritativeDomains: ['example.test'],
            },
          ]).setAccess(ctx, h.fence, {
            ...input,
            revision: 3,
            audit: { ...input.audit, id: ulid() },
          }),
        ).toEqual({ ok: false, error: 'conflict' });
      }));
    it('package access is revision fenced, audited atomically and authority checked', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.batch([st("INSERT INTO cache_epoch (org_id,version) VALUES ('org','epoch')")]);
        await e.batch([
          st("INSERT INTO role_permission VALUES ('org','approver-role','org:sources:write')"),
        ]);
        const repo = createPackageDetailRepository(e, [
          {
            provider: 'oidc',
            anchor: 'oidc:https://idp.example.test',
            emailAuthoritative: true,
            emailAuthoritativeDomains: ['example.test'],
          },
        ]);
        const input = {
          packageId: h.result.packageId,
          visibleToNewProjects: false,
          newProjectAccessMode: 'request' as const,
          revision: 2,
          idempotency: {
            principalKey: 'user:approver',
            key: 'access',
            route: 'PATCH /_pb/packages/:package/access',
            requestHash: 'a'.repeat(64),
            status: 200,
            responseJson: '{}',
            createdAt: NOW,
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          audit: { ...w.input().event, id: ulid(), action: 'package.access_update' as const },
        };
        expect(await repo.setAccess(ctx, h.fence, input)).toEqual({ ok: true });
        expect(
          await e.all(
            st("SELECT count(*) n FROM api_idempotency WHERE org_id='org' AND key='access'"),
          ),
        ).toEqual([{ n: 1 }]);
        expect(
          await e.all(
            st('SELECT visible_to_new_projects, new_project_access_mode, rev FROM package'),
          ),
        ).toEqual([{ visible_to_new_projects: 0, new_project_access_mode: 'request', rev: 3 }]);
        expect(
          await e.all(
            st("SELECT count(*) n FROM audit_pending WHERE action='package.access_update'"),
          ),
        ).toEqual([{ n: 1 }]);
        expect(
          await repo.setAccess(ctx, h.fence, {
            ...input,
            idempotency: { ...input.idempotency, key: 'stale' },
            audit: { ...input.audit, id: ulid() },
          }),
        ).toEqual({ ok: false, error: 'conflict' });
        await expect(
          repo.setAccess(ctx, h.fence, { ...input, visibleToNewProjects: true }),
        ).rejects.toThrow('invalid package access');
        for (const invalid of [
          { ...input, visibleToNewProjects: 'yes' as never },
          { ...input, newProjectAccessMode: 'invalid' as never },
          { ...input, revision: 0 },
          { ...input, revision: 1.5 },
        ])
          await expect(repo.setAccess(ctx, h.fence, invalid)).rejects.toThrow(
            'invalid package access',
          );
        expect(await repo.setAccess(orgContext('foreign'), h.fence, input)).toEqual({
          ok: false,
          error: 'not_found',
        });
        await e.batch([
          st(
            "CREATE TRIGGER reject_access_audit BEFORE INSERT ON audit_pending WHEN NEW.action='package.access_update' BEGIN SELECT RAISE(ABORT, 'test audit failure'); END",
          ),
        ]);
        expect(
          await repo.setAccess(ctx, h.fence, {
            ...input,
            revision: 3,
            idempotency: { ...input.idempotency, key: 'rollback' },
            audit: { ...input.audit, id: ulid() },
          }),
        ).toEqual({ ok: false, error: 'unavailable' });
        expect(await e.all(st('SELECT rev FROM package'))).toEqual([{ rev: 3 }]);
        expect(
          await e.all(st("SELECT count(*) n FROM api_idempotency WHERE key='rollback'")),
        ).toEqual([{ n: 0 }]);
        await e.batch([st('DROP TRIGGER reject_access_audit')]);
        await e.batch([st("DELETE FROM role_permission WHERE permission='org:sources:write'")]);
        expect(
          await repo.setAccess(ctx, h.fence, {
            ...input,
            revision: 3,
            idempotency: { ...input.idempotency, key: 'revoked' },
            audit: { ...input.audit, id: ulid() },
          }),
        ).toEqual({
          ok: false,
          error: 'forbidden',
        });
        expect(
          await e.all(
            st("SELECT count(*) n FROM audit_pending WHERE action='package.access_update'"),
          ),
        ).toEqual([{ n: 1 }]);
      }));
    it('unheld publication attribution survives audit sealing and tags remain version specific', () =>
      run(async (e, w) => {
        const input = w.input();
        const published = await w.writer.publishVersion(ctx, w.guard, input);
        expect(
          await e.all(
            st(
              "SELECT target_type,target_id,payload_json FROM audit_pending WHERE action='package.publish'",
            ),
          ),
        ).toEqual([
          {
            target_type: 'version',
            target_id: published.versionId,
            payload_json: JSON.stringify({ changes: { version: { new: '1.0.0' } } }),
          },
        ]);
        const query = { packageId: published.packageId, projectId: null, limit: 10 };
        expect((await w.admin.listVersions(ctx, query))?.items[0]).toMatchObject({
          publishedBy: { kind: 'service', displayName: 'Publisher' },
          approvedBy: null,
        });
        await e.batch([
          st(
            "INSERT INTO audit_event (id,org_id,seq,prev_hash,hash,created_at,actor_type,actor_id,action,target_type,target_id,payload_json) SELECT id,org_id,1,?,?,created_at,actor_type,actor_id,action,target_type,target_id,payload_json FROM audit_pending WHERE action='package.publish'",
            'a'.repeat(64),
            'b'.repeat(64),
          ),
          st("DELETE FROM audit_pending WHERE action='package.publish'"),
        ]);
        expect((await w.admin.listVersions(ctx, query))?.items[0]?.publishedBy).toEqual({
          kind: 'service',
          displayName: 'Publisher',
        });
        await w.writer.publishVersion(ctx, w.guard, w.input(false, '2.0.0'));
        expect((await w.admin.listVersions(ctx, query))?.items.map((v) => v.distTags)).toEqual([
          [],
          ['latest'],
        ]);
      }));
    it('version detail returns integrity, current tags and redacted publication attribution', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await h.repo.decide(ctx, h.fence, h.input);
        await e.batch([st("UPDATE user_account SET display_name='Approver' WHERE id='approver'")]);
        const page = await w.admin.listVersions(ctx, {
          packageId: h.result.packageId,
          projectId: null,
          limit: 10,
        });
        expect(page?.items[0]).toMatchObject({
          integrity: w.input().integrity,
          distTags: ['latest'],
          publishedBy: { kind: 'service', displayName: 'Publisher' },
          approvedBy: { displayName: 'Approver', decidedAt: NOW },
        });
        await e.batch([
          st("UPDATE user_account SET display_name=email WHERE id='approver'"),
          st("UPDATE service_principal SET name='publisher@example.test'"),
        ]);
        const redacted = await w.admin.listVersions(ctx, {
          packageId: h.result.packageId,
          projectId: null,
          limit: 10,
        });
        expect(redacted?.items[0]).toMatchObject({
          publishedBy: { displayName: 'Service principal' },
          approvedBy: { displayName: 'User' },
        });
        expect(JSON.stringify(redacted)).not.toContain('@');
      }));
    it.each([
      ['pending', 'not_required', true],
      ['approved', 'not_required', false],
      ['rejected', 'not_required', false],
      ['expired', 'not_required', false],
      ['approved', 'queued', true],
      ['approved', 'running', true],
      ['approved', 'failed', true],
      ['approved', 'allowed', false],
      ['approved', 'denied', false],
    ] as const)(
      'management gates %s/%s only while unresolved',
      (approvalState, scanState, blocked) =>
        run(async (e, w) => {
          const h = await held(e, w);
          await e.batch([
            st("INSERT INTO cache_epoch(org_id,version) VALUES ('org','epoch')"),
            st(
              'UPDATE publish_approval SET approval_state=?,scan_state=?,hold_scan=?,decided_by_user_id=?,decided_at=?',
              approvalState,
              scanState,
              scanState === 'not_required' ? 0 : 1,
              ['approved', 'rejected'].includes(approvalState) ? 'approver' : null,
              approvalState === 'pending' ? null : NOW,
            ),
            st('UPDATE package SET held_until_active=0'),
            st("INSERT INTO role_permission VALUES ('org','approver-role','org:packages:manage')"),
            st("INSERT INTO role_permission VALUES ('org','approver-role','org:sources:write')"),
          ]);
          const packageId = h.result.packageId;
          const versionId = 'version-1.0.0';
          expect(
            (await w.admin.findManagedVersion(ctx, { packageId, versionId, projectId: null }))
              ?.publishGate ?? false,
          ).toBe(blocked);
          const anchors = [
            {
              provider: 'oidc',
              anchor: 'oidc:https://idp.example.test',
              emailAuthoritative: true,
              emailAuthoritativeDomains: ['example.test'],
            },
          ];
          const store = createVisibilityStore(e, { providerAnchors: anchors });
          const base = {
            packageId,
            versionId,
            manage: { kind: 'organization' as const },
            audit: h.input.event,
          };
          for (const method of [
            'releaseQuarantine',
            'quarantineVersion',
            'tombstoneVersion',
          ] as const) {
            const expectedStatus =
              method === 'quarantineVersion' ? ('active' as const) : ('quarantined' as const);
            await e.all(st('UPDATE version SET status=?', expectedStatus));
            const result = await store[method](ctx, h.fence, {
              ...base,
              audit: { ...h.input.event, id: ulid() },
              expectedStatus,
              reason: method === 'quarantineVersion' ? 'admin_quarantine' : 'admin_tombstone',
            } as never);
            expect(result.ok).toBe(!blocked);
            if (blocked) expect(result).toMatchObject({ reason: 'publish_gate' });
          }
          await e.all(st("UPDATE version SET status='quarantined'"));
          const result = await createCatalogueStatusRepository(e, {
            providerAnchors: anchors,
          }).releaseQuarantine(ctx, h.fence, { versionId });
          expect(result.ok).toBe(!blocked);
          if (blocked) expect(result).toMatchObject({ reason: 'publish_gate' });
        }),
    );
    it('late approval preserves a quarantined newer latest', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.all(st('UPDATE source SET require_publish_approval=0'));
        await w.writer.publishVersion(ctx, w.guard, w.input(false, '2.0.0'));
        await e.all(st("UPDATE version SET status='quarantined' WHERE version='2.0.0'"));
        expect(await h.repo.decide(ctx, h.fence, h.input)).toMatchObject({ changed: true });
        expect(await e.all(st("SELECT version_id FROM dist_tag WHERE tag='latest'"))).toEqual([
          { version_id: 'version-2.0.0' },
        ]);
      }));
    it('lists fifty inspections in one bounded statement', () =>
      run(async (e, w) => {
        await held(e, w);
        for (let i = 1; i < 50; i++)
          await w.writer.publishVersion(ctx, w.guard, w.input(true, `1.0.${i}`));
        let count = 0;
        const statements: Statement[] = [];
        const counted = {
          ...e,
          all: async <R>(statement: Statement) => {
            count++;
            statements.push(statement);
            return e.all<R>(statement);
          },
          batch: e.batch.bind(e),
        };
        const page = await createPublishesRepository(counted).list(ctx, { limit: 50 });
        expect(page.items).toHaveLength(50);
        expect(count).toBe(1);
        expect(statements[0]!.sql).toMatch(/limit \?/);
        expect(statements[0]!.params.at(-1)).toBe(51);
      }));
    it.each(['rejected', 'expired'] as const)(
      '%s does not schedule purge for a shared active blob',
      (state) =>
        run(async (e, w) => {
          const h = await held(e, w);
          await e.all(st('UPDATE source SET require_publish_approval=0'));
          await w.writer.publishVersion(ctx, w.guard, w.input(false, '2.0.0'));
          if (state === 'rejected')
            await h.repo.decide(ctx, h.fence, {
              ...h.input,
              decision: 'rejected',
              reason: 'Policy',
            });
          else {
            await e.all(st("UPDATE publish_approval SET expires_at='2000-01-01T00:00:00.000Z'"));
            await h.repo.expire(
              ctx,
              systemMutationFence('verifier', { id: 'job', owner: 'owner', fence: 1 }, {}),
              h.input,
            );
          }
          expect(await e.all(st('SELECT purge_after FROM blob'))).toEqual([{ purge_after: null }]);
        }),
    );
    it('approval activates version, readme, description and tags atomically', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.all(
          st(
            "UPDATE version SET metadata_json=json_set(metadata_json,'$.description','Approved description')",
          ),
        );
        expect(await h.repo.decide(ctx, h.fence, h.input)).toEqual({
          changed: true,
          active: true,
          revision: 2,
        });
        expect(await e.all(st('SELECT status FROM version'))).toEqual([{ status: 'active' }]);
        expect(await e.all(st('SELECT held_until_active,description FROM package'))).toEqual([
          { held_until_active: 0, description: 'Approved description' },
        ]);
        expect((await w.reader.distTags(ctx, ref))?.tags).toEqual({ latest: '1.0.0' });
        expect(await createPackageReadmeReader(e).get(ctx, ref)).toEqual({
          filename: 'README.md',
          body: '# Widget',
        });
        expect(
          await h.repo.decide(ctx, h.fence, {
            ...h.input,
            decision: 'rejected',
            reason: 'Rejected',
            event: { ...h.input.event, id: ulid() },
          }),
        ).toMatchObject({ changed: false });
        expect(await e.all(st('SELECT count(*) n FROM audit_pending'))).toEqual([{ n: 2 }]);
      }));
    for (const [label, change] of [
      ['stale revision', 'UPDATE publish_approval SET revision=2'],
      ['changed scan state', "UPDATE publish_approval SET hold_scan=1,scan_state='allowed'"],
      ['non-quarantined version', "UPDATE version SET status='active'"],
      [
        'self approval',
        "UPDATE publish_approval SET requested_by_type='user',requested_by_id='approver'",
      ],
      ['expired request', "UPDATE publish_approval SET expires_at='2000-01-01T00:00:00.000Z'"],
      ['revoked session', "UPDATE session SET revoked_at='2000-01-01T00:00:00.000Z'"],
      ['lost permission', 'DELETE FROM role_permission'],
    ])
      it(`approval refuses ${label} without side effects`, () =>
        run(async (e, w) => {
          const h = await held(e, w);
          await e.all(st(change!));
          const before = await e.all(st('SELECT * FROM publish_approval'));
          const beforePackage = await e.all(st('SELECT * FROM package'));
          const beforeBlob = await e.all(st('SELECT * FROM blob'));
          const beforeVersion = await e.all(st('SELECT * FROM version'));
          expect(await h.repo.decide(ctx, h.fence, h.input)).toMatchObject({ changed: false });
          expect(await e.all(st('SELECT * FROM publish_approval'))).toEqual(before);
          expect(await e.all(st('SELECT * FROM package'))).toEqual(beforePackage);
          expect(await e.all(st('SELECT * FROM blob'))).toEqual(beforeBlob);
          expect(await e.all(st('SELECT * FROM version'))).toEqual(beforeVersion);
          expect(await e.all(st('SELECT count(*) n FROM audit_pending'))).toEqual([{ n: 1 }]);
          expect(await e.all(st('SELECT count(*) n FROM dist_tag'))).toEqual([{ n: 0 }]);
        }));
    it('approval preserves the scan hold', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.all(st("UPDATE publish_approval SET hold_scan=1,scan_state='queued'"));
        expect(
          await h.repo.decide(ctx, h.fence, { ...h.input, expectedScanState: 'queued' }),
        ).toEqual({ changed: true, active: false, revision: 2 });
        expect(await e.all(st('SELECT status FROM version'))).toEqual([{ status: 'quarantined' }]);
        expect(await e.all(st('SELECT count(*) n FROM dist_tag'))).toEqual([{ n: 0 }]);
      }));
    it('reject tombstones and schedules blob purge in seven days', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        expect(
          await h.repo.decide(ctx, h.fence, {
            ...h.input,
            decision: 'rejected',
            reason: 'Policy refusal',
            event: { ...h.input.event, action: 'publish.reject' },
          }),
        ).toMatchObject({ changed: true, active: false });
        expect(
          await e.all(st('SELECT status,tombstone_reason,tombstoned_at FROM version')),
        ).toEqual([{ status: 'tombstoned', tombstone_reason: 'rejected', tombstoned_at: NOW }]);
        expect(await e.all(st('SELECT purge_after FROM blob'))).toEqual([
          { purge_after: '2026-11-06T00:00:00.000Z' },
        ]);
      }));
    it('expiry is due-only, leased, revision-guarded and audited once', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        const fence = systemMutationFence('verifier', { id: 'job', owner: 'owner', fence: 1 }, {});
        expect(await h.repo.expire(ctx, fence, h.input)).toMatchObject({ changed: false });
        await e.all(st("UPDATE publish_approval SET expires_at='2000-01-01T00:00:00.000Z'"));
        expect(
          await h.repo.expire(ctx, fence, {
            ...h.input,
            event: { ...h.input.event, action: 'publish.expire' },
          }),
        ).toEqual({ changed: true, active: false, revision: 2 });
        expect(await h.repo.expire(ctx, fence, h.input)).toMatchObject({ changed: false });
        expect(await e.all(st('SELECT status,tombstone_reason FROM version'))).toEqual([
          { status: 'tombstoned', tombstone_reason: 'expired' },
        ]);
        expect(await e.all(st('SELECT count(*) n FROM audit_pending'))).toEqual([{ n: 2 }]);
      }));
    it('late approval keeps a newer latest and its description', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.all(st('UPDATE source SET require_publish_approval=0'));
        await w.writer.publishVersion(ctx, w.guard, w.input(false, '2.0.0'));
        expect(await h.repo.decide(ctx, h.fence, h.input)).toMatchObject({
          changed: true,
          active: true,
        });
        expect((await w.reader.distTags(ctx, ref))?.tags).toEqual({ latest: '2.0.0' });
        expect(await e.all(st('SELECT description FROM package'))).toEqual([
          { description: 'Public description' },
        ]);
      }));
    it('rejected hosted blobs remain eligible for their scheduled purge', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await h.repo.decide(ctx, h.fence, {
          ...h.input,
          decision: 'rejected',
          reason: 'Policy refusal',
        });
        const reader = createBlobReferenceReader(e);
        expect(await reader.stillEligible(ctx, 'a'.repeat(64))).toBe(true);
        expect(await reader.scheduledIneligible(ctx, { limit: 10 })).toEqual([]);
      }));
    it('expired page is organization-scoped and capped at ten', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        for (let i = 1; i <= 10; i++)
          await w.writer.publishVersion(ctx, w.guard, w.input(true, `1.0.${i}`));
        expect(await h.repo.listExpired(ctx, NOW)).toEqual([]);
        await e.all(st("UPDATE publish_approval SET expires_at='2000-01-01T00:00:00.000Z'"));
        expect(await h.repo.listExpired(ctx, NOW)).toHaveLength(10);
        expect(await h.repo.listExpired(orgContext('other'), NOW)).toEqual([]);
        expect((await h.repo.list(ctx, { limit: 2, state: 'pending' })).next).not.toBeNull();
        const first = await h.repo.list(ctx, { limit: 2 });
        const next = await h.repo.list(ctx, { limit: 2, cursor: first.next! });
        expect(next.items.some((item) => first.items.some((prior) => prior.id === item.id))).toBe(
          false,
        );
        let continued = 0;
        await createPublishApprovalExpireJob({ publishes: h.repo }).handler({}, {
          org: ctx,
          jobId: 'job',
          idempotencyKey: 'expiry',
          attempt: 1,
          fence: 1,
          signal: new AbortController().signal,
          fences: jobFences({ id: 'job', owner: 'owner', fence: 1 }),
          ports: {
            clock: fixedClock(NOW),
            ids: { ulid },
            platform: {
              jobs: {
                enqueue: async () => {
                  continued++;
                  return { id: 'continuation', created: true };
                },
              },
            },
          },
        } as never);
        expect(
          await e.all(st("SELECT count(*) n FROM publish_approval WHERE approval_state='expired'")),
        ).toEqual([{ n: 10 }]);
        expect(continued).toBe(1);
        const audits = await e.all<{ payload_json: string }>(
          st("SELECT payload_json FROM audit_pending WHERE action='publish.expire'"),
        );
        expect(audits).toHaveLength(10);
        for (const audit of audits)
          expect(JSON.parse(audit.payload_json)).toMatchObject({
            changes: { package: { new: 'widget' }, version: { new: expect.any(String) } },
          });
      }));
    it('expiry refuses a lost job lease', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.all(st("UPDATE publish_approval SET expires_at='2000-01-01T00:00:00.000Z'"));
        await e.all(st('UPDATE job SET fence=2'));
        await expect(
          h.repo.expire(
            ctx,
            systemMutationFence('verifier', { id: 'job', owner: 'owner', fence: 1 }, {}),
            h.input,
          ),
        ).rejects.toThrow();
        expect((await h.repo.get(ctx, h.input.id))?.approvalState).toBe('pending');
        expect(await e.all(st('SELECT count(*) n FROM audit_pending'))).toEqual([{ n: 1 }]);
      }));
    it('decisions are scoped to the organization', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        expect(await h.repo.decide(orgContext('other'), h.fence, h.input)).toMatchObject({
          changed: false,
        });
        expect((await h.repo.get(ctx, h.input.id))?.approvalState).toBe('pending');
      }));
    it('rejection requires a nonempty reason of at most 1000 UTF-8 bytes', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        for (const reason of [
          '',
          'é'.repeat(501),
          'https://user:password@example.test/archive',
          'person@example.test',
        ])
          await expect(
            h.repo.decide(ctx, h.fence, { ...h.input, decision: 'rejected', reason }),
          ).rejects.toThrow('invalid_decision_reason');
        expect((await h.repo.get(ctx, h.input.id))?.approvalState).toBe('pending');
      }));
    it('publisher role bootstrap is insert-only and audited on each backend', () =>
      run(async (e) => {
        await e.all(st("INSERT INTO cache_epoch(org_id,version) VALUES ('org','epoch')"));
        const ids = Object.fromEntries(DEFAULT_ROLES.map((role) => [role.key, ulid()])) as Record<
          DefaultRoleKey,
          string
        >;
        const input = {
          email: 'bootstrap@example.test',
          userId: ulid(),
          setupHash: 'a'.repeat(64),
          setupExpiresAt: '2099-01-01T00:00:00.000Z',
          grantId: ulid(),
          roleIds: ids,
          opId: ulid(),
          now: NOW,
        };
        await bootstrapAdmin(e, ctx, input);
        expect(
          await e.all(st("SELECT count(*) n FROM audit_pending WHERE action='role.create'")),
        ).toEqual([{ n: 0 }]);
        await e.all(st("DELETE FROM role WHERE org_id='org' AND key='organization_publisher'"));
        await bootstrapAdmin(e, ctx, input);
        await e.all(
          st(
            "UPDATE role SET name='Preserved' WHERE key='organization_publisher' AND org_id='org'",
          ),
        );
        await bootstrapAdmin(e, ctx, input);
        expect(
          await e.all(
            st("SELECT name FROM role WHERE org_id='org' AND key='organization_publisher'"),
          ),
        ).toEqual([{ name: 'Preserved' }]);
        expect(
          await e.all(st("SELECT count(*) n FROM audit_pending WHERE action='role.create'")),
        ).toEqual([{ n: 1 }]);
      }));
    it('exports safe display names without account e-mails or credentials', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.all(
          st("UPDATE service_principal SET name='https://user:password@example.test/archive'"),
        );
        await e.all(st("UPDATE source SET name='person@example.test'"));
        const item = await h.repo.get(ctx, h.input.id);
        expect(item?.requestedBy.name).toBe('Service');
        expect(item?.sourceName).toBe('Source');
        expect(JSON.stringify(item)).not.toContain('password');
        expect(JSON.stringify(item)).not.toContain('example.test');
      }));
    it('concurrent approve and reject record exactly one decision', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        const outcomes = await Promise.all([
          h.repo.decide(ctx, h.fence, h.input),
          h.repo.decide(ctx, h.fence, {
            ...h.input,
            decision: 'rejected',
            reason: 'Policy refusal',
            event: { ...h.input.event, id: ulid(), action: 'publish.reject' },
          }),
        ]);
        expect(outcomes.filter((result) => result.changed)).toHaveLength(1);
        expect(
          await e.all(
            st(
              "SELECT count(*) n FROM audit_pending WHERE action IN ('publish.approve','publish.reject')",
            ),
          ),
        ).toEqual([{ n: 1 }]);
      }));
    for (const decision of ['approve', 'reject'] as const)
      it(`approval API ${decision} has the same HTTP contract on both runtimes`, () =>
        run(async (e, w) => {
          const h = await held(e, w);
          const id = ulid();
          await e.all(st('UPDATE publish_approval SET id=? WHERE id=?', id, h.input.id));
          const csrf = 'B'.repeat(43),
            csrfHash = await sha256Hex(csrf);
          const engine = createAuthorizationEngine({
            access: {
              lookupSession: async () => ({
                session: { id: 'session', csrfHash },
                user: { id: 'approver' },
                identity: null,
                protectedHolder: false,
                project: null,
                organizationPermissions: ['org:packages:read', 'org:packages:approve'],
                projectPermissions: [],
              }),
              lookupToken: async () => null,
              touchSession: async () => true,
              touchToken: async () => true,
            },
            tokenUse: {
              keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
              nowMs: () => 0,
              dispatch: () => undefined,
              log: () => undefined,
            },
            patValidation: patValidationGate,
            publicOrigin: 'https://broker.test',
            providerAnchors: async () => [],
          });
          const kernel = await createKernel({
            platform: name === 'd1' ? 'cloudflare' : 'node',
            plugins: [],
            ports: {
              organizations: { get: async () => null },
              clock: fixedClock(NOW),
              ids: { ulid },
            },
            resolveOrg: async () => ctx,
            health: async () => true,
            log: () => undefined,
            authorization: engine,
            coreRoutes: publishRoutes({
              publishes: h.repo,
              clock: fixedClock(NOW),
              ids: { ulid },
              clientIp: () => null,
            }),
          });
          const call = (path: string, method = 'GET', match?: string) =>
            kernel.fetch(
              new Request('https://broker.test' + path, {
                method,
                headers: {
                  cookie: `__Host-pb_session=${'A'.repeat(43)}; __Host-pb_csrf=${csrf}`,
                  origin: 'https://broker.test',
                  ...(method === 'POST'
                    ? { 'content-type': 'application/json', 'x-csrf-token': csrf }
                    : {}),
                  ...(match ? { 'if-match': match } : {}),
                },
                ...(method === 'POST'
                  ? {
                      body: JSON.stringify(
                        decision === 'reject' ? { reason: 'Policy refusal' } : {},
                      ),
                    }
                  : {}),
              }),
            );
          const listed = await call('/_pb/publishes?state=pending');
          expect(listed.status).toBe(200);
          expect(((await listed.json()) as { items: { id: string }[] }).items[0]?.id).toBe(id);
          const inspected = await call('/_pb/publishes/' + id);
          expect(inspected.status).toBe(200);
          expect(inspected.headers.get('etag')).toBe('"r1"');
          expect((await call(`/_pb/publishes/${id}/${decision}`, 'POST')).status).toBe(428);
          const decided = await call(`/_pb/publishes/${id}/${decision}`, 'POST', '"r1"');
          expect(decided.status).toBe(200);
          expect(decided.headers.get('etag')).toBe('"r2"');
          expect((await call(`/_pb/publishes/${id}/${decision}`, 'POST', '"r1"')).status).toBe(409);
          expect(
            await e.all(
              st(
                "SELECT count(*) n FROM audit_pending WHERE action IN ('publish.approve','publish.reject')",
              ),
            ),
          ).toEqual([{ n: 1 }]);
        }));
    it('refuses decisions for a different actor or fence kind', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        const system = systemMutationFence('verifier', { id: 'job', owner: 'owner', fence: 1 }, {});
        await expect(h.repo.decide(ctx, system, h.input)).rejects.toThrow('invalid_publish_fence');
        await expect(h.repo.expire(ctx, h.fence, h.input)).rejects.toThrow('invalid_publish_fence');
        await expect(
          h.repo.expire(
            ctx,
            systemMutationFence('purge', { id: 'job', owner: 'owner', fence: 1 }, {}),
            h.input,
          ),
        ).rejects.toThrow('invalid_publish_fence');
        await expect(
          h.repo.decide(ctx, h.fence, { ...h.input, decidedByUserId: 'different' }),
        ).rejects.toThrow('invalid_publish_actor');
      }));
    it('refuses an already decided approval even while the scan holds it', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.all(
          st(
            "UPDATE publish_approval SET hold_scan=1,scan_state='queued',approval_state='approved',decided_by_user_id='approver',decided_at='2026-10-30T00:00:00.000Z'",
          ),
        );
        expect(
          await h.repo.decide(ctx, h.fence, {
            ...h.input,
            expectedApprovalState: 'approved',
            expectedScanState: 'queued',
          }),
        ).toMatchObject({ changed: false });
      }));
    it('fences a latest change between inspection and the decision batch', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.all(st('UPDATE source SET require_publish_approval=0'));
        const raced = createPublishesRepository(
          {
            ...e,
            batch: async (statements) => {
              await w.writer.publishVersion(ctx, w.guard, w.input(false, '2.0.0'));
              return e.batch(statements);
            },
          },
          [
            {
              provider: 'oidc',
              anchor: 'oidc:https://idp.example.test',
              emailAuthoritative: true,
              emailAuthoritativeDomains: ['example.test'],
            },
          ],
        );
        expect(await raced.decide(ctx, h.fence, h.input)).toMatchObject({ changed: false });
        expect((await h.repo.get(ctx, h.input.id))?.approvalState).toBe('pending');
        expect((await w.reader.distTags(ctx, ref))?.tags).toEqual({ latest: '2.0.0' });
      }));
    it('self-rejection does not use the self-approval refusal', () =>
      run(async (e, w) => {
        const h = await held(e, w);
        await e.all(
          st("UPDATE publish_approval SET requested_by_type='user',requested_by_id='approver'"),
        );
        expect(
          await h.repo.decide(ctx, h.fence, {
            ...h.input,
            decision: 'rejected',
            reason: 'Rejected by requester',
          }),
        ).toMatchObject({ changed: true, active: false });
      }));
    it('resolves the package audit target inside the publication batch', () =>
      run(async (e, w) => {
        const input = w.input();
        const result = await w.writer.publishVersion(ctx, w.guard, {
          ...input,
          event: { ...input.event, target: { type: 'package', id: ulid() } },
        });
        expect(await e.all(st('SELECT target_id FROM audit_pending'))).toEqual([
          { target_id: result.packageId },
        ]);
      }));
    it('records the service actor in tag history', () =>
      run(async (e, w) => {
        const input = w.input();
        await w.writer.publishVersion(ctx, w.guard, input);
        expect(await e.all(st('SELECT actor_type,actor_id FROM dist_tag_history'))).toEqual([
          { actor_type: 'service', actor_id: input.event.actor.id },
        ]);
      }));
    it('changes description only when latest moves and preserves null', () =>
      run(async (e, w) => {
        await w.writer.publishVersion(ctx, w.guard, w.input());
        await w.writer.publishVersion(ctx, w.guard, {
          ...w.input(false, '2.0.0'),
          description: 'Next',
          distTags: { next: '2.0.0' },
        });
        expect(await e.all(st('SELECT description FROM package'))).toEqual([
          { description: 'Public description' },
        ]);
        await w.writer.publishVersion(ctx, w.guard, {
          ...w.input(false, '3.0.0'),
          description: null,
        });
        expect(await e.all(st('SELECT description FROM package'))).toEqual([{ description: null }]);
      }));
    it('hides held packages from findManagedVersion at both scopes', () =>
      run(async (e, w) => {
        await e.all(st('UPDATE source SET require_publish_approval=1'));
        const result = await w.writer.publishVersion(ctx, w.guard, w.input(true));
        for (const projectId of [null, 'project'])
          expect(
            await w.admin.findManagedVersion(ctx, {
              packageId: result.packageId,
              versionId: result.versionId,
              projectId,
            }),
          ).toBeNull();
      }));
    it('accepts a selected-project PAT with organization-granted project write', () =>
      run(async (e, w) => {
        await e.batch([
          st('DELETE FROM token'),
          st(
            "INSERT INTO identity_provider_binding (org_id,provider,anchor) VALUES ('org','oidc','oidc:https://idp.example.test')",
          ),
          st(
            "INSERT INTO identity (id,org_id,user_id,provider,subject,email,email_verified,validated_at) VALUES ('identity','org','user','oidc','subject','test@example.test',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
          ),
          st(
            "INSERT INTO role (id,org_id,key,scope,name) VALUES ('publisher','org','publisher','organization','Publisher')",
          ),
          st(
            "INSERT INTO role_permission (org_id,role_id,permission) VALUES ('org','publisher','project:packages:write')",
          ),
          st(
            "INSERT INTO access_grant (id,org_id,subject_type,subject_value,scope,role_id) VALUES ('grant','org','email','test@example.test','organization','publisher')",
          ),
          st(
            "INSERT INTO token (id,org_id,kind,user_id,selector,hash,pepper_version,name,project_mode,scopes_json,expires_at,validation_kind,validation_identity_id) VALUES ('token','org','pat','user','abcdefghijkl',?,1,'publish','selected','[\"write\"]','2099-01-01T00:00:00.000Z','sso','identity')",
            'b'.repeat(64),
          ),
          st(
            "INSERT INTO token_project (org_id,token_id,project_id) VALUES ('org','token','project')",
          ),
        ]);
        const guard = createPublishWriteGuard(
          ctx,
          {
            tokenId: 'token',
            selector: 'abcdefghijkl',
            projectSlug: 'project',
            routeProjectId: 'project',
            sourceId: 'source',
            key: 'widget',
          },
          [
            {
              provider: 'oidc',
              anchor: 'oidc:https://idp.example.test',
              emailAuthoritative: true,
              emailAuthoritativeDomains: ['example.test'],
            },
          ],
        );
        expect((await w.writer.publishVersion(ctx, guard, w.input())).versionId).toBe(
          'version-1.0.0',
        );
      }));
    for (const cause of [
      'approval row presence',
      'approval hold flag',
      'approval state',
      'scan state',
      'version binding',
      'source binding',
      'token binding',
      'tag snapshot',
      'missing scanners',
      'missing scan jobs',
      'unexpected scan jobs',
    ] as const) {
      it(`diagnoses invalid publish hold: ${cause}`, () =>
        run(async (_e, w) => {
          const input = w.input(true);
          const approval = { ...input.approval! };
          let scanJobStatements: PublishVersionInput['scanJobStatements'] = [];
          if (cause === 'approval hold flag') approval.holdApproval = false;
          if (cause === 'approval state') approval.approvalState = 'approved';
          if (cause === 'scan state') approval.scanState = 'allowed';
          if (cause === 'version binding') approval.versionId = 'different';
          if (cause === 'source binding') approval.sourceId = 'different';
          if (cause === 'token binding') approval.tokenId = 'different';
          if (cause === 'tag snapshot') approval.distTags = {};
          if (cause === 'missing scanners' || cause === 'missing scan jobs') {
            approval.holdScan = true;
            approval.scanState = 'queued';
            approval.requiredScanners = cause === 'missing scanners' ? [] : ['scanner'];
            scanJobStatements = cause === 'missing scanners' ? [st('SELECT 1')] : [];
          }
          if (cause === 'unexpected scan jobs') scanJobStatements = [st('SELECT 1')];
          await expect(
            w.writer.publishVersion(ctx, w.guard, {
              ...input,
              approval: cause === 'approval row presence' ? null : approval,
              scanJobStatements,
            }),
          ).rejects.toThrow(`invalid_publish_hold: ${cause}`);
        }));
    }
    for (const status of ['quarantined', 'removed_upstream', 'yanked'] as const)
      for (const actorType of ['user', 'service'] as const) {
        it(`tag patch by ${actorType} refuses ${status} atomically`, () =>
          run(async (e, w) => {
            const published = await w.writer.publishVersion(ctx, w.guard, w.input());
            await e.all(
              st(
                "UPDATE version SET status=?,removed_upstream_at='2026-10-30T00:00:00.000Z' WHERE org_id='org' AND id=?",
                status,
                published.versionId,
              ),
            );
            const before = await e.all(st('SELECT rev FROM package'));
            const plan = distTagStatements(ctx, w.guard, {
              packageId: published.packageId,
              ecosystem: 'npm',
              tags: { next: '1.0.0' },
              mode: 'patch',
              actorType,
              actorId: 'principal',
              opId: ulid(),
            });
            await expect(e.batch(plan.statements)).rejects.toThrow();
            expect(await e.all(st('SELECT rev FROM package'))).toEqual(before);
            expect(await e.all(st('SELECT tag FROM dist_tag'))).toEqual([{ tag: 'latest' }]);
            expect(await e.all(st('SELECT count(*) as n FROM dist_tag_history'))).toEqual([
              { n: 1 },
            ]);
          }));
      }
    it('atomically publishes an installable version with memberships, readme, tags and audit', () =>
      run(async (e, w) => {
        const result = await w.writer.publishVersion(ctx, w.guard, w.input());
        expect(result.held).toEqual({ approval: false, scan: false });
        expect((await w.reader.lookupTag(ctx, { ...ref, tag: 'latest' }))?.version.version).toBe(
          '1.0.0',
        );
        const page = await w.reader.resolveVersions(ctx, { ...ref, limit: 10 });
        expect(page && !('changed' in page) && page.pkg.listingComplete).toBe(true);
        expect(await e.all(st('SELECT body FROM version_readme'))).toEqual([{ body: '# Widget' }]);
        expect(await e.all(st('SELECT count(*) as n FROM audit_pending'))).toEqual([{ n: 1 }]);
      }));
    it('a held first publish hides its description until the first active publish', () =>
      run(async (e, w) => {
        await e.all(st('UPDATE source SET require_publish_approval=1'));
        await w.writer.publishVersion(ctx, w.guard, w.input(true));
        expect(await e.all(st('SELECT description,held_until_active FROM package'))).toEqual([
          { description: null, held_until_active: 1 },
        ]);
        await e.all(st('UPDATE source SET require_publish_approval=0'));
        await w.writer.publishVersion(ctx, w.guard, {
          ...w.input(false, '2.0.0'),
          description: 'Activated',
        });
        expect(await e.all(st('SELECT description,held_until_active FROM package'))).toEqual([
          { description: 'Activated', held_until_active: 0 },
        ]);
        expect((await w.reader.listVisible(ctx, { ...ref, limit: 10 })).items).toHaveLength(1);
      }));
    it('counts held eight-tag publication with readme, one scan job and audit exactly', () =>
      run(async (e, w) => {
        await e.all(st('UPDATE source SET require_publish_approval=1'));
        let count = 0;
        const writer = createCatalogueWriter({
          ...e,
          batch: async (statements) => {
            count = statements.length;
            return e.batch(statements);
          },
        });
        const input = w.input(true);
        const distTags = Object.fromEntries(
          Array.from({ length: 8 }, (_, n) => [`tag${n}`, '1.0.0']),
        );
        await writer.publishVersion(ctx, w.guard, {
          ...input,
          distTags,
          approval: {
            ...input.approval!,
            holdScan: true,
            scanState: 'queued',
            requiredScanners: ['scanner'],
            distTags,
          },
          scanJobStatements: [
            st(
              "INSERT INTO job (id,org_id,type,idempotency_key,payload_json) VALUES ('budget-scan','org','core:publish-scan:v1','budget-scan','{}')",
            ),
          ],
        });
        expect(count).toBe(13);
        expect(await e.all(st('SELECT count(*) as n FROM audit_pending'))).toEqual([{ n: 1 }]);
      }));
    for (const scanJobs of [28, 29]) {
      it(`held eight-tag publication with readme and audit ${scanJobs === 28 ? 'fits exactly 40 statements' : 'refuses 41 statements atomically'}`, () =>
        run(async (e, w) => {
          await e.all(st('UPDATE source SET require_publish_approval=1'));
          let count = 0;
          const writer = createCatalogueWriter({
            ...e,
            batch: async (statements) => {
              count = statements.length;
              return e.batch(statements);
            },
          });
          const input = w.input(true);
          const distTags = Object.fromEntries(
            Array.from({ length: 8 }, (_, n) => [`tag${n}`, '1.0.0']),
          );
          const publish = () =>
            writer.publishVersion(ctx, w.guard, {
              ...input,
              distTags,
              approval: {
                ...input.approval!,
                holdScan: true,
                scanState: 'queued',
                requiredScanners: ['scanner'],
                distTags,
              },
              scanJobStatements: Array.from({ length: scanJobs }, (_, n) =>
                st(
                  "INSERT INTO job (id,org_id,type,idempotency_key,payload_json) VALUES (?,'org','core:publish-scan:v1',?,'{}')",
                  `scan-${n}`,
                  `scan-${n}`,
                ),
              ),
            });
          if (scanJobs === 28) {
            await publish();
            expect(count).toBe(40);
            expect(await e.all(st('SELECT count(*) as n FROM audit_pending'))).toEqual([{ n: 1 }]);
          } else {
            await expect(publish()).rejects.toThrow('publish batch budget exceeded');
            expect(count).toBe(0);
            for (const table of [
              'package',
              'version',
              'version_readme',
              'publish_approval',
              'audit_pending',
            ])
              expect(await e.all(st(`SELECT count(*) as n FROM ${table}`))).toEqual([{ n: 0 }]);
          }
        }));
    }
    it('publishes eight tags with readme and audit in exactly 37 statements', () =>
      run(async (e, w) => {
        let count = 0;
        const writer = createCatalogueWriter({
          ...e,
          batch: async (statements) => {
            count = statements.length;
            return e.batch(statements);
          },
        });
        await writer.publishVersion(ctx, w.guard, {
          ...w.input(),
          distTags: Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`tag${n}`, '1.0.0'])),
        });
        expect(count).toBe(37);
        expect(Object.keys((await w.reader.distTags(ctx, ref))!.tags)).toHaveLength(8);
      }));
    for (const [label, sql] of [
      ['read scope', `UPDATE token SET scopes_json='["read"]'`],
      ['read-only token', 'UPDATE token SET read_only=1'],
      ['lost publish permission', 'DELETE FROM service_principal_permission'],
      ['suspended principal', "UPDATE service_principal SET status='suspended'"],
    ])
      it(`refuses ${label} in the mutation fence`, () =>
        run(async (e, w) => {
          await e.all(st(sql!));
          await expect(w.writer.publishVersion(ctx, w.guard, w.input())).rejects.toThrow();
          expect(await e.all(st('SELECT count(*) as n FROM package'))).toEqual([{ n: 0 }]);
        }));
    it('requires current admission for project publishers and permits organization publishers', () =>
      run(async (e, w) => {
        await e.all(
          st("UPDATE service_principal_permission SET permission='project:packages:write'"),
        );
        await e.all(st('UPDATE source SET default_visible_to_new_projects=0'));
        await expect(w.writer.publishVersion(ctx, w.guard, w.input())).rejects.toThrow();
        await e.all(
          st("UPDATE service_principal_permission SET permission='org:packages:publish'"),
        );
        await w.writer.publishVersion(ctx, w.guard, w.input());
        expect(await e.all(st('SELECT count(*) as n FROM version'))).toEqual([{ n: 1 }]);
      }));
    it('refuses a detached hosted source for a project publisher', () =>
      run(async (e, w) => {
        await e.all(
          st("UPDATE service_principal_permission SET permission='project:packages:write'"),
        );
        await e.all(st('DELETE FROM project_source'));
        await expect(w.writer.publishVersion(ctx, w.guard, w.input())).rejects.toThrow();
        expect(await e.all(st('SELECT count(*) as n FROM package'))).toEqual([{ n: 0 }]);
      }));
    for (const stale of [false, true])
      it(`rechecks ${stale ? 'stale' : 'fresh'} personal-token identity evidence`, () =>
        run(async (e, w) => {
          await e.batch([
            st(
              "INSERT INTO identity_provider_binding (org_id,provider,anchor) VALUES ('org','oidc','oidc:https://idp.example.test')",
            ),
            st(
              "INSERT INTO identity (id,org_id,user_id,provider,subject,email,email_verified,validated_at) VALUES ('identity','org','user','oidc','subject','test@example.test',1,?)",
              new Date().toISOString(),
            ),
            st(
              "INSERT INTO role (id,org_id,key,name,scope) VALUES ('publisher-role','org','publisher','Publisher','organization')",
            ),
            st(
              "INSERT INTO role_permission (org_id,role_id,permission) VALUES ('org','publisher-role','org:packages:publish')",
            ),
            st(
              "INSERT INTO access_grant (id,org_id,subject_type,subject_value,scope,role_id) VALUES ('grant','org','email','test@example.test','organization','publisher-role')",
            ),
            st(
              "UPDATE token SET kind='pat',user_id='user',service_principal_id=NULL,validation_kind='sso',validation_identity_id='identity'",
            ),
          ]);
          const guard = createPublishWriteGuard(
            ctx,
            {
              tokenId: 'token',
              selector: 'abcdefghijkl',
              projectSlug: 'project',
              routeProjectId: 'project',
              sourceId: 'source',
              key: 'widget',
            },
            [
              {
                provider: 'oidc',
                anchor: 'oidc:https://idp.example.test',
                emailAuthoritative: true,
                emailAuthoritativeDomains: ['example.test'],
              },
            ],
          );
          if (stale) await e.all(st("UPDATE identity SET validated_at='2020-01-01T00:00:00.000Z'"));
          if (stale) await expect(w.writer.publishVersion(ctx, guard, w.input())).rejects.toThrow();
          else
            expect((await w.writer.publishVersion(ctx, guard, w.input())).held).toEqual({
              approval: false,
              scan: false,
            });
        }));
    it('snapshots guard bindings before the caller mutates its input object', () =>
      run(async (e, w) => {
        await e.batch([
          st("UPDATE service_principal_permission SET permission='project:packages:write'"),
          st(
            "INSERT INTO package (id,org_id,source_id,ecosystem,name,visible_to_new_projects) VALUES ('hidden','org','source','npm','other',0)",
          ),
          st(
            "INSERT INTO registered_name (id,org_id,source_id,ecosystem,pattern) VALUES ('other-claim','org','source','npm','other')",
          ),
        ]);
        const binding = {
          tokenId: 'token',
          selector: 'abcdefghijkl',
          projectSlug: 'project',
          routeProjectId: 'project',
          sourceId: 'source',
          key: 'widget',
        };
        const guard = createPublishWriteGuard(ctx, binding, []);
        binding.key = 'other';
        const input = w.input();
        await expect(
          w.writer.publishVersion(ctx, guard, {
            ...input,
            key: 'other',
            version: {
              ...input.version,
              metadata: normalizeVersionMetadata('npm', { name: 'other', version: '1.0.0' }),
            },
          }),
        ).rejects.toThrow('invalid publish write guard');
        expect(await e.all(st('SELECT count(*) as n FROM version'))).toEqual([{ n: 0 }]);
      }));
    it('rejects a publish guard bound to another package', () =>
      run(async (e, w) => {
        await expect(
          w.writer.publishVersion(ctx, w.guard, { ...w.input(), key: 'other' }),
        ).rejects.toThrow('invalid publish write guard');
        expect(await e.all(st('SELECT count(*) as n FROM package'))).toEqual([{ n: 0 }]);
      }));
    for (const bad of ['build metadata', 'manifest cap'] as const)
      it(`rejects ${bad} before mutation`, () =>
        run(async (e, w) => {
          const input = w.input(false, bad === 'build metadata' ? '1.0.0+build' : '1.0.0');
          if (bad === 'manifest cap')
            Object.assign(input.version, {
              metadata: {
                ...input.version.metadata,
                json: JSON.stringify({ name: 'widget', description: 'x'.repeat(262144) }),
              },
            });
          await expect(w.writer.publishVersion(ctx, w.guard, input)).rejects.toThrow();
          expect(await e.all(st('SELECT count(*) as n FROM package'))).toEqual([{ n: 0 }]);
        }));
    for (const budget of ['statements', 'bytes', 'missing job', 'missing scanner'] as const)
      it(`fails closed on scan ${budget}`, () =>
        run(async (e, w) => {
          const base = w.input();
          const pending = w.input(true).approval!;
          const input = {
            ...base,
            approval: {
              ...pending,
              holdApproval: false,
              approvalState: 'not_required' as const,
              holdScan: true,
              scanState: 'queued' as const,
              requiredScanners: budget === 'missing scanner' ? [] : ['scanner'],
            },
            scanJobStatements:
              budget === 'missing job'
                ? []
                : budget === 'statements'
                  ? Array.from({ length: 41 }, () => st('SELECT 1'))
                  : [st('SELECT ?', budget === 'bytes' ? 'x'.repeat(4 * 1024 * 1024) : 'job')],
          };
          await expect(w.writer.publishVersion(ctx, w.guard, input)).rejects.toThrow();
          expect(await e.all(st('SELECT count(*) as n FROM package'))).toEqual([{ n: 0 }]);
        }));
    it('concurrent publishes of the same version have one version and one audit winner', () =>
      run(async (e, w) => {
        const results = await Promise.allSettled([
          w.writer.publishVersion(ctx, w.guard, w.input()),
          w.writer.publishVersion(ctx, w.guard, { ...w.input(), versionId: 'concurrent-id' }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(await e.all(st('SELECT count(*) as n FROM version'))).toEqual([{ n: 1 }]);
        expect(await e.all(st('SELECT count(*) as n FROM audit_pending'))).toEqual([{ n: 1 }]);
      }));
    it('persists a scan hold and its job in the publication batch', () =>
      run(async (e, w) => {
        const pending = w.input(true).approval!;
        const result = await w.writer.publishVersion(ctx, w.guard, {
          ...w.input(),
          approval: {
            ...pending,
            holdApproval: false,
            approvalState: 'not_required',
            holdScan: true,
            scanState: 'queued',
            requiredScanners: ['scanner'],
          },
          scanJobStatements: [
            st(
              "INSERT INTO job (id,org_id,type,idempotency_key,payload_json) VALUES ('scan-job','org','core:publish-scan:v1','publish:version-1.0.0','{}')",
            ),
          ],
        });
        expect(result.held).toEqual({ approval: false, scan: true });
        expect(await e.all(st('SELECT id FROM job WHERE id=?', 'scan-job'))).toEqual([
          { id: 'scan-job' },
        ]);
        expect(
          await e.all(st('SELECT required_scanners_json,scan_state FROM publish_approval')),
        ).toEqual([{ required_scanners_json: '["scanner"]', scan_state: 'queued' }]);
        expect(
          await w.reader.lookupVersion(ctx, { ...ref, versionNormalized: '1.0.0' }),
        ).toBeNull();
      }));
    for (const heldFirst of [false, true])
      for (const method of ['GET', 'HEAD', 'range'] as const) {
        it(`tarball ${method} hides ${heldFirst ? 'a held first package' : 'a quarantined publish'}`, () =>
          run(async (e, w) => {
            if (!heldFirst) await w.writer.publishVersion(ctx, w.guard, w.input());
            await e.all(st('UPDATE source SET require_publish_approval=1'));
            const held = w.input(true, heldFirst ? '1.0.0' : '2.0.0');
            await w.writer.publishVersion(ctx, w.guard, held);
            const access = createPackageAccess(w.reader);
            const actor = {
              kind: 'project' as const,
              userId: 'user',
              orgId: ctx.orgId,
              projectId: 'project',
              permissions: new Set(['project:packages:read']),
            };
            let byteReads = 0;
            const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
            const kernel = await createKernel({
              platform: name === 'd1' ? 'cloudflare' : 'node',
              plugins: [],
              ports: {
                organizations: { get: async () => null },
                clock: fixedClock(NOW),
                ids: { ulid },
              },
              resolveOrg: async () => ctx,
              health: async () => true,
              log: () => undefined,
              packageResolver: access,
              authorization: createAuthorizationEngine({
                access: {
                  lookupSession: async () => ({
                    session: { id: 'session', csrfHash: '' },
                    user: { id: 'user' },
                    identity: null,
                    protectedHolder: false,
                    project: { id: 'project' },
                    organizationPermissions: [],
                    projectPermissions: ['project:read', 'project:packages:read'],
                  }),
                  lookupToken: async () => null,
                  touchSession: async () => true,
                  touchToken: async () => true,
                },
                tokenUse: {
                  keyring,
                  nowMs: () => 0,
                  dispatch: () => undefined,
                  log: () => undefined,
                },
                patValidation: patValidationGate,
                publicOrigin: 'https://broker.test',
                providerAnchors: async () => [],
              }),
              ecosystemRoutes: npmRoutes({
                access,
                dist: {
                  serve: async () => {
                    byteReads++;
                    return {
                      kind: 'file',
                      headers: new Headers({ 'Content-Type': 'application/gzip' }),
                      size: 3,
                      body: new Response('tgz').body!,
                    };
                  },
                },
                onDemand: { ensure: async () => ({ kind: 'serve', stale: false }) },
                reresolve: async () => access.resolve(actor, 'npm', 'widget'),
                handleOf: async () => null,
                publicUrl: 'https://broker.test',
                codecs: { gunzip: () => new TransformStream() },
                audit: { enabled: false },
              }),
            });
            const response = await kernel.fetch(
              new Request(
                `https://broker.test/project/npm/widget/-/widget-${held.version.version}.tgz`,
                {
                  method: method === 'HEAD' ? 'HEAD' : 'GET',
                  headers: {
                    cookie: `__Host-pb_session=${'A'.repeat(43)}`,
                    ...(method === 'range' ? { range: 'bytes=0-1' } : {}),
                  },
                },
              ),
            );
            expect(response.status).toBe(404);
            expect(byteReads).toBe(0);
            if (!heldFirst) {
              const control = await kernel.fetch(
                new Request('https://broker.test/project/npm/widget/-/widget-1.0.0.tgz', {
                  headers: { cookie: `__Host-pb_session=${'A'.repeat(43)}` },
                }),
              );
              expect(control.status).toBe(200);
              expect(byteReads).toBe(1);
              await control.body?.cancel();
            }
          }));
      }
    it('duplicates including tombstones abort every write and audit', () =>
      run(async (e, w) => {
        await w.writer.publishVersion(ctx, w.guard, w.input());
        const before = await e.all(st('SELECT rev,description FROM package'));
        await e.all(
          st(
            "UPDATE version SET status='tombstoned', tombstoned_at='2026-10-30T00:00:00.000Z', tombstone_reason='rejected'",
          ),
        );
        await expect(
          w.writer.publishVersion(ctx, w.guard, {
            ...w.input(),
            versionId: 'duplicate-id',
            description: 'Changed',
          }),
        ).rejects.toThrow();
        expect(await e.all(st('SELECT rev,description FROM package'))).toEqual(before);
        expect(await e.all(st('SELECT count(*) as n FROM audit_pending'))).toEqual([{ n: 1 }]);
      }));
    for (const [label, sql] of [
      ['revoked token', "UPDATE token SET revoked_at='2020-01-01T00:00:00.000Z'"],
      ['expired token', "UPDATE token SET expires_at='2020-01-01T00:00:00.000Z'"],
      ['archived project', "UPDATE project SET status='archived'"],
      ['paused source', "UPDATE source SET status='paused'"],
      ['missing claim', 'DELETE FROM registered_name'],
      ['changed approval policy', 'UPDATE source SET require_publish_approval=1'],
      ['purge leased blob', "UPDATE blob SET purge_lease_until='2099-01-01T00:00:00.000Z'"],
    ])
      it(`fences ${label}`, () =>
        run(async (e, w) => {
          await e.all(st(sql!));
          await expect(w.writer.publishVersion(ctx, w.guard, w.input())).rejects.toThrow();
          expect(await e.all(st('SELECT count(*) as n FROM package'))).toEqual([{ n: 0 }]);
          expect(await e.all(st('SELECT count(*) as n FROM audit_pending'))).toEqual([{ n: 0 }]);
        }));
    it('keeps held publish inspection organization-scoped in get and list', () =>
      run(async (e, w) => {
        await e.all(st('UPDATE source SET require_publish_approval=1'));
        const result = await w.writer.publishVersion(ctx, w.guard, w.input(true));
        const repo = createPublishesRepository(e);
        expect(await repo.get(ctx, result.approvalId!)).toMatchObject({
          id: result.approvalId,
          versionId: 'version-1.0.0',
          holdApproval: true,
        });
        expect((await repo.list(ctx, { limit: 10, state: 'pending' })).items.length).toBe(1);
        expect(await repo.get(orgContext('other'), result.approvalId!)).toBeNull();
        expect((await repo.list(orgContext('other'), { limit: 10 })).items).toEqual([]);
      }));
    it('readme refuses a stale latest tag targeting a quarantined publish', () =>
      run(async (e, w) => {
        const active = await w.writer.publishVersion(ctx, w.guard, w.input());
        await e.all(st('UPDATE source SET require_publish_approval=1'));
        await w.writer.publishVersion(ctx, w.guard, {
          ...w.input(true, '2.0.0'),
          readme: { filename: 'README.md', body: '# Held' },
        });
        await e.all(
          st(
            "UPDATE dist_tag SET version_id='version-2.0.0' WHERE package_id=? AND tag='latest'",
            active.packageId,
          ),
        );
        expect(await createPackageReadmeReader(e).get(ctx, ref)).toBeNull();
      }));
    it('compares held tag snapshots as maps regardless of key order', () =>
      run(async (e, w) => {
        await e.all(st('UPDATE source SET require_publish_approval=1'));
        const input = w.input(true);
        const result = await w.writer.publishVersion(ctx, w.guard, {
          ...input,
          distTags: { latest: '1.0.0', next: '1.0.0' },
          approval: { ...input.approval!, distTags: { next: '1.0.0', latest: '1.0.0' } },
        });
        expect(result.held).toEqual({ approval: true, scan: false });
        expect(
          await w.reader.lookupVersion(ctx, { ...ref, versionNormalized: '1.0.0' }),
        ).toBeNull();
      }));
    it('validates tag grammar even while held', () =>
      run(async (e, w) => {
        await e.all(st('UPDATE source SET require_publish_approval=1'));
        const held = w.input(true);
        await expect(
          w.writer.publishVersion(ctx, w.guard, {
            ...held,
            distTags: { '1.0.0': '1.0.0' },
            approval: { ...held.approval!, distTags: { '1.0.0': '1.0.0' } },
          }),
        ).rejects.toThrow();
        expect(await e.all(st('SELECT count(*) as n FROM package'))).toEqual([{ n: 0 }]);
      }));
    it('patches tags without removing an earlier channel', () =>
      run(async (e, w) => {
        await w.writer.publishVersion(ctx, w.guard, { ...w.input(), distTags: { next: '1.0.0' } });
        await w.writer.publishVersion(ctx, w.guard, w.input(false, '2.0.0'));
        expect((await w.reader.distTags(ctx, ref))?.tags).toEqual({
          next: '1.0.0',
          latest: '2.0.0',
        });
        expect(
          await e.all(st("SELECT count(*) as n FROM dist_tag_history WHERE action='remove'")),
        ).toEqual([{ n: 0 }]);
      }));
    it('refuses more than eight tags before any mutation', () =>
      run(async (e, w) => {
        await expect(
          w.writer.publishVersion(ctx, w.guard, {
            ...w.input(),
            distTags: Object.fromEntries(Array.from({ length: 9 }, (_, n) => [`tag${n}`, '1.0.0'])),
          }),
        ).rejects.toThrow();
        expect(await e.all(st('SELECT count(*) as n FROM package'))).toEqual([{ n: 0 }]);
      }));
    it('refuses tags targeting a different version before any mutation', () =>
      run(async (e, w) => {
        await w.writer.publishVersion(ctx, w.guard, w.input(false, '2.0.0'));
        await expect(
          w.writer.publishVersion(ctx, w.guard, { ...w.input(), distTags: { latest: '2.0.0' } }),
        ).rejects.toThrow();
        expect(await e.all(st('SELECT count(*) as n FROM version'))).toEqual([{ n: 1 }]);
      }));
    for (const heldFirst of [false, true]) {
      for (const reader of [
        'versions',
        'lookupVersion',
        'lookupTag',
        'distTags',
        'dist',
        'search',
        'list',
        'adminPackages',
        'adminVersions',
        'readme',
        'full',
        'abbreviated',
        'vulnerability',
        'mcp',
        'adminProjectPackages',
        'adminProjectVersions',
      ] as const) {
        it(`${reader} hides ${heldFirst ? 'a held first package' : 'a quarantined publish'}`, () =>
          run(async (e, w) => {
            let packageId: string;
            if (!heldFirst)
              packageId = (await w.writer.publishVersion(ctx, w.guard, w.input())).packageId;
            await e.all(st('UPDATE source SET require_publish_approval=1'));
            const held = w.input(true, heldFirst ? '1.0.0' : '2.0.0');
            packageId = (await w.writer.publishVersion(ctx, w.guard, held)).packageId;
            // Even a stale tag must not expose the held version.
            await e.all(
              st(
                "INSERT INTO dist_tag (org_id,package_id,tag,version_id) VALUES ('org',?,'held',?)",
                packageId,
                held.versionId,
              ),
            );
            const actor = {
              kind: 'project' as const,
              orgId: ctx.orgId,
              projectId: 'project',
              userId: 'user',
              permissions: new Set(['project:packages:read']),
            };
            if (reader === 'full' || reader === 'abbreviated') {
              const response = await renderPackument({
                requestId: ulid(),
                access: createPackageAccess(w.reader),
                actor,
                projectSlug: 'project',
                name: 'widget',
                publicUrl: 'https://broker.test',
                abbreviated: reader === 'abbreviated',
              });
              expect(response.status).toBe(heldFirst ? 404 : 200);
              const body = (await response.json()) as { versions?: Record<string, unknown> };
              expect(Object.keys(body.versions ?? {})).toEqual(heldFirst ? [] : ['1.0.0']);
            } else if (reader === 'vulnerability') {
              let requested: readonly string[] = [];
              const route = packageRoutes({
                ...w.admin,
                readStatuses: async (_ctx, ids) => {
                  requested = ids;
                  return new Map();
                },
              }).find(
                (r) =>
                  r.api &&
                  'operationId' in r.api &&
                  r.api.operationId === 'listProjectPackageVersions',
              )!;
              const response = await route.handler({
                request: new Request(
                  'https://broker.test/_pb/projects/project/packages/' + packageId + '/versions',
                ),
                requestId: ulid(),
                org: ctx,
                principal: { kind: 'user', id: 'user' },
                projectId: 'project',
                params: { project: 'project', package: packageId },
                ports: {} as PluginPorts,
              });
              expect(response.status).toBe(heldFirst ? 404 : 200);
              expect(requested).toEqual(heldFirst ? [] : ['version-1.0.0']);
              expect(await response.text()).not.toContain(held.versionId);
            } else if (reader === 'mcp') {
              const routes = packageRoutes(w.admin);
              const context: RequestContext = {
                request: new Request('https://broker.test/_pb/mcp'),
                requestId: ulid(),
                org: ctx,
                principal: { kind: 'user', id: 'user' },
                projectId: 'project',
                params: {},
                ports: {} as PluginPorts,
              };
              const route = routes.find(
                (r) =>
                  r.api &&
                  'operationId' in r.api &&
                  r.api.operationId === 'listProjectPackageVersions',
              )!;
              const tools = createMcpTools({
                routes,
                publicOrigin: 'https://broker.test',
                kernel: {
                  fetch: async (request) =>
                    route.handler({
                      ...context,
                      request,
                      params: { project: 'project', package: packageId },
                    }),
                },
              });
              const result = (await tools['tools/call']!(
                {
                  name: 'get_package_versions',
                  arguments: { params: { project: 'project', package: packageId } },
                },
                context,
              )) as { content: { text: string }[] };
              const text = result.content.map((c) => c.text).join('');
              expect(text).not.toContain(held.versionId);
              if (heldFirst) expect(text).toContain('not_found');
              if (!heldFirst) expect(text).toContain('1.0.0');
            } else if (reader === 'versions') {
              const page = await w.reader.resolveVersions(ctx, { ...ref, limit: 10 });
              expect(
                page && !('changed' in page) ? page.versions.map((v) => v.version) : null,
              ).toEqual(heldFirst ? null : ['1.0.0']);
            } else if (reader === 'lookupVersion')
              expect(
                await w.reader.lookupVersion(ctx, {
                  ...ref,
                  versionNormalized: held.version.version,
                }),
              ).toBeNull();
            else if (reader === 'lookupTag')
              expect(await w.reader.lookupTag(ctx, { ...ref, tag: 'held' })).toBeNull();
            else if (reader === 'distTags')
              expect((await w.reader.distTags(ctx, ref))?.tags ?? null).toEqual(
                heldFirst ? null : { latest: '1.0.0' },
              );
            else if (reader === 'dist')
              expect(
                await w.reader.resolveDist(ctx, {
                  ...ref,
                  by: 'version',
                  versionNormalized: held.version.version,
                }),
              ).toBeNull();
            else if (reader === 'search')
              expect(
                (await w.reader.search(ctx, { ...ref, text: 'widget', limit: 10 })).length,
              ).toBe(heldFirst ? 0 : 1);
            else if (reader === 'list')
              expect((await w.reader.listVisible(ctx, { ...ref, limit: 10 })).items.length).toBe(
                heldFirst ? 0 : 1,
              );
            else if (reader === 'readme') {
              expect(await createPackageReadmeReader(e).get(ctx, ref)).toEqual(
                heldFirst ? null : { filename: 'README.md', body: '# Widget' },
              );
            } else if (reader === 'adminPackages' || reader === 'adminProjectPackages') {
              const page =
                reader === 'adminPackages'
                  ? await w.admin.listOrganization(ctx, { limit: 10 })
                  : await w.admin.listProject(ctx, 'project', { limit: 10 });
              expect(page.items.length).toBe(heldFirst ? 0 : 1);
              if (!heldFirst)
                expect(page.items[0]).toMatchObject({ versionCount: 1, status: 'active' });
            } else {
              const page = await w.admin.listVersions(ctx, {
                packageId,
                projectId: reader === 'adminProjectVersions' ? 'project' : null,
                limit: 10,
              });
              expect(page?.items.map((v) => v.version) ?? null).toEqual(
                heldFirst ? null : ['1.0.0'],
              );
            }
          }));
      }
    }
  });
}
