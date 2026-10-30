import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./cli.js');
  vi.doUnmock('node:fs/promises');
  vi.unstubAllEnvs();
});

it('prints only the error name for an unexpected error', async () => {
  const secret = 'secret-ish text';
  vi.doMock('./cli.js', () => ({ run: () => Promise.reject(new Error(secret)) }));
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  await import('./bin.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));

  const printed = error.mock.calls.map((call) => call.join(' ')).join('\n');
  expect(printed).toBe('error: Error');
  expect(printed).not.toContain(secret);
});

it('prints the exit code of a normal run unchanged', async () => {
  vi.doMock('./cli.js', () => ({ run: () => Promise.resolve(3) }));
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  await import('./bin.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(3));
});

it('keeps a real provision JSON usage failure to one stdout object and exit 2', async () => {
  const previous = process.argv;
  process.argv = ['node', 'pb', 'cloudflare', 'provision', '--json'];
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    await import('./bin.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      schema_version: 1,
      command: 'provision',
      status: 'error',
      error: { code: 'invalid_input' },
    });
    expect(error).not.toHaveBeenCalled();
  } finally {
    process.argv = previous;
  }
});

it('attributes a real migrate JSON usage failure to migrate with exit 2', async () => {
  const previous = process.argv;
  process.argv = ['node', 'pb', 'cloudflare', 'migrate', '--json'];
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    await import('./bin.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      command: 'migrate',
      status: 'error',
      error: { code: 'invalid_input', stage: 'migrate' },
    });
    expect(error).not.toHaveBeenCalled();
  } finally {
    process.argv = previous;
  }
});

it('keeps a missing worker name as a separate deploy usage failure', async () => {
  await deployJsonFailure([]);
});

it.each(
  [
    ['--secrets-file', 'secret.json'],
    ['--rollout', '0'],
    ['--rollout', '1e2'],
    ['--secret', 'PB_MASTER_KEY=value'],
  ].map((flags) => ({ flags: ['--worker-name', 'broker', ...flags] })),
)('keeps deploy JSON failures safe and attributed to deploy: $flags', async ({ flags }) => {
  await deployJsonFailure(flags);
});

async function deployJsonFailure(flags: string[]) {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32));
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'TEST_TOKEN');
  const realpath = vi.fn(async () => {
    throw new Error('downstream artifact validation reached');
  });
  vi.doMock('node:fs/promises', async (original) => ({
    ...(await original<typeof import('node:fs/promises')>()),
    realpath,
  }));
  const previous = process.argv;
  process.argv = ['node', 'pb', 'cloudflare', 'deploy', '--json', ...flags];
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    await import('./bin.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      command: 'deploy',
      status: 'error',
      error: { code: 'invalid_input', stage: 'deploy' },
    });
    expect(error).not.toHaveBeenCalled();
    expect(realpath).not.toHaveBeenCalled();
  } finally {
    process.argv = previous;
  }
}

it.each([9, 10, 11, 12])('preserves smoke exit %i through the binary', async (code) => {
  vi.doMock('./cli.js', () => ({ run: () => Promise.resolve(code) }));
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  await import('./bin.js');
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code));
});

it.each(
  [
    [],
    ['--worker-name', 'broker', '--deadline-seconds', '0'],
    ['--worker-name', 'broker', '--deadline-seconds', '301'],
    ['--worker-name', 'broker', '--deadline-seconds', '1e2'],
    ['--worker-name', 'broker', '--smoke-token', 'TOKEN_SENTINEL'],
  ].map((flags) => ({ flags })),
)('keeps smoke usage failures to one safe JSON object: $flags', async ({ flags }) => {
  const previous = process.argv;
  process.argv = ['node', 'pb', 'cloudflare', 'smoke', '--json', ...flags];
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    await import('./bin.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(log).toHaveBeenCalledTimes(1);
    const text = String(log.mock.calls[0]![0]);
    expect(JSON.parse(text)).toMatchObject({
      schema_version: 1,
      command: 'smoke',
      status: 'error',
      error: { code: 'invalid_input', stage: 'smoke' },
    });
    expect(text).not.toContain('TOKEN_SENTINEL');
    expect(error).not.toHaveBeenCalled();
  } finally {
    process.argv = previous;
  }
});

