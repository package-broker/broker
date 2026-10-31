import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { verifyChain, type AuditRow } from '@package-broker/core/audit/chain';
import type { AuditExportHead, VerifiedAuditArtifact } from '@package-broker/core/audit/cutover';
import { auditWireRecord } from '@package-broker/core/audit/wire';
import { assertAuditLedgerEntry, type AuditLedgerEntry } from '@package-broker/core/audit/ledger';
import { isUlid } from '@package-broker/core/ids';

export class AuditArtifactError extends Error {
  override readonly name = 'AuditArtifactError';
  constructor(readonly code: string) {
    super('Audit artifact refused');
  }
}
export function requireAudit(value: unknown): asserts value {
  if (!value) throw new AuditArtifactError('invalid_artifact');
}
export function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parseAuditHead(value: unknown): AuditExportHead {
  requireAudit(object(value));
  const { chainId, epoch, boundarySeq, boundaryPrevHash, headSeq, headHash } = value;
  requireAudit(typeof chainId === 'string' && /^[0-9a-f]{32}$/.test(chainId));
  requireAudit(
    [epoch, boundarySeq, headSeq].every((n) => Number.isSafeInteger(n) && (n as number) >= 0),
  );
  requireAudit((boundarySeq as number) >= 1 && (boundarySeq as number) - 1 <= (headSeq as number));
  requireAudit(
    [headHash, boundaryPrevHash].every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)),
  );
  return { chainId, epoch, boundarySeq, boundaryPrevHash, headSeq, headHash } as AuditExportHead;
}

export async function safeAuditItem(value: unknown): Promise<Record<string, unknown>> {
  requireAudit(object(value));
  const { kind, chain_id, epoch, org_id, seq, prev_hash, hash } = value;
  requireAudit(typeof chain_id === 'string' && /^[0-9a-f]{32}$/.test(chain_id));
  requireAudit(
    Number.isSafeInteger(epoch) &&
      (epoch as number) >= 0 &&
      typeof org_id === 'string' &&
      isUlid(org_id),
  );
  requireAudit(Number.isSafeInteger(seq) && (seq as number) > 0);
  requireAudit([prev_hash, hash].every((h) => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)));
  const base = { kind, chain_id, epoch, org_id, seq, prev_hash, hash };
  if (kind === 'withheld') {
    requireAudit(typeof value.marker_id === 'string' && isUlid(value.marker_id));
    requireAudit(['unreadable', 'content_unavailable'].includes(value.reason_code as string));
    return { ...base, marker_id: value.marker_id, reason_code: value.reason_code };
  }
  requireAudit(kind === 'event');
  const keys = [
    'id',
    'created_at',
    'actor_type',
    'actor_id',
    'token_selector',
    'action',
    'target_type',
    'target_id',
    'project_id',
    'payload_json',
  ] as const;
  const row = {
    ...Object.fromEntries(keys.map((key) => [key, value[key]])),
    org_id,
    seq,
    prev_hash,
    hash,
    source_ip: value.source_ip ?? null,
  } as unknown as AuditRow;
  const projected = await auditWireRecord(
    { chainId: chain_id, epoch: epoch as number, orgId: org_id },
    row,
    'include',
  );
  requireAudit(projected.kind === 'event');
  requireAudit((await verifyChain([row], row.prev_hash, row.seq)) === null);
  return {
    ...base,
    ...Object.fromEntries(keys.map((key) => [key, value[key]])),
    ...(value.source_ip === undefined ? {} : { source_ip: value.source_ip }),
  };
}

export function safeDisposition(value: unknown): AuditLedgerEntry {
  requireAudit(object(value));
  const keys = [
    'id',
    'kind',
    'chainId',
    'epoch',
    'fromSeq',
    'toSeq',
    'count',
    'sinkId',
    'reasonCode',
    'policy',
    'modeGeneration',
    'actorType',
    'actorId',
    'createdAt',
    'resolvesId',
    'capacity',
  ];
  const entry = Object.fromEntries(
    keys.filter((k) => value[k] !== undefined).map((k) => [k, value[k]]),
  ) as unknown as AuditLedgerEntry;
  try {
    assertAuditLedgerEntry(entry);
  } catch {
    throw new AuditArtifactError('invalid_artifact');
  }
  return entry;
}

export class AuditArtifactVerifier {
  private readonly digest = createHash('sha256');
  private head: AuditExportHead | null = null;
  private next = 0;
  private prev = '';
  private orgId: string | null = null;
  private bodies = 0;
  private withheld = 0;
  private ended = false;

  async consume(value: unknown, line: string): Promise<void> {
    requireAudit(!this.ended && object(value));
    if (this.head === null) {
      requireAudit(
        value.kind === 'audit-export' && value.schema === 'audit-chain/1' && value.version === 1,
      );
      this.head = parseAuditHead(value.snapshot);
      this.next = this.head.boundarySeq;
      this.prev = this.head.boundaryPrevHash;
    } else if (value.kind === 'end') {
      requireAudit(this.next - 1 === this.head.headSeq && this.prev === this.head.headHash);
      requireAudit(value.bodies === this.bodies && value.withheld === this.withheld);
      requireAudit(value.sha256 === this.digest.digest('hex'));
      this.ended = true;
      return;
    } else if (value.kind === 'cursor') {
      requireAudit(value.next === this.next);
    } else if (value.kind === 'disposition') {
      const entry = safeDisposition(value.entry);
      requireAudit(entry.chainId === this.head.chainId && entry.epoch === this.head.epoch);
      requireAudit(entry.fromSeq <= this.head.headSeq && entry.toSeq >= this.head.boundarySeq);
    } else {
      const row = await safeAuditItem(value);
      requireAudit(row.chain_id === this.head.chainId && row.epoch === this.head.epoch);
      requireAudit(
        row.seq === this.next && row.prev_hash === this.prev && this.next <= this.head.headSeq,
      );
      if (this.orgId === null) this.orgId = row.org_id as string;
      requireAudit(row.org_id === this.orgId);
      this.next++;
      this.prev = row.hash as string;
      if (row.kind === 'event') this.bodies++;
      else this.withheld++;
    }
    this.digest.update(line + '\n');
  }
  progress() {
    requireAudit(this.head && !this.ended);
    return { head: this.head, next: this.next };
  }
  footer(): Record<string, unknown> {
    requireAudit(
      !this.ended &&
        this.head &&
        this.next - 1 === this.head.headSeq &&
        this.prev === this.head.headHash,
    );
    return {
      kind: 'end',
      bodies: this.bodies,
      withheld: this.withheld,
      sha256: this.digest.copy().digest('hex'),
    };
  }
  result(): VerifiedAuditArtifact {
    requireAudit(this.ended && this.head);
    return { ...this.head, orgId: this.orgId, bodies: this.bodies, withheld: this.withheld };
  }
}

export async function verifyAuditArtifact(file: string): Promise<VerifiedAuditArtifact> {
  const stream = createReadStream(file);
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const verifier = new AuditArtifactVerifier();
  try {
    for await (const line of lines) {
      requireAudit(Buffer.byteLength(line) <= 131072);
      try {
        await verifier.consume(JSON.parse(line), line);
      } catch {
        throw new AuditArtifactError('invalid_artifact');
      }
    }
    return verifier.result();
  } finally {
    lines.close();
    stream.destroy();
  }
}
