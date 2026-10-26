import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { ORG_SLUG_PATTERN } from '@package-broker/core/db/organization';
import { normalizeEmail } from '@package-broker/core/identity/policy';
import { createOtlpExporter } from '@package-broker/core/platform/otlp';
import {
  formatMasterKey,
  generateMasterKey,
  parseMasterKey,
} from '@package-broker/core/secrets/master-key';
import {
  assertPrebuiltConfiguration,
  materializePrebuilt,
  prebuiltEnvelope,
  removePrebuilt,
} from '../../prebuilt.js';
import { bootstrapAdmin } from '../admin.js';
import { bootstrapCloudflare, migrateCloudflare } from '../cloudflare.js';
import {
  CloudflareApi,
  CloudflareError,
  cloudflareCredentials,
  commandEnvelope,
  failCommand,
  type CommandResult,
} from './api.js';
import {
  active,
  cloudflareDeployContract,
  deploy,
  deploymentDomain,
  workersDevOrigin,
  validateDeploymentArtifact,
  type DeployOptions,
} from './deploy.js';
import {
  InventoryStore,
  InventoryTransaction,
  installIdentity,
  type Inventory,
} from './inventory.js';
import { provision, type ProvisionOptions } from './provision.js';
import { smoke, type SmokeOptions } from './smoke.js';

type Env = Readonly<Record<string, string | undefined>>;

export interface SetupOptions extends Omit<ProvisionOptions, 'contract' | 'transaction'> {
  orgSlug?: string;
  orgName?: string;
  adminEmail?: string;
  keyFile?: string;
  masterKeyEnv?: string;
  tokenFile?: string;
  nonInteractive?: boolean;
  refreshSetupToken?: boolean;
  publicUrl?: string;
  routes?: string;
  rollout?: number;
  allowContract?: readonly string[];
  secret?: readonly string[];
  secrets?: string;
  smokeProject?: string;
  smokeTokenEnv?: string;
  deadlineSeconds?: number;
  migrate?: boolean;
  tty?: boolean;
  reveal?: (secret: string) => Promise<void>;
  hiddenPrompt?: (message: string) => Promise<string>;
}

export interface SetupOperations {
  materializePrebuilt?: typeof materializePrebuilt;
  build: typeof buildSetupArtifact;
  validateArtifact: typeof validateDeploymentArtifact;
  provision: typeof provision;
  migrate: typeof migrateCloudflare;
  organization: typeof bootstrapCloudflare;
  deploy: typeof deploy;
  smoke: typeof smoke;
  admin: typeof bootstrapAdmin;
}

// No inherited extension, provider, runtime or arbitrary configuration input crosses this boundary.
export function setupBuildEnvironment(env: Env): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const name of [
    'PATH',
    'HOME',
    'USERPROFILE',
    'TMPDIR',
    'TMP',
    'TEMP',
    'SystemRoot',
    'WINDIR',
    'LANG',
    'LC_ALL',
    'TZ',
    'SOURCE_DATE_EPOCH',
  ]) {
    if (env[name] !== undefined) clean[name] = env[name];
  }
  return clean;
}

export async function buildSetupArtifact(
  configPath: string,
  outDir: string,
  env: Env,
): Promise<void> {
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        'const { build } = await import(process.argv[1]); await build({ configPath: process.argv[2], outDir: process.argv[3], target: "cloudflare" });',
        new URL('../../build.js', import.meta.url).href,
        configPath,
        outDir,
      ],
      { env: setupBuildEnvironment(env), maxBuffer: 1024 * 1024 },
    );
  } catch {
    throw new CloudflareError('invalid_input', 2, false, 'build');
  }
}

const invalid = (): never => {
  throw new CloudflareError('invalid_input', 2, false, 'validate');
};
const unsafe = (): never => {
  throw new CloudflareError('unsafe_path', 2, false, 'validate');
};
const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

async function stat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return null;
    throw error;
  }
}

