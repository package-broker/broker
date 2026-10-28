import { execFile, type ExecFileOptions } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as manifest from './manifest.js';

const run = promisify(execFile);
const BUILD_SCRIPT = fileURLToPath(new URL('../scripts/build.mjs', import.meta.url));
const BUILD_TIMEOUT_MS = 60_000;

type BuildRunner = (
  file: string,
  args: readonly string[],
  options: ExecFileOptions,
) => Promise<unknown>;

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
    await runBuild(entry, out, budgetFile);
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

async function runBuild(
  entry: string,
  out: string,
  budgetFile: string,
  runner: BuildRunner = run,
): Promise<void> {
  await runner(
    process.execPath,
    [BUILD_SCRIPT, '--entry', entry, '--out', out, '--budget', budgetFile],
    { maxBuffer: 10_000_000, timeout: BUILD_TIMEOUT_MS },
  );
}

async function cleanupScratch(directory: string | undefined): Promise<void> {
  if (directory) await rm(directory, { recursive: true, force: true });
}

function assertNoInlineCode(html: string): void {
  expect(html).not.toMatch(/<script\b(?![^>]*\ssrc\s*=)[^>]*>/i);
  expect(html).not.toMatch(/<style\b/i);
  expect(html).not.toMatch(/<[a-z][^>]*\s(?:style|on[a-z]+)\s*=/i);
  expect(html).not.toMatch(/javascript:/i);
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
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  await run(process.execPath, [tsc, '-b', fileURLToPath(new URL('../../core', import.meta.url))], {
    timeout: BUILD_TIMEOUT_MS,
  });
  scratch = await mkdtemp(path.join(tmpdir(), 'pb-ui-build-test-'));
}, BUILD_TIMEOUT_MS);

afterAll(async () => {
  await cleanupScratch(scratch);
});

describe('build test safeguards', () => {
  it.each([
    ['an inline script', '<script>console.log("inline")</script>'],
    ['a script with only data-src', '<script data-src="app.js">inline()</script>'],
    ['a style element', '<style>body { color: red }</style>'],
    ['a style attribute', '<div style="color: red"></div>'],
    ['an event handler', '<button onclick="run()"></button>'],
    ['a javascript URL', '<a href="javascript:run()">run</a>'],
  ])('rejects %s even when the shared detector returns nothing', (_, html) => {
    const detector = vi.spyOn(manifest, 'findInlineCode').mockReturnValue([]);
    try {
      expect(() => assertNoInlineCode(html)).toThrow();
    } finally {
      detector.mockRestore();
    }
  });

  it('bounds the build subprocess with a finite timeout', async () => {
    const runner = vi.fn<BuildRunner>().mockResolvedValue(undefined);
    await runBuild('entry.js', 'out', 'budget.json', runner);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith(
      process.execPath,
      [BUILD_SCRIPT, '--entry', 'entry.js', '--out', 'out', '--budget', 'budget.json'],
      expect.objectContaining({ timeout: BUILD_TIMEOUT_MS }),
    );
    expect(BUILD_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(BUILD_TIMEOUT_MS)).toBe(true);
  });

  it('cleans up safely when scratch was never initialized', async () => {
    await expect(cleanupScratch(undefined)).resolves.toBeUndefined();
  });

  it('cleans up safely when scratch is stale', async () => {
    const directory = await mkdtemp(path.join(scratch, 'stale-'));
    await rm(directory, { recursive: true });
    await expect(cleanupScratch(directory)).resolves.toBeUndefined();
  });
});

