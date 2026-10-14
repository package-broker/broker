import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const PLUGIN_PATH = /(^|\/)packages\/plugin-|node_modules\/@package-broker\/plugin-/;

async function bundleInputs(config, target, out) {
  execFileSync(
    'node',
    ['packages/cli/dist/bin.js', 'build', '--config', config, '--target', target, '--out', out],
    { stdio: 'inherit' },
  );
  const metafile = JSON.parse(await readFile(`${out}/metafile.json`, 'utf8'));
  return Object.keys(metafile.inputs);
}

let failed = false;

for (const target of ['cloudflare', 'node']) {
  const minimal = await bundleInputs('fixtures/minimal.config.ts', target, `.pb/minimal-${target}`);
  const leaked = minimal.filter((input) => PLUGIN_PATH.test(input));
  if (leaked.length > 0) {
    failed = true;
    console.error(`minimal/${target}: plugin modules in bundle:\n${leaked.join('\n')}`);
  }

  const full = await bundleInputs('broker.config.ts', target, `.pb/default-${target}`);
  if (!full.some((input) => PLUGIN_PATH.test(input))) {
    failed = true;
    console.error(`default/${target}: no plugin modules found, the check cannot prove anything`);
  }

  if (target === 'cloudflare') {
    const node = minimal.filter((input) => /(^|\/)runtime-node\//.test(input));
    if (node.length > 0) {
      failed = true;
      console.error(`minimal/cloudflare: node runtime in bundle:\n${node.join('\n')}`);
    }
  } else {
    const cf = minimal.filter((input) => /(^|\/)runtime-cloudflare\//.test(input));
    if (cf.length > 0) {
      failed = true;
      console.error(`minimal/node: cloudflare runtime in bundle:\n${cf.join('\n')}`);
    }
  }
  console.log(`${target}: minimal ${minimal.length} inputs, default ${full.length} inputs`);
}

process.exit(failed ? 1 : 0);
