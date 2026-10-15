import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type { Platform } from '@package-broker/core/plugin';
import { build } from './build.js';
import { runBootstrapSqlite, runMigrateSqlite } from './commands/sqlite.js';

const USAGE =
  'Usage: pb build [--config <file>] [--target cloudflare|node] [--out <dir>]\n' +
  '       pb migrate --sqlite <file> [--out <dir> (default .pb/node)] [--dry-run]\n' +
  '       pb bootstrap --sqlite <file> --slug <slug> --name <name>\n' +
  '       pb version\n' +
  'Exit codes: 0 success; 1 error; 2 usage or invalid slug; 3 checksum mismatch; 4 migration locked; 5 already bootstrapped with another slug';

function parseCliArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string', default: 'broker.config.ts' },
        target: { type: 'string' },
        out: { type: 'string' },
        sqlite: { type: 'string' },
        slug: { type: 'string' },
        name: { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    });
  } catch {
    return null;
  }
}

export async function run(argv: readonly string[]): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const parsed = parseCliArgs([...argv]);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const { positionals, values } = parsed;
  const [command] = positionals;

  if (command === 'migrate' && values.sqlite) {
    return runMigrateSqlite({
      file: values.sqlite,
      outDir: values.out || '.pb/node',
      dryRun: values['dry-run'] ?? false,
    });
  }

  if (command === 'bootstrap' && values.sqlite && values.slug && values.name) {
    return runBootstrapSqlite({ file: values.sqlite, slug: values.slug, name: values.name });
  }

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
