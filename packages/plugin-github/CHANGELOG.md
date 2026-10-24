# Changelog

## [0.1.0-rc.1](https://github.com/package-broker/broker/compare/plugin-github-v0.1.0-rc.0...plugin-github-v0.1.0-rc.1) (2026-10-24)


### Features

* **plugin-github:** GitHub webhook signature verifier ([#671](https://github.com/package-broker/broker/issues/671)) ([5dceeb3](https://github.com/package-broker/broker/commit/5dceeb32d61a9ff8b89c8ead76fc69586a5eb692))
* **plugin-github:** per-repository discovery plan ([#509](https://github.com/package-broker/broker/issues/509)) ([2ae84dd](https://github.com/package-broker/broker/commit/2ae84dd2017565413137c7307e0bb8cc2dc96bf8))
* **plugin-github:** wire the GitHub provider, App discovery and webhook verifier via SourceProviderContext ([#724](https://github.com/package-broker/broker/issues/724)) ([1a758df](https://github.com/package-broker/broker/commit/1a758df761df737cc967039d2ef0254c84375574))
* **sources:** GitHub sources with a personal access token ([#822](https://github.com/package-broker/broker/issues/822)) ([ffaa78b](https://github.com/package-broker/broker/commit/ffaa78bc9a0eba5d734a242caf0b9dfc3ecdb10a))


### Bug Fixes

* **core:** narrowing a source selection never removes packages ([#771](https://github.com/package-broker/broker/issues/771)) ([ba1fc77](https://github.com/package-broker/broker/commit/ba1fc77d8561210d6eec594b4001b8b61e0637c4))
* package-sync lease hold-back on finalize ([#727](https://github.com/package-broker/broker/issues/727)) ([142c79f](https://github.com/package-broker/broker/commit/142c79fbeb14ca84bf4fb86099f2e7fd6e95edc4))
* **plugin-github:** harden token sources after review ([#836](https://github.com/package-broker/broker/issues/836)) ([c903d15](https://github.com/package-broker/broker/commit/c903d15f99b84753cbc48af8bbebe8732acb7dd1))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
