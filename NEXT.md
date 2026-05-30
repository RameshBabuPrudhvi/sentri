# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

> **AUTO-023 ✅ shipped.** The 5-bundle multi-agent collaboration plan in [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md) (envelope schema → linear handoff → reviewer↔author loop → supervisor orchestrator → tool calling) is fully delivered across PR #34–#38. The legacy "LangGraph-style DAG pipeline runner" framing is retired; the supervisor orchestrator (Bundle 4) supersedes it. See `ROADMAP.md` Completed Work Summary for the full shipped scope. **Do not re-list AUTO-023 in the queue.**
>
> **Agent-fulfillment rule:** items requiring a live LLM API key + multi-hour human review (e.g. **AUTO-022b** eval-harness recording) are **not agent-fulfillable** and stay deferred under § ⏭ Queue → "Deferred (human-only)". Agents must skip those items and promote the next agent-completable queue slot. The "Current PR" block at the top of this file is always the next agent-completable item.

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ▶ Current PR — AUTO-014 — Test dependency and execution ordering
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** MNT-015 ✅ PR #1 (browser pool — per-test dispatch loop already flows through `browserPool.acquire`; topological sort feeds the same loop) | **Source:** `ROADMAP.md` Phase 4 (AUTO-014). **Note:** AUTO-022b (eval-harness recording) stays in the queue but is **not agent-fulfillable** — it requires a live LLM API key + 4–8h of focused per-case recording that only a human maintainer can drive. AUTO-014 is the next agent-completable item.

Add explicit per-test `dependsOn: [testId, ...]` declarations so prerequisite tests (login → create record → edit record → delete record) execute in topological order. Downstream tests auto-skip when an upstream blocker fails (`skipReason: "upstream_failed"` marker, surfaced in run results + RunDetail UI). Circular declarations (`A → B → A`) are rejected at save time with a structured 400 error. Smoke-pin (AUTO-001) keeps priority over `dependsOn` — smoke tests still dispatch first; dependencies only constrain ordering *within* the non-smoke tail.

**Problem:** Tests with implicit ordering dependencies (login must pass before checkout can run) currently dispatch in arbitrary order inside the `poolMap` worker pool at `backend/src/testRunner.js`. A failed login test produces cascading failures with no indication that the root cause is upstream — every dependent test reports its own `expect()` failure, the run timeline looks like 5 unrelated breakages, and `clusterFailures()` can't fingerprint the common cause. Operators waste triage time chasing symptoms instead of fixing the one broken login.

