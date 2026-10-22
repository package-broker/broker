import { useEffect, useMemo, useSyncExternalStore, type FormEvent } from 'react';
import type { ApiResult } from '../api.js';
import type { operations } from '../api-types.js';
import { useServices, type ShellServices } from '../auth.js';
import { loadPending, savePending, type PendingStorage } from '../pending.js';
import { Button } from '../components/ui/button.js';
import { Input } from '../components/ui/input.js';
import { Label } from '../components/ui/label.js';
import { Select } from '../components/ui/select.js';
import { Alert, AlertDescription } from '../components/ui/alert.js';
import {
  Table,
  TableHeader,
  TableHead,
  TableBody,
  TableRow,
  TableCell,
} from '../components/ui/table.js';

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
  issuedId: string | null;
  oldPersonalId: string | null;
  pending: Issue | null;
  renewal: Token | null;
  busy: boolean;
  loading: boolean;
  notice: string | null;
}
interface Deps {
  storage: PendingStorage;
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
      issuedId: null,
      oldPersonalId: null,
      pending: null,
      renewal: null,
      busy: false,
      notice: null,
    };
  return state;
}
function pendingStorage(storage: PendingStorage): PendingStorage {
  return {
    getItem: (key) => storage.getItem(`tokens:${key}`),
    setItem: (key, value) => storage.setItem(`tokens:${key}`, value),
    removeItem: (key) => storage.removeItem(`tokens:${key}`),
  };
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
    issuedId: null,
    oldPersonalId: null,
    pending: null,
    renewal: null,
    busy: false,
    loading: false,
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
    async copy() {
      if (state.secret === null) return;
      const version = epoch;
      try {
        await deps.clipboard(state.secret);
        if (version === epoch)
          set({ ...(deps.clearAfterCopy ? { secret: null } : {}), notice: 'Token copied.' });
      } catch {
        if (version === epoch) set({ notice: 'Unable to copy token.' });
      }
    },
    async load(
      target: Target = state.target,
      project: string | null = state.project,
      after?: string,
    ) {
      const version = ++listing;
      set({ target, project, loading: true, items: [], next: null, lifetime: null });
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
          : { loading: false, lifetime: null, notice: 'Unable to load tokens.' },
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

export function TokensView({ state: s, controller: c }: { state: State; controller: Controller }) {
  const personal = s.renewal?.kind === 'pat' || s.target === 'personal';
  const policy = s.lifetime?.[personal ? 'personal' : 'service'];
  const renewal = s.renewal;
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
      <h1 id="page-heading" className="text-xl font-semibold">
        Tokens
      </h1>
      <p>Management writes use your signed-in session. Secrets are shown once.</p>
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
      <p>
        Your personal tokens are revoked when you leave the organization or your account is
        suspended. Access stops at once; the tokens are marked revoked shortly after.
      </p>
      <p>
        Service tokens keep working when the person who created them leaves. Project owners can see,
        renew and revoke every service token of their project.
      </p>
      <Table>
        <caption>Token kinds and maximum lifetime</caption>
        <TableBody>
          <TableRow>
            <TableCell>Personal</TableCell>
            <TableCell>1 year (the operator can set less)</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Service</TableCell>
            <TableCell>1 year for every scope (the operator can change it)</TableCell>
          </TableRow>
        </TableBody>
      </Table>
      {s.notice === null ? null : (
        <Alert>
          <AlertDescription>{s.notice}</AlertDescription>
        </Alert>
      )}
      {s.pending === null ? null : (
        <section aria-label="Confirm token issue" className="space-y-2">
          <h2>Confirm token issue</h2>
          <p>Your identity was checked. Issue this token now?</p>
          <Button
            disabled={s.busy || s.loading || s.lifetime === null}
            onClick={() => void c.confirm()}
          >
            Confirm token issue
          </Button>
          <Button variant="outline" onClick={() => c.decline()}>
            Cancel
          </Button>
        </section>
      )}
      {s.secret === null ? null : (
        <section aria-label="Token secret" className="space-y-2">
          <h2>Token secret — shown once</h2>
          <p>Save it before closing this panel or navigating.</p>
          <pre className="overflow-x-auto whitespace-pre-wrap break-all">
            <code>{s.secret}</code>
          </pre>
          <Button onClick={() => void c.copy()}>Copy token</Button>
          <Button variant="outline" onClick={() => c.closeSecret()}>
            Close secret panel
          </Button>
          {s.oldPersonalId !== null ? (
            <Button
              variant="destructive"
              disabled={s.busy}
              onClick={() => void c.revoke(s.oldPersonalId!, true)}
            >
              Revoke old personal token
            </Button>
          ) : null}
        </section>
      )}
      {s.pending !== null || s.secret !== null ? null : (
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
                  Principal discovery is limited to principals referenced by the tokens you can see.
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
          <Button disabled={s.busy || s.loading || policy === undefined}>
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
      )}
      <Button variant="outline" disabled={s.loading || s.busy} onClick={() => void c.load()}>
        Reload tokens
      </Button>
      {s.loading ? <p role="status">Loading tokens…</p> : null}
      <Table>
        <caption>Tokens</caption>
        <TableHeader>
          <TableRow>
            <TableHead>Selector</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Expiry</TableHead>
            <TableHead>Last use</TableHead>
            <TableHead>Issued by</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.items.map((t) => (
            <TableRow key={t.id}>
              <TableCell>{t.id}</TableCell>
              <TableCell>{t.scope}</TableCell>
              <TableCell>{t.expiresAt ?? 'None'}</TableCell>
              <TableCell>{t.lastUsedAt ?? 'Never'}</TableCell>
              <TableCell>
                {t.kind === 'svc' && t.createdByUserId !== null
                  ? (s.names[t.createdByUserId] ?? 'a member')
                  : 'a member'}
              </TableCell>
              <TableCell>
                <Button
                  variant="outline"
                  disabled={
                    s.busy || t.status !== 'active' || (t.kind === 'pat' && t.userId !== s.userId)
                  }
                  onClick={() => c.renew(t)}
                >
                  Renew
                </Button>
                <Button
                  variant="destructive"
                  disabled={s.busy || t.status === 'revoked'}
                  onClick={() => void c.revoke(t.id)}
                >
                  Revoke
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {s.next === null ? null : (
        <Button
          disabled={s.busy || s.loading}
          onClick={() => void c.load(s.target, s.project, s.next!)}
        >
          Next tokens
        </Button>
      )}
      <h2>Service principals</h2>
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
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
        <Button disabled={s.busy}>Create service principal</Button>
      </form>
      <Button variant="outline" disabled={s.busy} onClick={() => void c.loadPrincipals()}>
        Reload service principals
      </Button>
      <Table>
        <caption>Service principals</caption>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Action</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {s.principals.map((p) => (
            <TableRow key={p.id}>
              <TableCell>{p.name}</TableCell>
              <TableCell>{p.status}</TableCell>
              <TableCell>
                <Button
                  variant="destructive"
                  disabled={s.busy || p.status !== 'active'}
                  onClick={() => void c.suspendPrincipal(p)}
                >
                  Revoke principal access
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {s.principalsNext === null ? null : (
        <Button disabled={s.busy} onClick={() => void c.loadPrincipals(s.principalsNext!)}>
          Next service principals
        </Button>
      )}
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
  return <TokensView state={state} controller={controller} />;
}
