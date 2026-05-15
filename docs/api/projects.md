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


## GitHub App Integration

### Start GitHub App Install

```
GET /api/v1/integrations/github/install/start/:projectId
```

**Auth:** admin JWT. Returns a GitHub App installation URL containing a 10-minute, one-shot `state` token bound to the project. The Settings Integrations tab redirects admins to this URL; operators no longer need to paste numeric installation IDs manually.

**Response:**
```json
{ "url": "https://github.com/apps/sentri/installations/new?state=..." }
```

### GitHub App Install Callback

```
GET /api/v1/integrations/github/install/callback?installation_id=<id>&setup_action=install&state=<jwt>
```

**Auth:** Signed one-shot `state` JWT (issued by `GET /install/start/:projectId` to authenticated admins). No browser cookie or Bearer token is required — and would not work, because GitHub's cross-site redirect does not carry `SameSite=Strict` cookies. The state token is nonce-tracked (replay-proof), signed with `JWT_SECRET` (unforgeable), and binds a specific project + originating admin captured at `/install/start`. Verifies the state, fetches the repositories selected for the installation, then enables PR checks for the bound project with the first selected `owner/repo` and the returned `installation_id`. Browser requests redirect back to Settings; API clients that send `Accept: application/json` receive the updated settings payload.

### GitHub App Webhook `[no-ui]`

```
POST /api/v1/integrations/github/app-webhook
```

**Auth:** GitHub HMAC only — `X-Hub-Signature-256` using `GITHUB_WEBHOOK_SECRET` over the raw request body. This endpoint is machine-only because App-level lifecycle events do not carry a project trigger token.

Handled events:

- `installation.deleted` disables every `github_check_settings` row matching the installation and logs `integration.github.disabled` per affected project.
- `installation_repositories.removed` disables only rows matching the removed `owner/repo` values for the installation.
- `installation.created`, `installation.suspend`, and `installation.unsuspend` are logged for existing rows and otherwise leave settings unchanged; admins explicitly re-enable projects from Settings.

### Install-state replay protection

