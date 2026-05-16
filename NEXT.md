# NEXT.md — Current Sprint Target

> **Agents:** Start here. Everything needed to begin the current PR is in this file. Open `ROADMAP.md` only to look up a specific item by ID or review phase context.
>
> **Humans:** When a PR ships — move the item to `ROADMAP.md` ✅ table, promote the next queue item to Current PR, and update Recently Completed.

---

## Bundling guidance

Flag adjacent items as bundling candidates in your PR description rather than expanding scope mid-flight. Good signals: items touch the same module, one validates the other end-to-end, or both are S/XS effort and skipping a handoff saves more than it costs in review surface. Bad signals: different phases, M+ effort expansion, or the candidate surfaces after CI is already green. When in doubt, comment on the PR and let the human decide — never silently expand beyond the Current PR checklist.

---

## ▶ Current PR — SEC-004 — MFA (TOTP / passkey) support

**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-004)

**Problem:** No multi-factor authentication. MFA is a compliance requirement (SOC 2, ISO 27001) and a sales blocker for regulated industries.

**Fix:** Add TOTP-based MFA using `otplib`. Store the encrypted TOTP secret in the `users` table. Add a setup flow (QR code generation), MFA verification at login, and recovery codes. Passkey (WebAuthn) support can follow in a subsequent sprint.

**Files to change:**
- `backend/src/routes/auth.js` — MFA enroll, verify, and recovery endpoints
- `backend/src/database/migrations/` — add `mfaSecret`, `mfaEnabled`, `mfaRecoveryCodes` to `users`
- `frontend/src/pages/Login.jsx` — MFA verification step
- `frontend/src/pages/Settings.jsx` — MFA setup and management
- `docs/changelog.md` `## [Unreleased]` § Added

**Acceptance criteria:**
- Users can enrol a TOTP secret via QR code from Settings; secret stored AES-encrypted via `credentialEncryption.js`
- Login prompts for TOTP when `mfaEnabled = 1`; recovery codes accepted as one-shot fallbacks
- Per-workspace MFA enforcement policy configurable by admins
- Users without MFA enrolled continue to log in via password / OAuth unchanged

### PR checklist (SEC-004)
- [ ] TOTP secret column AES-encrypted at rest (reuse `encryptString` / `decryptString`)
- [ ] Recovery codes hashed (single-use, audit-logged on consumption)
- [ ] `permissions.json` updated for new MFA routes
- [ ] `backend/tests/` covers enrol, verify, recovery, and disabled-MFA happy path
- [ ] `docs/changelog.md` `## [Unreleased]` updated
- [ ] `QA.md` § MFA updated with manual test plan
- [ ] PROC-001 satisfied: every new backend route has a matching frontend consumer

---

## ⏭ Queue (next 4 PRs after current)

### 1 · SEC-006 — PII firewall
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-006)

### 2 · SEC-007 — Compliance audit log surface (immutability + auth events + admin export)
**Effort:** M | **Priority:** 🟡 High | **Dependencies:** SEC-004 (auth events from MFA routes — bundle if SEC-004 ships first; otherwise ship Phase 1 immutability MVP standalone) | **Source:** `ROADMAP.md` Phase 5 (SEC-007)

Six gaps block SOC 2 / ISO 27001: the activity log is purgeable by admins, auth events are not emitted, there is no admin compliance surface or export, and no retention policy or SIEM streaming. Phased fix: P1 immutability + auth events, P2 admin page + export + retention, P3 SIEM on demand.

### 3 · INF-007 — OTel / Sentry observability
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** none | **Source:** `ROADMAP.md` Phase 5 (INF-007)

### 4 · INF-008 — Postgres-default + dual-DB CI matrix
**Effort:** M | **Priority:** 🔴 Blocker | **Dependencies:** INF-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (INF-008)

---

## 🔀 Parallel opportunities

Items that do not overlap SEC-004's changed files and can land in a separate PR while SEC-004 is in flight. "Shared files?" lists any files that *would* conflict if merged concurrently — flag in your PR description if you pick one up.

| ID | Title | Effort | Priority | Shared files? |
|----|-------|--------|----------|---------------|
| INF-007 | OTel / Sentry observability | L | 🔴 Blocker | None — touches `appSetup.js`, `otel.js`, `metrics.js`, `aiProvider.js`, `testRunner.js`, `selfHealing.js`, `main.jsx`; no overlap with auth or Settings |
| SEC-006 | PII firewall (domSanitizer pipeline stage) | M | 🔴 Blocker | None — `domSanitizer.js`, `pipelineOrchestrator.js`; entirely pipeline-layer |
| AUTO-022 | AI eval harness with golden-set regression | L | 🔴 Blocker | None — `pipelineEval.js`, `scorers.js`, `eval.yml`, `pipelineOrchestrator.js` (additive `promptVersion` emit only) |
| INF-008 | Postgres-default + dual-DB CI matrix | M | 🔴 Blocker | ⚠️ `backend/src/database/migrations/` — SEC-004 adds MFA migration files to the same directory; coordinate numeric prefix assignment to avoid collisions |
| MNT-001 | Vision-based locator healing | XL | 🟢 Differentiator | None — `selfHealing.js`, `executeTest.js` only |
| AUTO-009 | Browser code coverage mapping | L | 🟢 Differentiator | None — `executeTest.js`, `coverageAggregator.js`, `Dashboard.jsx` |

**Note:** SEC-007 (compliance audit log surface) depends on SEC-004 auth events — it cannot start Phase 1 independently until SEC-004's `auth.*` activity emission is merged. It is listed in the Queue, not here.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AUTO-008 | Distributed runner — standalone `worker` Compose service, `WORKER_CONCURRENCY` env var, dashboard worker-pool panel (Runner Mode / Queue Depth / Active Workers / Completed Jobs) | #9 |
| DIF-015c (Gaps 2/3/5/6) | Recorder gaps — point-and-click assert UX, `assertCount`/`assertHasClass` kinds, pause/resume/undo, device profiles (launch + mid-session switch), stealth launch profile | #8 |
| AUTO-010 | Root-cause failure clustering — deterministic clusterer grouping failed results by error fingerprint, URL prefix, and selector edit-distance; `runs.rootCauses` persisted; Run Detail "Root Cause Summary" panel | #6 |

*Full completed list → ROADMAP.md § Completed Work Summary*
