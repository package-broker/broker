import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLES,
  PERMISSIONS,
  PERMISSION_PATTERN,
  effectivePermissions,
  isPermission,
  missingCatalogue,
  rolePermissionProblems,
} from './permissions.js';

// Columns: name, scope, then session only, admin, organization auditor, owner, developer, auditor.
const matrix = [
  ['org:read', 'organization', '011000'],
  ['org:settings:write', 'organization', '110000'],
  ['org:users:read', 'organization', '011000'],
  ['org:users:write', 'organization', '110000'],
  ['org:roles:read', 'organization', '011000'],
  ['org:roles:write', 'organization', '110000'],
  ['org:grants:read', 'organization', '011000'],
  ['org:grants:write', 'organization', '110000'],
  ['org:projects:create', 'organization', '110000'],
  ['org:projects:archive', 'organization', '110000'],
  ['org:sources:read', 'organization', '011000'],
  ['org:sources:write', 'organization', '110000'],
  ['org:tokens:read', 'organization', '111000'],
  ['org:tokens:revoke', 'organization', '110000'],
  ['org:service-principals:write', 'organization', '110000'],
  ['org:audit:read', 'organization', '011000'],
  ['project:read', 'project', '011111'],
  ['project:settings:write', 'project', '110100'],
  ['project:grants:read', 'project', '011101'],
  ['project:grants:write', 'project', '110100'],
  ['project:packages:read', 'project', '011111'],
  ['project:packages:write', 'project', '010110'],
  ['project:packages:manage', 'project', '110100'],
  ['project:sources:read', 'project', '011111'],
  ['project:sources:write', 'project', '110100'],
  ['project:service-principals:write', 'project', '110100'],
  ['project:tokens:create', 'project', '110110'],
  ['project:tokens:read', 'project', '111101'],
  ['project:tokens:revoke', 'project', '110100'],
  ['project:audit:read', 'project', '011101'],
] as const;

const roles = [
  ['organization_admin', 'Organization Admin', 'organization'],
  ['organization_auditor', 'Organization Auditor', 'organization'],
  ['project_owner', 'Project Owner', 'project'],
  ['project_developer', 'Project Developer', 'project'],
  ['project_auditor', 'Project Auditor', 'project'],
] as const;

