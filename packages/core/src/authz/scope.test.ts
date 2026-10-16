import { describe, expect, it } from 'vitest';
import { tokenAllowedPermissions } from './catalogue.js';
import { PERMISSIONS } from './permissions.js';
import {
  SCOPE_LEVELS,
  parseScopeLevel,
  parseScopes,
  parseScopesJson,
  resolveScope,
  scopeAllows,
  tokenEffectivePermissions,
  type ScopeLevel,
} from './scope.js';

const sessionOnlyNames = PERMISSIONS.filter(({ sessionOnly }) => sessionOnly).map(
  ({ name }) => name,
);
const everything = PERMISSIONS.map(({ name }) => name);

function effective(
  level: ScopeLevel,
  grants: readonly string[] = everything,
  overrides: {
    tokenMaxScope?: ScopeLevel;
    readOnly?: boolean;
    projectMode?: 'all' | 'selected';
  } = {},
): string[] {
  return [
    ...tokenEffectivePermissions({
      grants,
      boundary: 'project',
      projectMode: overrides.projectMode ?? 'selected',
      scope: { level, readOnly: overrides.readOnly ?? level === 'read' },
      tokenMaxScope: overrides.tokenMaxScope ?? 'full',
    }),
  ].sort();
}

function effectiveOrg(
  level: ScopeLevel,
  projectMode: 'all' | 'selected',
  grants: readonly string[] = everything,
): string[] {
  return [
    ...tokenEffectivePermissions({
      grants,
      boundary: 'organization',
      projectMode,
      scope: { level, readOnly: level === 'read' },
    }),
  ].sort();
}

describe('parseScopes', () => {
  it.each(SCOPE_LEVELS)('accepts the single level %s', (level) => {
    expect(parseScopes([level])).toEqual({ ok: true, level });
  });

  it.each([
    ['empty array', [], 'empty'],
    ['unknown level', ['admin'], 'unknown'],
    ['wrong case', ['READ'], 'unknown'],
    ['non-string element', [1], 'unknown'],
    ['duplicate level', ['read', 'read'], 'duplicate'],
    ['conflicting levels', ['read', 'write'], 'conflicting'],
    ['conflicting with full', ['write', 'full'], 'conflicting'],
    ['known plus unknown', ['read', 'admin'], 'unknown'],
    ['not an array', 'read', 'malformed'],
    ['null', null, 'malformed'],
    ['object', { 0: 'read' }, 'malformed'],
    ['sparse array', new Array(1), 'unknown'],
  ])('refuses %s', (_name, input, reason) => {
    expect(parseScopes(input)).toEqual({ ok: false, reason });
  });
});

