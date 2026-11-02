import type { AuditEvent } from '../../audit/actions.js';
import type { CatalogueWriteGuard } from '../../db/catalogue.js';
import type { OrgContext } from '../../db/port.js';
import type { DeprecationSnapshot } from './deprecate.js';

export function validDistTag(tag: string): boolean {
  if (!/^[A-Za-z0-9_!~*'().-]{1,128}$/.test(tag) || tag === '.' || tag === '..') return false;
  return !npmRangeTag(tag);
}

/**
 * Parse npm's strict x-range and tilde grammar within the URL-safe tag alphabet.
 * Comparators, caret, build metadata, unions and hyphen ranges need characters
 * already excluded above. npm strips repeated v prefixes when expanding ranges,
 * but its full-version comparator accepts only one v.
 */
function npmRangeTag(tag: string): boolean {
  const part = '(0|[1-9][0-9]*|[xX*])';
  const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
  const match = new RegExp(
    `^(~)?(v*)${part}(?:\\.${part}(?:\\.${part}(?:-(${identifier}(?:\\.${identifier})*))?)?)?$`,
  ).exec(tag);
  if (!match) {
    // npm removes one star before compiling the remaining full-version comparator.
    const withoutStar = tag.replace('*', '');
    return withoutStar !== tag && /^v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(withoutStar)
      ? npmRangeTag(withoutStar)
      : false;
  }
  const [, tilde, prefix, major, minor, patch] = match;
  const parts = [major, minor, patch];
  const wildcard = parts.findIndex((value) => value === undefined || /^[xX*]$/.test(value));
  if (
    !tilde &&
    wildcard !== -1 &&
    parts.slice(wildcard + 1).some((value) => value !== undefined && !/^[xX*]$/.test(value))
  )
    return false;
  const numeric = parts.slice(0, wildcard === -1 ? 3 : wildcard).map(Number);
  if (numeric.some((value) => !Number.isSafeInteger(value))) return false;
  if (wildcard === -1 && !tilde && prefix!.length > 1) return false;
  const upper =
    wildcard === 0
      ? undefined
      : wildcard === 1
        ? numeric[0]
        : tilde || wildcard === 2
          ? numeric[1]
          : undefined;
  return upper === undefined || Number.isSafeInteger(upper + 1);
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
