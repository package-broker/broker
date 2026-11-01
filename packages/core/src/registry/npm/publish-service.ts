import { normalizeVersionMetadata, MetadataTooLargeError } from '../../catalogue/metadata.js';
import { parseAuthorization } from '../../auth/credential-parser.js';
import { API_ERROR_CODES, jsonResponse } from '../../api/response.js';
import { auditEvent } from '../../audit/actions.js';
import { accessContextOf } from '../../authz/access-context.js';
import type { EngineAccessPort, EngineProviderAnchor } from '../../authz/engine.js';
import { packageKey } from '../../catalogue/names.js';
import { PUBLISH_APPROVAL_WINDOW_MS } from '../../db/publishes.js';
import { DbError, ACCESS_MUTATION_GUARD_CONSTRAINT } from '../../db/errors.js';
import type { CatalogueWriteGuard, CatalogueWriter } from '../../db/catalogue.js';
import type { OrgContext } from '../../db/port.js';
import { ulid, type Clock } from '../../ids.js';
import {
  BlobAdmissionError,
  BlobBusyError,
  BlobTooLargeError,
  type CoreBlobStore,
  type StagedBlob,
} from '../../platform/blob.js';
import type { Codecs } from '../../platform/codec.js';
import { formatIntegrity } from '../../platform/codec.js';
import type { CoreJobs } from '../../platform/jobs.js';
import type { RequestContext } from '../../plugin.js';
import type { RegistryConfig } from '../registry-config.js';
import { validatePublishBody } from './publish-body.js';
import { PublishValidationError } from './tarball-walk.js';

export interface PublishGuardInput {
  readonly tokenId: string;
  readonly selector: string;
  readonly projectSlug: string;
  readonly routeProjectId: string;
  readonly sourceId: string;
  readonly key: string;
}
export interface PublishDependencies {
  readonly reads: {
    source(
      ctx: OrgContext,
      key: string,
    ): Promise<readonly { id: string; status: string; requirePublishApproval: boolean }[]>;
    packageBinding(
      ctx: OrgContext,
      tokenId: string,
    ): Promise<{ packageName: string | null } | null>;
    blobId(ctx: OrgContext, sha256: string): Promise<string | null>;
  };
  readonly lookupToken: EngineAccessPort['lookupToken'];
  readonly anchors: (ctx: OrgContext) => Promise<readonly EngineProviderAnchor[]>;
  readonly writeGuard: (
    ctx: OrgContext,
    input: PublishGuardInput,
    anchors: readonly EngineProviderAnchor[],
  ) => CatalogueWriteGuard;
  readonly admitted: (ctx: OrgContext, input: PublishGuardInput) => Promise<boolean>;
  readonly writer: Pick<CatalogueWriter, 'publishVersion'>;
  readonly requiredScanners: () => readonly string[];
  readonly scanJobs: Pick<CoreJobs, 'enqueueStatements'>;
}
export interface PublishServiceDeps extends PublishDependencies {
  readonly blob: CoreBlobStore;
  readonly codecs: Codecs;
  readonly registry: RegistryConfig;
  readonly clock: Clock;
  readonly publicUrl: string;
}

export const PUBLISH_DOCS = 'https://package.broker/docs/clients/npm-pnpm-yarn';
export function publishError(ctx: RequestContext, status: number, code: string): Response {
  const messages: Readonly<Record<string, { readonly message: string; readonly status: number }>> =
    API_ERROR_CODES;
  if (Object.hasOwn(messages, code)) status = messages[code]!.status;
  const message = Object.hasOwn(messages, code)
    ? messages[code]!.message
    : 'Publish request refused';
  const response = jsonResponse(status, {
    error:
      code === 'write_unsupported' ? `This write is unsupported. See ${PUBLISH_DOCS}` : message,
    code,
    requestId: ctx.requestId,
  });
  response.headers.set('x-request-id', ctx.requestId);
  response.headers.set('Cache-Control', 'no-store');
  if (status === 405) response.headers.set('Allow', 'GET, HEAD');
  if (code === 'busy') response.headers.set('Retry-After', '10');
  return response;
}

