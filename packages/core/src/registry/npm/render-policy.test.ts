import { describe, expect, it, vi } from 'vitest';
import { createPackageAccess } from '../../catalogue/package-access.js';
import { createPolicyPackageAccess } from '../../catalogue/policy-access.js';
import type { PolicyRule } from '../../db/registry-policy.js';
import type { HookMap } from '../../plugin.js';
import {
  catalogueEntry,
  catalogueVersion,
  memoryCatalogue,
  type CatalogueEntry,
} from '../../test-support/registry-policy-catalogue.js';
import { policyRule, sessionSetup } from '../../test-support/registry-policy-session.js';
import { MAX_VERSION_DECISIONS } from '../policy/session.js';
import { renderPackument, renderVersionDocument } from './render.js';

const BLOCK = '01J0P0000000000000000000B1';

interface Packument {
  versions: Record<string, { description?: string; deprecated?: string }>;
  'dist-tags': Record<string, string>;
  time: Record<string, string>;
}
const BASE = 'b'.repeat(64);

function block(members: string[], packageKey = 'left-pad'): PolicyRule {
  return policyRule(BLOCK, { packageKey, members });
}

function fixture(
  entry: CatalogueEntry,
  options: { rules?: PolicyRule[]; hooks?: Array<HookMap['registry.read']> } = {},
) {
  const catalogue = memoryCatalogue([entry]);
  const raw = createPackageAccess(catalogue.reader);
  const setup = sessionSetup({
    rules: options.rules ?? [],
    ...(options.hooks ? { hooks: options.hooks } : {}),
  });
  const render = (
    init: { abbreviated?: boolean; headers?: Record<string, string>; version?: string } = {},
  ) => {
    const session = setup.open();
    const options = {
      requestId: '01J0R0000000000000000000R1',
      access: createPolicyPackageAccess(raw, session),
      actor: session.actor,
      projectSlug: 'demo',
      name: entry.pkg.key,
      publicUrl: 'https://broker.test',
      abbreviated: init.abbreviated ?? false,
      policy: {
        session,
        conditional: { method: 'GET', headers: new Headers(init.headers ?? {}) },
        baseValidator: BASE,
      },
    };
    return init.version === undefined
      ? renderPackument(options)
      : renderVersionDocument(options, init.version);
  };
  return { catalogue, setup, render };
}

function tagged(count: number): CatalogueEntry {
  const entry = catalogueEntry(count);
  entry.tags = { latest: 'V0004', beta: 'V0003' };
  entry.versions = entry.versions.map((version, n) => ({
    ...version,
    metadataJson: JSON.stringify({
      name: 'left-pad',
      description: `Pads «${String(n)}» <b>text</b>`,
      deprecated: 'stored deprecation is replaced by the catalogue column',
    }),
    deprecatedMessage: n === 2 ? 'Use 1.0.3 — really' : null,
  }));
  return entry;
}

