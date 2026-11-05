/**
 * The runtime-neutral side of the registry policy HTTP matrices: upstream documents, the broker
 * interface each runtime harness implements, and management helpers that go through the real API.
 */

export const POLICY_NPM_PACKAGE = 'left-pad';
export const POLICY_LATE_PACKAGE = 'late-pad';
export const POLICY_COMPOSER_PACKAGE = 'acme/lib';

export interface PolicyRequestInit {
  readonly method?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
  /** False sends no session cookie or CSRF header. */
  readonly session?: boolean;
}

export interface PolicyAuditRow {
  readonly action: string;
  readonly payload: string;
}

/** One booted broker over a real database and blob store, as each runtime harness provides it. */
export interface PolicyBroker {
  /** The project slug whose sources serve the npm and Composer fixtures. */
  readonly project: string;
  fetch(path: string, init?: PolicyRequestInit): Promise<Response>;
  /** Marks the admin session freshly reauthenticated. */
  reauth(): Promise<void>;
  /** Clears the admin session reauthentication, as if it happened long ago. */
  dropReauth(): Promise<void>;
  audits(): Promise<readonly PolicyAuditRow[]>;
  /** Makes the database refuse new direct-denial evidence until restored. */
  breakReadAudit(): Promise<void>;
  restoreReadAudit(): Promise<void>;
  /** Moves a rule expiry into the past without a policy write or epoch change. */
  expireRule(id: string): Promise<void>;
  setVersionStatus(name: string, version: string, status: string): Promise<void>;
  versionStatus(name: string, version: string): Promise<string | null>;
  packageId(name: string): Promise<string | null>;
  upstreamCalls(): number;
  logs(): string;
}

export interface PolicyUpstream {
  readonly packument: (name: string) => unknown;
  readonly tarball: (version: string) => Uint8Array;
  readonly composer: () => unknown;
  readonly zip: Uint8Array;
}

const encoder = new TextEncoder();

async function integrity(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return `sha512-${btoa(binary)}`;
}

/** Three npm versions (2.0.0 latest, 3.0.0 an hour old as `next`) and two Composer versions. */
export async function policyUpstream(now: Date): Promise<PolicyUpstream> {
  const versions = ['1.0.0', '2.0.0', '3.0.0'];
  const tarballs = new Map(
    versions.map((version) => [version, encoder.encode(`tarball ${version}`)]),
  );
  const integrities = new Map<string, string>();
  for (const [version, bytes] of tarballs) integrities.set(version, await integrity(bytes));
  const times: Record<string, string> = {
    '1.0.0': '2026-01-01T00:00:00.000Z',
    '2.0.0': '2026-02-01T00:00:00.000Z',
    '3.0.0': new Date(now.getTime() - 3_600_000).toISOString(),
  };
  return {
    packument: (name) => ({
      name,
      description: 'Publisher text kept exactly',
      'dist-tags': { latest: '2.0.0', next: '3.0.0' },
      versions: Object.fromEntries(
        versions.map((version) => [
          version,
          {
            name,
            version,
            description: 'Publisher text kept exactly',
            deprecated: version === '1.0.0' ? 'Use 3.x, publisher wording kept' : undefined,
            dist: {
              tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
              integrity: integrities.get(version),
            },
          },
        ]),
      ),
      time: times,
    }),
    tarball: (version) => tarballs.get(version) ?? encoder.encode('missing'),
    composer: () => ({
      minified: 'composer/2.0',
      packages: {
        [POLICY_COMPOSER_PACKAGE]: ['1.0.0', '2.0.0'].map((version) => ({
          name: POLICY_COMPOSER_PACKAGE,
          version,
          version_normalized: `${version}.0`,
          type: 'library',
          time: '2026-01-01T00:00:00+00:00',
          dist: {
            type: 'zip',
            url: `https://api.github.com/repos/${POLICY_COMPOSER_PACKAGE}/zipball/r${version}`,
            reference: `r${version}`,
            shasum: '',
          },
        })),
      },
    }),
    zip: encoder.encode('zip bytes'),
  };
}

let keys = 0;

/** Sends one management write with a fresh idempotency key unless one is given. */
export async function policyWrite(
  broker: PolicyBroker,
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  options: { readonly revision?: number; readonly key?: string } = {},
): Promise<{ status: number; body: Record<string, unknown>; replayed: boolean }> {
  keys += 1;
  const response = await broker.fetch(path, {
    method,
    body,
    headers: {
      'idempotency-key': options.key ?? `matrix-${String(keys)}-${String(Date.now())}`,
      ...(options.revision === undefined ? {} : { 'if-match': `"r${String(options.revision)}"` }),
    },
  });
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
    replayed: response.headers.get('idempotent-replayed') === 'true',
  };
}

export function npmBlock(members: readonly string[], name = POLICY_NPM_PACKAGE) {
  return { ecosystem: 'npm', package: name, kind: 'block', members, reasonCode: 'security_review' };
}

export async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

export function sortedKeys(value: unknown): string[] {
  return value !== null && typeof value === 'object' ? Object.keys(value).sort() : [];
}

export async function readDenials(broker: PolicyBroker): Promise<string[]> {
  return (await broker.audits())
    .filter((row) => row.action === 'policy.read_denied')
    .map((row) => {
      const payload = JSON.parse(row.payload) as {
        changes?: { read_kind?: { new?: string } };
      };
      return payload.changes?.read_kind?.new ?? 'unknown';
    })
    .sort();
}
