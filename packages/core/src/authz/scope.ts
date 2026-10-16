import { catalogueTokenEligible } from './catalogue.js';
import { effectivePermissions } from './permissions.js';

export const SCOPE_LEVELS = Object.freeze(['read', 'write', 'full'] as const);

export type ScopeLevel = (typeof SCOPE_LEVELS)[number];

export type ScopeRefusal =
  'malformed' | 'empty' | 'unknown' | 'duplicate' | 'conflicting' | 'read_only_conflict';

export type ScopeParse = { readonly ok: true; readonly level: ScopeLevel } | RefusedScope;

export type ScopeResolution =
  { readonly ok: true; readonly level: ScopeLevel; readonly readOnly: boolean } | RefusedScope;

interface RefusedScope {
  readonly ok: false;
  readonly reason: ScopeRefusal;
}

function isScopeLevel(value: unknown): value is ScopeLevel {
  return typeof value === 'string' && (SCOPE_LEVELS as readonly string[]).includes(value);
}

export function parseScopeLevel(input: unknown): ScopeParse {
  if (typeof input !== 'string') return { ok: false, reason: 'malformed' };
  return isScopeLevel(input) ? { ok: true, level: input } : { ok: false, reason: 'unknown' };
}

export function parseScopes(input: unknown): ScopeParse {
  if (!Array.isArray(input)) return { ok: false, reason: 'malformed' };
  if (input.length === 0) return { ok: false, reason: 'empty' };
  const entries: unknown[] = Array.from(input);
  if (!entries.every(isScopeLevel)) return { ok: false, reason: 'unknown' };
  const distinct = new Set<ScopeLevel>(entries);
  if (distinct.size > 1) return { ok: false, reason: 'conflicting' };
  if (entries.length > 1) return { ok: false, reason: 'duplicate' };
  return { ok: true, level: entries[0] as ScopeLevel };
}

export function parseScopesJson(text: string): ScopeParse {
  try {
    return parseScopes(JSON.parse(text));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
}

// Issuance must persist read_only = (scope === 'read') so stored rows always agree.
export function resolveScope(
  input: unknown,
  storedReadOnly: boolean | 0 | 1 | null | undefined,
): ScopeResolution {
  const parsed = parseScopes(input);
  if (!parsed.ok) return parsed;
  const readOnly = parsed.level === 'read';
  if (storedReadOnly !== undefined && storedReadOnly !== null) {
    if (
      storedReadOnly !== true &&
      storedReadOnly !== false &&
      storedReadOnly !== 0 &&
      storedReadOnly !== 1
    ) {
      return { ok: false, reason: 'malformed' };
    }
    if (Boolean(storedReadOnly) !== readOnly) return { ok: false, reason: 'read_only_conflict' };
  }
  return { ok: true, level: parsed.level, readOnly };
}

const READ_MASK: ReadonlySet<string> = new Set(['project:read', 'project:packages:read']);
const WRITE_MASK: ReadonlySet<string> = new Set([...READ_MASK, 'project:packages:write']);

export function scopeAllows(level: ScopeLevel, permission: string): boolean {
  if (!catalogueTokenEligible(permission)) return false;
  switch (level) {
    case 'read':
      return READ_MASK.has(permission);
    case 'write':
      return WRITE_MASK.has(permission);
    case 'full':
      return true;
    default:
      return false;
  }
}

export type TokenProjectMode = 'all' | 'selected';

interface TokenPermissionBase {
  readonly grants: readonly string[];
  readonly projectMode: TokenProjectMode;
  readonly scope: { readonly level: ScopeLevel; readonly readOnly: boolean };
}

export type TokenPermissionInput =
  | (TokenPermissionBase & { readonly boundary: 'organization' })
  | (TokenPermissionBase & { readonly boundary: 'project'; readonly tokenMaxScope: ScopeLevel });

const NONE: ReadonlySet<string> = effectivePermissions([]);

export function tokenEffectivePermissions(input: TokenPermissionInput): ReadonlySet<string> {
  const { grants, scope } = input;
  if (scope.readOnly !== (scope.level === 'read')) return NONE;
  if (input.boundary === 'organization') {
    if (input.projectMode !== 'all' || scope.level !== 'full') return NONE;
    return effectivePermissions(
      grants.filter((name) => name.startsWith('org:') && scopeAllows('full', name)),
    );
  }
  if (input.boundary !== 'project') return NONE;
  return effectivePermissions(
    grants.filter(
      (name) =>
        name.startsWith('project:') &&
        scopeAllows(scope.level, name) &&
        scopeAllows(input.tokenMaxScope, name),
    ),
  );
}
