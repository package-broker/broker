import * as z from 'zod/mini';
import { validateInput, type ValidationCode } from '../api/validate.js';
import {
  DEFAULT_ROLES,
  PERMISSIONS,
  isPermission,
  rolePermissionProblems,
} from '../authz/permissions.js';
import { PROJECT_SLUG_PATTERN } from '../authz/project-path.js';
import { packageKey } from '../catalogue/names.js';
import { ROLE_KEY_PATTERN } from '../db/roles.js';
import { normalizeEmail } from '../identity/policy.js';
import { isReservedProviderId, isValidProviderId } from '../identity/port.js';
import { UPSTREAM_DEFAULTS } from '../sources/config.js';
import {
  ECOSYSTEM_OF,
  isCanonicalPattern,
  isCanonicalUrl,
  isPackagistConfig,
  SOURCE_TYPES,
  isConfigOf,
  sortConfigLists,
  sourceConfig,
} from './source-config.js';

export const MAX_MANIFEST_ITEMS = 10000;
export const MAX_MANIFEST_BYTES = 1048576;

const MAX_NAME_CODE_POINTS = 100;
const MAX_GROUP_CODE_POINTS = 256;
const MAX_PRECEDENCE = 100000;
const MAX_PERMISSION_LENGTH = 100;
const MAX_PACKAGE_LENGTH = 428;
const MAX_DETAILS = 20;

const externalRef = z.string().check(z.regex(/^[A-Za-z0-9._:/-]{1,200}$/));
const credentialRef = z.string().check(
  z.refine((value) => {
    if (/\p{Cc}/u.test(value)) return false;
    if (value.startsWith('env:')) {
      return /^env:[A-Z_][A-Z0-9_]{0,127}$/.exec(value)?.[0] === value;
    }
    if (!value.startsWith('file:')) return false;
    const path = value.slice(5);
    return path.length > 0 && new TextEncoder().encode(path).byteLength <= 1024;
  }),
);

const FORBIDDEN_TEXT = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;

function isDisplayText(value: string, maxCodePoints: number): boolean {
  const length = [...value].length;
  return (
    length >= 1 &&
    length <= maxCodePoints &&
    value === value.normalize('NFC') &&
    value === value.trim() &&
    !FORBIDDEN_TEXT.test(value)
  );
}

const displayText = z
  .string()
  .check(z.refine((value) => isDisplayText(value, MAX_NAME_CODE_POINTS)));
const groupText = z
  .string()
  .check(z.refine((value) => isDisplayText(value, MAX_GROUP_CODE_POINTS)));

const slug = z.string().check(z.regex(PROJECT_SLUG_PATTERN));
const roleKey = z.string().check(z.regex(ROLE_KEY_PATTERN));
const sourceName = z.string().check(z.regex(/^[a-z0-9][a-z0-9._-]{0,63}$/));
const sourceSystem = z.string().check(z.regex(/^[a-z][a-z0-9-]{0,63}$/));
const versionText = z.string().check(z.regex(/^[0-9A-Za-z][0-9A-Za-z.+_~/-]{0,255}$/));

const ecosystem = z.enum(['composer', 'npm']);
const scope = z.enum(['organization', 'project']);
const basis = z.enum(['source_release', 'packagist_added', 'import_time']);
const sourceType = z.enum(SOURCE_TYPES);

const PUBLISHED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const publishedAt = z.string().check(
  z.regex(PUBLISHED_AT),
  z.refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && time >= 0 && new Date(time).toISOString() === value;
  }),
);

const projectRef = z.union([
  z.strictObject({ ref: externalRef }),
  z.strictObject({ existing: slug }),
]);
const roleRef = z.union([
  z.strictObject({ ref: externalRef }),
  z.strictObject({ existing: roleKey }),
]);
const sourceRef = z.union([
  z.strictObject({ ref: externalRef }),
  z.strictObject({
    existing: z.strictObject({ project: z.nullable(slug), name: sourceName }),
  }),
]);

