import { sql, type SqlBool } from 'kysely';
import { isValidProjectListPrefix } from '@package-broker/core/authz/project-list';

/** Binary prefix ranges avoid D1's LIKE/GLOB pattern limit, including for long Unicode names. */
export function projectPrefixCondition(slug: string, name: string, q: string) {
  if (!isValidProjectListPrefix(q)) throw new TypeError('invalid project prefix');
  const points = Array.from(q, (character) => character.codePointAt(0)!);
  while (points.at(-1) === 0x10ffff) points.pop();
  const last = points.pop();
  const upper =
    last === undefined
      ? null
      : String.fromCodePoint(...points, last === 0xd7ff ? 0xe000 : last + 1);
  const range = (column: string) =>
    upper === null
      ? sql<SqlBool>`${sql.ref(column)} >= ${q}`
      : sql<SqlBool>`(${sql.ref(column)} >= ${q} AND ${sql.ref(column)} < ${upper})`;
  return sql<SqlBool>`(${range(slug)} OR ${range(name)})`;
}
