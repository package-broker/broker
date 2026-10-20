import { describe, expect, it } from 'vitest';
import { accessGrantFenceKey, projectBoundaryPermissions, roleFenceKey } from './project-actor.js';

describe('project grant fence keys', () => {
  it('names the grant and role revisions', () => {
    expect(accessGrantFenceKey('G1')).toBe('access_grant:G1');
    expect(roleFenceKey('R1')).toBe('role:R1');
  });
});

describe('projectBoundaryPermissions', () => {
  it('unions project rows with the project names of organization rows', () => {
    const union = projectBoundaryPermissions(
      ['project:read'],
      ['org:read', 'project:grants:write', 'org:users:read'],
    );
    expect([...union].sort()).toEqual(['project:grants:write', 'project:read']);
  });

  it('keeps an organization name out even when a project row carries none of it', () => {
    expect(projectBoundaryPermissions([], ['org:read']).size).toBe(0);
  });

  it('returns a fresh set each time', () => {
    const rows = ['project:read'];
    expect(projectBoundaryPermissions(rows, [])).not.toBe(projectBoundaryPermissions(rows, []));
  });
});
