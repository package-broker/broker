import { expect } from 'vitest';
import type { WebhookDeliveries } from '@package-broker/core/sources/webhooks';
import {
  createWebhookDeliveryRepository,
  deliveryOutcomeStatement,
  insertDeliveryStatement,
  settleDeliveryStatement,
} from '../../repositories/webhook-delivery.js';
import {
  orgOf,
  seeder,
  type CaseContext,
  type ContractCase,
  type MutationEntry,
  type Seed,
} from './harness.js';
import { NOT_NULL, seedSource } from './fixtures.js';

const PROVIDER = 'github';
const DELIVERY = 'cred:' + 'a'.repeat(64);
const CREDENTIAL = 'WHCRED1';
const OTHER_CREDENTIAL = 'WHCRED2';
const REPOSITORY = 'Acme/Widgets';
const INSTALLATION = 4242;
const ORG_SCOPE = /org_id = \?/;

const delivery = { provider: PROVIDER, deliveryId: DELIVERY };

function mutating(context: CaseContext): WebhookDeliveries {
  return createWebhookDeliveryRepository({
    driver: context.executor.driver,
    all: (statement) => context.executor.all(context.mutate(statement)),
    batch: (statements) => context.executor.batch(context.mutateBatch(statements)),
  });
}

async function outcomeOf(context: CaseContext, org: 'own' | 'foreign'): Promise<unknown[]> {
  const rows = await context.executor.all<{ outcome: string }>(
    deliveryOutcomeStatement(orgOf(context)[org], delivery),
  );
  return rows.map((row) => row.outcome);
}

async function seedDelivery(seed: Seed, orgId: string, outcome = 'received'): Promise<void> {
  await seed(
    'INSERT INTO webhook_delivery (org_id, provider, delivery_id, event, outcome) VALUES (?, ?, ?, ?, ?)',
    orgId,
    PROVIDER,
    DELIVERY,
    'push',
    outcome,
  );
}

async function seedCredential(seed: Seed, id: string, orgId: string): Promise<void> {
  await seed(
    "INSERT INTO credential (id, org_id, kind, ciphertext, nonce, key_version, aad) VALUES (?, ?, 'github_app', x'00', zeroblob(12), 1, 'aad')",
    id,
    orgId,
  );
}

async function seedVcs(
  seed: Seed,
  id: string,
  orgId: string,
  options: {
    credential?: string | null;
    config?: Record<string, unknown>;
    status?: string;
    type?: string;
  } = {},
): Promise<void> {
  await seedSource(seed, id, orgId, options.type ?? 'vcs');
  const config = {
    provider: 'github',
    repository: REPOSITORY,
    installationId: INSTALLATION,
    ...options.config,
  };
  await seed(
    'UPDATE source SET credential_id = ?, config_json = ?, status = ? WHERE id = ?',
    options.credential === undefined ? CREDENTIAL : options.credential,
    JSON.stringify(config),
    options.status ?? 'active',
    id,
  );
}

const insertBindsOrganization: ContractCase = {
  name: 'a recorded delivery belongs to the supplied organization only',
  async run(context) {
    const { own } = orgOf(context);
    await context.executor.batch([
      context.mutate(insertDeliveryStatement(own, { ...delivery, event: 'push' })),
    ]);
    expect(await outcomeOf(context, 'own')).toEqual(['received']);
    expect(await outcomeOf(context, 'foreign')).toEqual([]);
  },
};

const duplicateResumes: ContractCase = {
  name: 'a repeated delivery is a duplicate that keeps its outcome',
  async run(context) {
    const repo = mutating(context);
    const { own } = orgOf(context);
    expect(await repo.record(own, { ...delivery, event: 'push' })).toEqual({ state: 'new' });
    expect(await repo.record(own, { ...delivery, event: 'push' })).toEqual({
      state: 'duplicate',
      outcome: 'received',
    });
    await repo.settle(own, { ...delivery, outcome: 'processed' });
    expect(await repo.record(own, { ...delivery, event: 'push' })).toEqual({
      state: 'duplicate',
      outcome: 'processed',
    });
    await repo.settle(own, { ...delivery, outcome: 'ignored' });
    expect(await outcomeOf(context, 'own')).toEqual(['processed']);
  },
};

const foreignDeliveryBlocks: ContractCase = {
  name: 'a delivery of another organization is neither taken over nor reported as a duplicate',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedDelivery(seeder(context.executor), foreign.orgId);
    await expect(mutating(context).record(own, { ...delivery, event: 'push' })).rejects.toThrow(
      'webhook delivery is unavailable',
    );
    expect(await outcomeOf(context, 'own')).toEqual([]);
    expect(await outcomeOf(context, 'foreign')).toEqual(['received']);
  },
};

const foreignOutcomeAbsent: ContractCase = {
  name: 'the outcome of a foreign delivery is not readable',
  async run(context) {
    await seedDelivery(seeder(context.executor), orgOf(context).foreign.orgId, 'processed');
    const rows = await context.executor.all(
      context.mutate(deliveryOutcomeStatement(orgOf(context).own, delivery)),
    );
    expect(rows).toEqual([]);
  },
};

