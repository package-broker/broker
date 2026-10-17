# Changelog

## [1.0.0-rc.0](https://github.com/package-broker/broker/compare/plugin-sso-oidc-v0.1.0-rc.0...plugin-sso-oidc-v1.0.0-rc.0) (2026-10-17)


### ⚠ BREAKING CHANGES

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