it('keeps setup JSON missing token delivery to one safe stdout object before network', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32));
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'TEST_TOKEN');
  const { formatMasterKey, generateMasterKey } =
    await import('@package-broker/core/secrets/master-key');
  vi.stubEnv('SETUP_MASTER_KEY', formatMasterKey(generateMasterKey(1)));
  const { InventoryStore } = await import('./commands/cloudflare/inventory.js');
  const readInventory = vi.spyOn(InventoryStore.prototype, 'read').mockResolvedValue(null);
  const previous = process.argv;
  process.argv = [
    'node',
    'pb',
    'cloudflare',
    'setup',
    '--json',
    '--worker-name',
    'broker',
    '--org-slug',
    'demo',
    '--org-name',
    'Demo',
    '--admin-email',
    'admin@example.test',
    '--master-key-env',
    'SETUP_MASTER_KEY',
  ];
  const send = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not call network'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  try {
    await import('./bin.js');
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(2));
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      command: 'setup',
      status: 'error',
      error: { code: 'invalid_input', stage: 'validate' },
    });
    expect(readInventory).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(JSON.stringify(log.mock.calls)).not.toContain('admin@example.test');
  } finally {
    process.argv = previous;
  }
});

it('runs CLI disabled setup past validation with the default false refresh flag', async () => {
  vi.stubEnv('CLOUDFLARE_ACCOUNT_ID', 'a'.repeat(32));
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'TEST_TOKEN');
  vi.stubEnv('PB_IDP_DEX_CLIENT_SECRET', 'TEST_SECRET');
  const { formatMasterKey, generateMasterKey } =
    await import('@package-broker/core/secrets/master-key');
  vi.stubEnv('SETUP_MASTER_KEY', formatMasterKey(generateMasterKey(1)));
  const { InventoryStore } = await import('./commands/cloudflare/inventory.js');
  vi.spyOn(InventoryStore.prototype, 'read').mockResolvedValue(null);
  const build = vi.fn(async () => undefined);
  const send = vi.fn(
    async (input: string | URL | Request) =>
      new Response(
        JSON.stringify({
          success: true,
          result: String(input).endsWith('/workers/subdomain') ? { subdomain: 'account' } : [],
        }),
      ),
  );
  vi.doMock('./commands/cloudflare/setup.js', async (original) => {
    const actual = await original<typeof import('./commands/cloudflare/setup.js')>();
    return {
      ...actual,
      runCloudflareSetup: async (o: Parameters<typeof actual.setup>[0]) => {
        expect(o.refreshSetupToken).toBe(false);
        const result = await actual.setup(
          { ...o, fetch: send, progress: () => undefined },
          {
            build,
            validateArtifact: vi.fn(
              async () =>
                ({
                  localAuth: { version: 1 },
                  identity: {
                    runtimeProviders: false,
                    compiled: [
                      {
                        id: 'dex',
                        kind: 'oidc',
                        anchor: 'oidc:https://idp.example.test',
                        policy: {
                          verifiedDomains: ['example.test'],
                          emailAuthoritativeDomains: ['example.test'],
                        },
                      },
                    ],
                  },
                }) as unknown as Awaited<
                  ReturnType<
                    (typeof import('./commands/cloudflare/deploy.js'))['validateDeploymentArtifact']
                  >
                >,
            ),
            provision: vi.fn(async () => ({
              exitCode: 0,
              output: (await import('./commands/cloudflare/api.js')).commandEnvelope('provision'),
            })),
          },
        );
        expect(result).toMatchObject({ exitCode: 0, output: { status: 'planned' } });
        return result.exitCode;
      },
    };
  });
  try {
    const { run } = await import('./cli.js');
    expect(
      await run([
        'cloudflare',
        'setup',
        '--local-auth',
        'disabled',
        '--dry-run',
        '--json',
        '--worker-name',
        'broker',
        '--org-slug',
        'demo',
        '--org-name',
        'Demo',
        '--admin-email',
        'admin@example.test',
        '--master-key-env',
        'SETUP_MASTER_KEY',
        '--secret',
        'PB_IDP_DEX_CLIENT_SECRET',
      ]),
    ).toBe(0);
    expect(build).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalled();
  } finally {
    vi.doUnmock('./commands/cloudflare/setup.js');
  }
});
