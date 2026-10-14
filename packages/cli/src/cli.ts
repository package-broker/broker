import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type { Platform } from '@package-broker/core/plugin';
import { build } from './build.js';

const USAGE =
  'Usage: pb <build|version> [--config <file>] [--target cloudflare|node] [--out <dir>]';

export async function run(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      config: { type: 'string', default: 'broker.config.ts' },
      target: { type: 'string' },
      out: { type: 'string' },
    },
  });
  const [command] = positionals;

  if (command === 'version') {
    const pkg = createRequire(import.meta.url)('../package.json') as { version: string };
    console.log(pkg.version);
    return 0;
  }

  if (command === 'build') {
    const target = values.target;
    if (target !== undefined && target !== 'cloudflare' && target !== 'node') {
      console.error(`unknown target "${target}"`);
      return 2;
    }
    const result = await build({
      configPath: values.config,
      ...(target === undefined ? {} : { target: target as Platform }),
      ...(values.out === undefined ? {} : { outDir: values.out }),
    });
    console.log(`manifest: ${result.manifestJson}`);
    console.log(`bundle: ${result.bundle}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}
