import * as z from 'zod/mini';
import { validateInput, type ValidationResult } from '../api/validate.js';
import {
  DEFAULT_ROLES,
  PERMISSIONS,
  isPermission,
  rolePermissionProblems,
} from '../authz/permissions.js';
import { PROJECT_SLUG_PATTERN } from '../authz/project-path.js';
import { packageKey } from '../catalogue/names.js';
import { isValidPattern } from '../catalogue/patterns.js';
import { ROLE_KEY_PATTERN } from '../db/roles.js';
import { normalizeEmail } from '../identity/policy.js';
import { isValidProviderId } from '../identity/port.js';
import { UPSTREAM_DEFAULTS } from '../sources/config.js';

export const MAX_MANIFEST_ITEMS = 10000;
export const MAX_MANIFEST_BYTES = 1048576;

const MAX_URL_LENGTH = 2048;
const MAX_NAME_CODE_POINTS = 100;
const MAX_GROUP_CODE_POINTS = 256;
const MAX_PRECEDENCE = 100000;
const MAX_PERMISSION_LENGTH = 100;
const MAX_PACKAGE_LENGTH = 428;

const externalRef = z.string().check(z.regex(/^[A-Za-z0-9._:/-]{1,200}$/));
const credentialRef = z.string().check(z.regex(/^op:\/\/[A-Za-z0-9 ._/-]{1,200}$/));

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
const sourceType = z.enum([
  'vcs',
  'composer_repository',
  'npm_registry',
  'packagist_proxy',
  'npmjs_proxy',
]);

const PUBLISHED_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const publishedAt = z.string().check(
  z.regex(PUBLISHED_AT),
  z.refine((value) => {
    const time = Date.parse(value);
    return Number.isFinite(time) && time >= 0 && new Date(time).toISOString() === value;
  }),
);

const LOWERCASE_ESCAPE = /%(?:[a-f]|[0-9A-F][a-f])/;
const ESCAPE = /%([0-9A-Fa-f]{2})/g;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

function isCanonicalUrl(value: string): boolean {
  if (value.length > MAX_URL_LENGTH || /[?#]/.test(value) || LOWERCASE_ESCAPE.test(value)) {
    return false;
  }
  for (const match of value.matchAll(ESCAPE)) {
    if (UNRESERVED.test(String.fromCharCode(Number.parseInt(match[1] ?? '', 16)))) return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || url.protocol === 'http:') &&
    url.username === '' &&
    url.password === '' &&
    !url.hostname.endsWith('.') &&
    url.href === value
  );
}

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
  config: z.null(),
});

