# Changelog

## 2.1.0: fresh UI, combined Fibre & Electricity account, date fix

Version note: the previous release was 1.1.0; this goes straight to 2.1.0 (there was no 2.0.0).

### Adopted: fresh UI and combined prepaid utilities (`upgrade/fresh-ui`)
A ready-made upgrade, prepared separately and imported unchanged as its own commit; design notes in
`docs/BALANCE_FIRST.md`, screenshots in `design/`.
- New look across every screen (`industry.css`, `index.html`, `app.js`): balance-first dashboard, a sidebar
  on desktop and a bottom bar on mobile (Home, Expenses, Record, Utilities, More). `controls.js`: password
  show/hide, dialog keyboard focus and Escape, offline notice.
- **Fibre & Electricity**: one shared prepaid account for both. Each top-up saves its own split between
  flatmates when it is recorded (equal, percent or custom, exact to the cent), so later changes never rewrite
  old top-ups. Usage only lowers the credit; it never moves money between flatmates. Credit can't go negative.
  Routes moved to `server/utilities.js`; `PUT /api/prepaid/allocation` now always refuses (splits are per top-up).
- Migration `004_prepaid_utilities.sql` (with code in `migrate.js`, same transaction):
  - saves each existing top-up's split as the old account-wide rule calculated it, also in the activity log so
    undo keeps working; existing discrepancies are frozen as they were, not silently redistributed;
  - renames the account to "Fibre & Electricity" and **stops the monthly Electricity recurring bill**
    (unpaid electricity bills stay, labelled as legacy);
  - adds a `cash_outflows` view so reports, budgets and the new `spending.csv` / `utilities.csv` exports
    count each top-up once.
- `db.js`: inside `tx()`, the `q`/`one`/`all` helpers join the transaction automatically.
- Rollback after 004 means restoring the pre-upgrade database backup; older code would recompute old
  top-ups with the account-wide rule.
- Note: the 004 data step calls `topupShares()` from `calc.js`; if that function changes, a fresh database
  would migrate differently. Leave it alone or copy it into `migrate.js` before changing it.

### Fixed: dates moved back a day when the server runs in New Zealand time
- Postgres `DATE` values (calendar days) were turned into JS `Date` objects at *local* midnight, and
  `toISOString()` then converted them to UTC. In Pacific/Auckland (UTC+12/13), local midnight is the previous
  day in UTC, so edited expenses, CSV exports and statements showed every date one day early. It was hidden only
  because the container runs in UTC (also behind README bug 1's fix).
- `db.js` now keeps `DATE` columns as `'YYYY-MM-DD'` strings (`pg.types.setTypeParser(1082, …)`), and the
  `toISOString()` workarounds on dates are gone (`toISODate`, `fibreStats`, `utilities.js`).
- Proof: the full suite passes in UTC, Pacific/Auckland and America/Los_Angeles (`TZ=… test/run-integration.sh`);
  before the fix 4 tests failed in Pacific/Auckland. New tests fail without the fix even in UTC.

### Deployment changes
- `docker-compose.yml`: `name: commoncents` pins the project name, so the live volumes are used whichever folder
  Compose runs from (otherwise a copy run elsewhere would start on new, empty volumes).
- Dockerfile: the app's code is readable but not writable by the app user; only `/app/data` is writable.
  (The import made all of `/app` writable by it.) The optional `proxy_ca` build secret is unused here.
- `server/utilities.js` rewritten for readability with the same behaviour.

## Phase 3: features (one branch each, stacked; Discord reminders skipped by choice)

### My statement (`feature/statement`)
- More → **My statement**: every shared expense, fibre top-up and settlement that moved a person's balance,
  with a running balance, for any period (earlier items become the opening balance). Anyone's statement can be
  viewed, like the balances screen. `GET /api/statement?member=&from=&to=`.
- Built as a pure function (`statement()` in `calc.js`) with the same rules as `netBalances`; tests prove an
  all-time statement ends at exactly each member's balance, to the cent.

### Recurring bills admin (`feature/recurring-bills`)
- What `materialise()` already did: only **monthly** recurring bills generate bills (one pending bill per month,
  due on `DAY:n`, 15 if unset, max 28). Weekly (rent) is tracked as rent records and prepaid (fibre) in the
  prepaid account, so those entries are reminders. The screen now says so.
- Bills → Recurring: the admin can **add, edit and stop** recurring bills (`POST/PATCH/DELETE
  /api/recurring-bills`). A new monthly one creates this month's bill immediately (`ensureMonthlyBill`, pulled
  out of `materialise()`). Edits apply to future bills only. "Stop" deactivates; past bills and payments stay.
