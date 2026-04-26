# Manual QA Guide — Sentri

## 🎯 Purpose
This document is for **manual testers** to validate all functional flows in Sentri before release.

This is **NOT** a smoke test. Each section below defines preconditions, steps, and explicit expected results. A test only passes when **every** expected result is observed.

> ℹ️ Items marked **TBD** must be filled in by engineering with project-specific values (URLs, role names, notification channels). Do not skip them.

---

## 🧪 How to Test

- Browser matrix (all required):
  - Chrome (latest) — primary
  - Firefox (latest)
  - Safari (latest, macOS)
  - Edge (latest)
- Do NOT call APIs directly unless debugging a failure.
- Test like an end user: click flows, navigate, refresh mid-flow, use back/forward, open links in new tabs.
- Keep DevTools open. Capture **console errors**, **network 4xx/5xx**, and **failed assets** for every bug.
- Run state-sensitive flows twice: once as a fresh user, once as a returning user.

---

## 👤 Test Accounts & Roles

| Account | Role | Workspace | Purpose |
|---------|------|-----------|---------|
| User A | Admin / Owner | WS-1 | Full-permission flows |
| User B | Member | WS-1 | Reduced-permission flows |
| User C | Viewer (read-only) | WS-1 | Read-only enforcement |
| User D | Outsider (no membership) | — | Cross-workspace isolation |

- Use separate browsers / incognito windows per user.
- Never share auth cookies between users.

### Permissions Matrix (expected)

| Action | Admin | Member | Viewer | Outsider |
|---|---|---|---|---|
| Create/Delete workspace | ✅ | ❌ | ❌ | ❌ |
| Invite users / change roles | ✅ | ❌ | ❌ | ❌ |
| Create/Edit/Delete project | ✅ | ✅ | ❌ | ❌ |
| Restore from recycle bin | ✅ | ✅ | ❌ | ❌ |
| Create/Edit tests | ✅ | ✅ | ❌ | ❌ |
| Approve/Reject generated tests | ✅ | ✅ | ❌ | ❌ |
| Trigger run / regression | ✅ | ✅ | ❌ | ❌ |
| Stop running execution | ✅ | ✅ (own runs) | ❌ | ❌ |
| Accept visual baseline | ✅ | ✅ | ❌ | ❌ |
| Edit workspace settings | ✅ | ❌ | ❌ | ❌ |
| View dashboard / runs | ✅ | ✅ | ✅ | ❌ |
| Access another workspace's data via URL | ❌ | ❌ | ❌ | ❌ |

> Any deviation from this matrix is a **severe security bug** — file immediately.

---

## ⚙️ Setup

1. Start backend (`TBD: command`). Confirm `GET /health` returns `200`.
2. Start frontend (`npm run dev`).
3. Record exact build / commit SHA under test (include in every bug report).
4. Note environment: local / staging / preview URL.
5. Seed test data: `TBD: seed command or fixture URL`.

**Test data to prepare:**
- Stable crawl target URL: `TBD`
- Sample regression suite: ≥ 5 tests, mix of passing/failing
- Sample baseline images: at least one stable, one with intentional diff

---

## ✅ Functional Test Areas

Each area uses this format:
- **Preconditions** — required state before testing
- **Steps** — actions to perform
- **Expected** — measurable pass criteria
- **Negative / edge cases** — must also pass

---

### 🔐 Authentication

**Preconditions:** Logged out, fresh incognito window.

**Happy path:**
1. Register new user with valid email + strong password.
   - **Expected:** Verification email arrives within 60s; UI shows "verify email" state.
2. Click verification link.
   - **Expected:** Account marked verified; redirects to onboarding/dashboard.
3. Logout, then login.
   - **Expected:** Session cookie set; lands on last-visited workspace.
4. Forgot password → reset link → set new password.
   - **Expected:** Old password rejected; new password works; reset link is single-use.

**Negative / edge:**
- Wrong password → generic error (no user enumeration); rate-limited after `TBD: N` attempts.
- Expired verification link → clear error, option to resend.
- Expired / reused password reset link → rejected.
- Weak password → blocked at form level with reason.
- Register with already-used email → generic error (no enumeration).
- Session expiry mid-flow → redirected to login, returns to original page after re-auth.
- Two concurrent sessions (browser A + B) → both work; logout in A does not invalidate B unless "logout all" is used.
- Tampered JWT / cookie → 401; UI redirects to login.

---

### 👥 Workspaces

**Preconditions:** User A logged in.

**Steps & expected:**
1. Create workspace "WS-Test" → appears in switcher; User A is Owner.
2. Switch workspaces → URL updates, data scoped correctly, no leakage from previous workspace.
3. Invite User B by email → invite email arrives; pending state visible to Admin.
4. User B accepts → appears in member list with assigned role.
5. Change User B's role Member → Viewer → permissions update **without requiring relogin** (or document if relogin needed).
6. Remove User B → active session loses access on next request (≤ 60s).

