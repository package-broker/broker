import type { ShellServices } from '../auth.js';
import type { Delivery, DeliveryDetail, Endpoint } from './notification-actions.js';

export type DeliveryFilter = Delivery['state'] | 'all';

export interface NotificationsState {
  readonly project: string | null;
  readonly items: readonly Endpoint[];
  readonly next: string | null;
  readonly hasPrevious: boolean;
  readonly loading: boolean;
  /** Why the list is not shown: the project is unknown to this user, access is refused, or the broker has notifications off. */
  readonly blocked: 'denied' | 'unavailable' | 'error' | null;
  readonly selected: string | null;
  readonly deliveries: readonly Delivery[];
  readonly deliveriesNext: string | null;
  readonly deliveriesHasPrevious: boolean;
  readonly deliveriesLoading: boolean;
  readonly deliveriesError: boolean;
  readonly filter: DeliveryFilter;
  readonly detail: DeliveryDetail | null;
  readonly detailError: boolean;
}

const initial: NotificationsState = {
  project: null,
  items: [],
  next: null,
  hasPrevious: false,
  loading: false,
  blocked: null,
  selected: null,
  deliveries: [],
  deliveriesNext: null,
  deliveriesHasPrevious: false,
  deliveriesLoading: false,
  deliveriesError: false,
  filter: 'all',
  detail: null,
  detailError: false,
};

/** List and history reads. Responses carry configured flags only, never delivery settings. */
export function createNotificationsController(services: ShellServices) {
  let state = initial;
  let scopeEpoch = 0;
  let listEpoch = 0;
  let historyEpoch = 0;
  let cursors: (string | undefined)[] = [undefined];
  let historyCursors: (string | undefined)[] = [undefined];
  const listeners = new Set<() => void>();
  const set = (patch: Partial<NotificationsState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };

  async function loadHistory(): Promise<void> {
    const { project, selected, filter } = state;
    if (project === null || selected === null) return;
    const version = ++historyEpoch;
    set({ deliveriesLoading: true, deliveriesError: false });
    const cursor = historyCursors[historyCursors.length - 1];
    const result = await services.client.request(
      'get',
      '/_pb/projects/{project}/notifications/{id}/deliveries',
      {
        params: { project, id: selected },
        query: {
          ...(cursor === undefined ? {} : { cursor }),
          ...(filter === 'all' ? {} : { state: filter }),
        },
      },
    );
    if (version !== historyEpoch) return;
    set({
      deliveriesLoading: false,
      deliveriesError: !result.ok,
      deliveries: result.ok ? result.data.items : [],
      deliveriesNext: result.ok ? result.data.next : null,
      deliveriesHasPrevious: historyCursors.length > 1,
    });
  }

  const controller = {
    mutationScope() {
      const epoch = scopeEpoch;
      return () => epoch === scopeEpoch;
    },
    snapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async load(project: string | null = state.project): Promise<void> {
      if (project !== state.project) {
        scopeEpoch++;
        cursors = [undefined];
        historyCursors = [undefined];
        historyEpoch++;
        set({ ...initial, project });
      }
      if (project === null) return;
      const version = ++listEpoch;
      set({ loading: true, blocked: null });
      const cursor = cursors[cursors.length - 1];
      const result = await services.client.request('get', '/_pb/projects/{project}/notifications', {
        params: { project },
        query: cursor === undefined ? {} : { cursor },
      });
      if (version !== listEpoch) return;
      if (!result.ok) {
        set({
          loading: false,
          items: [],
          next: null,
          blocked:
            result.status === 403 ? 'denied' : result.status === 404 ? 'unavailable' : 'error',
        });
        return;
      }
      const selected =
        state.selected !== null && result.data.items.some((item) => item.id === state.selected)
          ? state.selected
          : null;
      set({
        loading: false,
        items: result.data.items,
        next: result.data.next,
        hasPrevious: cursors.length > 1,
        selected,
        ...(selected === null ? { deliveries: [], detail: null } : {}),
      });
    },
    async nextPage(): Promise<void> {
      if (state.loading || state.next === null) return;
      cursors.push(state.next);
      await controller.load();
    },
    async previousPage(): Promise<void> {
      if (state.loading || cursors.length < 2) return;
      cursors.pop();
      await controller.load();
    },
    /** Replaces one row after a confirmed write; null removes it. */
    replace(id: string, endpoint: Endpoint | null): void {
      set({
        items:
          endpoint === null
            ? state.items.filter((item) => item.id !== id)
            : state.items.some((item) => item.id === id)
              ? state.items.map((item) => (item.id === id ? endpoint : item))
              : [...state.items, endpoint],
        ...(endpoint === null && state.selected === id
          ? { selected: null, deliveries: [], detail: null }
          : {}),
      });
    },
    async select(id: string | null): Promise<void> {
      historyCursors = [undefined];
      historyEpoch++;
      set({
        selected: id,
        deliveries: [],
        deliveriesNext: null,
        deliveriesHasPrevious: false,
        deliveriesError: false,
        detail: null,
        detailError: false,
        filter: 'all',
      });
      await loadHistory();
    },
    async filterHistory(filter: DeliveryFilter): Promise<void> {
      historyCursors = [undefined];
      set({ filter, detail: null });
      await loadHistory();
    },
    reloadHistory: loadHistory,
    async nextHistory(): Promise<void> {
      if (state.deliveriesLoading || state.deliveriesNext === null) return;
      historyCursors.push(state.deliveriesNext);
      await loadHistory();
    },
    async previousHistory(): Promise<void> {
      if (state.deliveriesLoading || historyCursors.length < 2) return;
      historyCursors.pop();
      await loadHistory();
    },
    async openDelivery(id: string): Promise<void> {
      const { project, selected } = state;
      if (project === null || selected === null) return;
      set({ detailError: false });
      const result = await services.client.request(
        'get',
        '/_pb/projects/{project}/notifications/{id}/deliveries/{delivery}',
        { params: { project, id: selected, delivery: id } },
      );
      if (state.selected !== selected) return;
      set(result.ok ? { detail: result.data } : { detail: null, detailError: true });
    },
    dispose(): void {
      scopeEpoch++;
      listEpoch++;
      historyEpoch++;
    },
  };
  return controller;
}

export type NotificationsController = ReturnType<typeof createNotificationsController>;
