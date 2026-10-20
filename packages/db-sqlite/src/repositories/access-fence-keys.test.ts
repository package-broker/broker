import { describe, expect, it } from 'vitest';
import { accessGrantFenceKey, roleFenceKey } from '@package-broker/core/authz/project-actor';
import { projectGrantKey, projectGrantRoleKey } from './project-grant.js';

describe('project grant fence keys', () => {
  it('are the core helpers, not a second spelling', () => {
    expect(projectGrantKey).toBe(accessGrantFenceKey);
    expect(projectGrantRoleKey).toBe(roleFenceKey);
    expect(projectGrantKey('G')).toBe('access_grant:G');
    expect(projectGrantRoleKey('R')).toBe('role:R');
  });
});
