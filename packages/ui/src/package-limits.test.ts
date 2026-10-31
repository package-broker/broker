import { expect, it } from 'vitest';
import { MAX_NPM_NAME_LENGTH as coreNpm } from '@package-broker/core/catalogue/names';
import { MAX_PATTERN_BYTES as corePattern } from '@package-broker/core/catalogue/patterns';
import { MAX_NPM_NAME_LENGTH, MAX_PATTERN_BYTES } from './package-limits.js';

it('keeps the browser name and pattern limits aligned with core', () => {
  expect(MAX_NPM_NAME_LENGTH).toBe(coreNpm);
  expect(MAX_PATTERN_BYTES).toBe(corePattern);
});
