import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { TestProject } from 'vitest/node';
import setup from './global-setup.js';
import { prepareBrowserAssets } from './build-assets.js';

it('allocates an empty workspace without launching Chromium or building assets', async () => {
  const provide = vi.fn();
  const teardown = await setup({ provide } as unknown as TestProject);
  try {
    expect(provide).toHaveBeenCalledWith('uiBrowserAssets', expect.any(String));
    expect(await readdir(provide.mock.calls[0]![1] as string)).toEqual([]);
  } finally {
    await teardown();
  }
});

it('shares the lazy build promise and builds once across isolated worker modules', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pb-ui-build-test-'));
  const build = vi.fn(async () => {});
  try {
    const first = prepareBrowserAssets(scratch, build);
    expect(prepareBrowserAssets(scratch, build)).toBe(first);
    vi.resetModules();
    const isolated = await import('./build-assets.js');
    await Promise.all([first, isolated.prepareBrowserAssets(scratch, build)]);
    expect(build).toHaveBeenCalledOnce();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

it('shares build failures with other workers without rebuilding', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'pb-ui-build-test-'));
  const build = vi.fn(async () => {
    throw new Error('Build failed');
  });
  try {
    await expect(prepareBrowserAssets(scratch, build)).rejects.toThrow('Build failed');
    vi.resetModules();
    const isolated = await import('./build-assets.js');
    await expect(isolated.prepareBrowserAssets(scratch, build)).rejects.toThrow(
      'UI browser asset build failed',
    );
    expect(build).toHaveBeenCalledOnce();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