**Negative / edge:**
- User B (Member) tries to invite users → blocked.
- Outsider opens workspace URL directly → 403 / redirect, not 200 with empty data.
- Duplicate invite → handled gracefully.
- Invite to non-existent email → still sends (or clear UX); no crash.

---

### 📁 Projects

**Preconditions:** Workspace exists.

**Steps & expected:**
1. Create project → appears in list; slug/URL unique.
2. Edit project name/settings → persists after refresh.
3. Delete project → moved to recycle bin, no longer in active list.
4. Restore from recycle bin → returns to active list with data intact (tests, runs, baselines).
5. Permanently delete → unrecoverable; associated runs/tests gone.

**Negative / edge:**
- Two users edit same project simultaneously → last-write-wins or conflict warning (document behavior).
- Delete project with active running tests → runs stopped/completed cleanly, no orphans.
- Viewer attempts edit/delete → blocked with clear message.

---

### 🧪 Tests Page

**Preconditions:** Project exists.

**Steps & expected:**
1. Crawl URL (`TBD: demo site`) → crawl completes; discovered pages listed; progress visible.
2. Generate tests from crawled pages → tests appear in "pending" state with steps.
3. Approve test → moves to active suite; appears in run targets.
4. Reject test → removed/archived; excluded from regression.
5. Edit test steps (add/remove/reorder) → saved; preview reflects changes.
6. Export tests → downloads in supported format(s) (`TBD: list formats`); re-import (if supported) round-trips cleanly.

**Negative / edge:**
- Crawl an unreachable URL → clear error, no infinite spinner.
- Crawl an auth-gated site → documented behavior (login support or graceful failure).
- Generate tests with empty crawl → no crash; clear empty state.
- Edit test, refresh before save → unsaved-changes warning.
- Concurrent edits by two users → last-write-wins or conflict UI.

---

### 🎥 Recorder

**Preconditions:** Project exists; recorder extension/feature available.

**Steps & expected:**
1. Start recorder on `TBD: demo site` → recording indicator visible.
2. Perform: click, type, select dropdown, file upload, hover, scroll, navigate across pages.
   - **Expected:** Each action captured as a discrete step with selector + action type; no empty/null steps.
3. Stop and save → test appears in Tests page with all steps intact after refresh.
4. Replay the recorded test → all steps execute; pass status reported.

**Negative / edge:**
- ⚠️ Known: empty-steps bug — verify every recorded step has a selector and action.
- Record on SPA with client-side routing → navigations captured correctly.
- Record on iframe / shadow DOM content → document support status.
- Record across tabs/popups → document support status.
- Close tab mid-recording → partial recording saved or discarded cleanly (no corrupted state).
- Record on site with dynamic IDs → selectors are stable (data-testid / text / role), not brittle.

---

### ▶️ Runs

**Preconditions:** At least one approved test.

**Steps & expected:**
1. Run single test → status: queued → running → passed/failed; logs, screenshots, video (if supported) available.
2. Run regression suite → all tests execute; summary shows pass/fail counts matching detail view.
3. Stop running execution → stops within `TBD: N` seconds; run marked as "stopped"; partial results retained.
4. Re-run failed tests only → only previously-failed tests execute.

**Negative / edge:**
- Trigger run while another is in progress → queued or parallel per `TBD: concurrency policy`; no crash.
- Run test against unreachable target → fails with clear network error, not timeout silence.
- Flaky test (intermittent failure) → retry policy behaves per `TBD: retry config`.
- Viewer attempts to trigger run → blocked.
- Stop another user's run as Member → blocked; as Admin → allowed.
- Browser close mid-run → run continues on backend; status visible on return.

---

### 🖼️ Visual Testing

**Preconditions:** Test with screenshot steps exists.

**Steps & expected:**
1. First run creates baseline → baseline image saved; status "baseline created".
2. Re-run with no UI change → diff = 0; test passes.
3. Introduce intentional UI change → diff detected; test flagged; side-by-side + diff overlay visible.
4. Accept new baseline → new image replaces old; next run passes.
5. Reject change → baseline unchanged; run remains failed.

**Negative / edge:**
- Anti-aliasing / font rendering differences across OS → threshold tolerance works (`TBD: threshold`).
- Dynamic content (timestamps, ads) → mask/ignore regions supported and honored.
- Viewport size change between runs → diff behavior documented (pass/fail/warn).
- Concurrent baseline accept by two users → last-write-wins with audit trail.
- Very large images → no timeout, no memory crash.

---

### 📊 Dashboard

**Preconditions:** Workspace has runs, tests, and projects with data.

