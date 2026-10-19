import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { checkBudget, findInlineCode, parseUiManifest } from '../src/manifest.ts';

const run = promisify(execFile);
const here = (target) => fileURLToPath(new URL(target, import.meta.url));
const packageRoot = here('../');

function flag(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
  return path.resolve(value);
}

const outDir = flag('--out', path.join(packageRoot, 'dist/assets'));
const entryPath = flag('--entry', path.join(packageRoot, 'src/main.tsx'));
const budgetPath = flag('--budget', path.join(packageRoot, 'bundle-budget.json'));
const metafilePath = flag('--metafile', undefined);

const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

async function bundleScript() {
  const { outputFiles, metafile } = await build({
    entryPoints: [entryPath],
    bundle: true,
    write: false,
    metafile: true,
    outdir: outDir,
    format: 'esm',
    target: 'es2022',
    platform: 'browser',
    jsx: 'automatic',
    minify: true,
    legalComments: 'none',
    define: { 'process.env.NODE_ENV': '"production"' },
    logLevel: 'warning',
  });
  const file = outputFiles?.find((output) => output.path.endsWith('.js'));
  if (!file) throw new Error('esbuild produced no JavaScript output');
  return { script: Buffer.from(file.contents), metafile };
}

async function compileStyles() {
  const cliBin = createRequire(import.meta.url).resolve('@tailwindcss/cli/package.json');
  const manifest = JSON.parse(await readFile(cliBin, 'utf8'));
  const bin = fileURLToPath(new URL(manifest.bin.tailwindcss ?? manifest.bin, `file://${cliBin}`));
  const scratch = await mkdtemp(`${tmpdir()}/pb-ui-css-`);
  try {
    const output = `${scratch}/app.css`;
    await run(
      process.execPath,
      [bin, '--input', path.join(packageRoot, 'src/styles.css'), '--output', output, '--minify'],
      { cwd: packageRoot },
    );
    return await readFile(output);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

function renderIndex(scriptName, styleName) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Package Broker</title>
    <link rel="stylesheet" href="${styleName}" />
    <script type="module" src="${scriptName}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
}

const { script, metafile } = await bundleScript();
const styles = await compileStyles();
const scriptName = `app.${hashOf(script)}.js`;
const styleName = `app.${hashOf(styles)}.css`;
const html = Buffer.from(renderIndex(scriptName, styleName));

const inline = findInlineCode(html.toString('utf8'));
if (inline.length > 0) throw new Error(`index.html must not contain: ${inline.join(', ')}`);
const scriptText = script.toString('utf8');
if (/\b(?:eval|Function)\s*\(/.test(scriptText)) {
  throw new Error('bundle contains eval or Function calls, which the CSP forbids');
}

const total = gzipSync(script).length + gzipSync(styles).length;
if (process.argv.includes('--init-budget')) {
  await writeFile(budgetPath, `${JSON.stringify({ gzipBytes: total }, null, 2)}\n`);
  console.log(`bundle budget initialized at ${total} gzip bytes`);
  process.exit(0);
}
let budget;
try {
  budget = JSON.parse(await readFile(budgetPath, 'utf8'))?.gzipBytes;
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  throw new Error(
    'Bundle budget file is missing; pass --init-budget to initialize it deliberately',
    { cause: error },
  );
}
if (!Number.isSafeInteger(budget) || budget <= 0) {
  throw new Error('Bundle budget gzipBytes must be a positive safe integer');
}
const { ok, limit } = checkBudget(total, budget);
console.log(`bundle gzip total ${total} bytes, budget ${budget} bytes, limit ${limit} bytes`);
if (!ok) {
  throw new Error(
    `bundle gzip total ${total} bytes exceeds budget ${budget} bytes by more than 10% (limit ${limit}); update bundle-budget.json deliberately if the growth is intended`,
  );
}

const files = {
  'index.html': { contentType: 'text/html', bytes: html.length },
  [scriptName]: { contentType: 'text/javascript', bytes: script.length },
  [styleName]: { contentType: 'text/css', bytes: styles.length },
};
const manifestText = `${JSON.stringify({ version: 1, entry: 'index.html', files }, null, 2)}\n`;
parseUiManifest(manifestText);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(`${outDir}/index.html`, html),
  writeFile(`${outDir}/${scriptName}`, script),
  writeFile(`${outDir}/${styleName}`, styles),
  writeFile(`${outDir}/manifest.json`, manifestText),
]);
if (metafilePath) await writeFile(metafilePath, `${JSON.stringify(metafile, null, 2)}\n`);
