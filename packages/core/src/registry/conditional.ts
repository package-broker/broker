import { sha256Hex } from '../auth/primitives.js';
import type { CatalogueDocKind, ResolvedPackage } from '../db/catalogue.js';
import type { OrgContext } from '../db/port.js';

export type ComposerForm = 'composer-p2' | 'composer-p2-dev';
export type NpmForm = Exclude<CatalogueDocKind, ComposerForm>;

export interface ClockAdvance {
  readonly projectId: string;
  readonly keyHash: string;
  readonly form: ComposerForm;
  readonly validator: string;
}

export interface ClockReading {
  readonly validator: string;
  /** `YYYY-MM-DDTHH:MM:SSZ`, whole seconds. */
  readonly lastModified: string;
}

export interface RepresentationClock {
  advance(ctx: OrgContext, input: ClockAdvance): Promise<ClockReading>;
}

export interface Validators {
  readonly lastModified?: string;
  readonly etag?: string;
}

export interface RenderEmbedded {
  readonly projectSlug: string;
  /** Absolute origin the renderer writes into URLs, or null when it writes relative paths. */
  readonly origin: string | null;
}

export interface ConditionalRequest {
  readonly method: string;
  readonly headers: Headers;
}

export async function representationValidator(
  pkg: ResolvedPackage,
  form: CatalogueDocKind,
  renderVersion: number,
  embedded: RenderEmbedded,
): Promise<string> {
  if (!Number.isSafeInteger(renderVersion) || renderVersion < 0) {
    throw new RangeError('renderVersion must be a non-negative integer');
  }
  if (typeof embedded.projectSlug !== 'string' || embedded.projectSlug === '') {
    throw new TypeError('projectSlug must be a non-empty string');
  }
  return sha256Hex(
    JSON.stringify([
      'pb-representation',
      1,
      pkg.projectId,
      pkg.packageId,
      pkg.rev,
      form,
      pkg.cacheEpoch,
      renderVersion,
      embedded.projectSlug,
      embedded.origin,
    ]),
  );
}

export async function composerValidators(
  clock: RepresentationClock,
  ctx: OrgContext,
  pkg: ResolvedPackage,
  form: ComposerForm,
  renderVersion: number,
  embedded: RenderEmbedded,
): Promise<{ lastModified: string }> {
  const validator = await representationValidator(pkg, form, renderVersion, embedded);
  const keyHash = await sha256Hex(JSON.stringify([pkg.ecosystem, pkg.key]));
  const reading = await clock.advance(ctx, { projectId: pkg.projectId, keyHash, form, validator });
  if (reading.validator !== validator) {
    throw new Error('representation clock returned a different validator');
  }
  const at = Date.parse(reading.lastModified);
  if (!Number.isFinite(at)) throw new Error('representation clock returned an invalid time');
  return { lastModified: new Date(at).toUTCString() };
}

export async function npmValidators(
  pkg: ResolvedPackage,
  form: NpmForm,
  renderVersion: number,
  embedded: RenderEmbedded,
): Promise<{ etag: string }> {
  const validator = await representationValidator(pkg, form, renderVersion, embedded);
  return { etag: `W/"${validator.slice(0, 16)}"` };
}

const ENTITY_TAG = /^(?:W\/)?"([\x21\x23-\x7e\x80-\xff]*)"$/;
const LIST_ITEM = /[ \t]*(?:W\/)?"([\x21\x23-\x7e\x80-\xff]*)"[ \t]*(,|$)/y;
const EMPTY_ITEM = /[ \t]*,/y;

function opaque(tag: string): string | null {
  return ENTITY_TAG.exec(tag)?.[1] ?? null;
}

function entityTags(header: string): string[] | null {
  const item = new RegExp(LIST_ITEM);
  const empty = new RegExp(EMPTY_ITEM);
  const tags: string[] = [];
  let at = 0;
  while (at < header.length) {
    empty.lastIndex = at;
    if (empty.test(header)) {
      at = empty.lastIndex;
      continue;
    }
    item.lastIndex = at;
    const match = item.exec(header);
    if (match === null) return null;
    tags.push(match[1] ?? '');
    if (match[2] === '') break;
    at = item.lastIndex;
  }
  return tags;
}

function noneMatch(header: string, etag: string | undefined): boolean {
  if (header.trim() === '*') return true;
  if (etag === undefined) return false;
  const current = opaque(etag);
  if (current === null) return false;
  return entityTags(header)?.includes(current) ?? false;
}

export function isNotModified(request: ConditionalRequest, validators: Validators): boolean {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch !== null) return noneMatch(ifNoneMatch, validators.etag);
  const ifModifiedSince = request.headers.get('If-Modified-Since');
  return (
    ifModifiedSince !== null &&
    validators.lastModified !== undefined &&
    ifModifiedSince === validators.lastModified
  );
}

export function validatorHeaders(validators: Validators): Record<string, string> {
  const headers: Record<string, string> = {};
  if (validators.lastModified !== undefined) headers['Last-Modified'] = validators.lastModified;
  if (validators.etag !== undefined) headers.ETag = validators.etag;
  return headers;
}

export function notModifiedResponse(
  validators: Validators,
  vary: string,
  extra: Readonly<Record<string, string>> = {},
): Response {
  const headers = new Headers(extra);
  for (const name of ['ETag', 'Last-Modified', 'Vary']) headers.delete(name);
  for (const [name, value] of Object.entries(validatorHeaders(validators)))
    headers.set(name, value);
  headers.set('Vary', vary);
  return new Response(null, { status: 304, headers });
}
