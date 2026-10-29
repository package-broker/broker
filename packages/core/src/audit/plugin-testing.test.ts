import { describe, expect, it } from 'vitest';
import { canonicalRow, hashRow } from './chain.js';
import type { AuditBatchV1, AuditDelivery, AuditSink } from './plugin-api.js';
import {
  auditCanonicalVectors,
  auditMarkerFixtures,
  auditSinkConformanceFixtures,
  AuditSinkConformanceError,
  runAuditSinkConformance,
  type AuditSinkConformanceAdapter,
} from './plugin-testing.js';
import { auditWireRecord } from './wire.js';

function adapter(
  change?: (sink: AuditSink, generation: number) => AuditSink,
  partialOutcome: AuditSinkConformanceAdapter['partialOutcome'] = 'uncertain',
): AuditSinkConformanceAdapter {
  return {
    acknowledgement: 'receiver',
    partialOutcome,
    wireFormat: 'json',
    wireRecords: (body) => (JSON.parse(body) as { records: Record<string, unknown>[] }).records,
    decode: (body) => {
      const value = JSON.parse(body) as AuditBatchV1 | { probe: string };
      return 'probe' in value
        ? null
        : {
            ...value,
            records: value.records.map((record) =>
              Object.fromEntries(
                Object.entries(record).map(([key, value]) => [
                  key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
                  value,
                ]),
              ),
            ) as unknown as AuditBatchV1['records'],
          };
    },
    respond: (reply, batch, options) => {
      const ack = {
        outcome: 'accepted',
        chainId: batch.chainId,
        epoch: batch.epoch,
        throughSeq: batch.throughSeq,
        throughHash: batch.throughHash,
      } as const;
      let result: AuditDelivery = ack;
      if (reply === 'wrong_epoch') result = { ...ack, epoch: batch.epoch + 1 };
      if (reply === 'partial')
        result =
          partialOutcome === 'uncertain'
            ? {
                outcome: 'uncertain',
                code: 'partial_rejected',
                rejectedCount: options.rejectedCount!,
              }
            : { ...ack, outcome: 'accepted_with_warning', code: 'partial_success' };
      if (reply === 'rejected') result = { outcome: 'rejected', code: 'http_status' };
      if (reply === 'retry')
        return {
          status: options.status!,
          contentType: 'application/json',
          retryAfterMs: options.retryAfterMs ?? null,
          body: '{}',
        };
      if (reply === 'bad_response')
        return {
          status: 200,
          contentType: options.invalid === 'content_type' ? 'text/plain' : 'application/json',
          retryAfterMs: null,
          body:
            options.invalid === 'body'
              ? '{'
              : options.invalid === 'ack'
                ? '{}'
                : JSON.stringify(ack),
        };
      return {
        status: 200,
        contentType: 'application/json',
        retryAfterMs: null,
        body: JSON.stringify(result),
      };
    },
    frontierResponse: (position) => ({
      status: 200,
      contentType: 'application/json',
      retryAfterMs: null,
      body: JSON.stringify(position),
    }),
    create: (ctx, generation) => {
      const sink: AuditSink = {
        deliver: async (batch, signal) => {
          const response = await ctx.fetch({
            body: JSON.stringify({
              ...batch,
              records: batch.records.map((record) =>
                Object.fromEntries(
                  Object.entries(record).map(([key, value]) => [
                    key.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase()),
                    value,
                  ]),
                ),
              ),
            }),
            contentType: 'application/json',
            signal,
          });
          if (response.status === 408 || response.status === 429 || response.status >= 500)
            return {
              outcome: 'retry',
              code: 'http_status',
              ...(response.retryAfterMs === null ? {} : { retryAfterMs: response.retryAfterMs }),
            };
          if (response.contentType !== 'application/json')
            return { outcome: 'retry', code: 'bad_response' };
          try {
            const result = JSON.parse(response.body) as AuditDelivery;
            return result.outcome === undefined
              ? { outcome: 'retry', code: 'bad_response' }
              : result;
          } catch {
            return { outcome: 'retry', code: 'bad_response' };
          }
        },
        frontier: async (signal) => {
          const response = await ctx.fetch({
            body: '{"probe":"frontier"}',
            contentType: 'application/json',
            signal,
          });
          return JSON.parse(response.body);
        },
      };
      return change?.(sink, generation) ?? sink;
    },
  };
}

