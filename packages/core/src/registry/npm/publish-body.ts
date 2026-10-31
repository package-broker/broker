import { packageKey } from '../../catalogue/names.js';
import { validateVersion } from '../../catalogue/versions.js';
import type { VersionInput } from '../../db/catalogue.js';
import {
  CodecCorruptError,
  CodecTruncatedError,
  CodecLimitError,
  formatIntegrity,
  type Codecs,
} from '../../platform/codec.js';
import { PublishValidationError, walkTarball, type TarballWalkResult } from './tarball-walk.js';
import { npmVersionInput, type NpmVersionOrigin } from './version-object.js';

export interface PublishBodyCaps {
  readonly publishBodyBytes?: number;
  readonly publishMetadataBytes?: number;
  readonly publishTarballBytes?: number;
}
export interface PublishBodyOptions {
  readonly name: string;
  readonly caps?: PublishBodyCaps;
  readonly onTarballChunk: (bytes: Uint8Array, signal?: AbortSignal) => Promise<void>;
  readonly signal?: AbortSignal;
}
export interface PublishBodyResult {
  readonly metadata: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
  readonly version: string;
  readonly tarballBytes: number;
}
function fail(code = 'invalid_json', status = 400): never {
  throw new PublishValidationError(code, status);
}
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

async function deliver(
  options: PublishBodyOptions,
  bytes: Uint8Array,
  signal = options.signal,
): Promise<void> {
  try {
    await deliverToSink(options, bytes, signal);
  } catch (error) {
    if (error instanceof PublishValidationError) throw error;
    throw new PublishValidationError('staging_failed', 503, { cause: error });
  }
}

