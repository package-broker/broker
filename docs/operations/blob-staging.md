# Staged package uploads

Staged uploads remain outside the package catalogue until promotion succeeds. Completed staging objects older than 24 hours are removed by the hourly blob purge job, in batches of at most 50 per organization. A promoted, unreferenced package blob becomes eligible for orphan collection after seven days; import manifests remain protected.
<!-- source: packages/core/src/ingest/retention-jobs.ts -->
<!-- source: packages/db-sqlite/src/repositories/blob-references.ts -->

On Workers, staging uses sequential multipart uploads with fixed 8 MiB parts and a shorter final part. The assembler owns one 8 MiB buffer plus at most one part in flight. Failed or cancelled uploads are explicitly aborted. Incomplete multipart uploads are invisible to object listings; uploads that survive a process crash are removed by R2's default seven-day cleanup. `pb cloudflare deploy` installs no R2 lifecycle rule (DEC-NPM-O1). The hourly purge job removes only completed staging objects.
<!-- source: packages/runtime-cloudflare/src/blob/r2.ts -->

Node filesystem staging uses a temporary file and promotion by rename. S3 staging uses a bounded disk spool, unlinked before upload bytes are read so the operating system reclaims it on process exit, to determine the checksum and length before uploading a staging object; promotion uses a server-side copy. Neither path buffers the complete upload in memory.
<!-- source: packages/runtime-node/src/blob/filesystem.ts -->
<!-- source: packages/runtime-node/src/blob/s3.ts -->

Upload admission reserves a bounded byte budget before reading bytes. npm publish requires `Content-Length` and reserves the smaller of the effective tarball cap and `floor(Content-Length * 3 / 4)`; the effective cap is the smaller of `registry.caps.publishTarballBytes` and the blob store ceiling. When the shared 64 MiB upload budget is exhausted, a staged upload waits up to `registry.timers.waitBudgetMs` before refusing admission. Discard a staged handle after validation fails; a failed catalogue write after promotion is covered by orphan collection.
<!-- source: packages/core/src/platform/blob.ts -->
<!-- source: packages/core/src/registry/npm/publish-service.ts -->

The hourly sweep requires S3 `s3:ListBucket` permission on the bucket and the R2 binding’s `list` capability, in addition to object read, write and delete access. Sweep failures increment `pb.blob.staging_sweep` with `outcome=error` and log the fixed message `staged_blob_sweep_failed`; blob purging continues.
<!-- source: packages/core/src/ingest/retention-jobs.ts -->

Incomplete uploads surviving a crash can occupy bucket capacity until the default seven-day cleanup; completed staging objects follow the separate 24-hour retention. Account for those incomplete parts when planning bucket capacity. Deployment leaves adopted buckets' lifecycle configuration alone; it installs no cleanup rule. See storage settings in the [configuration reference](../reference/configuration.md) and include promoted npm archives in the [backup recovery set](backup-and-upgrades.md#npm-archives-are-part-of-the-recovery-set).
<!-- source: packages/runtime-cloudflare/src/blob/r2.ts -->
<!-- source: packages/cli/src/commands/cloudflare/deploy.ts -->
<!-- source: packages/core/src/ingest/retention-jobs.ts -->
<!-- verify: npm-workers-multipart-crash — owner on an isolated R2 bucket: interrupt an upload, confirm deploy leaves lifecycle settings unchanged, and observe cleanup under the bucket's default seven-day policy. -->
