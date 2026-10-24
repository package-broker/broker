import {
  GITHUB_API_VERSION,
  UpstreamError,
  type PolicyFetch,
  type UpstreamCredential,
} from '@package-broker/core/plugin';

import { parseRateLimit } from './installation-token.js';
import { RateLimited } from './rate-limited.js';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_BATCH_BYTES = 8 * 1024 * 1024;

const API = 'https://api.github.com';
const SHA = /^[a-f0-9]{40}$/;

export class GithubRestError extends Error {
  readonly code = 'invalid_response';
  constructor() {
    super('GitHub provider invalid_response');
    this.name = 'GithubRestError';
  }
}

export function tokenRest(fetch: PolicyFetch, credential: UpstreamCredential, repo: string) {
  const authorization = credential.apply(new Headers(), new URL(API)).headers.get('authorization');
  if (authorization === null || !authorization.startsWith('Bearer '))
    throw new UpstreamError('http_status', 401);
  const secret = authorization.slice(7);
  function safeName(name: unknown): void {
    if (typeof name !== 'string') return;
    let value = name;
    for (let pass = 0; pass < 4; pass++) {
      if (value.toLowerCase().includes(secret.toLowerCase())) throw new GithubRestError();
      try {
        value = decodeURIComponent(value);
      } catch {
        break;
      }
    }
  }
  async function json(path: string, raw = false): Promise<unknown> {
    const response = await fetch({
      url: `${API}/repos/${repo}/${path}`,
      method: 'GET',
      purpose: 'api',
      headers: {
        accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'x-github-api-version': GITHUB_API_VERSION,
      },
      credential,
      destinations: [API],
      maxBytes: 1024 * 1024,
      timeoutMs: 30_000,
    });
    try {
      const value: unknown = await new Response(response.body).json();
      const entries: unknown[] = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        if (typeof entry === 'object' && entry !== null && 'name' in entry) safeName(entry.name);
      }
      return value;
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      throw new GithubRestError();
    }
  }
  async function refs(kind: 'tags' | 'branches') {
    const result: { name: string; oid: string }[] = [];
    for (let page = 1; page <= 500; page++) {
      const entries = await json(`${kind}?per_page=100&page=${page}`);
      if (!Array.isArray(entries) || entries.length > 100) throw new GithubRestError();
      for (const entry of entries as unknown[]) {
        if (
          typeof entry !== 'object' ||
          entry === null ||
          !('name' in entry) ||
          typeof entry.name !== 'string' ||
          !('commit' in entry) ||
          typeof entry.commit !== 'object' ||
          entry.commit === null ||
          !('sha' in entry.commit) ||
          typeof entry.commit.sha !== 'string' ||
          !SHA.test(entry.commit.sha)
        )
          throw new GithubRestError();
        result.push({
          name: `refs/${kind === 'tags' ? 'tags' : 'heads'}/${entry.name}`,
          oid: entry.commit.sha,
        });
      }
      if (entries.length < 100) return result;
    }
    throw new GithubRestError();
  }
  async function manifest() {
    return json('contents/composer.json', true);
  }
  async function branch(name: string) {
    let entry: unknown;
    try {
      entry = await json(`branches/${encodeURIComponent(name)}`);
    } catch (error) {
      if (error instanceof UpstreamError && error.code === 'http_status' && error.status === 404)
        return null;
      throw error;
    }
    if (
      typeof entry !== 'object' ||
      entry === null ||
      !('name' in entry) ||
      entry.name !== name ||
      !('commit' in entry) ||
      typeof entry.commit !== 'object' ||
      entry.commit === null ||
      !('sha' in entry.commit) ||
      typeof entry.commit.sha !== 'string' ||
      !SHA.test(entry.commit.sha)
    )
      throw new GithubRestError();
    return { name: `refs/heads/${name}`, oid: entry.commit.sha };
  }
  async function files(refs: readonly { name: string; oid: string }[]) {
    type Ref = (typeof refs)[number];
    const texts = new Map<Ref, string>();
    const aliases = new Map(refs.map((ref, index) => [ref, `a${index}`]));
    const [owner, name] = repo.split('/');
    async function batch(chunk: readonly Ref[], text: boolean) {
      if (chunk.some((ref) => !SHA.test(ref.oid))) throw new GithubRestError();
      const fields = chunk
        .map(
          (ref) =>
            `${aliases.get(ref)}: object(expression: "${ref.oid}:composer.json") { ... on Blob { byteSize${text ? ' text' : ''} } }`,
        )
        .join(' ');
      const response = await fetch({
        url: `${API}/graphql`,
        method: 'POST',
        purpose: 'api',
        headers: { 'content-type': 'application/json', 'x-github-api-version': GITHUB_API_VERSION },
        body: new TextEncoder().encode(
          JSON.stringify({
            query: `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
            variables: { owner, name },
          }),
        ),
        credential,
        destinations: [API],
        maxBytes: MAX_BATCH_BYTES,
        timeoutMs: 30_000,
      });
      let value: unknown;
      try {
        value = await new Response(response.body).json();
      } catch (error) {
        if (error instanceof UpstreamError) throw error;
        throw new GithubRestError();
      }
      if (!record(value)) throw new GithubRestError();
      const repository =
        record(value.data) && record(value.data.repository) ? value.data.repository : null;
      const failed = new Set<string>();
      if (value.errors !== undefined) {
        if (!Array.isArray(value.errors) || value.errors.length === 0) throw new GithubRestError();
        const errors = value.errors as unknown[];
        for (const error of errors) {
          if (!record(error)) throw new GithubRestError();
          const path = error.path;
          if (
            Array.isArray(path) &&
            path[0] === 'repository' &&
            typeof path[1] === 'string' &&
            chunk.some((ref) => path[1] === aliases.get(ref))
          )
            failed.add(path[1]);
        }
        const partial =
          repository !== null &&
          failed.size > 0 &&
          errors.every(
            (error) =>
              record(error) && Array.isArray(error.path) && failed.has(error.path[1] as string),
          ) &&
          chunk.some(
            (ref) => !failed.has(aliases.get(ref)!) && record(repository[aliases.get(ref)!]),
          );
        if (!partial) {
          if (errors.some((error) => record(error) && error.type === 'RATE_LIMITED')) {
            throw new RateLimited(
              parseRateLimit(response.headers)?.reset ?? Math.floor(Date.now() / 1000) + 60,
            );
          }
          if (errors.some((error) => record(error) && error.type === 'FORBIDDEN'))
            throw new UpstreamError('http_status', 403);
          throw new GithubRestError();
        }
      }
      if (repository === null) throw new GithubRestError();
      return chunk.map((ref) => {
        const alias = aliases.get(ref)!;
        if (failed.has(alias)) return null;
        const blob = repository[alias];
        if (blob === null || (record(blob) && Object.keys(blob).length === 0)) return null;
        if (!record(blob) || !Number.isSafeInteger(blob.byteSize) || (blob.byteSize as number) < 0)
          throw new GithubRestError();
        return blob;
      });
    }
    for (let offset = 0; offset < refs.length; offset += 100) {
      const chunk = refs.slice(offset, offset + 100);
      const sizes = await batch(chunk, false);
      let pending: Ref[] = [];
      let budget = 0;
      async function readPending() {
        if (pending.length === 0) return;
        const blobs = await batch(pending, true);
        for (const [index, blob] of blobs.entries()) {
          if (blob === null || (blob.byteSize as number) > MAX_FILE_BYTES || blob.text === null)
            continue;
          if (
            typeof blob.text !== 'string' ||
            new TextEncoder().encode(blob.text).byteLength > MAX_FILE_BYTES
          )
            throw new GithubRestError();
          // Keep malformed JSON local to its ref in the provider.
          try {
            const manifest: unknown = JSON.parse(blob.text);
            if (record(manifest)) safeName(manifest.name);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
          texts.set(pending[index]!, blob.text);
        }
        pending = [];
        budget = 0;
      }
      for (const [index, blob] of sizes.entries()) {
        if (blob === null || (blob.byteSize as number) > MAX_FILE_BYTES) continue;
        // JSON can escape each byte as six ASCII bytes; reserve room for the envelope.
        const cost = (blob.byteSize as number) * 6 + 1024;
        if (budget + cost > MAX_BATCH_BYTES - 1024) await readPending();
        pending.push(chunk[index]!);
        budget += cost;
      }
      await readPending();
    }
    return refs.map((ref) => ({
      ref: ref.name,
      commit: ref.oid,
      committedAt: null,
      text: texts.get(ref) ?? null,
      reason: undefined,
    }));
  }
  return { refs, branch, manifest, files };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
