import type { ShellServices } from '../../auth.js';
import type { paths } from '../../api-types.js';

type ResponseAt<P extends keyof paths, M extends keyof paths[P]> = paths[P][M] extends {
  responses: { 200: { content: { 'application/json': infer T } } };
}
  ? T
  : never;
type Connection = ResponseAt<'/_pb/sources/discovery/connections', 'get'>['items'][number];
type Plan = ResponseAt<'/_pb/sources/discovery/plan', 'post'>;
type Applied = ResponseAt<'/_pb/sources/discovery/apply', 'post'>['results'][number];

export { discoveryReason } from './discovery-labels.js';
import { PATTERN_ERROR, validDiscoveryPattern } from './discovery-labels.js';
export function createDiscoveryPicker(services: ShellServices, ecosystem: 'composer' | 'npm') {
  let state = {
    loading: true,
    busy: false,
    importing: false,
    connections: [] as Connection[],
    connection: '',
    pattern: '*',
    includeForks: false,
    entries: [] as Plan['entries'],
    nextCursor: null as string | null,
    selected: [] as string[],
    results: [] as Applied[],
    error: null as string | null,
    patternError: null as string | null,
    pending: [] as string[],
    reviewed: false,
    progress: 0,
    total: 0,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<typeof state>) => {
    state = { ...state, ...patch };
    listeners.forEach((fn) => fn());
  };
  let cancelled = false;
  type Options = {
    credentialId: string;
    installationId: number;
    ecosystem: 'composer' | 'npm';
    includeForks: boolean;
  };
  const retryOptions = new Map<string, Options>();
  let pendingOptions: Options | undefined;
  const eligible = (repository: string) =>
    !state.results.some(
      (r) => r.repository === repository && (r.outcome === 'created' || r.outcome === 'existing'),
    );
  const connection = () => state.connections[Number(state.connection)];
  async function apply(repositories: string[], savedOptions?: Options, continuing = false) {
    const chosen = connection();
    if (
      cancelled ||
      state.busy ||
      (!chosen && !savedOptions) ||
      !repositories.length ||
      repositories.length > 20
    )
      return;
    const options = savedOptions ?? {
      credentialId: chosen!.credentialId,
      installationId: chosen!.installationId,
      ecosystem,
      includeForks: state.includeForks,
    };
    set({
      busy: true,
      importing: true,
      error: null,
      progress: continuing ? state.total - repositories.length : 0,
      total: continuing ? state.total : repositories.length,
    });
    pendingOptions = options;
    for (const repository of repositories) retryOptions.set(repository, options);
    let remaining = repositories;
    while (remaining.length) {
      const response = await services.client.request('post', '/_pb/sources/discovery/apply', {
        body: { ...options, repositories: remaining },
      });
      if (cancelled) break;
      const returned = response.ok ? response.data.results : [];
      const next = response.ok ? response.data.remainingRepositories : [];
      const rateLimited =
        response.ok && response.data.results.some((r) => r.error === 'rate_limited');
      const stalled =
        response.ok &&
        !rateLimited &&
        (next.length >= remaining.length || next.some((r) => !remaining.includes(r)));
      const results: Applied[] =
        !response.ok || stalled
          ? remaining.map((repository) => ({
              repository,
              outcome: 'failed',
              error: 'import_unconfirmed',
            }))
          : returned.map(({ repository, outcome, reason }) => ({
              repository,
              outcome,
              ...(reason ? { reason } : {}),
            }));
      for (const repository of remaining) {
        if (!results.some((r) => r.repository === repository) && !next.includes(repository))
          results.push({ repository, outcome: 'failed', error: 'import_unconfirmed' });
      }
      const updated = new Map(state.results.map((r) => [r.repository, r]));
      for (const result of results) updated.set(result.repository, result);
      set({
        results: [...updated.values()],
        progress: state.total - next.length,
        pending: rateLimited ? next : [],
        ...(!response.ok || stalled
          ? { error: 'Import could not finish. Retry failed repositories.', progress: state.total }
          : {}),
      });
      if (rateLimited) {
        set({
          error: 'GitHub is rate limiting imports. Continue import when it is available again.',
        });
        break;
      }
      if (!response.ok || stalled) break;
      remaining = next;
    }
    set({ busy: false, importing: false, selected: [] });
  }
  return {
    snapshot: () => state,
    cancel() {
      cancelled = true;
      set({ busy: false, importing: false });
    },
    startOver() {
      if (state.busy) return;
      retryOptions.clear();
      pendingOptions = undefined;
      set({
        entries: [],
        nextCursor: null,
        selected: [],
        reviewed: false,
        results: [],
        pending: [],
        progress: 0,
        total: 0,
        error: null,
        patternError: null,
      });
    },
    eligible,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async load() {
      if (state.busy) return;
      set({ loading: true, error: null });
      const response = await services.client.request('get', '/_pb/sources/discovery/connections');
      set(
        response.ok
          ? {
              loading: false,
              connections: response.data.items,
              connection: response.data.items.length ? '0' : '',
            }
          : { loading: false, error: 'GitHub connections could not be loaded. Try again.' },
      );
    },
    configure(patch: Partial<Pick<typeof state, 'connection' | 'pattern' | 'includeForks'>>) {
      if (state.busy) return;
      set({
        ...patch,
        entries: [],
        nextCursor: null,
        selected: [],
        reviewed: false,
        error: null,
        patternError: null,
      });
    },
    async preview(more = false) {
      const chosen = connection();
      if (state.busy || !chosen || (more && !state.nextCursor)) return;
      const pattern = state.pattern || '*';
      if (!validDiscoveryPattern(pattern)) {
        set({
          patternError: PATTERN_ERROR,
        });
        return;
      }
      set({ busy: true, error: null, patternError: null });
      const response = await services.client.request('post', '/_pb/sources/discovery/plan', {
        body: {
          credentialId: chosen.credentialId,
          installationId: chosen.installationId,
          ecosystem,
          includeForks: state.includeForks,
          pattern,
          cursor: more ? state.nextCursor : null,
        },
      });
      if (cancelled) {
        set({ busy: false });
        return;
      }
      set(
        response.ok
          ? {
              busy: false,
              entries: response.data.entries,
              nextCursor: response.data.nextCursor,
              selected: [],
              reviewed: true,
            }
          : { busy: false, error: 'Repositories could not be previewed. Try again.' },
      );
    },
    toggle(repository: string, checked: boolean) {
      if (
        state.busy ||
        !state.entries.some(
          (e) => e.repository === repository && e.action === 'new' && eligible(repository),
        )
      )
        return;
      set({
        selected: checked
          ? [...new Set([...state.selected, repository])].slice(0, 20)
          : state.selected.filter((r) => r !== repository),
      });
    },
    selectPage(checked: boolean) {
      if (!state.busy)
        set({
          selected: checked
            ? state.entries
                .filter((e) => e.action === 'new' && eligible(e.repository))
                .map((e) => e.repository)
                .slice(0, 20)
            : [],
        });
    },
    importSelected: () => (state.pending.length ? Promise.resolve() : apply(state.selected)),
    continueImport: () => apply(state.pending, pendingOptions, true),
    retryFailed: () => {
      const first = state.results.find(
        (r) => r.outcome === 'failed' && !state.pending.includes(r.repository),
      );
      if (!first) return Promise.resolve();
      const options = retryOptions.get(first.repository);
      return apply(
        state.results
          .filter(
            (r) =>
              r.outcome === 'failed' &&
              !state.pending.includes(r.repository) &&
              retryOptions.get(r.repository) === options,
          )
          .map((r) => r.repository)
          .slice(0, 20),
        options,
      );
    },
  };
}
