import { createTrustedPublishersController } from './tokens/trusted-publishers-controller.js';
import { TrustedPublishers } from './tokens/trusted-publishers.js';
import { pendingStorage } from '../token-pending.js';
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from 'react';
import type { ApiResult } from '../api.js';
import type { operations } from '../api-types.js';
import { useServices, type ShellServices } from '../auth.js';
import { loadPending, savePending, type PendingStorage } from '../pending.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import { DataTable } from '../components/ui/table.js';
import { StatusBadge } from '../components/ui/status-badge.js';
import { IdText } from '../components/ui/id-text.js';
import { Time } from '../components/ui/time.js';
import { Badge } from '../components/ui/badge.js';
import { LoadedListFilters } from '../components/ui/toolbar.js';
import { ListState } from '../components/ui/list-state.js';
import { ConfirmAction } from '../components/ui/confirm-action.js';
import { IssueTokenForm, accessLabels } from './tokens/issue-token-form.js';
import { PrincipalForm } from './tokens/principal-form.js';
import { tokenClientConfig } from './tokens/client-config.js';

type Token =
  operations['listMyTokens']['responses'][200]['content']['application/json']['items'][number];
type Lifetime =
  operations['listMyTokens']['responses'][200]['content']['application/json']['lifetime'];
type Principal =
  operations['listServicePrincipals']['responses'][200]['content']['application/json']['items'][number];
