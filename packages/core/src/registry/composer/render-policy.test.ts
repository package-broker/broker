import { describe, expect, it, vi } from 'vitest';
import { createPackageAccess } from '../../catalogue/package-access.js';
import { createPolicyPackageAccess } from '../../catalogue/policy-access.js';
import type { CatalogueVersion } from '../../db/catalogue.js';
import type { PolicyRule } from '../../db/registry-policy.js';
import type { ScopedCache } from '../../platform/cache.js';
import { composerEntry, composerVersionId } from '../../test-support/policy-registry-http.js';
import {
  memoryCatalogue,
  type CatalogueEntry,
} from '../../test-support/registry-policy-catalogue.js';
import { policyRule, sessionSetup } from '../../test-support/registry-policy-session.js';
import type { RepresentationClock } from '../conditional.js';
import { expandVersions } from './minify.js';
import { renderComposerP2, renderPackagesJson } from './render.js';

const BLOCK = '01J0P0000000000000000000B1';
type Doc = { packages: Record<string, Array<Record<string, unknown>>> };

function block(members: string[], packageKey = 'acme/lib'): PolicyRule {
  return policyRule(BLOCK, { ecosystem: 'composer', packageKey, members });
}

function fixture(entries: CatalogueEntry[], rules: PolicyRule[] = [], governed = true) {
  const catalogue = memoryCatalogue(entries);
  const raw = createPackageAccess(catalogue.reader);
  const setup = sessionSetup({ rules, input: { ecosystem: 'composer' } });
  const cache = {
    currentVersion: vi.fn(async () => 'v1'),
    set: vi.fn(async () => true),
  };
  const clock: RepresentationClock = {
    advance: vi.fn(async (_ctx, input) => ({
      stale: false,
      validator: input.validator,
      lastModified: '2025-12-01T00:00:00Z',
    })),
  };
  const render = (init: { dev?: boolean; headers?: Record<string, string> } = {}) => {
    const session = setup.open({ client: { family: 'composer', version: '2.7.1' } });
    return renderComposerP2({
      requestId: '01J0R0000000000000000000R1',
      actor: session.actor,
      access: governed ? createPolicyPackageAccess(raw, session) : raw,
      projectSlug: 'demo',
      name: 'acme/lib',
      publicUrl: 'https://broker.test',
      request: new Request('https://broker.test/demo/p2/acme/lib.json', {
        headers: init.headers ?? {},
      }),
      clock,
      dev: init.dev ?? false,
      cache: cache as unknown as ScopedCache,
      ...(governed ? { policy: { session } } : {}),
    });
  };
  const root = () => {
    const session = setup.open({ kind: 'listing' });
    return renderPackagesJson({
      requestId: '01J0R0000000000000000000R1',
      actor: session.actor,
      access: createPolicyPackageAccess(raw, session),
      projectSlug: 'demo',
      policy: { session },
    });
  };
  return { setup, cache, clock, render, root };
}

const expanded = async (response: Response) => {
  const doc = (await response.json()) as Doc;
  return expandVersions(doc.packages['acme/lib'] ?? [], { maxVersions: 1000 });
};

function variant(entry: CatalogueEntry, n: number, change: Partial<CatalogueVersion>) {
  entry.versions[n] = { ...entry.versions[n]!, ...change };
}

