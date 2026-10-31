import { auditEvent } from '@package-broker/core/audit/actions';
import { systemClock, ulid } from '@package-broker/core/ids';
import { auditPendingStatement } from './audit-pending.js';
import type { OrgContext, SqlExecutor, Statement } from '@package-broker/core/db/port';
import type { MutationFence } from '@package-broker/core/authz/fence';
import type {
  PersonalTokenStoreInput,
  MintedPersonalToken,
} from '@package-broker/core/authz/pat-service';
import { createSecretCipher } from '@package-broker/core/secrets/cipher';
import type { Keyring } from '@package-broker/core/secrets/keyring';
import { base64urlEncode, base64urlDecode } from '@package-broker/core/auth/primitives';
import { sql } from 'kysely';
import { assertCheck } from '../kysely.js';
import { createTokenRepository } from './token.js';

export function createNpmLoginRepository(executor: SqlExecutor, keyring: Keyring) {
  const cipher = createSecretCipher(keyring, 'npm-login');
  return {
    async start(
      ctx: OrgContext,
      input: {
        id: string;
        projectId: string;
        selectorHash: string;
        doneHash: string;
        hostname: string | null;
        sourceIp: string | null;
      },
    ) {
      const result = await executor.batch([
        {
          sql: `INSERT INTO npm_login_session (id, org_id, project_id, selector_hash, done_hash, cli_hostname, source_ip, expires_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+5 minutes')
          WHERE EXISTS (SELECT 1 FROM project WHERE org_id = ? AND id = ? AND status = 'active')
          AND (SELECT count(*) FROM npm_login_session WHERE org_id = ? AND project_id = ? AND state = 'pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) < 20
          AND (SELECT count(*) FROM npm_login_session WHERE org_id = ? AND state = 'pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')) < 200 RETURNING id`,
          params: [
            input.id,
            ctx.orgId,
            input.projectId,
            input.selectorHash,
            input.doneHash,
            input.hostname,
            input.sourceIp,
            ctx.orgId,
            input.projectId,
            ctx.orgId,
            input.projectId,
            ctx.orgId,
          ],
        },
      ]);
      return result[0]?.rows.length === 1;
    },
    async confirmation(ctx: OrgContext, selectorHash: string) {
      const rows = await executor.all<{
        projectId: string;
        name: string;
        slug: string;
        cliHostname: string | null;
        sourceIp: string | null;
        createdAt: string;
        expiresAt: string;
      }>({
        sql: `SELECT p.id AS projectId, p.name, p.slug, l.cli_hostname AS cliHostname, l.source_ip AS sourceIp, l.created_at AS createdAt, l.expires_at AS expiresAt
          FROM npm_login_session l JOIN project p ON p.org_id = l.org_id AND p.id = l.project_id
          WHERE l.org_id = ? AND l.selector_hash = ? AND l.state = 'pending' AND l.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now') AND p.status = 'active' LIMIT 1`,
        params: [ctx.orgId, selectorHash],
      });
      return rows[0] ?? null;
    },
    async approveNpmLogin(
      ctx: OrgContext,
      fence: MutationFence,
      input: PersonalTokenStoreInput,
      mint: () => MintedPersonalToken | Promise<MintedPersonalToken>,
      selectorHash: string,
    ) {
      if (
        input.projectMode !== 'selected' ||
        input.projectIds.length !== 1 ||
        input.scope === 'full'
      )
        return { status: 'refused', reason: 'authority' } as const;
      if ((await this.confirmation(ctx, selectorHash)) === null)
        return { status: 'refused', reason: 'id_conflict' } as const;
      let sealed: { ciphertext: string; nonce: string; version: number } | undefined;
      const live = sql<boolean>`exists (select 1 from npm_login_session where org_id = ${ctx.orgId} and selector_hash = ${selectorHash} and project_id = ${input.projectIds[0]} and state = 'pending' and expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
      const wrapped: SqlExecutor = {
        driver: executor.driver,
        all: (statement) => executor.all(statement),
        async batch(statements) {
          if (sealed === undefined) throw new TypeError('Login token was not sealed');
          const update: Statement = {
            sql: `UPDATE npm_login_session SET state = 'approved', user_id = ?, token_id = ?, token_ciphertext = ?, token_nonce = ?, token_key_version = ?
              WHERE org_id = ? AND selector_hash = ? AND project_id = ? AND state = 'pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
              AND EXISTS (SELECT 1 FROM token WHERE org_id = ? AND id = ? AND user_id = ? AND kind = 'pat')`,
            params: [
              fence.userId,
              input.id,
              sealed.ciphertext,
              sealed.nonce,
              sealed.version,
              ctx.orgId,
              selectorHash,
              input.projectIds[0]!,
              ctx.orgId,
              input.id,
              fence.userId,
            ],
          };
          const linked = sql<boolean>`exists (select 1 from npm_login_session l join token t on t.org_id = l.org_id and t.id = l.token_id and t.user_id = l.user_id where l.org_id = ${ctx.orgId} and l.selector_hash = ${selectorHash} and l.token_id = ${input.id} and l.user_id = ${fence.userId} and l.state = 'approved')`;
          return executor.batch([
            ...assertCheck(live),
            ...statements,
            update,
            ...assertCheck(linked),
          ]);
        },
      };
      const outcome = await createTokenRepository(wrapped).issuePersonal(
        ctx,
        fence,
        input,
        async () => {
          const minted = await mint();
          const box = await cipher.seal(
            new TextEncoder().encode(minted.plaintext),
            `npm-login/${ctx.orgId}/${selectorHash}`,
          );
          sealed = {
            ciphertext: base64urlEncode(box.ciphertext),
            nonce: base64urlEncode(box.nonce),
            version: box.keyVersion,
          };
          return minted;
        },
      );
      if (outcome.status === 'refused' && (await this.confirmation(ctx, selectorHash)) === null)
        return { status: 'refused', reason: 'id_conflict' } as const;
      if (outcome.status === 'refused' && outcome.reason === 'unclassified')
        return { status: 'refused', reason: 'authority' } as const;
      return outcome;
    },
    async poll(ctx: OrgContext, projectId: string, doneHash: string) {
      const predicate = `org_id = ? AND project_id = ? AND done_hash = ? AND state = 'approved' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
      const params: [orgId: string, projectId: string, doneHash: string] = [
        ctx.orgId,
        projectId,
        doneHash,
      ];
      const result = await executor.batch([
        {
          sql: `SELECT selector_hash, token_id, token_ciphertext, token_nonce, token_key_version FROM npm_login_session WHERE ${predicate}`,
          params,
        },
        {
          sql: `UPDATE npm_login_session SET state = 'consumed', consumed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), token_ciphertext = NULL, token_nonce = NULL, token_key_version = NULL WHERE ${predicate} RETURNING id`,
          params,
        },
      ]);
      if (result[1]?.rows.length === 1) {
        const row = result[0]?.rows[0] as
          | {
              selector_hash: string;
              token_id: string;
              token_ciphertext: string;
              token_nonce: string;
              token_key_version: number;
            }
          | undefined;
        if (row === undefined) throw new Error('Login consume failed');
        try {
          const token = await cipher.open(
            {
              ciphertext: base64urlDecode(row.token_ciphertext),
              nonce: base64urlDecode(row.token_nonce),
              keyVersion: row.token_key_version,
            },
            `npm-login/${ctx.orgId}/${row.selector_hash}`,
          );
          return { status: 'token', token: new TextDecoder().decode(token) } as const;
        } catch {
          const now = systemClock.now().toISOString();
          const op = ulid();
          const audit = auditEvent({
            id: ulid(),
            now,
            action: 'token.revoke',
            actor: { type: 'system', id: null },
            context: { opId: op, requestId: op, sourceIp: null, tokenSelector: null },
            target: { type: 'token', id: row.token_id },
            projectId: null,
            changes: { cause: { new: 'login_delivery_failed' } },
          });
          if (!audit.ok) throw new TypeError('Invalid login delivery audit');
          const condition = {
            sql: 'EXISTS (SELECT 1 FROM token WHERE org_id = ? AND id = ? AND revoked_at IS NULL)',
            params: [ctx.orgId, row.token_id] as [orgId: string, tokenId: string],
          };
          await executor.batch([
            auditPendingStatement(ctx, audit.event, condition),
            {
              sql: 'UPDATE token SET revoked_at = ?, last_op_id = ? WHERE org_id = ? AND id = ? AND revoked_at IS NULL',
              params: [now, op, ctx.orgId, row.token_id],
            },
          ]);
          return { status: 'not_found' } as const;
        }
      }
      const pending = await executor.all({
        sql: `SELECT 1 FROM npm_login_session WHERE org_id = ? AND project_id = ? AND done_hash = ? AND state = 'pending' AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
        params,
      });
      return { status: pending.length === 1 ? 'pending' : 'not_found' } as const;
    },
  };
}
