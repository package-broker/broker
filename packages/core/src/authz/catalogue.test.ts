import { describe, expect, it } from 'vitest';
import type { RouteDefinition } from '../plugin.js';
import {
  catalogueProblems,
  routeDescriptors,
  catalogueTokenEligible,
  tokenAllowedPermissions,
} from './catalogue.js';
import { DEFAULT_ROLES, PERMISSIONS } from './permissions.js';

const adminRows = DEFAULT_ROLES.find(({ key }) => key === 'organization_admin')!.permissions;

function route(
  plugin: string,
  overrides: Partial<Omit<RouteDefinition, 'handler'>>,
): RouteDefinition & { readonly plugin: string } {
  return {
    plugin,
    method: 'GET',
    path: '/x',
    permission: null,
    handler: () => new Response(null),
    ...overrides,
  };
}

const byName = (name: string) => PERMISSIONS.find((info) => info.name === name);

describe('step 5 catalogue additions', () => {
  it('adds the new permissions as session-only', () => {
    expect(byName('project:service-principals:write')).toMatchObject({
      scope: 'project',
      sessionOnly: true,
    });
    expect(byName('org:projects:archive')).toMatchObject({
      scope: 'organization',
      sessionOnly: true,
    });
  });

  it('marks token revocation session-only', () => {
    expect(byName('org:tokens:revoke')!.sessionOnly).toBe(true);
    expect(byName('project:tokens:revoke')!.sessionOnly).toBe(true);
  });

  it('leaves permissions added without a flag session-only', () => {
    for (const name of ['org:projects:archive', 'project:service-principals:write']) {
      expect(byName(name)!.sessionOnly).toBe(true);
    }
  });

  it('grants project service principal management to the Project Owner', () => {
    const owner = DEFAULT_ROLES.find(({ key }) => key === 'project_owner')!;
    expect(owner.permissions).toContain('project:service-principals:write');
  });

  it('marks token reads session-only', () => {
    expect(byName('org:tokens:read')!.sessionOnly).toBe(true);
    expect(byName('project:tokens:read')!.sessionOnly).toBe(true);
  });

  it('keeps every non-session-only permission explicit', () => {
    expect(PERMISSIONS.filter(({ sessionOnly }) => !sessionOnly).map(({ name }) => name)).toEqual([
      'org:read',
      'org:users:read',
      'org:roles:read',
      'org:grants:read',
      'org:sources:read',
      'org:import:write',
      'org:audit:read',
      'project:read',
      'project:grants:read',
      'project:packages:read',
      'project:packages:write',
      'project:sources:read',
      'project:audit:read',
    ]);
  });

  it('denies every session-only permission to a full token and allows the rest', () => {
    for (const info of PERMISSIONS) {
      expect(catalogueTokenEligible(info.name)).toBe(!info.sessionOnly);
    }
    expect(tokenAllowedPermissions()).toEqual(
      PERMISSIONS.filter(({ sessionOnly }) => !sessionOnly).map(({ name }) => name),
    );
  });

  it('denies unknown permissions to tokens', () => {
    expect(catalogueTokenEligible('org:invented')).toBe(false);
    expect(catalogueTokenEligible('')).toBe(false);
  });
});

describe('routeDescriptors', () => {
  it('derives sessionOnly from the catalogue and normalizes the boundary', () => {
    const descriptors = routeDescriptors([
      route('core', {
        method: 'POST',
        path: '/projects/archive',
        permission: 'org:projects:archive',
        boundary: 'organization',
      }),
      route('core', {
        path: '/packages',
        permission: 'project:packages:read',
        boundary: 'project',
      }),
      route('core', { path: '/health' }),
      route('core', { path: '/me', boundary: 'self' }),
    ]);
    expect(descriptors).toEqual([
      {
        plugin: 'core',
        method: 'POST',
        path: '/projects/archive',
        permission: 'org:projects:archive',
        boundary: 'organization',
        sessionOnly: true,
      },
      {
        plugin: 'core',
        method: 'GET',
        path: '/packages',
        permission: 'project:packages:read',
        boundary: 'project',
        sessionOnly: false,
      },
      {
        plugin: 'core',
        method: 'GET',
        path: '/health',
        permission: null,
        boundary: 'none',
        sessionOnly: false,
      },
      {
        plugin: 'core',
        method: 'GET',
        path: '/me',
        permission: null,
        boundary: 'self',
        sessionOnly: true,
      },
    ]);
  });

  it('treats a permission outside the catalogue as session-only', () => {
    const [descriptor] = routeDescriptors([
      route('p', { permission: 'org:invented', boundary: 'organization' }),
    ]);
    expect(descriptor).toMatchObject({ permission: 'org:invented', sessionOnly: true });
  });

  it('returns frozen descriptors', () => {
    const [descriptor] = routeDescriptors([route('p', {})]);
    expect(Object.isFrozen(descriptor)).toBe(true);
  });
});

