import { expect, it, vi } from 'vitest';
import { run } from './cli.js';
import { runCloudflareSetup } from './commands/cloudflare/setup.js';
import { runCloudflareProvision } from './commands/cloudflare/provision.js';

vi.mock('./commands/cloudflare/provision.js', () => ({
  runCloudflareProvision: vi.fn(async () => 0),
}));

vi.mock('./commands/cloudflare/setup.js', () => ({
  runCloudflareSetup: vi.fn(async () => 0),
}));

it('lists only working commands in --help', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    expect(await run(['--help'])).toBe(0);
    expect(output).toHaveBeenCalledTimes(1);
    const help = String(output.mock.calls[0]?.[0]);
    const commands = [...help.matchAll(/(?:Usage: |^\s+)pb (.+?)(?= --| \[|$)/gm)].map(
      (match) => match[1],
    );
    expect(commands).toEqual([
      'build',
      'migrate',
      'bootstrap',
      'cloudflare setup',
      'cloudflare provision',
      'cloudflare deploy',
      'cloudflare smoke',
      'cloudflare teardown',
      'cloudflare janitor',
      'cloudflare migrate',
      'cloudflare bootstrap',
      'secrets generate-master-key',
      'admin bootstrap',
      'admin reset-local',
      'admin rebind-provider',
      'admin show-provider-binding',
      'import cutover-check',
      'import private-packagist fetch',
      'import private-packagist plan',
      'import private-packagist dates',
      'import satis plan',
      'import submit',
      'import status <run>',
      'import credentials <run>',
      'import verify <run>',
      'import accept <run>',
      'source accept-removal',
      'version',
    ]);
    expect(help).not.toContain('pb openapi');
  } finally {
    output.mockRestore();
  }
});

it('accepts --abandon-intent only on provision and requires a value', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const provision = vi.mocked(runCloudflareProvision);
    provision.mockClear();
    expect(
      await run(['cloudflare', 'provision', '--worker-name', 'broker', '--abandon-intent', 'op-1']),
    ).toBe(0);
    expect(provision).toHaveBeenCalledWith(expect.objectContaining({ abandonIntent: 'op-1' }));
    expect(
      await run(['cloudflare', 'provision', '--worker-name', 'broker', '--abandon-intent']),
    ).toBe(2);
    expect(
      await run(['cloudflare', 'migrate', '--database-id', 'x', '--abandon-intent', 'op-1']),
    ).toBe(2);
    expect(provision).toHaveBeenCalledTimes(1);
  } finally {
    error.mockRestore();
  }
});

it('setup --project keeps the build project at cwd and passes only the smoke slug', async () => {
  const setup = vi.mocked(runCloudflareSetup);
  setup.mockClear();
  expect(await run(['cloudflare', 'setup', '--project', 'acme', '--dry-run', '--json'])).toBe(0);
  expect(setup).toHaveBeenCalledWith(
    expect.objectContaining({ smokeProject: 'acme', prebuilt: false }),
  );
  expect(setup.mock.calls[0]![0]).not.toHaveProperty('project');
});

vi.mock('./commands/cloudflare/deploy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./commands/cloudflare/deploy.js')>()),
  runCloudflareDeploy: vi.fn(async () => 0),
}));

it('passes --workers-paid to cloudflare deploy options', async () => {
  const { runCloudflareDeploy } = await import('./commands/cloudflare/deploy.js');
  const deploy = vi.mocked(runCloudflareDeploy);
  deploy.mockClear();
  expect(await run(['cloudflare', 'deploy', '--worker-name', 'broker', '--workers-paid'])).toBe(0);
  expect(deploy).toHaveBeenCalledWith(expect.objectContaining({ workersPaid: true }));
});

it('passes --workers-paid to cloudflare setup options', async () => {
  const setup = vi.mocked(runCloudflareSetup);
  setup.mockClear();
  expect(await run(['cloudflare', 'setup', '--worker-name', 'broker', '--workers-paid'])).toBe(0);
  expect(setup).toHaveBeenCalledWith(expect.objectContaining({ workersPaid: true }));
});

