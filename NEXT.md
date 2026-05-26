# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

> **Heads up — AUTO-023 reframed.** The legacy "LangGraph-style DAG pipeline runner" framing is **retired**. AUTO-023 is now the 5-bundle multi-agent collaboration plan in [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md) (envelope schema → linear handoff → reviewer↔author loop → supervisor orchestrator → tool calling). The supervisor agent (Bundle 4) is a strictly more powerful version of the DAG runner — flow control is decided by an LLM reading a structured thread, not hardcoded if/else. Migration 058's Oracle + Reviewer flags remain valid scaffolding for both framings. Bundle 1 is purely additive and parallelisable with MNT-015 — no shared files, no blocker dependency.

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ▶ Current PR — MNT-015 — Browser pool reuse + per-tenant AI rate limiting
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** INF-007 ✅ (metrics to measure pool hit/miss rate), INF-009 ✅ (PR #30 — graceful-shutdown plumbing the pool will hook into) | **Source:** `ROADMAP.md` Phase 5 (MNT-015) — formerly `PERF-001` in AUDIT_IMPL.md. **Note:** AUTO-023 (now reframed as the multi-agent collaboration plan — see [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md)) is **no longer blocked on MNT-015**; the two tracks are parallel-safe. MNT-015 remains valuable for `playwright.dryRun` tool latency in AUTO-023 Bundle 5, but is not a prerequisite.

Replace the cold-start-per-test Chromium launch pattern in `backend/src/testRunner.js` with a `BrowserPool` that maintains N warm contexts (`BROWSER_POOL_SIZE`, default = `MAX_WORKERS`). Each test execution checks out a context, runs its Playwright code, and returns the context without closing the underlying browser process. Wall-clock run time for a 50-test suite drops 40–60% per AUDIT.md P4. **Plus** per-workspace AI rate limiting with cost weighting (AI call = 10 units, regular call = 1 unit) keyed in Redis under `workspaceId:ai` so expensive AI endpoints (`/chat`, `/tests/generate`, `/projects/:id/crawl`) stop sharing the same global bucket as cheap GETs that ENH-005's global-tier limiter currently treats identically.

**Problem:**
1. Every test in a regression run cold-starts a fresh Chromium instance. A 50-test suite = 50 browser launches = ~50 × 800ms = 40s of pure launch overhead before any test code executes. INF-007's `app_run_duration_seconds` histogram p90 is dominated by this overhead.
2. ENH-005's global-tier rate limiter does not distinguish between a workspace hammering `POST /tests/generate` (one call = $0.20 in AI tokens) and the same workspace polling `GET /projects`. A noisy tenant burning AI quota can starve sibling workspaces' regular API traffic from the same global bucket. There is no per-workspace AI-specific tier.
3. AUTO-023's Bundle 5 `playwright.dryRun` tool will inherit the pool — without it, every reviewer-driven sanity-check would cold-start Chromium, defeating the point of fast iteration. (Not a hard dependency: AUTO-023 Bundles 1–4 don't touch the runner.)

