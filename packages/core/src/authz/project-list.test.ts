import { describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../auth/primitives.js';
import { orgContext } from '../db/port.js';
import { createKeyring } from '../secrets/keyring.js';
import type { ActorContext } from './administration.js';
import { createAuthorizationEngine, patValidationGate } from './engine.js';
import type { EngineAccessPort } from './engine.js';
import {
  PROJECT_LIST_MAX_LIMIT,
  createProjectLister,
  type ProjectListEntry,
  type ProjectListSource,
  type ProjectReadAccess,
  type ReadableProjectSource,
} from './project-list.js';

const ctx = orgContext('org-a');
const ORIGIN = 'https://broker.test';
const SESSION_SECRET = 'A'.repeat(43);
const ULID_PREFIX = '01J00000000000000000';

function idOf(n: number): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  return `${ULID_PREFIX}${[5, 4, 3, 2, 1, 0].map((p) => alphabet[Math.floor(n / 32 ** p) % 32]).join('')}`;
}

function entry(n: number, status: 'active' | 'archived' = 'active'): ProjectListEntry {
  return { id: idOf(n), slug: `p${n}`, name: `Project ${n}`, status, revision: 1 };
}

interface World {
  readonly projects: readonly ProjectListEntry[];
  readonly organizationPermissions: readonly string[];
  readonly projectPermissions: Readonly<Record<string, readonly string[]>>;
}

function world(init: Partial<World> & Pick<World, 'projects'>): World {
  return { organizationPermissions: [], projectPermissions: {}, ...init };
}

function actorOf(w: World, isOrganizationAdmin = false): ActorContext {
  return {
    kind: 'organization',
    userId: 'u1',
    permissions: new Set(w.organizationPermissions),
    isOrganizationAdmin,
  };
}

function readable(n: number[]): Record<string, string[]> {
  return Object.fromEntries(n.map((i) => [idOf(i), ['project:read']]));
}

function setup(w: World, sourceRows: readonly (ProjectListEntry & object)[] = w.projects) {
  const list = vi.fn<ProjectListSource['list']>(async (_ctx, page) =>
    sourceRows
      .filter((p) => (page.afterId === undefined ? true : p.id > page.afterId))
      .filter((p) => p.status === page.status)
      .filter((p) => page.ids === undefined || page.ids.includes(p.id))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
      .slice(0, page.limit),
  );
  const source: ProjectListSource = { list };
  const permissionsFor = vi.fn<ProjectReadAccess['permissionsFor']>(async (_ctx, _user, ids) => {
    const map = new Map<string, ReadonlySet<string>>();
    for (const id of ids) {
      const granted = w.projectPermissions[id];
      if (granted !== undefined) map.set(id, new Set(granted));
    }
    return map;
  });
  const access: ProjectReadAccess = { permissionsFor };
  const listReadableProjects = vi.fn<ReadableProjectSource['listReadableProjects']>(
    async (_ctx, _actor, page) =>
      sourceRows
        .filter((p) => page.afterId === undefined || p.id > page.afterId)
        .filter((p) => p.status === page.status)
        .filter((p) => page.ids === undefined || page.ids.includes(p.id))
        .filter((p) => (w.projectPermissions[p.id] ?? []).includes('project:read'))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, page.limit),
  );
  const readableSource = { listReadableProjects };
  return {
    source,
    access,
    list,
    permissionsFor,
    listReadableProjects,
    lister: createProjectLister({ source, access, readable: readableSource }),
  };
}

function engineFor(w: World) {
  const port: EngineAccessPort = {
    lookupSession: async (_ctx, input) => {
      if (input.secretHash !== (await sha256Hex(SESSION_SECRET))) return null;
      const project =
        input.boundary === 'project'
          ? (w.projects.find((p) => p.slug === input.projectSlug && p.status === 'active') ?? null)
          : null;
      return {
        session: { id: 's1', csrfHash: 'x' },
        protectedHolder: false,
        user: { id: 'u1' },
        identity: null,
        project: project === null ? null : { id: project.id },
        organizationPermissions: w.organizationPermissions,
        projectPermissions: project === null ? [] : (w.projectPermissions[project.id] ?? []),
      };
    },
    touchSession: async () => true,
    touchToken: async () => true,
    lookupToken: async () => null,
  };
  return createAuthorizationEngine({
    access: port,
    tokenUse: {
      keyring: createKeyring([{ version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i) }]),
      nowMs: () => Date.parse('2026-10-16T12:00:00.000Z'),
      dispatch: (run) => void run(),
      log: () => undefined,
    },
    patValidation: patValidationGate,
    publicOrigin: ORIGIN,
    providerAnchors: async () => [],
  });
}

