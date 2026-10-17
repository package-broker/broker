import { describe, expect, it } from 'vitest';
import {
  admitProxy,
  deriveVisibility,
  resolveWinner,
  type VisibilityAttachment,
  type VisibilityConfig,
  type VisibilityPackage,
  type VisibilitySource,
} from './visibility.js';

const source = (over: Partial<VisibilitySource> & { id: string }): VisibilitySource => ({
  orgId: 'o1',
  ecosystem: 'composer',
  type: 'composer_repository',
  ownerProjectId: null,
  removalPolicy: 'flag',
  defaultVisible: 1,
  ...over,
});

const pkg = (
  over: Partial<VisibilityPackage> & { id: string; sourceId: string },
): VisibilityPackage => ({
  orgId: 'o1',
  ecosystem: 'composer',
  key: 'acme/lib',
  status: 'active',
  visible: 1,
  ...over,
});

const att = (sourceId: string, over: Partial<VisibilityAttachment> = {}): VisibilityAttachment => ({
  projectId: 'p1',
  sourceId,
  precedence: 100,
  includes: [],
  excludes: [],
  ...over,
});

function config(over: Partial<VisibilityConfig> = {}): VisibilityConfig {
  return {
    projects: [{ id: 'p1', orgId: 'o1', active: true }],
    sources: [source({ id: 's1' })],
    packages: [pkg({ id: 'k1', sourceId: 's1' })],
    attachments: [att('s1')],
    explicit: [],
    registeredNames: [],
    ...over,
  };
}

const archived = [{ id: 'p1', orgId: 'o1', active: false }];
const rows = (c: VisibilityConfig) =>
  deriveVisibility(c).map((r) => `${r.projectId}:${r.packageId}:${r.origin}`);

describe('deriveVisibility', () => {
  it('derives subscription rows for flag-1 packages without includes', () => {
    expect(rows(config())).toEqual(['p1:k1:subscription']);
  });

  it('never admits flag-0 packages through subscription or includes', () => {
    const packages = [pkg({ id: 'k1', sourceId: 's1', visible: 0 })];
    expect(rows(config({ packages }))).toEqual([]);
    expect(rows(config({ packages, attachments: [att('s1', { includes: ['acme/*'] })] }))).toEqual(
      [],
    );
  });

  it('replaces subscription by matching includes with pattern origin', () => {
    const packages = [
      pkg({ id: 'k1', sourceId: 's1' }),
      pkg({ id: 'k2', sourceId: 's1', key: 'other/lib' }),
    ];
    expect(rows(config({ packages, attachments: [att('s1', { includes: ['acme/*'] })] }))).toEqual([
      'p1:k1:pattern',
    ]);
  });

  it('applies excludes over includes and subscription', () => {
    expect(rows(config({ attachments: [att('s1', { excludes: ['acme/*'] })] }))).toEqual([]);
  });

  it('keeps explicit rows through excludes and flag flips', () => {
    const packages = [pkg({ id: 'k1', sourceId: 's1', visible: 0 })];
    const attachments = [att('s1', { excludes: ['acme/*'] })];
    const explicit = [{ projectId: 'p1', packageId: 'k1' }];
    expect(rows(config({ packages, attachments, explicit }))).toEqual(['p1:k1:explicit']);
  });

  it('prefers explicit over pattern over subscription for the same package', () => {
    const attachments = [att('s1', { includes: ['acme/*'] })];
    const explicit = [{ projectId: 'p1', packageId: 'k1' }];
    expect(rows(config({ attachments, explicit }))).toEqual(['p1:k1:explicit']);
  });

  it('models detach as removal of the attachment, its patterns and every row', () => {
    const explicit = [{ projectId: 'p1', packageId: 'k1' }];
    expect(rows(config({ attachments: [], explicit }))).toEqual([]);
  });

  it('refuses sources owned by another project', () => {
    const sources = [source({ id: 's1', ownerProjectId: 'p2' })];
    const explicit = [{ projectId: 'p1', packageId: 'k1' }];
    expect(rows(config({ sources, explicit }))).toEqual([]);
  });

  it('keeps rows of archived projects', () => {
    expect(rows(config({ projects: archived }))).toEqual(['p1:k1:subscription']);
  });

  it('serves nothing from a forged attachment of another organization source', () => {
    const sources = [source({ id: 's1', orgId: 'o2' })];
    const packages = [pkg({ id: 'k1', orgId: 'o2', sourceId: 's1' })];
    const explicit = [{ projectId: 'p1', packageId: 'k1' }];
    expect(rows(config({ sources, packages, explicit }))).toEqual([]);
  });

  it('skips attachments to unknown projects', () => {
    expect(rows(config({ attachments: [att('s1', { projectId: 'ghost' })] }))).toEqual([]);
  });

  it('emits one row per project and package for duplicate attachments', () => {
    const attachments = [att('s1'), att('s1', { includes: ['acme/*'] })];
    expect(rows(config({ attachments }))).toEqual(['p1:k1:pattern']);
  });

  it('fails closed through the oracle when a rule exceeds the pattern cap', () => {
    const includes = Array.from({ length: 65 }, (_, i) => `acme/lib${i}`).concat('acme/lib');
    expect(rows(config({ attachments: [att('s1', { includes })] }))).toEqual([]);
  });
});

