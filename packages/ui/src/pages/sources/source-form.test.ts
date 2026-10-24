import { parseSourceConfig } from '@package-broker/core/sources/config';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import type { Source } from '../sources.js';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SourceForm, sourceSubmission, sourceFieldErrors } from './source-form.js';

function data(fields: Record<string, string> = {}) {
  const result = new FormData();
  for (const [key, value] of Object.entries({
    pollIntervalSeconds: '300',
    removalPolicy: 'flag',
    name: 'Upstream',
    ...fields,
  }))
    result.set(key, value);
  return result;
}

describe('source form request bodies', () => {
  it('builds composer selection lists without inventing nested URL fields', () => {
    expect(
      sourceSubmission(
        data({
          url: 'https://repo.example.test',
          'config/selection/packages': 'vendor/one\r\nvendor/two\n',
          'config/selection/patterns': 'vendor/*',
          'config/selection/expandPatterns': 'on',
          'config/distHosts': 'dist.example.test',
          'config/mirrorsFallback': 'on',
          defaultVisibleToNewProjects: 'on',
          retentionDaysOverride: '0',
        }),
        'composer',
        'composer_repository',
        false,
      ),
    ).toEqual({
      name: 'Upstream',
      ecosystem: 'composer',
      type: 'composer_repository',
      url: 'https://repo.example.test',
      userAgent: null,
      pollIntervalSeconds: 300,
      removalPolicy: 'flag',
      defaultVisibleToNewProjects: true,
      retentionDaysOverride: 0,
      config: {
        selection: {
          packages: ['vendor/one', 'vendor/two'],
          patterns: ['vendor/*'],
          expandPatterns: true,
        },
        distHosts: ['dist.example.test'],
        mirrorsFallback: true,
      },
    });
  });

  it.each(['github', 'git', 'ssh'])(
    'builds VCS provider %s with refs and optional fields',
    (provider) => {
      const result = sourceSubmission(
        data({
          'config/provider': provider,
          'config/repository': 'owner/repo',
          'config/installationId': '42',
          'config/packageName': 'vendor/package',
          'config/refs/branches': 'main\nrelease',
          'config/refs/tags': 'on',
          'config/scopes': '@stale',
        }),
        'composer',
        'vcs',
        false,
      );
      expect(result).not.toHaveProperty('url');
      expect(result.config).toEqual({
        provider,
        repository: 'owner/repo',
        ...(provider === 'github' ? { installationId: 42 } : {}),
        packageName: 'vendor/package',
        refs: { branches: ['main', 'release'], tags: true },
      });
    },
  );

  it('omits a stale installation ID in personal access token mode', () => {
    const result = sourceSubmission(
      data({
        'config/provider': 'github',
        'config/repository': 'owner/repo',
        githubAuthentication: 'token',
        'config/installationId': '42',
        'config/refs/tags': 'on',
      }),
      'composer',
      'vcs',
      false,
    );
    expect(result.config).toEqual({
      provider: 'github',
      repository: 'owner/repo',
      refs: { branches: [], tags: true },
    });
    expect(result).not.toHaveProperty('credential');
  });
  it('requires an installation ID for GitHub App mode', () => {
    expect(() =>
      sourceSubmission(
        data({ 'config/provider': 'github', githubAuthentication: 'app' }),
        'composer',
        'vcs',
        false,
      ),
    ).toThrow('Enter valid whole numbers');
  });

  it('sends only npm registry config fields when stale composer fields exist', () => {
    const result = sourceSubmission(
      data({
        'config/scopes': '@one\n@two',
        'config/distHosts': 'dist.example.test',
        'config/selection/packages': 'ignored',
        url: 'https://npm.example.test',
      }),
      'npm',
      'npm_registry',
      false,
    );
    expect(result.config).toEqual({ scopes: ['@one', '@two'], distHosts: ['dist.example.test'] });
  });

  it.each([
    ['packagist_proxy', 'composer', { githubToken: false }],
    ['npmjs_proxy', 'npm', {}],
  ] as const)('builds %s proxy config', (type, ecosystem, config) => {
    expect(
      sourceSubmission(
        data({ 'config/githubToken': 'on', 'config/scopes': '@stale' }),
        ecosystem,
        type,
        false,
      ).config,
    ).toEqual(config);
  });

  it('creates Packagist without a token using the actual service validator', () => {
    const body = sourceSubmission(
      data({ url: 'https://repo.packagist.org', 'config/githubToken': 'on' }),
      'composer',
      'packagist_proxy',
      false,
    );
    const options = {
      runtime: 'node' as const,
      policy: createOutboundPolicy({ runtime: 'node', allowPrivateHosts: [], selfOrigins: [] }),
      hasCredential: false,
    };
    const validate = (config: unknown, hasCredential = false) =>
      parseSourceConfig('packagist_proxy', 'composer', body.url ?? null, JSON.stringify(config), {
        ...options,
        hasCredential,
      });
    expect(validate({ githubToken: true }).ok).toBe(false);
    expect(validate(body.config).ok).toBe(true);
    expect(validate(body.config, true).ok).toBe(true);
  });

  it('enables Packagist token mode on explicit config replacement', () => {
    const body = sourceSubmission(
      data({ replaceConfig: 'on', 'config/githubToken': 'on' }),
      'composer',
      'packagist_proxy',
      true,
    );
    expect(body.config).toEqual({ githubToken: true });
  });

  it('preserves Packagist config unless replaced and supports disabling token mode', () => {
    expect(sourceSubmission(data(), 'composer', 'packagist_proxy', true)).not.toHaveProperty(
      'config',
    );
    expect(
      sourceSubmission(data({ replaceConfig: 'on' }), 'composer', 'packagist_proxy', true).config,
    ).toEqual({ githubToken: false });
  });

  it('offers Packagist config replacement and explains the setup sequence', () => {
    const source: Source = {
      id: 'packagist',
      name: 'Packagist',
      projectId: null,
      ecosystem: 'composer',
      type: 'packagist_proxy',
      url: 'https://repo.packagist.org',
      status: 'active',
      removalPolicy: 'flag',
      pollIntervalSeconds: 300,
      hasCredential: false,
      lastError: null,
      lastPolledAt: null,
      nextPollAt: null,
      lastSuccessAt: null,
      lastRemovalRefusal: null,
      removalAcceptanceArmed: false,
      attachedProjectCount: 0,
    };
    const html = renderToString(
      createElement(SourceForm, {
        source,
        busy: false,
        errors: {},
        alert: null,
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain('name="replaceConfig"');
    expect(html).not.toContain('setup is unavailable');
    expect(html).toContain('save a bearer credential with your GitHub token');
  });

  it('keeps unread config, network settings and defaults out of ordinary edits', () => {
    expect(
      sourceSubmission(
        data({ url: 'https://display-only.example.test' }),
        'composer',
        'composer_repository',
        true,
      ),
    ).toEqual({ pollIntervalSeconds: 300, removalPolicy: 'flag' });
  });

  it('allows explicit config replacement, false visibility and resetting retention to inheritance', () => {
    expect(
      sourceSubmission(
        data({
          replaceConfig: 'on',
          replaceDefaults: 'on',
          replaceNetwork: 'on',
          url: 'https://new.example.test',
        }),
        'composer',
        'composer_repository',
        true,
      ),
    ).toEqual({
      pollIntervalSeconds: 300,
      removalPolicy: 'flag',
      defaultVisibleToNewProjects: false,
      retentionDaysOverride: null,
      url: 'https://new.example.test',
      userAgent: null,
      config: {
        selection: { packages: [], patterns: [], expandPatterns: false },
        distHosts: [],
        mirrorsFallback: false,
      },
    });
  });

  it.each(['0', '-1', '1.5', '9007199254740992', '', 'not a number'])(
    'rejects invalid poll interval %s before sending',
    (value) => {
      expect(() =>
        sourceSubmission(
          data({ pollIntervalSeconds: value }),
          'composer',
          'composer_repository',
          false,
        ),
      ).toThrow('Enter valid whole numbers');
    },
  );

  it('maps array item pointers and ignores unknown pointers', () => {
    expect(
      sourceFieldErrors([
        { path: '/body/config/distHosts/0', code: 'invalid' },
        { path: '/body/config/refs/branches/1', code: 'invalid' },
        { path: '/body/unknown-secret', code: 'invalid' },
      ]),
    ).toEqual({
      'config/distHosts': 'Check this field.',
      'config/refs/branches': 'Check this field.',
    });
  });

  it('renders a native dialog and composer fields with associated validation', () => {
    const html = renderToString(
      createElement(SourceForm, {
        source: null,
        busy: false,
        errors: { url: 'Check this field.' },
        alert: 'Review the form.',
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain('<dialog');
    expect(html).toContain('<select');
    expect(html).not.toContain('<style');
    expect(html).toContain('name="config/selection/packages"');
    expect(html).not.toContain('name="config/scopes"');
    expect(html).not.toContain('value="npm_registry"');
    expect(html).not.toContain('value="hosted"');
    expect(html).toContain('aria-describedby="source-url-error"');
    expect(html).toContain('role="alert"');
  });
});
