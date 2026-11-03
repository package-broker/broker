import type { CredentialRecord, CredentialRepository } from '../db/credentials.js';
import type {
  NotificationAttemptRepository,
  NotificationDeliveryContext,
  NotificationDeliveryRecord,
  NotificationPrepareRepository,
} from '../db/notifications.js';
import { orgContext, type OrgContext } from '../db/port.js';
import { fixedClock, ulid } from '../ids.js';
import { createNotificationCredentials } from '../notifications/credentials.js';
import { notificationEvent, type NotificationEvent } from '../notifications/events.js';
import { createNotificationBodies } from '../notifications/prepare-delivery.js';
import type { JobGuard } from '../platform/job-repository.js';
import { createSecretCipher } from '../secrets/cipher.js';
import { createCredentialStore } from '../secrets/credential-store.js';
import { createKeyring } from '../secrets/keyring.js';

export const ORG = orgContext('01J00000000000000000000A0A');
export const PROJECT = '01J0PR0JECT0000000000000PA';
export const ENDPOINT = '01J0EEEEEEEEEEEEEEEEEEEEE0';
export const EVENT = '01J0EVENT00000000000000001';
export const DELIVERY = '0b5f1c8e-2d3a-4c1b-9e7f-1a2b3c4d5e6f';
export const CREATED = '2026-11-01T12:00:00.000Z';
export const SIGNING_KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
export const LEASE: JobGuard = { id: '01J0J0B00000000000000000J1', owner: 'owner', fence: 1 };

type Row = CredentialRecord & { readonly orgId: string };

export function memoryCredentials() {
  const rows = new Map<string, Row>();
  const visible = (ctx: OrgContext, id: string) => {
    const row = rows.get(id);
    return row !== undefined && row.orgId === ctx.orgId ? row : null;
  };
  /** Rows a prepared statement would insert land here only when the batch commits. */
  const staged = new Map<string, Row>();
  const repository: CredentialRepository = {
    insertStatement(ctx, row) {
      staged.set(row.id, { ...row, orgId: ctx.orgId });
      return { sql: 'staged credential row', params: [row.id] };
    },
    async insert(ctx, row) {
      rows.set(row.id, { ...row, orgId: ctx.orgId });
    },
    async get(ctx, id) {
      return visible(ctx, id);
    },
    async listBelowVersion() {
      return [];
    },
    async reseal() {
      return false;
    },
    async delete(ctx, id) {
      return rows.delete(id);
    },
  };
  const store = createCredentialStore({
    repository,
    cipher: createSecretCipher(
      createKeyring([{ version: 1, bytes: Uint8Array.from({ length: 32 }, (_, i) => i + 1) }]),
      'credential-encryption',
    ),
    ids: { ulid },
    clock: fixedClock(CREATED),
  });
  const commit = (id: string) => {
    const row = staged.get(id);
    if (row !== undefined) rows.set(id, row);
  };
  return {
    rows,
    store,
    repository,
    commit,
    credentials: createNotificationCredentials({ store, repository }),
    bodies: createNotificationBodies({ store, repository }),
  };
}

export type MemoryCredentials = ReturnType<typeof memoryCredentials>;

export async function sealedConfiguration(
  credentials: MemoryCredentials,
  over: {
    readonly url?: string;
    readonly headers?: readonly (readonly [string, string])[];
    readonly template?: string | null;
    readonly endpointId?: string;
  } = {},
): Promise<string> {
  const sealed = await credentials.credentials.prepare(
    ORG,
    { projectId: PROJECT, endpointId: over.endpointId ?? ENDPOINT },
    {
      url: over.url ?? 'https://hooks.example.com/in/SECRETPATH?token=SECRETQUERY',
      headers: over.headers ?? [['Authorization', 'Bearer SECRETHEADER']],
      signingKey: SIGNING_KEY,
      template:
        over.template === undefined || over.template === null
          ? null
          : { text: over.template, events: ['npm.package.published'] },
    },
  );
  credentials.commit(sealed.credentialId);
  return sealed.credentialId;
}

export function publishedEvent(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return notificationEvent({
    schemaVersion: 1,
    id: EVENT,
    type: 'npm.package.published',
    occurredAt: CREATED,
    operationId: '01J0PERATN0000000000000001',
    organizationId: ORG.orgId,
    projectId: PROJECT,
    package: { ecosystem: 'npm', name: '@acme/widget', version: '1.0.0' },
    data: {},
    ...over,
  });
}

export interface WorldCall {
  readonly kind: string;
  readonly input?: unknown;
}

/**
 * One delivery in memory with the fencing rules of the SQL repositories: writes need the claim,
 * the revision read and a lease whose fence is current.
 */
