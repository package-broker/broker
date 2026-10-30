import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import type { Platform } from '@package-broker/core/plugin';
import { build, BuildDiagnosticsError } from './build.js';
import { assertPrebuiltConfiguration } from './prebuilt.js';
import {
  runAdminBootstrap,
  runAdminRebindProvider,
  runAdminResetLocal,
  runAdminShowProviderBinding,
  runGenerateMasterKey,
  type AdminTarget,
} from './commands/admin.js';
import { runCloudflareBootstrap, runCloudflareMigrate } from './commands/cloudflare.js';
import { runCloudflareProvision } from './commands/cloudflare/provision.js';
import { readProvidersOption, type ProvidersOption } from './commands/cloudflare/providers-file.js';
import { runCloudflareDeploy } from './commands/cloudflare/deploy.js';
import { runCloudflareSetup } from './commands/cloudflare/setup.js';
import { runCloudflareSmoke } from './commands/cloudflare/smoke.js';
import { runCloudflareTeardown } from './commands/cloudflare/teardown.js';
import { runCloudflareJanitor } from './commands/cloudflare/janitor.js';
import { commandEnvelope, failCommand, CloudflareError } from './commands/cloudflare/api.js';
import { runImport } from './commands/import.js';
import { runImportCutover } from './commands/import-cutover.js';
import { runImportSatisPlan } from './commands/import-satis.js';
import {
  runImportPrivatePackagistFetch,
  runImportPrivatePackagistPlan,
  runImportPrivatePackagistDates,
} from './commands/import-private-packagist.js';
import { runSourceAcceptRemoval } from './commands/source.js';
import { runOpenApi } from './commands/openapi.js';
import { runBootstrapSqlite, runMigrateSqlite } from './commands/sqlite.js';