describe('catalogueProblems', () => {
  it('reports nothing when routes use catalogue permissions seeded to the admin', () => {
    const descriptors = routeDescriptors([
      route('core', { permission: 'project:read', boundary: 'project' }),
      route('core', { path: '/health' }),
    ]);
    expect(catalogueProblems(descriptors, adminRows)).toEqual([]);
  });

  it('reports a protected route without a boundary', () => {
    const descriptors = routeDescriptors([route('p', { path: '/a', permission: 'project:read' })]);
    expect(catalogueProblems(descriptors, adminRows)).toEqual([
      'Route GET /a (plugin "p"): protected route declares no boundary',
    ]);
  });

  it('reports a public route with an organization or project boundary', () => {
    const descriptors = routeDescriptors([
      route('p', { path: '/a', boundary: 'organization' }),
      route('p', { path: '/b', boundary: 'project' }),
    ]);
    expect(catalogueProblems(descriptors, adminRows)).toEqual([
      'Route GET /a (plugin "p"): public route declares the organization boundary',
      'Route GET /b (plugin "p"): public route declares the project boundary',
    ]);
  });

  it('reports a route permission absent from the catalogue without inventing it', () => {
    const descriptors = routeDescriptors([
      route('plug', { path: '/a', permission: 'org:invented', boundary: 'organization' }),
    ]);
    expect(catalogueProblems(descriptors, adminRows)).toEqual([
      'Route GET /a (plugin "plug"): permission "org:invented" is not in the catalogue',
    ]);
    expect(PERMISSIONS.some(({ name }) => name === 'org:invented')).toBe(false);
  });

  it('reports a catalogue permission missing from the seeded admin rows', () => {
    const legacy = adminRows.filter((name) => name !== 'org:projects:archive');
    const descriptors = routeDescriptors([
      route('core', {
        method: 'POST',
        path: '/archive',
        permission: 'org:projects:archive',
        boundary: 'organization',
      }),
    ]);
    expect(catalogueProblems(descriptors, legacy)).toEqual([
      'Route POST /archive (plugin "core"): permission "org:projects:archive" is not in the seeded Organization Admin rows',
    ]);
  });

  it('reports catalogue permissions the seeded admin rows lack even without routes', () => {
    const legacy = adminRows.filter((name) => name !== 'project:service-principals:write');
    expect(catalogueProblems([], legacy)).toEqual([
      'Catalogue permission "project:service-principals:write" is not in the seeded Organization Admin rows',
    ]);
  });

  it('seeds every catalogue permission to the Organization Admin default', () => {
    expect([...adminRows].sort()).toEqual(PERMISSIONS.map(({ name }) => name).sort());
    expect(catalogueProblems([], adminRows)).toEqual([]);
  });

  it('bounds and quotes caller-supplied names', () => {
    const long = 'x'.repeat(200);
    const [problem] = catalogueProblems(
      routeDescriptors([route('p', { permission: long, boundary: 'organization' })]),
      adminRows,
    );
    expect(problem).toContain(JSON.stringify('x'.repeat(80)));
    expect(problem).not.toContain('x'.repeat(81));
  });
});

describe('import and package permissions', () => {
  it.each([
    ['org:packages:manage', true, false],
    ['org:import:write', false, true],
    ['org:import:approve', true, false],
  ] as const)('%s session and token eligibility', (name, sessionOnly, eligible) => {
    expect(byName(name)).toMatchObject({ scope: 'organization', sessionOnly });
    expect(catalogueTokenEligible(name)).toBe(eligible);
  });
});
