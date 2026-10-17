export type DbErrorKind =
  'unique' | 'foreign_key' | 'not_null' | 'check' | 'busy' | 'too_big' | 'unknown';

/** UNIQUE constraint raised by every access_mutation_guard insert: fence guards, assertCheck postconditions and the cache epoch bump check. */
export const ACCESS_MUTATION_GUARD_CONSTRAINT = 'access_mutation_guard.key';

export interface DbErrorOptions {
  readonly cause?: unknown;
  readonly constraint?: string | undefined;
}

interface Marker {
  readonly kind: DbErrorKind;
  readonly text: string;
  readonly namesConstraint: boolean;
}

const MARKERS: readonly Marker[] = [
  { kind: 'unique', text: 'UNIQUE constraint failed:', namesConstraint: true },
  { kind: 'foreign_key', text: 'FOREIGN KEY constraint failed', namesConstraint: false },
  { kind: 'not_null', text: 'NOT NULL constraint failed:', namesConstraint: true },
  { kind: 'check', text: 'CHECK constraint failed', namesConstraint: false },
  { kind: 'busy', text: 'SQLITE_BUSY', namesConstraint: false },
  { kind: 'busy', text: 'database is locked', namesConstraint: false },
  { kind: 'too_big', text: 'too many SQL variables', namesConstraint: false },
  { kind: 'too_big', text: 'SQLITE_TOOBIG', namesConstraint: false },
  { kind: 'too_big', text: 'string or blob too big', namesConstraint: false },
];

export class DbError extends Error {
  readonly kind: DbErrorKind;
  readonly constraint: string | undefined;

  constructor(kind: DbErrorKind, message: string, options: DbErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = 'DbError';
    this.kind = kind;
    this.constraint = options.constraint;
  }
}

function readProperty(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

function readMessage(value: unknown): string | undefined {
  const message = readProperty(value, 'message');
  return typeof message === 'string' ? message : undefined;
}

function originalMessage(error: unknown): string {
  return readMessage(error) ?? String(error);
}

function match(text: string | undefined): Marker | undefined {
  if (text === undefined) return undefined;
  return MARKERS.find((marker) => text.includes(marker.text));
}

function constraintOf(text: string, marker: Marker): string {
  const rest = text.slice(text.indexOf(marker.text) + marker.text.length).trim();
  const ends = [rest.indexOf(': '), rest.indexOf(' [')].filter((index) => index >= 0);
  return rest.slice(0, ends.length === 0 ? rest.length : Math.min(...ends)).trim();
}

export function classifySqliteError(error: unknown): DbError {
  if (error instanceof DbError) return error;
  if (!(error instanceof Error)) {
    return new DbError('unknown', `unknown: ${originalMessage(error)}`, { cause: error });
  }

  const ownMessage = readMessage(error);
  const causeMessage = readMessage(readProperty(error, 'cause'));
  const ownMarker = match(ownMessage);
  const marker = ownMarker ?? match(causeMessage);
  const kind = marker?.kind ?? 'unknown';
  const constraintText = ownMarker === undefined ? causeMessage : ownMessage;
  const constraint =
    marker?.namesConstraint === true && constraintText !== undefined
      ? constraintOf(constraintText, marker)
      : undefined;

  return new DbError(kind, `${kind}: ${originalMessage(error)}`, { cause: error, constraint });
}