export function deliveryWorld(credentials: MemoryCredentials, configurationCredentialId: string) {
  const calls: WorldCall[] = [];
  const state = {
    delivery: {
      id: DELIVERY,
      projectId: PROJECT,
      eventId: EVENT,
      endpointId: ENDPOINT,
      endpointRevision: 1,
      configurationCredentialId,
      bodyCredentialId: null,
      state: 'pending',
      attempts: 0,
      jobGeneration: 1,
      activeJobId: LEASE.id,
      activeFence: null,
      revision: 1,
      nextAttemptAt: CREATED,
      expiresAt: '2026-11-02T12:00:00.000Z',
      createdAt: CREATED,
      lastFinishedAt: null,
    } as NotificationDeliveryRecord,
    payloadJson: JSON.stringify(publishedEvent()),
    endpoint: {
      state: 'enabled',
      revision: 1,
      method: 'POST',
    } as NotificationDeliveryContext['endpoint'],
    projectActive: true,
    admitted: true,
    currentFence: LEASE.fence,
    streak: 0,
    disabled: null as string | null,
    attempts: [] as { attempt: number; outcome: string; code: string | null }[],
    audits: [] as string[],
  };
  const set = (patch: Partial<NotificationDeliveryRecord>) => {
    state.delivery = { ...state.delivery, ...patch, revision: state.delivery.revision + 1 };
  };
  const leased = (lease: JobGuard) => lease.id === LEASE.id && lease.fence === state.currentFence;
  const claimed = (lease: JobGuard, revision: number) =>
    leased(lease) &&
    state.delivery.state === 'pending' &&
    state.delivery.activeJobId === lease.id &&
    state.delivery.revision === revision;
  const fail = (now: string, code: string, counts: boolean, disable: string | null) => {
    set({ state: 'failed', activeFence: null });
    calls.push({ kind: 'terminal', input: code });
    if (!counts) return;
    state.streak += 1;
    if (disable !== null || state.streak >= 10) state.disabled = disable ?? 'failures';
    void now;
  };

  const prepare: NotificationPrepareRepository = {
    async context(ctx, id) {
      calls.push({ kind: 'context' });
      if (ctx.orgId !== ORG.orgId || id !== DELIVERY) return null;
      return {
        delivery: state.delivery,
        payloadJson: state.payloadJson,
        endpoint: state.endpoint,
        projectActive: state.projectActive,
        admitted: state.admitted,
      };
    },
    async attachBody(_ctx, lease, input) {
      calls.push({ kind: 'attachBody' });
      if (!claimed(lease, input.expectedRevision) || state.delivery.bodyCredentialId !== null)
        return false;
      credentials.commit(input.credentialId);
      state.delivery = { ...state.delivery, bodyCredentialId: input.credentialId };
      return true;
    },
    async cancel(_ctx, lease, input) {
      calls.push({ kind: 'cancel', input: input.code });
      if (!claimed(lease, input.expectedRevision)) return false;
      set({ state: 'cancelled', activeFence: null });
      state.audits.push(input.event.action);
      return true;
    },
    async finish(_ctx, lease, input) {
      calls.push({ kind: 'finish', input: input.code });
      if (!claimed(lease, input.expectedRevision)) return false;
      fail(input.now, input.code, input.code !== 'template', input.disable);
      state.audits.push(input.event.action);
      return true;
    },
  };

  const attempts: NotificationAttemptRepository = {
    async load() {
      return state.delivery;
    },
    async reserve(_ctx, lease, input) {
      calls.push({ kind: 'reserve' });
      if (
        !claimed(lease, input.expectedRevision) ||
        state.endpoint?.state !== 'enabled' ||
        state.delivery.attempts >= 8 ||
        input.now < state.delivery.nextAttemptAt
      )
        return { ok: false };
      set({ state: 'sending', attempts: state.delivery.attempts + 1, activeFence: lease.fence });
      state.attempts.push({ attempt: state.delivery.attempts, outcome: 'started', code: null });
      state.audits.push(input.event.action);
      return { ok: true, attempt: state.delivery.attempts, revision: state.delivery.revision };
    },
    async settle(_ctx, lease, input) {
      calls.push({ kind: 'settle', input });
      if (
        !leased(lease) ||
        state.delivery.state !== 'sending' ||
        state.delivery.activeFence !== lease.fence ||
        state.delivery.attempts !== input.attempt ||
        state.delivery.revision !== input.expectedRevision
      )
        return false;
      state.attempts[input.attempt - 1] = {
        attempt: input.attempt,
        outcome: input.outcome,
        code: input.code,
      };
      state.audits.push(input.event.action);
      if (input.delivery.state === 'pending') {
        set({
          state: 'pending',
          activeFence: null,
          nextAttemptAt: input.delivery.nextAttemptAt,
          lastFinishedAt: input.now,
        });
        return true;
      }
      if (input.delivery.state === 'delivered') {
        set({ state: 'delivered', activeFence: null, lastFinishedAt: input.now });
        state.streak = 0;
        return true;
      }
      fail(input.now, input.delivery.code, input.outcome !== 'unknown', input.disable);
      return true;
    },
    async reconcile(_ctx, lease, input) {
      calls.push({ kind: 'reconcile', input });
      if (
        !leased(lease) ||
        state.delivery.state !== 'sending' ||
        state.delivery.activeJobId !== lease.id ||
        (state.delivery.activeFence ?? 0) >= lease.fence
      )
        return false;
      const last = state.attempts.at(-1);
      if (last)
        state.attempts[state.attempts.length - 1] = {
          ...last,
          outcome: 'unknown',
          code: 'unknown',
        };
      state.audits.push(input.event.action);
      if (input.delivery.state === 'pending')
        set({
          state: 'pending',
          activeFence: null,
          nextAttemptAt: input.delivery.nextAttemptAt,
          lastFinishedAt: input.now,
        });
      else fail(input.now, input.delivery.code, false, null);
      return true;
    },
  };

  return { state, calls, prepare, attempts };
}
