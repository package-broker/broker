export const NPM_AUDIT_ADVISORY_FIELDS = [
  'id',
  'url',
  'title',
  'severity',
  'vulnerable_versions',
  'cwe',
  'cvss',
] as const;

export const NPM_AUDIT_ADVISORIES_MAX = 200;

const ID_MAX = 200;
const URL_MAX = 2048;
const TITLE_MAX = 1024;
const SEVERITY_MAX = 32;
const RANGE_MAX = 1024;
const CWE_COUNT_MAX = 20;
const CWE_MAX = 32;
const VECTOR_MAX = 256;
const SEVERITIES: ReadonlySet<string> = new Set(['info', 'low', 'moderate', 'high', 'critical']);

export interface NpmAuditCvss {
  readonly score: number;
  readonly vectorString?: string;
}

export interface NpmAuditAdvisory {
  readonly id: number | string;
  readonly url?: string;
  readonly title?: string;
  readonly severity?: string;
  readonly vulnerable_versions?: string;
  readonly cwe?: readonly string[];
  readonly cvss?: NpmAuditCvss;
}

export interface SanitizedNpmAudit {
  readonly body: Record<string, NpmAuditAdvisory[]>;
  readonly unexpectedKeys: number;
  readonly droppedAdvisories: number;
}

class Malformed extends Error {}

const encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, max: number): string {
  if (typeof value !== 'string' || encoder.encode(value).byteLength > max) throw new Malformed();
  return value;
}

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string') throw new Malformed();
  let clean = '';
  for (const char of value) {
    if (!isControl(char.codePointAt(0)!)) clean += char;
  }
  return boundedString(clean, max);
}

function optional<T>(
  source: Record<string, unknown>,
  field: string,
  read: (value: unknown) => T | undefined,
): Record<string, T> {
  const value = source[field];
  if (!Object.hasOwn(source, field) || value === null) return {};
  const result = read(value);
  return result === undefined ? {} : { [field]: result };
}

function advisoryId(value: unknown): number | string {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Malformed();
    return value;
  }
  const id = text(value, ID_MAX);
  if (id === '') throw new Malformed();
  return id;
}

function httpsUrl(value: unknown): string {
  const raw = boundedString(value, URL_MAX);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Malformed();
  }
  return boundedString(url.href, URL_MAX);
}

function cwe(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > CWE_COUNT_MAX) throw new Malformed();
  return value.map((entry) => text(entry, CWE_MAX));
}

function cvss(value: unknown): NpmAuditCvss | undefined {
  if (!isRecord(value)) throw new Malformed();
  const vector = optional(value, 'vectorString', (raw) => text(raw, VECTOR_MAX));
  const { score } = value;
  if (score === null || score === undefined) return undefined;
  if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 10) {
    throw new Malformed();
  }
  return { score, ...vector };
}

function advisory(value: unknown): NpmAuditAdvisory | undefined {
  if (!isRecord(value)) throw new Malformed();
  const severity = optional(value, 'severity', (raw) =>
    boundedString(raw, SEVERITY_MAX) === '' ? undefined : (raw as string),
  );
  const rebuilt: NpmAuditAdvisory = {
    id: advisoryId(value.id),
    ...optional(value, 'url', httpsUrl),
    ...optional(value, 'title', (raw) => text(raw, TITLE_MAX)),
    ...severity,
    ...optional(value, 'vulnerable_versions', (raw) => text(raw, RANGE_MAX)),
    ...optional(value, 'cwe', cwe),
    ...optional(value, 'cvss', cvss),
  };
  if (severity.severity !== undefined && !SEVERITIES.has(severity.severity)) return undefined;
  return rebuilt;
}

export function sanitizeNpmAuditResponse(
  bytes: Uint8Array,
  sentNames: ReadonlySet<string>,
): SanitizedNpmAudit | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) return null;
    const body: Record<string, NpmAuditAdvisory[]> = Object.create(null);
    let unexpectedKeys = 0;
    let droppedAdvisories = 0;
    for (const [name, advisories] of Object.entries(parsed)) {
      if (!sentNames.has(name)) {
        unexpectedKeys++;
        continue;
      }
      if (!Array.isArray(advisories) || advisories.length > NPM_AUDIT_ADVISORIES_MAX) {
        return null;
      }
      const kept: NpmAuditAdvisory[] = [];
      for (const entry of advisories) {
        const rebuilt = advisory(entry);
        if (rebuilt === undefined) droppedAdvisories++;
        else kept.push(rebuilt);
      }
      body[name] = kept;
    }
    return { body, unexpectedKeys, droppedAdvisories };
  } catch {
    return null;
  }
}
