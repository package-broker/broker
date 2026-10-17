# Changelog

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/runtime-cloudflare-v2.0.0-rc.0...runtime-cloudflare-v2.0.0-rc.1) (2026-10-17)


### Features

* A failed fence guard is told apart from a real unique collision ([#359](https://github.com/package-broker/broker/issues/359)) ([55de662](https://github.com/package-broker/broker/commit/55de662a41f3652231dc9cd8bb9534d2528c9aad))
* Cross-provider e-mail linking only through a provider e-mail-authorita ([#362](https://github.com/package-broker/broker/issues/362)) ([9d966e7](https://github.com/package-broker/broker/commit/9d966e7bf8e9f29eb207ad398a45aa68e1bc9142))
* **db-sqlite:** migration 0004 cache_epoch seeded at organization bootstrap ([#126](https://github.com/package-broker/broker/issues/126)) ([e2ad872](https://github.com/package-broker/broker/commit/e2ad872fb528aed8732318c92abddb5cae8ea599))
* **db-sqlite:** migration 0005 tops up Organization Admin permissions ([#146](https://github.com/package-broker/broker/issues/146)) ([0203cd2](https://github.com/package-broker/broker/commit/0203cd27148741053e90bfe25797cade6615eef9))
* **db-sqlite:** migration 0006 for job and blob port columns ([#151](https://github.com/package-broker/broker/issues/151)) ([7023f60](https://github.com/package-broker/broker/commit/7023f60d7775b8b257667178b7f8f8ef3eaa0d46))
* **db-sqlite:** token issuance and revocation with in-batch authority ([#149](https://github.com/package-broker/broker/issues/149)) ([93b0581](https://github.com/package-broker/broker/commit/93b0581ac28b0bdac0a86cee38d084e8f431d3bb))
* **github:** GitHub App JWT on Workers with a bounded key cache ([#305](https://github.com/package-broker/broker/issues/305)) ([8fa9864](https://github.com/package-broker/broker/commit/8fa9864e63109e991001ebac876f3f3bd3470d04))
* Job runners take handler ports from kernel.jobScope ([#361](https://github.com/package-broker/broker/issues/361)) ([7fe0847](https://github.com/package-broker/broker/commit/7fe084749d1a61e166d9f04182539259682db5f0))
* Observability contract on the Node and Workers sinks ([#330](https://github.com/package-broker/broker/issues/330)) ([c9e30dd](https://github.com/package-broker/broker/commit/c9e30dddd7367402e7409c79006108987ccd6c04))
* **plugin:** require plugin API 3 ([#283](https://github.com/package-broker/broker/issues/283)) ([0e7d3dd](https://github.com/package-broker/broker/commit/0e7d3dd018199a610eceab2f8deee2060b6d545c))
* Query plans on D1: INDEXED BY statements and the local PAT holder sc ([#357](https://github.com/package-broker/broker/issues/357)) ([31dba34](https://github.com/package-broker/broker/commit/31dba34b40989c4f9b51366f9bc37d70bd074e26))
* **registry:** representation clock tracks the winning package and its revision ([#311](https://github.com/package-broker/broker/issues/311)) ([bd477d9](https://github.com/package-broker/broker/commit/bd477d9a5d5d1f4ff193b8e8bc9ec734ba1e17c2))
* runtime-cloudflare: assemble storage, cache, queues and observability ([#393](https://github.com/package-broker/broker/issues/393)) ([94f0ac0](https://github.com/package-broker/broker/commit/94f0ac09817e274b4412c2c13e5b8da991330d28))
* **runtime-cloudflare:** D1 executor tested on Miniflare ([#21](https://github.com/package-broker/broker/issues/21)) ([a229b04](https://github.com/package-broker/broker/commit/a229b0467d30cc46ae71b286e4fbbfa52df015e1))
* **runtime-cloudflare:** master key and auth wiring ([#107](https://github.com/package-broker/broker/issues/107)) ([9b490b6](https://github.com/package-broker/broker/commit/9b490b603a858202e0d7853d3486b1c8fb9a2a39))
* **runtime-cloudflare:** metadata cache adapter on the named Cache API ([#212](https://github.com/package-broker/broker/issues/212)) ([6a6dc0a](https://github.com/package-broker/broker/commit/6a6dc0a46866b4dbe33b7d1a02909d625d0a530a))
* **runtime-cloudflare:** queue consumer and cron handler for jobs ([#279](https://github.com/package-broker/broker/issues/279)) ([cd6bc4b](https://github.com/package-broker/broker/commit/cd6bc4ba2adf4707c4f7ec7581700e517f8a167f))
* **runtime-cloudflare:** serve the kernel over D1 with per-binding cache and init retry ([#39](https://github.com/package-broker/broker/issues/39)) ([3e7770e](https://github.com/package-broker/broker/commit/3e7770e2e7aa1ccc508a0f20bd33a2415fb1fcbc))
* **runtime-cloudflare:** verified R2 ByteStore adapter ([#237](https://github.com/package-broker/broker/issues/237)) ([4a9b16a](https://github.com/package-broker/broker/commit/4a9b16a85cff67030fa155b790efa6785f66692c))
* **runtime-cloudflare:** Workers codec adapter ([#301](https://github.com/package-broker/broker/issues/301)) ([b543f71](https://github.com/package-broker/broker/commit/b543f7105b2df51f314365023df1095945622739))
* **runtime-cloudflare:** Wrangler operator template and production example config ([#250](https://github.com/package-broker/broker/issues/250)) ([a4cb482](https://github.com/package-broker/broker/commit/a4cb482afedc46cb472f003735c25914ad15706b))
* **runtime:** cloudflare and node entries with error envelope ([54990ec](https://github.com/package-broker/broker/commit/54990ec7cc1ee42bd06bbb2581fbe5e4c2ed4514))
* **runtime:** observability sinks for Node stdio and Workers ([#125](https://github.com/package-broker/broker/issues/125)) ([ff8f916](https://github.com/package-broker/broker/commit/ff8f9168827bd0dbc945f76d27984405b905c9d6))
* Service-principal repository and service: replay, probes and result co ([#338](https://github.com/package-broker/broker/issues/338)) ([9644dcb](https://github.com/package-broker/broker/commit/9644dcbb119157f5d4b0f632d23e179cc937a32a))
* T569b: creator-removed case through the T568 removal path and a mutati ([#375](https://github.com/package-broker/broker/issues/375)) ([d94adf1](https://github.com/package-broker/broker/commit/d94adf17cfeabcb85027b46f4d37f541dd46e81e))
* Token lookup contract on the real repository; personal tokens only for ([#373](https://github.com/package-broker/broker/issues/373)) ([93f7f28](https://github.com/package-broker/broker/commit/93f7f28240b6e0e385f3595193c08f444e279834))
* Workers sink drops pb.http.* metric console lines without an ANALYTI ([#344](https://github.com/package-broker/broker/issues/344)) ([4eb6da3](https://github.com/package-broker/broker/commit/4eb6da30581106f287bdf7e9a90966428d5fffd6))


### Bug Fixes

* **build:** migration lists come from the discovered set ([#298](https://github.com/package-broker/broker/issues/298)) ([5814920](https://github.com/package-broker/broker/commit/5814920b51b5eb18f7937f213c86bc1f657634af))
* **cache:** Node LRU early expiry and Workers waitUntil failures ([#328](https://github.com/package-broker/broker/issues/328)) ([1503682](https://github.com/package-broker/broker/commit/15036827499887b0b68c6082c55febaf147de41d))
* **db-sqlite:** keep authorization statements under the D1 parameter limit ([#145](https://github.com/package-broker/broker/issues/145)) ([ce204d2](https://github.com/package-broker/broker/commit/ce204d2c41a6773fcd2c4d08424fbd5ce7e45644))
* **db:** fail closed on D1 parameter and pattern limits in the executors ([#329](https://github.com/package-broker/broker/issues/329)) ([9a4f3b5](https://github.com/package-broker/broker/commit/9a4f3b53c03fea6a17357953da0767230018b24c))
* **kernel:** plugin register runs once per kernel build ([#109](https://github.com/package-broker/broker/issues/109)) ([6bfdc4b](https://github.com/package-broker/broker/commit/6bfdc4b5589e30b6e152491a2cb86c8031ca1b03))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @package-broker/core bumped to 2.0.0-rc.1
    * @package-broker/db-sqlite bumped to 2.0.0-rc.1
