# Audit exports and cutover

Sign in as an organization administrator and complete re-authentication. Put the session Cookie header in an environment variable, then export:

```sh
pb audit export --broker https://broker.example --cookie-env PB_AUDIT_COOKIE --output audit.jsonl --format jsonl
```

The command creates a private file (mode 0600), pins the chain identity, epoch, retained boundary and initial head, and verifies record hashes with the core audit-chain functions. It pauses before each group after ten requests. Records appended above the pinned head belong to a later export. Withheld markers contain hash links but no withheld bodies. Empty and fully pruned chains produce valid empty artifacts.

Protect the artifact: it contains audit history. Store it durably with restricted access. The checksum detects accidental changes; it is unsigned and does not establish independent trust in the pinned head. Keep partial exports protected too. Credentials are excluded from the artifact and diagnostics.

Once the first response pins the header, the partial file remains available after a refusal. Re-authenticate when needed, update the cookie environment variable, and resume:

```sh
pb audit export --broker https://broker.example --cookie-env PB_AUDIT_COOKIE --resume audit.jsonl --format jsonl
```

Resume verifies the header, broker origin and every record through the last complete page checkpoint. It discards an unfinished page and retries that page, without duplicating records or dispositions. Completed artifacts cannot be resumed. Use the same broker and organization session. The chain, epoch and boundary must still match. Do not modify the partial file.

