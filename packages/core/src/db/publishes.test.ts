import { describe, expect, it } from 'vitest';
import * as contracts from './publishes.js';

describe('npm repository contracts', () => {
  it('keeps publish repository implementation outside core', () => {
    expect(contracts).not.toHaveProperty('createPublishesRepository');
  });
  it('keeps access-request repository implementation outside core', () => {
    expect(contracts).not.toHaveProperty('createPackageAccessRequestRepository');
  });
});
