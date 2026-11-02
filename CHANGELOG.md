# Changelog

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
- **Port 3040 is published on 127.0.0.1 only.** Caddy runs on the host, so it still reaches the app; the LAN and
  tailnet can't go around Caddy any more. Uptime Kuma checks through Caddy instead (see README).
- **Login rate limit:** 10 failed attempts per 15 minutes per client IP (`express-rate-limit`). Successful
  logins don't count. `trust proxy` = loopback + private ranges, because Caddy's requests arrive from the
  Docker bridge gateway; that's only safe because of the loopback-only port.
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
  date, the 429 on the 11th failed login, per-client limiting, and no SQL text in errors.
