import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findInlineCode } from './manifest.js';

const run = promisify(execFile);
const BUILD_SCRIPT = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));
const BUILD_TIMEOUT_MS = 60_000;

interface BuildResult {
  readonly code: number;
  readonly output: string;
  readonly out: string;
}

let scratch: string;
let counter = 0;

async function writeEntry(source: string): Promise<string> {
  const entry = path.join(scratch, `entry-${counter++}.js`);
  await writeFile(entry, source);
  return entry;
}

async function writeBudget(gzipBytes: number): Promise<string> {
  const file = path.join(scratch, `budget-${counter++}.json`);
  await writeFile(file, JSON.stringify({ gzipBytes }));
  return file;
}

async function build(entry: string, budget: number = 1_000_000): Promise<BuildResult> {
  const out = path.join(scratch, `out-${counter++}`);
  const budgetFile = await writeBudget(budget);
  try {
    await run(
      process.execPath,
      [BUILD_SCRIPT, '--entry', entry, '--out', out, '--budget', budgetFile],
      { maxBuffer: 10_000_000 },
    );
    return { code: 0, output: '', out };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: failure.code ?? 1,
      output: `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
      out,
    };
  }
}

async function readOutput(out: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const name of (await readdir(out)).sort()) {
    files.set(name, await readFile(path.join(out, name)));
  }
  return files;
}

const jsName = (files: Map<string, Buffer>): string =>
  [...files.keys()].find((name) => name.endsWith('.js')) ?? '';
const cssName = (files: Map<string, Buffer>): string =>
  [...files.keys()].find((name) => name.endsWith('.css')) ?? '';

beforeAll(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), 'pb-ui-build-test-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('ui build output', () => {
  it(
    'links script and stylesheet by file and carries no inline code',
    async () => {
      const result = await build(await writeEntry("console.log('a');"));
      expect(result.code).toBe(0);
      const files = await readOutput(result.out);
      const html = files.get('index.html')?.toString('utf8') ?? '';
      expect(findInlineCode(html)).toEqual([]);
      expect(html).toContain(`src="${jsName(files)}"`);
      expect(html).toContain(`href="${cssName(files)}"`);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'produces identical names and bytes for the same input',
    async () => {
      const entry = await writeEntry("console.log('same');");
      const first = await build(entry);
      const second = await build(entry);
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const a = await readOutput(first.out);
      const b = await readOutput(second.out);
      expect([...b.keys()]).toEqual([...a.keys()]);
      for (const [name, bytes] of a) expect(b.get(name)?.equals(bytes)).toBe(true);
    },
    BUILD_TIMEOUT_MS * 2,
  );

  it(
    'renames only the script when only the entry changes',
    async () => {
      const first = await build(await writeEntry("console.log('one');"));
      const second = await build(await writeEntry("console.log('two');"));
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      const a = await readOutput(first.out);
      const b = await readOutput(second.out);
      expect(jsName(b)).not.toBe(jsName(a));
      expect(cssName(b)).toBe(cssName(a));
      expect(b.get(cssName(b))?.equals(a.get(cssName(a)) ?? Buffer.alloc(0))).toBe(true);
    },
    BUILD_TIMEOUT_MS * 2,
  );

  it(
    'fails when the bundle exceeds a lowered budget',
    async () => {
      const result = await build(await writeEntry("console.log('big');"), 1);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('exceeds budget');
      await expect(readdir(result.out)).rejects.toThrow();
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'fails when the entry calls eval',
    async () => {
      const result = await build(await writeEntry("eval('1');"));
      expect(result.code).not.toBe(0);
      expect(result.output).toContain('eval or Function');
      await expect(readdir(result.out)).rejects.toThrow();
    },
    BUILD_TIMEOUT_MS,
  );
});
