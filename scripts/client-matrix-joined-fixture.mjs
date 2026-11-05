import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { fixtureReply, harnessAssert as assert, tarEntry } from './client-matrix.mjs';

const commit = 'a'.repeat(40);
const manifest = JSON.stringify({
  name: 'matrix-joined-repository',
  version: '1.0.0',
  main: 'index.js',
});
const archive = gzipSync(
  Buffer.concat([
    tarEntry('repository/package.json', manifest),
    tarEntry('repository/index.js', 'module.exports = true;\n'),
    tarEntry('repository/README.md', '# Joined repository fixture\n'),
    Buffer.alloc(1024),
  ]),
);

export function createJoinedFixture(audits, { holdTimeoutMs = 180_000 } = {}) {
  let tagVisible = false;
  const modes = new Map();
  const requests = [];
  let healthy = true;
  let disposed = false;
  const check = (condition) => {
    if (!condition) healthy = false;
    assert.ok(condition, 'Joined fixture assertion failed');
  };
  return {
    requests,
    assertHealthy: () => assert.ok(healthy, 'Joined fixture assertion failed'),
    assertTagListing: () => {
      const exposed = requests.indexOf('tag exposed');
      assert.ok(
        exposed >= 0 && requests.slice(exposed + 1).includes('GET /repos/fixture/repository/tags'),
        'Repository tag listing after exposure missing',
      );
    },
    dispose: () => {
      disposed = true;
      modes.clear();
    },
    tag: () => {
      tagVisible = true;
      requests.push('tag exposed');
    },
    scanner: (name, mode) => {
      if (!disposed) modes.set(name, mode);
    },
    async fetch(request) {
      const url = new URL(request.url);
      if (url.origin === 'https://scanner.matrix.test') {
        check(!request.headers.has('authorization') && !request.headers.has('cookie'));
        const name = url.pathname.slice(1);
        const deadline = Date.now() + holdTimeoutMs;
        while (modes.get(name) === 'hold') {
          if (Date.now() >= deadline) {
            healthy = false;
            assert.ok(false, 'Joined scanner hold timed out');
          }
          await delay(25, undefined, { signal: request.signal });
        }
        return new Response(null, { status: modes.get(name) === 'allow' ? 200 : 503 });
      }
      if (url.origin === 'https://api.github.com') {
        check(
          request.headers.get('authorization') === 'Bearer matrix-github-fixture-token' &&
            !request.headers.has('cookie'),
        );
        requests.push(`${request.method} ${url.pathname}`);
        if (url.pathname === '/repos/fixture/repository')
          return Response.json({
            id: 123,
            owner: { id: 456 },
            full_name: 'fixture/repository',
            archived: false,
            default_branch: 'main',
          });
        if (url.pathname === '/repos/fixture/repository/tags')
          return Response.json(tagVisible ? [{ name: 'v1.0.0', commit: { sha: commit } }] : []);
        if (url.pathname === '/graphql')
          return Response.json({
            data: { repository: { a0: { byteSize: Buffer.byteLength(manifest), text: manifest } } },
          });
        if (url.pathname === `/repos/fixture/repository/tarball/${commit}`)
          return new Response(archive, { headers: { 'content-type': 'application/gzip' } });
        check(false);
      }
      if (
        url.origin === 'https://registry.npmjs.org' &&
        request.method === 'HEAD' &&
        decodeURIComponent(url.pathname).startsWith('/matrix-joined-')
      ) {
        check(!request.headers.has('authorization') && !request.headers.has('cookie'));
        return new Response(null, { status: 404 });
      }
      return fixtureReply(request, audits);
    },
  };
}
