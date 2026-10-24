import { describe, expect, it } from 'vitest';
import { composerAvailable, redactComposerOutput } from './composer-output.js';

describe('Composer diagnostics', () => {
  it('redacts raw, encoded and Basic credential forms before excerpting', () => {
    const secrets = ['github_pat_private', 'ghs_private', 'password:/+?', 'broker-token'];
    const forms = secrets.flatMap((secret) =>
      [secret, `x-access-token:${secret}`, `${secret}:`].flatMap((value) => {
        const base64 = Buffer.from(value).toString('base64');
        return [value, base64, encodeURIComponent(value), encodeURIComponent(base64)];
      }),
    );
    const output = redactComposerOutput(`failure ${forms.join('\n')} end`, secrets);
    expect(output).toContain('failure');
    expect(output).toContain('end');
    for (const form of forms) expect(output).not.toContain(form);
  });
  it('redacts a literal Basic authorization line', () => {
    expect(
      redactComposerOutput('Authorization: Basic eC1hY2Nlc3MtdG9rZW46Z2hwX3Rlc3Q=', ['ghp_test']),
    ).toBe('Authorization: Basic [redacted]');
  });
  it.each(['true', ''])('fails a missing or broken Composer in CI (%j)', async (ci) => {
    await expect(composerAvailable(() => Promise.reject(new Error('private')), ci)).rejects.toThrow(
      'ComposerUnavailable',
    );
  });
  it('permits a local skip and accepts a working Composer', async () => {
    expect(await composerAvailable(() => Promise.reject(new Error()), null)).toBe(false);
    expect(await composerAvailable(() => Promise.resolve(), 'true')).toBe(true);
  });
});