const USAGE =
  'Usage: pb build [--config <file>] [--target cloudflare|node] [--out <dir>]\n' +
  '       pb migrate --sqlite <file> [--out <dir> (default .pb/node)] [--dry-run]\n' +
  '       pb bootstrap --sqlite <file> --slug <slug> --name <name>\n' +
  '       pb cloudflare setup [--workers-paid] [--prebuilt] [--providers <file|none>] [--local-auth enabled|disabled] --worker-name <slug> --org-slug <slug> --org-name <name> --admin-email <email> [--key-file <path> | --master-key-env <name>] [--token-file <path>] [--non-interactive] [--yes] [--refresh-setup-token] [--json] [--dry-run]\n' +
  '       pb cloudflare provision [--prebuilt] --worker-name <slug> [--config <file>] [--environment <slug>] [--jurisdiction eu|default] [--inventory <file>] [--out <dir>] [--adopt-resource <kind:id>] [--abandon-intent <op-id>] [--domain <hostname>] [--yes] [--json] [--dry-run]\n' +
  '       pb cloudflare deploy [--workers-paid] [--prebuilt] [--providers <file|none>] [--local-auth enabled|disabled] --worker-name <slug> [--out <dir>] [--rollout <1..100>] [--domain <hostname>] [--public-url <https-origin>] [--routes <zone:pattern\n...>] [--secret <ENV_NAME>] [--secrets <ENV_NAMES>] [--json] [--dry-run]\n' +
  '       pb cloudflare smoke --worker-name <slug> [--project <slug>] [--smoke-token-env <name>] [--deadline-seconds <1..300>] [--no-rollback] [--json] [--dry-run]\n' +
  '       pb cloudflare teardown --inventory <file> [--config <file>] [--project <dir>] [--inventory-id <owner_digest> --i-understand-this-deletes] [--json] [--dry-run]\n' +
  '       pb cloudflare janitor --repository-id <numeric-id> [--inventory <file>] [--config <file>] [--project <dir>] [--json] [--dry-run]\n' +
  '       pb cloudflare migrate [--prebuilt] --database-id <id> [--out <dir> (default .pb/cloudflare)] [--dry-run]\n' +
  '       pb cloudflare bootstrap --database-id <id> --slug <slug> --name <name>\n' +
  '       pb secrets generate-master-key [--key-version <n> (default 1)]\n' +
  '       pb admin bootstrap [--sign-in local|sso] (--email <e> | --group <group> --provider <id>) (--sqlite <file> | --cloudflare --database-id <id>) [--token-file <path>]\n' +
  '       pb admin reset-local --email <e> (--sqlite <file> | --cloudflare --database-id <id>) [--token-file <path>]\n' +
  '       pb admin rebind-provider --provider <id> --confirm <id> --expected-anchor <anchor> --new-anchor <anchor> (--sqlite <file> | --cloudflare --database-id <id>)\n' +
  '       pb admin show-provider-binding --provider <id> (--sqlite <file> | --cloudflare --database-id <id>)\n' +
  '       pb import cutover-check --project-dir <dir> --old-repository <url> --new-repository <url> --old-auth-env <VAR> --new-auth-env <VAR> [--lock <file>]... [--timeout-seconds <seconds>] [--json]\n' +
  '       pb import private-packagist fetch --org <short-name> --snapshot <out.json> [--api-key-file <path>] [--api-secret-file <path>] [--versions] [--require-org-match] (or PP_API_KEY_FILE/PP_API_SECRET_FILE)\n' +
  '       pb import private-packagist plan --snapshot <file> --map <file> --out <manifest> --credentials-out <file> [--members <csv>] [--baseline <manifest>] [--mode merge|override] [--include-org-admins] [--runtime workers|node] [--packagist existing:<name>] [--compact-selection --compact-vendor <vendor>...] [--accept-project-widening <slug>...] [--quiet]\n' +
  '       pb import private-packagist dates --snapshot <file> --map <file> --baseline <manifest> --out <manifest> [--package <name>...] [--quiet]\n' +
  '       pb import satis plan --config <satis.json> --out <manifest> [--project <slug>] [--repository-map <file>] [--credentials <file>] [--baseline <manifest>] [--mode merge|override]\n' +
  '       pb import submit --manifest <file> --receipt <file> --principal <label> --broker <origin> [--resume] [--token-file <path>]\n' +
  '       pb import status <run> --broker <origin> [--wait | --wait-seconds <0..300>] [--token-file <path>]\n' +
  '       pb import credentials <run> --manifest <file> --credentials <map> --broker <origin> [--token-file <path>]\n' +
  '       pb import verify <run> --broker <origin> [--wait | --wait-seconds <0..300>] [--token-file <path>]\n' +
  '       pb import accept <run> --broker <origin> [--wait | --wait-seconds <0..300>] [--token-file <path>]\n' +
  '       pb source accept-removal --url <https-origin> --source <id> (PB_SESSION and PB_CSRF_TOKEN)\n' +
  '       pb version\n' +
  'Exit codes: 0 success; 1 error; 2 usage, invalid slug or invalid build configuration; 3 checksum mismatch; 4 migration locked; 5 already bootstrapped with another slug; 6 outcome unknown (response lost after the request was sent)\n' +
  '--providers <file|none>: none removes the definitions; pass a file named none as ./none.\n' +
  '--local-auth enabled|disabled: preserve the live setting when omitted; re-enabling requires --local-auth enabled. PB_AUTH_LOCAL must agree when both are supplied.\n' +
  '--workers-paid: use the Paid Workers environment variable limit (128; default 64) for cloudflare deploy/setup.\n' +
  'Exit codes for pb cloudflare smoke: 8 concurrent deployment or ownership conflict; 9 smoke failed on an existing deployment; 10 rollback failed or unknown; 11 contract migration blocks rollback; 12 first-deployment smoke failed with no prior release\n' +
  'Exit codes for pb cloudflare teardown/janitor: 0 cleaned or skipped; 1 cleanup failed; 2 invalid inventory, wrong inventory id or missing destructive confirmation; 4 inventory locked; 6 unresolved resource or deletion outcome; 8 ownership conflict. Production confirmation uses identity.owner_digest as --inventory-id. Adopted D1 and R2 resources always require --i-understand-this-deletes; janitor retains them. Inventory schema version 2 records deployment history and lifecycle baselines. Janitor requires run_identity pb-e2e-<repository-id>-<epoch-seconds> (optional run suffix) and a matching worker_name stem; Worker stems may encode both numbers in lowercase base 36 to fit name limits. Both the run and inventory update must be older than 6 hours. Deleting a Worker removes its versions.\n' +
  'Import commands use PB_IMPORT_TOKEN or --token-file. --resume requires the same token (idempotency principal); --principal is only a non-secret receipt label. Approval, apply and accept stay in the UI. Import exit codes: 0 success; 1 API or run failure; 2 local validation; 3 pending UI action or wait timeout; 6 outcome unknown.\n' +
  'Admin bootstrap: --sign-in defaults to local; --group and --provider require sso; --token-file is local-only. SSO provider configuration must be verified separately.\n' +
  'Exit codes for pb admin bootstrap/reset-local: 0 success; 1 error (including a suspended SSO account; nothing changed); 2 usage, invalid e-mail or existing token file; 5 organization not bootstrapped; 6 already_set_up (bootstrap) or not_found (reset-local); 7 outcome unknown (D1 request sent, no usable response, re-running is safe); 8 admin_role_missing (reset-local); SIGINT or SIGTERM received during a synchronous SQLite batch is handled after the batch returns\n' +
  'Exit codes for pb admin rebind-provider: 0 success; 1 error; 2 usage, --confirm not equal to --provider, or invalid provider or anchor; 5 organization not bootstrapped; 6 anchor_mismatch (no binding with that provider and expected anchor; nothing changed); 7 outcome unknown (D1 response lost; the swap may have applied; a re-run that reports anchor_mismatch means it did or the anchor is wrong)\n' +
  'Exit codes for pb admin show-provider-binding: 0 success; 1 error; 2 usage or invalid provider; 5 organization not bootstrapped; 6 no_binding; nothing is bound for that provider; 7 outcome unknown (D1 response lost, re-running is safe)';