describe('npm filtered packument', () => {
  it('full and abbreviated documents agree and drop denied versions, times and tags without retargeting', async () => {
    const { render } = fixture(tagged(5), { rules: [block(['1.0.4', '1.0.1'])] });
    const full = (await (await render()).json()) as Packument;
    const abbreviated = (await (await render({ abbreviated: true })).json()) as Packument;
    expect(Object.keys(full.versions)).toEqual(['1.0.0', '1.0.2', '1.0.3']);
    expect(Object.keys(abbreviated.versions)).toEqual(Object.keys(full.versions));
    expect(full['dist-tags']).toEqual({ beta: '1.0.3' });
    expect(abbreviated['dist-tags']).toEqual({ beta: '1.0.3' });
    expect(Object.keys(full.time)).toEqual(['created', 'modified', '1.0.0', '1.0.2', '1.0.3']);
  });

  it('keeps publisher text of surviving versions exactly as stored', async () => {
    const { render } = fixture(tagged(5), { rules: [block(['1.0.4'])] });
    const body = (await (await render()).json()) as Packument;
    expect(body.versions['1.0.2']?.description).toBe('Pads «2» <b>text</b>');
    expect(body.versions['1.0.2']?.deprecated).toBe('Use 1.0.3 — really');
    expect(body.versions['1.0.3']).not.toHaveProperty('deprecated');
  });

  it('a package with no eligible version is a 404', async () => {
    const response = await fixture(tagged(5), { rules: [block([])] }).render();
    expect(response.status).toBe(404);
  });

  it('denials on a later raw page and an all-denied first page are both honoured', async () => {
    const entry = catalogueEntry(250);
    const late = fixture(entry, { rules: [block(['1.0.240'])] });
    const lateBody = (await (await late.render()).json()) as Packument;
    expect(Object.keys(lateBody.versions)).toHaveLength(249);
    expect(lateBody.versions).not.toHaveProperty(['1.0.240']);

    const firstPage = Array.from({ length: 200 }, (_, n) => `1.0.${String(n)}`);
    const early = fixture(catalogueEntry(250), { rules: [block(firstPage)] });
    const earlyBody = (await (await early.render()).json()) as Packument;
    expect(Object.keys(earlyBody.versions)).toHaveLength(50);
    expect(Object.keys(earlyBody.versions)[0]).toBe('1.0.200');
  });

  it('fails with the fixed 503 before any header when the document exceeds the decision bound', async () => {
    const entry = catalogueEntry(MAX_VERSION_DECISIONS + 1);
    entry.versions = entry.versions.map((version, n) => ({
      ...version,
      publishedAt: new Date(Date.UTC(2020, 0, 1) + n * 60_000).toISOString(),
    }));
    const { render } = fixture(entry);
    const within = { ...entry, versions: entry.versions.slice(0, MAX_VERSION_DECISIONS) };
    expect((await fixture(within).render()).status).toBe(200);
    const response = await render();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Package policy is unavailable',
      code: 'policy_unavailable',
      requestId: '01J0R0000000000000000000R1',
    });
    expect(response.headers.get('retry-after')).toBe('5');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  }, 30_000);

  it('a request-wide denial is the fixed 403 and a failing policy read the fixed 503', async () => {
    const denied = fixture(tagged(5), {
      hooks: [
        (input) => (input.phase === 'request' ? { deny: true, reason: 'restricted' } : undefined),
      ],
    });
    const refused = await denied.render();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: 'Package access denied by policy',
      code: 'policy_denied',
      requestId: '01J0R0000000000000000000R1',
    });
    expect(refused.headers.get('cache-control')).toBe('private, no-store');

    const broken = fixture(tagged(5));
    broken.setup.policy.state.fail = true;
    const unavailable = await broken.render();
    expect(unavailable.status).toBe(503);
    expect(JSON.stringify(await unavailable.json())).not.toContain('SELECT');
  });

  it('a policy commit during evaluation is retried once and the retry serves the new decision', async () => {
    const { render, setup } = fixture(tagged(5));
    const snapshot = setup.policy.reader.snapshot.bind(setup.policy.reader);
    let reads = 0;
    setup.policy.reader.snapshot = async (ctx, query) => {
      reads += 1;
      if (reads === 2) setup.policy.commit([block(['1.0.0'])]);
      return snapshot(ctx, query);
    };
    const body = (await (await render()).json()) as Packument;
    expect(Object.keys(body.versions)).toEqual(['1.0.1', '1.0.2', '1.0.3', '1.0.4']);
  });

  it('a change on every attempt is the fixed 503, not a document', async () => {
    const { render, setup } = fixture(tagged(5));
    const snapshot = setup.policy.reader.snapshot.bind(setup.policy.reader);
    let reads = 0;
    setup.policy.reader.snapshot = async (ctx, query) => {
      reads += 1;
      if (reads % 2 === 0) setup.policy.commit([]);
      return snapshot(ctx, query);
    };
    const response = await render();
    expect(response.status).toBe(503);
    expect(((await response.json()) as { code: string }).code).toBe('policy_unavailable');
  });

  it('issues a decision-aware ETag and answers a matching conditional only after evaluation', async () => {
    const { render, setup } = fixture(tagged(5), { rules: [block(['1.0.4'])] });
    const first = await render();
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"p\.[0-9a-f]{32}"$/);
    const again = await render({ headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(again.headers.get('etag')).toBe(etag);

    setup.policy.commit([block(['1.0.4', '1.0.3'])]);
    const changed = await render({ headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('a stream that has started is cut, never continued, when policy changes before its next page', async () => {
    const entry = catalogueEntry(300);
    const padding = 'x'.repeat(8000);
    entry.versions = entry.versions.map((version) => ({
      ...version,
      metadataJson: JSON.stringify({ name: 'left-pad', padding }),
    }));
    const { render, setup } = fixture(entry);
    const response = await render();
    expect(response.status).toBe(200);
    setup.policy.commit([block(['1.0.250'])]);
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

  it('a denied exact version or tag target is a 404 after its audit; an allowed one renders', async () => {
    const { render, setup } = fixture(tagged(5), { rules: [block(['1.0.4'])] });
    expect((await render({ version: '1.0.4' })).status).toBe(404);
    expect((await render({ version: 'latest' })).status).toBe(404);
    expect(setup.audit.events).toHaveLength(2);
    const allowed = await render({ version: 'beta' });
    expect(allowed.status).toBe(200);
    expect(((await allowed.json()) as { version: string }).version).toBe('1.0.3');
  });

  it('a version document is refused with the fixed 503 when its audit cannot be written', async () => {
    const entry = tagged(5);
    const catalogue = memoryCatalogue([entry]);
    const setup = sessionSetup({ rules: [block(['1.0.4'])], auditFails: true });
    const session = setup.open();
    const response = await renderVersionDocument(
      {
        requestId: '01J0R0000000000000000000R1',
        access: createPolicyPackageAccess(createPackageAccess(catalogue.reader), session),
        actor: session.actor,
        projectSlug: 'demo',
        name: 'left-pad',
        publicUrl: 'https://broker.test',
        policy: {
          session,
          conditional: { method: 'GET', headers: new Headers() },
          baseValidator: BASE,
        },
      },
      '1.0.4',
    );
    expect(response.status).toBe(503);
  });

  it('versions removed by a hook leave the document and change its ETag', async () => {
    const hook = vi.fn<HookMap['registry.read']>((input) =>
      input.phase === 'versions'
        ? {
            deniedVersions: input.versions
              .filter((fact) => fact.version === '1.0.2')
              .map((fact) => ({
                versionId: fact.versionId,
                revision: fact.revision,
                reason: 'restricted' as const,
              })),
          }
        : undefined,
    );
    const hooked = fixture(tagged(5), { hooks: [hook] });
    const plain = fixture(tagged(5));
    const withHook = await hooked.render();
    const without = await plain.render();
    expect(Object.keys(((await withHook.json()) as Packument).versions)).not.toContain('1.0.2');
    expect(withHook.headers.get('etag')).not.toBe(without.headers.get('etag'));
    expect(catalogueVersion(0).versionId).toBe('V0000');
  });

  it('a policy commit between evaluation and the 304 is seen by the seal, not answered from the old decision', async () => {
    const { render, setup } = fixture(tagged(5));
    const etag = (await render()).headers.get('etag')!;
    const snapshot = setup.policy.reader.snapshot.bind(setup.policy.reader);
    let reads = 0;
    setup.policy.reader.snapshot = async (ctx, query) => {
      reads += 1;
      if (reads === 2) setup.policy.commit([block(['1.0.4'])]);
      return snapshot(ctx, query);
    };
    const response = await render({ headers: { 'if-none-match': etag } });
    expect(response.status).toBe(200);
    expect(Object.keys(((await response.json()) as Packument).versions)).not.toContain('1.0.4');
  });

  it('a version document is sealed: a block committed after its lookup is a 404', async () => {
    const { render, setup } = fixture(tagged(5));
    const snapshot = setup.policy.reader.snapshot.bind(setup.policy.reader);
    let reads = 0;
    setup.policy.reader.snapshot = async (ctx, query) => {
      reads += 1;
      if (reads === 2) setup.policy.commit([block(['1.0.4'])]);
      return snapshot(ctx, query);
    };
    expect((await render({ version: '1.0.4' })).status).toBe(404);
  });
});
