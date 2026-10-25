import { createGithubProvider } from '@package-broker/plugin-github/provider';
import {
  APPLY_MEMBER_WINDOW,
  APPLY_WINDOW_BYTES,
} from '@package-broker/core/ingest/apply-description';
import { composerVersionInput } from '@package-broker/core/registry/composer/version-object';
import { createPolicyFetch } from '@package-broker/core/sources/policy-fetch';
import { createOutboundPolicy } from '@package-broker/core/sources/url-policy';
import { workersCodecs } from '@package-broker/runtime-cloudflare/codec/workers-codec';

const API = 'https://api.github.com';
const silent = { log() {}, counter() {}, histogram() {} };

function bearer(value) {
  return {
    origins: [API],
    queryParams: [],
    apply(headers, url) {
      if (url.origin === API) headers.set('authorization', `Bearer ${value}`);
      return { headers, url };
    },
  };
}

const NO_PROBE = { secrets: [], queryParams: [] };

// Mirrors readWindow in core ingest/apply-description: converts and retains admitted versions,
// stops converting once the window is full, and keeps draining to the end.
async function drain(description, key) {
  const importedAt = new Date().toISOString();
  const entries = [];
  const keys = new Set();
  let retained = 0;
  let admitted = 0;
  let exhausted = true;
  let members = 0;
  for await (const candidate of description.members) {
    members += 1;
    if (!exhausted) continue;
    if (entries.length >= APPLY_MEMBER_WINDOW) {
      exhausted = false;
      continue;
    }
    let version = null;
    try {
      const result = composerVersionInput(key, JSON.parse(candidate.raw), {
        probe: NO_PROBE,
        importedAt,
      });
      if (result.ok) version = result.input;
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
    const normalized = version?.versionNormalized;
    const duplicate = normalized !== undefined && keys.has(normalized);
    if (normalized !== undefined) keys.add(normalized);
    if (version === null || duplicate) {
      entries.push({ ordinal: candidate.ordinal, version: null });
      continue;
    }
    const bytes = 2 * version.metadata.json.length;
    if (admitted > 0 && retained + bytes > APPLY_WINDOW_BYTES) {
      exhausted = false;
      continue;
    }
    retained += bytes;
    admitted += 1;
    entries.push({ ordinal: candidate.ordinal, version });
  }
  return {
    members,
    kept: admitted,
    retainedUtf16Bytes: retained,
    upstreamComplete: description.upstreamComplete,
  };
}

export default {
  async fetch(request) {
    const { mode, repository, unbounded } = await request.json();
    const policyFetch = createPolicyFetch({
      policy: createOutboundPolicy({
        runtime: 'cloudflare',
        selfOrigins: [],
        allowPrivateHosts: [],
      }),
      userAgent: 'pb-github-fill-measure',
      fetchImpl: (input, init) => fetch(input, init),
    });
    const provider = createGithubProvider({
      runtime: 'cloudflare',
      ...(unbounded ? { budget: { textBytes: Infinity, requests: Infinity } } : {}),
      tokensFor: () => ({
        forRepositories: async () => ({
          value: 'fixture-installation-value',
          expiresAt: Date.now() / 1000 + 3600,
          repositories: [repository.split('/')[1]],
        }),
        forListing: async () => {
          throw new Error('unused');
        },
        observe() {},
        rateLimit() {
          return undefined;
        },
      }),
    });
    const source = {
      id: 'measure',
      type: 'vcs',
      ecosystem: 'composer',
      url: null,
      config: {
        provider: 'github',
        repository,
        refs: { tags: true, branches: ['main'] },
        ...(mode === 'app' ? { installationId: 7 } : { packageName: repository }),
      },
    };
    const ctx = {
      org: { orgId: 'measure' },
      fetch: policyFetch,
      credential: mode === 'app' ? null : bearer('fixture-personal-value'),
      codecs: workersCodecs,
      signal: new AbortController().signal,
      clock: { now: () => new Date() },
      observability: silent,
    };
    try {
      const result = await provider.describe(ctx, source, repository, {});
      if (result.kind !== 'found') return Response.json({ outcome: result.kind });
      return Response.json({ outcome: 'found', ...(await drain(result.description, repository)) });
    } catch (error) {
      return Response.json({
        outcome: 'error',
        name: error?.name ?? 'unknown',
        code: error?.code ?? null,
        status: error?.status ?? null,
      });
    }
  },
};
