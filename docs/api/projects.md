# Projects API

> All project endpoints are under `/api/v1/` (INF-005). Legacy `/api/*` paths are 308-redirected.

## Create a Project

```
POST /api/v1/projects
```

**Body:**
```json
{
  "name": "My App",
  "url": "https://example.com",
  "credentials": {                // optional
    "username": "admin",
    "password": "secret"
  }
}
```

## List Projects

```
GET /api/v1/projects
```

Returns an array of all non-deleted projects.

## Get a Project

```
GET /api/v1/projects/:id
```

## Delete a Project

```
DELETE /api/v1/projects/:id
```

Soft-deletes the project and cascade soft-deletes all its tests and runs. Items are moved to the Recycle Bin and can be restored via `POST /api/v1/restore/project/:id`. Healing history and activities are preserved for audit trail. Returns 409 if a crawl or test run is in progress.

**Response:**
```json
{
  "ok": true,
  "deletedTests": 12,
  "deletedRuns": 5,
  "destroyedTokens": 2,
  "destroyedSchedule": true
}
```

::: warning
CI/CD trigger tokens and cron schedules are **permanently deleted** (not soft-deleted) because they are security credentials and active cron tasks. Restoring the project from the Recycle Bin will **not** restore these — they must be re-created manually.
:::

## Start a Crawl

```
POST /api/v1/projects/:id/crawl
```

Launches Chromium, crawls the project URL, and generates tests via the AI pipeline. Returns a run ID for tracking via SSE.

**Body (optional):**
```json
{
  "maxDepth": 3,
  "dialsConfig": { ... }
}
```

## Run Regression

```
POST /api/v1/projects/:id/run
```

Executes all approved tests for the project. Returns a run ID.

## CI/CD Trigger

```
POST /api/v1/projects/:id/trigger
```

**Auth:** `Authorization: Bearer <project-trigger-token>` (not a user JWT).

Token-authenticated endpoint for CI/CD pipelines. By default, starts a test run using the project's approved tests and returns immediately. When `triggerCrawl: true` is set, dispatches a diff-aware crawl instead (AUTO-002 + AUTO-015).

**Body (optional):**
```json
{
  "dialsConfig": { "parallelWorkers": 2 },
  "callbackUrl": "https://ci.example.com/hooks/sentri",
  "triggerCrawl": false,
  "previewUrl": "https://preview-deploy.example.com"
}
```

- `triggerCrawl` — When `true`, dispatches a diff-aware crawl (only changed pages flow through generation) instead of a regression run. The run is created with `type: "crawl"` and emits `crawl.start` / `crawl.complete` activity rows. Default: `false`.
- `previewUrl` — Optional preview-deployment URL to crawl instead of the project's canonical URL. SSRF-validated (loopback / RFC1918 rejected unless `ALLOW_PRIVATE_URLS` is set). When set, the project's production baselines are preserved; only the diff is computed and reported. Ignored when `triggerCrawl` is `false`.

**Response `202 Accepted`:**
```json
{ "runId": "RUN-42", "statusUrl": "https://sentri.example.com/api/v1/projects/PRJ-1/trigger/runs/RUN-42" }
```

Poll `statusUrl` with the same Bearer token until `status` is no longer `"running"`. If `callbackUrl` is provided, Sentri POSTs a JSON summary on any terminal state (`completed`, `failed`, or `aborted`) — best-effort, 10s timeout. The payload includes `error: null | string` so CI pipelines can distinguish success from failure.

| Error | Reason |
|---|---|
| 400 | No approved tests |
| 401 | Missing or invalid Bearer token |
| 403 | Token belongs to a different project |
| 404 | Project not found |
| 409 | Another run already in progress |
| 429 | Rate limit exceeded |

## List Trigger Tokens

```
GET /api/v1/projects/:id/trigger-tokens
```

Returns all trigger tokens for the project (token hashes are never returned).

**Response:**
```json
[
  { "id": "WH-1", "label": "GitHub Actions", "createdAt": "...", "lastUsedAt": "..." }
]
```

