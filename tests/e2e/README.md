# Sentri E2E (Playwright)

## Scope
This suite validates:
- API auth + verification lifecycle
- API full functional flow (project + test CRUD + approval)
- API negative validations for project/test payloads
- UI login-route smoke checks (when frontend is reachable)

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