describe('published audit-chain/1 vectors', () => {
  it.each(auditCanonicalVectors)(
    'pins canonical bytes, hash, and mapping for $name',
    async (vector) => {
      expect(vector.format).toBe('audit-chain/1');
      expect(canonicalRow(vector.row)).toBe(vector.canonical);
      expect(await hashRow(vector.row.prev_hash, vector.row)).toBe(vector.row.hash);
      expect(
        await auditWireRecord(
          {
            chainId: vector.record.chainId,
            epoch: vector.record.epoch,
            orgId: vector.record.orgId,
          },
          vector.row,
          'include',
        ),
      ).toEqual(vector.record);
      const { kind, chainId, epoch, sourceIp, ...record } = vector.record;
      const wire = { ...vector.row, kind, chain_id: chainId, epoch } as Record<string, unknown>;
      if (sourceIp === undefined) delete wire['source_ip'];
      expect(wire).toEqual(vector.wire);
      expect(Object.keys(record)).toHaveLength(14);
      expect(Object.keys(JSON.parse(vector.canonical) as object)).toHaveLength(13);
      expect(Object.isFrozen(vector.row)).toBe(true);
      expect(Object.isFrozen(vector.record)).toBe(true);
      expect(
        await hashRow(vector.row.prev_hash, { ...vector.row, source_ip: '198.51.100.1' }),
      ).toBe(vector.row.hash);
    },
  );

  it('pins exact payload bytes and all nullable fields', async () => {
    const vector = auditCanonicalVectors[0]!;
    const payload = JSON.parse(vector.row.payload_json) as unknown;
    const reordered = JSON.stringify(payload, null, 1);
    expect(
      await hashRow(vector.row.prev_hash, { ...vector.row, payload_json: reordered }),
    ).not.toBe(vector.row.hash);
    expect(auditCanonicalVectors[1]!.row.created_at < vector.row.created_at).toBe(true);
    expect(auditCanonicalVectors[2]!.row.seq).toBe(Number.MAX_SAFE_INTEGER);
    expect(auditCanonicalVectors[1]!.record.actorId).toBeNull();
    expect(auditCanonicalVectors[1]!.record.tokenSelector).toBeNull();
    expect(auditCanonicalVectors[1]!.record.targetId).toBeNull();
  });
});