**Fix:**
1. New `backend/src/runner/browserPool.js` exports a `BrowserPool` singleton with `acquire({ browserType, viewport, locale, timezone })` → `{ context, page, release }`, `drainAndClose()` (shutdown hook), and `getStats()` for INF-007 telemetry. Internally maintains a per-`browserType` array of warm `BrowserContext` instances seeded from a single `chromium.launch()` / `firefox.launch()` / `webkit.launch()` per type. Pool size honours `BROWSER_POOL_SIZE` (env, default `MAX_WORKERS`); when all contexts are checked out, `acquire` waits on a FIFO queue rather than spawning a new browser. Each `release()` runs `context.clearCookies()` + `context.clearPermissions()` + tears down the page (operator-supplied profile dimensions — locale/timezone/viewport — are part of the cache key so a context with `it-IT` never serves an `en-US` request).
2. `backend/src/testRunner.js` + `backend/src/runner/executeTest.js` switch from `chromium.launch(...) → browser.newContext(...)` per test to `browserPool.acquire(...)` → release. The legacy `BROWSER` env var stays as the default `browserType` so existing single-browser-type deployments don't change behaviour. CAP-002's per-shard execution path inherits the pool through the same call site.
3. New `backend/src/middleware/aiRateLimit.js` exports an Express middleware factory `aiRateLimit({ costFn })` that increments `workspaceId:ai` in Redis via a new `incrWithExpiry(key, cost, windowSec)` helper on `backend/src/utils/redisClient.js` (atomic Lua-script equivalent of `INCRBY` + `EXPIRE`, mirroring the dispatch path in `aiProvider/quotaGuard.js`'s Redis-Lua branch). `costFn(req)` returns `10` for AI mutation routes and `1` otherwise; default window `60s`, default cap `300` units = 30 AI calls/min/workspace OR 300 regular calls/min/workspace, both clamped by env. 429 response sets `Retry-After` from the remaining TTL. The middleware mounts on `POST /chat`, `POST /tests/generate`, `POST /projects/:id/crawl`, `POST /tests/:id/regenerate`, and the agent-role `/test` endpoints — never on auth, SSE, or `/health`. Sibling workspaces are unaffected because the Redis key namespaces on `workspaceId`.
4. Graceful-shutdown hook in `backend/src/index.js` (MAINT-013) + `backend/src/worker.js` (INF-009) calls `browserPool.drainAndClose()` before the existing `closeQueue → closeRedis → closeDatabase` chain so SIGTERM under K8s deletes every warm context cleanly (no zombie Chromium PIDs on the node when the pod terminates).
5. INF-007 metrics surface: 4 new Prometheus gauges/counters in `backend/src/utils/metrics.js` — `app_browser_pool_size{type}` (configured cap), `app_browser_pool_in_use{type}` (live), `app_browser_pool_acquires_total{type, outcome}` (`outcome ∈ {hit, miss, queue}`), and `app_ai_rate_limited_total{workspace_role}` (label is the `req.workspaceRole` bucket per ACL-002, never the raw workspaceId — cardinality bomb).

**Files to change:**
- `backend/src/runner/browserPool.js` (new) — pool class + singleton + JSDoc-typed acquire/release contract
- `backend/src/testRunner.js` — switch from per-test `chromium.launch` to `browserPool.acquire`; preserve every existing `runTests(...)` argument so trigger/run/worker paths need zero changes
- `backend/src/runner/executeTest.js` — same swap on the inner per-test execution loop
- `backend/src/middleware/aiRateLimit.js` (new) — per-workspace AI cost-weighted limiter
- `backend/src/middleware/appSetup.js` — mount `aiRateLimit` on the 5 AI mutation routes (NEVER global)
- `backend/src/utils/redisClient.js` — add `incrWithExpiry(key, cost, windowSec)` exported helper
- `backend/src/utils/metrics.js` — register 3 pool gauges/counter + 1 AI-rate-limit counter
- `backend/src/index.js` + `backend/src/worker.js` — `await browserPool.drainAndClose()` in the graceful-shutdown sequence (BEFORE `closeQueue`)
- `backend/.env.example` + `docs/guide/env-vars.md` — document `BROWSER_POOL_SIZE`, `AI_RATE_LIMIT_PER_MIN`, `AI_RATE_LIMIT_REGULAR_PER_MIN`
- `backend/tests/browser-pool.test.js` (new) — pool acquire/release, queue ordering, drain-and-close, viewport/locale cache-key separation, hit/miss counter integration
- `backend/tests/ai-rate-limit.test.js` (new) — cost-weighted increment, sibling workspace isolation, `Retry-After` header on 429, route allowlist (auth/SSE/health bypass)
- `backend/tests/run-tests.js` — register the two new test files
- `docs/changelog.md` — `## [Unreleased]` § Added + § Performance entries
- `QA.md` — new section "Browser pool + per-tenant AI rate limiting (MNT-015)" with manual test plan
- Optional: `monitoring/prometheus/alerts.yml` — `BrowserPoolStarvation` rule fires when `app_browser_pool_in_use / app_browser_pool_size > 0.9` for 5m, runbook link to a new `docs/guide/observability.md#browserpoolstarvation` anchor

**Acceptance criteria** (verbatim from ROADMAP.md MNT-015):
- A 10-test suite run starts in ≤3 browser launch events (verified via `app_browser_pool_acquires_total{outcome="miss"}` not exceeding 3, OR by stubbing `chromium.launch` and asserting call count).
- A workspace exceeding its AI rate limit receives `429` with `Retry-After` header without affecting other workspaces' counters.
- Draining the pool on graceful shutdown closes all browser contexts cleanly (no zombie processes; covered by `browser-pool.test.js`).
- Wall-clock improvement of 40–60% on a 50-test regression run vs. pre-MNT-015 baseline (measured against `app_run_duration_seconds` p50 on the same suite; documented in PR description, not asserted in CI).

### PR checklist (MNT-015)
- [ ] PR title follows Conventional Commits (`perf(runner): MNT-015 — browser pool + per-tenant AI rate limiting`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally (incl. new `browser-pool.test.js` + `ai-rate-limit.test.js`)
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] Stubbed-`chromium.launch` test confirms ≤3 launches for a 10-test suite
- [ ] Manual verification on a local stack: a workspace exceeding `AI_RATE_LIMIT_PER_MIN` returns 429 + `Retry-After`; sibling workspace unaffected
- [ ] `kubectl delete pod -l app=worker` cleanly drains the pool (no orphan Chromium PIDs)
- [ ] `app_browser_pool_*` + `app_ai_rate_limited_total` metrics scrape cleanly via `/metrics`
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Added + § Performance
- [ ] `QA.md` § "Browser pool + per-tenant AI rate limiting (MNT-015)" landed
- [ ] ROADMAP.md `### MNT-015` section flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added

**Out-of-scope for MNT-015 (intentionally deferred to AUTO-023):**
- The multi-agent envelope schema + emitter — AUTO-023 Bundle 1 (`docs/roadmap/autonomous-multi-agent.md` § B1).
- Reviewer↔author feedback loop + supervisor orchestrator — AUTO-023 Bundles 3 + 4.
- Wiring Oracle + Reviewer agents (already scaffolded by migration 058) into the orchestrator — AUTO-023 Bundles 2 + 4 scope.
- `playwright.dryRun` tool — AUTO-023 Bundle 5 (consumes this PR's `browserPool.acquire`).

---
## ⏭ Queue (AUTO-023 multi-agent track elevated — parallel-safe with MNT-015)

> **Heads up:** **AUTO-023** has been reframed as a 5-bundle multi-agent collaboration plan (see [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md)). Bundle 1 (envelope schema + validator + emitter) is purely additive and can land **in parallel with MNT-015** — no shared files. The legacy DAG-runner framing is retired; the supervisor orchestrator (Bundle 4) supersedes it. Remaining queue order after AUTO-023: **AUTO-022b** (eval harness recording, deferred — needs LLM API key) → **AUTO-014** (test dependency + execution ordering) → **DIF-008** (Jira / Linear issue sync). Original "AI platform foundation" track (AI-002 → AI-007) is fully shipped — see `ROADMAP.md` § Phase 5.

### 1 · AUTO-023 — Autonomous multi-agent collaboration (5 bundles)
**Effort:** XL (split across 5 bundles, each independently shippable) | **Priority:** 🟢 Strategic | **Dependencies:** INF-007 ✅ (OTel spans), `agent_events` ✅ (Task 2), `provider_routes` + `quotaGuard` + circuit breaker ✅ (PR #23), migration 058 ✅ (Oracle + Reviewer per-project flags), AI-005c single-agent collapse rule ✅. **Not blocked on MNT-015.** | **Source:** [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md) (full plan, schema, exit criteria per bundle, cross-bundle invariants, risk register).

Replaces the legacy DAG-runner framing. The new plan ships a real multi-agent system in 5 independently-shippable bundles: **B1** `agent_messages` schema + envelope validator + emitter (purely additive, zero behaviour change), **B2** wrap each pipeline call site with envelope read/write (still linear DAG, gated by `SENTRI_AGENT_MODE=envelope`), **B3** reviewer↔author feedback loop with structured `verdict ∈ {accept, revise, reject}` + bounded `MAX_REVIEW_ROUNDS`, **B4** supervisor orchestrator that reads the thread and decides next role (`SENTRI_AGENT_MODE=autonomous`, per-workspace opt-in), **B5** thread blackboard + closed-set tool registry (`db.listExistingTests`, `playwright.dryRun`, `thread.askPeer`). Every bundle preserves zero-regression default (`SENTRI_AGENT_MODE=pipeline` = today's behaviour). The supervisor (B4) supersedes the DAG runner — flow control is LLM-driven, not hardcoded if/else.

### 2 · AUTO-022b — Eval harness: record real LLM cache + first real baseline
**Effort:** M (4–8h focused maintainer session) | **Priority:** 🔴 Blocker (deferred — needs LLM API key) | **Dependencies:** AUTO-022 ✅ PR #17 plumbing | **Source:** `ROADMAP.md` Phase 5 (AUTO-022b) + `docs/guide/eval-harness-record-goldens.md`
Activate the dormant AUTO-022 regression gate by replacing the 50 synthetic golden snapshots with real DOM captures, recording `.cache/*.txt` against the live LLM via `EVAL_RECORD=1`, and committing the first real `eval-baseline.json`. Pure data PR — no new code, no schema changes. Currently deferred per maintainer call (recording requires LLM API key + 4–8h focused per-case iteration).

### 3 · AUTO-014 — Test dependency and execution ordering
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 4 (AUTO-014)
Add explicit per-test `dependsOn: [testId, ...]` declarations so prerequisite tests (login → create record → edit record → delete record) execute in topological order, downstream tests auto-skip when an upstream blocker fails (`skipReason: "upstream_failed"` marker), and circular-dependency declarations are rejected at save time.

### 4 · DIF-008 — Jira / Linear issue sync
**Effort:** L | **Priority:** 🟢 Differentiator | **Dependencies:** FEA-001 ✅ (notification dispatch pattern) | **Source:** `ROADMAP.md` Phase 3 (DIF-008)
Add `POST /api/integrations/jira` and `POST /api/integrations/linear` settings endpoints to store OAuth tokens; on test-run failure auto-create a bug ticket (screenshot + error + Playwright trace attached); sync pass/fail status back to the linked issue's status field.

<!-- LEGACY INF-009 PROSE BELOW — kept inert until human prunes; superseded by MNT-015 above -->
<!--
**Problem:** Sentri ships a Docker Compose for self-hosted demos, but operators running production Kubernetes clusters have no first-class deployment artefact — they hand-write Deployments / Services / Ingresses from the compose file, miss the SIGTERM graceful-shutdown drain that `MAINT-013` already implements in code, and have no canonical disaster-recovery story. The `INF-007` Prometheus `/metrics` endpoint and `GET /api/v1/health` route exist but no probe configuration ties them to a kubelet. There is no nightly database backup; an operator who loses the Postgres volume loses every project, run, test, audit log, and SIEM-replay DLQ row with no documented recovery path.
**Fix:**
1. New `helm/sentri/` Helm chart with parameterised `values.yaml` — separate `backend` + `worker` Deployments (matching the `docker-compose.yml --profile redis --profile postgres` topology), Postgres as a StatefulSet with PVC, Redis as a single Deployment (cluster-mode opt-in via `values.redis.cluster.enabled`), HorizontalPodAutoscaler on the worker Deployment driven by BullMQ queue depth via the `app_queue_depth` Prometheus gauge, ingress for the backend HTTP surface, ConfigMap for non-secret env vars (`DATABASE_URL`, `REDIS_URL`, `WORKER_CONCURRENCY`, etc.), Secret for AES + JWT keys + AI provider keys.
2. `readinessProbe` + `livenessProbe` on both `backend` and `worker` Deployments. Backend probes `GET /api/v1/health` (verifies DB + Redis reachable); worker probes a new `GET /healthz` endpoint binding only on a sidecar port that returns `200` when BullMQ is connected and `503` otherwise (avoids exposing the worker via the public ingress).
3. New `.github/workflows/nightly-backup.yml` runs `pg_dump` against the configured `DATABASE_URL` and uploads to S3 (or any S3-compatible bucket configured via `S3_BACKUP_BUCKET` + reusing `MNT-006`'s S3 client). Retention: 30 daily + 12 monthly snapshots, lifecycle policy documented in the runbook.
4. New `docs/guide/disaster-recovery.md` ships the operator hand-off: explicit RTO (<4h) / RPO (<24h) targets, restore playbook (`pg_restore` against a fresh StatefulSet PVC), Redis loss tolerance (durable BullMQ jobs replay from Postgres-side run state, ephemeral session data is acceptable to lose), `helm upgrade --rollback` runbook for failed deploys.
5. Helm chart smoke test in `tests/helm/` via `helm template` + `kubeval` (or `kubeconform`) in CI — guarantees the chart renders into valid Kubernetes manifests against the current minor version. Mirrors the pattern from `INF-007`'s `monitoring/prometheus/alerts.yml` validation.
**Files to change:**
- `helm/sentri/Chart.yaml` (new) — chart metadata, version 0.1.0
- `helm/sentri/values.yaml` (new) — defaults for image tags, replicas, ingress host, Postgres/Redis sizing, autoscaling thresholds
- `helm/sentri/templates/backend-deployment.yaml` (new) — Deployment with `readinessProbe` / `livenessProbe` on `GET /api/v1/health`; env from ConfigMap + Secret; `terminationGracePeriodSeconds` aligned with `MAINT-013`'s drain timeout
- `helm/sentri/templates/worker-deployment.yaml` (new) — Deployment with `readinessProbe` / `livenessProbe` on the new `GET /healthz` worker endpoint
- `helm/sentri/templates/postgres-statefulset.yaml` (new) — StatefulSet + PVC + headless Service
- `helm/sentri/templates/redis-deployment.yaml` (new) — Deployment + Service (cluster-mode opt-in via `values.redis.cluster.enabled`)
- `helm/sentri/templates/ingress.yaml` (new) — ingress for backend HTTP surface
- `helm/sentri/templates/configmap.yaml` (new) — non-secret env (`DATABASE_URL`, `REDIS_URL`, `WORKER_CONCURRENCY`, …)
- `helm/sentri/templates/secret.yaml` (new) — AES + JWT keys + AI provider keys stub
- `helm/sentri/templates/hpa.yaml` (new) — HorizontalPodAutoscaler on worker driven by `app_queue_depth`
- `backend/src/worker.js` — add `GET /healthz` sidecar HTTP endpoint binding on `WORKER_HEALTH_PORT` (default 3002) returning 200/503 based on BullMQ connection state
- `backend/src/middleware/appSetup.js` — extend `/api/v1/health` to verify Postgres + Redis reachable before returning 200
- `.github/workflows/nightly-backup.yml` (new) — `pg_dump` → S3 daily at 02:00 UTC, 30-day + 12-month retention
- `.github/workflows/helm-validate.yml` (new) — `helm template helm/sentri/ | kubeconform` on every PR touching `helm/`
- `tests/helm/values-overrides.yaml` (new) — minimal `values.yaml` overrides used by the validate workflow
- `docs/guide/disaster-recovery.md` (new) — RTO/RPO targets, restore playbook, Redis loss tolerance, `helm upgrade --rollback` runbook
- `docs/guide/kubernetes-deployment.md` (new) — Helm install walkthrough mirroring `docs/guide/getting-started.md`'s Docker Compose structure
- `docs/guide/env-vars.md` — document `WORKER_HEALTH_PORT` + `S3_BACKUP_BUCKET` + `S3_BACKUP_REGION` + `S3_BACKUP_ACCESS_KEY_ID` + `S3_BACKUP_SECRET_ACCESS_KEY`
- `docs/changelog.md` — `## [Unreleased]` § Added
- `QA.md` — new section "Kubernetes deployment + DR (INF-009)" with manual test plan

**Acceptance criteria:**
- `helm template helm/sentri/ --set ingress.host=test.local | kubeconform --strict --schema-location default` exits 0 against the current Kubernetes minor version.
- `helm install sentri ./helm/sentri/` on a clean `kind` cluster brings up backend + worker + Postgres + Redis. `kubectl wait --for=condition=Ready` succeeds on every pod within 90s.
- `kubectl delete pod -l app=backend` flips the readiness probe red, ingress stops routing to the deleted pod, the new pod's `/api/v1/health` returns 200, and zero in-flight runs are lost (MAINT-013's drain semantics preserved under SIGTERM).
- `pg_restore` from a snapshot uploaded by `.github/workflows/nightly-backup.yml` into a fresh StatefulSet PVC restores the workspace bit-for-bit (projects + runs + tests + audit log + SIEM DLQ rows). RTO documented as <4h; RPO documented as <24h.
- Worker `/healthz` returns 503 within 2s of Redis connection loss; readiness probe flips, HPA stops scaling against a stale queue gauge.
- `docs/guide/disaster-recovery.md` includes the explicit `pg_restore` invocation, the S3 bucket layout, and the `helm rollback` step-by-step for failed deploys.

### PR checklist (INF-009)
- [ ] PR title follows Conventional Commits (`feat(inf): INF-009 — Helm chart + K8s probes + DR playbook`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally (incl. any new `health.test.js` for the worker `/healthz` endpoint + extended `/api/v1/health` DB+Redis check)
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] `helm template helm/sentri/ | kubeconform --strict` passes locally
- [ ] `helm install sentri ./helm/sentri/` on a local `kind` cluster brings up all pods Ready within 90s
- [ ] Pod-deletion drain verified — no in-flight run lost under SIGTERM
- [ ] `pg_dump` → S3 → `pg_restore` round-trip verified on a copy of the cluster's database
- [ ] `docs/guide/disaster-recovery.md` + `docs/guide/kubernetes-deployment.md` ship the full operator hand-off
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Added
- [ ] ROADMAP.md `### INF-009` section flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added
-->

---

## 🔀 Parallel opportunities

Items that do not overlap MNT-015's changed files and can land in a separate PR while it is in flight. MNT-015 touches `backend/src/runner/browserPool.js` (new), `backend/src/testRunner.js`, `backend/src/runner/executeTest.js`, `backend/src/middleware/aiRateLimit.js` (new), `backend/src/middleware/appSetup.js` (5-route mount), `backend/src/utils/redisClient.js` (new `incrWithExpiry`), `backend/src/utils/metrics.js` (4 new metrics), `backend/src/index.js` + `backend/src/worker.js` (drain hook). Any PR touching the test-runner browser launch path, the rate-limiter middleware, or the graceful-shutdown sequence will conflict and should serialise.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| AUTO-022b | Eval harness: record real LLM cache + first real baseline | M | 🔴 Blocker (deferred) | None — pure data PR in `backend/tests/fixtures/eval-goldens/` + `eval-baseline.json` |
| AUTO-014 | Test dependency and execution ordering | M | 🔵 Medium | Light — `executeTest.js` dispatch loop overlaps; serialise after MNT-015 lands the `browserPool.acquire` swap. |
| DIF-008 | Jira / Linear issue sync | L | 🟢 Differentiator | None — `routes/settings.js`, `Settings.jsx`, new `utils/integrations.js` |
| SEC-005 | SAML / OIDC SSO federation | L | 🟢 Strategic | None — `routes/auth.js`, `middleware/authenticate.js`, `Settings.jsx` (different tab) |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AUTO-023 | Autonomous multi-agent collaboration — final bundle (Bundle 5 of 5, closes the AUTO-023 roadmap). Closed-set tool registry (`db.listExistingTests`, `db.getTest`, `crawl.getPageHtml`, `playwright.dryRun`, `thread.askPeer`) with per-role visibility intersected with workspace `agent_configs.allowedTools` (migration 064); Zod-validated structured args + errors (`err.issues[]` with `{path, message, code}` per ZodError); thread-scoped blackboard (`agent_thread_state` migration 063, optimistic CAS, `AGENT_THREAD_STATE_MAX_BYTES` cap default 64KB); envelope-mediated server-side dispatch (`tool_call` / `tool_result` intents, 30s per-call timeout, `agent_tool_calls_total{tool,outcome}` counter, summary-form result envelopes via `summarizeToolResult`); peer Q&A with `MAX_PEER_NESTING=3` + cross-process Redis pub/sub bridge (`sentri:agent-peer-answer`); workspace scoping at the repo layer (`projectRepo.getByIdInWorkspace` + `run.workspaceId` checks); colour-coded UI tool-call timeline (`.ac-tool-chip--{call,success,error}`). Production wire-up: author dispatches `db.listExistingTests` before prompt construction in `journeyGenerator.generateFromDescription`; reviewer dispatches `playwright.dryRun` through the tool registry in `feedbackLoop.runReviewerAuthorLoop`. Hardening: `AGENT_TOOL_RATE_LIMIT_PER_MIN` (default 60, max 1000) true sliding-window rate limit via Redis sorted sets (ZADD + ZREMRANGEBYSCORE + ZCARD) with in-memory fallback; SQL `LIMIT` pushed to repo via new `testRepo.getRecentByProjectId`; tool args scrubbed for secrets via CAP-003 `secretScanner` before envelope persistence; `AbortSignal` threaded from orchestrator + production wire-ups into `executeToolCall`; bounded exponential-backoff retry (2 attempts, 100ms base + jitter) on transient errors for idempotent reads. New env vars documented in `docs/guide/env-vars.md`: `AGENT_THREAD_STATE_MAX_BYTES`, `AGENT_TOOL_RATE_LIMIT_PER_MIN`. New tests registered in `backend/tests/run-tests.js`: `agent-blackboard.test.js`, `agent-tools-registry.test.js`, `agent-peer-qa.test.js`, `agent-tool-call-envelope.test.js`, `agent-tools-orchestrator.test.js`. Closes the AUTO-023 plan in `docs/roadmap/autonomous-multi-agent.md` — every roadmap checkbox ticked. | #38 |
| INF-009 | Helm chart + Kubernetes readiness/liveness probes + disaster-recovery playbook. New `helm/sentri/` chart deploys backend + worker Deployments (both `terminationGracePeriodSeconds: 60` aligned with MAINT-013), Postgres StatefulSet (PVC + secret-driven `POSTGRES_USER`/`POSTGRES_DB`/`POSTGRES_PASSWORD`), Redis Deployment (gated by `values.redis.cluster.enabled` so external Redis Cluster operators can opt out), Ingress, ConfigMap, Secret, and a worker HPA driven by the `app_queue_depth` Prometheus gauge. Backend `GET /api/v1/health` extended to verify both Postgres + Redis reachability (503 when either is down); worker spawns a lightweight HTTP server on `WORKER_HEALTH_PORT` (default 3002) serving `/healthz` for the kubelet probe. New `.github/workflows/nightly-backup.yml` runs `pg_dump -Fc` (custom format — required by the documented `pg_restore` flow) at 02:00 UTC daily and uploads to S3 (daily + first-of-month snapshots). `.github/workflows/helm-validate.yml` renders the chart via `helm template` and validates against Kubernetes 1.30 schemas with `kubeconform --strict` on every PR touching `helm/`. Operator docs: `docs/guide/kubernetes-deployment.md` (full Helm install walkthrough — prereqs, quick-start with secret generation, services table, configuration knobs, graceful shutdown) + `docs/guide/disaster-recovery.md` (RTO <4h / RPO <24h targets, S3 bucket layout, `pg_restore` restore steps, `helm rollback` runbook). New env vars: `WORKER_HEALTH_PORT`, `S3_BACKUP_BUCKET`, `S3_BACKUP_REGION`, `S3_BACKUP_ACCESS_KEY_ID`, `S3_BACKUP_SECRET_ACCESS_KEY`. Coverage: `backend/tests/health-routes.test.js` pins the `/api/v1/health` JSON shape and 503-when-Redis-down behaviour; `backend/tests/worker-health.test.js` exercises the worker `/healthz` 200/503 contract directly against `http.createServer` (no BullMQ boot required). | #30 |
| AUTO-009 | Browser code coverage mapping (MVP + AUTO-009b/c/d/f/g/h/i/j follow-ups landed in the same PR). Opt-in per-project Playwright V8 JS coverage capture, `coverageAggregator.js` + `finalizeCoverage.js` (single source of truth for single-process AND sharded runs — fixes the parity gap that silently persisted `coverageSummary: null` on multi-shard runs), source-map resolution via `sourceMapResolver.js` (`source-map@^0.7` LRU cache, SSRF-guarded), `v8ToIstanbul.js` lift for statement/branch/function granularity, PR-scoped coverage diff via `coveragePrDiff.js` + `getChangedFilesWithRangesForPr` (single pagination pass against `/pulls/:n/files`), four new quality gates (`minCoveragePct`, `minBranchPct`, `minPrCoveragePct`, `maxCoverageRegressionPct`), AUTO-009g memory ceiling (`COVERAGE_MEMORY_CEILING_MB`, default 500), AUTO-009h server-side Istanbul/NYC coverage for API tests via `serverCoverageProxy.js` (HTTP `GET /__coverage__` SSRF-guarded + `file://` shared-FS modes, browser/server `layer` discriminator on `topUncoveredFiles[]`), AUTO-009i regression alerting via `coverageRegressionDetector.js` (Teams adaptive card / email / webhook through FEA-001 channels + `coverage.regression` audit row), AUTO-009j daily retention sweep in `scheduler.js`. 8 DB migrations (038–045), 8 new tests, E2E `coverage-ui.spec.mjs`, Dashboard `CoveragePanel` with Browser/Server/Combined layer toggle + Lines/Branches/Functions metric toggle + `sourceMapStatus` badge, `ProjectQualityCard` new "Coverage" tab, `TestRunView.jsx` per-test `+47L · +12B · +3F` delta badges, `RunDetail.jsx` `priorCoveragePct` regression context. `docs/guide/coverage-mapping.md` + `docs/guide/coverage-server-side.md` operator guides; QA.md AUTO-009 manual test checklist; `docs/changelog.md` updated. New deps: `source-map@^0.7.4`, `v8-to-istanbul@^9.3.0`. | #19 |
| MNT-001 + AUTO-022 | Vision-based locator healing (host-side stages 7 pixelmatch CV + 8 LLM vision with per-project budget circuit-breaker, SEC-007-compatible audit trail, `STRATEGY_VERSION` 3→4, baseline crop capture on green runs, coordinate re-action on heal, new Vision Healing tab on Quality card + Vision-based healing panel on Healing dashboard) **plus** AI eval harness plumbing (deterministic Levenshtein scorer over selector/action/assertion tuples, record/replay adapters keyed on `sha256(promptVersion + model + snapshot + url)`, 50-case golden fixture set with 5 canonical templates, path-filtered `eval.yml` CI workflow, Dashboard `EvalPanel` with 30-day trend + drill-down backed by `metric_samples`, cold-start guard so the merge isn't blocked on missing recordings — gate dormant until AUTO-022b records real LLM cache). | #17 |


*Full completed list → ROADMAP.md § Completed Work Summary*
