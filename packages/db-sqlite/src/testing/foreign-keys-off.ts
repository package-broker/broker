import { it } from 'vitest';
import { DbError } from '@package-broker/core/db/errors';
import type { ScalarSqlExecutor } from '@package-broker/core/db/port';

export class ForeignKeysStayOn extends Error {
  constructor() {
    super('D1 ignores PRAGMA foreign_keys; composite FKs make forged rows impossible');
    this.name = 'ForeignKeysStayOn';
  }
}

const enforcement = async (executor: ScalarSqlExecutor): Promise<number | undefined> =>
  (await executor.all<{ foreign_keys: number }>({ sql: 'PRAGMA foreign_keys', params: [] }))[0]
    ?.foreign_keys;

export async function withForeignKeysOff<T>(
  executor: ScalarSqlExecutor,
  seed: () => Promise<T>,
): Promise<T> {
  if ((await enforcement(executor)) !== 1) return seed();
  await executor.all({ sql: 'PRAGMA foreign_keys = OFF', params: [] });
  if ((await enforcement(executor)) === 1) {
    try {
      return await seed();
    } catch (error) {
      if (error instanceof DbError && error.kind === 'foreign_key') throw new ForeignKeysStayOn();
      throw error;
    }
  }
  try {
    return await seed();
  } finally {
    await executor.all({ sql: 'PRAGMA foreign_keys = ON', params: [] });
  }
}

export function forgedItFor(
  d1: boolean,
): (name: string, body: () => Promise<void>, timeout?: number) => void {
  return (name, body, timeout) => {
    it(
      name,
      async (context) => {
        try {
          await body();
        } catch (error) {
          if (d1 && error instanceof ForeignKeysStayOn) context.skip(error.message);
          throw error;
        }
      },
      timeout,
    );
  };
}