const permissionName = z.string().check(z.maxLength(MAX_PERMISSION_LENGTH));

const projectItem = z.strictObject({
  type: z.literal('project'),
  external_ref: externalRef,
  slug,
  name: displayText,
});

const roleItem = z.strictObject({
  type: z.literal('role'),
  external_ref: externalRef,
  key: roleKey,
  name: displayText,
  scope,
  permissions: z.array(permissionName).check(z.minLength(1), z.maxLength(PERMISSIONS.length)),
});

const subject = z.union([
  z.strictObject({
    type: z.literal('email'),
    value: z.string().check(z.refine((value) => normalizeEmail(value) === value)),
  }),
  z.strictObject({
    type: z.literal('group'),
    provider: z.string().check(z.refine(isValidProviderId)),
    value: groupText,
  }),
]);

const grantItem = z.strictObject({
  type: z.literal('grant'),
  external_ref: externalRef,
  scope,
  project: z.nullable(projectRef),
  role: roleRef,
  subject,
});

const sourceItem = z.strictObject({
  type: z.literal('source'),
  external_ref: externalRef,
  name: sourceName,
  ecosystem,
  source_type: sourceType,
  project: z.nullable(projectRef),
  url: z.nullable(z.string()),
  credential_ref: z.nullable(credentialRef),
  config: sourceConfig,
});

const nameItem = z.strictObject({
  type: z.literal('name'),
  external_ref: externalRef,
  source: sourceRef,
  ecosystem,
  pattern: z.string().check(z.refine(isCanonicalPattern)),
});

const attachmentItem = z.strictObject({
  type: z.literal('attachment'),
  external_ref: externalRef,
  project: projectRef,
  source: sourceRef,
  precedence: z
    .number()
    .check(
      z.refine(
        (value) =>
          Number.isSafeInteger(value) &&
          !Object.is(value, -0) &&
          value >= 0 &&
          value <= MAX_PRECEDENCE,
      ),
    ),
});

const versionOverrideItem = z.strictObject({
  type: z.literal('version_override'),
  external_ref: externalRef,
  source: sourceRef,
  package: z.string().check(z.minLength(1), z.maxLength(MAX_PACKAGE_LENGTH)),
  version: versionText,
  published_at: publishedAt,
  basis,
});

const item = z.discriminatedUnion('type', [
  projectItem,
  roleItem,
  grantItem,
  sourceItem,
  nameItem,
  attachmentItem,
  versionOverrideItem,
]);

const wideningEntry = z.strictObject({ type: z.literal('grant'), external_ref: externalRef });

const envelope = z.strictObject({
  version: z.literal(1),
  source_system: sourceSystem,
  items: z.array(item).check(z.maxLength(MAX_MANIFEST_ITEMS)),
  widening: z.array(wideningEntry).check(z.maxLength(MAX_MANIFEST_ITEMS)),
});

type Shape = z.infer<typeof envelope>;
type Item = Shape['items'][number];
type RoleItem = Extract<Item, { type: 'role' }>;
type SourceItem = Extract<Item, { type: 'source' }>;
type ProjectRef = z.infer<typeof projectRef>;
type RoleRef = z.infer<typeof roleRef>;
type SourceRef = z.infer<typeof sourceRef>;

const PROXY_URL: Partial<Record<SourceItem['source_type'], string>> = {
  packagist_proxy: UPSTREAM_DEFAULTS.packagist.url,
  npmjs_proxy: UPSTREAM_DEFAULTS.npmjs.url,
};

type Refusal =
  | 'duplicate_ref'
  | 'duplicate_key'
  | 'unknown_reference'
  | 'shadowed_existing'
  | 'scope_mismatch'
  | 'ecosystem_mismatch'
  | 'invalid_url'
  | 'config_mismatch'
  | 'credential_mismatch'
  | 'reserved_role_key'
  | 'unknown_permission'
  | 'permission_scope'
  | 'reserved_provider'
  | 'invalid_pattern'
  | 'invalid_package'
  | 'owner_mismatch';

