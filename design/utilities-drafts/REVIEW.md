# CommonCents: design selection

Branch: `feature/utilities-design-drafts`. Baseline: `bb9225a04553304b91033b33c0aa3d52e40b43a6`.

The uploaded ZIP is byte-for-byte identical to the 36 files in this baseline. No newer feature needs importing. The current repository remains the implementation baseline. No production source, database migration, package manifest, lockfile, or deployment configuration is changed in this draft phase.

Open `index.html` in a browser. It is a self-contained, offline-capable **design artifact**, with no external assets, API calls, service worker registration, or saved credentials. Choose A/B/C across the top. Each option includes mobile sign-in, dashboard, combined utilities, a top-up interaction, and a desktop dashboard. On narrow screens, jump links reach each screen; the desktop study scrolls horizontally. PNGs are included for review without running a server.

## Layout choices

| Option | Information hierarchy | Navigation | Recording pattern |
| --- | --- | --- | --- |
| A — Balance First (recommended) | Personal position → quick actions → rent / prepaid credit → activity | Home, Expenses, central Record, Utilities, More | Sheet-style panel |
| B — Household Overview | Utilities credit → rent progress → member summaries → personal position | Household, Members, Record, Utilities, More | Dedicated recording page |
| C — Tasks First | Rent outstanding / upcoming bill → recording actions → personal position → activity | Today, Expenses, Record, Overview, More | Focused recording dialog appearance |

A is closest to the reference's central phone and makes a household settlement position easy to understand. B best supports shared household coordination. C makes unresolved work fastest to find. All use the same warm ivory, forest green, sage, rounded surfaces, outline icons, and sans-serif typography. Task-first does not invent low-credit warnings or estimated dates from insufficient history.

These previews demonstrate interaction and visual hierarchy, not the completed accounting changes. Recording confirms an isolated sample action and shows its calculated consequences; the fixed comparison ledger does not change. Other recording actions explicitly explain their preview scope. The final implementation must retain real backend operations.

## Shared fictional ledger

Kōwhai Flat: Alex, Jamie, Morgan, Riley. Week Monday 2–Sunday 8 November 2026. All amounts NZD.

- Alex paid $80 groceries and a $100 utilities top-up; Jamie paid a $60 water bill. Each of the four shares the $240 cash outflow equally ($60 each).
- Settlement balances: Alex +$90; Jamie $0; Morgan −$60; Riley −$60. Sum $0. Rent excluded.
- $100 topped up − $30 usage = $70 remaining credit. Usage changes no member debt and adds nothing to the $240 spending total.
- $200 rent due per member; Alex, Jamie and Morgan recorded $200 each. $600 collected of $800 due; Riley has $200 outstanding. Rent is not shared-expense spending.
- A separate $60 upcoming water bill is unpaid, due 8 November; it contributes nothing to recorded spending yet.
- November utilities budget $200; $100 top-ups counted once means 50% used. No earlier usage history: no depletion forecast.
- The recording form demonstrates an **additional** $100 top-up: $170 resulting credit, $25 shares, payer credited net $75. It does not replace the original sample transaction. The sample usage form starts a separate interaction from $70 credit.

## Feature and implementation map

The following features were located in the actual code, not inferred from the reference. They remain required after design selection.

| Existing capability | Current implementation | Planned work / preservation |
| --- | --- | --- |
| Member selection, cookie sign-in/out, password changes | `public/app.js` renderLogin/renderMore; `server/auth.js`; `/api/auth/*` | Reusable eye toggle in sign-in/current/new password fields. Hidden by default, Enter submission, autocomplete, no persisted visibility. Preserve bcrypt and session cookie controls. |
| Member administration / weekly rent settings | renderMembers; `/api/members` | New consistent member rows/forms; preserve admin boundaries and active membership. |
| Monday rent weeks, partial payments / credits, week navigation | renderDash/rentDialog; `/api/weeks/:weekStart/summary`, `/api/rent/*`; calc date helpers | Rent stays separate from net settlement; keep quick full/half/unpaid and week navigation. Preserve Auckland dates and old-week normalisation. |
| Dashboard summaries | renderDash; budgets, balances, prepaid, bills APIs | Selected hierarchy; actual personal owe/owed position, combined prepaid credit, rent progress, upcoming bills and activity. |
| Shared expenses: equal/custom/percentage | renderExpenses/expenseDialog; resolveSplits; calc equalSplit/percentSplit | Preserve filters, search, sorting, status actions, edits/deletes and exact cent allocation. |
| Receipts | expense multipart forms; authenticated `/api/receipts/:file`; multer; DATA_DIR | Retain upload, access controls and persistent receipts; no public receipt cache. |
| Bills: edits/deletes, pay/unpay, linked expenses | renderBills/billDialog; `/api/bills/*` | Preserve legacy unpaid electricity bills and linked paid history; explicit legacy badges. |
| Recurring bill administration / monthly materialisation | recurringDialog; `/api/recurring-bills`; seed ensureMonthlyBill/materialise | Stop only adopted household's future electricity generation; retain unrelated recurring bills and existing instances. |
| Prepaid top-ups / usage and edit/delete | renderFibre; `/api/prepaid/*`; prepaid tables | Combined Fibre & Electricity account, payer/date/note inputs, full allocation editor, consistent invariant checks on create/update/delete/undo. |
| Cost allocation / member balances / settlement suggestions | topupShares/netBalances/settlementPlan; `/api/balances` | Snapshot historical liabilities before changing allocation model. Use validated per-top-up shares for future allocations, reconcile cent totals. |
| Recorded repayments | renderBalances; `/api/settlements/*` | Retain payer/recipient, amounts/dates, edits/deletes, undo. No bank-transfer claim. |
| Category budgets | renderBudgets/budgetCard; `/api/budgets`; migration 003 | Cash-outflow basis: expense records plus top-ups once, never usage. Preserve original budget identities and handle combined display collisions explicitly. |
| Reports: category/member/week/month | renderReports; `/api/reports/*` | Reuse selected analytics language, aggregate prepaid cash outflow consistently in every dimension. Separate usage analysis. |
| Statements: period/opening/closing/running balance | renderStatement; `/api/statement`; calc statement | Rename future utilities descriptions; consume the same frozen shares as balances so statements reconcile. Keep old history readable. |
| Date-filtered exports | renderExport; `/api/export/{expenses,settlements,rent}.csv`; csv.js | Retain current formats/date semantics and formula neutralisation; add clearly identified utilities cash outflows without duplicating expense rows. |
| Activity / supported undo | renderActivity/confirmUndo; activity.js; `/api/activity/*` | Preserve original record IDs, snapshots and old entity types; new shares travel with top-up undo. Transactional invariant checks. |
| Admin permissions / demo reset | UI admin gates; endpoint checks; `/api/admin/reset-demo` | Preserve permission boundaries; update demo seed/reset to combined utility account safely. |
| PWA / offline shell | index.html, manifest.json, sw.js, sw-register.js; server SHELL_FILES | Reusable tokens/components; consolidate inline CSS; keep new asset lists and hash inputs aligned. No cached API data or offline financial writes. |
| Security / deployment | auth, helmet, login limiter, escaping, Dockerfile/Compose, CI, staging, /healthz | Retain health checks, graceful shutdown, security headers, CSP, proxy trust and migration locking. No production deployment during preview. |

