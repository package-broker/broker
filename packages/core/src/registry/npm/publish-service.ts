import { deprecationChanges, ManifestUpdate, type DeprecationStore } from './deprecate.js';
import { manifest } from './render.js';
import { removedVersions, type UnpublishStore } from './unpublish.js';
import { validDistTag } from './dist-tags.js';
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
  readonly permission?: 'project:packages:manage';
}
export interface PublishDependencies {
  readonly unpublish?: UnpublishStore;
  readonly deprecations?: DeprecationStore;
  readonly distTags?: import('./dist-tags.js').DistTagStore;
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
        npmManagement: true,
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
      const manageAuthority = found.projectPermissions.includes('project:packages:manage');
      if (!projectAuthority && !organizationAuthority && !manageAuthority)
        return publishError(ctx, 403, 'forbidden');
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
      const publishAuthority = projectAuthority || organizationAuthority;
      const staging: Promise<StagedBlob | undefined> = publishAuthority
        ? deps.blob.stage(org, pipe.readable, {
            maxBytes: Math.floor((contentLength * 3) / 4),
            mediaType: 'application/gzip',
          })
        : Promise.resolve(undefined);
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
          refuseAttachments: !publishAuthority,
          signal: AbortSignal.any([ctx.request.signal, scannerAbort.signal]),
          onTarballChunk: (bytes) => sink.write(bytes),
        });
        await sink.close();
        staged = await staging;
      } catch (error) {
        await sink.abort(error).catch(() => undefined);
        staged = await staging.catch(() => undefined);
        if (error instanceof ManifestUpdate) {
          if (!manageAuthority) return publishError(ctx, 403, 'forbidden');
          if (!deps.deprecations) return publishError(ctx, 503, 'unavailable');
          const snapshot = await deps.deprecations.snapshot(org, source.id, key);
          if (!snapshot) return publishError(ctx, 404, 'not_found');
          const before = {
            _id: name,
            _rev: String(snapshot.rev),
            name,
            'dist-tags': snapshot.tags,
            versions: Object.fromEntries(
              snapshot.versions.map((v) => [
                v.version,
                manifest(
                  { publicUrl: deps.publicUrl, projectSlug: ctx.params['project'] ?? '' },
                  v,
                  name,
                ),
              ]),
            ),
            time: {
              created: snapshot.createdAt,
              modified: snapshot.modifiedAt,
              ...Object.fromEntries(snapshot.versions.map((v) => [v.version, v.publishedAt])),
            },
          };
          const changes = deprecationChanges(before, error.metadata).map((change) => {
            const version = snapshot.versions.find((v) => v.version === change.version)!;
            const event = auditEvent({
              id: ulid(),
              now,
              action: 'package.deprecate',
              actor: {
                type: ctx.principal!.kind === 'service' ? 'service_principal' : 'user',
                id: ctx.principal!.id,
              },
              context: {
                opId: ulid(),
                requestId: ctx.requestId,
                sourceIp: null,
                tokenSelector: selector,
              },
              target: { type: 'version', id: version.id },
              projectId: ctx.projectId,
              changes: {
                version: { new: change.version },
                deprecated: { old: change.old, new: change.message },
              },
            });
            if (!event.ok) throw new PublishValidationError('invalid_deprecation');
            return { ...change, event: event.event };
          });
          try {
            await deps.deprecations.update(
              org,
              deps.writeGuard(
                org,
                { ...guardInput, permission: 'project:packages:manage' },
                anchors,
              ),
              {
                tokenId: token.id,
                routeProjectId: ctx.projectId,
                sourceId: source.id,
                key,
                snapshot,
                edits: changes,
              },
            );
          } catch (failure) {
            if (
              failure instanceof DbError &&
              failure.kind === 'unique' &&
              failure.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
            )
              return publishError(ctx, 409, 'conflict');
            throw failure;
          }
          const response = jsonResponse(200, { ok: true });
          response.headers.set('Cache-Control', 'no-store');
          response.headers.set('x-request-id', ctx.requestId);
          return response;
        }
        throw error;
      }
      if (!publishAuthority || staged === undefined) return publishError(ctx, 403, 'forbidden');
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

