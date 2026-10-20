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
