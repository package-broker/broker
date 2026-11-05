# Offline audit restore

Quiesce all writers and stop the broker before restoring. Use a trusted logical JSON snapshot produced by the restore-rehearsal `exportDatabase` helper: an array of `{ sql, params }` statements, with binary parameters encoded as `{ hex }`. This command restores the database only; restore keys and blob objects separately using the deployment restore procedure.

```sh
pb sqlite restore --sqlite restored.sqlite --snapshot database.json [--out <build>]
```

The target main file and its WAL, SHM and journal sidecars must be absent. Restore uses a restrictive umask to create a private database and WAL/SHM sidecars, loads tables and indexes, then rows, then triggers and views, in one SQLite transaction. It checks foreign keys before committing. A failed restore removes the file it created. With `--out <build>`, restore loads that build’s migration set, including plugin migrations, just as `migrate` does. Without `--out`, it uses only the CLI’s bundled core migrations. Snapshots must contain at least one organization and exactly the selected migration ids and checksums. After loading, every table, index, trigger and view must match the reference database built from those migrations byte for byte by type, name and SQL; missing, extra or altered schema objects are refused with `migration_mismatch`. Migration records alone do not satisfy this check. Older snapshots must be migrated before export. These checks cannot verify row completeness beyond the presence of an organization, its audit chain, migration records and foreign-key consistency; operators must establish that the exporter captured every required row.

For every restored organization, the same transaction increments incarnation and epoch, sets `restore_pending`, clears verification results, blocks active and already-blocked sinks, preserving an existing blocked reason or setting `fork` when null. Retired, disabled and inactive sinks remain untouched. The transaction also appends an `epoch_bump` ledger entry and stages an `audit.sink_admin` event. Journal sequence numbers, chain identity, retained boundaries, sink cursors and in-flight bytes are preserved. Delivery stays blocked until an operator confirms the restore through the audit administration tooling.

After a manual restore outside the broker, including D1 Time Travel, mark it before restarting writers:

```sh
pb audit epoch bump --sqlite database.sqlite
pb audit epoch bump --cloudflare --database-id <id>
```

The D1 command uses `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from the environment. Epoch bump covers every organization, using one atomic batch containing organization-scoped statements for all organizations, including every ledger entry and pending event. If the batch would exceed 200 statements, it refuses with `batch_limit` before writing anything. Any failure rolls back the entire batch. It compares the chain state read before the batch and refuses a concurrent change. It never creates a missing SQLite database. If a remote response is lost, inspect the chain and ledger before retrying: another invocation is another explicit bump. The fixed `audit.restore_detected` diagnostic signals the operator action needed; runtime alert delivery belongs to restore detection.

For an empty chain (`head_seq = 0`), the epoch-bump ledger range is `[1, 1]` with `count = 0`. This is a control marker, not a claim that sequence 1 exists; it satisfies migration 0002's positive-range checks without advancing the head. Setting `boundary_reason = 'epoch_bump'` belongs to restore detection.

Failures report fixed reason codes without snapshot or request values: `target_exists`, `invalid_snapshot`, `migration_mismatch`, `chain_missing`, `fk_violation`, `concurrent_change`, `batch_limit`, `io_error`, or `internal`. A stale chain guard, busy database or exhausted counter reports `concurrent_change`; inspect chain state before retrying. Filesystem and SQLite I/O failures report `io_error`; unexpected failures report `internal`. Rollback failure preserves the original reason code.
