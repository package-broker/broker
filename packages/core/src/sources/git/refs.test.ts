import { describe, expect, it } from 'vitest';
import { createPolicyFetch, type UpstreamCredential } from '../policy-fetch.js';
import { createOutboundPolicy } from '../url-policy.js';
import { DELIM, FLUSH, GitRemoteError, encodePkt } from './pkt-line.js';
import { GitRefsError, MAX_LS_REFS_BYTES, discoverCapabilities, lsRefs } from './refs.js';

const SECRET = 'sek-ret-token-123';
const REPO = 'https://git.example.com/acme/lib.git';
const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const T1 = 'c'.repeat(40);
const ADVERT = 'application/x-git-upload-pack-advertisement';
const RESULT = 'application/x-git-upload-pack-result';
const policy = createOutboundPolicy({ allowPrivateHosts: [], runtime: 'node', selfOrigins: [] });
const dec = new TextDecoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const pkts = (...lines: (string | Uint8Array)[]): Uint8Array =>
  concat(lines.map((l) => (l instanceof Uint8Array ? l : encodePkt(l))));

function advertisement(caps: string[] = ['agent=git/2.45', 'ls-refs=unborn', 'fetch=shallow']) {
  return pkts(
    '# service=git-upload-pack\n',
    FLUSH,
    'version 2\n',
    ...caps.map((c) => `${c}\n`),
    FLUSH,
  );
}

function lsRefsBody(lines: string[]): Uint8Array {
  return pkts(...lines.map((l) => `${l}\n`), FLUSH);
}

const GOOD_LS = [
  `${C1} HEAD symref-target:refs/heads/main`,
  `${C1} refs/heads/main`,
  `${C2} refs/heads/dev`,
  `${T1} refs/tags/v1.0.0 peeled:${C2}`,
  `${C1} refs/tags/v0.9.0`,
];

interface Hop {
  url: string;
  method: string;
  headers: Headers;
  body: Uint8Array | undefined;
}

function harness(
  advert: Response | (() => Response),
  lsBody: Response | (() => Response) = new Response(lsRefsBody(GOOD_LS), {
    headers: { 'content-type': RESULT },
  }),
) {
  const hops: Hop[] = [];
  const policyFetch = createPolicyFetch({
    policy,
    userAgent: 'package-broker-test',
    fetchImpl: async (input, init) => {
      hops.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: new Headers(init?.headers),
        body: init?.body as Uint8Array | undefined,
      });
      const pick = init?.method === 'POST' ? lsBody : advert;
      return typeof pick === 'function' ? pick() : pick.clone();
    },
  });
  return { hops, policyFetch };
}

const advertResponse = (body = advertisement(), type = ADVERT) =>
  new Response(body, { headers: { 'content-type': type } });

const credential: UpstreamCredential = {
  origins: ['https://git.example.com'],
  queryParams: [],
  apply(headers, url) {
    const out = new Headers(headers);
    out.set('authorization', `Basic ${SECRET}`);
    return { headers: out, url };
  },
};

const lsResponse = (body: Uint8Array, type = RESULT) =>
  new Response(body, { headers: { 'content-type': type } });

function trackedStream(bytes: Uint8Array): {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
} {
  let cancelled = false;
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return;
      sent = true;
      controller.enqueue(bytes);
    },
    cancel() {
      cancelled = true;
    },
  });
  return { stream, cancelled: () => cancelled };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function lsOf(lines: string[]) {
  return harness(advertResponse(), lsResponse(lsRefsBody(lines))).policyFetch;
}

function padCaps(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `x-pad${i}=${'a'.repeat(60000)}`);
}

function lsBodyOfSize(total: number): Uint8Array {
  const line = (name: string) => `${C1} ${name}\n`;
  const full = 46 + 900;
  const k = Math.floor((total - 4 - 70) / full);
  const name = (i: number, length: number) =>
    `refs/heads/${String(i).padStart(7, '0')}`.padEnd(length, 'x');
  const lines = Array.from({ length: k }, (_, i) => line(name(i, 900)));
  const rest = total - 4 - k * full;
  lines.push(line(name(k, rest - 46)));
  const out = pkts(...lines, FLUSH);
  expect(out.length).toBe(total);
  return out;
}

