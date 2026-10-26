import { PROJECT_SLUG_PATTERN } from '@package-broker/core/authz/project-path';
import { packageKey } from '@package-broker/core/catalogue/names';
import { isCanonicalPattern, isCanonicalUrl } from '@package-broker/core/import/source-config';
import { isCredentialReference } from '../credential-refs.js';

export type CredentialKind = 'http_basic' | 'bearer' | 'github_app' | 'ssh_key';
export interface CredentialRule {
  readonly match:
    | { package: string }
    | { url_prefix: string }
    | { packagist_credential: number }
    | { host: string };
  readonly kind: CredentialKind;
  readonly ref: string | null;
}
export interface TeamMapping {
  readonly group?: { readonly provider: string; readonly value: string };
  readonly members?: 'csv';
  readonly projects?: readonly string[];
  readonly role?: 'project_owner' | 'project_developer';
}
export interface PackagistMap {
  readonly version: 1;
  readonly projects: Readonly<
    Record<string, { readonly slug?: string; readonly existing?: string }>
  >;
  readonly github: { readonly installations: Readonly<Record<string, number>> };
  readonly mirrorOrder: readonly number[];
  readonly packages: Readonly<Record<string, { readonly url: string }>>;
  readonly teams: Readonly<Record<string, TeamMapping>>;
  readonly credentials: readonly CredentialRule[];
  readonly distHosts: Readonly<Record<string, readonly string[]>>;
}
export class MapError extends Error {
  constructor(
    readonly pointer: string,
    readonly cap?: string,
  ) {
    super('invalid_map');
  }
}
export const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && !/[\p{Cc}\p{Cf}]/u.test(v);
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const host = (v: unknown): v is string =>
  text(v) &&
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/.test(v);
function name(v: string): boolean {
  try {
    return packageKey(v, { ecosystem: 'composer' }) === v;
  } catch {
    return false;
  }
}
function bad(pointer: string, cap?: string): never {
  throw new MapError(pointer, cap);
}

export function parsePackagistMap(input: unknown): PackagistMap {
  const v: unknown =
    typeof input === 'string'
      ? (() => {
          try {
            return JSON.parse(input) as unknown;
          } catch {
            return bad('');
          }
        })()
      : input;
  if (
    !object(v) ||
    v.version !== 1 ||
    !keys(v, [
      'version',
      'projects',
      'github',
      'mirrorOrder',
      'packages',
      'teams',
      'credentials',
      'distHosts',
    ])
  )
    bad('');
  for (const key of ['projects', 'packages', 'teams', 'distHosts'])
    if (v[key] !== undefined && !object(v[key])) bad(`/${key}`);
  const projects = (v.projects ?? {}) as Record<string, unknown>;
  for (const [i, entry] of Object.values(projects).entries()) {
    if (
      !object(entry) ||
      !keys(entry, ['slug', 'existing']) ||
      Object.keys(entry).length !== 1 ||
      !text(entry.slug ?? entry.existing) ||
      !PROJECT_SLUG_PATTERN.test(String(entry.slug ?? entry.existing))
    )
      bad(`/projects/${i}`);
  }
  const github = v.github === undefined ? { installations: {} } : v.github;
  if (
    !object(github) ||
    !keys(github, ['installations']) ||
    !object(github.installations) ||
    !Object.entries(github.installations).every(
      ([owner, id]) => text(owner) && /^[a-z0-9](?:[a-z0-9-]{0,38})$/.test(owner) && positive(id),
    )
  )
    bad('/github');
  const order = v.mirrorOrder === undefined ? [] : v.mirrorOrder;
  if (!Array.isArray(order) || !order.every(positive) || new Set(order).size !== order.length)
    bad('/mirrorOrder');
  if (order.length > 89) bad('/mirrorOrder', 'MAX_MIRRORS');
  for (const [i, [pkg, entry]] of Object.entries(v.packages ?? {}).entries()) {
    if (!name(pkg) || !object(entry) || !keys(entry, ['url']) || !text(entry.url))
      bad(`/packages/${i}`);
  }
  for (const [i, entry] of Object.values(v.teams ?? {}).entries()) {
    if (
      !object(entry) ||
      !keys(entry, ['group', 'members', 'projects', 'role']) ||
      (entry.group === undefined) === (entry.members === undefined)
    )
      bad(`/teams/${i}`);
    if (
      entry.group !== undefined &&
      (!object(entry.group) ||
        !keys(entry.group, ['provider', 'value']) ||
        !text(entry.group.provider) ||
        !text(entry.group.value))
    )
      bad(`/teams/${i}/group`);
    if (entry.members !== undefined && entry.members !== 'csv') bad(`/teams/${i}/members`);
    if (
      entry.projects !== undefined &&
      (!Array.isArray(entry.projects) ||
        !entry.projects.every(text) ||
        new Set(entry.projects).size !== entry.projects.length)
    )
      bad(`/teams/${i}/projects`);
    if (
      entry.role !== undefined &&
      !['project_owner', 'project_developer'].includes(String(entry.role))
    )
      bad(`/teams/${i}/role`);
  }
  const credentials = v.credentials === undefined ? [] : v.credentials;
  if (!Array.isArray(credentials)) bad('/credentials');
  for (const [i, rule] of credentials.entries()) {
    const p = `/credentials/${i}`;
    if (
      !object(rule) ||
      !keys(rule, ['match', 'kind', 'ref']) ||
      !object(rule.match) ||
      Object.keys(rule.match).length !== 1 ||
      !['http_basic', 'bearer', 'github_app', 'ssh_key'].includes(String(rule.kind)) ||
      !(rule.ref === null || (typeof rule.ref === 'string' && isCredentialReference(rule.ref)))
    )
      bad(p);
    const m = rule.match;
    if (typeof m.package === 'string') {
      if (Buffer.byteLength(m.package) > 50) bad(`${p}/match`, 'MAX_PATTERN_BYTES');
      if (
        !text(m.package) ||
        !isCanonicalPattern(m.package) ||
        (!m.package.includes('*') && !name(m.package))
      )
        bad(`${p}/match`);
    } else if (typeof m.url_prefix === 'string') {
      if (!isCanonicalUrl(m.url_prefix) || !m.url_prefix.startsWith('https://')) bad(`${p}/match`);
    } else if (m.packagist_credential !== undefined) {
      if (!positive(m.packagist_credential)) bad(`${p}/match`);
    } else if (!host(m.host)) bad(`${p}/match`);
  }
  for (const [i, entry] of Object.values(v.distHosts ?? {}).entries()) {
    if (!Array.isArray(entry) || !entry.every(host) || new Set(entry).size !== entry.length)
      bad(`/distHosts/${i}`);
    if (entry.length > 64) bad(`/distHosts/${i}`, 'SOURCE_CONFIG_LIST_LIMIT');
    if (entry.some((h) => h.length > 200))
      bad(`/distHosts/${i}`, 'SOURCE_CONFIG_ENTRY_LENGTH_LIMIT');
  }
  return {
    version: 1,
    projects,
    github,
    mirrorOrder: order,
    packages: v.packages ?? {},
    teams: v.teams ?? {},
    credentials,
    distHosts: v.distHosts ?? {},
  } as unknown as PackagistMap;
}
