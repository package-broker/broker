import assert from 'node:assert/strict';

export interface WireEnvelope {
  chain_id: string;
  org_id: string;
  epoch: number;
  records: Record<string, unknown>[];
}

export function decodeOtlp(
  body: Record<string, unknown>,
): WireEnvelope & { through_seq: number; through_hash: string } {
  type Attribute = { key: string; value: { stringValue: string } };
  const fields = (attributes: Attribute[]) =>
    Object.fromEntries(
      attributes.map((attribute) => {
        assert(attribute.key.startsWith('pb.audit.'), 'InvalidOtlpAttribute');
        const key = attribute.key.slice('pb.audit.'.length);
        const value = attribute.value.stringValue;
        return [
          key,
          [
            'epoch',
            'seq',
            'from_seq',
            'to_seq',
            'last_common_seq',
            'boundary_seq',
            'through_seq',
            'count',
          ].includes(key)
            ? Number(value)
            : value,
        ];
      }),
    );
  const resources = body['resourceLogs'] as {
    resource: { attributes: Attribute[] };
    scopeLogs: { logRecords: { attributes: Attribute[] }[] }[];
  }[];
  assert(Array.isArray(resources) && resources.length === 1, 'InvalidOtlpResources');
  const resource = resources[0]!;
  const attributes = fields(resource.resource.attributes);
  return {
    chain_id: attributes['chain_id'] as string,
    org_id: attributes['org_id'] as string,
    epoch: attributes['epoch'] as number,
    through_seq: attributes['through_seq'] as number,
    through_hash: attributes['through_hash'] as string,
    records: resource.scopeLogs.flatMap((scope) =>
      scope.logRecords.map((row) => fields(row.attributes)),
    ),
  };
}

export function assertWireIdentity(value: WireEnvelope, orgId: string | undefined): void {
  assert(orgId && value.org_id === orgId, 'ForeignReceiverOrganization');
  assert(
    typeof value.chain_id === 'string' &&
      value.chain_id.length > 0 &&
      Number.isSafeInteger(value.epoch) &&
      value.epoch >= 0,
    'InvalidReceiverIdentity',
  );
  assert(Array.isArray(value.records) && value.records.length > 0, 'EmptyReceiverBatch');
  for (const record of value.records) {
    assert(
      record['chain_id'] === value.chain_id && record['epoch'] === value.epoch,
      'ForeignReceiverRecordIdentity',
    );
    if (record['kind'] === 'event' || record['kind'] === 'withheld')
      assert(record['org_id'] === orgId, 'ForeignReceiverRecordOrganization');
  }
}
