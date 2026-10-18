import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { StaticAssets } from '@package-broker/core/platform/assets';
import { parseUiManifest } from '@package-broker/core/platform/ui-manifest';

/** A hard link inside the root to an outside inode is served; deployments own the dist directory. */
export async function createNodeAssets(rootDir: string): Promise<StaticAssets> {
  let root: string;
  async function readContained(name: string, bytes?: number): Promise<Uint8Array | null> {
    try {
      const path = await realpath(join(root, name));
      if (!path.startsWith(root.endsWith(sep) ? root : root + sep)) return null;
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return null;
        if (bytes !== undefined && stat.size !== bytes) return null;
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  let manifest;
  try {
    root = await realpath(rootDir);
    const body = await readContained('manifest.json');
    if (body === null) throw new Error();
    manifest = parseUiManifest(new TextDecoder().decode(body));
  } catch {
    throw new Error('UI manifest is invalid');
  }
  for (const file of Object.values(manifest.files)) Object.freeze(file);
  Object.freeze(manifest.files);
  Object.freeze(manifest);

  return {
    async manifest() {
      return manifest;
    },
    async read(name) {
      if (!Object.hasOwn(manifest.files, name)) return null;
      const file = manifest.files[name]!;
      const body = await readContained(name, file.bytes);
      if (body === null || body.byteLength !== file.bytes) return null;
      return { body, ...file };
    },
  };
}
