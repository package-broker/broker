import { expect, it, vi } from 'vitest';
import { orgContext, type Statement } from '../db/port.js';
import { fixedClock, ulid } from '../ids.js';
import { createKeyring } from '../secrets/keyring.js';
import { verifyToken } from '../secrets/token-hash.js';
import { createWorkloadTokenService, type WorkloadTokenStore } from './service-token-service.js';

it('mints a hashed workload secret once with an explicit fifteen-minute expiry and safe audit', async () => {
  const keyring = createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]);
  const fence = {
    publisher: {
      id: 'publisher',
      packageName: 'test',
      repositoryId: '123',
      repositoryOwnerId: '456',
      workflow: 'publish.yml',
      environment: '',
      servicePrincipalId: 'principal',
      revision: 1,
      refPattern: null,
    },
    replay: { appendTo: (batch: readonly Statement[]) => batch },
  };
  const issueWorkload = vi.fn<WorkloadTokenStore['issueWorkload']>(
    async (_ctx, _fence, input, mint) => {
      const minted = await mint();
      expect(await verifyToken(keyring, minted.pepperVersion, minted.plaintext, minted.hash)).toBe(
        true,
      );
      expect(minted.plaintext).toMatch(/^pb_svc_[a-z2-7]{12}_[A-Za-z0-9_-]{43}$/);
      expect(input).toMatchObject({
        now: '2026-10-31T00:00:00.000Z',
        expiresAt: '2026-10-31T00:15:00.000Z',
        audit: {
          action: 'token.workload_issue',
          actor: { type: 'service_principal', id: 'principal' },
          target: { type: 'token', id: input.id },
        },
      });
      expect(input.audit.payloadJson).not.toContain(minted.plaintext);
      expect(input.audit.payloadJson).not.toContain(minted.hash);
      return { status: 'issued', id: input.id, plaintext: minted.plaintext };
    },
  );
  const service = createWorkloadTokenService({
    tokens: { issueWorkload },
    keyring,
    clock: fixedClock('2026-10-31T00:00:00.000Z'),
    ids: { ulid },
  });
  const result = await service.issueWorkload(orgContext('org'), fence, {
    requestId: ulid(),
    changes: { package: { new: 'test' } },
  });
  expect(issueWorkload).toHaveBeenCalledExactlyOnceWith(
    orgContext('org'),
    fence,
    expect.any(Object),
    expect.any(Function),
  );
  expect(result).toMatchObject({
    status: 'issued',
    token: expect.stringMatching(/^pb_svc_/),
    created: '2026-10-31T00:00:00.000Z',
    expires: '2026-10-31T00:15:00.000Z',
  });
});

it('preserves selector exhaustion from the workload store for HTTP classification', async () => {
  const service = createWorkloadTokenService({
    tokens: { issueWorkload: async () => ({ status: 'refused', reason: 'selector_collision' }) },
    keyring: createKeyring([{ version: 1, bytes: new Uint8Array(32).fill(7) }]),
    clock: fixedClock('2026-10-31T00:00:00.000Z'),
    ids: { ulid },
  });
  expect(
    await service.issueWorkload(
      orgContext('org'),
      {
        publisher: {
          id: 'publisher',
          packageName: 'test',
          repositoryId: '123',
          repositoryOwnerId: '456',
          workflow: 'publish.yml',
          environment: '',
          servicePrincipalId: 'principal',
          revision: 1,
          refPattern: null,
        },
        replay: { appendTo: (batch: readonly Statement[]) => batch },
      },
      { requestId: ulid(), changes: { package: { new: 'test' } } },
    ),
  ).toEqual({
    status: 'refused',
    reason: 'selector_collision',
  });
});
