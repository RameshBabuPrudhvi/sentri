# Environment Variables

Complete reference for all backend and frontend env vars.
Only `JWT_SECRET` and one AI provider key are required to get started — everything else has sensible defaults.

## Backend (`backend/.env`)

### Telemetry (DIF-013)

Anonymous opt-out telemetry via PostHog. All variables are optional; telemetry is a no-op unless `POSTHOG_API_KEY` is set.

> **Posture:** Sentri is self-hosted, so telemetry follows the posture of
> tools like Next.js / Vite / Playwright: **effectively opt-in** (no
> `POSTHOG_API_KEY` → zero network traffic, zero events, zero `data/`
> cache writes) with an **opt-out signal** (`SENTRI_TELEMETRY=0` or
> `DO_NOT_TRACK=1`) for operators who *do* configure a key but want to
> disable collection per-deployment. There is no in-product banner or
> first-run consent prompt — telemetry cannot start without the operator
> explicitly providing an API key, which is itself the consent signal.
> If you need a consent banner for end-user-facing deployments, file an
> issue against DIF-013; the telemetry module's opt-out branches are
> already exposed so a UI-level gate is additive work.

| Variable | Default | Description |
| --- | --- | --- |
| `POSTHOG_API_KEY` | _(unset)_ | PostHog project API key. When unset, `trackTelemetry()` is a no-op regardless of other settings. |
| `POSTHOG_HOST` | `https://us.i.posthog.com` | PostHog ingestion host. Override for self-hosted PostHog or EU region (`https://eu.i.posthog.com`). |
| `SENTRI_TELEMETRY` | `1` | Set to `0` to disable telemetry entirely (overrides `POSTHOG_API_KEY`). |
| `DO_NOT_TRACK` | `0` | Industry-standard opt-out signal. Set to `1` to disable telemetry. Equivalent to `SENTRI_TELEMETRY=0`. |

The distinct ID sent to PostHog is `sha256(hostname|cwd)` — no usernames, emails, or full URLs are transmitted. URL properties are reduced to the domain hostname before send. All values are read at process start; restart the backend after changing them.

