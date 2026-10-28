import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Statement } from '@package-broker/core/db/port';
import { openMigratedDatabase, type MigratedDatabase } from '../testing/migrated-database.js';
import { createProjectGrantReader } from './project-grant-read.js';

let database: MigratedDatabase;
const stmt = (sql: string, ...params: Statement['params']): Statement => ({ sql, params });
beforeEach(async () => {
  database = await openMigratedDatabase({ twoOrganizations: true });
  const { a, b } = database.orgs!;
  await database.executor.batch([
    stmt(
      "INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'demo', 'Demo'), ('Q', ?, 'other', 'Other')",
      a.orgId,
      b.orgId,
    ),
    stmt(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'dev', 'Developer', 'project')",
      a.orgId,
    ),
    stmt(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R', 'project:read')",
      a.orgId,
    ),
    stmt(
      "INSERT INTO user_account (id, org_id, email, display_name) VALUES ('U', ?, 'member@example.test', 'Member')",
      a.orgId,
    ),
    stmt(
      "INSERT INTO access_grant (id, org_id, scope, project_id, role_id, subject_type, subject_value, subject_provider) VALUES ('G1', ?, 'project', 'P', 'R', 'email', 'member@example.test', NULL), ('G2', ?, 'project', 'P', 'R', 'group', 'team', 'oidc'), ('G3', ?, 'project', 'P', 'R', 'email', 'pending@example.test', NULL)",
      a.orgId,
      a.orgId,
      a.orgId,
    ),
  ]);
});
afterEach(() => database.close());

it('paginates grants with principals, role and permissions', async () => {
  const reader = createProjectGrantReader(database.executor);
  const first = await reader.list(database.orgs!.a, { projectId: 'P', limit: 1 });
  expect(first.next).toBe('G1');
  expect(first.items).toEqual([
    expect.objectContaining({
      id: 'G1',
      principal: { kind: 'user', id: 'U', displayName: 'Member', visibility: 'redacted' },
      role: { id: 'R', name: 'Developer', permissions: ['project:read'] },
    }),
  ]);
  const second = await reader.list(database.orgs!.a, {
    projectId: 'P',
    limit: 2,
    after: first.next!,
  });
  expect(second.next).toBeNull();
  expect(second.items.map((item) => item.principal)).toEqual([
    { kind: 'group', id: 'G2', provider: 'oidc', displayName: 'Group', visibility: 'redacted' },
    { kind: 'email', id: 'G3', displayName: 'Pending user', visibility: 'redacted' },
  ]);
});

it('never exposes e-mail or group values through pending users, display names or group names when redacted', async () => {
  await database.executor.batch([
    stmt("UPDATE user_account SET display_name = email WHERE id = 'U'"),
    stmt("UPDATE access_grant SET subject_value = 'team@example.test' WHERE id = 'G2'"),
  ]);
  const reader = createProjectGrantReader(database.executor);
  const page = await reader.list(database.orgs!.a, { projectId: 'P', limit: 100 });
  expect(page.items).toHaveLength(3);
  expect(JSON.stringify(page)).not.toContain('@');
  expect(JSON.stringify(page)).not.toContain('team');
  expect(page.items.map((item) => item.principal.displayName)).toEqual([
    'User',
    'Group',
    'Pending user',
  ]);
});

it('returns the e-mail or group value each grant names only when asked to reveal subjects', async () => {
  await database.executor.batch([
    stmt("UPDATE access_grant SET subject_value = 'team@example.test' WHERE id = 'G2'"),
  ]);
  const reader = createProjectGrantReader(database.executor);
  const page = await reader.list(database.orgs!.a, {
    projectId: 'P',
    limit: 100,
    revealSubjects: true,
  });
  expect(page.items.map((item) => item.principal)).toEqual([
    {
      kind: 'user',
      id: 'U',
      displayName: 'Member',
      email: 'member@example.test',
      visibility: 'visible',
    },
    {
      kind: 'group',
      id: 'G2',
      displayName: 'team@example.test',
      provider: 'oidc',
      groupValue: 'team@example.test',
      visibility: 'visible',
    },
    {
      kind: 'email',
      id: 'G3',
      displayName: 'Pending user',
      email: 'pending@example.test',
      visibility: 'visible',
    },
  ]);
  const redacted = await reader.list(database.orgs!.a, {
    projectId: 'P',
    limit: 100,
    revealSubjects: false,
  });
  expect(JSON.stringify(redacted)).not.toContain('@');
  expect(redacted.items.every((item) => item.principal.visibility === 'redacted')).toBe(true);
});

it('isolates organizations and projects and omits archived projects', async () => {
  const reader = createProjectGrantReader(database.executor);
  expect(await reader.list(database.orgs!.b, { projectId: 'P', limit: 100 })).toEqual({
    items: [],
    next: null,
  });
  expect(await reader.list(database.orgs!.a, { projectId: 'Q', limit: 100 })).toEqual({
    items: [],
    next: null,
  });
  await database.executor.batch([stmt("UPDATE project SET status = 'archived' WHERE id = 'P'")]);
  expect(await reader.list(database.orgs!.a, { projectId: 'P', limit: 100 })).toEqual({
    items: [],
    next: null,
  });
});