it('documents sign-in and rejects invalid or misplaced sign-in flags without reflecting their value', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(await run(['--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--sign-in local|sso'));
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('1 error (including a suspended SSO account; nothing changed)'),
    );
    expect(
      await run([
        'admin',
        'bootstrap',
        '--sign-in',
        'private-invalid-mode',
        '--email',
        'admin@example.test',
        '--sqlite',
        'missing',
      ]),
    ).toBe(2);
    expect(error).toHaveBeenLastCalledWith('admin bootstrap: invalid_sign_in');
    expect(
      await run([
        'admin',
        'reset-local',
        '--sign-in',
        'sso',
        '--email',
        'admin@example.test',
        '--sqlite',
        'missing',
      ]),
    ).toBe(2);
    expect(await run(['admin', 'bootstrap', '--sign-in'])).toBe(2);
    expect(
      await run([
        'admin',
        'bootstrap',
        '--sign-in',
        'sso',
        '--email',
        'admin@example.test',
        '--sqlite',
        'missing',
        '--token-file',
        'unused',
      ]),
    ).toBe(2);
    expect(error.mock.calls.flat().join(' ')).not.toContain('private-invalid-mode');
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

it.each(['deploy', 'setup'])(
  'passes local-auth and explicit environment to %s without defaulting',
  async (command) => {
    const { runCloudflareDeploy } = await import('./commands/cloudflare/deploy.js');
    const operation = vi.mocked(command === 'deploy' ? runCloudflareDeploy : runCloudflareSetup);
    vi.stubEnv('PB_AUTH_LOCAL', 'enabled');
    try {
      for (const mode of ['enabled', 'disabled', undefined]) {
        operation.mockClear();
        expect(
          await run([
            'cloudflare',
            command,
            '--worker-name',
            'broker',
            ...(mode ? ['--local-auth', mode] : []),
          ]),
        ).toBe(0);
        const received = operation.mock.calls[0]![0];
        expect(received.env.PB_AUTH_LOCAL).toBe('enabled');
        if (mode) expect(received).toHaveProperty('localAuth', mode);
        else expect(received).not.toHaveProperty('localAuth');
      }
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it('documents local-auth and rejects invalid, missing and misplaced values safely', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(await run(['--help'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('--local-auth enabled|disabled'));
    for (const args of [
      ['cloudflare', 'deploy', '--worker-name', 'broker', '--local-auth', 'PRIVATE_MODE'],
      ['cloudflare', 'setup', '--local-auth'],
      [
        'cloudflare',
        'setup',
        '--worker-name',
        'broker',
        '--local-auth',
        'enabled',
        '--local-auth=enabled',
      ],
      [
        'cloudflare',
        'deploy',
        '--worker-name',
        'broker',
        '--local-auth=disabled',
        '--local-auth',
        'enabled',
      ],
      ['cloudflare', 'provision', '--local-auth', 'enabled'],
    ])
      expect(await run(args)).toBe(2);
    expect(JSON.stringify(error.mock.calls)).not.toContain('PRIVATE_MODE');
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
});

it.each(['deploy', 'setup'])('passes --cpu-ms to cloudflare %s', async (command) => {
  const { runCloudflareDeploy } = await import('./commands/cloudflare/deploy.js');
  const operation = vi.mocked(command === 'deploy' ? runCloudflareDeploy : runCloudflareSetup);
  operation.mockClear();
  expect(await run(['cloudflare', command, '--worker-name', 'broker', '--cpu-ms', '45000'])).toBe(
    0,
  );
  expect(operation).toHaveBeenCalledWith(expect.objectContaining({ cpuMs: 45000 }));
});
it.each(['deploy', 'setup'])(
  'rejects malformed --cpu-ms for %s without reflecting values',
  async (command) => {
    const { runCloudflareDeploy } = await import('./commands/cloudflare/deploy.js');
    const operation = vi.mocked(command === 'deploy' ? runCloudflareDeploy : runCloudflareSetup);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const value of [
        '0',
        '-1',
        '1.5',
        '',
        '+1',
        '1e3',
        ' 1 ',
        'secret-sentinel',
        '9007199254740992',
      ]) {
        operation.mockClear();
        expect(
          await run(['cloudflare', command, '--worker-name', 'broker', '--cpu-ms', value]),
        ).toBe(2);
        expect(operation).not.toHaveBeenCalled();
      }
      expect(error.mock.calls.flat().join(' ')).not.toContain('secret-sentinel');
    } finally {
      error.mockRestore();
    }
  },
);

it('rejects missing or misplaced --cpu-ms', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect(await run(['cloudflare', 'deploy', '--worker-name', 'broker', '--cpu-ms'])).toBe(2);
    expect(
      await run(['cloudflare', 'provision', '--worker-name', 'broker', '--cpu-ms', '45000']),
    ).toBe(2);
  } finally {
    error.mockRestore();
  }
});
