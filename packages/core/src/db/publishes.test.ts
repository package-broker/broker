import { describe, expect, it } from 'vitest';
import { createPublishesRepository, createPackageAccessRequestRepository } from './publishes.js';
import { orgContext } from './port.js';

describe('npm repository contracts', () => {
  it('leaves publish reads unavailable until implemented', async () => {
    await expect(createPublishesRepository().get(orgContext('org'), 'publish')).rejects.toThrow(
      'not_implemented',
    );
  });
  it('leaves access-request reads unavailable until implemented', async () => {
    await expect(
      createPackageAccessRequestRepository().get(orgContext('org'), 'request'),
    ).rejects.toThrow('not_implemented');
  });
});
