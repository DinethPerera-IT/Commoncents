# Design-phase validation

Validated 3 November 2026 (Pacific/Auckland) on `feature/utilities-design-drafts`.

- ZIP comparison: 36 files compared byte-for-byte; no differences from repository baseline `bb9225a`.
- `npm run test:all`: **42 passed, 0 failed, 0 skipped**, PostgreSQL 16 and Node 24 in disposable Docker containers. Log: `/tmp/commoncents-draft-tests.log` (current workspace only).
- Chromium / Playwright preview checks: **101 assertions passed**, no browser JavaScript errors, no `/api/` calls.
- All three options checked for required five views; keyboard Space/Enter password reveal/hide, accessible toggle state, value preservation, no toggle submission, Enter sign-in, equal cent allocation, percentage/custom inputs and invalid totals, payer accounting, successful sample recording, disabled duplicate submission, history filtering, usage credit validation.
- Page overflow and sign-in panel overflow checked at widths 320, 390, 768, 1024, 1440. Desktop study intentionally scrolls within its own container on phones. A narrow layout overflow found during review was corrected and the full browser checks rerun successfully.
- Fifteen individual screenshots and three complete comparison boards rendered in Chromium at a 1740px comparison viewport; individual phone frames are approximately 398px wide. All three boards visually inspected. All previews use the same fictional data.
- Production application source is unchanged; no migration was created or applied. No live household database was contacted. No merge, push, or production deployment was performed.

The existing suite protects baseline application behaviour; it does **not** validate the future combined utilities implementation. Full new migration/accounting tests, real browser workflows across every screen, Docker build verification and production before/after comparisons follow design selection. The earlier setup health check passed; it is not evidence of a new redesigned application running.

## Reproduce preview checks

Use a temporary tooling directory, without changing CommonCents dependencies:

```bash
npm install --prefix /tmp/commoncents-browser --cache /tmp/commoncents-npm-cache playwright
python -m http.server 8765 --bind 127.0.0.1 --directory design/utilities-drafts
# In another terminal, from the repository root:
PLAYWRIGHT_MODULE=/tmp/commoncents-browser/node_modules/playwright node design/utilities-drafts/verify.cjs
PLAYWRIGHT_MODULE=/tmp/commoncents-browser/node_modules/playwright node design/utilities-drafts/render.cjs
```

The scripts use installed `/usr/bin/chromium`. `PREVIEW_BASE_URL` can select another local preview server. This static server is for internal checks; review the supplied PNGs or open the self-contained HTML artifact directly. Do not install the preview as the production app or copy fixtures into production data.
