import { describe, expect, it, vi } from 'vitest';
import { runSourceAcceptRemoval } from './source.js';

const options = {
  url: 'https://broker.test',
  source: '01JA0000000000000000000003',
  env: { PB_SESSION: 'A'.repeat(43), PB_CSRF_TOKEN: 'B'.repeat(43) },
};

describe('source accept-removal', () => {
  it('sends the acceptance with session and CSRF authentication', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    expect(await runSourceAcceptRemoval({ ...options, fetch })).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      new URL(`https://broker.test/_pb/sources/${options.source}/accept-removal`),
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          origin: 'https://broker.test',
          cookie: `__Host-pb_session=${options.env.PB_SESSION}`,
          'x-csrf-token': options.env.PB_CSRF_TOKEN,
        },
      },
    );
  });

  it.each(['not-a-ulid', '', '01JA0000000000000000000003/../x'])(
    'rejects invalid source %j',
    async (source) => {
      const fetch = vi.fn();
      expect(await runSourceAcceptRemoval({ ...options, source, fetch })).toBe(2);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    'http://broker.test',
    'https://secret@broker.test',
    'https://broker.test/?token=secret',
  ])('rejects unsafe origins', async (url) => {
    const fetch = vi.fn();
    expect(await runSourceAcceptRemoval({ ...options, url, fetch })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 500])('does not print response data on HTTP %s', async (status) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('secret-account@example.test', { status }));
      expect(await runSourceAcceptRemoval({ ...options, fetch })).toBe(1);
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret-account');
    } finally {
      error.mockRestore();
    }
  });

  it('reports an unknown outcome without echoing a network error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('secret'));
    expect(await runSourceAcceptRemoval({ ...options, fetch })).toBe(6);
  });
});
