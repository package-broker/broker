# Changelog

## [0.1.0-rc.4](https://github.com/package-broker/broker/compare/plugin-github-v0.1.0-rc.3...plugin-github-v0.1.0-rc.4) (2026-10-31)


### Features

* **core:** contracts for npm publishing, approvals and identity ([#991](https://github.com/package-broker/broker/issues/991)) ([74e716b](https://github.com/package-broker/broker/commit/74e716b67e7bc615aba602b9545cb7b800d6d5be))
* **sources:** build npm packages from GitHub and Git repository tags ([#1015](https://github.com/package-broker/broker/issues/1015)) ([403f684](https://github.com/package-broker/broker/commit/403f68463ff041faab588a295f2ef4e9f2fd5eed))
* **sources:** npm packages from GitHub repositories with claim admission ([#1013](https://github.com/package-broker/broker/issues/1013)) ([a712143](https://github.com/package-broker/broker/commit/a7121436e0ef57595561a7fd31192cba28f0ef88))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.4
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.4

## [0.1.0-rc.3](https://github.com/package-broker/broker/compare/plugin-github-v0.1.0-rc.2...plugin-github-v0.1.0-rc.3) (2026-10-28)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.3
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.3

## [0.1.0-rc.2](https://github.com/package-broker/broker/compare/plugin-github-v0.1.0-rc.1...plugin-github-v0.1.0-rc.2) (2026-10-28)


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.2
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.2

## [0.1.0-rc.1](https://github.com/package-broker/broker/compare/plugin-github-v0.1.0-rc.0...plugin-github-v0.1.0-rc.1) (2026-10-27)


### Features

* **core:** sync generations with package counts and child error codes ([#883](https://github.com/package-broker/broker/issues/883)) ([3390cd3](https://github.com/package-broker/broker/commit/3390cd371ff62330ebf2366f8ababef8efe32878))
* **plugin-github:** GitHub webhook signature verifier ([#671](https://github.com/package-broker/broker/issues/671)) ([5dceeb3](https://github.com/package-broker/broker/commit/5dceeb32d61a9ff8b89c8ead76fc69586a5eb692))
* **plugin-github:** per-repository discovery plan ([#509](https://github.com/package-broker/broker/issues/509)) ([2ae84dd](https://github.com/package-broker/broker/commit/2ae84dd2017565413137c7307e0bb8cc2dc96bf8))
* **plugin-github:** wire the GitHub provider, App discovery and webhook verifier via SourceProviderContext ([#724](https://github.com/package-broker/broker/issues/724)) ([1a758df](https://github.com/package-broker/broker/commit/1a758df761df737cc967039d2ef0254c84375574))
* **sources:** GitHub sources with a personal access token ([#822](https://github.com/package-broker/broker/issues/822)) ([ffaa78b](https://github.com/package-broker/broker/commit/ffaa78bc9a0eba5d734a242caf0b9dfc3ecdb10a))


### Bug Fixes

* **core:** narrowing a source selection never removes packages ([#771](https://github.com/package-broker/broker/issues/771)) ([ba1fc77](https://github.com/package-broker/broker/commit/ba1fc77d8561210d6eec594b4001b8b61e0637c4))
* package-sync lease hold-back on finalize ([#727](https://github.com/package-broker/broker/issues/727)) ([142c79f](https://github.com/package-broker/broker/commit/142c79fbeb14ca84bf4fb86099f2e7fd6e95edc4))
* **plugin-github:** bound token-source describes by manifest bytes and requests ([#858](https://github.com/package-broker/broker/issues/858)) ([4ca134a](https://github.com/package-broker/broker/commit/4ca134a807c3ad7fe5cb916e535411f42e0bdf95))
* **plugin-github:** harden token sources after review ([#836](https://github.com/package-broker/broker/issues/836)) ([c903d15](https://github.com/package-broker/broker/commit/c903d15f99b84753cbc48af8bbebe8732acb7dd1))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
