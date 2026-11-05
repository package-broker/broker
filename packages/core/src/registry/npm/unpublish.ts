import type { AuditEvent } from '../../audit/actions.js';
import type { CatalogueWriteGuard } from '../../db/catalogue.js';
import type { OrgContext } from '../../db/port.js';
import type { DeprecationSnapshot } from './deprecate.js';
import { PublishValidationError } from './tarball-walk.js';

function canonical(value: unknown): string | undefined {
  if (Array.isArray(value)) return JSON.stringify(value.map((v) => canonical(v)));
  if (value !== null && typeof value === 'object')
    return JSON.stringify(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, v]) => [key, canonical(v)]),
    );
  return JSON.stringify(value);
}
export function removedVersions(
  before: Record<string, unknown>,
  after: unknown,
): readonly string[] {
  const invalid = (): never => {
    throw new PublishValidationError('invalid_unpublish');
  };
  if (!after || typeof after !== 'object' || Array.isArray(after)) return invalid();
  const versions = after as Record<string, unknown>;
  if (!Object.keys(versions).length) return invalid();
  for (const [version, manifest] of Object.entries(versions)) {
    if (!Object.hasOwn(before, version) || canonical(manifest) !== canonical(before[version]))
      return invalid();
  }
  const removed = Object.keys(before).filter((v) => !Object.hasOwn(versions, v));
  return removed.length ? removed : invalid();
}
export interface UnpublishStore {
  tarballRemoved(
    ctx: OrgContext,
    sourceId: string,
    key: string,
    file: string,
    revision: number,
  ): Promise<boolean>;
  remove(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: {
      readonly tokenId: string;
      readonly routeProjectId: string;
      readonly sourceId: string;
      readonly key: string;
      readonly snapshot: DeprecationSnapshot;
      readonly versions: readonly string[];
      readonly whole: boolean;
      readonly event: AuditEvent;
    },
  ): Promise<void>;
}
