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

## ▶ Current PR — DIF-015c (Gaps 2/3/4/5/6) — Recorder gaps completion
**Effort:** M (bundled 4×S) | **Priority:** 🟢 Differentiator (parity with BearQ / Mabl / Testim) | **Dependencies:** DIF-015 ✅, DIF-015b ✅, DIF-015c Gap 1 ✅ PR #11, DIF-015c Gap 2 backend ✅ PR #118 | **Source:** `ROADMAP.md` Phase 3 (DIF-015c sub-items) — promoted per `NEXT.md` rotation after AUTO-010 shipped in PR #6
PR #115 made the recorder canvas interactive and aligned recorded steps with the AI-generated / manual format, but four gaps remain that surface during real use against e-commerce, kanban, and admin-dashboard targets. Bundled because all four touch the same `backend/src/runner/recorder.js` + `frontend/src/components/run/RecorderModal.jsx` surface within a single reviewable boundary; doing them separately means re-opening the same files four times with merge-conflict risk on `RECORDER_SCRIPT`.
### Gap 2 — Inline assertion authoring (point-and-click UX, parity with BearQ)
PR #118 already shipped the backend: `POST /api/v1/projects/:id/record/:sessionId/assertion` (`backend/src/routes/tests.js:1164-1184`) and server-side `addAssertionAction()` (`backend/src/runner/recorder.js:827-855`) support `assertVisible`, `assertText`, `assertValue`, and `assertUrl`. The `RecorderModal` already exposes an "Add assertion" form. **Remaining:** point-and-click UX — when the assert toggle is active, suppress `forwardInput` on the canvas, highlight the hovered element via CDP `Overlay.highlightNode`, and open the assertion picker pre-filled with that element's `bestSelector()` output. Add an `assertMode` prop on `frontend/src/components/run/LiveBrowserView.jsx` that suppresses input forwarding and surfaces hover targets back to the modal. `assertCount` and `assertHasClass` need a new action kind on the backend (typedef + `actionsToPlaywrightCode` branch + `recordedActionToStepText` branch + `isEmittableAction` branch + regression test); the other four are already wired.
### Gap 3 — Pause / resume + undo last action
Once recording starts, every action is captured through to Stop. Add `POST /record/:sessionId/{pause,resume,pop-last}` routes + session-state guards in `forwardInput` (short-circuit when `session.paused === true`). The server-side change is small; the UX work in `RecorderModal` (pause/resume control + undo affordance + optional mid-recording edit of the last action's fill value) is the larger lift. Justifies: recorder captures password keystrokes when pause was unavailable (currently truncated to 40 chars in step prose but the full value lives in `playwrightCode`) → pause closes that exfiltration window; mis-clicks today force a full session discard → undo restores the prior investment.
#### Gap 4 — Authentication / pre-logged-in state handling

The recorder starts at `startUrl` with a fresh browser context — no cookies, no localStorage, no logged-in state. Three flows have no good answer today:

1. **Recording a test against an authenticated app** — user must record the login flow as part of every test, even though the resulting test will execute under a different fixture in CI. Workaround is to record the full login each time.
2. **Recording behind SSO / OAuth** — login redirects through a third-party IdP (Google / Okta / Azure AD); the recorder captures the IdP form fields but those selectors are useless at replay (the IdP UI changes; tests cannot be rerun against a different env).
3. **MFA-protected logins** — every recording requires re-doing MFA, which is not deterministic.

Possible fix: integrate with project credential profiles (DIF-010) so the recorder browser context is seeded with `storageState` from a captured login, skipping login entirely. Pair with environment-aware credential profiles per `MNT-004` / `DIF-012`.
### Gap 5 — Mobile / touch / device profile during recording
The recorder runs at desktop viewport only — no device dropdown in `RecorderModal`. Thread a `device` param through `POST /api/v1/projects/:id/record` → `backend/src/runner/recorder.js`, and set `browser.newContext({ ...devices[device] })` the same way `executeTest.js` already does for runs (DIF-003). UX is a device dropdown in `RecorderModal` mirroring the one in `RunRegressionModal.jsx`.
### Gap 6 — Stealth launch profile for sites that detect headless
Some target apps detect headless Chromium (via `navigator.webdriver`, missing chrome plugins, viewport inconsistencies) and refuse to render. Today's workaround is `BROWSER_HEADLESS=false` (per `REVIEW.md:154-156`). Add a "stealth" launch profile to `launchBrowser()` that hides automation markers — `playwright-extra` + `puppeteer-extra-plugin-stealth` is the conventional choice. Gate behind an opt-in `stealth: true` session param so default recordings stay deterministic.
**Files to change:**
- `backend/src/runner/recorder.js` — `RECORDER_SCRIPT` extensions for Gap 2 action kinds; typedef + `actionsToPlaywrightCode` + `recordedActionToStepText` + `isEmittableAction` branches; pause/resume/pop-last session-state guards in `forwardInput`; `device` + `stealth` params threaded through session creation
- `backend/src/routes/tests.js` — `POST /record` param surface (`device`, `stealth`); new `POST /record/:sessionId/{pause,resume,pop-last}` endpoints
- `backend/src/middleware/permissions.json` — register the three new recorder mutation routes (qa_lead+)
- `frontend/src/components/run/RecorderModal.jsx` — assert toggle (Gap 2) with hover-to-pick; pause/resume controls (Gap 3); device dropdown (Gap 5); stealth toggle (Gap 6)
- `frontend/src/components/run/LiveBrowserView.jsx` — `assertMode` prop suppresses `forwardInput`; hover-target callback surfaces selector back to the modal
- `frontend/src/api.js` — `pauseRecorder`, `resumeRecorder`, `popLastRecorderAction`, `addRecorderAssertion` (point-and-click variant) consumers
- `backend/tests/recorder.test.js` — per-Gap coverage (registered in `backend/tests/run-tests.js`); default-mode snapshot proves bit-for-bit unchanged
- `tests/e2e/specs/recorder-gaps-ui.spec.mjs` (new, Tier-3 `page.route()` mocks) — assert popover renders, pause toggle visually distinct, device dropdown switches viewport on resume
- `QA.md` § Recorder — captured / not-captured lists per gap; manual checks for `assertCount`/`assertHasClass`, pause-then-resume continuity, device profile mid-recording, stealth-flag headless detection
- `docs/changelog.md` `## [Unreleased]` § Added — one entry per shipped sub-item
- `docs/api/projects.md` — document the three new recorder routes alongside the existing assertion endpoint
**Acceptance criteria:**
- Gap 2: Operator clicks "Assert" in `RecorderModal`, hovers a button on the live canvas → button highlights → click opens popover with `assertVisible / assertText / assertCount / assertHasClass / assertUrl`. Selecting one writes the assertion via the existing route. No manual selector paste required.
- Gap 3: Pause → subsequent clicks / keystrokes do **not** append to `session.actions`. Resume → capture continues from a clean state (no buffered events replay). Pop-last → most recent action is removed from `session.actions` and disappears from the step preview; idempotent on empty `actions[]`.
- Gap 5: Device dropdown shows the same options as `RunRegressionModal`. Switching mid-session resizes the canvas to match; selectors regenerated at the new viewport's pixel scale.
- Gap 6: Stealth toggle on a fresh session disables `navigator.webdriver` and the headless-detection bypass works on a known guard-script fixture (regression test in `recorder.test.js`).
- Zero regression: default-mode recordings (no assert toggle, no pause, no device override, no stealth) emit byte-identical `playwrightCode` to PR #11 baseline; covered by snapshot test.
### PR checklist (DIF-015c)
- [ ] Gap 2 — point-and-click assert UX: `LiveBrowserView.assertMode` prop suppresses `forwardInput`; CDP `Overlay.highlightNode` wired on hover; popover writes via existing `POST /record/:sessionId/assertion`; `assertCount` + `assertHasClass` action kinds added with regression coverage in `backend/tests/recorder.test.js`
- [ ] Gap 3 — pause / resume / undo: `POST /record/:sessionId/{pause,resume,pop-last}` registered in `permissions.json` (qa_lead+); `forwardInput` short-circuits when `session.paused === true`; pop-last idempotent on empty `actions[]`; UI affordances with visible state indicator
- [ ] Gap 4
- [ ] Gap 5 — device profile: `device` param threaded `POST /record → recorder.js`; `browser.newContext({ ...devices[device] })` applied; dropdown in `RecorderModal` mirrors `RunRegressionModal`; mid-session device switch verified
- [ ] Gap 6 — stealth profile: opt-in `stealth: true` session param; `launchBrowser()` accepts and applies the stealth-plugin stack; default-mode bit-for-bit unchanged; headless-detection bypass verified against guard-script fixture
- [ ] `backend/tests/recorder.test.js` covers all four gaps and is registered in `backend/tests/run-tests.js`
- [ ] `tests/e2e/specs/recorder-gaps-ui.spec.mjs` (Tier-3) covers the new UI affordances via `page.route()` mocks
- [ ] PROC-001 satisfied: every new `router.<method>(…)` has a matching frontend consumer in `frontend/src/api.js` + `RecorderModal.jsx`
- [ ] `permissions.json` updated for the three new recorder mutation routes
- [ ] `docs/api/projects.md` documents the new routes; `docs/changelog.md` `## [Unreleased]` updated per shipped sub-item
- [ ] `QA.md` § Recorder updated with the four-gap manual test plan

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