describe('resolveScope', () => {
  it('derives read_only from scope=read', () => {
    expect(resolveScope(['read'], undefined)).toEqual({ ok: true, level: 'read', readOnly: true });
    expect(resolveScope(['write'], undefined)).toEqual({
      ok: true,
      level: 'write',
      readOnly: false,
    });
    expect(resolveScope(['full'], null)).toEqual({ ok: true, level: 'full', readOnly: false });
  });

  it('accepts a stored flag that agrees', () => {
    expect(resolveScope(['read'], true)).toEqual({ ok: true, level: 'read', readOnly: true });
    expect(resolveScope(['write'], false)).toEqual({ ok: true, level: 'write', readOnly: false });
  });

  it.each(['write', 'full'] as const)('refuses %s with read_only=true', (level) => {
    expect(resolveScope([level], true)).toEqual({ ok: false, reason: 'read_only_conflict' });
  });

  it('refuses read with read_only=false', () => {
    expect(resolveScope(['read'], false)).toEqual({ ok: false, reason: 'read_only_conflict' });
  });

  it('accepts the stored column values 0 and 1', () => {
    expect(resolveScope(['read'], 1)).toEqual({ ok: true, level: 'read', readOnly: true });
    expect(resolveScope(['write'], 0)).toEqual({ ok: true, level: 'write', readOnly: false });
    expect(resolveScope(['write'], 1)).toEqual({ ok: false, reason: 'read_only_conflict' });
    expect(resolveScope(['read'], 0)).toEqual({ ok: false, reason: 'read_only_conflict' });
  });

  it('refuses other stored flag values', () => {
    expect(resolveScope(['read'], 2 as never)).toEqual({ ok: false, reason: 'malformed' });
    expect(resolveScope(['read'], 'true' as never)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('passes scope parse failures through', () => {
    expect(resolveScope([], undefined)).toEqual({ ok: false, reason: 'empty' });
    expect(resolveScope(['read', 'full'], true)).toEqual({ ok: false, reason: 'conflicting' });
  });
});

describe('scopeAllows', () => {
  it('read allows only the catalogued safe reads', () => {
    expect(scopeAllows('read', 'project:read')).toBe(true);
    expect(scopeAllows('read', 'project:packages:read')).toBe(true);
    expect(scopeAllows('read', 'project:packages:write')).toBe(false);
    expect(scopeAllows('read', 'project:audit:read')).toBe(false);
    expect(scopeAllows('read', 'project:tokens:read')).toBe(false);
    expect(scopeAllows('read', 'org:users:read')).toBe(false);
  });

  it('write adds project:packages:write only', () => {
    expect(scopeAllows('write', 'project:read')).toBe(true);
    expect(scopeAllows('write', 'project:packages:write')).toBe(true);
    expect(scopeAllows('write', 'project:sources:read')).toBe(false);
    expect(scopeAllows('write', 'project:packages:manage')).toBe(false);
  });

  it('full allows token-eligible catalogue permissions and nothing else', () => {
    for (const { name, sessionOnly } of PERMISSIONS) {
      expect(scopeAllows('full', name)).toBe(!sessionOnly);
    }
    expect(scopeAllows('full', 'project:made-up')).toBe(false);
  });
});

describe('tokenEffectivePermissions', () => {
  it('intersects read with live grants', () => {
    expect(effective('read')).toEqual(['project:packages:read', 'project:read']);
    expect(effective('read', ['project:read', 'project:packages:write'])).toEqual(['project:read']);
  });

  it('write includes read plus packages:write, bounded by grants', () => {
    expect(effective('write')).toEqual([
      'project:packages:read',
      'project:packages:write',
      'project:read',
    ]);
    expect(effective('write', ['project:packages:write'])).toEqual(['project:packages:write']);
  });

  it('full is the grants intersected with the token-eligible catalogue, not the catalogue', () => {
    const grants = ['project:read', 'project:sources:read', 'project:tokens:create'];
    expect(effective('full', grants)).toEqual(['project:read', 'project:sources:read']);
    expect(effective('full', [])).toEqual([]);
    expect(effective('full')).toEqual(
      tokenAllowedPermissions()
        .filter((name) => name.startsWith('project:'))
        .sort(),
    );
  });

  it('never contains a session-only permission, even at full', () => {
    const result = new Set(effective('full'));
    for (const name of sessionOnlyNames) expect(result.has(name)).toBe(false);
  });

  it('a full token cannot mint tokens, change grants or revoke', () => {
    const result = new Set(effective('full'));
    for (const name of [
      'project:tokens:create',
      'project:tokens:read',
      'project:tokens:revoke',
      'project:grants:write',
      'org:grants:write',
      'org:tokens:read',
      'org:tokens:revoke',
      'project:service-principals:write',
    ]) {
      expect(result.has(name)).toBe(false);
    }
  });

  it('drops grants that are not in the catalogue', () => {
    expect(effective('full', ['project:read', 'project:made-up', 'org:future:read'])).toEqual([
      'project:read',
    ]);
  });

  it('applies the project token_max_scope mask', () => {
    expect(effective('full', everything, { tokenMaxScope: 'read', readOnly: false })).toEqual([
      'project:packages:read',
      'project:read',
    ]);
    expect(effective('full', everything, { tokenMaxScope: 'write', readOnly: false })).toEqual([
      'project:packages:read',
      'project:packages:write',
      'project:read',
    ]);
    expect(effective('read', everything, { tokenMaxScope: 'write' })).toEqual([
      'project:packages:read',
      'project:read',
    ]);
  });

  it('treats a contradictory level and read_only pair as no permissions', () => {
    expect(effective('write', everything, { readOnly: true })).toEqual([]);
    expect(effective('full', everything, { readOnly: true })).toEqual([]);
    expect(effective('read', everything, { readOnly: false })).toEqual([]);
  });

  it('an uncatalogued sessionOnly default keeps a permission out of tokens', () => {
    expect(scopeAllows('full', 'project:future:thing')).toBe(false);
  });

  it('returns a read-only set', () => {
    const result = tokenEffectivePermissions({
      grants: everything,
      boundary: 'project',
      projectMode: 'selected',
      scope: { level: 'read', readOnly: true },
      tokenMaxScope: 'full',
    });
    expect(() => (result as Set<string>).add('project:tokens:create')).toThrow(TypeError);
  });
});

describe('parseScopeLevel', () => {
  it.each(SCOPE_LEVELS)('accepts %s', (level) => {
    expect(parseScopeLevel(level)).toEqual({ ok: true, level });
  });

  it.each([
    ['unknown string', 'admin', 'unknown'],
    ['empty string', '', 'unknown'],
    ['null', null, 'malformed'],
    ['array', ['read'], 'malformed'],
  ])('refuses %s', (_name, input, reason) => {
    expect(parseScopeLevel(input)).toEqual({ ok: false, reason });
  });
});

describe('parseScopesJson', () => {
  it('parses a stored one-element array', () => {
    expect(parseScopesJson('["write"]')).toEqual({ ok: true, level: 'write' });
  });

  it.each(['', '{', 'read', 'null', '{"0":"read"}'])('maps %j to malformed', (text) => {
    expect(parseScopesJson(text)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('keeps typed refusals from the parsed value', () => {
    expect(parseScopesJson('[]')).toEqual({ ok: false, reason: 'empty' });
    expect(parseScopesJson('["read","read"]')).toEqual({ ok: false, reason: 'duplicate' });
  });
});

describe('scopeAllows fallthrough', () => {
  it('denies a level outside the enum', () => {
    expect(scopeAllows('admin' as ScopeLevel, 'project:read')).toBe(false);
  });
});

describe('boundary and project mode', () => {
  const orgPermissions = PERMISSIONS.filter(
    ({ name, sessionOnly }) => name.startsWith('org:') && !sessionOnly,
  )
    .map(({ name }) => name)
    .sort();

  it('an all-project full token on an organization route gets only token-eligible org permissions', () => {
    expect(orgPermissions.length).toBeGreaterThan(0);
    expect(effectiveOrg('full', 'all')).toEqual(orgPermissions);
    expect(effectiveOrg('full', 'all', ['org:read', 'project:read', 'org:users:write'])).toEqual([
      'org:read',
    ]);
  });

  it('a selected PAT on an organization route gets nothing', () => {
    expect(effectiveOrg('full', 'selected')).toEqual([]);
  });

  it.each(['read', 'write'] as const)(
    'an all-project %s PAT on an organization route gets nothing',
    (level) => {
      expect(effectiveOrg(level, 'all')).toEqual([]);
    },
  );

  it('a contradictory scope pair yields nothing', () => {
    const input = {
      grants: everything,
      boundary: 'project',
      projectMode: 'all',
      scope: { level: 'write', readOnly: true },
      tokenMaxScope: 'full',
    } as const;
    expect(tokenEffectivePermissions(input).size).toBe(0);
  });

  it('org permissions never appear in a project-route result', () => {
    for (const level of SCOPE_LEVELS) {
      for (const projectMode of ['all', 'selected'] as const) {
        const result = effective(level, everything, { projectMode });
        expect(result.filter((name) => name.startsWith('org:'))).toEqual([]);
      }
    }
  });

  it.each(SCOPE_LEVELS.flatMap((s) => SCOPE_LEVELS.map((m) => [s, m] as const)))(
    'scope %s with token_max_scope %s yields the lower mask',
    (scope, max) => {
      const rank = { read: 0, write: 1, full: 2 } as const;
      const lower = rank[scope] <= rank[max] ? scope : max;
      expect(
        effective(scope, everything, { tokenMaxScope: max, readOnly: scope === 'read' }),
      ).toEqual(effective(lower, everything, { readOnly: lower === 'read' }));
    },
  );

  it('keeps default-flag catalogue permissions out of every token', () => {
    const defaulted = PERMISSIONS.find(({ name }) => name === 'org:settings:write')!;
    expect(defaulted.sessionOnly).toBe(true);
    expect(effectiveOrg('full', 'all', [defaulted.name])).toEqual([]);
  });

  it('filters a stored service-principal set against the current catalogue', () => {
    const stored = ['project:read', 'project:tokens:read', 'project:removed:thing'];
    expect(effective('full', stored)).toEqual(['project:read']);
  });
});