export interface IssueProject {
  id: string;
  slug: string;
  name: string;
  cap: 'read' | 'write' | 'full' | null;
  permissions: string[] | null;
  policyState?: 'idle' | 'loading' | 'loaded' | 'error';
}
type Target = 'personal' | 'project' | 'organization';
export interface Draft {
  name: string;
  scope: 'read' | 'write' | 'full';
  lifetimeDays: number;
  servicePrincipalId: string;
  projectMode: 'all' | 'selected';
  projectIds: string[];
  overlapDays?: 0 | 1 | 7;
}
interface Issue {
  target: Target;
  project: string | null;
  draft: Draft;
  key: string;
  rotate?: string;
  replace?: string;
  refresh?: boolean;
  listTarget?: Target;
  listProject?: string | null;
}
export interface State {
  target: Target;
  project: string | null;
  issuanceProject: string | null;
  items: Token[];
  next: string | null;
  principals: Principal[];
  principalsNext: string | null;
  principalsRestricted: boolean;
  principalsLoading: boolean;
  principalsError: boolean;
  organizationPermissions: string[];
  issuanceDraft: Issue | null;
  issuancePrincipal: string | null;
  issuanceNonce: number;
  names: Record<string, string>;
  projectSlugs: Record<string, string>;
  projects: IssueProject[];
  projectsError: boolean;
  result: Issue | null;
  lifetime: Lifetime | null;
  userId: string | null;
  secret: string | null;
  secretProject: string | null;
  issuedId: string | null;
  oldPersonalId: string | null;
  pending: Issue | null;
  renewal: Token | null;
  busy: boolean;
  loading: boolean;
  listError: boolean;
  notice: string | null;
}
interface Deps {
  storage: PendingStorage;
  origin: string;
  clipboard: (text: string) => Promise<void>;
  navigate: (hash: string) => void;
  newKey: () => string;
  now: () => number;
  clearAfterCopy?: boolean;
}
export const dayLabel = (days: number) => `${days} ${days === 1 ? 'day' : 'days'}`;
export function lifetimeChoices(policy: { maxDays: number; defaultDays: number }) {
  return [...new Set([30, 90, 180, 365, policy.maxDays, policy.defaultDays])]
    .filter((days) => days > 0 && days <= policy.maxDays)
    .sort((a, b) => a - b);
}
export function tokensReducer(state: State, action: { type: 'navigate' }): State {
  if (action.type === 'navigate')
    return {
      ...state,
      secret: null,
      secretProject: null,
      result: null,
      issuedId: null,
      oldPersonalId: null,
      pending: null,
      renewal: null,
      busy: false,
      notice: null,
    };
  return state;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function restoredIssue(value: unknown): Issue | null {
  if (!record(value) || !record(value.draft)) return null;
  const d = value.draft;
  if (
    !['personal', 'project', 'organization'].includes(String(value.target)) ||
    !(value.project === null || typeof value.project === 'string') ||
    typeof value.key !== 'string' ||
    typeof d.name !== 'string' ||
    !['read', 'write', 'full'].includes(String(d.scope)) ||
    !Number.isInteger(d.lifetimeDays) ||
    Number(d.lifetimeDays) < 1 ||
    typeof d.servicePrincipalId !== 'string' ||
    !['all', 'selected'].includes(String(d.projectMode)) ||
    !Array.isArray(d.projectIds) ||
    !d.projectIds.every((id) => typeof id === 'string') ||
    (value.rotate !== undefined && typeof value.rotate !== 'string') ||
    (value.replace !== undefined && typeof value.replace !== 'string') ||
    (d.overlapDays !== undefined && ![0, 1, 7].includes(Number(d.overlapDays)))
  )
    return null;
  return {
    target: value.target as Target,
    project: value.project,
    key: value.key,
    ...(value.refresh === true ? { refresh: true } : {}),
    ...(['personal', 'project', 'organization'].includes(String(value.listTarget))
      ? {
          listTarget: value.listTarget as Target,
          listProject: typeof value.listProject === 'string' ? value.listProject : null,
        }
      : {}),
    ...(typeof value.rotate === 'string' ? { rotate: value.rotate } : {}),
    ...(typeof value.replace === 'string' ? { replace: value.replace } : {}),
    draft: {
      name: d.name,
      scope: d.scope as Draft['scope'],
      lifetimeDays: Number(d.lifetimeDays),
      servicePrincipalId: d.servicePrincipalId,
      projectMode: d.projectMode as Draft['projectMode'],
      projectIds: [...d.projectIds] as string[],
      ...(d.overlapDays === undefined ? {} : { overlapDays: Number(d.overlapDays) as 0 | 1 | 7 }),
    },
  };
}
function publicToken(t: Token): Token {
  return {
    id: t.id,
    kind: t.kind,
    name: t.name,
    scope: t.scope,
    readOnly: t.readOnly,
    status: t.status,
    projectMode: t.projectMode,
    projectCount: t.projectCount,
    projectId: t.projectId,
    userId: t.userId,
    createdByUserId: t.createdByUserId,
    servicePrincipalId: t.servicePrincipalId,
    createdAt: t.createdAt,
    expiresAt: t.expiresAt,
    lastUsedAt: t.lastUsedAt,
    revokedAt: t.revokedAt,
  };
}
export function inResultScope(result: Issue | null, project: IssueProject) {
  if (!result) return true;
  if (result.target === 'project') return project.slug === result.project;
  if (result.target === 'personal')
    return result.draft.projectMode !== 'selected' || result.draft.projectIds.includes(project.id);
  return true;
}
export function hasSetupAccess(state: State, project: IssueProject) {
  const result = state.result;
  if (!result) return false;
  const permissions =
    result.target === 'personal'
      ? project.permissions
      : state.principals.find((p) => p.id === result.draft.servicePrincipalId)?.permissions;
  return (
    permissions?.includes('project:packages:read') === true ||
    (result.draft.scope !== 'read' &&
      project.cap !== 'read' &&
      permissions?.includes('project:packages:write') === true)
  );
}
export function createTokensController(services: ShellServices, deps: Deps) {
  let state: State = {
    target: 'personal',
    project: null,
    issuanceProject: null,
    items: [],
    next: null,
    principals: [],
    principalsNext: null,
    principalsRestricted: false,
    principalsLoading: true,
    principalsError: false,
    organizationPermissions: [],
    issuanceDraft: null,
    issuancePrincipal: null,
    issuanceNonce: 0,
    names: {},
    projectSlugs: {},
    projects: [],
    projectsError: false,
    result: null,
    lifetime: null,
    userId: null,
    secret: null,
    secretProject: null,
    issuedId: null,
    oldPersonalId: null,
    pending: null,
    renewal: null,
    busy: false,
    loading: false,
    listError: false,
    notice: null,
  };
  let epoch = 0;
  let listing = 0;
  let navigation = 0;
  const policyQueue: string[] = [];
  let policyWorkers = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<State>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const storage = pendingStorage(deps.storage);
  function failure(result: Exclude<ApiResult<unknown>, { ok: true }>) {
    if (result.code === 'reauth_required')
      services.requireReauth(result.request, { credential: false, secretFields: [] });
    else
      set({
        notice:
          result.status === 412 || result.status === 428
            ? 'The record changed. Reload before trying again.'
            : 'Unable to update tokens. Try again.',
      });
  }
  async function send(action: Issue) {
    if (state.busy) return;
    const version = ++epoch;
    set({
      busy: true,
      secret: null,
      secretProject: null,
      result: null,
      issuedId: null,
      oldPersonalId: null,
      pending: null,
      notice: null,
    });
    const { draft: d, target, project, key } = action;
    const base = { name: d.name, scope: d.scope, lifetimeDays: d.lifetimeDays };
    const service = { ...base, servicePrincipalId: d.servicePrincipalId };
    const rotation = {
      name: d.name,
      lifetimeDays: d.lifetimeDays,
      overlapDays: d.overlapDays ?? 0,
    };
    const result =
      action.rotate !== undefined
        ? target === 'project'
          ? await services.client.request('post', '/_pb/projects/{project}/tokens/{token}/rotate', {
              params: { project: project!, token: action.rotate },
              body: rotation,
              idempotencyKey: key,
            })
          : await services.client.request('post', '/_pb/tokens/{token}/rotate', {
              params: { token: action.rotate },
              body: rotation,
              idempotencyKey: key,
            })
        : target === 'personal'
          ? await services.client.request('post', '/_pb/me/tokens', {
              body: { ...base, projectMode: d.projectMode, projectIds: d.projectIds },
              idempotencyKey: key,
            })
          : target === 'project'
            ? await services.client.request('post', '/_pb/projects/{project}/tokens', {
                params: { project: project! },
                body: service,
                idempotencyKey: key,
              })
            : await services.client.request('post', '/_pb/tokens', {
                body: service,
                idempotencyKey: key,
              });
    if (version !== epoch) return;
    set({ busy: false });
    if (result.ok) {
      set({
        secret: result.data.token,
        secretProject:
          target === 'project'
            ? project
            : d.projectMode === 'selected' && d.projectIds.length === 1
              ? (state.projectSlugs[d.projectIds[0]!] ?? null)
              : null,
        result: action,
        oldPersonalId: action.replace ?? null,
        issuedId: result.data.id,
        notice: 'Token created.',
      });
    } else if (result.code === 'reauth_required') {
      const saved = savePending(storage, {
        method: 'POST',
        path: '/_pb/me/tokens',
        body: action,
        idempotencyKey: key,
        credential: false,
        secretFields: [],
      });
      set({
        secret: null,
        notice: saved.ok
          ? 'Confirm your identity, then confirm token issue.'
          : 'Unable to save the pending action.',
      });
      if (saved.ok)
        deps.navigate(
          `#/reauth?return=${encodeURIComponent(`/tokens${project === null ? '' : `?project=${encodeURIComponent(project)}`}`)}`,
        );
    } else if (result.code === 'already_issued')
      set({ notice: 'already issued, create a new token' });
    else failure(result);
  }
  const controller = {
    trustedPublishers: createTrustedPublishersController(services),
    snapshot: () => state,
    announce(notice: string) {
      set({ notice });
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    navigate() {
      controller.trustedPublishers.clear();
      epoch++;
      navigation++;
      listing++;
      policyQueue.length = 0;
      set({
        ...tokensReducer(state, { type: 'navigate' }),
        principalsLoading: false,
        projects: state.projects.map((p) =>
          p.policyState === 'loading' ? { ...p, policyState: 'idle' } : p,
        ),
      });
    },
    dispose() {
      controller.navigate();
      listeners.clear();
    },
    closeSecret() {
      if (state.busy) return;
      epoch++;
      set({
        secret: null,
        secretProject: null,
        result: null,
        issuedId: null,
        oldPersonalId: null,
        notice: null,
        renewal: null,
        issuanceDraft: state.pending === null ? null : state.issuanceDraft,
      });
    },
    restore() {
      const loaded = loadPending(storage, deps.now());
      const action = loaded.ok ? restoredIssue(loaded.action?.body) : null;
      if (action !== null)
        set({ pending: action, issuanceDraft: action.refresh ? action : null, secret: null });
    },
    async start(target: Target, project: string | null) {
      set({ issuanceProject: project });
      controller.restore();
      const action = state.pending;
      await controller.load(
        action?.listTarget ?? action?.target ?? target,
        action ? (action.listTarget ? (action.listProject ?? null) : action.project) : project,
      );
    },
    async selectTarget(target: Target, project: string | null) {
      if (state.busy) return;
      set({ pending: null, renewal: null });
      await controller.load(target, project);
    },
    decline() {
      set({ pending: null });
    },
    async confirm() {
      const action = state.pending;
      if (action === null || state.busy || state.loading) return;
      if (state.lifetime === null) {
        await controller.load();
        if (state.pending !== action || state.lifetime === null || state.loading) return;
      }
      await send(action);
      if (action.refresh && state.secret !== null) await controller.load();
    },
    async issueFor(target: Target, project: string | null, draft: Draft) {
      const action = {
        target,
        project,
        draft,
        key: deps.newKey(),
        refresh: true,
        listTarget: state.target,
        listProject: state.project,
      };
      set({ issuanceDraft: action });
      await send(action);
      if (state.secret !== null) await controller.load();
    },
    configureProject(slug: string) {
      const result = state.result;
      const project = state.projects.find((p) => p.slug === slug);
      if (
        !project ||
        !result ||
        (result.target === 'project' && result.project !== slug) ||
        (result.target === 'personal' &&
          result.draft.projectMode === 'selected' &&
          !result.draft.projectIds.includes(project.id))
      )
        return;
      set({ secretProject: slug });
    },
    async issue(draft: Draft) {
      await send({
        target:
          state.renewal?.kind === 'pat'
            ? 'personal'
            : state.renewal?.projectId
              ? 'project'
              : state.target,
        project:
          state.renewal?.kind === 'svc' && state.renewal.projectId !== null
            ? (state.projectSlugs[state.renewal.projectId] ?? state.project)
            : state.project,
        draft,
        key: deps.newKey(),
        ...(state.renewal?.kind === 'svc' ? { rotate: state.renewal.id } : {}),
        ...(state.renewal?.kind === 'pat' ? { replace: state.renewal.id } : {}),
      });
    },
    renew(token: Token) {
      if (state.busy || (token.kind === 'pat' && token.userId !== state.userId)) return;
      if (
        token.kind === 'svc' &&
        token.projectId !== null &&
        state.projectSlugs[token.projectId] === undefined &&
        state.target !== 'project'
      ) {
        set({ notice: 'Choose this token’s project scope before renewing.' });
        return;
      }
      set({ renewal: token, secret: null, issuedId: null, oldPersonalId: null, notice: null });
    },
    invalidProjects() {
      set({ notice: 'Choose between 1 and 200 projects.' });
    },
    registryOrigin: () => new URL(deps.origin).origin,
    clientConfig() {
      return state.secret === null || state.secretProject === null
        ? null
        : tokenClientConfig(deps.origin, state.secretProject, state.secret);
    },
    async copy(kind?: keyof ReturnType<typeof tokenClientConfig>) {
      if (state.secret === null) return;
      const text = kind === undefined ? state.secret : controller.clientConfig()?.[kind];
      if (text === undefined) return;
      const label = kind === undefined ? 'Token' : 'Configuration';
      const version = epoch;
      try {
        await deps.clipboard(text);
        if (version === epoch)
          set({ ...(deps.clearAfterCopy ? { secret: null } : {}), notice: `${label} copied.` });
      } catch {
        if (version === epoch)
          set({
            notice:
              kind === undefined
                ? 'Could not copy. Select and copy the token manually.'
                : 'Could not copy. Select and copy the configuration manually.',
          });
      }
    },
    async load(
      target: Target = state.target,
      project: string | null = state.project,
      after?: string,
    ) {
      const version = ++listing;
      set({
        target,
        project,
        loading: true,
        listError: false,
        notice: state.secret === null ? null : state.notice,
        items: [],
        next: null,
        lifetime: null,
      });
      const result =
        target === 'personal'
          ? await services.client.request('get', '/_pb/me/tokens', { query: { after } })
          : target === 'project' && project !== null
            ? await services.client.request('get', '/_pb/projects/{project}/tokens', {
                params: { project },
                query: { after },
              })
            : await services.client.request('get', '/_pb/tokens', { query: { after } });
      if (version !== listing) return;
      set(
        result.ok
          ? {
              items: result.data.items.map(publicToken),
              next: result.data.next,
              lifetime: result.data.lifetime,
              loading: false,
            }
          : { loading: false, listError: true, lifetime: null, notice: 'Unable to load tokens.' },
      );
    },
    async loadPrincipals(after?: string) {
      const version = navigation;
      set({ principalsLoading: true, principalsError: false });
      const principals: Principal[] = [];
      let cursor = after;
      do {
        const result = await services.client.request('get', '/_pb/service-principals', {
          query: { after: cursor },
        });
        if (version !== navigation) return;
        if (!result.ok) {
          set({
            principalsLoading: false,
            principalsError: result.status !== 403,
            principalsRestricted: result.status === 403,
            principals: [],
            principalsNext: null,
          });
          return;
        }
        principals.push(
          ...result.data.items.map((p) => ({
            id: p.id,
            name: p.name,
            projectId: p.projectId,
            status: p.status,
            revision: p.revision,
            createdByUserId: p.createdByUserId,
            permissions: p.permissions,
          })),
        );
        cursor = result.data.next ?? undefined;
      } while (cursor !== undefined);
      set({
        principals,
        principalsNext: null,
        principalsRestricted: false,
        principalsLoading: false,
      });
    },
    loadProjectPolicies(ids: string[], retry = false) {
      const marked = new Set<string>();
      for (const id of ids) {
        const project = state.projects.find((p) => p.id === id);
        if (
          !project ||
          project.policyState === 'loading' ||
          project.policyState === 'loaded' ||
          (!retry && project.policyState === 'error')
        )
          continue;
        marked.add(id);
        policyQueue.push(id);
      }
      if (marked.size)
        set({
          projects: state.projects.map((p) =>
            marked.has(p.id) ? { ...p, policyState: 'loading' } : p,
          ),
        });
      async function work() {
        policyWorkers++;
        try {
          while (policyQueue.length) {
            const id = policyQueue.shift()!;
            const project = state.projects.find((p) => p.id === id);
            if (!project) continue;
            const version = navigation;
            const detail = await services.client.request('get', '/_pb/projects/{project}', {
              params: { project: project.slug },
            });
            const authority = await services.client.request(
              'get',
              '/_pb/projects/{project}/permissions',
              { params: { project: project.slug } },
            );
            if (version !== navigation) continue;
            set({
              projects: state.projects.map((p) =>
                p.id === id
                  ? {
                      ...p,
                      cap: detail.ok ? detail.data.tokenMaxScope : null,
                      permissions: authority.ok ? authority.data.project : null,
                      policyState: detail.ok && authority.ok ? 'loaded' : 'error',
                    }
                  : p,
              ),
            });
          }
        } finally {
          policyWorkers--;
        }
      }
      while (policyQueue.length && policyWorkers < 4) void work();
    },
    choosePrincipal(id: string, project: string | null, organization = project === null) {
      set({
        issuancePrincipal: id,
        issuanceProject: organization ? '__organization' : (project ?? ''),
        issuanceNonce: state.issuanceNonce + 1,
      });
    },
    async identity() {
      const version = navigation;
      const session = services.client.request('get', '/_pb/session');
      const projectSlugs: Record<string, string> = {};
      const catalogue: IssueProject[] = [];
      let projectsError = false;
      let projectAfter: string | undefined;
      do {
        const projects = await services.client.request('get', '/_pb/projects', {
          query: { after: projectAfter },
        });
        if (version !== navigation) return;
        if (!projects.ok) {
          projectsError = true;
          break;
        }
        for (const project of projects.data.items) {
          projectSlugs[project.id] = project.slug;
          if (project.status === 'archived') continue;
          catalogue.push({
            id: project.id,
            slug: project.slug,
            name: project.name ?? project.slug,
            cap: null,
            permissions: null,
            policyState: 'idle',
          });
        }
        projectAfter = projects.data.next ?? undefined;
        set({ projectSlugs: { ...projectSlugs }, projects: [...catalogue], projectsError });
      } while (projectAfter !== undefined);
      set({ projectSlugs, projects: catalogue, projectsError });
      const result = await session;
      if (version !== navigation) return;
      if (result.ok) set({ userId: result.data.user.id });
      const permissions = await services.client.request('get', '/_pb/me/permissions');
      if (version !== navigation) return;
      set({ organizationPermissions: permissions.ok ? permissions.data.organization : [] });
      if (!permissions.ok || !permissions.data.organization.includes('org:users:read')) {
        set({ names: {} });
        return;
      }
      let after: string | undefined;
      const names: Record<string, string> = {};
      do {
        const users = await services.client.request('get', '/_pb/users', { query: { after } });
        if (version !== navigation) return;
        if (!users.ok) break;
        for (const user of users.data.items)
          if (user.displayName !== null) names[user.id] = user.displayName;
        after = users.data.next ?? undefined;
      } while (after !== undefined);
      if (version === navigation) set({ names });
    },
    async revoke(id: string, own = false) {
      if (state.busy) return;
      const version = epoch;
      set({ busy: true, secret: null, issuedId: null });
      const result =
        state.target === 'personal' || own
          ? await services.client.request('delete', '/_pb/me/tokens/{token}', {
              params: { token: id },
            })
          : state.target === 'project'
            ? await services.client.request('delete', '/_pb/projects/{project}/tokens/{token}', {
                params: { project: state.project!, token: id },
              })
            : await services.client.request('delete', '/_pb/tokens/{token}', {
                params: { token: id },
              });
      if (version !== epoch) return;
      set({ busy: false });
      if (!result.ok) failure(result);
      else {
        await controller.load();
        set({ notice: 'Token revoked.', renewal: null });
      }
    },
    async createPrincipal(name: string, project: string, permissions: string[]) {
      if (state.busy) return;
      const version = epoch;
      set({ busy: true, secret: null, issuedId: null });
      type Body =
        operations['createServicePrincipal']['requestBody']['content']['application/json'];
      const body: Body = {
        name,
        permissions: permissions as Body['permissions'],
        ...(project === '' ? {} : { project }),
      };
      const result = await services.client.request('post', '/_pb/service-principals', {
        body,
        idempotencyKey: deps.newKey(),
      });
      if (version !== epoch) return;
      set({ busy: false });
      if (!result.ok) failure(result);
      else {
        await controller.loadPrincipals();
        set({ notice: 'Service principal created. Create a token to use it.' });
        return result.data;
      }
    },
    async suspendPrincipal(principal: Principal) {
      if (state.busy) return;
      const version = epoch;
      set({ busy: true, secret: null, issuedId: null });
      const project =
        principal.projectId === null ? undefined : state.projectSlugs[principal.projectId];
      const result =
        project !== undefined
          ? await services.client.request(
              'post',
              '/_pb/projects/{project}/service-principals/{principal}/suspend',
              { params: { project, principal: principal.id } },
            )
          : await services.client.request('post', '/_pb/service-principals/{principal}/suspend', {
              params: { principal: principal.id },
            });
      if (version !== epoch) return;
      set({ busy: false });
      if (!result.ok) failure(result);
      else {
        await controller.loadPrincipals();
        set({ notice: 'Service principal suspended; its tokens no longer work.' });
      }
    },
  };
  return controller;
}
export type Controller = ReturnType<typeof createTokensController>;

export interface TokenFilters {
  q: string;
  scope: string;
  status: string;
}
export function filterTokens(items: Token[], filters: TokenFilters) {
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(filters.q.toLowerCase()) &&
      (!filters.scope ||
        item.scope === filters.scope ||
        accessLabels[item.scope] === filters.scope) &&
      (!filters.status || item.status === filters.status),
  );
}
export function TokenList({ state: s, controller: c }: { state: State; controller: Controller }) {
  const [filters, setFilters] = useState<TokenFilters>({ q: '', scope: '', status: '' });
  const filtered = !!(filters.q || filters.scope || filters.status);
  const items = filterTokens(s.items, filters);
  const scope =
    s.target === 'personal'
      ? 'My personal tokens'
      : s.target === 'project'
        ? `Project: ${s.project}`
        : 'Organization';
  return (
    <>
      <LoadedListFilters
        values={filters}
        fields={[
          { key: 'q', label: 'Name (this page)' },
          { key: 'scope', label: 'Scope', options: Object.values(accessLabels) },
          { key: 'status', label: 'Status', options: ['active', 'expired', 'revoked'] },
        ]}
        onChange={setFilters}
      />
      <div className="my-3 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-neutral-600">
          {items.length} tokens on this page ·{' '}
          {items.filter((token) => token.status === 'active').length} active
        </p>
        <Button
          type="button"
          variant="outline"
          disabled={s.loading || s.busy}
          onClick={() => void c.load()}
        >
          Reload tokens
        </Button>
      </div>
      {s.loading ? (
        <ListState kind="loading" title="Loading tokens…" />
      ) : s.listError ? (
        <ListState kind="error" title="Unable to load tokens." />
      ) : items.length === 0 ? (
        <ListState
          kind={filtered ? 'filtered-empty' : 'empty'}
          title={
            filtered ? 'No tokens match these filters on this page.' : 'No tokens on this page.'
          }
        />
      ) : (
        <DataTable
          label="Tokens"
          items={items}
          columns={[
            {
              key: 'name',
              label: 'Token',
              value: (token) => token.name,
              render: (token) => (
                <div className="grid gap-1">
                  <strong>{token.name}</strong>
                  <IdText value={token.id} label="token ID" />
                </div>
              ),
            },
            {
              key: 'status',
              label: 'Status',
              value: (token) => token.status,
              render: (token) => <StatusBadge status={token.status} />,
            },
            {
              key: 'scope',
              label: 'Scope',
              value: (token) => token.scope,
              render: (token) => <Badge variant="outline">{accessLabels[token.scope]}</Badge>,
            },
            {
              key: 'project',
              label: 'Project',
              value: (token) =>
                token.projectId === null
                  ? token.kind === 'pat'
                    ? token.projectMode === 'all'
                      ? 'All accessible projects'
                      : `${token.projectCount} selected projects`
                    : 'Organization'
                  : (s.projectSlugs[token.projectId] ?? token.projectId),
              priority: 2,
              render: (token) =>
                token.projectId !== null && !s.projectSlugs[token.projectId] ? (
                  <IdText value={token.projectId} label="project ID" />
                ) : token.projectId !== null ? (
                  s.projectSlugs[token.projectId]
                ) : token.kind === 'pat' ? (
                  token.projectMode === 'all' ? (
                    'All accessible projects'
                  ) : (
                    `${token.projectCount} selected projects`
                  )
                ) : (
                  'Organization'
                ),
            },
            {
              key: 'lastUsedAt',
              label: 'Last used',
              value: (token) => token.lastUsedAt ?? '',
              priority: 2,
              render: (token) => <Time value={token.lastUsedAt} fallback="Never" />,
            },
            {
              key: 'expiresAt',
              label: 'Expires',
              value: (token) => token.expiresAt ?? '',
              priority: 3,
              render: (token) => <Time value={token.expiresAt} fallback="None" />,
            },
            {
              key: 'issuer',
              label: 'Issued by',
              value: (token) =>
                token.kind === 'svc' && token.createdByUserId !== null
                  ? (s.names[token.createdByUserId] ?? 'a member')
                  : 'a member',
              priority: 3,
            },
            {
              key: 'actions',
              label: 'Actions',
              value: () => '',
              sortable: false,
              render: (token) => (
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      s.busy ||
                      token.status !== 'active' ||
                      (token.kind === 'pat' && token.userId !== s.userId)
                    }
                    onClick={() => c.renew(token)}
                  >
                    Renew
                  </Button>
                  <ConfirmAction
                    key={`${token.id}:${token.status}`}
                    action="Revoke"
                    target={`${token.name} (${token.id})`}
                    scope={scope}
                    description="Revoking this token stops clients using it from authenticating. This cannot be undone. Create a new token to restore client access."
                    disabled={s.busy || token.status === 'revoked'}
                    onConfirm={() => void c.revoke(token.id)}
                  />
                </div>
              ),
            },
          ]}
        />
      )}
      {s.next === null ? null : (
        <Button
          type="button"
          disabled={s.busy || s.loading}
          onClick={() => void c.load(s.target, s.project, s.next!)}
        >
          Next tokens
        </Button>
      )}
      <p className="mt-3 text-xs text-neutral-600">
        Secrets are never listed. Only tokens in your accessible scope appear here.
      </p>
    </>
  );
}

