# Recorded git smart-HTTP exchanges

Each JSON file holds the exact request and response bytes (base64) of the POST requests that `readFileAtRefs` in `../fetch.ts` sent while it ran against a real server, plus the call arguments and the outcome. Request headers are limited to `git-protocol`, `content-type` and `accept`; response headers to `content-type`, `location`, `cache-control` and `www-authenticate`. Only public repositories were used and no credentials were sent. `fetch.test.ts` ("recorded exchanges") replays them without network and checks that fetch.ts sends the recorded request bytes again.

Recorded 2026-10-16 (see `recordedAt` in each file). Client: package-broker core at the commit that merged T378, Node v24.19.0, `git version 2.54.0 (Apple Git-157)` for `git ls-remote` (ref listing only). The local server ran stock `git http-backend` from `node:24-alpine` (`git version 2.54.0`, `uploadpack.allowFilter` unset) behind a small Node CGI bridge (`v2-research/scripts/git-http-bridge.mjs`).

Re-record, from the repository root after `pnpm typecheck`:

    node <path>/v2-research/scripts/record-git-fixtures.mjs . [scenario ...]

| File                                        | Server                                     | What it shows                                                                                                                                |
| ------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| github-tree1-rejected                       | github.com composer/semver                 | `filter tree:1` answered with HTTP 200 and `ERR tree filter allows max depth 0, but got 1` as the first and only packet; fall back to tree:0 |
| github-semver-41-refs                       | github.com composer/semver                 | 41 refs, warm cache at tree:0: commit batch (`deepen 1`, `shallow-info` then `packfile`), root-tree batch, blob batch                        |
| github-tree-by-oid-tree0                    | github.com composer/semver                 | root tree wanted by oid under tree:0                                                                                                         |
| github-tag-peels-to-tree                    | github.com torvalds/linux                  | `v2.6.11-tree` peels to a tree; `deepen 1` + tree:0 returns that tree                                                                        |
| github-not-our-ref, github-not-our-ref-warm | github.com composer/semver                 | `ERR upload-pack: not our ref <oid>`, HTTP 200, with a cold and a warm cache                                                                 |
| github-renamed-repository                   | github.com fzaninotto/Faker                | renamed repository: GitHub answers the POST itself with 200, no redirect                                                                     |
| github-renamed-repository-401               | github.com jakub-onderka/PHP-Parallel-Lint | renamed repository GitHub no longer serves under the old name: 401 with `www-authenticate: Basic realm="GitHub"`                             |
| local-git-http-backend                      | stock git-http-backend                     | `filter` request without `uploadpack.allowFilter`: HTTP 200 with an empty body                                                               |
| local-git-http-backend-no-filter            | stock git-http-backend                     | same repository with `capabilities.filter=false`: one full request succeeds                                                                  |

ERR packets from GitHub carry no trailing newline. The local server's repository is created per recording, so its object ids and commit time differ between recordings.
