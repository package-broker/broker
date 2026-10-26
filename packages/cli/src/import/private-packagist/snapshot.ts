import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { link, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PackagistApi, PackagistError } from './api.js';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Row = { [key: string]: Json };
type Schema = (value: unknown) => Json;

function invalid(): never {
  throw new PackagistError('invalid_response');
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
const string: Schema = (value) => (typeof value === 'string' ? value : invalid());
const boolean: Schema = (value) => (typeof value === 'boolean' ? value : invalid());
const id: Schema = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : invalid();
const nullable =
  (schema: Schema): Schema =>
  (value) =>
    value === null ? null : schema(value);
const array =
  (schema: Schema): Schema =>
  (value) =>
    Array.isArray(value) ? value.map(schema) : invalid();
function shape(required: Record<string, Schema>, optional: Record<string, Schema> = {}): Schema {
  return (value) => {
    const input = record(value);
    const output: Row = {};
    for (const [key, schema] of Object.entries(required)) output[key] = schema(input[key]);
    for (const [key, schema] of Object.entries(optional))
      if (Object.hasOwn(input, key) && input[key] !== null) output[key] = schema(input[key]);
    return output;
  };
}
const safeName: Schema = (value) => {
  const text = string(value) as string;
  const withoutReferences = text
    .replace(/(?:^|\s)git@[a-zA-Z0-9.-]+:[^\s@]+(?=\s|$)/g, '')
    .replace(/^[a-zA-Z0-9._-]+@\d+(?:\.\d+)+\.(?:zip|tar|gz|tgz|bz2|xz)$/, '');
  if (/[\r\n]/.test(text) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(withoutReferences)) return invalid();
  return text;
};
const accountName: Schema = (value) => {
  const text = string(value) as string;
  if (/[\r\n]|[^\s@]+@[^\s@]+\.[^\s@]+/.test(text)) return invalid();
  return text;
};
const url: Schema = (value) => {
  const text = string(value) as string;
  if (!text) return text;
  if (/^git@[a-zA-Z0-9.-]+:[^\s?#]+$/.test(text)) return text;
  try {
    const parsed = new URL(text);
    if (
      !['https:', 'http:', 'ssh:'].includes(parsed.protocol) ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.username && !(parsed.protocol === 'ssh:' && parsed.username === 'git'))
    )
      return invalid();
    return text;
  } catch {
    return invalid();
  }
};
class RepositoryUrlError extends Error {}
const repositoryUrl: Schema = (value) => {
  if (typeof value !== 'string') throw new RepositoryUrlError();
  const text = value;
  if (!text) return text;
  if (/^git@[a-zA-Z0-9.-]+:[^\s?#@]+$/.test(text)) return text;
  try {
    const parsed = new URL(text);
    const ssh = ['ssh:', 'git+ssh:', 'svn+ssh:'].includes(parsed.protocol);
    if (
      !['https:', 'http:', 'git:', 'ssh:', 'git+ssh:', 'svn:', 'svn+ssh:'].includes(
        parsed.protocol,
      ) ||
      !parsed.hostname ||
      parsed.password ||
      parsed.hash ||
      /[\s\r\n]/.test(text) ||
      (parsed.username && !(ssh && /^[a-zA-Z0-9_-]+$/.test(parsed.username))) ||
      // Retain public routing queries; credential-bearing query parameters are never persisted.
      [...parsed.searchParams.keys()].some(
        (key) =>
          /^(?:[a-z0-9]+[_-])*(?:token|key|secret|password|passwd|pwd|auth|signature|sig|credentials?)(?:[_-][a-z0-9]+)*$/i.test(
            key,
          ) ||
          /^(?:(?:access|refresh|id|auth)token|(?:api|private|public)key|authorization)$/i.test(
            key,
          ),
      )
    )
      throw new RepositoryUrlError();
    return text;
  } catch {
    throw new RepositoryUrlError();
  }
};
const reference: Schema = (value) => (value === '' || value === null ? value : id(value));
class EnumValueError extends Error {}
const safeEnum: Schema = (value) => {
  if (typeof value !== 'string' || !/^[\x20-\x7e]{0,64}$/.test(value)) throw new EnumValueError();
  try {
    return safeName(value);
  } catch {
    throw new EnumValueError();
  }
};
const permission = safeEnum;
const behavior = safeEnum;
const version = shape(
  { version: string, versionNormalized: string },
  {
    sourceReference: nullable(string),
    distReference: nullable(string),
    releasedAt: nullable(string),
  },
);
const packageSchema = shape(
  {
    id,
    name: safeName,
    origin: safeEnum,
    config: shape(
      {},
      {
        type: safeEnum,
        url: nullable(repositoryUrl),
        customJson: nullable(string),
        credentialsId: reference,
        mirroredRepositoryId: reference,
        artifactIds: array(id),
        defaultSuborganizationAccess: safeEnum,
      },
    ),
  },
  { abandoned: boolean, replacementPackage: nullable(safeName) },
);
const mirror = shape(
  { id, name: safeName, url: repositoryUrl },
  { mirroringBehavior: behavior, credentials: reference },
);
const team = shape(
  { id, name: safeName, permission },
  {
    members: array(
      shape(
        { id, username: accountName },
        {
          remoteIds: (value) => {
            const input = record(value);
            const output: Row = {};
            for (const [key, value] of Object.entries(input)) {
              if (!/^[a-zA-Z0-9_-]+$/.test(key)) return invalid();
              output[key] = typeof value === 'number' ? id(value) : accountName(value);
            }
            return output;
          },
        },
      ),
    ),
  },
);
const token = shape(
  { id },
  {
    description: safeName,
    access: safeEnum,
    expiresAt: nullable(string),
    url,
    lastUsed: nullable(string),
    teamId: reference,
  },
);
const suborganization = shape(
  {
    id,
    name: safeName,
    urlName: (value) => {
      const name = string(value) as string;
      return /^[a-zA-Z0-9_-]+$/.test(name) ? name : invalid();
    },
  },
  { createdAt: string, installStatistics: boolean, links: shape({}, { repository: url }) },
);
const credential = shape(
  {
    id,
    type: safeEnum,
  },
  {
    description: safeName,
    domain: safeName,
    username: accountName,
  },
);
const synchronization = shape(
  {
    name: safeName,
    isPrimary: boolean,
    integration: shape({ target: safeEnum }, { url }),
  },
  { id },
);
const artifact = shape(
  { id, version: string, originalFileName: safeName },
  {
    composerJson: shape({}, { name: safeName, version: string, type: string }),
  },
);

export interface SnapshotObject {
  readonly data: Row;
  readonly sha256: string;
}
export interface PackagistSnapshot {
  readonly version: 1;
  readonly versions: boolean;
  readonly fetchedAt: string;
  readonly org: string;
  readonly objects: Readonly<Record<string, readonly SnapshotObject[]>>;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).sort().join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const input = value as Record<string, unknown>;
    return `{${Object.keys(input)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(input[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function fetchSnapshot(
  api: PackagistApi,
  options: {
    readonly org: string;
    readonly versions?: boolean;
    readonly requireOrgMatch?: boolean;
    readonly now?: () => Date;
  },
): Promise<{ snapshot: PackagistSnapshot; notices: readonly string[] }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(options.org)) throw new PackagistError('invalid_input');
  const objects: Record<string, SnapshotObject[]> = {
    suborganizationPackages: [],
    suborganizationMirroredRepositories: [],
    suborganizationTeams: [],
    suborganizationTokens: [],
  };
  let verified = false;
  const dropped = new Map<string, number>();
  const evidence = (value: Json): void => {
    if (typeof value !== 'string' || !value) return;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return;
    }
    if (parsed.origin !== 'https://repo.packagist.com') return;
    let segment: string;
    try {
      segment = decodeURIComponent(parsed.pathname.split('/')[1] ?? '');
    } catch {
      return invalid();
    }
    if (!segment) return;
    if (segment !== options.org) throw new PackagistError('org_mismatch');
    verified = true;
  };
  const add = (kind: string, data: Row) => {
    api.assertNoCredentials(data);
    const entry = { data, sha256: createHash('sha256').update(canonical(data)).digest('hex') };
    (objects[kind] ??= []).push(entry);
  };
  const read = async (
    kind: string,
    path: string,
    schema: Schema,
    scope: Row = {},
  ): Promise<Row[]> => {
    objects[kind] ??= [];
    const rows: Row[] = [];
    for (const input of await api.list(path)) {
      try {
        rows.push(schema(input) as Row);
      } catch (error) {
        const reason =
          error instanceof RepositoryUrlError
            ? 'repository_url_refused'
            : error instanceof EnumValueError
              ? 'enum_value_refused'
              : undefined;
        if (!reason) throw error;
        dropped.set(reason, (dropped.get(reason) ?? 0) + 1);
      }
    }
    for (const row of rows) {
      if (kind === 'tokens' || kind === 'suborganizationTokens') evidence(row.url ?? null);
      if (kind === 'suborganizations' && row.links) evidence((row.links as Row).repository ?? null);
      add(kind, { ...row, ...scope });
    }
    return rows;
  };
  // Two workers bound pending requests as well as HTTP concurrency for large inventories.
  const tasks: (() => Promise<unknown>)[] = [];
  const schedule = (task: () => Promise<unknown>) => {
    tasks.push(task);
  };
  let cursor = 0;
  let stopped = false;
  const worker = async () => {
    try {
      for (;;) {
        if (stopped) return;
        const task = tasks[cursor++];
        if (!task) return;
        await task();
      }
    } catch (error) {
      stopped = true;
      throw error;
    }
  };
  const suborganizations = await read(
    'suborganizations',
    '/api/suborganizations/',
    suborganization,
  );
  const packages: Row[] = [];
  schedule(async () => {
    for (const row of await read('packages', '/api/packages/', packageSchema)) packages.push(row);
  });
  for (const [kind, endpoint, schema] of [
    ['mirroredRepositories', 'mirrored-repositories', mirror],
    ['teams', 'teams', team],
    ['tokens', 'tokens', token],
    ['credentials', 'credentials', credential],
    ['synchronizations', 'synchronizations', synchronization],
    ['customers', 'customers', shape({ id })],
    ['vendorBundles', 'vendor-bundles', shape({ id })],
  ] as const)
    schedule(() => read(kind, `/api/${endpoint}/`, schema));
  for (const suborg of suborganizations) {
    const base = `/api/suborganizations/${encodeURIComponent(suborg.urlName as string)}`;
    const scope = { suborganizationId: suborg.id! };
    schedule(async () => {
      const rows = await read('suborganizationPackages', `${base}/packages/`, packageSchema, scope);
      for (const row of rows) packages.push(row);
    });
    schedule(() =>
      read(
        'suborganizationMirroredRepositories',
        `${base}/mirrored-repositories/`,
        (value) => {
          const row = record(value);
          if (Object.hasOwn(row, 'mirroredRepository')) {
            const wrapped = shape({ mirroringBehavior: behavior, mirroredRepository: mirror })(
              row,
            ) as Row;
            return {
              ...(wrapped.mirroredRepository as Row),
              mirroringBehavior: wrapped.mirroringBehavior!,
            };
          }
          return mirror(value);
        },
        scope,
      ),
    );
    schedule(() => read('suborganizationTeams', `${base}/teams/`, team, scope));
    schedule(() => read('suborganizationTokens', `${base}/tokens/`, token, scope));
  }
  // Wait for both workers even on refusal, so no requests outlive this operation.
  const results = await Promise.allSettled([worker(), worker()]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  const uniquePackages = new Map<Json, { id: Json; artifact: boolean; private: boolean }>();
  for (const pkg of packages) {
    const previous = uniquePackages.get(pkg.id!);
    const config = pkg.config as Row;
    uniquePackages.set(pkg.id!, {
      id: pkg.id!,
      artifact:
        previous?.artifact === true ||
        config.type === 'artifact' ||
        (Array.isArray(config.artifactIds) && config.artifactIds.length > 0),
      private: previous?.private === true || pkg.origin === 'private',
    });
  }
  tasks.length = 0;
  cursor = 0;
  objects.artifacts = [];
  objects.packageDetails = [];
  for (const pkg of uniquePackages.values()) {
    if (pkg.artifact)
      schedule(() =>
        read('artifacts', `/api/packages/${pkg.id}/artifacts/`, artifact, { packageId: pkg.id! }),
      );
    if (options.versions && pkg.private)
      schedule(async () => {
        const result = await api.request(`/api/packages/${pkg.id}/`);
        const detail = shape({ id, versions: array(version) })(result.data) as Row;
        if (detail.id !== pkg.id) return invalid();
        add('packageDetails', detail);
      });
  }
  const details = await Promise.allSettled([worker(), worker()]);
  for (const result of details) if (result.status === 'rejected') throw result.reason;
  if (!verified && options.requireOrgMatch) throw new PackagistError('org_unverified');
  const snapshot: PackagistSnapshot = {
    version: 1,
    versions: options.versions === true,
    fetchedAt: (options.now ?? (() => new Date()))().toISOString(),
    org: options.org,
    objects,
  };
  api.assertNoCredentials(snapshot);
  const notices = [...dropped].map(([reason, count]) => `${reason}: ${count}`);
  if (!verified) notices.push('org_unverified');
  return { snapshot, notices: notices.sort() };
}

export async function writeSnapshot(path: string, snapshot: PackagistSnapshot): Promise<void> {
  const temporary = join(dirname(path), `.pb-packagist-${randomUUID()}.tmp`);
  let created = false;
  const interrupt = (signal: NodeJS.Signals): void => {
    try {
      unlinkSync(temporary);
    } catch {
      // The temporary file may not have been created yet.
    }
    process.removeListener(signal, interrupt);
    process.kill(process.pid, signal);
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(canonical(snapshot), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
  } catch (error) {
    throw new PackagistError(
      (error as NodeJS.ErrnoException).code === 'EEXIST' ? 'output_exists' : 'output_unwritable',
    );
  } finally {
    if (created) await unlink(temporary).catch(() => undefined);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
