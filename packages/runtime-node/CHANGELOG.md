# Changelog

## [2.0.0-rc.3](https://github.com/package-broker/broker/compare/runtime-node-v2.0.0-rc.2...runtime-node-v2.0.0-rc.3) (2026-10-28)


### Miscellaneous Chores

* **runtime-node:** Synchronize product versions


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @package-broker/core bumped to 2.0.0-rc.3
    * @package-broker/db-sqlite bumped to 2.0.0-rc.3

## [2.0.0-rc.2](https://github.com/package-broker/broker/compare/runtime-node-v2.0.0-rc.1...runtime-node-v2.0.0-rc.2) (2026-10-28)


### Bug Fixes

* read SSO providers at runtime and check the trust anchor before contacting the IdP ([#926](https://github.com/package-broker/broker/issues/926)) ([ee91a10](https://github.com/package-broker/broker/commit/ee91a1073b4af36c9429c75720676b5fc72d0f93)), closes [#918](https://github.com/package-broker/broker/issues/918)
* **runtime-node:** PB_TRUSTED_PROXY names the proxy type it trusts ([#939](https://github.com/package-broker/broker/issues/939)) ([6f2ac52](https://github.com/package-broker/broker/commit/6f2ac520d4fca20d0e53da89f9fd0b9e745dbcb2))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @package-broker/core bumped to 2.0.0-rc.2
    * @package-broker/db-sqlite bumped to 2.0.0-rc.2

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/runtime-node-v2.0.0-rc.0...runtime-node-v2.0.0-rc.1) (2026-10-27)


### Features

* **audit:** record local login and reauth in their session batches ([#825](https://github.com/package-broker/broker/issues/825)) ([04f64b3](https://github.com/package-broker/broker/commit/04f64b3e2f2916081b886de90bbe667fc33e1150))
* **audit:** record setup completion in the setup batch ([#828](https://github.com/package-broker/broker/issues/828)) ([8cdac9d](https://github.com/package-broker/broker/commit/8cdac9dbd2228f0f8f275329164523c07f4b29df))
* BrokerConfig flag to trust inbound W3C traceparent, off by default ([#476](https://github.com/package-broker/broker/issues/476)) ([692edd0](https://github.com/package-broker/broker/commit/692edd0e3048ec3380c83c4bf335524d1c585d96))
* **cli:** pass BrokerConfig observability from broker.config.ts to both runtimes ([#542](https://github.com/package-broker/broker/issues/542)) ([e1a971d](https://github.com/package-broker/broker/commit/e1a971d7c6ad7a539341077e6188a4f44f2437b9))
* **core:** access-loss paths enqueue selected-PAT revocation ([#694](https://github.com/package-broker/broker/issues/694)) ([c7a3077](https://github.com/package-broker/broker/commit/c7a307722ff7806c282186f4d577272be5ac3b53))
* **core:** attach and detach a source to a project ([#774](https://github.com/package-broker/broker/issues/774)) ([bd042b2](https://github.com/package-broker/broker/commit/bd042b26d72e8a2c9b5e451c4a0ff11688a2612e))
* **core:** baseline security headers on every response ([#513](https://github.com/package-broker/broker/issues/513)) ([83d3df1](https://github.com/package-broker/broker/commit/83d3df1e7279e50015912c85977803dc003b8a15))
* **core:** composer_repository source provider (job-synced mirror) ([#804](https://github.com/package-broker/broker/issues/804)) ([e6b5914](https://github.com/package-broker/broker/commit/e6b5914c669769f4454f4bedd5274efc6dc6f3e8))
* **core:** identity finish failures carry a closed-list detail code ([#752](https://github.com/package-broker/broker/issues/752)) ([afbf15f](https://github.com/package-broker/broker/commit/afbf15ff8a292ef866df079559688bb7b9997dee))
* **core:** import verify job with rollback recovery from a dead verify ([#679](https://github.com/package-broker/broker/issues/679)) ([4f3f6a9](https://github.com/package-broker/broker/commit/4f3f6a9aacbb50d779cc35be56db21460a2549e8))
* **core:** ingest logs carry the source id ([#757](https://github.com/package-broker/broker/issues/757)) ([0db40e1](https://github.com/package-broker/broker/commit/0db40e1ab749ee6bd3f12c9cca389475568b703b))
* **core:** job lease accessor and release signal for core jobs ([#664](https://github.com/package-broker/broker/issues/664)) ([116edfb](https://github.com/package-broker/broker/commit/116edfbb2bc00596f74eb7bad6a0d3cc387f43cb))
* **core:** keyring verifier follow-ups ([#602](https://github.com/package-broker/broker/issues/602)) ([906ce97](https://github.com/package-broker/broker/commit/906ce97af5ab187ef56aca5698d309fce8d9b610))
* **core:** lease-bound fence issuer for import jobs ([#652](https://github.com/package-broker/broker/issues/652)) ([d638f8e](https://github.com/package-broker/broker/commit/d638f8ec85c5aa02d8584639013719aa503b751f))
* **core:** management API wave b: package manage and import routes with the token fence ([#780](https://github.com/package-broker/broker/issues/780)) ([11e6e05](https://github.com/package-broker/broker/commit/11e6e05fa6dbf4fcce99f1ec5322c47798cd6853))
* **core:** PAT and service-principal services carry audit and idempotency ([#556](https://github.com/package-broker/broker/issues/556)) ([d6dd962](https://github.com/package-broker/broker/commit/d6dd9620746cf63f5329a93b3095f54ab05b90ff))
* **core:** periodic source poll, retention scan, sweep and due purge with premature-purge guard ([#673](https://github.com/package-broker/broker/issues/673)) ([aca62da](https://github.com/package-broker/broker/commit/aca62daedbe7fbcc9f994fc95b32cd21e9fe8a93))
* **core:** persist the last successful audit verification time ([#778](https://github.com/package-broker/broker/issues/778)) ([2bf2347](https://github.com/package-broker/broker/commit/2bf234736e85cdb0b64d647d6d684155346fd58e))
* **core:** project grants list and source attachment and precedence for the UI ([#791](https://github.com/package-broker/broker/issues/791)) ([7873621](https://github.com/package-broker/broker/commit/787362114847001464624aaaabe42818fbad911f))
* **core:** project services write audit and idempotency ([#586](https://github.com/package-broker/broker/issues/586)) ([eebc9e3](https://github.com/package-broker/broker/commit/eebc9e3b2c233352dc2081f325f52f56ebc04ecb))
* **core:** report schema drift on /health/ready ([#901](https://github.com/package-broker/broker/issues/901)) ([4e79afd](https://github.com/package-broker/broker/commit/4e79afd3bbb6698b96b4835f7e267ad974f03fbe))
* **core:** request a package on a proxy source before the first install ([#904](https://github.com/package-broker/broker/issues/904)) ([9ce2457](https://github.com/package-broker/broker/commit/9ce24575d45802ef098e3c2bac02137558bc5eb2))
* **core:** serve the UI shell publicly so the login screen is reachable ([#783](https://github.com/package-broker/broker/issues/783)) ([0ad4c6d](https://github.com/package-broker/broker/commit/0ad4c6d1c8cadf951290f0328f4f50227857af55))
* **core:** service-principal creation requires fresh reauth ([#597](https://github.com/package-broker/broker/issues/597)) ([93d079e](https://github.com/package-broker/broker/commit/93d079eba176ee6fb303d85cb496c4039390f192))
* **core:** sync generations with package counts and child error codes ([#883](https://github.com/package-broker/broker/issues/883)) ([3390cd3](https://github.com/package-broker/broker/commit/3390cd371ff62330ebf2366f8ababef8efe32878))
* **core:** token services bind to the route ([#585](https://github.com/package-broker/broker/issues/585)) ([1afa0ea](https://github.com/package-broker/broker/commit/1afa0eadb369b96a1959c6e739d41f7c7438971a))
* **core:** upstream.fetch child span for every upstream request ([#880](https://github.com/package-broker/broker/issues/880)) ([fd11ae0](https://github.com/package-broker/broker/commit/fd11ae03e22028d7970568ca8733805f8e1ffd33))
* **core:** vulnerability status in the API and job wiring on Node and Workers ([#779](https://github.com/package-broker/broker/issues/779)) ([89a54fc](https://github.com/package-broker/broker/commit/89a54fc78a8a6d0e4e5154969389de66090cc8a9))
* **db-sqlite:** closure-edge indexes with project_package names (migration 0024) ([#735](https://github.com/package-broker/broker/issues/735)) ([14cecfd](https://github.com/package-broker/broker/commit/14cecfd2a1ac89e686557c5c05178c44090373ab))
* **db-sqlite:** mass-removal guard at the finalize call sites with per-registry not-found presets ([#546](https://github.com/package-broker/broker/issues/546)) ([9631882](https://github.com/package-broker/broker/commit/963188227ce5239efdc1185fb82caafdde749b74))
* **db-sqlite:** schedule refetchable orphans past grace for purge ([#650](https://github.com/package-broker/broker/issues/650)) ([2e601c9](https://github.com/package-broker/broker/commit/2e601c9aded128fea40c766fd91dac74a5db358b))
* **db-sqlite:** visibility mutations write audit rows in the fenced batch ([#610](https://github.com/package-broker/broker/issues/610)) ([adb0d1e](https://github.com/package-broker/broker/commit/adb0d1e0e692cd1b0d3266dc1b38822f4797b9f2))
* **db-sqlite:** vulnerability status storage, migration 0022 and contracts ([#701](https://github.com/package-broker/broker/issues/701)) ([ced5dff](https://github.com/package-broker/broker/commit/ced5dffd560c757a6775e3db9be2bf2d11ba689c))
* Docker smoke command and migration log wiring on the Node entry ([#715](https://github.com/package-broker/broker/issues/715)) ([c65e77b](https://github.com/package-broker/broker/commit/c65e77bc3b12548172773a23f3fe589f8554b5a2))
* engine wiring prerequisites: token revoke adapters, provider-anchor reader, request-bound background work ([#437](https://github.com/package-broker/broker/issues/437)) ([39f71ba](https://github.com/package-broker/broker/commit/39f71ba13b78be8e25fa3df4e459d7ae0a6b7221))
* mount the UI separately from the management API ([#523](https://github.com/package-broker/broker/issues/523)) ([34eee2d](https://github.com/package-broker/broker/commit/34eee2d9b9b1b8a7456000f3a4f7ab2cb4930840))
* **plugin-github:** wire the GitHub provider, App discovery and webhook verifier via SourceProviderContext ([#724](https://github.com/package-broker/broker/issues/724)) ([1a758df](https://github.com/package-broker/broker/commit/1a758df761df737cc967039d2ef0254c84375574))
* Register the audit jobs in both runtimes ([#483](https://github.com/package-broker/broker/issues/483)) ([5fbadb6](https://github.com/package-broker/broker/commit/5fbadb65743f92bdbd3502c001b186b5d4ca1f4b))
* **runtime-node:** filesystem SSH archive store scoped per call by OrgContext ([#457](https://github.com/package-broker/broker/issues/457)) ([1596328](https://github.com/package-broker/broker/commit/15963287ff5acdd8a247c8bcf0074d1d5f98ca29))
* **runtime-node:** forced exit after a shutdown timeout ([#574](https://github.com/package-broker/broker/issues/574)) ([edcb078](https://github.com/package-broker/broker/commit/edcb0784379dd9571eaafec86fca1382c6390fdb))
* **runtime-node:** generic Git sources on Node and source forms that offer only served providers ([#849](https://github.com/package-broker/broker/issues/849)) ([30bf3eb](https://github.com/package-broker/broker/commit/30bf3eb09c1c9e87bb970b28faa1c43b0dd9ef30))
* **runtime-node:** Node entry: platformPorts manifest export, process handlers, sanitized startup failure ([#443](https://github.com/package-broker/broker/issues/443)) ([bf2634e](https://github.com/package-broker/broker/commit/bf2634edfef86b7d41458f1b6f86e5b478369c9a))
* **runtime-node:** register the package-sync job on the Node runtime ([#685](https://github.com/package-broker/broker/issues/685)) ([32481d5](https://github.com/package-broker/broker/commit/32481d5c3791cc591b235daa059f681a68307a15))
* **runtime-node:** serve SSH-built archives through the registry dist path ([#877](https://github.com/package-broker/broker/issues/877)) ([6e95071](https://github.com/package-broker/broker/commit/6e950719e0d62e55533ebb6c8c56bb1922f659ab))
* **runtime-node:** shutdown reports abandoned work; auth records reach the sink with reason codes ([#419](https://github.com/package-broker/broker/issues/419)) ([b2b31d2](https://github.com/package-broker/broker/commit/b2b31d2e0a8eb44bff108fc78f3840c94b5a3bfb))
* **runtime-node:** trusted-proxy client IP for audit source_ip ([#776](https://github.com/package-broker/broker/issues/776)) ([b1008a0](https://github.com/package-broker/broker/commit/b1008a0df9af4fbc8911252c9e1af95da9136f97))
* **runtime-node:** wire the authorization engine, pepper and access services ([#447](https://github.com/package-broker/broker/issues/447)) ([d26762e](https://github.com/package-broker/broker/commit/d26762ecbf4fc47e97577adf4e48ce9397219cac))
* **runtime-node:** wire the catalogue ([#521](https://github.com/package-broker/broker/issues/521)) ([86a73f8](https://github.com/package-broker/broker/commit/86a73f83ad95a7e87c83b6b7ae0d630390657772))
* **runtime-node:** wire the registry, codecs and guarded fetch into the Node runtime ([#641](https://github.com/package-broker/broker/issues/641)) ([9c3f238](https://github.com/package-broker/broker/commit/9c3f238980324fb7bffa3c553b6d7c19e24e5d99))
* **runtime:** compose organization Administration and carry config.tokens through the manifest ([#693](https://github.com/package-broker/broker/issues/693)) ([093998e](https://github.com/package-broker/broker/commit/093998e723c6ce591574490783acdd19cb6c5323))
* **runtime:** compose source-sync and source-poll jobs on both runtimes ([#713](https://github.com/package-broker/broker/issues/713)) ([4256596](https://github.com/package-broker/broker/commit/425659674c11376edc5b9218cb08e34bb773ca77))
* **runtime:** keyring verifier that fails closed when PB_MASTER_KEY does not match the stored keyring ([#581](https://github.com/package-broker/broker/issues/581)) ([57612b7](https://github.com/package-broker/broker/commit/57612b76c16d6bc9b5c7eb0eda3bc0867eb36a6d))
* **runtime:** mount /_pb/mcp when enabled; check the rate-limit binding at startup ([#802](https://github.com/package-broker/broker/issues/802)) ([79860d6](https://github.com/package-broker/broker/commit/79860d682570de674f3a2fae3f9ce598c24b7306))
* **runtime:** mount the API module on Node and Workers ([#809](https://github.com/package-broker/broker/issues/809)) ([1420bbd](https://github.com/package-broker/broker/commit/1420bbd41a8f561c660fddbe2fe8fcfa35a217f3))
* **runtime:** mount the GitHub webhook route on both runtimes ([#731](https://github.com/package-broker/broker/issues/731)) ([6b4984b](https://github.com/package-broker/broker/commit/6b4984b37486b93bd1f35d35f6aad1548802f8bc))
* **runtime:** mount the management API wave a on Node and Workers ([#766](https://github.com/package-broker/broker/issues/766)) ([2268b87](https://github.com/package-broker/broker/commit/2268b87705dc38732040aa253a13fc8a473e2e32))
* **runtime:** register retention-scan and blob-purge jobs with a lease-safe purge outcome ([#687](https://github.com/package-broker/broker/issues/687)) ([47246d9](https://github.com/package-broker/broker/commit/47246d980561f72b6757bb2858c92fa9bd42d4c7))
* **runtime:** register the import apply and rollback jobs on both runtimes ([#666](https://github.com/package-broker/broker/issues/666)) ([a8da9fa](https://github.com/package-broker/broker/commit/a8da9fa05023d0cf0d8be03567750557a3d79d0d))
* **runtime:** serve /_pb/openapi.json and complete the API document ([#790](https://github.com/package-broker/broker/issues/790)) ([ec277e2](https://github.com/package-broker/broker/commit/ec277e2baf6226aa7e26be126fa30f39e7258a30))
* **runtime:** streaming blob hashers and purge timing check ([#593](https://github.com/package-broker/broker/issues/593)) ([489b488](https://github.com/package-broker/broker/commit/489b488f58c31eff313b31cf95c30267fbdae01e))
* **runtime:** wire the token lifetime policy and personal-token offboarding jobs ([#674](https://github.com/package-broker/broker/issues/674)) ([c707814](https://github.com/package-broker/broker/commit/c70781414bc98c994248be8cb9b604f2334324fb))
* Sealer job ([#435](https://github.com/package-broker/broker/issues/435)) ([7021085](https://github.com/package-broker/broker/commit/702108564caa5aecc9efcd3b3c9c21425f1b793d))
* Shared public-origin parser ([#516](https://github.com/package-broker/broker/issues/516)) ([15eb515](https://github.com/package-broker/broker/commit/15eb515e6e6532cce6c2cb5e9890e30de8d758c9))
* **sources:** GitHub sources with a personal access token ([#822](https://github.com/package-broker/broker/issues/822)) ([ffaa78b](https://github.com/package-broker/broker/commit/ffaa78bc9a0eba5d734a242caf0b9dfc3ecdb10a))
* **sources:** sync now, immediate poll on enable, sync outcome in the source DTO ([#826](https://github.com/package-broker/broker/issues/826)) ([9dcaf07](https://github.com/package-broker/broker/commit/9dcaf071593524d4c467a2bb52ed2576bd5695a0))
* StaticAssets adapters: Workers ASSETS binding and Node dist directory ([#462](https://github.com/package-broker/broker/issues/462)) ([b0927b0](https://github.com/package-broker/broker/commit/b0927b0cb9124f0950236b828979c1418e262bb7))
* **ui:** browser first-admin setup with a local QR and automated Playwright end to end ([#718](https://github.com/package-broker/broker/issues/718)) ([8fcda6e](https://github.com/package-broker/broker/commit/8fcda6ed00991b21ee544f410893d0750f9a05f1))
* Version-state store: D8 authority, package match, expected status, aud ([#751](https://github.com/package-broker/broker/issues/751)) ([6b69d63](https://github.com/package-broker/broker/commit/6b69d633bbac1e1e6abd39158de5a7ab3c429e0e))


### Bug Fixes

* **auth:** client address resolvers return only IP literals ([#821](https://github.com/package-broker/broker/issues/821)) ([8fffb73](https://github.com/package-broker/broker/commit/8fffb73c7a5872324b076e2fcefd761e2b910cd9))
* **core:** allow enabling the Packagist GitHub token mode through the API ([#831](https://github.com/package-broker/broker/issues/831)) ([6a7ecd8](https://github.com/package-broker/broker/commit/6a7ecd8f06c0685ef09f72b31a60b9eb5783f749))
* **core:** answer 503 for sources that cannot be bound instead of 404 ([#854](https://github.com/package-broker/broker/issues/854)) ([1533eb5](https://github.com/package-broker/broker/commit/1533eb5535e23a577345e47a791133b8f42c95fb))
* **core:** bind a Packagist credential only in GitHub token mode ([#835](https://github.com/package-broker/broker/issues/835)) ([242ddc2](https://github.com/package-broker/broker/commit/242ddc28c18134ecabf1de9cf9cfab944eff8769))
* **core:** Composer fill fails fast on an incomplete upstream document; dist hash refusal answers 502 ([#657](https://github.com/package-broker/broker/issues/657)) ([612934f](https://github.com/package-broker/broker/commit/612934fd39aa9834917f573547ea1c1a3091f4ae))
* **core:** D1 batches never exceed 200 statements ([#767](https://github.com/package-broker/broker/issues/767)) ([90cd307](https://github.com/package-broker/broker/commit/90cd307d702bbd790f4b0e73cd70574f71bfd9d7))
* **core:** narrowing a source selection never removes packages ([#771](https://github.com/package-broker/broker/issues/771)) ([ba1fc77](https://github.com/package-broker/broker/commit/ba1fc77d8561210d6eec594b4001b8b61e0637c4))
* **core:** outbound policy: explicit TLS ports are https-only and the DNS guard requires a scheme ([#464](https://github.com/package-broker/broker/issues/464)) ([f2bfa1e](https://github.com/package-broker/broker/commit/f2bfa1e0aa599285545ba89cd123341da2e5a928))
* **core:** refuse and quarantine an upstream archive over the size cap ([#846](https://github.com/package-broker/broker/issues/846)) ([72eaf1c](https://github.com/package-broker/broker/commit/72eaf1cbfe02dfb2467a8814682621a7223df310))
* **core:** refused upstream answers 502 upstream_refused; refusal log at debug only ([#796](https://github.com/package-broker/broker/issues/796)) ([5bd73b1](https://github.com/package-broker/broker/commit/5bd73b13197e92f05c5b32457b6017fcc944a03b))
* **core:** require an MCP limiter on Node and split non-touching session authentication ([#859](https://github.com/package-broker/broker/issues/859)) ([f14a75f](https://github.com/package-broker/broker/commit/f14a75fb9d001b77507f91d7f55840e17591a905))
* **db-sqlite:** imported source config omits absent fields so the runtime binds generic Git sources ([#886](https://github.com/package-broker/broker/issues/886)) ([b56f11f](https://github.com/package-broker/broker/commit/b56f11f88d183527b4d60afcd8e55cac2f20c4d0))
* **db-sqlite:** protectedHolder decides group freshness on the database clock ([#552](https://github.com/package-broker/broker/issues/552)) ([c62ae32](https://github.com/package-broker/broker/commit/c62ae32fe535ba04caf4ffad0dcb6d5a768b25ce))
* outbound policy: bare allowlist entries admit HTTPS on 443 only, http on 443 refused ([#415](https://github.com/package-broker/broker/issues/415)) ([a3c8a60](https://github.com/package-broker/broker/commit/a3c8a603aadfc84a4db05967560beb7f7e871626))
* **runtime-node:** accept only IP literals from proxy forwarding headers ([#782](https://github.com/package-broker/broker/issues/782)) ([dc802f2](https://github.com/package-broker/broker/commit/dc802f2fb556fb352a3bc3e09793628b71095cef))
* **runtime-node:** bind the packagist-proxy GitHub token to GitHub origins only ([#662](https://github.com/package-broker/broker/issues/662)) ([f6a57bb](https://github.com/package-broker/broker/commit/f6a57bb89364484a315a415f21cece7b76ad9a3b))
* **runtime-node:** bound the registry drain by the shutdown deadline and move test seams out of the public entry ([#649](https://github.com/package-broker/broker/issues/649)) ([45e6dde](https://github.com/package-broker/broker/commit/45e6dde5158df4a2806d978c9d12ad713c0848ca))
* **runtime:** serve the staged UI the same way on Node and the Worker ([#672](https://github.com/package-broker/broker/issues/672)) ([1350dfb](https://github.com/package-broker/broker/commit/1350dfbb3ed9c7b218945b86168ca9d08c8c6d4b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @package-broker/core bumped to 2.0.0-rc.1
    * @package-broker/db-sqlite bumped to 2.0.0-rc.1
