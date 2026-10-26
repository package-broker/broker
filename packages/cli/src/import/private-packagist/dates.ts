import { createHash } from 'node:crypto';
import {
  canonicalManifest,
  MAX_MANIFEST_BYTES,
  MAX_MANIFEST_ITEMS,
  parseManifest,
  planHash,
  type ParsedManifest,
} from '@package-broker/core/import/manifest';
import { MapError, object, parsePackagistMap } from './map.js';
import { Refusal, repository, type PlanDiagnostic } from './plan.js';
import { canonical } from './snapshot.js';

type Row = Record<string, unknown>;
type Override = Extract<ParsedManifest['items'][number], { type: 'version_override' }>;
export interface PrivatePackagistDatesInput {
  readonly snapshot: unknown;
  readonly map: unknown;
  readonly baseline: unknown;
  readonly packages?: readonly string[];
}
export interface DatesSummary {
  overrides: number;
  missingReleasedAt: number;
}
export type PrivatePackagistDatesResult =
  | {
      readonly ok: false;
      readonly diagnostics: readonly (PlanDiagnostic & { readonly selector?: string })[];
      readonly summary: DatesSummary;
    }
  | {
      readonly ok: true;
      readonly diagnostics: readonly (PlanDiagnostic & { readonly selector?: string })[];
      readonly summary: DatesSummary;
      readonly manifest: ParsedManifest;
      readonly canonical: string;
      readonly hash: string;
    };

