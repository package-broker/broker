# Changelog

## [1.0.0-rc.0](https://github.com/package-broker/broker/compare/plugin-github-v0.1.0-rc.0...plugin-github-v1.0.0-rc.0) (2026-10-17)


### ⚠ BREAKING CHANGES

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