export type ManifestCode = ValidationCode | Refusal;

export interface ManifestDetail {
  readonly path: string;
  readonly code: ManifestCode;
}

type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export type Manifest = DeepReadonly<Shape>;

declare const manifestBrand: unique symbol;
export type ParsedManifest = Manifest & { readonly [manifestBrand]: true };

export type ManifestResult =
  | { readonly ok: true; readonly data: ParsedManifest }
  | { readonly ok: false; readonly details: readonly ManifestDetail[] };

const DEFAULT_ROLE_KEYS: ReadonlySet<string> = new Set(DEFAULT_ROLES.map(({ key }) => key));
const sep = '\u0000';

function keyOrNull(name: string, eco: 'composer' | 'npm'): string | null {
  try {
    return packageKey(name, { ecosystem: eco });
  } catch {
    return null;
  }
}

function consistencyIssues(manifest: Shape): ManifestDetail[] {
  const issues: ManifestDetail[] = [];
  const refuse = (path: string, code: Refusal): void => {
    if (issues.length < MAX_DETAILS) issues.push({ path, code });
  };
  const field = (index: number, name: string): string => `/items/${index}/${name}`;

  const checkSourceFields = (source: SourceItem, i: number): void => {
    const { source_type: type, url } = source;
    if (ECOSYSTEM_OF[type] !== source.ecosystem)
      refuse(field(i, 'ecosystem'), 'ecosystem_mismatch');
    const fixed = PROXY_URL[type];
    if (
      type === 'vcs'
        ? url !== null
        : fixed !== undefined
          ? url !== fixed
          : !(url !== null && isCanonicalUrl(url))
    ) {
      refuse(field(i, 'url'), 'invalid_url');
    }
    if (!isConfigOf(type, source.config)) {
      refuse(field(i, 'config'), 'config_mismatch');
      return;
    }
    const { config } = source;
    const hasCredential = source.credential_ref !== null;
    if (
      (type === 'npmjs_proxy' && hasCredential) ||
      (type === 'packagist_proxy' &&
        isPackagistConfig(config) &&
        config.githubToken !== hasCredential)
    ) {
      refuse(field(i, 'credential_ref'), 'credential_mismatch');
    }
  };

  const byRef = new Map<string, Item>();
  const naturalKeys = new Set<string>();
  const slugs = new Set<string>();
  const roleKeys = new Set<string>();
  const sourceKeys = new Set<string>();
  const indexed = (type: Item['type'], externalRefValue: string): Item | undefined =>
    byRef.get(`${type}${sep}${externalRefValue}`);
  const claim = (key: string, path: string): void => {
    if (naturalKeys.has(key)) refuse(path, 'duplicate_key');
    else naturalKeys.add(key);
  };

  manifest.items.forEach((entry, i) => {
    const key = `${entry.type}${sep}${entry.external_ref}`;
    if (byRef.has(key)) refuse(field(i, 'external_ref'), 'duplicate_ref');
    else byRef.set(key, entry);
  });

  const slugOf = (reference: ProjectRef): string | null => {
    if ('existing' in reference) return reference.existing;
    const found = indexed('project', reference.ref);
    return found?.type === 'project' ? found.slug : null;
  };
  const projectKey = (reference: ProjectRef | null): string | null =>
    reference === null ? '' : slugOf(reference);
  const sourceOf = (reference: SourceRef): SourceItem | 'existing' | null => {
    if ('existing' in reference) return 'existing';
    const found = indexed('source', reference.ref);
    return found?.type === 'source' ? found : null;
  };
  const sourceKey = (reference: SourceRef): string | null => {
    if ('existing' in reference) {
      return `${reference.existing.project ?? ''}${sep}${reference.existing.name}`;
    }
    const found = sourceOf(reference);
    if (found === null || found === 'existing') return null;
    const project = projectKey(found.project);
    return project === null ? null : `${project}${sep}${found.name}`;
  };
  const roleOf = (reference: RoleRef): RoleItem | 'existing' | null => {
    if ('existing' in reference) return 'existing';
    const found = indexed('role', reference.ref);
    return found?.type === 'role' ? found : null;
  };

  const checkSourceRef = (i: number, reference: SourceRef): SourceItem | 'existing' | null => {
    const source = sourceOf(reference);
    if (source === null) {
      refuse(field(i, 'source'), 'unknown_reference');
      return null;
    }
    if ('existing' in reference) {
      const { project } = reference.existing;
      const key = sourceKey(reference) ?? '';
      if ((project !== null && slugs.has(project)) || sourceKeys.has(key)) {
        refuse(field(i, 'source'), 'shadowed_existing');
        return null;
      }
    }
    return source;
  };

  manifest.items.forEach((entry, i) => {
    switch (entry.type) {
      case 'project':
        slugs.add(entry.slug);
        claim(`project${sep}${entry.slug}`, field(i, 'slug'));
        break;
      case 'role':
        if (DEFAULT_ROLE_KEYS.has(entry.key)) refuse(field(i, 'key'), 'reserved_role_key');
        if (new Set(entry.permissions).size !== entry.permissions.length) {
          refuse(field(i, 'permissions'), 'duplicate_key');
        } else if (!entry.permissions.every(isPermission)) {
          refuse(field(i, 'permissions'), 'unknown_permission');
        } else if (rolePermissionProblems(entry.scope, entry.permissions).length > 0) {
          refuse(field(i, 'permissions'), 'permission_scope');
        }
        roleKeys.add(entry.key);
        claim(`role${sep}${entry.key}`, field(i, 'key'));
        break;
      case 'source': {
        checkSourceFields(entry, i);
        const project = projectKey(entry.project);
        if (project === null) {
          refuse(field(i, 'project'), 'unknown_reference');
          break;
        }
        sourceKeys.add(`${project}${sep}${entry.name}`);
        claim(`source${sep}${project}${sep}${entry.name}`, field(i, 'name'));
        break;
      }
      default:
        break;
    }
  });

  manifest.items.forEach((entry, i) => {
    switch (entry.type) {
      case 'source':
        if (
          entry.project !== null &&
          'existing' in entry.project &&
          slugs.has(entry.project.existing)
        ) {
          refuse(field(i, 'project'), 'shadowed_existing');
        }
        break;
      case 'grant': {
        if ((entry.scope === 'organization') !== (entry.project === null)) {
          refuse(field(i, 'project'), 'scope_mismatch');
        }
        const project = projectKey(entry.project);
        if (project === null) refuse(field(i, 'project'), 'unknown_reference');
        else if (
          entry.project !== null &&
          'existing' in entry.project &&
          slugs.has(entry.project.existing)
        ) {
          refuse(field(i, 'project'), 'shadowed_existing');
        }
        const role = roleOf(entry.role);
        if (role === null) refuse(field(i, 'role'), 'unknown_reference');
        else if (role === 'existing') {
          if (roleKeys.has((entry.role as { existing: string }).existing)) {
            refuse(field(i, 'role'), 'shadowed_existing');
          }
        } else if (role.scope !== entry.scope) refuse(field(i, 'role'), 'scope_mismatch');
        if (entry.subject.type === 'group' && isReservedProviderId(entry.subject.provider)) {
          refuse(`${field(i, 'subject')}/provider`, 'reserved_provider');
        }
        const who =
          entry.subject.type === 'email'
            ? `email${sep}${entry.subject.value}`
            : `group${sep}${entry.subject.provider}${sep}${entry.subject.value}`;
        if (project !== null) {
          claim(`grant${sep}${entry.scope}${sep}${project}${sep}${who}`, field(i, 'subject'));
        }
        break;
      }
      case 'name': {
        const source = checkSourceRef(i, entry.source);
        if (source !== null && source !== 'existing' && source.ecosystem !== entry.ecosystem) {
          refuse(field(i, 'ecosystem'), 'ecosystem_mismatch');
        }
        const { pattern } = entry;
        const wildcard = pattern.includes('*');
        if (
          (entry.ecosystem === 'composer' && pattern.startsWith('@')) ||
          (!wildcard && keyOrNull(pattern, entry.ecosystem) !== pattern)
        ) {
          refuse(field(i, 'pattern'), 'invalid_pattern');
        }
        claim(`name${sep}${entry.ecosystem}${sep}${pattern}`, field(i, 'pattern'));
        break;
      }
      case 'attachment': {
        const project = slugOf(entry.project);
        if (project === null) refuse(field(i, 'project'), 'unknown_reference');
        else if ('existing' in entry.project && slugs.has(project)) {
          refuse(field(i, 'project'), 'shadowed_existing');
        }
        const source = checkSourceRef(i, entry.source);
        const key = sourceKey(entry.source);
        if (project === null || source === null || key === null) break;
        const owner = key.split(sep)[0] ?? '';
        if (owner !== '' && owner !== project) refuse(field(i, 'source'), 'owner_mismatch');
        claim(`attachment${sep}${project}${sep}${key}`, field(i, 'source'));
        break;
      }
      case 'version_override': {
        const source = checkSourceRef(i, entry.source);
        const key = sourceKey(entry.source);
        if (source === null || key === null) break;
        const ecosystems =
          source === 'existing' ? (['composer', 'npm'] as const) : [source.ecosystem];
        if (!ecosystems.some((eco) => keyOrNull(entry.package, eco) === entry.package)) {
          refuse(field(i, 'package'), 'invalid_package');
        }
        claim(
          `version_override${sep}${key}${sep}${entry.package}${sep}${entry.version}`,
          field(i, 'version'),
        );
        break;
      }
      default:
        break;
    }
  });

  const listed = new Set<string>();
  manifest.widening.forEach((entry, j) => {
    const key = `grant${sep}${entry.external_ref}`;
    const path = `/widening/${j}/external_ref`;
    if (!byRef.has(key)) refuse(path, 'unknown_reference');
    else if (listed.has(key)) refuse(path, 'duplicate_ref');
    else listed.add(key);
  });
  return issues;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value as DeepReadonly<T>;
}

