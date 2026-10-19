export const UPSTREAM_FORMS = [
  'composer-p2',
  'composer-p2-dev',
  'composer-v1-provider',
  'npm-packument',
] as const;

export type UpstreamForm = (typeof UPSTREAM_FORMS)[number];

export type PendingValidators = {
  readonly [form in UpstreamForm]?: {
    readonly etag: string | null;
    readonly lastModified: string | null;
    readonly contentSha256: string | null;
  };
};

const SHA256 = /^[0-9a-f]{64}$/;
const MAX_VALIDATOR_LENGTH = 1024;
const hasControl = (value: string): boolean =>
  [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });

export function assertHeaderValue(name: string, value: string | null): void {
  if (value !== null && (value.length > MAX_VALIDATOR_LENGTH || hasControl(value))) {
    throw new TypeError(
      `${name} must be at most ${MAX_VALIDATOR_LENGTH} characters without control characters`,
    );
  }
}

function nullableText(field: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string or null`);
  return value;
}

export function parsePendingValidators(value: unknown): PendingValidators {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RangeError('pending validators must be a plain object');
  }
  const result: Partial<Record<UpstreamForm, NonNullable<PendingValidators[UpstreamForm]>>> = {};
  for (const [form, raw] of Object.entries(value)) {
    if (!UPSTREAM_FORMS.includes(form as UpstreamForm))
      throw new RangeError('unknown upstream form');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError('pending validators must map each form to an object');
    }
    const entry = raw as Record<string, unknown>;
    const etag = nullableText('etag', entry['etag']);
    const lastModified = nullableText('lastModified', entry['lastModified']);
    const contentSha256 = nullableText('contentSha256', entry['contentSha256']);
    assertHeaderValue('etag', etag);
    assertHeaderValue('lastModified', lastModified);
    if (contentSha256 !== null && (contentSha256.length !== 64 || !SHA256.test(contentSha256))) {
      throw new TypeError('contentSha256 must be 64 lowercase hex characters');
    }
    result[form as UpstreamForm] = { etag, lastModified, contentSha256 };
  }
  return result;
}
