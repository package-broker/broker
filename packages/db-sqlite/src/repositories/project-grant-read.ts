import type { ProjectGrantReader } from '@package-broker/core/db/grants';
import type { SqlExecutor } from '@package-broker/core/db/port';
import { validateLimit } from '@package-broker/core/db/catalogue';
import { sql } from 'kysely';
import { compile, db } from '../kysely.js';

interface Row {
  readonly id: string;
  readonly revision: number;
  readonly created_at: string;
  readonly subject_type: 'email' | 'group';
  readonly subject_value: string;
  readonly subject_provider: string | null;
  readonly user_id: string | null;
  readonly display_name: string | null;
  readonly role_id: string;
  readonly role_name: string;
  readonly permissions: string;
}

function displayName(value: string | null, fallback: string, reveal: boolean): string {
  return value === null || value.trim() === '' || (!reveal && value.includes('@'))
    ? fallback
    : value;
}

function subjectFields(row: Row, reveal: boolean) {
  if (row.subject_type === 'group') {
    return reveal
      ? {
          provider: row.subject_provider!,
          groupValue: row.subject_value,
          visibility: 'visible' as const,
        }
      : { provider: row.subject_provider!, visibility: 'redacted' as const };
  }
  return reveal
    ? { email: row.subject_value, visibility: 'visible' as const }
    : { visibility: 'redacted' as const };
}

export function createProjectGrantReader(executor: SqlExecutor): ProjectGrantReader {
  return {
    async list(ctx, input) {
      validateLimit(input.limit, 100);
      if (typeof input.projectId !== 'string' || input.projectId === '')
        throw new TypeError('invalid project id');
      let query = db
        .selectFrom('access_grant as g')
        .innerJoin('project as p', 'p.id', 'g.project_id')
        .innerJoin('role as r', 'r.id', 'g.role_id')
        .leftJoin('user_account as u', (join) =>
          join
            .onRef('u.email', '=', 'g.subject_value')
            .on('g.subject_type', '=', 'email')
            .on('u.org_id', '=', ctx.orgId),
        )
        .select([
          'g.id',
          'g.revision',
          'g.created_at',
          'g.subject_type',
          'g.subject_value',
          'g.subject_provider',
          'u.id as user_id',
          'u.display_name',
          'r.id as role_id',
          'r.name as role_name',
        ])
        .select(
          sql<string>`(select json_group_array(permission) from (
          select rp.permission from role_permission as rp
          where rp.role_id = r.id and rp.org_id = ${ctx.orgId} order by rp.permission
        ))`.as('permissions'),
        )
        .where('g.org_id', '=', ctx.orgId)
        .where('p.org_id', '=', ctx.orgId)
        .where('r.org_id', '=', ctx.orgId)
        .where('g.scope', '=', 'project')
        .where('r.scope', '=', 'project')
        .where('g.project_id', '=', input.projectId)
        .where('p.status', '=', 'active')
        .orderBy('g.id')
        .limit(input.limit + 1);
      if (input.after !== undefined) query = query.where('g.id', '>', input.after);
      const rows = await executor.all<Row>(compile(query));
      const reveal = input.revealSubjects === true;
      const items = rows.slice(0, input.limit).map((row) => {
        const group = row.subject_type === 'group';
        return {
          id: row.id,
          revision: row.revision,
          createdAt: row.created_at,
          principal: {
            kind: group
              ? ('group' as const)
              : row.user_id === null
                ? ('email' as const)
                : ('user' as const),
            id: row.user_id ?? row.id,
            displayName: displayName(
              group ? (reveal ? row.subject_value : null) : row.display_name,
              group ? 'Group' : row.user_id === null ? 'Pending user' : 'User',
              reveal,
            ),
            ...subjectFields(row, reveal),
          },
          role: {
            id: row.role_id,
            name: row.role_name,
            permissions: JSON.parse(row.permissions) as string[],
          },
        };
      });
      return { items, next: rows.length > input.limit ? items.at(-1)!.id : null };
    },
  };
}
