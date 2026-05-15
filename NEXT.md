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

## ▶ Current PR — AUTO-008 — Distributed runner across multiple machines
**Effort:** XL | **Priority:** 🟢 Differentiator | **Dependencies:** INF-003 ✅, INF-002 ✅, CAP-002 ✅ (PR #3) | **Source:** `ROADMAP.md` Phase 4 (AUTO-008) — promoted per `NEXT.md` rotation after DIF-015c Gaps 2/3/5/6 shipped in PR #8
Current parallelism is 1–10 workers within a single Chromium process on one machine (`testRunner.js:48-67`). For large suites (500+ tests), execution must distribute across multiple machines. BullMQ (INF-003) and the in-process sharding primitives (CAP-002) provide the foundation; this item extracts the browser worker into a standalone, stateless container image so any number of worker replicas can pull jobs from the shared queue.

**Files to change:**
- `backend/src/workers/runWorker.js` — make fully stateless and containerisable; accept per-worker `WORKER_CONCURRENCY` env var
- `docker-compose.yml` — add scalable `worker` service alongside the existing `web` service
- `frontend/src/pages/Dashboard.jsx` — worker pool status panel (queue depth, active workers, idle workers)
- `backend/src/routes/dashboard.js` — expose BullMQ queue metrics (`waiting`, `active`, `completed`, `failed`) when Redis is available
- `docs/guide/getting-started.md` — document the multi-machine deployment pattern
- `docs/changelog.md` `## [Unreleased]` § Added

**Acceptance criteria:**
- `docker-compose up --scale worker=4` launches 4 independent worker containers that each pull jobs from the shared BullMQ queue
- A 40-test suite with `shards: 4` completes in ~1/4 the wall-clock time of `shards: 1` (same acceptance criterion as CAP-002b Gap 1)
- Worker crash mid-test → BullMQ retry picks up the job on a surviving worker; no orphan `running` runs
- Dashboard shows live worker count + queue depth when Redis is configured; gracefully degrades to "single-process mode" when Redis is absent
- Zero regression: single-process deployments (no Redis, no `worker` service) behave identically to today

### PR checklist (AUTO-008)
- [ ] `backend/src/workers/runWorker.js` is stateless — no local-filesystem state survives a container restart
- [ ] `docker-compose.yml` `worker` service uses the same image as `web` with a different entrypoint
- [ ] Dashboard worker-pool panel renders queue metrics from BullMQ
- [ ] `backend/tests/` covers worker-crash recovery + multi-worker job distribution
- [ ] `docs/guide/getting-started.md` documents the `--scale worker=N` deployment pattern
- [ ] `docs/changelog.md` `## [Unreleased]` updated
- [ ] `QA.md` § Distributed Runner updated with manual test plan
- [ ] PROC-001 satisfied: any new backend route has a matching frontend consumer

---

## ⏭ Queue (next 3 PRs after current)
### 1 · SEC-004 — MFA (TOTP / passkey) support
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-004)

### 2 · SEC-006 — PII firewall
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-006)

### 3 · INF-007 — OTel / Sentry observability
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 5 (INF-007)

> **Phase 5 audit-hardening blockers** (`SEC-004` MFA, `SEC-006` PII firewall, `INF-007` OTel/Sentry, `INF-008` Postgres-default + dual-DB CI matrix, `AUTO-022` AI eval harness) remain queued in `ROADMAP.md` Phase 5.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| DIF-015c (Gaps 2/3/5/6) | Recorder gaps completion — point-and-click assert UX + `assertCount`/`assertHasClass` kinds + pause/resume/undo + device profiles (launch + mid-session switch) + stealth launch profile (hand-rolled, no new deps). 5 new `qa_lead`-gated routes, 31-step QA plan, 5 Tier-3 UI tests, 25+ backend unit tests. | #8 |
| AUTO-010 | Root-cause failure clustering. Deterministic clusterer (`failureClusterer.js`) groups failed results by normalised error fingerprint, URL origin prefix, and selector edit-distance — no DB, no LLM. `runs.rootCauses` persisted via migration 027; called from both the single-process tail in `testRunner.js` AND `finalizeShardedRun` in `runWorker.js` (CAP-002 parity). Run Detail renders a collapsible "Root Cause Summary" panel that auto-expands when ≥2 clusters surface. | #6 |
| CAP-002 | Distributed test sharding across runners. End-to-end cross-process sharding for `POST /api/v1/projects/:id/run` and `POST /api/v1/projects/:id/trigger`. `shards: N > 1` fans out across N BullMQ shard workers; boundary-crossing shard finalizes exactly once via atomic `incrementShardsCompleted` + `markRunCompletedFirstWriterWins`. 7 dedicated backend test files, 24-step QA manual plan, per-shard trace dropdown, CI/CD callback + GitHub Check completion on sharded runs. Deferred to CAP-002b: 10 SaaS-readiness follow-ups. | #3 |
| DIF-012 | Multi-environment support (staging vs. production). | #2 |

*Full completed list → ROADMAP.md § Completed Work*
