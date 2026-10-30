export class PublishValidationError extends Error {
  readonly detail: string | undefined;
  override readonly name = 'PublishValidationError';
  constructor(
    readonly code: string,
    readonly status = 400,
    options?: ErrorOptions & { detail?: string },
  ) {
    super(code, options);
    this.detail = options?.detail;
  }
}

export interface TarballWalkOptions {
  readonly name: string;
  readonly version: string | Promise<string>;
  readonly maxEntries?: number;
  readonly maxUnpackedBytes?: number;
  readonly maxExtensionBytes?: number;
  readonly maxPathBytes?: number;
  readonly maxManifestBytes?: number;
  readonly maxReadmeBytes?: number;
}
export interface TarballWalkResult {
  readonly fileCount: number;
  readonly unpackedSize: number;
  readonly manifest: Record<string, unknown>;
  readonly readme: string | null;
  readonly readmeTruncated: boolean;
}
const invalid = (detail: string): never => {
  throw new PublishValidationError('invalid_tarball', 400, { detail });
};
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
function decode(bytes: Uint8Array): string {
  try {
    return utf8.decode(bytes);
  } catch {
    return invalid('utf8');
  }
}
function text(bytes: Uint8Array): string {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some((b) => b !== 0)) invalid('nul_suffix');
  return decode(end < 0 ? bytes : bytes.subarray(0, end));
}
function octal(bytes: Uint8Array): number {
  const raw = String.fromCharCode(...bytes);
  if (!/^[ ]*[0-7]*[\0 ]+$/.test(raw)) invalid('octal');
  const value = parseInt(raw.trim().replace(/\0.*$/, ''), 8) || 0;
  return value;
}
function headerNumber(bytes: Uint8Array): number {
  if (!(bytes[0]! & 128)) return octal(bytes);
  if (bytes[0] !== 128 && bytes[0] !== 255) invalid('number_marker');
  let value = bytes[0] === 255 ? -1n : 0n;
  for (const b of bytes.subarray(1)) value = value * 256n + BigInt(b);
  const result = Number(value);
  if (!Number.isSafeInteger(result)) invalid('number_range');
  return result;
}
function records(bytes: Uint8Array): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  let at = 0;
  while (at < bytes.length) {
    const prefix = /^([1-9][0-9]{0,7}) /.exec(String.fromCharCode(...bytes.subarray(at, at + 10)));
    if (!prefix) return invalid('pax_length');
    const count = prefix[1]!;
    const space = at + count.length;
    const end = at + Number(count);
    if (end > bytes.length || end <= space + 1 || bytes[end - 1] !== 10) invalid('pax_length');
    const record = decode(bytes.subarray(space + 1, end - 1));
    const equals = record.indexOf('=');
    if (equals < 1 || record.includes('\0') || record.includes('\n')) invalid('pax_record');
    const key = record.slice(0, equals);
    if (/sparse/i.test(key)) invalid('pax_sparse');
    if (['path', 'linkpath', 'size'].includes(key)) result[key] = record.slice(equals + 1);
    at = end;
  }
  return result;
}
function effectivePath(path: string, directory: boolean, max: number): string {
  if (directory && path.endsWith('/')) path = path.slice(0, -1);
  if (
    new TextEncoder().encode(path).length > max ||
    path.includes('\0') ||
    path.includes('\\') ||
    /^[A-Za-z]:/.test(path) ||
    !(path.startsWith('package/') || (directory && path === 'package'))
  )
    invalid('path');
  if (path.split('/').some((p) => p === '' || p === '..' || p === '.' || /^[A-Za-z]:/.test(p)))
    invalid('path_segments');
  return path;
}

function limit(value: number | undefined, ceiling: number): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) invalid('limit');
  return Math.min(value ?? ceiling, ceiling);
}