export function parseManifest(input: unknown): ManifestResult {
  const result = validateInput(envelope, input);
  if (!result.ok) return result;
  const issues = consistencyIssues(result.data);
  if (issues.length > 0) return { ok: false, details: issues };
  return { ok: true, data: deepFreeze(result.data) as ParsedManifest };
}

function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort(compareCodeUnits)) {
    sorted[key] = sortKeys(record[key]);
  }
  return sorted;
}

type ParsedItem = Manifest['items'][number];

function byTypeAndRef(
  a: ParsedItem | Manifest['widening'][number],
  b: ParsedItem | Manifest['widening'][number],
): number {
  return compareCodeUnits(a.type, b.type) || compareCodeUnits(a.external_ref, b.external_ref);
}

function withSortedSets(entry: ParsedItem): ParsedItem {
  if (entry.type === 'role') {
    return { ...entry, permissions: [...entry.permissions].sort(compareCodeUnits) };
  }
  return entry.type === 'source' ? { ...entry, config: sortConfigLists(entry.config) } : entry;
}

export function canonicalManifest(manifest: ParsedManifest): string {
  return JSON.stringify(
    sortKeys({
      version: manifest.version,
      source_system: manifest.source_system,
      items: manifest.items.map(withSortedSets).sort(byTypeAndRef),
      widening: [...manifest.widening].sort(byTypeAndRef),
    }),
  );
}

export async function planHash(manifest: ParsedManifest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalManifest(manifest));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
