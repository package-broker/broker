# Changelog

## [0.1.0-rc.1](https://github.com/package-broker/broker/compare/plugin-sso-oidc-v0.1.0-rc.0...plugin-sso-oidc-v0.1.0-rc.1) (2026-10-24)


### Features

* **audit:** record SSO login in the session batch ([#827](https://github.com/package-broker/broker/issues/827)) ([1dd04e5](https://github.com/package-broker/broker/commit/1dd04e5a8e9f5a33b45b3f9c8b629b4f22d87cd6))
* **core:** identity finish failures carry a closed-list detail code ([#752](https://github.com/package-broker/broker/issues/752)) ([afbf15f](https://github.com/package-broker/broker/commit/afbf15ff8a292ef866df079559688bb7b9997dee))
* **plugin-sso-oidc:** groups claim mapping with a synthetic fixture ([#725](https://github.com/package-broker/broker/issues/725)) ([9a1bf63](https://github.com/package-broker/broker/commit/9a1bf6313f893e505fea4b5ae3fc5dd3833efdc7))
* **sso-oidc:** accept email-authoritative domains for OIDC and Access ([#819](https://github.com/package-broker/broker/issues/819)) ([e439970](https://github.com/package-broker/broker/commit/e439970ffae924a2e6706c98743d26862f276444))


### Bug Fixes

* **sso-oidc:** refuse an issuer host with uppercase letters ([#810](https://github.com/package-broker/broker/issues/810)) ([9fb58d1](https://github.com/package-broker/broker/commit/9fb58d128a2e8166cdac54a7de7b4cbc992b531c))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