**Fix:**
1. **Schema** — new migration adds `tests.dependsOn JSON` (nullable; default `null` = no dependencies; legacy rows untouched). Migration number assigned at file-creation time per the existing sequencing.
2. **Save-time validation** in `backend/src/routes/tests.js` rejects (a) non-array values, (b) array entries that aren't existing test IDs in the same project, (c) self-reference (`A.dependsOn` includes `A`), (d) cycles via DFS — the cycle-detection runs against the *post-save* graph so an edit that creates a cycle (`A→B` exists, edit B to add `dependsOn: [A]`) is caught at the offending write, not on the next run. 400 with structured `{ code: "CYCLE_DETECTED", path: ["A","B","A"] }` / `{ code: "MISSING_UPSTREAM", testId: "..." }`.
3. **Runner — topological sort** in a new pure helper `backend/src/runner/dependencyOrder.js`:
   - `topologicalSortTests(tests)` → `{ ordered, skipped }` (Kahn's algorithm, stable; `skipped[]` carries tests whose `dependsOn` references a test outside the dispatched set — soft-skipped with `skipReason: "missing_upstream"`).
   - `computeUpstreamSkips(tests, failedTestIds)` → `Set<testId>` cascade resolver (BFS over the reverse-dep graph).
   - Pure functions, no DB, no I/O — exercised in isolation by the new test file.
4. **Dispatch order** in `backend/src/testRunner.js` becomes `[…smoke-pin…, …topologicallySortedNonSmoke…]`. Smoke pin happens FIRST (preserves the AUTO-001 invariant), then `topologicalSortTests` runs against the non-smoke tail. Stable sort within each group, so deterministic dispatch order is preserved for runs without `dependsOn` declarations (zero regression for legacy callers).
5. **Skip cascade** — when a test fails, `computeUpstreamSkips` resolves every transitively-dependent test and pre-seeds them as `skipped` with `skipReason: "upstream_failed"` + `upstreamFailedTestId: <root>` BEFORE the dependent slot would dispatch. Same shape as AUTO-001's `over_budget` / AUTO-004's `skipped_no_impact`, so `evaluateQualityGates` already excludes these from the pass-rate denominator via `isNonExecutedSkip()`.
6. **UI** — `frontend/src/pages/TestDetail.jsx` gains a "Depends on" multi-select sourced from `useProjectTestsQuery`, with inline validation against the same cycle detector (shared `frontend/src/utils/dependencyGraph.js` — parity with the backend implementation). RunDetail surfaces upstream-failed rows with a 🔗 badge linking to the blocking test.

**Files to change:**
- `backend/src/database/migrations/NNN_test_depends_on.sql` (new) — adds `tests.dependsOn JSON`
- `backend/src/database/repositories/testRepo.js` — `dependsOn` in the column allowlist + `LEAN_COLS` + JSON parse on read
- `backend/src/routes/tests.js` — save-time validation (non-array, missing-id, self-ref, cycle); 400 with structured codes
- `backend/src/runner/dependencyOrder.js` (new) — `topologicalSortTests(tests)` + `computeUpstreamSkips(tests, failedTestIds)`
- `backend/src/testRunner.js` — call `topologicalSortTests` after smoke-pin; wire `computeUpstreamSkips` into the failure path so dependents pre-seed as `skipped` before dispatch
- `backend/src/utils/skipReasons.js` — register `"upstream_failed"` + `"missing_upstream"` as non-executed skips (so `evaluateQualityGates` excludes them from the denominator)
- `frontend/src/utils/dependencyGraph.js` (new) — shared cycle detector for the Settings UI
- `frontend/src/pages/TestDetail.jsx` — "Depends on" multi-select with inline cycle validation
- `frontend/src/pages/RunDetail.jsx` — render the 🔗 upstream-failed badge with link to the blocking test
- `frontend/src/api.js` — `updateTest({ dependsOn })` helper if not already present
- `backend/tests/dependency-order.test.js` (new) — topological sort (linear chain, diamond, multi-root, isolated nodes), cycle detection (self-ref, 2-node, 3-node, deep), `computeUpstreamSkips` cascade (single root, multi-root, partial failure)
- `backend/tests/test-routes-depends-on.test.js` (new) — POST/PATCH validation: non-array → 400, missing-id → 400, self-ref → 400, cycle → 400, valid graph → 200; cross-workspace ACL preserved
- `backend/tests/run-tests.js` — register the two new test files
- `frontend/tests/dependency-graph.test.js` (new) — cycle detector parity with the backend implementation
- `docs/changelog.md` — `## [Unreleased]` § Added entry
- `docs/api/tests.md` — document the `dependsOn` field on POST/PATCH/GET shapes
- `QA.md` — new "Test dependency ordering (AUTO-014)" section with manual test plan

**Acceptance criteria:**
- A login → checkout test chain runs in declared order regardless of `tests[]` array order at the route layer.
- A failed login test pre-seeds every dependent test as `skipped { skipReason: "upstream_failed", upstreamFailedTestId }` BEFORE the dependent slot dispatches (verified by asserting zero `executeTest` invocations for the skipped tests).
- Saving a cycle (`A→B→A`) returns 400 with `{ code: "CYCLE_DETECTED", path: ["A","B","A"] }`; the test row is not mutated.
- `evaluateQualityGates` excludes `upstream_failed` + `missing_upstream` skips from the pass-rate denominator — a 5-test run where 1 login fails + 4 dependents skip reports `passRate: 0/1`, not `0/5`.
- Smoke-pin invariant preserved — `isSmokeTest(t)` tests still dispatch first; `dependsOn` only constrains ordering within the non-smoke tail.

### PR checklist (AUTO-014)
- [ ] PR title follows Conventional Commits (`feat(runner): AUTO-014 — test dependency + execution ordering`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally (incl. new `dependency-order.test.js` + `test-routes-depends-on.test.js`)
- [ ] `cd frontend && npm run build && npm test` passes locally (incl. new `dependency-graph.test.js`)
- [ ] Migration applies cleanly on both SQLite + PostgreSQL (`tests.dependsOn JSON`)
- [ ] Cycle-detection rejects `A→B→A` and `A→A` at save time with `{ code: "CYCLE_DETECTED" }`
- [ ] Failed upstream test pre-seeds all transitive dependents as `skipped` BEFORE dispatch (no `executeTest` calls)
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Added
- [ ] `QA.md` § "Test dependency ordering (AUTO-014)" landed
- [ ] ROADMAP.md `### AUTO-014` section flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added

<details>
<summary>Archived: previous Current PR — MNT-015 — Browser pool reuse + per-tenant AI rate limiting (✅ shipped in PR #1)</summary>

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

</details>

---
## ⏭ Queue

> **Heads up:** **AUTO-014** is the current target (promoted from queue slot 3 after MNT-015 shipped in PR #1 — AUTO-022b stays deferred because it isn't agent-fulfillable). Remaining queue order: **DIF-008** (Jira / Linear issue sync) → **SEC-005** (SAML / OIDC SSO federation) → **AUTO-011** (anomaly detection) → **AUTO-021** (AI-generated test-suite health insights). **AUTO-022b** stays as a deferred 🔴 Blocker that requires a human maintainer with an LLM API key — agents must skip it and pick the next agent-completable item. **AUTO-023 (multi-agent collaboration) is fully shipped** — Bundles 1–5 landed across PR #34–#38 (see `ROADMAP.md` Completed Work Summary). Original "AI platform foundation" track (AI-002 → AI-007) is also fully shipped.

### 1 · DIF-008 — Jira / Linear issue sync
**Effort:** L | **Priority:** 🟢 Differentiator | **Dependencies:** FEA-001 ✅ (notification dispatch pattern) | **Source:** `ROADMAP.md` Phase 3 (DIF-008)
Add `POST /api/integrations/jira` and `POST /api/integrations/linear` settings endpoints to store OAuth tokens; on test-run failure auto-create a bug ticket (screenshot + error + Playwright trace attached); sync pass/fail status back to the linked issue's status field.

### 2 · SEC-005 — SAML / OIDC SSO federation
**Effort:** L | **Priority:** 🟢 Strategic | **Dependencies:** ACL-001 ✅ (workspaces required for per-workspace SSO) | **Source:** `ROADMAP.md` Phase 2 (SEC-005)
Integrate `openid-client` for OIDC and `@node-saml/passport-saml` for SAML 2.0 so enterprise procurement teams can connect Okta / Azure AD / OneLogin / Ping. Per-workspace SSO config (metadata URL, client ID, certificate); auto-provision users on first SSO login; Settings → Authentication panel.

### 3 · AUTO-011 — Historical trend analysis and anomaly detection
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** FEA-001 ✅ (notification dispatch for fired alerts) | **Source:** `ROADMAP.md` Phase 4 (AUTO-011)
Add a rolling-mean + standard-deviation anomaly detector to the dashboard. Alert when pass rate drops more than a configurable threshold (default 15%) versus the prior 5-run baseline. Surface as a warning banner on the dashboard and include in run completion notifications.

### 4 · AUTO-021 — AI-generated test-suite health insights
**Effort:** S | **Priority:** 🔵 Medium | **Dependencies:** FEA-001 ✅ (notifications include insights in failure alerts) | **Source:** `ROADMAP.md` Phase 4 (AUTO-021)
After each run, feed the quality analytics summary (failure categories, flaky tests, healing events, pass rate delta) to the LLM and generate a 3–5 sentence natural-language insight surfaced as an "AI Insights" card on the dashboard.

### Deferred (human-only) · AUTO-022b — Eval harness: record real LLM cache + first real baseline
**Effort:** M (4–8h focused maintainer session) | **Priority:** 🔴 Blocker (deferred — needs LLM API key, **not agent-fulfillable**) | **Dependencies:** AUTO-022 ✅ PR #17 plumbing | **Source:** `ROADMAP.md` Phase 5 (AUTO-022b) + `docs/guide/eval-harness-record-goldens.md`
Activate the dormant AUTO-022 regression gate by replacing the 50 synthetic golden snapshots with real DOM captures, recording `.cache/*.txt` against the live LLM via `EVAL_RECORD=1`, and committing the first real `eval-baseline.json`. Pure data PR — no new code, no schema changes. **Agents skip this item** — recording requires a live LLM API key and per-case human review of the captured prompts/responses; it cannot be driven end-to-end by an autonomous agent.

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

Items that do not overlap AUTO-014's changed files and can land in a separate PR while it is in flight. AUTO-014 touches `backend/src/database/migrations/NNN_test_depends_on.sql` (new), `backend/src/database/repositories/testRepo.js`, `backend/src/routes/tests.js`, `backend/src/runner/dependencyOrder.js` (new), `backend/src/testRunner.js` (dispatch order + skip cascade), `backend/src/utils/skipReasons.js`, `frontend/src/utils/dependencyGraph.js` (new), `frontend/src/pages/TestDetail.jsx`, `frontend/src/pages/RunDetail.jsx`. Any PR touching the per-test dispatch order, `testRepo` column list, or the test-detail / run-detail UI will conflict and should serialise.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| DIF-008 | Jira / Linear issue sync | L | 🟢 Differentiator | None — `routes/settings.js`, `Settings.jsx`, new `utils/integrations.js` |
| SEC-005 | SAML / OIDC SSO federation | L | 🟢 Strategic | None — `routes/auth.js`, `middleware/authenticate.js`, `Settings.jsx` (different tab) |
| AUTO-011 | Historical trend analysis + anomaly detection | M | 🔵 Medium | None — `routes/dashboard.js`, new `utils/anomalyDetector.js`, `Dashboard.jsx` banner |
| AUTO-021 | AI-generated test-suite health insights | S | 🔵 Medium | None — `routes/dashboard.js`, `Dashboard.jsx` AI Insights card |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| B1 (AUDIT-ROADMAP Bundle 1) | Run persistence + crash recovery — `run_test_results` per-test flush (migration 065), `crawl_snapshots` streaming (066), tiered-durability `dbWriteQueue`, admin-only `POST /runs/:id/resume`, RunDetail Resume button. | #N |
| MNT-015 | Browser pool reuse + per-tenant cost-weighted AI rate limiting — warm Playwright pool with FIFO waiter queue, per-workspace AI limiter (`workspaceId:ai`), IETF `RateLimit-*` headers, graceful-shutdown drain. | #1 |
| AUTO-023 | Autonomous multi-agent collaboration — Bundle 5/5: closed-set tool registry, thread-scoped blackboard (migration 063), envelope-mediated dispatch, peer Q&A, sliding-window rate limit, AbortSignal wiring. | #38 |
| INF-009 | Helm chart + K8s readiness/liveness probes + disaster-recovery playbook — backend/worker Deployments, Postgres StatefulSet, worker `/healthz`, nightly `pg_dump` to S3, `kubeconform --strict` CI gate. | #30 |
| AUTO-009 | Browser code coverage mapping (MVP + AUTO-009b/c/d/f/g/h/i/j) — V8 capture, source-map resolution, PR-scoped diff, 4 quality gates, server-side Istanbul coverage, regression alerting, retention sweep. | #19 |
| MNT-001 + AUTO-022 | Vision-based locator healing (pixelmatch CV + LLM vision stages 7/8, per-project budget circuit-breaker, baseline crop capture) **plus** AI eval harness plumbing (Levenshtein scorer, 50-case goldens, `EvalPanel`). | #17 |


*Full completed list → ROADMAP.md § Completed Work Summary*
