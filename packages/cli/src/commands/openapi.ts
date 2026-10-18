import { stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { generateOpenApi } from '@package-broker/core/api/openapi';
import type { ApiRouteSpec } from '@package-broker/core/api/route';

export function openapiCommand(deps: {
  specs: () => readonly ApiRouteSpec[];
  info: { title: string; version: string };
  write: (path: string, bytes: string) => Promise<void>;
}): (out: string | undefined) => Promise<number> {
  return async (out) => {
    if (!out) {
      console.error('openapi_out_required');
      return 2;
    }
    try {
      let existing;
      try {
        existing = await stat(out);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (existing?.isDirectory()) {
        console.error('openapi_out_is_directory');
        return 2;
      }
      const bytes = JSON.stringify(generateOpenApi(deps.specs(), deps.info));
      await deps.write(out, bytes);
      return 0;
    } catch (error) {
      console.error(
        error instanceof Error && error.message === 'no_api_specs'
          ? 'no_api_specs'
          : 'openapi_failed',
      );
      return 1;
    }
  };
}

const pkg = createRequire(import.meta.url)('../../package.json') as { version: string };
export const runOpenApi = openapiCommand({
  specs: () => {
    throw new Error('no_api_specs');
  },
  info: { title: 'Package Broker', version: pkg.version },
  write: (path, bytes) => writeFile(path, bytes, 'utf8'),
});
