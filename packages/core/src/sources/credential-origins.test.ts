import { describe, expect, it } from 'vitest';
import type { SourceRecord } from '../db/source.js';
import { sourceCredentialOrigins } from './credential-origins.js';

describe.each(['node', 'cloudflare'] as const)('%s Packagist credential origins', (runtime) => {
  const options = { runtime, policy: { runtime, selfOrigins: [], allowPrivateHosts: [] } };
  const source = (configJson: string, credentialId: string | null = 'token'): SourceRecord =>
    ({
      type: 'packagist_proxy',
      ecosystem: 'composer',
      url: 'https://repo.packagist.org',
      configJson,
      credentialId,
    }) as SourceRecord;

  it.each([
    '{}',
    '{"githubToken":false}',
    '{"githubToken":"true"}',
    '{"githubToken":1}',
    '{"githubToken":null}',
    '{"githubToken":true,"unknown":true}',
    'null',
    '{',
  ])('does not bind a stored credential for disabled or invalid config %s', (config) => {
    expect(sourceCredentialOrigins(source(config), options)).toBeNull();
  });
  it('binds explicitly enabled token mode to exactly the two GitHub origins', () => {
    expect(sourceCredentialOrigins(source('{"githubToken":true}'), options)).toEqual([
      'https://api.github.com',
      'https://codeload.github.com',
    ]);
  });
  it('rejects token mode without a stored credential', () => {
    expect(sourceCredentialOrigins(source('{"githubToken":true}', null), options)).toBeNull();
  });
});

describe.each(['node', 'cloudflare'] as const)('%s source credential origins', (runtime) => {
  const options = { runtime, policy: { runtime, selfOrigins: [], allowPrivateHosts: [] } };
  const source = (overrides: Partial<SourceRecord> = {}): SourceRecord =>
    ({
      type: 'composer_repository',
      ecosystem: 'composer',
      url: 'https://packages.example.com/path',
      configJson: '{}',
      credentialId: 'token',
      ...overrides,
    }) as SourceRecord;

  it.each([
    ['github', 'acme/lib', ['https://api.github.com']],
    [
      'git',
      'https://git.example.com/acme/lib.git',
      runtime === 'node' ? ['https://git.example.com'] : null,
    ],
    ['ssh', 'git@git.example.com:acme/lib.git', runtime === 'node' ? [] : null],
  ] as const)('restricts vcs %s origins', (provider, repository, expected) => {
    expect(
      sourceCredentialOrigins(
        source({ type: 'vcs', url: null, configJson: JSON.stringify({ provider, repository }) }),
        options,
      ),
    ).toEqual(expected);
  });
  it('rejects invalid vcs config', () => {
    expect(sourceCredentialOrigins(source({ type: 'vcs', url: null }), options)).toBeNull();
  });
  it.each([
    ['{}', ['https://packages.example.com']],
    [
      '{"distHosts":["dist.example.com"]}',
      ['https://packages.example.com', 'https://dist.example.com'],
    ],
    ['{"distHosts":["invalid host"]}', null],
  ])('uses composer repository origins for %s', (configJson, expected) => {
    expect(sourceCredentialOrigins(source({ configJson: configJson as string }), options)).toEqual(
      expected,
    );
  });
  it('rejects a composer repository without a URL', () => {
    expect(sourceCredentialOrigins(source({ url: null }), options)).toBeNull();
  });
  it('falls back to the npm registry URL origin', () => {
    expect(
      sourceCredentialOrigins(source({ type: 'npm_registry', ecosystem: 'npm' }), options),
    ).toEqual(['https://packages.example.com']);
  });
  it.each(['npmjs_proxy', 'hosted'] as const)('restricts %s fallback to Node', (type) => {
    expect(sourceCredentialOrigins(source({ type, ecosystem: 'npm' }), options)).toEqual(
      runtime === 'node' ? ['https://packages.example.com'] : null,
    );
  });
  it.each([null, 'invalid-url'])('rejects an unusable fallback URL %s', (url) => {
    expect(
      sourceCredentialOrigins(source({ type: 'npm_registry', ecosystem: 'npm', url }), options),
    ).toBeNull();
  });
});