function focusResult(node: HTMLHeadingElement | null) {
  node?.focus();
}

function SetupProjectAccess({ state: s, controller: c }: { state: State; controller: Controller }) {
  const [setupCandidate, setSetupCandidate] = useState('');
  const candidate = s.projects.find((p) => p.id === setupCandidate);
  useEffect(() => {
    if (s.secret && candidate?.policyState === 'loaded' && hasSetupAccess(s, candidate))
      c.configureProject(candidate.slug);
  }, [c, s.secret, candidate]);

  return (
    <>
      {' '}
      {s.projects.some((p) => p.permissions === null) && (
        <details>
          <summary className="min-h-11 cursor-pointer">
            Check another project's package access
          </summary>
          <Label htmlFor="setup-candidate">Project to configure</Label>
          <Select
            id="setup-candidate"
            className="min-h-11"
            value={setupCandidate}
            onChange={(event) => {
              setSetupCandidate(event.target.value);
              c.loadProjectPolicies([event.target.value]);
            }}
          >
            <option value="">Choose a project</option>
            {s.projects
              .filter((p) => inResultScope(s.result, p))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </Select>
          {candidate?.policyState === 'loading' && <p>Loading project access…</p>}
          {candidate?.policyState === 'error' && (
            <Button type="button" onClick={() => c.loadProjectPolicies([candidate.id], true)}>
              Try again loading project access
            </Button>
          )}
          {candidate?.policyState === 'loaded' && !hasSetupAccess(s, candidate) && (
            <p>This token does not have package access to this project.</p>
          )}
        </details>
      )}
    </>
  );
}

export function TokensView({ state: s, controller: c }: { state: State; controller: Controller }) {
  const personal = s.renewal !== null ? s.renewal.kind === 'pat' : s.target === 'personal';
  const policy = s.lifetime?.[personal ? 'personal' : 'service'];
  const renewal = s.renewal;
  const clientConfig = c.clientConfig();
  const projectId =
    renewal?.kind === 'svc'
      ? renewal.projectId
      : s.target === 'project'
        ? Object.keys(s.projectSlugs).find((id) => s.projectSlugs[id] === s.project)
        : null;
  const principalChoices = s.principals.filter((p) => p.status === 'active');
  function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (s.busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const selectedIds = data.getAll('projectIds').map(String);
    if (
      personal &&
      data.get('projectMode') === 'selected' &&
      (selectedIds.length < 1 || selectedIds.length > 200)
    ) {
      c.invalidProjects();
      return;
    }
    const scope =
      renewal?.kind === 'svc' ? renewal.scope : (String(data.get('scope')) as Draft['scope']);
    void c.issue({
      name: String(data.get('name')),
      scope,
      lifetimeDays: Number(data.get('lifetimeDays')),
      servicePrincipalId: String(data.get('principal') ?? ''),
      projectMode: data.get('projectMode') === 'selected' ? 'selected' : 'all',
      projectIds: data.getAll('projectIds').map(String),
      overlapDays: Number(data.get('overlap') ?? 0) as 0 | 1 | 7,
    });
  }
  return (
    <section aria-labelledby="page-heading" className="space-y-4">
      <h1 tabIndex={-1} id="page-heading" className="text-xl font-semibold">
        Tokens
      </h1>
      <p className="text-neutral-600">Connect your tools and CI pipelines to your packages.</p>
      {s.notice === null || s.listError ? null : (
        <Alert role="status" aria-live="polite">
          <AlertDescription>{s.notice}</AlertDescription>
        </Alert>
      )}
      {s.pending === null ? null : (
        <section aria-label="Confirm token issue" className="space-y-2">
          <h2>Confirm token issue</h2>
          <p>Your identity was checked. Issue this token now?</p>
          <Button
            type="button"
            disabled={s.busy || s.loading || s.lifetime === null}
            onClick={() => void c.confirm()}
          >
            Confirm token issue
          </Button>
          <Button type="button" variant="outline" onClick={() => c.decline()}>
            Cancel
          </Button>
        </section>
      )}
      {s.secret === null ? null : (
        <section aria-label="Token secret" className="detail-group space-y-3 border-emerald-200">
          <h2 tabIndex={-1} ref={focusResult}>
            Token created
          </h2>
          {s.result && (
            <p className="break-words">
              {s.result.draft.name} ·{' '}
              {s.result.target === 'project'
                ? (s.projects.find((p) => p.slug === s.result?.project)?.name ??
                  'Project name unavailable')
                : s.result.target === 'organization'
                  ? 'Organization-wide'
                  : s.result.draft.projectMode === 'all'
                    ? 'All accessible projects'
                    : s.result.draft.projectIds.length === 1
                      ? (s.projects.find((p) => p.id === s.result?.draft.projectIds[0])?.name ??
                        '1 selected project')
                      : `${s.result.draft.projectIds.length} selected projects`}{' '}
              · {accessLabels[s.result.draft.scope]} · Expires after{' '}
              {dayLabel(s.result.draft.lifetimeDays)}
            </p>
          )}
          <p>Copy this token now. You cannot view it again. Closing this panel keeps it active.</p>
          <pre className="rounded-md border bg-neutral-50 p-3 overflow-x-auto whitespace-pre-wrap break-all">
            <code role="region" aria-label="Created token">
              {s.secret}
            </code>
          </pre>
          <Button className="min-h-11" type="button" onClick={() => void c.copy()}>
            Copy token
          </Button>
          <Button
            type="button"
            variant="outline"
            className="min-h-11"
            onClick={() => {
              c.closeSecret();
              requestAnimationFrame(() => document.getElementById('new-token')?.focus());
            }}
          >
            Done
          </Button>
          <SetupProjectAccess state={s} controller={c} />
          <Label htmlFor="configure-project">Configure for project</Label>
          <Select
            className="min-h-11"
            id="configure-project"
            value={s.secretProject ?? ''}
            onChange={(event) => c.configureProject(event.target.value)}
          >
            <option value="">Choose a project</option>
            {s.projects
              .filter((p) => hasSetupAccess(s, p))
              .filter((p) => inResultScope(s.result, p))
              .map((p) => (
                <option key={p.id} value={p.slug}>
                  {p.name}
                </option>
              ))}
          </Select>
          {clientConfig === null ? (
            <p>Choose a project this token can access to configure Composer or npm.</p>
          ) : (
            <>
              <p>
                Composer sends this credential to this registry host. The token still limits which
                projects it can access.
              </p>
              {(
                [
                  ['Composer', ['composer', 'composerAuth']],
                  ['npm', ['npm']],
                  ['CI environment', ['ciComposer', 'ciNpm']],
                ] as const
              ).map(([title, kinds], index) => (
                <details key={title} open={index === 0} className="min-w-0">
                  <summary className="min-h-11 cursor-pointer">{title}</summary>
                  {kinds.map((kind) => (
                    <div key={kind}>
                      <p>
                        {
                          {
                            composer: 'Composer repository command',
                            composerAuth:
                              'Merge this into your local auth.json. Do not commit credentials.',
                            npm: 'Use this on your computer. For CI, use the environment-variable version below.',
                            ciComposer:
                              'Save PACKAGE_BROKER_TOKEN as a secret in your CI settings. These examples install packages; they do not publish them.',
                            ciNpm: 'Save this as .npmrc, then run npm ci.',
                          }[kind]
                        }
                      </p>
                      <pre className="whitespace-pre-wrap break-all rounded-md border bg-neutral-50 p-3">
                        <code>{clientConfig[kind]}</code>
                      </pre>
                      <Button
                        type="button"
                        variant="outline"
                        className="min-h-11"
                        onClick={() => void c.copy(kind)}
                      >
                        {
                          {
                            composer: 'Copy Composer configuration',
                            composerAuth: 'Copy auth.json',
                            npm: 'Copy npm configuration',
                            ciComposer: 'Copy CI Composer',
                            ciNpm: 'Copy CI npm',
                          }[kind]
                        }
                      </Button>
                    </div>
                  ))}
                </details>
              ))}
            </>
          )}
          {s.oldPersonalId !== null ? (
            <ConfirmAction
              action="Revoke old personal token"
              target={s.oldPersonalId!}
              scope="My personal tokens"
              description="Clients using the old token will lose access immediately. This cannot be undone. Update clients to the new token before revoking."
              disabled={s.busy}
              onConfirm={() => void c.revoke(s.oldPersonalId!, true)}
            />
          ) : null}
        </section>
      )}
      <div hidden={s.pending !== null || s.secret !== null || renewal !== null}>
        <IssueTokenForm state={s} controller={c} />
      </div>
      {s.pending !== null || s.secret !== null || renewal === null ? null : (
        <details
          key={`${s.target}:${renewal?.id ?? ''}`}
          open={renewal !== null}
          className="detail-group"
        >
          <summary className="min-h-11 cursor-pointer font-semibold">
            {renewal === null ? 'Issue token' : 'Renew token'}
          </summary>
          <form
            key={`${s.target}:${renewal?.id ?? ''}:${policy?.defaultDays}`}
            onSubmit={issue}
            className="grid gap-2"
          >
            <Label htmlFor="token-name">Name</Label>
            <Input id="token-name" name="name" defaultValue={renewal?.name ?? ''} required />
            <Label htmlFor="token-scope">Scope</Label>
            <Select
              id="token-scope"
              name="scope"
              defaultValue={renewal?.scope ?? 'read'}
              disabled={renewal?.kind === 'svc'}
            >
              <option value="read">Install and download</option>
              <option value="write">Include publish permission</option>
              <option value="full">Include grants, sources and audit access</option>
            </Select>
            <Label htmlFor="token-lifetime">Lifetime</Label>
            <Select
              id="token-lifetime"
              name="lifetimeDays"
              defaultValue={policy?.defaultDays}
              required
            >
              {policy === undefined
                ? null
                : lifetimeChoices(policy).map((days) => (
                    <option key={days} value={days}>
                      {dayLabel(days)}
                    </option>
                  ))}
            </Select>
            {personal ? (
              <>
                <Label htmlFor="token-project-mode">Projects</Label>
                <Select
                  id="token-project-mode"
                  name="projectMode"
                  defaultValue={renewal?.projectMode ?? 'all'}
                >
                  <option value="all">All accessible projects</option>
                  <option value="selected">Selected projects</option>
                </Select>
                <fieldset>
                  <legend>Choose projects again when renewing a selected token</legend>
                  {s.projects.map((p) => (
                    <label key={p.id} className="flex min-h-11 items-center gap-2">
                      <input type="checkbox" name="projectIds" value={p.id} />
                      {p.name}
                    </label>
                  ))}
                </fieldset>
              </>
            ) : (
              <>
                <Label htmlFor="token-principal">Service principal</Label>
                <Select
                  id="token-principal"
                  name="principal"
                  defaultValue={renewal?.servicePrincipalId ?? ''}
                  disabled={renewal?.kind === 'svc'}
                  required={renewal?.kind !== 'svc'}
                >
                  <option value="" disabled>
                    Select a principal
                  </option>
                  {principalChoices
                    .filter((p) => p.projectId === projectId)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                </Select>
                {s.principalsRestricted ? (
                  <p>
                    Ask an organization administrator to create a service identity for this project.
                  </p>
                ) : null}
              </>
            )}
            {renewal?.kind !== 'svc' ? null : (
              <>
                <Label htmlFor="token-overlap">Overlap</Label>
                <Select id="token-overlap" name="overlap" defaultValue="0">
                  <option value="0">None</option>
                  <option value="1">1 day</option>
                  <option value="7">7 days</option>
                </Select>
                <p>
                  The old token stops at the end of the overlap or when the new token expires,
                  whichever is first.
                </p>
              </>
            )}
            <Button type="submit" disabled={s.busy || s.loading || policy === undefined}>
              {renewal === null ? 'Issue token' : 'Renew token'}
            </Button>
            {renewal === null ? null : (
              <Button
                type="button"
                variant="outline"
                disabled={s.busy}
                onClick={() => c.closeSecret()}
              >
                Cancel renewal
              </Button>
            )}
          </form>
        </details>
      )}
      <Label htmlFor="token-list">Token list</Label>
      <Select
        id="token-list"
        value={s.target}
        disabled={s.busy}
        onChange={(e) => {
          void c.selectTarget(e.target.value as Target, s.project);
        }}
      >
        <option value="personal">My personal tokens</option>
        {s.project === null ? null : <option value="project">Project tokens</option>}
        <option value="organization">Organization tokens</option>
      </Select>
      <details className="detail-group">
        <summary>How token access works</summary>
        <p>
          Personal tokens use your access and stop working if you leave or your account is
          suspended. Service tokens use a service identity and keep working when their creator
          leaves. Each project's access policy can limit a token further.
        </p>
      </details>
      <TokenList key={`${s.target}:${s.project}`} state={s} controller={c} />
      {s.project === null && s.organizationPermissions.includes('org:service-principals:write') ? (
        <TrustedPublishers
          controller={c.trustedPublishers}
          permissions={s.organizationPermissions}
        />
      ) : null}
      <details className="detail-group">
        <summary className="min-h-11 cursor-pointer font-semibold">Service principals</summary>
        <PrincipalForm state={s} controller={c} />
        <Button
          type="button"
          variant="outline"
          disabled={s.busy}
          onClick={() => void c.loadPrincipals()}
        >
          Reload service principals
        </Button>
        {s.principalsRestricted ? (
          <ListState kind="placeholder" title="You cannot browse service principals here." />
        ) : s.principalsLoading ? (
          <ListState kind="loading" title="Loading service principals…" />
        ) : s.principals.length === 0 ? (
          <ListState kind="empty" title="No service principals loaded." />
        ) : (
          <DataTable
            label="Service principals"
            items={s.principals}
            columns={[
              {
                key: 'name',
                label: 'Name',
                value: (principal) => principal.name,
                render: (principal) => (
                  <div className="grid gap-1">
                    <strong>{principal.name}</strong>
                    <IdText value={principal.id} label="principal ID" />
                  </div>
                ),
              },
              {
                key: 'status',
                label: 'Status',
                value: (principal) => principal.status,
                render: (principal) => <StatusBadge status={principal.status} />,
              },
              {
                key: 'actions',
                label: 'Actions',
                value: () => '',
                sortable: false,
                render: (principal) => (
                  <ConfirmAction
                    key={`${principal.id}:${principal.status}`}
                    action="Revoke principal access"
                    target={`${principal.name} (${principal.id})`}
                    scope={
                      principal.projectId === null
                        ? 'Organization'
                        : `Project: ${s.projectSlugs[principal.projectId] ?? principal.projectId}`
                    }
                    description="Suspending this principal stops all of its tokens from working. Update clients before continuing."
                    disabled={s.busy || principal.status !== 'active'}
                    onConfirm={() => void c.suspendPrincipal(principal)}
                  />
                ),
              },
            ]}
          />
        )}
        {s.principalsNext === null ? null : (
          <Button
            type="button"
            disabled={s.busy}
            onClick={() => void c.loadPrincipals(s.principalsNext!)}
          >
            Next service principals
          </Button>
        )}
      </details>
    </section>
  );
}
export function bindTokensLifecycle(
  controller: Controller,
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  onNavigate: () => void,
) {
  const change = () => {
    controller.navigate();
    onNavigate();
  };
  const clear = () => controller.navigate();
  const show = (event: Event) => {
    clear();
    if ((event as Partial<PageTransitionEvent>).persisted === true) {
      onNavigate();
      if (controller.snapshot().organizationPermissions.includes('org:service-principals:write'))
        void controller.trustedPublishers.load();
    }
  };
  events.addEventListener('hashchange', change);
  events.addEventListener('pagehide', clear);
  events.addEventListener('pageshow', show);
  return () => {
    events.removeEventListener('hashchange', change);
    events.removeEventListener('pagehide', clear);
    events.removeEventListener('pageshow', show);
    controller.dispose();
  };
}
export function bindTokensReplay(controller: Controller, services: ShellServices) {
  return services.subscribeReplay?.((result) => {
    if (!result.ok) return;
    if (
      /^\/_pb\/(?:me\/)?tokens\/[^/]+$/.test(result.path) ||
      /^\/_pb\/projects\/[^/]+\/tokens\/[^/]+$/.test(result.path) ||
      /^\/_pb\/service-principals(?:\/[^/]+\/suspend)?$/.test(result.path) ||
      /^\/_pb\/projects\/[^/]+\/service-principals\/[^/]+\/suspend$/.test(result.path)
    ) {
      void controller.load();
      void controller.loadPrincipals();
    }
  });
}
export function TokensPage() {
  const services = useServices();
  const controller = useMemo(
    () =>
      createTokensController(services, {
        storage: {
          getItem: (key) => window.sessionStorage.getItem(key),
          setItem: (key, value) => window.sessionStorage.setItem(key, value),
          removeItem: (key) => window.sessionStorage.removeItem(key),
        },
        origin: window.location.origin,
        clipboard: (text) => navigator.clipboard.writeText(text),
        navigate: (hash) => {
          window.location.hash = hash;
        },
        newKey: () => crypto.randomUUID(),
        now: Date.now,
      }),
    [services],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    controller.snapshot,
  );
  useEffect(() => {
    function change() {
      const project = new URLSearchParams(window.location.hash.split('?')[1] ?? '').get('project');
      if (window.location.hash.startsWith('#/tokens'))
        void controller.start(project === null ? 'personal' : 'project', project);
    }
    function reload() {
      if (!window.location.hash.startsWith('#/tokens')) return;
      void controller.identity();
      void controller.loadPrincipals();
    }
    change();
    void controller.identity();
    void controller.loadPrincipals();
    return bindTokensLifecycle(controller, window, () => {
      change();
      reload();
    });
  }, [controller]);
  useEffect(() => bindTokensReplay(controller, services), [controller, services]);
  return <TokensView state={state} controller={controller} />;
}
