import { auditEvent, type AuditEvent } from '../../audit/actions.js';
import type { MutationFence } from '../../authz/fence.js';
import { displayName, packageKey, PackageNameError } from '../../catalogue/names.js';
import type { OrgContext } from '../../db/port.js';
import type { SourceRepository } from '../../db/source.js';
import { PACKAGE_SYNC_JOB_TYPE, packageSyncEnqueueInput } from '../../ingest/package-sync-job.js';
import type { SourcePackageProbe } from '../../ingest/source-package.js';
import type { RouteDefinition } from '../../plugin.js';
import { apiRoute } from '../route.js';
import { projectSessionCallContext, type ApiRouteDeps } from './context.js';
import { SOURCE_PACKAGE_API_SPEC } from './sources-schemas.js';

export interface SourcePackageStore {
  present(org: OrgContext, sourceId: string, key: string): Promise<boolean>;
  request(
    org: OrgContext,
    fence: MutationFence,
    input: { readonly projectId: string; readonly sourceId: string; readonly audit?: AuditEvent },
  ): Promise<'accepted' | 'forbidden' | 'not_found' | 'source_paused' | 'unavailable'>;
}

export interface SourcePackageRouteDeps extends ApiRouteDeps {
  readonly sources: Pick<SourceRepository, 'get'>;
  readonly projects: {
    get(org: OrgContext, id: string): Promise<{ readonly status: 'active' | 'archived' } | null>;
  };
  readonly projectSources: {
    list(
      org: OrgContext,
      input: { readonly projectId: string },
    ): Promise<readonly { readonly sourceId: string }[]>;
  };
  readonly store: SourcePackageStore;
  readonly probe: SourcePackageProbe;
}

export function sourcePackageRoutes(deps: SourcePackageRouteDeps): readonly RouteDefinition[] {
  return [
    apiRoute(SOURCE_PACKAGE_API_SPEC, async ({ ctx, params, body }) => {
      const c = projectSessionCallContext(ctx, deps);
      const project = await deps.projects.get(c.org, c.projectId);
      if (project?.status !== 'active') return { error: 'not_found' };
      const source = await deps.sources.get(c.org, params.source);
      if (source === null || (source.projectId !== null && source.projectId !== c.projectId))
        return { error: 'not_found' };
      const attached = await deps.projectSources.list(c.org, { projectId: c.projectId });
      if (!attached.some(({ sourceId }) => sourceId === source.id)) return { error: 'not_found' };
      if (!['packagist_proxy', 'npmjs_proxy', 'npm_registry'].includes(source.type))
        return { error: 'unsupported_source_kind' };
      if (source.status === 'paused') return { error: 'source_paused' };
      let key: string;
      try {
        key = packageKey(body.name, {
          ecosystem: source.ecosystem,
          legacyCase: source.ecosystem === 'npm',
        });
      } catch (error) {
        if (!(error instanceof PackageNameError)) throw error;
        return { error: 'invalid_request', details: [{ path: '/body/name', code: 'invalid' }] };
      }
      const present = await deps.store.present(c.org, source.id, key);
      const jobs = ctx.ports.platform?.jobs;
      if (!present && jobs === undefined) return { error: 'unavailable' };
      let result: Awaited<ReturnType<SourcePackageProbe>> = 'found';
      try {
        if (!present)
          result = await deps.probe(
            c.org,
            source.id,
            key,
            AbortSignal.any([ctx.request.signal, AbortSignal.timeout(25_000)]),
          );
      } catch {
        return { error: 'unavailable' };
      }
      if (result === 'not_found') return { error: 'package_not_found' };
      if (result !== 'found') return { error: result };
      const input = { projectId: c.projectId, sourceId: source.id };
      const authorized = await deps.store.request(c.org, c.fence, input);
      if (authorized !== 'accepted') return { error: authorized };
      if (present) return { status: 200, body: { name: displayName(key), state: 'present' } };
      const audit = auditEvent({
        id: deps.ids.ulid(),
        now: deps.clock.now().toISOString(),
        action: 'source.package_requested',
        actor: { type: 'user', id: c.actor.userId },
        context: c.call.audit,
        target: { type: 'source', id: source.id },
        projectId: c.projectId,
        changes: { package_name: { new: displayName(key) } },
      });
      if (!audit.ok) throw new TypeError('Invalid source audit event');
      const payload = { sourceId: source.id, key };
      let jobId: string;
      try {
        const job = await jobs!.enqueue(
          c.org,
          PACKAGE_SYNC_JOB_TYPE,
          payload,
          await packageSyncEnqueueInput(payload, c.call.audit.opId),
        );
        jobId = job.id;
      } catch {
        return { error: 'unavailable' };
      }
      const recorded = await deps.store.request(c.org, c.fence, { ...input, audit: audit.event });
      if (recorded !== 'accepted') return { error: recorded };
      return { status: 202, body: { name: displayName(key), state: 'queued', jobId } };
    }),
  ];
}
