import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { createCredentialUnavailableMark, SourceUnavailableError } from './source-unavailable.js';

const org = orgContext('org-1');

describe('createCredentialUnavailableMark', () => {
  it.each([null, 'network', 'timeout', 'http_error', 'rate_limited'])(
    'writes when the source holds %s',
    async (lastError) => {
      const write = vi.fn(async () => undefined);
      await createCredentialUnavailableMark(write).mark(org, { id: 's1', lastError });
      expect(write).toHaveBeenCalledExactlyOnceWith(org, 's1');
    },
  );

  it.each(['unauthorized', 'mass_absence', 'policy_denied', 'not_found', 'internal'])(
    'keeps the specific code %s without writing',
    async (lastError) => {
      const write = vi.fn(async () => undefined);
      await createCredentialUnavailableMark(write).mark(org, { id: 's1', lastError });
      expect(write).not.toHaveBeenCalled();
    },
  );

  it('skips the write while the source already holds credential_unavailable', async () => {
    const write = vi.fn(async () => undefined);
    const mark = createCredentialUnavailableMark(write);
    for (let i = 0; i < 3; i += 1)
      await mark.mark(org, { id: 's1', lastError: 'credential_unavailable' });
    expect(write).not.toHaveBeenCalled();
  });

  it('collapses concurrent marks for one source into one write and keeps orgs apart', async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const write = vi.fn(() => gate);
    const mark = createCredentialUnavailableMark(write);
    const other = orgContext('org-2');
    const pending = [
      mark.mark(org, { id: 's1', lastError: null }),
      mark.mark(org, { id: 's1', lastError: null }),
      mark.mark(other, { id: 's1', lastError: null }),
    ];
    finish();
    await Promise.all(pending);
    expect(write.mock.calls).toEqual([
      [org, 's1'],
      [other, 's1'],
    ]);
  });

  it('swallows a failed write and tries again on the next miss', async () => {
    const write = vi.fn(async () => {
      throw new Error('db down');
    });
    const mark = createCredentialUnavailableMark(write);
    await expect(mark.mark(org, { id: 's1', lastError: null })).resolves.toBeUndefined();
    await mark.mark(org, { id: 's1', lastError: null });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a writer', async () => {
    await expect(
      createCredentialUnavailableMark(undefined).mark(org, { id: 's1', lastError: null }),
    ).resolves.toBeUndefined();
  });
});

describe('SourceUnavailableError', () => {
  it('carries the reason code and a fixed message', () => {
    const error = new SourceUnavailableError('config_invalid');
    expect(error).toMatchObject({
      name: 'SourceUnavailableError',
      reason: 'config_invalid',
      message: 'source unavailable',
    });
  });
});
