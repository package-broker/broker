import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build as bundle } from 'esbuild';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import {
  formatMasterKey,
  generateMasterKey,
  parseMasterKey,
} from '@package-broker/core/secrets/master-key';
import { stageAssets } from '../../build-assets.js';
import { commandEnvelope, failCommand, CloudflareError } from './api.js';
import { cloudflareDeployContract, deploy, validateDeploymentArtifact } from './deploy.js';
import {
  emptyInventory,
  installIdentity,
  InventoryStore,
  InventoryTransaction,
  digest,
  type Inventory,
} from './inventory.js';
import { provision } from './provision.js';
import { setup, setupBuildEnvironment, type SetupOptions, type SetupOperations } from './setup.js';

const ACCOUNT = 'a'.repeat(32),
  DB = '44444444-4444-4444-8444-444444444444';
const identity = installIdentity({ accountId: ACCOUNT, workerName: 'broker' });
const KEY = formatMasterKey(generateMasterKey(1));
let project: string, outside: string, store: InventoryStore;
let calls: string[], options: SetupOptions, ops: SetupOperations;
let installed: boolean, exists: boolean;
let sentKey: string | undefined;
let buildFixture: string;
const result = (command: string) => ({ exitCode: 0, output: commandEnvelope(command) });
const journal = async () => (await store.read())!;
async function update(change: (j: Inventory) => void) {
  const j = (await store.read()) ?? emptyInventory(identity, Date.now());
  change(j);
  j.revision++;
  await store.write(j);
}

beforeAll(async () => {
  await mkdir(resolve('.pb'), { recursive: true });
  buildFixture = await mkdtemp(resolve('.pb/setup-build-'));
  const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
  await bundle({
    entryPoints: [join(sourceRoot, 'commands/cloudflare/setup.ts'), join(sourceRoot, 'build.ts')],
    outbase: sourceRoot,
    outdir: buildFixture,
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'workspace-sources',
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) => {
            const workspace = /^@package-broker\/([^/]+)(?:\/(.+))?$/.exec(args.path);
            if (workspace) {
              return {
                path: fileURLToPath(
                  new URL(
                    `../../../../${workspace[1]}/src/${workspace[2] ?? 'index'}.ts`,
                    import.meta.url,
                  ),
                ),
              };
            }
            return { path: createRequire(args.importer).resolve(args.path), external: true };
          });
        },
      },
    ],
  });
});
afterAll(async () => {
  await rm(buildFixture, { recursive: true, force: true });
});

