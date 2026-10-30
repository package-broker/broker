import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

// Keep this generator standalone: its independent Buffer-based writer checks the
// TypeScript test builder against real stored bytes without a TS loader or walker import.
const root = new URL('./adversarial/', import.meta.url);
await mkdir(root, { recursive: true });
const manifest = JSON.stringify({ name: 'test-package', version: '1.0.0' });
const join = (...parts) => Buffer.concat(parts.map((p) => Buffer.from(p)));
function checksum(bytes) {
  bytes.fill(32, 148, 156);
  const sum = bytes.subarray(0, 512).reduce((n, b) => n + b, 0);
  bytes.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return bytes;
}
function entry(path, body = '', type = '0') {
  const data = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(path, 0, 100);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
  header.write('00000000000\0', 136);
  header.write(type, 156);
  header.write('ustar\0' + '00', 257);
  return join(checksum(header), data, Buffer.alloc((512 - (data.length % 512)) % 512));
}
function pax(key, value) {
  const body = ` ${key}=${value}\n`;
  let size = Buffer.byteLength(body) + 1;
  while (String(size).length + Buffer.byteLength(body) !== size)
    size = String(size).length + Buffer.byteLength(body);
  return `${size}${body}`;
}
const good = () => entry('package/package.json', manifest);
const archive = (...parts) => join(...parts, Buffer.alloc(1024));
const cases = [];
async function add(id, bytes, code = 'invalid_tarball', options = {}) {
  await writeFile(new URL(id + '.tgz', root), gzipSync(bytes));
  const reason = reasonFor(id);
  if (!reason) throw new Error('Missing guard reason for ' + id);
  cases.push({ id, code, options, reason });
}
function reasonFor(id) {
  if (id.startsWith('type-')) return 'entry_type';
  if (id.startsWith('override-g-') || id.startsWith('global-')) return 'global_override';
  if (id.startsWith('path-') || id.startsWith('override-')) {
    return /(?:traversal|empty|dot)$/.test(id) ? 'path_segments' : 'path';
  }
  if (id.startsWith('octal-')) return 'octal';
  return {
    checksum: 'checksum',
    magic: 'tar_magic',
    version: 'tar_version',
    padding: 'padding',
    'negative-size': 'size_bounds',
    'unsafe-size': 'number_range',
    'nul-path': 'nul_suffix',
    'utf8-path': 'utf8',
    'link-name': 'header_linkpath',
    duplicate: 'duplicate_path',
    'missing-manifest': 'manifest_identity',
    'manifest-identity': 'manifest_identity',
    'manifest-json': 'manifest_json',
    'manifest-array': 'manifest_shape',
    'directory-size': 'directory_size',
    'one-end-block': 'end_blocks',
    'no-end-block': 'end_blocks',
    'header-after-end': 'after_end',
    'nonzero-trailer': 'truncated',
    truncated: 'truncated',
    'pax-length': 'pax_length',
    'pax-decimal': 'pax_length',
    'pax-equals': 'pax_record',
    'pax-nul': 'pax_record',
    'pax-sparse': 'pax_sparse',
    'pax-size': 'pax_size',
    'pax-negative': 'pax_size',
    'pax-fraction': 'pax_size',
    'pax-unsafe': 'size_bounds',
    'pax-link': 'linkpath',
    'gnu-link': 'linkpath',
    'gnu-unterminated': 'gnu_terminator',
    'dangling-extension': 'end_blocks',
    'readme-control': 'readme_control',
    'readme-utf8': 'readme_utf8',
    'entry-cap': 'entry_cap',
    'unpacked-cap': 'unpacked_cap',
    'path-cap': 'path',
    'manifest-cap': 'manifest_cap',
    'extension-cap': 'extension_cap',
    'nul-suffix': 'nul_suffix',
    'number-marker': 'number_marker',
    'pax-length-grammar': 'pax_length',
    'pax-nul-unknown': 'pax_record',
    'unterminated-size': 'octal',
    'pax-newline': 'pax_record',
    'pax-newline-unknown': 'pax_record',
    'empty-extension': 'header_path',
    'extension-link': 'header_linkpath',
    'gnu-version': 'tar_version',
    'blank-size': 'blank_size',
  }[id];
}
await writeFile(new URL('good.tgz', root), gzipSync(archive(good())));
for (const type of ['1', '2', '3', '4', '6', '7', 'S', 'Z'])
  await add('type-' + type, archive(good(), entry('package/bad', '', type)));
