# NEXT.md — Current Sprint Target

> **For agents:** Read this file only. Do not read ROADMAP.md unless you need context on items
> beyond the current PR. Everything you need to start work is here.
>
> **For humans:** Update this file when a PR ships. Move the completed item to ROADMAP.md ✅ table,
> promote the next item from the queue below, and rewrite the "Current PR" block.

> **Bundling guidance — for agents writing code:** When working on the Current PR, if you
> spot adjacent items in the Queue (or in `ROADMAP.md`) that share files, infrastructure,
> or a natural review boundary with the in-flight scope, **flag them as bundling candidates
> in your PR description** rather than expanding the PR mid-flight. Good bundling signals:
> (1) the items touch the same module / shared abstraction, so reviewing them together
> reduces churn (e.g. CAP-004 + MET-001 share `<TrendChart>`); (2) one item validates
> another end-to-end (e.g. a CI guard validates the convention it documents);
> (3) both are S/XS effort and skipping a hand-off cycle saves more than it costs in
> review surface (e.g. AUTO-017.3 + PROC-001 in slot 2). **Bad** bundling signals: items
> in different phases, items that grow the PR past M effort, items that change the
> reviewer's mental model (UX rewrite + backend rewrite), or items the agent identifies
> *after* CI is already green on the original scope. When in doubt, surface the candidate
> bundle as a comment on the PR and let the human decide — never silently expand scope
> beyond the Current PR's `### PR checklist`. Recording the rejected candidates is also
> useful: it builds the dataset for future planning.

---

