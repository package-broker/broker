import type { MutationEntry } from './harness.js';
import { allowlist as sourceSyncReadsAllowlist } from './source-sync-reads.js';
import { packetStatuses } from './packet-status.js';

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
  'repositories/ingest-session.ts#createIngestSessions',
  'repositories/upstream-state.ts#createUpstreamStateRepository',
  'repositories/source.ts#createSourceRepository',
  'repositories/catalogue-dist.ts#createDistResolver',
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

/** Schema exemptions and helpers with no independent organization SQL. */
export const builderAllowlist: Readonly<Record<string, string>> = {
  'repositories/import-run.ts#getImportRunStatement':
    'NOT_A_MUTATION: read-only organization-scoped import run summary; organization isolation is covered by repository, D1 twin and cp-restore mutation tests.',
  'repositories/import-run.ts#listImportRunsStatement':
    'NOT_A_MUTATION: read-only organization-scoped import run keyset page; organization isolation is covered by repository, D1 twin and cp-restore mutation tests.',
  ...sourceSyncReadsAllowlist,
  'repositories/package-id.ts#createPackageIdReads':
    'NOT_A_MUTATION: adds no SQL; validates arguments and maps rows of packageIdStatement, registered separately in package-id.ts.',
  'repositories/project-source-read.ts#createProjectSourceReader':
    'NOT_A_MUTATION: adds no SQL; validates the project id and maps rows of projectSourceIdsStatement, registered separately in project-source-read.ts.',
  'repositories/registry-reads.ts#createRegistryReads':
    'NOT_A_MUTATION: adds no SQL; validates arguments and maps rows of coversStatement and versionByIdStatement, both registered separately in registry-reads.ts.',
  'repositories/organization.ts#createOrganizationBootstrap':
    'REDUNDANT_BY_SCHEMA: 0001_init.sql organization_singleton UNIQUE (singleton), CHECK (singleton = 1); bootstrap selects the installation singleton rather than an organization context',
  'repositories/keyring-verifier.ts#createKeyringVerifierStore':
    'REDUNDANT_BY_SCHEMA: 0015_keyring_verifier.sql keyring_verifier PRIMARY KEY (key_version); the verifier is installation-global and has no organization column',
  'repositories/webhook-delivery.ts#createWebhookDeliveryRepository':
    'NOT_A_MUTATION: the factory only sequences the four registered webhook delivery statements, maps their rows and issues no SQL of its own.',

  'sql/project-prefix.ts#projectPrefixCondition':
    'NOT_A_MUTATION: builds slug and name range predicates without tables or organization columns; callers supply organization scoping.',
  'internal/lease-time.ts#until':
    'NOT_A_MUTATION: builds a lease timestamp expression without tables or organization predicates.',
  'repositories/catalogue-predicates.ts#npmClaimCover':
    'NOT_A_MUTATION: compares supplied ecosystem, pattern and key expressions without tables or organization columns; callers supply organization scoping.',
  'repositories/catalogue-predicates.ts#winnerOrder':
    'NOT_A_MUTATION: returns ORDER BY expressions without selecting or changing rows.',
  'repositories/catalogue-status.ts#quarantineStatements':
    'NOT_A_MUTATION: adds no SQL; concatenates supplied guards, versionStatusStatements and conditionalEpochBumpStatement unchanged, all registered separately.',
  'repositories/session-liveness.ts#liveSessionCondition':
    'NOT_A_MUTATION: builds only revocation and time predicates for a supplied session alias; callers supply organization scoping.',
  'kysely.ts#compile':
    'NOT_A_MUTATION: compiles the supplied query unchanged without adding tables or predicates.',
  'kysely.ts#existsGuard':
    'NOT_A_MUTATION: wraps a supplied query in EXISTS without adding tables or organization predicates.',
  'kysely.ts#assertCheck':
    'NOT_A_MUTATION: wraps a supplied predicate in a constraint check without adding organization SQL.',
  'internal/catalogue-write-guard.ts#registerCatalogueWriteGuard':
    'NOT_A_MUTATION: brands supplied statements and records their organization in a WeakMap without building SQL.',
  'internal/catalogue-write-guard.ts#assertCatalogueWriteGuard':
    'NOT_A_MUTATION: checks the WeakMap brand and organization without building SQL.',
};

/** Problems between the exported builders of the given repository sources, the table and the allowlist. */
export function checkCompleteness(
  sources: Readonly<Record<string, string>>,
  table: readonly MutationEntry[],
  allowlist: Readonly<Record<string, string>> = builderAllowlist,
  statuses: typeof packetStatuses = packetStatuses,
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
      !/^NOT_A_MUTATION: .+/.test(reason) &&
      !/^REDUNDANT_BY_SCHEMA: .*(?:FOREIGN KEY|PRIMARY KEY|UNIQUE|CHECK)/.test(reason) &&
      !/^DEFERRED: .+; owner T\d+\w*(?: .+)?$/.test(reason)
    ) {
      problems.push(
        `${key} needs a no-mutation reason, schema constraint or deferred reason and owner packet`,
      );
    }
    if (reason.startsWith('DEFERRED:')) {
      const owner = /; owner (T\d+\w*)(?: .+)?$/.exec(reason)?.[1];
      if (owner !== undefined && statuses[owner] !== 'open') {
        problems.push(
          `${key} deferred owner ${owner} is ${statuses[owner] ?? 'unknown'}; an open packet is required`,
        );
      }
    }
  }
  return problems;
}
