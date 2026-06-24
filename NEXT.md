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

## ▶ Current PR — DIF-008 — Jira / Linear issue sync
**Effort:** L | **Priority:** 🟢 Differentiator | **Dependencies:** FEA-001 ✅ (notification dispatch pattern is the template — same outbound HTTP shape, same retry policy, same per-workspace scoping) | **Source:** `ROADMAP.md` Phase 3 (DIF-008). **Note:** AUTO-022b (eval-harness recording) stays deferred — not agent-fulfillable. DIF-008 is the next agent-completable item promoted from queue slot 1 after AUTO-014 shipped in PR #TBD.

The traceability data model already stores `linkedIssueKey` and `tags` per test, but there is no outbound sync. When a test fails, no Jira / Linear ticket is automatically created and reviewers must manually correlate failures to issues. Add per-workspace OAuth-token storage for both providers, an outbound failure-sync hook in the run finalizer, and a status-back sync from issue close → test re-run.

**Problem:** `linkedIssueKey` exists on every test row (since DIF-007 / FEA-001) but is reverse-only — operators paste a key in TestDetail and it links to an existing issue. The forward direction — "this test just failed, file a bug ticket attached to its trace" — has no plumbing. Three-way drift accumulates: failing tests stay un-ticketed, tickets stay open after the underlying test starts passing again, and a new ticket is filed every run for the same persistent failure.

**Fix:**
1. **Settings storage** — new `integrations` table with `{ workspaceId, provider, oauthAccessToken (AES-encrypted), oauthRefreshToken (AES-encrypted), expiresAt, projectKey, ... }`. Per-workspace, admin-only CRUD.
2. **OAuth flows** — `GET /api/integrations/jira/auth` + `/linear/auth` redirect to the provider; callback handlers exchange the code, encrypt-and-persist the tokens, audit-log the install. Token refresh runs lazily on every API call.
3. **Failure sync** — new `backend/src/utils/integrations.js` exports `syncFailureToIssue(test, run, failureResult)`. Called from `testRunner.js` after `finalizeRunIfNotAborted` for every failed result. Idempotent: looks up an existing open ticket for `(test.id, run.projectId)` first; bumps its comment count instead of opening a duplicate.
4. **Status-back sync** — webhook receiver `POST /api/integrations/jira/webhook` + `/linear/webhook` listens for issue close events. When a linked issue closes, mark the test as "ready for re-test" via a new `pendingRetest` flag (surfaces as a chip in TestDetail).
5. **UI** — Settings → Integrations tab with per-provider connect button, account chip, disconnect action. TestDetail surfaces the linked ticket with a deep link.

**Files to change:**
- `backend/src/database/migrations/NNN_integrations.sql` (new) — `integrations` table; `tests.pendingRetest` boolean column
- `backend/src/database/repositories/integrationRepo.js` (new) — CRUD + token-refresh helper
- `backend/src/utils/integrations.js` (new) — Jira + Linear API clients + `syncFailureToIssue` + `syncStatusBack`
- `backend/src/routes/integrations.js` (new) — OAuth init/callback, webhook receivers, manual disconnect
- `backend/src/middleware/permissions.json` — register the new admin-gated routes
- `backend/src/testRunner.js` — call `syncFailureToIssue` for each failed result after finalize
- `frontend/src/pages/Settings.jsx` — Integrations tab (per-provider connect + status)
- `frontend/src/pages/TestDetail.jsx` — render linked-issue chip with provider deep link + "Re-test pending" badge when `pendingRetest`
- `frontend/src/api.js` — `getIntegrations`, `connectIntegration`, `disconnectIntegration` helpers
- `backend/tests/integrations-routes.test.js` (new) — OAuth callback happy path, encrypted token round-trip, webhook signature verification, cross-workspace ACL
- `backend/tests/integrations-sync.test.js` (new) — `syncFailureToIssue` happy path, idempotency on repeated failure, status-back close flips `pendingRetest`
- `backend/tests/run-tests.js` — register both new test files
- `docs/changelog.md` — `## [Unreleased]` § Added
- `docs/api/integrations.md` (new) — operator guide for OAuth setup + webhook URL configuration
- `QA.md` — new "Jira / Linear issue sync (DIF-008)" section

**Acceptance criteria:**
- An admin can complete the Jira OAuth flow from Settings → Integrations and the access token is AES-encrypted at rest (verified by direct DB read).
- A failed test in a regression run auto-creates one Jira / Linear ticket with the screenshot, error message, and Playwright trace ZIP attached.
- A second failure of the same test against the same project does NOT create a second ticket — it appends a comment to the open ticket (idempotency).
- Closing the linked issue via webhook flips `tests.pendingRetest = true` and surfaces a "Re-test pending" badge on TestDetail.
- Cross-workspace ACL preserved — workspace A admin cannot read workspace B's integration tokens via any endpoint.
- Disconnecting an integration zeroes the encrypted tokens and emits an `integration.disconnected` audit row (SEC-007 hash chain).

