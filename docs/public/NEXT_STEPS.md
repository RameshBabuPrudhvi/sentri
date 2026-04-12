# Sentri — Implementation Plan

> **Purpose:** This document tracks all known issues, improvement opportunities, and new features for Sentri. It consolidates findings from the full codebase audit, the Assrt MCP cross-reference analysis, and competitive research against autonomous QA platforms (Mabl, Testim, QA Wolf, Reflect).
>
> Each item includes the affected files, effort estimate, and the source of the finding so contributors know exactly where to start.

---

## How to use this document

- Items are grouped into **Sprints** by priority and dependency order.
- The **Effort** field is sized for a 2-engineer team: `XS` < 1 day, `S` 1–2 days, `M` 3–5 days, `L` 1–2 weeks, `XL` 2–4 weeks.
- The **Source** field cites where the finding came from: `Audit` (internal codebase review), `Assrt` (pattern adopted from Assrt MCP), or `Competitive` (gap vs. Mabl/Testim/QA Wolf/Reflect).
- Items marked `🔴 Blocker` must be resolved before any enterprise or team deployment.
- Items marked `🟡 High` should ship within the next two sprints.
- Items marked `🔵 Medium` improve quality and coverage.
- Items marked `🟢 Differentiator` build competitive moat and can be scheduled freely.

---

## ~~Sprint 1 — Security & Stability~~ ✅ Complete

All 6 items shipped: S1-01 (vm sandbox), S1-02 (HttpOnly cookies), S1-03 (SQLite), S1-04 (retry backoff), S1-05 (crash isolation), S1-06 (CORS restriction).

---

## Sprint 2 — CI/CD, Alerts & Scheduling (Weeks 4–6)

These features are required to compete with every major autonomous QA platform. Without them, Sentri cannot be integrated into any CI/CD pipeline and teams must poll the dashboard manually.

---

### S2-01 — Webhook trigger endpoint + GitHub Actions integration 🟡 High

**Problem:** Tests can only be triggered manually from the UI. There is no programmatic trigger, so Sentri cannot be called from GitHub Actions, GitLab CI, CircleCI, Jenkins, or any other pipeline.

**Fix:**
1. Add `POST /api/projects/:id/trigger` authenticated by a per-project secret token (stored hashed in the database, displayed once on creation).
2. The endpoint creates a run, starts test execution asynchronously, and returns `{ runId, statusUrl }` immediately.
3. Publish `sentri/run-tests` as a GitHub Action to the GitHub Marketplace. The action polls `/api/runs/:runId` until completion and sets a pass/fail exit code.
4. Add a **Trigger** tab to ProjectDetail showing the token, a copy button, and example YAML snippets for GitHub Actions, GitLab CI, and cURL.

**Files to change:**
- `backend/src/routes/runs.js` — add `POST /projects/:id/trigger`
- `backend/src/routes/settings.js` — add `POST/DELETE /projects/:id/trigger-token`
- `frontend/src/pages/ProjectDetail.jsx` — add Trigger tab
- `.github/actions/run-tests/` — new directory, GitHub Action definition

**Effort:** M | **Source:** Competitive

---

### S2-02 — Cron-based scheduled runs 🟡 High

**Problem:** There is no way to schedule automated runs. Teams cannot run nightly regressions without keeping a browser tab open.

**Fix:** Add a per-project schedule configuration (daily/weekly/custom cron expression) stored in the database. Use `node-cron` to fire scheduled runs as background jobs. Display the next scheduled run time in `ProjectHeader`. Add a schedule toggle to the project Settings tab.

**Files to change:**
- `backend/src/scheduler.js` — new file, `node-cron` job manager
- `backend/src/index.js` — initialise scheduler on startup
- `backend/src/routes/projects.js` — add `PATCH /projects/:id/schedule`
- `frontend/src/components/project/ProjectHeader.jsx` — show next run time
- `frontend/src/pages/Settings.jsx` (project settings section) — schedule config UI
- `backend/package.json` — add `node-cron`

**Effort:** M | **Source:** Competitive

---

### S2-03 — Failure notifications (Slack, email, webhook) 🟡 High

**Problem:** When a test run completes with failures there is no outbound notification. Teams must poll the dashboard. The README production checklist flags this as incomplete.

