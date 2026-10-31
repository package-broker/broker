import type { Codecs } from '../../platform/codec.js';
import { gzipFrame } from '../../registry/npm/gzip-frame.js';
import { loadAttributes, type ArchiveBlobSource } from '../../sources/git/archive.js';
import type { GitTree } from '../../sources/git/fetch.js';

const encoder = new TextEncoder();
function header(path: string, size: number, mode: number, type = '0') {
  const bytes = new Uint8Array(512);
  const put = (at: number, value: string) => bytes.set(encoder.encode(value), at);
  const octal = (at: number, width: number, value: number) =>
    put(at, value.toString(8).padStart(width - 1, '0') + '\0');
  put(0, path);
  octal(100, 8, mode);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  put(156, type);
  put(257, 'ustar\0');
  put(263, '00');
  bytes.fill(32, 148, 156);
  put(
    148,
    bytes
      .reduce((a, b) => a + b, 0)
      .toString(8)
      .padStart(6, '0') + '\0 ',
  );
  return bytes;
}
const padding = (size: number) => new Uint8Array((512 - (size % 512)) % 512);

export async function gitTarball(
  tree: GitTree,
  blobs: ArchiveBlobSource,
  codecs: Codecs,
  signal: AbortSignal,
) {
  if (tree.skipped > 0 || tree.entries.length > 50000) throw new RangeError('invalid_git_tree');
  const files = tree.entries.filter((entry) => ['100644', '100755'].includes(entry.mode));
  const { matcher } = await loadAttributes(blobs, files, { used: 0 });
  async function* chunks() {
    let total = 0;
    for (const entry of files) {
      signal.throwIfAborted();
      if (matcher.ignored(entry.path)) continue;
      const path = `repository/${entry.path}`;
      if (
        encoder.encode(path).length > 4096 ||
        path.split('/').length > 65 ||
        /[\\\p{Cc}]/u.test(path) ||
        path.split('/').some((p) => p === '' || p === '.' || p === '..')
      )
        throw new RangeError('invalid_git_path');
      const opened = await blobs.read(entry.oid, 64 * 1024 * 1024 - total);
      if (
        !Number.isSafeInteger(opened.size) ||
        opened.size < 0 ||
        (total += opened.size) > 64 * 1024 * 1024
      ) {
        await opened.body.cancel();
        throw new RangeError('too_large');
      }
      if (encoder.encode(path).length > 100) {
        const suffix = ` path=${path}\n`;
        const length = encoder.encode(suffix).length;
        let size = length + 1;
        while (String(size).length + length !== size) size = String(size).length + length;
        const pax = encoder.encode(String(size) + suffix);
        yield header('repository/PaxHeader', pax.length, 0o644, 'x');
        yield pax;
        yield padding(pax.length);
      }
      yield header(
        encoder.encode(path).length <= 100 ? path : 'repository/entry',
        opened.size,
        entry.mode === '100755' ? 0o755 : 0o644,
      );
      const reader = opened.body.getReader();
      let read = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          signal.throwIfAborted();
          read += next.value.length;
          if (read > opened.size) throw new RangeError('git_blob_size');
          yield next.value;
        }
        if (read !== opened.size) throw new RangeError('git_blob_size');
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      yield padding(opened.size);
    }
    yield new Uint8Array(1024);
  }
  const iterator = chunks();
  return gzipFrame(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) controller.close();
          else controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel() {
        await iterator.return();
      },
    }),
    codecs,
  );
}