async function engineAllows(w: World, slug: string): Promise<boolean> {
  const decision = await engineFor(w).authorize({
    request: new Request(`${ORIGIN}/_pb/projects/${slug}`, {
      headers: { cookie: `__Host-pb_session=${SESSION_SECRET}` },
    }),
    org: ctx,
    route: {
      plugin: 'core',
      method: 'GET',
      path: '/_pb/projects/:project',
      permission: 'project:read',
      boundary: 'project',
    },
    params: { project: slug },
  });
  return decision.allow;
}

function range(count: number): ProjectListEntry[] {
  return Array.from({ length: count }, (_, i) => entry(i + 1));
}

async function ids(
  lister: ReturnType<typeof setup>['lister'],
  actor: ActorContext,
  request: Parameters<ReturnType<typeof setup>['lister']['list']>[2],
): Promise<string[]> {
  const result = await lister.list(ctx, actor, request);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.value.items.map((p) => p.id);
}

describe('project list against the access engine', () => {
  const cases: [string, Partial<World>][] = [
    [
      'project grants only',
      { projectPermissions: { ...readable([2, 5]), [idOf(3)]: ['project:write'] } },
    ],
    ['an organization project:read', { organizationPermissions: ['project:read'] }],
    ['an organization grant without project:read', { organizationPermissions: ['org:read'] }],
    [
      'organization project:write plus one project:read',
      { organizationPermissions: ['project:write'], projectPermissions: readable([4]) },
    ],
    ['no grants', {}],
  ];

  it.each(cases)('matches the engine per project with %s', async (_name, extra) => {
    const w = world({ projects: [...range(6), entry(7, 'archived')], ...extra });
    const expected: string[] = [];
    for (const p of w.projects) if (await engineAllows(w, p.slug)) expected.push(p.id);
    const { lister } = setup(w);
    expect(await ids(lister, actorOf(w), { limit: 50 })).toEqual(expected);
  });

  it('a project-only grant adds exactly one project', async () => {
    const base = world({ projects: range(4) });
    const granted = world({ projects: range(4), projectPermissions: readable([3]) });
    expect(await ids(setup(base).lister, actorOf(base), { limit: 10 })).toEqual([]);
    expect(await ids(setup(granted).lister, actorOf(granted), { limit: 10 })).toEqual([idOf(3)]);
    expect(await engineAllows(granted, 'p3')).toBe(true);
  });
});

