# Database statement budgets

The shared constants in `packages/core/src/db/port.ts` define the portability
budget used by both runtimes:

| Scope                    | Statements | Enforcement                                                                                                  |
| ------------------------ | ---------: | ------------------------------------------------------------------------------------------------------------ |
| One atomic batch         |        200 | Executors reject larger batches with `DbError` kind `too_big` before preparing SQL or opening a transaction. |
| One D1 invocation        |        500 | Callers account for all reads and batches in the invocation.                                                 |
| Reserved invocation work |         50 | Ingest leaves room for reads, lease checks and completion.                                                   |
| Ingest chunk allowance   |        450 | `planChunk` derives this from the invocation limit minus the reserve.                                        |

The batch limit is an application portability policy. Executors do not split
batches, because splitting would lose atomicity. They do not track invocation
usage: an executor may outlive an invocation, and a batch guard alone cannot
account for all statements across calls. The Node test executor uses the same
batch guard to expose violations in repository tests.

The catalogue version insert, version update and dist tag planners assert their
final statement counts, including lease guards, before returning a plan. A
request within its input count limit can still exceed the statement budget;
the complete plan determines whether it fits. Parameter counts and payload byte
limits remain separate constraints.

The 101-statement audit seal figure in T497 describes a particular operation:
100 event inserts followed by one scoped delete. It fits within the 200-statement
batch policy; it is not another global budget. The seal, apply-chunk and sweep
writers discussed in the review are absent from this checkout and must adopt
the same constants and planned-size checks when integrated.
