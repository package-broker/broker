# T770 review

## Scope and findings

Reviewed the complete working-tree diff against merge base `8fcda6ed00991b21ee544f410893d0750f9a05f1`, including committed, staged, unstaged, and untracked changes. The only implementation change is `packages/core/src/architecture.test.ts`; there are no branch commits, staged changes, or new implementation files.

No actionable bugs found. Root build-module discovery, script classification, exact core-parser permissions, and named tooling permissions match the objective. Existing assertions remain intact. No changes outside the objective are needed. The final diff cannot establish whether tests were written first.

## Validation

- Architecture suite: **110/110 passed**.
- `git diff --check`: passed.
- `pnpm check`: typecheck and lint passed; the full test run was stopped after runtime integration failures/timeouts in this restricted environment, so it did not complete.
- `pnpm build`, `pnpm bundle`, `pnpm check:treeshake`, and `pnpm check:pack`: passed.
- `pnpm smoke:cloudflare`: blocked by `listen EPERM` on loopback.
- `pnpm smoke:node`: blocked installing production dependencies by `ENOTFOUND registry.npmjs.org`.

## Mutation proof

Ran isolated temporary copies of the architecture suite without modifying repository tests. The unchanged copy passed all 110 tests; every deliberate regression failed assertions:

| Mutation                                                              | Failing tests |
| --------------------------------------------------------------------- | ------------: |
| Remove the exact core-parser exception                                |            11 |
| Broaden the exception to all core subpaths                            |             9 |
| Broaden the exception to all file locations                           |             6 |
| Remove the named `openapi-typescript` permission                      |             9 |
| Remove the named `prettier` permission                                |             9 |
| Allow tooling in browser source                                       |             5 |
| Revert root build script classification to JavaScript-only extensions |             4 |
| Revert discovery to omit `.mts` and `.cts`                            |             1 |
| Omit UI root-module discovery entirely                                |             2 |

Detailed command output is in `/tmp/T770-{check,build,bundle,treeshake,pack,cloudflare,node,mutations}.log`. No fixes or commits were made.

Verdict: patch is correct; integration validation remains limited by the sandbox.
