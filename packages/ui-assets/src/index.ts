import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import type { AssetProviderV1 } from '@package-broker/core/config';

const MANIFEST_SPECIFIER = '@package-broker/ui/assets/manifest.json';

export function createUiAssetsProvider(anchor: string | URL): AssetProviderV1 {
  const require = createRequire(anchor);
  return {
    apiVersion: 1,
    async resolve() {
      return { manifestUrl: pathToFileURL(require.resolve(MANIFEST_SPECIFIER)).href };
    },
  };
}

const provider = createUiAssetsProvider(import.meta.url);

export default provider;
