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

## ▶ Current PR — SEC-004 — MFA (TOTP / passkey) support
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-004) — promoted per `NEXT.md` rotation after AUTO-008 shipped in PR #9

**Problem:** There is no multi-factor authentication. MFA is a compliance requirement (SOC 2, ISO 27001) and a sales blocker for regulated industries.

**Fix:** Add TOTP-based MFA using `otplib`. Store the encrypted TOTP secret in the `users` table. Add MFA setup flow (QR code generation), MFA verification at login, and recovery codes. Passkey (WebAuthn) support can follow in a subsequent sprint.

**Files to change:**
- `backend/src/routes/auth.js` — MFA enroll, verify, and recovery endpoints
- `backend/src/database/migrations/` — add `mfaSecret`, `mfaEnabled`, `mfaRecoveryCodes` to `users`
- `frontend/src/pages/Login.jsx` — MFA verification step
- `frontend/src/pages/Settings.jsx` — MFA setup and management
- `docs/changelog.md` `## [Unreleased]` § Added

**Acceptance criteria:**
- New users can enrol a TOTP secret via QR code from Settings; secret stored AES-encrypted via `credentialEncryption.js`
- Login flow prompts for TOTP code when `mfaEnabled = 1`; recovery codes accepted as one-shot fallbacks
- Per-workspace MFA enforcement policy (admin-configurable)
- Zero regression: users without MFA enrolled continue to log in via password / OAuth unchanged

### PR checklist (SEC-004)
- [ ] TOTP secret column AES-encrypted at rest (reuse `encryptString` / `decryptString`)
- [ ] Recovery codes hashed (single-use, audit-logged on consumption)
- [ ] `permissions.json` updated for new MFA routes
- [ ] `backend/tests/` covers enrol, verify, recovery, and disabled-MFA happy path
- [ ] `docs/changelog.md` `## [Unreleased]` updated
- [ ] `QA.md` § MFA updated with manual test plan
- [ ] PROC-001 satisfied: any new backend route has a matching frontend consumer

---

## ⏭ Queue (next 4 PRs after current)
### 1 · SEC-006 — PII firewall
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-006)

### 2 · SEC-007 — Compliance audit log surface (immutability + auth events + admin export)
**Effort:** M | **Priority:** 🟡 High (promoted from 🟢 Strategic) | **Dependencies:** SEC-004 (auth events emit from MFA routes — bundle if SEC-004 ships first; otherwise ship Phase 1 immutability MVP standalone) | **Source:** `ROADMAP.md` Phase 5 (SEC-007)
Sentri already records ~30 event types into `activities` via `logActivity()` with per-user attribution (ENH-021 ✅). Six gaps block SOC2/ISO27001: (1) `DELETE /api/v1/data/activities` lets admins purge the log — hard compliance fail; (2) auth events (login/logout/MFA/role-change/API-key) not emitted; (3) no admin-only workspace-wide compliance surface (the existing per-project Activity feed is a developer view); (4) no CSV/NDJSON export; (5) no retention policy enforcement; (6) no SIEM streaming. Phased fix: P1 immutability + auth events MVP, P2 admin page + export + retention, P3 SIEM (deferred until customer demand).

### 3 · INF-007 — OTel / Sentry observability
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 5 (INF-007)

### 4 · INF-008 — Postgres-default + dual-DB CI matrix
**Effort:** M | **Priority:** 🔴 Blocker | **Dependencies:** INF-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (INF-008)

> **Phase 5 audit-hardening blockers** (`SEC-006` PII firewall, `INF-007` OTel/Sentry, `INF-008` Postgres-default + dual-DB CI matrix, `AUTO-022` AI eval harness) remain queued in `ROADMAP.md` Phase 5. `SEC-007` (compliance audit log surface) sits between SEC-006 and INF-007 at 🟡 High — pairs naturally with SEC-004 since the auth-event emission lives alongside MFA enrolment routes.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AUTO-008 | Distributed runner across multiple machines. Standalone `worker` Compose service (`node src/worker.js`) under the `redis` profile, scaled via `docker compose --profile redis --profile postgres up --scale worker=N`. `WORKER_CONCURRENCY` env var (with `MAX_WORKERS` fallback) for per-container concurrency. Dashboard worker-pool panel (Runner Mode / Queue Depth / Active Workers / Completed Jobs) backed by `runQueue.getWorkers()` + `getQueueStats()`; gracefully degrades to `single-process` mode when Redis is absent. New `getCompletedCount()` exposed on `getQueueStats()`. Worker boots DB + AI keys + workspace backfill but binds no HTTP port. New `backend/tests/worker-pool-dashboard.test.js` covers the payload shape including capping `activeWorkers` at `totalWorkers`. | #9 |
| DIF-015c (Gaps 2/3/5/6) | Recorder gaps completion — point-and-click assert UX + `assertCount`/`assertHasClass` kinds + pause/resume/undo + device profiles (launch + mid-session switch) + stealth launch profile (hand-rolled, no new deps). 5 new `qa_lead`-gated routes, 31-step QA plan, 5 Tier-3 UI tests, 25+ backend unit tests. | #8 |
| AUTO-010 | Root-cause failure clustering. Deterministic clusterer (`failureClusterer.js`) groups failed results by normalised error fingerprint, URL origin prefix, and selector edit-distance — no DB, no LLM. `runs.rootCauses` persisted via migration 027; called from both the single-process tail in `testRunner.js` AND `finalizeShardedRun` in `runWorker.js` (CAP-002 parity). Run Detail renders a collapsible "Root Cause Summary" panel that auto-expands when ≥2 clusters surface. | #6 |
| CAP-002 | Distributed test sharding across runners. End-to-end cross-process sharding for `POST /api/v1/projects/:id/run` and `POST /api/v1/projects/:id/trigger`. `shards: N > 1` fans out across N BullMQ shard workers; boundary-crossing shard finalizes exactly once via atomic `incrementShardsCompleted` + `markRunCompletedFirstWriterWins`. 7 dedicated backend test files, 24-step QA manual plan, per-shard trace dropdown, CI/CD callback + GitHub Check completion on sharded runs. Deferred to CAP-002b: 10 SaaS-readiness follow-ups. | #3 |
| DIF-012 | Multi-environment support (staging vs. production). | #2 |

*Full completed list → ROADMAP.md § Completed Work*
