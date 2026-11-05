import { afterEach, expect, it, vi } from 'vitest';
import { verifierLogs } from './audit.spec.js';

afterEach(() => vi.useRealTimers());

it.each(['audit.chain_broken', 'audit.verified', 'audit.verify_partial', 'audit.verify_continued'])(
  'waits through split health-alert output for %s from the dispatched job',
  async (event) => {
    vi.useFakeTimers();
    const records = [
      { event: 'audit.alert', job_id: 'dispatched', reason_code: 'audit.chain_integrity' },
      { event: 'audit.chain_broken', job_id: 'scheduled', seq: 0, reason: 'seq_gap' },
    ];
    let settled = false;
    const waiting = verifierLogs(
      () => records.map((row) => JSON.stringify(row)).join('\n'),
      'dispatched',
    ).then((logs) => {
      settled = true;
      return logs;
    });
    await vi.advanceTimersByTimeAsync(300);
    expect(settled).toBe(false);
    const verdict = { event, job_id: 'dispatched', seq: 0, reason: 'seq_gap' };
    records.push(verdict);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toEqual([records[0], verdict]);
  },
);

it('rejects alert-only output when no verifier outcome arrives', async () => {
  vi.useFakeTimers();
  const waiting = verifierLogs(
    () => JSON.stringify({ event: 'audit.alert', job_id: 'dispatched' }),
    'dispatched',
  );
  const rejected = expect(waiting).rejects.toThrow('MissingRuntimeVerifierEvidence');
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
});