function refuse(code: string, pointer = '', cap?: string): never {
  throw new Refusal(code, pointer, cap);
}
function json(value: unknown, code: string): unknown {
  try {
    return typeof value === 'string' ? JSON.parse(value) : value;
  } catch {
    return refuse(code);
  }
}
const hash = (...parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex');

export async function planPrivatePackagistDates(
  input: PrivatePackagistDatesInput,
): Promise<PrivatePackagistDatesResult> {
  const summary: DatesSummary = { overrides: 0, missingReleasedAt: 0 };
  try {
    const snapshot = json(input.snapshot, 'invalid_snapshot');
    if (!object(snapshot)) refuse('invalid_snapshot');
    if (snapshot.versions !== true) refuse('versions_missing', '/versions');
    if (
      snapshot.version !== 1 ||
      typeof snapshot.org !== 'string' ||
      typeof snapshot.fetchedAt !== 'string' ||
      !object(snapshot.objects)
    )
      refuse('invalid_snapshot');
    const rows = new Map<string, Row[]>();
    for (const [kind, entries] of Object.entries(snapshot.objects)) {
      if (!Array.isArray(entries)) refuse('invalid_snapshot');
      rows.set(
        kind,
        entries.map((entry: unknown) => {
          if (
            !object(entry) ||
            !object(entry.data) ||
            entry.sha256 !== createHash('sha256').update(canonical(entry.data)).digest('hex')
          )
            refuse('invalid_snapshot', '/objects');
          return entry.data;
        }),
      );
    }
    const map = parsePackagistMap(input.map);
    const baseline = parseManifest(json(input.baseline, 'invalid_baseline'));
    if (!baseline.ok || baseline.data.source_system !== 'private-packagist')
      refuse('invalid_baseline', '/baseline');
    const sources = new Map(
      baseline.data.items.flatMap((item) =>
        item.type === 'source' &&
        item.source_type === 'vcs' &&
        item.ecosystem === 'composer' &&
        item.project === null
          ? [[item.external_ref, item] as const]
          : [],
      ),
    );
    const packages = new Map<number, Row>();
    for (const kind of ['packages', 'suborganizationPackages']) {
      for (const [i, pkg] of (rows.get(kind) ?? []).entries()) {
        const pointer = `/objects/${kind}/${i}`;
        if (
          typeof pkg.id !== 'number' ||
          !Number.isSafeInteger(pkg.id) ||
          pkg.id <= 0 ||
          typeof pkg.name !== 'string' ||
          !object(pkg.config)
        )
          refuse('invalid_snapshot', pointer);
        const old = packages.get(pkg.id);
        if (old && (old.name !== pkg.name || old.origin !== pkg.origin))
          refuse('invalid_snapshot', pointer);
        if (old && pkg.origin === 'private') {
          const mapped = Object.hasOwn(map.packages, pkg.name) ? map.packages[pkg.name] : undefined;
          const previous = repository(mapped?.url ?? (old.config as Row).url, pointer, true);
          if (previous !== repository(mapped?.url ?? pkg.config.url, pointer, true))
            refuse('conflicting_source', pointer);
        }
        packages.set(pkg.id, pkg);
      }
    }
    const selected =
      input.packages === undefined || input.packages.length === 0 ? null : new Set(input.packages);
    const privateNames = new Set(
      [...packages.values()].filter((pkg) => pkg.origin === 'private').map((pkg) => pkg.name),
    );
    for (const [index, selector] of (input.packages ?? []).entries()) {
      if (!privateNames.has(selector))
        return {
          ok: false,
          diagnostics: [
            { code: 'unknown_package', pointer: `/options/packages/${index}`, selector },
          ],
          summary,
        };
    }
    const items = new Map<string, Override>();
    const missing = new Set<string>();
    const detailed = new Set<number>();
    for (const [i, detail] of (rows.get('packageDetails') ?? []).entries()) {
      const pointer = `/objects/packageDetails/${i}/data`;
      const pkg = packages.get(detail.id as number);
      if (!pkg || !Array.isArray(detail.versions)) refuse('invalid_snapshot', pointer);
      detailed.add(detail.id as number);
      if (selected !== null && !selected.has(pkg.name as string)) continue;
      if (
        ['private-mirror', 'private-proxy', 'public-mirror', 'public-proxy'].includes(
          String(pkg.origin),
        )
      )
        continue;
      if (pkg.origin !== 'private') refuse('unsupported_package_origin', pointer);
      const name = pkg.name as string;
      const config = pkg.config as Row;
      const mapped = Object.hasOwn(map.packages, name) ? map.packages[name] : undefined;
      const url = repository(mapped?.url ?? config.url, pointer, true);
      const identity = [url, name];
      const source = sources.get(`pp:source:${hash('pp-source-v1', identity)}`);
      if (!source) refuse('incomplete_baseline', pointer);
      for (const [j, version] of detail.versions.entries()) {
        const path = `${pointer}/versions/${j}`;
        if (!object(version) || typeof version.version !== 'string')
          refuse('invalid_snapshot', path);
        if (!/^[0-9A-Za-z][0-9A-Za-z.+_~/-]{0,255}$/.test(version.version))
          refuse('invalid_version', `${path}/version`);
        const external_ref = `pp:version:${hash('pp-version-v1', identity, name, version.version)}`;
        if (version.releasedAt === null || version.releasedAt === undefined) {
          missing.add(external_ref);
          continue;
        }
        if (
          typeof version.releasedAt !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
            version.releasedAt,
          )
        )
          refuse('invalid_released_at', `${path}/releasedAt`);
        const time = Date.parse(version.releasedAt);
        if (!Number.isFinite(time) || time < 0) refuse('invalid_released_at', `${path}/releasedAt`);
        const localTime = Date.parse(version.releasedAt.replace(/(?:Z|[+-]\d{2}:\d{2})$/, 'Z'));
        if (
          !Number.isFinite(localTime) ||
          new Date(localTime).toISOString().slice(0, 19) !== version.releasedAt.slice(0, 19)
        )
          refuse('invalid_released_at', `${path}/releasedAt`);
        const item: Override = {
          type: 'version_override',
          external_ref,
          source: { existing: { project: null, name: source.name } },
          package: name,
          version: version.version,
          published_at: new Date(time).toISOString(),
          basis: 'source_release',
        };
        const previous = items.get(external_ref);
        if (previous && previous.published_at !== item.published_at)
          refuse('conflicting_release_date', path);
        items.set(external_ref, item);
        if (items.size > MAX_MANIFEST_ITEMS)
          refuse('single_run_limit_exceeded', '', 'MAX_MANIFEST_ITEMS');
      }
    }
    for (const [id, pkg] of packages) {
      if (
        pkg.origin === 'private' &&
        (selected === null || selected.has(pkg.name as string)) &&
        !detailed.has(id)
      )
        refuse('invalid_snapshot', '/objects/packageDetails');
    }
    summary.overrides = items.size;
    summary.missingReleasedAt = missing.size;
    const parsed = parseManifest({
      version: 1,
      source_system: 'private-packagist',
      items: [...items.values()],
      widening: [],
    });
    if (!parsed.ok) refuse('manifest_invalid', parsed.details[0]?.path ?? '');
    const bytes = canonicalManifest(parsed.data);
    if (Buffer.byteLength(bytes) > MAX_MANIFEST_BYTES)
      refuse('single_run_limit_exceeded', '', 'MAX_MANIFEST_BYTES');
    return {
      ok: true,
      diagnostics: [],
      summary,
      manifest: parsed.data,
      canonical: bytes,
      hash: await planHash(parsed.data),
    };
  } catch (error) {
    const diagnostic: PlanDiagnostic =
      error instanceof Refusal
        ? {
            code: error.code,
            pointer: error.pointer,
            ...(error.cap === undefined ? {} : { cap: error.cap }),
          }
        : error instanceof MapError
          ? { code: 'invalid_map', pointer: error.pointer }
          : { code: 'invalid_snapshot', pointer: '' };
    return { ok: false, diagnostics: [diagnostic], summary };
  }
}