export function createPublishService(deps: PublishServiceDeps) {
  return async (ctx: RequestContext, name: string): Promise<Response> => {
    let staged: StagedBlob | undefined;
    let promoted = false;
    let stagingFailure: unknown;
    try {
      const key = (() => {
        try {
          return packageKey(name, { ecosystem: 'npm' });
        } catch {
          throw new PublishValidationError('invalid_name');
        }
      })();
      const snapshot = accessContextOf(ctx);
      const token = snapshot?.token;
      const selector =
        snapshot?.rateKey.stage === 'authenticated' ? snapshot.rateKey.tokenSelector : null;
      if (!token?.id || !selector || !ctx.org || !ctx.projectId || !ctx.principal) {
        return publishError(ctx, 401, 'token_required');
      }
      if (token.readOnly || (token.scope !== 'write' && token.scope !== 'full'))
        return publishError(ctx, 403, 'scope');
      const org = ctx.org;
      const anchors = await deps.anchors(org);
      const found = await deps.lookupToken(org, {
        boundary: 'project',
        projectSlug: ctx.params['project'] ?? '',
        selector,
        providerAnchors: anchors,
        organizationAlternative: 'org:packages:publish',
      });
      if (
        !found ||
        found.token.id !== token.id ||
        found.principalStatus !== 'active' ||
        found.token.revoked ||
        found.token.expired ||
        !found.token.bindingOk ||
        (found.token.kind === 'pat' && found.validation?.fresh !== true) ||
        found.project?.id !== ctx.projectId
      )
        return publishError(ctx, 403, 'forbidden');
      const projectAuthority = found.projectPermissions.includes('project:packages:write');
      const organizationAuthority = found.organizationPermissions.includes('org:packages:publish');
      if (!projectAuthority && !organizationAuthority) return publishError(ctx, 403, 'forbidden');
      const claims = await deps.reads.source(org, key);
      if (claims.length !== 1) return publishError(ctx, 409, 'name_not_claimed');
      const source = claims[0]!;
      const guardInput = {
        tokenId: token.id,
        selector,
        projectSlug: ctx.params['project'] ?? '',
        routeProjectId: ctx.projectId,
        sourceId: source.id,
        key,
      };
      if (!(await deps.admitted(org, guardInput))) return publishError(ctx, 403, 'not_admitted');
      const authority = projectAuthority ? 'project' : 'organization';
      if (source.status !== 'active') return publishError(ctx, 409, 'source_paused');
      const binding = await deps.reads.packageBinding(org, token.id);
      if (binding === null || (binding.packageName !== null && binding.packageName !== key))
        return publishError(ctx, 403, 'package_binding');
      const requiredScanners = [...deps.requiredScanners()];
      const holdScan = requiredScanners.length > 0;
      if (
        ctx.request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
        'application/json'
      )
        return publishError(ctx, 415, 'unsupported_media_type');
      if (!ctx.request.body) return publishError(ctx, 400, 'invalid_publish_body');
      const length = ctx.request.headers.get('content-length');
      if (length === null) return publishError(ctx, 411, 'length_required');
      if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)))
        return publishError(ctx, 400, 'invalid_publish_body');
      const contentLength = Number(length);
      if (contentLength > deps.registry.caps.publishBodyBytes)
        return publishError(ctx, 413, 'publish_body_too_large');
      const now = deps.clock.now().toISOString();
      const credential = parseAuthorization(ctx.request.headers.get('authorization'));
      const pipe = new TransformStream<Uint8Array, Uint8Array>(
        undefined,
        { highWaterMark: 1 },
        { highWaterMark: 262144, size: (chunk) => chunk.byteLength },
      );
      const sink = pipe.writable.getWriter();
      const scannerAbort = new AbortController();
      const staging = deps.blob.stage(org, pipe.readable, {
        maxBytes: Math.floor((contentLength * 3) / 4),
        mediaType: 'application/gzip',
      });
      void staging.catch((error: unknown) => {
        stagingFailure = error;
        scannerAbort.abort(error);
        return sink.abort(error).catch(() => undefined);
      });
      const packagePath = name.split('/').map(encodeURIComponent).join('/').replace(/^%40/, '@');
      const tarballUrl = (version: string) =>
        `${deps.publicUrl}/${encodeURIComponent(ctx.params['project'] ?? '')}/npm/${packagePath}/-/${encodeURIComponent(name.split('/').at(-1) ?? name)}-${encodeURIComponent(version)}.tgz`;
      let validated;
      try {
        validated = await validatePublishBody(ctx.request.body, {
          name,
          caps: {
            ...deps.registry.caps,
            publishBodyBytes: Math.min(deps.registry.caps.publishBodyBytes, contentLength),
          },
          codecs: deps.codecs,
          origin: {
            importedAt: now,
            probe: {
              secrets: credential.outcome === 'token' ? [credential.token.canonical] : [],
              queryParams: [],
            },
          },
          tarballUrl,
          requireLicense: deps.registry.publish.requireLicense,
          signal: AbortSignal.any([ctx.request.signal, scannerAbort.signal]),
          onTarballChunk: (bytes) => sink.write(bytes),
        });
        await sink.close();
        staged = await staging;
      } catch (error) {
        await sink.abort(error).catch(() => undefined);
        staged = await staging.catch(() => undefined);
        throw error;
      }
      const tags = (validated.metadata['dist-tags'] ?? {}) as Record<string, string>;
      const metadata = JSON.parse(validated.input.metadata.json) as Record<string, unknown>;
      const principal = { id: ctx.principal.id, kind: ctx.principal.kind };
      const attributedMetadata = normalizeVersionMetadata('npm', {
        ...metadata,
        _npmUser: principal,
        maintainers: [principal],
      });
      const version = {
        ...validated.input,
        metadata: { ...validated.input.metadata, json: attributedMetadata.json },
      };

      const guard = deps.writeGuard(org, guardInput, anchors);
      const blob = await deps.blob.promote(org, staged, { refetchable: false });
      promoted = true;
      const blobId = await deps.reads.blobId(org, blob.sha256);
      if (blobId === null) return publishError(ctx, 503, 'unavailable');
      const versionId = ulid();
      const approvalId = source.requirePublishApproval || holdScan ? ulid() : null;
      const integrity = formatIntegrity('sha512', validated.digests.sha512);
      const event = auditEvent({
        id: ulid(),
        now,
        action: 'package.publish',
        actor: {
          type: ctx.principal.kind === 'service' ? 'service_principal' : 'user',
          id: ctx.principal.id,
        },
        context: {
          opId: ulid(),
          requestId: ctx.requestId,
          sourceIp: null,
          tokenSelector: selector,
        },
        target: { type: 'version', id: versionId },
        projectId: ctx.projectId,
        changes: Object.fromEntries(
          Object.entries({
            package: name,
            version: validated.version,
            hold_approval: source.requirePublishApproval,
            hold_scan: holdScan,
            integrity,
            size_bytes: blob.size,
            source: source.id,
            authority,
          }).map(([field, value]) => [field, { new: value }]),
        ),
      });
      if (!event.ok) return publishError(ctx, 503, 'unavailable');
      const result = await deps.writer.publishVersion(org, guard, {
        sourceId: source.id,
        key,
        description:
          typeof validated.manifest.description === 'string'
            ? validated.manifest.description
            : null,
        versionId,
        version,
        blob: {
          id: blobId,
          sha256: blob.sha256,
          sizeBytes: blob.size,
          mediaType: blob.mediaType,
          refetchable: false,
        },
        integrity,
        distTags: tags as Record<string, string>,
        readme:
          validated.readme === null ? null : { filename: 'README.md', body: validated.readme },
        approval:
          approvalId === null
            ? null
            : {
                id: approvalId,
                packageId: '',
                versionId,
                sourceId: source.id,
                holdApproval: source.requirePublishApproval,
                holdScan,
                approvalState: source.requirePublishApproval ? 'pending' : 'not_required',
                scanState: holdScan ? 'queued' : 'not_required',
                requiredScanners,
                requestedByType: ctx.principal.kind === 'service' ? 'service' : 'user',
                requestedById: ctx.principal.id,
                tokenId: token.id,
                routeProjectId: ctx.projectId,
                distTags: tags as Record<string, string>,
                readmePending: validated.readme !== null,
                scanVerdicts: [],
                expiresAt: new Date(Date.parse(now) + PUBLISH_APPROVAL_WINDOW_MS).toISOString(),
              },
        scanJobStatements: holdScan
          ? (
              await deps.scanJobs.enqueueStatements(
                org,
                'core:publish-scan:v1',
                { id: approvalId! },
                { idempotencyKey: `publish:${versionId}`, resourceKey: `publish:${versionId}` },
              )
            ).statements
          : [],
        requirePublishApproval: source.requirePublishApproval,
        routeProjectId: ctx.projectId,
        tokenId: token.id,
        now,
        event: event.event,
      });
      const response = jsonResponse(
        result.approvalId === null ? 201 : 202,
        result.approvalId === null
          ? { ok: true, id: `${name}@${validated.version}`, rev: result.rev }
          : {
              ok: true,
              id: `${name}@${validated.version}`,
              held: result.held,
              status: `${deps.publicUrl}/_pb/publishes/${result.approvalId}`,
            },
      );
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('x-request-id', ctx.requestId);
      return response;
    } catch (error) {
      if (stagingFailure instanceof BlobTooLargeError || error instanceof BlobTooLargeError)
        return publishError(ctx, 413, 'tarball_too_large');
      if (
        stagingFailure instanceof BlobAdmissionError ||
        stagingFailure instanceof BlobBusyError ||
        error instanceof BlobAdmissionError ||
        error instanceof BlobBusyError
      )
        return publishError(ctx, 503, 'busy');
      if (error instanceof MetadataTooLargeError)
        return publishError(ctx, 413, 'manifest_too_large');
      if (error instanceof PublishValidationError) {
        if (error.code === 'publish_cancelled' && stagingFailure !== undefined)
          return stagingFailure instanceof PublishValidationError
            ? publishError(ctx, stagingFailure.status, stagingFailure.code)
            : publishError(ctx, 503, 'staging_failed');
        return publishError(ctx, error.status, error.code);
      }
      if (
        error instanceof DbError &&
        error.kind === 'unique' &&
        (error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT ||
          error.constraint === 'version.package_id, version.version_normalized')
      )
        return publishError(
          ctx,
          error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT ? 403 : 409,
          error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT ? 'forbidden' : 'version_exists',
        );
      return publishError(ctx, 503, 'unavailable');
    } finally {
      if (staged && !promoted && ctx.org)
        await deps.blob.discard(ctx.org, staged).catch(() => undefined);
    }
  };
}
