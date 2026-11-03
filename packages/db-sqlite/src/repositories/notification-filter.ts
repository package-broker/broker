import { sql, type Expression, type SqlBool } from 'kysely';
import { MAX_KEY_LENGTH } from '@package-broker/core/catalogue/names';
import { MAX_PATTERN_BYTES, MAX_PATTERN_WILDCARDS } from '@package-broker/core/catalogue/patterns';

/**
 * SQL twin of the core notification filter: a restricted `*` glob over the stored package key.
 * Both alphabets exclude GLOB's `?`, `[` and `]`, so `glob` here has the TypeScript semantics;
 * length() and glob stop at NUL, so a character/byte length mismatch is refused. The CASE keeps
 * D1's 50-byte pattern limit from being reached by an unchecked stored pattern.
 */
export function notificationFilterCondition(
  pattern: Expression<unknown>,
  key: Expression<unknown>,
): Expression<SqlBool> {
  return sql<SqlBool>`(case when
    length(cast(${pattern} as blob)) = length(${pattern})
    and length(${pattern}) between 1 and ${sql.lit(MAX_PATTERN_BYTES)}
    and ${pattern} not glob '*[^a-z0-9._~@!/*-]*'
    and length(${pattern}) - length(replace(${pattern}, '*', '')) <= ${sql.lit(MAX_PATTERN_WILDCARDS)}
    and length(cast(${key} as blob)) = length(${key})
    and length(${key}) between 1 and ${sql.lit(MAX_KEY_LENGTH)}
    and ${key} not glob '*[^a-z0-9._~@!/-]*'
    then ${key} glob ${pattern} else 0 end)`;
}