beforeEach(async () => {
  await mkdir(resolve('.pb'), { recursive: true });
  project = await mkdtemp(resolve('.pb/setup-test-'));
  await promisify(execFile)('git', ['init', '--quiet', project]);
  await writeFile(join(project, '.gitignore'), '.pb/\n');
  outside = await mkdtemp(resolve('.pb/setup-delivery-'));
  store = await InventoryStore.create({
    project,
    outDir: join(project, '.pb/cloudflare'),
    identity,
  });
  calls = [];
  installed = false;
  exists = false;
  sentKey = undefined;
  options = {
    workerName: 'broker',
    project,
    configPath: join(project, 'broker.config.ts'),
    orgSlug: 'demo',
    orgName: 'Demo',
    adminEmail: 'admin@example.test',
    env: {
      CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
      CLOUDFLARE_API_TOKEN: 'API_SENTINEL',
      PB_MASTER_KEY: 'INHERITED_MASTER',
      RUNTIME_SENTINEL: 'HIDDEN',
      CUSTOM_SOURCE: KEY,
    },
    keyFile: join(outside, 'master.key'),
    tokenFile: join(outside, 'admin.token'),
    yes: true,
    nonInteractive: true,
    progress: vi.fn(),
    fetch: vi.fn(async (input) => {
      calls.push('read');
      const path = new URL(String(input)).pathname;
      const value = path.endsWith('/secrets')
        ? installed
          ? [{ name: 'PB_MASTER_KEY', type: 'secret_text' }]
          : []
        : exists
          ? [
              {
                id: identity.script_name,
                tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`],
              },
            ]
          : [];
      return new Response(
        JSON.stringify({
          success: true,
          result: value,
          result_info: { total_count: value.length },
        }),
      );
    }),
  };
  ops = {
    build: vi.fn(async (_config, _out, env) => {
      calls.push('build');
      expect(env).not.toHaveProperty('CLOUDFLARE_API_TOKEN');
      expect(env).not.toHaveProperty('PB_MASTER_KEY');
      expect(env).not.toHaveProperty('RUNTIME_SENTINEL');
      expect(env).not.toHaveProperty('CUSTOM_SOURCE');
    }),
    validateArtifact: vi.fn(async () => {
      calls.push('artifact');
      return {} as Awaited<ReturnType<SetupOperations['validateArtifact']>>;
    }),
    provision: vi.fn(async (o) => {
      calls.push(o.dryRun ? 'plan' : 'provision');
      const r = result('provision');
      r.output.database_id = DB;
      r.output.plan = [
        {
          stage: 'provision',
          action: exists ? 'reuse' : 'create',
          kind: 'd1',
          name: 'broker-production-db',
        },
      ];
      if (!o.dryRun) {
        o.transaction!.assertStore(store);
        await update((j) => {
          j.resources.d1 = {
            name: 'broker-production-db',
            id: DB,
            jurisdiction: 'eu',
            state: 'complete',
            evidence: {
              source: 'adopted',
              operation_id: null,
              verified_at: new Date().toISOString(),
            },
          };
        });
      }
      return r;
    }),
    migrate: vi.fn(async () => {
      calls.push('migrate');
      return {
        ...result('migrate'),
        value: { applied: [], skipped: [], unknown: [], pending: [] },
        diagnostics: [],
      };
    }),
    organization: vi.fn(async () => {
      calls.push('organization');
      return { ...result('bootstrap'), value: null, diagnostics: [] };
    }),
    deploy: vi.fn(async (o) => {
      calls.push('deploy');
      sentKey = o.env.PB_MASTER_KEY;
      if (!installed) {
        expect((await journal()).secret_delivery.master_key).toBe('upload_pending');
        expect(sentKey).toBeTruthy();
      }
      exists = true;
      installed = true;
      const r = result('deploy');
      r.output.worker_url = 'https://broker.example.test';
      r.output.version_id = 'release-1';
      r.output.plan.push({ stage: 'deploy', action: sentKey ? 'upload_activate' : 'unchanged' });
      return r;
    }),
    smoke: vi.fn(async (o) => {
      calls.push('smoke');
      expect(o.project).toBeUndefined();
      return result('smoke');
    }),
    admin: vi.fn(async () => {
      calls.push('admin');
      expect((await journal()).bootstrap.state).toBe('issuing');
      return { exitCode: 0, state: 'issued' as const, expiresAt: '2026-10-22T12:00:00.000Z' };
    }),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(project, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

it('orders typed operations, durably delivers a T159 key and prints only a credential-free URL', async () => {
  const r = await setup(options, ops);
  expect(r.exitCode).toBe(0);
  expect(vi.mocked(ops.deploy).mock.calls[0]![0].contract).toBe(cloudflareDeployContract);
  expect(calls.filter((c) => c !== 'read')).toEqual([
    'build',
    'artifact',
    'plan',
    'provision',
    'migrate',
    'organization',
    'deploy',
    'smoke',
    'admin',
  ]);
  const saved = (await readFile(options.keyFile!, 'utf8')).trim();
  parseMasterKey(saved, 'PB_MASTER_KEY');
  expect(saved).toBe(sentKey);
  expect((await stat(options.keyFile!)).mode & 0o777).toBe(0o600);
  expect((await journal()).secret_delivery.master_key).toBe('installed');
  expect((await journal()).bootstrap.state).toBe('issued');
  expect(r.output.bootstrap_url).toBe('https://broker.example.test/_pb/ui/setup');
  const publicText =
    JSON.stringify(r) +
    JSON.stringify(vi.mocked(options.progress!).mock.calls) +
    (await readFile(store.path, 'utf8'));
  for (const secret of [saved, 'admin@example.test', 'API_SENTINEL', 'INHERITED_MASTER'])
    expect(publicText).not.toContain(secret);
  expect(publicText).toContain('setup/start');
  expect(publicText).toContain('setup/finish');
  expect(publicText).toContain('delete the local key file');
});

it.each(['none', 'different', 'exact'])(
  'requires exact explicit Worker adoption before mutating provision: %s',
  async (adoption) => {
    const out = join(project, '.pb/cloudflare');
    await mkdir(join(out, 'generated'), { recursive: true });
    await writeFile(
      join(out, 'generated/manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        platform: 'cloudflare',
        platformPorts: null,
        bindings: [],
        plugins: [],
      }),
    );
    await writeFile(
      join(out, 'build-info.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: 'cloudflare',
        core: '2.0.0',
        plugins: {},
        lockfileSha256: null,
        gitSha: null,
      }),
    );
    const database = { uuid: DB, name: `${identity.script_name}-db`, jurisdiction: 'eu' };
    let time = Date.now();
    options.now = () => time;
    options.sleep = async (ms) => {
      time += ms;
    };
    options.adoptResource = [
      `d1:${DB}`,
      ...(adoption === 'none'
        ? []
        : [`worker:${adoption === 'exact' ? identity.script_name : 'different-worker'}`]),
    ];
    options.fetch = vi.fn(async (input) => {
      const path = new URL(String(input)).pathname.split(ACCOUNT)[1];
      const value =
        path === '/d1/database'
          ? [database]
          : path === `/d1/database/${DB}`
            ? database
            : path === '/workers/scripts'
              ? [{ id: identity.script_name, tags: [] }]
              : path === `/workers/scripts/${identity.script_name}/settings`
                ? { tags: [], bindings: [] }
                : path === '/workers/subdomain'
                  ? { subdomain: 'example' }
                  : [];
      return new Response(
        JSON.stringify({ success: true, result: value, result_info: { total_pages: 1 } }),
      );
    });
    ops.provision = vi.fn(provision);
    const outcome = await setup(options, ops);
    if (adoption === 'exact') {
      expect(outcome).toMatchObject({ exitCode: 0 });
      expect(ops.provision).toHaveBeenCalledTimes(2);
      expect(vi.mocked(ops.provision).mock.calls[1]![0]).toMatchObject({
        dryRun: false,
        adoptResource: [`d1:${DB}`, `worker:${identity.script_name}`],
      });
      expect((await journal()).resources.worker).toMatchObject({
        id: identity.script_name,
        state: 'complete',
        evidence: { source: 'adopted' },
      });
    } else {
      expect(outcome).toMatchObject({
        exitCode: 8,
        output: { error: { code: 'ownership_conflict' } },
      });
      expect(ops.provision).toHaveBeenCalledTimes(1);
      expect(ops.migrate).not.toHaveBeenCalled();
      expect(await store.read()).toBeNull();
    }
  },
);

it.each(['tokenFile', 'keyFile', 'orgSlug', 'orgName', 'adminEmail'] as const)(
  'rejects missing %s before build or network',
  async (field) => {
    delete options[field];
    expect(await setup(options, ops)).toMatchObject({
      exitCode: 2,
      output: { error: { stage: 'validate', code: 'invalid_input' } },
    });
    expect(calls).toEqual([]);
  },
);
it('requires token-file even for JSON with a TTY', async () => {
  delete options.tokenFile;
  options.json = true;
  options.tty = true;
  expect((await setup(options, ops)).exitCode).toBe(2);
  expect(calls).toEqual([]);
});
it.each(['keyFile', 'tokenFile'] as const)(
  'rejects existing/symlink/checkout %s without truncation or network',
  async (field) => {
    await writeFile(options[field]!, 'KEEP', { mode: 0o600 });
    expect((await setup(options, ops)).exitCode).toBe(2);
    expect(await readFile(options[field]!, 'utf8')).toBe('KEEP');
    await rm(options[field]!);
    await symlink(join(outside, 'absent'), options[field]!);
    expect((await setup(options, ops)).exitCode).toBe(2);
    options[field] = join(project, 'secret');
    expect((await setup(options, ops)).exitCode).toBe(2);
    expect(calls).toEqual([]);
  },
);
it('rejects symlink parents and paths within an external build directory', async () => {
  const linked = join(outside, 'linked');
  await symlink(project, linked);
  options.keyFile = join(linked, 'key');
  expect((await setup(options, ops)).exitCode).toBe(2);
  options.outDir = outside;
  options.keyFile = join(outside, 'key');
  expect((await setup(options, ops)).exitCode).toBe(2);
  expect(calls).toEqual([]);
});
it('requires create acknowledgement after read-only planning but before writes or generation', async () => {
  options.yes = false;
  const r = await setup(options, ops);
  expect(r).toMatchObject({
    exitCode: 2,
    output: { error: { code: 'confirmation_required', stage: 'provision' } },
  });
  expect(ops.provision).toHaveBeenCalledTimes(1);
  expect(ops.deploy).not.toHaveBeenCalled();
  expect(await store.read()).toBeNull();
  await expect(stat(options.keyFile!)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['no', 'YES', ' yes', ''])('requires literal yes on TTY (%j)', async (answer) => {
  options.yes = false;
  options.nonInteractive = false;
  options.tty = true;
  options.prompt = vi.fn(async () => answer);
  expect((await setup(options, ops)).output.error?.code).toBe('confirmation_declined');
  expect(ops.deploy).not.toHaveBeenCalled();
  expect(await store.read()).toBeNull();
});
it('accepts an injected TTY create prompt', async () => {
  options.yes = false;
  options.nonInteractive = false;
  options.tty = true;
  options.prompt = vi.fn(async () => 'yes');
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(options.prompt).toHaveBeenCalledTimes(1);
});
it('dry-run performs no generation, delivery, prompt, journal or mutable operation', async () => {
  options.dryRun = true;
  options.yes = false;
  options.prompt = vi.fn();
  options.reveal = vi.fn();
  expect(await setup(options, ops)).toMatchObject({ exitCode: 0, output: { status: 'planned' } });
  expect(ops.provision).toHaveBeenCalledTimes(1);
  expect(ops.migrate).not.toHaveBeenCalled();
  expect(options.prompt).not.toHaveBeenCalled();
  expect(options.reveal).not.toHaveBeenCalled();
  expect(await store.read()).toBeNull();
  await expect(stat(options.keyFile!)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('plans a first install with the real collection shapes and no KV permission', async () => {
  const fixtures = JSON.parse(
    await readFile(new URL('./fixtures/provider-responses.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
  const out = join(project, '.pb/cloudflare');
  await mkdir(join(out, 'generated'), { recursive: true });
  await writeFile(
    join(out, 'generated/manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      platform: 'cloudflare',
      platformPorts: {
        blob: { adapter: 'r2', binding: 'STORAGE', maxBytes: 1024 },
        cache: { adapter: 'cache-api', namespace: 'pb-metadata-v1' },
        jobs: { adapter: 'queues', binding: 'JOBS', maxRunning: 2 },
        observability: {
          adapter: 'workers',
          analyticsBinding: 'ANALYTICS',
          deploymentIdEnv: 'DEPLOYMENT_ID',
        },
      },
      bindings: [],
      plugins: [],
    }),
  );
  await writeFile(
    join(out, 'build-info.json'),
    JSON.stringify({
      schemaVersion: 1,
      target: 'cloudflare',
      core: '2.0.0',
      plugins: {},
      lockfileSha256: null,
      gitSha: null,
    }),
  );
  let time = Date.now();
  options.now = () => time;
  options.sleep = async (ms) => {
    time += ms;
  };
  options.dryRun = true;
  const reads: URL[] = [];
  options.fetch = vi.fn(async (input, init) => {
    const url = new URL(String(input));
    expect(url.pathname).toContain(`/accounts/${ACCOUNT}/`);
    const path = url.pathname.split(ACCOUNT)[1]!;
    reads.push(url);
    if (path === `/workers/scripts/${identity.script_name}/settings`)
      return new Response(JSON.stringify({ success: false, result: null, errors: [] }), {
        status: 404,
      });
    const bodies: Record<string, unknown> = {
      '/d1/database': fixtures.d1Empty,
      '/r2/buckets': fixtures.r2Empty,
      '/queues': fixtures.queuesEmpty,
      '/subscriptions': fixtures.forbidden,
      '/analytics_engine/sql': fixtures.analyticsTablesEmpty,
      '/workers/scripts': fixtures.workersEmpty,
      '/workers/subdomain': { success: true, result: { subdomain: 'example' } },
      '/storage/kv/namespaces': fixtures.forbidden,
    };
    if (path === '/analytics_engine/sql') {
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe('SHOW TABLES');
    } else expect(init?.method ?? 'GET').toBe('GET');
    expect(bodies).toHaveProperty(path);
    return new Response(JSON.stringify(bodies[path]), {
      status: ['/subscriptions', '/storage/kv/namespaces'].includes(path) ? 403 : 200,
    });
  });
  ops.provision = vi.fn(provision);
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 0,
    output: {
      status: 'planned',
      error: null,
      plan: expect.arrayContaining([
        expect.objectContaining({ action: 'create', kind: 'd1' }),
        expect.objectContaining({ action: 'create', kind: 'r2' }),
        expect.objectContaining({
          action: 'create',
          kind: 'queue',
          name: `${identity.script_name}-jobs`,
        }),
        expect.objectContaining({
          action: 'create',
          kind: 'queue',
          name: `${identity.script_name}-jobs-dlq`,
        }),
        expect.objectContaining({ action: 'create', kind: 'worker' }),
      ]),
      checks: expect.arrayContaining([
        { name: 'analytics_engine', status: 'supported', source: 'analytics_engine_sql' },
      ]),
    },
  });
  const scriptReads = reads.filter((url) => url.pathname.endsWith('/workers/scripts'));
  expect(scriptReads).toHaveLength(1);
  expect(scriptReads[0]!.search).toBe('');
  expect(reads.some((url) => url.pathname.includes('/storage/kv/'))).toBe(false);
  expect(await store.read()).toBeNull();
  expect(ops.deploy).not.toHaveBeenCalled();
});

it.each([undefined, null])(
  'reads installed secrets as a snapshot with metadata %s',
  async (result_info) => {
    options.dryRun = true;
    const reads: URL[] = [];
    options.fetch = vi.fn(async (input) => {
      const url = new URL(String(input));
      reads.push(url);
      return new Response(
        JSON.stringify({
          success: true,
          result: url.pathname.endsWith('/secrets')
            ? [{ name: 'PB_MASTER_KEY', type: 'secret_text' }]
            : [
                {
                  id: identity.script_name,
                  tags: ['pb-install-v1', `pb-owner-${identity.owner_digest}`],
                },
              ],
          result_info,
        }),
      );
    });
    expect((await setup(options, ops)).exitCode).toBe(0);
    expect(reads).toHaveLength(2);
    expect(reads.every((url) => url.search === '')).toBe(true);
    expect(reads[1]!.pathname).toBe(
      `/client/v4/accounts/${ACCOUNT}/workers/scripts/${identity.script_name}/secrets`,
    );
    expect(await store.read()).toBeNull();
  },
);

it('build failure stops before any network or secret side effect', async () => {
  ops.build = vi.fn(async () => {
    throw new CloudflareError('invalid_input', 2, false, 'build');
  });
  expect((await setup(options, ops)).output.error?.stage).toBe('build');
  expect(calls).toEqual([]);
  expect(await store.read()).toBeNull();
});
it.each([
  'permission_denied',
  'workers_paid_required',
  'queues_unavailable',
  'capability_unknown',
] as const)('preserves authoritative capability failure %s unchanged', async (code) => {
  ops.provision = vi.fn(async () =>
    failCommand(commandEnvelope('provision'), new CloudflareError(code, 2, false, 'provision')),
  );
  const r = await setup(options, ops);
  expect(r.output.error).toEqual({
    code,
    message: new CloudflareError(code).message,
    retryable: false,
    stage: 'provision',
  });
  expect(ops.migrate).not.toHaveBeenCalled();
  expect(ops.deploy).not.toHaveBeenCalled();
});
it.each(['migrate', 'organization', 'deploy', 'smoke'] as const)(
  'stops on the first %s failure',
  async (stage) => {
    Object.assign(ops, {
      [stage]: vi.fn(async () => ({
        ...failCommand(
          commandEnvelope(stage),
          new CloudflareError('provider_failure', 1, false, stage),
        ),
        value: null,
        diagnostics: [],
      })),
    });
    expect((await setup(options, ops)).exitCode).toBe(1);
    expect(ops.admin).not.toHaveBeenCalled();
  },
);
it('maps org slug mismatch at org_bootstrap exactly', async () => {
  ops.organization = vi.fn(async () => ({
    ...failCommand(
      commandEnvelope('bootstrap'),
      new CloudflareError('organization_slug_mismatch', 5, false, 'org_bootstrap'),
    ),
    value: null,
    diagnostics: [],
  }));
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 5,
    output: { error: { code: 'organization_slug_mismatch', stage: 'org_bootstrap' } },
  });
});
it.each([5, 7])('maps admin exit %i separately and conservatively', async (exitCode) => {
  ops.admin = vi.fn(async () => ({
    exitCode,
    state: exitCode === 7 ? ('unknown' as const) : ('error' as const),
    expiresAt: null,
  }));
  expect(await setup(options, ops)).toMatchObject({
    exitCode,
    output: {
      error: {
        code: exitCode === 5 ? 'organization_not_found' : 'outcome_unknown',
        stage: 'admin_bootstrap',
      },
    },
  });
  expect((await journal()).bootstrap.state).toBe('unknown');
});
it.each([9, 10, 11, 12])('preserves smoke exit %i', async (exitCode) => {
  ops.smoke = vi.fn(async () =>
    failCommand(
      commandEnvelope('smoke'),
      new CloudflareError('smoke_failed', exitCode, false, 'smoke'),
    ),
  );
  expect(await setup(options, ops)).toMatchObject({
    exitCode,
    output: { error: { stage: 'smoke' } },
  });
  expect(ops.admin).not.toHaveBeenCalled();
});

it('TTY reveals once and confirms the last six before export/upload', async () => {
  delete options.keyFile;
  options.nonInteractive = false;
  options.tty = true;
  let delivered = '';
  options.reveal = vi.fn(async (key) => {
    delivered = key;
    expect((await journal()).secret_delivery.master_key).toBe('export_pending');
  });
  options.hiddenPrompt = vi.fn(async () => {
    expect((await journal()).secret_delivery.master_key).toBe('export_pending');
    return delivered.slice(-6);
  });
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(options.reveal).toHaveBeenCalledTimes(1);
  expect(sentKey).toBe(delivered);
  expect(JSON.stringify(await journal())).not.toContain(delivered.slice(-6));
});
it.each(['mismatch', 'cancel'])('TTY %s never exports/uploads or regenerates', async (mode) => {
  delete options.keyFile;
  options.nonInteractive = false;
  options.tty = true;
  options.reveal = vi.fn(async () => undefined);
  options.hiddenPrompt = vi.fn(async () => {
    if (mode === 'cancel') throw new Error('suffix-sentinel');
    return 'wrong';
  });
  expect((await setup(options, ops)).exitCode).not.toBe(0);
  expect((await journal()).secret_delivery.master_key).toBe('export_pending');
  expect(ops.deploy).not.toHaveBeenCalled();
  expect((await setup(options, ops)).output.error?.code).toBe('key_recovery_required');
  expect(options.reveal).toHaveBeenCalledTimes(1);
});
it.each(['export_pending', 'exported', 'upload_pending', 'unknown'] as const)(
  'never regenerates after interrupted %s, including marker before generation',
  async (state) => {
    await update((j) => {
      j.secret_delivery.master_key = state;
    });
    delete options.keyFile;
    options.nonInteractive = false;
    options.tty = true;
    options.reveal = vi.fn();
    expect((await setup(options, ops)).output.error?.code).toBe('key_recovery_required');
    expect(options.reveal).not.toHaveBeenCalled();
    expect(ops.deploy).not.toHaveBeenCalled();
  },
);
it.each(['export_pending', 'exported', 'upload_pending', 'unknown', 'installed'] as const)(
  'recovers saved key for %s without replacement or re-export',
  async (state) => {
    await update((j) => {
      j.secret_delivery.master_key = state;
    });
    await writeFile(options.keyFile!, `${KEY}\n`, { mode: 0o600 });
    expect((await setup(options, ops)).exitCode).toBe(0);
    expect(sentKey).toBe(KEY);
    expect(await readFile(options.keyFile!, 'utf8')).toBe(`${KEY}\n`);
  },
);
it('rejects permissive saved keys before network', async () => {
  await update((j) => {
    j.secret_delivery.master_key = 'exported';
  });
  await writeFile(options.keyFile!, KEY);
  await chmod(options.keyFile!, 0o644);
  expect((await setup(options, ops)).exitCode).toBe(2);
  expect(calls).toEqual([]);
});
it('imports an explicit env source without revealing it', async () => {
  delete options.keyFile;
  options.masterKeyEnv = 'CUSTOM_SOURCE';
  options.reveal = vi.fn();
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(sentKey).toBe(KEY);
  expect(options.reveal).not.toHaveBeenCalled();
});
it.each(['export_pending', 'exported', 'upload_pending', 'unknown', 'installed'] as const)(
  'reconciles %s with a removed key file when the live master key is installed',
  async (state) => {
    installed = exists = true;
    await update((j) => {
      j.secret_delivery.master_key = state;
    });
    options.reveal = vi.fn();
    await expect(stat(options.keyFile!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await setup(options, ops)).exitCode).toBe(0);
    expect(options.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`/workers/scripts/${identity.script_name}/secrets`),
      expect.anything(),
    );
    expect(sentKey).toBeUndefined();
    expect(vi.mocked(ops.deploy).mock.calls[0]![0].secret).not.toContain('PB_MASTER_KEY');
    expect(options.reveal).not.toHaveBeenCalled();
    await expect(stat(options.keyFile!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await journal()).secret_delivery.master_key).toBe('installed');
  },
);
it('requires the missing saved key file only after live names confirm the key is absent', async () => {
  exists = true;
  await update((j) => {
    j.secret_delivery.master_key = 'exported';
  });
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 2,
    output: { error: { code: 'key_recovery_required', stage: 'key_delivery' } },
  });
  expect(options.fetch).toHaveBeenCalledWith(
    expect.stringContaining(`/workers/scripts/${identity.script_name}/secrets`),
    expect.anything(),
  );
  expect(ops.provision).toHaveBeenCalledTimes(1);
  expect(vi.mocked(ops.provision).mock.calls[0]![0].dryRun).toBe(true);
  expect(ops.migrate).not.toHaveBeenCalled();
  expect(ops.organization).not.toHaveBeenCalled();
  expect(ops.deploy).not.toHaveBeenCalled();
});
it('completed rerun retains installed names and skips key/token delivery and create prompts', async () => {
  expect((await setup(options, ops)).exitCode).toBe(0);
  delete options.keyFile;
  delete options.tokenFile;
  options.yes = false;
  options.prompt = vi.fn();
  vi.mocked(ops.admin).mockClear();
  vi.mocked(ops.deploy).mockClear();
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(sentKey).toBeUndefined();
  expect(ops.admin).not.toHaveBeenCalled();
  expect(options.prompt).not.toHaveBeenCalled();
  expect(vi.mocked(ops.deploy).mock.calls[0]![0].secret).not.toContain('PB_MASTER_KEY');
});
it('completed rerun accepts deleted delivery directories after checking live secret names', async () => {
  const keyDirectory = join(outside, 'keys');
  const tokenDirectory = join(outside, 'tokens');
  await mkdir(keyDirectory);
  await mkdir(tokenDirectory);
  options.keyFile = join(keyDirectory, 'master.key');
  options.tokenFile = join(tokenDirectory, 'admin.token');
  expect((await setup(options, ops)).exitCode).toBe(0);
  await rm(keyDirectory, { recursive: true });
  await rm(tokenDirectory, { recursive: true });
  vi.mocked(options.fetch!).mockClear();
  vi.mocked(ops.admin).mockClear();
  options.reveal = vi.fn();
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(options.fetch).toHaveBeenCalledWith(
    expect.stringContaining(`/workers/scripts/${identity.script_name}/secrets`),
    expect.anything(),
  );
  expect(sentKey).toBeUndefined();
  expect(ops.admin).not.toHaveBeenCalled();
  expect(options.reveal).not.toHaveBeenCalled();
  await expect(stat(keyDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(stat(tokenDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('requires missing key directories for saved-key recovery only after live names are checked', async () => {
  exists = true;
  await update((j) => {
    j.secret_delivery.master_key = 'exported';
  });
  options.keyFile = join(outside, 'deleted', 'master.key');
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 2,
    output: { error: { code: 'key_recovery_required', stage: 'key_delivery' } },
  });
  expect(options.fetch).toHaveBeenCalledWith(
    expect.stringContaining(`/workers/scripts/${identity.script_name}/secrets`),
    expect.anything(),
  );
  expect(calls).not.toContain('provision');
});
it('refuses a missing new key-delivery directory before provisioning', async () => {
  options.keyFile = join(outside, 'absent', 'master.key');
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 2,
    output: { error: { code: 'unsafe_path' } },
  });
  expect(calls).not.toContain('provision');
  expect(options.fetch).not.toHaveBeenCalled();
  expect(await store.read()).toBeNull();
});
it('an identical completed rerun retains selected non-master secrets without resubmitting values', async () => {
  vi.mocked(ops.validateArtifact).mockResolvedValue({
    ports: {
      blob: { binding: 'STORAGE' },
      jobs: { binding: 'JOBS' },
      observability: { endpointEnv: 'OTEL_ENDPOINT', headersEnv: 'OTEL_HEADERS' },
    },
  } as Awaited<ReturnType<SetupOperations['validateArtifact']>>);
  options.secret = ['IDP_SECRET'];
  options.secrets = 'OTEL_HEADERS';
  options.env = {
    ...options.env,
    IDP_SECRET: 'IDP_SENTINEL',
    OTEL_ENDPOINT: 'https://collector.example.test',
    OTEL_HEADERS: '{"key":"value"}',
  };
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(vi.mocked(ops.deploy).mock.calls[0]![0]).toMatchObject({
    secret: ['IDP_SECRET', 'OTEL_HEADERS', 'PB_MASTER_KEY'],
    env: { IDP_SECRET: 'IDP_SENTINEL', OTEL_HEADERS: '{"key":"value"}' },
  });
  const fetch = options.fetch!;
  options.fetch = vi.fn(async (input, init) =>
    new URL(String(input)).pathname.endsWith('/secrets')
      ? new Response(
          JSON.stringify({
            success: true,
            result: ['PB_MASTER_KEY', 'IDP_SECRET', 'OTEL_HEADERS'].map((name) => ({
              name,
              type: 'secret_text',
            })),
            result_info: { total_count: 3 },
          }),
        )
      : fetch(input, init),
  );
  for (const name of ['IDP_SECRET', 'OTEL_HEADERS'])
    Object.defineProperty(options.env, name, {
      get: () => {
        throw new Error('retained secret must not be loaded');
      },
    });
  vi.mocked(ops.deploy).mockClear();
  expect((await setup(options, ops)).exitCode).toBe(0);
  const deployed = vi.mocked(ops.deploy).mock.calls[0]![0];
  expect(deployed.secret).toEqual([]);
  expect(deployed.env).not.toHaveProperty('IDP_SECRET');
  expect(deployed.env).not.toHaveProperty('OTEL_HEADERS');
  expect(deployed).not.toHaveProperty('secrets');
});

it.each(['completed', 'upload_pending'])(
  'reuses the real deployment version on an identical %s rerun with selected secrets',
  async (checkpoint) => {
    const out = join(project, '.pb/cloudflare');
    await mkdir(join(out, 'generated'), { recursive: true });
    await mkdir(join(out, 'migrations/core'), { recursive: true });
    await writeFile(join(out, 'migrations/core/0001_init.sql'), '-- fixture migration\n');
    await writeFile(join(out, 'worker.js'), 'export default { fetch() {} };');
    await writeFile(
      join(out, 'generated/manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        platform: 'cloudflare',
        platformPorts: null,
        plugins: [],
        bindings: [],
        migrations: [
          {
            id: 'core:0001_init',
            name: '0001_init.sql',
            checksum: digest('-- fixture migration\n'),
            phase: 'expand',
          },
        ],
        routes: [],
      }),
    );
    await writeFile(
      join(out, 'build-info.json'),
      JSON.stringify({
        schemaVersion: 1,
        target: 'cloudflare',
        core: '2.0.0',
        plugins: {},
        lockfileSha256: null,
        gitSha: null,
      }),
    );
    const files = [
      {
        name: 'manifest.json',
        content: Buffer.from(
          JSON.stringify({
            version: 1,
            entry: 'index.html',
            files: { 'index.html': { bytes: 0, contentType: 'text/html' } },
          }),
        ),
      },
      { name: 'index.html', content: Buffer.alloc(0) },
    ];
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    await stageAssets(out, {
      files,
      record: {
        schemaVersion: 1,
        provider: { specifier: '@package-broker/ui-assets', version: '2.0.0' },
        digest: `sha256:${digest(JSON.stringify(files.map((f) => [f.name, sha(f.content)])))}`,
        descriptor: {
          directory: './assets',
          binding: 'ASSETS',
          run_worker_first: true,
          html_handling: 'none',
          not_found_handling: 'none',
        },
      },
    });
    const base = `/workers/scripts/${identity.script_name}`;
    const versionId = '22222222-2222-4222-8222-222222222222';
    const tags = ['pb-install-v1', `pb-owner-${identity.owner_digest}`];
    let uploads = 0;
    let active = false;
    let loseUpload = checkpoint === 'upload_pending';
    let candidate: Record<string, unknown> | undefined;
    let candidateBindings: Record<string, unknown>[] = [];
    let schedules: { cron: string }[] = [];
    let clock = Date.now();
    options.now = () => clock;
    options.sleep = async (ms) => {
      clock += ms;
    };
    const ok = (value: unknown) =>
      new Response(
        JSON.stringify({ success: true, result: value, result_info: { total_pages: 1 } }),
      );
    options.fetch = vi.fn(async (input, init) => {
      const path = new URL(String(input)).pathname.replace(`/client/v4/accounts/${ACCOUNT}`, '');
      const method = init?.method ?? 'GET';
      if (path === '/workers/scripts') return ok([{ id: identity.script_name, tags }]);
      if (path === `/d1/database/${DB}`)
        return ok({ uuid: DB, name: 'broker-production-db', jurisdiction: 'eu' });
      if (path === `${base}/settings`)
        return ok({
          tags,
          bindings: active ? candidateBindings : [{ type: 'd1', name: 'DB', id: DB }],
        });
      if (path === `${base}/secrets`)
        return ok(
          ['PB_MASTER_KEY', ...(active ? ['IDP_SECRET'] : [])].map((name) => ({
            name,
            type: 'secret_text',
          })),
        );
      if (path === '/workers/subdomain') return ok({ subdomain: 'account' });
      if (path === '/workers/domains') return ok([]);
      if (path === `${base}/subdomain`) return ok({ enabled: true, previews_enabled: false });
      if (path === `${base}/schedules`) {
        if (method !== 'GET') schedules = JSON.parse(String(init?.body));
        return ok({ schedules });
      }
      if (path === `${base}/assets-upload-session`) return ok({ jwt: 'ASSETS', buckets: [] });
      if (path === `${base}/versions` && method === 'POST') {
        uploads++;
        const metadata = JSON.parse(String((init!.body as FormData).get('metadata')));
        candidateBindings = [
          ...metadata.bindings.map((b: Record<string, unknown>) =>
            b.type === 'secret_text' ? { type: b.type, name: b.name } : b,
          ),
          { type: 'secret_text', name: 'PB_MASTER_KEY' },
        ];
        candidate = {
          id: versionId,
          annotations: metadata.annotations,
          resources: {
            bindings: candidateBindings,
            assets: { config: metadata.assets.config },
            script_runtime: {
              compatibility_date: '2026-10-01',
              compatibility_flags: ['nodejs_compat'],
            },
          },
        };
        if (loseUpload) {
          loseUpload = false;
          throw new Error('upload acknowledgement lost');
        }
        return ok({ id: versionId });
      }
      if (path === `${base}/versions`) return ok({ items: candidate ? [candidate] : [] });
      if (path === `${base}/versions/${versionId}`) return ok(candidate);
      if (path === `${base}/deployments`) {
        if (method !== 'GET') active = true;
        const deployment = {
          id: 'active-deployment',
          versions: [{ version_id: versionId, percentage: 100 }],
        };
        return ok(method === 'GET' ? { deployments: active ? [deployment] : [] } : deployment);
      }
      throw new Error(`Unexpected request ${method} ${path}`);
    });
    installed = exists = true;
    delete options.keyFile;
    options.masterKeyEnv = 'CUSTOM_SOURCE';
    options.secret = ['IDP_SECRET'];
    options.env = { ...options.env, IDP_SECRET: 'IDP_SENTINEL' };
    ops.validateArtifact = validateDeploymentArtifact;
    ops.deploy = vi.fn((o) =>
      deploy({
        ...o,
        contract: { versionsCreateScript: true, secretInheritance: true, assetHash: sha },
      }),
    );
    ops.smoke = vi.fn(async () => {
      await update((j) => {
        j.deployment!.attempt.phase = 'verified';
        j.deployment!.attempt.smoke = 'passed';
      });
      return result('smoke');
    });
    const first = await setup(options, ops);
    expect(first.exitCode, JSON.stringify(first.output)).toBe(checkpoint === 'completed' ? 0 : 6);
    expect(uploads).toBe(1);
    const rerun = await setup(options, ops);
    expect(rerun.exitCode).toBe(0);
    expect(uploads).toBe(1);
    expect(rerun.output.version_id).toBe(versionId);
    expect(rerun.output.plan).toContainEqual({
      stage: 'deploy',
      action: checkpoint === 'completed' ? 'unchanged' : 'reconcile',
    });
  },
);

it('normalizes a trailing slash public URL through deployment, smoke and browser setup', async () => {
  options.publicUrl = 'https://broker.example.test/';
  options.domain = 'broker.example.test';
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 0,
    output: { bootstrap_url: 'https://broker.example.test/_pb/ui/setup' },
  });
  for (const operation of [ops.provision, ops.migrate, ops.deploy, ops.smoke])
    expect(operation).toHaveBeenCalledWith(
      expect.objectContaining({ publicUrl: 'https://broker.example.test' }),
    );
});

it.each(['missing endpoint', 'malformed headers', 'non-string headers', 'invalid endpoint'])(
  'rejects artifact-dependent telemetry input before provisioning or key export: %s',
  async (failure) => {
    vi.mocked(ops.validateArtifact).mockImplementation(async () => {
      calls.push('artifact');
      return {
        ports: {
          blob: { binding: 'STORAGE' },
          jobs: { binding: 'JOBS' },
          observability: {
            analyticsBinding: 'ANALYTICS',
            endpointEnv: 'OTEL_ENDPOINT',
            headersEnv: 'OTEL_HEADERS',
          },
        },
      } as Awaited<ReturnType<SetupOperations['validateArtifact']>>;
    });
    options.secret = ['OTEL_HEADERS'];
    options.env = {
      ...options.env,
      OTEL_ENDPOINT:
        failure === 'missing endpoint'
          ? undefined
          : failure === 'invalid endpoint'
            ? 'not a URL'
            : 'https://collector.example.test',
      OTEL_HEADERS:
        failure === 'malformed headers'
          ? 'HEADERS_SENTINEL'
          : failure === 'non-string headers'
            ? '{"authorization":123}'
            : '{}',
    };
    const outcome = await setup(options, ops);
    expect(outcome).toMatchObject({
      exitCode: 2,
      output: { error: { code: 'invalid_input' } },
    });
    if (failure === 'missing endpoint' || failure === 'invalid endpoint') {
      expect(calls).toEqual(['build', 'artifact']);
      expect(options.fetch).not.toHaveBeenCalled();
      expect(ops.provision).not.toHaveBeenCalled();
    } else {
      expect(options.fetch).toHaveBeenCalled();
      expect(ops.provision).toHaveBeenCalledTimes(1);
      expect(vi.mocked(ops.provision).mock.calls[0]![0].dryRun).toBe(true);
    }
    for (const operation of [ops.migrate, ops.organization, ops.deploy, ops.admin])
      expect(operation).not.toHaveBeenCalled();
    expect(await store.read()).toBeNull();
    await expect(stat(options.keyFile!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(outcome)).not.toContain('HEADERS_SENTINEL');
  },
);
it('rejects PB_MASTER_KEY as telemetry headers before planning on first install', async () => {
  vi.mocked(ops.validateArtifact).mockResolvedValue({
    ports: {
      blob: { binding: 'STORAGE' },
      jobs: { binding: 'JOBS' },
      observability: { endpointEnv: 'OTEL_ENDPOINT', headersEnv: 'PB_MASTER_KEY' },
    },
  } as Awaited<ReturnType<SetupOperations['validateArtifact']>>);
  options.env = { ...options.env, OTEL_ENDPOINT: 'https://collector.example.test' };
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 2,
    output: { error: { code: 'invalid_input', stage: 'validate' } },
  });
  expect(options.fetch).not.toHaveBeenCalled();
  expect(ops.provision).not.toHaveBeenCalled();
  expect(await store.read()).toBeNull();
  await expect(stat(options.keyFile!)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([
  { secret: ['MISSING_SECRET'] },
  { secrets: 'MISSING_SECRET' },
  { secret: ['EMPTY_SECRET'] },
  { secrets: 'EMPTY_SECRET' },
  {},
])('requires all new deployment secret values before resource mutation: %j', async (selection) => {
  Object.assign(options, selection);
  options.env = { ...options.env, EMPTY_SECRET: '' };
  if (!('secret' in selection) && !('secrets' in selection)) {
    vi.mocked(ops.validateArtifact).mockResolvedValue({
      ports: {
        blob: { binding: 'STORAGE' },
        jobs: { binding: 'JOBS' },
        observability: {
          analyticsBinding: 'ANALYTICS',
          endpointEnv: 'OTEL_ENDPOINT',
          headersEnv: 'OTEL_HEADERS',
        },
      },
    } as Awaited<ReturnType<SetupOperations['validateArtifact']>>);
    options.env = { ...options.env, OTEL_ENDPOINT: 'https://collector.example.test' };
  }
  options.reveal = vi.fn();
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 2,
    output: { error: { code: 'invalid_input', stage: 'validate' } },
  });
  expect(ops.provision).toHaveBeenCalledTimes(1);
  expect(vi.mocked(ops.provision).mock.calls[0]![0].dryRun).toBe(true);
  for (const operation of [ops.migrate, ops.organization, ops.deploy, ops.smoke, ops.admin])
    expect(operation).not.toHaveBeenCalled();
  expect(options.reveal).not.toHaveBeenCalled();
  expect(await store.read()).toBeNull();
  await expect(stat(options.keyFile!)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('does not read a supplied env key when the live secret is installed', async () => {
  installed = exists = true;
  await update((j) => {
    j.secret_delivery.master_key = 'installed';
    j.bootstrap.state = 'issued';
  });
  delete options.keyFile;
  delete options.tokenFile;
  options.masterKeyEnv = 'CUSTOM_SOURCE';
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(sentKey).toBeUndefined();
});
it('installed checkpoint invalidated by live names stops for explicit recovery', async () => {
  await update((j) => {
    j.secret_delivery.master_key = 'installed';
    j.bootstrap.state = 'issued';
  });
  delete options.keyFile;
  delete options.tokenFile;
  expect((await setup(options, ops)).output.error?.code).toBe('key_recovery_required');
  expect(ops.provision).toHaveBeenCalledTimes(1);
});
it.each(['issuing', 'unknown', 'issued'] as const)(
  'never reissues an admin token implicitly from %s',
  async (state) => {
    installed = exists = true;
    await update((j) => {
      j.secret_delivery.master_key = 'installed';
      j.bootstrap.state = state;
    });
    delete options.keyFile;
    delete options.tokenFile;
    const r = await setup(options, ops);
    expect(r.exitCode).toBe(state === 'issued' ? 0 : 7);
    expect(ops.admin).not.toHaveBeenCalled();
  },
);
it('requires delivery before network for explicit token refresh', async () => {
  installed = exists = true;
  await update((j) => {
    j.secret_delivery.master_key = 'installed';
    j.bootstrap.state = 'issued';
  });
  delete options.keyFile;
  delete options.tokenFile;
  options.refreshSetupToken = true;
  expect((await setup(options, ops)).exitCode).toBe(2);
  expect(calls).toEqual([]);
});
it('explicit refresh uses bootstrap and never resets completed credentials', async () => {
  installed = exists = true;
  await update((j) => {
    j.secret_delivery.master_key = 'installed';
    j.bootstrap.state = 'unknown';
  });
  delete options.keyFile;
  options.refreshSetupToken = true;
  ops.admin = vi.fn(async () => ({
    exitCode: 6,
    state: 'already_set_up' as const,
    expiresAt: null,
  }));
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect((await journal()).bootstrap.state).toBe('already_set_up');
  vi.mocked(ops.admin).mockClear();
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(ops.admin).not.toHaveBeenCalled();
});
it('admin commit followed by lost delivery leaves a marker that prevents implicit reissue', async () => {
  ops.admin = vi.fn(async () => {
    expect((await journal()).bootstrap.state).toBe('issuing');
    throw new Error('committed then lost output');
  });
  expect((await setup(options, ops)).exitCode).toBe(7);
  expect((await journal()).bootstrap.state).toBe('issuing');
  delete options.keyFile;
  delete options.tokenFile;
  vi.mocked(ops.admin).mockClear();
  expect((await setup(options, ops)).exitCode).toBe(7);
  expect(ops.admin).not.toHaveBeenCalled();
});
it('refuses --migrate=false when live schema has pending migrations', async () => {
  options.migrate = false;
  ops.migrate = vi.fn(async () => ({
    ...result('migrate'),
    value: { applied: [], skipped: [], unknown: [], pending: ['core:0001_init'] },
    diagnostics: [],
  }));
  expect((await setup(options, ops)).exitCode).toBe(11);
  expect(ops.organization).not.toHaveBeenCalled();
});
it.each(['secret', 'secrets'] as const)(
  'removes OS-allowlisted secrets selected through %s from the real build child environment',
  async (selection) => {
    const names = ['LANG', 'LC_ALL', 'SOURCE_DATE_EPOCH'];
    if (selection === 'secret') options.secret = names;
    else options.secrets = names.join('\n');
    options.env = {
      ...options.env,
      LANG: 'LANG_SENTINEL',
      LC_ALL: 'LC_ALL_SENTINEL',
      SOURCE_DATE_EPOCH: 'EPOCH_SENTINEL',
    };
    ops.build = vi.fn(async (_config, _out, env) => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ['--eval', 'process.stdout.write(JSON.stringify(process.env))'],
        { env },
      );
      const observed = JSON.parse(stdout);
      for (const name of names) expect(observed).not.toHaveProperty(name);
    });
    expect((await setup(options, ops)).exitCode).toBe(0);
    expect(ops.build).toHaveBeenCalledTimes(1);
    expect(vi.mocked(ops.deploy).mock.calls[0]![0].env).toMatchObject({
      LANG: 'LANG_SENTINEL',
      LC_ALL: 'LC_ALL_SENTINEL',
      SOURCE_DATE_EPOCH: 'EPOCH_SENTINEL',
    });
  },
);

it('allowlists only OS/build inputs, including rejecting inherited execution hooks', async () => {
  const clean = setupBuildEnvironment({
    PATH: process.env.PATH,
    NODE_OPTIONS: '--require bad',
    NODE_PATH: '/bad',
    PB_MASTER_KEY: KEY,
    IDP_SECRET: 'hidden',
    OTEL_HEADERS: 'hidden',
    INHERITED_SENTINEL: 'hidden',
    SOURCE_DATE_EPOCH: '0',
  });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ['--eval', 'process.stdout.write(JSON.stringify(process.env))'],
    { env: clean },
  );
  expect(JSON.parse(stdout)).toMatchObject(clean);
  expect(stdout).not.toContain('hidden');
  expect(stdout).not.toContain(KEY);
  expect(stdout).not.toContain('NODE_OPTIONS');
});

it.each(['export_pending', 'exported', 'upload_pending', 'installed'] as const)(
  'recovers conservatively after interruption immediately following persisted %s',
  async (checkpoint) => {
    const write = InventoryStore.prototype.write;
    let interrupted = false;
    vi.spyOn(InventoryStore.prototype, 'write').mockImplementation(async function (
      this: InventoryStore,
      j,
    ) {
      await write.call(this, j);
      if (!interrupted && j.secret_delivery.master_key === checkpoint) {
        interrupted = true;
        throw new Error('interrupted after durable checkpoint');
      }
    });
    expect((await setup(options, ops)).exitCode).not.toBe(0);
    expect(interrupted).toBe(true);
    expect((await journal()).secret_delivery.master_key).toBe(checkpoint);
    if (checkpoint === 'export_pending') {
      await expect(stat(options.keyFile!)).rejects.toMatchObject({ code: 'ENOENT' });
      delete options.keyFile;
      expect((await setup(options, ops)).output.error?.code).toBe('key_recovery_required');
    } else {
      const saved = await readFile(options.keyFile!, 'utf8');
      expect((await setup(options, ops)).exitCode).toBe(0);
      expect(await readFile(options.keyFile!, 'utf8')).toBe(saved);
    }
  },
);
it.each(['issuing', 'issued'] as const)(
  'never reissues after persisted bootstrap %s and output loss',
  async (checkpoint) => {
    const write = InventoryStore.prototype.write;
    let interrupted = false;
    vi.spyOn(InventoryStore.prototype, 'write').mockImplementation(async function (
      this: InventoryStore,
      j,
    ) {
      await write.call(this, j);
      if (!interrupted && j.bootstrap.state === checkpoint) {
        interrupted = true;
        throw new Error('lost checkpoint acknowledgement');
      }
    });
    expect((await setup(options, ops)).exitCode).toBe(7);
    delete options.keyFile;
    delete options.tokenFile;
    vi.mocked(ops.admin).mockClear();
    expect((await setup(options, ops)).exitCode).toBe(checkpoint === 'issued' ? 0 : 7);
    expect(ops.admin).not.toHaveBeenCalled();
  },
);
it('a lost upload acknowledgement with installed live names never reloads or replaces the key', async () => {
  ops.deploy = vi.fn(async () => {
    installed = exists = true;
    return failCommand(
      commandEnvelope('deploy'),
      new CloudflareError('outcome_unknown', 6, false, 'deploy'),
    );
  });
  expect((await setup(options, ops)).exitCode).toBe(6);
  expect((await journal()).secret_delivery.master_key).toBe('upload_pending');
  delete options.keyFile;
  ops.deploy = vi.fn(async (o) => {
    expect(o.env.PB_MASTER_KEY).toBeUndefined();
    expect(o.secret).not.toContain('PB_MASTER_KEY');
    const r = result('deploy');
    r.output.worker_url = 'https://broker.example.test';
    return r;
  });
  expect((await setup(options, ops)).exitCode).toBe(0);
});
it('secret-list failure stops before resource writes and is never interpreted as key absence', async () => {
  exists = true;
  const send = options.fetch!;
  options.fetch = vi.fn(async (input, init) =>
    new URL(String(input)).pathname.endsWith('/secrets')
      ? new Response('{}', { status: 403 })
      : send(input, init),
  );
  expect((await setup(options, ops)).output.error?.code).toBe('permission_denied');
  expect(ops.provision).toHaveBeenCalledTimes(1);
  expect(ops.deploy).not.toHaveBeenCalled();
});
it('build config evaluated by the real shared build child cannot observe inherited secret sentinels', async () => {
  const observed = join(project, 'observed.json');
  await writeFile(
    options.configPath!,
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(observed)}, JSON.stringify(Object.fromEntries(['CLOUDFLARE_API_TOKEN','PB_MASTER_KEY','CUSTOM_SOURCE','PB_SMOKE_TOKEN','IDP_SECRET','OTEL_HEADERS','INHERITED_SENTINEL','NODE_OPTIONS'].map(k => [k, process.env[k] ?? null]))));
throw new Error('fixture stops after inspecting environment');
export default {};
`,
  );
  const moduleUrl = pathToFileURL(join(buildFixture, 'commands/cloudflare/setup.js')).href;
  const script =
    'const { buildSetupArtifact } = await import(process.argv[1]); try { await buildSetupArtifact(process.argv[2], process.argv[3], process.env); process.exitCode = 1; } catch (error) { if (error.code !== "invalid_input" || error.stage !== "build") process.exitCode = 2; }';
  await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      script,
      moduleUrl,
      options.configPath!,
      join(project, '.pb/cloudflare'),
    ],
    {
      env: {
        ...process.env,
        ...options.env,
        PB_SMOKE_TOKEN: 'SMOKE_SENTINEL',
        IDP_SECRET: 'IDP_SENTINEL',
        OTEL_HEADERS: 'OTEL_SENTINEL',
        INHERITED_SENTINEL: 'INHERITED_SENTINEL',
      },
    },
  );
  const values = Object.values(JSON.parse(await readFile(observed, 'utf8')));
  expect(values).toHaveLength(8);
  expect(values.every((value) => value === null)).toBe(true);
});

it.each(['upload_pending', 'uploaded', 'configuring', 'activation_pending'] as const)(
  'delegates exact candidate reconciliation from %s without loading or generating a key',
  async (phase) => {
    vi.mocked(ops.validateArtifact).mockResolvedValue({
      ports: {
        blob: { binding: 'STORAGE' },
        jobs: { binding: 'JOBS' },
        observability: { endpointEnv: 'OTEL_ENDPOINT', headersEnv: 'OTEL_HEADERS' },
      },
    } as Awaited<ReturnType<SetupOperations['validateArtifact']>>);
    options.env = { ...options.env, OTEL_ENDPOINT: 'https://collector.example.test' };
    options.secret = ['IDP_SECRET'];
    options.secrets = 'OTEL_HEADERS';
    for (const name of ['IDP_SECRET', 'OTEL_HEADERS'])
      Object.defineProperty(options.env, name, {
        get: () => {
          throw new Error('pending secret must not be loaded');
        },
      });
    await update((j) => {
      j.secret_delivery.master_key = 'upload_pending';
      const settings = {
        endpoints: { enabled: true, previews_enabled: false },
        schedules: [],
        consumer: null,
        routes: [],
        domain: null,
      };
      j.deployment = {
        last_verified: null,
        attempt: {
          operation_id: 'candidate-operation',
          artifact_sha256: 'a'.repeat(64),
          assets_sha256: null,
          settings_sha256: 'b'.repeat(64),
          secret_names: ['PB_MASTER_KEY', 'IDP_SECRET', 'OTEL_HEADERS'],
          build_info: {
            schemaVersion: 1,
            target: 'cloudflare',
            core: '2.0.0',
            plugins: {},
            lockfileSha256: null,
            gitSha: null,
          },
          version_id: phase === 'upload_pending' ? null : 'candidate-version',
          previous_version_id: null,
          previous_deployment_id: null,
          previous_distribution: [],
          requested_rollout: 100,
          worker_url: 'https://broker.example.test',
          candidate_probe_url: null,
          migration_ledger_sha256: 'c'.repeat(64),
          rollback_compatible: true,
          contract_ids: [],
          phase,
          activated_at: null,
          smoke: 'pending',
          rollback: 'not_needed',
          preview: 'disabled',
          prior_settings: settings,
          intended_settings: settings,
          changes: [],
        },
      };
    });
    delete options.keyFile;
    options.reveal = vi.fn();
    ops.deploy = vi.fn(async (o) => {
      expect(o.env.PB_MASTER_KEY).toBeUndefined();
      expect(o.env).not.toHaveProperty('IDP_SECRET');
      expect(o.env).not.toHaveProperty('OTEL_HEADERS');
      expect(o.secret).toEqual([]);
      expect(o).not.toHaveProperty('secrets');
      expect((await journal()).deployment?.attempt.phase).toBe(phase);
      const r = result('deploy');
      r.output.worker_url = 'https://broker.example.test';
      return r;
    });
    expect((await setup(options, ops)).exitCode).toBe(0);
    expect(options.reveal).not.toHaveBeenCalled();
    expect(ops.deploy).toHaveBeenCalledTimes(1);
  },
);
it('does not access the value of an explicitly supplied source for an installed key', async () => {
  installed = exists = true;
  await update((j) => {
    j.secret_delivery.master_key = 'installed';
    j.bootstrap.state = 'issued';
  });
  delete options.keyFile;
  delete options.tokenFile;
  options.masterKeyEnv = 'CUSTOM_SOURCE';
  Object.defineProperty(options.env, 'CUSTOM_SOURCE', {
    get: () => {
      throw new Error('installed source must not be loaded');
    },
  });
  expect((await setup(options, ops)).exitCode).toBe(0);
});
it('returns a typed JSON-safe failure if releasing the install lock fails', async () => {
  const close = InventoryTransaction.prototype.close;
  vi.spyOn(InventoryTransaction.prototype, 'close').mockImplementation(async function (
    this: InventoryTransaction,
  ) {
    await close.call(this);
    throw new Error('private lock sentinel');
  });
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 4,
    output: { status: 'error', error: { code: 'install_locked' } },
  });
});
it.each([
  { secret: ['DB'] },
  { secret: ['CUSTOM', 'CUSTOM'] },
  { rollout: 0 },
  { deadlineSeconds: 0 },
  { publicUrl: 'https://user:password@broker.example.test' },
  { smokeProject: 'login' },
  { smokeTokenEnv: 'CLOUDFLARE_API_TOKEN' },
])('rejects locally invalid options before network: %j', async (invalidOptions) => {
  Object.assign(options, invalidOptions);
  expect((await setup(options, ops)).exitCode).toBe(2);
  expect(options.fetch).not.toHaveBeenCalled();
});

