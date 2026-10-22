import { scanSql, SqlScanError, type Segment } from '../sql/scan.js';

const MAX_STATEMENT_BYTES = 100_000;
const SEMICOLON = 59;
const utf8 = new TextEncoder();
const LEADING_WORD = /^[A-Za-z_]+/;
const CREATE_TRIGGER = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;

const FORBIDDEN_KEYWORDS = new Set([
  'BEGIN',
  'COMMIT',
  'END',
  'ROLLBACK',
  'SAVEPOINT',
  'RELEASE',
  'PRAGMA',
  'ATTACH',
  'DETACH',
  'VACUUM',
]);

export class MigrationSyntaxError extends Error {
  readonly statementIndex: number | null;

  constructor(message: string, statementIndex: number | null) {
    super(message);
    this.name = 'MigrationSyntaxError';
    this.statementIndex = statementIndex;
  }
}

function reject(statement: string, index: number): void {
  const word = LEADING_WORD.exec(statement)?.[0]?.toUpperCase();
  if ((word !== undefined && FORBIDDEN_KEYWORDS.has(word)) || CREATE_TRIGGER.test(statement)) {
    throw new MigrationSyntaxError(`statement ${index} is not allowed in a migration`, index);
  }
  if (utf8.encode(statement).length > MAX_STATEMENT_BYTES) {
    throw new MigrationSyntaxError(
      `statement ${index} exceeds ${MAX_STATEMENT_BYTES} bytes`,
      index,
    );
  }
}

export function splitStatements(sql: string): string[] {
  let segments: Segment[];
  try {
    segments = scanSql(sql.replace(/\r\n/g, '\n'));
  } catch (error) {
    if (error instanceof SqlScanError) {
      throw new MigrationSyntaxError(error.message, null);
    }
    throw error;
  }

  const statements: string[] = [];
  let current = '';

  const flush = (): void => {
    const statement = current.trim();
    current = '';
    if (statement.length > 0) statements.push(statement);
  };

  for (const segment of segments) {
    if (segment.kind === 'comment') {
      current += ' ';
      continue;
    }
    if (segment.kind !== 'code') {
      current += segment.text;
      continue;
    }

    let start = 0;
    for (let index = 0; index < segment.text.length; index += 1) {
      if (segment.text.charCodeAt(index) === SEMICOLON) {
        current += segment.text.slice(start, index);
        flush();
        start = index + 1;
      }
    }
    current += segment.text.slice(start);
  }
  flush();

  statements.forEach((statement, index) => reject(statement, index));
  return statements;
}
