import { readFileSync, readdirSync } from 'node:fs';
import { zip, tarGzip } from './archives.js';

export const coreCorpus = new URL('../../../core/', import.meta.url);
export const ownCorpus = new URL('../../corpus/', import.meta.url);

export function composerCorpus(): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  const root = new URL('test-fixtures/composer-v1/', coreCorpus);
  const walk = (relative: string) => {
    for (const entry of readdirSync(new URL(relative, root), { withFileTypes: true })) {
      const path = relative + entry.name;
      if (entry.isDirectory()) walk(path + '/');
      else if (path.endsWith('.body')) {
        files.set('/composer-v1/' + path.slice(0, -5), readFileSync(new URL(path, root)));
      }
    }
  };
  walk('');
  return files;
}

export interface GitRecording {
  call: { refs: { name: string; oid: string }[] };
  exchanges: {
    request: { bodyBase64: string };
    response: { status: number; headers: Record<string, string>; bodyBase64: string };
  }[];
}

export function gitRecording(filtered = false): GitRecording {
  const name = filtered ? 'local-git-http-backend' : 'local-git-http-backend-no-filter';
  return JSON.parse(
    readFileSync(new URL(`src/sources/git/fixtures/${name}.json`, coreCorpus), 'utf8'),
  ) as GitRecording;
}

export function packet(value: string | Buffer): Buffer {
  const body = Buffer.from(value);
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0')), body]);
}

export function buildCorpus(): Map<string, Buffer> {
  const seed = JSON.parse(readFileSync(new URL('seed.json', ownCorpus), 'utf8')) as {
    composer: { name: string; version: string };
    npm: { name: string; version: string };
    escapePayload: string;
  };
  const composer = Buffer.from(JSON.stringify(seed.composer) + '\n');
  const npm = Buffer.from(JSON.stringify(seed.npm) + '\n');
  const oversized = Buffer.from(
    JSON.stringify({ name: 'fx/oversized', padding: 'x'.repeat(1024 * 1024) }) + '\n',
  );
  const full = gitRecording().exchanges[0]!.response.bodyBase64;
  const delta = readFileSync(new URL('src/sources/git/__fixtures__/ofs-delta.pack', coreCorpus));
  return new Map([
    ['lib.zip', zip([{ name: 'lib/composer.json', body: composer }])],
    ['lib.tgz', tarGzip([{ name: 'package/package.json', body: npm }])],
    ['zip-bomb.zip', zip([{ name: 'bomb.txt', body: Buffer.alloc(8 * 1024 * 1024, 65) }], true)],
    [
      'tar-traversal.tgz',
      tarGzip([{ name: '../escape.txt', body: Buffer.from(seed.escapePayload) }]),
    ],
    [
      'symlink-escape.tgz',
      tarGzip([
        { name: 'package/escape', body: Buffer.alloc(0), link: '../../outside' },
        { name: 'package/escape/payload.txt', body: Buffer.from(seed.escapePayload) },
      ]),
    ],
    ['oversized-manifest.json', oversized],
    ['oversized-manifest.zip', zip([{ name: 'lib/composer.json', body: oversized }])],
    ['delta.pack', delta],
    [
      'delta-upload-pack.bin',
      Buffer.concat([
        packet('packfile\n'),
        packet(Buffer.concat([Buffer.from([1]), delta])),
        Buffer.from('0000'),
      ]),
    ],
    ['digest-mismatch.zip', Buffer.from('fixture: deliberately not the advertised archive\n')],
    ['git-upload-pack.bin', Buffer.from(full, 'base64')],
    [
      'git-filtered-upload-pack.bin',
      Buffer.from(gitRecording(true).exchanges[0]!.response.bodyBase64, 'base64'),
    ],
  ]);
}
