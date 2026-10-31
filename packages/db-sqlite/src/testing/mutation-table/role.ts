import { expect } from 'vitest';
import { DEFAULT_ROLES, type DefaultRoleKey } from '@package-broker/core/authz/permissions';
import { seedDefaultsStatements } from '../../repositories/role.js';
import { orgOf, seeder, type ContractCase, type MutationEntry } from './harness.js';
import { NOT_NULL, ref } from './fixtures.js';

function foreignRole(key: DefaultRoleKey): ContractCase {
  return {
    name: `default permissions do not attach to a foreign ${key}`,
    async run(context) {
      const { own, foreign } = orgOf(context);
      const seed = seeder(context.executor);
      const ids = {} as Record<DefaultRoleKey, string>;
      for (const role of DEFAULT_ROLES) {
        ids[role.key] = `R-${role.key}`;
        await seed(
          'INSERT INTO role (id, org_id, key, name, scope, is_system, protects_last_holder) VALUES (?, ?, ?, ?, ?, 1, ?)',
          ids[role.key],
          role.key === key ? foreign.orgId : own.orgId,
          role.key,
          role.name,
          role.scope,
          role.protectsLastHolder ? 1 : 0,
        );
      }
      // Isolate permission selection after role creation; colliding foreign ids would abort the role INSERT before reaching this guard.
      const permissions = seedDefaultsStatements(own, {
        now: '2020-01-01T00:00:00.000Z',
        ids,
      }).filter((_, index) => index % 2 === 1);
      await context.executor.batch(
        context.mutateBatch(
          permissions.flatMap((statement, index) => [
            {
              sql: 'UPDATE role SET name=name WHERE id=?',
              params: [ids[DEFAULT_ROLES[index]!.key]],
            },
            statement,
          ]),
        ),
      );
      const rows = await context.executor.all({
        sql: 'SELECT permission FROM role_permission WHERE role_id = ?',
        params: [ids[key]],
      });
      expect(rows).toEqual([]);
    },
  };
}
export const entries: readonly MutationEntry[] = [
  {
    file: 'repositories/role.ts',
    builder: 'seedDefaultsStatements',
    cases: DEFAULT_ROLES.map(({ key }) => foreignRole(key)),
    predicates: DEFAULT_ROLES.map(({ key }, index) => ({
      name: `${key} permission source belongs to the organization`,
      locate: ref('r', 'org_id', '\\?'),
      neutral: NOT_NULL,
      copies: DEFAULT_ROLES.length,
      waivedCopies: Object.fromEntries(
        DEFAULT_ROLES.flatMap((other, otherIndex) =>
          otherIndex === index
            ? []
            : [[otherIndex, `this occurrence is killed by "${foreignRole(other.key).name}"`]],
        ),
      ),
      caseName: foreignRole(key).name,
    })),
  },
];
