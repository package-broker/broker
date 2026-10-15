import { expect, test } from 'vitest';
import { dialect } from './index.js';

test('declares the sqlite dialect', () => {
  expect(dialect).toBe('sqlite');
});
