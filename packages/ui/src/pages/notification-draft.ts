import type { Endpoint, Options } from './notification-actions.js';

const KEY = 'pb.notification-draft.v1';
const WINDOW_MS = 10 * 60 * 1000;

interface NotificationDraft {
  project: string;
  endpoint: Pick<Endpoint, 'id' | 'revision'> | null;
  options: Options;
  savedAt: number;
}

export function clearNotificationDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* Storage can be unavailable. */
  }
}

/** Only these four public option fields may survive navigation to reauthentication. */
export function saveNotificationDraft(
  project: string,
  endpoint: Pick<Endpoint, 'id' | 'revision'> | null,
  options: Options,
): void {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({
        project,
        endpoint: endpoint === null ? null : { id: endpoint.id, revision: endpoint.revision },
        options: {
          name: options.name,
          method: options.method,
          events: [...options.events],
          packagePattern: options.packagePattern,
        },
        savedAt: Date.now(),
      } satisfies NotificationDraft),
    );
  } catch {
    /* Reauthentication still works when storage is unavailable. */
  }
}

export function takeNotificationDraft(project: string): NotificationDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    if (raw === null) return null;
    const draft = JSON.parse(raw) as NotificationDraft;
    const options = draft.options;
    if (
      draft.project !== project ||
      !Number.isFinite(draft.savedAt) ||
      Date.now() < draft.savedAt ||
      Date.now() - draft.savedAt > WINDOW_MS ||
      typeof options?.name !== 'string' ||
      options.name.length > 80 ||
      !['POST', 'PUT'].includes(options.method) ||
      typeof options.packagePattern !== 'string' ||
      options.packagePattern.length > 50 ||
      !Array.isArray(options.events) ||
      options.events.length === 0 ||
      options.events.length > 5 ||
      !options.events.every((event) =>
        /^npm\.package\.(published|released|unpublished|deprecation_changed|dist_tag_changed)$/.test(
          event,
        ),
      ) ||
      (draft.endpoint !== null &&
        (typeof draft.endpoint?.id !== 'string' ||
          !/^[0-9A-Za-z_-]{1,64}$/.test(draft.endpoint.id) ||
          !Number.isSafeInteger(draft.endpoint.revision) ||
          draft.endpoint.revision < 1))
    )
      return null;
    return {
      project,
      endpoint:
        draft.endpoint === null
          ? null
          : { id: draft.endpoint.id, revision: draft.endpoint.revision },
      options: {
        name: options.name,
        method: options.method,
        events: [...options.events],
        packagePattern: options.packagePattern,
      },
      savedAt: draft.savedAt,
    };
  } catch {
    return null;
  }
}
