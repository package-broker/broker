import { parseSourceConfig } from '@package-broker/core/sources/config';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import type { Source } from '../sources.js';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DialogContent } from '../../components/ui/dialog.js';
import {
  SourceForm,
  sourceSubmission,
  sourceFieldErrors,
  validateSourceForm,
  focusSourceError,
} from './source-form.js';

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
      expect(result).toEqual({
        name: 'Upstream',
        ecosystem: 'composer',
        type: 'vcs',
        userAgent: null,
        pollIntervalSeconds: 300,
        removalPolicy: 'flag',
        defaultVisibleToNewProjects: false,
        retentionDaysOverride: null,
        config: {
          provider,
          repository: 'owner/repo',
          ...(provider === 'github' ? { installationId: 42 } : {}),
          packageName: 'vendor/package',
          refs: { branches: ['main', 'release'], tags: true },
        },
      });
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
      projectName: null,
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
      'config/distHosts':
        'Enter hostnames only, one per line, without schemes, paths, or duplicates.',
      'config/refs/branches': 'Enter valid branch names, one per line, without duplicates.',
    });
  });

  it('defaults to Packagist with radios, a static upstream URL and associated validation', () => {
    const html = renderToString(
      createElement(SourceForm, {
        source: null,
        busy: false,
        errors: { pollIntervalSeconds: 'Enter a whole number of seconds greater than 0.' },
        alert: 'Review the form.',
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain('<dialog');
    expect(html).toContain('<select');
    expect(html).not.toContain('<style');
    expect(html).not.toContain('name="config/selection/packages"');
    expect(html).toContain('Upstream URL:');
    expect(html).toContain('type="hidden" name="url" value="https://repo.packagist.org"');
    expect(html).not.toContain('name="config/scopes"');
    expect(html).not.toContain('value="npm_registry"');
    expect(html).not.toContain('value="hosted"');
    expect(html).toContain(
      'aria-describedby="source-pollIntervalSeconds-help source-pollIntervalSeconds-error"',
    );
    expect(html).toContain('role="alert"');
  });
});

describe('source form UX', () => {
  it('creates a working Packagist proxy with only a name typed', () => {
    const fields = data({ url: 'https://repo.packagist.org' });
    expect(validateSourceForm(fields, 'packagist_proxy', false)).toEqual({});
    expect(sourceSubmission(fields, 'composer', 'packagist_proxy', false)).toEqual({
      name: 'Upstream',
      ecosystem: 'composer',
      type: 'packagist_proxy',
      url: 'https://repo.packagist.org',
      userAgent: null,
      pollIntervalSeconds: 300,
      removalPolicy: 'flag',
      defaultVisibleToNewProjects: false,
      retentionDaysOverride: null,
      config: { githubToken: false },
    });
  });

  it('keeps the npmjs payload and default URL unchanged', () => {
    expect(
      sourceSubmission(data({ url: 'https://registry.npmjs.org' }), 'npm', 'npmjs_proxy', false),
    ).toEqual({
      name: 'Upstream',
      ecosystem: 'npm',
      type: 'npmjs_proxy',
      url: 'https://registry.npmjs.org',
      userAgent: null,
      pollIntervalSeconds: 300,
      removalPolicy: 'flag',
      defaultVisibleToNewProjects: false,
      retentionDaysOverride: null,
      config: {},
    });
  });

  it.each(['config/selection/packages', 'config/selection/patterns'])(
    'accepts a Composer selection using only %s',
    (field) => {
      expect(
        validateSourceForm(
          data({ url: 'https://composer.example.com', [field]: 'acme/payments' }),
          'composer_repository',
          false,
        ),
      ).toEqual({});
    },
  );

  it('blocks empty and whitespace-only Composer selections with a field error', () => {
    expect(
      validateSourceForm(
        data({
          url: 'https://composer.example.com',
          'config/selection/packages': ' \n ',
          'config/selection/patterns': '\r\n',
        }),
        'composer_repository',
        false,
      ),
    ).toEqual({
      'config/selection/packages': 'Add at least one package name or pattern',
    });
  });

  it('requires a scope while keeping unrelated Composer fields out of npm submissions', () => {
    const fields = data({
      url: 'https://npm.example.com',
      'config/scopes': '\n ',
      'config/selection/packages': 'acme/payments',
    });
    expect(validateSourceForm(fields, 'npm_registry', false)).toHaveProperty('config/scopes');
    fields.set('config/scopes', '@acme');
    expect(validateSourceForm(fields, 'npm_registry', false)).toEqual({});
    expect(sourceSubmission(fields, 'npm', 'npm_registry', false)).toEqual({
      name: 'Upstream',
      ecosystem: 'npm',
      type: 'npm_registry',
      url: 'https://npm.example.com',
      userAgent: null,
      pollIntervalSeconds: 300,
      removalPolicy: 'flag',
      defaultVisibleToNewProjects: false,
      retentionDaysOverride: null,
      config: { scopes: ['@acme'], distHosts: [] },
    });
  });

  it.each(['', '0', '-1', '1.5', '9007199254740992'])(
    'reports installation ID %s on the field and ignores it in token or SSH mode',
    (installationId) => {
      const fields = data({
        'config/provider': 'github',
        'config/repository': 'acme/payments',
        'config/installationId': installationId,
      });
      expect(validateSourceForm(fields, 'vcs', false)).toEqual({
        'config/installationId': 'Enter a positive whole-number installation ID.',
      });
      fields.set('githubAuthentication', 'token');
      expect(validateSourceForm(fields, 'vcs', false)).toEqual({});
      fields.set('githubAuthentication', 'app');
      fields.set('config/provider', 'ssh');
      expect(validateSourceForm(fields, 'vcs', false)).toEqual({});
    },
  );

  it('validates advanced numeric fields without requiring unselected replacement groups', () => {
    const fields = data({ pollIntervalSeconds: '0', retentionDaysOverride: '-1' });
    expect(validateSourceForm(fields, 'npmjs_proxy', false)).toEqual({
      pollIntervalSeconds: 'Enter a whole number of seconds greater than 0.',
      retentionDaysOverride:
        'Enter a whole number of days that does not shorten organization retention.',
    });
    fields.set('pollIntervalSeconds', '90');
    expect(validateSourceForm(fields, 'composer_repository', true)).toEqual({});
    fields.set('replaceConfig', 'on');
    expect(validateSourceForm(fields, 'composer_repository', true)).toHaveProperty(
      'config/selection/packages',
    );
  });

  it('orders primary choices first and keeps advanced controls collapsed and the footer outside the scroll area', () => {
    const html = renderToString(
      createElement(SourceForm, {
        source: null,
        busy: false,
        errors: {},
        alert: null,
        onSubmit: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html.indexOf('<legend class="text-sm font-medium">Ecosystem')).toBeLessThan(
      html.indexOf('>Source type</legend>'),
    );
    expect(html.indexOf('>Source type</legend>')).toBeLessThan(
      html.indexOf('>Source name (required)</label>'),
    );
    expect(html).toMatch(/<details class="min-w-0">/);
    expect(html.indexOf('<details')).toBeLessThan(html.indexOf('name="pollIntervalSeconds"'));
    expect(html).not.toContain('name="config/selection/expandPatterns"');
    expect(html).toContain('text-base sm:text-sm');
    expect(html).toContain('h-dvh');
    expect(html).toContain('sm:max-w-lg');
    expect(html).toContain('min-h-0 flex-1 overflow-y-auto');
    expect(html).toMatch(
      /<\/details><\/fieldset><\/div><div class="[^"]*shrink-0[^"]*border-t[^"]*bg-white/,
    );
    expect(html).toContain('env(safe-area-inset-bottom)');
  });
});

it('opens Advanced before focusing its first invalid field in form order', () => {
  const details = { open: false };
  const advanced = {
    getAttribute: () => 'pollIntervalSeconds',
    closest: () => details,
    focus: vi.fn(() => expect(details.open).toBe(true)),
  };
  const later = {
    getAttribute: () => 'retentionDaysOverride',
    closest: () => details,
    focus: vi.fn(),
  };
  const form = { elements: [advanced, later] } as unknown as HTMLFormElement;
  focusSourceError(form, {
    retentionDaysOverride: 'Invalid retention',
    pollIntervalSeconds: 'Invalid interval',
  });
  expect(advanced.focus).toHaveBeenCalledOnce();
  expect(later.focus).not.toHaveBeenCalled();
  details.open = false;
  focusSourceError(form, { unknown: 'Invalid' });
  expect(details.open).toBe(false);
});

it('leaves the shared dialog layout unchanged unless the source variant is requested', () => {
  const html = renderToString(createElement(DialogContent, { children: 'Other dialog' }));
  expect(html).toContain('max-h-[90dvh]');
  expect(html).not.toContain('h-dvh');
  expect(html).not.toContain('open:flex');
});
