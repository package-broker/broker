<!-- Pull requests target `main` and are squash-merged; the pull request title becomes the commit message, so it must follow Conventional Commits with the package directory as scope. -->

## Summary

What this change does and why.

## Changes

-

## Screenshots

<!-- Required when the change touches the UI: one Before and one After screenshot per changed screen, inside this section. Otherwise tick "No visible UI change". -->

<details>
<summary>Before | After</summary>

| Before | After |
| --- | --- |
|  |  |

</details>

- [ ] No visible UI change

## Test plan

How you verified the change, for example the commands you ran and the cases you covered.

## Checklist

- [ ] Signed-off-by on every commit (`git commit -s`)
- [ ] Title follows Conventional Commits, with the package directory as scope
- [ ] A change to a published contract (exports, plugin API, HTTP routes, configuration) adds entries to `BACKWARD_COMPATIBILITY.md` and `UPGRADE_NOTES.md` (once present)
- [ ] A change to a recorded decision updates `docs/decisions/`
- [ ] Docs and tests are updated