**Fix:** Add a per-project notification config: Slack incoming webhook URL, email recipients (via Resend or SendGrid), and a generic webhook URL. On run completion, if `run.failed > 0` or `run.status === "failed"`, fire all configured destinations. Slack payload should include pass/fail counts, failing test names, run duration, and a link to the run detail page.

**Files to change:**
- `backend/src/utils/notifications.js` — new file, Slack/email/webhook dispatch
- `backend/src/testRunner.js` — call `fireNotifications(run, project)` on completion
- `backend/src/routes/projects.js` — add notification config endpoints
- `frontend/src/pages/Settings.jsx` — notification config UI per project
- `backend/.env.example` — document `RESEND_API_KEY` / `SENDGRID_API_KEY`

**Effort:** M | **Source:** Competitive

---

## Sprint 3 — Quality, Coverage & Trust (Weeks 7–10)

These items directly improve the reliability and coverage of generated tests, and close the most visible gaps against competitors.

---

### ~~S3-02 — DOM stability wait (MutationObserver) before assertions~~ ✅ Complete

**Problem:** Sentri uses fixed-duration waits (`waitForTimeout`) and `waitForText` throughout the runner. Modern SPAs with loading states, streaming AI responses, skeleton screens, and async data fetches settle at variable times. Tests assert on partially-rendered pages and produce false failures.

**Fix:** Inject a `waitForStable(page, options)` helper that installs a MutationObserver, polls until `stableSec` seconds pass with no DOM mutations, then disconnects cleanly. Call this before assertion-heavy steps.

**Pattern from Assrt (`agent.ts`):**
```javascript
async function waitForStable(page, { timeoutSec = 30, stableSec = 2 } = {}) {
  await page.evaluate(() => {
    window.__sentri_mutations = 0;
    window.__sentri_observer = new MutationObserver(m => {
      window.__sentri_mutations += m.length;
    });
    window.__sentri_observer.observe(document.body, {
      childList: true, subtree: true, characterData: true
    });
  });
  const start = Date.now();
  let lastCount = -1, stableSince = Date.now();
  while (Date.now() - start < timeoutSec * 1000) {
    await new Promise(r => setTimeout(r, 500));
    const count = await page.evaluate(() => window.__sentri_mutations);
    if (count !== lastCount) { lastCount = count; stableSince = Date.now(); }
    else if (Date.now() - stableSince >= stableSec * 1000) break;
  }
  await page.evaluate(() => {
    window.__sentri_observer?.disconnect();
    delete window.__sentri_mutations;
    delete window.__sentri_observer;
  });
}
```

**Files to change:**
- `backend/src/runner/pageCapture.js` — add `waitForStable(page, opts)` export
- `backend/src/runner/executeTest.js` — call `waitForStable` before assertion-heavy step groups
- `backend/src/pipeline/assertionEnhancer.js` — inject `waitForStable` step before enhanced assertions

**Effort:** S | **Source:** Assrt

---

### ~~S3-04 — Shadow DOM and web component support in crawl~~ ✅ Complete

**Problem:** `backend/src/pipeline/elementFilter.js` has no logic to pierce shadow roots. Modern enterprise applications built with Angular, Lit, Stencil, Salesforce LWC, or any shadow-DOM-based component library are largely invisible to the crawler. The generated test suites for these apps are thin or empty.

**Fix:** During the crawl browser session, inject a `queryShadowAll(selector)` helper that recursively traverses shadow roots. Update `elementFilter.js` to call this alongside the standard `page.$$()` query. For self-healing, add a `pierce:` selector strategy to the waterfall in `selfHealing.js`.

**Files to change:**
- `backend/src/pipeline/elementFilter.js` — add shadow DOM traversal
- `backend/src/pipeline/crawlBrowser.js` — inject `queryShadowAll` helper script
- `backend/src/selfHealing.js` — add `pierce:` selector strategy to waterfall

**Effort:** M | **Source:** Audit (competitive gap)

---

### ~~S3-08 — Disposable email support for auth flow testing~~ ✅ Complete

**Problem:** Sentri can crawl and discover auth flows but cannot complete registration flows that require email verification. Tests for signup, password reset, and email-gated onboarding are either skipped or left as stubs.

