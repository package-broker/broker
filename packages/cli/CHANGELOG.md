# Changelog

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/cli-v2.0.0-rc.0...cli-v2.0.0-rc.1) (2026-10-24)


### Features

* `pb openapi` and manifest ([#427](https://github.com/package-broker/broker/issues/427)) ([5f48ada](https://github.com/package-broker/broker/commit/5f48ada0761d4ede983c833d556a2ccbe1f34626))
* **audit:** record SSO login in the session batch ([#827](https://github.com/package-broker/broker/issues/827)) ([1dd04e5](https://github.com/package-broker/broker/commit/1dd04e5a8e9f5a33b45b3f9c8b629b4f22d87cd6))
* Catalogue diagnostics fail pb build and the migration runner ([#351](https://github.com/package-broker/broker/issues/351)) ([f272da0](https://github.com/package-broker/broker/commit/f272da07aea35aeb1134978122a57d65e59ba5e0))
* **cli:** pass BrokerConfig observability from broker.config.ts to both runtimes ([#542](https://github.com/package-broker/broker/issues/542)) ([e1a971d](https://github.com/package-broker/broker/commit/e1a971d7c6ad7a539341077e6188a4f44f2437b9))
* **cli:** pb cloudflare deploy with artifact checks, guarded endpoints and journaled recovery ([#712](https://github.com/package-broker/broker/issues/712)) ([35a6635](https://github.com/package-broker/broker/commit/35a66355daa9121197fcaafaddb8ed7f0036a2a2))
* **cli:** pb cloudflare provision with ownership and durable inventory ([#613](https://github.com/package-broker/broker/issues/613)) ([4b2fc04](https://github.com/package-broker/broker/commit/4b2fc043837ce025de7a971ae3d0b5ebb97de07d))
* **cli:** pb cloudflare setup with resumable install and browser setup URL ([#746](https://github.com/package-broker/broker/issues/746)) ([f7ba99d](https://github.com/package-broker/broker/commit/f7ba99d99d40f97759edb065215d728558f90851))
* **cli:** pb cloudflare smoke with bounded checks and guarded rollback ([#719](https://github.com/package-broker/broker/issues/719)) ([067c033](https://github.com/package-broker/broker/commit/067c033662c80e47a7b63673f435958602618697))
* **cli:** pb cloudflare teardown and janitor delete only inventoried resources ([#770](https://github.com/package-broker/broker/issues/770)) ([1a79ab4](https://github.com/package-broker/broker/commit/1a79ab480509ccf76a9c142b0af5fb442e73a953))
* **cli:** pb import satis plan compiles satis.json into a validated import manifest ([#660](https://github.com/package-broker/broker/issues/660)) ([6c84605](https://github.com/package-broker/broker/commit/6c84605310fc99a441d95ff249988119b9117083))
* **cli:** real Cloudflare provider and deploy contracts ([#807](https://github.com/package-broker/broker/issues/807)) ([f10dfb2](https://github.com/package-broker/broker/commit/f10dfb20d098eb308052fd0f3451d87f425bf541))
* **cli:** record the git commit and dirty state in build info and test deploys against observed Cloudflare shapes ([#844](https://github.com/package-broker/broker/issues/844)) ([73a9acd](https://github.com/package-broker/broker/commit/73a9acdb4c76e0c6ef0c77b729f591fba84b1aa7))
* **cli:** stage configured UI assets beside both build targets ([#648](https://github.com/package-broker/broker/issues/648)) ([1c4cae5](https://github.com/package-broker/broker/commit/1c4cae523b088b47c5f9824112bf4cb77ef2aa38))
* **core:** audited one-shot acceptance of a refused source removal ([#769](https://github.com/package-broker/broker/issues/769)) ([f45ad6f](https://github.com/package-broker/broker/commit/f45ad6ffe0cbbb63992aae8e8480b9b10be7f121))
* **core:** management API wave b: package manage and import routes with the token fence ([#780](https://github.com/package-broker/broker/issues/780)) ([11e6e05](https://github.com/package-broker/broker/commit/11e6e05fa6dbf4fcce99f1ec5322c47798cd6853))
* **core:** vulnerability status in the API and job wiring on Node and Workers ([#779](https://github.com/package-broker/broker/issues/779)) ([89a54fc](https://github.com/package-broker/broker/commit/89a54fc78a8a6d0e4e5154969389de66090cc8a9))
* **db-sqlite:** composite (org_id, id) foreign keys in migrations 0020 and 0021 ([#681](https://github.com/package-broker/broker/issues/681)) ([4e49ba7](https://github.com/package-broker/broker/commit/4e49ba7e33cb0b3e2a728ebbfb09c25b9e6a0901))
* **db:** keep package ecosystem equal to its source's ecosystem ([#818](https://github.com/package-broker/broker/issues/818)) ([89a1929](https://github.com/package-broker/broker/commit/89a1929c22bc7e31e9b4d2800482e4033842fa7e))
* Docker smoke command and migration log wiring on the Node entry ([#715](https://github.com/package-broker/broker/issues/715)) ([c65e77b](https://github.com/package-broker/broker/commit/c65e77bc3b12548172773a23f3fe589f8554b5a2))
* engine wiring prerequisites: token revoke adapters, provider-anchor reader, request-bound background work ([#437](https://github.com/package-broker/broker/issues/437)) ([39f71ba](https://github.com/package-broker/broker/commit/39f71ba13b78be8e25fa3df4e459d7ae0a6b7221))
* Platform ports surface: error location, shape test, manifest type, b ([#348](https://github.com/package-broker/broker/issues/348)) ([b79e532](https://github.com/package-broker/broker/commit/b79e53299f91c9a0a354dd823fb319af2432e466))
* Route `api` slot (Zod types) and exemptions ([#400](https://github.com/package-broker/broker/issues/400)) ([6d3e9e4](https://github.com/package-broker/broker/commit/6d3e9e454f46f2cae1901146087ffe712368fb41))
* **runtime-cloudflare:** wire the registry, codecs and guarded fetch into the Worker ([#654](https://github.com/package-broker/broker/issues/654)) ([5746d00](https://github.com/package-broker/broker/commit/5746d00238175bd9b1772f178ec65b2f2fe5659d))
* **runtime-node:** Node entry: platformPorts manifest export, process handlers, sanitized startup failure ([#443](https://github.com/package-broker/broker/issues/443)) ([bf2634e](https://github.com/package-broker/broker/commit/bf2634edfef86b7d41458f1b6f86e5b478369c9a))
* **runtime-node:** wire the registry, codecs and guarded fetch into the Node runtime ([#641](https://github.com/package-broker/broker/issues/641)) ([9c3f238](https://github.com/package-broker/broker/commit/9c3f238980324fb7bffa3c553b6d7c19e24e5d99))
* **runtime:** compose organization Administration and carry config.tokens through the manifest ([#693](https://github.com/package-broker/broker/issues/693)) ([093998e](https://github.com/package-broker/broker/commit/093998e723c6ce591574490783acdd19cb6c5323))
* **runtime:** mount /_pb/mcp when enabled; check the rate-limit binding at startup ([#802](https://github.com/package-broker/broker/issues/802)) ([79860d6](https://github.com/package-broker/broker/commit/79860d682570de674f3a2fae3f9ce598c24b7306))
* **runtime:** serve /_pb/openapi.json and complete the API document ([#790](https://github.com/package-broker/broker/issues/790)) ([ec277e2](https://github.com/package-broker/broker/commit/ec277e2baf6226aa7e26be126fa30f39e7258a30))
* **ui:** browser first-admin setup with a local QR and automated Playwright end to end ([#718](https://github.com/package-broker/broker/issues/718)) ([8fcda6e](https://github.com/package-broker/broker/commit/8fcda6ed00991b21ee544f410893d0750f9a05f1))
* **ui:** committed openapi.json and generated UI types with a drift check ([#765](https://github.com/package-broker/broker/issues/765)) ([ab87962](https://github.com/package-broker/broker/commit/ab879625da660e2eca35e6a35968b6d9a050d856))
* **ui:** sources page with write-only credentials and ordering ([#800](https://github.com/package-broker/broker/issues/800)) ([7b9718c](https://github.com/package-broker/broker/commit/7b9718cc5fdcb5335fca530657d1ec76643c0474))


### Bug Fixes

* **cli:** look up Worker versions by name when the scripts listing has no worker_id ([#842](https://github.com/package-broker/broker/issues/842)) ([cac7652](https://github.com/package-broker/broker/commit/cac76528ad6c3fa04d2ea06d7ce6fd4aec2b7bb9))
* **cli:** pb cloudflare provision hardening ([#632](https://github.com/package-broker/broker/issues/632)) ([f3edd17](https://github.com/package-broker/broker/commit/f3edd175e31c141d131683916687b04faa85fbf0))
* **cli:** setup refuses deploy-time failures before provisioning ([#823](https://github.com/package-broker/broker/issues/823)) ([fe5ed0f](https://github.com/package-broker/broker/commit/fe5ed0f4b1c7cf08b6ab2d5b584b860baa9938ad))
* **cli:** teardown hardening: ownership tags, entry points disabled before the R2 drain, historical public-URL receipts ([#777](https://github.com/package-broker/broker/issues/777)) ([92976fd](https://github.com/package-broker/broker/commit/92976fd34948b169fc241c2c8eccd05dfae76e87))
* **core:** D1 batches never exceed 200 statements ([#767](https://github.com/package-broker/broker/issues/767)) ([90cd307](https://github.com/package-broker/broker/commit/90cd307d702bbd790f4b0e73cd70574f71bfd9d7))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @package-broker/core bumped to 2.0.0-rc.1
    * @package-broker/db-sqlite bumped to 2.0.0-rc.1
    * @package-broker/runtime-cloudflare bumped to 2.0.0-rc.1
    * @package-broker/runtime-node bumped to 2.0.0-rc.1
