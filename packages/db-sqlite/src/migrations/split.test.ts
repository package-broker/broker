import { expect, test } from 'vitest';
import { MigrationSyntaxError, splitStatements } from './split.js';

test('drops a header comment and yields the create statements', () => {
  const sql = [
    '-- migrations: BEGIN; PRAGMA foreign_keys=ON;',
    'CREATE TABLE a (id TEXT);',
    'CREATE TABLE b (id TEXT);',
  ].join('\n');

  expect(splitStatements(sql)).toEqual(['CREATE TABLE a (id TEXT)', 'CREATE TABLE b (id TEXT)']);
});

test('keeps semicolons and doubled quotes inside literals', () => {
  expect(splitStatements("INSERT INTO t VALUES ('a;b', 'it''s'); SELECT 1")).toEqual([
    "INSERT INTO t VALUES ('a;b', 'it''s')",
    'SELECT 1',
  ]);
});

test('keeps semicolons inside quoted identifiers', () => {
  expect(splitStatements('CREATE TABLE [a;b] (id TEXT); SELECT 1')).toEqual([
    'CREATE TABLE [a;b] (id TEXT)',
    'SELECT 1',
  ]);
});

test('turns a block comment into a single space', () => {
  expect(splitStatements('SELECT/* c */1')).toEqual(['SELECT 1']);
});

test('turns a line comment into a single space and keeps one statement', () => {
  const statements = splitStatements('SELECT 1--c\nFROM t');

  expect(statements).toHaveLength(1);
  expect(statements[0]).toContain('1 ');
  expect(statements[0]).toContain('FROM');
});

test('drops empty pieces and trailing separators', () => {
  expect(splitStatements('SELECT 1;;\n\n; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  expect(splitStatements('')).toEqual([]);
  expect(splitStatements('-- only a comment;')).toEqual([]);
});

test('CRLF input equals LF input', () => {
  const lf = "INSERT INTO t VALUES ('a;\nb');\nSELECT 1";
  const crlf = lf.replace(/\n/g, '\r\n');

  expect(splitStatements(crlf)).toEqual(splitStatements(lf));
});

const forbidden: Array<[string, string]> = [
  ['BEGIN', 'BEGIN'],
  ['COMMIT', 'COMMIT'],
  ['END', 'END'],
  ['ROLLBACK', 'ROLLBACK'],
  ['SAVEPOINT', 'SAVEPOINT s'],
  ['RELEASE', 'RELEASE s'],
  ['PRAGMA', 'PRAGMA foreign_keys=ON'],
  ['ATTACH', "ATTACH DATABASE 'x' AS y"],
  ['DETACH', 'DETACH DATABASE y'],
  ['VACUUM', 'VACUUM'],
  ['CREATE TEMP TRIGGER', 'CREATE TEMP TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1'],
];

test.each(forbidden)('rejects %s with its index', (_, statement) => {
  expect(() => splitStatements(`SELECT 1;\n${statement}`)).toThrow(MigrationSyntaxError);

  try {
    splitStatements(`SELECT 1;\n${statement}`);
    expect.unreachable('splitStatements should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationSyntaxError);
    expect((error as MigrationSyntaxError).statementIndex).toBe(1);
  }
});

test.each([
  ['CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1', 0],
  ['CREATE TEMPORARY TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1', 0],
])('rejects %s at index %i', (statement, index) => {
  try {
    splitStatements(statement);
    expect.unreachable('splitStatements should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationSyntaxError);
    expect((error as MigrationSyntaxError).statementIndex).toBe(index);
  }
});

test('accepts exactly 100 000 UTF-8 bytes', () => {
  const statement = 'a'.repeat(100_000);

  expect(new TextEncoder().encode(statement)).toHaveLength(100_000);
  expect(splitStatements(statement)).toEqual([statement]);
});

test('rejects multibyte text over the byte limit but under the character limit', () => {
  const statement = '€'.repeat(33_334);
  const bytes = new TextEncoder().encode(statement);

  expect(statement).toHaveLength(33_334);
  expect(bytes).toHaveLength(100_002);

  try {
    splitStatements(statement);
    expect.unreachable('splitStatements should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationSyntaxError);
    expect((error as MigrationSyntaxError).statementIndex).toBe(0);
  }
});

test('accepts 99 999 bytes and rejects 100 001 bytes', () => {
  expect(splitStatements('a'.repeat(99_999))).toEqual(['a'.repeat(99_999)]);

  try {
    splitStatements('SELECT 1;'.concat('a'.repeat(100_001)));
    expect.unreachable('splitStatements should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationSyntaxError);
    expect((error as MigrationSyntaxError).statementIndex).toBe(1);
  }
});

test('an unterminated literal becomes MigrationSyntaxError with a null index', () => {
  try {
    splitStatements("SELECT 'open");
    expect.unreachable('splitStatements should have thrown');
  } catch (error) {
    expect(error).toBeInstanceOf(MigrationSyntaxError);
    expect((error as MigrationSyntaxError).statementIndex).toBeNull();
  }
});

test('no statement keeps a trailing semicolon', () => {
  const statements = splitStatements('SELECT 1; SELECT 2;');

  expect(statements).toEqual(['SELECT 1', 'SELECT 2']);
  expect(statements.every((statement) => !statement.endsWith(';'))).toBe(true);
});
