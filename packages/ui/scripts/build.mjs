import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import {
  checkLoadBudgets,
  measureInitialLoad,
  findInlineCode,
  parseUiManifest,
} from '../src/manifest.ts';

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
const setupEntryPath = flag('--setup-entry', path.join(packageRoot, 'src/setup.tsx'));
const budgetPath = flag('--budget', path.join(packageRoot, 'bundle-budget.json'));
const metafilePath = flag('--metafile', undefined);

const hashOf = (bytes) => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

async function bundleScript(entry, split = false) {
  entry = await realpath(entry);
  const { outputFiles, metafile } = await build({
    entryPoints: [entry],
    bundle: true,
    splitting: split,
    chunkNames: 'chunk-[hash]',
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
  const outputs = new Map(
    outputFiles.map((file) => [
      path.relative(process.cwd(), file.path),
      Buffer.from(file.contents),
    ]),
  );
  const scripts = new Map();
  const names = new Map();
  const inProgress = new Set();
  function emit(key) {
    if (names.has(key)) return names.get(key);
    if (inProgress.has(key)) throw new Error('UI bundle import cycle prevents content hashing');
    inProgress.add(key);
    let text = outputs.get(key).toString('utf8');
    for (const dependency of metafile.outputs[key].imports) {
      if (dependency.external) throw new Error('UI bundle must not contain external imports');
      const name = emit(dependency.path);
      text = text.replaceAll(`./${path.basename(dependency.path)}`, `./${name}`);
    }
    const bytes = Buffer.from(text);
    const isEntry = path.resolve(metafile.outputs[key].entryPoint ?? '') === entry;
    const pageEntry = metafile.outputs[key].entryPoint;
    const prefix = isEntry
      ? split
        ? 'app'
        : 'setup'
      : pageEntry
        ? path.basename(pageEntry, path.extname(pageEntry))
        : 'chunk';
    const name = `${prefix}.${hashOf(bytes)}.js`;
    inProgress.delete(key);
    names.set(key, name);
    scripts.set(name, bytes);
    return name;
  }
  const entryKey = Object.keys(metafile.outputs).find(
    (key) => path.resolve(metafile.outputs[key].entryPoint ?? '') === entry,
  );
  if (!entryKey) throw new Error('esbuild produced no JavaScript entry');
  const entryName = emit(entryKey);
  return { scripts, entryName, metafile, entryKey, names };
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

function renderIndex(scriptName, styleName, preloads) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Package Broker</title>
    <link rel="stylesheet" href="${styleName}" />
${preloads.map((name) => `    <link rel="modulepreload" href="${name}" />`).join('\n')}
    <script type="module" src="${scriptName}"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;
}

const SETUP_ASSET_PREFIX = '/_pb/ui/setup/assets/';

function renderSetup(scriptName, styleName) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Package Broker setup</title>
    <link rel="stylesheet" href="${SETUP_ASSET_PREFIX}${styleName}" />
    <script type="module" src="${SETUP_ASSET_PREFIX}${scriptName}"></script>
  </head>
  <body>
    <main id="root" class="mx-auto max-w-xl p-6"></main>
  </body>
</html>
`;
}

const app = await bundleScript(entryPath, true);
const setup = await bundleScript(setupEntryPath);
const { metafile } = app;
const setupMetafile = setup.metafile;
const scripts = new Map([...app.scripts, ...setup.scripts]);
const styles = await compileStyles();
const scriptName = app.entryName;
const styleName = `app.${hashOf(styles)}.css`;
const setupScriptName = setup.entryName;
const sizes = Object.fromEntries(
  [...app.names].map(([key, name]) => [key, gzipSync(scripts.get(name)).length]),
);
const initialGraph = measureInitialLoad(metafile.outputs, app.entryKey, sizes, 0);
const preloads = initialGraph.initialFiles
  .filter((key) => key !== app.entryKey)
  .map((key) => app.names.get(key));
const html = Buffer.from(renderIndex(scriptName, styleName, preloads));
const setupHtml = Buffer.from(renderSetup(setupScriptName, styleName));

for (const [label, document] of [
  ['index.html', html],
  ['setup.html', setupHtml],
]) {
  const inline = findInlineCode(document.toString('utf8'));
  if (inline.length > 0) throw new Error(`${label} must not contain: ${inline.join(', ')}`);
}
for (const bundled of scripts.values()) {
  if (/\b(?:eval|Function)\s*\(/.test(bundled.toString('utf8'))) {
    throw new Error('bundle contains eval or Function calls, which the CSP forbids');
  }
}

const fixedBytes = [html, setupHtml, scripts.get(setupScriptName), styles].reduce(
  (sum, bytes) => sum + gzipSync(bytes).length,
  0,
);
const measured = measureInitialLoad(metafile.outputs, app.entryKey, sizes, fixedBytes);
const total = measured.totalGzipBytes;
if (process.argv.includes('--init-budget')) {
  await writeFile(
    budgetPath,
    `${JSON.stringify({ initialGzipBytes: measured.initialGzipBytes, chunkGzipBytes: measured.chunkGzipBytes, totalGzipBytes: total }, null, 2)}\n`,
  );
  console.log(`bundle budget initialized at ${total} gzip bytes`);
  process.exit(0);
}
let budget;
try {
  budget = JSON.parse(await readFile(budgetPath, 'utf8'));
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  throw new Error(
    'Bundle budget file is missing; pass --init-budget to initialize it deliberately',
    { cause: error },
  );
}
const checked = checkLoadBudgets(measured, budget);
console.log(
  `bundle gzip total ${total} bytes, initial load ${measured.initialGzipBytes} bytes, largest chunk ${measured.chunkGzipBytes} bytes`,
);
console.log(
  `bundle gzip limits: initial ${checked.initial.limit}, chunk ${checked.chunk.limit}, total ${checked.total.limit} bytes`,
);
for (const [cap, result] of Object.entries(checked)) {
  if (!result.ok) {
    const key = `${cap}GzipBytes`;
    throw new Error(
      `UI ${key} exceeds budget: measured ${measured[key]} bytes, limit ${result.limit} bytes; update bundle-budget.json deliberately`,
    );
  }
}

const files = {
  'index.html': { contentType: 'text/html', bytes: html.length },
  'setup.html': { contentType: 'text/html', bytes: setupHtml.length },
  ...Object.fromEntries(
    [...scripts].map(([name, bytes]) => [
      name,
      { contentType: 'text/javascript', bytes: bytes.length },
    ]),
  ),
  [styleName]: { contentType: 'text/css', bytes: styles.length },
};
const manifestText = `${JSON.stringify({ version: 1, entry: 'index.html', files }, null, 2)}\n`;
parseUiManifest(manifestText);
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(`${outDir}/index.html`, html),
  writeFile(`${outDir}/setup.html`, setupHtml),
  ...[...scripts].map(([name, bytes]) => writeFile(`${outDir}/${name}`, bytes)),
  writeFile(`${outDir}/${styleName}`, styles),
  writeFile(`${outDir}/manifest.json`, manifestText),
]);
if (metafilePath) {
  const combined = {
    inputs: { ...metafile.inputs, ...setupMetafile.inputs },
    outputs: { ...metafile.outputs, ...setupMetafile.outputs },
  };
  await writeFile(metafilePath, `${JSON.stringify(combined, null, 2)}\n`);
}