const foreignSettleUntouched: ContractCase = {
  name: 'settling an own delivery id leaves the foreign delivery received',
  async run(context) {
    const { own, foreign } = orgOf(context);
    await seedDelivery(seeder(context.executor), foreign.orgId);
    await context.executor.batch([
      context.mutate(settleDeliveryStatement(own, { ...delivery, outcome: 'processed' })),
    ]);
    expect(await outcomeOf(context, 'foreign')).toEqual(['received']);
  },
};

const ownSettle: ContractCase = {
  name: 'settling moves only a received delivery',
  async run(context) {
    const { own } = orgOf(context);
    await seedDelivery(seeder(context.executor), own.orgId);
    await context.executor.batch([
      context.mutate(settleDeliveryStatement(own, { ...delivery, outcome: 'ignored' })),
    ]);
    expect(await outcomeOf(context, 'own')).toEqual(['ignored']);
  },
};

async function sourceIds(context: CaseContext, installationId = INSTALLATION) {
  return mutating(context).sourcesFor(orgOf(context).own, {
    credentialId: CREDENTIAL,
    installationId,
    repository: REPOSITORY,
  });
}

const foreignSourceAbsent: ContractCase = {
  name: 'a source of another organization is never selected',
  async run(context) {
    const seed = seeder(context.executor);
    const { own, foreign } = orgOf(context);
    await seedCredential(seed, CREDENTIAL, own.orgId);
    await seedVcs(seed, 'WHS-OWN', own.orgId);
    await seedVcs(seed, 'WHS-FOREIGN', foreign.orgId);
    expect(await sourceIds(context)).toEqual(['WHS-OWN']);
  },
};

const matchingOnly: ContractCase = {
  name: 'only active sources of the credential, installation and repository are selected',
  async run(context) {
    const seed = seeder(context.executor);
    const { own } = orgOf(context);
    await seedCredential(seed, CREDENTIAL, own.orgId);
    await seedCredential(seed, OTHER_CREDENTIAL, own.orgId);
    await seedVcs(seed, 'WHS-B', own.orgId, { config: { repository: 'acme/WIDGETS' } });
    await seedVcs(seed, 'WHS-A', own.orgId);
    await seedVcs(seed, 'WHS-CRED', own.orgId, { credential: OTHER_CREDENTIAL });
    await seedVcs(seed, 'WHS-NONE', own.orgId, { credential: null });
    await seedVcs(seed, 'WHS-INSTALL', own.orgId, { config: { installationId: 1 } });
    await seedVcs(seed, 'WHS-TEXT', own.orgId, {
      config: { installationId: String(INSTALLATION) },
    });
    await seedVcs(seed, 'WHS-REPO', own.orgId, { config: { repository: 'acme/other' } });
    await seedVcs(seed, 'WHS-GIT', own.orgId, { config: { provider: 'gitlab' } });
    await seedVcs(seed, 'WHS-PAUSED', own.orgId, { status: 'paused' });
    await seedVcs(seed, 'WHS-TYPE', own.orgId, { type: 'hosted' });
    expect(await sourceIds(context)).toEqual(['WHS-A', 'WHS-B']);
    expect(await sourceIds(context, 2)).toEqual([]);
  },
};

export const entries: readonly MutationEntry[] = [
  {
    builder: 'insertDeliveryStatement',
    file: 'repositories/webhook-delivery.ts',
    cases: [insertBindsOrganization, duplicateResumes, foreignDeliveryBlocks],
    predicates: [],
    waivers: [
      {
        locate: ORG_SCOPE,
        reason:
          'the insert has no organization comparison; these comparisons belong to the outcome and settle statements the repository runs after it, registered in their own entries',
      },
    ],
  },
  {
    builder: 'deliveryOutcomeStatement',
    file: 'repositories/webhook-delivery.ts',
    cases: [foreignOutcomeAbsent],
    predicates: [
      {
        name: 'delivery outcome is scoped to the organization',
        locate: ORG_SCOPE,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignOutcomeAbsent.name,
      },
    ],
  },
  {
    builder: 'settleDeliveryStatement',
    file: 'repositories/webhook-delivery.ts',
    cases: [foreignSettleUntouched, ownSettle],
    predicates: [
      {
        name: 'delivery settle is scoped to the organization',
        locate: ORG_SCOPE,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSettleUntouched.name,
      },
    ],
  },
  {
    builder: 'webhookSourcesStatement',
    file: 'repositories/webhook-delivery.ts',
    cases: [foreignSourceAbsent, matchingOnly],
    predicates: [
      {
        name: 'source is scoped to the organization',
        locate: ORG_SCOPE,
        neutral: NOT_NULL,
        copies: 1,
        caseName: foreignSourceAbsent.name,
      },
    ],
  },
];