describe('lsRefs', () => {
  it('lists heads, tags, peeled commits and the HEAD symref', async () => {
    const { policyFetch } = harness(advertResponse());
    expect(await lsRefs(policyFetch, REPO)).toEqual({
      skipped: 0,
      refs: [
        { name: 'HEAD', oid: C1, symref: 'refs/heads/main' },
        { name: 'refs/heads/main', oid: C1 },
        { name: 'refs/heads/dev', oid: C2 },
        { name: 'refs/tags/v1.0.0', oid: T1, peeled: C2 },
        { name: 'refs/tags/v0.9.0', oid: C1 },
      ],
    });
  });

  it('replays a GitHub-style v2 exchange (hand-built from the wire format)', async () => {
    const advert = pkts(
      '# service=git-upload-pack\n',
      FLUSH,
      'version 2\n',
      'agent=git/github-g5b3a1f2c9d1a-Linux\n',
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done filter\n',
      'server-option\n',
      'object-format=sha1\n',
      FLUSH,
    );
    const ls = pkts(
      `${C1} HEAD symref-target:refs/heads/main\n`,
      `${C1} refs/heads/main\n`,
      `${C2} refs/heads/release/1.x\n`,
      `${T1} refs/tags/v2.0.0 peeled:${C1}\n`,
      `${C2} refs/tags/v1.9.0\n`,
      FLUSH,
    );
    const { policyFetch } = harness(advertResponse(advert), lsResponse(ls));
    const result = await lsRefs(policyFetch, REPO, credential);
    expect(result.skipped).toBe(0);
    expect(result.refs.map((r) => r.name)).toEqual([
      'HEAD',
      'refs/heads/main',
      'refs/heads/release/1.x',
      'refs/tags/v2.0.0',
      'refs/tags/v1.9.0',
    ]);
    expect(result.refs[3]).toEqual({ name: 'refs/tags/v2.0.0', oid: T1, peeled: C1 });
  });

  it('refuses a v1 advertisement with peeled tags and a HEAD symref (hand-built)', async () => {
    const v1 = pkts(
      '# service=git-upload-pack\n',
      FLUSH,
      `${C1} HEAD\0multi_ack thin-pack side-band-64k ofs-delta symref=HEAD:refs/heads/main agent=git/2.39.0\n`,
      `${C1} refs/heads/main\n`,
      `${T1} refs/tags/v1.0.0\n`,
      `${C2} refs/tags/v1.0.0^{}\n`,
      FLUSH,
    );
    const { hops, policyFetch } = harness(advertResponse(v1));
    await expect(lsRefs(policyFetch, REPO)).rejects.toMatchObject({
      code: 'unsupported_protocol',
    });
    expect(hops).toHaveLength(1);
  });

  it('sends the discovery and ls-refs requests with the expected headers and body', async () => {
    const { hops, policyFetch } = harness(advertResponse());
    await lsRefs(policyFetch, `${REPO}/`, credential);
    expect(hops).toHaveLength(2);
    const [get, post] = hops as [Hop, Hop];
    expect(get.method).toBe('GET');
    expect(get.url).toBe(`${REPO}/info/refs?service=git-upload-pack`);
    expect(get.headers.get('git-protocol')).toBe('version=2');
    expect(get.headers.get('accept')).toBe(ADVERT);
    expect(get.headers.get('authorization')).toBe(`Basic ${SECRET}`);
    expect(post.method).toBe('POST');
    expect(post.url).toBe(`${REPO}/git-upload-pack`);
    expect(post.headers.get('git-protocol')).toBe('version=2');
    expect(post.headers.get('content-type')).toBe('application/x-git-upload-pack-request');
    expect(post.headers.get('accept')).toBe(RESULT);
    expect(post.headers.get('authorization')).toBe(`Basic ${SECRET}`);
    const body = dec.decode(post.body);
    expect(body).toBe(
      [
        '0014command=ls-refs\n',
        '0019agent=package-broker\n',
        '0001',
        '0009peel\n',
        '000csymrefs\n',
        '0014ref-prefix HEAD\n',
        '001bref-prefix refs/heads/\n',
        '001aref-prefix refs/tags/\n',
        '0000',
      ].join(''),
    );
    expect(body.includes(dec.decode(DELIM))).toBe(true);
  });

  it('omits agent= when the server does not advertise one', async () => {
    const { hops, policyFetch } = harness(advertResponse(advertisement(['ls-refs'])));
    await lsRefs(policyFetch, REPO);
    expect(dec.decode(hops[1]?.body)).not.toContain('agent=');
  });

  it('accepts an advertisement without the # service= header and with a charset parameter', async () => {
    const plain = pkts('version 2\n', 'ls-refs\n', FLUSH);
    const { policyFetch } = harness(advertResponse(plain, `${ADVERT.toUpperCase()}; charset=x`));
    expect((await lsRefs(policyFetch, REPO)).refs).toHaveLength(5);
  });

  it('accepts a # service= header without the flush after it', async () => {
    const noFlush = pkts('# service=git-upload-pack\n', 'version 2\n', 'ls-refs\n', FLUSH);
    const { policyFetch } = harness(advertResponse(noFlush));
    expect((await lsRefs(policyFetch, REPO)).refs).toHaveLength(5);
  });

  it('refuses another # service= value', async () => {
    const other = pkts('# service=git-receive-pack\n', FLUSH, 'version 2\n', 'ls-refs\n', FLUSH);
    await expect(lsRefs(harness(advertResponse(other)).policyFetch, REPO)).rejects.toMatchObject({
      code: 'not_smart',
    });
  });

  it('refuses a text/plain advertisement and a missing content type as not_smart', async () => {
    const plain = harness(advertResponse(advertisement(), 'text/plain'));
    await expect(lsRefs(plain.policyFetch, REPO)).rejects.toMatchObject({
      name: 'GitRefsError',
      code: 'not_smart',
    });
    const none = harness(() => new Response(advertisement()));
    await expect(lsRefs(none.policyFetch, REPO)).rejects.toMatchObject({ code: 'not_smart' });
  });

  it('refuses an ls-refs answer with the wrong content type', async () => {
    const { policyFetch } = harness(advertResponse(), lsResponse(lsRefsBody(GOOD_LS), 'text/html'));
    await expect(lsRefs(policyFetch, REPO)).rejects.toMatchObject({ code: 'not_smart' });
  });

  it('refuses a server without ls-refs or with a non-sha1 object format', async () => {
    const none = advertisement(['fetch=shallow']);
    await expect(lsRefs(harness(advertResponse(none)).policyFetch, REPO)).rejects.toMatchObject({
      code: 'unsupported_protocol',
    });
    const sha256 = advertisement(['ls-refs', 'object-format=sha256']);
    await expect(lsRefs(harness(advertResponse(sha256)).policyFetch, REPO)).rejects.toMatchObject({
      code: 'unsupported_protocol',
    });
  });

  it('surfaces ERR packets as typed errors without echoing upstream text', async () => {
    const err = pkts('ERR access denied for hunter2\n');
    const first = await lsRefs(harness(advertResponse(err)).policyFetch, REPO).catch((e) => e);
    expect(first).toBeInstanceOf(GitRemoteError);
    expect(String(first.message)).not.toContain('hunter2');
    const second = await lsRefs(
      harness(advertResponse(), lsResponse(pkts('ERR boom hunter2\n'))).policyFetch,
      REPO,
    ).catch((e) => e);
    expect(second).toMatchObject({ code: 'remote_error' });
    expect(String(second.message)).not.toContain('hunter2');
  });

  it('maps a non-success status to an upstream error', async () => {
    const { policyFetch } = harness(() => new Response('no', { status: 404 }));
    await expect(lsRefs(policyFetch, REPO)).rejects.toMatchObject({
      name: 'UpstreamError',
      code: 'http_status',
      status: 404,
    });
  });

  it.each([
    ['bad oid', `${'z'.repeat(40)} refs/heads/main`],
    ['short oid', `${'a'.repeat(39)} refs/heads/main`],
    ['uppercase oid', `${'A'.repeat(40)} refs/heads/main`],
    ['bad peeled value', `${C1} refs/tags/v1 peeled:xyz`],
    ['missing name', C1],
    ['no-break space is not a separator', `${C1}${String.fromCharCode(160)}refs/heads/x`],
    ['repeated peeled', `${C1} refs/tags/v1 peeled:${C2} peeled:${C2}`],
    ['repeated symref-target', `${C1} HEAD symref-target:refs/heads/a symref-target:refs/heads/b`],
  ])('rejects a structurally malformed line: %s', async (_label, line) => {
    await expect(lsRefs(lsOf([line]), REPO)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('keeps a branch alias with symref-target as an ordinary ref', async () => {
    const result = await lsRefs(
      lsOf([
        `${C1} refs/heads/main`,
        `${C1} refs/heads/master symref-target:refs/heads/main`,
        `${C1} refs/heads/bad symref-target:refs/heads/../x`,
      ]),
      REPO,
    );
    expect(result).toEqual({
      skipped: 0,
      refs: [
        { name: 'refs/heads/main', oid: C1 },
        { name: 'refs/heads/master', oid: C1, symref: 'refs/heads/main' },
        { name: 'refs/heads/bad', oid: C1 },
      ],
    });
  });

  it('ignores peeled on a non-tag ref and keeps names starting with a dash', async () => {
    const result = await lsRefs(
      lsOf([`${C1} refs/heads/a peeled:${C2}`, `${C1} refs/heads/-x`]),
      REPO,
    );
    expect(result.refs).toEqual([
      { name: 'refs/heads/a', oid: C1 },
      { name: 'refs/heads/-x', oid: C1 },
    ]);
  });

  it('caps the number of capability lines', async () => {
    const many = pkts(
      'version 2\n',
      'ls-refs\n',
      ...Array.from({ length: 1001 }, (_, i) => `c${i}\n`),
      FLUSH,
    );
    await expect(lsRefs(harness(advertResponse(many)).policyFetch, REPO)).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('filters refs outside the requested prefixes without counting them', async () => {
    const result = await lsRefs(
      lsOf([
        `${C1} refs/heads/a`,
        `${C1} refs/pull/1/head`,
        `${C1} refs/notes/x`,
        `${C1} refs/../x`,
      ]),
      REPO,
    );
    expect(result).toEqual({ skipped: 0, refs: [{ name: 'refs/heads/a', oid: C1 }] });
  });

  it.each([
    ['traversal', 'refs/heads/../x'],
    ['control character', 'refs/heads/a\u0001b'],
    ['non-ASCII', 'refs/heads/café'],
    ['forbidden character', 'refs/heads/a:b'],
    ['at-brace', 'refs/heads/a@{b'],
    ['empty component', 'refs/heads//a'],
    ['trailing slash', 'refs/heads/a/'],
    ['component starting with a dot', 'refs/heads/.a'],
    ['lock suffix', 'refs/heads/a.lock'],
    ['trailing dot', 'refs/heads/a.'],
    ['too long', `refs/heads/${'a'.repeat(1100)}`],
    ['nothing after the prefix', 'refs/tags/'],
  ])('skips and counts a ref with an invalid name: %s', async (_label, name) => {
    const result = await lsRefs(lsOf([`${C1} refs/heads/ok`, `${C2} ${name}`]), REPO);
    expect(result).toEqual({ skipped: 1, refs: [{ name: 'refs/heads/ok', oid: C1 }] });
  });

  it('keeps names that merely look unusual but are valid', async () => {
    const result = await lsRefs(
      lsOf([`${C1} refs/heads/feature/a.b`, `${C1} refs/heads/a@b`, `${C1} refs/tags/v1.0.0-rc.1`]),
      REPO,
    );
    expect(result.skipped).toBe(0);
    expect(result.refs).toHaveLength(3);
  });

  it('drops only the symref when the HEAD target is invalid, and counts it', async () => {
    const result = await lsRefs(
      lsOf([`${C1} HEAD symref-target:refs/heads/../x`, `${C1} refs/heads/a`]),
      REPO,
    );
    expect(result).toEqual({
      skipped: 1,
      refs: [
        { name: 'HEAD', oid: C1 },
        { name: 'refs/heads/a', oid: C1 },
      ],
    });
    const other = await lsRefs(lsOf([`${C1} HEAD symref-target:refs/remotes/o/main`]), REPO);
    expect(other.refs).toEqual([{ name: 'HEAD', oid: C1 }]);
  });

  it('rejects duplicate ref names', async () => {
    await expect(
      lsRefs(lsOf([`${C1} refs/heads/a`, `${C2} refs/heads/a`]), REPO),
    ).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('enforces the ref-count cap inside the read loop', async () => {
    const lines = Array.from({ length: 50_001 }, (_, i) => `${C1} refs/pull/${i}/head`);
    await expect(lsRefs(lsOf(lines), REPO)).rejects.toMatchObject({
      code: 'bad_response',
      reason: 'too_many_refs',
    });
    const ok = Array.from({ length: 50_000 }, (_, i) => `${C1} refs/heads/b${i}`);
    expect((await lsRefs(lsOf(ok), REPO)).refs).toHaveLength(50_000);
  });

  it('rejects an ls-refs answer without a closing flush and data after it', async () => {
    const open = lsResponse(pkts(`${C1} refs/heads/a\n`));
    await expect(lsRefs(harness(advertResponse(), open).policyFetch, REPO)).rejects.toMatchObject({
      code: 'bad_response',
    });
    const extra = lsResponse(pkts(`${C1} refs/heads/a\n`, FLUSH, `${C2} refs/heads/b\n`));
    await expect(lsRefs(harness(advertResponse(), extra).policyFetch, REPO)).rejects.toMatchObject({
      code: 'bad_response',
    });
  });

  it('normalises pkt-line failures to GitRefsError', async () => {
    const oversized = lsResponse(new TextEncoder().encode('fff1'));
    await expect(
      lsRefs(harness(advertResponse(), oversized).policyFetch, REPO),
    ).rejects.toMatchObject({ name: 'GitRefsError', code: 'bad_response' });
    const truncated = lsResponse(new TextEncoder().encode('0030abc'));
    await expect(
      lsRefs(harness(advertResponse(), truncated).policyFetch, REPO),
    ).rejects.toMatchObject({ name: 'GitRefsError', code: 'bad_response' });
  });

  it.each([
    ['unexpected delimiter', pkts(`${C1} refs/heads/a\n`, DELIM, FLUSH)],
    ['invalid UTF-8', pkts(encodePkt(new Uint8Array([0xff, 0xfe])), FLUSH)],
    ['ERR packet', pkts('ERR no\n')],
    ['malformed line', pkts('garbage\n', FLUSH)],
  ])('cancels the ls-refs stream on %s', async (_label, bytes) => {
    const tracked = trackedStream(bytes);
    const reply = new Response(tracked.stream, { headers: { 'content-type': RESULT } });
    await expect(
      lsRefs(harness(advertResponse(), () => reply).policyFetch, REPO),
    ).rejects.toThrow();
    await settle();
    expect(tracked.cancelled()).toBe(true);
  });

  it('cancels the advertisement stream when parsing fails', async () => {
    const tracked = trackedStream(pkts('version 2\n', DELIM, FLUSH));
    const reply = new Response(tracked.stream, { headers: { 'content-type': ADVERT } });
    await expect(lsRefs(harness(() => reply).policyFetch, REPO)).rejects.toThrow();
    await settle();
    expect(tracked.cancelled()).toBe(true);
  });

  it('cancels the stream of a refused content type and a bad status', async () => {
    const wrong = trackedStream(advertisement());
    const reply = new Response(wrong.stream, { headers: { 'content-type': 'text/plain' } });
    await expect(lsRefs(harness(() => reply).policyFetch, REPO)).rejects.toThrow();
    await settle();
    expect(wrong.cancelled()).toBe(true);
  });

  describe('8 MiB budget', () => {
    it('fails when two individually valid responses exceed the cap together', async () => {
      const advert = advertisement(['ls-refs', ...padCaps(90)]);
      const ls = lsBodyOfSize(3.5 * 1024 * 1024);
      expect(advert.length).toBeLessThan(MAX_LS_REFS_BYTES);
      expect(advert.length + ls.length).toBeGreaterThan(MAX_LS_REFS_BYTES);
      await expect(
        lsRefs(harness(advertResponse(advert), lsResponse(ls)).policyFetch, REPO),
      ).rejects.toMatchObject({ name: 'GitRefsError', code: 'too_large' });
      const alone = harness(advertResponse(advertisement(['ls-refs'])), lsResponse(ls));
      expect((await lsRefs(alone.policyFetch, REPO)).refs.length).toBeGreaterThan(1000);
    });

    it('succeeds when the sum is exactly the cap and fails one byte over', async () => {
      const advert = advertisement(['ls-refs', ...padCaps(60)]);
      const exact = lsBodyOfSize(MAX_LS_REFS_BYTES - advert.length);
      const ok = await lsRefs(harness(advertResponse(advert), lsResponse(exact)).policyFetch, REPO);
      expect(ok.refs.length).toBeGreaterThan(1000);
      const over = lsBodyOfSize(MAX_LS_REFS_BYTES - advert.length + 1);
      await expect(
        lsRefs(harness(advertResponse(advert), lsResponse(over)).policyFetch, REPO),
      ).rejects.toMatchObject({ name: 'GitRefsError', code: 'too_large' });
    });

    it('rejects a single response over the cap', async () => {
      const big = lsResponse(lsBodyOfSize(MAX_LS_REFS_BYTES + 1024));
      await expect(lsRefs(harness(advertResponse(), big).policyFetch, REPO)).rejects.toMatchObject({
        name: 'GitRefsError',
        code: 'too_large',
      });
    });
  });

  it.each([
    ['https://user:pw@git.example.com/a.git'],
    ['https://git.example.com/a.git?token=x'],
    ['https://git.example.com/a.git#frag'],
    ['http://git.example.com/a.git'],
    ['ssh://git.example.com/a.git'],
    ['not a url'],
  ])('refuses a repository url that is not plain https: %s', async (url) => {
    const { hops, policyFetch } = harness(advertResponse());
    await expect(lsRefs(policyFetch, url)).rejects.toBeInstanceOf(GitRefsError);
    expect(hops).toHaveLength(0);
  });

  it('keeps credentials out of error messages', async () => {
    const { policyFetch } = harness(advertResponse(advertisement(), 'text/plain'));
    const error = await lsRefs(policyFetch, REPO, credential).catch((e: Error) => e);
    expect(String((error as Error).message)).not.toContain(SECRET);
  });
});

describe('lsRefs advertised capabilities', () => {
  const report = async (caps?: string[]) => {
    const seen: unknown[] = [];
    const { policyFetch } = harness(advertResponse(advertisement(caps)));
    await lsRefs(policyFetch, REPO, undefined, (capabilities) => seen.push(capabilities));
    return seen;
  };

  it('reports filter support when the fetch capability lists filter', async () => {
    expect(await report(['ls-refs=unborn', 'fetch=shallow wait-for-done filter'])).toEqual([
      { filter: true },
    ]);
  });

  it('reports no filter support when the fetch capability omits it', async () => {
    expect(await report(['ls-refs=unborn', 'fetch=shallow'])).toEqual([{ filter: false }]);
  });

  it('reports no filter support when fetch is not advertised', async () => {
    expect(await report(['ls-refs=unborn'])).toEqual([{ filter: false }]);
  });

  it('does not report capabilities when discovery fails', async () => {
    const seen: unknown[] = [];
    const { policyFetch } = harness(advertResponse(advertisement(), 'text/plain'));
    await expect(
      lsRefs(policyFetch, REPO, undefined, (capabilities) => seen.push(capabilities)),
    ).rejects.toBeInstanceOf(GitRefsError);
    expect(seen).toEqual([]);
  });
});

describe('discoverCapabilities', () => {
  it.each([true, false])(
    'discovers filter=%s with only an advertisement request',
    async (filter) => {
      const { policyFetch, hops } = harness(
        advertResponse(
          advertisement(['ls-refs', filter ? 'fetch=shallow filter' : 'fetch=shallow']),
        ),
        () => {
          throw new Error('must not list refs');
        },
      );
      expect(await discoverCapabilities(policyFetch, REPO, credential)).toEqual({ filter });
      expect(hops).toHaveLength(1);
      expect(hops[0]!.method).toBe('GET');
      expect(hops[0]!.headers.has('authorization')).toBe(true);
    },
  );

  it('normalizes malformed discovery packets without listing refs', async () => {
    const { policyFetch, hops } = harness(advertResponse(new TextEncoder().encode('0030abc')));
    await expect(discoverCapabilities(policyFetch, REPO)).rejects.toMatchObject({
      name: 'GitRefsError',
      code: 'bad_response',
    });
    expect(hops).toHaveLength(1);
  });
});