function deliverToSink(
  options: PublishBodyOptions,
  bytes: Uint8Array,
  signal = options.signal,
): Promise<void> {
  if (!signal) return options.onTarballChunk(bytes);
  return new Promise<void>((resolve, reject) => {
    const cancel = () => {
      signal.removeEventListener('abort', cancel);
      reject(
        signal.reason instanceof PublishValidationError
          ? signal.reason
          : new PublishValidationError('publish_cancelled'),
      );
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    let pending: Promise<void>;
    try {
      pending = options.onTarballChunk(bytes, signal);
    } catch (error) {
      signal.removeEventListener('abort', cancel);
      reject(error);
      return;
    }
    void pending.then(
      () => {
        signal.removeEventListener('abort', cancel);
        resolve();
      },
      (error) => {
        signal.removeEventListener('abort', cancel);
        reject(error);
      },
    );
  });
}

class JsonInput {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private at = 0;
  private wire = 0;
  private metadata = 0;
  private nodes = 0;
  private countNode(): void {
    if (++this.nodes > 100_000) fail('publish_metadata_too_large', 413);
  }
  private readonly abort: () => void;
  constructor(
    body: ReadableStream<Uint8Array>,
    private readonly options: PublishBodyOptions,
  ) {
    this.reader = body.getReader();
    this.abort = () => {
      void this.reader.cancel(new PublishValidationError('publish_cancelled')).catch(() => {});
    };
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }
  async ready(): Promise<boolean> {
    if (this.options.signal?.aborted) fail('publish_cancelled');
    while (this.at === this.chunk.length) {
      const next = await this.reader.read();
      if (this.options.signal?.aborted) fail('publish_cancelled');
      if (next.done) return false;
      this.chunk = next.value;
      this.at = 0;
    }
    return true;
  }
  private advance(n: number, attachment = false): void {
    this.wire += n;
    if (this.wire > (this.options.caps?.publishBodyBytes ?? 80_000_000))
      fail('publish_body_too_large', 413);
    if (!attachment) {
      this.metadata += n;
      if (this.metadata > (this.options.caps?.publishMetadataBytes ?? 10_000_000))
        fail('publish_metadata_too_large', 413);
    }
    this.at += n;
  }
  consume(n: number, attachment = false): Uint8Array {
    const bytes = this.chunk.subarray(this.at, this.at + n);
    this.advance(n, attachment);
    return bytes;
  }
  private consumeByte(attachment = false): number {
    const byte = this.chunk[this.at]!;
    this.advance(1, attachment);
    return byte;
  }
  async peek(): Promise<number> {
    return (await this.ready()) ? this.chunk[this.at]! : -1;
  }
  async byte(attachment = false): Promise<number> {
    if (!(await this.ready())) return fail();
    return this.consumeByte(attachment);
  }
  async expect(value: number): Promise<void> {
    if ((await this.byte()) !== value) fail();
  }
  private needsWhitespace(): boolean {
    return this.at === this.chunk.length || [32, 9, 10, 13].includes(this.chunk[this.at]!);
  }
  async whitespace(): Promise<void> {
    if (this.at < this.chunk.length && ![32, 9, 10, 13].includes(this.chunk[this.at]!)) return;
    while (await this.ready()) {
      let end = this.at;
      while ([32, 9, 10, 13].includes(this.chunk[end] ?? -1)) end++;
      this.advance(end - this.at);
      if (end < this.chunk.length) return;
    }
  }
  private inlineString(): string | undefined {
    if (this.at < this.chunk.length && this.chunk[this.at] === 34) {
      let end = this.at + 1;
      while (
        end < this.chunk.length &&
        this.chunk[end]! >= 32 &&
        this.chunk[end] !== 34 &&
        this.chunk[end] !== 92
      )
        end++;
      if (this.chunk[end] === 34) {
        const bytes = this.chunk.subarray(this.at + 1, end);
        this.advance(end - this.at + 1);
        try {
          return decoder.decode(bytes);
        } catch {
          return fail();
        }
      }
    }
    return undefined;
  }
  async string(emit?: (part: string) => Promise<void>): Promise<string> {
    if (!emit) {
      const inline = this.inlineString();
      if (inline !== undefined) return inline;
    }
    await this.expect(34);
    let buffer: Uint8Array = new Uint8Array(32);
    let size = 0;
    const append = (bytes: Uint8Array) => {
      if (size + bytes.length > buffer.length) {
        const grown = new Uint8Array(Math.max(buffer.length * 2, size + bytes.length));
        grown.set(buffer.subarray(0, size));
        buffer = grown;
      }
      buffer.set(bytes, size);
      size += bytes.length;
    };
    for (;;) {
      if (!(await this.ready())) fail();
      let end = this.at;
      while (
        end < this.chunk.length &&
        this.chunk[end]! >= 32 &&
        this.chunk[end] !== 34 &&
        this.chunk[end] !== 92 &&
        end - this.at < 16384
      )
        end++;
      if (end > this.at) {
        const part = this.consume(end - this.at, !!emit);
        if (emit) {
          await emit(String.fromCharCode(...part));
        } else {
          append(part);
        }
        continue;
      }
      const byte = await this.byte(!!emit);
      if (byte === 34) break;
      if (byte !== 92) fail();
      const escape = await this.byte(!!emit);
      let raw = '\\' + String.fromCharCode(escape);
      if (escape === 117)
        for (let i = 0; i < 4; i++) raw += String.fromCharCode(await this.byte(!!emit));
      let decoded: string;
      try {
        decoded = JSON.parse('"' + raw + '"') as string;
      } catch {
        return fail();
      }
      if (emit) await emit(decoded);
      else {
        append(encoder.encode(raw));
      }
    }
    if (emit) return '';
    try {
      return JSON.parse('"' + decoder.decode(buffer.subarray(0, size)) + '"') as string;
    } catch {
      return fail();
    }
  }
  async value(depth = 0, kind = ''): Promise<unknown> {
    this.countNode();
    if (this.needsWhitespace()) await this.whitespace();
    const start = this.at < this.chunk.length ? this.chunk[this.at]! : await this.peek();
    if (start === 34) return this.string();
    if (start === 123 || start === 91) {
      if (depth >= 32) fail();
      if (this.at < this.chunk.length) this.advance(1);
      else await this.byte();
      if (this.needsWhitespace()) await this.whitespace();
      const close = start === 123 ? 125 : 93;
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const array: unknown[] = [];
      if ((this.at < this.chunk.length ? this.chunk[this.at]! : await this.peek()) === close) {
        if (this.at < this.chunk.length) this.advance(1);
        else await this.byte();
        return start === 123 ? result : array;
      }
      let keys = 0;
      for (;;) {
        if (start === 123) {
          if (++keys > 10_000) fail('publish_metadata_too_large', 413);
          this.countNode();
          const key = this.inlineString() ?? (await this.string());
          if (Object.hasOwn(result, key))
            fail(
              kind === 'attachments' ||
                (kind === 'attachment' && key === 'data') ||
                (depth === 0 && key === '_attachments')
                ? 'invalid_attachments'
                : 'invalid_json',
            );
          if (kind === 'attachment' && !['content_type', 'data', 'length'].includes(key))
            fail('invalid_attachments');
          if (kind === 'attachments') {
            if (key.endsWith('.sigstore')) fail('provenance_unsupported');
            if (Object.keys(result).length) fail('invalid_attachments');
          }
          if (this.needsWhitespace()) await this.whitespace();
          if (this.at < this.chunk.length) {
            if (this.consumeByte() !== 58) fail();
          } else await this.expect(58);
          if (this.needsWhitespace()) await this.whitespace();
          if (kind === 'attachment' && key === 'data') {
            this.countNode();
            await this.base64();
            result[key] = null;
          } else {
            const childKind =
              depth === 0 && key === '_attachments'
                ? 'attachments'
                : kind === 'attachments'
                  ? 'attachment'
                  : kind === 'attachment' || kind === 'attachmentMetadata'
                    ? 'attachmentMetadata'
                    : '';
            if (
              ['attachments', 'attachment'].includes(childKind) &&
              (this.at < this.chunk.length ? this.chunk[this.at]! : await this.peek()) !== 123
            )
              fail('invalid_attachments');
            if (
              this.chunk[this.at] === 110 &&
              this.chunk[this.at + 1] === 117 &&
              this.chunk[this.at + 2] === 108 &&
              this.chunk[this.at + 3] === 108 &&
              [32, 9, 10, 13, 44, 125].includes(this.chunk[this.at + 4] ?? -1)
            ) {
              this.countNode();
              this.advance(4);
              result[key] = null;
            } else result[key] = await this.value(depth + 1, childKind);
          }
        } else array.push(await this.value(depth + 1, kind));
        if (this.needsWhitespace()) await this.whitespace();
        const next = this.at < this.chunk.length ? this.consumeByte()! : await this.byte();
        if (next === close) break;
        if (next !== 44) fail();
        if (this.needsWhitespace()) await this.whitespace();
      }
      return start === 123 ? result : array;
    }
    let token = '';
    let end = this.at;
    while (end < this.chunk.length && ![32, 9, 10, 13, 44, 93, 125].includes(this.chunk[end]!))
      end++;
    if (end < this.chunk.length) {
      if (end - this.at > 1024) fail();
      token = String.fromCharCode(...this.consume(end - this.at));
    } else {
      while (await this.ready()) {
        const next = this.chunk[this.at]!;
        if ([32, 9, 10, 13, 44, 93, 125].includes(next)) break;
        if (token.length >= 1024) fail();
        token += String.fromCharCode(await this.byte());
      }
    }
    if (!/^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(token))
      fail();
    const value: unknown = JSON.parse(token);
    if (typeof value === 'number' && !Number.isFinite(value)) fail();
    return value;
  }
  tarballBytes = 0;
  private async base64(): Promise<void> {
    if ((await this.peek()) !== 34) fail('invalid_attachments');
    let pending = '',
      ended = false;
    await this.string(async (part) => {
      if (ended && part.length) fail('invalid_attachments');
      pending += part;
      const complete = pending.length - (pending.length % 4);
      if (!complete) return;
      const encoded = pending.slice(0, complete);
      pending = pending.slice(complete);
      let binary: string;
      try {
        binary = atob(encoded);
      } catch {
        return fail('invalid_attachments');
      }
      if (btoa(binary) !== encoded) fail('invalid_attachments');
      ended = encoded.endsWith('=');
      this.tarballBytes += binary.length;
      if (this.tarballBytes > (this.options.caps?.publishTarballBytes ?? 50_000_000))
        fail('tarball_too_large', 413);
      if (binary.length)
        await deliver(
          this.options,
          Uint8Array.from(binary, (c) => c.charCodeAt(0)),
        );
    });
    if (pending.length) fail('invalid_attachments');
  }
  async close(error?: unknown): Promise<void> {
    this.options.signal?.removeEventListener('abort', this.abort);
    if (error !== undefined) await this.reader.cancel(error).catch(() => {});
    this.reader.releaseLock();
  }
}

export async function scanPublishBody(
  body: ReadableStream<Uint8Array>,
  options: PublishBodyOptions,
): Promise<PublishBodyResult> {
  const input = new JsonInput(body, options);
  try {
    try {
      packageKey(options.name, { ecosystem: 'npm' });
    } catch {
      return fail('invalid_name');
    }
    const metadata = await input.value();
    await input.whitespace();
    if ((await input.peek()) !== -1) fail();
    if (!object(metadata)) fail();
    if (!object(metadata._attachments)) fail('write_unsupported', 405);
    if (!object(metadata.versions) || Object.keys(metadata.versions).length !== 1)
      fail('invalid_version');
    const version = Object.keys(metadata.versions)[0]!;
    try {
      validateVersion({ ecosystem: 'npm', version, versionNormalized: version });
    } catch {
      return fail('invalid_version');
    }
    const manifest = metadata.versions[version];
    if (!object(manifest) || manifest.version !== version) fail('invalid_version');
    if (
      manifest.name !== options.name ||
      (metadata.name !== undefined && metadata.name !== options.name)
    )
      fail('manifest_mismatch');
    const attachmentKey = Object.keys(metadata._attachments)[0]!;
    const attachment = metadata._attachments[attachmentKey];
    if (
      !object(attachment) ||
      !Object.hasOwn(attachment, 'data') ||
      input.tarballBytes === 0 ||
      (attachment.length !== undefined && attachment.length !== input.tarballBytes)
    )
      fail('invalid_attachments');
    if (attachmentKey !== `${options.name}-${version}.tgz`) fail('invalid_attachment');
    delete metadata._attachments;
    await input.close();
    return { metadata, manifest, version, tarballBytes: input.tarballBytes };
  } catch (error) {
    await input.close(error);
    if (error instanceof PublishValidationError) throw error;
    return fail('invalid_publish_body');
  }
}

export interface ValidatePublishBodyOptions extends PublishBodyOptions {
  readonly codecs: Pick<Codecs, 'digestTap' | 'gunzip'>;
  readonly origin: NpmVersionOrigin;
  readonly tarballUrl: string | ((version: string) => string);
  readonly requireLicense?: boolean;
}
export interface ValidatedPublishBody extends PublishBodyResult {
  readonly archive: TarballWalkResult;
  readonly digests: Record<'sha1' | 'sha256' | 'sha512', Uint8Array>;
  readonly input: VersionInput;
  readonly readme: string | null;
  readonly readmeTruncated: boolean;
}
function readmeText(value: string): { readme: string; readmeTruncated: boolean } {
  const bytes = encoder.encode(value);
  const readmeTruncated = bytes.length > 524288;
  const readme = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes.subarray(0, 524288),
    {
      stream: readmeTruncated,
    },
  );
  // eslint-disable-next-line no-control-regex -- ASCII controls are intentionally refused.
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(readme)) fail('invalid_readme');
  return { readme, readmeTruncated };
}

