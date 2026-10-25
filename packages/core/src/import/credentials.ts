import { auditEvent, type AuditContext, type AuditEvent } from '../audit/actions.js';
import {
  fenceKind,
  type FencedOutcome,
  type MutationFence,
  type TokenMutationFence,
} from '../authz/fence.js';
import type { OrgContext, Statement } from '../db/port.js';
import type { CredentialStore } from '../secrets/credential-store.js';
import { stripCredentialEcho } from '../sources/credential-echo.js';
import {
  credentialEchoProbe,
  CredentialError,
  parseCredentialMaterial,
  type CredentialKind,
  type CredentialMaterial,
} from '../sources/credentials.js';
import { parseManifest } from './manifest.js';

export interface CredentialTarget {
  readonly approvedAt: string | null;
  readonly credentialWindowUntil: string | null;
  readonly manifest: string;
  readonly source: {
    readonly id: string;
    readonly projectId: string | null;
    readonly credentialId: string | null;
  } | null;
}

/**
 * Organization-scoped inspection hides absent, foreign, archived and invisible runs even when
 * authority is missing. allowed requires live org:import:write. source is present only for a
 * matching import_ref with entity_type=source, action=create and no rolled_back_at.
 *
 * setCredential rechecks visibility, live authority, approval, window, source binding and a null
 * credential_id against database time. Credential insertion, binding, audit and optional
 * idempotency run atomically in one fenced batch.
 */
export interface ImportCredentialStore {
  inspect(
    ctx: OrgContext,
    fence: MutationFence | TokenMutationFence,
    runId: string,
    externalRef: string,
    now: string,
  ): Promise<{ readonly target: CredentialTarget | null; readonly allowed: boolean }>;
  /**
   * Organization-scoped read of a run's stored manifest and the external refs of its imported
   * sources (matching import_ref, entity_type=source, action=create, not rolled back) that hold a
   * credential. Absent and foreign runs return null; a run without a stored manifest has none;
   * a stored manifest missing from the blob store is 'unavailable'.
   */
  bindings(
    ctx: OrgContext,
    runId: string,
  ): Promise<
    { readonly manifest: string | null; readonly bound: readonly string[] } | 'unavailable' | null
  >;
  setCredential(
    ctx: OrgContext,
    fence: MutationFence | TokenMutationFence,
    input: {
      readonly runId: string;
      readonly externalRef: string;
      readonly sourceId: string;
      readonly expected: { readonly approvedAt: string; readonly credentialWindowUntil: string };
      readonly credential: { readonly id: string; readonly statement: Statement };
      readonly audit: Statement;
      readonly idempotency?: Statement;
      readonly now: string;
    },
  ): Promise<FencedOutcome | { readonly ok: false; readonly reason: 'not_found' | 'conflict' }>;
}

export type ImportCredentialError =
  'not_found' | 'forbidden' | 'conflict' | 'invalid_credential' | 'too_large' | 'unavailable';

export type ImportCredentialResult =
  | { readonly ok: true; readonly value: null }
  | { readonly ok: false; readonly error: ImportCredentialError };

export interface ImportCredentialInput {
  readonly runId: string;
  readonly externalRef: string;
  readonly kind: CredentialKind;
  readonly material: string | Uint8Array;
  readonly now: string;
  readonly context: AuditContext;
  readonly idempotency?: Statement;
}

export interface ImportCredentialBinding {
  readonly sourceRef: string;
  readonly bound: boolean;
}

export type ImportCredentialStatusResult =
  | { readonly ok: true; readonly value: readonly ImportCredentialBinding[] }
  | { readonly ok: false; readonly error: 'not_found' | 'unavailable' };

export interface ImportCredentialService {
  /** Binding state of every credential-bearing source in the run's manifest; no credential data. */
  credentialStatus(ctx: OrgContext, runId: string): Promise<ImportCredentialStatusResult>;
  acceptImportCredential(
    ctx: OrgContext,
    fence: MutationFence | TokenMutationFence,
    input: ImportCredentialInput,
  ): Promise<ImportCredentialResult>;
}

const fail = (error: ImportCredentialError): ImportCredentialResult => ({ ok: false, error });