describe('Composer P2 filtering', () => {
  it('stable and dev forms exclude denied versions and 404 when their form has none left', async () => {
    const entry = composerEntry(4);
    variant(entry, 3, { version: 'dev-main', versionNormalized: 'dev-main', stability: 'dev' });
    const { render } = fixture([entry], [block(['1.0.1.0', 'dev-main'])]);
    expect((await expanded(await render())).map((v) => v.version)).toEqual(['1.0.0', '1.0.2']);
    expect((await render({ dev: true })).status).toBe(404);
  });

  it('source-only versions and metapackages pass the same policy', async () => {
    const entry = composerEntry(4);
    for (const n of [0, 1]) {
      variant(entry, n, {
        distType: null,
        metadataJson: JSON.stringify({
          name: 'acme/lib',
          source: { type: 'git', url: 'https://git.test/lib', reference: `s${String(n)}` },
        }),
      });
    }
    for (const n of [2, 3]) {
      variant(entry, n, {
        distType: null,
        metadataJson: JSON.stringify({ name: 'acme/lib', type: 'metapackage' }),
      });
    }
    const { render } = fixture([entry], [block(['1.0.0.0', '1.0.2.0'])]);
    expect((await expanded(await render())).map((v) => v.version)).toEqual(['1.0.1', '1.0.3']);
  });

  it('an allowed successor inherits nothing from a denied predecessor', async () => {
    const entry = composerEntry(3);
    variant(entry, 0, { metadataJson: JSON.stringify({ name: 'acme/lib', license: ['MIT'] }) });
    variant(entry, 1, {
      metadataJson: JSON.stringify({
        name: 'acme/lib',
        license: ['MIT'],
        require: { 'x/y': '^1' },
      }),
    });
    variant(entry, 2, {
      metadataJson: JSON.stringify({
        name: 'acme/lib',
        license: ['MIT'],
        require: { 'x/y': '^1' },
      }),
    });
    const { render } = fixture([entry], [block(['1.0.1.0'])]);
    const versions = await expanded(await render());
    expect(versions.map((v) => v.version)).toEqual(['1.0.0', '1.0.2']);
    expect(versions[1]!.require).toEqual({ 'x/y': '^1' });
    expect(versions[0]).not.toHaveProperty('require');
  });

  it('never fills the shared rendered cache with a filtered document; the legacy path still does', async () => {
    const governed = fixture([composerEntry(3)], [block(['1.0.1.0'])]);
    expect((await governed.render()).status).toBe(200);
    expect(governed.cache.set).not.toHaveBeenCalled();
    const legacy = fixture([composerEntry(3)], [block(['1.0.1.0'])], false);
    expect((await legacy.render()).status).toBe(200);
    expect(legacy.cache.set).toHaveBeenCalledTimes(1);
  });

  it('validates by a decision-aware ETag only, without the date clock', async () => {
    const { render, clock } = fixture([composerEntry(3)], [block(['1.0.1.0'])]);
    const response = await render();
    expect(response.headers.get('etag')).toMatch(/^W\/"p\./);
    expect(response.headers.get('last-modified')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
    expect(clock.advance).not.toHaveBeenCalled();
    const etag = response.headers.get('etag')!;
    expect((await render({ headers: { 'if-none-match': etag } })).status).toBe(304);
    expect(
      (await render({ headers: { 'if-modified-since': 'Mon, 01 Dec 2025 00:00:00 GMT' } })).status,
    ).toBe(200);
  });

  it('a change of the filtered set changes the ETag', async () => {
    const { render, setup } = fixture([composerEntry(3)], [block(['1.0.1.0'])]);
    const etag = (await render()).headers.get('etag')!;
    setup.policy.commit([block(['1.0.1.0', '1.0.2.0'])]);
    const after = await render({ headers: { 'if-none-match': etag } });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(etag);
  });

  it('keeps the dist URL of each surviving version bound to its own id', async () => {
    const { render } = fixture([composerEntry(3)], [block(['1.0.1.0'])]);
    const versions = await expanded(await render());
    expect(versions.map((v) => (v.dist as { url: string }).url)).toEqual([
      `https://broker.test/demo/dist/acme/lib/${composerVersionId(0)}.1.zip`,
      `https://broker.test/demo/dist/acme/lib/${composerVersionId(2)}.1.zip`,
    ]);
  });

  it('a request-wide denial and an unreadable policy are the fixed envelopes', async () => {
    const broken = fixture([composerEntry(3)]);
    broken.setup.policy.state.fail = true;
    const response = await broken.render();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: 'policy_unavailable', message: 'Package policy is unavailable' },
    });
  });
});

describe('Composer root listing', () => {
  it('lists only packages with a permitted witness', async () => {
    const { root } = fixture(
      [composerEntry(2, 'acme/lib'), composerEntry(2, 'acme/other')],
      [block([], 'acme/other')],
    );
    const response = await root();
    expect(await response.json()).toEqual({
      packages: [],
      'metadata-url': '/demo/p2/%package%.json',
      'available-packages': ['acme/lib'],
    });
    expect(response.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('a P2 stream that has started is cut when policy changes before its next page', async () => {
    const entry = composerEntry(300);
    entry.versions = entry.versions.map((version, n) => ({
      ...version,
      metadataJson: JSON.stringify({
        name: 'acme/lib',
        padding: String(n).repeat(8000).slice(0, 8000),
        dist: { reference: 'r' },
      }),
    }));
    const { render, setup } = fixture([entry]);
    const response = await render();
    expect(response.status).toBe(200);
    setup.policy.commit([block(['1.0.250.0'])]);
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    await expect(
      (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          text += decoder.decode(value, { stream: true });
        }
      })(),
    ).rejects.toThrow();
    expect(text).toContain('"1.0.199"');
    expect(text).not.toContain('"1.0.200"');
  });
});
