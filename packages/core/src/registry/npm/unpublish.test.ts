import { describe, expect, it } from 'vitest';
import { removedVersions } from './unpublish.js';

describe('npm unpublish manifest validation', () => {
  const before = {
    '1.0.0': { name: 'widget', version: '1.0.0' },
    '2.0.0': { name: 'widget', version: '2.0.0' },
  };
  it('accepts removed versions and unchanged remaining manifests', () => {
    expect(removedVersions(before, { '2.0.0': before['2.0.0'] })).toEqual(['1.0.0']);
  });
  it.each([{}, { '3.0.0': {} }, { '2.0.0': { name: 'changed' } }, before])(
    'refuses invalid partial unpublish',
    (after) => {
      expect(() => removedVersions(before, after)).toThrow('invalid_unpublish');
    },
  );
});
