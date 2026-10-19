import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatToken } from '../secrets/token-format.js';
import { FAKE } from '../test-support/credential-fixtures.js';
import { isCredentialValue, redactUrl, redactValue } from './redact.js';

const SELECTOR = 'abcdefghijkl';
const SECRET = 'A'.repeat(43);

describe('credential fixture source', () => {
  it('contains no literal credentials or provider prefixes', () => {
    const source = readFileSync(
      new URL('../test-support/credential-fixtures.ts', import.meta.url),
      'utf8',
    );
    const patterns = [
      /A[KS]IA/i,
      /gh[pousr]_|github[_]pat_/,
      /gl(?:pat|dt|ptt|oas)-/i,
      /[prs]k[_](?:live|test)_/i,
      /xox[abeprs]-/i,
      /dckr[_]pat_/i,
      /npm[_]|pypi[-]/,
      /shp(?:at|ss|ca|pa)_/i,
      /AI[z]a|hf[_]/i,
      /pb[_](?:pat|svc|cst)_/i,
      /ey[J][A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\./,
      /-{3,}\s*begin\b/i,
      /(?:bearer|basic)[:= ]\s*[A-Za-z0-9._~+/=-]{16,}/i,
      /[A-Za-z0-9+/_-]{40}/,
    ];
    expect(patterns.some((pattern) => pattern.test(source))).toBe(false);
  });

  it('keeps generated AWS keys at their provider lengths and alphabets', () => {
    expect(FAKE.AWS_ACCESS_1).toMatch(/^A[K]IA[A-Z]{16}$/);
    expect(FAKE.AWS_SESSION_1).toMatch(/^A[S]IA[A-Z]{15}[0-9]$/);
  });
});

describe('isCredentialValue', () => {
  const refused: Array<[string, string]> = [
    ['broker token', formatToken('pat', SELECTOR, SECRET)],
    ['AWS access key', FAKE.AWS_ACCESS_1],
    ['AWS session key', FAKE.AWS_SESSION_1],
    ['GitHub token', FAKE.GITHUB_CLASSIC_A20],
    ['GitHub fine-grained token', FAKE.GITHUB_FINE_B20],
    ['GitLab token', FAKE.GITLAB_C20],
    ['npm token', `${['np', 'm_'].join('')}${'d'.repeat(20)}`],
    ['JWT', FAKE.JWT_1],
    ['PEM header', FAKE.PEM_1],
    ['Bearer header', `Bearer ${'e'.repeat(20)}`],
    ['Basic header', `Basic ${'f'.repeat(20)}`],
    ['base64 run', FAKE.RUN_1],
    ['hex run outside a hash field', 'a1'.repeat(25)],
    ['e-mail address', 'someone@example.test'],
    ['e-mail address inside text', 'contact someone@example.test now'],
  ];
  it.each(refused)('refuses %s', (_name, value) => {
    expect(isCredentialValue(value)).toBe(true);
  });

  const allowed: Array<[string, string, string]> = [
    ['ULID', '01J0USER000000000000000000', 'name'],
    ['long package name', 'vendor/a-very-long-package-name-with-many-words', 'package_name'],
    ['sha256 field value', 'a'.repeat(32) + '0123456789abcdef'.repeat(2), 'sha256_new'],
    ['plan hash', '0123456789abcdef'.repeat(4), 'plan_hash'],
    ['display name with spaces', `${'word '.repeat(19)}end`, 'name'],
    ['scoped package', '@scope/package', 'name'],
    ['versioned name', 'package@1.2.3', 'name'],
    ['prerelease package spec', '@scope/pkg@1.0.0-alpha.beta', 'name'],
    ['UUID in an id field', '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b', 'project_id'],
  ];
  it.each(allowed)('does not refuse %s', (_name, value, field) => {
    expect(redactValue(value, 200, field).ok).toBe(true);
  });

  it('refuses a long package name outside a name field', () => {
    expect(redactValue('vendor/a-very-long-package-name-with-many-words', 200, 'url').ok).toBe(
      false,
    );
  });

  it('refuses a 64-hex value outside a hash field', () => {
    expect(isCredentialValue('0123456789abcdef'.repeat(4))).toBe(true);
  });

  const extraRefused: Array<[string, string]> = [
    ['32 hex', 'a3f9'.repeat(8)],
    ['39 hex', 'a3f9'.repeat(10).slice(0, 39)],
    ['36 mixed-case run', FAKE.RUN_2],
    ['Shopify token', `${['sh', 'pat_'].join('')}${'a3f9'.repeat(8)}`],
    ['Docker token', FAKE.DOCKER_1],
    ['GitLab deploy token', FAKE.GITLAB_DEPLOY_1],
    ['Google key', FAKE.GOOGLE_1],
    ['Hugging Face token', FAKE.HUGGINGFACE_1],
    ['Slack token', FAKE.SLACK_1],
    ['Stripe key', FAKE.STRIPE_1],
    ['bare UUID', '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'],
    ['60-char lowercase dashed secret', FAKE.RUN_3],
    ['provider token mid-word', FAKE.GITHUB_PAT_CLASSIC_1],
    ['provider token after underscore', FAKE.GITHUB_PAT_CLASSIC_2],
    ['upper-case provider token', FAKE.GITHUB_UPPER_1],
    ['JWT not at start', FAKE.JWT_EMBEDDED_1],
    ['embedded Bearer', FAKE.BEARER_EMBEDDED_1],
    ['token scheme', FAKE.TOKEN_HEADER_1],
    ['lower-case PEM', FAKE.RUN_4],
    ['URL with leading space userinfo', 'x https://deploy:hunter2pw@10.0.0.5/repo'],
    ['mid-string URL query secret', 'mirror https://git.example.test/r?access_token=s3cr3tvalue12'],
    ['backslash URL userinfo', 'x https:\\\\deploy:hunter2pw@10.0.0.5/r'],
    ['plus-address e-mail', 'jan+tag@example.test'],
    ['upper-case e-mail', 'JAN@EXAMPLE.TEST'],
    ['IDN e-mail', 'jan@b\u00fccher.de'],
    ['Cyrillic e-mail', 'jan@\u043f\u0440\u0438\u043c\u0435\u0440.\u0440\u0444'],
    ['localhost e-mail', 'jan@localhost'],
    ['IP literal e-mail', 'jan@[10.0.0.1]'],
    ['full-width at e-mail', 'jan\uff20example.test'],
    ['percent-encoded e-mail', 'https://h.example.test/u/jan%40example.test'],
    ['input over 4096 characters', 'a '.repeat(2049)],
  ];
  it.each(extraRefused)('refuses %s', (_name, value) => {
    expect(isCredentialValue(value)).toBe(true);
  });

  it('is linear on a 20k-character input', () => {
    const inputs = [
      'a@'.repeat(10000),
      '@'.repeat(20000),
      `${'a'.repeat(20000)}@`,
      'a '.repeat(10000),
    ];
    const start = performance.now();
    for (const input of inputs) isCredentialValue(input);
    expect(performance.now() - start).toBeLessThan(50);
  });

  it('refuses a non-ULID 26-character run padded to 40', () => {
    expect(isCredentialValue(`${'01J0USER000000000000000000'}${'A'.repeat(14)}`)).toBe(true);
  });
});

describe('credential reference redaction', () => {
  const uuid = '550e8400-e29b-41d4-a716-446655440000';
  const path = `./${uuid}/${uuid}/token`;

  it.each([
    'env:REGISTRY_TOKEN',
    `file:${path}`,
    `file:${uuid}/token`,
    `file:${uuid}`,
    `file:${uuid}\\token`,
    `file:C:\\${uuid}\\${uuid}\\token`,
    `file:\\\\server\\${uuid}\\token`,
    `file:./My Vault/${uuid}/token`,
    `file:./${uuid}/${'é'.repeat(490)}/keys`,
  ])('preserves reference %s exactly', (value) => {
    expect(redactValue(value, 2048, 'external_ref')).toEqual({ ok: true, value });
  });

  it.each([
    ['retired scheme', ['op', `//${uuid}/token`].join(':')],
    ['unknown scheme', `other:${path}`],
    ['control character', `file:${path}\u0000`],
    ['C1 control character', `file:${path}\u0085`],
    ['oversized UTF-8 path', `file:./${uuid}/${'é'.repeat(491)}/keys`],
    ['UUID within a path segment', `file:./prefix-${uuid}/token`],
    ['provider token with UUID', `file:./${uuid}/${FAKE.GITHUB_CLASSIC_A20}/token`],
    ['provider token after initial UUID', `file:${uuid}/${FAKE.GITHUB_CLASSIC_A20}/token`],
    ['provider token in Windows path', `file:C:\\${uuid}\\${FAKE.GITHUB_CLASSIC_A20}`],
    ['UUID within a Windows path segment', `file:C:\\prefix-${uuid}\\token`],
  ])('refuses %s without echoing it', (_name, value) => {
    expect(redactValue(value, 2048, 'external_ref')).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });
});

describe('redactUrl', () => {
  it('drops userinfo, query and fragment', () => {
    expect(redactUrl('https://user:pw@git.example.test/a/b?token=x#f')).toBe(
      'https://git.example.test/a/b',
    );
  });

  it('drops the user from an ssh URL', () => {
    expect(redactUrl('ssh://git@host.example.test/a.git')).toBe('ssh://host.example.test/a.git');
  });

  it('matches the scheme in any case', () => {
    expect(redactUrl('HTTPS://user:pw@Git.Example.test/a')).toBe('https://git.example.test/a');
  });

  it('returns null for an unparseable URL', () => {
    expect(redactUrl('https://')).toBeNull();
  });

  it('trims before testing the scheme', () => {
    expect(redactUrl('  https://u:p@h.example.test/a')).toBe('https://h.example.test/a');
  });

  it.each(['git+https', 'git+ssh', 'svn+ssh', 'ftp', 'sftp'])('handles the %s scheme', (scheme) => {
    expect(redactUrl(`${scheme}://u:p@h.example.test/r?x=1`)).toBe(`${scheme}://h.example.test/r`);
  });

  it('strips path parameters', () => {
    expect(redactUrl('https://h.example.test/r;jsessionid=s3cr3tvalue12')).toBe(
      'https://h.example.test/r',
    );
  });

  it('parses a backslash URL and drops its userinfo', () => {
    expect(redactUrl('https:\\\\deploy:pw@h.example.test/r')).toBe('https://h.example.test/r');
  });

  it('returns the value unchanged when it is not a URL', () => {
    expect(redactUrl('plain value')).toBe('plain value');
  });
});

describe('redactValue scp-style addresses', () => {
  it('drops the user from an scp-style address', () => {
    expect(redactValue('git@github.com:vendor/repo.git', 200, 'url')).toEqual({
      ok: true,
      value: 'github.com:vendor/repo.git',
    });
  });
});

describe('redactValue false-positive corpus', () => {
  const allowed: Array<[string, string]> = [
    ['url', 'https://storage.googleapis.com/acme-artifacts-bucket-2026/packages/'],
    ['url', 'https://gitlab.com/api/v4/projects/12345678/packages/composer/packages.json'],
    ['url', 'https://gitlab.example.com/api/v4/group/42/-/packages/composer/packages.json'],
    ['url', 'https://npm.pkg.github.com/@acme-corporation/'],
    ['url', ['https://registry.npmjs.org/@acme/np', 'm_registry_mirror_utils'].join('')],
    ['url', 'https://satis.acme-corporation.example.com/repositories/production/'],
    ['url', 'https://github.com/acme-corporation/magento2-module-checkout-improvements.git'],
    ['url', 'https://github.com/acme/widget.git'],
    ['package_name', 'acme/eurasiancommercegateway'],
    ['package_name', 'acme/fantasiaworldbuildingkit'],
    ['package_name', 'acme/malaysiaecommercemodule'],
    ['package_name', 'acme/indonesiapaymentgateway'],
    ['package_name', 'acme/takiacommerceconnector'],
    ['package_name', 'acme/magento-2-module-something-long-name'],
    ['package_name', 'vendor/module-catalog-2-0-compat-layer-extra'],
    ['package_name', ['acme/np', 'm_audit_resolver_tool'].join('')],
    ['package_name', 'acme/xoxo-gossip-girl'],
    ['package_name', ['acme/xo', 'xa-bootstrapping'].join('')],
    ['package_name', ['acme/gh', 's_monitoring_dashboard'].join('')],
    ['package_name', ['acme/gh', 'r_release_notes_builder'].join('')],
    ['package_name', ['acme/disk', '_live_monitoring_tools'].join('')],
    ['package_name', ['acme/risk', '_live_scoringengine'].join('')],
    ['package_name', ['acme/disk', '_live_monitoringtool'].join('')],
    ['package_name', ['acme/sh', 'pss_shipping_sync'].join('')],
    ['package_name', ['@acme/gl', 'pat-rotation-helper-cli'].join('')],
    ['package_name', 'eslint-plugin-gh_actions-workflow-lint'],
    ['package_name', ['acme/shf', '_fullsitebuilder'].join('')],
    ['package_name', ['acme/hf', '_transformersbridge'].join('')],
    ['package_name', 'acme/12345'],
    ['name', 'Asia Pacific mirror'],
    ['name', ['np', 'm_registry_proxy_eu_west'].join('')],
    ['slug', 'asiapacificwarehouse01'],
    ['slug', ['np', 'm_mirror_production_eu'].join('')],
    ['version', 'dev-dependabot/composer/symfony/http-foundation-6.4.14'],
    ['version', 'dev-feature/JIRA-1234-add-customer-attribute'],
    ['version', 'dev-feature/abc-123-new-checkout'],
    ['version', 'dev-Feature/Abc1-x'],
    ['version', 'dev-main#a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0'],
    ['version', '1.0.0-alpha.20241017120000.a1b2c3d4'],
    ['from_status', 'quarantined'],
    ['name', 'acme/package_with_underscores_and_numbers_123'],
    ['name', 'acme widget 2'],
  ];
  it.each(allowed)('accepts %s %s', (field, value) => {
    expect(redactValue(value, 200, field)).toEqual({ ok: true, value });
  });
});

describe('redactValue by field kind', () => {
  it('accepts an upper-case 64-hex digest in a hash field', () => {
    const digest = 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855';
    expect(redactValue(digest, 200, 'sha256_new').ok).toBe(true);
    expect(redactValue(digest, 200, 'plan_hash').ok).toBe(true);
  });

  it('refuses two digests in one hash field', () => {
    const digest = 'a3f9'.repeat(16);
    expect(redactValue(`${digest} ${digest}`, 200, 'sha256_new')).toEqual({
      ok: false,
      reason: 'credential_value',
    });
  });

  it('accepts a 40-hex commit in a version but not in a name', () => {
    const commit = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    expect(redactValue(commit, 200, 'version').ok).toBe(true);
    expect(redactValue(commit, 200, 'name').ok).toBe(false);
  });

  it('accepts a 40-hex commit as a URL path segment', () => {
    const url =
      'https://api.github.com/repos/acme/widget/zipball/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
    expect(redactValue(url, 200, 'url').ok).toBe(true);
  });

  it('refuses a url field value that is neither a URL nor an scp address', () => {
    expect(redactValue('mirror https://git.example.test/r', 200, 'url')).toEqual({
      ok: false,
      reason: 'bad_value',
    });
  });

  it('strips userinfo for a scheme outside the http family', () => {
    expect(redactValue('svn://deploy:hunter2pw@svn.example.test/r', 200, 'url')).toEqual({
      ok: true,
      value: 'svn://svn.example.test/r',
    });
  });

  it('accepts git@ as a service mailbox in free text', () => {
    expect(redactValue('Deploy key for git@github.com', 200, 'name').ok).toBe(true);
  });

  it('accepts a single-label @ inside a package path', () => {
    expect(redactValue('acme/my.email@helpers', 200, 'package_name').ok).toBe(true);
  });
});

describe('isCredentialValue free-text rules', () => {
  const refused: Array<[string, string]> = [
    ['userinfo after a single slash', 'https:/deploy:hunter2pw@10.0.0.5/r'],
    ['userinfo with no slash', 'https:deploy:hunter2pw@10.0.0.5/r'],
    ['userinfo after backslashes', 'https:\\\\deploy:hunter2pw@10.0.0.5/r'],
    ['userinfo for an unknown scheme', 'note svn://deploy:hunter2pw@svn.example.test/r'],
    ['query in a free-text URL', 'mirror https://git.example.test/r?apikey=s3cr3tvalue12'],
    ['fragment in a free-text URL', 'mirror https://git.example.test/r#token=s3cr3tvalue12'],
    ['secret-like key with =', 'private_token=s3cr3tvalue12'],
    ['secret-like key with a colon', 'API key: s3cr3tvalue12'],
    ['AWS secret key split by slashes', FAKE.AWS_SECRET_1],
    ['Bearer with an equals sign', FAKE.BEARER_EQUALS_1],
    ['Bearer with a colon', FAKE.BEARER_COLON_1],
    ['PEM with four dashes', FAKE.PEM_2],
    ['JWT after an underscore', FAKE.JWT_2],
    ['e-mail with a punycode TLD', 'jan@example.xn--p1ai'],
    ['e-mail at a bare IPv4', 'jan@10.0.0.1'],
    ['e-mail at a single label', 'jan@intranet'],
    ['24-character mixed-case run', FAKE.BASE64_24],
    ['31-character lower-case alphanumeric run', FAKE.RUN_5],
    ['32-character upper-case alphanumeric run', FAKE.RUN_6],
  ];
  it.each(refused)('refuses %s', (_name, value) => {
    expect(isCredentialValue(value)).toBe(true);
  });

  const allowed: Array<[string, string]> = [
    [['lower-case AK', 'IA inside a word'].join(''), 'eurasiancommercegateway'],
    ['provider prefix with a word body', FAKE.HUGGINGFACE_2],
    ['provider prefix with a short body', FAKE.GITHUB_PAT_CLASSIC_3],
    ['token followed by a word', 'Release token rotation-schedule'],
    ['permission with a colon', 'token:read'],
    ['camel-case words', 'MagentoCatalogInventoryIntegration'],
  ];
  it.each(allowed)('does not refuse %s', (_name, value) => {
    expect(isCredentialValue(value)).toBe(false);
  });
});

describe('redactValue detection rules', () => {
  const refused: Array<[string, string, string, 'bad_value' | 'credential_value']> = [
    ['GitLab token with a dash inside 16', 'name', FAKE.GITLAB_PAT_1, 'credential_value'],
    ['GitLab token with an early dash', 'name', FAKE.GITLAB_PAT_2, 'credential_value'],
    ['GitLab token with camel pieces', 'name', FAKE.GITLAB_PAT_3, 'credential_value'],
    ['GitLab deploy token with separators', 'name', FAKE.GITLAB_DEPLOY_2, 'credential_value'],
    ['base64 with a double slash', 'name', FAKE.RUN_7, 'credential_value'],
    ['base64 with a short segment', 'name', FAKE.RUN_8, 'credential_value'],
    ['base64 with a word segment', 'name', FAKE.RUN_9, 'credential_value'],
    ['44-character base64 with slashes', 'name', FAKE.RUN_10, 'credential_value'],
    ['dashed 4-character mixed pieces', 'name', FAKE.RUN_11, 'credential_value'],
    ['underscored 4-character mixed pieces', 'name', FAKE.RUN_12, 'credential_value'],
    [
      'chained ULIDs',
      'name',
      '01HZXY8J9K2M3N4P5Q6R7S8T9V-01HZXY8J9K2M3N4P5Q6R7S8T9W',
      'credential_value',
    ],
    ['letters-then-digits pieces', 'name', FAKE.RUN_13, 'credential_value'],
    ['upper-case letters then digits', 'name', FAKE.RUN_14, 'credential_value'],
    [
      'two UUIDs in an id field',
      'role_id',
      '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5c',
      'credential_value',
    ],
    [
      'scp address with a query',
      'url',
      'git.example.test:acme/repo.git?access=Ab1Cd2Ef3',
      'credential_value',
    ],
    [
      'scp address with a fragment',
      'url',
      'git.example.test:acme/repo.git#sig=Ab1Cd2',
      'credential_value',
    ],
    ['scp address without a dotted host', 'url', 'https:deploy:hunter2pw@10.0.0.5/r', 'bad_value'],
    ['javascript URL', 'url', 'javascript:alert(1)', 'bad_value'],
    ['javascript URL with slashes', 'url', 'javascript://h.example.test/x', 'bad_value'],
    ['data URL', 'url', 'data:text/plain,Ab1Cd2Ef3', 'bad_value'],
    ['mailto URL', 'url', 'mailto:jan@example.test', 'bad_value'],
    ['vbscript URL', 'url', 'vbscript:msgbox', 'bad_value'],
    [
      '40 hex outside a commit path',
      'url',
      'https://api.example.test/v1/a3f9a3f9a3f9a3f9a3f9a3f9a3f9a3f9a3f9a3f9/feed',
      'credential_value',
    ],
    [
      '40 hex as the first path segment',
      'url',
      'https://npm-proxy.fury.io/a3f9a3f9a3f9a3f9a3f9a3f9a3f9a3f9a3f9a3f9/acme/',
      'credential_value',
    ],
    [
      'UUID outside a commit path',
      'url',
      'https://hooks.example.test/services/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b',
      'credential_value',
    ],
    ['label with a long value', 'name', 'API key: production', 'credential_value'],
    ['label with a random value', 'name', 'token: x9Kq2', 'credential_value'],
    [
      'mid-word GitHub prefix with a random body',
      'name',
      FAKE.GITHUB_PAT_CLASSIC_1,
      'credential_value',
    ],
  ];
  it.each(refused)('refuses %s', (_name, field, value, reason) => {
    expect(redactValue(value, 200, field)).toEqual({ ok: false, reason });
  });

  const allowed: Array<[string, string, string]> = [
    ['label with a short display value', 'name', 'Token: CI deploy'],
    ['GitHub-like prefix inside a word', 'name', ['high', 's_abcdefghijklmnopq'].join('')],
    ['npm-like prefix inside a word', 'package_name', ['acme/pnp', 'm_workspacehelpers'].join('')],
    [
      'GitLab prefix with word pieces',
      'package_name',
      ['@acme/gl', 'pat-rotation-helper-cli'].join(''),
    ],
    ['branch path', 'version', 'dev-dependabot/composer/symfony/http-foundation-6.4.14'],
    [
      '40 hex after archive',
      'url',
      'https://github.com/acme/widget/archive/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0.zip',
    ],
    [
      '40 hex after tarball',
      'url',
      'https://api.github.com/repos/acme/widget/tarball/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    ],
    [
      '40 hex after commit',
      'url',
      'https://gitlab.example.test/acme/w/-/commit/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    ],
    [
      '40 hex after commits',
      'url',
      'https://h.example.test/acme/w/commits/a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    ],
    [
      'UUID after archive',
      'url',
      'https://h.example.test/archive/3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b.tgz',
    ],
    ['scp address with localhost', 'url', 'localhost:repo'],
    ['UUID in an id field', 'source_id', '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b'],
    [
      'dictionary word with digits',
      'package_name',
      'acme/magento2-warehouse01-helper-module-extension',
    ],
  ];
  it.each(allowed)('accepts %s', (_name, field, value) => {
    expect(redactValue(value, 200, field).ok).toBe(true);
  });
});