## Findings directly affecting implementation

1. `topupShares()` applies the **current** account allocation and active members to all past top-ups. Percent shares are independently rounded; custom amounts do not scale with top-up size. Changing the allocation or active membership can rewrite past debts. Migration must capture existing effective amounts, including any existing inconsistencies, before using validated immutable shares for new records. Do not silently rebalance historical cents; report any non-zero historical liability discrepancy and require a documented resolution before claiming reconciliation.
2. The prepaid UI selects equal/percent/custom, but sends only `method`; it supplies no percentage or custom rows. Account allocation update is several queries without a transaction and does not log undo. Design now exposes full inputs; implementation must validate and save atomically.
3. The top-up UI creates records with only an amount, despite API payer/date support. Editing cannot change payer. Usage create has date/note support not exposed by the UI. Amount/date/membership checks are inconsistent across creates/edits; usage edit and top-up delete/undo need credit invariant review. Use row/account locking to avoid concurrent overspending.
4. Category/member/weekly/monthly reports and category budgets sum expenses only; prepaid top-ups are excluded. A shared cash-outflow query/model must include top-ups exactly once. Usage must never enter liabilities or spending. Pending future bills must not enter that total.
5. `fibreStats()` treats the count of usage rows as weeks and fabricates a far-away estimate with zero usage. Replace this with dated history sufficiency and a clear unavailable state.
6. Seeds include separate electricity expenses, bills, monthly recurrence, and fibre prepaid reminders. Fresh-install seeds need the combined model; recurring generation must remain stopped on repeated startup. Keep existing unpaid bills visible and paid payments intact.
7. Existing dialogs lack keyboard Escape, focus trapping/restoration and pending submission guards. Existing sign-in is not a semantic form. Reusable form/dialog primitives must preserve inputs after errors and prevent duplicate submissions.
8. `public/index.html` contains overlapping shell styles and `app.js` many inline styles; blueprint corners and condensed heading fonts come from shared CSS. Consolidate into components/tokens after selection, not a superficial colour override.

## Migration plan after selection (not applied)

Add `004_prepaid_utilities.sql` after migration 003; never rewrite applied files. Preserve account/top-up/usage IDs and credit. Keep underlying legacy category and bill identities, receipts and activity snapshots. Prefer a combined display grouping rather than moving historical expense foreign keys. Keep paid electricity expenses as historical cash outflow; **never** create prepaid credit or new top-ups from them. Surface unpaid electricity bills as legacy obligations requiring explicit resolution.

Preserve both legacy category budget rows if fibre and electricity budgets coexist. The combined display budget will be the sum of the original limits, with a visible breakdown; its cash-outflow spending is the grouped historical expense spending plus top-ups once. Do not delete or overwrite either budget row. Future combined-budget editing needs an explicit displayed replacement decision, so old activity undo remains meaningful. Cover single-budget, no-budget and collision cases in disposable-database fixtures.

Snapshot the existing effective top-up shares first; introduce per-top-up allocations for future records. Keep a compatibility path for old activity snapshots missing share data. Share records must be restored/deleted with top-ups and activity inside the same transaction. Mark adoption explicitly per household, deactivate matching monthly electricity recurring entries, and guard generation/undo from silently resuming a retired recurrence. Weekly rent and unrelated water bills must behave unchanged.

## Verification boundary

Design-phase checks: browser-render all 15 requested views, inspect all three comparison boards, exercise password toggle by keyboard, Enter sign-in, amount/allocation validation, successful sample recording, duplicate-submit guard, history filters, and narrow/mobile/tablet/desktop overflow. Re-run the existing Node/PostgreSQL suite on this branch. Record actual results in VALIDATION.md.

After selection: add production tests for password controls and full utility accounting, cent allocation, edits/deletes/undo, category budget collisions, migration from legacy data, statements, cash-outflow reports/exports, admin/member access, fresh install and repeated startup. Browser-check every screen and real backend actions; verify Docker build and /healthz. Take before/after screenshots. None of those future implementation tests is implied complete by a working preview.

Deployment/rollback instructions belong with the selected implementation. Migration verification will use disposable databases only; production deployment and merging remain manual.
