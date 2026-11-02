import { describe, expect, it } from 'vitest';
import { MAX_CLIENT_HINT_BYTES, normalizeClientHints } from './client-hints.js';

const UNKNOWN = { family: 'unknown', version: null };

describe('normalizeClientHints', () => {
  it('normalizes the supported npm, pnpm, yarn and Composer user agents', () => {
    expect(
      normalizeClientHints('npm/10.2.4 node/v20.11.0 darwin x64 workspaces/false', 'npm'),
    ).toEqual({
      family: 'npm',
      version: '10.2.4',
    });
    expect(normalizeClientHints('pnpm/9.12.1 npm/? node/v20.11.0 darwin arm64', 'npm')).toEqual({
      family: 'pnpm',
      version: '9.12.1',
    });
    expect(normalizeClientHints('yarn/1.22.19 npm/? node/v18.19.0 linux x64', 'npm')).toEqual({
      family: 'yarn',
      version: '1.22.19',
    });
    expect(normalizeClientHints('yarn/4.5.0 npm/? node/v22.1.0 linux x64', 'npm')).toEqual({
      family: 'yarn',
      version: '4.5.0',
    });
    expect(
      normalizeClientHints('Composer/2.7.1 (Darwin; 23.2.0; PHP 8.3.2; cURL 8.4.0)', 'composer'),
    ).toEqual({ family: 'composer', version: '2.7.1' });
  });

  it('returns a fresh frozen value holding no raw header text', () => {
    const raw = 'npm/10.2.4 node/v20.11.0 secret-token-abc';
    const hints = normalizeClientHints(raw, 'npm');
    expect(Object.isFrozen(hints)).toBe(true);
    expect(Object.keys(hints)).toEqual(['family', 'version']);
    expect(JSON.stringify(hints)).not.toContain('secret');
  });

  it('treats absent, oversized and malformed input as unknown', () => {
    for (const raw of [
      null,
      undefined,
      '',
      '   ',
      'curl/8.4.0',
      'Mozilla/5.0 (Macintosh)',
      'npm',
      'npm/',
      'npm/10',
      'npm/10.2',
      'npm/10.2.4.1',
      'npm/010.2.4',
      'npm/10.2.4x',
      'npm/1234567890.0.0',
      'npm/10.2.4\u0000node',
      'npm/10.2.4\nX-Injected: 1',
      `npm/10.2.4 ${'x'.repeat(MAX_CLIENT_HINT_BYTES)}`,
      `npm/10.2.4 ${'é'.repeat(MAX_CLIENT_HINT_BYTES / 2)}`,
      42,
      { toString: () => 'npm/10.2.4' },
    ]) {
      expect(normalizeClientHints(raw, 'npm'), String(raw).slice(0, 40)).toEqual(UNKNOWN);
    }
  });

  it('accepts input at exactly the byte bound', () => {
    const head = 'npm/10.2.4 ';
    const raw = head + 'x'.repeat(MAX_CLIENT_HINT_BYTES - head.length);
    expect(normalizeClientHints(raw, 'npm')).toEqual({ family: 'npm', version: '10.2.4' });
  });

  it('treats prerelease and build versions as unknown', () => {
    for (const raw of [
      'npm/11.0.0-pre.1 node/v22.0.0',
      'pnpm/10.0.0-rc.3 npm/? node/v22.0.0',
      'yarn/4.0.0-rc.42 npm/? node/v20.0.0',
      'Composer/2.8.0-dev (Linux)',
      'Composer/2.8.0+build (Linux)',
    ]) {
      expect(normalizeClientHints(raw, raw.startsWith('Composer') ? 'composer' : 'npm')).toEqual(
        UNKNOWN,
      );
    }
  });

  it('treats ambiguous family claims as unknown', () => {
    for (const raw of [
      'npm/10.2.4 pnpm/9.0.0 node/v20.0.0',
      'pnpm/9.0.0 yarn/4.0.0 node/v20.0.0',
      'yarn/1.22.19 npm/10.2.4 node/v20.0.0',
      'node/v20.0.0 npm/10.2.4',
    ]) {
      expect(normalizeClientHints(raw, 'npm'), raw).toEqual(UNKNOWN);
    }
  });

  it('never takes an Object prototype key for a family', () => {
    expect(normalizeClientHints('npm/10.2.4 constructor/1.0.0 node/v20.0.0', 'npm')).toEqual({
      family: 'npm',
      version: '10.2.4',
    });
    expect(normalizeClientHints('Composer/2.7.1 Constructor/1.0.0', 'composer')).toEqual({
      family: 'composer',
      version: '2.7.1',
    });
    expect(normalizeClientHints('constructor/1.0.0', 'npm')).toEqual(UNKNOWN);
  });

  it('treats a client of the other ecosystem as unknown', () => {
    expect(normalizeClientHints('Composer/2.7.1 (Linux)', 'npm')).toEqual(UNKNOWN);
    expect(normalizeClientHints('npm/10.2.4 node/v20.0.0', 'composer')).toEqual(UNKNOWN);
  });
});
