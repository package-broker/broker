import type { SqlExecutor } from '@package-broker/core/db/port';
import { describe, expect, it, vi } from 'vitest';
import { readDoubleRevoke, type DoubleRevokeReadSource } from './access-contract.js';

function source(label: string, counts: number[]): DoubleRevokeReadSource {
  const all = vi.fn(async () =>
    Array.from({ length: counts.shift() ?? 0 }, () => ({
      revoked_at: 'private timestamp',
      last_op_id: 'private operation id',
    })),
  );
  const executor = { driver: 'd1', all, batch: vi.fn() } as unknown as SqlExecutor;
  return {
    executor,
    label,
    summary: () => ({ fields: ['results', 'success', 'meta'], rows_read: 2 }),
  };
}

describe('doubleRevoke read diagnostics', () => {
  it('fails on the original zero rows even when the same-binding diagnostic read finds the row', async () => {
    const primary = source('primary binding ACDB0', [0, 1]);
    const error: unknown = await readDoubleRevoke(primary.executor, {
      primary,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    const summary = (executor: string, count: number) => ({
      executor,
      fields: ['results', 'success', 'meta'],
      'results.length': count,
      'meta.rows_read': 2,
    });
    expect(message).toContain(
      JSON.stringify({
        initial: summary(primary.label, 0),
        same: summary(primary.label, 1),
      }),
    );
    expect(message).not.toContain('private');
    expect(primary.executor.all).toHaveBeenCalledTimes(2);
  });

  it('rejects extra rows and omits absent metadata', async () => {
    const primary = {
      ...source('primary binding ACDB0', [2, 0]),
      summary: () => ({ fields: ['results'] }),
    };
    const error: unknown = await readDoubleRevoke(primary.executor, {
      primary,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('"results.length":2');
    expect(message).not.toContain('meta.changes');
    expect(message).not.toContain('meta.rows_read');
    expect(message).not.toContain('private');
  });

  it('does not re-read a successful original result', async () => {
    const primary = source('primary binding ACDB0', [1]);
    expect(await readDoubleRevoke(primary.executor, { primary })).toHaveLength(1);
    expect(primary.executor.all).toHaveBeenCalledTimes(1);
  });

  it('omits error details when the same executor re-read throws', async () => {
    const primary = source('primary binding ACDB0', [0]);
    vi.mocked(primary.executor.all)
      .mockReset()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('private failure'));
    const error: unknown = await readDoubleRevoke(primary.executor, {
      primary,
    }).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('"results.length":null');
    expect((error as Error).message).not.toContain('private failure');
    expect(primary.executor.all).toHaveBeenCalledTimes(2);
  });
});
