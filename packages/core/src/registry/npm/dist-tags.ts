import type { AuditEvent } from '../../audit/actions.js';
import type { CatalogueWriteGuard } from '../../db/catalogue.js';
import type { OrgContext } from '../../db/port.js';
import type { DeprecationSnapshot } from './deprecate.js';

export function validDistTag(tag: string): boolean {
  if (!/^[A-Za-z0-9_!~*'().-]{1,128}$/.test(tag) || tag === '.' || tag === '..') return false;
  const range = tag.startsWith('~') ? tag.slice(1) : tag;
  return !/^[vV]?(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2}(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    range,
  );
}

export interface DistTagStore {
  update(
    ctx: OrgContext,
    guard: CatalogueWriteGuard,
    input: {
      readonly tokenId: string;
      readonly routeProjectId: string;
      readonly sourceId: string;
      readonly key: string;
      readonly snapshot: DeprecationSnapshot;
      readonly tag: string;
      readonly version: string | null;
      readonly event: AuditEvent;
    },
  ): Promise<void>;
}
