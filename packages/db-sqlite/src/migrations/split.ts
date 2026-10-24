import { scanSql, SqlScanError, type Segment } from '../sql/scan.js';

const MAX_STATEMENT_BYTES = 100_000;
const utf8 = new TextEncoder();
const LEADING_WORD = /^[A-Za-z_]+/;
const TEMP_TRIGGER = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)TRIGGER\b/i;

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
  if ((word !== undefined && FORBIDDEN_KEYWORDS.has(word)) || TEMP_TRIGGER.test(statement)) {
    throw new MigrationSyntaxError(`statement ${index} is not allowed in a migration`, index);
  }
  if (utf8.encode(statement).length > MAX_STATEMENT_BYTES) {
    throw new MigrationSyntaxError(
      `statement ${index} exceeds ${MAX_STATEMENT_BYTES} bytes`,
      index,
    );
  }
}

function triggerBodyStart(): (token: string, quoted?: boolean) => boolean {
  let phase: 'on' | 'table' | 'after-table' | 'when' = 'on';
  let depth = 0;
  let operand = true;

  return (token, quoted = false) => {
    if (phase === 'on') {
      if (!quoted && token === 'ON') phase = 'table';
    } else if (phase === 'table') {
      phase = 'after-table';
    } else if (phase === 'after-table') {
      if (!quoted && token === '.') phase = 'table';
      else if (!quoted && token === 'WHEN') phase = 'when';
      else if (!quoted && token === 'BEGIN') return true;
    } else if (quoted) {
      operand = false;
    } else {
      if (token === 'BEGIN' && depth === 0 && !operand) return true;
      if (token === '(' || token === 'CASE') {
        depth += 1;
        operand = true;
      } else if (token === ')' || (token === 'END' && !operand)) {
        depth -= 1;
        operand = false;
      } else {
        operand =
          /^[.,+*/%<>=~!&|?:@$-]$/.test(token) ||
          /^(?:AND|OR|NOT|IS|DISTINCT|FROM|IN|LIKE|GLOB|REGEXP|MATCH|BETWEEN|ESCAPE|WHEN|THEN|ELSE|AS|COLLATE)$/.test(
            token,
          );
      }
    }
    return false;
  };
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
  let leadingWords: string[] = [];
  let trigger = false;
  let body = false;
  let closed = false;
  let bodyStatementStart = false;
  let startsBody = triggerBodyStart();

  const flush = (): void => {
    const statement = current.trim();
    if (trigger && !closed) {
      const index = statements.length;
      throw new MigrationSyntaxError(`statement ${index} has an unterminated trigger`, index);
    }
    current = '';
    leadingWords = [];
    trigger = false;
    body = false;
    closed = false;
    bodyStatementStart = false;
    startsBody = triggerBodyStart();
    if (statement.length > 0) statements.push(statement);
  };

  for (const segment of segments) {
    if (segment.kind === 'comment') {
      current += ' ';
      continue;
    }
    if (segment.kind !== 'code') {
      current += segment.text;
      if (trigger && !body) startsBody(segment.text, true);
      continue;
    }

    let start = 0;
    for (const token of segment.text.matchAll(/[A-Za-z_][A-Za-z_0-9$]*|[0-9]+|\S/g)) {
      const word = token[0].toUpperCase();
      if (word === ';') {
        if (!trigger || closed) {
          current += segment.text.slice(start, token.index);
          flush();
          start = token.index + 1;
        } else {
          bodyStatementStart = true;
        }
        continue;
      }
      if (leadingWords.length < 2 && /^[A-Z_]/.test(word)) {
        leadingWords.push(word);
        trigger = leadingWords[0] === 'CREATE' && leadingWords[1] === 'TRIGGER';
      }
      if (!trigger) continue;
      if (!body) {
        if (startsBody(word)) {
          body = true;
          bodyStatementStart = true;
        }
      } else {
        if (word === 'END' && bodyStatementStart) closed = true;
        bodyStatementStart = false;
      }
    }
    current += segment.text.slice(start);
  }
  flush();

  statements.forEach((statement, index) => reject(statement, index));
  return statements;
}