function tarballCodecFailure(error: unknown): never {
  if (
    error instanceof CodecCorruptError ||
    error instanceof CodecTruncatedError ||
    error instanceof CodecLimitError
  )
    throw new PublishValidationError('invalid_tarball', 400, { cause: error });
  throw error;
}

/** The sink receives a cancellation signal and must discard staging if validation rejects. */
async function validatePublishBodyInner(
  body: ReadableStream<Uint8Array>,
  options: ValidatePublishBodyOptions,
): Promise<ValidatedPublishBody> {
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  const unzip = options.codecs.gunzip(256 * 1024 * 1024);
  const tap = options.codecs.digestTap(['sha1', 'sha256', 'sha512'] as const);
  const pipe = new TransformStream<Uint8Array, Uint8Array>(
    undefined,
    new ByteLengthQueuingStrategy({ highWaterMark: 262144 }),
    new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
  );
  const hashWriter = tap.transform.writable.getWriter();
  const tarWriter = pipe.writable.getWriter();
  const requestReader = body.getReader();
  const request = new ReadableStream<Uint8Array>(
    {
      async pull(c) {
        const next = await requestReader.read();
        if (next.done) c.close();
        else c.enqueue(next.value);
      },
      cancel: (reason) => requestReader.cancel(reason),
    },
    { highWaterMark: 0 },
  );
  const cancel = () => {
    void requestReader.cancel(signal.reason).catch(() => {});
    void hashWriter.abort(signal.reason).catch(() => {});
    void tarWriter.abort(signal.reason).catch(() => {});
  };
  signal.addEventListener('abort', cancel, { once: true });
  const draining = tap.transform.readable.pipeTo(
    new WritableStream<Uint8Array>({ write: (bytes) => deliver(options, bytes, signal) }),
    { signal },
  );
  let resolveVersion!: (version: string) => void;
  const expectedVersion = new Promise<string>((resolve) => {
    resolveVersion = resolve;
  });
  const archiveTask = walkTarball(pipe.readable.pipeThrough(unzip, { signal }), {
    name: options.name,
    version: expectedVersion,
  });
  let capturedArchive: TarballWalkResult | undefined;
  const archiveResult = archiveTask.catch(tarballCodecFailure);
  const tasks = [draining, tap.digests, archiveResult];
  for (const task of tasks)
    void task.catch((error) => {
      abort.abort(error);
    });
  try {
    signal.throwIfAborted();
    const scanned = await scanPublishBody(request, {
      ...options,
      signal,
      onTarballChunk: async (bytes) => {
        signal.throwIfAborted();
        await Promise.all([
          hashWriter.write(bytes),
          tarWriter.write(bytes).catch(tarballCodecFailure),
        ]);
      },
    });
    resolveVersion(scanned.version);
    await Promise.all([hashWriter.close(), tarWriter.close()]);
    await draining;
    capturedArchive = await archiveResult;
    const digests = await tap.digests;
    const dist = scanned.manifest.dist;
    if (dist !== undefined && !object(dist)) fail('integrity_mismatch');
    if (object(dist)) {
      const sha1 = Array.from(digests.sha1, (b) => b.toString(16).padStart(2, '0')).join('');
      if (
        dist.shasum !== undefined &&
        (typeof dist.shasum !== 'string' || dist.shasum.toLowerCase() !== sha1)
      )
        fail('integrity_mismatch');
      if (dist.integrity !== undefined) {
        if (typeof dist.integrity !== 'string' || !dist.integrity.trim())
          fail('integrity_mismatch');
        for (const token of dist.integrity.trim().split(/\s+/)) {
          if (
            token !== formatIntegrity('sha1', digests.sha1) &&
            token !== formatIntegrity('sha512', digests.sha512)
          )
            fail('integrity_mismatch');
        }
      }
    }
    const tags = scanned.metadata['dist-tags'];
    if (tags !== undefined) {
      if (!object(tags)) fail('invalid_tags');
      if (Object.keys(tags).length > 8) fail('too_many_tags');
      for (const [tag, version] of Object.entries(tags))
        if (
          !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tag) ||
          version !== scanned.version ||
          /^\d+\.\d+\.\d+/.test(tag)
        )
          fail('invalid_tags');
    }
    const normalized = npmVersionInput(
      options.name,
      {
        ...scanned.manifest,
        dist: {
          tarball:
            typeof options.tarballUrl === 'function'
              ? options.tarballUrl(scanned.version)
              : options.tarballUrl,
          integrity: formatIntegrity('sha512', digests.sha512),
          shasum: Array.from(digests.sha1, (b) => b.toString(16).padStart(2, '0')).join(''),
          fileCount: capturedArchive.fileCount,
          unpackedSize: capturedArchive.unpackedSize,
        },
      },
      undefined,
      options.origin,
    );
    if (!normalized.ok)
      fail(
        normalized.reason === 'too_large' ? 'manifest_too_large' : 'invalid_manifest',
        normalized.reason === 'too_large' ? 413 : 400,
      );
    if (options.requireLicense && normalized.input.license === null) fail('license_missing');
    const suppliedReadme = scanned.manifest.readme ?? scanned.metadata.readme;
    if (
      suppliedReadme !== undefined &&
      suppliedReadme !== null &&
      typeof suppliedReadme !== 'string'
    )
      fail('invalid_readme');
    const readme =
      typeof suppliedReadme === 'string'
        ? readmeText(suppliedReadme)
        : { readme: capturedArchive.readme, readmeTruncated: capturedArchive.readmeTruncated };
    return { ...scanned, archive: capturedArchive, digests, input: normalized.input, ...readme };
  } catch (error) {
    resolveVersion('');
    abort.abort(error);
    await Promise.allSettled(tasks);
    if (options.signal?.aborted) throw new PublishValidationError('publish_cancelled');
    const failure = signal.reason ?? error;
    if (failure instanceof PublishValidationError) throw failure;
    throw new PublishValidationError('staging_failed', 503, { cause: failure });
  } finally {
    signal.removeEventListener('abort', cancel);
    requestReader.releaseLock();
    hashWriter.releaseLock();
    tarWriter.releaseLock();
  }
}

export async function validatePublishBody(
  body: ReadableStream<Uint8Array>,
  options: ValidatePublishBodyOptions,
): Promise<ValidatedPublishBody> {
  try {
    return await validatePublishBodyInner(body, options);
  } catch (error) {
    if (error instanceof PublishValidationError) throw error;
    throw new PublishValidationError('staging_failed', 503, { cause: error });
  }
}