function parseCliArgs(argv: string[]) {
  try {
    return parseArgs({
      args: argv,
      allowPositionals: true,
      tokens: true,
      options: {
        url: { type: 'string' },
        broker: { type: 'string' },
        'project-dir': { type: 'string' },
        'old-repository': { type: 'string' },
        'new-repository': { type: 'string' },
        'old-auth-env': { type: 'string' },
        'new-auth-env': { type: 'string' },
        'timeout-seconds': { type: 'string' },
        lock: { type: 'string', multiple: true },
        org: { type: 'string' },
        snapshot: { type: 'string' },
        map: { type: 'string' },
        package: { type: 'string', multiple: true },
        'credentials-out': { type: 'string' },
        members: { type: 'string' },
        'include-org-admins': { type: 'boolean' },
        runtime: { type: 'string' },
        packagist: { type: 'string' },
        'compact-selection': { type: 'boolean' },
        'compact-vendor': { type: 'string', multiple: true },
        'accept-project-widening': { type: 'string', multiple: true },
        quiet: { type: 'boolean' },
        'api-key-file': { type: 'string' },
        'api-secret-file': { type: 'string' },
        versions: { type: 'boolean' },
        'require-org-match': { type: 'boolean' },
        manifest: { type: 'string' },
        receipt: { type: 'string' },
        principal: { type: 'string' },
        resume: { type: 'boolean' },
        wait: { type: 'boolean' },
        'wait-seconds': { type: 'string' },
        source: { type: 'string' },
        config: { type: 'string' },
        target: { type: 'string' },
        out: { type: 'string' },
        sqlite: { type: 'string' },
        slug: { type: 'string' },
        name: { type: 'string' },
        'database-id': { type: 'string' },
        email: { type: 'string' },
        provider: { type: 'string' },
        providers: { type: 'string' },
        'local-auth': { type: 'string' },
        confirm: { type: 'string' },
        'expected-anchor': { type: 'string' },
        'new-anchor': { type: 'string' },
        cloudflare: { type: 'boolean' },
        prebuilt: { type: 'boolean' },
        'sign-in': { type: 'string' },
        group: { type: 'string' },
        'token-file': { type: 'string' },
        'key-file': { type: 'string' },
        'master-key-env': { type: 'string' },
        'org-slug': { type: 'string' },
        'org-name': { type: 'string' },
        'admin-email': { type: 'string' },
        'non-interactive': { type: 'boolean' },
        'refresh-setup-token': { type: 'boolean' },
        migrate: { type: 'string' },
        'key-version': { type: 'string' },
        'dry-run': { type: 'boolean' },
        'worker-name': { type: 'string' },
        environment: { type: 'string' },
        'deployment-id': { type: 'string' },
        inventory: { type: 'string' },
        'inventory-id': { type: 'string' },
        'i-understand-this-deletes': { type: 'boolean' },
        'repository-id': { type: 'string' },
        jurisdiction: { type: 'string' },
        'location-hint': { type: 'string' },
        'adopt-resource': { type: 'string', multiple: true },
        'abandon-intent': { type: 'string' },
        'allow-contract': { type: 'string', multiple: true },
        domain: { type: 'string' },
        rollout: { type: 'string' },
        'public-url': { type: 'string' },
        routes: { type: 'string' },
        secret: { type: 'string', multiple: true },
        secrets: { type: 'string' },
        'workers-paid': { type: 'boolean' },
        yes: { type: 'boolean' },
        json: { type: 'boolean' },
        project: { type: 'string' },
        'smoke-token-env': { type: 'string' },
        'deadline-seconds': { type: 'string' },
        'no-rollback': { type: 'boolean' },
        credentials: { type: 'string' },
        'repository-map': { type: 'string' },
        baseline: { type: 'string' },
        mode: { type: 'string' },
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
  'cloudflare setup': [
    'providers',
    'local-auth',
    'prebuilt',
    'worker-name',
    'config',
    'out',
    'environment',
    'deployment-id',
    'inventory',
    'jurisdiction',
    'location-hint',
    'adopt-resource',
    'abandon-intent',
    'domain',
    'public-url',
    'routes',
    'rollout',
    'allow-contract',
    'secret',
    'secrets',
    'workers-paid',
    'org-slug',
    'org-name',
    'admin-email',
    'key-file',
    'master-key-env',
    'token-file',
    'non-interactive',
    'refresh-setup-token',
    'migrate',
    'yes',
    'json',
    'dry-run',
    'project',
    'smoke-token-env',
    'deadline-seconds',
  ],
  'cloudflare provision': [
    'prebuilt',
    'worker-name',
    'config',
    'environment',
    'deployment-id',
    'inventory',
    'out',
    'jurisdiction',
    'location-hint',
    'adopt-resource',
    'abandon-intent',
    'domain',
    'yes',
    'json',
    'dry-run',
  ],
  'cloudflare deploy': [
    'providers',
    'local-auth',
    'prebuilt',
    'worker-name',
    'config',
    'environment',
    'deployment-id',
    'inventory',
    'out',
    'jurisdiction',
    'rollout',
    'public-url',
    'routes',
    'domain',
    'secret',
    'secrets',
    'workers-paid',
    'allow-contract',
    'json',
    'dry-run',
  ],
  'cloudflare smoke': [
    'worker-name',
    'config',
    'environment',
    'deployment-id',
    'inventory',
    'out',
    'jurisdiction',
    'public-url',
    'project',
    'smoke-token-env',
    'deadline-seconds',
    'no-rollback',
    'json',
    'dry-run',
  ],
  'cloudflare migrate': [
    'prebuilt',
    'database-id',
    'out',
    'dry-run',
    'json',
    'worker-name',
    'config',
    'environment',
    'deployment-id',
    'inventory',
    'jurisdiction',
    'allow-contract',
  ],
  'cloudflare bootstrap': ['database-id', 'slug', 'name'],
  'cloudflare teardown': [
    'inventory',
    'inventory-id',
    'i-understand-this-deletes',
    'config',
    'project',
    'out',
    'json',
    'dry-run',
  ],
  'cloudflare janitor': [
    'repository-id',
    'inventory',
    'config',
    'project',
    'out',
    'json',
    'dry-run',
  ],
  'secrets generate-master-key': ['key-version'],
  'admin bootstrap': [
    'sign-in',
    'email',
    'group',
    'provider',
    'sqlite',
    'cloudflare',
    'database-id',
    'token-file',
  ],
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
  'import cutover-check': [
    'project-dir',
    'old-repository',
    'new-repository',
    'old-auth-env',
    'new-auth-env',
    'timeout-seconds',
    'lock',
    'json',
  ],
  'import satis plan': [
    'config',
    'out',
    'project',
    'credentials',
    'repository-map',
    'baseline',
    'mode',
  ],
  'import private-packagist plan': [
    'snapshot',
    'map',
    'out',
    'credentials-out',
    'members',
    'baseline',
    'mode',
    'include-org-admins',
    'runtime',
    'packagist',
    'compact-selection',
    'compact-vendor',
    'accept-project-widening',
    'quiet',
  ],
  'import private-packagist fetch': [
    'org',
    'snapshot',
    'api-key-file',
    'api-secret-file',
    'versions',
    'require-org-match',
  ],
  'import private-packagist dates': ['snapshot', 'map', 'baseline', 'out', 'package', 'quiet'],
  'import submit': ['manifest', 'receipt', 'principal', 'broker', 'resume', 'token-file'],
  'import status': ['broker', 'token-file', 'wait', 'wait-seconds'],
  'import credentials': ['broker', 'token-file', 'manifest', 'credentials'],
  'import verify': ['broker', 'token-file', 'wait', 'wait-seconds'],
  'import accept': ['broker', 'token-file', 'wait', 'wait-seconds'],
  'source accept-removal': ['url', 'source'],
  openapi: ['out'],
  version: [],
};

function acceptsInvocation(positionals: readonly string[], flags: readonly string[]): boolean {
  const isImportRun =
    positionals[0] === 'import' &&
    ['status', 'credentials', 'verify', 'accept'].includes(positionals[1] ?? '');
  if (isImportRun && positionals.length !== 3) return false;
  const allowed = ALLOWED_FLAGS[(isImportRun ? positionals.slice(0, 2) : positionals).join(' ')];
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
  const usageError = () => {
    const cloudflareIndex = argv.findIndex(
      (value, index) =>
        value === 'cloudflare' &&
        ['setup', 'provision', 'migrate', 'deploy', 'smoke', 'teardown', 'janitor'].includes(
          argv[index + 1] ?? '',
        ),
    );
    if (cloudflareIndex >= 0 && argv.includes('--json')) {
      console.log(
        JSON.stringify(
          failCommand(
            commandEnvelope(argv[cloudflareIndex + 1]!, argv.includes('--dry-run')),
            new CloudflareError('invalid_input', 2, false, argv[cloudflareIndex + 1]!),
          ).output,
        ),
      );
    } else console.error(USAGE);
    return 2;
  };
  if (parsed === null) return usageError();
  if (
    parsed.tokens.filter((token) => token.kind === 'option' && token.name === 'local-auth').length >
    1
  )
    return usageError();
  const { positionals, values } = parsed;
  if (!acceptsInvocation(positionals, Object.keys(values))) {
    return usageError();
  }
  const [command, subcommand] = positionals;
  if (values['local-auth'] !== undefined && !['enabled', 'disabled'].includes(values['local-auth']))
    return usageError();
  let providers: ProvidersOption = { kind: 'absent' };
  if (command === 'cloudflare' && (subcommand === 'deploy' || subcommand === 'setup')) {
    try {
      providers = await readProvidersOption(values.providers, undefined, subcommand);
    } catch (error) {
      const result = failCommand(commandEnvelope(subcommand, values['dry-run'] ?? false), error);
      if (values.json) console.log(JSON.stringify(result.output));
      else console.error(result.output.error?.message);
      return result.exitCode;
    }
  }

  if (command === 'cloudflare' && values.prebuilt) {
    try {
      await assertPrebuiltConfiguration(process.cwd(), values.config);
    } catch (error) {
      const result = failCommand(commandEnvelope(subcommand!, values['dry-run']), error);
      if (values.json) console.log(JSON.stringify(result.output));
      else console.error(result.output.error?.message);
      return result.exitCode;
    }
  }

  if (command === 'cloudflare' && (subcommand === 'teardown' || subcommand === 'janitor')) {
    const options = {
      env: process.env,
      ...(values.config === undefined ? {} : { configPath: values.config }),
      ...(values.project === undefined ? {} : { project: values.project }),
      ...(values.out === undefined ? {} : { outDir: values.out }),
      dryRun: values['dry-run'] ?? false,
      json: values.json ?? false,
    };
    if (subcommand === 'teardown') {
      if (!values.inventory) return usageError();
      return runCloudflareTeardown({
        ...options,
        inventory: values.inventory,
        ...(values['inventory-id'] === undefined ? {} : { inventoryId: values['inventory-id'] }),
        iUnderstandThisDeletes: values['i-understand-this-deletes'] ?? false,
      });
    }
    if (!values['repository-id']) return usageError();
    return runCloudflareJanitor({
      ...options,
      repositoryId: values['repository-id'],
      ...(values.inventory === undefined ? {} : { inventory: values.inventory }),
    });
  }

  if (command === 'source' && subcommand === 'accept-removal') {
    if (!values.url || !values.source) return usageError();
    return runSourceAcceptRemoval({
      url: values.url,
      source: values.source,
      env: process.env,
    });
  }

  if (command === 'openapi') return runOpenApi(values.out);

  if (
    command === 'import' &&
    ['submit', 'status', 'credentials', 'verify', 'accept'].includes(subcommand ?? '')
  ) {
    if (
      !values.broker ||
      (values.wait === true && values['wait-seconds'] !== undefined) ||
      (values['wait-seconds'] !== undefined &&
        !/^(?:0|[1-9][0-9]?|[12][0-9]{2}|300)$/.test(values['wait-seconds']))
    )
      return usageError();
    return runImport({
      command: subcommand as 'submit' | 'status' | 'credentials' | 'verify' | 'accept',
      broker: values.broker,
      env: process.env,
      ...(positionals[2] === undefined ? {} : { run: positionals[2] }),
      ...(values.manifest === undefined ? {} : { manifest: values.manifest }),
      ...(values.credentials === undefined ? {} : { credentials: values.credentials }),
      ...(values.receipt === undefined ? {} : { receipt: values.receipt }),
      ...(values.principal === undefined ? {} : { principal: values.principal }),
      ...(values.resume === undefined ? {} : { resume: values.resume }),
      ...(values['token-file'] === undefined ? {} : { tokenFile: values['token-file'] }),
      ...(values['wait-seconds'] === undefined
        ? values.wait
          ? { waitSeconds: 300 }
          : {}
        : { waitSeconds: Number(values['wait-seconds']) }),
    });
  }

  if (command === 'import' && subcommand === 'cutover-check') {
    if (
      !values['project-dir'] ||
      !values['old-repository'] ||
      !values['new-repository'] ||
      !values['old-auth-env'] ||
      !values['new-auth-env'] ||
      (values['timeout-seconds'] !== undefined && !/^\d+$/.test(values['timeout-seconds']))
    )
      return usageError();
    return runImportCutover({
      projectDir: values['project-dir'],
      oldRepository: values['old-repository'],
      newRepository: values['new-repository'],
      oldAuthEnv: values['old-auth-env'],
      newAuthEnv: values['new-auth-env'],
      historicLocks: values.lock ?? [],
      timeoutSeconds:
        values['timeout-seconds'] === undefined ? 1800 : Number(values['timeout-seconds']),
      json: values.json ?? false,
    });
  }

  if (command === 'import' && subcommand === 'private-packagist') {
    if (positionals[2] === 'dates') {
      if (!values.snapshot || !values.map || !values.baseline || !values.out) return usageError();
      return runImportPrivatePackagistDates({
        snapshot: values.snapshot,
        map: values.map,
        baseline: values.baseline,
        out: values.out,
        packages: values.package ?? [],
        quiet: values.quiet ?? false,
      });
    }
    if (positionals[2] === 'plan') {
      if (
        !values.snapshot ||
        !values.map ||
        !values.out ||
        !values['credentials-out'] ||
        (values.mode !== undefined && values.mode !== 'merge' && values.mode !== 'override') ||
        (values.runtime !== undefined && values.runtime !== 'workers' && values.runtime !== 'node')
      )
        return usageError();
      return runImportPrivatePackagistPlan({
        snapshot: values.snapshot,
        map: values.map,
        out: values.out,
        credentialsOut: values['credentials-out'],
        ...(values.members === undefined ? {} : { members: values.members }),
        ...(values.baseline === undefined ? {} : { baseline: values.baseline }),
        ...(values.mode === undefined ? {} : { mode: values.mode }),
        ...(values.runtime === undefined ? {} : { runtime: values.runtime }),
        ...(values.packagist === undefined ? {} : { packagist: values.packagist }),
        includeOrgAdmins: values['include-org-admins'] ?? false,
        compactSelection: values['compact-selection'] ?? false,
        compactVendors: values['compact-vendor'] ?? [],
        acceptProjectWidening: values['accept-project-widening'] ?? [],
        quiet: values.quiet ?? false,
      });
    }
    if (!values.org || !values.snapshot) return usageError();
    return runImportPrivatePackagistFetch({
      org: values.org,
      snapshot: values.snapshot,
      env: process.env,
      ...(values['api-key-file'] === undefined ? {} : { apiKeyFile: values['api-key-file'] }),
      ...(values['api-secret-file'] === undefined
        ? {}
        : { apiSecretFile: values['api-secret-file'] }),
      versions: values.versions ?? false,
      requireOrgMatch: values['require-org-match'] ?? false,
    });
  }

  if (command === 'import' && subcommand === 'satis') {
    const { config, out, mode } = values;
    if (
      config === undefined ||
      out === undefined ||
      (mode !== undefined && mode !== 'merge' && mode !== 'override')
    ) {
      return usageError();
    }
    return runImportSatisPlan({
      config,
      out,
      ...(values.project === undefined ? {} : { project: values.project }),
      ...(values.credentials === undefined ? {} : { credentials: values.credentials }),
      ...(values['repository-map'] === undefined
        ? {}
        : { repositoryMap: values['repository-map'] }),
      ...(values.baseline === undefined ? {} : { baseline: values.baseline }),
      ...(mode === undefined ? {} : { mode }),
    });
  }

  if (command === 'cloudflare' && subcommand === 'setup') {
    if (
      (values.migrate !== undefined && !['true', 'false'].includes(values.migrate)) ||
      (values.jurisdiction !== undefined && !['eu', 'default'].includes(values.jurisdiction))
    )
      return usageError();
    return runCloudflareSetup({
      providers,
      ...(values['local-auth'] === undefined
        ? {}
        : { localAuth: values['local-auth'] as 'enabled' | 'disabled' }),
      ...(values['workers-paid'] === undefined ? {} : { workersPaid: values['workers-paid'] }),
      prebuilt: values.prebuilt ?? false,
      workerName: values['worker-name'] ?? '',
      env: process.env,
      ...(values.config === undefined ? {} : { configPath: values.config }),
      ...(values.out === undefined ? {} : { outDir: values.out }),
      ...(values.environment === undefined ? {} : { environment: values.environment }),
      ...(values['deployment-id'] === undefined ? {} : { deploymentId: values['deployment-id'] }),
      ...(values.inventory === undefined ? {} : { inventory: values.inventory }),
      ...(values.jurisdiction === undefined
        ? {}
        : { jurisdiction: values.jurisdiction as 'eu' | 'default' }),
      ...(values['location-hint'] === undefined ? {} : { locationHint: values['location-hint'] }),
      ...(values['adopt-resource'] === undefined
        ? {}
        : { adoptResource: values['adopt-resource'] }),
      ...(values['abandon-intent'] === undefined
        ? {}
        : { abandonIntent: values['abandon-intent'] }),
      ...(values.domain === undefined ? {} : { domain: values.domain }),
      ...(values['public-url'] === undefined ? {} : { publicUrl: values['public-url'] }),
      ...(values.routes === undefined ? {} : { routes: values.routes }),
      ...(values.rollout === undefined ? {} : { rollout: Number(values.rollout) }),
      ...(values['allow-contract'] === undefined
        ? {}
        : { allowContract: values['allow-contract'] }),
      ...(values.secret === undefined ? {} : { secret: values.secret }),
      ...(values.secrets === undefined ? {} : { secrets: values.secrets }),
      ...(values['org-slug'] === undefined ? {} : { orgSlug: values['org-slug'] }),
      ...(values['org-name'] === undefined ? {} : { orgName: values['org-name'] }),
      ...(values['admin-email'] === undefined ? {} : { adminEmail: values['admin-email'] }),
      ...(values['key-file'] === undefined ? {} : { keyFile: values['key-file'] }),
      ...(values['master-key-env'] === undefined ? {} : { masterKeyEnv: values['master-key-env'] }),
      ...(values['token-file'] === undefined ? {} : { tokenFile: values['token-file'] }),
      ...(values.project === undefined ? {} : { smokeProject: values.project }),
      ...(values['smoke-token-env'] === undefined
        ? {}
        : { smokeTokenEnv: values['smoke-token-env'] }),
      ...(values['deadline-seconds'] === undefined
        ? {}
        : { deadlineSeconds: Number(values['deadline-seconds']) }),
      migrate: values.migrate !== 'false',
      nonInteractive: values['non-interactive'] ?? false,
      refreshSetupToken: values['refresh-setup-token'] ?? false,
      yes: values.yes ?? false,
      json: values.json ?? false,
      dryRun: values['dry-run'] ?? false,
    });
  }

  if (command === 'cloudflare' && subcommand === 'smoke') {
    if (
      !values['worker-name'] ||
      (values.jurisdiction !== undefined && !['eu', 'default'].includes(values.jurisdiction)) ||
      (values['deadline-seconds'] !== undefined &&
        !/^(?:[1-9]|[1-9][0-9]|[12][0-9]{2}|300)$/.test(values['deadline-seconds']))
    )
      return usageError();
    return runCloudflareSmoke({
      workerName: values['worker-name'],
      env: process.env,
      ...(values.config === undefined ? {} : { configPath: values.config }),
      ...(values.out === undefined ? {} : { outDir: values.out }),
      ...(values.environment === undefined ? {} : { environment: values.environment }),
      ...(values['deployment-id'] === undefined ? {} : { deploymentId: values['deployment-id'] }),
      ...(values.inventory === undefined ? {} : { inventory: values.inventory }),
      ...(values.jurisdiction === undefined
        ? {}
        : { jurisdiction: values.jurisdiction as 'eu' | 'default' }),
      ...(values['public-url'] === undefined ? {} : { publicUrl: values['public-url'] }),
      ...(values.project === undefined ? {} : { project: values.project }),
      ...(values['smoke-token-env'] === undefined
        ? {}
        : { smokeTokenEnv: values['smoke-token-env'] }),
      ...(values['deadline-seconds'] === undefined
        ? {}
        : { deadlineSeconds: Number(values['deadline-seconds']) }),
      noRollback: values['no-rollback'] ?? false,
      json: values.json ?? false,
      dryRun: values['dry-run'] ?? false,
    });
  }

  if (command === 'cloudflare' && subcommand === 'deploy') {
    if (
      !values['worker-name'] ||
      (values.jurisdiction !== undefined && !['eu', 'default'].includes(values.jurisdiction)) ||
      (values.rollout !== undefined && !/^(?:[1-9]|[1-9][0-9]|100)$/.test(values.rollout))
    )
      return usageError();
    return runCloudflareDeploy({
      providers,
      ...(values['local-auth'] === undefined
        ? {}
        : { localAuth: values['local-auth'] as 'enabled' | 'disabled' }),
      ...(values['workers-paid'] === undefined ? {} : { workersPaid: values['workers-paid'] }),
      prebuilt: values.prebuilt ?? false,
      workerName: values['worker-name'],
      env: process.env,
      ...(values.config === undefined ? {} : { configPath: values.config }),
      ...(values.out === undefined ? {} : { outDir: values.out }),
      ...(values.environment === undefined ? {} : { environment: values.environment }),
      ...(values['deployment-id'] === undefined ? {} : { deploymentId: values['deployment-id'] }),
      ...(values.inventory === undefined ? {} : { inventory: values.inventory }),
      ...(values.jurisdiction === undefined
        ? {}
        : { jurisdiction: values.jurisdiction as 'eu' | 'default' }),
      ...(values.rollout === undefined ? {} : { rollout: Number(values.rollout) }),
      ...(values['public-url'] === undefined ? {} : { publicUrl: values['public-url'] }),
      ...(values.domain === undefined ? {} : { domain: values.domain }),
      ...(values.routes === undefined ? {} : { routes: values.routes }),
      ...(values.secret === undefined ? {} : { secret: values.secret }),
      ...(values.secrets === undefined ? {} : { secrets: values.secrets }),
      ...(values['allow-contract'] === undefined
        ? {}
        : { allowContract: values['allow-contract'] }),
      json: values.json ?? false,
      dryRun: values['dry-run'] ?? false,
    });
  }

  if (command === 'cloudflare' && subcommand === 'provision') {
    if (
      !values['worker-name'] ||
      (values.jurisdiction !== undefined && !['eu', 'default'].includes(values.jurisdiction))
    )
      return usageError();
    return runCloudflareProvision({
      prebuilt: values.prebuilt ?? false,
      workerName: values['worker-name'],
      env: process.env,
      ...(values.config === undefined ? {} : { configPath: values.config }),
      ...(values.out === undefined ? {} : { outDir: values.out }),
      ...(values.environment === undefined ? {} : { environment: values.environment }),
      ...(values['deployment-id'] === undefined ? {} : { deploymentId: values['deployment-id'] }),
      ...(values.inventory === undefined ? {} : { inventory: values.inventory }),
      ...(values.jurisdiction === undefined
        ? {}
        : { jurisdiction: values.jurisdiction as 'eu' | 'default' }),
      ...(values['location-hint'] === undefined ? {} : { locationHint: values['location-hint'] }),
      ...(values['adopt-resource'] === undefined
        ? {}
        : { adoptResource: values['adopt-resource'] }),
      ...(values['abandon-intent'] === undefined
        ? {}
        : { abandonIntent: values['abandon-intent'] }),
      ...(values.domain === undefined ? {} : { domain: values.domain }),
      yes: values.yes ?? false,
      json: values.json ?? false,
      dryRun: values['dry-run'] ?? false,
    });
  }

  if (command === 'cloudflare') {
    if (subcommand === 'migrate' && (values['database-id'] || values['worker-name'])) {
      if (values.jurisdiction !== undefined && !['eu', 'default'].includes(values.jurisdiction))
        return usageError();
      return runCloudflareMigrate({
        prebuilt: values.prebuilt ?? false,
        ...(values['database-id'] === undefined ? {} : { databaseId: values['database-id'] }),
        ...(values['worker-name'] === undefined ? {} : { workerName: values['worker-name'] }),
        ...(values.config === undefined ? {} : { configPath: values.config }),
        ...(values.environment === undefined ? {} : { environment: values.environment }),
        ...(values['deployment-id'] === undefined ? {} : { deploymentId: values['deployment-id'] }),
        ...(values.inventory === undefined ? {} : { inventory: values.inventory }),
        ...(values.jurisdiction === undefined
          ? {}
          : { jurisdiction: values.jurisdiction as 'eu' | 'default' }),
        ...(values['allow-contract'] === undefined
          ? {}
          : { allowContract: values['allow-contract'] }),
        json: values.json ?? false,
        outDir: values.out || (values.prebuilt ? '.pb/prebuilt/cloudflare' : '.pb/cloudflare'),
        dryRun: values['dry-run'] ?? false,
        env: process.env,
      });
    }
    if (subcommand === 'bootstrap' && values['database-id'] && values.slug && values.name) {
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
    if ((values.email !== undefined || values.group !== undefined) && target !== null) {
      const options = {
        email: values.email,
        group: values.group,
        provider: values.provider,
        signIn: values['sign-in'],
        target,
        tokenFile: values['token-file'],
      };
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
    let result: Awaited<ReturnType<typeof build>>;
    try {
      result = await build({
        configPath: values.config ?? 'broker.config.ts',
        ...(target === undefined ? {} : { target: target as Platform }),
        ...(values.out === undefined ? {} : { outDir: values.out }),
      });
    } catch (error) {
      if (!(error instanceof BuildDiagnosticsError)) throw error;
      for (const problem of error.problems) {
        console.error(`error: ${problem}`.replace(/[\r\n]+/g, ' '));
      }
      return 2;
    }
    console.log(`manifest: ${result.manifestJson}`);
    console.log(`bundle: ${result.bundle}`);
    return 0;
  }

  return usageError();
}