The one-shot `state` JWT minted by `GET /install/start/:projectId` is nonce-tracked to prevent replay attacks. When `REDIS_URL` is configured, nonces live in Redis with a 10-minute TTL and are shared across replicas — the canonical configuration for multi-instance deployments. When Redis is unavailable, Sentri falls back to a process-local `Map`; this is safe for single-replica / dev setups but logs a one-shot warning at boot because an attacker who captures a callback URL could potentially replay it against a different replica. **Provision Redis (`REDIS_URL`) for any multi-instance production deployment.**

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
  "previewUrl": "https://preview-deploy.example.com",
  "changedFiles": ["src/checkout/CartPage.tsx"],
  "routeMap": { "src/components/CheckoutButton.tsx": ["/checkout"] }
}
```

- `triggerCrawl` — When `true`, dispatches a diff-aware crawl (only changed pages flow through generation) instead of a regression run. The run is created with `type: "crawl"` and emits `crawl.start` / `crawl.complete` activity rows. Default: `false`.
- `previewUrl` — Optional preview-deployment URL to crawl instead of the project's canonical URL. SSRF-validated (loopback / RFC1918 rejected unless `ALLOW_PRIVATE_URLS` is set). When set, the project's production baselines are preserved; only the diff is computed and reported. Ignored when `triggerCrawl` is `false`.
- `changedFiles` — Optional git diff file list for AUTO-004 impact analysis. When supplied (or when the GitHub webhook can fetch PR files), Sentri maps files to URL routes and runs only impacted approved tests. Empty or absent arrays keep the current full-suite behaviour; unknown docs/config/migration-only diffs mark approved tests as `status: "skipped"` with `skipReason: "skipped_no_impact"` instead of running the full suite.
- `routeMap` — Optional file-to-route override object for monorepos or shared component folders, e.g. `{ "src/components/CheckoutButton.tsx": ["/checkout"] }`.

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

When `pull_request.number` / `prNumber` is present and the project has a GitHub App `installationId`, Sentri fetches `GET /repos/{owner}/{repo}/pulls/{number}/files` best-effort and persists the normalized file list on `run.changedFiles`. GitHub API failures are logged and fall back to the full suite; they never block a run.

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


### POST /api/v1/tests/:testId/fixtures
Upload fixture data for a test version. Body: `{ format: "csv"|"json", csvText?: string, rows?: object[], iterationCap?: number }`.

### GET /api/v1/tests/:testId/fixtures
Returns fixture history for the test, newest version first.

## Environment management (DIF-012, partial)

### Overview — one project, many URLs

A project carries a canonical `url` (typically production). To target the same approved test suite against additional URLs (staging, preprod, dev, per-developer preview), create an **environment** under the project rather than a second project. Each environment carries:

- `name` — unique within the project (DB-enforced via `UNIQUE(projectId, name)` in migration `024_environments.sql`).
- `baseUrl` — overrides `project.url` at run time only.
- `credentials` *(optional)* — `{ username, password, ...selectors }`. `username` / `password` are AES-GCM encrypted at rest; selector fields are stored as plaintext. **Note:** env credentials are persisted but **not yet consumed by the crawler/runner auth flow** — for now the project's own credentials are still used for login. Wiring env creds into auth is tracked as remaining DIF-012 work.

`project.url` is never mutated by an env-scoped run. The runner receives a per-run shallow copy `{ ...project, url: environment.baseUrl, canonicalUrl: project.url }`, so the diff-aware baseline guard in `crawler.js` correctly skips replacing production baselines when running against a non-canonical URL.

Runs persist their resolved `environmentId` (column added by migration `024`), so run history shows which environment each run targeted.

### When to use environments vs. separate projects

- **Same app, different URL / credentials** → environments. Shared approved tests, shared run history filtered by env.
- **Different app entirely** → separate project. Tests are project-scoped.

### `GET /api/v1/projects/:id/environments`
Returns environments for a project (`qa_lead+`).

### `POST /api/v1/projects/:id/environments`
Creates environment (`admin`):

```json
{ "name": "staging", "baseUrl": "https://staging.example.com", "credentials": { "username": "qa", "password": "secret" } }
```

### `PATCH /api/v1/projects/:id/environments/:environmentId`
Updates `name`, `baseUrl`, or `credentials` (`admin`).

### `DELETE /api/v1/projects/:id/environments/:environmentId`
Deletes an environment (`admin`).

### Run payload
`POST /api/v1/projects/:id/run`, `POST /api/v1/projects/:id/crawl`, and `POST /api/v1/projects/:id/trigger` accept optional:

```json
{ "environmentId": "ENV-..." }
```

When provided, the run executes against the selected environment `baseUrl` only for that run; `project.url` remains unchanged in the DB. Cross-project or unknown `environmentId` values return `400 invalid environmentId`.


### Run sharding (CAP-002)

`POST /api/v1/projects/:id/run` and `POST /api/v1/projects/:id/trigger` accept optional `shards` (integer). The server clamps to `[1, MAX_WORKERS]`; default is `1`.

**Body excerpt:**
```json
{ "shards": 4 }
```

`shards: N > 1` fans the run out across `N` BullMQ workers when Redis is available — each shard executes a contiguous slice of the dispatched test queue using the same Playwright `--shard=N/M` algorithm (first `total % N` shards receive +1 test). When Redis is not available, the run falls back to the in-process partition with the same slice math but executes sequentially within one worker.

`shards` is decoupled from `dialsConfig.parallelWorkers`: `shardCount` reflects the number of cross-process partitions and only persists `> 1` when the caller explicitly requested sharding, while `parallelWorkers` controls in-process concurrency inside each shard. A run with `shards: 4` and no `dialsConfig` runs 4 shards × 1 worker each. A run with `shards: 4, dialsConfig.parallelWorkers: 2` runs 4 shards × 2 workers each.

**Response shape** is unchanged. Sharded runs surface progress via the `shardCount` and `shardsCompleted` fields on `GET /api/v1/runs/:runId`; the UI renders a "Shards M/N" badge that progresses as each shard finishes. Aggregate `passed` / `failed` / `total` columns compose atomically across shards.

**Per-shard trace artifacts:** sharded runs emit one Playwright trace zip per shard at `/artifacts/traces/${runId}/shard-${shardIndex}.zip`. The full URL list is persisted as a sparse JSON array on `run.tracePaths[]` (each slot is the shard's artifact URL or `null` when a shard never produced a trace). `RunDetail` renders a per-shard dropdown when `tracePaths.length > 1`; single-shard runs continue to use the legacy flat layout `/artifacts/traces/${runId}.zip` and the `run.tracePath` column for bit-for-bit zero regression.

**Abort behaviour:** `POST /api/v1/runs/:runId/abort` cancels every shard worker on the local replica via the in-process registry, then publishes to the `sentri:run-abort` Redis channel so sibling replicas drain their workers within one Redis round-trip. The first shard to crash mid-execution writes the failure reason atomically (predicate `WHERE status = 'running'`) — second-place shards become clean no-ops and the audit trail keeps the first crasher's classified error.

**Finalization handoff:** the BullMQ shard whose `incrementShardsCompleted` UPDATE crosses the `shardCount` boundary is the single finalizer per run. It evaluates quality gates + Web Vitals against the full results array, runs the AI feedback loop exactly once, transitions status to `completed` via a first-writer-wins UPDATE that catches the late-abort race, emits the single `done` SSE event, and POSTs the optional `callbackUrl` for trigger-path runs. SQL row-locking is the linearization point — no JS-side mutex required.

**CI/CD callbackUrl on sharded runs:** when `shards: N > 1` is combined with `callbackUrl` on a trigger run, the callback POSTs exactly once with the same payload shape as single-shard runs (`runId`, `status`, `passed`, `failed`, `total`, `error`, `gateResult`, `webVitalsResult`).

- Added `run.rootCauses[]` to `GET /api/v1/runs/:runId` response: `{ fingerprint, affectedTestIds[], sharedUrl, sharedSelector, errorPattern, size }`.