it('rejects domain labels longer than 63 characters before build or network', async () => {
  options.domain = `${'a'.repeat(64)}.example.test`;
  expect(await setup(options, ops)).toMatchObject({
    exitCode: 2,
    output: { error: { code: 'invalid_input', stage: 'validate' } },
  });
  expect(calls).toEqual([]);
  expect(options.fetch).not.toHaveBeenCalled();
});

it('accepts a domain label of exactly 63 characters', async () => {
  options.domain = `${'a'.repeat(63)}.example.test`;
  expect((await setup(options, ops)).exitCode).toBe(0);
});

it.each(['blob', 'jobs', 'analytics', 'endpoint'])(
  'rejects an implicit master-key collision with the %s binding before network',
  async (binding) => {
    if (binding === 'endpoint')
      options.env = { ...options.env, PB_MASTER_KEY: 'https://collector.example.test' };
    vi.mocked(ops.validateArtifact).mockResolvedValue({
      ports: {
        blob: { binding: binding === 'blob' ? 'PB_MASTER_KEY' : 'STORAGE' },
        jobs: { binding: binding === 'jobs' ? 'PB_MASTER_KEY' : 'JOBS' },
        observability: {
          analyticsBinding: binding === 'analytics' ? 'PB_MASTER_KEY' : 'ANALYTICS',
          ...(binding === 'endpoint' ? { endpointEnv: 'PB_MASTER_KEY' } : {}),
        },
      },
    } as Awaited<ReturnType<SetupOperations['validateArtifact']>>);
    expect(await setup(options, ops)).toMatchObject({
      exitCode: 2,
      output: { error: { code: 'invalid_input' } },
    });
    expect(options.fetch).not.toHaveBeenCalled();
    expect(ops.provision).not.toHaveBeenCalled();
    expect(await store.read()).toBeNull();
    await expect(stat(options.keyFile!)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('rejects duplicate generated binding names before network', async () => {
  vi.mocked(ops.validateArtifact).mockResolvedValue({
    ports: {
      blob: { binding: 'ASSETS' },
      jobs: { binding: 'JOBS' },
      observability: {},
    },
  } as Awaited<ReturnType<SetupOperations['validateArtifact']>>);
  expect((await setup(options, ops)).exitCode).toBe(2);
  expect(options.fetch).not.toHaveBeenCalled();
  expect(ops.provision).not.toHaveBeenCalled();
});

it.each(['ASSETS', 'OTEL_ENDPOINT'])(
  'rejects an installed secret colliding with %s before provisioning',
  async (name) => {
    installed = exists = true;
    if (name === 'OTEL_ENDPOINT') {
      vi.mocked(ops.validateArtifact).mockResolvedValue({
        ports: {
          blob: { binding: 'STORAGE' },
          jobs: { binding: 'JOBS' },
          observability: { endpointEnv: name },
        },
      } as Awaited<ReturnType<SetupOperations['validateArtifact']>>);
      options.env = { ...options.env, [name]: 'https://collector.example.test' };
    }
    const fetch = options.fetch!;
    options.fetch = vi.fn(async (input, init) =>
      new URL(String(input)).pathname.endsWith('/secrets')
        ? new Response(
            JSON.stringify({
              success: true,
              result: ['PB_MASTER_KEY', name].map((name) => ({ type: 'secret_text', name })),
              result_info: { total_count: 2 },
            }),
          )
        : fetch(input, init),
    );
    expect((await setup(options, ops)).exitCode).toBe(2);
    expect(calls).not.toContain('provision');
    expect(ops.deploy).not.toHaveBeenCalled();
    expect(await store.read()).toBeNull();
  },
);

it.each([false, true])(
  'rejects partial rollout without an active version before provisioning (worker exists: %s)',
  async (workerExists) => {
    exists = workerExists;
    options.rollout = 50;
    const fetch = options.fetch!;
    options.fetch = vi.fn(async (input, init) =>
      new URL(String(input)).pathname.endsWith('/deployments')
        ? new Response(JSON.stringify({ success: true, result: { deployments: [] } }))
        : fetch(input, init),
    );
    expect((await setup(options, ops)).exitCode).toBe(2);
    expect(calls).not.toContain('provision');
    expect(ops.deploy).not.toHaveBeenCalled();
    expect(await store.read()).toBeNull();
  },
);

it('an identical completed invocation accepts its existing delivery files without reading or changing them', async () => {
  const admin = ops.admin;
  ops.admin = vi.fn(async (o, sink) => {
    await writeFile(o.tokenFile!, 'TOKEN_SENTINEL\n', { mode: 0o600, flag: 'wx' });
    return admin(o, sink);
  });
  expect((await setup(options, ops)).exitCode).toBe(0);
  const key = await readFile(options.keyFile!, 'utf8');
  options.yes = false;
  vi.mocked(ops.admin).mockClear();
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(ops.admin).not.toHaveBeenCalled();
  expect(sentKey).toBeUndefined();
  expect(await readFile(options.keyFile!, 'utf8')).toBe(key);
  expect(await readFile(options.tokenFile!, 'utf8')).toBe('TOKEN_SENTINEL\n');
});

it('collects missing guided inputs through injected TTY prompts with identity defaults', async () => {
  options.workerName = '';
  options.nonInteractive = false;
  options.tty = true;
  const answers = ['broker', '', '', '', '', '', ''];
  options.prompt = vi.fn(async () => answers.shift() ?? '');
  expect((await setup(options, ops)).exitCode).toBe(0);
  expect(options.prompt).toHaveBeenCalledTimes(7);
  expect(vi.mocked(ops.provision).mock.calls[0]?.[0]).toMatchObject({
    workerName: 'broker',
    environment: 'production',
    jurisdiction: 'eu',
    deploymentId: 'broker-production',
  });
});