const nameItem = z.strictObject({
  type: z.literal('name'),
  external_ref: externalRef,
  source: sourceRef,
  ecosystem,
  pattern: z.string().check(z.refine(isValidPattern)),
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
type ProjectItem = Extract<Item, { type: 'project' }>;
type RoleItem = Extract<Item, { type: 'role' }>;
type SourceItem = Extract<Item, { type: 'source' }>;
type ProjectRef = z.infer<typeof projectRef>;
type RoleRef = z.infer<typeof roleRef>;
type SourceRef = z.infer<typeof sourceRef>;

const ECOSYSTEM_OF: Readonly<Record<SourceItem['source_type'], 'composer' | 'npm'>> = {
  vcs: 'composer',
  composer_repository: 'composer',
  packagist_proxy: 'composer',
  npm_registry: 'npm',
  npmjs_proxy: 'npm',
};

const PROXY_URL: Partial<Record<SourceItem['source_type'], string>> = {
  packagist_proxy: UPSTREAM_DEFAULTS.packagist.url,
  npmjs_proxy: UPSTREAM_DEFAULTS.npmjs.url,
};

const DEFAULT_ROLE_KEYS: ReadonlySet<string> = new Set(DEFAULT_ROLES.map(({ key }) => key));

function isSourceFieldsValid(source: SourceItem): boolean {
  if (ECOSYSTEM_OF[source.source_type] !== source.ecosystem) return false;
  const { source_type: type, url } = source;
  if (type === 'vcs') return url === null;
  const fixed = PROXY_URL[type];
  if (fixed !== undefined) return url === fixed;
  return url !== null && isCanonicalUrl(url);
}

function isRoleFieldsValid(role: RoleItem): boolean {
  if (DEFAULT_ROLE_KEYS.has(role.key)) return false;
  if (!role.permissions.every(isPermission)) return false;
  return rolePermissionProblems(role.scope, role.permissions).length === 0;
}

function isNameFieldsValid(pattern: string, name: Extract<Item, { type: 'name' }>): boolean {
  if (pattern.includes('*')) return true;
  return keyOrNull(pattern, name.ecosystem) === pattern;
}

function keyOrNull(name: string, eco: 'composer' | 'npm'): string | null {
  try {
    return packageKey(name, { ecosystem: eco });
  } catch {
    return null;
  }
}

const sep = '\u0000';

function isConsistent(manifest: Shape): boolean {
  const byRef = new Map<string, Item>();
  const naturalKeys = new Set<string>();
  const indexed = (type: Item['type'], externalRefValue: string): Item | undefined =>
    byRef.get(`${type}${sep}${externalRefValue}`);

  for (const entry of manifest.items) {
    const key = `${entry.type}${sep}${entry.external_ref}`;
    if (byRef.has(key)) return false;
    byRef.set(key, entry);
  }

  const slugOf = (reference: ProjectRef): string | null => {
    if ('existing' in reference) return reference.existing;
    const found = indexed('project', reference.ref);
    return found?.type === 'project' ? (found as ProjectItem).slug : null;
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

  const slugs = new Set<string>();
  const roleKeys = new Set<string>();
  const sourceKeys = new Set<string>();
  const claim = (key: string): boolean => {
    if (naturalKeys.has(key)) return false;
    naturalKeys.add(key);
    return true;
  };

  for (const entry of manifest.items) {
    switch (entry.type) {
      case 'project':
        slugs.add(entry.slug);
        if (!claim(`project${sep}${entry.slug}`)) return false;
        break;
      case 'role':
        if (!isRoleFieldsValid(entry)) return false;
        roleKeys.add(entry.key);
        if (!claim(`role${sep}${entry.key}`)) return false;
        break;
      case 'source': {
        if (!isSourceFieldsValid(entry)) return false;
        const project = projectKey(entry.project);
        if (project === null) return false;
        sourceKeys.add(`${project}${sep}${entry.name}`);
        if (!claim(`source${sep}${project}${sep}${entry.name}`)) return false;
        break;
      }
      default:
        break;
    }
  }

  for (const entry of manifest.items) {
    switch (entry.type) {
      case 'grant': {
        if ((entry.scope === 'organization') !== (entry.project === null)) return false;
        const project = projectKey(entry.project);
        if (project === null) return false;
        if (
          entry.project !== null &&
          'existing' in entry.project &&
          slugs.has(entry.project.existing)
        ) {
          return false;
        }
        const role = roleOf(entry.role);
        if (role === null) return false;
        if (role === 'existing') {
          if (roleKeys.has((entry.role as { existing: string }).existing)) return false;
        } else if (role.scope !== entry.scope) return false;
        const who =
          entry.subject.type === 'email'
            ? `email${sep}${entry.subject.value}`
            : `group${sep}${entry.subject.provider}${sep}${entry.subject.value}`;
        if (!claim(`grant${sep}${entry.scope}${sep}${project}${sep}${who}`)) return false;
        break;
      }
      case 'source':
        if (
          entry.project !== null &&
          'existing' in entry.project &&
          slugs.has(entry.project.existing)
        ) {
          return false;
        }
        break;
      case 'name': {
        const source = sourceOf(entry.source);
        if (source === null) return false;
        if (source !== 'existing' && source.ecosystem !== entry.ecosystem) return false;
        if ('existing' in entry.source && sourceKeys.has(sourceKey(entry.source) ?? ''))
          return false;
        if (!isNameFieldsValid(entry.pattern, entry)) return false;
        if (!claim(`name${sep}${entry.ecosystem}${sep}${entry.pattern}`)) return false;
        break;
      }
      case 'attachment': {
        const project = slugOf(entry.project);
        const source = sourceOf(entry.source);
        const key = sourceKey(entry.source);
        if (project === null || source === null || key === null) return false;
        if ('existing' in entry.project && slugs.has(entry.project.existing)) return false;
        if ('existing' in entry.source && sourceKeys.has(key)) return false;
        const owner = key.split(sep)[0] ?? '';
        if (owner !== '' && owner !== project) return false;
        if (!claim(`attachment${sep}${project}${sep}${key}`)) return false;
        break;
      }
      case 'version_override': {
        const source = sourceOf(entry.source);
        const key = sourceKey(entry.source);
        if (source === null || key === null) return false;
        if ('existing' in entry.source && sourceKeys.has(key)) return false;
        const ecosystems =
          source === 'existing' ? (['composer', 'npm'] as const) : [source.ecosystem];
        if (!ecosystems.some((eco) => keyOrNull(entry.package, eco) === entry.package))
          return false;
        if (!claim(`version_override${sep}${key}${sep}${entry.package}${sep}${entry.version}`)) {
          return false;
        }
        break;
      }
      default:
        break;
    }
  }

  const listed = new Set<string>();
  for (const entry of manifest.widening) {
    const key = `grant${sep}${entry.external_ref}`;
    if (!byRef.has(key) || listed.has(key)) return false;
    listed.add(key);
  }
  return true;
}

export const manifestSchema = envelope.check(z.refine(isConsistent));

export type Manifest = z.infer<typeof manifestSchema>;

declare const manifestBrand: unique symbol;
export type ParsedManifest = Manifest & { readonly [manifestBrand]: true };

export function parseManifest(input: unknown): ValidationResult<ParsedManifest> {
  const result = validateInput(manifestSchema, input);
  return result.ok ? { ok: true, data: result.data as ParsedManifest } : result;
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

function byTypeAndRef(a: Item | Shape['widening'][number], b: typeof a): number {
  return compareCodeUnits(a.type, b.type) || compareCodeUnits(a.external_ref, b.external_ref);
}

function withSortedPermissions(entry: Item): Item {
  return entry.type === 'role'
    ? { ...entry, permissions: [...entry.permissions].sort(compareCodeUnits) }
    : entry;
}

export function canonicalManifest(manifest: ParsedManifest): string {
  return JSON.stringify(
    sortKeys({
      version: manifest.version,
      source_system: manifest.source_system,
      items: manifest.items.map(withSortedPermissions).sort(byTypeAndRef),
      widening: [...manifest.widening].sort(byTypeAndRef),
    }),
  );
}

export async function planHash(manifest: ParsedManifest): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalManifest(manifest));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
