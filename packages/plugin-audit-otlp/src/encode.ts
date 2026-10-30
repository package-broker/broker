import type { AuditBatchV1 } from '@package-broker/core/plugin';

interface Attribute {
  readonly key: string;
  readonly value: { readonly stringValue: string };
}

function attributes(fields: object): Attribute[] {
  return Object.entries(fields)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => {
      if (
        !['string', 'number', 'boolean'].includes(typeof value) ||
        (typeof value === 'number' && !Number.isFinite(value))
      ) {
        throw new TypeError('Invalid audit attribute');
      }
      return {
        key: `pb.audit.${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`,
        value: { stringValue: String(value) },
      };
    });
}

function nanos(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError('Invalid audit timestamp');
  }
  const value = BigInt(milliseconds) * 1_000_000n;
  if (value > 18_446_744_073_709_551_615n) {
    throw new TypeError('Invalid audit timestamp');
  }
  return String(value);
}

/** The caller freezes the delivery time with the batch for byte-identical retries. */
export function encodeAuditBatch(batch: AuditBatchV1, observedAt: Date): string {
  const observedTimeUnixNano = nanos(observedAt.getTime());
  const logRecords = batch.records.map((record) => {
    const event = record.kind === 'event';
    const createdAt = 'createdAt' in record ? record.createdAt : undefined;
    if (
      createdAt !== undefined &&
      (typeof createdAt !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt))
    ) {
      throw new TypeError('Invalid audit timestamp');
    }
    return {
      timeUnixNano: createdAt === undefined ? observedTimeUnixNano : nanos(Date.parse(createdAt)),
      observedTimeUnixNano,
      eventName: event
        ? `package_broker.audit.${record.action}`
        : `package_broker.audit.marker.${record.kind}`,
      body: { stringValue: event ? record.action : record.kind },
      attributes: [
        ...attributes(record),
        ...(event && record.sourceIp != null
          ? [{ key: 'pb.audit.source_ip.hashed', value: { stringValue: 'false' } }]
          : []),
      ],
    };
  });
  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: {
          attributes: attributes({
            v: batch.v,
            chainId: batch.chainId,
            epoch: batch.epoch,
            orgId: batch.orgId,
            throughSeq: batch.throughSeq,
            throughHash: batch.throughHash,
          }),
        },
        scopeLogs: [
          { scope: { name: 'package-broker.audit', version: 'audit-otlp/1' }, logRecords },
        ],
      },
    ],
  });
  if (new TextEncoder().encode(body).length > 512 * 1024) {
    throw new RangeError('Audit OTLP body exceeds byte limit');
  }
  return body;
}
