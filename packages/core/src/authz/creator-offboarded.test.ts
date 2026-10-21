import { describe, expect, it, vi } from 'vitest';
import { orgContext } from '../db/port.js';
import { creatorOffboarded } from './creator-offboarded.js';

const ctx = orgContext('org-a');

describe('creator offboarding callback', () => {
  it.each(['suspended', 'membership_removed'] as const)(
    'forwards %s once with the organization',
    async (cause) => {
      const onCreatorOffboarded = vi.fn();
      const log = vi.fn();
      await creatorOffboarded({ onCreatorOffboarded, log }, ctx, 'user-1', cause);
      expect(onCreatorOffboarded).toHaveBeenCalledExactlyOnceWith(ctx, { userId: 'user-1', cause });
      expect(log).not.toHaveBeenCalled();
    },
  );

  it('does nothing when no callback is configured', async () => {
    const log = vi.fn();
    await creatorOffboarded({ log }, ctx, 'user-1', 'suspended');
    expect(log).not.toHaveBeenCalled();
  });

  it('logs only the callback error name', async () => {
    const log = vi.fn();
    await creatorOffboarded(
      {
        onCreatorOffboarded: () => {
          throw new TypeError('private callback detail');
        },
        log,
      },
      ctx,
      'user-1',
      'membership_removed',
    );
    expect(log).toHaveBeenCalledExactlyOnceWith({
      level: 'warn',
      event: 'user.offboarding_callback_failed',
      orgId: ctx.orgId,
      userId: 'user-1',
      cause: 'membership_removed',
      error: 'TypeError',
    });
  });

  it('keeps a committed write successful when the callback and sink throw', async () => {
    await expect(
      creatorOffboarded(
        {
          onCreatorOffboarded: async () => {
            throw new Error('callback failed');
          },
          log: () => {
            throw new Error('sink failed');
          },
        },
        ctx,
        'user-1',
        'suspended',
      ),
    ).resolves.toBeUndefined();
  });
});
