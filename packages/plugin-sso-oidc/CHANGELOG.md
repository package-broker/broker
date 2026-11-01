# Changelog

## [0.1.0-rc.4](https://github.com/package-broker/broker/compare/plugin-sso-oidc-v0.1.0-rc.3...plugin-sso-oidc-v0.1.0-rc.4) (2026-11-01)


### Features

* **auth:** deployment setting to disable local sign-in ([#998](https://github.com/package-broker/broker/issues/998)) ([2987e3d](https://github.com/package-broker/broker/commit/2987e3d9a25f6e4125bef0d741789f5237047c46))
* **auth:** hide SSO confirmation when the provider cannot prove a fresh sign-in ([#987](https://github.com/package-broker/broker/issues/987)) ([1f1ccca](https://github.com/package-broker/broker/commit/1f1cccaa65fcecea157010d606aacde91976f429)), closes [#964](https://github.com/package-broker/broker/issues/964)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.4
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.4

## [0.1.0-rc.3](https://github.com/package-broker/broker/compare/plugin-sso-oidc-v0.1.0-rc.2...plugin-sso-oidc-v0.1.0-rc.3) (2026-10-28)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.3
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.3

## [0.1.0-rc.2](https://github.com/package-broker/broker/compare/plugin-sso-oidc-v0.1.0-rc.1...plugin-sso-oidc-v0.1.0-rc.2) (2026-10-28)


### Features

* **cli:** deploy SSO providers at runtime for the prebuilt distribution ([#936](https://github.com/package-broker/broker/issues/936)) ([4fb21c3](https://github.com/package-broker/broker/commit/4fb21c351f106e16f91afaf334772f673f760544))


### Bug Fixes

* operator messages without internal ids and with the real migration lock expiry ([#938](https://github.com/package-broker/broker/issues/938)) ([a015d46](https://github.com/package-broker/broker/commit/a015d465dd9d4b671c89b208de6e82e32b76dd91))
* read SSO providers at runtime and check the trust anchor before contacting the IdP ([#926](https://github.com/package-broker/broker/issues/926)) ([ee91a10](https://github.com/package-broker/broker/commit/ee91a1073b4af36c9429c75720676b5fc72d0f93)), closes [#918](https://github.com/package-broker/broker/issues/918)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.2
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.2

## [0.1.0-rc.1](https://github.com/package-broker/broker/compare/plugin-sso-oidc-v0.1.0-rc.0...plugin-sso-oidc-v0.1.0-rc.1) (2026-10-27)


### Features

* **audit:** record SSO login in the session batch ([#827](https://github.com/package-broker/broker/issues/827)) ([1dd04e5](https://github.com/package-broker/broker/commit/1dd04e5a8e9f5a33b45b3f9c8b629b4f22d87cd6))
* **core:** identity finish failures carry a closed-list detail code ([#752](https://github.com/package-broker/broker/issues/752)) ([afbf15f](https://github.com/package-broker/broker/commit/afbf15ff8a292ef866df079559688bb7b9997dee))
* **plugin-sso-oidc:** groups claim mapping with a synthetic fixture ([#725](https://github.com/package-broker/broker/issues/725)) ([9a1bf63](https://github.com/package-broker/broker/commit/9a1bf6313f893e505fea4b5ae3fc5dd3833efdc7))
* **sso-oidc:** accept email-authoritative domains for OIDC and Access ([#819](https://github.com/package-broker/broker/issues/819)) ([e439970](https://github.com/package-broker/broker/commit/e439970ffae924a2e6706c98743d26862f276444))


### Bug Fixes

* **core:** require an MCP limiter on Node and split non-touching session authentication ([#859](https://github.com/package-broker/broker/issues/859)) ([f14a75f](https://github.com/package-broker/broker/commit/f14a75fb9d001b77507f91d7f55840e17591a905))
* **sso-oidc:** refuse an issuer host with uppercase letters ([#810](https://github.com/package-broker/broker/issues/810)) ([9fb58d1](https://github.com/package-broker/broker/commit/9fb58d128a2e8166cdac54a7de7b4cbc992b531c))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
