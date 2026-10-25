import { readFileSync } from 'node:fs';
import { expect, expectTypeOf, it } from 'vitest';
import type { SourceErrorCode } from '../db/source.js';
import { SOURCE_ERROR_CODES } from './source-error-codes.js';

it('derives the database error-code type from the shared list', () => {
  expectTypeOf<SourceErrorCode>().toEqualTypeOf<(typeof SOURCE_ERROR_CODES)[number]>();
  const source = readFileSync(new URL('../db/source.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/export type SourceErrorCode = \(typeof SOURCE_ERROR_CODES\)\[number\]/);
});