## Create Trigger Token

```
POST /api/v1/projects/:id/trigger-tokens
```

**Body (optional):**
```json
{ "label": "GitHub Actions" }
```

**Response `201`:**
```json
{ "id": "WH-1", "token": "<plaintext — shown once>", "label": "GitHub Actions", "createdAt": "..." }
```

::: warning
The plaintext token is returned **exactly once**. Store it securely (e.g. as a CI secret). It cannot be retrieved again.
:::

## Revoke Trigger Token

```
DELETE /api/v1/projects/:id/trigger-tokens/:tid
```

Permanently deletes the token. CI pipelines using it will fail immediately.

## Vercel Deployment Webhook

```
POST /api/v1/projects/:id/trigger/vercel
```

**Auth:** **Both** required (dual-auth):
- `Authorization: Bearer <project-trigger-token>` — proves which project should run.
- `X-Vercel-Signature: <hmac-sha1-hex>` — HMAC-SHA1 of the raw request body, keyed by `VERCEL_WEBHOOK_SECRET`. Without the secret env var set, the endpoint rejects all requests with 401.

Receives Vercel deployment-event webhooks and launches a diff-aware crawl against the deployment's preview URL when the deployment reaches READY state. Production baselines are preserved (`canonicalUrl` is retained while `url` is overridden to the preview).

**Body** (forwarded by Vercel):
```json
{
  "type": "deployment.ready",
  "deployment": { "url": "my-app-git-main-yourteam.vercel.app" }
}
```

The endpoint accepts any of:
- `type: "deployment.ready"`
- `type: "deployment.succeeded"`
- `deployment.readyState: "READY"`

Other deployment states (BUILDING, CANCELED, ERROR, …) ack 200 with `{ ignored: true }` and do **not** launch a run.

**Response `202 Accepted`:**
```json
{ "ok": true, "provider": "vercel", "runId": "RUN-42", "previewUrl": "https://my-app-git-main-yourteam.vercel.app" }
```

| Error | Reason |
|---|---|
| 200 (ignored) | Deployment not in READY state |
| 400 | `deployment.url` missing, or preview URL fails SSRF validation |
| 401 | Invalid HMAC signature, missing/invalid Bearer token |
| 409 | Another run already in progress for this project |

## Netlify Deployment Webhook

```
POST /api/v1/projects/:id/trigger/netlify
```

**Auth:** **Both** required (dual-auth):
- `Authorization: Bearer <project-trigger-token>`.
- `X-Netlify-Token: <hmac-sha256-hex>` — HMAC-SHA256 of the raw request body, keyed by `NETLIFY_WEBHOOK_SECRET`.

Same diff-aware-crawl-on-deploy behavior as the Vercel handler. Preview URL is read from `deploy_ssl_url` (preferred) or `deploy_url`.

Only fires when `state === "ready"`. Other states (`new`, `building`, `error`, `processing`, …) ack 200 with `{ ignored: true }` and do **not** launch a run — Netlify allocates the preview URL early in the deploy lifecycle, so the URL alone isn't a readiness signal.

**Body** (forwarded by Netlify):
```json
{ "state": "ready", "deploy_ssl_url": "https://deploy-preview-42--my-site.netlify.app" }
```

**Response `202 Accepted`:**
```json
{ "ok": true, "provider": "netlify", "runId": "RUN-42", "previewUrl": "https://deploy-preview-42--my-site.netlify.app" }
```

## GitHub PR Check Webhook (INT-002)

```
POST /api/v1/projects/:id/trigger/github
```

**Auth:** **Both** required (dual-auth):
- `Authorization: Bearer <project-trigger-token>` — proves which project should run.
- `X-Hub-Signature-256: sha256=<hmac-hex>` — HMAC-SHA256 of the raw request body, keyed by `GITHUB_WEBHOOK_SECRET`. Without the secret env var set, the endpoint rejects all requests with 401.

