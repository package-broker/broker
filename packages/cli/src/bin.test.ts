import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./cli.js');
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