describe('resolveWinner', () => {
  const two = (over: Partial<VisibilityConfig> = {}) =>
    config({
      sources: [source({ id: 's1' }), source({ id: 's2' })],
      packages: [pkg({ id: 'k1', sourceId: 's1' }), pkg({ id: 'k2', sourceId: 's2' })],
      attachments: [att('s1', { precedence: 200 }), att('s2', { precedence: 100 })],
      ...over,
    });
  const win = (c: VisibilityConfig, projectId = 'p1') =>
    resolveWinner(c, projectId, 'composer', 'acme/lib')?.packageId;

  it('resolves nothing for an archived project while rows are kept', () => {
    const c = config({ projects: archived });
    expect(deriveVisibility(c)).toHaveLength(1);
    expect(win(c)).toBeUndefined();
  });

  it('orders by attachment precedence, then source id', () => {
    expect(win(two())).toBe('k2');
    expect(win(two({ attachments: [att('s1'), att('s2')] }))).toBe('k1');
  });

  it('reads precedence per project attachment', () => {
    const c = two({
      projects: [
        { id: 'p1', orgId: 'o1', active: true },
        { id: 'p2', orgId: 'o1', active: true },
      ],
      attachments: [
        att('s1', { precedence: 200 }),
        att('s2', { precedence: 100 }),
        att('s1', { projectId: 'p2', precedence: 100 }),
        att('s2', { projectId: 'p2', precedence: 200 }),
      ],
    });
    expect(win(c, 'p1')).toBe('k2');
    expect(win(c, 'p2')).toBe('k1');
  });

  it('prefers project-level over organization-level at equal precedence', () => {
    const c = two({
      sources: [source({ id: 's1' }), source({ id: 's2', ownerProjectId: 'p1' })],
      attachments: [att('s1'), att('s2')],
    });
    expect(win(c)).toBe('k2');
  });

  it('ranks non-proxy before proxy even at better precedence', () => {
    const c = two({
      sources: [source({ id: 's1' }), source({ id: 's2', type: 'packagist_proxy' })],
      attachments: [att('s1', { precedence: 1000 }), att('s2', { precedence: 1 })],
    });
    expect(win(c)).toBe('k1');
  });

  it('ranks non-proxy before proxy at equal precedence', () => {
    const c = two({
      sources: [
        source({ id: 's1', type: 'packagist_proxy' }),
        source({ id: 's2', type: 'composer_repository' }),
      ],
      attachments: [att('s1'), att('s2')],
    });
    expect(win(c)).toBe('k2');
  });

  it('applies the removal policy', () => {
    const packages = [pkg({ id: 'k1', sourceId: 's1', status: 'removed_upstream' })];
    expect(win(config({ packages }))).toBe('k1');
    const exclude = [source({ id: 's1', removalPolicy: 'exclude' })];
    expect(win(config({ packages, sources: exclude }))).toBeUndefined();
  });

  it('keeps a hidden private key blocking the same-named proxy row', () => {
    const c = config({
      sources: [source({ id: 's1' }), source({ id: 's2', type: 'packagist_proxy' })],
      packages: [pkg({ id: 'k1', sourceId: 's1', visible: 0 }), pkg({ id: 'k2', sourceId: 's2' })],
      attachments: [att('s1'), att('s2')],
    });
    expect(rows(c)).toEqual(['p1:k2:subscription']);
    expect(win(c)).toBeUndefined();
  });

  it('blocks the proxy for a removed_upstream non-proxy key under exclude, unattached', () => {
    const c = config({
      sources: [
        source({ id: 's1', type: 'packagist_proxy' }),
        source({ id: 's9', ownerProjectId: 'p2', removalPolicy: 'exclude' }),
      ],
      packages: [
        pkg({ id: 'k1', sourceId: 's1' }),
        pkg({ id: 'k9', sourceId: 's9', status: 'removed_upstream' }),
      ],
    });
    expect(win(c)).toBeUndefined();
  });

  it('blocks a project-level proxy by an organization-level private key', () => {
    const c = config({
      sources: [
        source({ id: 's1', type: 'packagist_proxy', ownerProjectId: 'p1' }),
        source({ id: 's9' }),
      ],
      packages: [pkg({ id: 'k1', sourceId: 's1' }), pkg({ id: 'k9', sourceId: 's9', visible: 0 })],
    });
    expect(win(c)).toBeUndefined();
  });

  it('does not let another organization private key block the proxy', () => {
    const c = config({
      sources: [source({ id: 's1', type: 'packagist_proxy' }), source({ id: 's9', orgId: 'o2' })],
      packages: [pkg({ id: 'k1', sourceId: 's1' }), pkg({ id: 'k9', orgId: 'o2', sourceId: 's9' })],
    });
    expect(win(c)).toBe('k1');
  });

  it('blocks proxy rows whose key matches a registered name of the same ecosystem', () => {
    const c = config({
      sources: [source({ id: 's1', type: 'packagist_proxy' })],
      registeredNames: [{ orgId: 'o1', ecosystem: 'composer', pattern: 'acme/*' }],
    });
    expect(win(c)).toBeUndefined();
  });

  it('ignores registered names of another ecosystem or organization', () => {
    const c = config({
      sources: [source({ id: 's1', type: 'packagist_proxy' })],
      registeredNames: [
        { orgId: 'o1', ecosystem: 'npm', pattern: 'acme/*' },
        { orgId: 'o2', ecosystem: 'composer', pattern: 'acme/*' },
      ],
    });
    expect(win(c)).toBe('k1');
  });

  it('fails closed on an invalid stored registered-name pattern', () => {
    const c = config({
      sources: [source({ id: 's1', type: 'packagist_proxy' })],
      registeredNames: [{ orgId: 'o1', ecosystem: 'composer', pattern: 'Bad[' }],
    });
    expect(win(c)).toBeUndefined();
  });

  it('does not mix ecosystems', () => {
    const c = config({ sources: [source({ id: 's1', ecosystem: 'npm', type: 'npm_registry' })] });
    expect(win(c)).toBeUndefined();
  });
});