### PR checklist (DIF-008)
- [ ] PR title follows Conventional Commits (`feat(integrations): DIF-008 — Jira / Linear issue sync`)
- [ ] Branch is off `develop`, not `main`
- [ ] `cd backend && npm test` passes locally (incl. new `integrations-routes.test.js` + `integrations-sync.test.js`)
- [ ] `cd frontend && npm run build && npm test` passes locally
- [ ] OAuth tokens AES-encrypted at rest via `credentialEncryption.js`
- [ ] Webhook signature verification enforced (HMAC-SHA256 against `INTEGRATIONS_WEBHOOK_SECRET`)
- [ ] Idempotent failure sync verified — repeated failures append comments, never duplicate tickets
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Added
- [ ] `QA.md` § "Jira / Linear issue sync (DIF-008)" landed
- [ ] ROADMAP.md `### DIF-008` flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added

---
## ⏭ Queue

> **Heads up:** **DIF-008** is the current target (promoted from queue slot 1 after AUTO-014 shipped in PR #TBD — AUTO-022b stays deferred because it isn't agent-fulfillable). Remaining queue order: **SEC-005** (SAML / OIDC SSO federation) → **AUTO-011** (anomaly detection) → **AUTO-021** (AI-generated test-suite health insights). **AUTO-022b** stays as a deferred 🔴 Blocker that requires a human maintainer with an LLM API key — agents must skip it and pick the next agent-completable item. **AUTO-023 (multi-agent collaboration) is fully shipped** — Bundles 1–5 landed across PR #34–#38 (see `ROADMAP.md` Completed Work Summary). Original "AI platform foundation" track (AI-002 → AI-007) is also fully shipped.

### 1 · SEC-005 — SAML / OIDC SSO federation
**Effort:** L | **Priority:** 🟢 Strategic | **Dependencies:** ACL-001 ✅ (workspaces required for per-workspace SSO) | **Source:** `ROADMAP.md` Phase 2 (SEC-005)
Integrate `openid-client` for OIDC and `@node-saml/passport-saml` for SAML 2.0 so enterprise procurement teams can connect Okta / Azure AD / OneLogin / Ping. Per-workspace SSO config (metadata URL, client ID, certificate); auto-provision users on first SSO login; Settings → Authentication panel.

### 2 · AUTO-011 — Historical trend analysis and anomaly detection
**Effort:** M | **Priority:** 🔵 Medium | **Dependencies:** FEA-001 ✅ (notification dispatch for fired alerts) | **Source:** `ROADMAP.md` Phase 4 (AUTO-011)
Add a rolling-mean + standard-deviation anomaly detector to the dashboard. Alert when pass rate drops more than a configurable threshold (default 15%) versus the prior 5-run baseline. Surface as a warning banner on the dashboard and include in run completion notifications.

### 3 · AUTO-021 — AI-generated test-suite health insights
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

Items that do not overlap DIF-008's changed files and can land in a separate PR while it is in flight. DIF-008 touches `backend/src/database/migrations/NNN_integrations.sql` (new), `backend/src/database/repositories/integrationRepo.js` (new), `backend/src/utils/integrations.js` (new), `backend/src/routes/integrations.js` (new), `backend/src/middleware/permissions.json`, `backend/src/testRunner.js` (failure-sync hook), `frontend/src/pages/Settings.jsx` (Integrations tab), `frontend/src/pages/TestDetail.jsx` (linked-issue chip), `frontend/src/api.js`. Any PR touching `Settings.jsx`, the run finalizer, or the test-detail sidebar will conflict and should serialise.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| SEC-005 | SAML / OIDC SSO federation | L | 🟢 Strategic | ⚠️ Partial — `Settings.jsx` (different tab); `routes/auth.js` + `middleware/authenticate.js` are independent |
| AUTO-011 | Historical trend analysis + anomaly detection | M | 🔵 Medium | None — `routes/dashboard.js`, new `utils/anomalyDetector.js`, `Dashboard.jsx` banner |
| AUTO-021 | AI-generated test-suite health insights | S | 🔵 Medium | None — `routes/dashboard.js`, `Dashboard.jsx` AI Insights card |

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AUTO-014 | Test dependency and execution ordering — per-test `dependsOn` JSON (migration 068), `runner/dependencyOrder.js` (Kahn topo sort + cycle DFS + cascade BFS), serial-mode forcing when deps declared, `upstream_failed`/`missing_upstream` skip reasons excluded from pass-rate denominator, TestDetail multi-select + RunDetail badges. | #TBD |
| B1 (AUDIT-ROADMAP Bundle 1) | Run persistence + crash recovery — `run_test_results` per-test flush (migration 065), `crawl_snapshots` streaming (066), tiered-durability `dbWriteQueue`, admin-only `POST /runs/:id/resume`, RunDetail Resume button. | #N |
| MNT-015 | Browser pool reuse + per-tenant cost-weighted AI rate limiting — warm Playwright pool with FIFO waiter queue, per-workspace AI limiter (`workspaceId:ai`), IETF `RateLimit-*` headers, graceful-shutdown drain. | #1 |


*Full completed list → ROADMAP.md § Completed Work Summary*
