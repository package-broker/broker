import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject) {
  const scratch = await mkdtemp(join(tmpdir(), 'pb-ui-browser-'));
  project.provide('uiBrowserAssets', scratch);
  return () => rm(scratch, { recursive: true, force: true });
}

declare module 'vitest' {
  export interface ProvidedContext {
    uiBrowserAssets: string;
  }
}
