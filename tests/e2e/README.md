# Sentri E2E (Playwright)

## Scope

**UI-only for ✅ rows.** Every flow a real user touches via the browser is automated through `--project=ui-chromium` (Playwright `page` fixture, real DOM, role-based selectors). API specs in this suite are **scaffolding** — they pre-seed fixtures (registered users, approved tests, etc.) so the UI test can jump straight to the page under test. They never close a coverage row by themselves. See [`COVERAGE.md`](./COVERAGE.md) § UI-only policy for the rule, and the per-row matrix for what's UI-driven (✅) vs. still missing (🟥/🟨).

Files in `specs/` today:
- `ui-smoke.spec.mjs` — UI: login route renders + invalid-credentials error state
- `api-auth.spec.mjs` — scaffolding: registration, verification, login negative path
- `full-functional-api.spec.mjs` — scaffolding: project + test CRUD + approval + session security (CSRF / logout revocation)
- `functional-areas.spec.mjs` — scaffolding: crawl, generate, recorder, run-all, AI fix, AI chat endpoint contracts

The scaffolding specs run alongside the UI suite and have value for fixture seeding + endpoint smoke, but they don't substitute for `expect(page.…)` assertions against the rendered DOM. New user-facing PRs must add a UI spec under `specs/<area>-ui.spec.mjs` per [`REVIEW.md`](../../REVIEW.md) § Mandatory Test Requirements.

> For **manual** end-to-end validation (Golden E2E happy path + per-feature happy paths and negatives), see [`QA.md`](../../QA.md) at the repo root. The Playwright suite below is the automated complement — both should pass before release.

## Run
From repo root:

```bash
npx --prefix backend playwright test -c tests/e2e/playwright.config.mjs
node tests/e2e/generate-report.mjs
```

UI-only run:

```bash
RUN_UI_E2E=true npm run e2e:test -- --project=ui-chromium
```

## Environment
- `E2E_BACKEND_URL` (default `http://127.0.0.1:3001`)
- `E2E_FRONTEND_URL` (default `http://127.0.0.1:4173`)

If frontend is unavailable, UI specs will auto-skip and API specs still run.

## CI
- `.github/workflows/ci.yml` now includes a dedicated **UI E2E — Playwright smoke (Chromium)** job.
- The job provisions Chromium, boots backend/frontend, and runs `ui-chromium` project with `RUN_UI_E2E=true`.

## Coverage & Backlog

What's automated vs. still manual lives in [`COVERAGE.md`](./COVERAGE.md) — single source of truth, mirrors `QA.md`'s Golden E2E Happy Path (51 steps) and per-feature flows. Read it before adding a new spec; pick the top **Backlog** item; flip the matching row from 🟥 / 🟨 to ✅ in the same PR. The backfill queue itself is tracked as `MNT-012 — E2E coverage backfill` in `ROADMAP.md`.
