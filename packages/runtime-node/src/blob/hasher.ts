import { createHash } from 'node:crypto';
import type { BlobHasher } from '@package-broker/core/platform/blob';

export function createNodeBlobHasher(): BlobHasher {
  return {
    async hashStream(stream) {
      const hash = createHash('sha256');
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
        }
        return new Uint8Array(hash.digest());
      } catch (error) {
        await reader.cancel(error).catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    },
  };
}
