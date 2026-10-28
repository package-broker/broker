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
import { tokenClientConfig } from './tokens/client-config.js';

type Token =
  operations['listMyTokens']['responses'][200]['content']['application/json']['items'][number];
type Lifetime =
  operations['listMyTokens']['responses'][200]['content']['application/json']['lifetime'];
type Principal =
  operations['listServicePrincipals']['responses'][200]['content']['application/json']['items'][number];
type Target = 'personal' | 'project' | 'organization';
interface Draft {
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
}
interface State {
  target: Target;
  project: string | null;
  items: Token[];
  next: string | null;
  principals: Principal[];
  principalsNext: string | null;
  principalsRestricted: boolean;
  names: Record<string, string>;
  projectSlugs: Record<string, string>;
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
export function createTokensController(services: ShellServices, deps: Deps) {
  let state: State = {
    target: 'personal',
    project: null,
    items: [],
    next: null,
    principals: [],
    principalsNext: null,
    principalsRestricted: false,
    names: {},
    projectSlugs: {},
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
        secretProject: target === 'project' ? project : null,
        oldPersonalId: action.replace ?? null,
        issuedId: result.data.id,
        notice: 'Save this token now; it is shown once.',
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
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    navigate() {
      epoch++;
      navigation++;
      listing++;
      set(tokensReducer(state, { type: 'navigate' }));
    },
    dispose() {
      controller.navigate();
      listeners.clear();
    },
    closeSecret() {
      if (state.busy) return;
      epoch++;
      set({ secret: null, issuedId: null, oldPersonalId: null, notice: null, renewal: null });
    },
    restore() {
      const loaded = loadPending(storage, deps.now());
      const action = loaded.ok ? restoredIssue(loaded.action?.body) : null;
      if (action !== null)
        set({ target: action.target, project: action.project, pending: action, secret: null });
    },
    async start(target: Target, project: string | null) {
      controller.restore();
      const action = state.pending;
      await controller.load(action?.target ?? target, action === null ? project : action.project);
    },
    async selectTarget(target: Target, project: string | null) {
      if (state.busy) return;
      epoch++;
      set(tokensReducer(state, { type: 'navigate' }));
      await controller.load(target, project);
    },
    decline() {
      set({ pending: null });
    },
    async confirm() {
      const action = state.pending;
      if (action === null || state.busy || state.loading) return;
      if (state.lifetime === null) {
        await controller.load(action.target, action.project);
        if (state.pending !== action || state.lifetime === null || state.loading) return;
      }
      await send(action);
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
    registryOrigin: () => new URL(deps.origin).origin,
    clientConfig() {
      return state.secret === null || state.secretProject === null
        ? null
        : tokenClientConfig(deps.origin, state.secretProject, state.secret);
    },
    async copy(kind?: 'composer' | 'npm') {
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
            notice: kind === undefined ? 'Unable to copy token.' : 'Unable to copy configuration.',
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
        notice: null,
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
      const result = await services.client.request('get', '/_pb/service-principals', {
        query: { after },
      });
      if (version !== navigation) return;
      if (result.ok)
        set({
          principals: result.data.items.map((p) => ({
            id: p.id,
            name: p.name,
            projectId: p.projectId,
            status: p.status,
            revision: p.revision,
            createdByUserId: p.createdByUserId,
            permissions: p.permissions,
          })),
          principalsNext: result.data.next,
          principalsRestricted: false,
        });
      else if (result.status === 403)
        set({ principals: [], principalsNext: null, principalsRestricted: true });
    },
    async identity() {
      const version = navigation;
      const result = await services.client.request('get', '/_pb/session');
      if (version !== navigation) return;
      if (result.ok) set({ userId: result.data.user.id });
      const projectSlugs: Record<string, string> = {};
      let projectAfter: string | undefined;
      do {
        const projects = await services.client.request('get', '/_pb/projects', {
          query: { after: projectAfter },
        });
        if (version !== navigation) return;
        if (!projects.ok) break;
        for (const project of projects.data.items) projectSlugs[project.id] = project.slug;
        projectAfter = projects.data.next ?? undefined;
      } while (projectAfter !== undefined);
      set({ projectSlugs });
      const permissions = await services.client.request('get', '/_pb/me/permissions');
      if (version !== navigation) return;
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
        set({ notice: 'Service principal created.' });
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
type Controller = ReturnType<typeof createTokensController>;

export interface TokenFilters {
  q: string;
  scope: string;
  status: string;
}
export function filterTokens(items: Token[], filters: TokenFilters) {
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(filters.q.toLowerCase()) &&
      (!filters.scope || item.scope === filters.scope) &&
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
          { key: 'scope', label: 'Scope', options: ['read', 'write', 'full'] },
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
              render: (token) => <Badge variant="outline">{token.scope}</Badge>,
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

export function TokensView({ state: s, controller: c }: { state: State; controller: Controller }) {
  const personal = s.renewal?.kind === 'pat' || s.target === 'personal';
  const policy = s.lifetime?.[personal ? 'personal' : 'service'];
  const renewal = s.renewal;
  const clientConfig = c.clientConfig();
  const projectId =
    renewal?.kind === 'svc'
      ? renewal.projectId
      : s.target === 'project'
        ? Object.keys(s.projectSlugs).find((id) => s.projectSlugs[id] === s.project)
        : null;
  const principalChoices = s.principalsRestricted
    ? [
        ...new Map(
          s.items
            .filter(
              (t) => t.kind === 'svc' && t.status === 'active' && t.servicePrincipalId !== null,
            )
            .map((t) => [
              t.servicePrincipalId!,
              {
                id: t.servicePrincipalId!,
                name: t.servicePrincipalId!,
                projectId: t.projectId,
              },
            ]),
        ).values(),
      ]
    : s.principals.filter((p) => p.status === 'active');
  function issue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (s.busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const scope =
      renewal?.kind === 'svc' ? renewal.scope : (String(data.get('scope')) as Draft['scope']);
    void c.issue({
      name: String(data.get('name')),
      scope,
      lifetimeDays: Number(data.get('lifetimeDays')),
      servicePrincipalId: String(data.get('principal') ?? ''),
      projectMode: data.get('projectMode') === 'selected' ? 'selected' : 'all',
      projectIds: String(data.get('projectIds') ?? '')
        .split(/\s+/)
        .filter(Boolean),
      overlapDays: Number(data.get('overlap') ?? 0) as 0 | 1 | 7,
    });
    form.reset();
  }
  return (
    <section aria-labelledby="page-heading" className="space-y-4">
      <h1 tabIndex={-1} id="page-heading" className="text-xl font-semibold">
        Tokens
      </h1>
      <p className="text-neutral-600">
        Credentials for Composer and npm clients. Management writes use your signed-in session.
        Secrets are shown once.
      </p>
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
        <summary className="cursor-pointer font-medium">Token lifetimes and access</summary>
        <p className="mt-3">
          Your personal tokens are revoked when you leave the organization or your account is
          suspended. Access stops at once; the tokens are marked revoked shortly after.
        </p>
        <p>
          Service tokens keep working when the person who created them leaves. Project owners can
          see, renew and revoke every service token of their project.
        </p>
        <dl className="detail-list mt-3">
          <dt>Personal maximum lifetime</dt>
          <dd>1 year (the operator can set less)</dd>
          <dt>Service maximum lifetime</dt>
          <dd>1 year for every scope (the operator can change it)</dd>
        </dl>
      </details>
      {s.notice === null || s.listError ? null : (
        <Alert>
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
          <h2>Token secret — shown once</h2>
          <p>
            Copy it now. This value will not be shown again. Closing this panel keeps the token
            active.
          </p>
          <pre className="rounded-md border bg-neutral-50 p-3 overflow-x-auto whitespace-pre-wrap break-all">
            <code>{s.secret}</code>
          </pre>
          <Button type="button" onClick={() => void c.copy()}>
            Copy token
          </Button>
          <Button type="button" variant="outline" onClick={() => c.closeSecret()}>
            Close secret panel
          </Button>
          {clientConfig === null ? (
            <p>
              Choose a project this token can access to configure Composer or npm. Open that
              project’s registry at {c.registryOrigin()}/&lt;project&gt; for Composer or{' '}
              {c.registryOrigin()}/&lt;project&gt;/npm/ for npm.
            </p>
          ) : (
            <>
              <h3>Composer</h3>
              <pre className="overflow-x-auto rounded-md border bg-neutral-50 p-3">
                <code>{clientConfig.composer}</code>
              </pre>
              <Button type="button" variant="outline" onClick={() => void c.copy('composer')}>
                Copy Composer configuration
              </Button>
              <h3>npm (.npmrc)</h3>
              <pre className="overflow-x-auto rounded-md border bg-neutral-50 p-3">
                <code>{clientConfig.npm}</code>
              </pre>
              <Button type="button" variant="outline" onClick={() => void c.copy('npm')}>
                Copy npm configuration
              </Button>
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
      {s.pending !== null || s.secret !== null ? null : (
        <details
          key={`${s.target}:${renewal?.id ?? ''}`}
          open={renewal !== null}
          className="detail-group"
        >
          <summary className="cursor-pointer font-semibold">
            {renewal === null ? 'Issue token' : 'Renew token'}
          </summary>
          <form
            key={`${s.target}:${renewal?.id ?? ''}:${policy?.defaultDays}`}
            onSubmit={issue}
            className="grid gap-2"
          >
            <h2>{renewal === null ? 'Issue token' : 'Renew token'}</h2>
            <Label htmlFor="token-name">Name</Label>
            <Input id="token-name" name="name" defaultValue={renewal?.name ?? ''} required />
            <Label htmlFor="token-scope">Scope</Label>
            <Select
              id="token-scope"
              name="scope"
              defaultValue={renewal?.scope ?? 'read'}
              disabled={renewal?.kind === 'svc'}
            >
              <option value="read">Read</option>
              <option value="write">Write</option>
              <option value="full">Full</option>
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
                      {days} days
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
                <Label htmlFor="token-project-ids">
                  Selected project IDs (space separated; re-enter when renewing)
                </Label>
                <Input
                  id="token-project-ids"
                  name="projectIds"
                  required={renewal?.projectMode === 'selected'}
                />
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
                    Principal discovery is limited to principals referenced by the tokens you can
                    see.
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
      <TokenList key={`${s.target}:${s.project}`} state={s} controller={c} />
      <details className="detail-group">
        <summary className="cursor-pointer font-semibold">Service principals</summary>
        <h2>Service principals</h2>
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (s.busy) return;
            const form = event.currentTarget;
            const data = new FormData(form);
            void c.createPrincipal(
              String(data.get('name')),
              String(data.get('project')),
              String(data.get('permissions')).split(/\s+/).filter(Boolean),
            );
            form.reset();
          }}
        >
          <Label htmlFor="principal-name">Principal name</Label>
          <Input id="principal-name" name="name" required />
          <Label htmlFor="principal-project">Project ID (empty for organization)</Label>
          <Input id="principal-project" name="project" />
          <Label htmlFor="principal-permissions">Permissions (space separated)</Label>
          <Input id="principal-permissions" name="permissions" />
          <Button type="submit" disabled={s.busy}>
            Create service principal
          </Button>
        </form>
        <Button
          type="button"
          variant="outline"
          disabled={s.busy}
          onClick={() => void c.loadPrincipals()}
        >
          Reload service principals
        </Button>
        {s.principalsRestricted ? (
          <ListState kind="placeholder" title="Service principal discovery is restricted." />
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
  events.addEventListener('hashchange', change);
  events.addEventListener('pagehide', clear);
  events.addEventListener('pageshow', clear);
  return () => {
    events.removeEventListener('hashchange', change);
    events.removeEventListener('pagehide', clear);
    events.removeEventListener('pageshow', clear);
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
    change();
    void controller.identity();
    void controller.loadPrincipals();
    return bindTokensLifecycle(controller, window, change);
  }, [controller]);
  useEffect(() => bindTokensReplay(controller, services), [controller, services]);
  return <TokensView state={state} controller={controller} />;
}