| Export refusal      | Operator action                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reauth_required`   | Sign in or complete fresh re-authentication, refresh the cookie environment variable and resume.                                                                                            |
| `forbidden`         | Obtain organization administrator export authority and resume with that organization's session.                                                                                             |
| `rate_limited`      | Wait for the API limit to clear, then resume. The CLI retries the same page up to three times, bounding Retry-After waits to 1–60 seconds and waiting 60 seconds when the header is absent. |
| `request_failed`    | Check connectivity and the broker origin. Redirects are refused. Resume after fixing the cause.                                                                                             |
| `request_refused`   | Check broker availability and server status before resuming.                                                                                                                                |
| `chain_changed`     | Start a new export into a new file; never combine chains or epochs.                                                                                                                         |
| `invalid_artifact`  | Investigate changed boundaries, incomplete evidence or corrupt files. Start a new export after resolving the cause.                                                                         |
| `output_exists`     | Choose a new output path, or use `--resume` for an unfinished export.                                                                                                                       |
| `invalid_input`     | Correct the command arguments or cookie environment variable.                                                                                                                               |
| `operation_refused` | Check file access and local storage before retrying.                                                                                                                                        |

To register custody, optionally supply the expected organization id with `--org-id`. When supplied, a wrong-organization artifact is refused before the database is opened. Without it, the opened database organization is checked against the artifact.

```sh
pb audit cutover --register audit.jsonl --org-id <organization-id> --sqlite broker.sqlite --generation GENERATION --actor-type user --actor-id <operator-id>
```

For Cloudflare, replace `--sqlite broker.sqlite` with `--cloudflare --database-id <id>` and supply the usual Cloudflare account and API-token environment variables used by `pb audit sink`. Use any nonnegative safe-integer generation at least as high as every stored sink generation for the organization (`0` is sufficient without sinks), and an active organization user or service principal (`--actor-type service_principal`). Read the highest stored generation with the [organization-scoped query](audit.md#sink-lifecycle-and-commands). <!-- source: packages/db-sqlite/src/repositories/audit-cutover.ts:54 --> <!-- source: packages/db-sqlite/src/repositories/audit-cutover.ts:73 -->

Registration verifies the file before opening the target. It then atomically requires the same chain and epoch, a retained boundary no higher than the artifact boundary, a head at or above the artifact head, and the artifact's final sequence and hash still present in that organization's journal. Later sealed export events therefore do not invalidate registration. The effective audit mode (`pending_mode` when set, otherwise `mode`) must be `none`. Registration writes verified custody and stages its audit event together. Only a nonempty complete range of verified bodies can authorize custody; withheld or empty artifacts cannot authorize pruning.

Cutover refusals return exit 1 with a fixed code. The diagnosis is read after the atomic batch refuses, so concurrent changes can affect the reported cause; it never authorizes registration.

| Cutover refusal            | Operator action                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `head_mismatch`            | Check chain identity, epoch and retention boundary, then obtain a fresh export if the artifact's final row is no longer retained. |
| `stale_generation`         | Read the organization’s highest stored sink generation and use that value or a higher nonnegative safe integer.                   |
| `operator_unavailable`     | Use an active operator in the target organization.                                                                                |
| `restore_pending`          | Complete the restore confirmation workflow before retrying.                                                                       |
| `mode_not_none`            | Complete the intended transition to effective mode `none` before registration.                                                    |
| `withheld_present`         | Resolve withheld evidence and obtain a complete export of verified bodies.                                                        |
| `org_mismatch`             | Check the artifact, expected organization id and database target; use the matching organization.                                  |
| `invalid_artifact`         | Obtain an intact artifact and investigate missing, unsafe or altered evidence.                                                    |
| `invalid_input`            | Correct the arguments or provide a nonempty verified range for custody.                                                           |
| `operation_refused`        | Check target access and local storage.                                                                                            |
| `organization_unavailable` | Initialize or select the correct database target.                                                                                 |
| `outcome_unknown`          | Inspect the ledger before retrying a Cloudflare operation; the commit may have succeeded (exit 7).                                |

Retention completes a pending cutover when its other custody and policy checks pass. Keep the registered artifact available for the full custody period.

## Inspecting and acknowledging audit alerts

`pb audit alert list` lists every registered alert code with a plain-language meaning, its active state, its current revision and its acknowledged revision. It is read-only: it neither observes new incidents nor writes events or ledger rows. Revisions are scoped to the organization and alert code; an unseen code has revision zero. Multiple incident origins are shown together using the highest revision and acknowledged revision, with `active` true when any origin is active. Fingerprints and incident data are omitted.

```sh
pb audit alert list --sqlite broker.sqlite --generation GENERATION --actor-type user --actor-id <operator-id>
pb audit alert ack audit.capacity --revision 3 --sqlite broker.sqlite --generation GENERATION --actor-type user --actor-id <operator-id>
```

Use exactly the organization’s highest stored sink generation, or `0` without sink rows, and an active organization user or service principal (`--actor-type service_principal`). Read it with the [organization-scoped query](audit.md#sink-lifecycle-and-commands) and pass it as `GENERATION` in both examples. A lower value is stale; a higher value is refused as `generation_ahead`. This value can differ from the deployed build generation. <!-- source: packages/db-sqlite/src/repositories/audit-health.ts:98 --> For Cloudflare, replace `--sqlite broker.sqlite` with `--cloudflare --database-id <id>` and supply the same account and API-token environment variables as `pb audit sink`.

`ack` acknowledges exactly the latest revision for the given code, including its older incident origins. It atomically updates health state and stages an `audit.sink_admin` event with operation `alert_ack`, `alert_code` and `revision`; it writes no ledger row. This control event remains available when required-policy capacity refusal is active. Acknowledging an active condition leaves that condition active and does not repair it. Once the condition resolves, an acknowledged incident no longer leaves health degraded. A new occurrence raises a newer revision and needs a new acknowledgement.

A stale, absent or already acknowledged revision is refused as `stale_revision` (exit 1), without staging an event. Unknown alert codes and malformed input are `invalid_input` (exit 2). An unavailable organization exits 5; a generation below the highest stored sink generation returns `{"result":"stale"}` and exits 6. At preflight, a generation ahead of stored sinks or an unavailable actor is a named refusal (exit 1). If the generation advances or the operator is suspended between preflight and commit, `ack` returns `{"result":"contended"}` and exits 6. Successful commands emit JSON with `result: "applied"` and exit 0; list also includes `alerts`. A lost Cloudflare mutation response exits 7 with `outcome_unknown`: inspect the alert's acknowledged revision before retrying because the batch may have committed. Other operation failures exit 1 with a fixed refusal message.
