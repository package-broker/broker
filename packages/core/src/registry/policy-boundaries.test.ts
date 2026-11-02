import { describe, expect, it, vi } from 'vitest';
import type { HookMap } from '../plugin.js';
import {
  composerEntry,
  composerVersionId,
  policyHttp,
} from '../test-support/policy-registry-http.js';
import { catalogueEntry } from '../test-support/registry-policy-catalogue.js';
import { policyRule } from '../test-support/registry-policy-session.js';
import { NPM_VARY } from './npm/render.js';

type Handler = HookMap['registry.read'];

const denyRequests: Handler = async (input) =>
  input.phase === 'request' ? { deny: true, reason: 'restricted' } : undefined;

/** Every bound or multi-row catalogue read reports a concurrent change while `on()` holds. */
function churn(http: ReturnType<typeof policyHttp>, on: () => boolean = () => true): void {
  const reader = http.catalogue.reader;
  const resolve = reader.resolveVersions.bind(reader);
  reader.resolveVersions = async (ctx, query) =>
    on() && (query.binding !== undefined || query.limit > 1)
      ? { changed: true }
      : resolve(ctx, query);
}

describe('policy boundaries of the registry routes', () => {
  it('npm: a catalogue that changes on both attempts answers the legacy unavailable code', async () => {
    const http = policyHttp({ entries: [catalogueEntry(3)] });
    churn(http);
    const response = await http.npmGet('/left-pad');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'unavailable' });
    expect(response.headers.get('retry-after')).toBe('10');
  });

  it('npm: a policy change on both attempts stays the fixed policy 503', async () => {
    const ref: { http?: ReturnType<typeof policyHttp> } = {};
    const hook = vi.fn<Handler>(async (input) => {
      if (input.phase === 'versions') ref.http?.policy.policy.commit([]);
      return undefined;
    });
    const flapping = policyHttp({ entries: [catalogueEntry(3)], hooks: [hook] });
    ref.http = flapping;
    const response = await flapping.npmGet('/left-pad');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'policy_unavailable' });
    expect(hook).toHaveBeenCalled();
  });

  it('npm: a policy change, then a catalogue change, stays the fixed policy 503', async () => {
    let churning = false;
    const ref: { http?: ReturnType<typeof policyHttp> } = {};
    const hook = vi.fn<Handler>(async (input) => {
      if (input.phase === 'versions' && !churning) {
        churning = true;
        ref.http?.policy.policy.commit([]);
      }
      return undefined;
    });
    const http = policyHttp({ entries: [catalogueEntry(3)], hooks: [hook] });
    ref.http = http;
    churn(http, () => churning);
    const response = await http.npmGet('/left-pad');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'policy_unavailable' });
  });

  it('Composer: a catalogue that changes on both attempts answers the legacy unavailable code', async () => {
    const http = policyHttp({ entries: [composerEntry(3)] });
    churn(http);
    const response = await http.composerGet('/p2/acme/lib.json');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
  });

  it('Composer: a policy change, then a catalogue change, stays the fixed policy 503', async () => {
    let churning = false;
    const ref: { http?: ReturnType<typeof policyHttp> } = {};
    const hook = vi.fn<Handler>(async (input) => {
      if (input.phase === 'versions' && !churning) {
        churning = true;
        ref.http?.policy.policy.commit([]);
      }
      return undefined;
    });
    const http = policyHttp({ entries: [composerEntry(3)], hooks: [hook] });
    ref.http = http;
    churn(http, () => churning);
    const response = await http.composerGet('/p2/acme/lib.json');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'policy_unavailable' } });
  });

  it('npm: dist-tags of a package the project cannot see never reach a request hook', async () => {
    const hook = vi.fn(denyRequests);
    const http = policyHttp({ entries: [catalogueEntry(3)], hooks: [hook], admissible: ['ghost'] });
    const response = await http.npmGet('/-/package/ghost/dist-tags');
    expect(response.status).toBe(404);
    expect(hook).not.toHaveBeenCalled();
    expect((await http.npmGet('/-/package/left-pad/dist-tags')).status).toBe(403);
  });

  it('Composer: a request-wide denial of a dist is 403 whether or not the version exists', async () => {
    const http = policyHttp({ entries: [composerEntry(3)], hooks: [denyRequests] });
    for (const n of [1, 9]) {
      const response = await http.composerGet(`/dist/acme/lib/${composerVersionId(n)}.1.zip`);
      expect(response.status, String(n)).toBe(403);
      expect(await response.json()).toMatchObject({ error: { code: 'policy_denied' } });
    }
    expect(http.served).toEqual([]);
  });

  it('npm: governed 200 and 304 packuments vary exactly like the legacy routes', async () => {
    const http = policyHttp({
      entries: [catalogueEntry(3)],
      rules: [policyRule('01J0P0000000000000000000B1', { members: ['1.0.0'] })],
    });
    const response = await http.npmGet('/left-pad');
    expect(response.headers.get('vary')).toBe(NPM_VARY);
    const cached = await http.npmGet('/left-pad', {
      'if-none-match': response.headers.get('etag')!,
    });
    expect(cached.status).toBe(304);
    expect(cached.headers.get('vary')).toBe(NPM_VARY);
    const legacy = await policyHttp({ entries: [catalogueEntry(3)], policy: false }).npmGet(
      '/left-pad',
    );
    expect(legacy.headers.get('vary')).toBe(NPM_VARY);
  });
});
