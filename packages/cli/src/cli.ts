import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type { Platform } from '@package-broker/core/plugin';
import { build } from './build.js';
import { runCloudflareBootstrap, runCloudflareMigrate } from './commands/cloudflare.js';
import { runBootstrapSqlite, runMigrateSqlite } from './commands/sqlite.js';

const USAGE =
  'Usage: pb build [--config <file>] [--target cloudflare|node] [--out <dir>]\n' +
  '       pb migrate --sqlite <file> [--out <dir> (default .pb/node)] [--dry-run]\n' +
  '       pb bootstrap --sqlite <file> --slug <slug> --name <name>\n' +
  '       pb cloudflare migrate --database-id <id> [--out <dir> (default .pb/cloudflare)] [--dry-run]\n' +
  '       pb cloudflare bootstrap --database-id <id> --slug <slug> --name <name>\n' +
  '       pb version\n' +
  'Exit codes: 0 success; 1 error; 2 usage or invalid slug; 3 checksum mismatch; 4 migration locked; 5 already bootstrapped with another slug; 6 outcome unknown (response lost after the request was sent)';

function parseCliArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        config: { type: 'string' },
        target: { type: 'string' },
        out: { type: 'string' },
        sqlite: { type: 'string' },
        slug: { type: 'string' },
        name: { type: 'string' },
        'database-id': { type: 'string' },
        'dry-run': { type: 'boolean' },
      },
    });
  } catch {
    return null;
  }
}

const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  build: ['config', 'target', 'out'],
  migrate: ['sqlite', 'out', 'dry-run'],
  bootstrap: ['sqlite', 'slug', 'name'],
  'cloudflare migrate': ['database-id', 'out', 'dry-run'],
  'cloudflare bootstrap': ['database-id', 'slug', 'name'],
  version: [],
};

function acceptsInvocation(positionals: readonly string[], flags: readonly string[]): boolean {
  const allowed = ALLOWED_FLAGS[positionals.join(' ')];
  return allowed !== undefined && flags.every((flag) => allowed.includes(flag));
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
  if (!acceptsInvocation(positionals, Object.keys(values))) {
    console.error(USAGE);
    return 2;
  }
  const [command, subcommand] = positionals;

  if (command === 'cloudflare' && values['database-id']) {
    if (subcommand === 'migrate') {
      return runCloudflareMigrate({
        databaseId: values['database-id'],
        outDir: values.out || '.pb/cloudflare',
        dryRun: values['dry-run'] ?? false,
        env: process.env,
      });
    }
    if (subcommand === 'bootstrap' && values.slug && values.name) {
      return runCloudflareBootstrap({
        databaseId: values['database-id'],
        slug: values.slug,
        name: values.name,
        env: process.env,
      });
    }
  }

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
      configPath: values.config ?? 'broker.config.ts',
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
