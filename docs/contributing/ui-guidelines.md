---
title: UI guidelines
sidebar_position: 1
description: Design and review rules for the Package Broker admin UI.
---

## Principles

The admin UI is for people: show names, human labels and consequences. Agents and bots use the API and the future MCP server. Forms and list columns must not ask people to interpret IDs, raw enums or space-separated values. Put IDs behind a **Copy ID** action; use named pickers and permission checkboxes. Package names, versions and repository paths remain useful content.

Show the current organization or project beside consequential controls. Explain what changes, who is affected and whether the action can be undone. Keep administration sections, including Audit and Import, separated from everyday navigation. Use effective permissions and authorized metadata; UI visibility never replaces server authorization. Respect redaction: show “Group value hidden” when known to be hidden, or “Name unavailable” when missing. Never reconstruct hidden values through another endpoint.

Reuse the primitives in `packages/ui/src/components/ui/` and native controls. No new UI dependency without approval. The UI bundle has a size budget: `packages/ui/scripts/build.mjs` measures gzip output against `packages/ui/bundle-budget.json` and rejects growth beyond its 10% tolerance. Include before/after gzip totals when changing the bundle; do not reset the baseline to make a check pass.

## Foundations

Keep the system font, neutral surfaces and blue primary action. `packages/ui/src/styles.css` and the primitives currently contain literal colors; the following semantic names are the contract for a future token migration, not variables already available everywhere. Introduce aliases centrally with the current appearance first, then migrate components. Pages choose meaning rather than inventing status shades.

| Semantic token names                                                  | Purpose and initial direction                                                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--background`, `--foreground`                                        | Page surface and text: `#fafafa`, `#171717`.                                                                         |
| `--card`, `--card-foreground`, `--popover`, `--popover-foreground`    | Content and overlay pairs: white and `#171717`, including sticky cells.                                              |
| `--muted`, `--muted-foreground`                                       | Subtle regions and supporting text: `#f5f5f5`, `#525252`.                                                            |
| `--border`, `--input`                                                 | Container edges `#e5e5e5`; control edges `#d4d4d4`.                                                                  |
| `--primary`, `--primary-foreground`, `--primary-hover`                | Existing blue-700, white, blue-800 action colors.                                                                    |
| `--destructive`, `--destructive-foreground`                           | Existing red-700 and white for the final destructive action.                                                         |
| `--ring`                                                              | Visible focus; retain the current global `#155dfc` outline initially.                                                |
| `--status-{error,success,warning,info,neutral}-{bg,text,border,icon}` | Paired status roles extracted from `packages/ui/src/components/ui/status-badge.tsx`; check the icon role separately. |
| `--bg-disabled`, `--text-disabled`, `--border-disabled`               | Explicit readable disabled pairs when controls are normalized.                                                       |

Use each surface with its foreground partner. Register static Tailwind aliases and complete class maps; dynamically constructed class fragments will not reliably be emitted. Keep status meaning centralized in StatusBadge. Dark mode needs separately checked pairs across native controls, dialogs, menus, selected rows and table surfaces before release.

Use a 4px spacing rhythm: 4px within fields, 8px between inline controls, 16px between field rows and for compact container padding, 24px between columns/sections and for dialog padding. Preserve existing component radii during token work. Use one 24px/32px semibold page heading, 18px/28px semibold section headings, 14px/20px body, labels and essential help/errors, and 12px/16px secondary metadata. Reserve monospace for code, versions, paths and deliberate technical details.

Keep visible keyboard focus on every surface; the current global outline is 2px with a 2px offset. Do not remove it without an equally visible replacement. Read-only values remain selectable; disabled controls need a visible reason. Respect reduced motion when adding animation.

## Form anatomy

Use one title, a short purpose and explicit scope, grouped fields, a consequence or review sentence, then actions. A disclosure summary can supply the title; do not repeat “New project” or “New grant” inside it. Keep essential choices visible; advanced settings may use native `details`. Relevant collapsed controls remain mounted and submit their values; hide and disable inactive mutually exclusive controls so they do not submit or validate.

Every field has a visible associated label, control, necessary help and an associated error. Mark optional fields “optional” and communicate required fields in text plus native `required` where applicable. Use unique `id`/`htmlFor`, preserve all help/error references in `aria-describedby`, and set `aria-invalid` for invalid controls. Keep constraints visible when an error appears. Use `fieldset` and `legend` for related radios or checkboxes. Open a containing disclosure before focusing its invalid field.

