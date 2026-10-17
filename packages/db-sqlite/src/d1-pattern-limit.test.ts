import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const D1_MAX_PATTERN_BYTES = 50;
const packagesRoot = fileURLToPath(new URL('../../', import.meta.url));

const EXPECTED_MATCHES: Record<string, number> = {
  'db-sqlite/migrations/0002_local_login.sql': 2,
  'db-sqlite/migrations/0007_registry.sql': 6,
  'db-sqlite/src/contract/auth-contract.ts': 2,
  'db-sqlite/src/contract/migration-contract.ts': 5,
  'db-sqlite/src/contract/migration-lock-contract.ts': 1,
  'db-sqlite/src/repositories/catalogue-list.ts': 1,
  'db-sqlite/src/repositories/catalogue-predicates.ts': 4,
  'db-sqlite/src/repositories/job-schedule.ts': 2,
  'db-sqlite/src/repositories/registered-name.ts': 2,
};

const DYNAMIC: Record<string, string> = {
  'db-sqlite/src/repositories/catalogue-list.ts:${pattern}':
    'escaped search pattern; UTF-8 byte length checked <= 50, otherwise instr() fallback',
  "db-sqlite/src/repositories/catalogue-predicates.ts:${at(a.r, 'pattern')}":
    'catalogue rule pattern; D1 limit open, owner decision',
  "db-sqlite/src/repositories/catalogue-predicates.ts:${at(a.im, 'pattern')}":
    'catalogue rule pattern; D1 limit open, owner decision',
  "db-sqlite/src/repositories/catalogue-predicates.ts:${at(a.x, 'pattern')}":
    'catalogue rule pattern; D1 limit open, owner decision',
  'db-sqlite/src/repositories/registered-name.ts:rn_cov.pattern':
    'registered-name pattern; permits up to MAX_KEY_LENGTH (428) bytes, D1 limit open, owner decision',
};

interface Finding {
  file: string;
  operand: string;
  bytes?: number;
  reason?: string | undefined;
}

function walk(dir: string, accept: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path, accept);
    return accept(entry.name) ? [path] : [];
  });
}

const isSource = (name: string) => name.endsWith('.ts') && !name.endsWith('.test.ts');

function scannedFiles(): string[] {
  return [
    ...walk(join(packagesRoot, 'db-sqlite/src'), isSource),
    ...walk(join(packagesRoot, 'db-sqlite/migrations'), (name) => name.endsWith('.sql')),
    ...walk(join(packagesRoot, 'core/src'), isSource),
  ].sort();
}

function decodeLiteral(raw: string, isTs: boolean): string {
  const unescaped = isTs ? raw.replace(/\\\\/g, '\\') : raw;
  return unescaped.replace(/''/g, "'");
}

function constantValue(source: string, name: string, isTs: boolean): string | undefined {
  const declaration = new RegExp(
    `\\bconst\\s+${name}\\s*(?::[^=]+)?=\\s*(?:'((?:[^'\\\\]|\\\\.|'')*)'|"((?:[^"\\\\]|\\\\.)*)"|\`([^\`$]*)\`)`,
  ).exec(source);
  if (!declaration) return undefined;
  const [, single, double, template] = declaration;
  if (single !== undefined) return decodeLiteral(single, isTs);
  return double ?? template;
}

const OPERATOR =
  /\b(?:NOT\s+)?(?:GLOB|LIKE)\s+('(?:[^']|'')*'|\$\{[^}]*\}|[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)+)/gi;

function audit(): { findings: Finding[]; counts: Record<string, number> } {
  const findings: Finding[] = [];
  const counts: Record<string, number> = {};
  for (const path of scannedFiles()) {
    const file = relative(packagesRoot, path);
    const isTs = path.endsWith('.ts');
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(OPERATOR)) {
      counts[file] = (counts[file] ?? 0) + 1;
      const operand = match[1]!;
      if (operand.startsWith("'")) {
        const value = decodeLiteral(operand.slice(1, -1), isTs);
        findings.push({ file, operand, bytes: Buffer.byteLength(value, 'utf8') });
        continue;
      }
      const reference = /^\$\{([A-Za-z_$][\w$]*)\}$/.exec(operand);
      const resolved = reference ? constantValue(source, reference[1]!, isTs) : undefined;
      if (resolved !== undefined) {
        findings.push({ file, operand, bytes: Buffer.byteLength(resolved, 'utf8') });
        continue;
      }
      findings.push({ file, operand, reason: DYNAMIC[`${file}:${operand}`] });
    }
  }
  return { findings, counts };
}

describe('D1 LIKE/GLOB pattern limit', () => {
  const { findings, counts } = audit();

  it('matches the expected number of LIKE/GLOB operators per file', () => {
    expect(counts).toEqual(EXPECTED_MATCHES);
  });

  it('keeps every constant pattern within the D1 byte limit', () => {
    const constants = findings.filter((finding) => finding.bytes !== undefined);
    expect(constants.length).toBeGreaterThan(0);
    const tooLong = constants.filter((finding) => finding.bytes! > D1_MAX_PATTERN_BYTES);
    expect(tooLong).toEqual([]);
  });

  it('lists every non-constant operand in DYNAMIC with a reason', () => {
    const unlisted = findings
      .filter((finding) => finding.bytes === undefined && !finding.reason)
      .map((finding) => `${finding.file}:${finding.operand}`);
    expect(unlisted).toEqual([]);
  });

  it('has no stale DYNAMIC entries', () => {
    const seen = new Set(findings.map((finding) => `${finding.file}:${finding.operand}`));
    expect(Object.keys(DYNAMIC).filter((key) => !seen.has(key))).toEqual([]);
  });
});