async function safeDeliveryPath(
  path: string,
  roots: readonly string[],
  recovery: boolean,
  required = recovery,
): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  let parent = current;
  for (const part of relative(current, absolute).split(sep)) {
    current = resolve(current, part);
    const entry = await stat(current);
    if (entry?.isSymbolicLink() || (entry && current !== absolute && !entry.isDirectory()))
      unsafe();
    if (current !== absolute) {
      if (!entry && (!recovery || required)) {
        if (required) throw new CloudflareError('key_recovery_required', 2, false, 'key_delivery');
        unsafe();
      }
      if (entry) parent = current;
    }
  }
  parent = await realpath(parent);
  if (roots.some((root) => inside(root, absolute))) unsafe();
  try {
    await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd: parent });
    try {
      await promisify(execFile)('git', ['check-ignore', '--quiet', absolute], { cwd: parent });
    } catch {
      return unsafe();
    }
  } catch (error) {
    if (error instanceof CloudflareError) throw error;
    if ((error as { code?: unknown }).code !== 128) return unsafe();
  }
  const entry = await stat(absolute);
  if (
    entry &&
    (!recovery ||
      !entry.isFile() ||
      entry.nlink !== 1 ||
      (entry.mode & 0o077) !== 0 ||
      entry.uid !== process.getuid?.())
  )
    unsafe();
  if (required && !entry)
    throw new CloudflareError('key_recovery_required', 2, false, 'key_delivery');
}

async function readSavedKey(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const entry = await file.stat();
    if (
      !entry.isFile() ||
      entry.nlink !== 1 ||
      entry.size > 1024 ||
      (entry.mode & 0o077) !== 0 ||
      entry.uid !== process.getuid?.()
    )
      unsafe();
    return (await file.readFile('utf8')).trim();
  } finally {
    await file.close();
  }
}

