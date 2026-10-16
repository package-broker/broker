import { ORG_SLUG_PATTERN } from '../db/organization.js';
import type { Registration } from '../kernel/registry.js';

export const PROJECT_SLUG_PATTERN = ORG_SLUG_PATTERN;

const ALWAYS_RESERVED = [
  'health',
  '_pb',
  'auth',
  'setup',
  'callback',
  'login',
  '.well-known',
] as const;
const UNICODE_SPACE = /\s/;
const ENCODED_UNSAFE = /%(?:5c|0[0-9a-f]|1[0-9a-f]|7f)/i;
const ENCODED_DOT = /%2e/gi;
const FAMILIES: ReadonlySet<string> = new Set(['p2', 'dist', 'npm']);
const API_PREFIX = ['_pb', 'projects'] as const;

export type ProjectPathFamily = 'packages.json' | 'p2' | 'dist' | 'npm' | 'api';

export type ProjectPathResolution =
  | {
      readonly ok: true;
      readonly slug: string;
      readonly family: ProjectPathFamily;
      readonly rest: readonly string[];
    }
  | { readonly ok: false };

const REFUSED: ProjectPathResolution = Object.freeze({ ok: false });

export function isValidProjectSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && PROJECT_SLUG_PATTERN.test(slug);
}

export function reservedFirstSegments(
  routes: Iterable<Pick<Registration['routes'][number], 'path'>>,
): ReadonlySet<string> {
  const reserved = new Set<string>(ALWAYS_RESERVED);
  for (const route of routes) {
    const first = route.path.split('/')[1];
    if (first !== undefined && first !== '' && !first.startsWith(':')) {
      reserved.add(first.toLowerCase());
    }
  }
  return reserved;
}

export function projectSlugProblem(slug: unknown, reserved: ReadonlySet<string>): string | null {
  if (!isValidProjectSlug(slug)) {
    return 'project slug must be 1-64 lowercase ASCII letters, digits or hyphens, starting and ending alphanumeric';
  }
  if (reserved.has(slug)) return `project slug "${slug}" is reserved for a route`;
  return null;
}

export function pluginPrefixProblem(prefix: string, slugs: ReadonlySet<string>): string | null {
  if (typeof prefix !== 'string' || !prefix.startsWith('/')) {
    return `route prefix ${JSON.stringify(prefix)} must start with "/"`;
  }
  const raw = prefix.split('/')[1] ?? '';
  if (raw.startsWith(':')) return `route prefix "${prefix}" must not start with a parameter`;
  const first = raw.toLowerCase();
  for (const slug of slugs) {
    if (slug.toLowerCase() === first) {
      return `route prefix "${prefix}" collides with project slug "${slug}"`;
    }
  }
  return null;
}

function hasUnsafeCharacter(segment: string): boolean {
  for (let i = 0; i < segment.length; i++) {
    const code = segment.charCodeAt(i);
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0x5c) return true;
  }
  return UNICODE_SPACE.test(segment);
}

function restIsSafe(rest: readonly string[]): boolean {
  return rest.every((segment) => {
    if (segment === '') return false;
    const decodedDots = segment.replace(ENCODED_DOT, '.');
    if (decodedDots === '.' || decodedDots === '..') return false;
    return !hasUnsafeCharacter(segment) && !ENCODED_UNSAFE.test(segment);
  });
}

export function resolveProjectPath(
  rawPathname: string | URL,
  reserved: ReadonlySet<string>,
): ProjectPathResolution {
  const path = rawPathname instanceof URL ? rawPathname.pathname : rawPathname;
  if (typeof path !== 'string' || !path.startsWith('/') || /[?#]/.test(path)) return REFUSED;
  const segments = path.slice(1).split('/');

  let slug: string | undefined;
  let family: ProjectPathFamily;
  let rest: string[];

  if (segments[0] === API_PREFIX[0]) {
    if (segments[1] !== API_PREFIX[1]) return REFUSED;
    slug = segments[2];
    family = 'api';
    rest = segments.slice(3);
  } else {
    slug = segments[0];
    const name = segments[1];
    if (name === 'packages.json') {
      if (segments.length !== 2) return REFUSED;
      family = 'packages.json';
    } else if (name !== undefined && FAMILIES.has(name)) {
      family = name as ProjectPathFamily;
      if (segments.length < 3) return REFUSED;
    } else {
      return REFUSED;
    }
    rest = segments.slice(2);
  }

  if (!isValidProjectSlug(slug) || reserved.has(slug)) return REFUSED;
  if (!restIsSafe(rest)) return REFUSED;
  return { ok: true, slug, family, rest };
}
