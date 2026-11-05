import type { Codecs } from '../../platform/codec.js';
import { gzipFrame } from './gzip-frame.js';
import { selectPacklist } from './packlist-rules.js';
import {
  PublishValidationError,
  walkRepositoryTarball,
  type RepositoryTarEntry,
} from './tarball-walk.js';

export interface TarballPackOptions {
  /** Reopens the same immutable, uncompressed repository tar stream. */
  readonly open: () => Promise<ReadableStream<Uint8Array>>;
  readonly codecs: Pick<Codecs, 'deflateRaw'>;
  readonly maxEntries?: number;
  readonly maxUnpackedBytes?: number;
  readonly maxRuleBytes?: number;
  readonly maxOutputBytes?: number;
}
export interface TarballPackResult {
  readonly body: ReadableStream<Uint8Array>;
  readonly files: readonly string[];
  readonly readme: string | null;
  readonly readmeTruncated: boolean;
  readonly readmeFilename: string | null;
}
const encoder = new TextEncoder();
function fail(detail: string, code = 'invalid_packlist'): never {
  throw new PublishValidationError(code, 400, { detail });
}
function limit(value: number | undefined, ceiling: number): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) fail('limit');
  return Math.min(value ?? ceiling, ceiling);
}
function text(bytes: Uint8Array, truncated = false): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, {
      stream: truncated,
    });
  } catch {
    return fail('utf8');
  }
}
function header(path: string, size: number, mode: number, type = '0'): Uint8Array {
  const bytes = new Uint8Array(512);
  const put = (offset: number, value: string) => bytes.set(encoder.encode(value), offset);
  const octal = (offset: number, width: number, value: number) =>
    put(offset, value.toString(8).padStart(width - 1, '0') + '\0');
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
  const sum = bytes.reduce((n, b) => n + b, 0);
  put(148, sum.toString(8).padStart(6, '0') + '\0 ');
  return bytes;
}
const padding = (size: number) => new Uint8Array((512 - (size % 512)) % 512);
function paxPath(path: string): Uint8Array {
  const suffix = ' path=' + path + '\n';
  const bytes = encoder.encode(suffix);
  let size = bytes.length + 1;
  while (String(size).length + bytes.length !== size) size = String(size).length + bytes.length;
  return encoder.encode(String(size) + suffix);
}

