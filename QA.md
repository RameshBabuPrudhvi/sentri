# Manual QA Guide — Sentri

## 🎯 Purpose
This document is for **manual testers** to validate all functional flows in Sentri before release.

This is **NOT** a smoke test. Each section below defines preconditions, steps, and explicit expected results. A test only passes when **every** expected result is observed.

> ℹ️ Values below are grounded in `README.md`, `AGENT.md`, `ROADMAP.md` (ACL-002), and `backend/src/utils/notifications.js`. Any remaining `TBD` requires engineering confirmation (e.g. a stable demo crawl target).

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

Sentri defines three workspace roles (see `ROADMAP.md` ACL-002, stored in `workspace_members.role`): `admin`, `qa_lead`, `viewer`.

| Account | Role | Workspace | Purpose |
|---------|------|-----------|---------|
| User A | `admin` | WS-1 | Full-permission flows, settings, destructive ops |
| User B | `qa_lead` | WS-1 | Day-to-day QA flows (tests, runs) |
| User C | `viewer` | WS-1 | Read-only enforcement |
| User D | — (no membership) | — | Cross-workspace isolation |

- Use separate browsers / incognito windows per user.
- Never share auth cookies between users.

### Permissions Matrix (expected)

Derived from ACL-002: `admin` gates settings + destructive ops; `qa_lead` runs QA workflows; `viewer` is read-only. Verify these in-product — any deviation is a **severe security bug**.

| Action | admin | qa_lead | viewer | Outsider |
|---|---|---|---|---|
| Create/Delete workspace | ✅ | ❌ | ❌ | ❌ |
| Invite users / change roles | ✅ | ❌ | ❌ | ❌ |
| Edit workspace settings (AI keys, notifications) | ✅ | ❌ | ❌ | ❌ |
| Create/Edit/Delete project | ✅ | ✅ | ❌ | ❌ |
| Restore from recycle bin | ✅ | ✅ | ❌ | ❌ |
| Create/Edit tests | ✅ | ✅ | ❌ | ❌ |
| Approve/Reject generated tests | ✅ | ✅ | ❌ | ❌ |
| Trigger run / regression | ✅ | ✅ | ❌ | ❌ |
| Stop running execution | ✅ | ✅ (own runs) | ❌ | ❌ |
| Accept visual baseline | ✅ | ✅ | ❌ | ❌ |
| View dashboard / runs | ✅ | ✅ | ✅ | ❌ |
| Access another workspace's data via URL | ❌ | ❌ | ❌ | ❌ |

---

## ⚙️ Setup

From `README.md`:

```bash
# Backend (port 3001)
cd backend
npm install
npx playwright install chromium ffmpeg
cp .env.example .env            # Add at least one AI provider key
npm run dev

# Frontend (port 3000, proxies /api → :3001)
cd frontend
npm install
cp .env.example .env
npm run dev
```

Then:
1. Confirm backend `GET http://localhost:3001/health` returns `200`.
2. Open `http://localhost:3000`.
3. Record exact build / commit SHA under test (include in every bug report).
4. Note environment: local / staging / preview URL.
5. Dev-only seed endpoint is available when `NODE_ENV !== production` (see `AGENT.md`). Use it to pre-populate users/workspaces; otherwise register via UI.

