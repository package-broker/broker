import { packageKey } from '../../catalogue/names.js';
import { npmVersionsFromRefs } from '../../registry/npm/version-rules.js';
import { JsonTokenizer, type JsonToken } from '../json-tokenizer.js';
import {
  createPackageDescription,
  type SnapshotRef,
  type SkippedMember,
  type VersionCandidate,
} from '../../sources/provider.js';

export function parseNpmVcsManifest(text: string): Record<string, unknown> {
  const fail = (): never => {
    throw new TypeError('invalid_manifest');
  };
  if (text.length > 262144) return fail();
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > 262144) return fail();
  const stack: (Set<string> | null)[] = [];
  let nodes = 0;
  const sink = (token: JsonToken) => {
    if (++nodes > 10000) fail();
    if (token.type === 'beginObject' || token.type === 'beginArray') {
      if (stack.length >= 32) fail();
      stack.push(token.type === 'beginObject' ? new Set() : null);
    } else if (token.type === 'endObject' || token.type === 'endArray') stack.pop();
    else if (token.type === 'key') {
      const keys = stack.at(-1);
      if (
        !keys ||
        keys.has(token.value) ||
        ['__proto__', 'constructor', 'prototype'].includes(token.value)
      )
        fail();
      keys!.add(token.value);
    }
  };
  try {
    const parser = new JsonTokenizer({ maxStringBytes: 262144 });
    parser.write(bytes, sink);
    parser.end(sink);
    const manifest: unknown = JSON.parse(text);
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return fail();
    return manifest as Record<string, unknown>;
  } catch {
    return fail();
  }
}

export interface NpmManifestAtRef {
  readonly ref: string;
  readonly commit: string;
  readonly text: string | null;
  readonly committedAt?: string | null;
}

export async function npmVcsDescription(
  name: string,
  configuredName: string | undefined,
  tags: readonly string[],
  files: AsyncIterable<NpmManifestAtRef> | Iterable<NpmManifestAtRef>,
  snapshot: SnapshotRef,
) {
  const versions = npmVersionsFromRefs(tags).versions;
  const wanted = new Map(versions.map((v) => [`refs/tags/${v.ref}`, v]));
  const candidates = new Map<string, VersionCandidate>();
  const skipped: SkippedMember[] = [];
  let total = 0,
    bytes = 0;
  for await (const file of files) {
    if (++total > 50000 || (bytes += (file.text?.length ?? 0) * 2) > 64 * 1024 * 1024)
      throw new RangeError('too_large');
    const version = wanted.get(file.ref);
    if (!version || candidates.has(version.version)) continue;
    let manifest: Record<string, unknown>;
    let reason: SkippedMember['reason'] | undefined;
    try {
      manifest = parseNpmVcsManifest(file.text ?? '');
      if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string')
        reason = 'invalid_manifest';
      else if (
        packageKey(manifest.name, { ecosystem: 'npm' }) !== name ||
        (configuredName !== undefined && manifest.name !== configuredName)
      )
        reason = 'name_mismatch';
      else if (manifest.version !== version.version) reason = 'version_mismatch';
      else if (!/^[a-f0-9]{40}$/.test(file.commit)) reason = 'invalid_manifest';
    } catch {
      manifest = {};
      reason = 'invalid_manifest';
    }
    if (reason !== undefined) {
      skipped.push({ version: version.version, reason });
      continue;
    }
    delete manifest.dist;
    manifest.gitHead = file.commit;
    candidates.set(version.version, {
      ordinal: 0,
      version: version.version,
      form: 'npm-vcs',
      raw: JSON.stringify(manifest),
      ...(file.committedAt == null ? {} : { upstreamTime: file.committedAt }),
    });
  }
  const skippedVersions = new Set(skipped.map((v) => v.version));
  const members = versions
    .flatMap((v) => {
      const candidate = candidates.get(v.version);
      if (candidate) return [candidate];
      if (!skippedVersions.has(v.version))
        skipped.push({ version: v.version, reason: 'invalid_manifest' });
      return [];
    })
    .map((candidate, ordinal) => ({ ...candidate, ordinal }));
  const latest = (members.find((v) => !v.version.includes('-')) ?? members[0])?.version;
  return createPackageDescription({
    name,
    snapshot,
    validators: {},
    distTags: latest === undefined ? {} : { latest },
    skippedMembers: skipped,
    documentsComplete: true,
    members: (async function* () {
      yield* members;
    })(),
  });
}