describe('ui build output', () => {
  it(
    'links script and stylesheet by file and carries no inline code',
    async () => {
      const result = await build(await writeEntry("console.log('a');"));
      expect(result.code).toBe(0);
      const files = await readOutput(result.out);
      const html = files.get('index.html')?.toString('utf8') ?? '';
      assertNoInlineCode(html);
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

describe('split output budgets', () => {
  it(
    'rejects an oversized deferred chunk independently of the initial budget',
    async () => {
      const page = await writeEntry(
        'console.log(' +
          JSON.stringify(Array.from({ length: 1000 }, (_, index) => `value-${index}`).join(',')) +
          ');',
      );
      const entry = await writeEntry(
        `globalThis.loadPage = () => import(${JSON.stringify(page)});`,
      );
      const out = path.join(scratch, `out-${counter++}`);
      const budget = path.join(scratch, `split-budget-${counter++}.json`);
      await writeFile(budget, JSON.stringify({ initialGzipBytes: 1_000_000, chunkGzipBytes: 1 }));
      await expect(runBuild(entry, out, budget)).rejects.toThrow(/exceeds budget/);
      await expect(readdir(out)).rejects.toThrow();
      await writeFile(
        budget,
        JSON.stringify({ initialGzipBytes: 1_000_000, chunkGzipBytes: 10_000 }),
      );
      await expect(runBuild(entry, out, budget)).resolves.toBeUndefined();
      const files = await readOutput(out);
      expect([...files.keys()].filter((name) => name.endsWith('.js'))).toHaveLength(3);
    },
    BUILD_TIMEOUT_MS * 2,
  );
});

describe('ui setup build output', () => {
  it(
    'reports setup dependencies and outputs in the isolation graph',
    async () => {
      const entry = await writeEntry("console.log('app');");
      const corePath = fileURLToPath(
        new URL('../../core/src/authz/permissions.ts', import.meta.url),
      );
      const setupEntry = await writeEntry(
        `import { PERMISSIONS } from ${JSON.stringify(corePath)}; console.log(PERMISSIONS);`,
      );
      const out = path.join(scratch, `out-${counter++}`);
      const metafile = path.join(scratch, `meta-${counter++}.json`);
      await run(
        process.execPath,
        [
          BUILD_SCRIPT,
          '--entry',
          entry,
          '--setup-entry',
          setupEntry,
          '--out',
          out,
          '--budget',
          await writeBudget(1_000_000),
          '--metafile',
          metafile,
        ],
        { timeout: BUILD_TIMEOUT_MS },
      );
      const graph = JSON.parse(await readFile(metafile, 'utf8')) as {
        inputs: Record<string, unknown>;
        outputs: Record<string, { entryPoint?: string }>;
      };
      const absolute = (input: string) => realpathSync(path.resolve(input));
      expect(Object.keys(graph.inputs).map(absolute)).toEqual(
        expect.arrayContaining([entry, setupEntry, corePath].map(absolute)),
      );
      expect(
        Object.values(graph.outputs).map((output) => absolute(output.entryPoint ?? '')),
      ).toEqual(expect.arrayContaining([entry, setupEntry].map(absolute)));
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'measures every emitted HTML, script and stylesheet in the budget',
    async () => {
      const entry = await writeEntry("console.log('budget');");
      const out = path.join(scratch, `out-${counter++}`);
      const budget = await writeBudget(1_000_000);
      const args = [BUILD_SCRIPT, '--entry', entry, '--out', out, '--budget', budget];
      const { stdout } = await run(process.execPath, args, { timeout: BUILD_TIMEOUT_MS });
      const files = await readOutput(out);
      const measured = [...files]
        .filter(([name]) => /\.(?:html|js|css)$/.test(name))
        .reduce((sum, [, bytes]) => sum + gzipSync(bytes).length, 0);
      expect(stdout).toContain(`bundle gzip total ${measured} bytes`);
      await run(process.execPath, [...args, '--init-budget'], { timeout: BUILD_TIMEOUT_MS });
      expect(JSON.parse(await readFile(budget, 'utf8'))).toEqual({ gzipBytes: measured });
    },
    BUILD_TIMEOUT_MS * 2,
  );

  const setupReferences = (html: string): string[] =>
    [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1] ?? '');

  it(
    'emits setup.html with absolute setup asset URLs that the manifest lists',
    async () => {
      const result = await build(await writeEntry("console.log('app');"));
      expect(result.code).toBe(0);
      const files = await readOutput(result.out);
      const parsed = manifest.parseUiManifest(files.get('manifest.json')!.toString('utf8'));
      expect(parsed.entry).toBe('index.html');
      expect(parsed.files['setup.html']?.contentType).toBe('text/html');
      const html = files.get('setup.html')?.toString('utf8') ?? '';
      assertNoInlineCode(html);
      const references = setupReferences(html);
      expect(references).toHaveLength(2);
      for (const reference of references) {
        expect(reference).toMatch(/^\/_pb\/ui\/setup\/assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/);
        const name = reference.slice('/_pb/ui/setup/assets/'.length);
        expect(parsed.files[name]).toBeDefined();
        expect(files.has(name)).toBe(true);
      }
      expect(references.some((reference) => /\/setup\.[0-9a-f]{12}\.js$/.test(reference))).toBe(
        true,
      );
      expect(html).toContain('name="referrer" content="no-referrer"');
      expect(html).not.toMatch(/https?:\/\//);
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'bundles the setup script without React and keeps the normal entry untouched',
    async () => {
      const result = await build(await writeEntry("console.log('app');"));
      const files = await readOutput(result.out);
      const setupScript = [...files.keys()].find((name) => /^setup\.[0-9a-f]{12}\.js$/.test(name));
      expect(setupScript).toBeDefined();
      const text = files.get(setupScript!)!.toString('utf8');
      expect(text).not.toMatch(/\beval\s*\(|new Function/);
      expect(text).not.toContain('react-dom');
      const index = files.get('index.html')!.toString('utf8');
      expect(index).not.toContain('setup');
    },
    BUILD_TIMEOUT_MS,
  );

  it(
    'keeps the setup script name stable when only the app entry changes',
    async () => {
      const a = await readOutput((await build(await writeEntry("console.log('one');"))).out);
      const b = await readOutput((await build(await writeEntry("console.log('two');"))).out);
      const setupName = (files: Map<string, Buffer>) =>
        [...files.keys()].find((name) => name.startsWith('setup.') && name.endsWith('.js'));
      expect(setupName(a)).toBe(setupName(b));
    },
    BUILD_TIMEOUT_MS * 2,
  );
});

describe('whole app CSP graph', () => {
  it(
    'builds the actual app without scroll/style injection dependencies',
    async () => {
      const out = path.join(scratch, `whole-app-${counter++}`);
      const metafile = path.join(scratch, `whole-app-${counter++}.json`);
      await run(
        process.execPath,
        [
          BUILD_SCRIPT,
          '--out',
          out,
          '--budget',
          await writeBudget(1_000_000),
          '--metafile',
          metafile,
        ],
        { timeout: BUILD_TIMEOUT_MS },
      );
      const graph = JSON.parse(await readFile(metafile, 'utf8')) as {
        inputs: Record<string, unknown>;
      };
      const inputs = Object.keys(graph.inputs).join('\n');
      expect(inputs).toContain('src/main.tsx');
      expect(inputs).toContain('@base-ui/react');
      expect(inputs).toContain('@tanstack/react-table');
      expect(inputs).not.toMatch(/react-remove-scroll|react-style-singleton/);
      const files = await readOutput(out);
      for (const [name, bytes] of files)
        if (name.endsWith('.html')) assertNoInlineCode(bytes.toString('utf8'));
      const css = files.get(cssName(files))?.toString('utf8') ?? '';
      expect(css).toContain('@container broker-table');
      expect(css).toContain('content:attr(data-label)');
    },
    BUILD_TIMEOUT_MS,
  );
});
