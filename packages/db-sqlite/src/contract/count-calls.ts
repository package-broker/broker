import type {
  ScalarSqlExecutor,
  ScalarStatement,
  StatementResult,
} from '@package-broker/core/db/port';

export interface CallCounts {
  readonly all: number;
  readonly batch: number;
}

export function countCalls<E extends ScalarSqlExecutor>(
  executor: E,
): { readonly executor: E; counts(): CallCounts } {
  let all = 0;
  let batch = 0;

  const counted = new Proxy(executor, {
    get(target, property, receiver) {
      if (property === 'all') {
        return async <R = Record<string, unknown>>(statement: ScalarStatement): Promise<R[]> => {
          all += 1;
          return target.all<R>(statement);
        };
      }
      if (property === 'batch') {
        return async (statements: readonly ScalarStatement[]): Promise<StatementResult[]> => {
          batch += 1;
          return target.batch(statements);
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  return {
    executor: counted,
    counts: () => ({ all, batch }),
  };
}
