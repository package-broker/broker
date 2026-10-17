# Changelog

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/runtime-node-v2.0.0-rc.0...runtime-node-v2.0.0-rc.1) (2026-10-17)


### Features

* A failed fence guard is told apart from a real unique collision ([#359](https://github.com/package-broker/broker/issues/359)) ([55de662](https://github.com/package-broker/broker/commit/55de662a41f3652231dc9cd8bb9534d2528c9aad))
* **db-sqlite:** migration 0004 cache_epoch seeded at organization bootstrap ([#126](https://github.com/package-broker/broker/issues/126)) ([e2ad872](https://github.com/package-broker/broker/commit/e2ad872fb528aed8732318c92abddb5cae8ea599))
* **db-sqlite:** migration 0005 tops up Organization Admin permissions ([#146](https://github.com/package-broker/broker/issues/146)) ([0203cd2](https://github.com/package-broker/broker/commit/0203cd27148741053e90bfe25797cade6615eef9))
* **db-sqlite:** migration 0006 for job and blob port columns ([#151](https://github.com/package-broker/broker/issues/151)) ([7023f60](https://github.com/package-broker/broker/commit/7023f60d7775b8b257667178b7f8f8ef3eaa0d46))
* Job runners take handler ports from kernel.jobScope ([#361](https://github.com/package-broker/broker/issues/361)) ([7fe0847](https://github.com/package-broker/broker/commit/7fe084749d1a61e166d9f04182539259682db5f0))
* **kernel:** request observability wiring with verified token ids ([#242](https://github.com/package-broker/broker/issues/242)) ([8b8ecf0](https://github.com/package-broker/broker/commit/8b8ecf02354275ab7eebab6a99536a4ad6391d1a))
* Node staging adapter for archive builds ([#327](https://github.com/package-broker/broker/issues/327)) ([6aab5dd](https://github.com/package-broker/broker/commit/6aab5dda7d3f3e196fadf910e665b50e24f44340))
* Observability contract on the Node and Workers sinks ([#330](https://github.com/package-broker/broker/issues/330)) ([c9e30dd](https://github.com/package-broker/broker/commit/c9e30dddd7367402e7409c79006108987ccd6c04))
* Outbound policy contract: SSRF and credential leakage ([#349](https://github.com/package-broker/broker/issues/349)) ([e13c3d9](https://github.com/package-broker/broker/commit/e13c3d951dacb010993a59c42bd73745aefae8e6))
* runtime-node: assemble storage, cache, jobs and observability ([#391](https://github.com/package-broker/broker/issues/391)) ([535676a](https://github.com/package-broker/broker/commit/535676aa054d7600c77da51ffa983a90bae0c539))
* **runtime-node:** better-sqlite3 executor on the shared contract ([#20](https://github.com/package-broker/broker/issues/20)) ([ff7411a](https://github.com/package-broker/broker/commit/ff7411a5c3055c962740265457919e100afde331))
* **runtime-node:** DNS guard with vetted, pinned resolution per target ([#181](https://github.com/package-broker/broker/issues/181)) ([4d50972](https://github.com/package-broker/broker/commit/4d509722993cb6cce29d751bdf8fc30d8779a9c8))
* **runtime-node:** guarded fetch pinned to vetted addresses ([#188](https://github.com/package-broker/broker/issues/188)) ([ba4149f](https://github.com/package-broker/broker/commit/ba4149fe7ed0473d5943cbcbc56f3148a6abf1bc))
* **runtime-node:** hardened SSH Git transport for Docker ([#289](https://github.com/package-broker/broker/issues/289)) ([f3f46e4](https://github.com/package-broker/broker/commit/f3f46e4539272307cff1721b4851d71300d13462))
* **runtime-node:** in-memory LRU cache adapter ([#199](https://github.com/package-broker/broker/issues/199)) ([a6a6af3](https://github.com/package-broker/broker/commit/a6a6af3b9d651d48c4a711892143707c25c9a713))
* **runtime-node:** job dispatcher, scheduler loop and graceful shutdown ([#277](https://github.com/package-broker/broker/issues/277)) ([75e0ea6](https://github.com/package-broker/broker/commit/75e0ea676652af041b3f5ac746d8116727ffb4a7))
* **runtime-node:** master key, public URL and auth wiring ([#108](https://github.com/package-broker/broker/issues/108)) ([1630d86](https://github.com/package-broker/broker/commit/1630d86ae437e3ab03c00ba9b739bbefad89196b))
* **runtime-node:** Node codec adapter for digests and bounded decompression ([#169](https://github.com/package-broker/broker/issues/169)) ([9eba0e2](https://github.com/package-broker/broker/commit/9eba0e2f8082f2da15a3d03eedf029f9fdbaceb0))
* **runtime-node:** Node entry with signal handling ([#48](https://github.com/package-broker/broker/issues/48)) ([6c47d39](https://github.com/package-broker/broker/commit/6c47d396d2b24c850101a8939830b0475d019ca0))
* **runtime-node:** serve the kernel over an executor with frozen plugin ports ([#41](https://github.com/package-broker/broker/issues/41)) ([0f3b43b](https://github.com/package-broker/broker/commit/0f3b43bb4608e36325b8b4a6bd1cf40a914dc6ab))
* **runtime-node:** start-up that migrates, bootstraps and aborts before listen on init failure ([#44](https://github.com/package-broker/broker/issues/44)) ([4b16018](https://github.com/package-broker/broker/commit/4b16018ef8111cb459b2e44d879acfb2295d95e3))
* **runtime-node:** verified filesystem ByteStore adapter ([#243](https://github.com/package-broker/broker/issues/243)) ([48e308e](https://github.com/package-broker/broker/commit/48e308e33bc0497ca673e8b841e90dcca80e9753))
* **runtime-node:** verified S3-compatible ByteStore adapter ([#244](https://github.com/package-broker/broker/issues/244)) ([58e8a05](https://github.com/package-broker/broker/commit/58e8a05023b62788c091d9dfd23312b065c266e3))
* **runtime:** cloudflare and node entries with error envelope ([54990ec](https://github.com/package-broker/broker/commit/54990ec7cc1ee42bd06bbb2581fbe5e4c2ed4514))
* **runtime:** observability sinks for Node stdio and Workers ([#125](https://github.com/package-broker/broker/issues/125)) ([ff8f916](https://github.com/package-broker/broker/commit/ff8f9168827bd0dbc945f76d27984405b905c9d6))
* S3 adapter verifies existing objects through checksum mode ([#322](https://github.com/package-broker/broker/issues/322)) ([ec55786](https://github.com/package-broker/broker/commit/ec5578630e9f702c3806b490b25a491219a8cd54))
* SSH Git provider: commit time, default branch, quiet scratch repositor ([#385](https://github.com/package-broker/broker/issues/385)) ([66cd24c](https://github.com/package-broker/broker/commit/66cd24cbbdb67d89f6aff17a9ac5332ffa7f9383))
* SSH Git source provider (Docker only) ([#347](https://github.com/package-broker/broker/issues/347)) ([439d7db](https://github.com/package-broker/broker/commit/439d7db3899411d726767c6787e6a45c29ff8a0e))


### Bug Fixes

* **build:** migration lists come from the discovered set ([#298](https://github.com/package-broker/broker/issues/298)) ([5814920](https://github.com/package-broker/broker/commit/5814920b51b5eb18f7937f213c86bc1f657634af))
* **cache:** Node LRU early expiry and Workers waitUntil failures ([#328](https://github.com/package-broker/broker/issues/328)) ([1503682](https://github.com/package-broker/broker/commit/15036827499887b0b68c6082c55febaf147de41d))
* **kernel:** plugin register runs once per kernel build ([#109](https://github.com/package-broker/broker/issues/109)) ([6bfdc4b](https://github.com/package-broker/broker/commit/6bfdc4b5589e30b6e152491a2cb86c8031ca1b03))
* **runtime-node:** bound the prepared-statement cache ([#75](https://github.com/package-broker/broker/issues/75)) ([bf176b7](https://github.com/package-broker/broker/commit/bf176b7df3790a38ccd6cf4a4d4c260c9465ce43))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @package-broker/core bumped to 2.0.0-rc.1
    * @package-broker/db-sqlite bumped to 2.0.0-rc.1
