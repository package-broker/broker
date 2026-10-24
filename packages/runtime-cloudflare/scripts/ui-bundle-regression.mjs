import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; require-trusted-types-for 'script'";

/** Shared regression run against the staged Node and Worker bundles by their smokes. */
export async function checkUiBundle({ request, assetsDir, https }) {
  const manifest = JSON.parse(await readFile(join(assetsDir, 'manifest.json'), 'utf8'));
  const security = (response) => {
    assert.equal(response.headers.get('content-security-policy'), CSP);
    assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(
      response.headers.get('strict-transport-security'),
      https ? 'max-age=31536000; includeSubDomains' : null,
    );
    assert.ok(response.headers.get('x-request-id'));
    assert.equal(response.headers.get('set-cookie'), null);
  };
  for (const method of ['GET', 'HEAD']) {
    const redirect = await request('/_pb/ui?view=packages', { method });
    assert.equal(redirect.status, 303);
    assert.equal(redirect.headers.get('location'), '/_pb/ui/?view=packages');
    assert.equal(redirect.headers.get('cache-control'), 'no-store');
    security(redirect);
    assert.equal(await redirect.text(), '');

    const missing = await request('/_pb/ui/manifest.json', { method });
    assert.equal(missing.status, 404);
    security(missing);
    if (method === 'HEAD') assert.equal(await missing.text(), '');
    else {
      assert.deepEqual(await missing.json(), {
        error: {
          code: 'not_found',
          message: 'Route not found',
          requestId: missing.headers.get('x-request-id'),
        },
      });
    }
  }

  const document = await request('/_pb/ui/', {});
  assert.equal(document.status, 200);
  const html = await document.text();
  assert.equal(html, await readFile(join(assetsDir, manifest.entry), 'utf8'));
  const references = [...html.matchAll(/<(?:script|link)\b[^>]*\s(?:src|href)="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(references.some((name) => name.endsWith('.js')));
  assert.ok(references.some((name) => name.endsWith('.css')));
  for (const [path, name] of [
    ['/_pb/ui/', manifest.entry],
    ...references.map((name) => [`/_pb/ui/${name}`, name]),
  ]) {
    assert.ok(Object.hasOwn(manifest.files, name));
    const response = await request(path, {});
    assert.equal(response.status, 200);
    security(response);
    const contentType = manifest.files[name].contentType;
    assert.equal(
      response.headers.get('content-type'),
      contentType === 'text/html' ? 'text/html; charset=utf-8' : contentType,
    );
    assert.equal(
      response.headers.get('cache-control'),
      name === manifest.entry ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
    const body = await readFile(join(assetsDir, name));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), body);
    assert.equal(response.headers.get('content-length'), String(body.byteLength));
    const head = await request(path, { method: 'HEAD' });
    assert.equal(head.status, 200);
    security(head);
    for (const name of ['content-type', 'content-length', 'cache-control', 'etag']) {
      assert.equal(head.headers.get(name), response.headers.get(name));
    }
    assert.equal(await head.text(), '');
    const etag = response.headers.get('etag');
    assert.match(etag, /^"[0-9a-f]{64}"$/);
    for (const method of ['GET', 'HEAD']) {
      const cached = await request(path, { method, headers: { 'if-none-match': etag } });
      assert.equal(cached.status, 304);
      security(cached);
      assert.equal(cached.headers.get('etag'), etag);
      assert.equal(await cached.text(), '');
    }
  }
  for (const path of [
    `/_pb/ui/assets/${references[0]}`,
    '/_pb/ui/index.html',
    '/_pb/ui/..%2Fsecret',
  ]) {
    const missing = await request(path, {});
    assert.equal(missing.status, 404);
  }
}