describe('admitProxy', () => {
  const proxyConfig = (over: Partial<VisibilityConfig> = {}) =>
    config({
      sources: [
        source({ id: 's2', type: 'packagist_proxy' }),
        source({ id: 's1', type: 'packagist_proxy' }),
        source({ id: 's3', type: 'packagist_proxy', ownerProjectId: 'p1' }),
        source({ id: 's4', type: 'packagist_proxy', ownerProjectId: 'p2' }),
        source({ id: 's5', type: 'packagist_proxy' }),
      ],
      packages: [],
      attachments: [
        att('s1', { precedence: 1000 }),
        att('s2', { precedence: 1000 }),
        att('s3', { precedence: 500 }),
        att('s4'),
      ],
      ...over,
    });
  const admit = (c: VisibilityConfig, ecosystem: 'composer' | 'npm' = 'composer') =>
    admitProxy(c, 'p1', ecosystem, 'acme/lib');

  it('returns attached proxies owned by the org or the project, by attachment precedence then id', () => {
    expect(admit(proxyConfig())).toEqual(['s3', 's1', 's2']);
  });

  it('orders by the project attachment, not by the source', () => {
    const attachments = [att('s1', { precedence: 5 }), att('s2', { precedence: 1 })];
    expect(admit(proxyConfig({ attachments }))).toEqual(['s2', 's1']);
  });

  it('refuses an archived project', () => {
    expect(admit(proxyConfig({ projects: archived }))).toEqual([]);
  });

  it('refuses keys held by any non-proxy package, visible or not', () => {
    const packages = [pkg({ id: 'k9', sourceId: 's9', visible: 0, status: 'removed_upstream' })];
    const sources = [
      ...proxyConfig().sources,
      source({ id: 's9', ownerProjectId: 'p2', removalPolicy: 'exclude' }),
    ];
    expect(admit(proxyConfig({ packages, sources }))).toEqual([]);
  });

  it('ignores a non-proxy key held in another organization', () => {
    const packages = [pkg({ id: 'k9', orgId: 'o2', sourceId: 's9' })];
    const sources = [...proxyConfig().sources, source({ id: 's9', orgId: 'o2' })];
    expect(admit(proxyConfig({ packages, sources }))).toEqual(['s3', 's1', 's2']);
  });

  it('refuses registered names of the same ecosystem only', () => {
    const same = [{ orgId: 'o1', ecosystem: 'composer' as const, pattern: 'acme/lib' }];
    expect(admit(proxyConfig({ registeredNames: same }))).toEqual([]);
    const other = [{ orgId: 'o1', ecosystem: 'npm' as const, pattern: 'acme/lib' }];
    expect(admit(proxyConfig({ registeredNames: other }))).toEqual(['s3', 's1', 's2']);
  });

  it('fails closed on an invalid stored registered-name pattern', () => {
    const registeredNames = [{ orgId: 'o1', ecosystem: 'composer' as const, pattern: 'Bad[' }];
    expect(admit(proxyConfig({ registeredNames }))).toEqual([]);
  });

  it('refuses a forged attachment of another organization proxy', () => {
    const sources = [source({ id: 's1', type: 'packagist_proxy', orgId: 'o2' })];
    expect(admit(proxyConfig({ sources, attachments: [att('s1')] }))).toEqual([]);
  });

  it('applies the pattern rule with the source default flag', () => {
    const closed = proxyConfig().sources.map((s) => ({ ...s, defaultVisible: 0 as const }));
    expect(admit(proxyConfig({ sources: closed }))).toEqual([]);
    const attachments = [
      att('s1', { includes: ['other/*'] }),
      att('s2', { excludes: ['acme/lib'] }),
      att('s3', { includes: ['acme/*'] }),
    ];
    expect(admit(proxyConfig({ attachments }))).toEqual(['s3']);
  });

  it('fails closed when a rule exceeds the pattern cap', () => {
    const includes = Array.from({ length: 65 }, (_, i) => `acme/lib${i}`).concat('acme/lib');
    expect(admit(proxyConfig({ attachments: [att('s1', { includes })] }))).toEqual([]);
  });

  it('ignores non-proxy sources and other ecosystems', () => {
    const sources = [
      source({ id: 's1' }),
      source({ id: 's2', type: 'npmjs_proxy', ecosystem: 'npm' }),
    ];
    expect(admit(proxyConfig({ sources }))).toEqual([]);
  });
});

