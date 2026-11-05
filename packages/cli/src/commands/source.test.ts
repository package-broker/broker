import { openMigratedDatabase } from '@package-broker/db-sqlite/testing/migrated-database';
import { auditPendingStatement } from '@package-broker/db-sqlite/repositories/audit-pending';
import { errorResponse } from '@package-broker/core/kernel/errors';
import { describe, expect, it, vi } from 'vitest';
import { runSourceAcceptRemoval } from './source.js';

const options = {
  url: 'https://broker.test',
  source: '01JA0000000000000000000003',
  env: { PB_SESSION: 'A'.repeat(43), PB_CSRF_TOKEN: 'B'.repeat(43) },
};

describe('source accept-removal', () => {
  it('reports an audited write refusal as backlog rather than contention', async () => {
    const database = await openMigratedDatabase({ twoOrganizations: true });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const ctx = database.orgs!.a;
      await database.executor.batch([
        {
          sql: "UPDATE audit_chain SET policy = 'required', capacity_state = 'refusing' WHERE org_id = ?",
          params: [ctx.orgId],
        },
      ]);
      let failure: unknown;
      try {
        await database.executor.batch([
          auditPendingStatement(ctx, {
            id: '01K7R5V0000000000000000001',
            occurredAt: '2026-10-30T10:00:00.000Z',
            actor: { type: 'system', id: null },
            tokenSelector: null,
            sourceIp: null,
            action: 'source.removal_accepted',
            target: { type: 'source', id: options.source },
            projectId: null,
            payloadJson: '{}',
          }),
        ]);
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toMatchObject({ kind: 'backlog_full' });
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(errorResponse(failure, 'request', () => {}));
      expect(await runSourceAcceptRemoval({ ...options, fetch })).toBe(1);
      expect(error).toHaveBeenCalledExactlyOnceWith('source accept-removal: audit backlog is full');
    } finally {
      await database.close();
      error.mockRestore();
    }
  });
  it('sends the acceptance with session and CSRF authentication', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    expect(await runSourceAcceptRemoval({ ...options, fetch })).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      new URL(`https://broker.test/_pb/sources/${options.source}/accept-removal`),
      {
        method: 'POST',
        redirect: 'error',
        headers: {
          origin: 'https://broker.test',
          cookie: `__Host-pb_session=${options.env.PB_SESSION}`,
          'x-csrf-token': options.env.PB_CSRF_TOKEN,
        },
      },
    );
  });

  it.each(['not-a-ulid', '', '01JA0000000000000000000003/../x'])(
    'rejects invalid source %j',
    async (source) => {
      const fetch = vi.fn();
      expect(await runSourceAcceptRemoval({ ...options, source, fetch })).toBe(2);
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    'http://broker.test',
    'https://secret@broker.test',
    'https://broker.test/?token=secret',
  ])('rejects unsafe origins', async (url) => {
    const fetch = vi.fn();
    expect(await runSourceAcceptRemoval({ ...options, url, fetch })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 500])('does not print response data on HTTP %s', async (status) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(new Response('secret-account@example.test', { status }));
      expect(await runSourceAcceptRemoval({ ...options, fetch })).toBe(1);
      expect(JSON.stringify(error.mock.calls)).not.toContain('secret-account');
    } finally {
      error.mockRestore();
    }
  });

  it('reports an unknown outcome without echoing a network error', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('secret'));
    expect(await runSourceAcceptRemoval({ ...options, fetch })).toBe(6);
  });
});
