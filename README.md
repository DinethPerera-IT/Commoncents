# CommonCents

A mobile-first shared-household expense-splitting and bill-tracking app: weekly rent,
shared expenses with equal/custom/percentage splits, a prepaid fibre account, and a
group settle-up flow — deployed and running on my homelab.

Part of [homelab-infrastructure](https://github.com/DinethPerera-IT/homelab-infrastructure).

## Authorship

**The initial working version of this app — the schema, the auth system, the core split/
balance/settlement math, and the frontend — was built by a university teammate** as part
of a related team project.

**My contribution, on top of that starting point:**
- Deployed it to the homelab: Docker, Postgres, reverse-proxied via Caddy behind a
  Pi-hole-backed hostname.
- Diagnosed and fixed two genuine backend bugs found during testing (see below).
- Designed and built three feature additions from scratch, verified against a live
  database before deployment: full edit/delete support for every record type (expenses,
  bills, settlements, prepaid top-ups/usage), a corrected "reset demo data" flow, and a
  complete activity-log/undo system.
- Upgraded and hardened the running deployment (see `CHANGELOG.md`): Node 24, Express 5,
  multer 2, reproducible `npm ci` builds; a login rate limit that can't be dodged with a
  fake `X-Forwarded-For`; security headers with a Content-Security-Policy; a `/healthz`
  endpoint with Docker healthchecks; clean shutdown on `docker compose up -d`; and a
  throwaway staging copy (`staging/`) for testing changes against a backup of the real
  database before they touch the live app.

This split is reflected honestly here rather than presented as a solo build — see
`server/activity.js` and the edit/delete endpoints throughout `server/index.js` for the
part that's mine.

## What it does

- Weekly rent tracking per flatmate, with a live-updating balance view
- Shared expenses with equal, custom-dollar, or percentage splits
- A shared prepaid fibre/broadband account (top-ups and usage, allocated to flatmates)
- Recurring bills with a "mark as paid" flow that auto-generates the corresponding
  shared expense
- A settle-up screen showing exactly who owes who, and by how much
- Full edit and delete on every record type
- A complete activity log with undo — every create/edit/delete can be reversed, including
  correctly restoring child rows (e.g. an expense's splits) and reversing side effects
  (e.g. undoing a bill payment also removes the expense it generated)

## Real bugs found and fixed (via live database testing, not just code review)

1. **PostgreSQL `DATE` columns come back as JS `Date` objects, not strings.** The first
   version of the new edit endpoints fell back to the existing date value with
   `String(existing.some_date).slice(0, 10)` when no new date was supplied — but
   `String(Date)` produces `"Tue Sep 01 2026"`, not an ISO date, so the format validation
   always failed. Fixed with a `toISODate()` helper used everywhere an edit endpoint
   reads an existing date value.

2. **Foreign key ordering bug in the "revert a paid bill" action**, present in **two
   separate places**: the dedicated `/api/bills/:id/unpay` route, and the generic undo
   dispatch in `activity.js` for `entity_type: 'bill'`. Both originally deleted the
   linked expense *before* clearing `bills.expense_id`, which Postgres correctly rejected
   with a foreign-key violation since the bill row still referenced that expense at the
   moment of deletion. Fixed in both places by reversing the order: clear the reference
   first, then delete the expense.

3. **"Reset demo data" could fail, or leave demo money behind.** Paying a demo bill
   creates its expense as *real* data, so the reset removed the bill but kept the payment
   in everyone's balances. And a real bill paid with a demo expense made the reset hit the
   same foreign key as bug 2, failing halfway and showing the raw SQL error in the browser.
   Reproduced on a staging copy of the live database first, then fixed: one transaction,
   references cleared before deletes, and SQL errors are no longer sent to the client.

All three were caught by running the actual sequence (pay a bill → undo it) against a real
database before deployment, not by reading the code and assuming it worked.

## Running it

```bash
cp .env.example .env   # set real secrets — see the note below
docker compose up -d --build
docker compose logs -f app   # expect "CommonCents listening on :3040 (build …)"
curl -s localhost:3040/healthz   # {"ok":true,...}: the app and its database are up
```

- Receipts live in the `app_data` volume and survive rebuilds; the database in `db_data`.
- The app listens on port 3040 (home network); Caddy can proxy a local hostname to it.
- **Test a change first:** `staging/up.sh` starts a separate copy on `127.0.0.1:3041`,
  restored from the newest backup in `~/backups/commoncents`; `staging/verify.sh` runs the
  checks. Remove it with `docker compose -f staging/compose.yml down -v`.

⚠️ The demo/seed password and DB credentials must be changed from the `.env.example`
placeholders before any real use — the values that shipped during initial development
were briefly visible in plain text while debugging and should be treated as permanently
compromised, never reused.

## Stack

Node.js 24 · Express 5 · PostgreSQL 16 · vanilla JS (PWA, installable, offline-capable via
`sw.js`) · Docker

## Status

Active — deployed and in real use on the homelab.
