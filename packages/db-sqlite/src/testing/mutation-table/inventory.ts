import type { MutationEntry } from './harness.js';

const BUILDER_RETURN =
  /\b(?:Guard|Statement|ScalarStatement|FenceGuard|LeaseGuardCondition|EligibleCondition|\w*Plan)\b|Expression<|SelectQueryBuilder|Statement\[\]/;
const BUILDER_NAME = /(?:Condition|Statements?|Guard)$/;

function closingParen(source: string, open: number): number {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return index;
  }
  return source.length;
}

function isBuilder(name: string, annotation: string | undefined): boolean {
  if (annotation === undefined) return true;
  return (
    !annotation.startsWith('Promise<') &&
    (name.startsWith('create') || BUILDER_RETURN.test(annotation) || BUILDER_NAME.test(name))
  );
}

/** Exported functions and arrow constants of a source that build SQL statements, guards or predicates. */
export function exportedBuilders(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/^export (?:async )?function (\w+)\s*(?:<[^(]*>)?\(/gm)) {
    const close = closingParen(source, (match.index ?? 0) + match[0].length - 1);
    const annotation = /^\s*:\s*([^{]*?)\s*\{/s.exec(source.slice(close + 1, close + 400))?.[1];
    if (isBuilder(match[1] ?? '', annotation)) found.push(match[1] ?? '');
  }
  for (const match of source.matchAll(
    /^export const (\w+)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:function\s*)?(?:<[^(]*>)?\(/gm,
  )) {
    const close = closingParen(source, (match.index ?? 0) + match[0].length - 1);
    const after = source.slice(close + 1, close + 400);
    const annotation = /^\s*:\s*([^{=]*?)\s*(?:=>|\{)/s.exec(after)?.[1];
    if (/^\s*(?::[^{=]*?)?\s*(?:=>|\{)/s.test(after) && isBuilder(match[1] ?? '', annotation)) {
      found.push(match[1] ?? '');
    }
  }
  return found;
}

/** Builders a source exports, including relative re-exports of builders from other sources. */
export function builderNames(
  file: string,
  sources: Readonly<Record<string, string>>,
  seen: ReadonlySet<string> = new Set(),
): string[] {
  const source = sources[file];
  if (source === undefined || seen.has(file)) return [];
  const names = exportedBuilders(source);
  for (const match of source.matchAll(
    /^export \{([^}]*)\} from '(\.{1,2}\/[^']+)'|^export \* from '(\.{1,2}\/[^']+)'/gm,
  )) {
    const specifier = match[2] ?? match[3] ?? '';
    const target = new URL(specifier.replace(/\.js$/, '.ts'), `file:///${file}`).pathname.slice(1);
    const upstream = builderNames(target, sources, new Set([...seen, file]));
    if (match[1] === undefined) {
      names.push(...upstream);
      continue;
    }
    for (const item of match[1].split(',')) {
      const [original, alias] = item.trim().split(/\s+as\s+/);
      if (original !== undefined && original !== '' && upstream.includes(original)) {
        names.push(alias ?? original);
      }
    }
  }
  return names;
}

const productionAccessFactories: ReadonlySet<string> = new Set([
  'repositories/project.ts#createProjectRepository',
  'repositories/project-grant.ts#createProjectGrantRepository',
  'repositories/service-principal-authority.ts#createServicePrincipalAuthority',
  'repositories/unlink.ts#createUnlinkRepository',
  'repositories/access.ts#createAccessRepository',
  'repositories/token-read.ts#createTokenReader',
  'repositories/organization.ts#createOrganizationRepository',
  'repositories/project-readable.ts#createReadableProjectRepository',
  'repositories/token.ts#createTokenRepository',
  'repositories/auth.ts#createAuthRepositories',
  'repositories/service-principal.ts#createServicePrincipalRepository',
]);

/** Factories still awaiting semantic cases, and builders with no independent organization SQL. */
export const builderAllowlist: Readonly<Record<string, string>> = {
  'repositories/blob-access.ts#createBlobAccessRepository':
    'DEFERRED: blob authorization read paths need independent child fixtures; owner T782n follow-up',
  'repositories/fetch-lease.ts#createFetchLeases':
    'DEFERRED: factory acquire, renew and release paths exceed the registered guard cases; owner T782n follow-up',
  'repositories/visibility-subset.ts#createVisibilitySubsetRepository':
    'DEFERRED: visibility subset readers need foreign package and source fixtures; owner T782n follow-up',
  'repositories/blob.ts#createBlobRepository':
    'DEFERRED: blob writes and lease lifecycle need independent child fixtures; owner T782n follow-up',
  'repositories/credential.ts#createCredentialRepository':
    'DEFERRED: credential lifecycle needs foreign user and credential fixtures; owner T782n follow-up',
  'repositories/source.ts#createSourceRepository':
    'DEFERRED: source factory reads and writes exceed the registered source guard case; owner T782n follow-up',
  'repositories/ingest-session.ts#createIngestSessionWriteGuard':
    'DEFERRED: session lifecycle and maintenance exceed the registered statement cases; owner T782n follow-up',
  'repositories/ingest-session.ts#createIngestSessions':
    'DEFERRED: session lifecycle and maintenance exceed the registered statement cases; owner T782n follow-up',
  'repositories/ingest-session.ts#createIngestSessionMaintenance':
    'DEFERRED: session lifecycle and maintenance exceed the registered statement cases; owner T782n follow-up',
  'repositories/catalogue-reconcile.ts#finalizeListingStatements':
    'DEFERRED: createCatalogueReconciler.finalizeListing wraps exactly these statements and is exercised by the registered reconcile cases; owner T782n follow-up',
  'repositories/catalogue-lookup.ts#createCatalogueLookup':
    'DEFERRED: lookup adapter needs executable foreign winner fixtures; owner T782n follow-up',
  'repositories/registered-name.ts#createRegisteredNameRepository':
    'DEFERRED: factory lookup paths exceed the registered name statements; owner T782n follow-up',
  'repositories/upstream-state.ts#createUpstreamStateRepository':
    'DEFERRED: upstream state transitions need foreign package fixtures; owner T782n follow-up',
  'repositories/blob-references.ts#createBlobReferenceReader':
    'DEFERRED: reference reader adapter exceeds the registered statement case; owner T782n follow-up',
  'repositories/login.ts#createLoginWriter':
    'DEFERRED: login writer needs foreign identity and user fixtures; owner T782n follow-up',
  'repositories/closure-edges.ts#createClosureEdges':
    'DEFERRED: closure edge lifecycle needs foreign project and package fixtures; owner T782n follow-up',
  'repositories/representation-clock.ts#createRepresentationClock':
    'DEFERRED: representation clock reads need foreign package fixtures; owner T782n follow-up',
  'repositories/proxy-admission.ts#createProxyAdmission':
    'DEFERRED: factory admission lifecycle exceeds admittedProxySources registration; owner T782n follow-up',
  'repositories/scoped-admission.ts#createScopedAdmission':
    'DEFERRED: scoped admission needs foreign lease and session fixtures; owner T782n follow-up',
  'repositories/job-schedule.ts#createJobScheduleRepository':
    'DEFERRED: job schedule writes need foreign source fixtures; owner T782n follow-up',
  'repositories/catalogue-list.ts#createCatalogueList':
    'DEFERRED: catalogue list readers need independent foreign winner fixtures; owner T782n follow-up',
  'repositories/grant.ts#createGrantRepository':
    'DEFERRED: organization grant lifecycle needs foreign role and subject fixtures; owner T782n follow-up',
  'repositories/role.ts#createRoleRepository':
    'DEFERRED: role factory writes exceed seedDefaultsStatements registration; owner T782n follow-up',
  'repositories/session.ts#createSessionRepository':
    'DEFERRED: session factory lifecycle exceeds the registered session statements; owner T782n follow-up',
  'repositories/catalogue-dist.ts#createDistResolver':
    'DEFERRED: dist resolver needs foreign version and blob fixtures; owner T782n follow-up',
  'repositories/identity-block.ts#createIdentityBlockRepository':
    'DEFERRED: identity blocking needs foreign subject and issuer fixtures; owner T782n follow-up',
  'repositories/job.ts#createJobRepository':
    'DEFERRED: job lifecycle needs foreign source and lease fixtures; owner T782n follow-up',
  'repositories/local-login-success.ts#createLocalLoginSuccessWriter':
    'DEFERRED: local login success writes need foreign user and credential fixtures; owner T782n follow-up',
  'repositories/catalogue-read.ts#createCatalogueReader':
    'DEFERRED: catalogue reader factory exceeds visibleWinner registration; owner T782n follow-up',
  'repositories/organization.ts#createOrganizationBootstrap':
    'REDUNDANT_BY_SCHEMA: 0001_init.sql organization_singleton UNIQUE (singleton), CHECK (singleton = 1); bootstrap selects the installation singleton rather than an organization context',
  'repositories/existing-versions.ts#createExistingVersionsReader':
    'DEFERRED: existing version reader needs foreign package fixtures; owner T782n follow-up',
  'repositories/local-login.ts#createLocalLoginReader':
    'DEFERRED: local login reader needs foreign user and credential fixtures; owner T782n follow-up',
  'repositories/local-login-setup.ts#createLocalLoginSetupWriter':
    'DEFERRED: local login setup writes need foreign user and credential fixtures; owner T782n follow-up',
  'repositories/user.ts#createUserRepository':
    'DEFERRED: user factory methods beyond the auth getIdentity case need separate fixtures; owner T782n follow-up',
  'repositories/cache-epoch.ts#createCacheEpochRepository':
    'DEFERRED: epoch repository adapter exceeds epochReadStatement registration; owner T782n follow-up',
  'repositories/visibility-attach.ts#createVisibilityAttachRepository':
    'DEFERRED: factory attachment lifecycle exceeds attachSourceStatements registration; owner T782n follow-up',

  'internal/lease-time.ts#until':
    'DEFERRED: builds only a lease timestamp expression; no organization-scoped read or write; owner T782n exemption review',
  'repositories/catalogue-predicates.ts#winnerOrder':
    'DEFERRED: builds no organization-scoped read or write; owner T782n exemption review',
  'repositories/catalogue-status.ts#quarantineStatements':
    'DEFERRED: adds no SQL or organization column of its own: concatenates the supplied guard, versionStatusStatements and conditionalEpochBumpStatement unchanged; their predicates are registered separately; owner T782n exemption review',
  'repositories/session-liveness.ts#liveSessionCondition':
    'DEFERRED: builds no organization-scoped read or write; owner T782n exemption review',
  'kysely.ts#compile':
    'DEFERRED: builds no organization-scoped read or write; owner T782n exemption review',
  'kysely.ts#existsGuard':
    'DEFERRED: wraps only the supplied query in EXISTS; it adds no table, column or organization predicate of its own; owner T782n exemption review',
  'kysely.ts#assertCheck':
    'DEFERRED: builds no organization-scoped read or write; owner T782n exemption review',
  'internal/catalogue-write-guard.ts#registerCatalogueWriteGuard':
    'DEFERRED: builds no organization-scoped read or write; owner T782n exemption review',
  'internal/catalogue-write-guard.ts#assertCatalogueWriteGuard':
    'DEFERRED: builds no organization-scoped read or write; owner T782n exemption review',
};

/** Problems between the exported builders of the given repository sources, the table and the allowlist. */
export function checkCompleteness(
  sources: Readonly<Record<string, string>>,
  table: readonly MutationEntry[],
  allowlist: Readonly<Record<string, string>> = builderAllowlist,
): string[] {
  const exported = new Set<string>();
  for (const file of Object.keys(sources)) {
    for (const name of builderNames(file, sources)) exported.add(`${file}#${name}`);
  }
  const registered = new Set(table.map((entry) => `${entry.file}#${entry.builder}`));
  const problems: string[] = [];
  for (const key of exported) {
    if (!registered.has(key) && !(key in allowlist)) problems.push(`${key} has no registration`);
  }
  for (const key of registered) {
    if (!exported.has(key)) problems.push(`${key} is registered but no longer exported`);
  }
  for (const key of Object.keys(allowlist)) {
    if (!exported.has(key)) problems.push(`${key} is allowlisted but no longer exported`);
    if (registered.has(key)) problems.push(`${key} is allowlisted and registered`);
    if (!exported.has(key)) continue;
    if (productionAccessFactories.has(key)) {
      problems.push(`${key} is wired in production and cannot be waived`);
    }
    const reason = allowlist[key] ?? '';
    if (
      !/^REDUNDANT_BY_SCHEMA: .*(?:FOREIGN KEY|PRIMARY KEY|UNIQUE|CHECK)/.test(reason) &&
      !/^DEFERRED: .+; owner T\d+\w*(?: .+)?$/.test(reason)
    ) {
      problems.push(`${key} needs a schema constraint or a deferred reason and owner packet`);
    }
  }
  return problems;
}
