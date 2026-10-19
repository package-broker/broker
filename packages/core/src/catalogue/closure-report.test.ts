import { describe, expect, it, vi } from 'vitest';
import type { ProjectActor } from '../authz/project-actor.js';
import type { CatalogueReader, EdgeRow, KeyClass } from '../db/catalogue.js';
import { orgContext } from '../db/port.js';
import { fixedClock } from '../ids.js';
import { buildClosureReport } from './closure-report.js';

const ctx = orgContext('org-a');
const actor: ProjectActor = {
  kind: 'project',
  userId: 'user',
  orgId: ctx.orgId,
  projectId: 'project-a',
  permissions: new Set(['project:packages:read', 'project:sources:read', 'org:sources:read']),
};
const clock = fixedClock('2026-10-19T00:00:00.000Z');
const row = (deps: object | null, ecosystem = 'npm'): EdgeRow => ({
  requirerKey: ecosystem === 'npm' ? 'root' : 'vendor/root',
  versionId: 'v1',
  version: '1.0.0',
  deps: deps === null ? null : JSON.stringify(deps),
});
function setup(rows: EdgeRow[] = [], status: KeyClass = 'not_available') {
  const reader = {
    listVisible: vi.fn(async () => ({ items: [], next: null, openNamespace: false })),
    pageEdges: vi.fn<CatalogueReader['pageEdges']>(async () => ({ rows, next: null })),
    classify: vi.fn(async (_ctx, query) =>
      query.keys.map((key: string) => ({ key, class: status })),
    ),
  } satisfies Pick<CatalogueReader, 'listVisible' | 'pageEdges' | 'classify'>;
  const run = (permissions: ReadonlySet<string> = new Set()) =>
    buildClosureReport(reader, actor, permissions, 'npm', clock);
  return { reader, run };
}

describe('buildClosureReport', () => {
  it('refuses missing read authority before any reader call', async () => {
    const { reader } = setup();
    await expect(
      buildClosureReport(reader, { ...actor, permissions: new Set() }, new Set(), 'npm', clock),
    ).rejects.toThrow('forbidden');
    for (const method of Object.values(reader)) expect(method).not.toHaveBeenCalled();
  });

  it('uses only organization permissions for all classifications', async () => {
    const { reader, run } = setup([row({ dependencies: { missing: '^1' } })], 'attachable');
    expect((await run()).missing[0]?.status).toBe('not_available');
    expect(reader.classify).not.toHaveBeenCalled();
    expect((await run(new Set(['org:sources:read']))).missing[0]?.status).toBe('attachable');
  });

  it.each(['proxy_admissible', 'attachable', 'not_available'] as const)(
    'collapses %s to byte-identical absence without organization authority',
    async (status) => {
      const rows = [row({ dependencies: { missing: '^1' } })];
      const actual = await setup(rows, status).run();
      const absent = await setup(rows).run();
      expect(JSON.stringify(actual.missing[0])).toBe(JSON.stringify(absent.missing[0]));
      expect(JSON.stringify(actual)).toBe(JSON.stringify(absent));
    },
  );

  it('distinguishes proxy admission and another project’s private source for organization readers', async () => {
    const { reader, run } = setup([row({ dependencies: { fetchable: '^1', private: '^1' } })]);
    reader.classify.mockImplementation(async (_ctx, query) =>
      query.keys.map((key: string) => ({
        key,
        class: key === 'fetchable' ? 'proxy_admissible' : 'not_available',
      })),
    );
    expect(
      (await run(new Set(['org:sources:read']))).missing.map(({ name, status }) => ({
        name,
        status,
      })),
    ).toEqual([
      { name: 'fetchable', status: 'proxy_admissible' },
      { name: 'private', status: 'not_available' },
    ]);
  });

  it('pages visible keys including empty packages, and scopes every read to the actor', async () => {
    const reader: Pick<CatalogueReader, 'listVisible' | 'pageEdges' | 'classify'> = {
      listVisible: vi.fn(async (_ctx, query) => ({
        items: [
          { key: query.after ? 'empty' : 'root', packageId: 'p', sourceId: 's', description: null },
        ],
        next: query.after ? null : 'root',
        openNamespace: false,
      })),
      pageEdges: vi.fn(async () => ({
        rows: [row({ dependencies: { empty: '^1' } })],
        next: null,
      })),
      classify: vi.fn(async () => []),
    };
    const report = await buildClosureReport(reader, actor, new Set(), 'npm', clock);
    expect(report).toMatchObject({
      projectId: 'project-a',
      ecosystem: 'npm',
      generatedAt: clock.now().toISOString(),
      scannedPackages: 2,
      scannedVersions: 1,
      missing: [],
      truncated: false,
    });
    expect(reader.listVisible).toHaveBeenNthCalledWith(2, ctx, {
      projectId: 'project-a',
      ecosystem: 'npm',
      limit: 200,
      after: 'root',
    });
    expect(reader.pageEdges).toHaveBeenCalledWith(ctx, {
      projectId: 'project-a',
      ecosystem: 'npm',
      limit: 200,
    });
  });

  it.each([19999, 20000, 20001])('bounds the version scan at %i rows', async (total) => {
    const { reader, run } = setup();
    let offset = 0;
    reader.pageEdges.mockImplementation(async () => {
      const count = Math.min(200, total - offset);
      offset += count;
      return {
        rows: Array.from({ length: count }, () => row(null)),
        next: offset < total ? { requirerKey: 'root', versionId: String(offset) } : null,
      };
    });
    const report = await run();
    expect(report.scannedVersions).toBe(Math.min(total, 20000));
    expect(report.truncated).toBe(total >= 20000);
    expect(offset).toBe(Math.min(total, 20000));
    expect(reader.pageEdges).toHaveBeenNthCalledWith(2, ctx, {
      projectId: 'project-a',
      ecosystem: 'npm',
      limit: 200,
      after: { requirerKey: 'root', versionId: '200' },
    });
  });

  it('caps sorted missing names and classifies at most 1000 keys', async () => {
    const dependencies = Object.fromEntries(
      Array.from({ length: 1001 }, (_, i) => [`dep${String(i).padStart(4, '0')}`, '*']),
    );
    const { reader, run } = setup([row({ dependencies })], 'attachable');
    const report = await run(new Set(['org:sources:read']));
    expect(report.missing).toHaveLength(1000);
    expect(report.truncated).toBe(true);
    expect(reader.classify).toHaveBeenCalledTimes(1);
    expect(reader.classify.mock.calls[0]?.[1].keys).toHaveLength(1000);
  });

  it('parses Composer require maps and counts unresolvable npm specs without naming them', async () => {
    const composer = setup([row({ php: '^8', 'vendor/dep': '^1' }, 'composer')]);
    const report = await buildClosureReport(composer.reader, actor, new Set(), 'composer', clock);
    expect(report.missing.map(({ name }) => name)).toEqual(['vendor/dep']);
    const npm = await setup([
      row({
        dependencies: { alias: 'npm:real@^1', local: 'file:../secret' },
        devDependencies: { dev: '*' },
      }),
    ]).run();
    expect(npm.missing.map(({ name }) => name)).toEqual(['real']);
    expect(npm.unresolvableSpecs).toBe(1);
  });
});
