# CI/CD Triggers

Sentri can be triggered directly from your CI/CD pipeline so regression tests run automatically on every push, merge, or deployment.

## How It Works

1. **Create a trigger token** — one per project, from the **Automation** page (sidebar → Automation, or ⚡ button in ProjectHeader).
2. **`POST /api/v1/projects/:id/trigger`** with the token as a Bearer header — returns `202 Accepted` immediately with `{ runId, statusUrl }`.
3. **Poll `statusUrl`** until `status` is no longer `"running"`.
4. Optionally pass a `callbackUrl` in the request body to receive a POST with the run summary when it finishes.

## Creating a Token

Navigate to **Automation** in the sidebar → expand your project card → **New token**. You can also reach this from any project's detail page via the ⚡ **Automation** button in the header.

The plaintext token is shown **exactly once**. Copy it and store it as a CI secret (e.g. `SENTRI_TOKEN`). Only the SHA-256 hash is stored in the database — the plaintext cannot be retrieved again.

::: warning
Treat trigger tokens like passwords. Never commit them to your repository.
:::

## Token Management

| Action | Endpoint | Auth |
|---|---|---|
| List tokens | `GET /api/v1/projects/:id/trigger-tokens` | JWT (user session) |
| Create token | `POST /api/v1/projects/:id/trigger-tokens` | JWT (user session) |
| Revoke token | `DELETE /api/v1/projects/:id/trigger-tokens/:tid` | JWT (user session) |

Token management endpoints require a normal user session (JWT). Only the trigger endpoint itself accepts Bearer tokens.

## Trigger Endpoint

```
POST /api/v1/projects/:id/trigger
Authorization: Bearer <token>
Content-Type: application/json

{
  "dialsConfig": { "parallelWorkers": 2 },
  "callbackUrl": "https://ci.example.com/hooks/sentri"
}
```

**Response `202 Accepted`:**

```json
{ "runId": "RUN-42", "statusUrl": "https://sentri.example.com/api/v1/projects/PRJ-1/trigger/runs/RUN-42" }
```

### Error Codes

| Code | Reason |
|---|---|
| 400 | No approved tests — crawl and approve tests first |
| 401 | Missing or invalid Bearer token |
| 403 | Token belongs to a different project |
| 404 | Project not found |
| 409 | Another run already in progress |
| 429 | Rate limit exceeded |

## GitHub Actions Example