### AI Provider

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | auto-detect | Force: `anthropic`, `openai`, `google`, `openrouter`, or `local` |
| `ANTHROPIC_API_KEY` | — | [console.anthropic.com](https://console.anthropic.com) |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Override Anthropic model |
| `OPENAI_API_KEY` | — | [platform.openai.com](https://platform.openai.com/api-keys) |
| `OPENAI_MODEL` | `gpt-4o-mini` | Override OpenAI model |
| `GOOGLE_API_KEY` | — | [aistudio.google.com](https://aistudio.google.com/apikey) |
| `GOOGLE_MODEL` | `gemini-2.5-flash` | Override Google model |
| `OPENROUTER_API_KEY` | — | [openrouter.ai/keys](https://openrouter.ai/keys) — unified gateway to 200+ models |
| `OPENROUTER_MODEL` | `openrouter/auto` | OpenRouter model slug (e.g. `anthropic/claude-3.5-sonnet`, `meta-llama/llama-3.1-70b-instruct`) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Override for self-hosted / proxy deployments |
| `OPENROUTER_REFERER` | `https://sentri.dev` | `HTTP-Referer` header sent to OpenRouter for leaderboard attribution (optional) |
| `OPENROUTER_APP_TITLE` | `Sentri` | `X-Title` header sent to OpenRouter for leaderboard attribution (optional) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `mistral:7b` | Model name for local inference |
| `OLLAMA_MAX_PREDICT` | `4096` | Max output tokens for Ollama |
| `OLLAMA_TIMEOUT_MS` | `120000` | Timeout for Ollama calls (ms) |
| `ALLOW_PRIVATE_URLS` | `false` | When `"true"`, allows compat (`compat:<id>`) provider `baseUrl` to point at loopback / RFC1918 / link-local addresses (self-hosted vLLM, LiteLLM, LocalAI, internal proxies). **Scoped exclusively** to compat-slot saves and the per-call SSRF-guarded fetch — trigger callbacks, preview URLs, and notification webhooks remain SSRF-protected. Do not enable in multi-tenant deployments. See [AI Providers → Self-hosted endpoints](./ai-providers.md). |
| `COMPAT_CONFIG_CACHE_TTL_MS` | `60000` | TTL (ms) for the in-memory compat-provider config cache that fronts SQLite + AES decryption on every AI call. When `REDIS_URL` is set, cache invalidations are broadcast over the `sentri:compat-config:invalidate` channel for cross-instance coherence. |

::: info Compat providers are DB-only
There is no `COMPAT_<ID>_API_KEY` env equivalent — OpenAI-compatible slots (DeepSeek, Groq, Mistral, xAI, vLLM, LiteLLM, …) must be configured via the Settings UI or `POST /api/v1/settings`. For pure env-driven setups, use **OpenRouter** (`OPENROUTER_API_KEY` + `OPENROUTER_MODEL`) instead. See [AI Providers → OpenAI-Compatible Providers](./ai-providers.md).
:::

### Demo Mode

| Variable | Default | Description |
|---|---|---|
| `DEMO_GOOGLE_API_KEY` | — | Platform-owned Gemini API key for zero-config trial. When set, users without their own AI key can try Sentri immediately using the shared key, subject to per-user daily quotas |
| `DEMO_DAILY_CRAWLS` | `2` | Max crawls per user per day in demo mode |
| `DEMO_DAILY_RUNS` | `3` | Max test runs per user per day in demo mode |
| `DEMO_DAILY_GENERATIONS` | `5` | Max AI test generations per user per day in demo mode |

### AI Provider — Capability Probe (PR #28)

The capability probe verifies a provider is reachable, that its API key authenticates, and that the configured model exists. It runs on `POST /api/v1/settings/ai-providers/:id/probe` and as a fire-and-forget pass after every upsert that touches a probe-relevant field (`apiKey`, `model`, `baseUrl`, `family`, `protocol`).

| Variable | Default | Description |
|---|---|---|
| `AI_PROBE_TIMEOUT_MS` | `30000` | Default probe timeout (ms). Per-route override on `provider_routes.probeTimeoutMs` (Migration 060) takes precedence. Clamped to `[1000, 300000]` (1s – 5min). Raise for slow free-tier providers — OpenRouter `:free` models and Gemini free tier can queue 30–90s during peak load. The per-route column is clamped to `[1000, 600000]` (1s – 10min) to additionally accommodate large local Ollama models on CPU. |

### LLM Retry & Tokens

| Variable | Default | Description |
|---|---|---|
| `LLM_MAX_RETRIES` | `3` | Retry count for rate-limited AI calls |
| `LLM_BASE_DELAY_MS` | `2000` | Base delay for exponential backoff (ms) |
| `LLM_MAX_BACKOFF_MS` | `30000` | Max backoff delay (ms) |
| `LLM_MAX_TOKENS` | `16384` | Max output tokens per AI call |

### AI Request Log (B2.5)

Sentri persists per-call AI request metadata to the `ai_request_log` table on every dispatch — see [`backend/src/aiProvider/requestLog.js`](https://github.com/RameshBabuPrudhvi/sentri/blob/main/backend/src/aiProvider/requestLog.js). Storage mode is **per-workspace** (configured via the Settings UI, persisted in `workspaces.aiRequestLogMode`). The env var below acts as a single-tenant default for deployments that haven't enabled per-workspace settings:

| Variable | Default | Description |
|---|---|---|
| `AI_REQUEST_LOG_STORAGE_MODE` | `none` | Single-tenant fallback storage mode: `none` (metadata only — prompt + response are NULL; default), `redacted` (PII patterns stripped before persist), or `full` (raw prompt + response stored — required for replay; admin opt-in with compliance acknowledgement). Per-workspace settings always win over this env var. Replay endpoint refuses non-`full` rows with HTTP 400. |
| `AI_REQUEST_LOG_RETENTION_DAYS` | `30` | Daily 04:45 UTC sweep deletes `ai_request_log` rows older than this many days. Set `0` to disable the retention sweep entirely. |

**Per-workspace overrides:** Admins can set `aiRequestLogMode` and `aiRequestLogCustomRedactionRules` (JSON array of `{ pattern, flags?, replacement? }`) on the `workspaces` row via the Settings UI (Bundle 3) or direct SQL. The dispatcher reads workspace settings on every AI call via [`workspaceRepo.getAiRequestLogSettings`](https://github.com/RameshBabuPrudhvi/sentri/blob/main/backend/src/database/repositories/workspaceRepo.js); workspace mode `none` falls through to the env-default; workspace `redacted` or `full` always wins.

**Built-in PII redactors:** email, phone (international + national), US SSN, credit-card (13–19 digits). Workspace-supplied custom rules apply AFTER the built-ins. Malformed custom regex is silently skipped — built-in redactors still fire.

### AI Providers Audit Log (B3.9)

Sentri appends a `provider_route_audit` row on every mutation to a `provider_routes` row (create / update / delete / rotate_key / probe / export / import / workspace-default pin via Migration 059). Retention is operator-tunable so compliance windows can be longer than the default 90 days. Surfaced via **Settings → AI Providers → Audit Log** (renamed from "Provider Routes Audit Log" in PR #28; the underlying `provider_route_audit` table is unchanged). See [`backend/src/database/repositories/providerRouteAuditRepo.js`](https://github.com/RameshBabuPrudhvi/sentri/blob/main/backend/src/database/repositories/providerRouteAuditRepo.js#L92) for the sweep query.

| Variable | Default | Description |
|---|---|---|
| `AI_ROUTES_AUDIT_RETENTION_DAYS` | `90` | Daily 05:00 UTC sweep deletes `provider_route_audit` rows older than this many days. Set `0` to disable retention entirely (rows accumulate forever). Distinct from `AUDIT_RETENTION_DAYS` (SEC-007 `activities` table) — the two audit logs serve different compliance scopes and are tuned independently. |

### Agent Messages Retention (AUTO-023 B1.1)

Sentri persists thread-scoped agent-to-agent envelopes to the `agent_messages` table on every `emitAgentMessage(envelope)` call — see [`backend/src/aiProvider/agentEventEmitter.js`](https://github.com/RameshBabuPrudhvi/sentri/blob/main/backend/src/aiProvider/agentEventEmitter.js). Append-only, workspace-scoped, mirrors the `run_agent_events` retention posture.

| Variable | Default | Description |
|---|---|---|
| `SENTRI_AGENT_MODE` | `pipeline` | Agent orchestration mode switch (AUTO-023 Bundle 2). `pipeline` = legacy linear stage-return flow (default), `envelope` = same linear DAG but reads + writes handoff envelopes (`agent_messages`) at each stage boundary, `autonomous` = reserved for supervisor orchestration bundles (currently treated as non-default advanced mode). |
| `AI_RATE_LIMIT_PER_MIN` | `300` | Per-workspace AI mutation limiter budget (60s rolling window, weighted costs). |
| `AGENT_MESSAGE_RETENTION_DAYS` | `90` | Daily 05:15 UTC sweep deletes `agent_messages` rows older than this many days. Set `0` to disable the retention sweep entirely (rows accumulate forever). |

### AI Spend Alert Webhook (B4.0.1)

The B3.7 spend-cap path can deliver a Slack-compatible webhook payload to `workspaces.spendAlertWebhookUrl` when current spend crosses `cap × spendAlertThresholdPct / 100`. A cooldown prevents flooding when sustained-high-spend workspaces re-cross the threshold on every AI call — see [`backend/src/aiProvider/spendAlert.js`](https://github.com/RameshBabuPrudhvi/sentri/blob/main/backend/src/aiProvider/spendAlert.js).

| Variable | Default | Description |
|---|---|---|
| `SPEND_ALERT_COOLDOWN_MS` | `3600000` (1h) | Minimum interval between successive webhook fires for the same workspace. The cooldown timestamp lives on `workspaces.spendAlertLastFiredAt` (durable across restarts + shared across replicas). Set `0` to fire on every threshold crossing — useful for testing but will flood the channel under sustained load. |

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3001` | Backend server port |
| `NODE_ENV` | — | Set to `production` for production deployments |
| `DB_PATH` | `data/sentri.db` | SQLite database file path (ignored when `DATABASE_URL` is set) |
| `CORS_ORIGIN` | `*` | Frontend origin(s) for CORS, comma-separated. **Required in production** |
| `SHUTDOWN_DRAIN_MS` | `10000` | Max time (ms) to wait for in-flight runs during graceful shutdown |
| `SPA_INDEX_PATH` | auto-detect | Path to the Vite-built `index.html` for CSP nonce injection (SEC-002). Only needed when the frontend dist is not at the default location relative to the backend source. In Docker multi-container deployments, set to the shared volume path (e.g. `/usr/share/frontend/index.html`) |

### Database & Infrastructure

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | — | PostgreSQL connection string (e.g. `postgres://user:pass@host:5432/db`). When set, uses PostgreSQL instead of SQLite. Requires `pg` + `pg-native` (or `deasync` as fallback) |
| `PG_POOL_SIZE` | `10` | Max PostgreSQL connection pool size (ignored for SQLite) |
| `REDIS_URL` | — | Redis connection URL (e.g. `redis://localhost:6379`). When set, enables shared rate limiting, cross-instance token revocation, SSE pub/sub, and BullMQ job queue. Requires `ioredis`. For Redis-backed rate limiting also install `rate-limit-redis` |
| `MAX_WORKERS` | `2` | Global concurrency limit for BullMQ run execution (INF-003). Each slot processes one crawl or test run at a time. Ignored when Redis/BullMQ is not available. **Superseded by `WORKER_CONCURRENCY`** — kept as a fallback for backward compatibility |
| `WORKER_CONCURRENCY` | `2` | Per-container concurrency for the BullMQ run worker (AUTO-008). Used by both the in-process worker started by the backend and the standalone `worker` Compose service (`node src/worker.js`). Falls back to `MAX_WORKERS` when unset |

#### Local Redis setup

Redis is **optional** for local development — without it, Sentri uses in-memory stores for rate limiting, token revocation, and SSE. To enable Redis locally:

```bash
# macOS (Homebrew)
brew install redis && redis-server

# Or via Docker (any platform)
docker run -d --name sentri-redis -p 6379:6379 redis:7-alpine
```

Then in `backend/.env`:
```bash
REDIS_URL=redis://localhost:6379
```

Install the required npm packages:
```bash
cd backend
npm install ioredis rate-limit-redis
```

#### Local BullMQ setup

BullMQ provides **durable job queue execution** for crawls and test runs (INF-003). Without it, runs execute in-process — which is fine for local development but means runs are lost if the server crashes mid-execution.

To enable BullMQ locally, ensure Redis is running (see above), then:

```bash
cd backend
npm install bullmq
```

BullMQ is detected automatically when both `REDIS_URL` is set and the `bullmq` package is installed. Set `MAX_WORKERS` to control how many runs can execute concurrently (default: 2).

### Deployment Webhooks (AUTO-015)

Optional HMAC secrets for Vercel and Netlify deployment-event webhooks. When set, the corresponding `POST /api/v1/projects/:id/trigger/<provider>` endpoint accepts signed deployment payloads and launches a diff-aware preview crawl. Both endpoints additionally require a project-scoped Bearer trigger token (dual-auth) — see `POST /api/v1/projects/:id/trigger-tokens`.

| Variable | Default | Description |
|---|---|---|
| `VERCEL_WEBHOOK_SECRET` | — | HMAC-SHA1 secret used to verify the `X-Vercel-Signature` header on Vercel deployment-event webhooks. When unset, the `/trigger/vercel` endpoint rejects all requests with 401. |
| `NETLIFY_WEBHOOK_SECRET` | — | HMAC-SHA256 secret used to verify the `X-Netlify-Token` header on Netlify deployment-event webhooks. When unset, the `/trigger/netlify` endpoint rejects all requests with 401. |

### GitHub PR Check Runs (INT-002)

GitHub App credentials for posting native Check Runs on PRs. The feature is opt-in per project via **Settings → Integrations**; the env vars below carry the App-level secrets Sentri uses to mint installation tokens. See [`backend/src/integrations/githubChecks.js`](https://github.com/RameshBabuPrudhvi/sentri/blob/main/backend/src/integrations/githubChecks.js) for the lifecycle (`createPending` → `markInProgress` → `conclude`) and the bounded-retry policy (3 attempts, ≤4s, honours `Retry-After`).

| Variable | Default | Description |
|---|---|---|
| `GITHUB_APP_ID` | — | Numeric App ID from the GitHub App settings page. Required when any project opts into PR checks. |
| `GITHUB_APP_PRIVATE_KEY` | — | PEM RSA private key for the GitHub App. For multi-line `.env` values, escape newlines as `\n` — the module unescapes them at runtime. Used to sign RS256 App JWTs that exchange for installation tokens. |
| `GITHUB_WEBHOOK_SECRET` | — | HMAC-SHA256 secret for `X-Hub-Signature-256` verification on `POST /api/v1/projects/:id/trigger/github` **and** the App-level webhook `POST /api/v1/integrations/github/app-webhook`. When unset, both endpoints reject all requests with 401. |
| `GITHUB_APP_SLUG` | — | URL-safe slug of the GitHub App (the value at the end of `github.com/apps/<slug>`). Required for the OAuth-style install flow (`GET /api/v1/integrations/github/install/start/:projectId`); without it, `/install/start` returns 503. `GITHUB_APP_NAME` is accepted as a fallback alias. |
| `GITHUB_CHECK_NAME` | `Sentri QA` | Display name shown on the GitHub PR check. |
| `GITHUB_API_BASE` | `https://api.github.com` | Override for GitHub Enterprise Server (e.g. `https://github.acme.corp/api/v3`). |

### Email (Transactional)

| Variable | Default | Description |
|---|---|---|
| `RESEND_API_KEY` | — | [Resend](https://resend.com) API key for transactional email (recommended) |
| `SMTP_HOST` | — | SMTP server host (alternative to Resend) |
| `SMTP_PORT` | `587` | SMTP server port |
| `SMTP_SECURE` | `false` | Use TLS for SMTP connection |
| `SMTP_USER` | — | SMTP username |
| `SMTP_PASS` | — | SMTP password |
| `EMAIL_FROM` | `Sentri <noreply@sentri.dev>` | Sender address for all transactional emails |
| `SKIP_EMAIL_VERIFICATION` | `false` | When `"true"`, new users are auto-verified on registration. **Dev/CI only — never set in production** |

### Auth & Security

| Variable | Default | Description |
|---|---|---|
| `JWT_SECRET` | random (dev) | **Required in production.** 32+ char secret for signing JWTs |
| `CREDENTIAL_SECRET` | falls back to `JWT_SECRET` | Encryption secret for project credentials |
| `ARTIFACT_SECRET` | random (dev) | **Required in production.** Signs artifact URLs (screenshots, videos) |
| `ARTIFACT_TOKEN_TTL_MS` | `3600000` | Artifact URL token TTL (ms) |
| `ENABLE_DEV_RESET_TOKENS` | `false` | When `"true"`, forgot-password response includes the reset token (dev/test only — never in production) |
| `APP_URL` | `http://localhost:3000` | Frontend base URL (used for OAuth redirects, email verification links, and notification deep links). Falls back to `CORS_ORIGIN` |
| `APP_BASE_PATH` | `/` | Frontend base path prefix (e.g. `/sentri` for GitHub Pages) |
| `BACKEND_URL` | auto-detect | Backend URL override for cross-origin cookie detection |

### Compliance Audit Log (SEC-007)

The `activities` table is the workspace's compliance audit log. SOC 2 / ISO 27001 / PCI-DSS require it to be immutable, retained, tamper-evident, and its own reads to be audited. Every variable below is off / safe by default. See [Compliance Audit Log](./compliance.md) for the full operator guide.

| Variable | Default | Description |
|---|---|---|
| `DANGER_ALLOW_AUDIT_PURGE` | `false` | When `"true"`, `DELETE /api/v1/data/activities` is permitted (admin-gated). Default returns `403 AUDIT_PURGE_DISABLED`. Only flip in dev / CI or under explicit incident-response process. |
| `AUDIT_HASH_CHAIN` | `false` | When `"true"`, every audit row's `prevHash` is computed as `sha256(prev.prevHash + JSON.stringify(rowMinusHash(row)))` inside the INSERT transaction. `GET /api/v1/audit/verify` walks the chain. Serialises INSERTs under contention — enable only on low-volume, compliance-sensitive deployments. **Mutually exclusive with `AUDIT_RETENTION_DAYS > 0`** (boot fails if both are set). |
| `AUDIT_RETENTION_DAYS` | `365` | Daily 03:30 UTC sweep deletes activity rows older than this. `0` disables retention entirely. Values `1`–`89` are **rejected at boot** (SOC 2 / ISO 27001 minimum is 90 days). |
| `AUDIT_EXPORT_RATE_LIMIT` | `10` | Per (workspace × admin) CSV/NDJSON export budget per 15-min window. JSON browsing is exempt. Tripped exports return `429 AUDIT_EXPORT_RATE_LIMITED`. |
| `AUDIT_DEDUP_WINDOW_SEC` | `60` | Industry-standard audit-log event dedup window (Splunk / CloudTrail / Auth0 / Datadog convention). Consecutive identical read-shaped events (`audit.read`, `audit.export`, `auth.login.failed`) collapse into a single row with `count++` and `lastAt = now` if they fire within this window. `0` disables dedup entirely. Automatically disabled when `AUDIT_HASH_CHAIN=true` (mutating a persisted row's `count`/`lastAt` would invalidate its `prevHash`). PCI-DSS 10.5.3 permits this provided attribution is preserved. |

### Object Storage (MNT-006)

Sentri stores test artifacts (screenshots, videos, traces, visual-diff PNGs) on the local `artifacts/` directory by default. Set `STORAGE_BACKEND=s3` to upload supported artifacts to an S3-compatible object store (AWS S3, Cloudflare R2, MinIO).

| Variable | Default | Description |
|---|---|---|
| `STORAGE_BACKEND` | `local` | `local` (default) or `s3`. Anything other than `s3` keeps local-disk behaviour. |
| `S3_BUCKET` | — | **Required when `STORAGE_BACKEND=s3`.** Bucket name. For custom-endpoint providers (R2/MinIO) it is included path-style in upload + presigned URLs. |
| `S3_REGION` | `us-east-1` | AWS region used for SigV4 signing. For Cloudflare R2 use `auto`. |
| `S3_ACCESS_KEY_ID` | — | **Required when `STORAGE_BACKEND=s3`.** Access key ID. |
| `S3_SECRET_ACCESS_KEY` | — | **Required when `STORAGE_BACKEND=s3`.** Secret access key. |
| `S3_ENDPOINT` | — | Optional custom endpoint for S3-compatible providers. Leave unset for AWS S3 (virtual-hosted style). When set, path-style addressing is used. |

**Scope:** Screenshots, visual-diff baselines, visual-diff PNGs, Playwright videos, and trace zips all route through `writeArtifactBuffer()` in `s3` mode, which uploads to S3 and dual-writes to local disk so baseline acceptance and other code paths that still read from the filesystem continue to work. When `STORAGE_BACKEND=s3` is active, `signArtifactUrl()` emits S3 pre-signed GET URLs for every `/artifacts/*` path. Video and trace uploads are best-effort: if S3 upload fails the run still reports the local artifact path so the run isn't flipped to failed by a transient storage outage.

**Provider examples:**

```bash
# AWS S3
STORAGE_BACKEND=s3
S3_BUCKET=my-sentri-artifacts
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIA…
S3_SECRET_ACCESS_KEY=…

# Cloudflare R2
STORAGE_BACKEND=s3
S3_BUCKET=sentri-artifacts
S3_REGION=auto
S3_ACCESS_KEY_ID=…
S3_SECRET_ACCESS_KEY=…
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com

# MinIO (self-hosted)
STORAGE_BACKEND=s3
S3_BUCKET=sentri
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
S3_ENDPOINT=https://minio.internal:9000
```

### Test Execution

| Variable | Default | Description |
|---|---|---|
| `BROWSER_HEADLESS` | `true` | Set `false` to see the browser window |
| `VIEWPORT_WIDTH` | `1280` | Browser viewport width (px) |
| `VIEWPORT_HEIGHT` | `720` | Browser viewport height (px) |
| `NAVIGATION_TIMEOUT` | `30000` | Timeout for `page.goto()` calls (ms) |
| `API_TEST_TIMEOUT` | `30000` | Per-API-test timeout (ms) |
| `BROWSER_TEST_TIMEOUT` | `120000` | Per-browser-test timeout guard (ms) |
| `PARALLEL_WORKERS` | `1` | Concurrent browser contexts (1–10). Override per-run from UI |
| `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` | — | Custom Chromium executable path |

### Crawler

| Variable | Default | Description |
|---|---|---|
| `CRAWL_MAX_PAGES` | `30` | Maximum pages to visit per crawl |
| `CRAWL_MAX_DEPTH` | `3` | Maximum link-follow depth from the start URL |
| `CRAWL_NETWORKIDLE_TIMEOUT` | `5000` | Timeout (ms) for networkidle wait after page load |

### Self-Healing

| Variable | Default | Description |
|---|---|---|
| `HEALING_ELEMENT_TIMEOUT` | `5000` | Element finding timeout per strategy (ms) |
| `HEALING_RETRY_COUNT` | `3` | Retries per interaction before giving up |
| `HEALING_RETRY_DELAY` | `400` | Pause between retries (ms) |
| `HEALING_HINT_MAX_FAILS` | `3` | Skip healing hints that have failed this many consecutive times |
| `HEALING_VISIBLE_WAIT_CAP` | `1200` | Max `waitFor` timeout per strategy in `firstVisible` (ms) |

### AI Chat

| Variable | Default | Description |
|---|---|---|
| `MAX_CONVERSATION_TURNS` | `20` | Max turn pairs kept in chat context |
| `AI_CLASSIFY_THRESHOLD` | `40` | Confidence threshold for AI-assisted intent classification (0–100) |

### Logging

| Variable | Default | Description |
|---|---|---|
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error` |
| `LOG_DATE_FORMAT` | `iso` | `iso`, `utc`, `local`, or `epoch` |
| `LOG_TIMEZONE` | system | IANA timezone for `local` format |
| `LOG_JSON` | `false` | Emit structured JSON logs |

### Observability (INF-007)

OpenTelemetry traces, Prometheus metrics, and optional Sentry crash reporting. **All variables are optional** — every feature is a no-op when its toggle is unset, so a default deployment ships with zero external telemetry traffic.

Trace ↔ log correlation: when OTel is active, every `formatLogLine()` and `structuredLog()` call automatically carries `requestId`, `traceId`, and `spanId`, so jumping from a slow span in Jaeger / Tempo / Datadog to the matching log lines in Loki / ELK is one filter away.

> **Init order.** OTel SDK + Sentry are loaded via `node --import ./src/otel-preload.mjs` (configured in `backend/package.json`, `backend/Dockerfile`, and the worker `docker-compose.yml` command). This guarantees `@opentelemetry/auto-instrumentations-node` patches `express` / `pg` / `ioredis` **before** the application graph loads — patching after the fact would silently lose all framework-level spans. See `backend/src/otel-preload.mjs` for the full rationale.

| Variable | Default | Description |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OTLP/HTTP endpoint for trace export (e.g. `http://localhost:4318/v1/traces` for a local Jaeger or Tempo collector, or a vendor URL for Datadog / Honeycomb / Grafana Cloud). When unset, `initOpenTelemetry()` is a no-op — no SDK boot, no network traffic, no console spam. |
| `OTEL_SERVICE_NAME` | `sentri-backend` | Service name attached to every emitted span. Override per-deployment to distinguish staging vs. production traces in the same backend. |
| `METRICS_SCRAPE_KEY` | — | Bearer token required to scrape `GET /metrics`. When unset, the endpoint returns `401` to every caller — i.e. metrics are effectively disabled until you set a token. Generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. |
| `SENTRY_DSN` | — | Backend Sentry DSN (sentry.io project or self-hosted). When set, `Sentry.init()` runs in the preload and `Sentry.setupExpressErrorHandler(app)` is registered after all routes. `beforeSend` strips `event.request.headers` so Authorization / Cookie / X-CSRF-Token never leave the host. Unset → SDK is a no-op. |
| `SENTRY_TRACES_SAMPLE_RATE` | `0` | Fraction (0–1) of backend transactions sampled for Sentry performance traces. Default `0` keeps Sentry to crash reporting only. |

**Prometheus exposition surface** — `GET /metrics` returns the standard `text/plain; version=0.0.4` format containing:

- Default Node.js process metrics from `prom-client` (`nodejs_heap_size_total_bytes`, `nodejs_eventloop_lag_seconds`, `process_cpu_seconds_total`, …).
- Three brand-neutral custom counters (`app_` prefix per [Rebranding](./rebranding.md)):
  - `app_runs_total` — every persisted `runs` row (all types).
  - `app_tests_executed_total` — every test result that actually executed (passed / warning / failed; skipped rows are pre-seeded at the route layer and never reach the increment site).
  - `app_crawl_pages_total` — pages discovered per crawl, bumped by `pagesCrawled` at the end of each crawl run.

Counter naming uses `app_*` rather than a product-name prefix so Prometheus dashboards and alerting rules don't need to be migrated during a [product rebrand](./rebranding.md).

### OAuth

| Variable | Description |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Override Google OAuth redirect URI |

## Frontend (build-time)

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `""` (same origin) | Backend URL for cross-origin deploys |
| `GITHUB_PAGES` | — | Set to `true` to use `/sentri/` base path |
| `VITE_GITHUB_CLIENT_ID` | — | GitHub OAuth client ID (passed to frontend) |
| `VITE_GOOGLE_CLIENT_ID` | — | Google OAuth client ID (passed to frontend) |
| `VITE_SENTRY_DSN` | — | Frontend Sentry DSN. When set, `Sentry.init()` runs at app boot with `browserTracingIntegration()` so React Router navigations emit pageload + navigation breadcrumbs, and `ErrorBoundary` reports caught exceptions via `Sentry.captureException`. Unset → SDK is a no-op (no network traffic). |
| `VITE_SENTRY_TRACES_SAMPLE_RATE` | `0` | Fraction (0–1) of frontend transactions sampled for Sentry performance traces. Default `0` keeps Sentry to crash reporting + breadcrumbs only. |




### Kubernetes + Backup (INF-009)

Kubernetes deployment health probe + nightly Postgres backup credentials. The Helm chart at `helm/sentri/` wires `WORKER_HEALTH_PORT` automatically; the `S3_BACKUP_*` variables are only consumed by `.github/workflows/nightly-backup.yml`.

| Variable | Default | Description |
|---|---|---|
| `WORKER_HEALTH_PORT` | `3002` | Port for the worker-local `/healthz` endpoint used by the Kubernetes `readinessProbe`/`livenessProbe`. The chart's `worker.healthPort` value is injected here automatically. |
| `S3_BACKUP_BUCKET` | — | S3 bucket name for nightly `pg_dump -Fc` snapshots. Snapshots land at `s3://<bucket>/daily/YYYY-MM-DD.dump` and `s3://<bucket>/monthly/YYYY-MM.dump`. |
| `S3_BACKUP_REGION` | — | AWS region for the S3 backup bucket (e.g. `us-east-1`). |
| `S3_BACKUP_ACCESS_KEY_ID` | — | Access key ID for the IAM principal that owns the backup bucket. Configure via the `S3_BACKUP_ACCESS_KEY_ID` GitHub Actions secret. |
| `S3_BACKUP_SECRET_ACCESS_KEY` | — | Secret access key paired with `S3_BACKUP_ACCESS_KEY_ID`. Configure via the `S3_BACKUP_SECRET_ACCESS_KEY` GitHub Actions secret. |
