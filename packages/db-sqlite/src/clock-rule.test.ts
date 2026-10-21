import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIRECTORY = fileURLToPath(new URL('./repositories/', import.meta.url));

const APPLICATION_CLOCK = /\b(?:require)?[tT]imestamp\(\s*(?:'[^']*'\s*,\s*)?[\w.]*\bnow\b/;
const DATABASE_CLOCK = [
  /unixepoch\(\s*'now'/,
  /(?:strftime|datetime|julianday)\([^\n]*?'now'/,
  /from\s+'\.\/(?:session-liveness|actor-authority)\.js'/,
];

const ALLOWED_MIXED: Readonly<Record<string, string>> = {
  'grant.ts':
    'stamps rows with the caller-supplied now; the acting session liveness predicate uses the database clock',
  'project-grant.ts':
    'stamps rows with the caller-supplied now; the acting session liveness predicate uses the database clock',
  'project.ts':
    'stamps rows with the caller-supplied now; the acting session liveness and reauth window use the database clock',
  'token.ts':
    'stamps rows with the caller-supplied now; evidence freshness, session idle and expiry predicates use the database clock',
  'unlink.ts':
    'stamps blocked_at and revoked_at with the caller-supplied now; the acting session liveness predicate uses the database clock',
};

function mixesClocks(text: string): boolean {
  return APPLICATION_CLOCK.test(text) && DATABASE_CLOCK.some((idiom) => idiom.test(text));
}

function mixedClockFiles(read: (file: string) => string, files: readonly string[]): string[] {
  return files.filter((file) => mixesClocks(read(file))).sort();
}

const files = readdirSync(DIRECTORY).filter(
  (file) => file.endsWith('.ts') && !file.endsWith('.test.ts'),
);
const read = (file: string) => readFileSync(`${DIRECTORY}${file}`, 'utf8');

describe('clock rule: stamps from the application clock, predicates from the database clock', () => {
  it('every repository file mixing both clocks is allowlisted', () => {
    const unlisted = mixedClockFiles(read, files).filter((file) => !(file in ALLOWED_MIXED));
    expect(unlisted).toEqual([]);
  });

  it('every allowlist entry still mixes both clocks', () => {
    const mixed = new Set(mixedClockFiles(read, files));
    const stale = Object.keys(ALLOWED_MIXED).filter((file) => !mixed.has(file));
    expect(stale).toEqual([]);
  });

  it('every allowlist entry carries a one-line reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED_MIXED)) {
      expect(reason.trim(), file).not.toBe('');
      expect(reason, file).not.toContain('\n');
    }
  });

  describe('detector', () => {
    const application = [
      "const now = timestamp('now', input.now);",
      'const stamp = timestamp(now);',
      'const stamp = timestamp(input.now);',
      'requireTimestamp(input.now);',
    ];
    const database = [
      "unixepoch('now', 'subsec')",
      "strftime(${sql.lit(FORMAT)}, 'now')",
      "datetime('now', '-1 day')",
      "julianday('now')",
      "import { liveSessionCondition } from './session-liveness.js';",
    ];

    it.each(application.flatMap((a) => database.map((d) => [a, d] as const)))(
      'flags %s with %s',
      (a, d) => {
        expect(mixesClocks(`${a}\n${d}`)).toBe(true);
      },
    );

    it.each(application)('does not flag %s alone', (a) => {
      expect(mixesClocks(a)).toBe(false);
    });

    it.each(database)('does not flag %s alone', (d) => {
      expect(mixesClocks(d)).toBe(false);
    });

    it('flags a new file that mixes both idioms', () => {
      const fake: Record<string, string> = { 'fresh.ts': `${database[0]} ${application[0]}` };
      expect(mixedClockFiles((file) => fake[file]!, ['fresh.ts'])).toEqual(['fresh.ts']);
    });
  });
});
