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

## ▶ Current PR — DIF-015c (Gaps 2/3/5/6) — Recorder gaps completion
**Effort:** M (bundled 4×S) | **Priority:** 🟢 Differentiator (parity with BearQ / Mabl / Testim) | **Dependencies:** DIF-015 ✅, DIF-015b ✅, DIF-015c Gap 1 ✅ PR #11, DIF-015c Gap 2 backend ✅ PR #118 | **Source:** `ROADMAP.md` Phase 3 (DIF-015c sub-items) — promoted per `NEXT.md` rotation after AUTO-010 shipped in PR #6

Promoted from queue slot 1 after AUTO-010 moved to Recently Completed. Original scope unchanged — see `ROADMAP.md` § DIF-015c sub-section for the full Gap 2 (inline assertion authoring point-and-click UX + `assertCount` / `assertHasClass`), Gap 3 (pause / resume / undo + edit mid-recording), Gap 5 (mobile / device profile during recording), and Gap 6 (stealth launch profile for sites that detect headless) breakdown. Bundled because all four touch the same `recorder.js` + `RecorderModal.jsx` surface within a single reviewable boundary; doing them separately means re-opening the same files four times with merge-conflict risk on `RECORDER_SCRIPT`.

---

## ⏭ Queue (next 3 PRs after current)
### 1 · AUTO-008 — Distributed runner across multiple machines
**Effort:** XL | **Priority:** 🟢 Differentiator | **Dependencies:** INF-003 ✅, INF-002 ✅, CAP-002 ✅ (PR #3) | **Source:** `ROADMAP.md` Phase 4 (AUTO-008)

### 2 · SEC-004 — MFA (TOTP / passkey) support
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-004)

### 3 · SEC-006 — PII firewall
**Effort:** L | **Priority:** 🔴 Blocker | **Dependencies:** ACL-001 ✅ | **Source:** `ROADMAP.md` Phase 5 (SEC-006)

> **Phase 5 audit-hardening blockers** (`SEC-004` MFA — slot 3 above; `SEC-006` PII firewall, `INF-007` OTel/Sentry, `INF-008` Postgres-default + dual-DB CI matrix, `AUTO-022` AI eval harness) remain queued in `ROADMAP.md` Phase 5.

---

## ✅ Recently completed

| ID | Title | PR |
|----|-------|----|
| AUTO-010 | Root-cause failure clustering. Deterministic clusterer (`failureClusterer.js`) groups failed results by normalised error fingerprint, URL origin prefix, and selector edit-distance — no DB, no LLM. `runs.rootCauses` persisted via migration 027; called from both the single-process tail in `testRunner.js` AND `finalizeShardedRun` in `runWorker.js` (CAP-002 parity). Run Detail renders a collapsible "Root Cause Summary" panel that auto-expands when ≥2 clusters surface. | #6 |
| CAP-002 | Distributed test sharding across runners. End-to-end cross-process sharding for `POST /api/v1/projects/:id/run` and `POST /api/v1/projects/:id/trigger`. `shards: N > 1` fans out across N BullMQ shard workers; boundary-crossing shard finalizes exactly once via atomic `incrementShardsCompleted` + `markRunCompletedFirstWriterWins`. 7 dedicated backend test files, 24-step QA manual plan, per-shard trace dropdown, CI/CD callback + GitHub Check completion on sharded runs. Deferred to CAP-002b: 10 SaaS-readiness follow-ups. | #3 |
| DIF-012 | Multi-environment support (staging vs. production). | #2 |

*Full completed list → ROADMAP.md § Completed Work*

_END OF FILE — everything below was removed during the CAP-002 → AUTO-010 sprint rotation._