export async function packTarball(options: TarballPackOptions): Promise<TarballPackResult> {
  const ruleCap = limit(options.maxRuleBytes, 4 * 1024 * 1024);
  const outputCap = limit(options.maxOutputBytes, 50_000_000);
  let retainedRuleBytes = 0;
  const entries: RepositoryTarEntry[] = [];
  const paths = new Set<string>();
  const metadata = new Map<string, { entry: RepositoryTarEntry; bytes?: Uint8Array }>();
  let readmeBytes = 0;
  const readmes = new Map<string, { bytes: Uint8Array; truncated: boolean }>();
  let readmeFilename: string | null = null;
  let readme: string | null = null,
    readmeTruncated = false;
  await walkRepositoryTarball(
    await options.open(),
    async (entry) => {
      entries.push(entry);
      if (entry.type !== '0') return;
      paths.add(entry.path);
      const base = entry.path.slice(entry.path.lastIndexOf('/') + 1);
      const ruleFile =
        entry.path === 'package.json' ||
        /(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(entry.path) ||
        base === '.npmignore' ||
        base === '.gitignore';
      const readmeFile = !entry.path.includes('/') && /^readme[^/]*$/i.test(entry.path);
      if (!ruleFile && !readmeFile) return;
      if (readmeFile) {
        readmeBytes += Math.min(entry.size, 524288);
        if (readmeBytes > 16 * 1024 * 1024) fail('packlist_budget');
      }
      if (ruleFile) {
        metadata.set(entry.path, { entry });
        const cap = base === 'package.json' ? 262144 : 4 * 1024 * 1024 - 1;
        // Speculative captures are bounded; selection can reopen uncaptured metadata.
        if (entry.size > cap || retainedRuleBytes + entry.size > ruleCap) return;
        retainedRuleBytes += entry.size;
      }
      const bytes = new Uint8Array(ruleFile ? entry.size : Math.min(entry.size, 524288));
      let at = 0;
      return {
        async write(chunk) {
          if (at < bytes.length) bytes.set(chunk.subarray(0, bytes.length - at), at);
          at += chunk.length;
        },
        async close() {
          if (ruleFile) metadata.get(entry.path)!.bytes = bytes;
          if (readmeFile) readmes.set(entry.path, { bytes, truncated: entry.size > bytes.length });
        },
      };
    },
    options,
  );
  let work = 0;
  const spendWork = (amount: number) => {
    if (amount > 2_000_000_000 - work) fail('packlist_budget');
    work += amount;
  };
  const select = () =>
    selectPacklist(paths, new Set(metadata.keys()), ruleCap, undefined, spendWork);
  let selection = select();
  let replayed = false;
  let consumedRuleBytes = 0;
  let step = selection.next();
  while (!step.done) {
    const captured = metadata.get(step.value)!;
    const manifest = captured.entry.path.endsWith('package.json');
    if (manifest && captured.entry.size > 262144) fail('manifest_cap');
    if (!manifest && captured.entry.size >= 4 * 1024 * 1024) fail('packlist_budget');
    consumedRuleBytes += captured.entry.size;
    if (consumedRuleBytes > ruleCap) fail('rule_cap');
    if (!captured.bytes) {
      if (replayed) fail('packlist_budget');
      replayed = true;
      const needed = new Set<string>();
      const discovery = select();
      let pending = discovery.next();
      let unknownManifest = false;
      while (!pending.done) {
        const path = pending.value;
        needed.add(path);
        const candidate = metadata.get(path)!;
        const manifest = path.endsWith('package.json');
        if (!candidate.bytes && manifest) unknownManifest = true;
        // Missing ignores cannot prune directories; missing manifests may reveal bundles.
        pending = discovery.next(candidate.bytes ? text(candidate.bytes) : manifest ? '{}' : '');
      }
      if (unknownManifest)
        for (const path of metadata.keys()) {
          spendWork(path.length);
          if (path.includes('node_modules/') && !metadata.get(path)!.bytes) needed.add(path);
        }
      retainedRuleBytes = 0;
      for (const [path, candidate] of metadata) {
        spendWork(path.length);
        if (!needed.has(path)) delete candidate.bytes;
        else retainedRuleBytes += candidate.bytes?.length ?? 0;
      }
      const missing = new Set([...needed].filter((path) => !metadata.get(path)!.bytes));
      let index = 0;
      await walkRepositoryTarball(
        (await options.open()).pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              spendWork(chunk.length);
              controller.enqueue(chunk);
            },
          }),
        ),
        async (entry) => {
          const expected = entries[index++];
          if (
            !expected ||
            entry.path !== expected.path ||
            entry.size !== expected.size ||
            entry.mode !== expected.mode ||
            entry.type !== expected.type
          )
            fail('archive_changed', 'archive_changed');
          if (!missing.has(entry.path)) return;
          const cap = entry.path.endsWith('package.json') ? 262144 : 4 * 1024 * 1024 - 1;
          if (entry.size > cap) return;
          if (retainedRuleBytes + entry.size > ruleCap) fail('packlist_budget');
          retainedRuleBytes += entry.size;
          const bytes = new Uint8Array(entry.size);
          let at = 0;
          return {
            async write(chunk) {
              bytes.set(chunk, at);
              at += chunk.length;
            },
            async close() {
              metadata.get(entry.path)!.bytes = bytes;
            },
          };
        },
        options,
      );
      if (index !== entries.length) fail('archive_changed', 'archive_changed');
      selection = select();
      consumedRuleBytes = 0;
      step = selection.next();
      continue;
    }
    step = selection.next(text(captured.bytes));
  }
  metadata.clear();
  const files = step.value;
  const selected = new Set(files);
  for (const [path, captured] of readmes) {
    if (!selected.has(path)) continue;
    readmeFilename = path;
    readmeTruncated = captured.truncated;
    readme = text(captured.bytes, readmeTruncated);
    // eslint-disable-next-line no-control-regex -- Match the publish readme grammar.
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(readme)) fail('readme_control');
    break;
  }
  readmes.clear();
  const abort = new AbortController();
  const raw = new TransformStream<Uint8Array, Uint8Array>();
  const writer = raw.writable.getWriter();
  let size = 0;
  const body = gzipFrame(raw.readable, options.codecs).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > outputCap) fail('output_cap');
        controller.enqueue(chunk);
      },
    }),
  );
  const finished = (async () => {
    try {
      let index = 0;
      await walkRepositoryTarball(
        await options.open(),
        async (entry) => {
          const expected = entries[index++];
          if (
            !expected ||
            entry.path !== expected.path ||
            entry.size !== expected.size ||
            entry.mode !== expected.mode ||
            entry.type !== expected.type
          )
            fail('archive_changed', 'archive_changed');
          if (entry.type !== '0' || !selected.has(entry.path)) return;
          const path = 'package/' + entry.path;
          if (encoder.encode(path).length > 100) {
            const record = paxPath(path);
            await writer.write(header('PaxHeader', record.length, 0o644, 'x'));
            await writer.write(record);
            await writer.write(padding(record.length));
          }
          await writer.write(
            header(
              encoder.encode(path).length > 100 ? 'entry' : path,
              entry.size,
              entry.mode & 0o111 ? 0o755 : 0o644,
            ),
          );
          return {
            async write(chunk) {
              await writer.write(chunk);
            },
            async close() {
              await writer.write(padding(entry.size));
            },
          };
        },
        { ...options, signal: abort.signal },
      );
      if (index !== entries.length) fail('archive_changed', 'archive_changed');
      await writer.write(new Uint8Array(1024));
      await writer.close();
    } catch (error) {
      await writer.abort(error).catch(() => {});
    } finally {
      writer.releaseLock();
    }
  })();
  void finished;
  const reader = body.getReader();
  const output = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      } catch (error) {
        abort.abort(error);
        controller.error(error);
      }
    },
    async cancel(reason) {
      abort.abort(reason);
      await reader.cancel(reason);
    },
  });
  return { body: output, files, readme, readmeTruncated, readmeFilename };
}
