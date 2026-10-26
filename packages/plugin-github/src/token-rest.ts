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
  constructor(readonly code: 'invalid_response' | 'tag_limit_exceeded' = 'invalid_response') {
    super(`GitHub provider ${code}`);
    this.name = 'GithubRestError';
  }
}

/** Per-describe ceiling on manifest text bytes read and on GitHub API requests sent. */
export interface TokenRestBudget {
  readonly textBytes: number;
  readonly requests: number;
}

/** Counts every request of one describe against `requests`; the request over it is not sent. */
export function meteredFetch(policyFetch: PolicyFetch, requests: number) {
  let sent = 0;
  const fetch: PolicyFetch = async (request) => {
    if (sent >= requests) throw new UpstreamError('too_large', undefined, 'request_count');
    sent += 1;
    return policyFetch(request);
  };
  return { fetch, remaining: () => requests - sent };
}

export interface TextLimits {
  readonly textBytes: number;
  /** Requests the metered fetch still allows. */
  readonly remaining: () => number;
}

const UNBOUNDED: TextLimits = { textBytes: Infinity, remaining: () => Infinity };

export interface ManifestFile {
  readonly ref: string;
  readonly commit: string;
  readonly committedAt: null;
  readonly text: string | null;
  readonly reason: undefined;
}

export function tokenRest(
  fetch: PolicyFetch,
  credential: UpstreamCredential,
  repo: string,
  resetAt: (epochSeconds: number | undefined) => number,
  limits: TextLimits = UNBOUNDED,
) {
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
    throw new GithubRestError(kind === 'tags' ? 'tag_limit_exceeded' : 'invalid_response');
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
  async function stage(refs: readonly { name: string; oid: string }[]) {
    type Ref = (typeof refs)[number];
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
        if (errors.some((error) => record(error) && error.type === 'RATE_LIMITED')) {
          throw new RateLimited(resetAt(parseRateLimit(response.headers)?.reset));
        }
        const partial =
          repository !== null &&
          failed.size > 0 &&
          errors.every(
            (error) =>
              record(error) && Array.isArray(error.path) && failed.has(error.path[1] as string),
          ) &&
          chunk.some(
            (ref) => !failed.has(aliases.get(ref)!) && Object.hasOwn(repository, aliases.get(ref)!),
          );
        if (!partial) {
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
    const batches: Ref[][] = [];
    let textBytes = 0;
    for (let offset = 0; offset < refs.length; offset += 100) {
      const chunk = refs.slice(offset, offset + 100);
      const sizes = await batch(chunk, false);
      let pending: Ref[] = [];
      let cost = 0;
      for (const [index, blob] of sizes.entries()) {
        if (blob === null || (blob.byteSize as number) > MAX_FILE_BYTES) continue;
        textBytes += blob.byteSize as number;
        // JSON can escape each byte as six ASCII bytes; reserve room for the envelope.
        const escaped = (blob.byteSize as number) * 6 + 1024;
        if (pending.length > 0 && cost + escaped > MAX_BATCH_BYTES - 1024) {
          batches.push(pending);
          pending = [];
          cost = 0;
        }
        pending.push(chunk[index]!);
        cost += escaped;
      }
      if (pending.length > 0) batches.push(pending);
    }
    if (textBytes > limits.textBytes)
      throw new UpstreamError('too_large', undefined, 'manifest_bytes');
    if (batches.length > limits.remaining())
      throw new UpstreamError('too_large', undefined, 'request_count');
    async function read(chunk: readonly Ref[]) {
      const texts = new Map<Ref, string>();
      const blobs = await batch(chunk, true);
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
        texts.set(chunk[index]!, blob.text);
      }
      return texts;
    }
    const owners = new Map<Ref, number>();
    for (const [index, chunk] of batches.entries()) for (const ref of chunk) owners.set(ref, index);
    return {
      /** Yields one file per ref in order, holding the texts of one batch at a time. */
      async *files(): AsyncGenerator<ManifestFile> {
        let loaded = -1;
        let texts = new Map<Ref, string>();
        for (const ref of refs) {
          const owner = owners.get(ref);
          if (owner !== undefined && owner !== loaded) {
            texts.clear();
            texts = await read(batches[owner]!);
            loaded = owner;
          }
          yield {
            ref: ref.name,
            commit: ref.oid,
            committedAt: null,
            text: owner === undefined ? null : (texts.get(ref) ?? null),
            reason: undefined,
          };
        }
      },
    };
  }
  async function files(refs: readonly { name: string; oid: string }[]) {
    const result: ManifestFile[] = [];
    for await (const file of (await stage(refs)).files()) result.push(file);
    return result;
  }
  return { refs, branch, manifest, stage, files };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
