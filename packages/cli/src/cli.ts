import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type { Platform } from '@package-broker/core/plugin';
import { build } from './build.js';
import {
  runAdminBootstrap,
  runAdminResetLocal,
  runGenerateMasterKey,
  type AdminTarget,
} from './commands/admin.js';
import { runCloudflareBootstrap, runCloudflareMigrate } from './commands/cloudflare.js';
import { runBootstrapSqlite, runMigrateSqlite } from './commands/sqlite.js';

const USAGE =
  'Usage: pb build [--config <file>] [--target cloudflare|node] [--out <dir>]\n' +
  '       pb migrate --sqlite <file> [--out <dir> (default .pb/node)] [--dry-run]\n' +
  '       pb bootstrap --sqlite <file> --slug <slug> --name <name>\n' +
  '       pb cloudflare migrate --database-id <id> [--out <dir> (default .pb/cloudflare)] [--dry-run]\n' +
  '       pb cloudflare bootstrap --database-id <id> --slug <slug> --name <name>\n' +
  '       pb secrets generate-master-key [--key-version <n> (default 1)]\n' +
  '       pb admin bootstrap --email <e> (--sqlite <file> | --cloudflare --database-id <id>) [--token-file <path>]\n' +
  '       pb admin reset-local --email <e> (--sqlite <file> | --cloudflare --database-id <id>) [--token-file <path>]\n' +
  '       pb version\n' +
  'Exit codes: 0 success; 1 error; 2 usage or invalid slug; 3 checksum mismatch; 4 migration locked; 5 already bootstrapped with another slug; 6 outcome unknown (response lost after the request was sent)\n' +
  'Exit codes for pb admin: 0 success; 1 error; 2 usage, invalid e-mail or existing token file; 5 organization not bootstrapped; 6 already_set_up (bootstrap) or not_found (reset-local); 7 outcome unknown (D1 response lost, re-running is safe); 8 admin_role_missing (reset-local)';

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
        email: { type: 'string' },
        cloudflare: { type: 'boolean' },
        'token-file': { type: 'string' },
        'key-version': { type: 'string' },
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
  'secrets generate-master-key': ['key-version'],
  'admin bootstrap': ['email', 'sqlite', 'cloudflare', 'database-id', 'token-file'],
  'admin reset-local': ['email', 'sqlite', 'cloudflare', 'database-id', 'token-file'],
  version: [],
};

function acceptsInvocation(positionals: readonly string[], flags: readonly string[]): boolean {
  const allowed = ALLOWED_FLAGS[positionals.join(' ')];
  return allowed !== undefined && flags.every((flag) => allowed.includes(flag));
}

function adminTarget(values: {
  readonly sqlite?: string | undefined;
  readonly cloudflare?: boolean | undefined;
  readonly 'database-id'?: string | undefined;
}): AdminTarget | null {
  const databaseId = values['database-id'];
  if (values.sqlite !== undefined && values.cloudflare !== true && databaseId === undefined) {
    return { kind: 'sqlite', file: values.sqlite };
  }
  if (values.sqlite === undefined && values.cloudflare === true && databaseId !== undefined) {
    return { kind: 'cloudflare', databaseId, env: process.env };
  }
  return null;
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

  if (command === 'secrets' && subcommand === 'generate-master-key') {
    return runGenerateMasterKey({ keyVersion: values['key-version'] });
  }

  if (command === 'admin' && (subcommand === 'bootstrap' || subcommand === 'reset-local')) {
    const target = adminTarget(values);
    if (values.email !== undefined && target !== null) {
      const options = { email: values.email, target, tokenFile: values['token-file'] };
      return subcommand === 'bootstrap' ? runAdminBootstrap(options) : runAdminResetLocal(options);
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
