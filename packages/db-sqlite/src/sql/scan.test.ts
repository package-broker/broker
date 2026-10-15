import { expect, test } from 'vitest';
import { SqlScanError, scanSql, type Segment } from './scan.js';

const kinds = (segments: readonly Segment[]): string[] => segments.map((segment) => segment.kind);

const texts = (segments: readonly Segment[]): string[] => segments.map((segment) => segment.text);

const starts = (segments: readonly Segment[]): number[] => segments.map((segment) => segment.start);

const roundTrips = (input: string): void => {
  expect(
    scanSql(input)
      .map((segment) => segment.text)
      .join(''),
  ).toBe(input);
};

test('splits code, literals, identifiers and comments', () => {
  const input = 'SELECT \'a;b\', "x""y" -- c;\n/* d */1';
  const segments = scanSql(input);

  expect(kinds(segments)).toEqual([
    'code',
    'string',
    'code',
    'identifier',
    'code',
    'comment',
    'code',
    'comment',
    'code',
  ]);
  expect(texts(segments)).toEqual([
    'SELECT ',
    "'a;b'",
    ', ',
    '"x""y"',
    ' ',
    '-- c;',
    '\n',
    '/* d */',
    '1',
  ]);
  expect(starts(segments)).toEqual([0, 7, 12, 14, 20, 21, 26, 27, 34]);
  roundTrips(input);
});

test('doubled quotes stay inside one string literal', () => {
  expect(scanSql("'it''s'")).toEqual([{ kind: 'string', text: "'it''s'", start: 0 }]);
});

test('reads bracket, backtick and doubled-quote identifiers', () => {
  expect(scanSql('[a;b]')).toEqual([{ kind: 'identifier', text: '[a;b]', start: 0 }]);
  expect(scanSql('`a;b`')).toEqual([{ kind: 'identifier', text: '`a;b`', start: 0 }]);
  expect(scanSql('`a``b`')).toEqual([{ kind: 'identifier', text: '`a``b`', start: 0 }]);
});

test('keeps the newline in code after a line comment', () => {
  expect(texts(scanSql('SELECT 1 -- c\r\n2'))).toEqual(['SELECT 1 ', '-- c', '\r\n2']);
  expect(texts(scanSql('-- c'))).toEqual(['-- c']);
});

test('empty input has no segments', () => {
  expect(scanSql('')).toEqual([]);
});

const unterminated: Array<[input: string, offset: number]> = [
  ["SELECT 'open", 7],
  ['/* open', 0],
  ['"open', 0],
  ['[open', 0],
  ['`open', 0],
];

test.each(unterminated)('throws SqlScanError with offset for %j', (input, offset) => {
  expect(() => scanSql(input)).toThrow(SqlScanError);

  try {
    scanSql(input);
    expect.unreachable('scanSql should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(SqlScanError);
    expect((error as SqlScanError).offset).toBe(offset);
  }
});

const valid: string[] = [
  'SELECT \'a;b\', "x""y" -- c;\n/* d */1',
  "'it''s'",
  '[a;b]',
  '`a;b`',
  '`a``b`',
  'SELECT 1 -- c\r\n2',
  '-- c',
  'SELECT 1;',
  'SELECT/* c */1',
  '',
];

test.each(valid)('round trips %j', (input) => {
  roundTrips(input);
});