## ▶ Current PR — AUTO-010 — Root cause analysis and failure clustering
**Effort:** L | **Priority:** 🟢 Differentiator | **Dependencies:** none (composes naturally with AUTO-004 ✅ PR #18 — impact-scoped runs that still fail are the most useful input to clustering, since the noise floor is already lower) | **Source:** `ROADMAP.md` Phase 4 (AUTO-010) — promoted per `NEXT.md` rotation after CAP-002 shipped in PR #3

When 15 tests fail in a run, they often share a single root cause (login endpoint down, auth-service degraded, shared API 5xx). Sentri reports each failure independently — `defectBreakdown` in `Dashboard.jsx` buckets by error-type category but never clusters by **shared cause**. An autonomous QA system should group failures by shared error-message fingerprint, common `sourceUrl`, and common failing step selector, then report "1 root cause → 15 affected tests" so triage stops chasing 15 tickets for one outage. Pairs naturally with AUTO-004's impact-scoped runs (lower noise floor → cleaner clusters) and AUTO-001's risk scorer (high-risk tests are the cluster anchors).

**Files:** new `backend/src/pipeline/failureClusterer.js` (pure function — error-fingerprint hashing + URL-prefix grouping + selector-similarity edit distance, no DB access) · `backend/src/testRunner.js` (call clusterer on run completion, attach `rootCauses` to run record) · `backend/src/database/repositories/runRepo.js` (`rootCauses` JSON field + INSERT_COL) · new migration `027_run_root_causes.sql` · `frontend/src/pages/RunDetail.jsx` (Root Cause Summary panel above the test list) · `frontend/src/api.js` (no new endpoint — `rootCauses` rides on `GET /runs/:runId`) · new `backend/tests/failure-clusterer.test.js`

**Acceptance criteria:**
- A run with 10 failures sharing the same `Error: ECONNREFUSED https://api.example.com/auth` message clusters into a single "likely root cause: auth service unreachable" row with 10 affected tests.
- Failures with truly distinct causes (different URLs, different errors) produce N separate clusters of size 1 each — no false grouping.
- Clustering runs in <100ms for a 100-test run; no LLM calls (deterministic fingerprint hashing only, AI-generated explanations are AUTO-021's scope).
- Runs with zero failures persist `rootCauses: []` and render unchanged (zero regression).
- The panel collapses by default when there's only one cluster, expands automatically when ≥2 clusters surface.

### PR checklist (AUTO-010)

- [ ] New migration `027_run_root_causes.sql` adds `rootCauses` JSON column to `runs`; registered in `runRepo.JSON_FIELDS` + `INSERT_COLS`
- [ ] New pure helper `backend/src/pipeline/failureClusterer.js` exports `clusterFailures({ results })` returning `[{ fingerprint, affectedTestIds[], sharedUrl, sharedSelector, errorPattern, size }]` — no DB access, no LLM calls
- [ ] `backend/src/testRunner.js` calls `clusterFailures` on run completion and persists `run.rootCauses` via `runRepo.update`
- [ ] `frontend/src/pages/RunDetail.jsx` Root Cause Summary panel renders above the test list when `run.rootCauses.length >= 1`; collapses by default for single-cluster, auto-expands for ≥2 clusters
- [ ] `backend/tests/failure-clusterer.test.js` (registered in `run-tests.js`) covers: same-message → single cluster, distinct messages → N singleton clusters, URL-prefix grouping, selector-similarity threshold, zero-failures path, 100ms perf budget on a 100-test fixture
- [ ] `docs/api/projects.md` documents `run.rootCauses[]` shape on `GET /api/v1/runs/:runId`
- [ ] `docs/changelog.md` updated under `## [Unreleased]`
- [ ] `QA.md` § Run Detail extended with root-cause-clustering manual checks (when a panel renders, when it collapses, multi-cluster expansion)
- [ ] `tests/e2e/specs/run-detail-root-cause-ui.spec.mjs` (Tier-3, `page.route()` mock) asserts the panel renders with synthetic `rootCauses` payload

---

## ⏭ Queue (next 3 PRs after current)
### 1 · DIF-015c (Gaps 2/3/5/6) — Recorder gaps completion
**Effort:** M (bundled 4×S) | **Priority:** 🟢 Differentiator (parity with BearQ / Mabl / Testim) | **Dependencies:** DIF-015 ✅, DIF-015b ✅, DIF-015c Gap 1 ✅ PR #11, DIF-015c Gap 2 backend ✅ PR #118 | **Source:** `ROADMAP.md` Phase 3 (DIF-015c sub-items)

_(promoted from queue slot 2 to slot 1 after AUTO-010 moved to Current PR. Original scope unchanged — see prior NEXT.md revisions for the full Gap 2/3/5/6 breakdown, or the `ROADMAP.md` § DIF-015c sub-section.)_

### 2 · AUTO-008 — Distributed runner across multiple machines
**Effort:** XL | **Priority:** 🟢 Differentiator | **Dependencies:** INF-003 ✅, INF-002 ✅, CAP-002 ✅ (PR #3) | **Source:** `ROADMAP.md` Phase 4 (AUTO-008)

### 3 · SEC-004 — MFA (TOTP / passkey) support
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-004)

> **Phase 5 audit-hardening blockers** (`SEC-004` MFA — slot 3 above; `SEC-006` PII firewall, `INF-007` OTel/Sentry, `INF-008` Postgres-default + dual-DB CI matrix, `AUTO-022` AI eval harness) remain queued in `ROADMAP.md` Phase 5.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| CAP-002 | Distributed test sharding across runners. End-to-end cross-process sharding for `POST /api/v1/projects/:id/run` and `POST /api/v1/projects/:id/trigger`. `shards: N > 1` fans out across N BullMQ shard workers; boundary-crossing shard finalizes exactly once via atomic `incrementShardsCompleted` + `markRunCompletedFirstWriterWins`. 7 dedicated backend test files, 24-step QA manual plan, per-shard trace dropdown, CI/CD callback + GitHub Check completion on sharded runs. Deferred to CAP-002b: 10 SaaS-readiness follow-ups. | #3 |
| DIF-012 | Multi-environment support (staging vs. production). | #2 |
| CAP-001 | Data-driven test fixtures. | #1 |

*Full completed list → ROADMAP.md § Completed Work*

_END OF FILE — everything below was removed during the CAP-002 → AUTO-010 sprint rotation._
