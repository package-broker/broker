import { createApiClient } from '../api.js';
import type { ShellServices } from '../auth.js';
import { installSnippet } from './packages/package-detail.js';
import { describe, expect, it } from 'vitest';
import { parseHash } from '../app.js';
import { safePageHash } from '../auth.js';
import { createPackageFilterChoicesLoader, parsePackagesHash } from './packages.js';
import {
  publishActions,
  accessSetting,
  canEditAccess,
  decisionAllowed,
  decisionHeaders,
  validReason,
} from './packages/npm-workflow.js';

describe('package workflow guards', () => {
  it('uses the API revision ETag grammar for decisions', () => {
    expect(decisionHeaders(7)).toEqual({ 'If-Match': '"r7"' });
  });
  it('routes package details and keeps project scope', () => {
    const parsed = parseHash('#/packages/01AAAAAAAAAAAAAAAAAAAAAAAA?project=demo');
    expect(parsed.route).toBe('packages');
    expect(parsed.project).toBe('demo');
    expect(safePageHash('#/packages/01AAAAAAAAAAAAAAAAAAAAAAAA?project=demo')).toBe(
      '#/packages/01AAAAAAAAAAAAAAAAAAAAAAAA?project=demo',
    );
    expect(parsePackagesHash('#/packages/01AAAAAAAAAAAAAAAAAAAAAAAA?project=demo').project).toBe(
      'demo',
    );
    expect(parseHash('#/packages/not-an-id').route).toBeNull();
  });
  it('maps all three access choices without losing approval semantics', () => {
    expect(accessSetting('available')).toEqual({
      visibleToNewProjects: true,
      newProjectAccessMode: 'none',
    });
    expect(accessSetting('request')).toEqual({
      visibleToNewProjects: false,
      newProjectAccessMode: 'request',
    });
    expect(accessSetting('unavailable')).toEqual({
      visibleToNewProjects: false,
      newProjectAccessMode: 'none',
    });
  });
  it('requires the owner authority, including for organization administrators', () => {
    expect(canEditAccess(null, ['org:packages:manage'], [], null)).toBe(false);
    expect(canEditAccess(null, ['org:sources:write'], [], null)).toBe(true);
    expect(canEditAccess('owner', ['org:sources:write'], [], 'owner')).toBe(false);
    expect(canEditAccess('owner', [], ['project:sources:write'], 'other')).toBe(false);
    expect(canEditAccess('owner', [], ['project:sources:write'], 'owner')).toBe(true);
  });
  it('refuses duplicate, stale, unauthorized and decided mutations', () => {
    expect(decisionAllowed(true, false, false, 'pending')).toBe(true);
    expect(decisionAllowed(false, false, false, 'pending')).toBe(false);
    expect(decisionAllowed(true, true, false, 'pending')).toBe(false);
    expect(decisionAllowed(true, false, true, 'pending')).toBe(false);
    expect(decisionAllowed(true, false, false, 'approved')).toBe(false);
  });
  it('validates required reasons and UTF-8 byte limits', () => {
    expect(validReason('', true)).toBe(false);
    expect(validReason('   ', true)).toBe(false);
    expect(validReason('', false)).toBe(true);
    expect(validReason('é'.repeat(501), false)).toBe(false);
    expect(validReason('Reason', true)).toBe(true);
  });
});

it('uses the exact project registry address for each ecosystem', () => {
  expect(installSnippet('npm', '@team/library', 'https://broker.test', 'demo')).toBe(
    'registry=https://broker.test/demo/npm/',
  );
  expect(installSnippet('composer', 'team/library', 'https://broker.test', 'demo')).toBe(
    'composer config repositories.demo composer https://broker.test/demo\ncomposer require team/library',
  );
});

it('caches paginated filter choices independently for each scope', async () => {
  const calls: string[] = [];
  const client = createApiClient({
    readCookie: () => undefined,
    fetch: async (input) => {
      const url = new URL(String(input), 'https://broker.test');
      calls.push(url.pathname + url.search);
      return Response.json({
        items: [{ id: url.pathname, name: 'Named choice' }],
        next: url.searchParams.has('after') ? null : 'next',
      });
    },
  });
  const load = createPackageFilterChoicesLoader({ client } as ShellServices);
  const org = await load(null);
  expect(org.sources).toHaveLength(2);
  expect(org.projects).toHaveLength(2);
  expect(await load(null)).toBe(org);
  const project = await load('demo');
  expect(project.sources).toHaveLength(2);
  expect(project.projects).toHaveLength(0);
  expect(await load('demo')).toBe(project);
  await load('other');
  expect(await load(null)).toBe(org);
  expect(calls).toEqual([
    '/_pb/sources',
    '/_pb/sources?after=next',
    '/_pb/projects',
    '/_pb/projects?after=next',
    '/_pb/projects/demo/sources',
    '/_pb/projects/demo/sources?after=next',
    '/_pb/projects/other/sources',
    '/_pb/projects/other/sources?after=next',
  ]);
});

it('retries filter choices after a failed page instead of caching the partial list', async () => {
  let fail = true;
  const calls: string[] = [];
  const client = createApiClient({
    readCookie: () => undefined,
    fetch: async (input) => {
      const url = new URL(String(input), 'https://broker.test');
      calls.push(url.pathname);
      if (fail && url.pathname === '/_pb/projects/demo/sources')
        return Response.json(
          { error: { code: 'unavailable', message: 'x', requestId: 'r' } },
          { status: 503 },
        );
      return Response.json({ items: [{ id: url.pathname, name: 'Named choice' }], next: null });
    },
  });
  const load = createPackageFilterChoicesLoader({ client } as ShellServices);
  expect((await load('demo')).sources).toHaveLength(0);
  fail = false;
  const retried = await load('demo');
  expect(retried.sources).toHaveLength(1);
  expect(await load('demo')).toBe(retried);
  expect(calls).toEqual(['/_pb/projects/demo/sources', '/_pb/projects/demo/sources']);
});

it('offers only valid actions across approval and scan combinations', () => {
  for (const approvalState of [
    'pending',
    'not_required',
    'approved',
    'rejected',
    'expired',
  ] as const) {
    for (const scanState of [
      'not_required',
      'queued',
      'running',
      'allowed',
      'failed',
      'denied',
    ] as const) {
      const actions = publishActions({
        approvalState,
        scanState,
        holdScan: scanState !== 'not_required',
      });
      const open =
        ['pending', 'not_required', 'approved'].includes(approvalState) && scanState !== 'denied';
      expect(actions.includes('rescan')).toBe(open && scanState === 'failed');
      expect(actions.includes('approve')).toBe(open && approvalState === 'pending');
      expect(actions.includes('reject')).toBe(
        open &&
          (approvalState === 'pending' ||
            (approvalState === 'not_required' && scanState !== 'not_required') ||
            (approvalState === 'approved' && scanState === 'failed')),
      );
    }
  }
});

it('invalidates filter choices after source changes', async () => {
  let name = 'Before';
  const client = createApiClient({
    readCookie: () => undefined,
    fetch: async () => Response.json({ items: [{ id: 'source', name }], next: null }),
  });
  const load = createPackageFilterChoicesLoader({ client } as ShellServices);
  expect((await load('demo')).sources[0]?.name).toBe('Before');
  name = 'After';
  load.invalidate();
  expect((await load('demo')).sources[0]?.name).toBe('After');
});
