import type { BlobHasher } from '@package-broker/core/platform/blob';

interface DigestStreamLike extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
}

export function createWorkersBlobHasher(): BlobHasher {
  return {
    async hashStream(stream) {
      const factory = (
        crypto as unknown as { DigestStream?: new (name: string) => DigestStreamLike }
      ).DigestStream;
      if (factory === undefined)
        throw new Error('crypto.DigestStream is unavailable in this runtime');
      const digestStream = new factory('SHA-256');
      digestStream.digest.catch(() => undefined);
      await stream.pipeTo(digestStream);
      return new Uint8Array(await digestStream.digest);
    },
  };
}