- All three are logged and undoable (new `recurring_bill` case). Undoing a create removes the bill it generated
  only if nobody has paid it yet; otherwise the paid bill stays and the recurring bill is just stopped.

### Reports (`feature/reports`)
- The charts already existed (the plan assumed only the API did). Added a **period picker** (this month, last
  month, last 3 months, this year, all time) for the category and per-person charts, a total, and a
  **monthly trend** chart (`GET /api/reports/monthly?months=N`). `/api/reports/by-member` takes `from`/`to`.

### Category budgets (`feature/budgets`)
- Migration `003_category_budgets.sql`: an optional monthly budget per category. Spending is always computed
  from expenses (calendar month, NZ), never stored, so it can't drift.
- Dashboard: a **Budgets** card with a bar per budgeted category, marked "over by $x" when exceeded (only shown
  once a budget exists). More → **Budgets**: the admin sets or clears amounts; everyone else can look.
- `GET /api/budgets?month=YYYY-MM`, `PUT /api/budgets/:categoryId`. Every change goes through
  `logActivity`, and undo (new `budget` case) restores the previous amount or removes a new budget.

### CSV export (`feature/csv-export`)
- More → **Export to spreadsheet**: expenses (with a column per person's share), settlements and rent, for
  any date range (inclusive) or everything. `GET /api/export/{expenses,settlements,rent}.csv`.
- Safe to open in Excel: text starting with `= + - @` gets a leading `'` so it can't run as a formula
  ("CSV injection"); a UTF-8 BOM keeps names like Pak’nSave intact. Read-only, so nothing to undo.


## Phase 2: dev quality (branch `upgrade/quality`)

### Tests
- **Unit tests** (`test/calc.test.js`, built-in `node:test`, no new dependency) for every calculation:
  equal and percentage splits (every amount from 1c to $50, 1–6 people), split validation, balances summing
  to zero, settlement plans (2,000 random ledgers settle to the cent), top-up shares, week boundaries, and
  the browser's date helpers under three time zones.
- **Integration tests** (`test/integration.test.js`) against a real, throwaway Postgres: migrations (fresh,
  baselined, failing-and-rolled-back), README bugs 1 and 2, the Phase 1 reset-demo cases, percentage splits
  through the API, old week URLs, no SQL in errors, and the login limit. `test/run-integration.sh` runs it all
  in Docker; the tests refuse any database whose name lacks "test".
- **CI** (`.github/workflows/ci.yml`): Node 24 + a Postgres 16 service container run `npm ci` and `npm test`
  on every push and pull request, plus a `docker build` check.

### Bugs the tests found (and fixed)
- **NZ dates.** `today()` was the server's UTC date: a day behind every NZ morning, so expenses got
  yesterday's date and Monday's new rent week started at 1 pm. Now `Pacific/Auckland` (`APP_TZ` to change).
  The browser was worse: local noon + `toISOString()` put every week start on the Saturday/Sunday before, in
  NZ. Live data shows it: a real week's rent payments are stored under a Saturday "week". Both ends fixed; the server snaps week URLs to the nearest Monday, so phones still running the
  old `app.js` stop creating stray weeks.
- **Rounding.** Equal splits could give a negative share and be off by 2c; percentage splits could lose a
  cent; custom splits accepted being 1c off; `round2(1.005)` was 1.00; 1c debts were never settled. All
  money math now runs in whole cents (`toCents`, `percentSplit` with largest remainders).

### Migrations
- `migrations/NNN_name.sql` + `server/migrate.js` (~40 lines, handwritten): each file once, in order, in a
  transaction, recorded in `schema_migrations`, under an advisory lock. Replaces "run SCHEMA.sql if the
  tables are missing + ALTERs on every boot".
- `001_baseline.sql` is the live schema exactly (proved by diffing `pg_dump --schema-only` of a database
  built from it against live). On the live database it's recorded as applied, not run.
- `002_rent_is_demo_default_false.sql`: the first real migration. `rent_records.is_demo` defaulted to true.
- `SCHEMA.sql` is gone; `migrations/` is the single source of truth.

### Other
- `server/index.js` exports `app` and `start()`, and only listens when run directly (so tests can import it).
- `.dockerignore` also skips `test/`, `staging/` and `.github/`.


## Phase 1: fix and harden (branch `upgrade/harden`)

### Found in Phase 0 (2026-11-02)
- The live deployment (`/opt/commoncents`) already had three fixes that GitHub `main` lacked: `bcryptjs` in
  package.json, `SCHEMA.sql` copied into the image, and receipts on a named volume (`app_data`). Those are on
  branch `live-snapshot`, which this branch builds on.
- The live database was created from that `SCHEMA.sql`, not from the "reconstructed" schema on `main`.

### Fixed
- **reset-demo could fail or leave demo money behind.** Reproduced against a copy of the real database before fixing:
  - Paying a demo bill creates its expense with `is_demo = false`, so reset-demo removed the bill but kept the
    payment, and balances still counted it.
  - A real bill whose payment was a demo expense made reset-demo fail on `bills_expense_id_fkey` (same bug class as
    the earlier "unpay" fix), and the raw SQL error was sent to the browser.
  - Now: one transaction; demo payments include expenses created by paying demo bills; real bills that point at one
    are cleared first and set back to pending; then the deletes. All of it commits, or none of it does.
- **Database errors no longer leak to the client.** `wrap()` sent any error with `code` + `message` to the browser,
  and Postgres errors have both. Only the app's own codes (`FORBIDDEN`, `MISSING_FIELD`, …) are sent now;
  everything else is logged and answered with a generic 500.

### Upgraded
- Node 22 → **24** (current LTS). Express 4 → **5**, multer 1 → **2** (fixes known DoS CVEs), pg 8.23.
  - Express 5 checks: the SPA fallback is a RegExp (still valid), nothing writes to `req.query`, no removed
    APIs (`req.param`, `res.send(status)`, …) are used.
- `npm ci` with the committed `package-lock.json` (exact versions every build). `npm audit`: **0 vulnerabilities**.

### Hardened
- **Port 3040 stays open on the home network** (flatmates use `http://<server-ip>:3040`); Caddy also proxies
  the `.internal` name to it.
- **Login rate limit:** 10 failed attempts per 15 minutes per client IP (`express-rate-limit`). Successful
  logins don't count. `X-Forwarded-For` is trusted **only** from the Docker network gateway (where Caddy's
  requests arrive) and loopback, found at startup from `/proc/net/route`. Trusting all private ranges would
  let a LAN device send a fake `X-Forwarded-For` on every try and never hit the limit (tested both paths).