The example below also enforces **quality gates** (AUTO-012): if the project has gates configured (e.g. `minPassRate: 95`), the trigger status response includes `gateResult.passed`, and the workflow exits non-zero when gates fail — even if every test technically completed. Configure gates from the **Settings** tab on the project page (see [Quality Gates](#quality-gates) below).

```yaml
# .github/workflows/sentri.yml
name: Sentri regression

on:
  push:
    branches: [main]

jobs:
  sentri:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger Sentri test run
        id: trigger
        run: |
          response=$(curl -sf -X POST \
            -H "Authorization: Bearer ${{ secrets.SENTRI_TOKEN }}" \
            -H "Content-Type: application/json" \
            "https://your-sentri-instance.com/api/v1/projects/PRJ-1/trigger")
          echo "run_id=$(echo $response | jq -r .runId)" >> $GITHUB_OUTPUT
          echo "status_url=$(echo $response | jq -r .statusUrl)" >> $GITHUB_OUTPUT

      - name: Wait for run to complete and enforce quality gates
        run: |
          status_url="${{ steps.trigger.outputs.status_url }}"
          for i in $(seq 1 60); do
            payload=$(curl -sf \
              -H "Authorization: Bearer ${{ secrets.SENTRI_TOKEN }}" \
              "$status_url")
            status=$(echo "$payload" | jq -r .status)
            echo "Run status: $status"
            [ "$status" != "running" ] && break
            sleep 10
          done

          # 1. Run-level status — fail the build on any non-completed state.
          if [ "$status" != "completed" ]; then
            echo "::error::Run finished with status=$status"
            exit 1
          fi

          # 2. Quality gates (AUTO-012) — gateResult is null when the project
          #    has no gates configured, in which case we don't enforce anything.
          gate_passed=$(echo "$payload" | jq -r '.gateResult.passed // "null"')
          if [ "$gate_passed" = "false" ]; then
            echo "::error::Quality gate failed:"
            echo "$payload" | jq -r '.gateResult.violations[] |
              "  - \(.rule): actual \(.actual) vs threshold \(.threshold)"'
            exit 1
          fi

          # 3. Web Vitals budgets (AUTO-017) — webVitalsResult is null when the
          #    project has no budgets configured, in which case we don't enforce.
          vitals_passed=$(echo "$payload" | jq -r '.webVitalsResult.passed // "null"')
          if [ "$vitals_passed" = "false" ]; then
            echo "::error::Web Vitals budget failed:"
            echo "$payload" | jq -r '.webVitalsResult.violations[] |
              "  - \(.rule | ascii_upcase) on \(.testName // .testId): actual \(.actual) vs threshold \(.threshold)"'
            exit 1
          fi
          echo "Run completed; quality gates and Web Vitals budgets passed."
```

## GitLab CI Example

```yaml
# .gitlab-ci.yml
sentri:
  stage: test
  script:
    - |
      response=$(curl -sf -X POST \
        -H "Authorization: Bearer $SENTRI_TOKEN" \
        -H "Content-Type: application/json" \
        "https://your-sentri-instance.com/api/v1/projects/PRJ-1/trigger")
      STATUS_URL=$(echo $response | jq -r .statusUrl)
      for i in $(seq 1 60); do
        PAYLOAD=$(curl -sf \
          -H "Authorization: Bearer $SENTRI_TOKEN" \
          "$STATUS_URL")
        STATUS=$(echo "$PAYLOAD" | jq -r .status)
        echo "Run status: $STATUS"
        [ "$STATUS" != "running" ] && break
        sleep 10
      done
      [ "$STATUS" = "completed" ] || exit 1
      # AUTO-012: enforce quality gates when configured.
      GATE_PASSED=$(echo "$PAYLOAD" | jq -r '.gateResult.passed // "null"')
      if [ "$GATE_PASSED" = "false" ]; then
        echo "Quality gate failed:"
        echo "$PAYLOAD" | jq -r '.gateResult.violations[] |
          "  - \(.rule): actual \(.actual) vs threshold \(.threshold)"'
        exit 1
      fi
      # AUTO-017: enforce Web Vitals budgets when configured.
      VITALS_PASSED=$(echo "$PAYLOAD" | jq -r '.webVitalsResult.passed // "null"')
      if [ "$VITALS_PASSED" = "false" ]; then
        echo "Web Vitals budget failed:"
        echo "$PAYLOAD" | jq -r '.webVitalsResult.violations[] |
          "  - \(.rule | ascii_upcase) on \(.testName // .testId): actual \(.actual) vs threshold \(.threshold)"'
        exit 1
      fi
```

## cURL (Direct)

```bash
curl -X POST \
  -H "Authorization: Bearer <YOUR_TOKEN>" \
  -H "Content-Type: application/json" \
  "https://your-sentri-instance.com/api/v1/projects/PRJ-1/trigger"
```

## Callback URL

Pass `callbackUrl` in the trigger request body to receive a POST when the run finishes:

```json
{
  "callbackUrl": "https://ci.example.com/hooks/sentri"
}
```

Sentri will POST a JSON summary on **any terminal state** (completed, failed, or aborted) — best-effort, 10s timeout:

```json
{
  "runId": "RUN-42",
  "status": "completed",
  "passed": 14,
  "failed": 1,
  "total": 15,
  "error": null,
  "gateResult": {
    "passed": false,
    "violations": [
      { "rule": "minPassRate", "threshold": 95, "actual": 93.33 }
    ]
  },
  "webVitalsResult": {
    "passed": false,
    "violations": [
      { "rule": "lcp", "threshold": 2500, "actual": 3100, "testId": "TST-7", "testName": "Home page loads" }
    ]
  }
}
```

On failure, `status` will be `"failed"` and `error` will contain a human-readable message. On abort, `status` will be `"aborted"`. `gateResult` is `null` when the project has no quality gates configured (see below). `webVitalsResult` is `null` when the project has no Web Vitals budgets configured (see [Web Vitals Budgets](#web-vitals-budgets)).

## Quality Gates

AUTO-012 lets you enforce per-project deploy-blocking thresholds without writing custom CI logic. Configure them under **Project → Settings → Quality Gates**; the form takes any subset of:

| Field | Range | Meaning |
|---|---|---|
| `minPassRate` | 0–100 (%) | Run fails when pass rate drops below this. |
| `maxFlakyPct` | 0–100 (%) | Run fails when flaky percentage exceeds this. |
| `maxFailures` | integer ≥ 0 | Run fails when total failures exceed this. |

On every test run, the backend evaluates the configured gates and persists the result on the run record. The trigger status response and the optional `callbackUrl` payload both include a `gateResult` field:

```json
"gateResult": {
  "passed": false,
  "violations": [
    { "rule": "minPassRate", "threshold": 95, "actual": 90 }
  ]
}
```

- `gateResult: null` — no gates configured. CI should treat as "no enforcement" (legacy projects unaffected).
- `gateResult.passed === true` — all configured thresholds met.
- `gateResult.passed === false` — at least one violation; `violations[]` lists every failed rule with its threshold and the actual measured value.

The CI examples above already enforce this: when `gateResult.passed === false` the workflow exits non-zero, blocking the deploy. When the project has no gates, the same scripts treat the run as a pure pass/fail based on `status` alone.

::: tip
You can set gates conservatively (e.g. `minPassRate: 95`, `maxFailures: 0`) for `main` and tune them per-environment by running separate Sentri projects against staging vs. production URLs.
:::

## Web Vitals Budgets

AUTO-017 adds per-project performance budgets enforced from CI alongside `gateResult`. Sentri injects the [`web-vitals`](https://github.com/GoogleChrome/web-vitals) library at capture time and records LCP, CLS, INP, and TTFB on every captured page during a run. Configure budgets under **Automation → \[your project\] → Web Vitals Budgets** (or via `PATCH /api/v1/projects/:id/web-vitals-budgets`); the form takes any subset of:

| Field | Unit | Meaning |
|---|---|---|
| `lcp` | milliseconds | Largest Contentful Paint — fail when any captured page exceeds this. |
| `cls` | unitless (0–1) | Cumulative Layout Shift — fail when any captured page exceeds this. |
| `inp` | milliseconds | Interaction to Next Paint — fail when any captured page exceeds this. |
| `ttfb` | milliseconds | Time To First Byte — fail when any captured page exceeds this. |

On every test run, the backend evaluates the configured budgets against the captured metrics and persists the result on the run record. The trigger status response and the optional `callbackUrl` payload both include a `webVitalsResult` field:

```json
"webVitalsResult": {
  "passed": false,
  "violations": [
    { "rule": "lcp", "threshold": 2500, "actual": 3100, "testId": "TST-7", "testName": "Home page loads" }
  ]
}
```

- `webVitalsResult: null` — no budgets configured. CI should treat as "no enforcement" (legacy projects unaffected).
- `webVitalsResult.passed === true` — every captured page met every configured threshold.
- `webVitalsResult.passed === false` — at least one violation; `violations[]` lists every offending metric with the test it came from, the configured threshold, and the actual measured value.

The CI examples above already enforce this: when `webVitalsResult.passed === false` the workflow exits non-zero, blocking the deploy. When the project has no budgets, the same scripts treat the run as a pure pass/fail based on `status` + `gateResult` alone.

::: tip
Budgets compose with quality gates — a run can pass functional gates (`gateResult.passed === true`) but still fail on performance (`webVitalsResult.passed === false`). Both fields are independent; CI should check both.
:::

::: warning INP can be `null` for non-interactive tests
LCP, CLS, and TTFB are recorded reliably for every captured page because their `PerformanceObserver` reads buffered entries that the browser has already collected by the time the `web-vitals` library is injected. **INP** (Interaction to Next Paint), however, is only emitted after a user interaction (click / keypress / tap) occurs *during* the observation window — so tests that end on an assertion, navigation, or `waitForLoadState` without a final interaction will record `inp: null`. This is a Playwright-environment characteristic, not a Sentri bug. The evaluator skips `null` metrics (treats them as "not measured" rather than "0"), so an `inp` budget on an assertion-ending test is silently ignored rather than falsely passing or failing. If you need INP enforcement, ensure the test has at least one interaction (e.g. `page.click(...)`) before its final assertion.
:::

## Security Notes

- Tokens are stored as **SHA-256 hashes** — the plaintext is never persisted.
- Tokens are **project-scoped** — a token for Project A cannot trigger Project B.
- When a project is deleted, all its trigger tokens are **immediately hard-deleted** (not soft-deleted).
- The trigger endpoint is rate-limited by the `expensiveOpLimiter` (20 req/hr per IP).