describe('admin and archived projects', () => {
  const adminWorld = world({
    projects: [entry(1), entry(2), entry(3, 'archived')],
    organizationPermissions: ['project:read', 'org:projects:archive'],
  });

  it('lists active projects by default and skips the per-project lookup when project:read is inherited', async () => {
    const { lister, permissionsFor } = setup(adminWorld);
    expect(await ids(lister, actorOf(adminWorld, true), { limit: 10 })).toEqual([idOf(1), idOf(2)]);
    expect(permissionsFor).not.toHaveBeenCalled();
  });

  it('passes the limit straight through when project:read is inherited', async () => {
    const { lister, list } = setup(adminWorld);
    await lister.list(ctx, actorOf(adminWorld, true), { limit: 7 });
    expect(list.mock.calls[0]?.[1].limit).toBe(7);
  });

  it('lists archived projects for an admin only on request', async () => {
    const { lister } = setup(adminWorld);
    expect(await ids(lister, actorOf(adminWorld, true), { limit: 10, status: 'archived' })).toEqual(
      [idOf(3)],
    );
  });

  it('does not let an admin flag replace project:read', async () => {
    const w = world({
      projects: range(2),
      organizationPermissions: ['org:projects:archive'],
      projectPermissions: readable([2]),
    });
    expect(await ids(setup(w).lister, actorOf(w, true), { limit: 10 })).toEqual([idOf(2)]);
  });

  it('refuses archived for a non-admin, even with project:read, without reading', async () => {
    const w = world({
      projects: [entry(1, 'archived')],
      organizationPermissions: ['project:read'],
    });
    const { lister, list } = setup(w);
    expect(await lister.list(ctx, actorOf(w), { limit: 10, status: 'archived' })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(list).not.toHaveBeenCalled();
  });

  it('treats a forged admin flag as non-admin', async () => {
    const w = world({ projects: range(1), organizationPermissions: ['project:read'] });
    const forged = { ...actorOf(w), isOrganizationAdmin: 'yes' } as unknown as ActorContext;
    const result = await setup(w).lister.list(ctx, forged, { limit: 10, status: 'archived' });
    expect(result).toEqual({ ok: false, error: 'forbidden' });
  });

  it('refuses an actor that is not an object with a user id', async () => {
    const { lister } = setup(world({ projects: range(1) }));
    expect(await lister.list(ctx, null as unknown as ActorContext, { limit: 10 })).toEqual({
      ok: false,
      error: 'forbidden',
    });
  });

  it('filters by status', async () => {
    const w = world({
      projects: [entry(1), entry(2, 'archived'), entry(3)],
      organizationPermissions: ['project:read'],
    });
    const { lister } = setup(w);
    expect(await ids(lister, actorOf(w, true), { limit: 10, status: 'active' })).toEqual([
      idOf(1),
      idOf(3),
    ]);
    const result = await lister.list(ctx, actorOf(w, true), {
      limit: 10,
      status: 'deleted' as unknown as 'active',
    });
    expect(result).toEqual({ ok: false, error: 'invalid_status' });
  });
});

describe('limits and cursors', () => {
  const open = world({ projects: range(3), organizationPermissions: ['project:read'] });

  it.each([0, -1, 201, 1.5, Number.NaN, '5' as unknown as number])(
    'refuses limit %s instead of clamping',
    async (limit) => {
      const { lister, list } = setup(open);
      expect(await lister.list(ctx, actorOf(open), { limit })).toEqual({
        ok: false,
        error: 'invalid_limit',
      });
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('accepts the bounds 1 and 200', async () => {
    const { lister } = setup(open);
    expect((await lister.list(ctx, actorOf(open), { limit: 1 })).ok).toBe(true);
    expect((await lister.list(ctx, actorOf(open), { limit: PROJECT_LIST_MAX_LIMIT })).ok).toBe(
      true,
    );
    expect(PROJECT_LIST_MAX_LIMIT).toBe(200);
  });

  it.each(['', 'not-a-ulid', idOf(1).toLowerCase(), `${idOf(1)}0`, 5 as unknown as string])(
    'refuses cursor %s instead of ignoring it',
    async (afterId) => {
      const { lister, list } = setup(open);
      expect(await lister.list(ctx, actorOf(open), { limit: 10, afterId })).toEqual({
        ok: false,
        error: 'invalid_cursor',
      });
      expect(list).not.toHaveBeenCalled();
    },
  );

  it('accepts a cursor that points at a hidden or archived project', async () => {
    const w = world({
      projects: [entry(1), entry(2, 'archived'), entry(3), entry(4)],
      projectPermissions: readable([3, 4]),
    });
    const { lister } = setup(w);
    expect(await ids(lister, actorOf(w), { limit: 10, afterId: idOf(2) })).toEqual([
      idOf(3),
      idOf(4),
    ]);
    expect(await ids(lister, actorOf(w), { limit: 10, afterId: idOf(1) })).toEqual([
      idOf(3),
      idOf(4),
    ]);
  });
});

describe('paging', () => {
  it('pages in id order, fills across hidden projects and ends with a null cursor', async () => {
    const w = world({ projects: range(10), projectPermissions: readable([2, 4, 6, 8, 10]) });
    const { lister } = setup(w);
    const seen: string[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await lister.list(ctx, actorOf(w), {
        limit: 2,
        ...(afterId === undefined ? {} : { afterId }),
      });
      if (!result.ok) throw new Error(result.error);
      seen.push(...result.value.items.map((p) => p.id));
      if (result.value.nextAfterId === null) break;
      expect(result.value.nextAfterId).toBe(result.value.items.at(-1)?.id);
      afterId = result.value.nextAfterId;
    }
    expect(seen).toEqual([2, 4, 6, 8, 10].map(idOf));
  });

  it('returns a null cursor when everything fits', async () => {
    const w = world({ projects: range(2), organizationPermissions: ['project:read'] });
    const result = await setup(w).lister.list(ctx, actorOf(w), { limit: 5 });
    expect(result.ok && result.value.nextAfterId).toBeNull();
  });

  it('reads sparse grants in one query', async () => {
    const w = world({
      projects: range(450),
      projectPermissions: readable([199, 200, 201, 202, 450]),
    });
    const { lister, listReadableProjects } = setup(w);
    expect(await ids(lister, actorOf(w), { limit: 10 })).toEqual(
      [199, 200, 201, 202, 450].map(idOf),
    );
    expect(listReadableProjects).toHaveBeenCalledTimes(1);
  });

  it('keeps hidden rows at the batch boundary out of the page and the cursor', async () => {
    const w = world({ projects: range(450), projectPermissions: readable([200, 201]) });
    const { lister } = setup(w);
    const result = await lister.list(ctx, actorOf(w), { limit: 1 });
    expect(result.ok && result.value.items.map((p) => p.id)).toEqual([idOf(200)]);
    expect(result.ok && result.value.nextAfterId).toBe(idOf(200));
  });

  it('never exposes a hidden id after 10,050 hidden projects', async () => {
    const total = 10_050;
    const w = world({ projects: range(total), projectPermissions: readable([total]) });
    const { lister, list, listReadableProjects } = setup(w);
    const result = await lister.list(ctx, actorOf(w), { limit: 1 });
    expect(result).toEqual({
      ok: true,
      value: { items: [entry(total)], nextAfterId: idOf(total) },
    });
    expect(list).not.toHaveBeenCalled();
    expect(listReadableProjects).toHaveBeenCalledTimes(1);
  });

  it('returns a final short page for sparse grants', async () => {
    const w = world({ projects: range(3000), projectPermissions: readable([5]) });
    const result = await setup(w).lister.list(ctx, actorOf(w), { limit: 3 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.items.map((p) => p.id)).toEqual([idOf(5)]);
    expect(result.value.nextAfterId).toBeNull();
  });
});

describe('prefix validation', () => {
  it.each(['', '%', '_', 'name%', 'name_', 'x'.repeat(201), '\u0000', 1, null])(
    'rejects %j before querying',
    async (q) => {
      const w = world({ projects: range(1), organizationPermissions: ['project:read'] });
      const f = setup(w);
      expect(await f.lister.list(ctx, actorOf(w), { limit: 5, q: q as string })).toEqual({
        ok: false,
        error: 'invalid_query',
      });
      expect(f.list).not.toHaveBeenCalled();
      expect(f.listReadableProjects).not.toHaveBeenCalled();
    },
  );
});

describe('item shape and wiring', () => {
  it('returns only id, slug, name, status and revision', async () => {
    const w = world({ projects: range(1), organizationPermissions: ['project:read'] });
    const rows = [
      { ...entry(1), tokenMaxScope: 'full', requirePublishApproval: true, revision: 4 },
    ] as unknown as ProjectListEntry[];
    const result = await setup(w, rows).lister.list(ctx, actorOf(w), { limit: 5 });
    expect(result.ok && result.value.items).toEqual([{ ...entry(1), revision: 4 }]);
    expect(result.ok && Object.keys(result.value.items[0] ?? {}).sort()).toEqual([
      'id',
      'name',
      'revision',
      'slug',
      'status',
    ]);
  });

  it('drops a project the access port omits', async () => {
    const w = world({ projects: range(2) });
    const { source } = setup(w);
    const lister = createProjectLister({
      source,
      readable: { listReadableProjects: async () => [] },
    });
    expect(await ids(lister, actorOf(w), { limit: 10 })).toEqual([]);
  });

  it('refuses to be built without its ports', () => {
    expect(() => createProjectLister({} as never)).toThrow(TypeError);
  });
});

function readableSetup(w: World) {
  const base = setup(w);
  const listReadableProjects = vi.fn<ReadableProjectSource['listReadableProjects']>(
    async (_ctx, _actor, page) =>
      w.projects
        .filter((p) => (page.afterId === undefined ? true : p.id > page.afterId))
        .filter((p) => p.status === page.status)
        .filter((p) => page.ids === undefined || page.ids.includes(p.id))
        .filter((p) => (w.projectPermissions[p.id] ?? []).includes('project:read'))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .slice(0, page.limit),
  );
  const readable: ReadableProjectSource = { listReadableProjects };
  return {
    ...base,
    listReadableProjects,
    lister: createProjectLister({ source: base.source, readable }),
  };
}

describe('readable-projects source', () => {
  it('finds a readable project behind 10,050 hidden ones with one read and no scan', async () => {
    const total = 10_051;
    const w = world({ projects: range(total), projectPermissions: readable([10_041]) });
    const { lister, list, permissionsFor, listReadableProjects } = readableSetup(w);
    const result = await lister.list(ctx, actorOf(w), { limit: 1 });
    expect(result).toEqual({
      ok: true,
      value: { items: [entry(10_041)], nextAfterId: idOf(10_041) },
    });
    expect(listReadableProjects).toHaveBeenCalledTimes(1);
    expect(listReadableProjects.mock.calls[0]?.[1]).toEqual({ userId: 'u1' });
    expect(listReadableProjects.mock.calls[0]?.[2]).toEqual({ limit: 1, status: 'active' });
    expect(list).not.toHaveBeenCalled();
    expect(permissionsFor).not.toHaveBeenCalled();
    const next = await lister.list(ctx, actorOf(w), { limit: 1, afterId: idOf(10_041) });
    expect(next).toEqual({ ok: true, value: { items: [], nextAfterId: null } });
  });

  it.each([
    [
      'project grants only',
      { projectPermissions: { ...readable([2, 5]), [idOf(3)]: ['project:write'] } },
    ],
    ['an organization grant without project:read', { organizationPermissions: ['org:read'] }],
    [
      'organization project:write plus one project:read',
      { organizationPermissions: ['project:write'], projectPermissions: readable([4]) },
    ],
    ['no grants', {}],
  ] as [string, Partial<World>][])(
    'matches the engine per project with %s',
    async (_name, extra) => {
      const w = world({ projects: [...range(6), entry(7, 'archived')], ...extra });
      const expected: string[] = [];
      for (const p of w.projects) if (await engineAllows(w, p.slug)) expected.push(p.id);
      expect(await ids(readableSetup(w).lister, actorOf(w), { limit: 50 })).toEqual(expected);
    },
  );

  it('keeps the plain source when project:read is inherited from the organization', async () => {
    const w = world({ projects: range(3), organizationPermissions: ['project:read'] });
    const { lister, list, listReadableProjects } = readableSetup(w);
    expect(await ids(lister, actorOf(w), { limit: 10 })).toEqual([1, 2, 3].map(idOf));
    expect(list).toHaveBeenCalledTimes(1);
    expect(listReadableProjects).not.toHaveBeenCalled();
  });

  it('pages with the cursor and ends with a null cursor', async () => {
    const w = world({ projects: range(10), projectPermissions: readable([2, 4, 6, 8, 10]) });
    const { lister, listReadableProjects } = readableSetup(w);
    const seen: string[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const result = await lister.list(ctx, actorOf(w), {
        limit: 2,
        ...(afterId === undefined ? {} : { afterId }),
      });
      if (!result.ok) throw new Error(result.error);
      seen.push(...result.value.items.map((p) => p.id));
      if (result.value.nextAfterId === null) break;
      afterId = result.value.nextAfterId;
    }
    expect(seen).toEqual([2, 4, 6, 8, 10].map(idOf));
    expect(listReadableProjects.mock.calls[1]?.[2]).toEqual({
      afterId: idOf(4),
      limit: 2,
      status: 'active',
    });
  });

  it('passes archived to the source for an admin', async () => {
    const w = world({
      projects: [entry(1), entry(2, 'archived')],
      organizationPermissions: ['org:projects:archive'],
      projectPermissions: readable([1, 2]),
    });
    expect(
      await ids(readableSetup(w).lister, actorOf(w, true), { limit: 10, status: 'archived' }),
    ).toEqual([idOf(2)]);
  });

  it('drops rows of another status, out of order or past the limit', async () => {
    const w = world({ projects: range(4) });
    const { source } = setup(w);
    const lister = createProjectLister({
      source,
      readable: {
        listReadableProjects: async () => [entry(2), entry(1), entry(3, 'archived'), entry(4)],
      },
    });
    expect(await ids(lister, actorOf(w), { limit: 3, afterId: idOf(1) })).toEqual([idOf(2)]);
  });

  it('refuses a full page of which no row survives instead of ending the listing', async () => {
    const w = world({ projects: range(4) });
    const { source } = setup(w);
    const lister = createProjectLister({
      source,
      readable: { listReadableProjects: async () => [entry(1, 'archived'), entry(2, 'archived')] },
    });
    expect(await lister.list(ctx, actorOf(w), { limit: 2 })).toEqual({
      ok: false,
      error: 'source_invalid',
    });
  });

  it('refuses a readable source without its method', () => {
    const { source } = setup(world({ projects: range(1) }));
    expect(() => createProjectLister({ source, readable: {} as never })).toThrow(TypeError);
    expect(() => createProjectLister({ source } as never)).toThrow(TypeError);
  });
});

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('restricted access lookup and readable source agree', () => {
  it.each(Array.from({ length: 40 }, (_, i) => i + 1))(
    'returns equal pages and cursors for random world %i',
    async (seed) => {
      const random = mulberry32(seed * 104_729);
      const count = 1 + Math.floor(random() * 30);
      const projects = Array.from({ length: count }, (_, i) =>
        entry(i + 1, random() < 0.2 ? 'archived' : 'active'),
      );
      const projectPermissions: Record<string, string[]> = {};
      for (const p of projects) {
        const roll = random();
        if (roll < 0.35) projectPermissions[p.id] = ['project:read'];
        else if (roll < 0.5) projectPermissions[p.id] = ['project:write'];
      }
      const w = world({
        projects,
        organizationPermissions: random() < 0.5 ? ['org:read'] : [],
        projectPermissions,
      });
      const fallback = setup(w).lister;
      const viaReadable = readableSetup(w).lister;
      for (const status of ['active', 'archived'] as const) {
        const limit = 1 + Math.floor(random() * 5);
        const actor = actorOf(w, status === 'archived');
        let afterId: string | undefined;
        for (let page = 0; page < 40; page += 1) {
          const request = {
            limit,
            status,
            restrictTo: projects.map((p) => p.id),
            ...(afterId === undefined ? {} : { afterId }),
          };
          const left = await fallback.list(ctx, actor, request);
          const right = await viaReadable.list(ctx, actor, request);
          expect(right).toEqual(left);
          if (!left.ok || left.value.nextAfterId === null) break;
          afterId = left.value.nextAfterId;
        }
      }
    },
  );
});

describe('restricted listing through the read-access port', () => {
  it('lists only bound projects the actor holds a live project:read grant on', async () => {
    const w = world({ projects: range(6), projectPermissions: readable([1, 3, 5]) });
    const { lister, permissionsFor } = setup(w);
    const found = await ids(lister, actorOf(w), {
      limit: 50,
      restrictTo: [idOf(1), idOf(2), idOf(3), idOf(4)],
    });
    expect(found).toEqual([idOf(1), idOf(3)]);
    expect(permissionsFor).toHaveBeenCalled();
  });

  it('lists nothing when the grants are gone, even for bound ids', async () => {
    const w = world({ projects: range(3) });
    const { lister } = setup(w);
    expect(
      await ids(lister, actorOf(w), { limit: 50, restrictTo: range(3).map((p) => p.id) }),
    ).toEqual([]);
  });

  it('ignores a project:write grant', async () => {
    const w = world({ projects: range(2), projectPermissions: { [idOf(1)]: ['project:write'] } });
    const { lister } = setup(w);
    expect(await ids(lister, actorOf(w), { limit: 50, restrictTo: [idOf(1)] })).toEqual([]);
  });

  it('ends with a null cursor when the last bound project fills the page exactly', async () => {
    const w = world({ projects: range(4), projectPermissions: readable([1, 2, 3, 4]) });
    const { lister } = setup(w);
    const result = await lister.list(ctx, actorOf(w), {
      limit: 2,
      restrictTo: [idOf(1), idOf(2)],
    });
    expect(result).toEqual({
      ok: true,
      value: { items: [entry(1), entry(2)], nextAfterId: null },
    });
  });

  it('keeps a cursor while later bound ids remain', async () => {
    const w = world({ projects: range(4), projectPermissions: readable([1, 2, 3]) });
    const { lister } = setup(w);
    const result = await lister.list(ctx, actorOf(w), {
      limit: 2,
      restrictTo: [idOf(1), idOf(2), idOf(3)],
    });
    expect(result).toEqual({
      ok: true,
      value: { items: [entry(1), entry(2)], nextAfterId: idOf(2) },
    });
  });
});

describe('restricted listing through the readable source', () => {
  it('fills 25 grant-readable bindings as 10, 10, 5 and stops', async () => {
    const boundNumbers = Array.from({ length: 25 }, (_, i) => (i + 1) * 200);
    const w = world({ projects: range(5000), projectPermissions: readable(boundNumbers) });
    const { lister } = readableSetup(w);
    let afterId: string | undefined;
    const sizes: number[] = [];
    const seen: string[] = [];
    for (let page = 0; page < 4; page += 1) {
      const result = await lister.list(ctx, actorOf(w), {
        limit: 10,
        restrictTo: boundNumbers.map(idOf),
        ...(afterId === undefined ? {} : { afterId }),
      });
      if (!result.ok) throw new Error(result.error);
      sizes.push(result.value.items.length);
      seen.push(...result.value.items.map((p) => p.id));
      if (result.value.nextAfterId === null) break;
      afterId = result.value.nextAfterId;
    }
    expect(sizes).toEqual([10, 10, 5]);
    expect(seen).toEqual(boundNumbers.map(idOf));
  });

  it('reaches a bound project behind thousands of readable ones in one page', async () => {
    const w = world({
      projects: range(2_500),
      projectPermissions: readable(range(2_500).map((_, i) => i + 1)),
    });
    const { lister, listReadableProjects, list } = readableSetup(w);
    const result = await lister.list(ctx, actorOf(w), { limit: 10, restrictTo: [idOf(2_490)] });
    expect(result).toEqual({ ok: true, value: { items: [entry(2_490)], nextAfterId: null } });
    expect(listReadableProjects.mock.calls.length).toBeLessThanOrEqual(2);
    expect(list).not.toHaveBeenCalled();
  });

  it('returns distant bound projects in one query', async () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const validId = (n: number): string =>
      `${ULID_PREFIX}${[5, 4, 3, 2, 1, 0].map((p) => alphabet[Math.floor(n / 32 ** p) % 32]).join('')}`;
    const total = 5_000;
    const projects = Array.from({ length: total }, (_, i) => ({
      id: validId(i + 1),
      slug: `p${i + 1}`,
      name: `Project ${i + 1}`,
      status: 'active' as const,
      revision: 1,
    }));
    const w = world({
      projects,
      projectPermissions: Object.fromEntries(projects.map((p) => [p.id, ['project:read']])),
    });
    const { lister, listReadableProjects } = readableSetup(w);
    const bound = [validId(1), validId(total)];
    const found: string[] = [];
    let afterId: string | undefined;
    let pages = 0;
    for (; pages < 10; pages += 1) {
      listReadableProjects.mockClear();
      const result = await lister.list(ctx, actorOf(w), {
        limit: 10,
        restrictTo: bound,
        ...(afterId === undefined ? {} : { afterId }),
      });
      if (!result.ok) throw new Error(`refused: ${result.error}`);
      expect(listReadableProjects).toHaveBeenCalledTimes(1);
      found.push(...result.value.items.map((p) => p.id));
      if (result.value.nextAfterId === null) break;
      afterId = result.value.nextAfterId;
    }
    expect(found).toEqual(bound);
    expect(pages).toBe(0);
  });

  it('never hands out an unbound id as a cursor and reaches a far bound id behind a revoked one', async () => {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const validId = (n: number): string =>
      `${ULID_PREFIX}${[5, 4, 3, 2, 1, 0].map((p) => alphabet[Math.floor(n / 32 ** p) % 32]).join('')}`;
    const total = 5_000;
    const projects = Array.from({ length: total }, (_, i) => ({
      id: validId(i + 1),
      slug: `p${i + 1}`,
      name: `Project ${i + 1}`,
      status: 'active' as const,
      revision: 1,
    }));
    const revoked = validId(1);
    const far = validId(total);
    const w = world({
      projects,
      projectPermissions: Object.fromEntries(
        projects.filter((p) => p.id !== revoked).map((p) => [p.id, ['project:read']]),
      ),
    });
    const { lister, listReadableProjects } = readableSetup(w);
    const bound = [revoked, far];
    const found: string[] = [];
    let afterId: string | undefined;
    let sawCursor = false;
    for (let pages = 0; pages < 10; pages += 1) {
      listReadableProjects.mockClear();
      const result = await lister.list(ctx, actorOf(w), {
        limit: 10,
        restrictTo: bound,
        ...(afterId === undefined ? {} : { afterId }),
      });
      if (!result.ok) throw new Error(`refused: ${result.error}`);
      expect(listReadableProjects).toHaveBeenCalledTimes(1);
      found.push(...result.value.items.map((p) => p.id));
      const next = result.value.nextAfterId;
      if (next === null) break;
      sawCursor = true;
      expect(bound).toContain(next);
      expect(next > (afterId ?? '')).toBe(true);
      afterId = next;
    }
    expect(found).toEqual([far]);
    expect(sawCursor || found.length > 0).toBe(true);
  });

  it('exhausts more than ten chunks of invisible bindings without an empty continuation page', async () => {
    const w = world({ projects: range(1000), projectPermissions: readable([1000]) });
    const { lister, listReadableProjects } = readableSetup(w);
    expect(
      await lister.list(ctx, actorOf(w), {
        limit: 10,
        restrictTo: w.projects.map((p) => p.id),
      }),
    ).toEqual({ ok: true, value: { items: [entry(1000)], nextAfterId: null } });
    expect(listReadableProjects).toHaveBeenCalledTimes(20);
    expect(listReadableProjects.mock.calls.every(([, , page]) => page.ids?.length === 50)).toBe(
      true,
    );
  });

  it('never lists a readable project outside the binding', async () => {
    const w = world({ projects: range(5), projectPermissions: readable([1, 2, 3, 4, 5]) });
    const { lister } = readableSetup(w);
    expect(await ids(lister, actorOf(w), { limit: 50, restrictTo: [idOf(2), idOf(4)] })).toEqual([
      idOf(2),
      idOf(4),
    ]);
  });

  it('does not list a bound project the actor cannot read', async () => {
    const w = world({ projects: range(3), projectPermissions: readable([1]) });
    const { lister } = readableSetup(w);
    expect(await ids(lister, actorOf(w), { limit: 50, restrictTo: [idOf(1), idOf(2)] })).toEqual([
      idOf(1),
    ]);
  });

  it('ends with a null cursor when the last bound project fills the page exactly', async () => {
    const w = world({ projects: range(4), projectPermissions: readable([1, 2, 3, 4]) });
    const { lister } = readableSetup(w);
    const result = await lister.list(ctx, actorOf(w), {
      limit: 2,
      restrictTo: [idOf(1), idOf(2)],
    });
    expect(result).toEqual({
      ok: true,
      value: { items: [entry(1), entry(2)], nextAfterId: null },
    });
  });
});
