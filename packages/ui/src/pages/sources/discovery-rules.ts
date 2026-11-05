import type { ReplayResult, ShellServices } from '../../auth.js';
import type { operations } from '../../api-types.js';
import { revisionTag } from '../management.js';
import {
  PATTERN_ERROR,
  validDiscoveryPattern,
  type DiscoveryConnection,
} from '../packages/discovery-labels.js';

type List = operations['listDiscoveryRules']['responses'][200]['content']['application/json'];
export type Rule = List['items'][number];
export type RuleOptions =
  operations['createDiscoveryRule']['requestBody']['content']['application/json'];
import { drafts } from './discovery-rule-prefill.js';
export function ruleFailure(result: { status: number; code?: string }): string {
  if (result.status === 412)
    return 'This rule changed while you were editing. The newer rule is shown. Review the latest settings before saving.';
  if (result.status === 404) return 'This discovery rule is no longer available. Reload the rules.';
  if (result.code === 'duplicate')
    return 'A discovery rule with this name already exists. Choose another name.';
  if (result.code === 'reauth_required')
    return 'Sign in again, then confirm the discovery rule settings.';
  if (result.status === 429) return 'GitHub is rate limiting requests. Try again later.';
  if (result.status === 409 && result.code === 'discovery_rule_disabled')
    return 'Enable this rule before requesting a scan.';
  if (result.status === 409)
    return 'The rule conflicts with its current state. Reload and try again.';
  if (result.status === 403) return 'You do not have permission to change discovery rules.';
  return 'Discovery rules could not be updated. Check the settings and try again.';
}
export function runFailure(reason: string | null | undefined, failed = 0): string {
  if (reason !== 'disabled' && reason !== 'discovery_failed')
    return `Finished with ${failed} failed repositories`;
  return reason === 'disabled'
    ? 'The rule was disabled before the scan finished.'
    : 'The scan could not finish. Check the GitHub connection and try again.';
}
export function ruleState(rule: Rule): string {
  if (!rule.enabled) return 'Disabled';
  if (!('outcome' in rule)) return 'Current run information is available to source managers.';
  if (rule.outcome === 'running') return 'Running';
  if (rule.outcome === 'rate_limited') return 'Waiting for GitHub rate limit';
  if (rule.outcome === 'failed') return runFailure(rule.failureReason, rule.failed);
  return 'Waiting for the next scheduled scan';
}
export function scheduleWords(seconds: number): string {
  if (seconds % 86400 === 0)
    return seconds === 86400 ? 'Every day' : `Every ${seconds / 86400} days`;
  if (seconds % 3600 === 0)
    return seconds === 3600 ? 'Every hour' : `Every ${seconds / 3600} hours`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `Every ${hours ? `${hours} ${hours === 1 ? 'hour' : 'hours'} and ` : ''}${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
export function createDiscoveryRules(services: ShellServices) {
  const restored = drafts.get(services);
  let state = {
    visible: false,
    manager: false,
    loading: true,
    busy: false,
    reauthPending: restored?.reauthPending ?? false,
    items: [] as Rule[],
    next: null as string | null,
    connections: [] as DiscoveryConnection[],
    connectionsError: false,
    draft: restored?.options ?? (null as RuleOptions | null),
    editing: restored?.id ?? (null as string | null),
    revision: restored?.revision ?? (null as number | null),
    stale: false,
    error: null as string | null,
    notice: null as string | null,
    patternError: null as string | null,
  };
  let generation = 0;
  const listeners = new Set<() => void>();
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  const remember = () => {
    if (state.draft)
      drafts.set(services, {
        options: state.draft,
        id: state.editing,
        revision: state.revision,
        reauthPending: state.reauthPending,
      });
    else drafts.delete(services);
  };
  async function load(more = false, announce = true) {
    if (state.busy || (more && !state.next)) return;
    const request = ++generation;
    set({
      loading: true,
      error: null,
      ...(announce ? { notice: 'Loading discovery rules…' } : {}),
    });
    const permissions = await services.client.request('get', '/_pb/me/permissions');
    if (request !== generation) return;
    const manager = permissions.ok && permissions.data.organization.includes('org:sources:write');
    const visible =
      manager || (permissions.ok && permissions.data.organization.includes('org:sources:read'));
    set({ manager, visible });
    if (!visible) {
      set({
        loading: false,
        items: [],
        draft: null,
        error: permissions.ok ? null : 'Discovery rule permissions could not be loaded. Try again.',
      });
      return;
    }
    const [rules, connections] = await Promise.all([
      services.client.request(
        'get',
        '/_pb/sources/discovery/rules',
        more ? { query: { after: state.next! } } : {},
      ),
      manager ? services.client.request('get', '/_pb/sources/discovery/connections') : null,
    ]);
    if (request !== generation) return;
    set({
      loading: false,
      ...(announce ? { notice: null } : {}),
      connections: connections?.ok ? connections.data.items : [],
      connectionsError: manager && !connections?.ok,
      ...(rules.ok
        ? {
            items: more
              ? [...new Map([...state.items, ...rules.data.items].map((r) => [r.id, r])).values()]
              : rules.data.items,
            next: rules.data.next,
          }
        : { error: 'Discovery rules could not be loaded. Try again.' }),
    });
  }
  async function failed(
    result: {
      ok: false;
      status: number;
      code: string;
      request: Parameters<ShellServices['requireReauth']>[0];
    },
    rule?: Pick<Rule, 'id' | 'name'>,
    effect = 'The scan restarts.',
  ) {
    set({ error: ruleFailure(result) });
    if (result.code === 'reauth_required') {
      set({ reauthPending: true });
      remember();
      services.requireReauth(result.request, {
        credential: false,
        secretFields: [],
        display: {
          label: `Change discovery rule ${rule?.name ?? state.draft?.name ?? 'New rule'}`,
          effect,
          scope: 'Organization sources',
        },
      });
    }
    if (result.status === 412 && rule) {
      set({ stale: state.editing === rule.id && state.draft !== null });
      const request = generation;
      const latest = await services.client.request('get', '/_pb/sources/discovery/rules/{id}', {
        params: { id: rule.id },
      });
      if (request !== generation) return;
      if (latest.ok)
        set({
          items: state.items.some((r) => r.id === rule.id)
            ? state.items.map((r) => (r.id === rule.id ? latest.data : r))
            : [...state.items, latest.data],
        });
      else set({ error: ruleFailure(latest) });
    }
  }
  async function mutate(
    action: () => Promise<Awaited<ReturnType<typeof services.client.request>>>,
    notice: string,
    rule?: Pick<Rule, 'id' | 'name'>,
    effect = 'The scan restarts.',
  ) {
    if (!state.manager || state.busy || state.reauthPending || state.loading || state.stale) return;
    set({ busy: true, error: null, notice: null });
    const result = await action();
    if (!result.ok) await failed(result, rule, effect);
    set({ busy: false });
    if (result.ok) {
      await load(false, false);
      set({ notice });
    }
    if (!result.ok && result.status === 404) {
      await load(false, false);
      set({ error: ruleFailure(result) });
    }
    return result.ok;
  }
  const edit = (rule?: Rule, prefill?: Partial<RuleOptions>) => {
    if (!state.manager || state.busy || state.reauthPending || state.loading || state.draft) return;
    const c = state.connections[0];
    const options: RuleOptions = rule
      ? {
          name: rule.name,
          pattern: rule.pattern,
          ecosystem: rule.ecosystem,
          includeForks: rule.includeForks,
          enabled: rule.enabled,
          intervalSeconds: rule.intervalSeconds,
          credentialId: 'credentialId' in rule ? rule.credentialId : '',
          installationId: 'installationId' in rule ? rule.installationId : 0,
        }
      : {
          name: '',
          credentialId: c?.credentialId ?? '',
          installationId: c?.installationId ?? 0,
          ecosystem: 'both',
          pattern: '*',
          includeForks: false,
          intervalSeconds: 86400,
          enabled: true,
          ...prefill,
        };
    set({
      draft: options,
      editing: rule?.id ?? null,
      revision: rule?.revision ?? null,
      stale: false,
      error: null,
      patternError: null,
    });
    remember();
  };
  return {
    snapshot: () => state,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    load,
    dispose() {
      generation++;
    },
    edit,
    configure(patch: Partial<RuleOptions>) {
      if (state.busy || state.reauthPending || !state.draft) return;
      set({ draft: { ...state.draft, ...patch }, patternError: null });
      remember();
    },
    close() {
      if (state.busy || state.reauthPending) return;
      set({ draft: null, editing: null, stale: false, error: null });
      remember();
    },
    reviewLatest() {
      const latest = state.items.find((r) => r.id === state.editing);
      if (latest) {
        set({ draft: null });
        edit(latest);
      } else set({ stale: false });
    },
    async save() {
      if (!state.manager || !state.draft || state.stale || state.busy || state.reauthPending)
        return;
      const options = {
        ...state.draft,
        name: state.draft.name.trim(),
        pattern: state.draft.pattern || '*',
      };
      if (!validDiscoveryPattern(options.pattern)) {
        set({ patternError: PATTERN_ERROR });
        return;
      }
      const prior = state.items.find((r) => r.id === state.editing);
      const unchanged =
        prior &&
        'credentialId' in prior &&
        prior.credentialId === options.credentialId &&
        prior.installationId === options.installationId;
      if (
        !Number.isInteger(options.intervalSeconds! / 3600) ||
        options.intervalSeconds! < 3600 ||
        options.intervalSeconds! > 2592000
      ) {
        set({ error: 'Enter a whole number of hours from 1 to 720.' });
        return;
      }
      if (
        !options.name ||
        options.name.length > 80 ||
        (!unchanged &&
          !state.connections.some(
            (c) =>
              c.credentialId === options.credentialId &&
              c.installationId === options.installationId,
          ))
      ) {
        set({
          error: 'Enter a name of up to 80 characters and choose an available GitHub connection.',
        });
        return;
      }
      const body: Partial<RuleOptions> = { ...options };
      if (
        prior &&
        'credentialId' in prior &&
        prior.credentialId === options.credentialId &&
        prior.installationId === options.installationId
      ) {
        delete body.credentialId;
        delete body.installationId;
      }
      const ok = await mutate(
        () =>
          state.editing === null
            ? services.client.request('post', '/_pb/sources/discovery/rules', {
                body: options,
                idempotencyKey: crypto.randomUUID(),
              })
            : services.client.request('patch', '/_pb/sources/discovery/rules/{id}', {
                params: { id: state.editing },
                headers: { 'If-Match': revisionTag(state.revision!)! },
                body,
              }),
        'Discovery rule saved.',
        prior ?? (state.editing ? { id: state.editing, name: options.name } : undefined),
        !prior ||
          !unchanged ||
          prior.ecosystem !== options.ecosystem ||
          prior.pattern !== options.pattern ||
          prior.includeForks !== options.includeForks
          ? 'The scan restarts. Imported sources stay.'
          : 'Save the settings. The scan keeps its progress.',
      );
      if (ok) {
        set({ draft: null, editing: null });
        remember();
      }
    },
    run: (rule: Rule) =>
      !rule.enabled
        ? Promise.resolve(false)
        : mutate(
            () =>
              services.client.request('post', '/_pb/sources/discovery/rules/{id}/run', {
                params: { id: rule.id },
                body: {},
                idempotencyKey: crypto.randomUUID(),
              }),
            'Scan requested. It will start on a scheduler tick when GitHub is available.',
            rule,
            'Request a scan on the next scheduler tick.',
          ),
    toggle: (rule: Rule) =>
      mutate(
        () =>
          services.client.request('patch', '/_pb/sources/discovery/rules/{id}', {
            params: { id: rule.id },
            headers: { 'If-Match': revisionTag(rule.revision)! },
            body: { enabled: !rule.enabled },
          }),
        'Discovery rule updated.',
        rule,
        rule.enabled ? 'Scheduled scans stop.' : 'Scheduled scans resume.',
      ),
    remove: async (selected: Rule) => {
      const rule = state.items.find((r) => r.id === selected.id);
      if (!rule) {
        await load(false, false);
        set({ error: ruleFailure({ status: 404 }) });
        return false;
      }
      return mutate(
        () =>
          services.client.request('delete', '/_pb/sources/discovery/rules/{id}', {
            params: { id: rule.id },
            headers: { 'If-Match': revisionTag(rule.revision)! },
          }),
        'Discovery rule deleted. Imported sources stay.',
        rule,
        'Scheduled scans stop. Imported sources stay.',
      );
    },
    async replayed(result: ReplayResult) {
      set({ reauthPending: false });
      remember();
      if (!result.ok && result.cancelled) {
        set({
          error: null,
          notice: 'Discovery rule was not sent. Review the settings before trying again.',
        });
        return;
      }
      if (result.ok) {
        set({ draft: null, editing: null });
        remember();
      }
      const loading = load(false, false);
      const replayGeneration = generation;
      await loading;
      if (replayGeneration !== generation) return;
      if (result.ok) set({ notice: 'Discovery rule saved.' });
      if (!result.ok) {
        set({ error: ruleFailure(result), stale: result.status === 412 && state.draft !== null });
        if (result.status === 412 && state.editing) {
          const request = generation;
          const editing = state.editing;
          const latest = await services.client.request('get', '/_pb/sources/discovery/rules/{id}', {
            params: { id: state.editing },
          });
          if (request !== generation || editing !== state.editing) return;
          if (latest.ok)
            set({
              items: state.items.some((r) => r.id === state.editing)
                ? state.items.map((r) => (r.id === state.editing ? latest.data : r))
                : [...state.items, latest.data],
            });
        }
      }
    },
  };
}
export type DiscoveryRulesModel = ReturnType<typeof createDiscoveryRules>;
