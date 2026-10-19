export const layers = ['U', 'L', 'B', 'C', 'H', 'X', 'R'] as const;
export type Layer = (typeof layers)[number];
export type Gate = 'M' | 'R' | 'E' | 'D';
export type GateLayers = Readonly<Partial<Record<Gate, readonly Layer[]>>>;

interface CapabilityDefinition {
  readonly id: string;
  readonly group: string;
  readonly scenario: string;
  readonly gate: GateLayers;
  readonly deferral?: {
    readonly backlogId: `PB-${number}`;
    readonly reason: 'not-implemented' | 'needs-custom-hostname';
    readonly claim: string;
  };
  readonly hostnameMove?: { readonly from: 'C'; readonly to: 'H'; readonly reason: string };
  readonly beforeCutover?: true;
  readonly cadence?: 'before-cut-over';
}

export interface Capability extends CapabilityDefinition {
  readonly layers: readonly Layer[];
}

function capability(definition: CapabilityDefinition): Capability {
  return { ...definition, layers: [...new Set(Object.values(definition.gate).flat())] };
}

// One entry per row of e2e-release-testing.md section 4, in table order.
export const capabilities: readonly Capability[] = [
  capability({
    id: 'artifact-portability',
    group: 'Artifact',
    scenario:
      'packed CLI and packages install outside the monorepo; bundle starts without workspace or test dependencies',
    gate: { M: ['L'] },
  }),
  capability({
    id: 'artifact-identity',
    group: 'Artifact',
    scenario:
      'recorded Worker bytes deploy and the recorded image digest runs; `/health` reports the manifest version',
    gate: { R: ['C', 'H'] },
  }),
  capability({
    id: 'install-composer',
    group: 'Install',
    scenario:
      '`composer require` and lockfile install resolve mirrored and proxied packages with expected archive hashes',
    gate: { M: ['L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'install-npm',
    group: 'Install',
    scenario:
      '`npm install` and `npm ci` resolve scoped and unscoped private and proxied packages with expected integrity',
    gate: { M: ['L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'install-pnpm',
    group: 'Install',
    scenario: '`pnpm add` and frozen-lockfile reinstall with an isolated store',
    gate: { M: ['L'] },
  }),
  capability({
    id: 'install-yarn',
    group: 'Install',
    scenario: '`yarn add` and immutable reinstall with an isolated cache and the mirror disabled',
    gate: { M: ['L'] },
  }),
  capability({
    id: 'install-cache-reuse',
    group: 'Install',
    scenario:
      'empty client caches force a second broker download while fresh broker state makes zero upstream requests',
    gate: { M: ['L'] },
  }),
  capability({
    id: 'install-credential-containment',
    group: 'Install',
    scenario:
      'metadata, lockfiles, errors and dist URLs carry no credential and no direct-upstream bypass',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'mirror-proxy-assembly',
    group: 'Mirror and proxy',
    scenario:
      'the T448 scenario (mirrored, proxied Composer; proxied npm; webhook sync; re-mirror after blob loss) through both assemblies',
    gate: { M: ['L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'composer-normalisation',
    group: 'Mirror and proxy',
    scenario:
      'Composer v1 and v2 metadata, aliases, constraints and dist formats normalise into installable output',
    gate: { M: ['U', 'L'], E: ['X'] },
  }),
  capability({
    id: 'npm-normalisation',
    group: 'Mirror and proxy',
    scenario:
      'npm versions, dist-tags, tarball URLs rewritten to the broker origin, integrity rendered from authorised catalogue state',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'source-precedence',
    group: 'Mirror and proxy',
    scenario:
      'source precedence and registered names refuse dependency confusion and unauthorised proxy admission',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'http-validators',
    group: 'Mirror and proxy',
    scenario:
      'conditional GET and HEAD keep authorisation; HEAD has no body; validators stable across runtimes',
    gate: { M: ['U', 'L'], R: ['C'] },
  }),
  capability({
    id: 'push-publish',
    group: 'Push',
    scenario:
      'publish once, conflict on republish, write scope and approval enforced, immutable bytes installable',
    gate: { D: ['U', 'L', 'B', 'C', 'H', 'X', 'R'] },
    deferral: { backlogId: 'PB-40', reason: 'not-implemented', claim: 'Push waits for PB-40.' },
  }),
  capability({
    id: 'source-lifecycle',
    group: 'Sources',
    scenario:
      'Source lifecycle: create paused, add registered names, attach, resume, reorder with revision check, pause, refuse unsafe delete',
    gate: { M: ['U', 'L', 'B'] },
  }),
  capability({
    id: 'github-app',
    group: 'Sources',
    scenario: 'GitHub App token refresh, repository selection, pagination, installation revocation',
    gate: { M: ['U', 'L'], E: ['X'] },
  }),
  capability({
    id: 'git-sources',
    group: 'Sources',
    scenario:
      'Git smart HTTP tags and manifests; SSH on Docker only; an SSH source configured on Workers fails with a clear refusal',
    gate: { M: ['U', 'L', 'B'], R: ['H'] },
  }),
  capability({
    id: 'webhook-security',
    group: 'Webhooks',
    scenario:
      'valid signed delivery triggers sync; wrong HMAC, oversize body, replayed delivery id and wrong installation mutate nothing and make zero upstream requests',
    gate: { M: ['U', 'L'], E: ['X'] },
  }),
  capability({
    id: 'job-idempotency',
    group: 'Jobs',
    scenario:
      'duplicate delivery, expired lease and crash after a durable effect produce one domain effect; a stale worker cannot commit',
    gate: { M: ['U', 'L'], R: ['C'] },
  }),
  capability({
    id: 'job-notification-recovery',
    group: 'Jobs',
    scenario:
      'a lost Queue notification recovers through cron; scheduled and queue entry points execute the deployed code',
    gate: { R: ['C'] },
  }),
  capability({
    id: 'auth-sessions',
    group: 'Auth',
    scenario: 'bootstrap single-use; local login, logout, session expiry and replay refusal',
    gate: { M: ['U', 'L', 'B'] },
  }),
  capability({
    id: 'auth-key-versioning',
    group: 'Auth',
    scenario:
      'production hashing parameters and key versioning apply; a wrong or missing master key fails closed with a safe error',
    gate: { M: ['U', 'L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'auth-uniform-refusal',
    group: 'Auth',
    scenario:
      'malformed, expired, revoked and wrong-secret credentials answer a uniform 401; an invalid header never falls back to a cookie',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'sso-oidc',
    group: 'SSO',
    scenario:
      'Dex code flow with state, nonce, PKCE, issuer, audience, verified identity and safe return destination',
    gate: { M: ['U', 'L', 'B'], R: ['H'] },
  }),
  capability({
    id: 'sso-cache-policy',
    group: 'SSO',
    scenario:
      'JWKS rotation, unknown key, expired and future JWT, discovery redirect and IdP outage follow the bounded cache policy',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'sso-access-edge',
    group: 'SSO',
    scenario:
      'real Access allowed and denied users exercise the edge policy, the identity mapping and the direct-origin bypass defence',
    gate: { D: ['B', 'C', 'X'] },
    deferral: {
      backlogId: 'PB-132',
      reason: 'needs-custom-hostname',
      claim: 'Access edge policy and direct-origin bypass require a custom hostname.',
    },
  }),
  capability({
    id: 'reauth-freshness',
    group: 'Re-auth',
    scenario:
      'sensitive actions need same-session, same-identity fresh evidence; stale, future or missing `auth_time` never refreshes authority',
    gate: { M: ['U', 'L', 'B'] },
  }),
  capability({
    id: 'reauth-flows',
    group: 'Re-auth',
    scenario:
      'Access without step-up refuses token creation; local admin password and code re-auth complete the supported flows',
    gate: { M: ['U', 'L', 'B'], R: ['C'] },
  }),
  capability({
    id: 'authz-project-isolation',
    group: 'Authorisation',
    scenario:
      '`alpha` credentials cannot enumerate `beta` through lists, search, resolve, metadata, tarballs, revisions, audit or UI',
    gate: { M: ['U', 'L', 'B'], R: ['C'] },
  }),
  capability({
    id: 'authz-envelopes',
    group: 'Authorisation',
    scenario:
      'invalid authentication 401; absent, foreign or invisible project 404 with an identical envelope; visible forbidden action 403',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'authz-cache-revocation',
    group: 'Authorisation',
    scenario:
      'grant revoke, role change, token narrowing and project archive take effect on the next request despite warm caches',
    gate: { M: ['U', 'L'], R: ['H'], D: ['C'] },
    deferral: {
      backlogId: 'PB-132',
      reason: 'needs-custom-hostname',
      claim:
        'Named Cache API invalidation cannot be exercised on lbajsarowicz.workers.dev; runtime-independent warm-cache revocation is required on H.',
    },
    hostnameMove: {
      from: 'C',
      to: 'H',
      reason: 'Runtime-independent warm-cache revocation is required on the Node host.',
    },
  }),
  capability({
    id: 'authz-plugin-denial',
    group: 'Authorisation',
    scenario: 'plugin timeout, exception, malformed decision and attempted widening all deny',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'authz-organisation-isolation',
    group: 'Authorisation',
    scenario:
      'a second organisation bootstrap is refused; adversarial cross-org rows cannot escape query predicates',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'token-lifecycle',
    group: 'Tokens',
    scenario:
      'PAT and service token issue, show-once, scope and expiry caps, revoke, selected and all-project bindings',
    gate: { M: ['U', 'L', 'B'] },
  }),
  capability({
    id: 'token-suspension',
    group: 'Tokens',
    scenario:
      'user suspension invalidates PATs; service suspension or grant removal invalidates service tokens; tokens cannot perform session-only writes',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'token-identity-binding',
    group: 'Tokens',
    scenario:
      'identity unlink and rebind and freshness expiry invalidate dependent credentials without resurrection through another identity',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'integrity-quarantine',
    group: 'Integrity',
    scenario:
      'digest mismatch quarantines the version, stores no bytes, answers the specified unavailable dist response',
    gate: { M: ['U', 'L'], R: ['C'] },
  }),
  capability({
    id: 'integrity-blob-recovery',
    group: 'Integrity',
    scenario:
      'blob loss or corruption coalesces re-fetch and restores verified bytes; a missing historical revision never receives replacement bytes',
    gate: { M: ['U', 'L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'integrity-changing-upstream',
    group: 'Integrity',
    scenario:
      'second-pass upstream bytes changing triggers bounded retry then safe failure without partial publication',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'retention',
    group: 'Retention',
    scenario:
      'partial, empty or failed listings remove nothing; complete removals keep non-refetchable bytes; purge respects references',
    gate: { M: ['U', 'L'] },
  }),
  capability({
    id: 'backup-consistency',
    group: 'Backup',
    scenario:
      'a consistent backup during writes restores catalogue, credentials, pending and sealed audit and the migration ledger into fresh resources',
    gate: { M: ['U', 'L'], R: ['C', 'H', 'R'] },
  }),
  capability({
    id: 'restore-revocation',
    group: 'Backup',
    scenario:
      'restore obtains the master key from its separate store, rotates the cache epoch, invalidates sessions, applies the revocation policy Owner Q4: invalidate every restored session and PAT; admins re-issue service principals.',
    gate: { R: ['C', 'H', 'R'] },
  }),
  capability({
    id: 'restore-blobs',
    group: 'Backup',
    scenario:
      'restore keeps pushed, generated and upstream-removed bytes and re-fetches only refetchable blobs',
    gate: { R: ['C', 'H', 'R'] },
  }),
  capability({
    id: 'restore-d1',
    group: 'Backup',
    scenario: 'D1 export recovery and Time Travel recovery each follow the documented workflow',
    gate: { R: ['C', 'R'] },
    beforeCutover: true,
  }),
  capability({
    id: 'restore-rehearsal',
    group: 'Backup',
    scenario:
      'sized rehearsal restores client installs within 4 h from a recovery point under 24 h old',
    gate: { R: ['R'] },
    beforeCutover: true,
    cadence: 'before-cut-over',
  }),
  capability({
    id: 'upgrade-state',
    group: 'Upgrade',
    scenario:
      'the previous rc creates state; candidate migrations preserve installs, credentials, authorisation and audit',
    gate: { M: ['L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'upgrade-migration-failures',
    group: 'Upgrade',
    scenario:
      'interrupted migration, concurrent migrator, checksum change and ambiguous commit response never yield a partially ready state',
    gate: { M: ['U', 'L'], R: ['C'] },
  }),
  capability({
    id: 'upgrade-job-payloads',
    group: 'Upgrade',
    scenario:
      'old and new job payload versions stay safe during upgrade; rollback only along a declared path',
    gate: { M: ['U', 'L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'ui-management',
    group: 'UI',
    scenario:
      'projects, sources and tokens pages complete create, read and update through documented OpenAPI operations only (network interceptor)',
    gate: { M: ['B'] },
  }),
  capability({
    id: 'ui-reauth',
    group: 'UI',
    scenario:
      're-auth replay needs confirmation, keeps the idempotency key, never persists a credential body',
    gate: { M: ['B'] },
  }),
  capability({
    id: 'ui-token-install',
    group: 'UI',
    scenario:
      'the PAT issued in the UI installs with `composer` and `npm`; revoked in the UI, the next `npm view` answers 401',
    gate: { M: ['B'] },
  }),
  capability({
    id: 'browser-csrf',
    group: 'Browser security',
    scenario:
      'real two-origin POST, missing or wrong CSRF token, wrong Origin, ambient Basic and mixed credentials mutate nothing',
    gate: { M: ['U', 'L', 'B'] },
  }),
  capability({
    id: 'browser-cookies',
    group: 'Browser security',
    scenario:
      '`__Host-pb_csrf` attributes, HttpOnly session, `no-store`, no CORS, cookie refused over plain HTTP or with `Domain`',
    gate: { M: ['B'], R: ['C', 'H'] },
  }),
  capability({
    id: 'browser-csp',
    group: 'Browser security',
    scenario:
      'CSP blocks inline script, framing and foreign form submission while the SSO navigation completes; zero console violations',
    gate: { M: ['B'], R: ['C', 'H'] },
  }),
  capability({
    id: 'rate-limiting',
    group: 'Rate limiting',
    scenario:
      'configured burst and window produce 429 with `Retry-After`, recover on time, ignore spoofed forwarding headers',
    gate: { D: ['U', 'L', 'B', 'C', 'H', 'X', 'R'] },
    deferral: {
      backlogId: 'PB-94',
      reason: 'not-implemented',
      claim: 'Rate limiting waits for the PB-94 policy packet.',
    },
  }),
  capability({
    id: 'observability-correlation',
    group: 'Observability',
    scenario: 'concurrent requests emit correlated completion records once; bounded metrics',
    gate: { M: ['U', 'L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'observability-redaction',
    group: 'Observability',
    scenario:
      'canary secrets and e-mails in headers, upstream bodies and thrown errors never reach logs, traces, caches, reports or backups',
    gate: { M: ['U', 'L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'audit-integrity',
    group: 'Audit',
    scenario:
      'business effect and pending audit atomic; sealing ordered and idempotent; mutation, deletion, reorder and anchored truncation detected with the first invalid position',
    gate: { M: ['U', 'L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'd1-bindings',
    group: 'D1 limits',
    scenario:
      '99, 100 and 101 bindings; the largest real writer and authorisation statements stay within limits',
    gate: { R: ['U', 'C'] },
  }),
  capability({
    id: 'd1-patterns',
    group: 'D1 limits',
    scenario: '49, 50 and 51-byte LIKE and GLOB patterns, escaping and multibyte inputs (OQ-50)',
    gate: { M: ['U', 'L'], R: ['C'] },
  }),
  capability({
    id: 'd1-indexes',
    group: 'D1 limits',
    scenario:
      'every shipped `INDEXED BY` statement executes on migrated real D1; a failed batch leaves no partial mutation',
    gate: { R: ['U', 'C'] },
  }),
  capability({
    id: 'd1-budgets',
    group: 'D1 limits',
    scenario:
      'maximum selections, version pages and ingest chunks stay within statement, row and response-size budgets',
    gate: { M: ['U', 'L'], R: ['C'] },
  }),
  capability({
    id: 'workers-cpu',
    group: 'Workers CPU',
    scenario:
      'cold and warm auth at production hashing cost, maximum metadata, bounded archives and worst supported packs fit the budget; 20 concurrent installs with PBKDF2 produce zero CPU-limit errors',
    gate: { R: ['C'] },
  }),
  capability({
    id: 'availability-health',
    group: 'Availability',
    scenario:
      'readiness needs usable dependencies; liveness distinct from readiness under database failure; `/health` under 200 ms when healthy',
    gate: { M: ['U', 'L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'availability-drain',
    group: 'Availability',
    scenario:
      'SIGTERM stops admissions and drains an in-flight 20 MB download within the documented limit; restart and crash recover durable state and unfinished jobs',
    gate: { M: ['U', 'L', 'B'], R: ['H'] },
  }),
  capability({
    id: 'availability-upstream-outage',
    group: 'Availability',
    scenario:
      'upstream outage serves permitted cached content with a stale marker; unseen requests fail within the deadline without a credential leak',
    gate: { M: ['U', 'L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'availability-storage-failure',
    group: 'Availability',
    scenario:
      'database failure never serves unauthorised cached data; blob or disk failure never yields a false successful publication',
    gate: { M: ['U', 'L'], R: ['C', 'H'] },
  }),
  capability({
    id: 'tls-host',
    group: 'TLS and host',
    scenario:
      'trusted certificate, hostname, redirects, forwarded-origin handling, non-root filesystem, persistent mount',
    gate: { R: ['H', 'B'] },
    hostnameMove: {
      from: 'C',
      to: 'H',
      reason:
        'Runtime-independent public TLS, hostname and forwarded-origin checks is required on the Node host.',
    },
  }),
];

export interface CertificationOptions {
  readonly beforeCutover?: boolean;
}

export function requiredScenarioIds(layer: Layer, options: CertificationOptions = {}): string[] {
  return capabilities
    .filter((entry) => entry.cadence !== 'before-cut-over' || options.beforeCutover)
    .filter((entry) =>
      Object.entries(entry.gate).some(
        ([gate, selected]) => gate !== 'D' && selected.includes(layer),
      ),
    )
    .map(({ id }) => id);
}

export interface CertificationResult {
  readonly id: string;
  readonly layer: Layer;
  readonly status: 'PASS' | 'FAIL' | 'NOT RUN';
}

export interface Certification {
  readonly passed: boolean;
  readonly issues: readonly { readonly id: string; readonly reason: string }[];
}

export function certify(
  layer: Layer,
  results: readonly CertificationResult[],
  options: CertificationOptions = {},
): Certification {
  const issues: { id: string; reason: string }[] = [];
  const selected = new Map<string, CertificationResult>();
  for (const result of results) {
    const entry = capabilities.find(({ id }) => id === result.id);
    if (!entry || !entry.layers.includes(result.layer)) {
      issues.push({ id: result.id, reason: 'Unknown capability or unsupported layer.' });
      continue;
    }
    if (entry.gate.D?.includes(result.layer)) {
      issues.push({ id: result.id, reason: 'Deferred evidence cannot be certified.' });
    }
    if (result.layer !== layer) continue;
    if (selected.has(result.id)) {
      issues.push({ id: result.id, reason: 'Duplicate scenario result.' });
    }
    selected.set(result.id, result);
    if (!['PASS', 'FAIL', 'NOT RUN'].includes(result.status) || result.status === 'FAIL') {
      issues.push({ id: result.id, reason: 'Scenario did not pass.' });
    }
  }
  for (const id of requiredScenarioIds(layer, options)) {
    if (selected.get(id)?.status !== 'PASS') {
      issues.push({ id, reason: 'Required scenario is missing or did not pass.' });
    }
  }
  return { passed: issues.length === 0, issues };
}
