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

test.each([['CREATE TEMPORARY TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1', 0]])(
  'rejects %s at index %i',
  (statement, index) => {
    try {
      splitStatements(statement);
      expect.unreachable('splitStatements should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(MigrationSyntaxError);
      expect((error as MigrationSyntaxError).statementIndex).toBe(index);
    }
  },
);

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

// Migration batches may not change PRAGMAs.
test.each([
  'PRAGMA foreign_keys = OFF',
  'PRAGMA foreign_keys = ON',
  'PRAGMA defer_foreign_keys = OFF',
  'PRAGMA defer_foreign_keys = ON',
  'PRAGMA writable_schema = ON',
])('rejects migration PRAGMA %s', (statement) => {
  expect(() => splitStatements(statement)).toThrow(MigrationSyntaxError);
});

test('keeps a complete trigger and its body semicolons in one statement', () => {
  const trigger = 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1; SELECT 2; END';
  expect(splitStatements(`${trigger}; SELECT 3;`)).toEqual([trigger, 'SELECT 3']);
});

test.each([
  'CREATE TRIGGER tr AFTER UPDATE OF begin, end ON t BEGIN SELECT 1; END',
  'CREATE TRIGGER tr AFTER INSERT ON t WHEN begin BEGIN SELECT 1; END',
  'CREATE TRIGGER tr AFTER INSERT ON t FOR EACH ROW WHEN begin = 1 BEGIN SELECT 1; END',
  'CREATE TRIGGER tr AFTER INSERT ON begin BEGIN SELECT 1; END',
  'CREATE TRIGGER tr AFTER INSERT ON main.begin WHEN t.begin + begin > 0 BEGIN SELECT 1; END',
  'CREATE TRIGGER tr AFTER INSERT ON "begin" WHEN (begin OR end) BEGIN SELECT 1; END',
  'CREATE TRIGGER tr AFTER INSERT ON t WHEN CASE WHEN begin THEN end ELSE 0 END BEGIN SELECT 1; END',
])('recognises the trigger body after header identifiers: %s', (trigger) => {
  expect(splitStatements(`${trigger}; SELECT 2;`)).toEqual([trigger, 'SELECT 2']);
});

test('ignores END and semicolons in trigger strings, identifiers and comments', () => {
  const trigger = `CREATE /* header */ TRIGGER tr AFTER INSERT ON t BEGIN
    SELECT 'END; it''s text', "END;", [END;]; -- END;
    /* END; */ SELECT 2;
  END`;
  const statements = splitStatements(`${trigger}; SELECT 3;`);
  expect(statements).toHaveLength(2);
  expect(statements[0]).toContain(`SELECT 'END; it''s text', "END;", [END;];`);
  expect(statements[0]).toContain('SELECT 2;');
  expect(statements[1]).toBe('SELECT 3');
});

test('keeps CASE END inside a trigger body', () => {
  const trigger =
    'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 2 END; SELECT 3; END';
  expect(splitStatements(trigger)).toEqual([trigger]);
});

test.each([
  'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 1;',
  "CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT 'END;'; /* END */",
  'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT CASE WHEN 1 THEN 2 END;',
])('rejects an unterminated trigger with its statement index: %s', (trigger) => {
  expect(() => splitStatements(`SELECT 1; ${trigger}`)).toThrow(
    expect.objectContaining({ name: 'MigrationSyntaxError', statementIndex: 1 }),
  );
});

test('applies the byte cap to the whole trigger body', () => {
  const trigger = `CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT '${'€'.repeat(33_334)}'; END;`;
  expect(() => splitStatements(trigger)).toThrow(/statement 0 exceeds 100000 bytes/);
});

test('does not close a trigger on an unquoted END column', () => {
  const trigger = 'CREATE TRIGGER tr AFTER INSERT ON t BEGIN SELECT end FROM t; SELECT 2; END';
  expect(splitStatements(trigger)).toEqual([trigger]);
});