describe('sink fixture runner', () => {
  it.each(['uncertain', 'accepted_with_warning'] as const)(
    'runs all scenarios for partial outcome %s',
    async (outcome) => {
      const result = await runAuditSinkConformance(adapter(undefined, outcome));
      expect(result.passed).toEqual(auditSinkConformanceFixtures.map(({ name }) => name));
      expect(result.frontier).toBe('passed');
      expect(result.acknowledgement).toBe('receiver');
      expect(result.partialOutcome).toBe(outcome);
      expect(result.passed).toHaveLength(15);
    },
  );

  it('rejects the reviewer sink that wraps camelCase records and accepts non-errors', async () => {
    const base = adapter();
    const broken: AuditSinkConformanceAdapter = {
      ...base,
      decode: (body) => {
        const value = JSON.parse(body) as Omit<AuditBatchV1, 'records'> & {
          records: { __camel: AuditBatchV1['records'][number] }[];
        };
        return { ...value, records: value.records.map((record) => record.__camel) };
      },
      create: (ctx) => ({
        deliver: async (batch, signal) => {
          const response = await ctx.fetch({
            body: JSON.stringify({
              ...batch,
              records: batch.records.map((record) => ({ __camel: record })),
            }),
            contentType: 'application/json',
            signal,
          });
          if (response.status === 400) return { outcome: 'rejected', code: 'http_status' };
          const result = JSON.parse(response.body) as AuditDelivery;
          if (result.outcome === 'uncertain') return result;
          return {
            outcome: 'accepted',
            chainId: batch.chainId,
            epoch: batch.epoch,
            throughSeq: batch.throughSeq,
            throughHash: batch.throughHash,
          };
        },
      }),
    };
    await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
      fixture: 'canonical-vectors',
    });
  });

  it.each(['retry', 'bad_response'] as const)('rejects acceptance after %s', async (reply) => {
    const base = adapter();
    const broken = {
      ...base,
      respond: (input, batch, options) =>
        base.respond(input === reply ? 'accepted' : input, batch, options),
    } satisfies AuditSinkConformanceAdapter;
    await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
      fixture: reply === 'retry' ? 'retryable-http-status' : 'invalid-success-response',
    });
  });

  it('rejects a sink reporting acceptance after an actual 503 response', async () => {
    const base = adapter();
    let saw503 = false;
    const broken: AuditSinkConformanceAdapter = {
      ...base,
      create: (ctx, generation) => {
        let status = 0;
        const sink = base.create(
          {
            ...ctx,
            fetch: async (request) => {
              const response = await ctx.fetch(request);
              status = response.status;
              return response;
            },
          },
          generation,
        );
        return {
          ...sink,
          deliver: async (batch, signal) => {
            const result = await sink.deliver(batch, signal);
            if (status !== 503) return result;
            saw503 = true;
            return {
              outcome: 'accepted',
              chainId: batch.chainId,
              epoch: batch.epoch,
              throughSeq: batch.throughSeq,
              throughHash: batch.throughHash,
            };
          },
        };
      },
    };
    await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
      fixture: 'retryable-http-status',
    });
    expect(saw503).toBe(true);
  });

  it('rejects a sink that drops retryAfterMs', async () => {
    await expect(
      runAuditSinkConformance(
        adapter((sink) => ({
          ...sink,
          deliver: async (batch, signal) => {
            const result = await sink.deliver(batch, signal);
            return result.outcome === 'retry'
              ? { outcome: result.outcome, code: result.code }
              : result;
          },
        })),
      ),
    ).rejects.toMatchObject({ fixture: 'retryable-http-status' });
  });

  it.each(['lost-ack-after-commit', 'crash-before-marker-commit', 'crash-after-marker-commit'])(
    'rejects acceptance after a transport fault in %s',
    async (fixture) => {
      let creates = 0;
      const targetIndex = auditSinkConformanceFixtures
        .slice(
          0,
          auditSinkConformanceFixtures.findIndex(({ name }) => name === fixture),
        )
        .reduce(
          (count, item) =>
            count +
            1 +
            (item.overlap ? item.steps.length : item.steps.filter((step) => step.restart).length),
          0,
        );
      const base = adapter();
      const broken = {
        ...base,
        create: (ctx, generation) => {
          const mask = creates++ === targetIndex;
          const sink = base.create(ctx, generation);
          return {
            ...sink,
            deliver: async (batch, signal) => {
              try {
                return await sink.deliver(batch, signal);
              } catch (error) {
                if (!mask) throw error;
                return {
                  outcome: 'accepted' as const,
                  chainId: batch.chainId,
                  epoch: batch.epoch,
                  throughSeq: batch.throughSeq,
                  throughHash: batch.throughHash,
                };
              }
            },
          };
        },
      } satisfies AuditSinkConformanceAdapter;
      await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({ fixture });
    },
  );

  it('allows timeout classification for lost acknowledgements and crashes', async () => {
    const result = await runAuditSinkConformance(
      adapter((sink) => ({
        ...sink,
        deliver: async (batch, signal) => {
          try {
            return await sink.deliver(batch, signal);
          } catch {
            return { outcome: 'retry', code: 'timeout' };
          }
        },
      })),
    );
    expect(result.passed).toHaveLength(15);
  });

  it.each([0, 91])('accepts any differing receiver epoch (%s)', async (epoch) => {
    const base = adapter();
    const result = await runAuditSinkConformance({
      ...base,
      respond: (reply, batch, options) => {
        const response = base.respond(reply, batch, options);
        return reply === 'wrong_epoch'
          ? { ...response, body: JSON.stringify({ ...JSON.parse(response.body), epoch }) }
          : response;
      },
    });
    expect(result.passed).toHaveLength(15);
  });

  it.each(['none', 'number', 'null'] as const)(
    'checks OTLP string attributes and omitted nulls (corruption: %s)',
    async (corrupt) => {
      const base = adapter();
      type Attribute = { key: string; value: { stringValue: unknown } };
      const wireRecords = (body: string): Record<string, unknown>[] =>
        (JSON.parse(body) as { records: { attributes: Attribute[] }[] }).records.map(
          ({ attributes }) =>
            Object.fromEntries(
              attributes.map(({ key, value }) => [key.replace(/^audit\./, ''), value.stringValue]),
            ),
        );
      const otlp: AuditSinkConformanceAdapter = {
        ...base,
        wireFormat: 'otlp',
        wireRecords,
        decode: (body) => {
          const parsed = JSON.parse(body) as Record<string, unknown>;
          if ('probe' in parsed) return null;
          return base.decode(
            JSON.stringify({
              ...parsed,
              records: wireRecords(body).map((record) =>
                Object.fromEntries(
                  Object.entries(record).map(([key, value]) => [
                    key,
                    [
                      'epoch',
                      'seq',
                      'boundary_seq',
                      'from_seq',
                      'to_seq',
                      'count',
                      'policy_generation',
                      'last_common_seq',
                    ].includes(key)
                      ? Number(value)
                      : value,
                  ]),
                ),
              ),
            }),
          );
        },
        create: (ctx, generation) =>
          base.create(
            {
              ...ctx,
              fetch: (request) => {
                const parsed = JSON.parse(request.body) as { records?: Record<string, unknown>[] };
                return ctx.fetch({
                  ...request,
                  body: JSON.stringify({
                    ...parsed,
                    ...(parsed.records
                      ? {
                          records: parsed.records.map((record) => ({
                            attributes: Object.entries(record)
                              .filter(([, value]) => value !== null || corrupt === 'null')
                              .map(([key, value]) => ({
                                key: 'audit.' + key,
                                value: {
                                  stringValue:
                                    corrupt === 'number' && typeof value === 'number'
                                      ? value
                                      : String(value),
                                },
                              })),
                          })),
                        }
                      : {}),
                  }),
                });
              },
            },
            generation,
          ),
      };
      if (corrupt !== 'none')
        await expect(runAuditSinkConformance(otlp)).rejects.toMatchObject({
          fixture: 'canonical-vectors',
        });
      else expect((await runAuditSinkConformance(otlp)).passed).toHaveLength(15);
    },
  );

  it.each(['camel', 'wrapped', 'boundary', 'source_ip', 'event_future', 'marker_future'] as const)(
    'rejects marker/additive wire corruption: %s',
    async (corruption) => {
      const base = adapter();
      const broken: AuditSinkConformanceAdapter = {
        ...base,
        decode: (body) => {
          const parsed = JSON.parse(body) as { records: Record<string, unknown>[] };
          if (!parsed.records) return base.decode(body);
          parsed.records = parsed.records.map((record) => {
            if ('__camel' in record) return record['__camel'] as Record<string, unknown>;
            const restored = { ...record };
            if ('wrong_boundary' in restored) {
              restored['boundary_prev_hash'] = restored['wrong_boundary'];
              delete restored['wrong_boundary'];
            }
            if ('wrong_ip' in restored) {
              restored['source_ip'] = restored['wrong_ip'];
              delete restored['wrong_ip'];
            }
            if ('wrong_future' in restored) {
              restored['future_field'] = restored['wrong_future'];
              delete restored['wrong_future'];
            }
            return restored;
          });
          return base.decode(JSON.stringify(parsed));
        },
        create: (ctx, generation) =>
          base.create(
            {
              ...ctx,
              fetch: (request) => {
                const parsed = JSON.parse(request.body) as { records: Record<string, unknown>[] };
                if (!parsed.records) return ctx.fetch(request);
                parsed.records = parsed.records.map((record) => {
                  const marker = record['kind'] !== 'event';
                  if (marker && (corruption === 'camel' || corruption === 'wrapped')) {
                    const camel = Object.fromEntries(
                      Object.entries(record).map(([key, value]) => [
                        key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
                        value,
                      ]),
                    );
                    return corruption === 'wrapped' ? { __camel: camel } : camel;
                  }
                  const changed = { ...record };
                  const rename = (from: string, to: string): void => {
                    if (from in changed) {
                      changed[to] = changed[from];
                      delete changed[from];
                    }
                  };
                  if (corruption === 'boundary') rename('boundary_prev_hash', 'wrong_boundary');
                  if (corruption === 'source_ip' && 'future_field' in record)
                    rename('source_ip', 'wrong_ip');
                  if (
                    (corruption === 'event_future' && !marker) ||
                    (corruption === 'marker_future' && marker)
                  )
                    rename('future_field', 'wrong_future');
                  return changed;
                });
                return ctx.fetch({ ...request, body: JSON.stringify(parsed) });
              },
            },
            generation,
          ),
      };
      await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
        fixture: ['camel', 'wrapped', 'boundary'].includes(corruption)
          ? 'marker-only-batches'
          : 'additive-fields-and-marker-kind',
      });
    },
  );

  it('rejects a receiver sink synthesizing an ACK for an empty JSON object', async () => {
    const base = adapter();
    let sawEmpty = false;
    const broken: AuditSinkConformanceAdapter = {
      ...base,
      create: (ctx, generation) => {
        let empty = false;
        const sink = base.create(
          {
            ...ctx,
            fetch: async (request) => {
              const response = await ctx.fetch(request);
              empty =
                response.status === 200 &&
                response.contentType === 'application/json' &&
                response.body === '{}';
              return response;
            },
          },
          generation,
        );
        return {
          ...sink,
          deliver: async (batch, signal) => {
            const result = await sink.deliver(batch, signal);
            if (!empty) return result;
            sawEmpty = true;
            return {
              outcome: 'accepted',
              chainId: batch.chainId,
              epoch: batch.epoch,
              throughSeq: batch.throughSeq,
              throughHash: batch.throughHash,
            };
          },
        };
      },
    };
    await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
      fixture: 'invalid-success-response',
    });
    expect(sawEmpty).toBe(true);
  });

  it.each(['delay', 'count', 'warning'] as const)('rejects invented %s results', async (fault) => {
    const broken = adapter((sink) => ({
      ...sink,
      deliver: async (batch, signal) => {
        const result = await sink.deliver(batch, signal);
        if (fault === 'delay' && result.outcome === 'retry' && result.code === 'http_status')
          return { ...result, retryAfterMs: result.retryAfterMs ?? 60000 };
        if (fault === 'count' && result.outcome === 'uncertain')
          return { ...result, rejectedCount: 1 };
        if (fault === 'warning' && result.outcome === 'accepted')
          return { ...result, outcome: 'accepted_with_warning', code: 'partial_success' };
        return result;
      },
    }));
    await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
      fixture:
        fault === 'delay'
          ? 'retryable-http-status'
          : fault === 'count'
            ? 'partial-success'
            : 'canonical-vectors',
    });
  });

  it('supports sinks without a frontier probe', async () => {
    expect(
      (await runAuditSinkConformance(adapter((sink) => ({ deliver: sink.deliver })))).frontier,
    ).toBe('unsupported');
  });

  it('supports transport ACKs that synthesize the batch identity', async () => {
    const base = adapter();
    const transport: AuditSinkConformanceAdapter = {
      ...base,
      acknowledgement: 'transport',
      respond: (reply, batch, options) =>
        base.respond(
          reply === 'wrong_epoch' || (reply === 'bad_response' && options.invalid === 'ack')
            ? 'accepted'
            : reply,
          batch,
          options,
        ),
    };
    expect((await runAuditSinkConformance(transport)).passed).toHaveLength(15);
  });

  it('accepts a sink rejecting an incorrect receiver epoch as bad_response', async () => {
    const strict = adapter((sink) => ({
      ...sink,
      deliver: async (batch, signal) => {
        const result = await sink.deliver(batch, signal);
        return result.outcome === 'accepted' && result.epoch !== batch.epoch
          ? { outcome: 'retry', code: 'bad_response' }
          : result;
      },
    }));
    expect((await runAuditSinkConformance(strict)).passed).toHaveLength(15);
  });

  it('refuses a frontier probe that hides a receiver ahead of the restored broker', async () => {
    const broken = adapter((sink) => ({ ...sink, frontier: async () => null }));
    await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
      fixture: 'restore-chain-and-cursor',
    });
  });

  it.each(['partial', 'rejected'] as const)(
    'refuses to turn %s into ordinary acceptance',
    async (reply) => {
      const base = adapter();
      await expect(
        runAuditSinkConformance({
          ...base,
          respond: (input, batch, options) =>
            base.respond(input === reply ? 'accepted' : input, batch, options),
        }),
      ).rejects.toMatchObject({
        fixture: reply === 'partial' ? 'partial-success' : 'permanent-rejection',
      });
    },
  );

  it('includes every marker and leaves non-advancing marker progress unchanged', () => {
    expect(auditMarkerFixtures.map(({ marker }) => marker.kind)).toEqual([
      'boundary',
      'gap',
      'tombstone',
      'delivery_uncertain',
      'withheld',
      'fork',
      'receiver_changed',
      'head',
    ]);
    const fixture = auditSinkConformanceFixtures.find(
      ({ name }) => name === 'marker-only-batches',
    )!;
    for (const { batch } of fixture.steps) {
      const marker = batch.records[0]!;
      expect(marker.kind).not.toBe('event');
      if (['boundary', 'fork', 'receiver_changed', 'head'].includes(marker.kind)) {
        expect(batch.throughSeq).toBe(0);
        expect(batch.throughHash).toBe('0'.repeat(64));
      }
    }
    const withheld = auditMarkerFixtures.find(({ marker }) => marker.kind === 'withheld')!.marker;
    expect(withheld).not.toHaveProperty('payloadJson');
    expect(withheld).not.toHaveProperty('sourceIp');
    expect(withheld).not.toHaveProperty('tokenSelector');
    expect(Object.isFrozen(fixture.steps[0]!.batch.records)).toBe(true);
  });

  it.each(['chainId', 'epoch', 'throughSeq', 'throughHash'] as const)(
    'refuses a corrupt %s ACK',
    async (field) => {
      const broken = adapter((sink) => ({
        ...sink,
        deliver: async (batch, signal) => {
          const result = await sink.deliver(batch, signal);
          return result.outcome === 'accepted'
            ? { ...result, [field]: field === 'epoch' || field === 'throughSeq' ? 99 : 'invalid' }
            : result;
        },
      }));
      await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
        name: 'AuditSinkConformanceError',
        fixture: 'canonical-vectors',
      });
    },
  );

  it('refuses a sink that fabricates a successful wrong-epoch ACK', async () => {
    const broken = adapter((sink) => ({
      ...sink,
      deliver: async (batch, signal) => {
        const result = await sink.deliver(batch, signal);
        return result.outcome === 'accepted' ? { ...result, epoch: batch.epoch } : result;
      },
    }));
    await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
      fixture: 'wrong-epoch-ack',
    });
  });

  it('detects requests whose record fields or payload bytes change', async () => {
    const broken = adapter((sink) => ({
      ...sink,
      deliver: (batch, signal) => sink.deliver({ ...batch, records: [] }, signal),
    }));
    await expect(runAuditSinkConformance(broken)).rejects.toBeInstanceOf(AuditSinkConformanceError);
  });

  it('detects encoding changes across a restart during a frozen batch', async () => {
    const original = adapter();
    const broken: AuditSinkConformanceAdapter = {
      ...original,
      create: (ctx, generation) =>
        original.create(
          {
            ...ctx,
            fetch: (request) =>
              ctx.fetch({
                ...request,
                body:
                  generation === 0
                    ? request.body
                    : JSON.stringify(JSON.parse(request.body), null, 2),
              }),
          },
          generation,
        ),
    };
    await expect(runAuditSinkConformance(broken)).rejects.toMatchObject({
      fixture: 'crash-before-marker-commit',
    });
  });

  it('does not let a sink swallow a transport assertion', async () => {
    const broken = adapter((sink) => ({
      ...sink,
      deliver: async (batch, signal) => {
        try {
          await sink.deliver({ ...batch, records: [] }, signal);
        } catch {
          /* Simulate a sink masking a protocol error. */
        }
        return {
          outcome: 'accepted',
          chainId: batch.chainId,
          epoch: batch.epoch,
          throughSeq: batch.throughSeq,
          throughHash: batch.throughHash,
        };
      },
    }));
    await expect(runAuditSinkConformance(broken)).rejects.toBeInstanceOf(AuditSinkConformanceError);
  });

  it('never includes plugin exception data in failures', async () => {
    const broken = adapter(() => {
      throw new Error('private-response-sentinel');
    });
    let failure: unknown;
    try {
      await runAuditSinkConformance(broken);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AuditSinkConformanceError);
    expect(String(failure)).toBe('AuditSinkConformanceError: Audit sink conformance failed');
    expect(JSON.stringify(failure)).not.toContain('private-response-sentinel');
    expect(failure).not.toHaveProperty('cause');
  });
});
