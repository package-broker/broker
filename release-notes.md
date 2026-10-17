:robot: I have created a release *beep* *boop*
---


<details><summary>plugin-github: 1.0.0-rc.0</summary>

## [1.0.0-rc.0](https://github.com/package-broker/broker/compare/plugin-github-v0.1.0-rc.0...plugin-github-v1.0.0-rc.0) (2026-10-17)


###   BREAKING CHANGES

* **core:** plugins declare apiVersion 2; the organization port exposes only get, settings writes stay with core.

### Features

* **core:** plugin API version 2 with a read-only organization port ([#17](https://github.com/package-broker/broker/issues/17)) ([93ba52d](https://github.com/package-broker/broker/commit/93ba52dd394e26927b24e67829c807c9246f4957))
* GitHub bulk discovery dry-run plan ([#263](https://github.com/package-broker/broker/issues/263)) ([013b363](https://github.com/package-broker/broker/commit/013b363ee88f113707a183d71c3d6128b1b791e2))
* **github:** GitHub App JWT on Workers with a bounded key cache ([#305](https://github.com/package-broker/broker/issues/305)) ([8fa9864](https://github.com/package-broker/broker/commit/8fa9864e63109e991001ebac876f3f3bd3470d04))
* **github:** GitHub source provider ([#309](https://github.com/package-broker/broker/issues/309)) ([ffddf08](https://github.com/package-broker/broker/commit/ffddf085f30b4e1c87397665c425758949e339ea))
* **plugin-github:** installation tokens narrowed per repository batch ([#261](https://github.com/package-broker/broker/issues/261)) ([600636a](https://github.com/package-broker/broker/commit/600636a5dbb9e8501d3fbddcb07551f884e0029e))
* **plugin:** require plugin API 3 ([#283](https://github.com/package-broker/broker/issues/283)) ([0e7d3dd](https://github.com/package-broker/broker/commit/0e7d3dd018199a610eceab2f8deee2060b6d545c))
* **plugins:** sso-oidc and github plugin stubs ([458e281](https://github.com/package-broker/broker/commit/458e28102d8b173b1c47ecb635f671ec660d7da8))
* **registry:** GitHub App JWT signing with WebCrypto ([#158](https://github.com/package-broker/broker/issues/158)) ([a6c1fd4](https://github.com/package-broker/broker/commit/a6c1fd43d8fb697409f49ecc5b47581d92bc466e))


### Bug Fixes

* **plugins:** core peer range follows the workspace version ([#217](https://github.com/package-broker/broker/issues/217)) ([a6f3341](https://github.com/package-broker/broker/commit/a6f33413bbf103f348332937cd1e6151813f6a61))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
</details>

<details><summary>plugin-sso-oidc: 1.0.0-rc.0</summary>

## [1.0.0-rc.0](https://github.com/package-broker/broker/compare/plugin-sso-oidc-v0.1.0-rc.0...plugin-sso-oidc-v1.0.0-rc.0) (2026-10-17)


###   BREAKING CHANGES

* **core:** plugins declare apiVersion 2; the organization port exposes only get, settings writes stay with core.

### Features

* **core:** plugin API version 2 with a read-only organization port ([#17](https://github.com/package-broker/broker/issues/17)) ([93ba52d](https://github.com/package-broker/broker/commit/93ba52dd394e26927b24e67829c807c9246f4957))
* OIDC plugin config snapshot: caps before copying, own enumerable strin ([#345](https://github.com/package-broker/broker/issues/345)) ([f771ce8](https://github.com/package-broker/broker/commit/f771ce8a6c4486b6e3f6dcb0a031e3d27c78c0b1))
* **plugin-sso-oidc:** Cloudflare Access identity provider ([#84](https://github.com/package-broker/broker/issues/84)) ([306fa76](https://github.com/package-broker/broker/commit/306fa764c4e325aa9fa5e4493117613536c66d67))
* **plugin-sso-oidc:** JWKS cache and bounded fetch ([#80](https://github.com/package-broker/broker/issues/80)) ([f3da839](https://github.com/package-broker/broker/commit/f3da83949a6247ea962e3f30cc773b8bca8ca56c))
* **plugin-sso-oidc:** JWT verification with typed claims ([#72](https://github.com/package-broker/broker/issues/72)) ([310633e](https://github.com/package-broker/broker/commit/310633e281d4ce7379aba4d9e9ee0df707afc795))
* **plugin-sso-oidc:** OIDC finish: code exchange and ID token checks ([#99](https://github.com/package-broker/broker/issues/99)) ([5448555](https://github.com/package-broker/broker/commit/54485553735055d3979921b244a5670e3077347d))
* **plugin-sso-oidc:** OIDC provider for Dex: discovery and start ([#85](https://github.com/package-broker/broker/issues/85)) ([efdda96](https://github.com/package-broker/broker/commit/efdda960a68f6b84fe7f2907d21c9d89bfe4565e))
* **plugin-sso-oidc:** plugin factory and identity binding ([#98](https://github.com/package-broker/broker/issues/98)) ([0959e18](https://github.com/package-broker/broker/commit/0959e18f30dc2ebf3d28d57346927eb399e14711))
* **plugin:** require plugin API 3 ([#283](https://github.com/package-broker/broker/issues/283)) ([0e7d3dd](https://github.com/package-broker/broker/commit/0e7d3dd018199a610eceab2f8deee2060b6d545c))
* **plugins:** sso-oidc and github plugin stubs ([458e281](https://github.com/package-broker/broker/commit/458e28102d8b173b1c47ecb635f671ec660d7da8))
* **sso-oidc:** stricter issuer, endpoint and config validation ([#295](https://github.com/package-broker/broker/issues/295)) ([d585400](https://github.com/package-broker/broker/commit/d5854007b02906074eb9ddc1dce49a15ec610ba0))


### Bug Fixes

* **plugins:** core peer range follows the workspace version ([#217](https://github.com/package-broker/broker/issues/217)) ([a6f3341](https://github.com/package-broker/broker/commit/a6f33413bbf103f348332937cd1e6151813f6a61))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
</details>

<details><summary>cli: 2.0.0-rc.1</summary>

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/cli-v2.0.0-rc.0...cli-v2.0.0-rc.1) (2026-10-17)


###   BREAKING CHANGES

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
</details>

<details><summary>core: 2.0.0-rc.1</summary>

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/core-v2.0.0-rc.0...core-v2.0.0-rc.1) (2026-10-17)


###   BREAKING CHANGES

* **core:** plugins declare apiVersion 2; the organization port exposes only get, settings writes stay with core.

### Features

* A failed fence guard is told apart from a real unique collision ([#359](https://github.com/package-broker/broker/issues/359)) ([55de662](https://github.com/package-broker/broker/commit/55de662a41f3652231dc9cd8bb9534d2528c9aad))
* A package's ecosystem always equals its source's ecosystem ([#378](https://github.com/package-broker/broker/issues/378)) ([c5acb1d](https://github.com/package-broker/broker/commit/c5acb1d4545034e05037a0134fb7a45cd3f800ac))
* Architecture rules: no Node globals in core, mint rule over plugins an ([#394](https://github.com/package-broker/broker/issues/394)) ([b698af6](https://github.com/package-broker/broker/commit/b698af6853fe2a84d3fe78d1f68a987a257a139c))
* Array-element selector for the streaming JSON extractor ([#271](https://github.com/package-broker/broker/issues/271)) ([ec000a7](https://github.com/package-broker/broker/commit/ec000a70d09ce0107a3590b6adcf3e99e66a26f5))
* Audit canonical form and hash ([#370](https://github.com/package-broker/broker/issues/370)) ([2bd4075](https://github.com/package-broker/broker/commit/2bd4075bfd4e2e9581a4279490f38e1c3c260f61))
* Auth module wiring: sessions, access and the unlink service ([#358](https://github.com/package-broker/broker/issues/358)) ([ddcbccd](https://github.com/package-broker/broker/commit/ddcbccd064198cae8673e6c98d64c56201796583))
* **authz:** deny-by-default access engine over one lookup ([#213](https://github.com/package-broker/broker/issues/213)) ([49ae3e8](https://github.com/package-broker/broker/commit/49ae3e80dac2e46e61ca5261ab6b31715adb1efe))
* **authz:** identity unlink service ([#264](https://github.com/package-broker/broker/issues/264)) ([c248b82](https://github.com/package-broker/broker/commit/c248b8297a9bd36337f262dc85d9bd19645e1540))
* **authz:** organization actor from the verified access snapshot ([#249](https://github.com/package-broker/broker/issues/249)) ([5bf5320](https://github.com/package-broker/broker/commit/5bf5320b88152665740ab247c668e29c0d426d1c))
* **authz:** PAT validation origin and 24-hour freshness gate ([#193](https://github.com/package-broker/broker/issues/193)) ([61d222e](https://github.com/package-broker/broker/commit/61d222e1977974e83652e44dba64361019a7b369))
* **authz:** personal access token issuance service ([#231](https://github.com/package-broker/broker/issues/231)) ([3e6184b](https://github.com/package-broker/broker/commit/3e6184ba492c1c6d234268c24d646274844aa175))
* **authz:** project grant administration service ([#215](https://github.com/package-broker/broker/issues/215)) ([f34b36f](https://github.com/package-broker/broker/commit/f34b36f4dfba651adf6bbb6989473884397c4cc6))
* **authz:** project service with scoped actors and archived-project gate ([#194](https://github.com/package-broker/broker/issues/194)) ([014a5d3](https://github.com/package-broker/broker/commit/014a5d3ba595094cf04389a265a65f8509fa10d6))
* **authz:** request-keyed core access context ([#262](https://github.com/package-broker/broker/issues/262)) ([5262529](https://github.com/package-broker/broker/commit/5262529b53f2e4ffbfeae30e5a1051dcd244f9e3))
* **authz:** require the organization actor discriminator ([#218](https://github.com/package-broker/broker/issues/218)) ([c58d62f](https://github.com/package-broker/broker/commit/c58d62fa857c1207e59666b7d8640678360cce46))
* **authz:** service-principal authority adapter and creator offboarding on suspension ([#336](https://github.com/package-broker/broker/issues/336)) ([f8bfc24](https://github.com/package-broker/broker/commit/f8bfc24a844e1cce51baa15992a158b5880ac25c))
* **authz:** service-principal service with in-batch authority guard ([#202](https://github.com/package-broker/broker/issues/202)) ([fc4ad43](https://github.com/package-broker/broker/commit/fc4ad4306aa9f7b1fc3f57a01d6c93d4077fde09))
* **authz:** service-token issuance ([#275](https://github.com/package-broker/broker/issues/275)) ([10d862b](https://github.com/package-broker/broker/commit/10d862b8cf012b0beb865a258dfc8fa1afdf7da1))
* **authz:** SQL-filtered readable projects for the project list ([#259](https://github.com/package-broker/broker/issues/259)) ([6acca22](https://github.com/package-broker/broker/commit/6acca22342ccd9e5f6bbaed8f2d6cc0a48180134))
* **authz:** token use gate with background last-used tracking ([#173](https://github.com/package-broker/broker/issues/173)) ([7ac2b5a](https://github.com/package-broker/broker/commit/7ac2b5aee892eb85e9d551a2d44b267cc05022b5))
* **catalogue:** canonical package names for Composer and npm ([#164](https://github.com/package-broker/broker/issues/164)) ([f417d47](https://github.com/package-broker/broker/commit/f417d47b8ec65d0542b2d24da426c552c7edbe03))
* **catalogue:** canonical version metadata without credentials ([#182](https://github.com/package-broker/broker/issues/182)) ([38e5e3d](https://github.com/package-broker/broker/commit/38e5e3d9915e8af8155c98fdfbfb99531e1fbf0b))
* **catalogue:** catalogue cache keys and statement-bound epoch reader ([#206](https://github.com/package-broker/broker/issues/206)) ([603a76a](https://github.com/package-broker/broker/commit/603a76a6e34958523d3a2b10c94e43b900484239))
* **catalogue:** in-memory visibility, winner and proxy-admission oracle ([#208](https://github.com/package-broker/broker/issues/208)) ([5fcd7c2](https://github.com/package-broker/broker/commit/5fcd7c23a562dbf26e1e609376032b69701eb245))
* **catalogue:** leak-safe dependency closure report ([#224](https://github.com/package-broker/broker/issues/224)) ([2c6700b](https://github.com/package-broker/broker/commit/2c6700ba7f3f1eea4f4837a3b5b73270aed913f7))
* **catalogue:** version identity validation and stability derivation ([#178](https://github.com/package-broker/broker/issues/178)) ([bf16a89](https://github.com/package-broker/broker/commit/bf16a89bbd8180ad349816b624dc471c5eaf3f18))
* **catalogue:** version status rules, reason codes and complete-listing proofs ([#177](https://github.com/package-broker/broker/issues/177)) ([8d0e3bb](https://github.com/package-broker/broker/commit/8d0e3bbc277954f85c4346004641412935563986))
* **catalogue:** visibility pattern grammar, linear matcher and fail-closed admission ([#179](https://github.com/package-broker/broker/issues/179)) ([2f8b77b](https://github.com/package-broker/broker/commit/2f8b77b87048ee9b2e984185dfbc6b1aec05c329))
* Composer root follow-ups: inline-packages flag, include-key encoding ([#337](https://github.com/package-broker/broker/issues/337)) ([ca9f301](https://github.com/package-broker/broker/commit/ca9f30114902bf18a5e006b95f6e545ac4dcaff2))
* Composer v1 provider file read ([#386](https://github.com/package-broker/broker/issues/386)) ([5edaa1f](https://github.com/package-broker/broker/commit/5edaa1f0d51fde9a9e76309336a8265ffc8ca0eb))
* composer version object: release-date bounds and allowlist ([#319](https://github.com/package-broker/broker/issues/319)) ([35920a6](https://github.com/package-broker/broker/commit/35920a62a3ae35890af32dcc8bb42d3b298aa0fe))
* Core request validation helper: Zod 4, no-echo error map, size and d ([#363](https://github.com/package-broker/broker/issues/363)) ([d7e225b](https://github.com/package-broker/broker/commit/d7e225bfe0665a642ca1527c01dcd0440c8f51c8))
* **core:** AES-256-GCM cipher with record-bound AAD ([#62](https://github.com/package-broker/broker/issues/62)) ([7eb78f5](https://github.com/package-broker/broker/commit/7eb78f56ac4fc0400d5b9b4116d7925b915ec51d))
* **core:** attributed hook denials on SSO login ([#110](https://github.com/package-broker/broker/issues/110)) ([02851ff](https://github.com/package-broker/broker/commit/02851fff33536841979d1c5722ac9606c1697563))
* **core:** auth module assembly ([#106](https://github.com/package-broker/broker/issues/106)) ([100f228](https://github.com/package-broker/broker/commit/100f2288ba751549f508dcd6edb456183fa3d258))
* **core:** auth primitives and __Host- cookies ([#60](https://github.com/package-broker/broker/issues/60)) ([240209f](https://github.com/package-broker/broker/commit/240209f2d64905cf944c6077fe9dd133cfc2fb14))
* **core:** authorization flow where the engine decides and hooks can only deny ([#30](https://github.com/package-broker/broker/issues/30)) ([85ebb53](https://github.com/package-broker/broker/commit/85ebb530f80f998a8af11db730f4c4ab28a005fb))
* **core:** blob port with verified publish, purge lease and upload admission ([#137](https://github.com/package-broker/broker/issues/137)) ([056fbc7](https://github.com/package-broker/broker/commit/056fbc74a5825d38db4c70292a9f637800134055))
* **core:** canonical token grammar for pb_pat, pb_svc and pb_cst tokens ([#113](https://github.com/package-broker/broker/issues/113)) ([7439db1](https://github.com/package-broker/broker/commit/7439db137d5064747d7e289932ddc0a369ed4d0b))
* **core:** catalogue and route diagnostics over the registration validator ([#142](https://github.com/package-broker/broker/issues/142)) ([40955ff](https://github.com/package-broker/broker/commit/40955fffd0b2590c682cdea9a3fa2d0aa8615afe))
* **core:** catalogue reader, writer and visibility ports with unforgeable proofs ([#190](https://github.com/package-broker/broker/issues/190)) ([45b7d6f](https://github.com/package-broker/broker/commit/45b7d6f826837f463a6063f7750e5cd97dfee5ea))
* **core:** credential header parser for Composer and npm clients ([#120](https://github.com/package-broker/broker/issues/120)) ([2566720](https://github.com/package-broker/broker/commit/25667201a8f8d6fc01b114ebb224bdb77ab7f15c))
* **core:** credential store service ([#73](https://github.com/package-broker/broker/issues/73)) ([663cb71](https://github.com/package-broker/broker/commit/663cb7191313e58c525ba5478211f5c7789ed6e0))
* **core:** database error type and SQLite error classification ([#6](https://github.com/package-broker/broker/issues/6)) ([e76155e](https://github.com/package-broker/broker/commit/e76155eeef4c0140d111a4f0c19e84a5e45db15a))
* **core:** database port types, scalar executor and organization interfaces ([#3](https://github.com/package-broker/broker/issues/3)) ([c1c4446](https://github.com/package-broker/broker/commit/c1c44465bdff3fecce7432d59732d1def886edcd))
* **core:** deny-only access checks that validate the exact hook result shape ([#22](https://github.com/package-broker/broker/issues/22)) ([9a165dc](https://github.com/package-broker/broker/commit/9a165dcad2fe7e5d181b78f1a555505def8e837b))
* **core:** error envelopes, default structured log and health responses ([#19](https://github.com/package-broker/broker/issues/19)) ([562b0c0](https://github.com/package-broker/broker/commit/562b0c038de79696482acb4bbfbce938acdf7d36))
* **core:** HKDF keyring with per-purpose derived keys ([#59](https://github.com/package-broker/broker/issues/59)) ([467fd15](https://github.com/package-broker/broker/commit/467fd15b3af06017d12db354bbdd735b7d903b04))
* **core:** identity hook runner on the deny-only machine ([#77](https://github.com/package-broker/broker/issues/77)) ([954f6ab](https://github.com/package-broker/broker/commit/954f6ab45b8d7184a0e1a609d924d817e192bace))
* **core:** identity port types and DomainPolicy ([#66](https://github.com/package-broker/broker/issues/66)) ([e0b0116](https://github.com/package-broker/broker/commit/e0b01166ff5bfe383beb79d637d76dd79206deee))
* **core:** identity provider builder ([#78](https://github.com/package-broker/broker/issues/78)) ([6e50ace](https://github.com/package-broker/broker/commit/6e50acec87607555fa4f09945dd5a3c3c0d2b6b7))
* **core:** job definition API and payload validation ([#123](https://github.com/package-broker/broker/issues/123)) ([ca5568d](https://github.com/package-broker/broker/commit/ca5568dc77333049e122e0d3eea0339190e1db5d))
* **core:** job repository port types and errors ([#144](https://github.com/package-broker/broker/issues/144)) ([2351447](https://github.com/package-broker/broker/commit/235144756e3ccf1de43453cf8169138055aa5753))
* **core:** kernel composition with routes, authorization, envelopes and health ([#38](https://github.com/package-broker/broker/issues/38)) ([0cb3cd8](https://github.com/package-broker/broker/commit/0cb3cd8aa07beaff3412a5c5de2ddf89001fdff0))
* **core:** kernel core routes under /_pb/ ([#55](https://github.com/package-broker/broker/issues/55)) ([38e36f4](https://github.com/package-broker/broker/commit/38e36f4700d63a9e972e79484848626a62db4320))
* **core:** kernel registry rejecting unknown keys, reserved ids and unbindable ports ([#24](https://github.com/package-broker/broker/issues/24)) ([4ca4298](https://github.com/package-broker/broker/commit/4ca429892a758a80eb3cb00b0dac9ccf59e5644e))
* **core:** local admin login and re-authentication ([#93](https://github.com/package-broker/broker/issues/93)) ([a44b517](https://github.com/package-broker/broker/commit/a44b5170f9b6c4f40526c62cb9c664ba8185753c))
* **core:** local admin login, re-authentication and setup routes ([#102](https://github.com/package-broker/broker/issues/102)) ([783d450](https://github.com/package-broker/broker/commit/783d450b994b8e1e869103cb212c4d35439796c3))
* **core:** local admin TOTP setup service ([#96](https://github.com/package-broker/broker/issues/96)) ([bae66f1](https://github.com/package-broker/broker/commit/bae66f13b88108e6229f3518b53964c3bb8797af))
* **core:** master key parsing and the misconfigured envelope ([#56](https://github.com/package-broker/broker/issues/56)) ([5333625](https://github.com/package-broker/broker/commit/5333625438c12950cdf988e15949b20261c6f2f9))
* **core:** metrics registry and W3C trace context ([#124](https://github.com/package-broker/broker/issues/124)) ([23da200](https://github.com/package-broker/broker/commit/23da200b0741f8bd4222958a05f2aad11e4c7d62))
* **core:** mutation fence types and the fenced batch runner ([#116](https://github.com/package-broker/broker/issues/116)) ([2933f5c](https://github.com/package-broker/broker/commit/2933f5cc9e0d1e2c6903638e6df3d40f0107e011))
* **core:** observability port with safe records and scoped loggers ([#115](https://github.com/package-broker/broker/issues/115)) ([cfefba2](https://github.com/package-broker/broker/commit/cfefba21b1243f958fc8594334c405905bcff7c8))
* **core:** organization administration service ([#94](https://github.com/package-broker/broker/issues/94)) ([75dbe04](https://github.com/package-broker/broker/commit/75dbe043eb73a9cd7b9a0468edb07eb72858b138))
* **core:** organization resolver with uncached readiness probe ([#8](https://github.com/package-broker/broker/issues/8)) ([0d6fbc3](https://github.com/package-broker/broker/commit/0d6fbc3dd4ad21b9a5be9501121e3ad45b25d3d1))
* **core:** peppered PBKDF2 password hashing ([#65](https://github.com/package-broker/broker/issues/65)) ([7b83fd9](https://github.com/package-broker/broker/commit/7b83fd9ab1738268a57a8459ce382db2881d82fb))
* **core:** per-platform port configuration and validation ([#155](https://github.com/package-broker/broker/issues/155)) ([dfa4c4d](https://github.com/package-broker/broker/commit/dfa4c4d18015a7c92d184c9d65d30fb6fd80db9a))
* **core:** permission catalogue and default roles ([#71](https://github.com/package-broker/broker/issues/71)) ([d12aa67](https://github.com/package-broker/broker/commit/d12aa67f8ffc5f75b08d90a49ad7a88cad53c575))
* **core:** plugin and config API stubs ([ef48e7c](https://github.com/package-broker/broker/commit/ef48e7c27844590af1be60f3a6f15e5e0c89c6d3))
* **core:** plugin and core job registration in the kernel registry ([#167](https://github.com/package-broker/broker/issues/167)) ([07ea1fd](https://github.com/package-broker/broker/commit/07ea1fdb813267c1f7c6c148d9a9098c64192584))
* **core:** plugin API version 2 with a read-only organization port ([#17](https://github.com/package-broker/broker/issues/17)) ([93ba52d](https://github.com/package-broker/broker/commit/93ba52dd394e26927b24e67829c807c9246f4957))
* **core:** plugin contract for identity providers and auth hooks ([#70](https://github.com/package-broker/broker/issues/70)) ([e6e09d1](https://github.com/package-broker/broker/commit/e6e09d11919218f2c2104724210218dc68bed1e1))
* **core:** plugin contract types with deny-only access hooks ([#11](https://github.com/package-broker/broker/issues/11)) ([1a2e62a](https://github.com/package-broker/broker/commit/1a2e62a7bb12d90a301fcce226cbbd5e79b33f48))
* **core:** portable OTLP/HTTP JSON encoder and bounded exporter ([#135](https://github.com/package-broker/broker/issues/135)) ([6c19499](https://github.com/package-broker/broker/commit/6c194995a7e50081f0827581f0b0225990c6f9dc))
* **core:** project slug resolution from the request path ([#132](https://github.com/package-broker/broker/issues/132)) ([09c1848](https://github.com/package-broker/broker/commit/09c18481cdfbdbb74c05c8692c9d6a6052290f7f))
* **core:** route descriptors from the permission catalogue ([#134](https://github.com/package-broker/broker/issues/134)) ([eb5ff58](https://github.com/package-broker/broker/commit/eb5ff58a2c538c21bb36d7f997dcb83ceb256768))
* **core:** route grammar with shape-based conflict detection and reserved core paths ([#13](https://github.com/package-broker/broker/issues/13)) ([cc8e462](https://github.com/package-broker/broker/commit/cc8e462366d9310a4d8400ee22450a43cb79c816))
* **core:** same-origin and CSRF token checks ([#63](https://github.com/package-broker/broker/issues/63)) ([c19cf57](https://github.com/package-broker/broker/commit/c19cf575d71a0e7b52f8f07b6835f773fb8bd44a))
* **core:** scoped cache port keyed on the organization cache epoch ([#138](https://github.com/package-broker/broker/issues/138)) ([dc61f27](https://github.com/package-broker/broker/commit/dc61f27ab3895597b97a738d7629469df978adb7))
* **core:** sealed login-state cookie ([#67](https://github.com/package-broker/broker/issues/67)) ([aea1da4](https://github.com/package-broker/broker/commit/aea1da44329128c7e00cd19cc90d1b66f443d93d))
* **core:** session service ([#81](https://github.com/package-broker/broker/issues/81)) ([a5f28da](https://github.com/package-broker/broker/commit/a5f28da7bf17d30e66a5798265cdd572e5a4271a))
* **core:** SSO login service ([#92](https://github.com/package-broker/broker/issues/92)) ([5517add](https://github.com/package-broker/broker/commit/5517add12b0fd1d202230a5de49b3938015c42a7))
* **core:** SSO re-authentication service ([#88](https://github.com/package-broker/broker/issues/88)) ([1db94b2](https://github.com/package-broker/broker/commit/1db94b2dc38d13a6c362173e3599039059efe3e2))
* **core:** SSO, session and logout routes ([#101](https://github.com/package-broker/broker/issues/101)) ([c891484](https://github.com/package-broker/broker/commit/c8914842632a07de8260bcf0251886e52b1a2f06))
* **core:** token hashing at rest with a keyring pepper ([#119](https://github.com/package-broker/broker/issues/119)) ([68d800f](https://github.com/package-broker/broker/commit/68d800f8e873a166372fc02a267ea6da46621ce2))
* **core:** token scope masks and effective permissions per boundary ([#141](https://github.com/package-broker/broker/issues/141)) ([592091f](https://github.com/package-broker/broker/commit/592091f4eaa14179f13f52a15cfbb643a65e0d6c))
* **core:** TOTP (RFC 6238) ([#64](https://github.com/package-broker/broker/issues/64)) ([4598591](https://github.com/package-broker/broker/commit/45985914d3a398b6e845835d1e042db14cd6642c))
* **core:** ULID generator with edge cases and injectable clock ([#4](https://github.com/package-broker/broker/issues/4)) ([6f8a098](https://github.com/package-broker/broker/commit/6f8a09886bf8e2a79122488690cf0c8d74805457))
* **core:** uniform 404 decisions and a browser denial page ([#133](https://github.com/package-broker/broker/issues/133)) ([379f655](https://github.com/package-broker/broker/commit/379f65596eb6c8d33be7945f283f226f383dd654))
* Creator offboarding when a project grant removal ends a user's project ([#339](https://github.com/package-broker/broker/issues/339)) ([b74f0b2](https://github.com/package-broker/broker/commit/b74f0b207bb554fdedac5052594943c3f3d40099))
* Credential echo guard: base64 echoes at a non-zero offset inside a lar ([#304](https://github.com/package-broker/broker/issues/304)) ([b8dd354](https://github.com/package-broker/broker/commit/b8dd354dbc45c4bdf14ec906d973f497ab7904a7))
* Cross-provider e-mail linking only through a provider e-mail-authorita ([#362](https://github.com/package-broker/broker/issues/362)) ([9d966e7](https://github.com/package-broker/broker/commit/9d966e7bf8e9f29eb207ad398a45aa68e1bc9142))
* **db-sqlite:** credential repository ([#68](https://github.com/package-broker/broker/issues/68)) ([51c45ee](https://github.com/package-broker/broker/commit/51c45ee62c1f1c334643e8571de9df0aa83e241b))
* **db-sqlite:** fenced role mutators with in-batch authority ([#148](https://github.com/package-broker/broker/issues/148)) ([b506932](https://github.com/package-broker/broker/commit/b5069326f0832e3263da2b3765a288588cbfc54d))
* **db-sqlite:** local login repository: reads and attempt reservation ([#83](https://github.com/package-broker/broker/issues/83)) ([2a1561f](https://github.com/package-broker/broker/commit/2a1561fcade2a859ee41f5c46155a27e930db646))
* **db-sqlite:** local login setup batches ([#90](https://github.com/package-broker/broker/issues/90)) ([b8f1380](https://github.com/package-broker/broker/commit/b8f1380cf7a78682a09890dc0135f4ad6cafd88b))
* **db-sqlite:** organization grants, last-admin guard and user suspension ([#87](https://github.com/package-broker/broker/issues/87)) ([48bdc0f](https://github.com/package-broker/broker/commit/48bdc0f4d18215279e4c5a870c6b7174ec625c7f))
* **db-sqlite:** role repository and default-role seed ([#79](https://github.com/package-broker/broker/issues/79)) ([80f6f5e](https://github.com/package-broker/broker/commit/80f6f5e2c36975dbc0b2e3b13605d6e209819c5c))
* **db-sqlite:** session repository ([#76](https://github.com/package-broker/broker/issues/76)) ([2e7c1e1](https://github.com/package-broker/broker/commit/2e7c1e1ea25d445b3b09ad3158b8c4355e1cf695))
* **db-sqlite:** user and identity reads for login ([#82](https://github.com/package-broker/broker/issues/82)) ([c052105](https://github.com/package-broker/broker/commit/c05210517910c1b915b1a91a3c25db9acfc00748))
* Engine grant side channel, AuthenticatedActor minting and setAccessCon ([#389](https://github.com/package-broker/broker/issues/389)) ([3e6d624](https://github.com/package-broker/broker/commit/3e6d624fe15ae405499cb4942df2c378a8c4877e))
* Error table and response helpers (`details` from T647) ([#367](https://github.com/package-broker/broker/issues/367)) ([c7edf12](https://github.com/package-broker/broker/commit/c7edf120da6a4dbd5b362a3474c1250a370d4ef1))
* Fenced identity-block delete repository and unblock service ([#266](https://github.com/package-broker/broker/issues/266)) ([3712842](https://github.com/package-broker/broker/commit/3712842292de4cb20b4d4454115c16452c3c264f))
* Generic Git source provider over smart HTTP ([#374](https://github.com/package-broker/broker/issues/374)) ([e870c68](https://github.com/package-broker/broker/commit/e870c68cde9b90ccff84a7c42300fd187c3bfe37))
* Import manifest follow-ups: source config schemas, per-item refusal pa ([#372](https://github.com/package-broker/broker/issues/372)) ([372802d](https://github.com/package-broker/broker/commit/372802d5d0f5b8d156c3e17f5af226eac6a1b817))
* Import plan manifest: schema, canonical form and hash ([#369](https://github.com/package-broker/broker/issues/369)) ([7b90b56](https://github.com/package-broker/broker/commit/7b90b56a72360cd6cd08d296fc8ca97dd65374a3))
* **ingest:** chunk planner with diff, coverage and statement budget ([#290](https://github.com/package-broker/broker/issues/290)) ([fc8fae9](https://github.com/package-broker/broker/commit/fc8fae94be41ca0770b9496307ec44125eb81fd8))
* **ingest:** Composer repository root detection with origin-checked URLs ([#235](https://github.com/package-broker/broker/issues/235)) ([33e9f13](https://github.com/package-broker/broker/commit/33e9f13c340c5c6e89a1062725188c9b860b6747))
* **ingest:** Composer v2 package fetch with per-form evidence ([#265](https://github.com/package-broker/broker/issues/265)) ([cb209e9](https://github.com/package-broker/broker/commit/cb209e926b29df0e54d207b2ce8277cc95eec99c))
* **ingest:** staged upstream snapshots for chunked ingest ([#251](https://github.com/package-broker/broker/issues/251)) ([6c12cf8](https://github.com/package-broker/broker/commit/6c12cf8d3789aab36f8e335820f989fb78a073e5))
* **ingest:** streaming JSON member extractor with bounded memory ([#191](https://github.com/package-broker/broker/issues/191)) ([edcfb28](https://github.com/package-broker/broker/commit/edcfb28f6497ac7661884e65ba3a76dd21826d10))
* **ingest:** two-pass blob ingest without buffering ([#172](https://github.com/package-broker/broker/issues/172)) ([6b218dd](https://github.com/package-broker/broker/commit/6b218ddfdf86a4651bbd04f6307143fe816ddce3))
* **ingest:** verified Composer v1 index from includes and providers ([#258](https://github.com/package-broker/broker/issues/258)) ([617004b](https://github.com/package-broker/broker/commit/617004b14d20b63430ecc5398359fd07f8192612))
* **jobs:** database Jobs port with per-plugin ownership ([#281](https://github.com/package-broker/broker/issues/281)) ([38ea79e](https://github.com/package-broker/broker/commit/38ea79e1415912277c45198ca8bf8488a7d13258))
* JSON Schema export from Zod for OpenAPI and MCP ([#365](https://github.com/package-broker/broker/issues/365)) ([e5c4029](https://github.com/package-broker/broker/commit/e5c4029d2c44391e6c630c66312d82699439f3c2))
* Kernel binds platform ports per plugin, request and job ([#312](https://github.com/package-broker/broker/issues/312)) ([1643a37](https://github.com/package-broker/broker/commit/1643a3722151e9812d0b2eff86a8cc4bc213df31))
* Kernel denials: outage versus policy, strict Accept parsing, handler s ([#392](https://github.com/package-broker/broker/issues/392)) ([54b996f](https://github.com/package-broker/broker/commit/54b996fba65a43696da836ac161f546e8dfc4a30))
* Kernel engine and hook integration contract ([#352](https://github.com/package-broker/broker/issues/352)) ([75d1ed4](https://github.com/package-broker/broker/commit/75d1ed4dccf67d2ae6b64a418532e87fb10b6fe8))
* Kernel registry and job naming hardening ([#346](https://github.com/package-broker/broker/issues/346)) ([0641e9b](https://github.com/package-broker/broker/commit/0641e9b74748376cbb45d7fdd4d0b1dfebcfe578))
* **kernel:** carry the verified token id in allow decisions ([#226](https://github.com/package-broker/broker/issues/226)) ([40c6589](https://github.com/package-broker/broker/commit/40c658950d162fc0e14b5a9e3ff585300fd3e0b5))
* **kernel:** closed observability vocabulary and message-free error records ([#227](https://github.com/package-broker/broker/issues/227)) ([dcf5326](https://github.com/package-broker/broker/commit/dcf532633d2ff3db48135f258d4d196b1c20d8a0))
* **kernel:** package route boundary and resolver registration ([#273](https://github.com/package-broker/broker/issues/273)) ([8c4ec2e](https://github.com/package-broker/broker/commit/8c4ec2e758762a5f32e239df2ad439229d477973))
* **kernel:** request observability wiring with verified token ids ([#242](https://github.com/package-broker/broker/issues/242)) ([8b8ecf0](https://github.com/package-broker/broker/commit/8b8ecf02354275ab7eebab6a99536a4ad6391d1a))
* **kernel:** request scope, completion guard and HTTP metrics ([#232](https://github.com/package-broker/broker/issues/232)) ([966da3d](https://github.com/package-broker/broker/commit/966da3db5daf569fb14ae5d6539c7214ba33930d))
* **kernel:** route boundaries and one shared route validator ([#121](https://github.com/package-broker/broker/issues/121)) ([d09c463](https://github.com/package-broker/broker/commit/d09c4637da81dffe4754448ef1e4a86c3796a81d))
* Large npm packument: the first response is pass 1 of staging (two GETs ([#387](https://github.com/package-broker/broker/issues/387)) ([e279b09](https://github.com/package-broker/broker/commit/e279b0969173de07b3768df980276fd40a4b8945))
* Local login and SSO re-auth hardening; drop the unused login-state c ([#353](https://github.com/package-broker/broker/issues/353)) ([0e82efe](https://github.com/package-broker/broker/commit/0e82efe36d2db958f2d8a4b6a55bd52133f6fcd3))
* npm_registry config distHosts replaces the storageHosts factory argume ([#355](https://github.com/package-broker/broker/issues/355)) ([97b8a02](https://github.com/package-broker/broker/commit/97b8a022e8450836bb62eeab73f850588563e8b2))
* npm: a version manifest over the 1 MiB member cap is skipped and recor ([#396](https://github.com/package-broker/broker/issues/396)) ([301efef](https://github.com/package-broker/broker/commit/301efef258a7044c7c81323ad805153179a5b4a4))
* **observability:** completion span derived from request records ([#228](https://github.com/package-broker/broker/issues/228)) ([60c6cf6](https://github.com/package-broker/broker/commit/60c6cf67c432a4284d604b55ddbc002f16b37fc6))
* **observability:** OTLP sink adapter with per-flush aggregation and histogram bounds ([#300](https://github.com/package-broker/broker/issues/300)) ([b28cd75](https://github.com/package-broker/broker/commit/b28cd754470f2ea5a19480fac37beb9adb729fc8))
* **observability:** single approved error-name list and request event name ([#225](https://github.com/package-broker/broker/issues/225)) ([bfa2b01](https://github.com/package-broker/broker/commit/bfa2b013530c524ba5423611d35bb211b4238b3a))
* Outbound policy contract: SSRF and credential leakage ([#349](https://github.com/package-broker/broker/issues/349)) ([e13c3d9](https://github.com/package-broker/broker/commit/e13c3d951dacb010993a59c42bd73745aefae8e6))
* Outbound policy: a bare allowlist entry allows https only; http need ([#350](https://github.com/package-broker/broker/issues/350)) ([4719569](https://github.com/package-broker/broker/commit/4719569df05e9e9c9556ce7b4cefcd92c1472ef8))
* packagist.org proxy provider ([#269](https://github.com/package-broker/broker/issues/269)) ([28e9f2d](https://github.com/package-broker/broker/commit/28e9f2dde30c5f780c4780ce2f077a041f7b68a1))
* Platform ports surface: error location, shape test, manifest type, b ([#348](https://github.com/package-broker/broker/issues/348)) ([b79e532](https://github.com/package-broker/broker/commit/b79e53299f91c9a0a354dd823fb319af2432e466))
* Plugin source-provider registration ([#284](https://github.com/package-broker/broker/issues/284)) ([78dee30](https://github.com/package-broker/broker/commit/78dee30030ad2982dc9e63306b698a42f9c79d3a))
* **plugin:** platform ports with fail-closed accessor ([#201](https://github.com/package-broker/broker/issues/201)) ([54f50f1](https://github.com/package-broker/broker/commit/54f50f1715dc2b0b9799bc926d583aaaf9894b6b))
* **plugin:** require plugin API 3 ([#283](https://github.com/package-broker/broker/issues/283)) ([0e7d3dd](https://github.com/package-broker/broker/commit/0e7d3dd018199a610eceab2f8deee2060b6d545c))
* Project cross-project denial contract ([#368](https://github.com/package-broker/broker/issues/368)) ([b9027b9](https://github.com/package-broker/broker/commit/b9027b9ad15798d5777ce918ac106d75fbc010a7))
* **registry:** batched last-accessed tracking for blobs ([#195](https://github.com/package-broker/broker/issues/195)) ([300a2eb](https://github.com/package-broker/broker/commit/300a2eb2529f1aac5b8c7089a490831da7e86dc9))
* **registry:** canonical Composer dist URLs by version id and revision ([#192](https://github.com/package-broker/broker/issues/192)) ([3814b81](https://github.com/package-broker/broker/commit/3814b8184acdf972b9cfebebcfe0db1af61c0e7e))
* **registry:** canonical Composer version object from upstream metadata ([#247](https://github.com/package-broker/broker/issues/247)) ([bf6549e](https://github.com/package-broker/broker/commit/bf6549eee7ded7c77296133364527356fcb927f9))
* **registry:** canonical npm version object from packument versions ([#255](https://github.com/package-broker/broker/issues/255)) ([49b3332](https://github.com/package-broker/broker/commit/49b3332a784464c529677a7f8a260d58c3cd3afc))
* **registry:** codec port with streaming digests, integrity and bounded decompression ([#159](https://github.com/package-broker/broker/issues/159)) ([00abdff](https://github.com/package-broker/broker/commit/00abdff95dfc41437ef9111abd750893f7636f59))
* **registry:** Composer p2 metadata minify and expand ([#165](https://github.com/package-broker/broker/issues/165)) ([6957d72](https://github.com/package-broker/broker/commit/6957d7200368a1d39e89b5160823a4dd48e56502))
* **registry:** Composer VCS tag and branch version rules ([#185](https://github.com/package-broker/broker/issues/185)) ([d0b96c2](https://github.com/package-broker/broker/commit/d0b96c21e0583eca381a888566647cd34fe19557))
* **registry:** Composer version normalisation for aliases, branches, dates and build metadata ([#168](https://github.com/package-broker/broker/issues/168)) ([675cdb1](https://github.com/package-broker/broker/commit/675cdb1b2b35268757988d146e8faee3d266c482))
* **registry:** Composer version normalisation, numeric and suffix grammar ([#156](https://github.com/package-broker/broker/issues/156)) ([9cfd6dc](https://github.com/package-broker/broker/commit/9cfd6dcfcf022991184fd9f212ff8c6c39690336))
* **registry:** conditional requests and the Composer representation clock ([#254](https://github.com/package-broker/broker/issues/254)) ([9d20b23](https://github.com/package-broker/broker/commit/9d20b23d47d0147f9daf9de9281efb881de9c712))
* **registry:** fill coalescer across requests and isolates ([#160](https://github.com/package-broker/broker/issues/160)) ([5dcaf71](https://github.com/package-broker/broker/commit/5dcaf71b55c5b92b0615000bd6defb3e298db515))
* **registry:** Git smart-HTTP client ([#162](https://github.com/package-broker/broker/issues/162)) ([fdd7f6a](https://github.com/package-broker/broker/commit/fdd7f6a06113fbf4107b4f13b6ab2e6cc3d2e5d7))
* **registry:** npm packument description with staged large documents ([#256](https://github.com/package-broker/broker/issues/256)) ([970fce4](https://github.com/package-broker/broker/commit/970fce492c76abb9650e7eeb5d44e84c847fe34d))
* **registry:** npm request path parser with single decoding ([#196](https://github.com/package-broker/broker/issues/196)) ([6185bd2](https://github.com/package-broker/broker/commit/6185bd22260c15374bf58f66af08ac66b46d8264))
* **registry:** npmjs proxy and GitHub Packages scoped providers ([#303](https://github.com/package-broker/broker/issues/303)) ([2e81f24](https://github.com/package-broker/broker/commit/2e81f24d44c21072d4c379a6f21f2e5058fc8bda))
* **registry:** outbound URL policy for package sources ([#161](https://github.com/package-broker/broker/issues/161)) ([4e60fc3](https://github.com/package-broker/broker/commit/4e60fc3226715051adfaa12579b0f0adc1f59b9e))
* **registry:** representation clock tracks the winning package and its revision ([#311](https://github.com/package-broker/broker/issues/311)) ([bd477d9](https://github.com/package-broker/broker/commit/bd477d9a5d5d1f4ff193b8e8bc9ec734ba1e17c2))
* **registry:** streaming JSON tokenizer ([#166](https://github.com/package-broker/broker/issues/166)) ([64e1254](https://github.com/package-broker/broker/commit/64e12548d96d7b0bef4b205d9c1cd5e81e560624))
* **registry:** validated registry deployment configuration ([#222](https://github.com/package-broker/broker/issues/222)) ([dde2f34](https://github.com/package-broker/broker/commit/dde2f34a9b3ffbb91f962a062195ab428071befe))
* **runtime-cloudflare:** Workers codec adapter ([#301](https://github.com/package-broker/broker/issues/301)) ([b543f71](https://github.com/package-broker/broker/commit/b543f7105b2df51f314365023df1095945622739))
* **runtime-node:** DNS guard with vetted, pinned resolution per target ([#181](https://github.com/package-broker/broker/issues/181)) ([4d50972](https://github.com/package-broker/broker/commit/4d509722993cb6cce29d751bdf8fc30d8779a9c8))
* **runtime-node:** guarded fetch pinned to vetted addresses ([#188](https://github.com/package-broker/broker/issues/188)) ([ba4149f](https://github.com/package-broker/broker/commit/ba4149fe7ed0473d5943cbcbc56f3148a6abf1bc))
* **runtime-node:** verified S3-compatible ByteStore adapter ([#244](https://github.com/package-broker/broker/issues/244)) ([58e8a05](https://github.com/package-broker/broker/commit/58e8a05023b62788c091d9dfd23312b065c266e3))
* Service independence from its creator contract ([#280](https://github.com/package-broker/broker/issues/280)) ([d35231c](https://github.com/package-broker/broker/commit/d35231ccbeadc0da026713bc2bb60be9034cbede))
* Service-principal repository and service: replay, probes and result co ([#338](https://github.com/package-broker/broker/issues/338)) ([9644dcb](https://github.com/package-broker/broker/commit/9644dcbb119157f5d4b0f632d23e179cc937a32a))
* Session repository: epoch comparisons in findActive and touch, and a f ([#371](https://github.com/package-broker/broker/issues/371)) ([b3e9f9a](https://github.com/package-broker/broker/commit/b3e9f9a1a96faa701a4f1f5526bf8ed5cbdff18c))
* Source config: a warning for a selection pattern with no literal vendo ([#388](https://github.com/package-broker/broker/issues/388)) ([4525ee4](https://github.com/package-broker/broker/commit/4525ee4842b24b8a3b4411ffd704056e55948a87))
* **sources:** batched git blob reader by object id ([#285](https://github.com/package-broker/broker/issues/285)) ([7c95c19](https://github.com/package-broker/broker/commit/7c95c1908911adae76639b29da82453f836c9620))
* **sources:** batched git fetch of manifests and trees at many refs ([#229](https://github.com/package-broker/broker/issues/229)) ([06c0fdf](https://github.com/package-broker/broker/commit/06c0fdf937afde52f188fdc315dd0675ee4f0f58))
* **sources:** Git delta resolution with verified object ids ([#180](https://github.com/package-broker/broker/issues/180)) ([4f1627b](https://github.com/package-broker/broker/commit/4f1627b796bdfad8c2a209a71a4d8bb140ea7999))
* **sources:** Git packfile parser with an aggregate memory budget ([#170](https://github.com/package-broker/broker/issues/170)) ([6655430](https://github.com/package-broker/broker/commit/66554304d3d3de4325a68e1a3959bdce6d752071))
* **sources:** Git protocol v2 ref discovery with per-ref skipping ([#187](https://github.com/package-broker/broker/issues/187)) ([ae1ff9f](https://github.com/package-broker/broker/commit/ae1ff9f198b343162fc123fa99a4c0405806ff4e))
* **sources:** origin-bound source credentials with redacted material ([#186](https://github.com/package-broker/broker/issues/186)) ([caf0b75](https://github.com/package-broker/broker/commit/caf0b75c8514c1d0c57d597c6ce10b9661b7c35b))
* **sources:** policy fetch with per-hop redirect checks and origin-bound credentials ([#174](https://github.com/package-broker/broker/issues/174)) ([18e45ed](https://github.com/package-broker/broker/commit/18e45ed45a67c6c4c6352c464090676224a53b7e))
* **sources:** refuse credential echoes before metadata storage ([#223](https://github.com/package-broker/broker/issues/223)) ([f80a082](https://github.com/package-broker/broker/commit/f80a0820618d5714ffc3b4cb634399f1491dde72))
* **sources:** source configuration grammar with outbound policy checks ([#203](https://github.com/package-broker/broker/issues/203)) ([2fbe87b](https://github.com/package-broker/broker/commit/2fbe87b463a4f2c22123dd451b20992435ac7a23))
* **sources:** source provider port with resumable listings ([#219](https://github.com/package-broker/broker/issues/219)) ([99a0ad6](https://github.com/package-broker/broker/commit/99a0ad663150c11dc0c7d8616213382f5a8f4144))
* SSO start: JSON location response for fetch clients ([#366](https://github.com/package-broker/broker/issues/366)) ([5970ee7](https://github.com/package-broker/broker/commit/5970ee73130cf31966f0b671c13e5c64bb578ae4))
* Stored catalogue and registered-name patterns capped at 50 bytes ([#383](https://github.com/package-broker/broker/issues/383)) ([f5c04ad](https://github.com/package-broker/broker/commit/f5c04ad9bf128467ca3f83f7f26624bbb10ce3ef))
* System, token and delegated mutation fences ([#356](https://github.com/package-broker/broker/issues/356)) ([b37d8ad](https://github.com/package-broker/broker/commit/b37d8adaadedb6b54fba627c9353cb4b54283a30))
* T416b: git provider smart-HTTP capabilities, next-tag fallback, skip e ([#377](https://github.com/package-broker/broker/issues/377)) ([ddbe893](https://github.com/package-broker/broker/commit/ddbe893a9784457e4fd06a7cf02437c24fbcc559))
* Token lookup contract on the real repository; personal tokens only for ([#373](https://github.com/package-broker/broker/issues/373)) ([93f7f28](https://github.com/package-broker/broker/commit/93f7f28240b6e0e385f3595193c08f444e279834))
* Token read port and repository: own, project and organization token li ([#381](https://github.com/package-broker/broker/issues/381)) ([2a7e033](https://github.com/package-broker/broker/commit/2a7e033facfc25b242e40c81be1dbb4bcbb5f51d))
* Token read: single-token metadata and issuer attribution ([#399](https://github.com/package-broker/broker/issues/399)) ([f7871c9](https://github.com/package-broker/broker/commit/f7871c9cb97f540aabd5e79e3874d9fceb1eb745))
* Token revocation service ([#282](https://github.com/package-broker/broker/issues/282)) ([6f0321b](https://github.com/package-broker/broker/commit/6f0321b727a63b490e0b3c62a6132da4e8502549))
* Token scope escalation and policy contract ([#278](https://github.com/package-broker/broker/issues/278)) ([07acbbf](https://github.com/package-broker/broker/commit/07acbbfb35a11750c86aeecf0d2594359a2e6cc7))
* Typed blob digest mismatch, the upstream bytes metric, blob port doc ([#354](https://github.com/package-broker/broker/issues/354)) ([f9ac34d](https://github.com/package-broker/broker/commit/f9ac34db5da7d062143ec8ca3f5cc63fc182f3a5))
* uniform refusal contract ([#313](https://github.com/package-broker/broker/issues/313)) ([7d7d5b2](https://github.com/package-broker/broker/commit/7d7d5b26a3f14965c47005cd7e26918a73e42e8a))
* zip archive from a Git tree with export-ignore (Docker) ([#324](https://github.com/package-broker/broker/issues/324)) ([f71d3f5](https://github.com/package-broker/broker/commit/f71d3f50cb6f5ab52427f9868189202b22748640))


### Bug Fixes

* **authz:** fence organization grant mutators and holder checks ([#175](https://github.com/package-broker/broker/issues/175)) ([46e5a84](https://github.com/package-broker/broker/commit/46e5a84e1d8b1499362b2c3020105c590a531675))
* **authz:** fence user suspend and reactivate ([#189](https://github.com/package-broker/broker/issues/189)) ([624a78a](https://github.com/package-broker/broker/commit/624a78a88ee9d99dc0787fe54563d0542e324d05))
* **authz:** project list test actor carries the organization kind ([#230](https://github.com/package-broker/broker/issues/230)) ([06636e7](https://github.com/package-broker/broker/commit/06636e7793a5d0191c7b558ab12268b9fd9118d8))
* **blob:** concurrent same-digest puts and boundary overflows in createBlobStore ([#241](https://github.com/package-broker/broker/issues/241)) ([17b3891](https://github.com/package-broker/broker/commit/17b38918f6a693d66b7b7d4124cc586c53f22960))
* **cli:** build manifest keeps plugin dependency order ([#234](https://github.com/package-broker/broker/issues/234)) ([185e11a](https://github.com/package-broker/broker/commit/185e11a879a1a42752923fbf0bd02bb5b1b759f7))
* **core:** authorization hardening for ids, labels, reporting and timeouts ([#37](https://github.com/package-broker/broker/issues/37)) ([40ba6d3](https://github.com/package-broker/broker/commit/40ba6d3d318e498bcff6337c23aa9aae520df9cd))
* **core:** login-state reauth without a session id returns null ([#74](https://github.com/package-broker/broker/issues/74)) ([f39ec54](https://github.com/package-broker/broker/commit/f39ec54f457a0e3d3f18910be06a7a5c9d0796ae))
* **git:** fall back to an unfiltered fetch when a server ignores the filter ([#306](https://github.com/package-broker/broker/issues/306)) ([26c97c4](https://github.com/package-broker/broker/commit/26c97c457ebb5ac4db5978c3a0fb48f3c182f289))
* **ingest:** bounded memory for lone-surrogate strings in the JSON tokenizer ([#333](https://github.com/package-broker/broker/issues/333)) ([1631796](https://github.com/package-broker/broker/commit/1631796a383dc7f167f530520243918049358ff7))
* **kernel:** plugin register runs once per kernel build ([#109](https://github.com/package-broker/broker/issues/109)) ([6bfdc4b](https://github.com/package-broker/broker/commit/6bfdc4b5589e30b6e152491a2cb86c8031ca1b03))
* **observability:** healthy health probes log at debug, failures at warn ([#331](https://github.com/package-broker/broker/issues/331)) ([41797a5](https://github.com/package-broker/broker/commit/41797a52c4456e896dc847c9167e6bc63198720e))
* **sources:** refuse hidden userinfo spellings, strict self-origin, credential whitespace and encoded probes ([#302](https://github.com/package-broker/broker/issues/302)) ([1e9ce34](https://github.com/package-broker/broker/commit/1e9ce34b709a2170e0ed34fe4928709f3b3abab0))
* **sources:** refuse upstream metadata redirects where the packet requires it ([#325](https://github.com/package-broker/broker/issues/325)) ([d186ec8](https://github.com/package-broker/broker/commit/d186ec83c1ab093e5b4fd80675b02a29ba257bea))
</details>

<details><summary>db-sqlite: 2.0.0-rc.1</summary>

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/db-sqlite-v2.0.0-rc.0...db-sqlite-v2.0.0-rc.1) (2026-10-17)


### Features

* A failed fence guard is told apart from a real unique collision ([#359](https://github.com/package-broker/broker/issues/359)) ([55de662](https://github.com/package-broker/broker/commit/55de662a41f3652231dc9cd8bb9534d2528c9aad))
* A package's ecosystem always equals its source's ecosystem ([#378](https://github.com/package-broker/broker/issues/378)) ([c5acb1d](https://github.com/package-broker/broker/commit/c5acb1d4545034e05037a0134fb7a45cd3f800ac))
* Absolute session lifetime in the shared live-session predicate ([#318](https://github.com/package-broker/broker/issues/318)) ([0325957](https://github.com/package-broker/broker/commit/0325957080c3b5def075cc67a4f35f487ace1e0c))
* Admin bootstrap top-up: counted in the batch, revision and cache epoch ([#297](https://github.com/package-broker/broker/issues/297)) ([e2a547c](https://github.com/package-broker/broker/commit/e2a547c7724520f82b3d5738244d8eaa90801053))
* **authz:** PAT validation origin and 24-hour freshness gate ([#193](https://github.com/package-broker/broker/issues/193)) ([61d222e](https://github.com/package-broker/broker/commit/61d222e1977974e83652e44dba64361019a7b369))
* **authz:** require the organization actor discriminator ([#218](https://github.com/package-broker/broker/issues/218)) ([c58d62f](https://github.com/package-broker/broker/commit/c58d62fa857c1207e59666b7d8640678360cce46))
* **authz:** service-principal authority adapter and creator offboarding on suspension ([#336](https://github.com/package-broker/broker/issues/336)) ([f8bfc24](https://github.com/package-broker/broker/commit/f8bfc24a844e1cce51baa15992a158b5880ac25c))
* **authz:** service-principal service with in-batch authority guard ([#202](https://github.com/package-broker/broker/issues/202)) ([fc4ad43](https://github.com/package-broker/broker/commit/fc4ad4306aa9f7b1fc3f57a01d6c93d4077fde09))
* **authz:** service-token issuance ([#275](https://github.com/package-broker/broker/issues/275)) ([10d862b](https://github.com/package-broker/broker/commit/10d862b8cf012b0beb865a258dfc8fa1afdf7da1))
* **authz:** SQL-filtered readable projects for the project list ([#259](https://github.com/package-broker/broker/issues/259)) ([6acca22](https://github.com/package-broker/broker/commit/6acca22342ccd9e5f6bbaed8f2d6cc0a48180134))
* **authz:** token use gate with background last-used tracking ([#173](https://github.com/package-broker/broker/issues/173)) ([7ac2b5a](https://github.com/package-broker/broker/commit/7ac2b5aee892eb85e9d551a2d44b267cc05022b5))
* Blob lease guard fragment for version writers ([#364](https://github.com/package-broker/broker/issues/364)) ([bdb313d](https://github.com/package-broker/broker/commit/bdb313d3841c66ac8b04398fa2677a062cc52e32))
* Catalogue fixture: forged configurations that seed derived rows ([#314](https://github.com/package-broker/broker/issues/314)) ([b19194c](https://github.com/package-broker/broker/commit/b19194c02715d54d1f6df9b9c8e17d38957ff036))
* **cli:** pb admin show-provider-binding ([#105](https://github.com/package-broker/broker/issues/105)) ([8406650](https://github.com/package-broker/broker/commit/84066506a711cccdf0df1ff9b6040b5476e38275))
* **core:** attributed hook denials on SSO login ([#110](https://github.com/package-broker/broker/issues/110)) ([02851ff](https://github.com/package-broker/broker/commit/02851fff33536841979d1c5722ac9606c1697563))
* **core:** auth module assembly ([#106](https://github.com/package-broker/broker/issues/106)) ([100f228](https://github.com/package-broker/broker/commit/100f2288ba751549f508dcd6edb456183fa3d258))
* **core:** route descriptors from the permission catalogue ([#134](https://github.com/package-broker/broker/issues/134)) ([eb5ff58](https://github.com/package-broker/broker/commit/eb5ff58a2c538c21bb36d7f997dcb83ceb256768))
* Creator offboarding when a project grant removal ends a user's project ([#339](https://github.com/package-broker/broker/issues/339)) ([b74f0b2](https://github.com/package-broker/broker/commit/b74f0b207bb554fdedac5052594943c3f3d40099))
* Cross-provider e-mail linking only through a provider e-mail-authorita ([#362](https://github.com/package-broker/broker/issues/362)) ([9d966e7](https://github.com/package-broker/broker/commit/9d966e7bf8e9f29eb207ad398a45aa68e1bc9142))
* D1 GLOB/LIKE pattern length audit ([#341](https://github.com/package-broker/broker/issues/341)) ([661384b](https://github.com/package-broker/broker/commit/661384b5310c75de17db991b1e650efbc9c181c2))
* **db-sqlite:** admin bootstrap and local login reset batches ([#89](https://github.com/package-broker/broker/issues/89)) ([abbfeea](https://github.com/package-broker/broker/commit/abbfeead8b6917705f9bee043d00699d982d301b))
* **db-sqlite:** backup scope manifest for every migrated table ([#205](https://github.com/package-broker/broker/issues/205)) ([40f1a8d](https://github.com/package-broker/broker/commit/40f1a8dfd2022ed44096cf0bcaf2ad60d6afd09e))
* **db-sqlite:** blob metadata repository ([#157](https://github.com/package-broker/broker/issues/157)) ([4f4913e](https://github.com/package-broker/broker/commit/4f4913e0c7ae4332d09b255c6b619a7931897274))
* **db-sqlite:** blob reference check for retention ([#220](https://github.com/package-broker/broker/issues/220)) ([c750424](https://github.com/package-broker/broker/commit/c750424666b777be14d317a56686ad3104c21d16))
* **db-sqlite:** cache epoch bump in every fenced access mutation ([#136](https://github.com/package-broker/broker/issues/136)) ([78ca6a2](https://github.com/package-broker/broker/commit/78ca6a2bd42ab5f3c1532e6acd37ef68a448de68))
* **db-sqlite:** cache epoch reader for the scoped cache ([#143](https://github.com/package-broker/broker/issues/143)) ([4221de4](https://github.com/package-broker/broker/commit/4221de486eba36e17f294a16d56c33fa87130d27))
* **db-sqlite:** credential repository ([#68](https://github.com/package-broker/broker/issues/68)) ([51c45ee](https://github.com/package-broker/broker/commit/51c45ee62c1f1c334643e8571de9df0aa83e241b))
* **db-sqlite:** diff-based visibility derivation for a scope ([#270](https://github.com/package-broker/broker/issues/270)) ([f790c88](https://github.com/package-broker/broker/commit/f790c88313a80f00b1af8ab47a958f9dccd4a41e))
* **db-sqlite:** fenced actor-authority guard for catalogue writes ([#171](https://github.com/package-broker/broker/issues/171)) ([f94ff9b](https://github.com/package-broker/broker/commit/f94ff9b9ae936224af99d063aa0353d2864b6a70))
* **db-sqlite:** fenced role mutators with in-batch authority ([#148](https://github.com/package-broker/broker/issues/148)) ([b506932](https://github.com/package-broker/broker/commit/b5069326f0832e3263da2b3765a288588cbfc54d))
* **db-sqlite:** freshness-aware protected-holder check on every last-admin path ([#131](https://github.com/package-broker/broker/issues/131)) ([f878546](https://github.com/package-broker/broker/commit/f878546e9c9f56546bf89320e4e3fe5c1b70dc75))
* **db-sqlite:** guard helpers for op markers, ownership, admin eligibility and protected roles ([#69](https://github.com/package-broker/broker/issues/69)) ([8fd534f](https://github.com/package-broker/broker/commit/8fd534f7a3c5bdb4344cbd58fb39c72354853bd0))
* **db-sqlite:** job lease guard and shared cache-epoch bump for job batches ([#197](https://github.com/package-broker/broker/issues/197)) ([ae4723d](https://github.com/package-broker/broker/commit/ae4723d8ee08ac7a10362d82da83c8cba2be6445))
* **db-sqlite:** job repository with leases, fencing and reaping ([#163](https://github.com/package-broker/broker/issues/163)) ([37bff1f](https://github.com/package-broker/broker/commit/37bff1f0aa973fd998c7d4b5ad1d84d7d3424e59))
* **db-sqlite:** job scheduler with atomic per-slot ticks ([#214](https://github.com/package-broker/broker/issues/214)) ([7a2011f](https://github.com/package-broker/broker/commit/7a2011fb1843397adcdc8b5a5c37e7e0678218d0))
* **db-sqlite:** Kysely schema types and compile-only query builder ([#7](https://github.com/package-broker/broker/issues/7)) ([9106876](https://github.com/package-broker/broker/commit/9106876b805aa0826a065d36bcf769c652b12536))
* **db-sqlite:** Kysely table types for the identity tables ([#58](https://github.com/package-broker/broker/issues/58)) ([a6b2709](https://github.com/package-broker/broker/commit/a6b270902f2fae5fb3463f4ebf0198b03737ed44))
* **db-sqlite:** Kysely types for the catalogue source and package tables ([#176](https://github.com/package-broker/broker/issues/176)) ([5b4d6bf](https://github.com/package-broker/broker/commit/5b4d6bf70cfd2cd22fc3357fc06c272970c6a50f))
* **db-sqlite:** Kysely types for the catalogue version and dist-tag tables ([#184](https://github.com/package-broker/broker/issues/184)) ([b91f80d](https://github.com/package-broker/broker/commit/b91f80d5ae425eaf731cde54d93681757f95fae9))
* **db-sqlite:** Kysely types for the registry tables ([#236](https://github.com/package-broker/broker/issues/236)) ([b28e34a](https://github.com/package-broker/broker/commit/b28e34acb683d7ff959a2888a3dcb78cd023b743))
* **db-sqlite:** local login repository: reads and attempt reservation ([#83](https://github.com/package-broker/broker/issues/83)) ([2a1561f](https://github.com/package-broker/broker/commit/2a1561fcade2a859ee41f5c46155a27e930db646))
* **db-sqlite:** local login setup batches ([#90](https://github.com/package-broker/broker/issues/90)) ([b8f1380](https://github.com/package-broker/broker/commit/b8f1380cf7a78682a09890dc0135f4ad6cafd88b))
* **db-sqlite:** local login success batch ([#91](https://github.com/package-broker/broker/issues/91)) ([b9e1863](https://github.com/package-broker/broker/commit/b9e18637fb4371a26a22a01b232d2812d989024c))
* **db-sqlite:** migration 0002 for local login, provider binding and identity freshness ([#57](https://github.com/package-broker/broker/issues/57)) ([b5a043f](https://github.com/package-broker/broker/commit/b5a043f56b18e7b64e22ef2836efb9d44b023c76))
* **db-sqlite:** migration 0003 for the access model ([#114](https://github.com/package-broker/broker/issues/114)) ([168aded](https://github.com/package-broker/broker/commit/168adedf0dc625fe8fe7c0df24559cf0c8cf264f))
* **db-sqlite:** migration 0004 cache_epoch seeded at organization bootstrap ([#126](https://github.com/package-broker/broker/issues/126)) ([e2ad872](https://github.com/package-broker/broker/commit/e2ad872fb528aed8732318c92abddb5cae8ea599))
* **db-sqlite:** migration 0005 tops up Organization Admin permissions ([#146](https://github.com/package-broker/broker/issues/146)) ([0203cd2](https://github.com/package-broker/broker/commit/0203cd27148741053e90bfe25797cade6615eef9))
* **db-sqlite:** migration 0006 for job and blob port columns ([#151](https://github.com/package-broker/broker/issues/151)) ([7023f60](https://github.com/package-broker/broker/commit/7023f60d7775b8b257667178b7f8f8ef3eaa0d46))
* **db-sqlite:** migration 0007 for ingest sessions, upstream state and fetch leases ([#233](https://github.com/package-broker/broker/issues/233)) ([8c7c7f5](https://github.com/package-broker/broker/commit/8c7c7f5e6f00c15545b979859161bec7ec1dddbd))
* **db-sqlite:** migration lock statements with fail-closed fencing ([#16](https://github.com/package-broker/broker/issues/16)) ([7348859](https://github.com/package-broker/broker/commit/7348859d8bcb85a1c83d381f3f56a8edeea59d8c))
* **db-sqlite:** migration plan validation and ordering ([#23](https://github.com/package-broker/broker/issues/23)) ([509bc68](https://github.com/package-broker/broker/commit/509bc68f19095bd22e447a9cf4291e04920a9fa9))
* **db-sqlite:** migration runner with lock, fencing and dry run ([#31](https://github.com/package-broker/broker/issues/31)) ([380cfb5](https://github.com/package-broker/broker/commit/380cfb5e665fdb9c2a41557db4eccde237a3d1e5))
* **db-sqlite:** migration source loader and the core 0001 migration ([#14](https://github.com/package-broker/broker/issues/14)) ([aac2e0f](https://github.com/package-broker/broker/commit/aac2e0f46888ae3211d1b2953608ac9fdb3c2e99))
* **db-sqlite:** migration statement splitter on the SQL lexer ([#9](https://github.com/package-broker/broker/issues/9)) ([822e785](https://github.com/package-broker/broker/commit/822e785ca8d3c2178cbe439c34859631487efc29))
* **db-sqlite:** organization grants, last-admin guard and user suspension ([#87](https://github.com/package-broker/broker/issues/87)) ([48bdc0f](https://github.com/package-broker/broker/commit/48bdc0f4d18215279e4c5a870c6b7174ec625c7f))
* **db-sqlite:** organization repository and bootstrap ([#33](https://github.com/package-broker/broker/issues/33)) ([95199cf](https://github.com/package-broker/broker/commit/95199cfb370927a09ba6ddce26aa57c488ea4c1a))
* **db-sqlite:** package resolution and bound version pages in one statement ([#272](https://github.com/package-broker/broker/issues/272)) ([9ee8861](https://github.com/package-broker/broker/commit/9ee8861fa6782165c4bb395e8faf188013cebc5a))
* **db-sqlite:** paged existing-version reader for ingest diffs ([#204](https://github.com/package-broker/broker/issues/204)) ([d6d7c1b](https://github.com/package-broker/broker/commit/d6d7c1b72da78a997fcc472b1a657d5e54f1455b))
* **db-sqlite:** project grant repository with in-batch authority ([#147](https://github.com/package-broker/broker/issues/147)) ([c965dfb](https://github.com/package-broker/broker/commit/c965dfb57585e64c1e6d2d24e86e4fe1499da039))
* **db-sqlite:** project repository with fenced lifecycle writes ([#150](https://github.com/package-broker/broker/issues/150)) ([c375d1c](https://github.com/package-broker/broker/commit/c375d1cb9a5f60d88b69d4bef2b36001594d5fbc))
* **db-sqlite:** provider rebind with trust anchor compare-and-swap ([#97](https://github.com/package-broker/broker/issues/97)) ([d89bf15](https://github.com/package-broker/broker/commit/d89bf15aead144b31f948b1699cbad69ee14cd7a))
* **db-sqlite:** registered names and private-source enablement ([#253](https://github.com/package-broker/broker/issues/253)) ([2a06e0e](https://github.com/package-broker/broker/commit/2a06e0e5beda56bddc10f5e9dfbf0f25ecf10bfc))
* **db-sqlite:** role repository and default-role seed ([#79](https://github.com/package-broker/broker/issues/79)) ([80f6f5e](https://github.com/package-broker/broker/commit/80f6f5e2c36975dbc0b2e3b13605d6e209819c5c))
* **db-sqlite:** schema types for the access model ([#118](https://github.com/package-broker/broker/issues/118)) ([7a18f25](https://github.com/package-broker/broker/commit/7a18f2541cda4d663938cea6d03d9097e5a8332a))
* **db-sqlite:** service principal repository with fenced writes ([#129](https://github.com/package-broker/broker/issues/129)) ([4419966](https://github.com/package-broker/broker/commit/4419966d7313476cbaa6f0e861542d0c3ab35e35))
* **db-sqlite:** session repository ([#76](https://github.com/package-broker/broker/issues/76)) ([2e7c1e1](https://github.com/package-broker/broker/commit/2e7c1e1ea25d445b3b09ad3158b8c4355e1cf695))
* **db-sqlite:** shared blob store and lifecycle contract suites ([#210](https://github.com/package-broker/broker/issues/210)) ([0dd418e](https://github.com/package-broker/broker/commit/0dd418ef45e1c393f29fc343dd3bb2329042a86d))
* **db-sqlite:** shared catalogue visibility and admission predicates ([#221](https://github.com/package-broker/broker/issues/221)) ([3983e2a](https://github.com/package-broker/broker/commit/3983e2a33f211259fb7e773417c5990d463086a5))
* **db-sqlite:** single-evaluation access mutation guard ([#122](https://github.com/package-broker/broker/issues/122)) ([fc76d40](https://github.com/package-broker/broker/commit/fc76d405c4417a19ff92fcf38cc249e8a0e47167))
* **db-sqlite:** source repository with owner-scoped credentials and paused activation ([#238](https://github.com/package-broker/broker/issues/238)) ([59cb658](https://github.com/package-broker/broker/commit/59cb6586cd39f817dc7779c370eea4620366d10f))
* **db-sqlite:** SQL lexer for statements, strings and comments ([#5](https://github.com/package-broker/broker/issues/5)) ([53c44a5](https://github.com/package-broker/broker/commit/53c44a57344f32a691670d9ae01a8f9e68325e23))
* **db-sqlite:** SSO login write batch ([#86](https://github.com/package-broker/broker/issues/86)) ([260ac63](https://github.com/package-broker/broker/commit/260ac63b7e76f55ffa14f0c408b63f33b95639df))
* **db-sqlite:** token issuance and revocation with in-batch authority ([#149](https://github.com/package-broker/broker/issues/149)) ([93b0581](https://github.com/package-broker/broker/commit/93b0581ac28b0bdac0a86cee38d084e8f431d3bb))
* **db-sqlite:** token lookup for personal and service tokens ([#152](https://github.com/package-broker/broker/issues/152)) ([ea3f199](https://github.com/package-broker/broker/commit/ea3f1997c546e967f97f67b3da617aa7e44f1af2))
* **db-sqlite:** upstream state repository ([#239](https://github.com/package-broker/broker/issues/239)) ([1b28b0d](https://github.com/package-broker/broker/commit/1b28b0d4c73e41ce5f6f2db5541ac43807ed3d40))
* **db-sqlite:** user and identity reads for login ([#82](https://github.com/package-broker/broker/issues/82)) ([c052105](https://github.com/package-broker/broker/commit/c05210517910c1b915b1a91a3c25db9acfc00748))
* Dist resolution with expected identity and fetch descriptor ([#316](https://github.com/package-broker/broker/issues/316)) ([739e582](https://github.com/package-broker/broker/commit/739e5828f2f76d29a054d454cea345a741412583))
* Exact version and tag lookup and the dist-tag read ([#274](https://github.com/package-broker/broker/issues/274)) ([23e9b16](https://github.com/package-broker/broker/commit/23e9b1654911908a8efeef75a846f7fd608e0b6b))
* Fenced identity-block delete repository and unblock service ([#266](https://github.com/package-broker/broker/issues/266)) ([3712842](https://github.com/package-broker/broker/commit/3712842292de4cb20b4d4454115c16452c3c264f))
* Fetch lease repository and catalogue write guard ([#380](https://github.com/package-broker/broker/issues/380)) ([ce1ada7](https://github.com/package-broker/broker/commit/ce1ada713cfe3ca80d776ce0c74c8f8fb57d1285))
* **identity:** identity unlink and provider rebind with last-holder proof ([#198](https://github.com/package-broker/broker/issues/198)) ([0b804c5](https://github.com/package-broker/broker/commit/0b804c5bcd53864992c5ed39d082ab3c616c4f93))
* Migration 0011: pending audit, idempotency, action index ([#398](https://github.com/package-broker/broker/issues/398)) ([53699b0](https://github.com/package-broker/broker/commit/53699b08f82cb87557d2206c43ee031a7848ee98))
* npm dist-tag writes with append-only history ([#384](https://github.com/package-broker/broker/issues/384)) ([5c372d8](https://github.com/package-broker/broker/commit/5c372d8378018f3d3cd676775f29da58cce366df))
* Observability contract on the Node and Workers sinks ([#330](https://github.com/package-broker/broker/issues/330)) ([c9e30dd](https://github.com/package-broker/broker/commit/c9e30dddd7367402e7409c79006108987ccd6c04))
* Package upsert with creation materialization and description generatio ([#343](https://github.com/package-broker/broker/issues/343)) ([a43e864](https://github.com/package-broker/broker/commit/a43e864467d594a79cacd7dc877e58503a9ce497))
* Project creation attaches organization sources ([#376](https://github.com/package-broker/broker/issues/376)) ([d5406af](https://github.com/package-broker/broker/commit/d5406aff72b592747ad11ebdbf8b416f53ed7319))
* Project cross-project denial contract ([#368](https://github.com/package-broker/broker/issues/368)) ([b9027b9](https://github.com/package-broker/broker/commit/b9027b9ad15798d5777ce918ac106d75fbc010a7))
* Project repository: core constants, store conformance, authority befor ([#299](https://github.com/package-broker/broker/issues/299)) ([982a820](https://github.com/package-broker/broker/commit/982a820df357601a42a51aaf2b49d8b2687bc256))
* Project subset writes: patterns and explicit packages ([#342](https://github.com/package-broker/broker/issues/342)) ([0892602](https://github.com/package-broker/broker/commit/0892602e664d25a70f84a498247445b1637f8569))
* protected-holder and last-holder contract ([#315](https://github.com/package-broker/broker/issues/315)) ([f880837](https://github.com/package-broker/broker/commit/f8808379f191e41c302b790ac20a24c7dbb292f6))
* Proxy admission for unseen names ([#276](https://github.com/package-broker/broker/issues/276)) ([193f52c](https://github.com/package-broker/broker/commit/193f52c9a48a19f2160a936f454e49b5c68e0006))
* Quarantine, tombstone and release transitions ([#390](https://github.com/package-broker/broker/issues/390)) ([d9a9743](https://github.com/package-broker/broker/commit/d9a9743440f337560e70ea34a5c2317e8786f9f8))
* Query plans on D1: INDEXED BY statements and the local PAT holder sc ([#357](https://github.com/package-broker/broker/issues/357)) ([31dba34](https://github.com/package-broker/broker/commit/31dba34b40989c4f9b51366f9bc37d70bd074e26))
* **registry:** batched last-accessed tracking for blobs ([#195](https://github.com/package-broker/broker/issues/195)) ([300a2eb](https://github.com/package-broker/broker/commit/300a2eb2529f1aac5b8c7089a490831da7e86dc9))
* **registry:** conditional requests and the Composer representation clock ([#254](https://github.com/package-broker/broker/issues/254)) ([9d20b23](https://github.com/package-broker/broker/commit/9d20b23d47d0147f9daf9de9281efb881de9c712))
* **registry:** on-demand admission for scoped npm registry sources ([#310](https://github.com/package-broker/broker/issues/310)) ([b48b27a](https://github.com/package-broker/broker/commit/b48b27ad24f4fb18ff25cd5af1d4c5aa829a0425))
* **registry:** representation clock tracks the winning package and its revision ([#311](https://github.com/package-broker/broker/issues/311)) ([bd477d9](https://github.com/package-broker/broker/commit/bd477d9a5d5d1f4ff193b8e8bc9ec734ba1e17c2))
* Retention: orphan refetchable blobs become purge-eligible 7 days aft ([#360](https://github.com/package-broker/broker/issues/360)) ([888d168](https://github.com/package-broker/broker/commit/888d1688d12e26c1091d57825cbc7921f0b37f3c))
* **runtime-cloudflare:** queue consumer and cron handler for jobs ([#279](https://github.com/package-broker/broker/issues/279)) ([cd6bc4b](https://github.com/package-broker/broker/commit/cd6bc4ba2adf4707c4f7ec7581700e517f8a167f))
* Service-principal repository and service: replay, probes and result co ([#338](https://github.com/package-broker/broker/issues/338)) ([9644dcb](https://github.com/package-broker/broker/commit/9644dcbb119157f5d4b0f632d23e179cc937a32a))
* Session repository: epoch comparisons in findActive and touch, and a f ([#371](https://github.com/package-broker/broker/issues/371)) ([b3e9f9a](https://github.com/package-broker/broker/commit/b3e9f9a1a96faa701a4f1f5526bf8ed5cbdff18c))
* Source attach, detach, precedence and package flag writes ([#340](https://github.com/package-broker/broker/issues/340)) ([3f7fc2e](https://github.com/package-broker/broker/commit/3f7fc2eb2fe35e8c593e3c968adec1a7dea6df49))
* Stored catalogue and registered-name patterns capped at 50 bytes ([#383](https://github.com/package-broker/broker/issues/383)) ([f5c04ad](https://github.com/package-broker/broker/commit/f5c04ad9bf128467ca3f83f7f26624bbb10ce3ef))
* T569b: creator-removed case through the T568 removal path and a mutati ([#375](https://github.com/package-broker/broker/issues/375)) ([d94adf1](https://github.com/package-broker/broker/commit/d94adf17cfeabcb85027b46f4d37f541dd46e81e))
* Token lookup contract on the real repository; personal tokens only for ([#373](https://github.com/package-broker/broker/issues/373)) ([93f7f28](https://github.com/package-broker/broker/commit/93f7f28240b6e0e385f3595193c08f444e279834))
* Token read port and repository: own, project and organization token li ([#381](https://github.com/package-broker/broker/issues/381)) ([2a7e033](https://github.com/package-broker/broker/commit/2a7e033facfc25b242e40c81be1dbb4bcbb5f51d))
* Token read: single-token metadata and issuer attribution ([#399](https://github.com/package-broker/broker/issues/399)) ([f7871c9](https://github.com/package-broker/broker/commit/f7871c9cb97f540aabd5e79e3874d9fceb1eb745))
* Typed blob digest mismatch, the upstream bytes metric, blob port doc ([#354](https://github.com/package-broker/broker/issues/354)) ([f9ac34d](https://github.com/package-broker/broker/commit/f9ac34db5da7d062143ec8ca3f5cc63fc182f3a5))
* Version insert with per-package phase, validation and licence ([#379](https://github.com/package-broker/broker/issues/379)) ([fed00d6](https://github.com/package-broker/broker/commit/fed00d6e97fe90af5ae4c029bac7d54570216c1c))
* Version update: Composer revisions, npm conflicts and deprecation ([#382](https://github.com/package-broker/broker/issues/382)) ([0423e16](https://github.com/package-broker/broker/commit/0423e1616ce3ba06696e0425d86a76649fcfe881))
* Visible package listing and search ([#317](https://github.com/package-broker/broker/issues/317)) ([c361cea](https://github.com/package-broker/broker/commit/c361cea66dfd10fada5c776a23df834d6210ce15))


### Bug Fixes

* **auth:** revoke a session in one guarded statement ([#291](https://github.com/package-broker/broker/issues/291)) ([5f8e757](https://github.com/package-broker/broker/commit/5f8e757c4be6ffcd26e25dcfff27e1090f3a2a3b))
* **authz:** fence organization grant mutators and holder checks ([#175](https://github.com/package-broker/broker/issues/175)) ([46e5a84](https://github.com/package-broker/broker/commit/46e5a84e1d8b1499362b2c3020105c590a531675))
* **authz:** fence user suspend and reactivate ([#189](https://github.com/package-broker/broker/issues/189)) ([624a78a](https://github.com/package-broker/broker/commit/624a78a88ee9d99dc0787fe54563d0542e324d05))
* **blob:** concurrent same-digest puts and boundary overflows in createBlobStore ([#241](https://github.com/package-broker/broker/issues/241)) ([17b3891](https://github.com/package-broker/broker/commit/17b38918f6a693d66b7b7d4124cc586c53f22960))
* **build:** migration lists come from the discovered set ([#298](https://github.com/package-broker/broker/issues/298)) ([5814920](https://github.com/package-broker/broker/commit/5814920b51b5eb18f7937f213c86bc1f657634af))
* **db-sqlite:** keep authorization statements under the D1 parameter limit ([#145](https://github.com/package-broker/broker/issues/145)) ([ce204d2](https://github.com/package-broker/broker/commit/ce204d2c41a6773fcd2c4d08424fbd5ce7e45644))
* **db-sqlite:** login batch refuses blocked identity subjects ([#245](https://github.com/package-broker/broker/issues/245)) ([f557def](https://github.com/package-broker/broker/commit/f557def6c29e6a78bc3a66d70ae758fb6faf16a3))
* **db-sqlite:** reject non-finite migration sequences ([#25](https://github.com/package-broker/broker/issues/25)) ([9d48cac](https://github.com/package-broker/broker/commit/9d48cac0fc90e838928008c1cdf5b0abde3b1606))
* **db:** fail closed on D1 parameter and pattern limits in the executors ([#329](https://github.com/package-broker/broker/issues/329)) ([9a4f3b5](https://github.com/package-broker/broker/commit/9a4f3b53c03fea6a17357953da0767230018b24c))


### Performance Improvements

* Job queue claim index for D1 load ([#395](https://github.com/package-broker/broker/issues/395)) ([1266f5f](https://github.com/package-broker/broker/commit/1266f5f4ca132725ae481e34b6cf35bddf33c3b6))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @package-broker/core bumped to 2.0.0-rc.1
</details>

<details><summary>runtime-cloudflare: 2.0.0-rc.1</summary>

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
</details>

<details><summary>runtime-node: 2.0.0-rc.1</summary>

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
</details>

<details><summary>ui: 2.0.0-rc.1</summary>

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/ui-v2.0.0-rc.0...ui-v2.0.0-rc.1) (2026-10-17)


### Features

* **ui:** static placeholder package ([176f61d](https://github.com/package-broker/broker/commit/176f61dd0079577c494902b099f29ec9863dacd8))
</details>

---
This PR was generated with [Release Please](https://github.com/googleapis/release-please). See [documentation](https://github.com/googleapis/release-please#release-please).