for (const [id, path] of Object.entries({
  outside: 'other/file',
  absolute: '/package/file',
  drive: 'C:/package/file',
  traversal: 'package/../file',
  empty: 'package//file',
  dot: 'package/./file',
  backslash: 'package/\\file',
})) {
  await add('path-' + id, archive(good(), entry(path)));
  for (const type of ['x', 'g', 'L'])
    await add(
      'override-' + type + '-' + id,
      archive(entry('extension', type === 'L' ? path + '\0' : pax('path', path), type), good()),
    );
}
for (const [id, offset] of Object.entries({
  mode: 100,
  uid: 108,
  gid: 116,
  mtime: 136,
  size: 124,
})) {
  const bytes = good();
  bytes[offset] = 57;
  await add('octal-' + id, archive(checksum(bytes)));
}
for (const [id, mutate] of Object.entries({
  checksum: (b) => {
    b[500] = 1;
  },
  magic: (b) => {
    b[257] = 0;
    checksum(b);
  },
  version: (b) => {
    b[263] = 57;
    checksum(b);
  },
  padding: (b) => {
    b[512 + Buffer.byteLength(manifest)] = 1;
  },
  'negative-size': (b) => {
    b.fill(255, 124, 136);
    checksum(b);
  },
  'unsafe-size': (b) => {
    b.fill(255, 124, 136);
    b[124] = 128;
    checksum(b);
  },
  'nul-path': (b) => {
    b[8] = 0;
    checksum(b);
  },
  'utf8-path': (b) => {
    b[8] = 255;
    checksum(b);
  },
  'link-name': (b) => {
    b[157] = 97;
    checksum(b);
  },
})) {
  const bytes = good();
  mutate(bytes);
  await add(id, archive(bytes));
}
await add('duplicate', archive(good(), good()));
await add('missing-manifest', archive(entry('package/file')), 'manifest_mismatch');
await add('manifest-identity', archive(entry('package/package.json', '{}')), 'manifest_mismatch');
await add('manifest-json', archive(entry('package/package.json', '{')));
await add('manifest-array', archive(entry('package/package.json', '[]')));
await add('directory-size', archive(good(), entry('package/folder/', 'x', '5')));
await add('one-end-block', join(good(), Buffer.alloc(512)));
await add('no-end-block', good());
await add('header-after-end', join(Buffer.alloc(512), good(), Buffer.alloc(1024)));
await add('nonzero-trailer', join(archive(good()), Buffer.from([1])));
await add('truncated', good().subarray(0, 530));
for (const [id, body] of Object.entries({
  length: '99 ignored=x\n',
  decimal: 'x path=a\n',
  equals: '4 x\n',
  nul: pax('path', 'package/a\0b'),
  sparse: pax('GNU.sparse.map', '0,1'),
  size: pax('size', 'no'),
  negative: pax('size', '-1'),
  fraction: pax('size', Buffer.byteLength(manifest) + '.0'),
  unsafe: pax('size', '99999999999999999'),
}))
  await add('pax-' + id, archive(entry('extension', body, 'x'), good()));
await add('pax-link', archive(entry('extension', pax('linkpath', 'package/a'), 'x'), good()));
await add('gnu-link', archive(entry('extension', 'package/a\0', 'K'), good()));
await add('gnu-unterminated', archive(entry('extension', 'package/a', 'L'), good()));
await add('dangling-extension', archive(good(), entry('extension', pax('path', 'package/a'), 'x')));
await add('readme-control', archive(good(), entry('package/README', 'a\x01b')));
await add('readme-utf8', archive(good(), entry('package/README', Buffer.from([255]))));
await add('entry-cap', archive(good(), entry('package/a')), 'invalid_tarball', { maxEntries: 1 });
await add('unpacked-cap', archive(good()), 'invalid_tarball', { maxUnpackedBytes: 1024 });
await add('path-cap', archive(good()), 'invalid_tarball', { maxPathBytes: 4 });
await add('manifest-cap', archive(good()), 'invalid_tarball', { maxManifestBytes: 4 });
await add(
  'extension-cap',
  archive(entry('extension', pax('path', 'package/a'), 'x'), good()),
  'invalid_tarball',
  { maxExtensionBytes: 4 },
);
const nulSuffix = good();
nulSuffix[25] = 97;
await add('nul-suffix', archive(checksum(nulSuffix)));
const invalidMarker = good();
invalidMarker.fill(0, 108, 116);
invalidMarker[108] = 129;
await add('number-marker', archive(checksum(invalidMarker)));
await add('pax-length-grammar', archive(entry('extension', '9.0 kk=x\n', 'x'), good()));
await add('pax-nul-unknown', archive(entry('extension', pax('ignored', 'a\0b'), 'x'), good()));
const unterminated = good();
unterminated.write(Buffer.byteLength(manifest).toString(8).padStart(12, '0'), 124);
await add('unterminated-size', archive(checksum(unterminated)));
await add(
  'global-path-disguise',
  archive(
    entry('extension', pax('path', 'package/package.json'), 'g'),
    entry('../outside', manifest),
  ),
);
await add(
  'global-alias-duplicate',
  archive(entry('extension', pax('path', 'package/alias'), 'g'), good(), entry('package/other')),
);
await add(
  'pax-newline',
  archive(
    entry('extension', pax('path', 'package/a\n' + pax('path', 'package/b').trimEnd()), 'x'),
    good(),
  ),
);
await add('pax-newline-unknown', archive(entry('extension', pax('comment', 'a\nb'), 'x'), good()));
await add('empty-extension', archive(entry('', pax('comment', 'ok'), 'x'), good()));
const extensionLink = entry('extension', 'package/package.json\0', 'L');
extensionLink[157] = 97;
await add('extension-link', archive(checksum(extensionLink), good()));
const gnuVersion = good();
gnuVersion[262] = 32;
await add('gnu-version', archive(checksum(gnuVersion)));
const blankSize = entry('package/empty');
blankSize.fill(32, 124, 136);
await add('blank-size', archive(good(), checksum(blankSize)));
await writeFile(new URL('cases.json', root), JSON.stringify(cases, null, 2) + '\n');
