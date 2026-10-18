import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createAuthModule, type AuthModuleOptions } from '../auth/module.js';
import { fixedClock } from '../ids.js';
import type { RouteDefinition } from '../plugin.js';
import { catalogueDiagnostics, type DiagnosticRoute } from './catalogue-diagnostics.js';
import { DEFAULT_ROLES } from './permissions.js';

const adminRows = DEFAULT_ROLES.find(({ key }) => key === 'organization_admin')!.permissions;
const withResolver = { packageResolver: true };
const withoutResolver = { packageResolver: false };

function route(
  overrides: Partial<Omit<RouteDefinition, 'handler'>> & { readonly plugin?: string },
): DiagnosticRoute {
  return {
    plugin: 'p',
    method: 'GET',
    path: '/x',
    permission: null,
    handler: () => new Response(null),
    ...overrides,
  };
}

const run = (
  overrides: Parameters<typeof route>[0],
  seed: readonly string[] = adminRows,
  options = withResolver,
) => catalogueDiagnostics([route(overrides)], seed, options);

describe('catalogueDiagnostics', () => {
  it('reports nothing for a valid table and seed', () => {
    const routes = [
      route({ path: '/health' }),
      route({ path: '/orgs', permission: 'org:read', boundary: 'organization' }),
      route({ path: '/p/:project', permission: 'project:read', boundary: 'project' }),
      route({ plugin: 'core', path: '/me/tokens', boundary: 'self' }),
    ];
    expect(catalogueDiagnostics(routes, adminRows, withResolver)).toEqual([]);
  });

  it('refuses a self route from a plugin', () => {
    expect(run({ path: '/me', boundary: 'self' }).join('\n')).toMatch(/self boundary.*plugin/);
  });

  it('accepts an authenticated core route and refuses one from a plugin', () => {
    expect(run({ plugin: 'core', path: '/me', boundary: 'authenticated' })).toEqual([]);
    expect(run({ path: '/me', boundary: 'authenticated' }).join('\n')).toMatch(
      /authenticated boundary.*plugin/,
    );
  });

  it('refuses a project:packages:* route without a resolver', () => {
    const problems = run(
      { path: '/p/:project/pkg', permission: 'project:packages:read', boundary: 'project' },
      adminRows,
      withoutResolver,
    );
    expect(problems.join('\n')).toMatch(/package-visibility resolver/);
    expect(
      run({ path: '/p/:project/pkg', permission: 'project:packages:read', boundary: 'project' }),
    ).toEqual([]);
  });

  it('refuses needsOrg false with a permission', () => {
    expect(
      run({ path: '/a', permission: 'org:read', boundary: 'organization', needsOrg: false }).join(
        '\n',
      ),
    ).toMatch(/without organization context must be public/);
  });

  it('reports a non-string permission instead of throwing', () => {
    const problems = run({ path: '/a', permission: 42 as never, boundary: 'organization' });
    expect(problems.join('\n')).toMatch(/permission must be a string or null/);
  });

  it('reports a non-string path instead of throwing', () => {
    expect(() => run({ path: 7 as never, permission: 'org:invented' })).not.toThrow();
  });

  it('reports a seed with an invented or duplicate permission', () => {
    const invented = run({}, [...adminRows, 'org:invented']);
    expect(invented.join('\n')).toMatch(/Unknown permission: "org:invented"/);
    const duplicate = run({}, [...adminRows, 'org:read']);
    expect(duplicate.join('\n')).toMatch(/Duplicate permission: "org:read"/);
  });

  it('reports a seed missing a route permission', () => {
    const seed = adminRows.filter((name) => name !== 'project:read');
    const problems = run(
      { path: '/p/:project', permission: 'project:read', boundary: 'project' },
      seed,
    );
    expect(problems.join('\n')).toMatch(/"project:read" is not in the seeded Organization Admin/);
  });

  it('reports a plugin-invented permission instead of accepting it', () => {
    const problems = run({
      plugin: 'evil',
      path: '/z',
      permission: 'org:invented',
      boundary: 'organization',
    });
    expect(problems.join('\n')).toMatch(/"org:invented" is not in the catalogue/);
  });

  it.each(['/p/:Project', '/p/:projectId', '/p/project'])(
    'does not accept %s as the :project parameter',
    (path) => {
      const problems = run({ path, permission: 'project:read', boundary: 'project' });
      expect(problems.join('\n')).toMatch(/requires :project in the path/);
    },
  );

  it('reports the package boundary with a null permission', () => {
    expect(run({ path: '/a', boundary: 'package' }).join('\n')).toMatch(
      /package boundary is reserved/,
    );
  });

  it('reports a project boundary with an organization permission', () => {
    const problems = run({ path: '/a/:project', permission: 'org:read', boundary: 'project' });
    expect(problems.join('\n')).toMatch(/project boundary requires a project:\* permission/);
  });

  it('is pure: repeated calls are equal and the inputs stay untouched', () => {
    const routes = [route({ path: '/a', permission: 'org:invented' })];
    const seed = [...adminRows];
    const first = catalogueDiagnostics(routes, seed, withResolver);
    expect(catalogueDiagnostics(routes, seed, withResolver)).toEqual(first);
    expect(seed).toEqual([...adminRows]);
  });

  it('reports nothing for the real core route table', () => {
    const unused = new Proxy({}, { get: () => () => Promise.resolve(null) });
    const auth = createAuthModule({
      repositories: unused,
      keyring: unused,
      clock: fixedClock('2026-10-16T00:00:00.000Z'),
      ids: { ulid: () => '01JA0000000000000000000000' },
      publicOrigin: 'https://broker.test',
      providers: new Map(),
      hooks: {},
      log: () => undefined,
    } as unknown as AuthModuleOptions);
    const routes = auth.coreRoutes.map((definition) => ({ ...definition, plugin: 'core' }));
    expect(routes.length).toBeGreaterThan(0);
    expect(catalogueDiagnostics(routes, adminRows, withoutResolver)).toEqual([]);
  });
});

describe('startup role-table probe', () => {
  const sources = [
    './catalogue-diagnostics.ts',
    '../kernel/kernel.ts',
    '../../../runtime-node/src/entry.ts',
    '../../../runtime-node/src/index.ts',
    '../../../runtime-node/src/startup.ts',
    '../../../runtime-cloudflare/src/entry.ts',
    '../../../runtime-cloudflare/src/index.ts',
  ];

  it.each(sources)('%s does not read the role table', (file) => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(from|into|update|join)\s+["'`]?roles?\b/i);
    expect(source).not.toMatch(/createRoleRepository|repositories\/role/);
  });
});
