import { describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import type { D1DatabaseLike, D1PreparedStatementLike } from './d1-executor.js';

describe('D1DatabaseLike against the Workers binding types', () => {
  it('accepts the real D1Database binding', () => {
    const binding = {} as D1Database;
    const like: D1DatabaseLike = binding;
    expect(like).toBe(binding);
  });

  it('rejects a method D1 does not have', () => {
    const like = {} as D1DatabaseLike;
    // @ts-expect-error D1 has no truncate()
    const call = (): unknown => like.truncate();
    expect(call).toBeTypeOf('function');
  });

  it('rejects a wrong all signature', () => {
    // @ts-expect-error D1 all takes no arguments
    const all: D1PreparedStatementLike['all'] = async (sql: string) => ({ results: [sql] });
    expect(all).toBeTypeOf('function');
  });

  it('rejects a wrong batch signature', () => {
    // @ts-expect-error D1 batch takes prepared statements
    const batch: D1DatabaseLike['batch'] = async (sql: string) => [{ results: [sql] }];
    expect(batch).toBeTypeOf('function');
  });

  it('rejects a wrong all result', () => {
    // @ts-expect-error D1 results must be an array
    const all: D1PreparedStatementLike['all'] = async () => ({ results: 'invalid' });
    expect(all).toBeTypeOf('function');
  });

  it('rejects a wrong batch result', () => {
    // @ts-expect-error D1 batch returns an array of results
    const batch: D1DatabaseLike['batch'] = async () => ({ results: [] });
    expect(batch).toBeTypeOf('function');
  });
});
