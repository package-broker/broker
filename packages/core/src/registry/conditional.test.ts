import { describe, expect, it, vi } from 'vitest';
import type { ResolvedPackage } from '../db/catalogue.js';
import type { OrgContext, OrgId } from '../db/port.js';
import {
  composerValidators,
  isNotModified,
  notModifiedResponse,
  npmValidators,
  representationValidator,
  validatorHeaders,
  type ClockAdvance,
  type RepresentationClock,
} from './conditional.js';

const ctx = { orgId: 'org-a' as OrgId } as OrgContext;
const HEX64 = /^[0-9a-f]{64}$/;
const embedded = { projectSlug: 'acme', origin: null };

const pkg: ResolvedPackage = {
  projectId: 'proj-1',
  ecosystem: 'composer',
  key: 'acme/lib',
  packageId: 'pkg-1',
  sourceId: 'src-1',
  rev: 3,
  modifiedAt: '2026-10-16T10:00:00.000Z',
  createdAt: '2026-10-01T10:00:00.000Z',
  listingComplete: true,
  cacheEpoch: 'e1',
};

function memoryClock(start = Date.parse('2026-10-16T10:00:00Z')) {
  const rows = new Map<string, { validator: string; lastModified: number }>();
  let now = start;
  const writes: ClockAdvance[] = [];
  const clock: RepresentationClock = {
    advance: vi.fn(async (_ctx: OrgContext, input: ClockAdvance) => {
      const id = `${input.projectId}|${input.keyHash}|${input.form}`;
      const row = rows.get(id);
      const second = Math.floor(now / 1000) * 1000;
      if (row === undefined) {
        rows.set(id, { validator: input.validator, lastModified: second });
        writes.push(input);
      } else if (row.validator !== input.validator) {
        rows.set(id, {
          validator: input.validator,
          lastModified: Math.max(second, row.lastModified + 1000),
        });
        writes.push(input);
      }
      const current = rows.get(id)!;
      return {
        stale: false,
        validator: current.validator,
        lastModified: new Date(current.lastModified).toISOString().replace('.000Z', 'Z'),
      };
    }),
  };
  return { clock, writes, tick: (ms: number) => (now += ms) };
}

const get = (headers: Record<string, string> = {}) => ({
  method: 'GET',
  headers: new Headers(headers),
});