Forms use two columns on wide screens and one on narrow screens. Use this Tailwind form container:

```text
grid max-w-5xl items-start gap-x-6 gap-y-4 lg:grid-cols-2
```

Pair short related fields at `lg` (1024px) and above: Project name | Project slug; Token name | Project; Service identity | Lifetime. Keep help and errors within their field's grid cell, with controls aligned at the top. Use `lg:col-span-2` for radio-card fieldsets, repository URL previews, permission disclosures, notices, results, review summaries and actions. DOM order follows left-to-right, row-by-row reading order; no CSS reordering.

Place the primary action first and left-aligned, followed by the secondary action. Buttons fit their content on desktop; use `w-full sm:w-auto` so full width applies only below `sm`. Destructive confirmation dialogs retain safe Cancel-first interaction. Name busy actions (“Creating project…”), expose busy state and prevent duplicate writes.

Keep non-secret drafts on validation, API and network failure; reset only after confirmed success. Focus the first invalid field or a linked error summary. On a revision conflict, retain the draft for comparison and require reload and renewed review: “This project changed while you were editing. Reload the latest settings before saving.” After reauthentication, restore scope and draft and require explicit confirmation; never automatically replay an unreviewed mutation. Keep secrets out of persisted drafts and pending reauthentication state. A token secret is shown once in memory, cleared on close/navigation, and never recovered through list refresh or retries.

| Do                                                                                                                                                                                                                                                         | Don't                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Label a role picker “Role”; show actual assignable roles for this scope and “View permissions (5)”. Block submission with a reason if choices cannot load.                                                                                                 | Ask for “Role ID”, infer custom-role powers from its name, or choose Organization Admin to bypass a missing option. |
| Show “Group value” and “Use the exact group value sent by this provider.” Show a single configured provider as text while submitting its ID.                                                                                                               | Treat a group address as verified membership or promise an invitation email.                                        |
| Use “Install and download” with its consequence; explicitly submit the safe create default. Explain the current publishing limitation when showing publish permission. A token ceiling only limits the holder's actual permissions; it grants none itself. | Show `read write full`, call `full` “Full control”, or promise an unenforced publish-approval gate.                 |
| Explain that Project slug is permanent and preview valid repository URLs; preserve manual edits to a suggested slug.                                                                                                                                       | Silently rename a collision or display invalid input as a usable URL.                                               |
| Use named projects and grouped permission checkboxes for a service identity.                                                                                                                                                                               | Ask for project IDs or a space-separated permission string.                                                         |

## List anatomy

Use one heading, explicit scope, a count such as “3 packages on this page”, useful filters with active chips and Clear filters, and one create action when permitted. Aim for four or five useful columns: recognizable item, essential role/status, compact context/activity and actions. Omit unavailable optional facts; do not fetch every row's detail just to decorate the list or fabricate totals, creator names or membership counts.

The primary cell starts with a name, person/group value, package or repository path and an explicit link or button. Secondary facts supply type, provider, context or activity. Keep meaningful values readable and allow wrapping. Use text status badges from StatusBadge; Person/Group are types, not evidence of active or verified membership. Preserve distinctions such as Unknown, Stale, Quarantined and Removed upstream. “Credentials configured” does not mean credentials are valid.

Reuse `RowActions`: keep one routine action visible, put secondary, technical and destructive actions in **More**, including **Copy ID**. Use accessible names such as “More actions for Storefront”. Never label a list action Copy token. Announce “ID copied.” or “Could not copy ID.” and provide a manual fallback. Disabled actions have visible associated reasons; hide unauthorized mutation controls. Confirm destructive actions with readable target, scope, consequence and reversibility. “Revoke grant” must explain that other grants still apply.

Use a semantic table with caption and scoped column headers on desktop. At the existing 640px container transition, use labeled mobile cards with primary identity first, facts next and actions last. Include real visible labels rather than relying only on CSS-generated text. Expose only one interactive representation at a time; if keeping a single table styled as cards, verify its accessibility tree. Do not hide critical status/error facts at tablet widths. Keep filters, cursor and selected row when returning from detail or reauthentication.

Page-only sorting and filtering must say so: “Sort this page”, “Sorting applies to this page” and “Search this page”. Keep keyboard header sorting and `aria-sort`, use numeric/date values for comparisons, and offer equivalent mobile controls. Cursor pagination must not invent page numbers or global totals. Preserve source precedence order during reordering. Remove routine column-visibility controls and permanent scroll instructions from curated lists; retain defensive overflow only when needed.

