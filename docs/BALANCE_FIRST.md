# Balance First: implementation and operations

Branch: `feature/utilities-design-drafts`; baseline `bb9225a`. No merge, push, or production deployment was performed.

## Changes

- `public/industry.css`, `index.html`, `app.js`: forest/ivory/sage design system across existing screens, rounded cards/forms/dialogs, personal settlement hero, recording actions, rent/combined-credit summaries, transactions and upcoming bills. Desktop uses three dashboard columns and a sidebar; mobile uses Home, Expenses, Record, Utilities, More. Bills, balances and every existing secondary screen remain accessible.
- `public/controls.js`: reusable password eye toggle for sign-in/current/new passwords, labels/autocomplete, modal keyboard focus management, Escape, focus restoration and offline notice. Submission guards preserve inputs on errors. The application still uses its actual backend, not design fixtures.
- `server/utilities.js`: household-scoped top-up/usage create/edit/delete, amount/date/payer/share validation, per-top-up allocations. Equal and percentage allocation conserve cents; custom totals must match exactly. Account row locking, writes, credit validation and activity logging run inside one transaction.
- `server/db.js`: AsyncLocalStorage makes existing query helpers participate in the same transaction. `activity.js` preserves saved shares on undo and rejects stale utility snapshots. Undo holds the account lock and rolls back if it would produce negative credit.
- `004_prepaid_utilities.sql` and `migrate.js`: additive migration, historical allocation snapshots, retirement of electricity recurrence, common cash-outflow view.
- Reports (category/member/week/month), budget spending and new spending/utilities CSV exports include top-ups once. Usage never changes member debts or spending. Rent stays separate. Existing expense/rent/settlement CSV formats remain available.
- Seeds use the combined account, stop seeding monthly electricity recurrence/unpaid electricity bills, and save explicit initial top-up shares. Historical electricity demo expense examples remain historical examples, not prepaid credit.
- `manifest.json`, `sw.js`, server shell hashing: ivory PWA appearance and new asset included. API responses are never cached. Offline writes are not supported.
- Dockerfile: optional public CA secret supports verified installs in a managed proxy environment; application files belong to the non-root runtime user even when checkout file modes are restrictive.

## Historical data and accounting

Migration 004 preserves account/top-up/usage IDs and amounts. It snapshots exactly the pre-upgrade account allocation and active-member calculation into each historical top-up and its activity snapshots, inside the migration transaction. Old snapshots of deleted top-ups are included. No historic bill payment becomes a new top-up or new credit. Statements and balances consume the same saved shares. Future allocation changes are per-top-up and cannot rewrite unrelated records. Editing a top-up requires explicitly selecting shares; the UI initially displays its saved shares as custom amounts.

Old percentage/custom allocations could already sum incorrectly. Their existing liabilities are frozen as calculated, **not silently redistributed**. Before deployment, audit the sum of each legacy top-up's saved shares against its amount and the sum of member balances. Existing discrepancies require an explicit household decision; do not claim those historical ledgers were automatically repaired. New allocations enforce exact totals.

Original fibre/electricity category IDs, expenses, receipts, linked bills and budget rows remain. A combined report display groups historical fibre/electricity spending with top-ups. The dashboard sums both legacy category budgets; the budget editor retains a separate line for each original budget so neither value is overwritten in a collision. Both remain undoable by their original category ID. Top-up spending belongs to the prepaid component; historical electricity expenses belong to the legacy electricity component.

Existing unpaid electricity bills stay visible with legacy-obligation labels and ordinary pay/reverse controls. Migration marks existing monthly electricity entries retired and inactive. Retired entries cannot generate bills even if an old undo restores their active flag. New monthly electricity recurrence is rejected for the adopted household; unrelated recurring bills still work. Existing activity wording remains readable.

## Validation

- Full suite: **44 passed, 0 failed, 0 skipped**, against disposable PostgreSQL 16 / Node 24. Includes baseline regression tests plus migration and utilities API scenarios: $100 top-up/$30 usage, no double counting, statement reconciliation, percentage cents, custom edit/delete/undo, invalid payer/date/credit, negative-credit deletion rollback, budget collision preservation, unchanged legacy bill IDs/status and unrelated recurring bills.
- Browser validation: **23 assertions passed, no uncaught browser errors**, against the final built container. Mobile sign-in and real recording form; all main/secondary screens; 320/390/768/1440px layouts; password Space/Enter, autocomplete, dialog role/Escape/focus restoration and retained invalid input. Screenshots are in `design/after-*.png` with baseline `design/before-*.png`.
- Docker build with TLS verification enabled; container runs as non-root and `/healthz` returns `ok:true`. Only the isolated review database is migrated. Live production access was not used.

Tests use `npm run test:all`; never supply the live database as TEST_DATABASE_URL. Browser automation used temporary Playwright tooling outside the project; application dependencies and lockfile are unchanged.

## Deploy manually after review

1. Keep the current image tag/code revision and a verified database backup together. Back up receipt storage too. Stop application writes before the final backup; keep PostgreSQL running for the dump.
2. Example with the repository's existing Compose names (execute on the deployment host, not during preview):

   ```sh
   docker compose stop app
   docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > commoncents-before-utilities.dump
   # Verify the dump in a separate disposable PostgreSQL instance before continuing.
   docker compose build app
   docker compose up -d app
   docker compose logs --tail=100 app
   curl --fail http://127.0.0.1:3040/healthz
   ```

3. Startup applies 004 once under the existing advisory migration lock. Check legacy record counts/credit and saved allocations, bills, statements, budgets and cash-outflow totals against the backup. Smoke-test login, a recording action and undo on staging first. Validate PWA refresh and receipt access.
4. Existing `.env` and persistent database/receipt volumes stay in place. Never reuse preview credentials in production. Standard Docker builds do not require the optional `proxy_ca` secret. Managed-proxy builds can pass `--secret id=proxy_ca,src=<public-CA-bundle>` without disabling TLS verification.

## Roll back

Do not merely run older code over new per-top-up allocations: it would recalculate historical liabilities using the account-level model. Stop writes, preserve a new post-upgrade backup and exports for reconciliation, restore the **pre-upgrade database and receipts** together with the original image/code, then start the old app and verify health/login/balances. Restoring a backup discards newer writes; reconcile those records deliberately before allowing users back in. Do not drop columns, rewrite applied migrations, or delete bills as a rollback shortcut.
