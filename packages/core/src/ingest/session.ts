import type { CatalogueWriteGuard } from '../db/catalogue.js';
import type { PendingValidators } from './validators.js';
import type { OrgContext } from '../db/port.js';

export type IngestScopeRef =
  | { readonly scope: 'source'; readonly sourceId: string }
  | { readonly scope: 'package'; readonly sourceId: string; readonly packageKey: string };

export interface IngestSessionHandle {
  readonly id: string;
  readonly scopeKey: string;
  readonly owner: string;
  readonly fence: number;
  readonly leaseSeconds: number;
  readonly generation: number;
  readonly stamp: string | null;
  readonly snapshotId: string | null;
  readonly snapshotBlobSha256: string | null;
  readonly cursor: string | null;
  readonly seenCount: number;
  readonly pagesSoFar: number;
  readonly pendingValidators: Readonly<Record<string, unknown>> | null;
}

export interface IngestSessionProgress {
  readonly seenCount: number;
  readonly pagesSoFar: number;
}

export type IngestSessionState = 'running' | 'complete' | 'abandoned';

export interface IngestSessionLatest {
  readonly state: IngestSessionState;
  readonly generation: number;
  readonly fence: number;
  readonly seenCount: number;
  readonly pagesSoFar: number;
}

export interface IngestSessions {
  acquire(
    ctx: OrgContext,
    scope: IngestScopeRef,
    owner: string,
    leaseSeconds: number,
  ): Promise<IngestSessionHandle | 'held'>;
  /** Records the snapshot and stamp of a new generation; false when the stamp is already set or the handle is superseded. */
  start(
    ctx: OrgContext,
    guard: IngestSessionHandle,
    input: {
      readonly snapshot: { readonly id: string; readonly blobSha256?: string };
      readonly stamp: string;
    },
  ): Promise<boolean>;
  /**
   * Extends the lease by the acquired duration; null when the handle is expired or superseded, or
   * when `writeGuard` (run in the same batch) fails.
   */
  advance(
    ctx: OrgContext,
    guard: IngestSessionHandle,
    input: { readonly cursor: string | null; readonly addSeen: number },
    writeGuard?: CatalogueWriteGuard,
  ): Promise<IngestSessionProgress | null>;
  setPendingValidators(
    ctx: OrgContext,
    guard: IngestSessionHandle,
    validators: PendingValidators | null,
  ): Promise<boolean>;
  /** An expired holder must re-acquire (fence + 1), then abandon with the new handle. */
  abandon(ctx: OrgContext, guard: IngestSessionHandle): Promise<boolean>;
  /** Newest generation of the scope in this org, or null; read-only, only `complete` means filled. */
  latest(ctx: OrgContext, scope: IngestScopeRef): Promise<IngestSessionLatest | null>;
}

export interface IngestSessionSweep {
  readonly abandoned: number;
  readonly deleted: number;
}

/** Cross-org maintenance; kept apart from `IngestSessions` so ingest consumers never see it. */
export interface IngestSessionMaintenance {
  /** Marks long-dead running sessions abandoned and deletes finished generations that have a newer one, each at most `limit` per run. */
  sweep(limit: number): Promise<IngestSessionSweep>;
}
