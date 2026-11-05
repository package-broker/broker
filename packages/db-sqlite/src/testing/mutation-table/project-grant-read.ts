import { expect } from 'vitest';
import { createProjectGrantReader } from '../../repositories/project-grant-read.js';
import { executing } from './factory-cases.js';
import { NOT_NULL } from './fixtures.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';

const targets = ['g', 'p', 'r', 'u', 'rp'] as const;
const cases: readonly ContractCase[] = targets.map((target) => ({
  name: `project grants exclude foreign ${target} data`,
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    const org = (alias: typeof target) => (alias === target ? foreign.orgId : own.orgId);
    await seed.forged(
      "INSERT INTO project (id, org_id, slug, name) VALUES ('P', ?, 'demo', 'Demo')",
      org('p'),
    );
    await seed.forged(
      "INSERT INTO role (id, org_id, key, name, scope) VALUES ('R', ?, 'dev', 'Developer', 'project')",
      org('r'),
    );
    await seed.forged(
      "INSERT INTO user_account (id, org_id, email, display_name) VALUES ('U', ?, 'member@example.test', 'Foreign member')",
      org('u'),
    );
    await seed.forged(
      "INSERT INTO role_permission (org_id, role_id, permission) VALUES (?, 'R', 'project:read')",
      org('rp'),
    );
    await seed.forged(
      "INSERT INTO access_grant (id, org_id, project_id, scope, role_id, subject_type, subject_value) VALUES ('G', ?, 'P', 'project', 'R', 'email', 'member@example.test')",
      org('g'),
    );
    const result = await createProjectGrantReader(executing(context)).list(own, {
      projectId: 'P',
      limit: 10,
    });
    if (target === 'u') {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.principal).toEqual({
        kind: 'email',
        id: 'G',
        displayName: 'Pending user',
        visibility: 'redacted',
      });
    } else if (target === 'rp') {
      expect(result.items).toHaveLength(1);
      expect(result.items[0]!.role.permissions).toEqual([]);
    } else expect(result.items).toEqual([]);
  },
}));

export const entries: readonly MutationEntry[] = [
  {
    builder: 'createProjectGrantReader',
    file: 'repositories/project-grant-read.ts',
    cases,
    predicates: targets.map((target) => ({
      name: `${target} belongs to the organization`,
      locate: target === 'rp' ? /rp\.org_id = \?/ : new RegExp(`"${target}"\\."org_id" = \\?`),
      neutral: NOT_NULL,
      copies: 1,
      caseName: `project grants exclude foreign ${target} data`,
    })),
  },
];
