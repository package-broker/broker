import type { AuditEvent } from '../../audit/actions.js';
import type { CatalogueWriteGuard } from '../../db/catalogue.js';
import type { OrgContext } from '../../db/port.js';
import { PublishValidationError } from './tarball-walk.js';

export interface DeprecationVersion {
  readonly id: string;
  readonly revision: number;
  readonly version: string;
  readonly publishedAt: string;
  readonly metadataJson: string;
  readonly npmIntegrity: string | null;
  readonly deprecatedMessage: string | null;
}
export interface DeprecationSnapshot {
  readonly packageId: string;
  readonly rev: number;
  readonly createdAt: string;
  readonly modifiedAt: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly versions: readonly DeprecationVersion[];
  /** Versions that are neither active nor tombstoned, such as quarantined or held publishes. */
  readonly inactive: number;
}
export interface DeprecationChange {
  readonly version: string;
  readonly old: string | null;
  readonly message: string;
}
export interface DeprecationStore {
  snapshot(ctx: OrgContext, sourceId: string, key: string): Promise<DeprecationSnapshot | null>;
  update(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: {
      readonly tokenId: string;
      readonly routeProjectId: string;
      readonly sourceId: string;
      readonly key: string;
      readonly snapshot: DeprecationSnapshot;
      readonly edits: readonly (DeprecationChange & { readonly event: AuditEvent })[];
    },
  ): Promise<void>;
}

/** Old and new messages both enter one audit event, whose payload is bounded. */
export const DEPRECATION_MESSAGE_MAX_BYTES = 1024;

export class ManifestUpdate extends PublishValidationError {
  constructor(readonly metadata: Record<string, unknown>) {
    super('manifest_update');
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  return (
    object(a) &&
    object(b) &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.hasOwn(b, k) && equal(a[k], b[k]))
  );
}
export function deprecationChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): readonly DeprecationChange[] {
  const fail = (): never => {
    throw new PublishValidationError('invalid_deprecation');
  };
  const oldVersions = before.versions;
  const versions = after.versions;
  if (!object(oldVersions) || !object(versions)) return fail();
  const strip = (v: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'deprecated'));
  const changes: DeprecationChange[] = [];
  if (!equal(Object.keys(oldVersions).sort(), Object.keys(versions).sort())) return fail();
  for (const [version, old] of Object.entries(oldVersions)) {
    const next = versions[version];
    if (!object(old) || !object(next) || !equal(strip(old), strip(next))) return fail();
    if (Object.hasOwn(next, 'deprecated') && typeof next.deprecated !== 'string') return fail();
    if (!equal(old.deprecated, next.deprecated)) {
      if (typeof next.deprecated !== 'string') return fail();
      if (new TextEncoder().encode(next.deprecated).byteLength > DEPRECATION_MESSAGE_MAX_BYTES)
        throw new PublishValidationError('deprecation_too_long');
      changes.push({
        version,
        old: typeof old.deprecated === 'string' ? old.deprecated : null,
        message: next.deprecated,
      });
    }
  }
  const envelope = (v: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'versions'));
  if (!equal(envelope(before), envelope(after))) return fail();
  return changes;
}