export function createImportCredentialService(deps: {
  readonly store: ImportCredentialStore;
  readonly credentials: Pick<CredentialStore, 'prepare'>;
  readonly runtime: 'node' | 'cloudflare';
  readonly ids: { ulid(): string };
  readonly auditStatement: (ctx: OrgContext, event: AuditEvent) => Statement;
}): ImportCredentialService {
  return {
    async credentialStatus(ctx, runId) {
      const stored = await deps.store.bindings(ctx, runId);
      if (stored === null) return { ok: false, error: 'not_found' };
      if (stored === 'unavailable') return { ok: false, error: 'unavailable' };
      if (stored.manifest === null) return { ok: true, value: [] };
      let manifest: unknown;
      try {
        manifest = JSON.parse(stored.manifest);
      } catch {
        return { ok: false, error: 'unavailable' };
      }
      const parsed = parseManifest(manifest);
      if (!parsed.ok) return { ok: false, error: 'unavailable' };
      const bound = new Set(stored.bound);
      return {
        ok: true,
        value: parsed.data.items.flatMap((item) =>
          item.type === 'source' && item.credential_ref !== null
            ? [{ sourceRef: item.external_ref, bound: bound.has(item.external_ref) }]
            : [],
        ),
      };
    },
    async acceptImportCredential(ctx, fence, input) {
      const kind = fenceKind(fence);
      if (kind !== 'session' && kind !== 'token')
        throw new TypeError('import credentials require a session or token fence');
      if (kind === 'token' && (fence as TokenMutationFence).permission !== 'org:import:write')
        throw new TypeError('import credentials require an import write fence');
      try {
        const { target, allowed } = await deps.store.inspect(
          ctx,
          fence,
          input.runId,
          input.externalRef,
          input.now,
        );
        if (target === null) return fail('not_found');
        if (!allowed) return fail('forbidden');
        let manifest: unknown;
        try {
          manifest = JSON.parse(target.manifest);
        } catch {
          return fail('unavailable');
        }
        const parsed = parseManifest(manifest);
        if (!parsed.ok) return fail('unavailable');
        const item = parsed.data.items.find(
          (entry) => entry.type === 'source' && entry.external_ref === input.externalRef,
        );
        if (item?.type !== 'source' || item.credential_ref === null) return fail('not_found');
        if (target.approvedAt === null) return fail('conflict');
        const now = Date.parse(input.now);
        const until =
          target.credentialWindowUntil === null ? NaN : Date.parse(target.credentialWindowUntil);
        if (!Number.isFinite(now) || !Number.isFinite(until) || now >= until)
          return fail('conflict');
        const source = target.source;
        if (source === null || source.credentialId !== null) return fail('conflict');
        if (typeof input.material === 'string' && input.material.length > 16384)
          return fail('too_large');
        if (input.material instanceof Uint8Array && input.material.byteLength > 16384)
          return fail('too_large');
        const plaintext =
          typeof input.material === 'string'
            ? new TextEncoder().encode(input.material)
            : Uint8Array.from(input.material);
        try {
          if (plaintext.byteLength > 16384) return fail('too_large');
          let material: CredentialMaterial;
          try {
            material = parseCredentialMaterial(input.kind, plaintext);
          } catch (error) {
            if (error instanceof CredentialError) return fail('invalid_credential');
            throw error;
          }
          if (
            (input.kind === 'github_app' &&
              (item.source_type !== 'vcs' ||
                !('provider' in item.config) ||
                item.config.provider !== 'github' ||
                item.project !== null)) ||
            (input.kind === 'query' && item.source_type !== 'composer_repository') ||
            (input.kind === 'ssh_key' && deps.runtime !== 'node')
          )
            return fail('invalid_credential');
          const actor =
            kind === 'session'
              ? { type: 'user' as const, id: (fence as MutationFence).userId }
              : {
                  type:
                    (fence as TokenMutationFence).tokenKind === 'svc'
                      ? ('service_principal' as const)
                      : ('user' as const),
                  id: (fence as TokenMutationFence).principalId,
                };
          const audit = auditEvent({
            id: deps.ids.ulid(),
            now: input.now,
            action: 'import_run.credential_set',
            actor,
            context: input.context,
            target: { type: 'import_run', id: input.runId },
            projectId: source.projectId,
            changes: { external_ref: { new: input.externalRef } },
          });
          if (!audit.ok) return fail('unavailable');
          const checked = stripCredentialEcho(audit.event, credentialEchoProbe(material));
          if (checked.refused || checked.stripped.length > 0) return fail('unavailable');
          const credential = await deps.credentials.prepare(ctx, {
            kind: input.kind,
            projectId: source.projectId,
            plaintext,
          });
          const answer = await deps.store.setCredential(ctx, fence, {
            runId: input.runId,
            externalRef: input.externalRef,
            sourceId: source.id,
            expected: {
              approvedAt: target.approvedAt,
              credentialWindowUntil: target.credentialWindowUntil!,
            },
            credential,
            audit: deps.auditStatement(ctx, audit.event),
            ...(input.idempotency === undefined ? {} : { idempotency: input.idempotency }),
            now: input.now,
          });
          if (answer.ok) return { ok: true, value: null };
          switch (answer.reason) {
            case 'not_found':
              return fail('not_found');
            case 'authority':
              return fail('forbidden');
            case 'conflict':
            case 'collision':
              return fail('conflict');
            case 'unclassified':
            case 'indeterminate':
              return fail('unavailable');
          }
        } finally {
          plaintext.fill(0);
        }
      } catch {
        return fail('unavailable');
      }
    },
  };
}