Receives GitHub webhook deliveries (PR opened / synchronized / check_suite requested) and starts a Sentri run against the PR's head SHA. When per-project PR checks are enabled in **Settings → Integrations**, Sentri also creates a native GitHub Check Run (`queued` → `in_progress` → `success` / `failure` / `neutral`) with a Markdown summary that lists **regressed tests only** (failing now, green on the base SHA's last run), quality-gate violations, and Web Vitals budget violations.

Retried webhook deliveries (same `X-GitHub-Delivery` UUID) are idempotent — the existing `checkRunId` is reused and no duplicate Sentri run is created. Distinct deliveries for the same `{ repo, sha }` (e.g. a `check_suite.rerequested` event after a user clicks "Re-run") each create a fresh Check Run.

**Body** (forwarded by GitHub, or a flat shape from custom CI):
```json
{
  "repository": { "full_name": "acme/app" },
  "pull_request": {
    "number": 42,
    "head": { "sha": "abc123…" },
    "base": { "sha": "def456…" }
  }
}
```

Flat alternative (CI scripts that don't forward the raw GitHub payload):
```json
{ "repo": "acme/app", "sha": "abc123…", "baseSha": "def456…", "prNumber": 42 }
```

**Response `202 Accepted`:**
```json
{
  "runId": "RUN-42",
  "statusUrl": "https://sentri.example.com/api/v1/projects/PRJ-1/trigger/runs/RUN-42",
  "githubCheck": { "checkRunId": 123456, "reused": false }
}
```

When the delivery is a duplicate for an in-flight run, the response carries `githubCheck.reused: true` and the existing `runId`.

| Error | Reason |
|---|---|
| 400 | No approved tests |
| 401 | Invalid HMAC signature, missing/invalid Bearer token |
| 403 | Token belongs to a different project |
| 404 | Project not found |
| 409 | Another run already in progress (different repo/SHA) |

## Last Deployment Run

```
GET /api/v1/projects/:id/last-deployment-run
```

Returns the most recent deployment-triggered crawl for this project within the last 24 hours, or `{ run: null }`. Powers the "Last deployment run" badge on the project header. Allowed for any authenticated workspace member.

**Response:**
```json
{
  "run": {
    "id": "RUN-42",
    "status": "completed",
    "startedAt": "2026-04-21T09:00:00.000Z",
    "finishedAt": "2026-04-21T09:02:14.000Z",
    "pagesFound": 10,
    "testsGenerated": 3,
    "changedPages": ["https://preview/checkout"],
    "removedPages": [],
    "provider": "vercel",
    "previewUrl": "https://my-app-git-main.vercel.app",
    "triggeredAt": "2026-04-21T09:00:00.000Z"
  }
}
```

## Get Schedule

```
GET /api/v1/projects/:id/schedule
```

Returns the current cron schedule for a project, or `null` if none exists.

**Response:**
```json
{ "schedule": { "id": "SCH-1", "projectId": "PRJ-1", "cronExpr": "0 9 * * 1", "timezone": "UTC", "enabled": true, "lastRunAt": null, "nextRunAt": "2026-04-21T09:00:00.000Z", "createdAt": "...", "updatedAt": "..." } }
```

## Create or Update Schedule

```
PATCH /api/v1/projects/:id/schedule
```

**Body:**
```json
{
  "cronExpr": "0 9 * * 1",
  "timezone": "America/New_York",
  "enabled": true
}
```

- `cronExpr` — 5-field cron expression (required). 6-field (with seconds) is rejected.
- `timezone` — IANA timezone name (default `"UTC"`).
- `enabled` — Whether the schedule is active (default `true`).

**Response:**
```json
{ "ok": true, "schedule": { ... } }
```

| Error | Reason |
|---|---|
| 400 | Missing or invalid `cronExpr`, or 6-field expression |
| 404 | Project not found |

## Delete Schedule

```
DELETE /api/v1/projects/:id/schedule
```

Removes the cron schedule and cancels the running cron task.

| Error | Reason |
|---|---|
| 404 | Project not found, or no schedule exists |
