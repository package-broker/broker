/**
 * The only names that may leave the process in a log line. A name outside this set is replaced by
 * "Error" so that plugin-supplied text can never travel further.
 */
const REPORTABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'DOMException',
  'AbortError',
  'TimeoutError',
  'NonError',
  'NotBootstrappedError',
  'KernelConfigError',
  'SecretsConfigError',
  'DbError',
  'CsrfError',
  'CredentialNotFoundError',
  'UnknownKeyVersionError',
  'SecretDecryptError',
  'HookTimeoutError',
  'EngineTimeoutError',
  'ProbeFailedError',
  'ReadinessTimeoutError',
  'BadBodyError',
  'OidcProviderError',
  'JwtError',
  'BoundedFetchError',
  'AlreadyBootstrappedError',
  'StartupConfigError',
  'SqlScanError',
  'MigrationSourceError',
  'MigrationLockedError',
  'MigrationSyntaxError',
  'MigrationChecksumError',
  'MigrationApplyError',
  'MigrationOrderError',
  'MigrationStateError',
  'BuiltManifestError',
  'JobError',
  'JsonStreamError',
]);

const MAX_PROTOTYPE_STEPS = 32;

const domExceptionNameGetter: (() => unknown) | null =
  typeof DOMException === 'function'
    ? (Object.getOwnPropertyDescriptor(DOMException.prototype, 'name')?.get ?? null)
    : null;

/**
 * Reads `name` from a data descriptor on the value or its prototype chain, so a hostile getter is
 * never run. A genuine DOMException exposes its name through a native prototype getter, which is
 * invoked directly; the brand check rejects look-alikes.
 */
function readName(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  if (domExceptionNameGetter !== null && error instanceof DOMException) {
    const name: unknown = domExceptionNameGetter.call(error);
    return typeof name === 'string' ? name : null;
  }
  let current: object | null = error;
  for (let step = 0; current !== null && step < MAX_PROTOTYPE_STEPS; step += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'name');
    if (descriptor !== undefined) {
      if (descriptor.get !== undefined || descriptor.set !== undefined) return null;
      return typeof descriptor.value === 'string' ? descriptor.value : null;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  return null;
}

export function reportableErrorName(error: unknown): string {
  try {
    const name = readName(error);
    return name !== null && REPORTABLE_ERROR_NAMES.has(name) ? name : 'Error';
  } catch {
    return 'Error';
  }
}
