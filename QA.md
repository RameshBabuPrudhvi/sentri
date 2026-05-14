# Manual QA Guide — Sentri

## 🎯 Purpose

This document is for **manual testers** to validate all functional flows in Sentri before release.

It has two layers:

1. **Golden E2E Happy Path** (must-pass) — one stitched-together user journey that exercises every core feature end-to-end. If any step fails, **stop the release**.
2. **Per-feature happy paths + negatives** — targeted checks per area for full coverage.

> ℹ️ Values are grounded in `README.md`, `AGENT.md`, `ROADMAP.md`, `docs/changelog.md`, `backend/src/routes/testFix.js`, `backend/src/pipeline/feedbackLoop.js`, `backend/src/utils/notifications.js`. `TBD` items require engineering confirmation.

---

## 🤖 For agents — read this first

This file is ~1000 lines. **Do not read it top-to-bottom.** Use the index below to jump directly to the section you need, read only that section, then stop.

### Intent → section map

If the user asks for… read only this section:

| User intent | Section (anchor) | Lines |
|---|---|---|
| "Run / write all happy paths" | [Golden E2E Happy Path](#-golden-e2e-happy-path-must-pass-before-release) | 241–342 |
| "Write Playwright tests for the deployed app" | [Canonical UI test shape](#canonical-ui-test-shape--emit-this-by-default) + [Tests Page §3](#-tests-page) | 95–109, 430–467 |
| "Write an API test" | [Tests Page §4](#-tests-page) + [API Test Imports](#-api-test-imports-openapi-har-plain-english-api) | 430–467, 1108–1124 |
| "Fix a failing test" | [AI Fix](#-ai-fix-failed-test-recovery) | 650–673 |
| "Record a test" | [Recorder](#-recorder) | 474–515 |
| "Run tests / regression" | [Runs](#%EF%B8%8F-runs) | 518–541 |
| "Review / approve / reject drafts" | [Review Queue](#-review-queue) | 544–579 |
| "Auto-approve tests / revoke / calibration" | [Auto-Approval](#-auto-approval-auto-003b) | 582–647 |
| "Edit test code / steps" | [Test Code Editing](#%EF%B8%8F-test-code-editing-steps--source) | 676–724 |
| "Schedule / trigger from CI" | [Automation](#-automation-cicd--scheduled-runs) | 727–758 |
| "Multi-environment / staging vs prod / environment selector" | [Environments](#-environments-dif-012) | 851–912 |
| "Distributed sharding / shards: N / cross-process test split" | [Distributed Sharding](#-distributed-sharding-cap-002) | 915–980 |
| "Data-driven test fixtures / CSV / iterations" | [Data-driven fixtures](#-data-driven-test-fixtures-cap-001) | 982–1020 |
| "Visual / screenshot testing" | [Visual Testing](#%EF%B8%8F-visual-testing) | 818–835 |
| "Verify permissions" | [`permissions.json`](./backend/src/middleware/permissions.json) **(canonical, read this, not prose)** | — |
| "Verify security / authorization" | [Security](#-security) | 997–1025 |
| "Bulk actions / keyboard shortcuts" | [Bulk Actions](#%EF%B8%8F-bulk-actions--keyboard-shortcuts) | 1104–1149 |
| "Report a bug" | [Bug Reporting Template](#-bug-reporting-template) | 1306–1339 |

### Section index (line ranges, for `sed -n 'A,Bp'` / partial reads)

```yaml
# Feature sections
authentication:      { lines: 356-381 }
workspaces:          { lines: 384-401 }
projects:            { lines: 404-427 }
tests-page:          { lines: 430-467 }
recorder:            { lines: 474-515 }
runs:                { lines: 518-541 }
review-queue:        { lines: 544-579 }     # NEW (PR #7)
auto-approval:       { lines: 582-647 }     # NEW (AUTO-003b)
ai-fix:              { lines: 650-673 }
test-code-editing:   { lines: 676-724 }
automation:          { lines: 727-758 }
quality-gates:       { lines: 795-849 }     # NEW (AUTO-012)
environments:        { lines: 851-912 }     # NEW (DIF-012)
distributed-sharding:{ lines: 915-980 }     # NEW (CAP-002)
data-driven-fixtures:{ lines: 982-1020 }    # NEW (CAP-001)
visual-testing:      { lines: 818-835 }
dashboard:           { lines: 838-856 }
ai-chat:             { lines: 860-889 }
settings:            { lines: 893-910 }
account-gdpr:        { lines: 914-924 }
email-verification:  { lines: 927-934 }
recycle-bin:         { lines: 938-948 }
audit-log:           { lines: 951-959 }
notifications:       { lines: 963-994 }
security:            { lines: 997-1025 }
reports-pdf:         { lines: 1028-1043 }
system-diagnostics:  { lines: 1047-1056 }
new-project:         { lines: 1060-1071 }
runs-list:           { lines: 1075-1086 }
project-detail:      { lines: 1089-1101 }
bulk-actions:        { lines: 1104-1149 }
modals:              { lines: 1152-1180 }
api-test-imports:    { lines: 1184-1199 }
onboarding:          { lines: 1203-1212 }
demo-mode:           { lines: 1216-1227 }
settings-data-tab:   { lines: 1231-1245 }
workspace-switcher:  { lines: 1249-1257 }

# Meta sections
golden-happy-path:       { lines: 241-342 }
canonical-ui-test-shape: { lines: 95-109 }
permissions-matrix:      { lines: 152-200 }
setup:                   { lines: 204-237 }
cross-cutting-checks:    { lines: 1185-1213 }
known-issues:            { lines: 1217-1228 }
bug-template:            { lines: 1232-1263 }
coverage-checklist:      { lines: 1267-1313 }
```

> **Read-only boundary:** line ranges are approximate and can drift ±5 lines after edits — always stop at the next `### ` heading. Don't read beyond the listed range for a given section.

> ⚠️ **Agents generating Playwright tests for Sentri: read this.**
> Sentri's primary output is **UI / browser tests** that drive a real browser via `await page.goto(...)`, role-based selectors (`getByRole` / `getByLabel` / `getByText`), `safeClick` / `safeFill`, and `expect(page....)` assertions on rendered DOM.
> API tests using `request.fetch` / `request.get` / `request.post` are an **additional, secondary** output — only valid when same-origin fetch/XHR was captured during a crawl, or the user explicitly asked for an API test (OpenAPI / HAR / `METHOD /path`).
> **If you emit only `request.*` tests when asked for "Playwright tests for Sentri", you have misread this guide.** Default to UI tests unless the user explicitly says "API test".

#### Canonical UI test shape — emit this by default

```js
test('user can log in', async ({ page }) => {
  await page.goto('https://rameshbabuprudhvi.github.io/sentri/login');
  await safeFill(page.getByLabel('Email'), 'user@example.test');
  await safeFill(page.getByLabel('Password'), 'pw');
  await safeClick(page.getByRole('button', { name: 'Sign in' }));
  await expect(page).toHaveURL(/dashboard/);
  await expect(page.getByRole('heading', { name: /workspace/i })).toBeVisible();
  await expect(page.getByRole('navigation')).toBeVisible();
});
```

No `import` lines. No `request.fetch` / `request.get` / `request.post`. Role-based selectors. ≥ 3 `expect(page....)` assertions on visible UI state.

**When adding a new user-facing flow** (per [REVIEW.md](./REVIEW.md)):
1. Add a section here under "Functional Test Areas".
2. Add a step (or sub-section) in the Golden E2E Happy Path if it belongs in the must-pass journey.
3. Add a row to the Coverage Checklist.
4. If the flow has a new endpoint, add it to [`backend/src/middleware/permissions.json`](./backend/src/middleware/permissions.json).
5. Cite the source file/line for any role-gated or behavior claim.

**When verifying a permissions claim:** read [`backend/src/middleware/permissions.json`](./backend/src/middleware/permissions.json), not the markdown matrix below — the JSON is the canonical machine-readable form. The markdown table mirrors it for humans.

> **Automated coverage:** This manual plan is the human baseline. Automated E2E specs live under [`tests/e2e/specs/`](./tests/e2e/specs/); the per-step automation matrix is at [`tests/e2e/COVERAGE.md`](./tests/e2e/COVERAGE.md) — check that first to see which Golden E2E steps and per-feature flows are already ✅ automated vs. still 🟥 manual-only. Sections already covered by automation should be tagged `_(automated: see tests/e2e/COVERAGE.md row …)_` — manual testers may skip those during release sign-off. When you add an automated test, update the matching `QA.md` section AND flip the row in `tests/e2e/COVERAGE.md`.

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

Verified against `requireRole(...)` declarations in `backend/src/routes/*.js` and `backend/src/middleware/requireRole.js` (hierarchy: `admin > qa_lead > viewer`). `admin` gates settings + destructive ops; `qa_lead` runs QA workflows; `viewer` is read-only. Source cited per row — if behavior diverges from this table, file a **severe security bug**.

**admin-only actions:**

| Action | Source |
|---|---|
| Edit workspace (rename, settings) | `routes/workspaces.js:44` |
| Invite / change-role / remove members | `routes/workspaces.js:134, 168, 196` |
| AI provider settings (`/settings`) | `routes/settings.js:48, 53, 130` |
| Settings → Data destructive clears (runs / activities / healing) | `routes/system.js:193, 200, 205` |
| **Delete project** | `routes/projects.js:84` |
| **Purge from recycle bin** (permanent) | `routes/recycleBin.js:132` |
| **Create / revoke CI/CD trigger token** | `routes/runs.js:379, 411` |

**qa_lead or admin (qa_lead-gated):**

| Action | Source |
|---|---|
| Create project | `routes/projects.js:46` |
| Test connection (New Project) | `routes/system.js:48` |
| Restore from recycle bin (soft-undelete) | `routes/recycleBin.js:54` |
| Crawl project | `routes/runs.js:46` |
| Create / Edit / Delete tests | `routes/tests.js:97, 318, 364` |
| Generate tests / Record / AI Fix / Apply Fix | `routes/tests.js:382, 858`; `routes/testFix.js:152, 273` |
| Approve / Reject (single + bulk) | `routes/tests.js:538, 555, 589` |
| Trigger run (project regression + single test) | `routes/runs.js:134`; `routes/tests.js:487` |
| **Abort / stop run** — note: code has **no "own-runs only" restriction**, any qa_lead can stop any run | `routes/runs.js:257` |
| Accept visual baseline | `routes/tests.js:751` |
| Set / edit / delete cron schedule | `routes/projects.js:162, 222` |
| Edit per-project notification settings | `routes/projects.js:266` |

**Any authenticated workspace member (no `requireRole`):**

| Action | Notes |
|---|---|
| View dashboard / runs / tests / reports / projects pages | Workspace scope still enforced — outsiders blocked |
| Account export / delete (own account, GDPR) | Password-confirmed; not workspace-scoped |
| Switch workspace | Via switcher; role re-resolved from DB on every request (ACL-001/002) |

**Always denied (cross-workspace isolation):**

| Action |
|---|
| Access another workspace's data via URL or API |
| Outsider (no `workspace_members` row) accessing any workspace resource |

> ⚠️ **Note on workspace create/delete:** the `POST/DELETE /api/workspaces/...` endpoints for creating/destroying entire workspaces are out of the scope captured here. Verify behavior against the running build and update this table if found.

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
- Stable crawl target URLs (from `frontend/src/demo.js` and CI):
  - `https://demo-shop.example.com` (E-Commerce demo)
  - `https://admin.example.com` (Admin Dashboard demo)
  - `https://www.example.com` (Marketing Site demo / CI default — `.github/workflows/ci.yml`)
  - These use IANA-reserved `example.com` subdomains; they will not actually crawl real content but are deterministic for create-project / connection-test flows. For real crawl/run testing, point at a site you control.
- Sample regression suite: ≥ 5 tests, mix of passing/failing
- Sample baseline images: at least one stable, one with intentional diff

---

## 🌟 Golden E2E Happy Path (must-pass before release)

Run this single end-to-end journey **as User A (admin)** in a fresh browser. Every numbered step must pass. If any fails, log a Blocker bug and stop.

**Preconditions:** Backend + frontend running; one AI provider key configured; mail transport (Resend / SMTP / console) reachable; clean DB or fresh workspace.

### 1. Auth — register & verify
1. Register `usera@example.test` with a strong password.
2. Verification email arrives (or appears in console fallback). Click the link.
3. Login → land on dashboard for the auto-created workspace.

### 2. Workspace — invite collaborator
4. Invite `userb@example.test` as `qa_lead`. Open invite link in incognito → User B accepts and lands in WS-1.

### 3. Project — create
5. As User A, create project **"PRJ-Demo"** with a real URL you control (or `https://www.example.com` for the create-project + connection-test flow only — `example.com` won't yield meaningful crawl results). Project appears in the list and as `?project=PRJ-Demo` deep-link target.

### 4. Discover — crawl the app
6. Trigger **Link Crawl** → progress visible; pages discovered; same-origin fetch/XHR captured.
7. Trigger **State Exploration** crawl on the same project → multi-step flows discovered (forms submitted, auth flows entered).
### 5. Generate — AI tests
8. Click **Generate** → 8-stage pipeline runs (discover → filter → classify → plan → generate → deduplicate → enhance → validate). New tests land in **Draft** queue, not auto-approved.
9. Verify **both test types** were produced — Sentri generates **UI / browser tests by default**; API tests are an additional output:
   - **UI / browser test (primary)** — uses `await page.goto(...)`, role-based selectors (`getByRole` / `getByLabel` / `getByText`), `safeClick` / `safeFill`, and ≥ 3 `expect(...)` assertions on visible UI state. Drives a real browser. **No `request.` / `request.fetch` / `request.get` calls.**
   - **API test (only if same-origin fetch/XHR was captured)** — Playwright `request` test asserting status + JSON shape.
   If only API tests appear, the crawl did not discover UI flows — re-run **State Exploration** and regenerate.


### 6. Record — manual recorder
10. Open Test Lab (`/projects/:id/test-lab` via the "Test Lab" quick-action card on the Tests page) → click the red **Record a test** CTA in the topbar → Playwright browser opens via CDP screencast. The Tests page no longer has its own Record button (PR #5 — recorder launch consolidated into Test Lab).
11. Perform: click, fill, press, select, navigate. Stop.
12. New Draft test appears with `safeClick` / `safeFill` calls and per-step entries; user is navigated to the Test Detail view.

### 7. Review — approve / reject
13. Open the **Review Queue** at `/review-queue` (also reachable via the "Review Drafts" quick-action card on the Tests page). Draft tab active by default; the first draft auto-selects in the detail pane showing steps + Playwright code (with the same Steps/Source rendering used on TestDetail).
14. Reject one obviously bad test via the styled confirmation modal → archived, excluded from regression. Switch to the Rejected tab to verify it lands there.
15. Approve at least 3 tests (use the `a` keyboard shortcut for speed) → moved to active suite. Watch the Draft tab badge tick down and the Approved tab badge tick up — both update via the single `GET /tests/counts` aggregate query.

### 8. Edit — verify auto-generated Playwright code
16. Open an approved test → switch to **Source** tab → confirm code uses role-based selectors (`getByRole`, `getByLabel`, `getByText`), starts with `await page.goto(...)`, has ≥ 3 `expect(...)` assertions, no `import` lines (`backend/src/routes/tests.js:218-224`).
17. Edit a step (rename a button, add a step) → save → **diff/preview panel** appears showing only the changed lines, **not** a full rewrite (`backend/src/routes/tests.js:160-198`).
18. Accept the diff → `playwrightCode` updated, `playwrightCodePrev` retained, `codeRegeneratedAt` set.
19. Discard a different diff → original code preserved.

### 9. Run — execute regression
20. Trigger regression with **parallelism = 3**, browser = **Chromium**, device = desktop. RunDetail opens with live SSE log stream.
21. Watch per-step screenshots and step-timing waterfall update (`docs/changelog.md` DIF-016).
22. Run completes → mix of pass/fail expected with at least one intentional failure (use a known-bad test or temporarily break a selector).

### 10. AI Fix — fix the failure
23. On a failed test in TestDetail, click **"Fix with AI"** (visible only when `lastResult === "failed"` and `playwrightCode` exists, `frontend/src/pages/TestDetail.jsx:411-426`).
24. SSE stream from `POST /api/v1/tests/:testId/fix` shows incremental tokens; final fixed code appears in the fix panel.
25. Accept the fix → test goes back to **Draft** for re-review (auto-fix never silently re-approves; `backend/src/pipeline/feedbackLoop.js:481-490`).
26. Re-approve the fixed test → re-run **only failed tests** → all pass.

### 11. Visual baseline
27. Run a test with a screenshot step twice → first run creates baseline under `artifacts/baselines/`, second run produces diff = 0.
28. Change something visible on the target → re-run → diff PNG appears at `artifacts/diffs/`, run flagged as visual regression when diff > `VISUAL_DIFF_THRESHOLD` (0.02).
29. Click **Accept visual changes** → baseline updated; subsequent run passes.

### 12. Run results, artifacts & reports
30. On RunDetail verify: per-test status, per-step screenshots, per-step timing, video, network logs, browser badge, parallelism used.
31. Download/inspect artifacts (screenshots, video, trace zip) — files exist and open. **🔍 Open Trace** (DIF-005, #9): on a run with a captured trace, click the **Open Trace** action on RunDetail → a new browser tab opens at `/trace-viewer/?trace=<signed-url>` and loads Playwright's embedded trace viewer with the run's trace pre-loaded; verify the viewer's timeline / actions / network panels render. The Trace ZIP download link continues to work alongside as a fallback (served from `backend/public/trace-viewer/` via `backend/src/middleware/appSetup.js`).
31a. **Compare runs** (AUTO-019, #10) — on a project with ≥ 2 completed test runs, open the newer RunDetail and click the **Compare** action in the header. The page renders a comparison card with summary chips (`Flipped: N · Added: N · Removed: N · Unchanged: N`) and per-test diff rows showing each test's `currentStatus` vs `previousStatus` with a `flipped` / `added` / `removed` / `unchanged` change-type badge (`backend/src/routes/runs.js` `GET /api/v1/runs/:runId/compare/:otherRunId`; `frontend/src/components/run/RunCompareView.jsx`). When > 1 prior test run exists, a `Compare against:` `<select>` picker appears above the card — switching the picker re-fetches the diff against the chosen run. The default target is the chronological predecessor (run immediately before the current one). The Compare action is suppressed for crawl and generate runs. Negative checks: outsider hitting `/api/v1/runs/:runId/compare/:otherRunId` for another workspace's runs → 404; unknown `otherRunId` → 404; no auth token → 401.
32. Open **`/reports`** page → renders run/test reports for the workspace.
33. From Dashboard, export the **executive PDF report** → file downloads, opens, contains pass-rate / defect breakdown / trends matching on-screen widgets.
34. **Out of scope (planned, not shipped):** public/shareable report links. Do not test these. Standalone Playwright project export (`DIF-006`) and the embedded Playwright trace viewer (`DIF-005`) **are** shipped — DIF-006 has its own line item under "Export & traceability" below; DIF-005 is verified inline at step 31 above.

### 13. Notifications
35. Configure Teams + email + generic webhook for PRJ-Demo. Trigger a failing run → notification arrives on each enabled channel within ~1 min, with project / test / runId / failure reason / link.

### 14. Automation (CI/CD)
36. Create a trigger token → plaintext shown **once**.
37. `POST /api/projects/PRJ-Demo/trigger` with `Authorization: Bearer <token>` → returns **202** with `{ runId, statusUrl }`. Poll `statusUrl`; final state matches RunDetail.
38. Set a cron schedule for "every minute" → wait → run fires automatically; disable schedule.

### 15. Export & traceability
39. Export tests as **Zephyr CSV** and **TestRail CSV** → non-empty files, correct headers.
40. Open **Traceability matrix** → maps tests ↔ source URLs / requirements.
41. **Standalone Playwright project ZIP** (DIF-006) — `GET /api/v1/projects/:id/export/playwright` → ZIP downloads with `Content-Type: application/zip`, contains `package.json`, `playwright.config.ts` (with `baseURL` from project), `README.md`, and one `tests/<slug>.spec.ts` per **approved** test (drafts and rejected tests excluded). Unzip, `npm install`, `npx playwright test` runs the suite without modification.

### 16. AI Chat
42. Open `/chat`. Ask: "How many tests failed in the last run?" → matches RunDetail.
43. Ask: "Why did test X fail?" in same session → multi-turn context preserved; answer references actual logs.
44. Export the session as Markdown and JSON.

### 17. Dashboard
45. Open Dashboard → pass-rate, defect breakdown, flaky detection, MTTR, growth trends all populated and match RunDetail / Tests source-of-truth counts.

### 18. Recycle bin & audit
46. Delete a test → it appears in **Settings → Recycle Bin**. Restore it → reappears in active list with steps intact.
47. Open **Audit Log** → every approve/reject/run/fix/restore action above is recorded with `userId` + `userName`.

### 19. Account / GDPR
48. Settings → Account → **Export account data** (password-confirmed) → JSON downloads with workspaces/projects/tests/runs/activities/schedules/notification settings.
49. Two-click **Delete account** with 5s auto-disarm → account gone; subsequent login fails.

### 20. Permissions sanity (negative)
50. As User C (`viewer`), confirm: cannot create/edit/delete projects, cannot trigger runs, cannot accept baselines, cannot create trigger tokens or schedules. Each blocked action returns 403, not a silent no-op.
51. As User D (outsider), confirm: any direct URL or API request for WS-1 resources returns 403, never empty 200.

> ✅ **Pass criterion:** all 51 steps green. Any failure = release blocker.

---

## ✅ Functional Test Areas

Each area uses this format:
- **Preconditions** — required state before testing
- **Steps** — actions to perform
- **Expected** — measurable pass criteria
- **Negative / edge cases** — must also pass

---

### 🔐 Authentication

_(automated: see `tests/e2e/specs/ui-smoke.spec.mjs` for login negative path + verified login redirect to `/dashboard`, and `tests/e2e/specs/project-create-ui.spec.mjs` for §3 step 5 (project create via `/projects/new` form). Coverage tracked in `tests/e2e/COVERAGE.md`; verified-login happy path remains pending until CI turns that row ✅.)_

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
5. Change User B's role `qa_lead` → `viewer` → permissions update **without requiring relogin** (role is re-resolved from DB on every request, ACL-001/002).
6. Remove User B → active session loses access on next request (≤ 60s).

**Negative / edge:**
- User B (`qa_lead`) tries to invite users → blocked (admin-only, `routes/workspaces.js:134`).
- Outsider opens workspace URL directly → 403 / redirect, not 200 with empty data.
- Duplicate invite → handled gracefully.
- Invite to non-existent email → still sends (or clear UX); no crash.

---

### 📁 Projects

**Preconditions:** Workspace exists.

**Steps & expected:**
1. Create project (`qa_lead` or `admin`, `routes/projects.js:46`) → appears in list; slug/URL unique.
2. **Edit project** (ENH-036, `qa_lead` or `admin`, `routes/projects.js:96` — `PATCH /api/v1/projects/:id`):
   - Click the pencil-icon button on a project card in `/projects` → routes to `/projects/new?edit=<id>` with name/URL pre-filled.
   - Auth toggle reflects whether credentials are configured server-side; password fields render `"•••••• (saved — leave blank to keep)"` placeholder.
   - Change the name and URL only → save → server merges with existing encrypted `username`/`password` and legacy `usernameSelector`/`passwordSelector`/`submitSelector` (no data loss; secrets never round-trip through the client).
   - Rotate the password (enter a new value) → save → next crawl uses the new credential. Verify by re-running the project's crawl.
   - Clear the auth toggle → save → server stores `credentials: null` and the project crawls without auth.
   - Edit a project that was created with explicit CSS selectors (legacy) → save name change only → confirm the legacy `usernameSelector` / `passwordSelector` / `submitSelector` are NOT silently wiped (regression guard for the merge logic).
   - Pristine edit (open + Back without typing) → no "Leave without saving?" prompt fires (`isDirty` baseline check).
3. **Delete project (admin-only**, `routes/projects.js:147`) → moved to recycle bin, no longer in active list. As `qa_lead`, attempting delete returns **403**.
4. Restore from recycle bin (`qa_lead` or `admin`, `routes/recycleBin.js:54`) → returns to active list with data intact (tests, runs, baselines).
5. **Permanently purge (admin-only**, `routes/recycleBin.js:132`) → unrecoverable; associated runs/tests gone. `qa_lead` purge attempt → 403.

**Negative / edge:**
- Two users edit same project simultaneously → last-write-wins or conflict warning (document behavior).
- Delete project with active running tests → runs stopped/completed cleanly, no orphans.
- Viewer attempts any project mutation (create/edit/delete/restore/purge) → 403.
- `qa_lead` attempts delete or purge → 403 (admin-only ops).

---

### 🧪 Tests Page

**Preconditions:** Project exists.

**Steps & expected:**
1. Crawl URL — verify **both crawl modes** (`README.md`):
   - **Link Crawl** — follows `<a>` tags, maps pages.
   - **State Exploration** — clicks/fills/submits to discover multi-step flows (auth, checkout).
   Each mode completes, discovered pages listed, progress visible. **Primary output: UI / browser tests** (see §3 below). Same-origin fetch/XHR is also captured and powers API test generation as a secondary output (see §4).
2. Generate tests — verify the **8-stage AI pipeline** runs (`README.md`): discover → filter → classify → plan → generate → deduplicate → enhance → validate. Tests appear in **Draft** queue (`README.md`: "Nothing executes until a human approves it").
3. **UI / browser test generation (default output)** — three paths, all produce tests that drive a real browser:
   - During **Link Crawl**: discovered pages → Playwright tests with `page.goto(...)` + `getByRole` / `getByLabel` / `getByText` + ≥ 3 `expect(...)` assertions on visible UI state.
   - During **State Exploration** crawl: multi-step flows (login, form submit, checkout) → tests using `safeClick` / `safeFill` so self-healing engages at run time.
   - **Recorder**: user-driven click/fill/press/select/navigate (see Recorder section).
   Each path produces a Playwright test that opens a browser, navigates pages, and asserts on rendered DOM. **No `request.fetch` / `request.get` / `request.post` calls.**
4. **API test generation (additional output)** — three paths, all produce Playwright `request` tests (no browser):
   - During crawl: same-origin fetch/XHR auto-generated as Playwright `request` tests.
   - "Generate Test" modal: plain-English endpoint description.
   - Paste `METHOD /path` patterns or attach an OpenAPI spec.
   Each path produces tests that verify status codes, JSON shape, error payloads.
5. Approve test → moves to active suite; appears in run targets.
6. Reject test → removed/archived; excluded from regression.
7. Edit test steps (add/remove/reorder) → saved; preview reflects changes.
8. **Search** tests via `?search=` (`/api/v1/projects/:id/tests?search=`) → filters list correctly; empty results show empty state.
9. **Exports** (`backend/src/routes/tests.js`):
   - `GET /api/v1/projects/:id/tests/export/zephyr` — Zephyr Scale CSV.
   - `GET /api/v1/projects/:id/tests/export/testrail` — TestRail CSV.
   - `GET /api/v1/projects/:id/tests/traceability` — traceability matrix.
   - `GET /api/v1/projects/:id/export/playwright` — standalone Playwright project ZIP (approved tests only — DIF-006).
   Each downloads a non-empty file with correct headers; re-importing into the target tool round-trips cleanly. The Playwright ZIP must run with `npm install && npx playwright test` after unzipping.

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
1. Start recorder on any stable site (same target as the Tests crawl step) → recording indicator visible. Recorder uses Playwright CDP screencast; the canvas is **interactive** — pointer / keyboard / wheel events are forwarded to the headless browser via the new `POST /api/v1/projects/:id/record/:sessionId/input` route (see `docs/changelog.md` DIF-015 + PR #115). Persists a Draft test with `safeClick` / `safeFill`.
1a. **Starting URL suggestions (PR #11)** — the Starting URL field renders a `<datalist>` dropdown populated by `GET /api/v1/projects/:id/pages`: the project's seed URL plus pages discovered on the latest successful crawl (or prior recorder run). Projects with no crawl history show just the seed URL. Verify suggestions appear as you focus the field; pick one → it populates the input.
1b. **Two-phase step display (PR #11)** — newly captured actions briefly render as a dim italic raw locator (`click → role=button[…]`) for ~600 ms, then flip to human-readable prose (`Click the 'Sign in' button`) with a yellow highlight flash (1.2 s animation). Verify both phases render on the first few actions of a fresh recording.
1c. **Flush-before-navigate (PR #11)** — type into a search box, hit **Enter** to submit the form. Verify the fill IS captured (Step: "Fill in the 'Search' field with 'iphone'") and ordered BEFORE the resulting `goto`, not swallowed by the navigation. Same check for submit-button click on a form: type → click Submit → the fill step appears in the recorded list, not just the goto.
2. Perform actions captured by the recorder (PR #115 + #118 expanded scope): **click, double-click, right-click, hover, fill (type), press (keyboard shortcut), select (dropdown), check / uncheck, file upload, drag-and-drop, and navigate**. Mouse moves and scroll are forwarded to the headless browser but not stored as discrete steps. Mouse moves are throttled to ~30 fps client-side.
   - **Hover with intent** — pointer rests on the same interactive element for ≥ 600 ms IS captured as a discrete `hover` step. Drive-by mouseovers are filtered out by the dwell timer (`backend/src/runner/recorder.js:282-309`).
   - **Double-click** — the two preceding `click` events captured for the same selector are dropped within the OS double-click window (`TIMINGS.DBLCLICK_WINDOW_MS` = 500 ms) so the recorded action list reads as a single dblclick, not click-click-dblclick (`backend/src/runner/recorder.js:931-944`).
   - **Right-click** records as `rightClick` and emits `locator.click({ button: 'right' })` so context-menu-driven flows replay correctly.
   - **File upload** captures filenames only (no full paths — would leak tmpdir). The generated code emits a `safeUpload(sel, [])` placeholder + a `// NOTE: recorder captured filenames […]` comment; reviewers must wire up real fixture paths before running outside the recorder.
   - **Drag-and-drop** pairs `dragstart` + `drop` → `locator.dragTo(targetLocator)` in the generated code.
   - **Printable characters typed into INPUT/TEXTAREA/contenteditable** are intentionally NOT captured as `press` steps by default — the `input` event handler captures them as a debounced `fill`, so emitting per-keystroke `keyboard.press` would double-type the value at replay. Keyboard chords with `Ctrl`/`Cmd` modifiers, plus editing keys (Enter, Tab, Backspace, arrows, Escape), still flow through to `press` actions.
   - **Paste (DIF-015c Gap 1, PR #11)** — pasting a token / address / JSON block into an `<input>` or `<textarea>` emits a single `safeFill` with the post-paste field value (500-char truncated), NOT a stream of per-keystroke `press` actions. The post-paste `input` event is deduplicated against the paste so exactly one fill is captured. Verify by pasting a long string into a search box — the Steps sidebar must show one "Fill in … with '…'" entry, not N `press` rows.
   - **Opt-in keyboard shortcut capture (DIF-015c Gap 1, PR #11)** — to record a shortcut like `Ctrl+A` / `Cmd+V` on an editable field, click the **Record keyboard shortcut** button in `RecorderModal` before pressing the chord. The button arms an N-keystroke budget (default 3) via `POST /record/:sessionId/input` with `type: "shortcutCapture"`; the next 3 printable keydowns on editable fields flow through to `press` instead of being suppressed. Budget auto-decrements to 0 so modifier noise is never permanent. Button label flips to "Shortcut capture armed (next 3 keys)" for 4s after arming.
   - **Manual assertions** (PR #118) — while recording, use the "Add assertion" form in `RecorderModal` to insert assertion steps. Four assertion kinds are supported: `assertVisible`, `assertText`, `assertValue`, `assertUrl` (`backend/src/routes/tests.js:1164-1184`, `backend/src/runner/recorder.js:827-855`). Server-side validation rejects assertions missing required fields (selector for visible/text/value, value for text/value/url) with a 400.
   - **Expected:** Each captured action is a discrete step with selector + action type; no empty/null steps. Persisted `steps[]` are short English sentences with **single quotes** (`User clicks the 'Sign in' button`, `User fills in the 'Email' field with 'user@example.com'`, `The 'Toast' is visible`) — **never raw selectors** like `role=button[name="…"]` or `#login`. Generated `playwrightCode` uses `safeClick` / `safeFill` / `safeSelect` / `safeCheck` / `safeUncheck` / `safeUpload` so self-healing engages at run time. The persisted `steps[]` count exactly matches the `// Step N:` comment count in `playwrightCode` — the shared `filterEmittableActions` predicate (`backend/src/runner/recorder.js:634-665`) drops actions missing required fields from both outputs identically (PR #118).
3. Stop and save → test appears in Tests page with all steps intact after refresh. The Test Detail Steps panel renders the recorded test identically to AI-generated and manually-created tests (no engineer-shaped strings).
4. Replay the recorded test → all steps execute; pass status reported.
5. **Default Chromium headless mode** — confirm `BROWSER_HEADLESS=true` (the default) no longer produces "no actions were captured" (PR #115). The previous bug was that the canvas was read-only — it now forwards input correctly even when the headless Chromium has no visible window.

**Negative / edge:**
- ⚠️ Known: empty-steps bug (legacy) — verify every recorded step has a selector and action. PR #118's `filterEmittableActions` drops ill-formed actions from both `steps[]` and `playwrightCode` so the two stay in lock-step.
- Record on SPA with client-side routing → navigations captured correctly. Consecutive `goto` actions to the **exact same URL** collapse to a single Step (e.g. `framenavigated` echoes); query-string-distinct navigations (`/search?q=iphone` → `/search?q=macbook`, pagination `?page=N`) are preserved as separate Steps so query-driven flows replay correctly (PR #115 + PR #118 fix).
- Record on iframe content (DIF-015b Gap 3, PR #11) → `actionsToPlaywrightCode` emits `page.frameLocator('iframe[src*="<frameUrl>"]').first()` for any captured action carrying a `frameUrl`, replacing the old `ensureFrame(...)` polling helper with Playwright's built-in locator chain. Verify by recording a click inside an `<iframe>` (e.g. Stripe checkout demo) and confirming the generated Source tab uses `frameLocator(...)`, not `ensureFrame`.
- Record on shadow DOM content → shadow-root traversal is handled by Playwright's `InjectedScript` on the primary `window.__playwrightSelector` delegation path (PR #4), which walks boundaries via `>> ` piercing selectors natively. Verify replay succeeds against the recorded target.
- Record across tabs/popups → popups are aliased as `popup1`, `popup2`, etc., and the generated code includes an `ensurePopup(alias)` helper (`backend/src/runner/recorder.js:688-700`). The `pageAlias` field on each captured action routes the replay through the correct page.
- Close tab mid-recording → partial recording saved or discarded cleanly (no corrupted state). The `MAX_RECORDING_MS` safety-net teardown closes the stub `runs` row so subsequent runs on the project are not blocked (PR #115). Operators who hit "Stop & Save" within `RECORDER_COMPLETED_TTL_MS` (default 2 min) of the auto-teardown still recover their captured actions from the completed-recordings cache (`backend/src/runner/recorder.js:143-162`).
- Record on site with dynamic IDs → selectors are stable (data-testid / role+name / label / text / placeholder fallback chain), not brittle.
- **Scroll inside the canvas** → only the recorded page scrolls; the surrounding modal / page must not scroll underneath (PR #115 — non-passive wheel listener).
- **Type printable characters** → each character appears once in the recorded form input. (PR #115 fixed a regression where every keystroke was inserted twice; PR #118 added the editable-field guard at `backend/src/runner/recorder.js:370-372` and a regression test in `backend/tests/recorder.test.js` to lock it down.)
- **Left / middle / right mouse button** → CDP receives the correct button name. PR #115 P1 fix mapped DOM `MouseEvent.button` 0→`"left"`, 1→`"middle"`, 2→`"right"`. Idle hovers (no button held) dispatch `"none"` so the move isn't interpreted as a left-button drag. Regression test at `backend/tests/recorder.test.js` (`maps DOM button 0 → CDP 'left'`).
- **Right-/middle-click drag** → forwards the correct CDP button. Verify by recording a right-click context menu on a page that has one — the menu opens, no left-click drag artefact appears.
- **Re-recording after a previous crashed session** → opens cleanly; no UNIQUE constraint error on the `runs` row. The orphan sweep at `POST /record` (`backend/src/routes/tests.js:881-902`) only clears `record`-type orphans — concurrent crawl / regression / generate runs are intentionally left alone.
- **Permissions** — every recorder route is gated by `requireRole("qa_lead")`: `POST /record`, `POST /record/:sessionId/input`, `POST /record/:sessionId/assertion`, `POST /record/:sessionId/stop`. Viewer attempts return 403 (`backend/src/middleware/permissions.json:22, 30-32`).
- **Rate limiting** — the `/input` route is exempt from the global rate limiter (`backend/src/middleware/appSetup.js`) because canvas events arrive at ~60 fps during active use. The exemption is scoped to `POST` requests matching `/record/:sessionId/input` only; `/record` and `/record/:sessionId/stop` are still rate-limited.
- **Assertion validation** — `POST /record/:sessionId/assertion` rejects payloads with invalid `kind` (anything other than `assertVisible` / `assertText` / `assertValue` / `assertUrl`) with 400. Missing `selector` for non-`assertUrl` kinds → 400. Missing `value` for `assertText` / `assertValue` / `assertUrl` → 400. Verify each branch returns a clear error message.
- **Step prose contract** — the persisted `steps[]` array must NEVER leak raw `role=…[name="…"]` selectors, `#id` CSS, or `.class` selectors into the rendered step. The fallback chain (`label` → role-selector name extraction → empty target phrase) at `backend/src/runner/recorder.js:440-489` is property-tested at `backend/tests/recorder.test.js` (`never leaks raw role=…[name="…"] or CSS selectors into the rendered step`).

---

### ▶️ Runs

**Preconditions:** At least one approved test.

**Steps & expected:**
1. Run single test → status: queued → running → passed/failed; logs, screenshots, video available.
2. Run regression suite → all tests execute; summary shows pass/fail counts matching detail view.
3. **Cross-browser run selector** (`docs/changelog.md` DIF-002) — trigger run with each engine: **Chromium** (default), **Firefox**, **WebKit**. Each run record persists `browser` (migration 009); RunDetail page shows a per-run badge.
4. **Mobile device emulation** (`docs/changelog.md` DIF-003) — pass `device` (e.g. `"iPhone 14"`, `"Pixel 7"`) → run uses Playwright device profile (viewport, user agent, touch). Verify dropdown lists curated devices.
5. **Parallel execution** (`README.md`) — set parallelism 1–10 from UI (or `PARALLEL_WORKERS`). Verify each worker has isolated video/screenshots/network logs; default is 1.
6. **Live run view** — RunDetail streams logs via SSE, shows per-step screenshots, and exposes **Abort** action mid-run.
7. **Abort run** → run marked `stopped`; partial results retained; per-test hard timeout is `BROWSER_TEST_TIMEOUT` (default **120 000 ms**, `AGENT.md`).
8. Re-run failed tests only → only previously-failed tests execute.
9. **Self-healing** (`README.md`) — break a primary selector, re-run; runtime tries role → label → text → aria-label → title, remembers the winner per element. Confirm subsequent run picks the previously-successful strategy first.

**Negative / edge:**
- Trigger run while another is in progress → concurrency = `PARALLEL_WORKERS` (default **1**, `AGENT.md`). Extra runs queue; no crash.
- Run test against unreachable target → fails with clear network error, not timeout silence.
- Long-running / hung test → aborted at `BROWSER_TEST_TIMEOUT` with a clear timeout error.
- **Flaky test (intermittent failure)** → product-level auto-retry **IS** wired (AUTO-005, PR #2). Each test failure triggers up to `MAX_TEST_RETRIES` retries (default **2**, max 10, set to `0` to disable) before the result is recorded as truly failed. Verify via `result.retryCount` (number of retries actually consumed) and `result.failedAfterRetry` (true only when all attempts failed). A test that fails once then passes shows `retryCount: 1, status: "passed"` — notifications and failure counters fire only on `failedAfterRetry: true` (`backend/src/runner/retry.js`, `backend/src/testRunner.js:229-240`). **Note:** only the FINAL attempt's video / screenshots / trace are preserved on disk — earlier attempts overwrite each other (intentional; see retry.js JSDoc § "Artifact overwrite behaviour"). Self-healing (`safeClick` / `safeFill` selector waterfall) is a separate, lower-level recovery layer — DIF-015b's nth=N disambiguation also reduces flake at recording time.
- Viewer attempts to trigger run → blocked.
- `qa_lead` stops another user's run → **allowed** (no per-user "own runs" gate exists in code, `routes/runs.js:257` only requires `qa_lead`). If product intent is to restrict to the run's owner, file as security enhancement.
- Browser close mid-run → run continues on backend; status visible on return.

---

### 📥 Review Queue

**Preconditions:** Workspace has ≥ 1 draft test. Open `/review-queue`. Reachable via the **Review Drafts** quick-action card on the Tests page (`frontend/src/pages/Tests.jsx`) or by direct URL. Replaces the legacy `ReviewModal` (deleted in PR #7).

**Layout:**
- Two-pane: left list (sort, search, category chips, multi-select) + right detail pane (steps, generated Playwright code, quality score).
- Tab bar at top: **Draft** / **Rejected** / **Approved** with live counts from `GET /api/v1/tests/counts` (single aggregate query — partitions Draft / Approved / Rejected via `SUM(CASE WHEN reviewStatus = ...)`).
- URL-driven state: `?tab=`, `?projectId=`, `?q=` are deep-linkable.
- Header project filter (dropdown) — narrows list, counts, and the Review Drafts deep-link target on the Tests page.

**Steps & expected:**
1. Open `/review-queue` → Draft tab active by default; first draft auto-selected in the detail pane.
2. Click any test row → detail pane shows description, steps, syntax-highlighted Playwright code (with one-click copy), and a sidebar with quality-score bar, project, type, priority, last run, generated-time, source URL.
3. Click the `Q:NN ▾` chip on a row or in the sidebar → factor-breakdown popover lists rewards (`✓ +20 URL assertion`) and penalties (`✗ -30 No assertions`) that produced the score. Backed by `qualityScoreFactors` JSON column populated by `scoreTestWithFactors()` in `backend/src/pipeline/deduplicator.js` (re-scored after assertion enhancement, so the persisted breakdown matches the persisted code).
4. **Sort dropdown** (newest / oldest / quality / name) → server-side `ORDER BY` via `?sortBy=` (whitelisted by `SORT_BY_CLAUSES` in `backend/src/database/repositories/testRepo.js`). Switching from "newest" to "quality" reorders **across all pages**, not just the current page; pager resets to page 1.
5. **Search input** → debounced 300 ms before committing to URL `?q=` and firing the server query (`useReviewQueueQuery`).
6. **Category chips** (All / Web / API / Journey) → server-side filter; "Journey" maps to `isJourneyTest = 1` (orthogonal to api/ui).
7. **Approve a draft** — click Approve in the detail-pane header, sidebar Quick-decision group, or press `a` → `PATCH /projects/:id/tests/:testId/approve` fires (no confirmation modal — primary action stays one-click). Active selection advances to the next visible test before the cache invalidation lands.
8. **Reject a draft** — click Reject or press `r` → styled `<ModalShell>` confirmation dialog → execute → `PATCH /projects/:id/tests/:testId/reject`.
9. **Switch to Rejected tab** → only Restore-to-Draft action is available (no direct rejected→approved path; verify by inspecting the sidebar Quick-decision group and the detail-pane header). Pressing `a` on this tab is a no-op (tab-gated).
10. **Restore a rejected test** → `PATCH /projects/:id/tests/:testId/restore` returns it to Draft so it re-enters the queue for re-review.
11. **Switch to Approved tab** → only Reject is available (no Approve duplication).
12. **Bulk approve / bulk reject** — select ≥ 2 drafts via checkboxes → bulk bar appears at bottom of list pane → both routes go through the styled confirmation modal.
13. **Per-row delete** (qa_lead+) → trash icon hidden until row is hovered or active; soft-deletes to recycle bin via styled confirmation.
14. **Inbox-zero coaching** — when the Draft tab is empty (no search/filter active), the page renders a green-check coaching layout: "Inbox zero" headline + workspace approval count + "Generate more tests →" primary CTA (deep-links to `/projects/:id/test-lab` if a project is selected, otherwise `/test-lab`) + "Audit recent approvals" secondary CTA (switches to Approved tab).
15. **Mobile layout** (< 640px) — single-pane "back-to-list" pattern: picking a row hides the list and shows only the detail pane; a `<` button in the detail header returns to the list.
16. **Tab counts** — single aggregate query (not three `pageSize:1` probes) so flipping projects / search updates all three badges in lock-step.

**Negative / edge:**
- Search returns no matches → "No matches" empty state (does not surface the inbox-zero coaching).
- Pressing `a` / `r` while inside the search input → no-op (input-focus guard).
- Rapid `a`/`r` keypresses → guarded by `actionLoading` so the same test cannot fire two concurrent mutations.
- Project deleted while open in detail pane → next refetch drops the test; auto-select advances to the first visible row.
- Workspace switch → all Review Queue queries reset (TanStack Query cache invalidation is workspace-scoped via the parent project filter).
- Viewer attempts approve/reject/restore → 403 (`requireRole("qa_lead")` on the underlying endpoints).

---

### 🤖 Auto-Approval (AUTO-003b)

**Preconditions:** Project exists with `qa_lead` or `admin` access. Endpoints documented in `backend/src/routes/projects.js` (PATCH threshold), `backend/src/routes/tests.js` (revoke + approval-stats), and `backend/src/middleware/permissions.json`.

**Threshold configuration** (`/automation` → expand a project → **Auto-Approval** inner tab, `frontend/src/components/automation/ProjectQualityCard.jsx`):
1. Default state: `autoApproveThreshold` is `null` → all generated tests still land in **Draft** (zero behaviour change for projects that haven't opted in).
2. Enter a threshold of `0.8` and click **Save** → since this is the *first* enable, a confirmation modal appears showing how many of the last 30 generated tests would have been auto-approved at this threshold (`getTests()` + client-side filter on `confidenceScore >= threshold`).
3. Click **Enable auto-approval** in the modal → `PATCH /api/v1/projects/:id` with body `{ autoApproveThreshold: 0.8 }` → toast "Auto-approval threshold set to 0.8".
4. Re-enable / change threshold (project already had a non-null value) → no preview modal; saves immediately. Disable (clear input → `null`) → no preview modal; toast "Auto-approval disabled".
5. Stats line below the input renders `N auto-approved · N human-approved · N draft` from `GET /api/v1/projects/:id/approval-stats`. When auto-approvals exist, a `X% revert rate (7d)` chip appears with a tooltip `M of N auto-approvals were revoked in the last 7 days`.

**Validation (each must return 400):**
6. PATCH with `autoApproveThreshold: 0` → 400 "must be null or a number greater than 0 and at most 1" (the route disallows 0 as a footgun — `confidenceScore >= 0` would auto-approve everything).
7. PATCH with `autoApproveThreshold: 1.5` → 400 (out of range).
8. PATCH with `autoApproveThreshold: "0.8"` (string) → 400 (must be finite number or null).
9. PATCH body `{ autoApproveThreshold: 0.8 }` with no `name` / `url` → succeeds (threshold-only PATCHes bypass the name/url validator; `backend/src/routes/projects.js:145-151`).

**Auto-approval at generation time** (`backend/src/pipeline/testPersistence.js`):
10. With threshold set to `0.8`, generate tests → tests with `confidenceScore >= 0.8` persist as `reviewStatus: "approved"` with `approvalSource: "auto"`, `approvalThreshold: 0.8` (captured at decision time), `approvedAt` (epoch ms), `approvedBy: "auto-approver"`.
11. Tests with `confidenceScore < 0.8` persist as `reviewStatus: "draft"` with all four provenance columns null.
12. Each auto-approval emits one `test.auto_approved` activity row with `userName: "auto-approver"` and structured `meta: { score, threshold }`.
13. After raising the threshold to `0.9`, historical auto-approvals retain their original `approvalThreshold: 0.8` — provenance is captured at decision time, not refreshed against the current setting.

**Tests page badges** (`frontend/src/pages/Tests.jsx`):
14. Auto-approved tests render `🤖 Auto · 0.91` (purple). Human-approved render `👤 Human` (green). Draft renders `📝 Draft · 0.62` (amber). Provenance is visible inline at table density — not hover-only (NEXT.md:100 anti-pattern).
15. Filter pills row: `All Tests` / `Approved` (human only) / `Auto-approved` / `Draft`. Counts on the pills reflect partition: clicking `Approved` excludes auto-approved tests; clicking `Auto-approved` shows only `approvalSource === "auto"`.

**Test Detail provenance + revoke** (`frontend/src/pages/TestDetail.jsx`):
16. Open an auto-approved test → sidebar shows inline provenance line: `🤖 Auto-approved · score 0.91 · threshold 0.80 · 2h ago` (`fmtRelativeTimeFull`).
17. Open a human-approved test → sidebar shows `👤 Approved by @alice · 3h ago`.
18. Click **Revoke approval** → `POST /api/v1/tests/:testId/revoke` → test returns to `reviewStatus: "draft"`; all five columns (`reviewedAt`, `approvalSource`, `approvalThreshold`, `approvedAt`, `approvedBy`) clear; the page reloads showing the draft state. Tooltip on the button surfaces the original threshold for context.
19. Try to revoke an already-draft test → 400 "only approved tests can be revoked".
20. Revoke writes a `test.revoke` activity with `meta.wasAutoApproved` set to `true` for auto-approved tests, `false` for human-approved.

**ReviewQueue 24h auto-approval tray** (`frontend/src/pages/ReviewQueue.jsx`, AUTO-003b):
21. With a single project selected (project filter, not "All") AND `autoApproveThreshold` set, open the Draft tab → a tray strip renders above the draft list: `🤖 N auto-approved (24h):` followed by clickable test chips with `Q:NN` quality scores (`qualityColor()` styling).
22. Click a chip → navigates to `/tests/:testId` for a 30-second spot-audit.
23. Tray is suppressed on the Approved / Rejected tabs, when "All projects" is selected, or when the selected project has no threshold configured.
24. Tray is empty (renders nothing) when no auto-approvals have fired in the last 24h.

**ProjectHeader aggregate** (`frontend/src/components/project/ProjectHeader.jsx`):
25. Open a project → header subtitle shows `N tests · N human · N auto 🤖 · N drafts` from `GET /api/v1/projects/:id/approval-stats`.
26. Aggregate is non-fatal: if the endpoint errors, the line just doesn't render.

**ApprovalsTimeline page** (`/approvals`, `frontend/src/pages/ApprovalsTimeline.jsx`):
27. Sidebar → **Approvals** → daily-grouped audit feed renders. Each day splits into per-actor batches: `🤖 12 auto-approved (avg score 0.89)` and `👤 @alice approved 3`.
28. Expand a batch → per-test rows with confidence/threshold (read from `activity.meta`), project name, time, and a per-test **Revoke** button on auto-approval rows.
29. Click Revoke on a row → toast "Approval revoked"; the row flips to italic `revoked` and the button hides. Failure surfaces as a "Revoke failed" toast.
30. Activity log is the source of truth: revoked tests still appear here even after their provenance columns are cleared on the test row.

**Bulk approve / restore provenance** (`backend/src/routes/tests.js`, AUTO-003b):
31. Bulk approve via Review Queue → each test gets `approvalSource: "human"`, `approvedBy` (the actor's `userName` / `userId`), `approvedAt` (epoch ms), `approvalThreshold: null`. Verify by GET'ting the tests after the bulk action.
32. Bulk restore → all four provenance columns clear (so a previously auto-approved test bulk-restored to draft doesn't retain stale `approvalSource: "auto"`).

**Permissions:**
33. `viewer` calling `POST /tests/:testId/revoke` → 403. `qa_lead` and `admin` succeed.
34. `viewer` calling `GET /projects/:id/approval-stats` → 403. `qa_lead` and `admin` succeed.
35. Cross-workspace ACL — outsider hitting `/projects/:id/approval-stats` for another workspace → 404.

**Negative / edge:**
- 7-day revert rate is clamped to `[0, 1]` — even if backfill produces more revokes than auto-approvals in the window, the UI renders at most "100%", never `117%`.
- `meta.wasAutoApproved` flag on revoke rows lets approval-stats compute the rate without correlating testIds across activity types — verify by revoking a human-approved test (its `wasAutoApproved: false` row must NOT count toward the auto-approval revert rate).
- Pre-AUTO-003b tests (created before the migration) have `confidenceScore: null` — they never auto-approve regardless of threshold; the Tests page renders them as `📝 Draft` without a score chip.
- First-time enable preview gracefully degrades: if `getTests()` fails, the panel falls through to a direct save rather than blocking the user (the toast on persist surfaces any save error).
- Disabling auto-approval (clearing the threshold) does NOT retroactively revoke previously auto-approved tests — those keep their provenance and remain approved. Reviewers who want to clear them must Revoke individually or via bulk restore.

---

### 🪄 AI Fix (failed test recovery)

**Preconditions:** A test exists with `playwrightCode` and `lastResult === "failed"` (or its latest run result is failed). AI provider configured. Role: `qa_lead` or `admin` (`backend/src/routes/testFix.js:152` — `requireRole("qa_lead")`).

**Manual fix flow:**
1. Open the failed test in TestDetail → **"Fix with AI"** button visible only when failed and code present (`frontend/src/pages/TestDetail.jsx:411-426`).
2. Click → `POST /api/v1/tests/:testId/fix` opens an **SSE stream** with incremental tokens.
3. Fix panel shows the proposed new code with a diff against the current code.
4. Accept → test goes back to **Draft** state for re-review (never silently re-approved — `backend/src/pipeline/feedbackLoop.js:481-490`).
5. Re-run the test after re-approval → previously-failing assertion passes.

**Automatic feedback loop** (`backend/src/pipeline/feedbackLoop.js:443-496`):
6. On a regression run with failures, only **high-priority categories** are auto-regenerated: `SELECTOR_ISSUE`, `URL_MISMATCH`, `TIMEOUT`, `ASSERTION_FAIL`, `NETWORK_MOCK_FAIL`, `FRAME_FAIL`, `API_ASSERTION_FAIL` (`backend/src/pipeline/feedbackLoop.js:358-366`).
7. Regenerated tests appear in **Draft** with `_regenerated` / `_regenerationReason` metadata; `qualityAnalytics` attached to the run.
8. Flaky-test detection runs and is exposed in `analytics.flakyTests` on the run record.

**Negative / edge:**
- No AI provider configured → button still clickable, server returns **503** with a clear "Go to Settings" message (`testFix.js:162-166`).
- Test with no `playwrightCode` → server returns **400** "Test has no Playwright code to fix" (`testFix.js:158-160`).
- Viewer attempts to call `/fix` → 403 (role gate).
- Cancel SSE mid-stream → no partial update persisted.
- AI returns malformed code → surfaced as "invalid output" error, original code untouched.
- Fix run mid-execution → abort signal honored, no half-applied changes (`feedbackLoop.js:478`).

---

### ✏️ Test Code Editing (Steps ↔ Source)

**Preconditions:** Approved test with `playwrightCode`. Open TestDetail.

**Toggle & view:**
1. Steps / Source toggle present (`frontend/src/pages/TestDetail.jsx:125-126`). Default = Steps.
2. **Steps tab** — list of plain-English steps; can add, remove, reorder, edit text inline.
3. **Source tab** — full Playwright code, monospace, editable.

**Code regeneration on step edit** (`backend/src/routes/tests.js:154-273`):
4. Edit a step → save → **preview** mode kicks in: diff panel shows old vs new code with **minimal changes only** (existing helpers, comments `// Step N:`, structure preserved).
5. The new code starts with `await page.goto(...)`, uses role-based selectors, has ≥ 3 `expect(...)` assertions, includes no `import` statements (cloud prompt at `backend/src/routes/tests.js:218-224`).
6. Accept diff → `playwrightCode` updated; `playwrightCodePrev` set to old code; `codeRegeneratedAt` timestamped.
7. Discard diff → no DB change; the test keeps prior code.
8. The hint banner reads "Code will be regenerated on save — you'll review changes before applying" when editing in Steps view (`frontend/src/pages/TestDetail.jsx:862-875`).

**Direct source editing:**
9. Edit Playwright code directly in **Source** tab → save → persists without going through AI regeneration (steps and code can drift; document this as expected).
10. `isApiTest` flag updates automatically based on code content (`backend/src/routes/tests.js:265`).

**Local provider (Ollama) path:**
11. Switch to a local provider → editing a step still works; backend uses a **shorter prompt**, plain-text response (no JSON wrapper) per `backend/src/routes/tests.js:199-209` and `230-238`. Verify regenerated code still parses.

**Negative / edge:**
- AI provider down → save returns the regeneration error string; original test untouched.
- Concurrent edit by two users → last-write-wins; document if an edit warning is shown.
- Edit and refresh before save → unsaved-changes warning.
- Edit Source to invalid JS → server validation rejects (test would fail to compile at run time); confirm clear error.
- Viewer attempts edit → 403.

**Edit with AI panel** (DIF-007 — `frontend/src/components/test/AiTestEditor.jsx`, `backend/src/routes/chat.js` `test_edit` mode):

**Preconditions:** Test with `playwrightCode` exists; AI provider configured; role `qa_lead` or `admin`.

1. Open TestDetail → toolbar shows **"Edit with AI"** button (only when `playwrightCode` is present).
2. Click → AI editor panel expands with prompt textarea, Generate / Apply buttons.
3. Enter a natural-language instruction (e.g. "Add an assertion that cart total updates after quantity change") → click **Generate edit**.
4. Backend receives `POST /api/v1/chat` with `context: { mode: "test_edit", testName, testSteps, testCode }` → uses dedicated `TEST_EDIT_SYSTEM_PROMPT`; SSE stream returns Markdown with `### Summary` + a fenced ` ```javascript ` block.
5. Frontend extracts the code block via `extractCodeBlock()` → renders a **DiffView** showing before/after.
6. Click **Apply** → `PATCH` saves new `playwrightCode`; panel closes; view switches to **Source** tab; verify code is updated and persisted across refresh.

**Negative / edge:**
- No AI provider configured → server returns **503**; error surfaces in the panel (not silent).
- Empty / whitespace-only prompt → **Generate edit** button disabled.
- AI response without a fenced code block → user-friendly error: "AI response did not include updated code. Try a more specific instruction."; original code untouched.
- SSE provider error mid-stream → real provider message preserved (not overwritten by the generic "no code" message — see `hadError` flag in `AiTestEditor.jsx`).
- Click **Hide AI Editor** mid-generation → panel hides; in-flight stream behavior should not corrupt state (note: in-flight `fetch` continues until completion — see review thread on AbortController).
- Viewer attempts → 403 on save.

---

### ⚡ Automation (CI/CD + Scheduled Runs)

**Preconditions:** Project exists with at least one approved test. Open `/automation` (or use `?project=PRJ-X` deep-link).

**Tabbed layout (PR #6):** `/automation` renders four top-level tabs — **Triggers & Schedules**, **Quality Gates**, **Integrations**, **Snippets** — with WAI-ARIA tab semantics (`role="tablist"` / `role="tab"` / `role="tabpanel"`, arrow-key + Home/End navigation, `aria-selected`, `aria-controls`). Only the active tab's content mounts. Per-project accordion cards live inside the relevant tab; collapsed headers render live status chips (`N tokens` / `Scheduled` vs `No schedule` on Triggers & Schedules; `Gates configured` / `Budgets set` vs `No gates` / `No budgets` on Quality Gates) so config state is visible without expanding. Verify before each section below:
1. All four tabs render and switch on click; arrow-keys / Home / End move focus between tabs and activate the focused tab.
2. `?project=PRJ-X` auto-expands the matching project card on whichever tab is active.
3. The empty state ("No projects yet") renders in both **Triggers & Schedules** and **Quality Gates** when no projects exist.
4. Below 640px: chips wrap under the project name, tab padding tightens, layout stays usable (no horizontal scroll).
5. Status-chip API response shapes are pinned in `frontend/src/utils/automationStatus.js` with regression coverage in `frontend/tests/automation-status.test.js` — if a backend response renames `data.schedule.enabled` / `data.qualityGates` / `data.webVitalsBudgets`, the chips silently fall back to the unconfigured state.

**CI/CD trigger tokens** (`docs/changelog.md` ENH-011) — under the **Triggers & Schedules** tab, expand a project card → inner tab bar switches between **CI/CD Tokens** and **Schedule**. The "View project" link is pushed to the right of the inner tab bar.
1. Create a token via `POST /api/projects/:id/trigger-tokens` (UI button) → plaintext token shown **exactly once**; refresh and confirm only the SHA-256 hash is stored (never plaintext again).
2. List tokens → no hashes leaked to UI.
3. Trigger a run via `POST /api/projects/:id/trigger` with `Authorization: Bearer <token>` → returns **202 Accepted** with `{ runId, statusUrl }`. Poll `statusUrl`; final state matches RunDetail page.
4. Optional `callbackUrl` → callback hits the URL on completion with run status.
5. Revoke token via `DELETE /api/projects/:id/trigger-tokens/:tid` → subsequent trigger calls return 401.

**Diff-aware CI crawl — `triggerCrawl: true`** (AUTO-002 + AUTO-015, PR #12, `backend/src/routes/trigger.js`):
6. `POST /api/v1/projects/:id/trigger` with body `{ "triggerCrawl": true, "previewUrl": "https://your-preview.example.com" }` + valid Bearer token → returns **202** with `{ runId, statusUrl }`; the dispatched run has `type: "crawl"` (not `test_run`), and the `crawl.start` activity row reads `CI/CD triggered crawl — <previewUrl>`. Without `triggerCrawl`, the endpoint still runs the existing approved-tests flow (zero regression).
7. **No-change short-circuit** — trigger a crawl twice against an unchanged site → second run ends as `completed_empty` with `run.noChangesDetected = true`, a `🟰 No page changes detected` log line, and zero LLM calls. Verify `run.changedPages` is `[]` and `run.removedPages` is `[]`.
8. **Diff-scoped regeneration** — modify one page, re-crawl → only that URL appears in `run.changedPages`; untouched pages' approved tests remain untouched; pipeline summary log reads `Pages: 10 (3 changed → generated)` when the diff narrows generation scope.
9. **Removed pages surfaced** — delete a page from the site, re-crawl → its URL appears in `run.removedPages`; baseline row dropped so it is not re-reported on subsequent crawls.
10. **SSRF guard on previewUrl** — `POST /trigger` with `previewUrl: "http://169.254.169.254/latest/meta-data/"` or any RFC1918 address → 400 with the SSRF error (same validator as `callbackUrl`).

**Deployment webhooks — Vercel + Netlify** (AUTO-015, PR #12):
11. Set `VERCEL_WEBHOOK_SECRET` / `NETLIFY_WEBHOOK_SECRET` in `backend/.env` (see `docs/guide/env-vars.md` § Deployment Webhooks).
12. Configure Vercel to POST to `/api/v1/projects/:id/trigger/vercel` with an `Authorization: Bearer <trigger-token>` header (dual-auth: HMAC signature + project-scoped Bearer). The Snippets tab on `/automation` renders a copy-pasteable payload template including both headers.
13. Trigger a deployment → when Vercel fires `type: "deployment.ready"` (or `deployment.readyState: "READY"`) → backend returns **202** with `{ ok: true, provider: "vercel", runId, previewUrl }`; a `crawl.start.deployment` activity row is logged with `meta: { provider, previewUrl, runId }`; a diff-aware crawl against the preview URL launches.
14. **Non-ready events ignored** — Vercel webhooks for `deployment.created` / `deployment.canceled` / `deployment.error` / `readyState: "BUILDING"` return **200** with `{ ignored: true, reason: "deployment not ready" }` and do NOT launch a run.
15. **Netlify** — same dual-auth with `X-Netlify-Token` (HMAC-SHA256); payload uses `deploy_ssl_url` or `deploy_url`. Only fires when `state === "ready"`; non-ready states (`building`, `processing`, `error`, …) return **200** with `{ ignored: true, state }` and do NOT launch a run.
16. **Tampered signature** — POST the correct payload with an invalid `X-Vercel-Signature` / `X-Netlify-Token` → **401 "invalid signature"** before any crawl work starts.
17. **Missing / bogus Bearer token** — valid HMAC but no `Authorization` header, or a revoked token → **401** from `requireTrigger` BEFORE the HMAC check (dual-auth enforced in order).
18. **Production baselines preserved on preview crawls** — the crawl against the preview URL must NOT overwrite the project's production baselines. Verify by running a production crawl, then a preview crawl, then another production crawl → the final production crawl should report `0 changed, 0 removed` (baselines intact).

**Last deployment run badge** (AUTO-015b, `frontend/src/components/project/ProjectHeader.jsx`):
19. After a deployment-triggered crawl completes, open the project's detail page → a **🚀 Last `<provider>` run · N changed** chip renders in the header. Click → navigates to `/runs/:runId`.
20. Badge only renders when a `crawl.start.deployment` activity row exists within the last 24h (`GET /api/v1/projects/:id/last-deployment-run` returns `{ run: null }` otherwise).
21. If the run failed, the chip tints red and the text reads `Last <provider> run · N changed` with a failed-state color. Hover tooltip shows the provider + preview URL.
22. While the run is in flight, the chip reads **"Deployment crawl in progress"** in accent color.
23. The endpoint is allowed for any authenticated workspace member (`backend/src/middleware/permissions.json` — `anyAuthenticatedMember` list). Outsiders hitting the URL directly → 404.

**Diff-aware live view — `pages_changed` SSE** (AUTO-002, `frontend/src/components/project/ActiveRunBanner.jsx` via `useProjectRunMonitor`):
24. Launch a crawl on a project with an existing baseline → the Test Lab live banner reads **"N pages changed → regenerating only those"** instead of the generic "Run in progress…", with a sub-line `N changed · M removed · K unchanged · live via SSE`.
25. Launch a crawl on an unchanged site → banner reads **"No page changes since last crawl — skipping generation"**.
26. First-ever crawl on a new project (no baseline yet) → banner falls back to the generic "Run in progress…" (no diff to report).

**Scheduled runs** (`docs/changelog.md` ENH-006):
1. Open `ScheduleManager` for a project → set a 5-field cron expression + IANA timezone via preset picker (hourly/daily/weekly).
2. `PATCH /api/projects/:id/schedule` → server validates cron; invalid expression rejected (try `* * *` → 400).
3. Enable schedule → next-run time displayed; persists across server restart (hot-reloaded on save without process restart — verify by saving while watching backend).
4. Disable schedule → cron task cancelled; no runs fired.
5. `DELETE /api/projects/:id/schedule` → schedule removed; `GET` returns null.

**Negative / edge:**
- Viewer attempts to create trigger token or schedule → 403.
- **`qa_lead` attempts to create / revoke trigger token → 403** (admin-only, `routes/runs.js:379, 411`). `qa_lead` *can* create / edit schedules (`routes/projects.js:162, 222`).
- Trigger run with revoked or wrong token → 401, no run created.
- Schedule across DST transition → next-run time correct in target timezone.
- Two schedules firing simultaneously → respect `PARALLEL_WORKERS` queue; no crash.

---

### 🚦 Quality Gates (AUTO-012)

**Preconditions:** Project with ≥ 5 approved tests; `qa_lead` or `admin` logged in. Endpoints documented in `backend/src/routes/projects.js` and `backend/src/middleware/permissions.json`.

**CRUD flow:**
1. `GET /api/v1/projects/:id/quality-gates` (any workspace member, viewer+) → returns `{ qualityGates: null }` for an unconfigured project.
2. `PATCH /api/v1/projects/:id/quality-gates` with `{ minPassRate: 95 }` (`qa_lead` or `admin`) → returns `{ qualityGates: { minPassRate: 95 } }`. Reload + GET → value persists across requests.
3. PATCH `{ minPassRate: 80, maxFlakyPct: 10, maxFailures: 2 }` → all three fields persist together.
4. `DELETE /api/v1/projects/:id/quality-gates` (`qa_lead` or `admin`) → returns `{ ok: true, qualityGates: null }`; subsequent GET returns null again.

**Validation (each must return 400):**
5. `minPassRate: 150` (out of 0–100 range) → 400 "minPassRate must be between 0 and 100".
6. `maxFlakyPct: -1` → 400 "maxFlakyPct must be between 0 and 100".
7. `maxFailures: 1.5` (non-integer) or `maxFailures: -1` → 400 "maxFailures must be a non-negative integer".
8. PATCH with array body or non-object → 400 "qualityGates must be an object".

**Run-time evaluation** (`backend/src/testRunner.js` `evaluateQualityGates`):
9. Configure `{ minPassRate: 95 }`. Trigger a run that finishes 9/10 passed (90%) → `run.gateResult = { passed: false, violations: [{ rule: "minPassRate", threshold: 95, actual: 90 }] }`.
10. Configure `{ maxFailures: 2 }` and finish a run with 3 failures → violation rule `maxFailures`, `actual: 3`.
11. Configure `{ maxFlakyPct: 5 }` and finish a run where `retryCount / total * 100 > 5` → violation rule `maxFlakyPct`.
12. All gates passing → `run.gateResult = { passed: true, violations: [] }`.
13. Project with **no** gates configured → `run.gateResult` is `null` (legacy / pre-AUTO-012 runs are unaffected; CI consumers must treat null as "no gate").

**CI/CD trigger integration** (`backend/src/routes/trigger.js`):
14. Trigger a run via `POST /api/v1/projects/:id/trigger` with a Bearer token, then poll `GET /api/v1/projects/:id/trigger/runs/:runId` → response includes top-level `gateResult` matching what's persisted on the run.
15. Provide `callbackUrl` on the trigger call → callback POST payload contains `gateResult: { passed, violations }` or `null`.
16. Confirm `gateResult` is included regardless of run status (`completed` / `failed` / `aborted`) when gates are configured; `null` otherwise.

**Permissions:**
17. As `viewer`, `PATCH` and `DELETE` quality-gates endpoints → **403** (not 200, not silent no-op). `GET` is allowed.
18. As `qa_lead` and `admin`, all three (GET / PATCH / DELETE) succeed.
19. Cross-workspace isolation — outsider hitting another workspace's project → 404 (workspace scope enforced upstream by `workspaceScope` middleware).

**UI surfaces (AUTO-012b, updated by PR #6):**

The Quality Gates and Web Vitals Budgets panels live exclusively on the `/automation` page now. The legacy ProjectDetail → Settings tab was removed in this PR (see the comment at `frontend/src/pages/ProjectDetail.jsx:601-603`); do not look for it.

- **`/automation` → Quality Gates tab** (sole surface, PR #6) — per-project accordion (`ProjectQualityCard`) with inner tab bar switching between **Quality Gates** and **Web Vitals**. Collapsed header shows status chips (`Gates configured` / `No gates`, `Budgets set` / `No budgets`).

20. On `/automation` → **Quality Gates** tab, expand a project → inner tab **Quality Gates** active by default → form renders. As `qa_lead`/`admin`, the form is editable; as `viewer`, fields are disabled and a "Read-only" hint shows.
21. Configure thresholds and click **Save** → toast "Quality gates saved"; reload tab → values persist.
22. Click **Clear all** → confirmation prompt → on confirm, gates removed; toast "Quality gates cleared"; subsequent runs report `gateResult: null`.
23. Enter all-blank fields and click Save → server-side `DELETE` is sent (config cleared) instead of saving an empty object — toast reads "Quality gates cleared".
24. Validation: enter `minPassRate: 150` → server returns 400; the form surfaces the error message inline (red banner) and does not corrupt local state.
25. Runs list (`/runs`) on a test run that has `gateResult` → green "Gates ✓" or red "Gates ✗" pill renders next to the status badge. Hover → tooltip lists violations.
26. Project Detail → **Runs** tab → same gate badge appears in the per-row status cell.
27. RunDetail header → gate badge appears next to the browser badge when `gateResult` is present. When gates failed, an inline red violation panel renders before the main content listing each `{ rule, threshold, actual }` entry.
28. Test runs created before AUTO-012 shipped (with `gateResult: null`) → no badge, no panel — UI must not regress for legacy runs.

**Negative / edge:**
- PATCH against a non-existent project ID → 404 "not found".
- Persisted JSON survives backend restart (column is `TEXT` JSON in migration `014_quality_gates.sql`).
- Pre-existing runs created before AUTO-012 shipped still load and render correctly with `gateResult: null` (no badge / no panel).
- Crawl and generate runs never carry `gateResult` even when configured (gates apply to test runs only) — verify badge / panel are suppressed in those views.

---

### 🌐 Environments (DIF-012)

_(automated: see `tests/e2e/specs/environments-ui.spec.mjs` for the Environments tab CRUD round-trip + RunRegressionModal dropdown via `page.route()` mock; backend integration coverage in `backend/tests/environments.test.js`. Coverage tracked in `tests/e2e/COVERAGE.md`.)_

**Preconditions:** Project exists; `admin` user logged in for mutations, `qa_lead`+ for reads. Endpoints documented in `docs/api/projects.md` § Environment management; permissions in `backend/src/middleware/permissions.json`.

**Run-scoped credential override** (DIF-012): when an environment carries `credentials`, both `environment.baseUrl` AND `environment.credentials` override their `project.*` counterparts for the duration of one run only. The project row is never mutated; the override happens via `envScopedProject()` in `backend/src/routes/runs.js` (UI-triggered runs) and `buildEnvScopedProject()` in `backend/src/routes/trigger.js` (CI/webhook-triggered runs). The shared scope contract: `canonicalUrl` is preserved so the AUTO-015 baseline guard treats env-scoped crawls as preview-style and doesn't overwrite production baselines. Envs **without** their own `credentials` inherit the project's auth — same shape as before.

**UI surface — ProjectDetail → Environments tab** (`frontend/src/components/project/EnvironmentsTab.jsx`):
1. Open `/projects/:id` → click the **Environments** tab (between Runs and Traceability) → empty-state copy reads "No environments defined. Runs will target the project's default URL."
2. Fill the add-environment form with `name: staging`, `baseUrl: https://staging.example.com` → click **Add environment** → toast `Environment created`; row appears in the table above with the `staging` name + `staging.example.com` URL.
3. Add a second env (`preprod`) with `username: qa` + `password: secret` filled in → row renders with a 🔒 lock icon + `qa` username (the password never echoes back — server response carries decrypted credentials; the table only renders the username).
4. Click **Edit** on the `preprod` row → form pre-fills with name + baseUrl (and `username: qa` — password field stays blank by design, never echoed). Change the `name` to `preprod-2` and save WITHOUT typing a new password → toast `Environment updated`; verify via DB inspection that the stored credentials still decrypt to `{ username: "qa", password: "secret" }` — the secret was NOT wiped.
5. Click **Edit** on the same row → clear both username and password fields → save → server stores `credentials: null`; reload tab → 🔒 column reads `—`.
6. Click the trash-can on a row → confirmation prompt → confirm → toast `Environment deleted`; row gone; reload to verify persistence.
7. As `qa_lead` (not `admin`) → tab renders, table is visible, but the add/edit form is hidden and per-row Edit / Delete buttons are disabled (admin-only mutations enforced by `requireRole("admin")` server-side; UI gates via the `canEdit` prop derived from `useAuth`).

**UI surface — Test Lab (crawl + generate)** (`frontend/src/pages/TestLab.jsx`):
8a. Open `/test-lab` (or `/projects/:id/test-lab`) → select a project with ≥ 1 environment → the right-rail launch panel renders an **Environment** dropdown below the Examples list (Requirement tab) or below the Estimate (Crawl tab). Selecting a non-default env causes the next **Start Crawl & Generate** / **Generate Tests** click to send `environmentId` in the POST body — verify by network-inspecting `/api/v1/projects/:id/crawl` or `/api/v1/projects/:id/tests/generate`.
8b. Switch projects in the left sidebar → env list reloads against the new project, selection resets to "Default" (no stale envId leak). Switch to a project with zero envs → dropdown disappears entirely.
8c. The recorder launched from Test Lab inherits the page-level env selection via the `defaultEnvironmentId` prop — clicking **Record a test** while a non-default env is selected pre-fills the recorder's Environment dropdown to match.

**UI surface — RecorderModal environment selector** (`frontend/src/components/run/RecorderModal.jsx`):
8d. Open the recorder on a project with ≥ 1 environment → idle form shows an **Environment** dropdown below the Project picker. Selecting an env auto-fills the **Starting URL** field with `environment.baseUrl` (operator lands on the right env from the first frame).
8e. Clicking **Launch recorder** sends `environmentId` in the `POST /record` body so the run record's `environmentId` column is set — verify by inspecting the `runs` row (`SELECT environmentId FROM runs WHERE id = '<sessionId>'`).
8f. The recorder is interactive (operator-driven) — `environment.credentials` are NOT auto-applied to login forms inside the recorder. Operators who need to log in to a non-default env will manually fill the form. Auto-login from env credentials applies to crawl/generate/run paths only (where it runs unattended).

**UI surface — RunRegressionModal environment selector** (`frontend/src/components/run/RunRegressionModal.jsx`):
8. From `/runs` click **Run Tests** → modal opens. With a project that has zero environments selected, the **Environment** dropdown does NOT render (clutter-free for env-less projects).
9. Switch the project selector to a project with ≥ 1 environment → the **Environment** dropdown appears with `Default (project URL)` as the first option, followed by each env as `<name> — <baseUrl>`.
10. Switch back to the env-less project → dropdown disappears AND any envId selected against the previous project is cleared (stale selection never leaks into the next run payload).
11. Select a non-default environment + click **Run Tests** → POST body to `/api/v1/projects/:id/run` includes `environmentId: "ENV-<uuid>"`. Leave on `Default` → body omits the field entirely.

**UI surface — Dashboard "Environments" panel** (`frontend/src/pages/Dashboard.jsx`):
12. Open `/dashboard` in a workspace where no project has any environments → the **Environments** panel does NOT render (zero-regression for workspaces that haven't adopted the feature).
13. Add an environment to any project + run regression at least once against each of "default" and the new env → reload dashboard → **Environments** panel renders with one row per `(project, environment)` bucket that has executed ≥ 1 completed test run.
14. Each row shows project name (click → `/projects/:id`), environment name + baseUrl, pass-rate cell (green ≥ 80%, amber 50–79%, red < 50%) with `(passed/total)` counts, and a **Last green run** cell that's clickable → navigates to that run's RunDetail. Buckets with zero green runs show "Never" in grey.
15. Switch workspace → panel resets and recomputes against the new workspace's projects.

**API flow — happy path** (admin token unless noted):
16. `POST /api/v1/projects/:id/environments` with `{ "name": "staging", "baseUrl": "https://staging.example.com" }` → **201** with the created env (`id` is `ENV-<uuid>`, `credentials: null`, `createdAt` ISO timestamp).
17. `POST /api/v1/projects/:id/environments` with `{ "name": "preprod", "baseUrl": "https://preprod.example.com", "credentials": { "username": "qa", "password": "secret" } }` → **201**; response includes `credentials` in decrypted form. Verify via direct DB read that the stored column is AES-encrypted (`backend/src/utils/credentialEncryption.js`).
18. `GET /api/v1/projects/:id/environments` (`qa_lead+`) → returns both environments, ordered by `createdAt ASC`.
19. Trigger a regression run with `{ "environmentId": "<staging-id>" }` → run dispatches; `GET /api/v1/projects/:id` still returns the original `url` (project row never mutates — verified at `backend/tests/environments.test.js`).
20. Inspect the run record via `GET /runs/:runId` → `environmentId` is persisted in the lean run columns (`backend/src/database/repositories/runRepo.js` `INSERT_COLS`).
21. `PATCH /api/v1/projects/:id/environments/:environmentId` with `{ "name": "staging-2", "baseUrl": "https://staging-2.example.com", "credentials": { "username": "u2", "password": "p2" } }` → **200**, response carries decrypted updated credentials.
22. PATCH the same env with only `{ "name": "staging-3" }` (no `credentials` key) → stored credentials decrypt to `u2`/`p2` unchanged (PATCH-without-key preserves stored secret).
23. PATCH with `{ "credentials": null }` → secret cleared in DB.
24. `DELETE /api/v1/projects/:id/environments/:environmentId` → **200** `{ ok: true }`; subsequent GET returns the remaining environments without this row.

**Negative / edge — all must hold:**
- `POST` with missing `name` or `baseUrl` → **400** `name and baseUrl are required`.
- Run with `environmentId: "ENV-does-not-exist"` → **400** `invalid environmentId` BEFORE the no-approved-tests check; trigger token path raises the same error.
- Run on project A with `environmentId` belonging to project B → **400** `invalid environmentId` (cross-project leak rejected — see `backend/src/routes/trigger.js`).
- Run on a project with NO environments AND NO `environmentId` in payload → behaves identically to pre-DIF-012 (zero regression — gate fails on no-approved-tests, not on env validation).
- `viewer` calling `GET /api/v1/projects/:id/environments` → **403** (`qa_lead+` gate).
- `qa_lead` calling `POST` / `PATCH` / `DELETE` on environments → **403** (admin-only mutations).
- Cross-workspace ACL — outsider hitting `/api/v1/projects/:id/environments` for a project in another workspace → **404** (workspace scope enforced upstream by `workspaceScope` middleware), and outsider PATCH on a known env id → **404** (not 403, to avoid leaking existence).
- Delete an environment that has existing runs → DELETE succeeds; the historical runs keep their `environmentId` value, but the env row is gone (dashboard buckets for that env stop appearing the next time the aggregation runs).
- `credentials` payload must be a plain object — passing a string or array currently round-trips as-is through `encryptCredentials` (verify; file as enhancement if hardening is desired).

---

### 🔀 Distributed Sharding (CAP-002)

_(automated: backend coverage in `backend/tests/run-sharding.test.js` (partition algorithm + route clamp + BUG-0001 decoupling), `backend/tests/run-storage-concurrency.test.js` (atomic `appendRunResults` + `incrementShardsCompleted` under 8× concurrent writers), `backend/tests/run-shard-finalizer.test.js` (race-safety: stats composition + exactly-one-finalizer + over-firing + interleave), `backend/tests/run-shard-crash.test.js` (first-writer-wins + late-abort race for `markRunFailedFirstWriterWins` / `markRunCompletedFirstWriterWins`), `backend/tests/run-shard-registry.test.js` (parent/shard `workerAbortControllers` registry), `backend/tests/run-worker-shard-retry.test.js` (shard-scoped retry reset), `backend/tests/run-abort-pubsub.test.js` (Redis pub/sub cross-replica abort, gated on `REDIS_URL`). UI coverage in `tests/e2e/specs/run-sharding-ui.spec.mjs` for the modal input + RunDetail badge.)_

**Preconditions:** Project with ≥ 5 approved tests; Redis running (`REDIS_URL` set) for the cross-process fan-out path; `qa_lead` or `admin` logged in. Without Redis, sharding falls back to in-process sequential partition (the badge still progresses but there is no wall-clock speedup — this is intentional and documented).

**Request shape** (`POST /api/v1/projects/:id/run` + `POST /api/v1/projects/:id/trigger`): body `{ "shards": 4 }`. Server-clamped to `[1, MAX_WORKERS]` (default `MAX_WORKERS=2`); default `1` (legacy zero-regression). `shards` is **decoupled from** `dialsConfig.parallelWorkers` — `shardCount` only persists `> 1` when the caller explicitly requested sharding (BUG-0001). A project using only `dialsConfig.parallelWorkers: 4` does NOT surface a misleading "Shards M/N" badge.

**RunRegressionModal `Shards` input:**

1. Open `/runs` → **Run Tests** → **Shards** numeric input renders below device + browser selectors; default `1`. Non-integer (`"3.7"`) coerces to `3`; negative or blank coerces to `1`. Values above `MAX_WORKERS` are server-clamped and the persisted `run.shardCount` reflects the clamp.
2. With `shards: 1`, the request body must NOT include the `shards` key (verify via DevTools Network). With `shards: 4`, the body includes `"shards": 4`.

**RunDetail "Shards M/N" badge:**

3. Submit `shards: 4` → header renders a blue **Shards 0/4** badge that ticks `0/4 → 4/4` as each shard's last test finishes (once per shard, NOT per test — data-driven tests do not drain the counter prematurely).
4. **Single-shard / pre-CAP-002** runs (or migrations < `025_run_shards.sql`) → no badge renders; header is bit-for-bit identical to legacy.
5. **`shards > tests.length`** — empty shards are pre-credited as complete the moment the partition computes; e.g. `shards: 4` on a 2-test suite shows `2/4` immediately, then `4/4` after the two non-empty shards finish.
6. **Hard browser-launch failure** — runner flushes `shardsCompleted` to `shardCount` so the badge reads `N/N` on the failed run (not stuck at `0/N`).

**Per-shard trace dropdown:**

7. Completed sharded run with ≥ 2 captured traces → "Open Trace" action becomes a `<select>` listing one option per non-empty `tracePaths[]` slot (`Shard 1/4`, `Shard 2/4`, …). Single-shard runs keep the single-link button.
8. **Sparse `tracePaths`** — when one shard crashed before flushing its trace, its slot is `null`; the dropdown skips it but preserves the original shard index in the label (no silent re-numbering).

**Coordinator fan-out (Redis available):**

9. Submit `shards: 4` → route partitions `selectedTests` into 4 contiguous slices via `partitionTestIdsForShards()` (Playwright `--shard=N/M`) and enqueues 4 BullMQ jobs of type `test_run_shard` sharing the parent `runId`. Each `jobId` is `${runId}:s${i}` (verify via BullMQ Redis keys).
10. Each shard worker pulls its pre-partitioned `testIds` slice from `job.data.options.testIds` — workers **never re-derive the split**. Verify via `worker.job_start` log entries with `type: "test_run_shard"`.
11. **No-Redis fallback** — unset `REDIS_URL` and re-run with `shards: 4` → in-process `runWithAbort` executes all 4 shards sequentially in one process; badge still progresses; run completes normally; no regression.
12. **Trigger path** — same fan-out for `POST /api/v1/projects/:id/trigger` with `shards: 4`. Response 202 shape unchanged from single-shard triggers.

**Finalization handoff:**

13. Exactly **one** shard per run finalizes — whichever shard's `incrementShardsCompleted` UPDATE both returns 1 AND lands the counter at `shardCount`. SQL row-lock predicate guarantees exactly-one even under heavy concurrency (covered by `run-shard-finalizer.test.js`).
14. The finalizer runs the AI feedback loop exactly once, transitions `status: "completed"` via `markRunCompletedFirstWriterWins`, emits one `done` SSE event, logs one `test_run.complete` activity row, fires notifications, completes the GitHub Check (if `run.githubCheck.checkRunId` is set), and POSTs the optional `callbackUrl` (trigger path only).
15. Aggregate `passed`/`failed`/`total` on the parent `runs` row reflect the sum across all shards. Data-driven tests' iteration overflow (`totalDelta`) composes correctly.

**Race-safety scenarios:**

16. **Concurrent shard finish** — 40 tests × `shards: 4` such that all shards complete near-simultaneously → exactly one `test_run.complete` activity row, one `done` SSE event, one notification fire. No duplicates.
17. **Mid-run abort** — long-running sharded run → click **Abort** halfway → abort route fans out to every shard's `workerAbortControllers` entry on this replica via `abortAllShardsForRun(runId)` AND publishes to `sentri:run-abort` so sibling replicas drain. Final status = `aborted`; `done` SSE event reports `status: "aborted"`.
18. **Late-abort race** — click Abort just as the last shard's `incrementShardsCompleted` lands → the finalizer's `markRunCompletedFirstWriterWins` UPDATE becomes a clean no-op (predicate `WHERE status = 'running'` evaluates false). Finalizer logs `run.finalize_skipped_terminal` and bails out before activity / done / notifications / callback. Final status = `aborted` (NOT overwritten to `completed`).
19. **Shard crash → run failed** — one shard's slice deterministically fails → first crasher writes the failure reason atomically via `markRunFailedFirstWriterWins`; subsequent crashing shards become no-ops (predicate evaluates false), preserving the first crasher's classified error. Worker publishes to `sentri:run-abort` so sibling shards drain. Final status = `failed`; `shardsCompleted < shardCount` preserved on the badge (truthful partial completion, NOT flushed to N/N).
20. **Cross-replica abort** (multi-replica deployments) — abort from replica A → replica B's workers receive the signal via `sentri:run-abort` within one Redis round-trip and cancel their in-flight controllers.

**CI/CD `callbackUrl` on sharded trigger runs:**

21. `POST /api/v1/projects/:id/trigger` with `{ "shards": 4, "callbackUrl": "https://ci.example.com/hooks/sentri" }` + Bearer token → 202 immediately. After the run completes, the callback URL receives exactly **one** POST with the same payload shape as single-shard trigger runs (`runId`, `status`, `passed`, `failed`, `total`, `error`, `gateResult`, `webVitalsResult`). SSRF-safe via `safeFetch` (re-resolves DNS, blocks redirects).
22. CI consumers can use one handler for both sharded and non-sharded runs — payload shape is identical.

**Permissions:**

23. `viewer` calling `POST /run` or `POST /trigger` with `shards: N` → 403 (same gate as single-shard).
24. Cross-workspace ACL — outsider hitting `/api/v1/runs/:runId` for a sharded run in another workspace → 404 (workspace scope enforced upstream).

**Negative / edge:**

- `shards: 0` or `shards: -5` → coerces to `1` (no error, no behaviour change from absent `shards`).
- `shards: "abc"` → coerces to `1` (non-numeric fallback).
- `shards: 100` with `MAX_WORKERS=2` → server clamps to `2`; persisted `run.shardCount: 2`.
- A test deleted between enqueue and worker pickup → that shard's `byId.get(id)` returns `undefined`, filtered out by `.filter(Boolean)`; the shard runs the remaining tests in its slice without crashing.
- A shard's BullMQ retry → wipes ONLY that shard's results via `purgeShardResults` (atomic, dialect-aware row lock); sibling shards' already-completed results survive the retry.

---

### 📊 Data-driven test fixtures (CAP-001)

_(automated: see `tests/e2e/specs/test-fixtures-ui.spec.mjs` for TestFixturePanel CSV upload round-trip, RunDetail iteration badges via `page.route()` mock, and Automation → Iterations panel save. Backend HTTP coverage in `backend/tests/test-fixtures-routes.test.js`; repo + runner unit coverage in `backend/tests/fixture-iteration.test.js`. Coverage tracked in `tests/e2e/COVERAGE.md`.)_

**Preconditions:** Project exists with `qa_lead` or `admin` access. A test exists with `playwrightCode` containing `{{column}}` placeholders. Endpoints documented in `backend/src/routes/tests.js` (fixtures CRUD), `backend/src/routes/projects.js` (`iterationCap` PATCH bypass), and `backend/src/middleware/permissions.json`.

**Fixture upload (TestDetail → Data-driven fixtures panel, `frontend/src/components/test/TestFixturePanel.jsx`):**
1. Open `/tests/:testId` → scroll to the **Data-driven fixtures** card → version badge reads `v<test.codeVersion>` (e.g. `v1` for a freshly created test).
2. Default format is **CSV**. Paste a 3-row CSV (`email,role\na@…,admin\nb@…,viewer\nc@…,viewer`) → click **Save fixture** → toast `Saved 3 row(s) at version 1`; history table renders one row with format `CSV`, count `3`, and an **active** badge (matches current `codeVersion`).
3. Switch the format select to **JSON array** → paste `[{"email":"a@…","role":"admin"}]` → save → second history row appears for the same version (replaces — fixtures are keyed on `(testId, version)`; verify by re-opening and confirming only one row per version).
4. **Same-version overwrite warning** — re-upload at the same `codeVersion` → `window.confirm` prompt appears (`A fixture already exists for version N (M row(s)). Saving will replace it. Continue?`). Cancel → no change; confirm → upserts.
5. **Different-version upload** — bump `codeVersion` (via an edit that triggers regeneration) → upload again → no confirm prompt fires (different version, not a replace).
6. **Iteration cap override** — fill the `iteration cap` input with `5` and upload a 15-row CSV → toast reads `Saved 5 row(s) at version N (truncated to cap 5)`; the response carries `capApplied: 5, truncated: true`.
7. **JSON validation** — paste invalid JSON → inline error `JSON is not valid — expected an array of row objects.` (form-level guard before request fires).
8. **Empty rows** — paste a CSV with only a header row → server returns 400 `fixture rows required`; the panel surfaces the error inline.

**Per-project iteration cap (`/automation` → Quality Gates → expand a project → **Iterations** inner tab, `IterationCapPanel`):**
9. Default state: `iterationCap` is `null` → server-side `clampIterationCap` falls through to the default **10** rows per data-driven test.
10. Fill the input with `25` → click **Save** → toast `Iteration cap set to 25`. Reload tab → value persists.
11. Clear the input → save → toast `Iteration cap cleared — using default (10).`; underlying PATCH sets `iterationCap: null`.
12. **Validation** — enter `0` / `101` / `1.5` → frontend error `Iteration cap must be empty or an integer between 1 and 100.` (server also returns 400 with the same range message at `backend/src/routes/projects.js`).
13. **Single-field PATCH bypass** — body `{ iterationCap: 25 }` with no `name`/`url` succeeds (mirrors the existing `autoApproveThreshold` bypass). A body that mixes `iterationCap` with another field (e.g. `status`) falls through to the full validator (verified by the `SINGLE_FIELD_BYPASS` set in `backend/src/routes/projects.js`).

**Run-time iteration (`backend/src/runner/executeTest.js` `executeTestIterations`, `backend/src/testRunner.js`):**
14. With a 3-row fixture saved at `v1` and a test whose `playwrightCode` references `{{email}}` → trigger a run → **3 iteration results land in `run.results`**, one per row. Each carries `iterationIndex` (0/1/2) + `fixtureRow` (the source row snapshot).
15. RunDetail → expand the test → each result row renders an `iteration #1` / `#2` / `#3` badge alongside the status pill. Hover the badge → the substituted row JSON is the tooltip (`title` attr).
16. **5-row CSV → 5 iteration results** acceptance criterion: upload 5 rows → run → all 5 must execute even if intermediate rows fail; verify by inducing a row 2 failure and confirming rows 3-5 still appear in `run.results` (the `executeTestIterations` for-loop never short-circuits).
17. **Fixture-less zero-regression** — a test with no fixture row uploaded at its current `codeVersion` runs **exactly once**; the result carries neither `iterationIndex` nor `fixtureRow`. Re-confirm by uploading a fixture at `v1`, bumping the test to `v2` via an AI fix, and running — the runner reads `(testId, v2)`, finds nothing, and falls back to the single-iteration path.
18. **Retry suppression for data-driven tests** — induce a row-level failure → the run log carries `↻ Skipping retry for <test> — N/M fixture iteration(s) failed (data-driven tests don't retry)`; fixture-less failures still go through the standard `MAX_TEST_RETRIES` flow.
19. **Cap clamp at runtime** — even if `projects.iterationCap` is set to `9999` via direct DB write, the runner's `clampIterationCap` enforces `[1, 100]` on every dispatch — verify by inspecting the dispatched batch size.

**Permissions:**
20. `viewer` calling `POST /api/v1/tests/:testId/fixtures` → 403. `qa_lead` and `admin` succeed.
21. `GET /api/v1/tests/:testId/fixtures` is `anyAuthenticatedMember` — viewer can read fixture history but not upload.
22. Cross-workspace ACL — outsider hitting `/api/v1/tests/:testId/fixtures` for a test in another workspace → 404 (workspace scope enforced via the test's parent project).

**Negative / edge:**
- Format allowlist — POST with `format: "xml"` → 400 `format must be 'csv' or 'json'` (matches the migration's CHECK constraint).
- CSV parser is RFC 4180-flavoured: handles quoted fields with embedded commas, CRLF line endings, and `""`-escaped quotes; trailing blank lines are dropped. A header-only file returns 400 (no data rows). Verified at `backend/tests/fixture-iteration.test.js`.
- Fixtures are scoped to `(testId, codeVersion)` — after an AI fix bumps `codeVersion`, old fixtures stay around for run-history replay but the new version starts fresh (zero rows → single iteration). Verify by inspecting the history table: old version rows lose their **active** badge once `codeVersion` increases.
- The fixture history table never grows unbounded for a single version: re-uploading at the same `(testId, version)` is an upsert, not an append (`backend/src/database/repositories/testFixtureRepo.js`).
- `iterationCap` in [1, 100] is enforced at three layers: frontend input validation, route-level PATCH validation, and `clampIterationCap` at runtime — verify each by attempting a `9999` write via each path.

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
- Dynamic content (timestamps, ads) → **mask / ignore regions are NOT supported.** `diffScreenshot()` in `backend/src/runner/executeTest.js:343-349` is called with only `{ runId, testId, browser, stepNumber, pngBuffer }` — no mask, region, clip, or exclude params exist. Workaround: tune `VISUAL_DIFF_THRESHOLD` / `VISUAL_DIFF_PIXEL_TOLERANCE`, or stub the dynamic content in the test. Do not test for masking; file as enhancement if needed.
- Viewport size change between runs → diff behavior documented (pass/fail/warn) — confirm actual product behavior and note it in checklist.
- Concurrent baseline accept by two users → last-write-wins with audit trail.
- Very large images → no timeout, no memory crash.

---

### 📊 Dashboard

_(automated: smoke-level login → dashboard landing is covered in `tests/e2e/specs/ui-smoke.spec.mjs`; full widget/report assertions remain manual until dedicated dashboard UI coverage lands.)_

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

**Preconditions:** Workspace with tests/runs/projects data. Open `/chat` (Chat History page, `docs/changelog.md` #83).

**Steps & expected:**
1. Ask "How many tests failed this week?" → answer matches Runs page filtered count.
2. Ask "Show me the last failed run for project X" → returns correct run, links to run detail.
3. Ask about a specific test by name → returns accurate step count, last status, last run time.
4. Multi-turn: follow up with "why did it fail?" → uses prior context; answer references actual logs.
5. Ask for something outside scope ("what's the weather") → declines or redirects gracefully.

**Chat History page** (`/chat`, persisted in localStorage per user):
6. Create a new session → appears in sidebar.
7. Rename a session → name persists across reload.
8. Delete a session → removed from list, conversation gone.
9. Search across sessions → matching messages highlighted.
10. Export session as **Markdown** and as **JSON** from the topbar menu → both files download with full conversation.
11. Create > 50 sessions → oldest are evicted (cap is 50/user per `#83`); confirm no errors.
12. "Open full chat page" button in the AI Chat modal → navigates to `/chat`.
13. Sidebar nav → "AI Chat" entry visible and active when on `/chat`.

**AI provider switching** (`README.md`):
14. Header dropdown lists configured providers (Anthropic / OpenAI / Google / OpenRouter / Ollama). Switch with one click → next chat message uses the new provider; auto-detection order is Anthropic → OpenAI → Google → OpenRouter → Ollama.

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
   - **AI provider keys** — admin-only (`routes/settings.js:48, 53, 130`). Switching providers via the header dropdown should succeed in one click (`README.md`).
   - **Workspace members & roles** — admin-only (`routes/workspaces.js:134, 168, 196`). Roles: `admin` / `qa_lead` / `viewer`.
   - **Per-project notification settings** (Teams webhook / email recipients / generic webhook) — **`qa_lead` or admin** (`routes/projects.js:266`); at least one channel required (`backend/tests/account-compliance.test.js`).
   - **System info / Ollama status** — read-only diagnostics; available on Settings → System and `/system` page.
2. Invalid input (bad email, bad URL) → inline validation; save blocked.
3. Revoke/regenerate API key → old key returns 401 immediately; new key works.
4. Disconnect integration → subsequent features depending on it fail gracefully.

**Negative / edge:**
- `qa_lead` or `viewer` opens `/settings` page → 403 (route is `requiredRole="admin"`, `frontend/src/App.jsx:66`). Note: per-project notification edits are reachable from ProjectDetail, not `/settings`.
- Concurrent settings edits → last-write-wins with no lost fields.
- Save partial form (required field blank) → blocked, no partial persistence.

---

### 👤 Account / GDPR (Settings → Account)

**Preconditions:** Logged in. Open Settings → Account tab (`docs/changelog.md` SEC-003 #93).

**Steps & expected:**
1. **Export account data** — click Export, enter password → server validates via `X-Account-Password` header → JSON downloads containing workspaces, projects, tests, runs, activities, schedules, notification settings (`GET /api/auth/export`).
2. Wrong password on export → 401, no file.
3. **Delete account** — two-click confirm with **5s auto-disarm** (UI re-arms after 5s if not confirmed). Final confirm + password → `DELETE /api/auth/account` runs in a single transaction; user logged out; subsequent login fails with "account not found"; all owned workspace data is gone.
4. Wrong password on delete → 401, account intact.
5. Cancel mid-flow → no state change.

---

### 📧 Email Verification (extra cases)

Beyond the Authentication section (`docs/changelog.md` SEC-001 #87):
1. Register → verification email sent via Resend / SMTP / console fallback (depending on env).
2. Try to login **before** verifying → blocked with "verify your email" state on Login page; "Resend" button visible.
3. Click Resend → `POST /api/auth/resend-verification` returns the same response whether or not the address is registered (enumeration-safe). Rate limit applies (5–10/15min).
4. `GET /api/auth/verify?token=` with valid token → user marked verified; tampered/expired token → rejected.
5. Pre-existing users (created before SEC-001 migration 003) are grandfathered as verified — login works without verification.

---

### ♻️ Recycle Bin (Settings)

**Preconditions:** Soft-delete a project, a test, and a run (`docs/changelog.md` ENH-020). Settings → Recycle Bin.

**Steps & expected:**
1. `GET /api/recycle-bin` → returns soft-deleted entities grouped by type, capped at **200 items per type**.
2. Restore a test → `POST /api/restore/test/:id`; reappears in active list with steps intact.
3. Restore a project → cascades to tests/runs deleted **at the same time** as the project. Tests deleted **individually** earlier remain in the bin.
4. Purge a test → `DELETE /api/purge/test/:id`; gone from `GET /api/recycle-bin`; cannot be restored.
5. Viewer attempts restore/purge → blocked.

---

### 🧾 Audit Log

**Preconditions:** Multiple users acting in WS-1 (`docs/changelog.md` #78).

**Steps & expected:**
1. Each mutating action records `userId` + `userName` on the activity entry.
2. Bulk approve/reject/restore → emits **one activity per test**, each tagged with the acting user (not a single bulk row).
3. Filter audit log by user → only that user's actions visible.
4. Audit entries cannot be edited/deleted via UI.

---

### 🔔 Notifications

**Preconditions:** Notifications configured per project. Sentri supports exactly **three channels** (see `backend/src/utils/notifications.js` — `fireNotifications`):
- **Microsoft Teams** — Adaptive Card via incoming webhook.
- **Email** — HTML summary via `emailSender.js`.
- **Generic webhook** — POST JSON to user-configured URL.

Note: **Slack and in-app are NOT supported** — do not test them.

The settings API requires **at least one channel** to be enabled (confirmed by `backend/tests/account-compliance.test.js`: saving with all three blank returns 400).

**Delivery model** (`backend/src/utils/notifications.js:270-305`):
- Channels fire **simultaneously** via `Promise.allSettled(dispatches)` — no queue, no retry, no rate-limit.
- All errors are logged (`[notifications] X failed for runId: ...`) but **never propagated** — a failing notification cannot fail the run.
- Notifications fire **only when `run.failed > 0`** (`notifications.js:256-257`). Successful runs send nothing.

**Steps & expected (per channel):**
1. Trigger a failed run → each enabled channel receives one dispatch. Verify backend log line `[notifications] <channel> notification sent for <runId>`.
2. Notification payload includes: project, test name, run ID, failure reason, link to run detail.
3. Link in notification opens the correct run and requires auth.
4. Disable a channel → no notifications sent via that channel for subsequent runs.
5. Save settings with all three channels blank → API returns **400** ("At least one channel is required").
6. Successful run (no failures) → **no notification** sent on any channel (intentional, `notifications.js:256`).
7. Recovery notifications ("previously failed, now passes") are **not implemented** — do not test for them; file as enhancement if needed.

**Negative / edge:**
- Invalid / non-HTTPS webhook URL → channel call fails; backend log shows `[notifications] Webhook notification failed` warning; **other channels still deliver** (best-effort).
- Slow / hung channel → no timeout in code; the dispatch will wait on the underlying HTTP client default. Verify this does not stall run completion (the run completes regardless because dispatches are best-effort).
- Flood of failures (10+ failed runs in a minute) → **no batching, throttling, or dedup is implemented**. Each failed run sends one notification per enabled channel. File as enhancement if this floods Teams/email.
- User removed from workspace → stops receiving notifications because settings are workspace-scoped.
- Notification payloads contain no PII / secrets / tokens.

---

### 🔒 Security

**Preconditions:** Users A (`admin` WS-1), B (`qa_lead` WS-1), C (`viewer` WS-1), D (outsider, no membership). A owns project P1, test T1, run R1 in WS-1.

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
- Password reset uses DB-backed **atomic one-time claim** tokens (`README.md`, `docs/changelog.md`): reusing a claimed token → rejected; requesting a new token invalidates all prior unused **reset tokens** (`#78`).
- ⚠️ **There is no in-app "change password" endpoint** — only `forgot-password` + `reset-password` (`backend/src/routes/auth.js:687`). Password reset **does NOT invalidate active sessions on other devices** (no token version bump / refresh-token clear). Verify this: log in on browsers A and B → run reset flow on A → confirm B's session continues to work. File as `SEC` enhancement; do not log as a bug against the current build.

**Input / injection:**
- XSS probes in test names, project names, workspace names, chat messages, bug titles (`<script>alert(1)</script>`) → rendered as text, never executed.
- SQL-ish payloads in search/filter inputs → no 500; no data leakage.
- Upload malicious file types (`.exe`, oversized image) to recorder / baseline → rejected with clear error.
- CSRF: submit a state-changing request from a third-party origin → blocked.

**Secrets:**
- API keys never appear in URLs, logs, or client-side bundles.
- Notification payloads, chat responses, error messages contain no tokens or passwords.

---

### 📑 Reports (`/reports`) & PDF Export

**Preconditions:** Workspace with completed runs and approved tests.

**Steps & expected:**
1. Sidebar → **Reports** → `/reports` loads without console errors.
2. Verify the report views available (run summary, test status, defect breakdown, etc. — record the actual list shown).
3. Filter / date-range controls update report content; counts match Runs and Tests pages.
4. From **Dashboard**, click **Export PDF** (executive report) → PDF downloads.
5. Open the PDF → contains pass-rate, defect breakdown, recent activity, and matches on-screen Dashboard widgets.
6. CSV export from **Tests** page (full-detail with step rows, file `sentri-tests-YYYY-MM-DD.csv` per `frontend/src/pages/Tests.jsx:564`) → opens in spreadsheet, header row + per-step rows.

**Negative / edge:**
- Empty workspace → reports/PDF render empty states, no errors.
- Viewer can view reports but cannot trigger destructive actions from them.
- Very large dataset → PDF generation completes; no client crash.

---

### 🖥️ System Diagnostics (`/system`)

**Preconditions:** Logged in.

**Steps & expected:**
1. Sidebar → **System** → `/system` loads.
2. Verify the diagnostics surfaces (record what's shown — typically uptime, version, AI provider status, Ollama status, DB stats, queue stats, etc.).
3. Settings → **System** tab shows the same/related info from `sysInfo` (`frontend/src/pages/Settings.jsx`); both should agree.
4. `GET /health` returns `200 { ok: true, uptime, version }` (`backend/src/index.js:270-278`).
5. `GET /config` returns app config including `demoMode` flag and per-user demo quota (see Demo Mode section).

---

### 🆕 New Project Page (`/projects/new`)

**Preconditions:** `qa_lead` or `admin` logged in.

**Steps & expected:**
1. Projects → **New Project** → `/projects/new` loads (separate page, not a modal).
2. Fill name + URL + any optional fields → **Test connection** button probes the URL.
   - Locally, set `ALLOW_PRIVATE_URLS=true` to allow `http://localhost:<port>` (`docs/changelog.md`); off in prod.
3. Save → redirects to ProjectDetail; project appears in `/projects` list.
4. Submit invalid URL / SSRF payload (e.g. `file://`, `http://169.254.169.254/`) → blocked.
5. Submit duplicate name → handled with clear error.
6. Viewer attempts to open `/projects/new` → blocked / 403.

---

### 📋 Runs List (`/runs`)

**Preconditions:** Workspace with multiple runs in different states.

**Steps & expected:**
1. Sidebar → **Runs** → `/runs` loads with table/list of runs.
2. Filter by status (passed / failed / running / stopped) → list updates.
3. Filter by project → only that project's runs.
4. Click a row → navigates to `/runs/:runId` (RunDetail).
5. Sort by date / duration → ordering correct.
6. Pagination (if present) → next/prev pages load without losing filter state.

---

### 📁 Project Detail (`/projects/:id`)

**Preconditions:** Project with approved tests + at least one run.

**Steps & expected:**
1. Open a project → `/projects/:id` loads with project-scoped command center.
2. **Run regression** from this page → uses the project's defaults; opens RunRegressionModal.
3. **Review / approve / reject** tests scoped to this project (does not show other projects' tests).
4. **Export** Zephyr CSV / TestRail CSV / Traceability scoped to this project.
5. **⚡ Automation** quick-link → opens `/automation?project=<id>` with project pre-expanded.
6. Per-status counts widget reflects `GET /api/v1/projects/:id/tests/counts`.
7. Project-scoped **Notification settings** entry point visible to admin.

---

### ☑️ Bulk Actions & Keyboard Shortcuts

**Preconditions:** Tests page (`/tests`) with ≥ 5 tests in mixed statuses.

**Surface split (PR #7):** Bulk **approve / reject** moved to the **Review
Queue** page (`/review-queue`) — see [Review Queue](#-review-queue) for that
flow. The Tests page retains bulk **delete** only; review actions are
intentionally one-surface to keep approval state consistent across tab counts.

**Bulk actions on Tests page** (`POST /api/v1/projects/:id/tests/bulk` with
`action: "delete"`, see `backend/src/routes/tests.js`):
1. Select multiple tests via checkboxes → bulk bar appears showing "N selected" with **Delete** + **Clear selection** (`frontend/src/pages/Tests.jsx`). Approve / Reject buttons are NOT shown here — those live in Review Queue.
2. **Bulk delete** → soft-deletes selected tests into Recycle Bin; ≥ 2 selected → confirmation dialog. One audit-log entry per test, tagged with the acting user (`docs/changelog.md` #78).
3. **Bulk restore** (from Recycle Bin) → restores all selected.
4. Mixing roles: Viewer cannot use bulk actions → buttons hidden or 403.

**Bulk actions on Review Queue page** (`/review-queue`):
5. Select multiple drafts via the row checkboxes → bulk bar with **Approve N**, **Reject N**, **Clear** appears at the bottom of the list pane. Both approve and reject route through a styled `<ModalShell>` confirmation (no `window.confirm`).
6. **Bulk approve** → groups selection by `projectId` and fires `POST /tests/bulk` per project via `Promise.allSettled`; partial failures surface in an inline amber banner.
7. **Bulk reject** → same per-project grouping + confirmation flow.
8. After mutation: `invalidateReviewQueueCache()` busts the list, tab-count badges, and the per-status counts; `invalidateProjectDataCache()` busts shared project state on Dashboard / Reports.

**Keyboard shortcuts on Tests page** (`frontend/src/pages/Tests.jsx`):
9. `/` → focuses search input (when no input is focused).
10. `Esc` → clears selection.
11. Typing in inputs/textareas / contenteditable → shortcuts **must NOT** fire (verify `INPUT`/`TEXTAREA`/`isContentEditable` guard).
12. **`a` / `r` shortcuts removed** from the Tests page in PR #7 (they were tied to bulk approve/reject which moved). Use Review Queue for `a` approve / `r` reject.

**Keyboard shortcuts on Review Queue page** (`frontend/src/pages/ReviewQueue.jsx`):
13. `a` → approve the currently active draft (only fires on the **Draft** tab — gate matches the visible Approve button so a stray `a` on the Rejected tab cannot bypass the "rejected → draft → re-review" trust contract).
14. `r` → reject the currently active draft (suppressed on the **Rejected** tab; on the **Approved** tab it routes through the styled confirmation modal).
15. `j` / `↓` → next test; `k` / `↑` → previous test.
16. `Esc` → clear selection.
17. Same input-focus guard as Tests page — typing in the search input doesn't trigger shortcuts.

**Command palette** (`⌘K` / `Ctrl+K`):
18. Press `⌘K` (mac) or `Ctrl+K` (win/linux) → palette opens with navigation entries + AI chat entry.
19. Type a page name → fuzzy match; `Enter` navigates.
20. `Esc` closes the palette.

**Negative / edge:**
- Bulk action with 0 selected → action button disabled.
- Bulk action mid-run on the same tests → handled gracefully (queued or rejected with clear error).
- Refresh after partial bulk failure → state consistent (no half-applied bulk).
- Tests page bulk delete fired with `a` or `r` keypress → must be a no-op (those shortcuts no longer exist on this page).

---

### 🪟 Modals & full-page surfaces (Tests page)

**Preconditions:** Tests page open. Most legacy modals on the Tests page were
migrated to dedicated pages in PR #5 (Test Lab) and PR #7 (Review Queue) — the
remaining true modals are **Run Regression**, **Recorder**, and **AI Fix**.
The Tests page now exposes three quick-action **cards** (Test Lab / Review
Drafts / Run Tests, see `frontend/src/pages/Tests.jsx` quick-action grid)
that navigate to those surfaces; the legacy `CrawlProjectModal`,
`GenerateTestModal`, and `ReviewModal` no longer exist.

For each surface: open → fill → submit → close behavior.

| Surface | Trigger | Verify |
|---|---|---|
| **Test Lab — Crawl & Generate tab** (page) | Tests page "Test Lab" quick-action card → navigates to `/projects/:id/test-lab?tab=crawl` (or `/test-lab?tab=crawl` when no project is selected) | Project pre-selected via the route or the in-page sidebar; mode picker (Link Crawl / State Exploration); Coverage / Perspectives / Quality chip groups; Test Count + Profile selects; Start button kicks off the 8-stage SSE pipeline. **Output: UI / browser tests** (Draft) — `page.goto` + role selectors + `safeClick` / `safeFill`; same-origin fetch/XHR additionally yields API tests. Migrated from the legacy `CrawlProjectModal` (deleted in PR #5). |
| **Test Lab — Generate from Requirement tab** (page) | Tests page "Test Lab" quick-action card → switch to "Generate from Requirement" tab inside Test Lab | Project pre-selected via the route or sidebar; large requirement / user-story textarea; example prompts; Coverage + Quality chips. **Default output: UI / browser tests** from the supplied requirement plus crawl context. API-shaped inputs (plain-English endpoint, OpenAPI upload, HAR upload, `METHOD /path` paste) produce API tests only when explicitly used; submit creates Draft tests. Migrated from the legacy `GenerateTestModal` (deleted in PR #5). |
| **Review Queue** (page, not modal) | Tests page "Review Drafts" quick-action card → navigates to `/review-queue` (or `/review-queue?projectId=<id>` when a project is selected) | Two-pane page: left list (sort, search, category chips, multi-select); right detail pane (steps, generated code, quality score with factor-breakdown popover). Tab bar (Draft / Rejected / Approved) with live counts; keyboard shortcuts `a` approve / `r` reject / `j`/`k` navigate / `Esc` clear. Replaces the legacy `ReviewModal` (deleted in PR #7). See [Review Queue](#-review-queue) for the full flow. |
| **RunRegressionModal** | Tests page "Run Tests" quick-action card | Project picker, browser selector (Chromium/Firefox/WebKit), device dropdown, locale/timezone/geolocation (AUTO-007), network condition (`fast` / `slow3g` / `offline`, AUTO-006), parallelism 1–10; submit opens RunDetail. |
| **RecorderModal** | Test Lab page topbar "Record a test" button (red CTA) — Tests page no longer has its own Record button | Live CDP screencast; record/stop controls; on stop saves Draft and navigates to Test Detail. Project is taken from the Test Lab's currently-selected project. |
| **AiFixPanel** | "Fix with AI" on failed test (Test Detail) | SSE token stream; diff vs current code; Accept/Discard. |

**Common checks for every modal:**
- Click outside or `Esc` closes (only if no unsaved input — otherwise warns).
- Required fields validated inline; submit blocked with clear errors.
- Loading state shown during submission; double-click does not double-submit.

---

### 📤 API Test Imports (OpenAPI, HAR, plain-English API)

> Scope: this section covers **API test** generation paths only. UI / browser tests are generated from crawls and the Recorder — see [Tests Page §3](#-tests-page) and [Recorder](#-recorder).

**Preconditions:** Test Lab page open at `/projects/:id/test-lab?tab=requirement` (formerly the `GenerateTestModal`).

**Steps & expected:**
1. **OpenAPI import** — upload a valid OpenAPI 3.x spec → tests generated cover documented endpoints with status + JSON-shape assertions.
2. **HAR import** — upload a captured HAR file → tests generated for same-origin fetch/XHR calls in the HAR.
3. **Plain-English** — describe an endpoint ("POST /api/login expects 200 + token") → API test generated.
4. **`METHOD /path` patterns** — paste lines like `GET /api/users` → matching tests generated.

**Negative / edge:**
- Malformed OpenAPI / HAR → clear error, no crash.
- HAR with cross-origin / sensitive data → only same-origin requests included; auth headers stripped or masked in generated tests.
- Oversized HAR → rejected with size limit message.

---

### 🚀 Onboarding Tour ("Getting Started")

**Preconditions:** Fresh user OR Settings → "Restart Tour" clicked (`frontend/src/pages/Settings.jsx:1219-1243`).

**Steps & expected:**
1. First login → onboarding tour appears on `/dashboard`.
2. Tour walks through the primary surfaces (record what steps are shown).
3. Skip → tour dismissed; doesn't reappear on next login.
4. Settings → **Restart Tour** → page navigates to `/dashboard` and tour replays.
5. After restart, the previous "completed" state is cleared (verify via localStorage `onboarding` keys).

---

### 🎟️ Demo Mode & Per-User Quotas

**Preconditions:** Hosted deployment with `DEMO_GOOGLE_API_KEY` set (`docs/changelog.md` #94).

**Steps & expected:**
1. `GET /config` returns `{ demoMode: true, quota: { crawls, runs, generations } }`.
2. As a demo user (no own AI key), per-day quotas enforced: **2 crawls**, **3 runs**, **5 generations** (`demoQuota` middleware).
3. Hit each quota → next call returns 429 / "quota exceeded" with reset time.
4. Add own AI key (BYOK) → quotas bypass, `/config` reflects new state.
5. Counters use Redis when available, in-memory fallback otherwise — verify either by inspecting Redis or restarting backend (in-memory resets, Redis persists).

**Skip in self-hosted / unset env:** confirm `demoMode: false` and no quota headers in responses.

---

### ⚙️ Settings → Data tab (destructive admin actions)

**Preconditions:** Admin logged in. Settings → Data tab.

**Steps & expected:** (per `frontend/src/pages/Settings.jsx:1202-1213`)
1. **Clear Run History** — confirms intent → `api.clearRuns()` → all run records + logs/results gone; counts on Dashboard reset.
2. **Clear Activity Log** — `api.clearActivities()` → audit log empty.
3. **Clear Self-Healing History** — `api.clearHealing()` → next run starts the selector waterfall fresh (no remembered winners).
4. Counts displayed reflect current state (`sysInfo.runs`, `sysInfo.activities`, `sysInfo.healingEntries`).
5. Recycle Bin section also accessible from this tab — verify same behavior as `Recycle Bin` section above.

**Negative / edge:**
- Non-admin opens Settings → 403 (route is `requiredRole="admin"`, `frontend/src/App.jsx:66`).
- Clear actions show a confirmation step (no one-click destruction).
- Concurrent runs while clearing → in-flight runs handled gracefully (record observed behavior).

---

### 🔀 Workspace Switcher

**Preconditions:** User belongs to ≥ 2 workspaces.

**Steps & expected:**
1. Workspace switcher visible in sidebar/topbar.
2. Switch workspace → URL updates, all entity lists (projects/tests/runs/activity) scoped to the new workspace; no data leak from previous.
3. JWT carries `workspaceId` hint; role re-resolved from DB on every request (`docs/changelog.md` ACL-001/002 #88) → role change in DB takes effect within one request.
4. Direct API call with mismatched workspace ID → 403.

---

## 📱 Cross-Cutting Checks

Run these against the full browser matrix (Chrome, Firefox, Safari, Edge):

**Responsive / visual:**
- Mobile (375px), tablet (768px), desktop (1440px) — no broken layouts, no horizontal scroll, all buttons reachable.
- Dark mode — **automatic** via `prefers-color-scheme` (no manual toggle exists, `README.md:77`). Toggle the OS setting and reload; verify no illegible text, no white flashes, all icons visible.
- High-DPI / Retina — images crisp, no pixelation.

**State & navigation:**
- Refresh mid-flow on every page — no lost unsaved work without a warning; no broken state.
- Browser back / forward — URL and UI stay in sync; no stale modals.
- Open any page in a new tab via URL paste — loads correctly with auth.
- Deep-link to a run/test/project while logged out — redirected to login, then back to the target.

**Sidebar collapse / expand** (PR #1, `frontend/src/components/layout/Layout.jsx`, `frontend/src/components/layout/Sidebar.jsx`):
- Click the `PanelLeftClose` icon in the sidebar header → sidebar collapses to a 64px icon-only rail. Logo, workspace avatar, nav icons (with `title` tooltips), and Settings icon (admin only) remain visible. Active route shows the accent indicator.
- Click the logo or workspace avatar in the rail → sidebar expands back to 216px.
- Refresh any page → collapsed/expanded state persists via `localStorage` key `ui.sidebar.collapsed` (`Layout.jsx:21`). Clearing that key restores the default expanded state.
- Switch between pages while collapsed → main content fills the reclaimed horizontal space; no horizontal scroll.
- Workspace switcher dropdown is closed automatically on collapse (so it doesn't float into the main content area).
- Each rail nav item has a `title` attribute so hovering shows the page name (Dashboard, Projects, Tests, Runs, Reports, Automation, System, Settings).

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

> **Note:** "Deploy pages failing" and "image push failures" referenced in earlier drafts of this doc apply to the **CD GitHub Actions workflow** (`.github/workflows/cd.yml` — GitHub Pages + GHCR). They are **not user-facing flows** and are out of scope for manual QA. If they fail, escalate to engineering, do not log against a tester's session.

| Issue | Ticket | Repro | Workaround |
|---|---|---|---|
| Recorder empty-steps | ✅ Fixed in PR #118 — `filterEmittableActions` (`backend/src/runner/recorder.js:634-665`) drops ill-formed actions from both `steps[]` and `playwrightCode`. Locked down by a regression test in `backend/tests/recorder.test.js`. Leave the row here for one release as a verification reference. | Record a simple flow; verify `steps.length` equals the number of `// Step N:` comments in the Source tab. | n/a — should not reproduce. File a P1 bug if it does. |
| Visual diff false positives | _open_ | Re-run unchanged suite; check flagged steps | Tune `VISUAL_DIFF_THRESHOLD` / `VISUAL_DIFF_PIXEL_TOLERANCE` |

---

## 🐞 Bug Reporting Template

```
**Title:** [Area] Short description

**Severity:** Blocker / Critical / Major / Minor / Trivial
**Environment:** local / staging / preview — URL: ...
**Build / commit SHA:** ...
**Browser + version + OS:** e.g. Chrome 131 / macOS 14.6
**User role:** admin / qa_lead / viewer / outsider
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
| **Golden E2E Happy Path (all 51 steps)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| Authentication | ⬜ | ⬜ | ⬜ | ⬜ | |
| Email Verification | ⬜ | ⬜ | ⬜ | ⬜ | |
| Workspaces | ⬜ | ⬜ | ⬜ | ⬜ | |
| Projects | ⬜ | ⬜ | ⬜ | ⬜ | |
| Tests (crawl modes, generate, search, exports) | ⬜ | ⬜ | ⬜ | ⬜ | |
| **UI / Browser Test Generation (default output)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| API Test Generation (additional output) | ⬜ | ⬜ | ⬜ | ⬜ | |
| Recorder | ⬜ | ⬜ | ⬜ | ⬜ | |
| Runs (cross-browser, mobile, parallel, abort, self-heal) | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Review Queue (PR #7 — tabs, sort, search, bulk, keyboard, mobile, inbox-zero)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **AI Fix (manual + auto feedback loop)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Test Code Editing (Steps ↔ Source)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| Automation (trigger tokens + schedules) | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Quality Gates (AUTO-012 — CRUD, evaluator, trigger response)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Run comparison (AUTO-019 — Compare action, prior-run picker, summary + diff rows)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| Visual Testing | ⬜ | ⬜ | ⬜ | ⬜ | |
| Dashboard | ⬜ | ⬜ | ⬜ | ⬜ | |
| AI Chat + Chat History | ⬜ | ⬜ | ⬜ | ⬜ | |
| AI Provider switching | ⬜ | ⬜ | ⬜ | ⬜ | |
| Settings | ⬜ | ⬜ | ⬜ | ⬜ | |
| Account / GDPR (export, delete) | ⬜ | ⬜ | ⬜ | ⬜ | |
| Recycle Bin | ⬜ | ⬜ | ⬜ | ⬜ | |
| Audit Log | ⬜ | ⬜ | ⬜ | ⬜ | |
| Notifications | ⬜ | ⬜ | ⬜ | ⬜ | |
| Security | ⬜ | ⬜ | ⬜ | ⬜ | |
| Permissions matrix | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Reports + Dashboard PDF + CSV** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **System diagnostics (`/system` + Settings → System)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **New Project page (`/projects/new`)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Runs list (`/runs`)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Project Detail (`/projects/:id`)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Bulk actions + keyboard shortcuts + ⌘K palette** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Test Lab page (Crawl / Generate tabs)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Modals (Run / Review / Recorder / AiFix)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Imports (OpenAPI / HAR / API description)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Onboarding tour** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Demo mode + per-user quotas** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Settings → Data tab (destructive clears)** | ⬜ | ⬜ | ⬜ | ⬜ | |
| **Workspace switcher** | ⬜ | ⬜ | ⬜ | ⬜ | |
| Cross-cutting checks | ⬜ | ⬜ | ⬜ | ⬜ | |

> **Out of scope (not yet shipped):** MFA/2FA (`SEC-004`), public/shareable test report links, Jira integration, billing, CLI. Do not test these — file enhancement requests instead. The `/reports` page, Dashboard PDF export, standalone Playwright project export (`DIF-006`), and the embedded Playwright trace viewer (`DIF-005`, verified inline at Golden E2E step 31) **are** shipped and must be tested.

---

## ✅ Sign-off Criteria

A release is QA-approved only when **all** of the following are true:
- The **Golden E2E Happy Path** (51 steps) passes end-to-end on Chrome **and** at least one other browser from the matrix.
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
