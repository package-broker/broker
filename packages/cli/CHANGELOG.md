# Changelog

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/cli-v2.0.0-rc.0...cli-v2.0.0-rc.1) (2026-10-17)


### ⚠ BREAKING CHANGES

* **core:** plugins declare apiVersion 2; the organization port exposes only get, settings writes stay with core.

### Features

* Admin bootstrap top-up: counted in the batch, revision and cache epoch ([#297](https://github.com/package-broker/broker/issues/297)) ([e2a547c](https://github.com/package-broker/broker/commit/e2a547c7724520f82b3d5738244d8eaa90801053))
* Catalogue diagnostics fail pb build and the migration runner ([#351](https://github.com/package-broker/broker/issues/351)) ([f272da0](https://github.com/package-broker/broker/commit/f272da07aea35aeb1134978122a57d65e59ba5e0))
* **cli:** build wiring that emits migrations and build info ([#40](https://github.com/package-broker/broker/issues/40)) ([309cec2](https://github.com/package-broker/broker/commit/309cec2553645e8a69c8a768fadd86c86df7670b))
* **cli:** collect migrations from core and plugins for the build ([#27](https://github.com/package-broker/broker/issues/27)) ([b068879](https://github.com/package-broker/broker/commit/b068879dcb79bb9fedacaf2baac08131a53cb0ac))
* **cli:** D1 HTTP executor on the batch form with bound parameters and redaction ([#28](https://github.com/package-broker/broker/issues/28)) ([3e578b5](https://github.com/package-broker/broker/commit/3e578b59401665a890c8a0be8e6d8c0068d5a1e5))
* **cli:** D1 HTTP response parser with error classification and redaction ([#18](https://github.com/package-broker/broker/issues/18)) ([c5b4407](https://github.com/package-broker/broker/commit/c5b4407be57163d6e3f52853d6acdbcf2b625547))
* **cli:** manifest from config with port, route and migration validation ([#29](https://github.com/package-broker/broker/issues/29)) ([a9fe2a1](https://github.com/package-broker/broker/commit/a9fe2a137730671ae0f57718e1c8b64446063e82))
* **cli:** pb admin generate-master-key, bootstrap and reset-local ([#95](https://github.com/package-broker/broker/issues/95)) ([64ef7fc](https://github.com/package-broker/broker/commit/64ef7fcaddae0ff2c116fb49033f392461971cde))
* **cli:** pb admin rebind-provider ([#103](https://github.com/package-broker/broker/issues/103)) ([f3375c5](https://github.com/package-broker/broker/commit/f3375c5a06947533490caf512bd30d02325cd05f))
* **cli:** pb admin show-provider-binding ([#105](https://github.com/package-broker/broker/issues/105)) ([8406650](https://github.com/package-broker/broker/commit/84066506a711cccdf0df1ff9b6040b5476e38275))
* **cli:** pb build and version with manifest generation ([2cee016](https://github.com/package-broker/broker/commit/2cee0166455196faee2e4fa74b0089b7f99f56c7))
* **cli:** pb cloudflare migrate and bootstrap over the D1 HTTP executor ([#51](https://github.com/package-broker/broker/issues/51)) ([678fb97](https://github.com/package-broker/broker/commit/678fb97df94c433e39d034bd459526b4b9ee1890))
* **cli:** pb migrate and pb bootstrap for SQLite ([#43](https://github.com/package-broker/broker/issues/43)) ([f444f89](https://github.com/package-broker/broker/commit/f444f89128c0b8b9b178c6b38235a6ef249ee286))
* **cli:** validate platform ports and describe them in the build manifest ([#216](https://github.com/package-broker/broker/issues/216)) ([0aae4db](https://github.com/package-broker/broker/commit/0aae4dbae690f035ba2722b9373f951be23795d8))
* **cli:** validate the built manifest as untrusted input ([#26](https://github.com/package-broker/broker/issues/26)) ([dc6b8f0](https://github.com/package-broker/broker/commit/dc6b8f041707dba7224467aee70b81d843a549b7))
* **core:** plugin API version 2 with a read-only organization port ([#17](https://github.com/package-broker/broker/issues/17)) ([93ba52d](https://github.com/package-broker/broker/commit/93ba52dd394e26927b24e67829c807c9246f4957))
* **db-sqlite:** migration 0002 for local login, provider binding and identity freshness ([#57](https://github.com/package-broker/broker/issues/57)) ([b5a043f](https://github.com/package-broker/broker/commit/b5a043f56b18e7b64e22ef2836efb9d44b023c76))
* **db-sqlite:** migration 0004 cache_epoch seeded at organization bootstrap ([#126](https://github.com/package-broker/broker/issues/126)) ([e2ad872](https://github.com/package-broker/broker/commit/e2ad872fb528aed8732318c92abddb5cae8ea599))
* **db-sqlite:** migration 0005 tops up Organization Admin permissions ([#146](https://github.com/package-broker/broker/issues/146)) ([0203cd2](https://github.com/package-broker/broker/commit/0203cd27148741053e90bfe25797cade6615eef9))
* **db-sqlite:** migration 0006 for job and blob port columns ([#151](https://github.com/package-broker/broker/issues/151)) ([7023f60](https://github.com/package-broker/broker/commit/7023f60d7775b8b257667178b7f8f8ef3eaa0d46))
* **kernel:** route boundaries and one shared route validator ([#121](https://github.com/package-broker/broker/issues/121)) ([d09c463](https://github.com/package-broker/broker/commit/d09c4637da81dffe4754448ef1e4a86c3796a81d))
* Platform ports surface: error location, shape test, manifest type, b ([#348](https://github.com/package-broker/broker/issues/348)) ([b79e532](https://github.com/package-broker/broker/commit/b79e53299f91c9a0a354dd823fb319af2432e466))
* Plugin source-provider registration ([#284](https://github.com/package-broker/broker/issues/284)) ([78dee30](https://github.com/package-broker/broker/commit/78dee30030ad2982dc9e63306b698a42f9c79d3a))
* **plugin:** require plugin API 3 ([#283](https://github.com/package-broker/broker/issues/283)) ([0e7d3dd](https://github.com/package-broker/broker/commit/0e7d3dd018199a610eceab2f8deee2060b6d545c))


### Bug Fixes

* **build:** migration lists come from the discovered set ([#298](https://github.com/package-broker/broker/issues/298)) ([5814920](https://github.com/package-broker/broker/commit/5814920b51b5eb18f7937f213c86bc1f657634af))
* **cli:** admin command error names, lost-response exit code and token-file safety ([#293](https://github.com/package-broker/broker/issues/293)) ([5fed481](https://github.com/package-broker/broker/commit/5fed48173a8a7d8fbc4a204a839f510c6c78a90e))
* **cli:** build manifest keeps plugin dependency order ([#234](https://github.com/package-broker/broker/issues/234)) ([185e11a](https://github.com/package-broker/broker/commit/185e11a879a1a42752923fbf0bd02bb5b1b759f7))
* **cli:** built-manifest migration entries carry the file name the loader expects ([#42](https://github.com/package-broker/broker/issues/42)) ([40c1e41](https://github.com/package-broker/broker/commit/40c1e41a340dd9e3e5e97121ca6730839cf7756d))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @package-broker/core bumped to 2.0.0-rc.1
    * @package-broker/db-sqlite bumped to 2.0.0-rc.1
    * @package-broker/runtime-cloudflare bumped to 2.0.0-rc.1
    * @package-broker/runtime-node bumped to 2.0.0-rc.1