export async function walkTarball(
  body: ReadableStream<Uint8Array>,
  options: TarballWalkOptions,
): Promise<TarballWalkResult> {
  const cap = limit(options.maxUnpackedBytes, 256 * 1024 * 1024);
  const maxEntries = limit(options.maxEntries, 50_000);
  const maxExtensionBytes = limit(options.maxExtensionBytes, 65536);
  const maxPathBytes = limit(options.maxPathBytes, 4096);
  const maxManifestBytes = limit(options.maxManifestBytes, 262144);
  const maxReadmeBytes = limit(options.maxReadmeBytes, 524288);
  const reader = body.getReader();
  let chunk: Uint8Array = new Uint8Array(0);
  let offset = 0,
    total = 0;
  async function take(length: number, allowEof = false): Promise<Uint8Array | null> {
    const out = new Uint8Array(length);
    let at = 0;
    while (at < length) {
      if (offset === chunk.length) {
        const next = await reader.read();
        if (next.done) {
          if (allowEof && (!at || (zeros >= 2 && out.subarray(0, at).every((b) => b === 0))))
            return null;
          return invalid('truncated');
        }
        chunk = next.value;
        offset = 0;
        total += chunk.length;
        if (total > cap) invalid('unpacked_cap');
        if (!chunk.length) continue;
      }
      const n = Math.min(length - at, chunk.length - offset);
      out.set(chunk.subarray(offset, offset + n), at);
      offset += n;
      at += n;
    }
    return out;
  }
  let local: Record<string, string> = Object.create(null) as Record<string, string>;
  const paths = new Set<string>();
  let entries = 0,
    fileCount = 0,
    unpackedSize = 0,
    zeros = 0;
  let manifest: Record<string, unknown> | null = null;
  let readme: string | null = null,
    readmeTruncated = false;
  try {
    for (;;) {
      const header = await take(512, true);
      if (!header) break;
      if (header.every((b) => b === 0)) {
        zeros++;
        continue;
      }
      if (zeros) invalid('after_end');
      if (++entries > maxEntries) invalid('entry_cap');
      const sum = header.reduce((n, b, i) => n + (i >= 148 && i < 156 ? 32 : b), 0);
      if (sum !== octal(header.subarray(148, 156))) invalid('checksum');
      for (const [start, end] of [
        [100, 108],
        [108, 116],
        [116, 124],
        [136, 148],
      ] as const)
        headerNumber(header.subarray(start, end));
      const magic = decode(header.subarray(257, 263));
      if (magic !== 'ustar\0' && magic !== 'ustar ') invalid('tar_magic');
      if (decode(header.subarray(263, 265)) !== (magic === 'ustar\0' ? '00' : ' \0'))
        invalid('tar_version');
      if (magic === 'ustar\0') {
        headerNumber(header.subarray(329, 337));
        headerNumber(header.subarray(337, 345));
        if (header[475] === 0) {
          headerNumber(header.subarray(476, 488));
          headerNumber(header.subarray(488, 500));
        }
      }
      const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]!);
      if (!['0', '5', 'x', 'g', 'L', 'K'].includes(type)) invalid('entry_type');
      const headerName = text(header.subarray(0, 100));
      const prefix =
        magic === 'ustar\0' ? text(header.subarray(345, header[475] === 0 ? 475 : 500)) : '';
      if (!headerName && !prefix) invalid('header_path');
      const headerLink = text(header.subarray(157, 257));
      if (type !== 'x' && type !== 'g' && headerLink) invalid('header_linkpath');
      if (header.subarray(124, 136).every((b) => b === 0 || b === 32)) invalid('blank_size');
      let size = headerNumber(header.subarray(124, 136));
      const extension = ['x', 'g', 'L', 'K'].includes(type);
      const attrs = local;
      if (extension && attrs.size !== undefined) invalid('pax_size_extension');
      if (!extension && attrs.size !== undefined) {
        if (!/^[0-9]+$/.test(attrs.size)) invalid('pax_size');
        size = Number(attrs.size);
      }
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > cap ||
        total - chunk.length + offset + size > cap
      )
        invalid('size_bounds');
      if (extension && size > maxExtensionBytes) invalid('extension_cap');
      let path = '';
      let capture = 0;
      if (!extension) {
        path = effectivePath(
          local.path ?? (prefix ? prefix + '/' : '') + headerName,
          type === '5',
          maxPathBytes,
        );
        if (paths.has(path)) invalid('duplicate_path');
        paths.add(path);
        if (attrs.linkpath || text(header.subarray(157, 257))) invalid('linkpath');
        if (type === '5' && size !== 0) invalid('directory_size');
        if (type === '0') {
          fileCount++;
          unpackedSize += size;
        }
        if (path === 'package/package.json') {
          if (size > maxManifestBytes) invalid('manifest_cap');
          capture = size;
        } else if (/^package\/readme[^/]*$/i.test(path) && readme === null && type === '0') {
          capture = Math.min(size, maxReadmeBytes);
          readmeTruncated = size > capture;
        }
        local = Object.create(null) as Record<string, string>;
      } else capture = size;
      const captured = new Uint8Array(capture);
      let at = 0;
      while (at < size) {
        const part = (await take(Math.min(16384, size - at)))!;
        if (at < capture) captured.set(part.subarray(0, capture - at), at);
        at += part.length;
      }
      const padding = (await take((512 - (size % 512)) % 512))!;
      if (padding.some((b) => b !== 0)) invalid('padding');
      if (extension) {
        if (type === 'x') Object.assign(local, records(captured));
        else if (type === 'g') {
          if (Object.keys(records(captured)).length) invalid('global_override');
        } else {
          if (!captured.length || captured[captured.length - 1] !== 0) invalid('gnu_terminator');
          local[type === 'L' ? 'path' : 'linkpath'] = text(captured);
        }
      } else if (path === 'package/package.json') {
        try {
          const parsed: unknown = JSON.parse(decode(captured), (_key, value: unknown) => {
            if (value && typeof value === 'object' && !Array.isArray(value))
              return Object.assign(Object.create(null) as Record<string, unknown>, value);
            return value;
          });
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            invalid('manifest_shape');
          manifest = parsed as Record<string, unknown>;
        } catch (error) {
          if (error instanceof PublishValidationError) throw error;
          invalid('manifest_json');
        }
      } else if (/^package\/readme[^/]*$/i.test(path) && readme === null && type === '0') {
        // A truncated multibyte code point is withheld until a complete UTF-8 boundary.
        try {
          readme = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(captured, {
            stream: readmeTruncated,
          });
        } catch {
          invalid('readme_utf8');
        }
        // eslint-disable-next-line no-control-regex -- ASCII controls are intentionally refused.
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(readme!)) invalid('readme_control');
      }
    }
    if (zeros < 2 || Object.keys(local).length) invalid('end_blocks');
    if (!manifest || manifest.name !== options.name || manifest.version !== (await options.version))
      throw new PublishValidationError('manifest_mismatch', 400, { detail: 'manifest_identity' });
    return { fileCount, unpackedSize, manifest, readme, readmeTruncated };
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