async function writeKey(path: string, key: string): Promise<void> {
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${key}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
  const directory = await open(dirname(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

async function prompt(message: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await reader.question(message);
  } finally {
    reader.close();
  }
}
async function reveal(secret: string): Promise<void> {
  const terminal = await open('/dev/tty', 'w');
  try {
    await terminal.writeFile(`${secret}\n`);
  } finally {
    await terminal.close();
  }
}
async function hiddenPrompt(message: string): Promise<string> {
  process.stderr.write(message);
  const input = process.stdin;
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  return new Promise((accept, reject) => {
    let value = '';
    const finish = (cancel: boolean) => {
      input.off('data', onData);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write('\n');
      if (cancel) reject(new CloudflareError('confirmation_declined', 2, false, 'key_delivery'));
      else accept(value);
      value = '';
    };
    const onData = (data: Buffer) => {
      for (const char of data.toString('utf8')) {
        if (char === '\u0003' || char === '\u0004') return finish(true);
        if (char === '\r' || char === '\n') return finish(false);
        if (char === '\u007f') value = value.slice(0, -1);
        else if (value.length < 128) value += char;
      }
    };
    input.on('data', onData);
  });
}

function validateRemoteInputs(o: SetupOptions): void {
  if ([o.keyFile, o.tokenFile, o.masterKeyEnv].some((value) => value !== undefined && value === ''))
    invalid();
  if (
    o.domain !== undefined &&
    (o.domain.length > 253 ||
      !o.domain.split('.').every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)) ||
      !o.domain.includes('.'))
  )
    invalid();
  if (o.publicUrl !== undefined) {
    let url: URL;
    try {
      url = new URL(o.publicUrl);
    } catch {
      return invalid();
    }
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.port ||
      url.pathname !== '/' ||
      !url.hostname.includes('.') ||
      (o.domain && url.hostname !== o.domain)
    )
      invalid();
  }
  if (o.routes !== undefined) {
    if (!o.publicUrl) return invalid();
    const lines = o.routes.split('\n');
    if (new Set(lines).size !== lines.length) invalid();
    for (const line of lines) {
      const match = /^[a-f0-9]{32}:([a-zA-Z0-9*./:-]{1,256})$/.exec(line);
      if (
        !match ||
        match[1]!.replace(/^https:\/\//, '').split('/')[0] !== new URL(o.publicUrl).hostname
      )
        invalid();
    }
  }
  if (o.rollout !== undefined && (!Number.isInteger(o.rollout) || o.rollout < 1 || o.rollout > 100))
    invalid();
  if (
    o.deadlineSeconds !== undefined &&
    (!Number.isInteger(o.deadlineSeconds) || o.deadlineSeconds < 1 || o.deadlineSeconds > 300)
  )
    invalid();
  const selectedSecrets = [...(o.secret ?? []), ...(o.secrets?.split('\n') ?? [])];
  if (new Set(selectedSecrets).size !== selectedSecrets.length) invalid();
  for (const name of [
    ...(o.secret ?? []),
    ...(o.secrets?.split('\n') ?? []),
    ...(o.masterKeyEnv === undefined ? [] : [o.masterKeyEnv]),
    ...(o.smokeTokenEnv === undefined ? [] : [o.smokeTokenEnv]),
  ]) {
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || name === 'PB_TOKEN_PEPPER') invalid();
  }
  if (
    o.smokeTokenEnv !== undefined &&
    (['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].includes(o.smokeTokenEnv) || !o.smokeProject)
  )
    invalid();
  if (
    o.smokeProject !== undefined &&
    (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(o.smokeProject) ||
      ['health', '_pb', 'auth', 'setup', 'callback', 'login', 'pb-smoke-unassigned'].includes(
        o.smokeProject,
      ))
  )
    invalid();
  if (o.keyFile !== undefined && o.masterKeyEnv !== undefined) invalid();
}

function validateSmokeToken(o: SetupOptions): void {
  const smokeName = o.smokeTokenEnv ?? 'PB_SMOKE_TOKEN';
  const smokeToken = o.env[smokeName];
  if (
    ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'].includes(smokeName) ||
    (o.smokeTokenEnv !== undefined && !smokeToken) ||
    (smokeToken &&
      (!o.smokeProject ||
        !/^[\x21-\x7e]+$/.test(smokeToken) ||
        smokeToken === o.env.CLOUDFLARE_API_TOKEN))
  )
    invalid();
}

function validateBindingCollisions(
  generatedNames: readonly string[],
  secretNames: readonly string[],
  endpointEnv: string | undefined,
): void {
  const plainNames = [...generatedNames, ...(endpointEnv ? [endpointEnv] : [])];
  if (
    new Set(plainNames).size !== plainNames.length ||
    secretNames.some((name) => plainNames.includes(name))
  )
    invalid();
}

function validateTelemetry(endpoint: string, rawHeaders?: string): void {
  try {
    const headers: unknown = rawHeaders ? JSON.parse(rawHeaders) : {};
    if (
      !headers ||
      typeof headers !== 'object' ||
      Array.isArray(headers) ||
      Object.values(headers).some((value) => typeof value !== 'string')
    )
      invalid();
    createOtlpExporter({ endpoint, headers: headers as Record<string, string> });
  } catch {
    invalid();
  }
}

export async function setup(
  o: SetupOptions,
  overrides: Partial<SetupOperations> = {},
): Promise<CommandResult> {
  const operations: SetupOperations = {
    build: buildSetupArtifact,
    validateArtifact: validateDeploymentArtifact,
    provision,
    migrate: migrateCloudflare,
    organization: bootstrapCloudflare,
    deploy,
    smoke,
    admin: bootstrapAdmin,
    ...overrides,
  };
  const output = commandEnvelope('setup', o.dryRun);
  const tty =
    !o.nonInteractive &&
    !o.json &&
    (o.tty ?? (process.stdin.isTTY === true && process.stderr.isTTY === true));
  const ask = o.prompt ?? prompt;
  const progress = o.progress ?? ((message: string) => console.error(message));
  let prebuiltOut: string | undefined;
  let transaction: InventoryTransaction | undefined;
  let stage = 'validate';
  let completed: CommandResult = { exitCode: 1, output };
  const merge = (result: CommandResult): CommandResult => {
    const plan = [...output.plan, ...result.output.plan];
    const checks = [...output.checks, ...result.output.checks];
    for (const [key, value] of Object.entries(result.output)) {
      if (
        !['command', 'dry_run', 'plan', 'checks'].includes(key) &&
        value !== null &&
        (key !== 'prebuilt' || value !== undefined) &&
        (!Array.isArray(value) || value.length)
      )
        Object.assign(output, { [key]: value });
    }
    output.plan = plan;
    output.checks = checks;
    return (completed = { exitCode: result.exitCode, output });
  };
  try {
    if (o.prebuilt) await assertPrebuiltConfiguration(resolve(o.project ?? '.'), o.configPath);
    const guided = tty && (!o.workerName || !o.orgSlug || !o.orgName || !o.adminEmail);
    const values = {
      workerName: o.workerName,
      orgSlug: o.orgSlug,
      orgName: o.orgName,
      adminEmail: o.adminEmail,
    };
    for (const name of ['workerName', 'orgSlug', 'orgName', 'adminEmail'] as const) {
      if (!values[name] && tty) values[name] = await ask(`${name}: `);
      if (!values[name]) invalid();
    }
    if (guided) {
      o = { ...o };
      o.environment ??= (await ask('Environment [production]: ')) || 'production';
      o.deploymentId ??=
        (await ask('Deployment ID [worker-environment]: ')) ||
        `${values.workerName}-${o.environment}`;
      if (!o.jurisdiction) {
        const answer = (await ask('Jurisdiction [eu/default; default eu]: ')) || 'eu';
        if (answer !== 'eu' && answer !== 'default') return invalid();
        o.jurisdiction = answer;
      }
      if (o.locationHint === undefined) {
        const answer = await ask('Optional creation location hint [none]: ');
        if (answer) o.locationHint = answer;
      }
      if (!o.publicUrl && !o.domain) {
        const answer = await ask('Canonical HTTPS origin [workers.dev]: ');
        if (answer) o.publicUrl = answer;
        const domain = await ask('Optional custom domain [none]: ');
        if (domain) o.domain = domain;
      }
      if (!o.keyFile && !o.masterKeyEnv) {
        const answer =
          (await ask('Master key delivery [terminal/key-file/env; default terminal]: ')) ||
          'terminal';
        if (answer === 'key-file') o.keyFile = await ask('Key file outside the checkout: ');
        else if (answer === 'env')
          o.masterKeyEnv = await ask('Saved master key environment variable: ');
        else if (answer !== 'terminal') return invalid();
      }
    }
    const slug = values.orgSlug!,
      name = values.orgName!,
      email = values.adminEmail!;
    if (!ORG_SLUG_PATTERN.test(slug) || !name.trim() || normalizeEmail(email) === null) invalid();
    validateRemoteInputs(o);
    if (o.publicUrl !== undefined) o = { ...o, publicUrl: new URL(o.publicUrl).origin };
    const configPath = resolve(o.configPath ?? 'broker.config.ts');
    const project = await realpath(resolve(o.project ?? dirname(configPath)));
    let outDir = resolve(
      project,
      o.outDir ?? (o.prebuilt ? '.pb/prebuilt/cloudflare' : '.pb/cloudflare'),
    );
    const auth = cloudflareCredentials(o.env);
    const identity = installIdentity({ ...o, ...auth, workerName: values.workerName! });
    const store = await InventoryStore.create({
      project,
      outDir,
      identity,
      ...(o.inventory === undefined ? {} : { inventory: o.inventory }),
    });
    let journal = await store.read();
    const keyState = journal?.secret_delivery.master_key ?? 'not_started';
    const bootstrapState = journal?.bootstrap.state ?? 'not_started';
    const needsToken =
      bootstrapState === 'not_started' ||
      (o.refreshSetupToken && bootstrapState !== 'already_set_up');
    if (needsToken && !tty && !o.tokenFile) invalid();
    if (keyState === 'not_started' && !tty && !o.keyFile && !o.masterKeyEnv) invalid();
    const checkout = (
      await promisify(execFile)('git', ['rev-parse', '--show-toplevel'], { cwd: project })
    ).stdout.trim();
    const roots = [await realpath(checkout), project, outDir, store.stateRoot];
    if (o.keyFile) await safeDeliveryPath(o.keyFile, roots, keyState !== 'not_started', false);
    if (o.tokenFile) await safeDeliveryPath(o.tokenFile, roots, !needsToken, false);
    if (o.keyFile && o.tokenFile && resolve(o.keyFile) === resolve(o.tokenFile)) unsafe();
    stage = 'build';
    const buildEnv = setupBuildEnvironment(o.env);
    const selectedSecrets = [...(o.secret ?? []), ...(o.secrets?.split('\n') ?? [])];
    for (const selected of [...selectedSecrets, o.masterKeyEnv, o.smokeTokenEnv])
      if (selected) delete buildEnv[selected];
    if (o.prebuilt) {
      const materialized = await (operations.materializePrebuilt ?? materializePrebuilt)({
        project,
        outDir,
      });
      outDir = prebuiltOut = materialized.outDir;
      output.prebuilt = prebuiltEnvelope(materialized);
    } else await operations.build(configPath, outDir, buildEnv);
    validateSmokeToken(o);
    const artifact = await operations.validateArtifact(outDir);
    output.build_info = artifact.info ?? null;
    output.artifact_sha256 = artifact.artifactHash ?? null;
    const generatedNames = [
      'DB',
      'DEPLOYMENT_ID',
      'PB_PUBLIC_URL',
      'ASSETS',
      ...(artifact.ports
        ? [
            artifact.ports.blob.binding,
            artifact.ports.jobs.binding,
            artifact.ports.observability.analyticsBinding,
          ]
        : []),
    ].filter((name): name is string => name !== undefined);
    const endpointEnv = artifact.ports?.observability.endpointEnv;
    const headersEnv = artifact.ports?.observability.headersEnv;
    validateBindingCollisions(generatedNames, [...selectedSecrets, 'PB_MASTER_KEY'], endpointEnv);
    if (headersEnv && (headersEnv === 'PB_MASTER_KEY' || generatedNames.includes(headersEnv)))
      invalid();
    if (endpointEnv) {
      const endpoint = o.env[endpointEnv];
      if (!endpoint) return invalid();
      validateTelemetry(endpoint);
    }
    if (!o.dryRun) {
      transaction = await InventoryTransaction.begin(store, (o.now ?? Date.now)());
      if (JSON.stringify(await store.read()) !== JSON.stringify(journal))
        throw new CloudflareError('plan_changed', 8, false, 'validate');
    }
    const common = {
      ...o,
      workerName: values.workerName!,
      prebuilt: false,
      project,
      configPath,
      outDir,
      ...(transaction ? { transaction } : {}),
    };
    // The lock spans planning, key delivery, activation, smoke and admin issuance.
    const save = async (update: (journal: Inventory) => void) => {
      journal = await store.read();
      if (!journal) throw new CloudflareError('invalid_inventory', 2, false, stage);
      update(journal);
      journal.revision++;
      journal.updated_at = new Date((o.now ?? Date.now)()).toISOString();
      await store.write(journal);
    };
    stage = 'provision';
    const planned = await operations.provision({
      ...common,
      dryRun: true,
      progress: () => undefined,
    });
    if (planned.exitCode) return merge(planned);
    merge(planned);
    const api = new CloudflareApi({
      ...auth,
      ...(o.fetch ? { fetch: o.fetch } : {}),
      ...(o.now ? { now: o.now } : {}),
      ...(o.sleep ? { sleep: o.sleep } : {}),
    });
    const workers = await api.snapshot('/workers/scripts');
    const matches = workers.filter((w) => w.id === identity.script_name);
    if (matches.length > 1) throw new CloudflareError('ownership_conflict', 8, false, stage);
    const worker = matches[0];
    if (worker) {
      if (
        (!Array.isArray(worker.tags) ||
          !worker.tags.includes(`pb-owner-${identity.owner_digest}`) ||
          !worker.tags.includes('pb-install-v1')) &&
        !o.adoptResource?.includes(`worker:${identity.script_name}`)
      )
        throw new CloudflareError('ownership_conflict', 8, false, stage);
    } else
      output.plan.push({
        stage: 'deploy',
        action: 'create',
        kind: 'worker',
        name: identity.script_name,
      });
    const installedNames = worker
      ? (await api.snapshot(`/workers/scripts/${identity.script_name}/secrets`)).map((s) => {
          if (
            s.type !== 'secret_text' ||
            typeof s.name !== 'string' ||
            !/^[A-Z][A-Z0-9_]{0,127}$/.test(s.name) ||
            'text' in s ||
            'value' in s
          )
            throw new CloudflareError('configuration_conflict', 8, false, 'key_delivery');
          return s.name;
        })
      : [];
    if (
      new Set(installedNames).size !== installedNames.length ||
      installedNames.includes('PB_TOKEN_PEPPER')
    )
      throw new CloudflareError('configuration_conflict', 8, false, 'key_delivery');
    const installed = installedNames.includes('PB_MASTER_KEY');
    journal = await store.read();
    const pending = journal?.deployment?.attempt;
    const pendingNames =
      pending &&
      ['upload_pending', 'uploaded', 'configuring', 'activation_pending'].includes(pending.phase)
        ? pending.secret_names
        : [];
    const retainedNames = new Set([...installedNames, ...pendingNames]);
    validateBindingCollisions(generatedNames, [...retainedNames], endpointEnv);
    if ((o.rollout ?? 100) < 100) {
      if (!worker) invalid();
      const current = await active(api, `/workers/scripts/${identity.script_name}`);
      if (!current.versions.length) invalid();
      if (!cloudflareDeployContract.preview)
        throw new CloudflareError('capability_unknown', 1, false, 'deploy');
    }
    if (!o.publicUrl && !o.domain) await workersDevOrigin(api, identity.script_name);
    if (o.domain && !(await deploymentDomain(api, identity.script_name, o.domain))) {
      if (!cloudflareDeployContract.domainZone)
        throw new CloudflareError('capability_unknown', 1, false, 'deploy');
      const zone = await cloudflareDeployContract.domainZone(api, o.domain);
      if (!/^[a-f0-9]{32}$/.test(zone))
        throw new CloudflareError('capability_unknown', 1, false, 'deploy');
    }
    for (const name of [...selectedSecrets, ...(headersEnv ? [headersEnv] : [])]) {
      if (name !== 'PB_MASTER_KEY' && !retainedNames.has(name)) {
        if (!selectedSecrets.includes(name) || !o.env[name]) invalid();
      }
    }
    if (endpointEnv && headersEnv && !retainedNames.has(headersEnv))
      validateTelemetry(o.env[endpointEnv]!, o.env[headersEnv]);
    const reconcileKey =
      pending?.secret_names.includes('PB_MASTER_KEY') &&
      ['upload_pending', 'uploaded', 'configuring', 'activation_pending'].includes(pending.phase);
    if (!installed && !reconcileKey && keyState !== 'not_started' && !o.keyFile && !o.masterKeyEnv)
      throw new CloudflareError('key_recovery_required', 2, false, 'key_delivery');
    if (!installed && !reconcileKey && !tty && !o.keyFile && !o.masterKeyEnv) invalid();
    let recoveredKey: string | undefined;
    if (!installed && !reconcileKey) {
      if (o.masterKeyEnv) recoveredKey = o.env[o.masterKeyEnv];
      else if (keyState !== 'not_started' && o.keyFile) {
        await safeDeliveryPath(o.keyFile, roots, true);
        recoveredKey = await readSavedKey(o.keyFile);
      }
      if (o.masterKeyEnv || (keyState !== 'not_started' && o.keyFile)) {
        try {
          if (!recoveredKey) throw new Error();
          parseMasterKey(recoveredKey, 'PB_MASTER_KEY').bytes.fill(0);
        } catch {
          throw new CloudflareError('invalid_input', 2, false, 'key_delivery');
        }
      }
    }
    progress(JSON.stringify(output.plan));
    if (o.dryRun) {
      output.plan.push(
        ...['migrate', 'org_bootstrap', 'key_delivery', 'deploy', 'smoke', 'admin_bootstrap'].map(
          (stage) => ({ stage, action: 'plan' }),
        ),
      );
      output.status = 'planned';
      return (completed = { exitCode: 0, output });
    }
    if (output.plan.some((entry) => entry.action === 'create') && !o.yes) {
      if (!tty) throw new CloudflareError('confirmation_required', 2, false, 'provision');
      if ((await ask('Type yes to create these resources: ')) !== 'yes')
        throw new CloudflareError('confirmation_declined', 2, false, 'provision');
    }
    const provisioned = await operations.provision({
      ...common,
      yes: true,
      dryRun: false,
      progress: () => undefined,
    });
    if (provisioned.exitCode) return merge(provisioned);
    merge(provisioned);
    const databaseId = provisioned.output.database_id;
    if (!databaseId) return invalid();
    stage = 'migrate';
    const migrated = await operations.migrate({
      ...common,
      databaseId,
      outDir,
      dryRun: false,
      verifyOnly: o.migrate === false,
    });
    if (migrated.exitCode) return merge(migrated);
    merge(migrated);
    if (
      o.migrate === false &&
      (migrated.value === null || migrated.value.pending.length || migrated.value.unknown.length)
    )
      throw new CloudflareError('configuration_conflict', 11, false, stage);
    stage = 'org_bootstrap';
    const organization = await operations.organization({
      databaseId,
      slug,
      name,
      env: o.env,
      ...(o.fetch ? { fetch: o.fetch } : {}),
    });
    if (organization.exitCode) return merge(organization);
    stage = 'key_delivery';
    let key: string | undefined = recoveredKey;
    if (installed) {
      await save((j) => {
        j.secret_delivery.master_key = 'installed';
      });
      progress('Existing master key secret retained.');
    } else if (!reconcileKey) {
      if (!key) {
        if (keyState !== 'not_started')
          throw new CloudflareError('key_recovery_required', 2, false, stage);
        await save((j) => {
          j.secret_delivery.master_key = 'export_pending';
        });
        const generated = generateMasterKey(1);
        key = formatMasterKey(generated);
        generated.bytes.fill(0);
        if (o.keyFile) {
          await safeDeliveryPath(o.keyFile, roots, false);
          await writeKey(o.keyFile, key);
        } else {
          if (!tty) invalid();
          await (o.reveal ?? reveal)(key);
          progress('Store this key in a secret manager. It is revealed once.');
          if (
            (await (o.hiddenPrompt ?? hiddenPrompt)(
              'Re-enter the last 6 characters (hidden): ',
            )) !== key.slice(-6)
          )
            throw new CloudflareError('confirmation_declined', 2, false, stage);
        }
      }
      if (!key) return invalid();
      try {
        parseMasterKey(key, 'PB_MASTER_KEY').bytes.fill(0);
      } catch {
        return (completed = failCommand(
          output,
          new CloudflareError('invalid_input', 2, false, stage),
        ));
      }
      await save((j) => {
        j.secret_delivery.master_key = 'exported';
      });
      if (o.keyFile)
        progress(
          'Move the key to a secret manager, verify storage, then delete the local key file. Setup does not delete it.',
        );
      await save((j) => {
        j.secret_delivery.master_key = 'upload_pending';
      });
    }
    stage = 'deploy';
    const deployCommon = { ...common };
    delete deployCommon.secrets;
    const deployEnv: Record<string, string | undefined> = {
      CLOUDFLARE_API_TOKEN: auth.apiToken,
      CLOUDFLARE_ACCOUNT_ID: auth.accountId,
      PB_MASTER_KEY: key,
    };
    for (const name of selectedSecrets) {
      if (name !== 'PB_MASTER_KEY' && !retainedNames.has(name)) deployEnv[name] = o.env[name];
    }
    if (endpointEnv) deployEnv[endpointEnv] = o.env[endpointEnv];
    const deployOptions: DeployOptions = {
      contract: cloudflareDeployContract,
      ...deployCommon,
      env: deployEnv,
      secret: selectedSecrets
        .filter((s) => s !== 'PB_MASTER_KEY' && !retainedNames.has(s))
        .concat(key ? ['PB_MASTER_KEY'] : []),
    };
    const deployed = await operations.deploy(deployOptions);
    key = undefined;
    recoveredKey = undefined;
    deployEnv.PB_MASTER_KEY = undefined;
    if (deployed.exitCode) return merge(deployed);
    merge(deployed);
    await save((j) => {
      j.secret_delivery.master_key = 'installed';
    });
    stage = 'smoke';
    const smokeCommon = { ...common };
    delete (smokeCommon as { project?: string }).project;
    const smokeOptions: SmokeOptions = {
      ...smokeCommon,
      projectRoot: project,
      ...(o.smokeProject ? { project: o.smokeProject } : {}),
    };
    const smoked = await operations.smoke(smokeOptions);
    if (smoked.exitCode) return merge(smoked);
    merge(smoked);
    stage = 'admin_bootstrap';
    journal = await store.read();
    const state = journal?.bootstrap.state;
    if ((state === 'issuing' || state === 'unknown') && !o.refreshSetupToken)
      throw new CloudflareError('token_refresh_required', 7, false, stage);
    if (
      state === 'not_started' ||
      ((state === 'issued' || state === 'issuing' || state === 'unknown') && o.refreshSetupToken)
    ) {
      if (o.tokenFile) await safeDeliveryPath(o.tokenFile, roots, false);
      await save((j) => {
        j.bootstrap.state = 'issuing';
      });
      const result = await operations.admin(
        {
          email,
          target: {
            kind: 'cloudflare',
            databaseId,
            env: o.env,
            ...(o.fetch ? { fetch: o.fetch } : {}),
          },
          ...(o.tokenFile ? { tokenFile: o.tokenFile } : {}),
          stdoutIsTTY: tty,
        },
        {
          diagnostic: () => undefined,
          output: () => undefined,
          ...(!o.tokenFile ? { deliver: o.reveal ?? reveal } : {}),
        },
      );
      if (result.state === 'issued' || result.state === 'already_set_up') {
        await save((j) => {
          j.bootstrap = {
            state: result.state === 'issued' ? 'issued' : 'already_set_up',
            expires_at: result.expiresAt,
          };
        });
      } else {
        await save((j) => {
          j.bootstrap.state = 'unknown';
        });
        throw new CloudflareError(
          result.exitCode === 5
            ? 'organization_not_found'
            : result.exitCode === 7
              ? 'outcome_unknown'
              : 'provider_failure',
          result.exitCode || 1,
          false,
          stage,
        );
      }
    }
    if (!output.worker_url) throw new CloudflareError('configuration_conflict', 8, false, 'deploy');
    const url = new URL(output.worker_url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/'
    )
      throw new CloudflareError('configuration_conflict', 8, false, 'deploy');
    output.bootstrap_url = `${url.origin}/_pb/ui/setup`;
    journal = await store.read();
    if (journal?.bootstrap.expires_at)
      progress(
        `Setup token expires at ${journal.bootstrap.expires_at}. Use --refresh-setup-token explicitly if a new token is needed.`,
      );
    output.status = 'ok';
    progress(
      'Open bootstrap_url and paste the separately delivered setup token. Curl alternative: POST /_pb/auth/local/setup/start {"token"}, then POST /_pb/auth/local/setup/finish {"token","password","code"}; use the broker Origin and application/json. Keep credential request and response files private; never print the TOTP response. See docs/workers-install.md.',
    );
    return (completed = { exitCode: 0, output });
  } catch (error) {
    return (completed = failCommand(
      output,
      error instanceof CloudflareError
        ? error
        : new CloudflareError(
            stage === 'admin_bootstrap' ? 'outcome_unknown' : 'provider_failure',
            stage === 'admin_bootstrap' ? 7 : 1,
            false,
            stage,
          ),
    ));
  } finally {
    if (prebuiltOut) await removePrebuilt(prebuiltOut).catch(() => undefined);
    try {
      await transaction?.close();
    } catch {
      const failure = failCommand(output, new CloudflareError('install_locked', 4, false, stage));
      completed.exitCode = failure.exitCode;
    }
  }
}

export async function runCloudflareSetup(o: SetupOptions): Promise<number> {
  const result = await setup(o);
  if (o.json) console.log(JSON.stringify(result.output));
  else if (result.exitCode) console.error(result.output.error?.message);
  else console.log(JSON.stringify(result.output));
  return result.exitCode;
}