**Test data to prepare:**
- Stable crawl target URL: `TBD` (engineering to confirm a stable demo site)
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
- Wrong password → generic error (no user enumeration); auth endpoints rate-limited to **5–10 requests / 15 min per IP** (`README.md` security table). Hammer the endpoint and confirm 429.
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
1. Crawl URL (engineering to confirm a stable demo site; otherwise use a site you control) → crawl completes; discovered pages listed; progress visible.
2. Generate tests from crawled pages → tests appear in "pending" state with steps.
3. Approve test → moves to active suite; appears in run targets.
4. Reject test → removed/archived; excluded from regression.
5. Edit test steps (add/remove/reorder) → saved; preview reflects changes.
6. Export tests → downloads in the product's supported format(s). Specific formats are not documented — record what the UI offers and confirm re-import (if supported) round-trips cleanly.

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
1. Start recorder on any stable site (same target as the Tests crawl step) → recording indicator visible. Recorder uses Playwright CDP screencast and persists a Draft test with `safeClick` / `safeFill` (see `docs/changelog.md` DIF-015).
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
1. Run single test → status: queued → running → passed/failed; logs, screenshots, CDP video available (recorder uses Playwright CDP screencast).
2. Run regression suite → all tests execute; summary shows pass/fail counts matching detail view.
3. Stop running execution → stops within a few seconds; run marked as "stopped"; partial results retained. Note: per-test hard timeout is `BROWSER_TEST_TIMEOUT` (default **120 000 ms**, see `AGENT.md`).
4. Re-run failed tests only → only previously-failed tests execute.

**Negative / edge:**
- Trigger run while another is in progress → concurrency = `PARALLEL_WORKERS` (default **1**, `AGENT.md`). Extra runs queue; no crash.
- Run test against unreachable target → fails with clear network error, not timeout silence.
- Long-running / hung test → aborted at `BROWSER_TEST_TIMEOUT` with a clear timeout error.
- Flaky test (intermittent failure) → no product-level auto-retry is documented. Rely on `safeClick` / `safeFill` self-healing (see `docs/changelog.md` DIF-015); confirm behavior, file if retry is expected.
- Viewer attempts to trigger run → blocked.
- `qa_lead` stops another user's run → blocked; `admin` → allowed.
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
- Anti-aliasing / font rendering differences across OS → `VISUAL_DIFF_THRESHOLD` (default **0.02** = 2% of pixels) and `VISUAL_DIFF_PIXEL_TOLERANCE` (default **0.1**) filter noise (`AGENT.md`). Change `VISUAL_DIFF_THRESHOLD=0` to verify zero-tolerance mode also works.
- Dynamic content (timestamps, ads) → **mask/ignore regions are not documented** in the codebase. File as a gap or confirm with engineering before marking this row pass.
- Viewport size change between runs → diff behavior documented (pass/fail/warn) — confirm actual product behavior and note it in checklist.
- Concurrent baseline accept by two users → last-write-wins with audit trail.
- Very large images → no timeout, no memory crash.

---

### 📊 Dashboard

**Preconditions:** Workspace has runs, tests, and projects with data.

**Steps & expected:**
1. Open dashboard → all charts render within a reasonable time (no formal SLO documented — use ≤ 3s as a guideline and file any regression); no console errors.
2. Verify each widget against source of truth:
   - Pass rate % matches count(passed) / count(total) over selected range.
   - Run count matches Runs page filter for same range.
   - Failing tests widget lists only tests with latest status = failed.
3. Change date range → all widgets update consistently; no stale values.
4. Switch workspace → dashboard resets; no data from previous workspace.

**Negative / edge:**
- Empty workspace (no runs) → empty states shown, not zero-division errors / NaN.
- Very large dataset (≥ 1000 runs) → dashboard loads without hanging or crashing; no unbounded network calls.
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
1. Update each setting category → change persists after refresh and across sessions. Sentri surfaces (no billing module):
   - **AI provider keys** (Anthropic / OpenAI / Google / Ollama). Switching providers via the header dropdown should succeed in one click (`README.md`).
   - **Workspace members & roles** (ACL-002: `admin` / `qa_lead` / `viewer`).
   - **Per-project notification settings** (Teams webhook / email recipients / generic webhook — at least one channel required, see `backend/tests/account-compliance.test.js`).
   - **System info / Ollama status**.
2. Invalid input (bad email, bad URL) → inline validation; save blocked.
3. Revoke/regenerate API key → old key returns 401 immediately; new key works.
4. Disconnect integration → subsequent features depending on it fail gracefully.

