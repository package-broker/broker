import { describe, expect, it } from 'vitest';
import { DENIAL_MESSAGE, denialResponse } from './denial-page.js';

const SENTINEL = 'sentinel-secret-9f3a';

function req(accept?: string): Request {
  return new Request('https://broker.test/p/items/42', {
    headers: accept === undefined ? {} : { accept },
  });
}

describe('denialResponse', () => {
  it('returns the static page for a browser', async () => {
    const response = denialResponse(req('text/html,application/xhtml+xml,*/*;q=0.8'), 'rid-1');
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-request-id')).toBe('rid-1');
    const body = await response.text();
    expect(body).toContain(DENIAL_MESSAGE);
    expect(DENIAL_MESSAGE).toBe(
      'You do not have access. Ask an organization administrator to assign you to a project.',
    );
    expect(body).not.toMatch(/@|group|token|rid-1/i);
  });

  it.each([
    'application/json',
    '*/*',
    undefined,
    'text/html;q=0',
    'application/json,text/html;q=0.5',
  ])('returns the envelope for Accept %s', async (accept) => {
    const response = denialResponse(req(accept), 'rid-2');
    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    const body = (await response.json()) as { error: { code: string; requestId: string } };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.requestId).toBe('rid-2');
  });

  it('is identical for any request, so nothing from it is echoed', async () => {
    const probe = new Request(`https://broker.test/${SENTINEL}?t=${SENTINEL}`, {
      headers: { accept: 'text/html', authorization: `Bearer ${SENTINEL}`, cookie: SENTINEL },
    });
    const text = await denialResponse(probe, 'rid-3').text();
    expect(text).not.toContain(SENTINEL);
    expect(text).toBe(await denialResponse(req('text/html'), 'rid-4').text());
  });

  it.each([
    ['application/*', 'application/*,text/html;q=0.5'],
    ['*/*', '*/*,text/html;q=0.5'],
    ['*/* tie', 'text/html,*/*'],
    ['wildcard beats lower html', 'application/*;q=0.9,text/html;q=0.8'],
  ])('counts %s toward JSON quality', async (_name, accept) => {
    const response = denialResponse(req(accept), 'rid-6');
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it.each(['text/html;q=2', 'text/html;q=-1', 'text/html;q=abc'])(
    'ignores the out-of-range entry %s',
    (accept) => {
      const response = denialResponse(req(accept), 'rid-7');
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
    },
  );

  it('ignores an out-of-range JSON quality so HTML can win', () => {
    const response = denialResponse(req('application/json;q=5,text/html;q=0.1'), 'rid-8');
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
  });

  it('sends Vary: Accept on both representations', () => {
    expect(denialResponse(req('text/html'), 'r').headers.get('vary')).toBe('Accept');
    expect(denialResponse(req('application/json'), 'r').headers.get('vary')).toBe('Accept');
  });

  it('hardens the HTML page', () => {
    const { headers } = denialResponse(req('text/html'), 'r');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(headers.get('referrer-policy')).toBe('no-referrer');
  });
});

describe('Accept negotiation (RFC 9110 qvalues)', () => {
  it.each([
    'text/html;q=0, */*',
    'text/html;q=0.000,application/json',
    'text/html;q=1.0001',
    'text/html;q=1.1',
    'text/html;q=0.1234',
    'text/html;q=.5',
    'text/html;q=',
    'text/html;q=0.5abc',
    'text/html;q=1e0',
    'text/html;q=-0',
    'text/html;q=+1',
  ])('returns the envelope for Accept %s', async (accept) => {
    const response = denialResponse(req(accept), 'rid-q');
    expect(response.headers.get('content-type')).toMatch(/^application\/json/);
  });

  it.each([
    'text/html;q=0.9, application/json;q=0.8',
    'text/html;q=1, application/json;q=0.999',
    'text/html;q=1.000',
    'text/html;q=1.',
    'text/html;q=0.001',
    'text/html;level=1;q=0.5',
    'text/html;q=0.5;ext=1',
    'TEXT/HTML;Q=0.5',
    'application/json;q=1.0001, text/html;q=0.1',
    'application/json;q=0, text/html;q=0.1',
  ])('returns the page for Accept %s', (accept) => {
    const response = denialResponse(req(accept), 'rid-q');
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
  });
});