**Fix:** Add a `DisposableEmail` utility module (adapted from Assrt's `email.ts`) using the temp-mail.io API. Expose it as a credential provider in `stateExplorer.js` — when the explorer encounters a signup form, it can create a temp email, fill the form, wait for the OTP, and complete the flow. Handle split OTP input fields via clipboard paste.

**Files to change:**
- `backend/src/utils/disposableEmail.js` — new file, temp-mail.io client + OTP extraction
- `backend/src/pipeline/stateExplorer.js` — integrate temp email into form-filling logic
- `backend/src/pipeline/actionDiscovery.js` — detect signup/registration form intent

**Effort:** S | **Source:** Assrt

---

## Sprint 4 — Platform Moat (Weeks 11–16)

These items build the features that separate Sentri from all other QA tools and justify it as a long-term platform investment.

---

### S4-01 — Organisations and team RBAC 🟡 High

**Problem:** All projects and users share one flat namespace. There is no organisation, workspace, or team scoping. Any authenticated user can list all tests and projects via `GET /api/tests`. This is a hard blocker for any enterprise sale or multi-team deployment.

**Fix:**
1. Add an `organisations` table and an `org_id` foreign key to `projects`, `tests`, `runs`, and `activities`.
2. Add `role` to the `users` table: `owner`, `admin`, `editor`, `viewer`.
3. All route handlers must filter by `req.user.orgId`.
4. Add organisation creation to the onboarding flow.
5. Add a Members page under Settings for invite, role assignment, and removal.

**Files to change:**
- `backend/src/database/schema.sql` — add `organisations`, `org_members` tables
- `backend/src/database/repositories/orgRepo.js` — new repository module
- `backend/src/routes/auth.js` — include `orgId` in JWT claims
- `backend/src/middleware/appSetup.js` — add `requireRole(role)` middleware
- All route files — scope all queries to `orgId`
- `frontend/src/pages/Settings.jsx` — add Members tab
- `frontend/src/context/AuthContext.jsx` — expose `org` and `role` to the app

**Effort:** XL | **Source:** Competitive

---

### S4-02 — Visual regression testing with baseline diffing 🟢 Differentiator

**Problem:** Sentri detects functional failures (wrong text, broken navigation, missing elements) but not visual regressions (layout shifts, colour changes, component positioning). Competitors including Mabl and Reflect offer visual diffing natively.

**Fix:** On the first approved run for a test, capture a full-page screenshot as the baseline (stored in `data/baselines/<testId>/step-<N>.png`). On subsequent runs, diff against the baseline using `pixelmatch`. Flag any region with pixel difference above a configurable threshold (`VISUAL_DIFF_THRESHOLD`, default 2%). Surface the diff overlay in `StepResultsView.jsx` as a togglable before/after view.

**Files to change:**
- `backend/src/runner/executeTest.js` — capture and store baseline, run diff
- `backend/src/runner/visualDiff.js` — new file, `pixelmatch` wrapper
- `backend/src/routes/runs.js` — serve diff images via a signed URL
- `frontend/src/components/StepResultsView.jsx` — add visual diff overlay component
- `backend/package.json` — add `pixelmatch`, `pngjs`

**Effort:** L | **Source:** Competitive

---

### S4-03 — Standalone Playwright export (zero vendor lock-in) 🟢 Differentiator

**Problem:** The biggest objection to AI QA tools is vendor lock-in. Teams want to know they can eject if needed. QA Wolf already offers this — Sentri does not have a comparable export story (tests are viewable in the UI but not independently runnable).

**Fix:** Add a `GET /api/projects/:id/export/playwright` endpoint that generates a zip containing:
- `playwright.config.ts` pre-configured with the project URL and test runner settings
- One `.spec.ts` file per approved test, with the generated Playwright code wrapped in a proper `test()` block
- A `README.md` with `npx playwright install && npx playwright test` instructions

**Files to change:**
- `backend/src/utils/exportFormats.js` — add `buildPlaywrightZip(project, tests)` function
- `backend/src/routes/tests.js` — add `GET /projects/:id/export/playwright`
- `frontend/src/pages/Tests.jsx` — add "Export as Playwright project" button

**Effort:** M | **Source:** Competitive

---

### S4-04 — Conversational test editor wired to /chat 🟢 Differentiator

**Problem:** The `/chat` route and `LLMStreamPanel` component exist but are not connected to specific tests. Users who want to modify a test must edit the Playwright code directly. Natural-language test editing — "add an assertion that the cart total updates" — is a significant UX differentiator that no other platform has.

**Fix:** In `TestDetail.jsx`, add an "Edit with AI" panel that opens a chat thread pre-seeded with the test's current Playwright code. The AI response proposes a code change. Show a Myers diff of old vs. new code. One-click "Apply" patches the code and saves.

**Files to change:**
- `frontend/src/pages/TestDetail.jsx` — add AI edit panel with inline diff view
- `backend/src/routes/chat.js` — add test-context mode with code diff response format

**Effort:** M | **Source:** Competitive

---

### S4-05 — Jira / Linear issue sync 🟢 Differentiator

**Problem:** The traceability data model already stores `linkedIssueKey` and `tags` per test, but there is no outbound sync. When a test fails, no ticket is automatically created. Engineers must manually correlate test failures to issues.

**Fix:**
1. Add `POST /api/integrations/jira` and `POST /api/integrations/linear` settings endpoints to store OAuth tokens and workspace config.
2. On test run failure, auto-create a bug ticket (with screenshot, error message, and Playwright trace attached) via the Jira/Linear API.
3. Sync the test pass/fail status back to the linked issue's status field.
4. Add a Integrations tab to Settings.

**Files to change:**
- `backend/src/utils/integrations.js` — new file, Jira and Linear API clients
- `backend/src/testRunner.js` — call `syncFailureToIssue(test, run)` on completion
- `backend/src/routes/settings.js` — add integration config endpoints
- `frontend/src/pages/Settings.jsx` — add Integrations tab

**Effort:** L | **Source:** Competitive

---

### S4-06 — Autonomous monitoring mode (always-on QA agent) 🟢 Differentiator

**Problem:** Sentri is currently a triggered tool — it runs when instructed. The brand promise of "autonomous QA" implies it should also watch production continuously. No competitor outside enterprise tiers offers this for self-hosted deployments.

**Fix:** Add a monitoring mode per project: run a configurable set of "smoke tests" on a schedule against the production URL. On failure, auto-trigger a re-run to distinguish a real regression from a transient flake (2 consecutive failures = real). Fire notifications (S2-03) on confirmed failures. Display a "Monitor" badge on the dashboard for projects in monitoring mode.

**Files to change:**
- `backend/src/scheduler.js` — add monitoring job type alongside scheduled runs
- `backend/src/routes/projects.js` — add `PATCH /projects/:id/monitor`
- `frontend/src/pages/Dashboard.jsx` — add monitoring status indicators
- `frontend/src/pages/ProjectDetail.jsx` — add monitoring config panel

**Effort:** M | **Source:** Competitive

---

### S4-07 — Anonymous usage telemetry with opt-out 🔵 Medium

**Problem:** Sentri has zero telemetry — the team has no visibility into feature usage, crawl success rates, model performance comparisons, or error frequency. This makes data-driven prioritisation impossible.

**Fix:** Add a PostHog telemetry module (adapted from Assrt's `telemetry.ts`). Track: crawl start/complete/fail, run start/complete/fail, test generation counts, provider used, test approval/rejection rate, healing events. Respect `DO_NOT_TRACK=1` and `SENTRI_TELEMETRY=0`. Hash machine IDs. Never log full URLs — domain only. Deduplicates daily events via a local file cache.

**Files to change:**
- `backend/src/utils/telemetry.js` — new file, PostHog wrapper with opt-out
- `backend/src/crawler.js` — instrument crawl events
- `backend/src/testRunner.js` — instrument run events
- `backend/.env.example` — document `SENTRI_TELEMETRY=0`
- `backend/package.json` — add `posthog-node`

**Effort:** S | **Source:** Assrt

---

### S4-08 — Multi-auth profile support per project 🟢 Differentiator

**Problem:** Sentri stores credentials per-project but only supports a single auth profile. Testing role-based access control — "admin sees this, viewer does not" — requires running the same test suite under different identities. No other self-hosted QA tool supports this.

**Fix:** Add named credential profiles (e.g., "admin", "viewer", "guest") per project, each with a separate username/password or cookie payload. The Test Dials already have a `multi_role` perspective option — wire it to actually run under each profile. Surface per-profile result columns in the run detail view.

**Files to change:**
- `backend/src/utils/credentialEncryption.js` — extend to support multiple named profiles
- `backend/src/routes/projects.js` — add profile CRUD endpoints
- `backend/src/pipeline/stateExplorer.js` — accept `profileId` param
- `frontend/src/pages/ProjectDetail.jsx` — add credential profiles panel
- `frontend/src/components/TestDials.jsx` — connect `multi_role` dial to profile selector

**Effort:** M | **Source:** Competitive (unique to Sentri)

---

### S4-09 — Coverage heatmap on site graph 🟢 Differentiator

**Problem:** The site graph shows crawled pages but gives no signal about which pages have test coverage. Teams cannot easily identify coverage gaps from the visual.

**Fix:** For each node in the site graph (`SiteGraph.jsx`), compute a "test density" score: 0 approved tests = red, 1–2 = amber, 3+ = green. Overlay the score as a coloured ring on each node. Add a legend. This makes gaps immediately visible without reading a table.

**Files to change:**
- `frontend/src/components/SiteGraph.jsx` — add density score computation and colour ring
- `backend/src/routes/dashboard.js` — add `testsByUrl` to the dashboard API response

**Effort:** S | **Source:** Competitive

---

## Ongoing / Maintenance

These items are not sprint-bounded — they should be addressed incrementally alongside feature work.

---

### M-01 — Replace revoked token Map with Redis

**Problem:** `backend/src/routes/auth.js` stores revoked JWTs in an in-memory Map. This means tokens are not truly revoked across process restarts or multiple instances. Now that SQLite is in place (S1-03 ✅), once Redis is available for BullMQ, move the revocation store there.

**Files:** `backend/src/routes/auth.js` | **Effort:** XS | **Source:** Audit

---

### M-02 — Add BullMQ job queue for crawl/run jobs

**Problem:** Crawl and run jobs execute directly in the Express request handler thread. A long crawl blocks Node's event loop. After the SQLite migration (S1-03), move jobs to BullMQ + Redis for proper background processing, retry, and visibility.

**Files:** `backend/src/routes/runs.js`, new `backend/src/workers/` directory | **Effort:** L | **Source:** Audit

---

### M-03 — Store screenshots and videos to S3/R2

**Problem:** Screenshots, videos, and traces are stored on local disk (`data/screenshots/`, `data/videos/`). In a multi-instance or Docker deployment, these are lost on container restart and cannot be shared across instances.

**Files:** `backend/src/runner/pageCapture.js`, `backend/src/runner/screencast.js` | **Effort:** M | **Source:** Audit

---

### M-04 — Add cursor overlay to live browser view

**Problem:** Sentri's live CDP screencast shows the browser but gives no visual indication of what the test is currently doing. Viewers cannot tell which element is about to be clicked.

**Fix:** Port Assrt's `CURSOR_INJECT_SCRIPT` (animated cursor dot, click ripple, keystroke toast) into Sentri's runner. Inject via `page.evaluate()` after each navigation.

**Files:** `backend/src/runner/executeTest.js`, `backend/src/runner/pageCapture.js` | **Effort:** S | **Source:** Assrt

---

### M-05 — Semantic deduplication using embedding similarity

**Problem:** `backend/src/pipeline/deduplicator.js` uses exact string matching on test name + description. Renamed tests or slightly rephrased duplicates are not caught. Large test suites accumulate near-duplicate tests over time.

**Files:** `backend/src/pipeline/deduplicator.js` | **Effort:** M | **Source:** Audit

---

### M-06 — Restructure frontend to feature-sliced architecture 🟡 High

**Problem:** `frontend/src/components/` is a flat directory of ~35 files with no domain grouping. Run-execution views (`CrawlView`, `GenerateView`, `TestRunView`, `StepResultsView`, `LiveBrowserView`, `RunSidebar`, `ExecutionTimeline`, `PipelineCard`, `LLMStreamPanel`, `ActivityLogCard`), modals (`GenerateTestModal`, `CrawlProjectModal`, `RunRegressionModal`, `DeleteProjectModal`), charts (`PassFailChart`, `SparklineChart`, `StackedBar`, `PassRateBar`, `StatCard`), badges (`TestBadges`, `StatusBadge`, `AgentTag`), and layout chrome (`CommandPalette`, `ProviderBadge`, `OnboardingTour`) are all siblings. This makes the codebase hard to navigate, slows onboarding, and violates the principle of colocation by domain.

**Note:** PR #70 already extracted `Sidebar`, `TopBar`, and `ThemeToggle` into `components/layout/`. This item completes the restructuring.

**Target structure (Feature-Sliced / Domain-Grouped):**

```
frontend/src/
├── app/                          # App shell — wiring only
│   ├── App.jsx                   # Router + Suspense boundaries
│   ├── routes.jsx                # Route definitions (extract from App.jsx)
│   └── providers/
│       └── AuthProvider.jsx      # Renamed from context/AuthContext.jsx
│
├── api/                          # API layer — split monolithic api.js
│   ├── client.js                 # Base fetch wrapper (timeout, CSRF, 401 handling)
│   ├── auth.js                   # Auth endpoints
│   ├── projects.js               # Project CRUD + crawl/run triggers
│   ├── tests.js                  # Test CRUD + review actions + export URLs
│   ├── runs.js                   # Run endpoints
│   └── reports.js                # Dashboard + reports
│
├── components/                   # Shared, domain-agnostic UI primitives
│   ├── ui/                       # Atomic components
│   │   ├── Tooltip.jsx
│   │   ├── Collapsible.jsx
│   │   ├── ModalShell.jsx
│   │   ├── OutcomeBanner.jsx
│   │   └── ExploreModePicker.jsx
│   ├── charts/                   # Reusable data visualisation
│   │   ├── PassFailChart.jsx
│   │   ├── SparklineChart.jsx
│   │   ├── StackedBar.jsx
│   │   ├── PassRateBar.jsx
│   │   └── StatCard.jsx
│   ├── badges/                   # Status indicators
│   │   ├── TestBadges.jsx
│   │   ├── StatusBadge.jsx
│   │   └── AgentTag.jsx
│   └── layout/                   # App shell chrome (already started in PR #70)
│       ├── Layout.jsx
│       ├── Sidebar.jsx
│       ├── TopBar.jsx
│       ├── ThemeToggle.jsx
│       ├── AppLogo.jsx
│       ├── ProtectedRoute.jsx
│       ├── CommandPalette.jsx
│       ├── ProviderBadge.jsx
│       └── OnboardingTour.jsx
│
├── features/                     # Domain features — each owns pages + components + hooks
│   ├── auth/
│   │   ├── pages/
│   │   │   ├── Login.jsx
│   │   │   └── ForgotPassword.jsx
│   │   └── hooks/
│   │       └── useAuth.js
│   ├── dashboard/
│   │   ├── pages/
│   │   │   └── Dashboard.jsx
│   │   └── components/
│   │       └── TestDials.jsx
│   ├── projects/
│   │   ├── pages/
│   │   │   ├── Applications.jsx
│   │   │   ├── ProjectDetail.jsx
│   │   │   └── NewProject.jsx
│   │   ├── components/
│   │   │   ├── ProjectHeader.jsx
│   │   │   ├── RunsTab.jsx
│   │   │   ├── TraceabilityTab.jsx
│   │   │   ├── ActiveRunBanner.jsx
│   │   │   ├── RunToast.jsx
│   │   │   ├── CrawlProjectModal.jsx
│   │   │   └── DeleteProjectModal.jsx
│   │   └── hooks/
│   │       ├── useProjectData.js
│   │       └── useProjectRunMonitor.js
│   ├── tests/
│   │   ├── pages/
│   │   │   ├── Tests.jsx
│   │   │   └── TestDetail.jsx
│   │   ├── components/
│   │   │   ├── GenerateTestModal.jsx
│   │   │   ├── DiffView.jsx
│   │   │   └── AiFixPanel.jsx
│   │   └── hooks/
│   ├── runs/
│   │   ├── pages/
│   │   │   ├── Runs.jsx
│   │   │   └── RunDetail.jsx
│   │   ├── components/
│   │   │   ├── CrawlView.jsx
│   │   │   ├── GenerateView.jsx
│   │   │   ├── TestRunView.jsx
│   │   │   ├── StepResultsView.jsx
│   │   │   ├── LiveBrowserView.jsx
│   │   │   ├── OverlayCanvas.jsx
│   │   │   ├── HealingTimeline.jsx
│   │   │   ├── RunSidebar.jsx
│   │   │   ├── ExecutionTimeline.jsx
│   │   │   ├── PipelineCard.jsx
│   │   │   ├── LLMStreamPanel.jsx
│   │   │   ├── GenerationSuccessBanner.jsx
│   │   │   ├── ActivityLogCard.jsx
│   │   │   ├── SiteGraph.jsx
│   │   │   └── RunRegressionModal.jsx
│   │   └── hooks/
│   │       ├── useRunSSE.js
│   │       └── useLogBuffer.js
│   ├── reports/
│   │   └── pages/
│   │       └── Reports.jsx
│   ├── settings/
│   │   └── pages/
│   │       └── Settings.jsx
│   ├── context/                  # "System Context" feature
│   │   └── pages/
│   │       └── Context.jsx
│   └── ai/                       # AI chat / assistant
│       └── components/
│           └── AIChat.jsx
│
├── hooks/                        # Truly global hooks (not feature-specific)
│   ├── usePageTitle.js
│   └── useOnboarding.js
│
├── utils/                        # Pure utility functions (no React)
│   ├── apiBase.js
│   ├── csrf.js
│   ├── fuzzyMatch.js
│   ├── formatTestName.js
│   ├── testTypeLabels.js
│   ├── exportCsv.js
│   ├── formatters.js
│   └── pdfReportGenerator.js
│
└── styles/                       # Keep existing ITCSS — already well-organised
    ├── tokens.css
    ├── reset.css
    ├── components.css
    ├── utilities.css
    ├── features/
    └── pages/
```

**Key principles:**

1. **Feature-sliced colocation** — each domain (`projects`, `tests`, `runs`, `auth`) owns its pages, components, and hooks together. When working on "runs", everything needed is in `features/runs/`.
2. **Shared components split by concern** — `components/ui/`, `charts/`, `badges/`, `layout/` instead of 35 files flat. Rule: if used by 2+ features → `components/`. If used by one feature → `features/<that-feature>/components/`.
3. **Split monolithic `api.js`** — the current ~380-line file covers auth, projects, tests, runs, reports, settings, chat, and SSE. Split into domain modules under `api/` with a shared `client.js` base.
4. **`app/` for wiring** — `App.jsx`, route definitions, and global providers are app-level concerns, not features.
5. **Keep ITCSS styles as-is** — the `styles/` directory is already well-layered; no change needed.

**Migration strategy:** Move files incrementally (one feature at a time), updating imports as you go. Start with `runs/` (largest cluster, 15+ components) then `projects/`, `tests/`, `auth/`. Use IDE "move file + update imports" refactoring. Each feature migration is a single PR.

**Files to change:** All `frontend/src/components/*.jsx`, `frontend/src/pages/*.jsx`, `frontend/src/hooks/*.js`, `frontend/src/api.js`, `frontend/src/App.jsx`, `frontend/src/context/AuthContext.jsx`

**Effort:** L (incremental — 1 PR per feature domain) | **Source:** Audit

---

## Summary

| Sprint | Items | Key deliverable |
|--------|-------|----------------|
| ~~Sprint 1~~ | ~~S1-01 through S1-06~~ | ✅ Complete — production-safe |
| Sprint 2 (Weeks 4–6) | S2-01 through S2-03 | CI/CD integration, scheduling, alerts |
| Sprint 3 (Weeks 7–10) | S3-02, S3-04, S3-08 | Test quality, coverage, trust loop |
| Sprint 4 (Weeks 11–16) | S4-01 through S4-09 | Org/team, visual regression, export, monitoring |
| Ongoing | M-01 through M-06 | Infrastructure hardening + frontend restructuring |

**Remaining items:** 17  
**Critical blockers (must ship before team use):** None — all Sprint 1 items complete  
**Highest competitive impact:** S2-01, S4-01, S4-03, S4-06  
**Lowest effort / highest value (remaining quick wins):** S3-02, S4-09

---

## Contributing

Before starting any item:
1. Open a GitHub Issue referencing the item ID (e.g., `S1-01`)
2. Assign yourself in the issue
3. Create a branch named `feat/S1-01-sandbox-code-execution` or `fix/S1-03-sqlite-migration`
4. Reference the issue in your PR description