**Negative / edge:**
- Member / Viewer attempts to open workspace settings → blocked.
- Concurrent settings edits → last-write-wins with no lost fields.
- Save partial form (required field blank) → blocked, no partial persistence.

---

### 🔔 Notifications

**Preconditions:** Notifications configured per project. Sentri supports exactly **three channels** (see `backend/src/utils/notifications.js` — `fireNotifications`):
- **Microsoft Teams** — Adaptive Card via incoming webhook.
- **Email** — HTML summary via `emailSender.js`.
- **Generic webhook** — POST JSON to user-configured URL.

Note: **Slack and in-app are NOT supported** — do not test them.

The settings API requires **at least one channel** to be enabled (confirmed by `backend/tests/account-compliance.test.js`: saving with all three blank returns 400).

**Steps & expected (per channel):**
1. Trigger a failed run → notification delivered via each enabled channel. Expect delivery within ~1 min (engineering to confirm SLO).
2. Notification payload includes: project, test name, run ID, failure reason, link to run detail.
3. Link in notification opens the correct run and requires auth.
4. Disable a channel → no notifications sent via that channel for subsequent runs.
5. Save settings with all three channels blank → API returns **400** ("At least one channel is required").
6. Trigger recovery (previously failing test now passes) → "recovered" notification sent (confirm if supported; otherwise file as enhancement).

**Negative / edge:**
- Invalid / non-HTTPS webhook URL → clear error in settings; no silent drop.
- Flood of failures (10+ in a minute) → batching/rate-limit policy is **undocumented**; observe and file if spam occurs.
- User removed from workspace → stops receiving notifications for that workspace.
- Notification payloads contain no PII / secrets / tokens.

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
- JWT stored in **HttpOnly cookie**; verify `HttpOnly`, `Secure`, `SameSite` flags in DevTools (`README.md` security table).
- Proactive refresh fires **5 min before expiry** (`docs/changelog.md`); leave a tab idle and confirm refresh happens without redirect.
- Logout invalidates cookie server-side (replay fails).
- Password reset uses DB-backed **atomic one-time claim** tokens (`README.md`, `docs/changelog.md`): reusing a claimed token → rejected; requesting a new token invalidates all prior unused tokens (`#78`).
- Global session invalidation on password change is **not documented**; observe behavior and file if other sessions remain valid.

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
- Initial page load ≤ 3s on a local dev build over loopback (no formal SLO documented — file regressions against prior release).
- No memory leaks after 10 minutes of navigation (check DevTools heap snapshot).
- No unbounded network polling (check Network tab).

**Accessibility (spot check):**
- Keyboard-only navigation works on primary flows (tab order, focus rings visible, Enter/Space activates).
- Screen reader announces form errors and modals.
- No formal WCAG compliance target is documented — treat **WCAG 2.1 AA** as the working goal and file contrast / ARIA gaps as Minor.

**Internationalization:**
- Sentri does not document i18n / locale support — the app is effectively English-only. Long English strings must not break layouts; RTL testing is out of scope until locales are added.

---

## 🚨 Known Issues

> Do **not** re-file these. Link the ticket in your report if you encounter them.

Per the codebase, recorder (DIF-015) and visual diff (DIF-001) were implemented/fixed in `docs/changelog.md`; there is no live "known issues" register in the repo. Treat the rows below as **claims to verify** — if you reproduce any, open a ticket and replace this table with the real IDs.

| Issue | Ticket | Repro | Workaround |
|---|---|---|---|
| Deploy pages failing | _open_ | Attempt deploy flow; capture logs | None known |
| Image push failures | _open_ | Trigger image push; capture logs | None known |
| Recorder empty-steps (regression) | _open_ | Record a simple flow; check each step has selector + action | Re-record; file bug |
| Visual diff false positives | _open_ | Re-run unchanged suite; check flagged steps | Tune `VISUAL_DIFF_THRESHOLD` / `VISUAL_DIFF_PIXEL_TOLERANCE` |

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
