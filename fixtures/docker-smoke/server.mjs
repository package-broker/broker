import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { createServer } from 'node:https';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const manifest = readFileSync(new URL('./package/composer.json', import.meta.url));
const installed = readFileSync(new URL('./package/installed.php', import.meta.url));

function archive() {
  const chunks = [];
  for (const [name, body] of [
    ['composer.json', manifest],
    ['installed.php', installed],
  ]) {
    const header = Buffer.alloc(512);
    header.write(`fixture/${name}`);
    const octal = (value, offset, length) =>
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(body.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

const bytes = archive();
const shasum = createHash('sha1').update(bytes).digest('hex');
const metadata = {
  packages: {
    'docker-smoke/fixture': [
      {
        ...JSON.parse(manifest),
        version_normalized: '1.0.0.0',
        dist: { type: 'tar', url: 'https://fixture:8443/dist/fixture.tar.gz', shasum },
      },
    ],
  },
};

export function fixtureHandler(request, response) {
  const routes = {
    '/health': ['text/plain', 'ready'],
    '/packages.json': [
      'application/json',
      readFileSync(new URL('./packages.json', import.meta.url)),
    ],
    '/p2/docker-smoke/fixture.json': ['application/json', JSON.stringify(metadata)],
    '/p2/docker-smoke/fixture~dev.json': [
      'application/json',
      '{"packages":{"docker-smoke/fixture":[]}}',
    ],
    '/dist/fixture.tar.gz': ['application/gzip', bytes],
  };
  const route = Object.hasOwn(routes, request.url) ? routes[request.url] : undefined;
  response.writeHead(route ? 200 : 404, { 'content-type': route?.[0] ?? 'text/plain' });
  response.end(route?.[1] ?? 'Not found');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createServer(
    {
      key: readFileSync('/private/fixture.key'),
      cert: readFileSync('/private/fixture.crt'),
    },
    fixtureHandler,
  ).listen(8443, '0.0.0.0');
}
