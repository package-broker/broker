import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type { Platform } from '@package-broker/core/plugin';
import { build } from './build.js';
import {
  runAdminBootstrap,
  runAdminRebindProvider,
  runAdminResetLocal,
  runAdminShowProviderBinding,
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
  '       pb admin rebind-provider --provider <id> --confirm <id> --expected-anchor <anchor> --new-anchor <anchor> (--sqlite <file> | --cloudflare --database-id <id>)\n' +
  '       pb admin show-provider-binding --provider <id> (--sqlite <file> | --cloudflare --database-id <id>)\n' +
  '       pb version\n' +
  'Exit codes: 0 success; 1 error; 2 usage or invalid slug; 3 checksum mismatch; 4 migration locked; 5 already bootstrapped with another slug; 6 outcome unknown (response lost after the request was sent)\n' +
  'Exit codes for pb admin bootstrap/reset-local: 0 success; 1 error; 2 usage, invalid e-mail or existing token file; 5 organization not bootstrapped; 6 already_set_up (bootstrap) or not_found (reset-local); 7 outcome unknown (D1 request sent, no usable response, re-running is safe); 8 admin_role_missing (reset-local); SIGINT or SIGTERM received during a synchronous SQLite batch is handled after the batch returns\n' +
  'Exit codes for pb admin rebind-provider: 0 success; 1 error; 2 usage, --confirm not equal to --provider, or invalid provider or anchor; 5 organization not bootstrapped; 6 anchor_mismatch (no binding with that provider and expected anchor; nothing changed); 7 outcome unknown (D1 response lost; the swap may have applied; a re-run that reports anchor_mismatch means it did or the anchor is wrong)\n' +
  'Exit codes for pb admin show-provider-binding: 0 success; 1 error; 2 usage or invalid provider; 5 organization not bootstrapped; 6 no_binding; nothing is bound for that provider; 7 outcome unknown (D1 response lost, re-running is safe)';

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
        provider: { type: 'string' },
        confirm: { type: 'string' },
        'expected-anchor': { type: 'string' },
        'new-anchor': { type: 'string' },
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
  'admin rebind-provider': [
    'provider',
    'confirm',
    'expected-anchor',
    'new-anchor',
    'sqlite',
    'cloudflare',
    'database-id',
  ],
  'admin show-provider-binding': ['provider', 'sqlite', 'cloudflare', 'database-id'],
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

  if (command === 'admin' && subcommand === 'rebind-provider') {
    const target = adminTarget(values);
    const { provider, confirm } = values;
    const expectedAnchor = values['expected-anchor'];
    const newAnchor = values['new-anchor'];
    if (
      target !== null &&
      provider !== undefined &&
      confirm !== undefined &&
      expectedAnchor !== undefined &&
      newAnchor !== undefined
    ) {
      return runAdminRebindProvider({ provider, confirm, expectedAnchor, newAnchor, target });
    }
  }

  if (command === 'admin' && subcommand === 'show-provider-binding') {
    const target = adminTarget(values);
    const { provider } = values;
    if (target !== null && provider !== undefined) {
      return runAdminShowProviderBinding({ provider, target });
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
