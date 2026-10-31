import type { ShellServices } from '../../auth.js';
import type { operations } from '../../api-types.js';
import type { ApiResult } from '../../api.js';

type Publisher =
  operations['listTrustedPublishers']['responses'][200]['content']['application/json']['items'][number];
type Draft = {
  packageName: string;
  repository: string;
  workflow: string;
  environment: string;
  refPattern: string;
};
const empty = (): Draft => ({
  packageName: '',
  repository: '',
  workflow: '',
  environment: '',
  refPattern: '',
});
export interface State {
  items: Publisher[];
  draft: Draft;
  editing: { id: string; revision: number } | null;
  loading: boolean;
  loadError: boolean;
  busy: boolean;
  stale: boolean;
  editDisabled: boolean;
  notice: string | null;
}
export function createTrustedPublishersController(services: ShellServices) {
  let state: State = {
    items: [],
    draft: empty(),
    editing: null,
    loading: false,
    loadError: false,
    busy: false,
    stale: false,
    editDisabled: false,
    notice: null,
  };
  let epoch = 0;
  const listeners = new Set<() => void>();
  const set = (next: Partial<State>) => {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  };
  const failure = (result: Exclude<ApiResult<unknown>, { ok: true }>) => {
    const conflict = result.code === 'conflict' || result.status === 412 || result.status === 428;
    set({
      stale: conflict,
      notice: conflict
        ? 'This publisher changed. Reload the latest settings and review your draft before saving.'
        : result.code === 'github_credentials_required'
          ? 'Configure a GitHub source for this repository with a GitHub App installation or token first.'
          : result.code === 'ambiguous_trusted_publisher'
            ? 'A publisher already uses this package, repository, workflow and environment.'
            : result.code === 'name_not_claimed'
              ? 'Claim this package on an active hosted npm source first.'
              : 'The publisher could not be saved. Check your settings and try again.',
    });
  };
  const controller = {
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    draft(draft: Draft) {
      set({ draft });
    },
    edit(
      item: Pick<
        Publisher,
        'id' | 'revision' | 'packageName' | 'repository' | 'workflow' | 'environment' | 'refPattern'
      >,
    ) {
      set({
        draft: {
          packageName: item.packageName,
          repository: item.repository,
          workflow: item.workflow,
          environment: item.environment,
          refPattern: item.refPattern ?? '',
        },
        editing: { id: item.id, revision: item.revision },
        notice: null,
        editDisabled: false,
      });
    },
    cancel() {
      set({ draft: empty(), editing: null, notice: null, editDisabled: false });
    },
    clear() {
      epoch++;
      set({
        draft: empty(),
        editing: null,
        items: [],
        notice: null,
        busy: false,
        loading: false,
        stale: false,
        editDisabled: false,
        loadError: false,
      });
    },
    async load() {
      if (state.busy) return;
      const version = ++epoch;
      set({ loading: true, loadError: false });
      const result = await services.client.request('get', '/_pb/trusted-publishers');
      if (version !== epoch) return;
      if (!result.ok) {
        set({ loading: false, loadError: true });
        return;
      }
      let editing = state.editing;
      let editDisabled = false;
      if (editing !== null) {
        const current = result.data.items.find(
          (item) => item.id === editing!.id && item.disabledAt === null,
        );
        editDisabled = current === undefined;
        if (current !== undefined) editing = { id: current.id, revision: current.revision };
      }
      set({
        items: result.data.items,
        loading: false,
        stale: false,
        editing,
        editDisabled,
        notice: editDisabled
          ? 'This publisher was disabled or is no longer available. Cancel this edit to create a new publisher.'
          : state.stale
            ? 'Latest settings loaded. Review your draft before saving again.'
            : state.notice,
      });
    },
    async save() {
      if (state.busy || state.loading || state.stale || state.loadError || state.editDisabled)
        return;
      const version = epoch;
      set({ busy: true, notice: null });
      const { draft, editing } = state;
      const body = {
        packageName: draft.packageName,
        repository: draft.repository,
        workflow: draft.workflow,
        environment: draft.environment,
        ...(draft.refPattern === '' ? {} : { refPattern: draft.refPattern }),
      };
      const result =
        editing === null
          ? await services.client.request('post', '/_pb/trusted-publishers', { body })
          : await services.client.request('put', '/_pb/trusted-publishers/{id}', {
              params: { id: editing.id },
              headers: { 'If-Match': `"r${editing.revision}"` },
              body,
            });
      if (version !== epoch) return;
      set({ busy: false });
      if (!result.ok) {
        failure(result);
        return;
      }
      set({ draft: empty(), editing: null, notice: 'Trusted publisher saved.' });
      await controller.load();
    },
    async disable(item: Pick<Publisher, 'id' | 'revision'>) {
      if (state.busy || state.loading || state.stale || state.loadError) return;
      const version = epoch;
      set({ busy: true, notice: null });
      const result = await services.client.request('delete', '/_pb/trusted-publishers/{id}', {
        params: { id: item.id },
        headers: { 'If-Match': `"r${item.revision}"` },
      });
      if (version !== epoch) return;
      set({ busy: false });
      if (!result.ok) {
        failure(result);
        return;
      }
      set({ notice: 'Publisher disabled. Its workload tokens have been revoked.' });
      await controller.load();
    },
  };
  return controller;
}
export type Controller = ReturnType<typeof createTrustedPublishersController>;