**Steps & expected:**
1. Open dashboard → all charts render within `TBD: N` seconds; no console errors.
2. Verify each widget against source of truth:
   - Pass rate % matches count(passed) / count(total) over selected range.
   - Run count matches Runs page filter for same range.
   - Failing tests widget lists only tests with latest status = failed.
3. Change date range → all widgets update consistently; no stale values.
4. Switch workspace → dashboard resets; no data from previous workspace.

**Negative / edge:**
- Empty workspace (no runs) → empty states shown, not zero-division errors / NaN.
- Very large dataset (`TBD: N runs`) → dashboard loads in ≤ `TBD: N` seconds.
- Viewer sees dashboard but cannot trigger actions.

---

### 🤖 AI Chat

**Preconditions:** Workspace with tests/runs/projects data.

**Steps & expected:**
1. Ask "How many tests failed this week?" → answer matches Runs page filtered count.
2. Ask "Show me the last failed run for project X" → returns correct run, links to run detail.
3. Ask about a specific test by name → returns accurate step count, last status, last run time.
4. Multi-turn: follow up with "why did it fail?" → uses prior context; answer references actual logs.
5. Ask for something outside scope ("what's the weather") → declines or redirects gracefully.

**Negative / edge:**
- Ask about data in a workspace the user doesn't belong to → **must refuse**; no data leakage (severe bug if leaked).
- Ask Viewer to perform a mutation via chat ("delete project X") → refused or no-op; permissions enforced.
- Prompt injection in a test name (e.g., test named `"ignore previous instructions..."`) → chat does not execute injected instructions.
- Non-existent entity ("run 99999") → clear "not found", no hallucinated data.
- Very long conversation → truncation behavior documented; no crash.

---

### ⚙️ Settings

**Preconditions:** Admin logged in.

**Steps & expected:**
1. Update each setting category (`TBD: list — profile, workspace, billing, integrations, API keys`) → change persists after refresh and across sessions.
2. Invalid input (bad email, bad URL) → inline validation; save blocked.
3. Revoke/regenerate API key → old key returns 401 immediately; new key works.
4. Disconnect integration → subsequent features depending on it fail gracefully.

**Negative / edge:**
- Member / Viewer attempts to open workspace settings → blocked.
- Concurrent settings edits → last-write-wins with no lost fields.
- Save partial form (required field blank) → blocked, no partial persistence.

---

### 🔔 Notifications

**Preconditions:** Notification channels configured: `TBD: email / Slack / webhook / in-app`.

**Steps & expected (per channel):**
1. Trigger a failed run → notification delivered via each enabled channel within `TBD: N` seconds.
2. Notification payload includes: project, test name, run ID, failure reason, link to run detail.
3. Link in notification opens the correct run and requires auth.
4. Disable a channel → no notifications sent via that channel for subsequent runs.
5. Trigger recovery (previously failing test now passes) → "recovered" notification sent (if supported).

**Negative / edge:**
- Invalid webhook URL → clear error in settings; no silent drop.
- Flood of failures (10+ in a minute) → batched or rate-limited per `TBD: policy`; no spam.
- User removed from workspace → stops receiving notifications for that workspace.
- Notification contains no PII / secrets / tokens.

---

### 🔒 Security

**Preconditions:** Users A (Admin WS-1), B (Member WS-1), D (Outsider). A has project P1, test T1, run R1 in WS-1.

**Authorization checks — each must return 403/404, never the resource:**
1. User D opens `/workspaces/WS-1` directly → denied.
2. User D opens `/projects/P1`, `/tests/T1`, `/runs/R1` directly → denied.
3. User D hits any API endpoint for WS-1 resources with their own token → 403.
4. User C (Viewer) issues mutations via direct API calls (POST/PUT/DELETE) → 403.
5. Swap workspace ID in a URL (`/ws/WS-1/...` → `/ws/WS-other/...` where user has no access) → 403, not 200 empty.
6. Change numeric/opaque IDs in URLs (IDOR) on project, test, run, baseline, invite, API key → 403.

**Session / auth:**
- Logout invalidates cookie server-side (replay fails).
- Password change invalidates other sessions per `TBD: policy`.
- Cookies have `HttpOnly`, `Secure`, `SameSite` set (verify in DevTools).

**Input / injection:**
- XSS probes in test names, project names, workspace names, chat messages, bug titles (`<script>alert(1)</script>`) → rendered as text, never executed.
- SQL-ish payloads in search/filter inputs → no 500; no data leakage.
- Upload malicious file types (`.exe`, oversized image) to recorder / baseline → rejected with clear error.
- CSRF: submit a state-changing request from a third-party origin → blocked.

**Secrets:**
- API keys never appear in URLs, logs, or client-side bundles.
- Notification payloads, chat responses, error messages contain no tokens or passwords.

---