describe('a package whose ecosystem differs from its source ecosystem', () => {
  const npmSource = [source({ id: 's1', ecosystem: 'npm', type: 'npm_registry' })];

  it('derives no subscription row', () => {
    expect(rows(config({ sources: npmSource }))).toEqual([]);
  });

  it('derives no explicit row', () => {
    const c = config({ sources: npmSource, explicit: [{ projectId: 'p1', packageId: 'k1' }] });
    expect(rows(c)).toEqual([]);
  });

  it('derives no pattern row', () => {
    const c = config({ sources: npmSource, attachments: [att('s1', { includes: ['acme/*'] })] });
    expect(rows(c)).toEqual([]);
  });

  it('wins in neither ecosystem', () => {
    const c = config({ sources: npmSource });
    expect(resolveWinner(c, 'p1', 'composer', 'acme/lib')).toBeNull();
    expect(resolveWinner(c, 'p1', 'npm', 'acme/lib')).toBeNull();
  });

  it('resolves by the package ecosystem', () => {
    const c = config({ packages: [pkg({ id: 'k1', sourceId: 's1', ecosystem: 'npm' })] });
    expect(rows(c)).toEqual([]);
    expect(resolveWinner(c, 'p1', 'npm', 'acme/lib')).toBeNull();
    expect(resolveWinner(c, 'p1', 'composer', 'acme/lib')).toBeNull();
  });

  it('blocks proxies of the package ecosystem, not of the source ecosystem', () => {
    const sources = [
      source({ id: 's1', ecosystem: 'npm', type: 'npm_registry' }),
      source({ id: 's2', type: 'packagist_proxy' }),
      source({ id: 's3', ecosystem: 'npm', type: 'npmjs_proxy' }),
    ];
    const c = config({ sources, attachments: [att('s1'), att('s2'), att('s3')] });
    expect(admitProxy(c, 'p1', 'composer', 'acme/lib')).toEqual([]);
    expect(admitProxy(c, 'p1', 'npm', 'acme/lib')).toEqual(['s3']);
  });
});
