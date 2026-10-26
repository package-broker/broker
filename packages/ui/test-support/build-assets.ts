import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const builds = new Map<string, Promise<void>>();

async function buildAssets(scratch: string, build: () => Promise<void>) {
  // Vitest isolates test modules; the directory lock shares one build across workers.
  let ownsBuild = true;
  try {
    await mkdir(join(scratch, 'build-lock'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    ownsBuild = false;
  }
  if (!ownsBuild) {
    for (;;) {
      let status: string;
      try {
        status = await readFile(join(scratch, 'build-status'), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await setTimeout(25);
        continue;
      }
      if (status !== 'ready') throw new Error('UI browser asset build failed');
      return;
    }
  }
  try {
    await build();
    await writeFile(join(scratch, 'build-status.tmp'), 'ready');
    await rename(join(scratch, 'build-status.tmp'), join(scratch, 'build-status'));
  } catch (error) {
    await writeFile(join(scratch, 'build-status.tmp'), 'failed');
    await rename(join(scratch, 'build-status.tmp'), join(scratch, 'build-status'));
    throw error;
  }
}

export function prepareBrowserAssets(
  scratch: string,
  build = async () => {
    await promisify(execFile)(process.execPath, [
      fileURLToPath(new URL('../scripts/build.mjs', import.meta.url)),
      '--out',
      join(scratch, 'assets'),
    ]);
  },
) {
  let pending = builds.get(scratch);
  if (!pending) {
    pending = buildAssets(scratch, build);
    builds.set(scratch, pending);
  }
  return pending;
}
