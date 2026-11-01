import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import type { Codecs } from '../../platform/codec.js';
import { scanPublishBody, validatePublishBody } from './publish-body.js';
import { PublishValidationError } from './tarball-walk.js';
import { entry, join, stream, manifest } from '../../test-support/npm-publish.js';

const enc = new TextEncoder();
const options = { name: 'test-package' };
const data = btoa('abc');
function body(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-package',
    versions: { '1.0.0': { name: 'test-package', version: '1.0.0' } },
    'dist-tags': { latest: '1.0.0' },
    _attachments: { 'test-package-1.0.0.tgz': { data, length: 3 } },
    ...overrides,
  };
}
const scan = (value: unknown, extra = {}) =>
  scanPublishBody(
    stream(enc.encode(typeof value === 'string' ? value : JSON.stringify(value)), 7),
    { ...options, onTarballChunk: async () => {}, ...extra },
  );
const runtimeNode = '../../../../runtime-node/src/codec/node-codec.ts';
const runtimeWorkers = '../../../../runtime-cloudflare/src/codec/workers-codec.ts';
const { nodeCodecs } = (await import(new URL(runtimeNode, import.meta.url).href)) as {
  nodeCodecs: Codecs;
};
const { workersCodecs } = (await import(new URL(runtimeWorkers, import.meta.url).href)) as {
  workersCodecs: Codecs;
};
// Node supplies the DigestStream primitive; the production Workers digest tap runs unchanged.
class NodeDigestStream extends WritableStream<Uint8Array> {
  readonly digest: Promise<ArrayBuffer>;
  constructor(algorithm: string) {
    const hash = createHash(algorithm.replace('-', '').toLowerCase());
    let resolve!: (value: ArrayBuffer) => void;
    let reject!: (reason: unknown) => void;
    const digest = new Promise<ArrayBuffer>((ok, no) => {
      resolve = ok;
      reject = no;
    });
    digest.catch(() => {});
    super({
      write: (bytes) => {
        hash.update(bytes);
      },
      close: () => {
        resolve(Uint8Array.from(hash.digest()).buffer);
      },
      abort: reject,
    });
    this.digest = digest;
  }
}
Object.defineProperty(crypto, 'DigestStream', { value: NodeDigestStream, configurable: true });
describe.each([
  ['node', nodeCodecs],
  ['workers', workersCodecs],
] as const)('%s production codecs', (_runtime, codecs) => {
  const validation = {
    ...options,
    codecs,
    origin: { importedAt: '2026-10-30T00:00:00.000Z', probe: { secrets: [], queryParams: [] } },
    tarballUrl: 'https://registry.invalid/test-package/-/test-package-1.0.0.tgz',
    onTarballChunk: async () => {},
  };
  function publish(dist: Record<string, unknown> = {}) {
    const tgz = gzipSync(
      join(
        entry('package/package.json', manifest),
        entry('package/README.md', 'archive readme'),
        new Uint8Array(1024),
      ),
    );
    return body({
      versions: { '1.0.0': { name: 'test-package', version: '1.0.0', dist } },
      _attachments: {
        'test-package-1.0.0.tgz': { data: tgz.toString('base64'), length: tgz.length },
      },
    });
  }

  it('uses both production codec functions unchanged', () => {
    const production = _runtime === 'node' ? nodeCodecs : workersCodecs;
    expect(validation.codecs.gunzip).toBe(production.gunzip);
    expect(validation.codecs.digestTap).toBe(production.digestTap);
  });

  describe('publish body scanner', () => {
    it('uses prototype-free objects and streams decoded bytes', async () => {
      const bytes: number[] = [];
      const result = await scan(body({ __proto__: null }), {
        onTarballChunk: async (chunk: Uint8Array) => {
          bytes.push(...chunk);
        },
      });
      expect(bytes).toEqual([97, 98, 99]);
      expect(Object.getPrototypeOf(result.metadata)).toBe(null);
      expect(Object.getPrototypeOf(result.manifest)).toBe(null);
      expect(JSON.stringify(result.metadata)).not.toContain(data);
      expect(result).toMatchObject({ version: '1.0.0', tarballBytes: 3 });
    });
    it.each(['{"a":1,"a":2}', '{"nested":{"a":1,"a":2}}', '{"a":1,"\\u0061":2}'])(
      'refuses duplicate keys: %s',
      async (raw) => {
        await expect(scan(raw)).rejects.toMatchObject({ code: 'invalid_json' });
      },
    );
    it.each([
      '{}x',
      '{"a":',
      '{"a":"\\x"}',
      '{"a":"\n"}',
      '{"a":01}',
      '{"a":NaN}',
      '{"a":true,}',
      '[1,]',
      '{} {}',
    ])('refuses JSON: %s', async (raw) => {
      await expect(scan(raw)).rejects.toMatchObject({ code: 'invalid_json' });
    });
    it('refuses malformed UTF-8', async () => {
      await expect(
        scanPublishBody(
          stream(join(enc.encode('{"a":"'), Uint8Array.of(0xc0, 0xaf), enc.encode('"}'))),
          { ...options, onTarballChunk: async () => {} },
        ),
      ).rejects.toMatchObject({ code: 'invalid_json' });
    });
    it('refuses excessive depth', async () => {
      await expect(
        scan(body({ extra: JSON.parse('['.repeat(33) + '0' + ']'.repeat(33)) })),
      ).rejects.toMatchObject({
        code: 'invalid_json',
      });
    });
    it.each(['YQ', 'Y===', 'YR==', 'YQ==AA==', 'Y Q==', '!!!!', 'é==='])(
      'refuses base64 %s',
      async (value) => {
        await expect(
          scan(body({ _attachments: { 'test-package-1.0.0.tgz': { data: value } } })),
        ).rejects.toMatchObject({ code: 'invalid_attachments' });
      },
    );
    it.each(['?WJj', 'YW-j', 'YW_j', 'YWJ=', '=WJj', 'YW=J', 'YQ=A', 'YQ==YWJj', 'YQ==Y', 'YQ='])(
      'rejects alphabet and padding errors across byte chunks: %s',
      async (encoded) => {
        const raw = JSON.stringify(
          body({ _attachments: { 'test-package-1.0.0.tgz': { data: encoded } } }),
        );
        await expect(
          scanPublishBody(stream(enc.encode(raw), 1), {
            ...options,
            onTarballChunk: async () => {},
          }),
        ).rejects.toMatchObject({ code: 'invalid_attachments' });
      },
    );
    it.each([1, 2, 3, 4, 5, 16383, 16384, 16385])(
      'decodes split quanta and terminal padding with chunks of %s bytes',
      async (chunkSize) => {
        const bytes = Uint8Array.from({ length: 20003 }, (_, i) => i % 256);
        const encoded = Buffer.from(bytes).toString('base64');
        const raw = JSON.stringify(
          body({
            _attachments: { 'test-package-1.0.0.tgz': { data: encoded, length: bytes.length } },
          }),
        );
        const received: Uint8Array[] = [];
        await scanPublishBody(stream(enc.encode(raw), chunkSize), {
          ...options,
          onTarballChunk: async (part) => {
            received.push(part);
          },
        });
        expect(join(...received)).toEqual(bytes);
      },
    );
    it.each(['a', 'ab', 'abc'])(
      'accepts canonical terminal padding for %s across byte chunks',
      async (text) => {
        const encoded = Buffer.from(text).toString('base64');
        const received: Uint8Array[] = [];
        await scanPublishBody(
          stream(
            enc.encode(
              JSON.stringify(
                body({
                  _attachments: {
                    'test-package-1.0.0.tgz': { data: encoded, length: text.length },
                  },
                }),
              ),
            ),
            1,
          ),
          {
            ...options,
            onTarballChunk: async (part) => {
              received.push(part);
            },
          },
        );
        expect(join(...received)).toEqual(enc.encode(text));
      },
    );
    it('accepts escaped base64 characters', async () => {
      expect(await scan(JSON.stringify(body()).replace('YWJj', '\\u0059WJj'))).toMatchObject({
        tarballBytes: 3,
      });
    });
    it.each(['data', 'attachment'])(
      'refuses duplicate %s before pulling the next chunk',
      async (kind) => {
        let reads = 0;
        const prefix =
          kind === 'data'
            ? '{"_attachments":{"a":{"data":"YQ==","data"'
            : '{"_attachments":{"a":{"data":"YQ=="},"b"';
        const source = new ReadableStream<Uint8Array>(
          {
            pull(c) {
              reads++;
              if (reads === 1) c.enqueue(enc.encode(prefix));
              else throw new Error('read beyond duplicate');
            },
          },
          { highWaterMark: 0 },
        );
        await expect(
          scanPublishBody(source, { ...options, onTarballChunk: async () => {} }),
        ).rejects.toMatchObject({ code: 'invalid_attachments' });
        expect(reads).toBe(1);
      },
    );
    it.each([{}, { a: {} }, { a: { data: 1 } }, { a: { data: data, length: 4 } }])(
      'refuses attachment shape %j',
      async (attachments) => {
        await expect(scan(body({ _attachments: attachments }))).rejects.toMatchObject({
          code: 'invalid_attachments',
        });
      },
    );
    it('refuses provenance before reading its value', async () => {
      await expect(scan('{"_attachments":{"a.sigstore"')).rejects.toMatchObject({
        code: 'provenance_unsupported',
      });
    });
    it('requires the full scoped attachment key', async () => {
      const scoped = body({
        name: '@scope/name',
        versions: { '1.0.0': { name: '@scope/name', version: '1.0.0' } },
        _attachments: { '@scope/name-1.0.0.tgz': { data } },
      });
      expect(await scan(scoped, { name: '@scope/name' })).toMatchObject({ version: '1.0.0' });
      await expect(scan(body({ _attachments: { 'wrong.tgz': { data } } }))).rejects.toMatchObject({
        code: 'invalid_attachment',
      });
    });
    it.each(['1.0.0+build', 'v1.0.0', '01.0.0', '1.0'])('refuses version %s', async (version) => {
      await expect(
        scan(body({ versions: { [version]: { name: 'test-package', version } } })),
      ).rejects.toMatchObject({ code: 'invalid_version' });
    });
    it.each([{ publishBodyBytes: 1 }, { publishMetadataBytes: 1 }, { publishTarballBytes: 2 }])(
      'enforces caps %j',
      async (caps) => {
        await expect(scan(body(), { caps })).rejects.toMatchObject({ status: 413 });
      },
    );
    it('excludes attachment data from the metadata cap', async () => {
      const value = body({
        _attachments: { 'test-package-1.0.0.tgz': { data: btoa('a'.repeat(10000)) } },
      });
      expect(await scan(value, { caps: { publishMetadataBytes: 500 } })).toMatchObject({
        tarballBytes: 10000,
      });
    });
    it('awaits the sink and cancels the source on sink failure', async () => {
      let cancelled = false;
      const bytes = enc.encode(JSON.stringify(body()));
      const source = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(bytes);
        },
        cancel() {
          cancelled = true;
        },
      });
      await expect(
        scanPublishBody(source, {
          ...options,
          onTarballChunk: async () => {
            throw new Error('sink failed');
          },
        }),
      ).rejects.toMatchObject({ code: 'staging_failed', status: 503 });
      expect(cancelled).toBe(true);
    });
  });

  describe('streaming publish validation', () => {
    it('hashes and walks one stream then normalizes the manifest', async () => {
      const value = publish();
      const result = await validatePublishBody(
        stream(enc.encode(JSON.stringify(value)), 19),
        validation,
      );
      expect(result).toMatchObject({
        version: '1.0.0',
        archive: { fileCount: 2 },
        readme: 'archive readme',
      });
      expect(JSON.parse(result.input.metadata.json).dist).toMatchObject({
        fileCount: 2,
        integrity: expect.stringMatching(/^sha512-/),
      });
    });
    it.each([
      { shasum: '0'.repeat(40) },
      { integrity: 'sha512-AAAA' },
      { integrity: 'sha256-AAAA' },
    ])('refuses supplied digest %j', async (dist) => {
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(publish(dist)))), validation),
      ).rejects.toMatchObject({ code: 'integrity_mismatch' });
    });
    it('accepts recomputed digests', async () => {
      const value = publish();
      const a = value._attachments as Record<string, { data: string }>;
      const bytes = Buffer.from(a['test-package-1.0.0.tgz']!.data, 'base64');
      const result = await validatePublishBody(
        stream(
          enc.encode(
            JSON.stringify(
              publish({
                shasum: createHash('sha1').update(bytes).digest('hex'),
                integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
              }),
            ),
          ),
        ),
        validation,
      );
      expect(result.input.version).toBe('1.0.0');
    });
    it('checks license only when configured', async () => {
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(publish()))), {
          ...validation,
          requireLicense: true,
        }),
      ).rejects.toMatchObject({ code: 'license_missing' });
    });
    it('caps the normalized manifest', async () => {
      const value = publish();
      (value.versions as Record<string, Record<string, unknown>>)['1.0.0']!.description =
        'a'.repeat(262144);
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
      ).rejects.toMatchObject({ code: 'manifest_too_large', status: 413 });
    });
    it('prefers version readme and truncates it', async () => {
      const value = publish();
      (value as Record<string, unknown>).readme = 'top';
      (value.versions as Record<string, Record<string, unknown>>)['1.0.0']!.readme = 'é'.repeat(
        262145,
      );
      expect(
        await validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
      ).toMatchObject({ readmeTruncated: true, readme: 'é'.repeat(262144) });
    });
    it('cancels the request when gzip decoding fails', async () => {
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(body()))), validation),
      ).rejects.toMatchObject({ code: 'invalid_tarball', status: 400 });
    });
  });

  describe('captured publish requests', () => {
    it.each(['01-unscoped', '01-scoped', '02-unscoped', '02-scoped', '03-unscoped', '03-scoped'])(
      'validates %s with recomputed digests and archive identity',
      async (id) => {
        const bytes = new Uint8Array(
          await readFile(
            new URL(`../../../../../fixtures/npm-publish/${id}.body`, import.meta.url),
          ),
        );
        const name = id.endsWith('-scoped') ? '@scope/name' : 'test-package';
        const result = await validatePublishBody(stream(bytes, 31), { ...validation, name });
        expect(result.input.version).toBe('1.0.0');
        expect(result.archive.fileCount).toBeGreaterThanOrEqual(3);
        expect(result.readme).toBe('# Publish fixture\n');
      },
    );
  });

  describe('publish failure isolation', () => {
    it('does not expose a sink error message', async () => {
      await expect(
        scan(body(), {
          onTarballChunk: async () => {
            throw new Error('private request value');
          },
        }),
      ).rejects.toMatchObject({ code: 'staging_failed', status: 503, message: 'staging_failed' });
    });
    it('does not expose a stream error message', async () => {
      const source = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('private request value');
        },
      });
      await expect(
        scanPublishBody(source, { ...options, onTarballChunk: async () => {} }),
      ).rejects.toMatchObject({ code: 'invalid_publish_body', message: 'invalid_publish_body' });
    });
    it('stops reading and cancels on an abort with a private reason', async () => {
      let cancel = false;
      const source = new ReadableStream<Uint8Array>({
        cancel() {
          cancel = true;
        },
      });
      const controller = new AbortController();
      const task = scanPublishBody(source, {
        ...options,
        signal: controller.signal,
        onTarballChunk: async () => {},
      });
      controller.abort(new Error('private request value'));
      await expect(task).rejects.toMatchObject({
        code: 'publish_cancelled',
        message: 'publish_cancelled',
      });
      expect(cancel).toBe(true);
    });
  });

  describe('publish backpressure', () => {
    it('does not drain the request while the staging sink is blocked', async () => {
      const value = publish();
      let seed = 123;
      const random = new Uint8Array(400000);
      for (let i = 0; i < random.length; i++) {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        random[i] = seed & 255;
      }
      const tgz = gzipSync(
        join(
          entry('package/package.json', manifest),
          entry('package/data', Buffer.from(random).toString('base64')),
          new Uint8Array(1024),
        ),
      );
      value._attachments = {
        'test-package-1.0.0.tgz': { data: tgz.toString('base64'), length: tgz.length },
      };
      const bytes = enc.encode(JSON.stringify(value));
      let pulled = 0;
      let started!: () => void;
      const reached = new Promise<void>((r) => {
        started = r;
      });
      let release!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const source = new ReadableStream<Uint8Array>(
        {
          pull(c) {
            if (pulled === bytes.length) c.close();
            else {
              c.enqueue(bytes.subarray(pulled, pulled + 1024));
              pulled += Math.min(1024, bytes.length - pulled);
            }
          },
        },
        { highWaterMark: 0 },
      );
      const result = validatePublishBody(source, {
        ...validation,
        onTarballChunk: async () => {
          started();
          await blocked;
        },
      });
      await reached;
      expect(pulled).toBeLessThan(32768);
      release();
      expect((await result).archive.fileCount).toBe(2);
    });
  });

  describe('publish semantic refusals', () => {
    it.each([null, [], true])('refuses root %j', async (value) => {
      await expect(scan(value)).rejects.toMatchObject({ code: 'invalid_json' });
    });
    it.each([
      null,
      [],
      {},
      { '1.0.0': null },
      { '1.0.0': { name: 'test-package', version: '2.0.0' } },
      { '1.0.0': { name: 'test-package', version: '1.0.0' }, '2.0.0': {} },
    ])('refuses versions %j', async (versions) => {
      await expect(scan(body({ versions }))).rejects.toMatchObject({ code: 'invalid_version' });
    });
    it.each(['BadName', '../name', '@Scope/name', ''])('refuses path name %s', async (name) => {
      await expect(scan(body(), { name })).rejects.toMatchObject({ code: 'invalid_name' });
    });
    it.each([{ name: 'other' }, { versions: { '1.0.0': { name: 'other', version: '1.0.0' } } }])(
      'refuses body identity %j',
      async (overrides) => {
        await expect(scan(body(overrides))).rejects.toMatchObject({ code: 'manifest_mismatch' });
      },
    );
    it.each([null, [], 1])('refuses attachments %j', async (attachments) => {
      await expect(scan(body({ _attachments: attachments }))).rejects.toMatchObject({
        code: 'invalid_attachments',
      });
    });
    it('refuses a second attachments object before reading its value', async () => {
      const raw = JSON.stringify(body()).slice(0, -1) + ',"_attachments"';
      await expect(scan(raw)).rejects.toMatchObject({ code: 'invalid_attachments' });
    });
    it('treats prototype property names as ordinary keys', async () => {
      const raw =
        JSON.stringify(body()).slice(0, -1) + ',"__proto__":{"value":1},"constructor":{"value":2}}';
      const parsed = await scan(raw);
      expect(Object.getPrototypeOf(parsed.metadata)).toBe(null);
      expect(Object.getPrototypeOf(parsed.metadata.__proto__)).toBe(null);
      expect(parsed.metadata.__proto__).toEqual({ value: 1 });
    });
    it.each([null, 'value', { shasum: 1 }, { integrity: null }, { integrity: '' }])(
      'refuses digest shape %j',
      async (dist) => {
        const value = publish();
        (value.versions as Record<string, Record<string, unknown>>)['1.0.0']!.dist = dist;
        await expect(
          validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
        ).rejects.toMatchObject({ code: 'integrity_mismatch' });
      },
    );
    it.each([
      null,
      [],
      { latest: '2.0.0' },
      { '1.0.0': '1.0.0' },
      { 'bad tag': '1.0.0' },
      Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['tag' + i, '1.0.0'])),
    ])('refuses tags %j', async (tags) => {
      const value = publish();
      (value as Record<string, unknown>)['dist-tags'] = tags;
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
      ).rejects.toMatchObject({
        code: tags && Object.keys(tags).length > 8 ? 'too_many_tags' : 'invalid_tags',
      });
    });
    it('refuses readme control characters', async () => {
      const value = publish();
      (value as Record<string, unknown>).readme = 'a\0b';
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
      ).rejects.toMatchObject({ code: 'invalid_readme' });
    });
    it('refuses a mismatch between archive and request versions', async () => {
      const value = publish();
      const version = (value.versions as Record<string, Record<string, unknown>>)['1.0.0']!;
      version.version = '2.0.0';
      value.versions = { '2.0.0': version } as unknown as typeof value.versions;
      const attachment = value._attachments['test-package-1.0.0.tgz'];
      value._attachments = {
        'test-package-2.0.0.tgz': attachment,
      } as unknown as typeof value._attachments;
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
      ).rejects.toMatchObject({ code: 'manifest_mismatch' });
    });
  });

  describe('isolated JSON and base64 guards', () => {
    it.each(['1e999', '1e' + '0'.repeat(1100)])(
      'refuses out-of-bound numeric token',
      async (token) => {
        const raw = JSON.stringify(body()).slice(0, -1) + ',"extra":' + token + '}';
        await expect(scan(raw)).rejects.toMatchObject({ code: 'invalid_json' });
      },
    );
    it('requires a comma between object properties', async () => {
      await expect(
        scan(JSON.stringify(body()).replace('{"name"', '{"extra":{};"name"')),
      ).rejects.toMatchObject({ code: 'invalid_json' });
    });
    it('rejects a raw control character followed by an escape letter', async () => {
      const raw = JSON.stringify(body()).slice(0, -1) + ',"extra":"a\nn"}';
      await expect(scan(raw)).rejects.toMatchObject({ code: 'invalid_json' });
    });
    it.each(['YWJjYQ', 'YQ==YQ=='])('refuses split base64 %s', async (data) => {
      await expect(
        scanPublishBody(
          stream(
            enc.encode(
              JSON.stringify(body({ _attachments: { 'test-package-1.0.0.tgz': { data } } })),
            ),
            1,
          ),
          { ...options, onTarballChunk: async () => {} },
        ),
      ).rejects.toMatchObject({ code: 'invalid_attachments' });
    });
    it('refuses a request that was already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      await expect(scan(body(), { signal: controller.signal })).rejects.toMatchObject({
        code: 'publish_cancelled',
      });
    });
  });

  describe('absent attachment', () => {
    it('dispatches an omitted attachments object as a manifest update', async () => {
      const value: Record<string, unknown> = body();
      delete value._attachments;
      await expect(scan(value)).rejects.toMatchObject({ code: 'manifest_update', status: 400 });
    });
    it('does not read a stalled source for an already aborted request', async () => {
      let pulled = false;
      const source = new ReadableStream<Uint8Array>(
        {
          pull() {
            pulled = true;
            return new Promise(() => {});
          },
        },
        { highWaterMark: 0 },
      );
      const controller = new AbortController();
      controller.abort();
      await expect(
        scanPublishBody(source, {
          ...options,
          signal: controller.signal,
          onTarballChunk: async () => {},
        }),
      ).rejects.toMatchObject({ code: 'publish_cancelled' });
      expect(pulled).toBe(false);
    });
  });

  describe('early attachment shape validation', () => {
    it.each(['{"_attachments":null', '{"_attachments":{"a":null'])(
      'refuses before consuming the value: %s',
      async (raw) => {
        await expect(scan(raw)).rejects.toMatchObject({ code: 'invalid_attachments' });
      },
    );
  });

  describe('readme shape', () => {
    it.each(['version', 'top'])('refuses a non-string %s readme', async (location) => {
      const value = publish();
      if (location === 'version')
        (value.versions as Record<string, Record<string, unknown>>)['1.0.0']!.readme = 12;
      else (value as Record<string, unknown>).readme = 12;
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
      ).rejects.toMatchObject({ code: 'invalid_readme' });
    });
  });

  describe('blocked sink cancellation', () => {
    it('cancels a blocked scanner sink promptly', async () => {
      let reached!: () => void;
      const started = new Promise<void>((r) => {
        reached = r;
      });
      let release!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const controller = new AbortController();
      const task = scan(body(), {
        signal: controller.signal,
        onTarballChunk: async () => {
          reached();
          await blocked;
        },
      });
      await started;
      controller.abort();
      try {
        await expect(task).rejects.toMatchObject({ code: 'publish_cancelled' });
      } finally {
        release();
        await task.catch(() => {});
      }
    });
    it('cancels a blocked staging sink when the archive refuses', async () => {
      const value = publish();
      const tgz = gzipSync(
        join(
          entry('package/package.json', manifest),
          entry('package/link', '', '2'),
          new Uint8Array(1024),
        ),
      );
      value._attachments = {
        'test-package-1.0.0.tgz': { data: tgz.toString('base64'), length: tgz.length },
      };
      let reached!: () => void;
      const started = new Promise<void>((r) => {
        reached = r;
      });
      let release!: () => void;
      const blocked = new Promise<void>((r) => {
        release = r;
      });
      const task = validatePublishBody(stream(enc.encode(JSON.stringify(value)), 65536), {
        ...validation,
        codecs: {
          ...codecs,
          gunzip: () => {
            const inner = new DecompressionStream('gzip');
            const writer = inner.writable.getWriter();
            return {
              readable: inner.readable,
              writable: new WritableStream<Uint8Array>({
                async write(bytes) {
                  await started;
                  await writer.write(bytes);
                },
                close: () => writer.close(),
                abort: (reason) => writer.abort(reason),
              }),
            };
          },
        },
        onTarballChunk: async () => {
          reached();
          await blocked;
        },
      });
      await started;
      try {
        await expect(task).rejects.toMatchObject({ code: 'invalid_tarball' });
      } finally {
        release();
        await task.catch(() => {});
      }
    });
  });

  describe('validation abort boundary', () => {
    it('returns a safe cancellation for an already aborted validation', async () => {
      const controller = new AbortController();
      controller.abort(new Error('private reason'));
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(publish()))), {
          ...validation,
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: 'publish_cancelled', message: 'publish_cancelled' });
    });
  });

  describe('round 3 scanner guards', () => {
    it('does not allocate a 16 KiB buffer for every JSON key or string', async () => {
      let largeBuffers = 0;
      const Original = Uint8Array;
      vi.stubGlobal(
        'Uint8Array',
        new Proxy(Original, {
          construct(target, args) {
            if (args[0] === 16384) largeBuffers++;
            return Reflect.construct(target, args) as Uint8Array;
          },
        }),
      );
      try {
        await scan(body({ extra: { one: 'a\b', two: 'b' } }));
        expect(largeBuffers).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    });
    it('checks readme controls without expanding a string into an array', async () => {
      const spy = vi.spyOn(Array, 'from');
      try {
        const value = publish();
        Object.assign(value.versions['1.0.0'], { readme: 'hello\tworld\n' });
        await validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation);
        expect(spy.mock.calls.some(([input]) => typeof input === 'string')).toBe(false);
      } finally {
        spy.mockRestore();
      }
    });
    it.each(['literal', 'escaped'])('preserves %s BOM in keys and values', async (form) => {
      const raw = JSON.stringify(body({ '\ufeffkey': '\ufeffvalue' }));
      const result = await scan(form === 'escaped' ? raw.replaceAll('\ufeff', '\\ufeff') : raw);
      expect(result.metadata['\ufeffkey']).toBe('\ufeffvalue');
      expect(Object.hasOwn(result.metadata, 'key')).toBe(false);
    });
    it('accepts exactly 10000 keys in one metadata object', async () => {
      const extra = Object.fromEntries(Array.from({ length: 10000 }, (_, i) => ['k' + i, 0]));
      expect((await scan(body({ extra }))).version).toBe('1.0.0');
    });
    it('requires a buffered colon between key and value', async () => {
      const raw = JSON.stringify(body()).replace('"name":', '"name";');
      await expect(
        scanPublishBody(stream(enc.encode(raw), 65536), {
          ...options,
          onTarballChunk: async () => {},
        }),
      ).rejects.toMatchObject({ code: 'invalid_json' });
    });
    it('caps a buffered numeric token before parsing', async () => {
      const raw = JSON.stringify(body()).slice(0, -1) + ',"extra":1e' + '0'.repeat(1100) + '}';
      await expect(
        scanPublishBody(stream(enc.encode(raw), 65536), {
          ...options,
          onTarballChunk: async () => {},
        }),
      ).rejects.toMatchObject({ code: 'invalid_json' });
    });
    it('refuses unsupported attachment properties before parsing their value', async () => {
      const value = body();
      Object.assign(value._attachments['test-package-1.0.0.tgz'], { extra: Array(150000).fill(0) });
      await expect(scan(value)).rejects.toMatchObject({ code: 'invalid_attachments', status: 400 });
      await expect(
        scan('{"_attachments":{"test-package-1.0.0.tgz":{"extra":INVALID'),
      ).rejects.toMatchObject({ code: 'invalid_attachments', status: 400 });
    });
    it.each(['content_type', 'length'])(
      'counts every materialized attachment %s node',
      async (key) => {
        const value = body();
        Object.assign(value._attachments['test-package-1.0.0.tgz'], {
          [key]: Array(150000).fill(0),
        });
        await expect(scan(value)).rejects.toMatchObject({
          code: 'publish_metadata_too_large',
          status: 413,
        });
      },
    );
    it('counts attachment keys at the total node boundary', async () => {
      const value = body({ extra: Array(99976).fill(0) });
      await expect(scan(value)).rejects.toMatchObject({
        code: 'publish_metadata_too_large',
        status: 413,
      });
    });
    it('caps keys in a single object below the byte cap', async () => {
      const extra = Object.fromEntries(Array.from({ length: 10001 }, (_, i) => ['k' + i, 0]));
      await expect(scan(body({ extra }))).rejects.toMatchObject({
        code: 'publish_metadata_too_large',
        status: 413,
      });
    });
    it('caps total metadata keys plus values across objects and arrays', async () => {
      const extra = Array.from({ length: 20 }, () => Array.from({ length: 5000 }, () => 0));
      await expect(scan(body({ extra }))).rejects.toMatchObject({
        code: 'publish_metadata_too_large',
        status: 413,
      });
    });
    it('refuses an 8 MB key flood within a bounded number of input bytes', async () => {
      const raw = enc.encode(
        JSON.stringify({
          extra: Array.from({ length: 50 }, () =>
            Object.fromEntries(
              Array.from({ length: 10000 }, (_, i) => ['k' + i.toString().padStart(8, '0'), null]),
            ),
          ),
        }),
      );
      expect(raw.byteLength).toBeGreaterThan(8000000);
      let read = 0;
      const input = new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            if (read === raw.length) controller.close();
            else {
              const end = Math.min(read + 65536, raw.length);
              controller.enqueue(raw.subarray(read, end));
              read = end;
            }
          },
        },
        { highWaterMark: 0 },
      );
      await expect(
        scanPublishBody(input, { ...options, onTarballChunk: async () => {} }),
      ).rejects.toMatchObject({ code: 'publish_metadata_too_large' });
      expect(read).toBeGreaterThan(800000);
      expect(read).toBeLessThan(1000000);
    });
    it.each([true, 123, {}])('requires a normalized license for %j', async (license) => {
      const value = publish();
      Object.assign(value.versions['1.0.0'], { license });
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(value))), {
          ...validation,
          requireLicense: true,
        }),
      ).rejects.toMatchObject({ code: 'license_missing' });
    });
    it('accepts a supported legacy license', async () => {
      const value = publish();
      Object.assign(value.versions['1.0.0'], { licenses: [{ type: 'MIT' }] });
      expect(
        (
          await validatePublishBody(stream(enc.encode(JSON.stringify(value))), {
            ...validation,
            requireLicense: true,
          })
        ).input.license,
      ).toBe('["MIT"]');
    });
    it('wraps a staging sink failure with its cause', async () => {
      const cause = new Error('private sink data');
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(publish()))), {
          ...validation,
          onTarballChunk: async () => {
            throw cause;
          },
        }),
      ).rejects.toMatchObject({
        code: 'staging_failed',
        status: 503,
        message: 'staging_failed',
        cause,
      });
    });
    it.each(['digestTap', 'gunzip'] as const)(
      'wraps synchronous %s setup failure',
      async (method) => {
        const cause = new Error('private codec data');
        await expect(
          validatePublishBody(stream(enc.encode(JSON.stringify(publish()))), {
            ...validation,
            codecs: {
              ...codecs,
              [method]: () => {
                throw cause;
              },
            },
          }),
        ).rejects.toMatchObject({
          code: 'staging_failed',
          status: 503,
          message: 'staging_failed',
          cause,
        });
      },
    );
    it('preserves an intentional client refusal from the staging sink', async () => {
      const refusal = new PublishValidationError('tarball_too_large', 413);
      await expect(
        scan(body(), {
          onTarballChunk: async () => {
            throw refusal;
          },
        }),
      ).rejects.toBe(refusal);
    });
    it('wraps an asynchronous codec failure with its cause', async () => {
      const cause = new Error('private asynchronous codec data');
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(publish()))), {
          ...validation,
          codecs: {
            ...codecs,
            gunzip: () =>
              new TransformStream<Uint8Array, Uint8Array>({
                transform() {
                  throw cause;
                },
              }),
          },
        }),
      ).rejects.toMatchObject({
        code: 'staging_failed',
        status: 503,
        message: 'staging_failed',
        cause,
      });
    });
    it.each(['crc', 'truncated'])(
      'maps client codec failure %s to invalid_tarball',
      async (kind) => {
        const value = publish();
        const attachment = value._attachments['test-package-1.0.0.tgz'];
        let bytes = Buffer.from(attachment.data, 'base64');
        if (kind === 'crc') bytes[bytes.length - 8] = bytes[bytes.length - 8]! ^ 1;
        else bytes = bytes.subarray(0, -1);
        attachment.data = bytes.toString('base64');
        attachment.length = bytes.length;
        await expect(
          validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
        ).rejects.toMatchObject({ code: 'invalid_tarball', status: 400 });
      },
    );
    it.each([Buffer.from([0, 0, 0]), Buffer.from('garbage')])(
      'refuses non-gzip bytes after a gzip member %j',
      async (trailing) => {
        const value = publish();
        const attachment = value._attachments['test-package-1.0.0.tgz'];
        const bytes = Buffer.concat([Buffer.from(attachment.data, 'base64'), trailing]);
        attachment.data = bytes.toString('base64');
        attachment.length = bytes.length;
        await expect(
          validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
        ).rejects.toMatchObject({ code: 'invalid_tarball', status: 400 });
      },
    );
    it.each([
      ['empty', new Uint8Array(0)],
      ['zero block', new Uint8Array(512)],
    ] as const)('accepts a concatenated gzip member %s like npm', async (_label, member) => {
      const value = publish();
      const attachment = value._attachments['test-package-1.0.0.tgz'];
      const bytes = Buffer.concat([Buffer.from(attachment.data, 'base64'), gzipSync(member)]);
      attachment.data = bytes.toString('base64');
      attachment.length = bytes.length;
      const result = await validatePublishBody(
        stream(enc.encode(JSON.stringify(value))),
        validation,
      );
      expect(result.archive).toMatchObject({ fileCount: 2, readme: 'archive readme' });
    });
    it('concatenates gzip members split within the tar stream', async () => {
      const bytes = Buffer.concat([
        gzipSync(entry('package/package.json', manifest).subarray(0, 513)),
        gzipSync(join(entry('package/package.json', manifest).subarray(513), new Uint8Array(1024))),
      ]);
      const value = publish();
      value._attachments['test-package-1.0.0.tgz'] = {
        data: bytes.toString('base64'),
        length: bytes.length,
      };
      const result = await validatePublishBody(
        stream(enc.encode(JSON.stringify(value))),
        validation,
      );
      expect(result.archive.fileCount).toBe(1);
    });
    it.each(['crc', 'truncated'])('refuses a corrupt second gzip member %s', async (kind) => {
      const value = publish();
      const attachment = value._attachments['test-package-1.0.0.tgz'];
      let member = gzipSync(new Uint8Array(512));
      if (kind === 'crc') member[member.length - 8] = member[member.length - 8]! ^ 1;
      else member = member.subarray(0, -1);
      const bytes = Buffer.concat([Buffer.from(attachment.data, 'base64'), member]);
      attachment.data = bytes.toString('base64');
      attachment.length = bytes.length;
      await expect(
        validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
      ).rejects.toMatchObject({ code: 'invalid_tarball', status: 400 });
    });
    it.each([['text', 'trailing']] as const)(
      'refuses a trailing gzip member %s',
      async (_label, member) => {
        const value = publish();
        const attachment = value._attachments['test-package-1.0.0.tgz'];
        const bytes = Buffer.concat([Buffer.from(attachment.data, 'base64'), gzipSync(member)]);
        attachment.data = bytes.toString('base64');
        attachment.length = bytes.length;
        await expect(
          validatePublishBody(stream(enc.encode(JSON.stringify(value))), validation),
        ).rejects.toMatchObject({ code: 'invalid_tarball', status: 400 });
      },
    );
  });
});
