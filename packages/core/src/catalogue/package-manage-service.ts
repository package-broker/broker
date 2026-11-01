import type { ApiCall } from '../api/idempotency.js';
import { auditEvent } from '../audit/actions.js';
import type { AuthenticatedSession, SessionService } from '../auth/session.js';
import type { AdminLog } from '../authz/administration.js';
import { fenceKind, type MutationFence } from '../authz/fence.js';
import type { PackageManageScope, VisibilityStore } from '../db/catalogue.js';
import type { PackageAdminReader } from '../db/package-admin.js';
import type { OrgContext } from '../db/port.js';
import { isUlid, type Clock } from '../ids.js';
import { versionTransition, type VersionStatus } from './version-rules.js';

export type { PackageManageScope } from '../db/catalogue.js';

export type PackageVersionAction = 'quarantine' | 'tombstone' | 'release';

export interface PackageManageInput {
  readonly reason?: string;
  readonly packageId: string;
  readonly versionId: string;
  readonly action: PackageVersionAction;
  readonly scope: PackageManageScope;
}

export type PackageManageError =
  | 'invalid_input'
  | 'reauth_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'indeterminate'
  | 'publish_gate';

export type PackageManageResult =
  | {
      readonly ok: true;
      readonly value: { readonly versionId: string; readonly status: VersionStatus };
    }
  | { readonly ok: false; readonly error: PackageManageError };

export interface PackageManageService {
  manage(
    ctx: OrgContext,
    authenticated: AuthenticatedSession,
    fence: MutationFence,
    input: PackageManageInput,
    call: ApiCall,
  ): Promise<PackageManageResult>;
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && isUlid(value);
}

export function createPackageManageService(deps: {
  readonly reader: Pick<PackageAdminReader, 'findManagedVersion'>;
  readonly store: Pick<
    VisibilityStore,
    'quarantineVersion' | 'tombstoneVersion' | 'releaseQuarantine'
  >;
  readonly sessions: Pick<SessionService, 'isReauthFresh'>;
  readonly clock: Clock;
  readonly ids: { ulid(): string };
  readonly log: AdminLog;
}): PackageManageService {
  return {
    async manage(ctx, authenticated, fence, input, call) {
      function result(value: PackageManageResult): PackageManageResult {
        try {
          deps.log({
            event: value.ok ? 'package.version_state_changed' : 'package.version_state_denied',
            orgId: ctx.orgId,
            versionId: input.versionId,
            action: input.action,
            scopeKind: input.scope.kind,
            actorUserId: fence.userId,
            opId: call.audit.opId,
          });
        } catch {
          // A failing sink must not change the mutation outcome.
        }
        return value;
      }
      function fail(error: PackageManageError): PackageManageResult {
        return result({ ok: false, error });
      }

      if (
        !validId(input.packageId) ||
        !validId(input.versionId) ||
        (input.scope.kind === 'project' && !validId(input.scope.projectId))
      )
        return { ok: false, error: 'invalid_input' };
      if (fenceKind(fence) !== 'session')
        throw new TypeError('Package manage requires a session fence');
      if (
        input.action === 'tombstone' &&
        (authenticated.session.userId !== fence.userId ||
          authenticated.session.id !== fence.sessionId ||
          !deps.sessions.isReauthFresh(authenticated))
      ) {
        return fail('reauth_required');
      }
      const version = await deps.reader.findManagedVersion(ctx, {
        packageId: input.packageId,
        versionId: input.versionId,
        projectId: input.scope.kind === 'project' ? input.scope.projectId : null,
      });
      if (version === null) return fail('not_found');
      if (version.publishGate) return fail('publish_gate');
      if (version.hostedNpm && input.action === 'tombstone') {
        if (input.scope.kind !== 'organization') return fail('forbidden');
        if (
          typeof input.reason !== 'string' ||
          !input.reason.trim() ||
          new TextEncoder().encode(input.reason).length > 1000
        )
          return fail('invalid_input');
      }
      const transition = {
        quarantine: { status: 'quarantined', reason: 'admin_quarantine' },
        tombstone: { status: 'tombstoned', reason: 'admin_tombstone' },
        release: { status: 'active', reason: 'admin_release' },
      } as const;
      const to = transition[input.action];
      if (!versionTransition(version.status, to.status, to.reason)) return fail('conflict');
      const audit = auditEvent({
        id: deps.ids.ulid(),
        now: deps.clock.now().toISOString(),
        action: 'version.state_change',
        actor: { type: 'user', id: fence.userId },
        target: { type: 'version', id: input.versionId },
        projectId: version.sourceProjectId,
        context: call.audit,
        changes: {
          ...(version.hostedNpm && input.action === 'tombstone'
            ? { reason: { new: input.reason! } }
            : {}),
          from_status: { old: version.status },
          to_status: { new: to.status },
          package_name: { new: version.packageName },
          version: { new: version.version },
        },
      });
      if (!audit.ok) throw new TypeError('Invalid package manage audit event');
      const write = {
        packageId: input.packageId,
        versionId: input.versionId,
        expectedStatus: version.status,
        ...(version.hostedNpm && input.action === 'tombstone'
          ? { tombstoneReason: input.reason!, expectedRevision: version.revision! }
          : {}),
        manage: input.scope,
        audit: audit.event,
        ...(call.idempotency === undefined ? {} : { idempotency: call.idempotency }),
      };
      const answer =
        input.action === 'quarantine'
          ? await deps.store.quarantineVersion(ctx, fence, { ...write, reason: 'admin_quarantine' })
          : input.action === 'tombstone'
            ? await deps.store.tombstoneVersion(ctx, fence, { ...write, reason: 'admin_tombstone' })
            : await deps.store.releaseQuarantine(ctx, fence, write);
      if (answer.ok)
        return result({ ok: true, value: { versionId: input.versionId, status: to.status } });
      switch (answer.reason) {
        case 'not_found':
          return fail('not_found');
        case 'authority':
          return fail('forbidden');
        case 'conflict':
          return fail('conflict');
        case 'publish_gate':
          return fail('publish_gate');
        case 'indeterminate':
          return fail('indeterminate');
        default:
          throw new Error('Unexpected package manage store outcome');
      }
    },
  };
}
