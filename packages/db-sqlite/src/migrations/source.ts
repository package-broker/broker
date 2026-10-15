import { scanSql } from '../sql/scan.js';
import { splitStatements } from './split.js';

export interface MigrationSource {
  readonly id: string;
  readonly owner: string;
  readonly name: string;
  readonly sequence: number;
  readonly sql: string;
  readonly checksum: string;
  readonly phase: 'expand' | 'contract';
}

export class MigrationSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationSourceError';
  }
}

const OWNER = /^[a-z0-9-]+$/;
const FILE_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const PHASE_DIRECTIVE = /^-- pb:phase[ \t]+(\S+)[ \t]*$/;
const DESTRUCTIVE = [
  /^DROP\s+(TABLE|INDEX|VIEW)\b/i,
  /^DELETE\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bDROP\b/i,
  /^ALTER\s+TABLE\b[\s\S]*\bRENAME\b/i,
];

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function readPhase(id: string, sql: string): 'expand' | 'contract' {
  const firstLine = sql.slice(0, sql.indexOf('\n') === -1 ? undefined : sql.indexOf('\n'));
  const value = PHASE_DIRECTIVE.exec(firstLine)?.[1];
  if (value === undefined) {
    if (/^-- pb:phase\b/.test(firstLine)) {
      throw new MigrationSourceError(`${id}: malformed pb:phase directive`);
    }
    return 'expand';
  }
  if (value === 'expand' || value === 'contract') return value;
  throw new MigrationSourceError(`${id}: unknown phase "${value}"`);
}

function lintExpand(id: string, sql: string): void {
  splitStatements(sql).forEach((statement, index) => {
    const code = scanSql(statement)
      .filter((segment) => segment.kind === 'code')
      .map((segment) => segment.text)
      .join(' ')
      .trim();
    if (DESTRUCTIVE.some((pattern) => pattern.test(code))) {
      throw new MigrationSourceError(
        `${id}: statement ${index} is destructive and not allowed in an expand migration`,
      );
    }
  });
}

export async function loadMigrationSource(
  owner: string,
  fileName: string,
  text: string,
): Promise<MigrationSource> {
  if (!OWNER.test(owner)) throw new MigrationSourceError(`invalid migration owner "${owner}"`);
  const match = FILE_NAME.exec(fileName);
  if (match === null) throw new MigrationSourceError(`invalid migration file name "${fileName}"`);

  const name = fileName.slice(0, -'.sql'.length);
  const id = `${owner}:${name}`;
  const sql = text.replace(/\r\n/g, '\n');
  const phase = readPhase(id, sql);
  if (phase === 'expand') lintExpand(id, sql);

  return {
    id,
    owner,
    name,
    sequence: Number(match[1]),
    sql,
    checksum: await sha256Hex(sql),
    phase,
  };
}