describe('representation validator', () => {
  it('is 64 hex and stable for the same representation', async () => {
    const a = await representationValidator(pkg, 'composer-p2', 1, embedded);
    expect(a).toMatch(HEX64);
    expect(await representationValidator({ ...pkg }, 'composer-p2', 1, embedded)).toBe(a);
  });

  it('changes with each component that defines the representation', async () => {
    const base = await representationValidator(pkg, 'composer-p2', 1, embedded);
    const variants = await Promise.all([
      representationValidator({ ...pkg, projectId: 'proj-2' }, 'composer-p2', 1, embedded),
      representationValidator(
        { ...pkg, packageId: 'pkg-2', sourceId: 'src-2' },
        'composer-p2',
        1,
        embedded,
      ),
      representationValidator({ ...pkg, rev: 4 }, 'composer-p2', 1, embedded),
      representationValidator(pkg, 'composer-p2-dev', 1, embedded),
      representationValidator({ ...pkg, cacheEpoch: 'e2' }, 'composer-p2', 1, embedded),
      representationValidator({ ...pkg, cacheEpoch: null }, 'composer-p2', 1, embedded),
      representationValidator(pkg, 'composer-p2', 2, embedded),
      representationValidator(pkg, 'composer-p2', 1, { ...embedded, projectSlug: 'other' }),
      representationValidator(pkg, 'composer-p2', 1, {
        ...embedded,
        origin: 'https://pkg.example.test',
      }),
    ]);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it('ignores modifiedAt, so an equal-timestamp swap is told apart only by identity', async () => {
    const a = await representationValidator(pkg, 'composer-p2', 1, embedded);
    expect(
      await representationValidator(
        { ...pkg, modifiedAt: '2027-01-01T00:00:00.000Z' },
        'composer-p2',
        1,
        embedded,
      ),
    ).toBe(a);
  });

  it('rejects an invalid renderer version', async () => {
    await expect(representationValidator(pkg, 'composer-p2', -1, embedded)).rejects.toThrow(
      RangeError,
    );
    await expect(representationValidator(pkg, 'composer-p2', 1.5, embedded)).rejects.toThrow(
      RangeError,
    );
  });
});

describe('composer validators', () => {
  it('omits Last-Modified for a stale reading and serves a conditional request with 200', async () => {
    const clock: RepresentationClock = {
      advance: async () => ({
        validator: 'f'.repeat(64),
        lastModified: '2026-10-16T10:00:00Z',
        stale: true,
      }),
    };
    const validators = await composerValidators(clock, ctx, pkg, 'composer-p2', 1, embedded);
    expect(validators).toEqual({});
    const request = get({ 'If-Modified-Since': 'Fri, 16 Oct 2026 10:00:00 GMT' });
    const response = isNotModified(request, validators)
      ? notModifiedResponse(validators, 'Authorization')
      : new Response('body', { headers: validatorHeaders(validators) });
    expect(response.status).toBe(200);
    expect(response.headers.has('Last-Modified')).toBe(false);
  });

  it('keys the clock by project, package name hash and form', async () => {
    const { clock } = memoryClock();
    await composerValidators(clock, ctx, pkg, 'composer-p2', 1, embedded);
    const [, input] = vi.mocked(clock.advance).mock.calls[0]!;
    expect(input.rev).toBe(pkg.rev);
    expect(input.packageId).toBe(pkg.packageId);
    expect(input.projectId).toBe('proj-1');
    expect(input.form).toBe('composer-p2');
    expect(input.keyHash).toMatch(HEX64);
    expect(input.validator).toBe(await representationValidator(pkg, 'composer-p2', 1, embedded));
  });

  it('returns Last-Modified as an IMF-fixdate', async () => {
    const { clock } = memoryClock();
    const v = await composerValidators(clock, ctx, pkg, 'composer-p2', 1, embedded);
    expect(v).toEqual({ lastModified: 'Fri, 16 Oct 2026 10:00:00 GMT' });
  });

  it('repeated requests for an unchanged representation keep Last-Modified and write nothing', async () => {
    const { clock, writes, tick } = memoryClock();
    const first = await composerValidators(clock, ctx, pkg, 'composer-p2', 1, embedded);
    tick(5000);
    const second = await composerValidators(clock, ctx, pkg, 'composer-p2', 1, embedded);
    expect(second).toEqual(first);
    expect(writes).toHaveLength(1);
  });

  it.each([
    ['an equal-timestamp winner swap', { ...pkg, packageId: 'pkg-2', sourceId: 'src-2' }, 1],
    ['a visibility (epoch) change', { ...pkg, cacheEpoch: 'e2' }, 1],
    ['a renderer version change', pkg, 2],
  ] as const)('%s within the same second gives a new Last-Modified', async (_, next, render) => {
    const { clock } = memoryClock();
    const first = await composerValidators(clock, ctx, pkg, 'composer-p2', 1, embedded);
    const second = await composerValidators(clock, ctx, next, 'composer-p2', render, embedded);
    expect(second.lastModified).not.toBe(first.lastModified);
    expect(isNotModified(get({ 'If-Modified-Since': first.lastModified! }), second)).toBe(false);
  });

  it('refuses a clock that returns another validator', async () => {
    const clock: RepresentationClock = {
      advance: async () => ({
        stale: false,
        validator: 'f'.repeat(64),
        lastModified: '2026-10-16T10:00:00Z',
      }),
    };
    await expect(composerValidators(clock, ctx, pkg, 'composer-p2', 1, embedded)).rejects.toThrow();
  });
});

describe('npm validators', () => {
  it('is a weak ETag over the first 16 hex of the representation validator', async () => {
    const full = await representationValidator(pkg, 'npm-full', 1, embedded);
    expect(await npmValidators(pkg, 'npm-full', 1, embedded)).toEqual({
      etag: `W/"${full.slice(0, 16)}"`,
    });
  });

  it('differs between packument forms', async () => {
    const full = await npmValidators(pkg, 'npm-full', 1, embedded);
    const abbreviated = await npmValidators(pkg, 'npm-abbreviated', 1, embedded);
    expect(full.etag).not.toBe(abbreviated.etag);
  });
});

describe('isNotModified', () => {
  const lastModified = 'Fri, 16 Oct 2026 10:00:00 GMT';

  it('returns 304 only for a byte-equal If-Modified-Since', () => {
    expect(isNotModified(get({ 'If-Modified-Since': lastModified }), { lastModified })).toBe(true);
    expect(
      isNotModified(
        { method: 'HEAD', headers: new Headers({ 'If-Modified-Since': lastModified }) },
        { lastModified },
      ),
    ).toBe(true);
  });

  it('returns 200 for an If-Modified-Since later than Last-Modified but not equal', () => {
    expect(
      isNotModified(get({ 'If-Modified-Since': 'Fri, 16 Oct 2026 10:00:01 GMT' }), {
        lastModified,
      }),
    ).toBe(false);
    expect(
      isNotModified(get({ 'If-Modified-Since': 'Sat, 01 Jan 2028 00:00:00 GMT' }), {
        lastModified,
      }),
    ).toBe(false);
  });

  it('returns 200 for an earlier, equivalent-but-differently-written or malformed date', () => {
    for (const value of [
      'Fri, 16 Oct 2026 09:59:59 GMT',
      'Friday, 16-Oct-26 10:00:00 GMT',
      'Fri Oct 16 10:00:00 2026',
      lastModified.toLowerCase(),
      'garbage',
    ]) {
      expect(isNotModified(get({ 'If-Modified-Since': value }), { lastModified })).toBe(false);
    }
  });

  it('returns 200 without a conditional header and for non-GET methods', () => {
    expect(isNotModified(get(), { lastModified })).toBe(false);
    expect(
      isNotModified(
        { method: 'POST', headers: new Headers({ 'If-Modified-Since': lastModified }) },
        { lastModified },
      ),
    ).toBe(false);
  });

  const etag = 'W/"0123456789abcdef"';

  it('matches If-None-Match lists with weak comparison', () => {
    expect(isNotModified(get({ 'If-None-Match': etag }), { etag })).toBe(true);
    expect(isNotModified(get({ 'If-None-Match': '"0123456789abcdef"' }), { etag })).toBe(true);
    expect(isNotModified(get({ 'If-None-Match': `"other", ${etag}` }), { etag })).toBe(true);
    expect(isNotModified(get({ 'If-None-Match': '*' }), { etag })).toBe(true);
  });

  it('matches If-None-Match * for a representation without an ETag', () => {
    expect(isNotModified(get({ 'If-None-Match': '*' }), { lastModified })).toBe(true);
  });

  it('tokenizes If-None-Match on quoted strings, not commas', () => {
    expect(isNotModified(get({ 'If-None-Match': '"a,b", W/"0123456789abcdef"' }), { etag })).toBe(
      true,
    );
    expect(isNotModified(get({ 'If-None-Match': '"a, W/"0123456789abcdef"' }), { etag })).toBe(
      false,
    );
    expect(isNotModified(get({ 'If-None-Match': '"a" W/"0123456789abcdef"' }), { etag })).toBe(
      false,
    );
  });

  it('does not match a different or malformed entity tag', () => {
    for (const value of [
      'W/"0123456789abcdee"',
      '0123456789abcdef',
      'W/0123456789abcdef',
      '"0123456789abcdef',
      '',
    ]) {
      expect(isNotModified(get({ 'If-None-Match': value }), { etag })).toBe(false);
    }
  });

  it('lets If-None-Match take precedence over If-Modified-Since', () => {
    const headers = { 'If-None-Match': '"nope"', 'If-Modified-Since': lastModified };
    expect(isNotModified(get(headers), { etag, lastModified })).toBe(false);
  });

  it('npm validators carry no Last-Modified, so If-Modified-Since alone never matches', () => {
    expect(isNotModified(get({ 'If-Modified-Since': lastModified }), { etag })).toBe(false);
  });
});

describe('notModifiedResponse', () => {
  it('is a bodiless 304 with validators and Vary', async () => {
    const response = notModifiedResponse({ etag: 'W/"0123456789abcdef"' }, 'Authorization, Accept');
    expect(response.status).toBe(304);
    expect(response.headers.get('ETag')).toBe('W/"0123456789abcdef"');
    expect(response.headers.get('Vary')).toBe('Authorization, Accept');
    expect(response.headers.has('Last-Modified')).toBe(false);
    expect(await response.text()).toBe('');
  });

  it('carries Last-Modified for Composer', () => {
    const response = notModifiedResponse(
      { lastModified: 'Fri, 16 Oct 2026 10:00:00 GMT' },
      'Authorization',
    );
    expect(response.headers.get('Last-Modified')).toBe('Fri, 16 Oct 2026 10:00:00 GMT');
    expect(response.headers.has('ETag')).toBe(false);
  });

  it('carries the cache headers the 200 would carry, without letting them replace validators', () => {
    const response = notModifiedResponse({ etag: 'W/"0123456789abcdef"' }, 'Authorization', {
      'Cache-Control': 'private, max-age=0, must-revalidate',
      Expires: 'Fri, 16 Oct 2026 10:00:00 GMT',
      ETag: '"spoofed"',
      Vary: '*',
    });
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=0, must-revalidate');
    expect(response.headers.get('Expires')).toBe('Fri, 16 Oct 2026 10:00:00 GMT');
    expect(response.headers.get('ETag')).toBe('W/"0123456789abcdef"');
    expect(response.headers.get('Vary')).toBe('Authorization');
  });

  it('drops a caller ETag when the representation has only Last-Modified', () => {
    const lastModified = 'Fri, 16 Oct 2026 10:00:00 GMT';
    const response = notModifiedResponse({ lastModified }, 'Authorization', { ETag: '"x"' });
    expect(response.headers.has('ETag')).toBe(false);
    expect(response.headers.get('Last-Modified')).toBe(lastModified);
  });
});
