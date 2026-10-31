import { parseSourceConfig, servedVcsProviders } from '@package-broker/core/sources/config';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import type { Source } from '../sources.js';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DialogContent } from '../../components/ui/dialog.js';
import {
  SourceForm,
  sourceSubmission,
  sourceFormData,
  scopeNamePatterns,
  sourceFieldErrors,
  validateSourceForm,
  focusSourceError,
  vcsProviderOptions,
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

function savedSource(type: Source['type'], config: NonNullable<Source['config']>): Source {
  return {
    id: 'saved',
    name: 'Saved source',
    projectId: null,
    ecosystem: type === 'npm_registry' || type === 'npmjs_proxy' ? 'npm' : 'composer',
    type,
    url: 'https://registry.example.com',
    config,
    userAgent: 'Broker/2.0',
    retentionDaysOverride: 730,
    defaultVisibleToNewProjects: true,
    pollIntervalSeconds: 600,
    removalPolicy: 'exclude',
    hasCredential: true,
    status: 'paused',
    lastError: null,
    lastPolledAt: null,
    lastSuccessAt: null,
    nextPollAt: null,
    lastRemovalRefusal: null,
    removalAcceptanceArmed: false,
    projectName: null,
    attachedProjectCount: 0,
  };
}

function renderForm(source: Source) {
  return renderToString(
    createElement(SourceForm, {
      source,
      busy: false,
      errors: {},
      alert: null,
      onSubmit: vi.fn(),
      onClose: vi.fn(),
      vcsProviders: ['github', 'git', 'ssh'],
    }),
  );
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
        null,
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
        null,
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
      null,
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
        null,
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
      null,
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
        null,
      ).config,
    ).toEqual(config);
  });

  it('creates Packagist without a token using the actual service validator', () => {
    const body = sourceSubmission(
      data({ url: 'https://repo.packagist.org', 'config/githubToken': 'on' }),
      'composer',
      'packagist_proxy',
      null,
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

  it('prefills Packagist token mode and explains the credential setup sequence', () => {
    const source = savedSource('packagist_proxy', { githubToken: true });
    const html = renderForm(source);
    expect(html).not.toContain('replaceConfig');
    expect(html).not.toContain('replaceDefaults');
    expect(html).not.toContain('replaceNetwork');
    expect(html).toMatch(/name="config\/githubToken"[^>]*checked=""/);
    expect(html).toContain('save a bearer credential with your GitHub token');
    expect(sourceSubmission(sourceFormData(source), 'composer', source.type, source)).toEqual({});
    const changed = sourceFormData(source);
    changed.delete('config/githubToken');
    expect(sourceSubmission(changed, 'composer', source.type, source)).toEqual({
      config: { githubToken: false },
    });
  });

  it('sends changed visibility, inherited retention and network fields alone', () => {
    const source = savedSource('composer_repository', {
      selection: { packages: ['vendor/package'], patterns: [], expandPatterns: false },
      distHosts: [],
      mirrorsFallback: false,
    });
    for (const [field, value, expected] of [
      ['userAgent', 'Changed/3.0', { userAgent: 'Changed/3.0' }],
      ['url', 'https://new.example.com', { url: 'https://new.example.com' }],
      ['retentionDaysOverride', '', { retentionDaysOverride: null }],
      ['defaultVisibleToNewProjects', null, { defaultVisibleToNewProjects: false }],
      ['pollIntervalSeconds', '60', { pollIntervalSeconds: 60 }],
      ['removalPolicy', 'flag', { removalPolicy: 'flag' }],
    ] as const) {
      const changed = sourceFormData(source);
      if (value === null) changed.delete(field);
      else changed.set(field, value);
      expect(sourceSubmission(changed, 'composer', source.type, source)).toEqual(expected);
    }
  });

  it.each(['0', '-1', '1.5', '9007199254740992', '', 'not a number'])(
    'rejects invalid poll interval %s before sending',
    (value) => {
      expect(() =>
        sourceSubmission(
          data({ pollIntervalSeconds: value }),
          'composer',
          'composer_repository',
          null,
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
    expect(sourceSubmission(fields, 'composer', 'packagist_proxy', null)).toEqual({
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
      sourceSubmission(data({ url: 'https://registry.npmjs.org' }), 'npm', 'npmjs_proxy', null),
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
    expect(sourceSubmission(fields, 'npm', 'npm_registry', null)).toEqual({
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

  it('validates prefilled edit fields without replacement checkboxes', () => {
    const source = savedSource('composer_repository', {
      selection: { packages: ['acme/payments'], patterns: [], expandPatterns: false },
    });
    const fields = sourceFormData(source);
    fields.set('pollIntervalSeconds', '0');
    fields.set('retentionDaysOverride', '-1');
    expect(validateSourceForm(fields, source.type, true)).toEqual({
      pollIntervalSeconds: 'Enter a whole number of seconds greater than 0.',
      retentionDaysOverride:
        'Enter a whole number of days that does not shorten organization retention.',
    });
    fields.set('pollIntervalSeconds', '90');
    fields.set('retentionDaysOverride', '730');
    fields.set('config/selection/packages', '');
    expect(validateSourceForm(fields, source.type, true)).toEqual({
      'config/selection/packages': 'Add at least one package name or pattern',
    });
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
      /<\/details><\/fieldset><\/div><div data-dialog-footer="true" class="[^"]*shrink-0[^"]*border-t[^"]*bg-white/,
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

describe('repository provider choices', () => {
  it('lists only the providers the broker reports, in display order', () => {
    expect(vcsProviderOptions(['github'])).toEqual([['github', 'GitHub']]);
    expect(vcsProviderOptions(servedVcsProviders('cloudflare'))).toEqual([['github', 'GitHub']]);
    expect(vcsProviderOptions(['git', 'github'])).toEqual([
      ['github', 'GitHub'],
      ['git', 'Git over HTTP(S)'],
    ]);
    expect(vcsProviderOptions(servedVcsProviders('node'))).toEqual([
      ['github', 'GitHub'],
      ['git', 'Git over HTTP(S)'],
      ['ssh', 'Git over SSH'],
    ]);
  });

  it('omits git and ssh when they are not reported, and unknown providers always', () => {
    const offered = vcsProviderOptions(['github', 'svn']).map(([provider]) => provider);
    expect(offered).toEqual(['github']);
    expect(offered).not.toContain('git');
    expect(offered).not.toContain('ssh');
  });
});

describe('source types without repository providers', () => {
  it('offers the Git repository type only when a provider is reported', () => {
    const render = (vcsProviders: readonly ('github' | 'git' | 'ssh')[]) =>
      renderToString(
        createElement(SourceForm, {
          source: null,
          busy: false,
          errors: {},
          alert: null,
          onSubmit: vi.fn(),
          onClose: vi.fn(),
          vcsProviders,
        }),
      );
    expect(render(['github'])).toContain('value="vcs"');
    expect(render([])).not.toContain('value="vcs"');
    expect(render([])).toContain('value="composer_repository"');
  });
});

describe('editing a Git repository source the broker no longer serves', () => {
  const editing = (vcsProviders: readonly ('github' | 'git' | 'ssh')[]) =>
    renderToString(
      createElement(SourceForm, {
        source: {
          id: 'vcs',
          name: 'Repository',
          ecosystem: 'composer',
          type: 'vcs',
          config: { provider: 'github', repository: 'owner/repo', installationId: 42 },
          configComplete: true,
          pollIntervalSeconds: 300,
          removalPolicy: 'flag',
        } as Source,
        busy: false,
        errors: {},
        alert: null,
        onSubmit: vi.fn(),
        onClose: vi.fn(),
        vcsProviders,
      }),
    );

  it('keeps the saved type visible read-only and offers no configuration replacement', () => {
    const html = editing([]);
    expect(html).toContain('Source type: Git repository');
    expect(html).not.toContain('Replace type-specific configuration');
  });

  it('shows repository settings without a replacement checkbox when a provider is served', () => {
    const html = editing(['github']);
    expect(html).not.toContain('Source type: Git repository');
    expect(html).not.toContain('Replace type-specific configuration');
    expect(html).toContain('name="config/repository"');
  });
});

describe('prefilled source editing', () => {
  it.each([
    [
      'composer_repository',
      {
        selection: {
          packages: ['vendor/one', 'vendor/two'],
          patterns: ['vendor/*'],
          expandPatterns: true,
        },
        distHosts: ['dist.example.com'],
        mirrorsFallback: true,
      },
    ],
    ['npm_registry', { scopes: ['@one', '@two'], distHosts: ['dist.example.com'] }],
    [
      'vcs',
      {
        provider: 'github',
        repository: 'owner/repo',
        installationId: 42,
        packageName: 'vendor/package',
        refs: { branches: ['main', 'release'], tags: false },
      },
    ],
    [
      'vcs',
      {
        provider: 'git',
        repository: 'https://git.example.com/repo',
        refs: { branches: [], tags: true },
      },
    ],
    [
      'vcs',
      {
        provider: 'ssh',
        repository: 'git@git.example.com:repo',
        refs: { branches: [], tags: true },
      },
    ],
    ['packagist_proxy', { githubToken: false }],
    ['npmjs_proxy', {}],
  ] as const)('prefills all %s fields and omits every unchanged field: %j', (type, config) => {
    const source = savedSource(type, config as NonNullable<Source['config']>);
    const html = renderForm(source);
    const fields = sourceFormData(source);
    expect(html).toContain('value="Broker/2.0"');
    expect(html).toContain('value="730"');
    expect(html).toContain('value="600"');
    expect(html).toMatch(/name="defaultVisibleToNewProjects"[^>]*checked=""/);
    const assertConfig = (value: unknown, path = 'config') => {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        const name = `${path}/${key}`;
        if (Array.isArray(item)) {
          expect(html).toContain(`name="${name}"`);
          if (item.length) expect(html).toContain(item.join('\n'));
          expect(fields.get(name)).toBe(item.join('\n'));
        } else if (typeof item === 'object' && item !== null) assertConfig(item, name);
        else if (typeof item === 'boolean') {
          expect(html).toMatch(new RegExp(`name="${name}"[^>]*${item ? 'checked=""' : '(?=>)'}`));
          if (!item) expect(html).not.toMatch(new RegExp(`name="${name}"[^>]*checked`));
        } else if (key === 'provider')
          expect(html).toContain(`<option value="${item}" selected="">`);
        else expect(html).toContain(`value="${item}"`);
      }
    };
    assertConfig(config);
    expect(validateSourceForm(fields, type, true)).toEqual({});
    expect(sourceSubmission(fields, source.ecosystem, type, source)).toEqual({});
  });

  it('sends config alone when a config field changes, preserving the other config fields', () => {
    const source = savedSource('npm_registry', {
      scopes: ['@one'],
      distHosts: ['dist.example.com'],
    });
    const fields = sourceFormData(source);
    fields.set('config/scopes', '@one\n@two');
    expect(sourceSubmission(fields, 'npm', source.type, source)).toEqual({
      config: { scopes: ['@one', '@two'], distHosts: ['dist.example.com'] },
    });
  });

  it('keeps an unavailable saved VCS provider and its configuration untouched on unrelated edits', () => {
    const source = savedSource('vcs', {
      provider: 'git',
      repository: 'https://git.example.com/repo',
      refs: { branches: [], tags: true },
    });
    const html = renderToString(
      createElement(SourceForm, {
        source,
        busy: false,
        errors: {},
        alert: null,
        onSubmit: vi.fn(),
        onClose: vi.fn(),
        vcsProviders: ['github'],
      }),
    );
    expect(html).toContain('Source type: Git repository');
    expect(html).not.toContain('name="config/provider"');
    const fields = sourceFormData(source);
    fields.delete('config/provider');
    fields.delete('config/repository');
    fields.set('userAgent', 'Changed/3.0');
    expect(sourceSubmission(fields, 'composer', source.type, source)).toEqual({
      userAgent: 'Changed/3.0',
    });
  });

  it('generates a name pattern for each configured npm scope', () => {
    expect(scopeNamePatterns('@one\r\n@two\n@one\n\ninvalid')).toEqual(['@one/*', '@two/*']);
    expect(scopeNamePatterns('')).toEqual([]);
  });
});

it.each([
  ['packagist_proxy', 'composer', 'https://repo.packagist.org'],
  ['npmjs_proxy', 'npm', 'https://registry.npmjs.org'],
] as const)(
  'does not resend the fixed %s URL when the DTO has a trailing slash',
  (type, ecosystem, url) => {
    const source = { ...savedSource(type, {}), url: `${url}/` };
    const fields = sourceFormData(source);
    const hidden = renderForm(source).match(/type="hidden" name="url" value="([^"]+)"/);
    expect(hidden?.[1]).toBe(url);
    fields.set('url', hidden![1]!);
    expect(sourceSubmission(fields, ecosystem, type, source)).toEqual({});
    fields.set('userAgent', 'Changed/3.0');
    expect(sourceSubmission(fields, ecosystem, type, source)).toEqual({ userAgent: 'Changed/3.0' });
  },
);

it('allows unrelated edits to a saved empty Composer selection while validating changes to that selection', () => {
  const source = savedSource('composer_repository', {
    selection: { packages: [], patterns: [], expandPatterns: false },
    distHosts: [],
    mirrorsFallback: false,
  });
  const fields = sourceFormData(source);
  fields.set('userAgent', 'Changed/3.0');
  expect(validateSourceForm(fields, source.type, true, source)).toEqual({});
  expect(sourceSubmission(fields, 'composer', source.type, source)).toEqual({
    userAgent: 'Changed/3.0',
  });
  fields.set('config/selection/packages', ' ');
  expect(validateSourceForm(fields, source.type, true, source)).toEqual({
    'config/selection/packages': 'Add at least one package name or pattern',
  });
});

it('requires explicit replacement for incomplete configuration and preserves it on unrelated edits', () => {
  const source = { ...savedSource('npm_registry', { scopes: ['@one'] }), configComplete: false };
  const html = renderForm(source);
  expect(html).toContain('Some saved settings cannot be displayed');
  expect(html).toContain('Replace type-specific configuration');
  expect(html).not.toContain('name="config/scopes"');
  const fields = sourceFormData(source);
  fields.set('config/scopes', '@two');
  fields.set('userAgent', 'Changed/3.0');
  expect(validateSourceForm(fields, source.type, true, source)).toEqual({});
  expect(sourceSubmission(fields, 'npm', source.type, source)).toEqual({
    userAgent: 'Changed/3.0',
  });
  fields.set('replaceConfig', 'on');
  expect(sourceSubmission(fields, 'npm', source.type, source)).toEqual({
    userAgent: 'Changed/3.0',
    config: { scopes: ['@two'], distHosts: [] },
  });
  fields.set('config/scopes', '');
  expect(validateSourceForm(fields, source.type, true, source)).toHaveProperty('config/scopes');
});

it('can explicitly replace an incomplete config even when its displayed values are unchanged', () => {
  const source = {
    ...savedSource('packagist_proxy', { githubToken: false }),
    configComplete: false,
  };
  const fields = sourceFormData(source);
  fields.set('replaceConfig', 'on');
  expect(sourceSubmission(fields, 'composer', source.type, source)).toEqual({
    config: { githubToken: false },
  });
});

it.each(['composer_repository', 'npm_registry'] as const)(
  'allows unrelated edits with a redacted %s URL',
  (type) => {
    const source = {
      ...savedSource(
        type,
        type === 'npm_registry'
          ? { scopes: ['@one'] }
          : { selection: { packages: ['vendor/package'] } },
      ),
      url: null,
    };
    const fields = sourceFormData(source);
    fields.set('userAgent', 'Changed/3.0');
    expect(renderForm(source)).not.toContain('URL (required)');
    expect(validateSourceForm(fields, type, true, source)).toEqual({});
    expect(sourceSubmission(fields, source.ecosystem, type, source)).toEqual({
      userAgent: 'Changed/3.0',
    });
    fields.set('url', 'https://new.example.com');
    expect(sourceSubmission(fields, source.ecosystem, type, source)).toEqual({
      userAgent: 'Changed/3.0',
      url: 'https://new.example.com',
    });
    const displayed = { ...source, url: 'https://registry.example.com' };
    fields.set('url', '');
    expect(validateSourceForm(fields, type, true, displayed)).toHaveProperty('url');
  },
);

it('offers hosted npm for the organization with claims kept outside configuration', () => {
  const html = renderToString(
    createElement(SourceForm, {
      source: null,
      busy: false,
      errors: {},
      alert: null,
      onSubmit: vi.fn(),
      onClose: vi.fn(),
      initialType: 'hosted',
    }),
  );
  expect(html).toContain('value="hosted"');
  expect(html).not.toContain('name="url"');
  expect(html).toContain('Register package names');
  expect(html).toContain('not yet cached');
  expect(sourceSubmission(data(), 'npm', 'hosted', null)).toMatchObject({
    type: 'hosted',
    ecosystem: 'npm',
    config: {},
    url: null,
  });
});

it('omits hosted source creation in a project form', () => {
  const html = renderToString(
    createElement(SourceForm, {
      source: null,
      busy: false,
      errors: {},
      alert: null,
      onSubmit: vi.fn(),
      onClose: vi.fn(),
      initialType: 'hosted',
      organization: false,
    }),
  );
  expect(html).not.toContain('value="hosted"');
});

it('offers npm VCS and explains root manifest naming', () => {
  const html = renderToString(
    createElement(SourceForm, {
      source: null,
      busy: false,
      errors: {},
      alert: null,
      onSubmit: vi.fn(),
      onClose: vi.fn(),
      initialType: 'vcs',
    }),
  );
  expect(html).toContain('value="vcs"');
  const help = /<p id="source-config\/packageName-help"[^>]*>(.*?)<\/p>/.exec(html)?.[1];
  expect(help).toBe(
    'Leave blank to use the root manifest name (composer.json or package.json). For npm, this must match the name in package.json.',
  );
});

it.each(['npm', 'composer'] as const)(
  'shows an ecosystem-aware VCS placeholder for %s',
  (ecosystem) => {
    const source = {
      ...savedSource('vcs', {
        provider: 'github',
        repository: 'acme/lib',
        refs: { tags: true, branches: [] },
      }),
      ecosystem,
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
    expect(html).toContain(
      `placeholder="${ecosystem === 'npm' ? '@acme/payments' : 'acme/payments'}"`,
    );
  },
);
