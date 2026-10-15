import {
  DummyDriver,
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type Compilable,
} from 'kysely';
import type { SqlValue, Statement } from '@package-broker/core/db/port';
import { ulid } from '@package-broker/core/ids';
import type { Database } from './schema.js';

export type { Database } from './schema.js';

export const db = new Kysely<Database>({
  dialect: {
    createAdapter: () => new SqliteAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (kysely) => new SqliteIntrospector(kysely),
    createQueryCompiler: () => new SqliteQueryCompiler(),
  },
});

function isSqlValue(value: unknown): value is SqlValue {
  if (value === null || typeof value === 'string' || value instanceof Uint8Array) {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value));
  }
  return false;
}

export function compile(query: Compilable): Statement {
  const { sql, parameters } = query.compile();
  const params = parameters.map((parameter): SqlValue => {
    if (!isSqlValue(parameter)) {
      throw new TypeError('SQL parameter is not a valid SqlValue');
    }
    return parameter;
  });
  return { sql, params };
}

export const newOpId = ulid;
