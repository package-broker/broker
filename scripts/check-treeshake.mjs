import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';

const PLUGIN_PATH = /(^|\/)packages\/plugin-|node_modules\/@package-broker\/plugin-/;
const WORKERS_INPUT_DENY =
  /node_modules\/(\.pnpm\/)?(better-sqlite3|miniflare|@hono\/node-server)|db-sqlite\/(src|dist)\/(contract|testing)\//;
const NODE_INPUT_DENY = /miniflare|db-sqlite\/(src|dist)\/(contract|testing)\//;
const DYNAMIC_IMPORT = /(?:^|[^\w$.])import\s*\(/g;
const REQUIRE_CALL = /(?:^|[^\w$.])(?:__)?require\s*\(/g;
const FROM_SPECIFIER = /\bfrom\s*/g;
const STATIC_IMPORT = /(?:^|[^\w$.])import\s+/g;
const CLOUDFLARE_ALLOWED_NODE = new Set(['node:async_hooks']);
const FIXTURE = process.env.PB_CHECK_TREESHAKE_FIXTURE;

function skipSpace(text, start) {
  let cursor = start;
  while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
  return cursor;
}

function readStringLiteral(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let cursor = start + 1;
  while (cursor < text.length) {
    const char = text[cursor];
    if (char === '\\') {
      cursor += 2;
      continue;
    }
    if (char === quote) return { start, value: text.slice(start + 1, cursor), end: cursor + 1 };
    if (quote === '`' && char === '$' && text[cursor + 1] === '{') return null;
    cursor += 1;
  }
  return null;
}

function scanBundle(file, text) {
  const findings = [];
  const report = (offset, kind) => findings.push(`${file}:${offset} ${kind}`);

  for (const match of text.matchAll(DYNAMIC_IMPORT)) {
    const open = match.index + match[0].length;
    const literal = readStringLiteral(text, skipSpace(text, open));
    if (!literal) report(open, 'dynamic import() with a non-literal specifier');
    else if (literal.value.startsWith('node:'))
      report(literal.start, 'node: specifier in import()');
  }

  for (const match of text.matchAll(FROM_SPECIFIER)) {
    const literal = readStringLiteral(text, skipSpace(text, match.index + match[0].length));
    if (literal?.value.startsWith('node:') && !CLOUDFLARE_ALLOWED_NODE.has(literal.value))
      report(literal.start, 'node: specifier after from');
  }

  for (const match of text.matchAll(STATIC_IMPORT)) {
    const literal = readStringLiteral(text, skipSpace(text, match.index + match[0].length));
    if (literal?.value.startsWith('node:') && !CLOUDFLARE_ALLOWED_NODE.has(literal.value))
      report(literal.start, 'node: specifier in import');
  }

  for (const match of text.matchAll(REQUIRE_CALL)) {
    const open = match.index + match[0].length;
    report(open, 'require() call');
    const literal = readStringLiteral(text, skipSpace(text, open));
    if (literal?.value.startsWith('node:')) report(literal.start, 'node: specifier in require()');
  }

  return findings;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (FIXTURE) {
      console.error(
        `PB_CHECK_TREESHAKE_FIXTURE=${FIXTURE}: cannot read ${path} (${error.code ?? error.message}); each bundle needs a subdirectory with metafile.json and its bundle files`,
      );
      process.exit(2);
    }
    throw error;
  }
}

async function bundle(config, target, out) {
  if (!FIXTURE)
    execFileSync(
      'node',
      ['packages/cli/dist/bin.js', 'build', '--config', config, '--target', target, '--out', out],
      { stdio: 'inherit' },
    );
  const dir = FIXTURE ? resolve(FIXTURE, basename(out)) : out;
  const outputBase = FIXTURE ? dir : process.cwd();
  const metafile = JSON.parse(await readText(resolve(dir, 'metafile.json')));
  const inputs = Object.keys(metafile.inputs);
  const externalImports = [];
  const bundleFiles = [];
  for (const [key, output] of Object.entries(metafile.outputs)) {
    for (const imported of output.imports ?? [])
      if (imported.external) externalImports.push(imported.path);
    if (target === 'cloudflare' && key.endsWith('.js')) bundleFiles.push(resolve(outputBase, key));
  }
  return { inputs, externalImports, bundleFiles };
}

if (FIXTURE) {
  let entries;
  try {
    entries = await readdir(FIXTURE);
  } catch (error) {
    console.error(
      `PB_CHECK_TREESHAKE_FIXTURE=${FIXTURE}: fixture directory is missing or unreadable (${error.code ?? error.message})`,
    );
    process.exit(2);
  }
  if (entries.length === 0) {
    console.error(
      `PB_CHECK_TREESHAKE_FIXTURE=${FIXTURE}: fixture directory is empty, expected per-bundle subdirectories with metafile.json and bundle files`,
    );
    process.exit(2);
  }
}

let failed = false;

for (const target of ['cloudflare', 'node']) {
  const minimal = await bundle('fixtures/minimal.config.ts', target, `.pb/minimal-${target}`);
  const leaked = minimal.inputs.filter((input) => PLUGIN_PATH.test(input));
  if (leaked.length > 0) {
    failed = true;
    console.error(
      `minimal/${target}: plugin modules in bundle (metafile: every bundled input path):\n${leaked.join('\n')}`,
    );
  }

  const full = await bundle('broker.config.ts', target, `.pb/default-${target}`);
  if (!full.inputs.some((input) => PLUGIN_PATH.test(input))) {
    failed = true;
    console.error(`default/${target}: no plugin modules found, the check cannot prove anything`);
  }

  const inputDeny = target === 'cloudflare' ? WORKERS_INPUT_DENY : NODE_INPUT_DENY;
  for (const [label, { inputs }] of [
    ['minimal', minimal],
    ['default', full],
  ]) {
    const forbidden = inputs.filter((input) => inputDeny.test(input));
    if (forbidden.length > 0) {
      failed = true;
      console.error(
        `${label}/${target}: forbidden modules in bundle (metafile: every bundled input path):\n${forbidden.join('\n')}`,
      );
    }
  }

  if (target === 'cloudflare') {
    for (const [label, { externalImports }] of [
      ['minimal', minimal],
      ['default', full],
    ]) {
      const foreign = externalImports.filter(
        (path) => !path.startsWith('cloudflare:') && !CLOUDFLARE_ALLOWED_NODE.has(path),
      );
      if (foreign.length > 0) {
        failed = true;
        console.error(
          `${label}/cloudflare: external imports other than cloudflare:* and node:async_hooks (metafile: every external import of every output):\n${foreign.join('\n')}`,
        );
      }
    }

    for (const [label, { bundleFiles }] of [
      ['minimal', minimal],
      ['default', full],
    ]) {
      for (const file of bundleFiles) {
        const findings = scanBundle(file, await readText(file));
        if (findings.length > 0) {
          failed = true;
          console.error(
            `${label}/cloudflare: emitted verbatim, invisible to the metafile (bundle text scan for dynamic import() with a non-literal specifier, require()/__require() calls, and node: specifiers after import()/from/import/require()):\n${findings.join('\n')}`,
          );
        }
      }
    }

    const node = minimal.inputs.filter((input) => /(^|\/)runtime-node\//.test(input));
    if (node.length > 0) {
      failed = true;
      console.error(`minimal/cloudflare: node runtime in bundle:\n${node.join('\n')}`);
    }
  } else {
    const cf = minimal.inputs.filter((input) => /(^|\/)runtime-cloudflare\//.test(input));
    if (cf.length > 0) {
      failed = true;
      console.error(`minimal/node: cloudflare runtime in bundle:\n${cf.join('\n')}`);
    }
  }
  console.log(
    `${target}: minimal ${minimal.inputs.length} inputs, default ${full.inputs.length} inputs`,
  );
}

process.exit(failed ? 1 : 0);