- **Security headers** (`helmet`): Content-Security-Policy with no inline scripts (the service-worker
  registration moved to `public/sw-register.js`), `X-Content-Type-Options`, `frame-ancestors 'none'`, etc.
  Inline *styles* are still allowed: `app.js` uses `style="…"` ~150 times; moving them is Phase 4.
  HSTS is off on purpose, since the site is plain http.
- Expired sessions are deleted on the existing 6-hourly `materialise()` run (12 were waiting).
- **`GET /healthz`**: no login, runs `SELECT 1`, returns `{ ok, build }`. Used by Docker's `HEALTHCHECK` and Kuma.
- **Graceful shutdown** on SIGTERM: stop accepting, finish requests, close the pg pool, exit 0. Before, Node as
  PID 1 ignored SIGTERM, so Docker waited 10 s and then killed it.
- **Service-worker cache per build:** the cache name is a hash of the app shell, so installed phones drop the
  old `app.js`/CSS after a deploy that changed them.
- `.dockerignore` keeps `.env`, `.git` and old zips out of the build context.

### Testing
- `staging/`: a throwaway copy of the app (own project, network and volumes, `127.0.0.1:3041`) restored from a
  backup. `staging/repro-reset-demo.sh` reproduces the reset-demo bug (fails on the old image, passes on the new);
  `staging/verify.sh` runs 20 checks: health, CSP, receipts across a rebuild, pay → undo, unpay, edit without a
  date, the 429 on the 11th failed login, per-client limiting, and no SQL text in errors. A LAN-device test with a
  rotating fake `X-Forwarded-For` is still blocked on the 11th attempt.