export function createDistTagService(deps: PublishServiceDeps) {
  return async (ctx: RequestContext, name: string, tag: string): Promise<Response> => {
    const invalid = () => publishError(ctx, 400, 'invalid_dist_tag');
    if (!validDistTag(tag) || (ctx.request.method === 'DELETE' && tag === 'latest'))
      return invalid();
    const access = accessContextOf(ctx);
    const token = access?.token;
    const selector =
      access?.rateKey.stage === 'authenticated' ? access.rateKey.tokenSelector : null;
    if (!ctx.org || !ctx.projectId || !ctx.principal || !token || !selector)
      return publishError(ctx, 401, 'token_required');
    if (token.scope !== 'full' || token.readOnly) return publishError(ctx, 403, 'forbidden');
    const anchors = await deps.anchors(ctx.org);
    const found = await deps.lookupToken(ctx.org, {
      boundary: 'project',
      projectSlug: ctx.params['project'] ?? '',
      selector,
      providerAnchors: anchors,
      npmManagement: true,
    });
    if (
      !found ||
      found.token.id !== token.id ||
      found.project?.id !== ctx.projectId ||
      !found.projectPermissions.includes('project:packages:manage')
    )
      return publishError(ctx, 403, 'forbidden');
    let key;
    try {
      key = packageKey(name, { ecosystem: 'npm' });
    } catch {
      return invalid();
    }
    const sources = await deps.reads.source(ctx.org, key);
    if (sources.length !== 1) return publishError(ctx, 405, 'write_unsupported');
    const sourceId = sources[0]!.id;
    if (!deps.deprecations || !deps.distTags) return publishError(ctx, 503, 'unavailable');
    const snapshot = await deps.deprecations.snapshot(ctx.org, sourceId, key);
    if (!snapshot) return publishError(ctx, 404, 'not_found');
    if (ctx.request.method === 'DELETE' && !Object.hasOwn(snapshot.tags, tag)) return invalid();
    let version: string | null = null;
    if (ctx.request.method === 'PUT') {
      if (ctx.request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        return publishError(ctx, 415, 'unsupported_media_type');
      const reader = ctx.request.body?.getReader();
      if (!reader) return invalid();
      try {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > 1024) return invalid();
          chunks.push(part.value);
        }
        const value: unknown = JSON.parse(await new Blob(chunks).text());
        if (typeof value !== 'string') return invalid();
        version = value;
      } catch {
        return invalid();
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
      if (!snapshot.versions.some((v) => v.version === version)) return invalid();
    }
    const input = {
      tokenId: token.id,
      selector,
      projectSlug: ctx.params['project'] ?? '',
      routeProjectId: ctx.projectId,
      sourceId,
      key,
      permission: 'project:packages:manage' as const,
    };
    if (!(await deps.admitted(ctx.org, input))) return publishError(ctx, 403, 'not_admitted');
    const event = auditEvent({
      id: ulid(),
      now: deps.clock.now().toISOString(),
      action: 'package.dist_tag',
      actor: {
        type: ctx.principal.kind === 'service' ? 'service_principal' : 'user',
        id: ctx.principal.id,
      },
      target: { type: 'package', id: snapshot.packageId },
      projectId: ctx.projectId,
      context: { opId: ulid(), requestId: ctx.requestId, sourceIp: null, tokenSelector: selector },
      changes: { tag: { new: tag }, version: { old: snapshot.tags[tag] ?? null, new: version } },
    });
    if (!event.ok) return invalid();
    try {
      await deps.distTags.update(ctx.org, deps.writeGuard(ctx.org, input, anchors), {
        ...input,
        snapshot,
        tag,
        version,
        event: event.event,
      });
    } catch (error) {
      if (
        error instanceof DbError &&
        error.kind === 'unique' &&
        error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
      )
        return publishError(ctx, 409, 'conflict');
      return publishError(ctx, 503, 'unavailable');
    }
    const response = jsonResponse(200, { ok: true });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
}

export function createUnpublishService(deps: PublishServiceDeps) {
  return async (
    ctx: RequestContext,
    name: string,
    revision: string,
    file?: string,
  ): Promise<Response> => {
    const invalid = () => publishError(ctx, 400, 'invalid_unpublish');
    if (!/^[1-9]\d{0,15}$/.test(revision) || !Number.isSafeInteger(Number(revision)))
      return invalid();
    const access = accessContextOf(ctx);
    const token = access?.token;
    const selector =
      access?.rateKey.stage === 'authenticated' ? access.rateKey.tokenSelector : null;
    if (!ctx.org || !ctx.projectId || !ctx.principal || !token || !selector)
      return publishError(ctx, 401, 'token_required');
    if (token.scope !== 'full' || token.readOnly) return publishError(ctx, 403, 'forbidden');
    const anchors = await deps.anchors(ctx.org);
    const found = await deps.lookupToken(ctx.org, {
      boundary: 'project',
      projectSlug: ctx.params['project'] ?? '',
      selector,
      providerAnchors: anchors,
      npmManagement: true,
    });
    if (
      !found ||
      found.token.id !== token.id ||
      found.project?.id !== ctx.projectId ||
      !found.projectPermissions.includes('project:packages:manage')
    )
      return publishError(ctx, 403, 'forbidden');
    let key;
    try {
      key = packageKey(name, { ecosystem: 'npm' });
    } catch {
      return invalid();
    }
    const sources = await deps.reads.source(ctx.org, key);
    if (sources.length !== 1) return publishError(ctx, 405, 'write_unsupported');
    const sourceId = sources[0]!.id;
    if (!deps.deprecations || !deps.unpublish) return publishError(ctx, 503, 'unavailable');
    const input = {
      tokenId: token.id,
      selector,
      projectSlug: ctx.params['project'] ?? '',
      routeProjectId: ctx.projectId,
      sourceId,
      key,
      permission: 'project:packages:manage' as const,
    };
    if (!(await deps.admitted(ctx.org, input))) return publishError(ctx, 403, 'not_admitted');
    const success = () => {
      const response = jsonResponse(200, { ok: true });
      response.headers.set('Cache-Control', 'no-store');
      return response;
    };
    const snapshot = await deps.deprecations.snapshot(ctx.org, sourceId, key);
    if (
      file &&
      (await deps.unpublish.tarballRemoved(ctx.org, sourceId, key, file, Number(revision)))
    )
      return success();
    if (!snapshot) return publishError(ctx, 404, 'not_found');
    if (String(snapshot.rev) !== revision) return publishError(ctx, 409, 'conflict');
    let versions: readonly string[] = snapshot.versions.map((v) => v.version);
    const whole = !file && ctx.request.method === 'DELETE';
    if (file) {
      const base = name.slice(name.lastIndexOf('/') + 1);
      versions = snapshot.versions
        .filter((v) => `${base}-${v.version}.tgz` === file)
        .map((v) => v.version);
      if (!versions.length) return publishError(ctx, 404, 'not_found');
    } else if (!whole) {
      if (ctx.request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json')
        return publishError(ctx, 415, 'unsupported_media_type');
      const reader = ctx.request.body?.getReader();
      if (!reader) return invalid();
      try {
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > deps.registry.caps.publishMetadataBytes)
            return publishError(ctx, 413, 'publish_body_too_large');
          chunks.push(part.value);
        }
        const body: unknown = JSON.parse(await new Blob(chunks).text());
        if (!body || typeof body !== 'object' || Array.isArray(body)) return invalid();
        const value = body as Record<string, unknown>;
        if (value._rev !== revision || value.name !== name) return invalid();
        const before = Object.fromEntries(
          snapshot.versions.map((v) => [
            v.version,
            manifest(
              { publicUrl: deps.publicUrl, projectSlug: ctx.params['project'] ?? '' },
              v,
              name,
            ),
          ]),
        );
        versions = removedVersions(before, value.versions);
        deprecationChanges(
          {
            _id: name,
            name,
            _rev: revision,
            'dist-tags': snapshot.tags,
            versions: before,
            time: {
              created: snapshot.createdAt,
              modified: snapshot.modifiedAt,
              ...Object.fromEntries(snapshot.versions.map((v) => [v.version, v.publishedAt])),
            },
          },
          { ...value, versions: before, 'dist-tags': snapshot.tags },
        );
      } catch {
        return invalid();
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    if (whole && snapshot.inactive > 0) return publishError(ctx, 409, 'unpublish_blocked');
    const now = deps.clock.now();
    if (
      snapshot.versions.some(
        (v) =>
          versions.includes(v.version) &&
          (Date.parse(v.publishedAt) < now.getTime() - 259200000 ||
            Date.parse(v.publishedAt) > now.getTime()),
      )
    )
      return publishError(ctx, 409, 'unpublish_window');
    const event = auditEvent({
      id: ulid(),
      now: now.toISOString(),
      action: 'package.unpublish',
      actor: {
        type: ctx.principal.kind === 'service' ? 'service_principal' : 'user',
        id: ctx.principal.id,
      },
      target: { type: 'package', id: snapshot.packageId },
      projectId: ctx.projectId,
      context: { opId: ulid(), requestId: ctx.requestId, sourceIp: null, tokenSelector: selector },
      changes: { versions: { old: versions } },
    });
    if (!event.ok) return invalid();
    try {
      await deps.unpublish.remove(ctx.org, deps.writeGuard(ctx.org, input, anchors), {
        ...input,
        snapshot,
        versions,
        whole,
        event: event.event,
      });
    } catch (error) {
      if (
        error instanceof DbError &&
        error.kind === 'unique' &&
        error.constraint === ACCESS_MUTATION_GUARD_CONSTRAINT
      )
        return publishError(ctx, 409, 'conflict');
      return publishError(ctx, 503, 'unavailable');
    }
    return success();
  };
}
