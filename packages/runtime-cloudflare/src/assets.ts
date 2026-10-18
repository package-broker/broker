import type { StaticAssets } from '@package-broker/core/platform/assets';
import { parseUiManifest } from '@package-broker/core/platform/ui-manifest';

export async function createWorkersAssets(binding: {
  fetch(input: Request | string): Promise<Response>;
}): Promise<StaticAssets> {
  async function fetchFile(name: string): Promise<Response | null> {
    try {
      const response = await binding.fetch(
        new Request(`https://assets.internal/${name}`, { redirect: 'manual' }),
      );
      if (response.status !== 200) return null;
      return response;
    } catch {
      return null;
    }
  }

  let manifest;
  try {
    const response = await fetchFile('manifest.json');
    if (response === null) throw new Error();
    manifest = parseUiManifest(await response.text());
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
      const response = await fetchFile(name);
      if (response === null) return null;
      try {
        const length = response.headers.get('content-length');
        if (length !== null && Number(length) !== file.bytes) return null;
        if (response.body === null) {
          return file.bytes === 0 ? { body: new Uint8Array(), ...file } : null;
        }
        const reader = response.body.getReader();
        try {
          const body = new Uint8Array(file.bytes);
          let size = 0;
          while (size < file.bytes + 1) {
            const { done, value } = await reader.read();
            if (done) return size === file.bytes ? { body, ...file } : null;
            size += value.byteLength;
            if (size > file.bytes) {
              await reader.cancel();
              return null;
            }
            body.set(value, size - value.byteLength);
          }
          return null;
        } finally {
          reader.releaseLock();
        }
      } catch {
        return null;
      }
    },
  };
}
