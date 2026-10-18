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

const NO_ORG_COLUMN = 'builds no organization-scoped read or write';
const UNREGISTERED = 'organization scoping not yet registered in the mutation table';

/** Exported builders that are not in `mutationTable`, each with the reason. */
export const builderAllowlist: Readonly<Record<string, string>> = {
  // Factory methods are scanned too; these remain explicit work for subsequent rounds.
  'repositories/blob-access.ts#createBlobAccessRepository': UNREGISTERED,
  'repositories/project.ts#createProjectRepository': UNREGISTERED,
  'repositories/fetch-lease.ts#createFetchLeases': UNREGISTERED,
  'repositories/visibility-subset.ts#createVisibilitySubsetRepository': UNREGISTERED,
  'repositories/blob.ts#createBlobRepository': UNREGISTERED,
  'repositories/credential.ts#createCredentialRepository': UNREGISTERED,
  'repositories/source.ts#createSourceRepository': UNREGISTERED,
  'repositories/ingest-session.ts#createIngestSessionWriteGuard': UNREGISTERED,
  'repositories/ingest-session.ts#createIngestSessions': UNREGISTERED,
  'repositories/ingest-session.ts#createIngestSessionMaintenance': UNREGISTERED,
  'repositories/project-grant.ts#createProjectGrantRepository': UNREGISTERED,
  'repositories/catalogue-lookup.ts#createCatalogueLookup': UNREGISTERED,
  'repositories/registered-name.ts#createRegisteredNameRepository': UNREGISTERED,
  'repositories/upstream-state.ts#createUpstreamStateRepository': UNREGISTERED,
  'repositories/blob-references.ts#createBlobReferenceReader': UNREGISTERED,
  'repositories/login.ts#createLoginWriter': UNREGISTERED,
  'repositories/service-principal-authority.ts#createServicePrincipalAuthority': UNREGISTERED,
  'repositories/unlink.ts#createUnlinkRepository': UNREGISTERED,
  'repositories/closure-edges.ts#createClosureEdges': UNREGISTERED,
  'repositories/representation-clock.ts#createRepresentationClock': UNREGISTERED,
  'repositories/proxy-admission.ts#createProxyAdmission': UNREGISTERED,
  'repositories/scoped-admission.ts#createScopedAdmission': UNREGISTERED,
  'repositories/job-schedule.ts#createJobScheduleRepository': UNREGISTERED,
  'repositories/catalogue-list.ts#createCatalogueList': UNREGISTERED,
  'repositories/grant.ts#createGrantRepository': UNREGISTERED,
  'repositories/role.ts#createRoleRepository': UNREGISTERED,
  'repositories/session.ts#createSessionRepository': UNREGISTERED,
  'repositories/access.ts#createAccessRepository': UNREGISTERED,
  'repositories/catalogue-dist.ts#createDistResolver': UNREGISTERED,
  'repositories/identity-block.ts#createIdentityBlockRepository': UNREGISTERED,
  'repositories/token-read.ts#createTokenReader': UNREGISTERED,
  'repositories/job.ts#createJobRepository': UNREGISTERED,
  'repositories/local-login-success.ts#createLocalLoginSuccessWriter': UNREGISTERED,
  'repositories/catalogue-read.ts#createCatalogueReader': UNREGISTERED,
  'repositories/organization.ts#createOrganizationRepository': UNREGISTERED,
  'repositories/organization.ts#createOrganizationBootstrap': UNREGISTERED,
  'repositories/existing-versions.ts#createExistingVersionsReader': UNREGISTERED,
  'repositories/project-readable.ts#createReadableProjectRepository': UNREGISTERED,
  'repositories/local-login.ts#createLocalLoginReader': UNREGISTERED,
  'repositories/local-login-setup.ts#createLocalLoginSetupWriter': UNREGISTERED,
  'repositories/token.ts#createTokenRepository': UNREGISTERED,
  'repositories/user.ts#createUserRepository': UNREGISTERED,
  'repositories/auth.ts#createAuthRepositories': UNREGISTERED,
  'repositories/cache-epoch.ts#createCacheEpochRepository': UNREGISTERED,
  'repositories/service-principal.ts#createServicePrincipalRepository': UNREGISTERED,
  'repositories/visibility-attach.ts#createVisibilityAttachRepository': UNREGISTERED,

  'internal/lease-time.ts#until':
    'builds only a lease timestamp expression; no organization-scoped read or write',
  'repositories/catalogue-predicates.ts#winnerOrder': NO_ORG_COLUMN,
  'repositories/catalogue-status.ts#quarantineStatements':
    'adds no SQL or organization column of its own: concatenates the supplied guard, versionStatusStatements and conditionalEpochBumpStatement unchanged; their predicates are registered separately',
  'repositories/session-liveness.ts#liveSessionCondition': NO_ORG_COLUMN,
  'kysely.ts#compile': NO_ORG_COLUMN,
  'kysely.ts#existsGuard':
    'wraps only the supplied query in EXISTS; it adds no table, column or organization predicate of its own',
  'kysely.ts#assertCheck': NO_ORG_COLUMN,
  'internal/catalogue-write-guard.ts#registerCatalogueWriteGuard': NO_ORG_COLUMN,
  'internal/catalogue-write-guard.ts#assertCatalogueWriteGuard': NO_ORG_COLUMN,
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
  }
  return problems;
}