describe('permission catalogue', () => {
  it('matches every catalogue and default-role matrix cell', () => {
    expect(PERMISSIONS.map(({ name }) => name)).toEqual(matrix.map(([name]) => name));
    expect(PERMISSIONS).toHaveLength(30);
    expect(PERMISSIONS.filter(({ scope }) => scope === 'organization')).toHaveLength(16);
    expect(PERMISSIONS.filter(({ scope }) => scope === 'project')).toHaveLength(14);
    expect(DEFAULT_ROLES).toHaveLength(5);
    for (const [index, [key, name, scope]] of roles.entries()) {
      const role = DEFAULT_ROLES[index]!;
      expect(role).toMatchObject({ key, name, scope, protectsLastHolder: index === 0 });
      expect(role.permissions).toEqual(
        matrix.filter(([, , cells]) => cells[index + 1] === '1').map(([permission]) => permission),
      );
      expect(rolePermissionProblems(scope, role.permissions)).toEqual([]);
    }
    expect(DEFAULT_ROLES[2]!.permissions).toHaveLength(14);
    for (const [index, [name, scope, cells]] of matrix.entries()) {
      expect(PERMISSIONS[index]).toMatchObject({
        name,
        scope,
        sessionOnly: cells[0] === '1',
      });
      expect(PERMISSIONS[index]!.description.trim().length).toBeGreaterThan(0);
      expect(name).toMatch(PERMISSION_PATTERN);
      expect(isPermission(name)).toBe(true);
    }
    expect(new Set(PERMISSIONS.map(({ name }) => name)).size).toBe(30);
    expect(DEFAULT_ROLES[0]!.permissions).toHaveLength(30);
  });

  it('validates unknown names, project scope violations and duplicates', () => {
    expect(rolePermissionProblems('project', ['org:read'])).toEqual([
      'Organization permission in project role: "org:read"',
    ]);
    expect(rolePermissionProblems('organization', ['org:read', 'project:read'])).toEqual([]);
    expect(rolePermissionProblems('organization', ['bogus'])).toEqual([
      'Unknown permission: "bogus"',
    ]);
    expect(rolePermissionProblems('project', ['project:unknown'])).toEqual([
      'Unknown permission: "project:unknown"',
    ]);
    expect(rolePermissionProblems('project', ['org:unknown'])).toEqual([
      'Unknown permission: "org:unknown"',
    ]);
    expect(rolePermissionProblems('project', ['project:read', 'project:read'])).toEqual([
      'Duplicate permission: "project:read"',
    ]);
    expect(
      rolePermissionProblems('project', ['org:read', 'bogus', 'project:read', 'project:read']),
    ).toEqual([
      'Organization permission in project role: "org:read"',
      'Unknown permission: "bogus"',
      'Duplicate permission: "project:read"',
    ]);
    expect(rolePermissionProblems('project', [])).toEqual([]);
    for (const name of [
      'bogus',
      'project:unknown',
      'org:Read',
      'project:',
      'project:read:extra:part',
    ]) {
      expect(isPermission(name)).toBe(false);
    }
    for (const name of ['org:Read', 'project:', 'project:read:extra:part', 'org:bad--name']) {
      expect(PERMISSION_PATTERN.test(name)).toBe(false);
    }
  });

  it('quotes and truncates caller-supplied names in problem text', () => {
    expect(rolePermissionProblems('organization', ['bad"name'])).toEqual([
      'Unknown permission: "bad\\"name"',
    ]);
    expect(rolePermissionProblems('organization', ['line\nbreak'])).toEqual([
      'Unknown permission: "line\\nbreak"',
    ]);
    const longName = 'x'.repeat(120);
    expect(rolePermissionProblems('organization', [longName])).toEqual([
      `Unknown permission: ${JSON.stringify(longName.slice(0, 80))}`,
    ]);
  });

  it('returns fresh mutable problem and catalogue arrays', () => {
    const problems = rolePermissionProblems('organization', ['bogus']);
    expect(Object.isFrozen(problems)).toBe(false);
    problems.push('extra problem');
    expect(problems).toContain('extra problem');
    const missing = missingCatalogue([]);
    expect(Object.isFrozen(missing)).toBe(false);
    missing.push('extra permission');
    expect(missing).toContain('extra permission');
  });

  it('uses only stored known names, for every role including admin', () => {
    expect(new Set(effectivePermissions(['project:read', 'bogus']))).toEqual(
      new Set(['project:read']),
    );
    for (const role of DEFAULT_ROLES) {
      expect(new Set(effectivePermissions(role.permissions))).toEqual(new Set(role.permissions));
      expect(new Set(effectivePermissions([]))).toEqual(new Set());
    }
    expect(new Set(effectivePermissions(['project:read', 'project:read']))).toEqual(
      new Set(['project:read']),
    );
    expect(missingCatalogue(DEFAULT_ROLES[0]!.permissions)).toEqual([]);
    expect(missingCatalogue([])).toEqual(matrix.map(([name]) => name));
    expect(missingCatalogue(['project:read', 'bogus'])).toEqual(
      matrix.map(([name]) => name).filter((name) => name !== 'project:read'),
    );
  });

  it('returns a read-only set that throws on add, delete and clear', () => {
    const effective = effectivePermissions(['project:read', 'bogus']);
    expect([...effective]).toEqual(['project:read']);
    expect(effective.size).toBe(1);
    expect(effective.has('project:read')).toBe(true);
    expect(effective.has('bogus')).toBe(false);
    const collected: string[] = [];
    effective.forEach((value) => collected.push(value));
    expect(collected).toEqual(['project:read']);

    const mutable = effective as unknown as Set<string>;
    expect(() => mutable.add('org:read')).toThrow(TypeError);
    expect(() => mutable.delete('project:read')).toThrow(TypeError);
    expect(() => mutable.clear()).toThrow(TypeError);
    expect([...effective]).toEqual(['project:read']);
    expect(effective.size).toBe(1);
  });

  it('freezes exported objects and nested arrays', () => {
    expect(Object.isFrozen(PERMISSION_PATTERN)).toBe(true);
    expect(() => (PERMISSIONS as unknown[]).push({})).toThrow(TypeError);
    expect(() => (DEFAULT_ROLES as unknown[]).pop()).toThrow(TypeError);
    for (const permission of PERMISSIONS) {
      expect(Object.isFrozen(permission)).toBe(true);
      expect(() => Object.assign(permission, { sessionOnly: !permission.sessionOnly })).toThrow(
        TypeError,
      );
    }
    for (const role of DEFAULT_ROLES) {
      expect(Object.isFrozen(role)).toBe(true);
      expect(() => Object.assign(role, { name: 'changed' })).toThrow(TypeError);
      expect(() => (role.permissions as string[]).push('bogus')).toThrow(TypeError);
    }
  });

  it('reports an unknown org name in a project role only as unknown', () => {
    expect(rolePermissionProblems('project', ['org:bogus'])).toEqual([
      'Unknown permission: "org:bogus"',
    ]);
  });

  it('quotes and truncates caller-supplied names in problems', () => {
    const hostile = `x"\n${'y'.repeat(200)}`;
    const [problem] = rolePermissionProblems('organization', [hostile]);
    expect(problem).toBe(`Unknown permission: ${JSON.stringify(hostile.slice(0, 80))}`);
    expect(problem).not.toContain('\n');
    expect(problem!.length).toBeLessThan(120);
  });

  it('returns fresh mutable arrays from validation and catalogue checks', () => {
    const problems = rolePermissionProblems('project', ['bogus']);
    expect(() => problems.push('extra')).not.toThrow();
    expect(problems).toHaveLength(2);
    const missing = missingCatalogue([]);
    expect(() => missing.push('extra')).not.toThrow();
    expect(missing).toHaveLength(31);
    expect(missingCatalogue([])).toHaveLength(30);
    expect(rolePermissionProblems('project', ['bogus'])).toHaveLength(1);
  });

  it('returns a read-only effective set that still behaves like a set', () => {
    const effective = effectivePermissions(['project:read', 'project:packages:read', 'bogus']);
    expect(() => (effective as Set<string>).add('project:audit:read')).toThrow(TypeError);
    expect(() => (effective as Set<string>).delete('project:read')).toThrow(TypeError);
    expect(() => (effective as Set<string>).clear()).toThrow(TypeError);
    expect([...effective]).toEqual(['project:read', 'project:packages:read']);
    expect(effective.size).toBe(2);
    expect(effective.has('project:read')).toBe(true);
    expect(effective.has('bogus')).toBe(false);
    expect([...effective.keys()]).toEqual([...effective.values()]);
    expect([...effective.entries()]).toEqual([
      ['project:read', 'project:read'],
      ['project:packages:read', 'project:packages:read'],
    ]);
    const seen: ReadonlySet<string>[] = [];
    effective.forEach((_value, _key, set) => seen.push(set));
    expect(seen).toHaveLength(2);
    for (const set of seen) {
      expect(() => (set as Set<string>).add('project:audit:read')).toThrow(TypeError);
    }
    expect(effective).toBeInstanceOf(Set);
    expect(new Set(effective)).toEqual(new Set(['project:read', 'project:packages:read']));
    expect([...effective]).toEqual(['project:read', 'project:packages:read']);
  });
});