| State              | Copy and recovery                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| First use          | “No projects yet. Create a project to organize packages and access.” Offer New project only when allowed.                                      |
| Filtered empty     | “No projects match these filters on this page.” Offer Clear filters.                                                                           |
| Loading/refreshing | “Loading projects…” with busy/status semantics. Identify retained rows as stale and prevent unsafe actions.                                    |
| Load failure       | “Projects could not be loaded. Try again.” Provide a working Try again action.                                                                 |
| Denied/unavailable | Explain the access or capability limitation; a forbidden catalogue is not “No roles”. Offer a permitted next step without guessing the reason. |

Use `ListState` and its children for state/recovery composition, extending it only when needed. Keep Never used, No expiry, Not approved, Hidden and Unavailable distinct. Exact local dates, timezone and ISO instants must be reachable without hover; use semantic `time` values and details rather than relying only on `title`.

## Copy rules

Use plain sentences and verb + object actions: “Create project”, “Change role”, “Revoke token”. State scope and consequences beside the decision. Use structured server reasons to choose specific error copy; do not interpret every conflict as a duplicate. Never show internal error codes as primary text or echo raw upstream responses, request data, credentials or credential-bearing URLs in errors or logs. Any technical diagnostic disclosure must follow the repository's privacy rules.

| Situation           | Wording pattern                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirmed success   | “Project created.” or “Access policy saved. Existing tokens now use this limit.” Use a polite status region; keep essential next steps inline.             |
| Busy                | “Creating token…” only while that operation is pending.                                                                                                    |
| Accepted/queued     | “Sync requested.” A 202 means accepted, never completed success: do not say “Package added” or “Synced”. Claim running only when worker state confirms it. |
| Already present     | “vendor/package is already available from this source.” Do not claim it was refreshed.                                                                     |
| Field failure       | “Enter a project name.” or, only for a confirmed duplicate, “This project slug is already in use. Choose another.”                                         |
| Partial failure     | “Service identity created. The token could not be created. Try again to create the token.” Retry the unfinished step without duplicating the identity.     |
| Updates unavailable | “Live updates are unavailable. Sync may still be running.” A client timeout is not proof that work failed.                                                 |

Errors and blockers persist with recovery. Do not use an expiring toast as the only explanation. Separate source listing success, individual package outcomes, archive availability and security assessment. Never call an unknown or stale vulnerability result “Safe”, promise a group exists, or imply unsupported publishing, discovery or global search is implemented.

## Accessibility and review evidence

Target WCAG 2.2 AA: check text contrast (4.5:1, or 3:1 for qualifying large text), meaningful control/focus boundaries and text alongside color. Verify keyboard operation, visible labels, fieldset/legend, help/error associations, first-error focus and announcements. Successes use polite status; errors need timely announcements without repeatedly reading the whole table. Essential information cannot depend on hover or a tooltip.

Use at least 44px touch targets, including row menus and copy actions; existing smaller primitive defaults need adjustment where used. Menus and dialogs must support Escape, contain focus appropriately and restore it to a connected opener or page heading. Close a menu before opening its confirmation. On phones, keep dialog actions reachable with a scrollable body and mobile keyboard visible.

Review at 1440px, 1024px, 768px and 390px, plus 320px reflow and 200% zoom: no page-level horizontal overflow, aligned fields and wrapped long names, paths and errors. Check relevant 400% reflow, reduced motion and screen-reader table/card semantics. Using a primitive does not prove accessibility; record the checks actually performed.

Every pull request that changes the UI carries **Before** and **After** screenshots per changed screen in the collapsed **Screenshots** section (the `ui screenshots` check). Include desktop and narrow layouts and relevant changed error, empty and busy states. Describe intentional visual differences and the keyboard, screen-reader and contrast evidence collected.

Add focused behavioral/browser coverage for changed interactions: failed draft retention, unavailable choices, conflict/reauthentication review, keyboard menus/dialogs, responsive overflow and queued versus completed feedback. Run `pnpm check` for typecheck, lint, unit tests, build and required UI browser tests; `pnpm check:ui-browser` runs the browser suite directly and requires Chromium. Keep CSP, permission and secret-lifecycle safeguards intact. Documentation-only changes use their task's docs gates and do not require screenshots of unchanged screens.
