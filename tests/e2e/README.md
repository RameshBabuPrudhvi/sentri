# Sentri E2E (Playwright)

## Scope
This suite validates:
- API auth happy/negative paths
- UI login-route smoke checks (when frontend is reachable)

## Run
From repo root:

```bash
npx --prefix backend playwright test -c tests/e2e/playwright.config.mjs
node tests/e2e/generate-report.mjs
```

## Environment
- `E2E_BACKEND_URL` (default `http://127.0.0.1:3001`)
- `E2E_FRONTEND_URL` (default `http://127.0.0.1:4173`)

If frontend is unavailable, UI specs will auto-skip and API specs still run.
