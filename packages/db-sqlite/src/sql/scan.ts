export type SegmentKind = 'code' | 'string' | 'identifier' | 'comment';

export interface Segment {
  readonly kind: SegmentKind;
  readonly text: string;
  readonly start: number;
}

export class SqlScanError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(message);
    this.name = 'SqlScanError';
    this.offset = offset;
  }
}

const SINGLE_QUOTE = 39;
const DOUBLE_QUOTE = 34;
const BACKTICK = 96;
const OPEN_BRACKET = 91;
const HYPHEN = 45;
const SLASH = 47;
const ASTERISK = 42;
const LINE_FEED = 10;
const CARRIAGE_RETURN = 13;

function readIdentifier(sql: string, start: number): number {
  const close = sql.indexOf(']', start + 1);
  if (close === -1) {
    throw new SqlScanError('unterminated quoted identifier', start);
  }
  return close + 1;
}

function readQuoted(sql: string, start: number): { end: number; kind: SegmentKind } {
  const open = sql.charCodeAt(start);
  const kind: SegmentKind = open === SINGLE_QUOTE ? 'string' : 'identifier';
  let index = start + 1;

  while (index < sql.length) {
    if (sql.charCodeAt(index) === open) {
      if (sql.charCodeAt(index + 1) === open) {
        index += 2;
        continue;
      }
      return { end: index + 1, kind };
    }
    index += 1;
  }

  throw new SqlScanError(
    kind === 'string' ? 'unterminated string literal' : 'unterminated quoted identifier',
    start,
  );
}

function readLineCommentEnd(sql: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    const code = sql.charCodeAt(index);
    if (code === LINE_FEED || code === CARRIAGE_RETURN) {
      return index;
    }
    index += 1;
  }
  return sql.length;
}

function readBlockCommentEnd(sql: string, start: number): number {
  const close = sql.indexOf('*/', start + 2);
  if (close === -1) {
    throw new SqlScanError('unterminated block comment', start);
  }
  return close + 2;
}

export function scanSql(sql: string): Segment[] {
  const segments: Segment[] = [];
  let codeStart = 0;
  let index = 0;

  const flushCode = (end: number): void => {
    if (end > codeStart) {
      segments.push({
        kind: 'code',
        text: sql.slice(codeStart, end),
        start: codeStart,
      });
    }
    codeStart = end;
  };

  const push = (kind: SegmentKind, start: number, end: number): void => {
    flushCode(start);
    segments.push({ kind, text: sql.slice(start, end), start });
    index = end;
    codeStart = end;
  };

  while (index < sql.length) {
    const code = sql.charCodeAt(index);
    const next = sql.charCodeAt(index + 1);

    if (code === HYPHEN && next === HYPHEN) {
      push('comment', index, readLineCommentEnd(sql, index));
    } else if (code === SLASH && next === ASTERISK) {
      push('comment', index, readBlockCommentEnd(sql, index));
    } else if (code === OPEN_BRACKET) {
      push('identifier', index, readIdentifier(sql, index));
    } else if (code === SINGLE_QUOTE || code === DOUBLE_QUOTE || code === BACKTICK) {
      const { end, kind } = readQuoted(sql, index);
      push(kind, index, end);
    } else {
      index += 1;
    }
  }

  flushCode(sql.length);
  return segments;
}
