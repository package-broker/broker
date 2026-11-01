# Changelog

## [2.0.0-rc.4](https://github.com/package-broker/broker/compare/ui-v2.0.0-rc.3...ui-v2.0.0-rc.4) (2026-11-01)


### Features

* **api:** package access requests with expiry ([#1003](https://github.com/package-broker/broker/issues/1003)) ([480b6c3](https://github.com/package-broker/broker/commit/480b6c3c2c34f298552b0ba091ab2cfe754306f3))
* **api:** package README, new-project access setting and version details ([#1014](https://github.com/package-broker/broker/issues/1014)) ([2bb6c30](https://github.com/package-broker/broker/commit/2bb6c305dd8df8988853a2b25d2c74659d54b2fb))
* **api:** publish approval setting for hosted npm sources ([#1029](https://github.com/package-broker/broker/issues/1029)) ([7aae24f](https://github.com/package-broker/broker/commit/7aae24fd06e9d4d6f77ebcfe1cdf8dd5bc6d072b))
* **auth:** deployment setting to disable local sign-in ([#998](https://github.com/package-broker/broker/issues/998)) ([2987e3d](https://github.com/package-broker/broker/commit/2987e3d9a25f6e4125bef0d741789f5237047c46))
* **auth:** hide SSO confirmation when the provider cannot prove a fresh sign-in ([#987](https://github.com/package-broker/broker/issues/987)) ([1f1ccca](https://github.com/package-broker/broker/commit/1f1cccaa65fcecea157010d606aacde91976f429)), closes [#964](https://github.com/package-broker/broker/issues/964)
* **core:** contracts for npm publishing, approvals and identity ([#991](https://github.com/package-broker/broker/issues/991)) ([74e716b](https://github.com/package-broker/broker/commit/74e716b67e7bc615aba602b9545cb7b800d6d5be))
* **registry:** npm publishing with scan gate, trusted publishing and integration gate ([#1022](https://github.com/package-broker/broker/issues/1022)) ([cbd6e80](https://github.com/package-broker/broker/commit/cbd6e80418b26b01f27d61252437967d1067ead7))
* **registry:** npm unpublish, deprecate and dist-tag writes for hosted packages ([#1038](https://github.com/package-broker/broker/issues/1038)) ([d60e6db](https://github.com/package-broker/broker/commit/d60e6db21fecba89c09b6437c1070207366b0e18))
* **registry:** npm web login with browser approval ([#1012](https://github.com/package-broker/broker/issues/1012)) ([f39fa8e](https://github.com/package-broker/broker/commit/f39fa8e2ac7673a4685de1b4e0aa308cb0b2d71a))
* **sources:** build npm packages from GitHub and Git repository tags ([#1015](https://github.com/package-broker/broker/issues/1015)) ([403f684](https://github.com/package-broker/broker/commit/403f68463ff041faab588a295f2ef4e9f2fd5eed))
* **sources:** hosted claims follow-ups and copy before publishing ([#1006](https://github.com/package-broker/broker/issues/1006)) ([c72ca04](https://github.com/package-broker/broker/commit/c72ca04d047143465a9f74bc8bc435c7c47b1143))
* **sources:** hosted npm sources with claim admission ([#997](https://github.com/package-broker/broker/issues/997)) ([6af51fb](https://github.com/package-broker/broker/commit/6af51fb3c53de6a0b0c76dfabe35a622581589d8))
* **sources:** npm packages from GitHub repositories with claim admission ([#1013](https://github.com/package-broker/broker/issues/1013)) ([a712143](https://github.com/package-broker/broker/commit/a7121436e0ef57595561a7fd31192cba28f0ef88))
* **ui:** pending publishes, access requests and package detail page ([#1018](https://github.com/package-broker/broker/issues/1018)) ([8a55f55](https://github.com/package-broker/broker/commit/8a55f55a5d868c82ef765dc95b38924f110e161b))


### Bug Fixes

* **core:** scoped package detail reads and settings revisions ([#1037](https://github.com/package-broker/broker/issues/1037)) ([46b85d4](https://github.com/package-broker/broker/commit/46b85d48ba6d252d05adbe3e53c451f6a8ea6261))
* **core:** trusted publisher audit, paging and shared constants ([#1027](https://github.com/package-broker/broker/issues/1027)) ([0fd7f0c](https://github.com/package-broker/broker/commit/0fd7f0ce9961b2906844caf158b5a76caea9a916))
* **ui:** actionable scan holds with rescan and audited disposal ([#1028](https://github.com/package-broker/broker/issues/1028)) ([60832bf](https://github.com/package-broker/broker/commit/60832bfb87092d3f5e07e254b4b811bc5030d572))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.4
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.4

## [2.0.0-rc.3](https://github.com/package-broker/broker/compare/ui-v2.0.0-rc.2...ui-v2.0.0-rc.3) (2026-10-28)


### Features

* **core:** grant lists show subjects to grant readers ([#954](https://github.com/package-broker/broker/issues/954)) ([eabb6fa](https://github.com/package-broker/broker/commit/eabb6facf4a463cf018d0802deb8b9187857f94b))
* **ui:** add packages and sync from a source on the Packages page ([#958](https://github.com/package-broker/broker/issues/958)) ([cadb091](https://github.com/package-broker/broker/commit/cadb091f624bbed275c0c253595bd9db088c4a3c))
* **ui:** guided token issuance and service identities on the Tokens page ([#959](https://github.com/package-broker/broker/issues/959)) ([0c33030](https://github.com/package-broker/broker/commit/0c33030c91abf4f4908494fe81ac1b1bb2affa26))
* **ui:** load admin pages on demand ([#960](https://github.com/package-broker/broker/issues/960)) ([cf0d187](https://github.com/package-broker/broker/commit/cf0d1877f43fc5661f3c143173a34748e726dcd6))
* **ui:** new grant form a first-time admin can fill ([#952](https://github.com/package-broker/broker/issues/952)) ([599a4ae](https://github.com/package-broker/broker/commit/599a4ae3a32a1918a6b8aafbf0e1d795caee8c94))
* **ui:** new project form that explains the access policy ([#948](https://github.com/package-broker/broker/issues/948)) ([b426d4a](https://github.com/package-broker/broker/commit/b426d4a4b9faa2325f8c54969294cb62af58fe13))
* **ui:** product footer on admin pages and sign-in screens ([#963](https://github.com/package-broker/broker/issues/963)) ([05f52e1](https://github.com/package-broker/broker/commit/05f52e1f7b16e9fc7f339ba49d2800c1ba4af089))
* **ui:** separate Audit and Import from everyday navigation ([#955](https://github.com/package-broker/broker/issues/955)) ([4dc1dc7](https://github.com/package-broker/broker/commit/4dc1dc7af99b9d2b71f46b9605bac37c1ea3a103))
* **ui:** two-column project forms on wide screens ([#953](https://github.com/package-broker/broker/issues/953)) ([df688f5](https://github.com/package-broker/broker/commit/df688f5c46ec07fcc325d0289c392ff908ebefa6))


### Bug Fixes

* **ui:** generic example names in form placeholders and UI tests ([#962](https://github.com/package-broker/broker/issues/962)) ([c65ed5b](https://github.com/package-broker/broker/commit/c65ed5b90b99da8621f478509298a023f6e80ebe))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.3
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.3

## [2.0.0-rc.2](https://github.com/package-broker/broker/compare/ui-v2.0.0-rc.1...ui-v2.0.0-rc.2) (2026-10-28)


### Bug Fixes

* **ui:** recognise the source error codes in the API client ([#935](https://github.com/package-broker/broker/issues/935)) ([81db48b](https://github.com/package-broker/broker/commit/81db48b5b4aa431131696f9d049daaacef6a6e3f))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.2
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.2

## [2.0.0-rc.1](https://github.com/package-broker/broker/compare/ui-v2.0.0-rc.0...ui-v2.0.0-rc.1) (2026-10-27)


### Features

* **core:** attach and detach a source to a project ([#774](https://github.com/package-broker/broker/issues/774)) ([bd042b2](https://github.com/package-broker/broker/commit/bd042b26d72e8a2c9b5e451c4a0ff11688a2612e))
* **core:** create, list and read service principals over HTTP ([#788](https://github.com/package-broker/broker/issues/788)) ([4788669](https://github.com/package-broker/broker/commit/4788669dedac1a5128a0a978b48733ac6ddf11e2))
* **core:** idempotent import run creation with credential window and binding status ([#841](https://github.com/package-broker/broker/issues/841)) ([855a7ce](https://github.com/package-broker/broker/commit/855a7ce7eb2ca5d159df5b7bcf98eb6180e4f9ad))
* **core:** management API wave b: package manage and import routes with the token fence ([#780](https://github.com/package-broker/broker/issues/780)) ([11e6e05](https://github.com/package-broker/broker/commit/11e6e05fa6dbf4fcce99f1ec5322c47798cd6853))
* **core:** organization source list can include project-owned sources ([#856](https://github.com/package-broker/broker/issues/856)) ([f7bdd5b](https://github.com/package-broker/broker/commit/f7bdd5b6a30da716d84dbb156d30eefaf3dc048f))
* **core:** organization source list carries an attached-project count ([#799](https://github.com/package-broker/broker/issues/799)) ([03fd0a2](https://github.com/package-broker/broker/commit/03fd0a294cdb11f4d5914e07a11b9084b25843b1))
* **core:** project grants list and source attachment and precedence for the UI ([#791](https://github.com/package-broker/broker/issues/791)) ([7873621](https://github.com/package-broker/broker/commit/787362114847001464624aaaabe42818fbad911f))
* **core:** projects list prefix filter and per-item ETags for restore ([#798](https://github.com/package-broker/broker/issues/798)) ([a45bea3](https://github.com/package-broker/broker/commit/a45bea3a0fc2f699b3948a032c2de1aad2814752))
* **core:** request a package on a proxy source before the first install ([#904](https://github.com/package-broker/broker/issues/904)) ([9ce2457](https://github.com/package-broker/broker/commit/9ce24575d45802ef098e3c2bac02137558bc5eb2))
* **core:** sync generations with package counts and child error codes ([#883](https://github.com/package-broker/broker/issues/883)) ([3390cd3](https://github.com/package-broker/broker/commit/3390cd371ff62330ebf2366f8ababef8efe32878))
* **core:** vulnerability status in the API and job wiring on Node and Workers ([#779](https://github.com/package-broker/broker/issues/779)) ([89a54fc](https://github.com/package-broker/broker/commit/89a54fc78a8a6d0e4e5154969389de66090cc8a9))
* **runtime-node:** generic Git sources on Node and source forms that offer only served providers ([#849](https://github.com/package-broker/broker/issues/849)) ([30bf3eb](https://github.com/package-broker/broker/commit/30bf3eb09c1c9e87bb970b28faa1c43b0dd9ef30))
* **runtime-node:** offer SSH sources on Node now that SSH archives are served ([#884](https://github.com/package-broker/broker/issues/884)) ([1700b48](https://github.com/package-broker/broker/commit/1700b48b5ad6a633d87b17d4dfefcf1b57b43018))
* **runtime:** serve /_pb/openapi.json and complete the API document ([#790](https://github.com/package-broker/broker/issues/790)) ([ec277e2](https://github.com/package-broker/broker/commit/ec277e2baf6226aa7e26be126fa30f39e7258a30))
* **sources:** GitHub sources with a personal access token ([#822](https://github.com/package-broker/broker/issues/822)) ([ffaa78b](https://github.com/package-broker/broker/commit/ffaa78bc9a0eba5d734a242caf0b9dfc3ecdb10a))
* **sources:** sync now, immediate poll on enable, sync outcome in the source DTO ([#826](https://github.com/package-broker/broker/issues/826)) ([9dcaf07](https://github.com/package-broker/broker/commit/9dcaf071593524d4c467a2bb52ed2576bd5695a0))
* UI pending-action store for reauth replay ([#563](https://github.com/package-broker/broker/issues/563)) ([4f99bee](https://github.com/package-broker/broker/commit/4f99beeaf27649ed40172fbe467e7a20399814c1))
* **ui:** add, edit, attach and detach sources ([#808](https://github.com/package-broker/broker/issues/808)) ([a3b30be](https://github.com/package-broker/broker/commit/a3b30be85bbbea4122e9a3f70cac727d0f139674))
* **ui:** admin shell with login, setup, reauth and scope switcher ([#781](https://github.com/package-broker/broker/issues/781)) ([5e7f06e](https://github.com/package-broker/broker/commit/5e7f06ed87a76aee44a773d9a8a2ca6a3f4d6ab2))
* **ui:** API client and types generated from openapi.json ([#551](https://github.com/package-broker/broker/issues/551)) ([b905b30](https://github.com/package-broker/broker/commit/b905b30562243be03a7599ef3657da2e87711f0c))
* **ui:** apply the readability components to projects, access, sources and tokens ([#803](https://github.com/package-broker/broker/issues/803)) ([09d184d](https://github.com/package-broker/broker/commit/09d184d3d1c9b1ea3555104047e5156717cd67f8))
* **ui:** asset provider bridge between core and ui builds ([#603](https://github.com/package-broker/broker/issues/603)) ([cb1adf0](https://github.com/package-broker/broker/commit/cb1adf05c93c1f2627bb30cc0c64788977aefa43))
* **ui:** audit and import pages ([#787](https://github.com/package-broker/broker/issues/787)) ([2097bfe](https://github.com/package-broker/broker/commit/2097bfe3a35f564e1bef01fb90f1d15122ecdef7))
* **ui:** browser first-admin setup with a local QR and automated Playwright end to end ([#718](https://github.com/package-broker/broker/issues/718)) ([8fcda6e](https://github.com/package-broker/broker/commit/8fcda6ed00991b21ee544f410893d0750f9a05f1))
* **ui:** client returns ETag and Location; reauth keeps page filters ([#785](https://github.com/package-broker/broker/issues/785)) ([7470b28](https://github.com/package-broker/broker/commit/7470b288b3a27258ad654581fec825ffd672c15c))
* **ui:** committed openapi.json and generated UI types with a drift check ([#765](https://github.com/package-broker/broker/issues/765)) ([ab87962](https://github.com/package-broker/broker/commit/ab879625da660e2eca35e6a35968b6d9a050d856))
* **ui:** enable project-owned sources from the project view ([#845](https://github.com/package-broker/broker/issues/845)) ([d7f047f](https://github.com/package-broker/broker/commit/d7f047f0f607794355a1adf1f2fb6f065b47d510))
* **ui:** packages page with versions and manage actions ([#792](https://github.com/package-broker/broker/issues/792)) ([c81eaaf](https://github.com/package-broker/broker/commit/c81eaafe600a9c5eef1d3ebba3a6c90a3656ad7c))
* **ui:** projects and access pages ([#797](https://github.com/package-broker/broker/issues/797)) ([fff3f19](https://github.com/package-broker/broker/commit/fff3f1955332e2c2edee3d3f010cd04b5564cc7e))
* **ui:** readable source configuration and a prefilled edit form ([#879](https://github.com/package-broker/broker/issues/879)) ([e5960a9](https://github.com/package-broker/broker/commit/e5960a9e08e667967f5180cc59070e7cc4e339ed))
* **ui:** readable, responsive tables, status badges and confirmations ([#801](https://github.com/package-broker/broker/issues/801)) ([2b284a2](https://github.com/package-broker/broker/commit/2b284a2fccd97725a38e1aa5d289cb42a02cdfa8))
* **ui:** RowActions owns the size of row buttons ([#908](https://github.com/package-broker/broker/issues/908)) ([8fce167](https://github.com/package-broker/broker/commit/8fce1677933fe92796b2e9d2c96f24842c5555ef))
* **ui:** show advisory status per package version ([#811](https://github.com/package-broker/broker/issues/811)) ([2603b30](https://github.com/package-broker/broker/commit/2603b3072a7206850a8dccd9f0982a8d16799a44))
* **ui:** show Composer and npm configuration with a new token ([#813](https://github.com/package-broker/broker/issues/813)) ([a61e757](https://github.com/package-broker/broker/commit/a61e757023774ea6ed69cce9ecc74a805ccfcd49))
* **ui:** simpler source form with radio choices, advanced settings and a full-screen mobile dialog ([#843](https://github.com/package-broker/broker/issues/843)) ([9b60b50](https://github.com/package-broker/broker/commit/9b60b5068e5f0606c351bf37afb630ff19cf7c34))
* **ui:** source row actions in a menu with dialogs instead of an inline edit card ([#847](https://github.com/package-broker/broker/issues/847)) ([99afa91](https://github.com/package-broker/broker/commit/99afa914904fe3ee69ada4352c7767e1f1e9bae9))
* **ui:** sources page with write-only credentials and ordering ([#800](https://github.com/package-broker/broker/issues/800)) ([7b9718c](https://github.com/package-broker/broker/commit/7b9718cc5fdcb5335fca530657d1ec76643c0474))
* **ui:** Sources row actions, credentials per source type and Add package ([#911](https://github.com/package-broker/broker/issues/911)) ([fc778fa](https://github.com/package-broker/broker/commit/fc778fa960da5937cf3c083b838c00297751c65a))
* **ui:** sync now and sync status on the Sources page ([#833](https://github.com/package-broker/broker/issues/833)) ([52ee73b](https://github.com/package-broker/broker/commit/52ee73b85053cb91fb163e01e1bd1ed59d29fcf5))
* **ui:** sync status that matches listing and demand-fill behaviour ([#862](https://github.com/package-broker/broker/issues/862)) ([ffd65c3](https://github.com/package-broker/broker/commit/ffd65c38dda103b517784fe9309bf16f7fa86bec))
* **ui:** tokens and service principals page with show-once secrets ([#794](https://github.com/package-broker/broker/issues/794)) ([fe40a55](https://github.com/package-broker/broker/commit/fe40a55d4677bf64c44f5f89f8bb6370e0c972ad))


### Bug Fixes

* **cli:** keep the OpenAPI document version at the API major ([#916](https://github.com/package-broker/broker/issues/916)) ([a37ff6a](https://github.com/package-broker/broker/commit/a37ff6af1244c0658f75c316eaee1406bc890814))
* **core:** allow enabling the Packagist GitHub token mode through the API ([#831](https://github.com/package-broker/broker/issues/831)) ([6a7ecd8](https://github.com/package-broker/broker/commit/6a7ecd8f06c0685ef09f72b31a60b9eb5783f749))
* **core:** refused upstream answers 502 upstream_refused; refusal log at debug only ([#796](https://github.com/package-broker/broker/issues/796)) ([5bd73b1](https://github.com/package-broker/broker/commit/5bd73b13197e92f05c5b32457b6017fcc944a03b))
* **plugin-github:** harden token sources after review ([#836](https://github.com/package-broker/broker/issues/836)) ([c903d15](https://github.com/package-broker/broker/commit/c903d15f99b84753cbc48af8bbebe8732acb7dd1))
* **ui:** Escape inside a menu never becomes a dialog close request; focus falls back when the opener stays disabled ([#875](https://github.com/package-broker/broker/issues/875)) ([511f51c](https://github.com/package-broker/broker/commit/511f51c2776b3ab4a1d5259955e946a4ab0a10ff))
* **ui:** projects page keeps a valid selection and lists active projects for members ([#817](https://github.com/package-broker/broker/issues/817)) ([253d521](https://github.com/package-broker/broker/commit/253d5219ddaecba7708375ef8f9cbb07d4d0c9de))
* **ui:** row menus render outside the table frame ([#905](https://github.com/package-broker/broker/issues/905)) ([d8cbe74](https://github.com/package-broker/broker/commit/d8cbe749239e07aa92beb3aa5544c0659055b79b))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
  * peerDependencies
    * @package-broker/core bumped to 2.0.0-rc.1