## 📱 Cross-Cutting Checks

Run these against the full browser matrix (Chrome, Firefox, Safari, Edge):

**Responsive / visual:**
- Mobile (375px), tablet (768px), desktop (1440px) — no broken layouts, no horizontal scroll, all buttons reachable.
- Dark mode — no illegible text, no white flashes, all icons visible.
- High-DPI / Retina — images crisp, no pixelation.

**State & navigation:**
- Refresh mid-flow on every page — no lost unsaved work without a warning; no broken state.
- Browser back / forward — URL and UI stay in sync; no stale modals.
- Open any page in a new tab via URL paste — loads correctly with auth.
- Deep-link to a run/test/project while logged out — redirected to login, then back to the target.

**Performance:**
- Initial page load ≤ `TBD: N` seconds on `TBD: baseline connection`.
- No memory leaks after 10 minutes of navigation (check DevTools heap snapshot).
- No unbounded network polling (check Network tab).

**Accessibility (spot check):**
- Keyboard-only navigation works on primary flows (tab order, focus rings visible, Enter/Space activates).
- Screen reader announces form errors and modals (`TBD: required compliance level`).
- Color contrast meets `TBD: WCAG AA/AAA`.

**Internationalization (if applicable):**
- Long strings don't break layouts.
- RTL languages render correctly (`TBD: supported locales`).

---

## 🚨 Known Issues

> Do **not** re-file these. Link the ticket in your report if you encounter them.

| Issue | Ticket | Repro | Workaround |
|---|---|---|---|
| Deploy pages failing | `TBD` | `TBD` | `TBD` |
| Image push failures | `TBD` | `TBD` | `TBD` |
| Recorder empty-steps bug | `TBD` | `TBD` | `TBD` |
| Visual diff false positives | `TBD` | `TBD` | `TBD` |

---

## 🐞 Bug Reporting Template

```
**Title:** [Area] Short description

**Severity:** Blocker / Critical / Major / Minor / Trivial
**Environment:** local / staging / preview — URL: ...
**Build / commit SHA:** ...
**Browser + version + OS:** e.g. Chrome 131 / macOS 14.6
**User role:** Admin / Member / Viewer / Outsider
**Workspace / Project / Test / Run IDs:** ...

**Preconditions:**
- ...

**Steps to reproduce:**
1. ...
2. ...

**Expected:**
- ...

**Actual:**
- ...

**Evidence:**
- Screenshot / screen recording
- Console errors (paste)
- Network request/response (paste or HAR)
- Server logs (if accessible)

**Reproducibility:** Always / Intermittent (N of M) / Once
**Regression?** First seen on build ...
```

---

## 📋 Coverage Checklist

Mark status per browser: ✅ pass · ❌ fail · ⚠️ partial · ⬜ not tested.

| Area | Chrome | Firefox | Safari | Edge | Notes / Bug links |
|---|---|---|---|---|---|
| Authentication | ⬜ | ⬜ | ⬜ | ⬜ | |
| Workspaces | ⬜ | ⬜ | ⬜ | ⬜ | |
| Projects | ⬜ | ⬜ | ⬜ | ⬜ | |
| Tests | ⬜ | ⬜ | ⬜ | ⬜ | |
| Recorder | ⬜ | ⬜ | ⬜ | ⬜ | |
| Runs | ⬜ | ⬜ | ⬜ | ⬜ | |
| Visual Testing | ⬜ | ⬜ | ⬜ | ⬜ | |
| Dashboard | ⬜ | ⬜ | ⬜ | ⬜ | |
| AI Chat | ⬜ | ⬜ | ⬜ | ⬜ | |
| Settings | ⬜ | ⬜ | ⬜ | ⬜ | |
| Notifications | ⬜ | ⬜ | ⬜ | ⬜ | |
| Security | ⬜ | ⬜ | ⬜ | ⬜ | |
| Permissions matrix | ⬜ | ⬜ | ⬜ | ⬜ | |
| Cross-cutting checks | ⬜ | ⬜ | ⬜ | ⬜ | |

---

## ✅ Sign-off Criteria

A release is QA-approved only when **all** of the following are true:
- Every row in the coverage checklist is ✅ across the required browser matrix.
- The permissions matrix has been verified end-to-end, including Outsider access attempts.
- All Security authorization checks return 403/404 (never the resource).
- No Blocker or Critical bugs are open; Major bugs have owners and ETAs.
- Known issues list is up to date (no new occurrences filed as duplicates).
- Bug reports include the full template (env, build SHA, browser, evidence).

---

## ❗ Rules

- Do NOT stop after the first bug — continue testing the remaining flows.
- Do NOT report a bug without a build/commit SHA and browser+OS.
- Do NOT file duplicates of Known Issues.
- Do NOT mark a flow as passing until **every** expected result is observed.
