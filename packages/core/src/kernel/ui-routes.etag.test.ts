import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { orgContext } from '../db/port.js';
import type { StaticAssets } from '../platform/assets.js';
import { createKernel } from './kernel.js';
import { createUiRoutes, UI_CSP } from './ui-routes.js';

const ORIGIN = 'https://broker.test';
const ASSET = '/_pb/ui/app.012345abcdef.js';
const BODY = 'console.log("π")';
const tag = (body: string) => `"${createHash('sha256').update(body).digest('hex')}"`;

async function app(stream = false, withKernelOrigin = true) {
  let entry = '<!doctype html><title>First</title>';
  let script = BODY;
  const assets: StaticAssets = {
    manifest: () =>
      Promise.resolve({
        version: 1,
        entry: 'index.html',
        files: {
          'index.html': { contentType: 'text/html', bytes: 1 },
          'app.012345abcdef.js': { contentType: 'text/javascript', bytes: 1 },
        },
      }),
    read: (name) => {
      const bytes = new TextEncoder().encode(name === 'index.html' ? entry : script);
      return Promise.resolve({
        body: stream
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes.slice(0, 3));
                controller.enqueue(bytes.slice(3));
                controller.close();
              },
            })
          : bytes,
        bytes: 1,
        contentType: name === 'index.html' ? 'text/html' : 'text/javascript',
      });
    },
  };
  const kernel = await createKernel({
    platform: 'node',
    ...(withKernelOrigin ? { publicOrigin: ORIGIN } : {}),
    plugins: [],
    ports: {
      organizations: { get: () => Promise.resolve(null) },
      clock: { now: () => new Date('2026-10-17T12:00:00Z') },
      ids: { ulid: () => '01J0A0000000000000000000000'.slice(0, 26) },
    },
    resolveOrg: () => Promise.resolve(orgContext('01J0ORGA00000000000000000A')),
    health: () => Promise.resolve(true),
    coreRoutes: createUiRoutes(assets, { publicOrigin: ORIGIN }),
    log: () => undefined,
  });
  return {
    fetch: (path = ASSET, validator?: string, method = 'GET') =>
      kernel.fetch(
        new Request(`${ORIGIN}${path}`, {
          method,
          headers: validator === undefined ? {} : { 'if-none-match': validator },
        }),
      ),
    setEntry: (value: string) => {
      entry = value;
    },
    setScript: (value: string) => {
      script = value;
    },
  };
}

describe('UI asset ETags', () => {
  it.each([false, true])('hashes the actual served bytes (stream=%s)', async (stream) => {
    const response = await (await app(stream)).fetch();
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(tag(BODY));
    expect(await response.text()).toBe(BODY);
  });

  it('returns an empty 304 with the current ETag and cache policy on a strong match', async () => {
    const response = await (await app()).fetch(ASSET, tag(BODY));
    expect(response.status).toBe(304);
    expect(response.headers.get('etag')).toBe(tag(BODY));
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(response.headers.get('x-request-id')).toBeTruthy();
    expect(await response.text()).toBe('');
  });

  it('retains every security header on 304', async () => {
    const server = await app();
    const full = await server.fetch();
    const response = await server.fetch(ASSET, tag(BODY));
    expect(full.status).toBe(200);
    expect(response.status).toBe(304);
    expect(response.headers.get('content-security-policy')).toBe(UI_CSP);
    expect(response.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
    const securityHeaderNames = new Set([
      'content-security-policy',
      'cross-origin-opener-policy',
      'x-content-type-options',
      'referrer-policy',
      'strict-transport-security',
    ]);
    const securityHeaders = (headers: Headers) =>
      Object.fromEntries([...headers].filter(([name]) => securityHeaderNames.has(name)));
    expect(securityHeaders(response.headers)).toEqual(securityHeaders(full.headers));
  });

  it('omits HSTS on 200 and 304 without a kernel public origin', async () => {
    const server = await app(false, false);
    const full = await server.fetch();
    const response = await server.fetch(ASSET, tag(BODY));
    expect(full.status).toBe(200);
    expect(response.status).toBe(304);
    expect(full.headers.has('strict-transport-security')).toBe(false);
    expect(response.headers.has('strict-transport-security')).toBe(false);
  });

  it('returns 200 and the body on a mismatched validator', async () => {
    const response = await (await app()).fetch(ASSET, tag('other'));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
  });

  it('returns 200 for a weak validator', async () => {
    const response = await (await app()).fetch(ASSET, `W/${tag(BODY)}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
  });

  it.each([
    ['unquoted', tag(BODY).slice(1, -1)],
    ['unterminated', tag(BODY).slice(0, -1)],
    ['trailing garbage', `${tag(BODY)} garbage`],
    ['invalid list', `${tag(BODY)},`],
  ])('returns 200 for a malformed validator: %s', async (_name, validator) => {
    const response = await (await app()).fetch(ASSET, validator);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(BODY);
  });

  it('matches a strong validator in a valid list', async () => {
    const response = await (await app()).fetch(ASSET, `${tag('other')}, ${tag(BODY)}`);
    expect(response.status).toBe(304);
  });

  it('changes the validator when bytes change at the same asset path', async () => {
    const server = await app();
    const first = await server.fetch();
    expect(first.headers.get('etag')).toBe(tag(BODY));
    server.setScript('changed');
    const response = await server.fetch(ASSET, tag(BODY));
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(tag('changed'));
    expect(await response.text()).toBe('changed');
  });

  it('keeps the entry document no-cache on 200 and 304', async () => {
    const server = await app();
    const full = await server.fetch('/_pb/ui/');
    const validator = full.headers.get('etag');
    expect(validator).toBe(tag('<!doctype html><title>First</title>'));
    expect(full.headers.get('cache-control')).toBe('no-cache');
    const response = await server.fetch('/_pb/ui/', validator!);
    expect(response.status).toBe(304);
    expect(response.headers.get('cache-control')).toBe('no-cache');
  });

  it('never returns 304 for a stale entry validator after the entry changes', async () => {
    const server = await app();
    const first = await server.fetch('/_pb/ui/');
    expect(first.headers.get('etag')).toBe(tag('<!doctype html><title>First</title>'));
    server.setEntry('<!doctype html><title>New</title>');
    const response = await server.fetch('/_pb/ui/', first.headers.get('etag')!);
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe(tag('<!doctype html><title>New</title>'));
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(await response.text()).toBe('<!doctype html><title>New</title>');
  });

  it.each(['/_pb/ui/', ASSET])('uses the same ETag for HEAD and GET on %s', async (path) => {
    const server = await app();
    const full = await server.fetch(path);
    const validator = full.headers.get('etag');
    expect(validator).toMatch(/^"[0-9a-f]{64}"$/);
    const head = await server.fetch(path, undefined, 'HEAD');
    expect(head.status).toBe(200);
    expect(head.headers.get('etag')).toBe(validator);
    expect(await head.text()).toBe('');
    const conditional = await server.fetch(path, validator!, 'HEAD');
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('etag')).toBe(validator);
    expect(await conditional.text()).toBe('');
  });
});
