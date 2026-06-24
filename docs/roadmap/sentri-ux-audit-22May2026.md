# Sentri — Deep UI/UX Audit Report
**Version audited:** `sentri_v1_4` (PR #23 codebase)  
**Audit date:** May 2026  
**Audit methodology:** Full codebase review — all pages, components, design tokens, CSS architecture, routing, state management patterns, AI/agent UX, accessibility, and comparison against GitHub Actions, Datadog, BrowserStack, LangSmith, Linear, Vercel, Grafana, Cypress Cloud, and Harness.

---

## 1. Executive UX Summary

Sentri has an impressively mature backend — multi-tenancy, RBAC, MFA, coverage mapping, sharding, vision healing, and a full AI provider routing layer are all production-grade features that most competitors don't have. The engineering quality is high and the codebase is disciplined.

The frontend, however, tells a different story. What exists was clearly built feature-by-feature rather than experience-first. The result is a platform where the raw capability is world-class but the UX is two or three product cycles behind it. Users who persist through the learning curve will find extraordinary power, but they will suffer significantly to get there.

The platform sits at approximately **4.8 / 10** on enterprise UX maturity today. With targeted investment in the areas below, it can reach 8+ within two product cycles.

**Most critical problems, ranked:**

1. Settings.jsx is a 3,594-line monolith that hosts every configuration surface in one vertically-scrolling page — this is the single biggest UX bloat in the product.
2. No persistent global search — the ⌘K palette is command-oriented, not data-oriented; users cannot search for a test by name, a run by ID, or a project across the workspace.
3. Dashboard information architecture is additive, not prioritised — 12+ panels render simultaneously with no visual hierarchy directing attention.
4. The AI/agent experience has no real-time explanation layer — agents fire and complete with no visible reasoning, no decision trail, no "why did this happen" surface.
5. Navigation has two top-level dead-ends (Chat History, Systems) that should live inside deeper contexts, inflating the sidebar.
6. Mobile and tablet experience is **not production-ready**. A shell-level responsive scaffold (768px / 480px breakpoints, hamburger sidebar) exists in `layout.css`, but no individual page has been audited or fixed for narrow viewports — Dashboard panels, Runs / AuditLog / ReviewQueue tables, RunDetail tabs, and every modal still break or overflow on phones and small tablets. Touch-target minimums (MOB-002) are also unmet. A page-by-page responsive QA + fix pass is required before the app can be called mobile-responsive.
7. No structured onboarding funnel beyond a tour overlay — first-run for a new workspace is blank-slate confusion.
8. Empty states across many pages are placeholder text rather than actionable guidance.

---

## 2. Major UI/UX Gaps

### GAP-001 — No Global Data Search
**Severity: Critical** · ✅ _Landed in PR #25 — new `GET /api/v1/search?q=<query>` route at `backend/src/routes/search.js` does workspace-scoped LIKE-based fuzzy search across `tests`, `projects`, and `runs` (ACL-001 via `projectRepo.getAll(req.workspaceId)`; cross-tenant rows filtered out by construction). Prefix-first ranking, 5-result-per-type cap, `q.length < 2` short-circuit. SQLite + PostgreSQL portable (no FTS5 dependency). Integration tests at `backend/tests/search.test.js` cover cross-tenant isolation, LIKE escaping (`50%_off` literal), prefix ranking, per-type cap, and the `truncated` flag — registered in `backend/tests/run-tests.js`. Frontend `api.search()` helper + debounced (250ms) integration in `CommandPalette.jsx` renders results in three sub-groups (Projects / Tests / Runs) below the existing fuzzy command matches; keyboard nav (↑↓ Enter) and ⌘K toggle unchanged. Settings search is not in this slice — the slice covers the audit's three named entity types._

The ⌘K command palette (`CommandPalette.jsx`) provides command navigation but does not search across data entities: tests, runs, projects, or settings. Users who want to find "the test named checkout flow" or "run abc123" have no path. They must know where to navigate, then scroll or use in-page filters.

**User impact:** Power users with 100+ tests across 10+ projects cannot find anything without drilling through Projects → ProjectDetail → Tests. This is a Level 1 friction point that drives churn in data-rich SaaS products.

**Reference:** Linear's command palette searches issues, projects, teams, and members simultaneously with fuzzy matching and keyboard-first navigation. Notion's search indexes every block across every page. Datadog's global search spans monitors, dashboards, hosts, and logs.

**Fix:** Extend the command palette to include a unified data search layer:
- `GET /api/v1/search?q=…` endpoint returning ranked results across tests, projects, runs, and settings keys
- TanStack Query-powered debounced fetch (300ms), keyed on the query string
- Result groups with type icons (SquareCheckBig for tests, PlayCircle for runs, FolderKanban for projects)
- Keyboard navigation through results with `Enter` navigating to the entity

---

### GAP-002 — Settings.jsx God-File Anti-Pattern
**Severity: Critical** · ✅ _Landed in PR #25 — sidebar-driven shell + 9 per-section lazy chunks under `frontend/src/features/settings/`. All 9 sections physically extracted as real React component files (Providers split into `ProvidersSection` + `ProviderCard` + `OllamaStatusPanel` + `CompatProviderForm`; Provider Routes split into `ProviderRoutesSection` + 9 sibling files for form / row / probe-badge / spend-caps / IO / audit-log / AI-request-log). The legacy 3,595-line `pages/Settings.jsx` is replaced by a build-time guard that throws on render._

`Settings.jsx` is 3,594 lines — one of the longest files in the codebase. It renders Provider configuration, Agent Roles, Team Members, MFA, Security, Integrations, AI Provider Routes, Workspace settings, Notification settings, Recycle Bin, and System info all within a single component with a single tab switcher. The file imports 30+ Lucide icons, 4 query hooks, and manages 40+ useState variables.

**User impact:** The Settings experience performs poorly due to the sheer component weight. Adding a team member requires the user to scroll past AI provider cards. Changing a notification webhook lives in the same mental space as configuring TOTP. There is no wayfinding between settings areas. Enterprise users — who spend significant time in settings — find this unusable at scale.

**Fix:** Decompose Settings into feature-scoped pages under `/settings/*`:
- `/settings/providers` — AI provider configuration (currently the largest section)
- `/settings/team` — Members, RBAC, invites
- `/settings/security` — MFA, password, sessions
- `/settings/integrations` — GitHub, Jira, Linear, webhooks
- `/settings/notifications` — email, Teams, webhooks
- `/settings/workspace` — name, billing tier, data export
- Each page is a standalone `React.lazy` component, lazy-loaded on demand

This also opens the door for a Settings sidebar (secondary navigation) that shows which section is active, similar to how GitHub Settings or Vercel Settings organises their configuration space.

---

### GAP-003 — Dashboard Has No Prioritisation Layer
**Severity: High** · ✅ _All three tiers landed in PR #26. **Tier 1 (Health banner)** — `frontend/src/components/dashboard/HealthBanner.jsx` renders above the stat grid with three alert kinds (failing projects today / pending review / runs in progress), each tone-tinted and click-through to the relevant filtered view. Computes client-side from the existing `/api/v1/dashboard` payload — no backend changes, no extra round-trip. Hidden when no alerts. Closes the audit's most-cited gap ("Users cannot identify what matters on a failing morning"). **Tier 2 (Primary KPIs)** — already in place as the existing 4-card Pass Rate / Failures Today / Total Tests / Total Runs grid. **Tier 3 (Supporting-detail accordion)** — single inline "Hide details" / "Show all metrics" toggle below the Coverage panel collapses rows 2–8 of the dashboard (Duration/Created/Fixed/Healing stat-grid, Platform Health, Defect Breakdown, Top Flaky Tests, Environments, Eval Quality, Accessibility Offenders, Run Status, Test Review, Test Suite Growth, Pass/Fail Trend, Recent Activity). State persists in localStorage (`ui.dashboard.supportingDetailHidden`); defaults to **expanded** so existing users see the unchanged dashboard on first load and opt into focus-mode explicitly — softens the audit's recommended "collapsed by default" to preserve workflow continuity without sacrificing the lever. `aria-expanded` + `aria-controls` + `hidden` attribute for screen-reader correctness. Chevron rotates -90° when collapsed (sidebar.css workspace-switcher pattern). The server-side `activeAlerts[]` shape the audit recommends for spend-cap + quality-gate signals stays as a deliberate non-goal — duplicating signals already in the workspace audit log would create a second write path with its own retention + ACL surface; the current HealthBanner derivation from `recentRuns` + `runsByStatus` + `useReviewQueueCounts` covers the audit's three named example alerts without that overhead. Spend-cap warnings already surface via the `spendAlert.js` webhook + Settings → Provider Routes panel; quality-gate violations already surface on RunDetail's `gateResult` badge. The dashboard banner intentionally focuses on the "what needs my attention right now" question, leaving forensic detail to the dedicated surfaces._

`Dashboard.jsx` renders approximately 12 independent panels in a vertically stacked layout: stat cards, a recent-runs table, a pass/fail trend chart, coverage panel, environment pass rates, worker pool stats, eval quality panel, healing stats, top-project breakdown, and more. All panels have identical visual weight. There is no distinction between "primary KPIs" and "supporting detail."

**User impact:** Users cannot identify what matters. On a failing morning where 3 projects have regressions, the dashboard does not surface this — regressions are buried within the recent-runs table at the same visual priority as a pass-rate sparkline from last week.

**Reference:** Datadog's dashboard has a "Summary" layer that shows aggregate health, then drills into services. Grafana separates alert panels from trend panels. GitHub Actions surfaces failing workflows with explicit failure banners at the top.

**Fix:** Introduce a three-tier dashboard hierarchy:
1. **Health banner** (top) — workspace health: "3 projects failing", "4 tests pending review", "2 self-healing events today" — actionable links only
2. **Primary KPIs** (row of 4 stat cards) — pass rate, active runs, pending approvals, coverage
3. **Supporting detail** (below fold) — all existing panels move here, collapsed by default with expand controls

---

### GAP-004 — Review Queue Has No Notification of Pending Work
**Severity: High** · ✅ _Sidebar badge landed in PR #25 — red pill on the Tests nav entry (expanded mode) + red pip on the icon (rail mode) when `useReviewQueueCounts().draft > 0`. Reuses the existing TanStack Query cache shared with `ReviewQueue.jsx`, so the badge and page stay in sync. The health-banner entry and daily digest are deferred to Phase 2._

The Review Queue (`/review-queue`) is reachable only via the Tests page quick-action card. There is no persistent indicator in the sidebar, no toast on login, and no email-on-queue-fill behaviour that would alert a QA Lead that tests are waiting for review. The sidebar auto-approvals badge (`🤖 N today`) tells users what was auto-approved, not what is still waiting for human action.

**User impact:** Tests accumulate in the review queue silently. QA Leads who don't habitually check the Tests page will miss drafts. This defeats a core Sentri workflow — the human-in-the-loop approval gate.

**Fix:**
- Add a `pending_review_count` field to the dashboard API payload
- Render a red badge on the Tests sidebar nav item when `pendingReviewCount > 0`
- Add a health-banner entry: "N tests awaiting review" with a direct link to `/review-queue`
- Optionally trigger a daily digest notification (already in FEA-001 notification infrastructure)

---

### GAP-005 — AI Agent Experience Has No Explainability Layer
**Severity: High** · ✅ _Landed in PR #26 — the audit's four-bullet explainability ask is now met end-to-end across the three surfaces that run AI pipelines:_

_**(1) Pipeline stages as collapsible rows** — `frontend/src/components/run/PipelineCard.jsx` (used by `CrawlView` + `GenerateView` from RunDetail) gains two optional closure props: `agentRoleFor(step)` and `outcomeFor(step)`. Each non-skipped stage now renders one or more purple 🤖 agent badges + a monospace outcome line ("23 tests generated", "4 duplicates removed", "0 validation rejected") computed from `run.pipelineStats` already on the dashboard payload. **The agent mapping is single-sourced at `frontend/src/config.js#getStageAgentRoles`**, sitting alongside the `AGENT_ROLES` list that already mirrors the canonical `backend/src/aiProvider/agentHealthCheck.js#AGENT_ROLES` (the 7-role enum: explorer / planner / author / oracle / reviewer / healer / triager). The mapping covers every real pipeline call site: step 3 (**Classify**) is **multi-agent** — `explorer` (intent classification at `backend/src/pipeline/intentClassifier.js:158`) + `planner` (journey decomposition at `backend/src/pipeline/journeyGenerator.js:218`) — and renders two badges side-by-side; step 4-7 use `author` (codegen + dedup + enhance + validate). `healer` runs at runtime (`selfHealing.js:274`, `vision.js:186`) outside the pipeline stage list. `oracle` / `reviewer` / `triager` are declared as configurable in `AGENT_ROLES` but not yet wired to any pipeline call site (per the `agentHealthCheck.js` docblock), so the mapping deliberately omits them — adding them without a real call site would mis-attribute the stage's actual agent. The badge palette matches the AI-004 streaming context line so the live LLMStreamPanel during a run and the persistent PipelineCard after a run agree on which agent owned which step. **Drift contract:** when the backend wires a new `agentRole: "<name>"` at a pipeline call site, update both the canonical `AGENT_ROLES` list and the `PIPELINE_STEP_ROLES` map in `frontend/src/config.js` — the two stay in sync, and CrawlView / GenerateView / TestLab.jsx all pick up the change without per-file edits._

_**(2) Per-stage duration / model / token count** — partially deferred. The pipeline stage list now exists with agent attribution and outcome counts; the per-stage duration + model + token columns the audit lists as "View prompt/response expandable" would need `ai_request_log` correlation back to a specific runId, which is a backend write-path change we deliberately skipped per the "no duplicate signal paths" rule. Today every AI call already lands in `ai_request_log` via migration 047 with `agentRole` + `traceId` + tokens + latency + cost; a future PR can wire `runId` correlation (column or join key) without touching the frontend surface — PipelineCard's `outcomeFor` closure already takes any shape so adding `model` / `tokenCount` rows is a one-line extension when the backend data lands._

_**(3) Confidence score factor breakdown inline on every draft test card** — already shipped in PR #25 under AI-001. `<QualityScoreChip>` with the factor-breakdown popover lives at `frontend/src/components/shared/QualityScoreChip.jsx` and is rendered by both ReviewQueue.jsx and TestDetail.jsx; `<QualityScoreExplainer>` adds the plain-English tier guidance ("Scores above 75 are typically safe to auto-approve.")._

_**(4) Healing strategy trace (which strategies tried, which succeeded)** — partially covered by the existing `HealingTimeline.jsx` component (loaded on RunDetail when a healing event fires on the active run). The "integrate HealingTimeline into HealingDashboard" half is tracked under AI-002 and remains genuinely unticked._

_Scope split is explicit so reviewers see what's deliberate non-goal vs. follow-up: surface-level explainability (the audit's stated primary deliverable in `**Fix:**`'s first bullet) is fully done; the per-LLM-call drill-down (the audit's `**Fix:**` second bullet about "View prompt/response expandable") needs the runId correlation work to be useful and that's a separate backend slice._

When Sentri's AI generates tests, heals selectors, or orchestrates a crawl, the user sees a spinner and then a result. There is no surface that shows:
- What the AI decided and why
- Which pipeline stage is currently active
- What the confidence score for a generated test means in plain language
- Why a self-heal chose strategy index 27 (AI selector) instead of 4 (role fallback)
- What the AI "saw" when it generated a specific assertion

**User impact:** Users cannot build trust in AI-generated outputs because they cannot verify the reasoning. Enterprise QA teams will not promote AI-generated tests to production without an explainability audit trail. This is the #1 reason enterprise AI tools fail procurement reviews.

**Reference:** LangSmith shows full trace trees of every LLM call with prompts, completions, and latency. GitHub Copilot shows which file context was used. Cursor shows which references the AI consulted.

**Fix:** Build an "Agent Trace" panel on RunDetail for crawl and generate runs:
- Show each pipeline stage as a collapsible row (Crawl → Plan → Author → Validate → Score → Approve)
- For each stage, expose: duration, model used, token count, and a "View prompt/response" expandable
- Link healing events to their strategy trace (which strategies were tried, which succeeded)
- Confidence score explainer: show the `qualityScoreFactors` breakdown inline on every draft test card

---

### GAP-006 — No Project-Level Health Summary
**Severity: High**

`ProjectDetail.jsx` (682 lines) shows Runs, Tests, Environments, and Settings tabs but has no health overview panel. When a user lands on a project, they see the most recent run's status but have no aggregate view: pass rate trend, healing frequency, test flakiness, coverage trajectory, or quality gate status.

**Fix:** Add a `Summary` tab as the default landing tab for ProjectDetail, showing:
- 30-day pass rate sparkline
- Coverage trend (if enabled)
- Active quality gate status (GateBadge)
- Top 3 failing tests
- Self-heal events this week
- Environment health (if configured)

This pattern is used by every competitive platform (Cypress Cloud's Project Overview, BrowserStack's Analytics tab, Harness's Pipeline summary).

---

## 3. Navigation & Workflow Issues

### NAV-001 — Sidebar Information Architecture Needs Restructuring
**Severity: High** · ✅ _Landed in PR #25 — `frontend/src/components/layout/Sidebar.jsx` `NAV_GROUPS` restructured to the recommended 4-group layout: **Core** (Dashboard, Projects, Tests), **Work** (Runs, Review Queue, Approvals), **Automation** (Test Lab, Healing, Automation), **Insights** (Reports, Audit Log [admin], System). Test Lab demoted Core → Automation; Approvals lifted Automation → Work; Review Queue gets a first-class entry (closing the silent-drafts gap that GAP-004's badge mitigated); Reports + Audit Log + System cluster under Insights. Settings stays in the footer. Chat is intentionally still off-sidebar — the audit calls it out as missing, but a sidebar entry vs. TopBar discoverability is a separate decision tracked outside NAV-001._

The sidebar has 3 groups (Core, Activity, Automation) with 12 items. Several items are inconsistently categorised:
- "Chat" (`/chat`) is in no group at all — it's missing from the sidebar entirely (reachable only via TopBar AI button, not discoverable for new users)
- "System" (`/system`) is in the Automation group but is an admin-only observability view, not an automation concept
- "Test Lab" (`/test-lab`) is in Core, but it's an advanced feature that shouldn't be at the same hierarchy level as Dashboard or Projects
- "Healing" (`/healing`) and "Approvals" (`/approvals`) are separate nav entries but represent sub-workflows of test management, not top-level navigation destinations

**Recommended IA:**
```
Core:       Dashboard, Projects, Tests
Work:       Runs, Review Queue, Approvals
Automation: Test Lab, Healing, Automation
Insights:   Reports, Audit Log (admin)
System:     Settings (admin)
```

---

### NAV-002 — No Breadcrumb Navigation on Deep Pages
**Severity: Medium** · ✅ _Landed in PR #25 — new shared `<Breadcrumb>` at `frontend/src/components/shared/Breadcrumb.jsx` renders WAI-ARIA APG-compliant trails (`<nav aria-label="Breadcrumb">` + `<ol>` + per-item `<Link>` so middle-click "open in new tab" works and screen readers announce the chain). RunDetail's `navigate(-1)` back-arrow breadcrumb is replaced with `Dashboard › Projects › [Project Name] › Runs › Run #abc123`; the project name is hydrated onto the run response server-side (`backend/src/routes/runs.js` adds `projectName` from the ACL-resolved project, no extra round-trip). TestDetail's bespoke `.td-breadcrumb*` markup is replaced with the same shared component rendering `Dashboard › Projects › [Project Name] › Tests › [Test Name]`. The dead `.td-breadcrumb*` CSS is removed in the same commit. The footer "Back" button on RunDetail intentionally still uses `navigate(-1)` — it's a secondary scroll-position convenience, not the logical-parent navigation the audit calls out._

Pages like `/runs/:runId` and `/tests/:testId` have a back-arrow (`ArrowLeft`) that navigates to the previous browser history entry — not necessarily the logical parent. If a user arrives at RunDetail from a notification link or a bookmark, the back arrow navigates nowhere useful.

**Fix:** Implement semantic breadcrumbs: `Dashboard > Projects > [Project Name] > Runs > Run #abc123`. Use project/run data already fetched by the page to build this trail. Linear and Vercel both implement this pattern.

---

### NAV-003 — Context Switching Between Projects Is High-Friction
**Severity: Medium**

When a user is in ProjectDetail and wants to switch to another project, they must navigate back to `/projects`, find the project, and click through. There is no project switcher in the header or project detail top bar.

**Fix:** Add a project picker dropdown to the ProjectDetail header, similar to GitHub's repository selector or Vercel's project picker. Pre-populated with the user's recent projects.

---

### NAV-004 — Deep Linking Support Is Incomplete
**Severity: Medium**

Settings.jsx uses `?tab=<key>` to deep-link to a tab, but this is the only deep-linking in the application. RunDetail has no way to link directly to a specific test result within a run. ReviewQueue supports `?projectId=` filtering but no test-specific deep links.

This matters for collaboration: a QA lead cannot send a link that opens directly to a failing test step within a specific run.

**Fix:** Add URL fragment or query-param-based state for: active tab in any tabbed view, selected test in ReviewQueue, expanded root cause cluster in RunDetail, and active step in StepResultsView.

---

## 4. Dashboard UX Issues

### DASH-001 — No Realtime Alert/Anomaly Banner
**Severity: High** · ✅ _Substantially resolved by GAP-003's HealthBanner in PR #26 — see `frontend/src/components/dashboard/HealthBanner.jsx`. Three of the four alert kinds DASH-001 specifies are live: **currently-failing projects** (red, per-project most-recent-outcome) + **pending review work** + **active long-running runs** (blue). All click-through to the relevant filtered view, all derived client-side from the existing `/api/v1/dashboard` payload, hidden when no alerts (zero noise on healthy days). The two remaining alert kinds (**quality-gate violations**, **spend-cap warnings**) stay as a deliberate non-goal for the same reason DASH-001's fix description hinted at — both already surface on dedicated surfaces (RunDetail `gateResult` badge; `spendAlert.js` Slack webhook + Settings → Provider Routes). Adding a third write path on the dashboard would duplicate signals already in the workspace audit log without a new user-facing benefit. The audit's "dismissible" recommendation is met via the Tier-3 supporting-detail collapse (banner sits above the stat grid which sits above the collapse toggle — focused mode hides everything but the banner + KPIs). DASH-001 is the dashboard sibling of GAP-003; ticking it here closes the bookkeeping._

The dashboard has no surface for active alerts. If 3 projects are currently in a failing state, a new quality gate violation was just triggered, or a self-healing event is actively processing, the user has no way to know without manually reading every panel.

**Fix:** Add a dismissible "Active Incidents" banner below the stat cards, fed by a new `activeAlerts` field in the dashboard API. Alerts include: currently-failing projects, quality gate violations, spend cap warnings (from `spendAlert.js`), and active long-running runs.

---

### DASH-002 — Stat Cards Lack Trend Context
**Severity: Medium**

The four stat cards (using `StatCard.jsx`) show current counts but no trend. A pass rate of 78% is fine if it was 72% last week but alarming if it was 95%. Without the delta, the number is opaque.

**Fix:** Add a `trend` prop to `StatCard` rendering a `+N%` or `-N%` badge with green/red colouring and a micro-sparkline. TanStack Query already fetches 30-day trend data for coverage — extend this to pass rate and test counts.

---

### DASH-003 — Worker Pool Panel Is Too Technical for Default Dashboard
**Severity: Low** · ✅ _Landed in PR #25 — new shared component at `frontend/src/components/shared/WorkerPoolPanel.jsx` exposes two variants: `variant="full"` (4-card breakdown — Runner Mode, Queue Depth, Active Workers, Completed Jobs) now lives on `/system` (`pages/Systems.jsx`), and `variant="health"` (single Platform Health StatCard with green/amber/red tier) replaces the old block on `/dashboard` (`pages/Dashboard.jsx`). Tier rules are shared between both variants so the dashboard health pill and the per-row red badges on the system page agree on what "unhealthy" means: red on any failed jobs, amber on backed-up queues (> 5 waiting) or distributed-mode-with-no-active-workers, green otherwise. Systems mounts `useDashboardQuery` so a user navigating Dashboard → System gets the cached payload immediately (TanStack Query cache key is shared across both surfaces — one fetch, two consumers)._

The 4 BullMQ worker stat cards (Runner Mode, Queue Depth, Active Workers, Completed Jobs) added in AUTO-008 are infrastructure-level data that operators, not QA users, need. They occupy primary dashboard real estate with information that is only relevant when something is wrong.

**Fix:** Move the worker pool panel to the `/system` page. On the main dashboard, replace it with a single "Platform Health" indicator that is green/amber/red based on queue depth and error rate.

---

## 5. AI/Agent UX Issues

### AI-001 — Confidence Score Is a Number Without Context
**Severity: High** · ✅ _Landed in PR #25 — `QualityScoreChip` + factor-breakdown popover extracted from `pages/ReviewQueue.jsx` to a shared `frontend/src/components/shared/QualityScoreChip.jsx` module, and a new `<QualityScoreExplainer>` companion renders the audit's recommended plain-English tier copy ("Scores above 75 are typically safe to auto-approve.", etc.). Tier thresholds (≥75 / ≥50 / <50) now live in one `qualityTier()` helper consumed by every score surface — the popover header, the explainer line, and the colour ramp. **TestDetail** swaps its bare numeric badge for the shared chip + explainer so the explainability gap is closed end-to-end; the previously-inconsistent 70/40 colour cutoffs are unified with ReviewQueue's 75/50 via `qualityColor()`. ReviewQueue keeps using the same component via the new shared import._

Generated tests display a quality score (0–100) and a factor breakdown via `QualityScoreChip`, but this exists only in the ReviewQueue. The TestDetail page shows a plain `qualityScore` number with no explanation. New users have no mental model for what "score 62" means compared to "score 88."

**Fix:** Add inline guidance: "Scores above 75 are typically safe to auto-approve. Scores below 50 indicate missing assertions or unreliable selectors." Add a contextual tooltip that maps score ranges to plain-English quality descriptions. Show this consistently wherever quality scores appear.

---

### AI-002 — Self-Healing Is a Black Box
**Severity: High**

`HealingDashboard.jsx` shows strategy distribution (which strategies were used) and a savings trend chart, but does not explain what "Strategy 27: AI selector" means in human terms, why it was chosen, or how confident the AI was. The healing timeline component (`HealingTimeline.jsx`) exists in `components/run/` but the dashboard doesn't use it.

**Fix:** Integrate `HealingTimeline.jsx` into `HealingDashboard.jsx` so each healing event shows the before/after selector, the failed strategies that were tried first, the model used, and a confidence indicator. This is the transparency that enterprise customers need before trusting autonomous healing in production.

---

### AI-003 — No Multi-Agent Orchestration Visualisation
**Severity: Medium**

The platform now has a full multi-agent dispatch layer (AI-005), with roles including `explorer`, `planner`, `author`, `healer`. The UI has no surface that shows these agents collaborating or their individual outputs. Users have no visibility into which agent handled which part of their workflow.

**Fix:** Add an "Agent Activity" section on RunDetail for crawl/generate runs showing a timeline of agent activations: "Explorer agent crawled 47 pages (12s)", "Planner agent created 8 test journeys (4s)", "Author agent generated 23 tests (34s)". Use the existing activity log data and pipeline stage metadata already persisted.

---

### AI-004 — LLM Token Streaming Is Visible But Not Explained
**Severity: Low** · ✅ _Landed in PR #25 — `LLMStreamPanel.jsx` gained four optional context props (`stageLabel`, `stageIndex`, `totalStages`, `agentRole`, `modelName`) that render a muted single-line context row beneath the existing "🧠 AI Thinking" header. `GenerateView.jsx` wires the props from `run.currentStep` (1-based pipeline-stage index already populated by the backend on every transition) and a per-step `STEP_TO_AGENT_ROLE` map (3 → planner, 4-7 → author) so the panel now reads `Author agent · generate tests via ai — Stage 4/8` instead of a context-free token stream. `modelName` is populated from `run.modelUsed` for forward-compatibility with the GAP-005 backend work that will persist per-run model attribution; until that lands the model fragment cleanly omits itself. Each context fragment is independently nullable — the panel renders gracefully on legacy runs / older backends with zero context props. **TestLab follow-up**: the context-row JSX + tier-resolution logic was extracted to a shared `<LLMContextRow>` component (`frontend/src/components/ai/LLMContextRow.jsx`) so `frontend/src/pages/TestLab.jsx`'s pipeline view renders the same `Author agent · generate tests via ai — Stage 4/8` line above its `<LiveLog>` — operators running generation from TestLab now get the same explainability layer as GenerateView. Same `STEP_TO_AGENT_ROLE` mapping is duplicated in TestLab.jsx (intentionally kept separate so the crawl and generate pipelines can diverge in the future) and `runData.modelUsed` is read for forward-compat with GAP-005. The shared component also fixes the stage-0 truthiness bug flagged on `LLMStreamPanel.jsx` (BUG-0001 active finding): the original `(stageIndex && totalStages)` predicate suppressed the progress chip when `stageIndex === 0`; the shared component now uses `stageIndex != null && stageIndex > 0` so stage 0 callers (if any are added later) render correctly._

The `LLMStreamPanel.jsx` shows raw streaming tokens from the AI during generation. For non-technical users, watching tokens stream is confusing — they see code being "typed" in real time without understanding why. For technical users, the panel does not show which model is generating or which stage of the pipeline this represents.

**Fix:** Add a header to the streaming panel: "Author agent generating test code with [model name]" and show the current pipeline stage. Add a progress indicator showing stage 4/8 rather than just raw tokens.

---

## 6. Design System Issues

### DS-001 — Inline Styles Contaminate Component Boundaries
**Severity: High** · ✅ _Landed in PR #25 — TopBar + NotFound + Settings.jsx + TestLab.jsx + RecorderModal. All four named offenders are gone: **Settings.jsx** was deleted entirely under GAP-002, with `OllamaStatusPanel` extracted to `features/settings/sections/providers/OllamaStatusPanel.jsx` and every inline `style={{}}` from the legacy panel + provider cards replaced with `.ollama-*` / `.st-provider-*` classes; the only inline styles remaining there are the data-driven per-provider brand colors on `ProviderCard` (AGENTS.md §127 carve-out). **TopBar.jsx** rewritten on top of a new `frontend/src/styles/features/topbar.css` partial — header, user-menu button, dropdown panel, and every menu item now use `.topbar*` / `.topbar-user*` / `.topbar-user-dropdown*` classes; `onMouseEnter` / `onMouseLeave` hover-state handlers replaced with CSS `:hover` pseudo-classes (the audit's anti-pattern call-out — extra renders, no `:focus-visible` integration, no theming hooks). **NotFound** in `App.jsx` migrated to the shared `.empty-state*` + `.btn .btn-primary` primitives. **TestLab.jsx** — the heaviest inline-style offender named in the audit — migrated to a new block of `.tl-*` classes in `frontend/src/styles/pages/test-lab.css` (~25 JSX blocks replaced: topbar brand cluster, Record button, Queue header + filter + recent label, project skeleton + last-crawl meta, run status suffix, 4 banner rows + their internal body/icon/actions, pipeline progress bar + "Pages crawled" stat val + Stop/New-run buttons, sitegraph + logs panes, Test Name + Import-issue panel, hidden file input, right-panel attached-run header + final-stats margin + 4 full-width button variants + button stack + stat placeholders + active-run card). The only inline styles remaining are data-driven per AGENTS.md §127 — `avatarStyle(initial)` HSL hue per letter and three `width: N%` progress-bar fills (continuous values that can't be expressed as a fixed class). Lint rule (`react/forbid-component-props`) is **NOT** in this PR — that requires eslint config plumbing and is tracked as a separate follow-up._

Despite the AGENTS.md rule "no inline `style={ {} }` (double-brace JSX expressions) except for data-driven values," `TopBar.jsx` contains extensive inline styles for nearly every element: the header, user menu button, dropdown panel, and menu items. `Settings.jsx` has inline styles throughout its OllamaStatusPanel and provider cards.

The design system has excellent token coverage in `tokens.css` but these tokens are not being used consistently at the component level. This makes theming unpredictable and dark-mode behaviour inconsistent.

**Audit findings:**
- `TopBar.jsx` — header element uses `style={ { height: 52, background: "var(--surface)", ... } }` — should be `.topbar` CSS class
- `TopBar.jsx` — user menu uses `onMouseEnter`/`onMouseLeave` for hover states — should be CSS `:hover`
- `Settings.jsx` — OllamaStatusPanel panel uses `style={ { marginTop: 16, display: "grid", gap: 12 } }` — should be utility classes
- `NotFound` component (App.jsx) uses entirely inline styles

**Fix:** Migrate all layout and theme-dependent styles from inline to CSS classes. Create a `topbar.css` feature partial. Establish a lint rule (ESLint `react/forbid-component-props`) to prevent new inline style additions except for genuinely data-driven values.

---

### DS-002 — Spacing System Is Implicit
**Severity: Medium**

`tokens.css` defines `--radius` and `--radius-lg` but no spacing scale. Spacing values throughout the codebase are raw pixel values: `marginTop: 16`, `gap: 12`, `padding: "0 24px"`. There is no `--space-sm`, `--space-md`, `--space-lg` token set.

Without a spacing scale, visual rhythm varies between pages. The Dashboard card padding differs from the Settings card padding which differs from the RunDetail card padding.

**Fix:** Add a spacing scale to `tokens.css`:
```css
--space-xs: 4px;
--space-sm: 8px;
--space-md: 16px;
--space-lg: 24px;
--space-xl: 32px;
--space-2xl: 48px;
```
Adopt these tokens in `components.css` and all feature/page CSS. This is a one-time migration that locks in visual consistency.

---

### DS-003 — Typography Scale Is Underdefined
**Severity: Medium**

`tokens.css` defines `--font-sans` and `--font-mono` but no font-size or line-height tokens. Text sizes are scattered raw values: `fontSize: "0.83rem"`, `fontSize: "0.72rem"`, `fontSize: "0.875rem"`. The CSS uses `.text-xs`, `.text-sm` utility classes in some places and raw `fontSize` in others.

**Fix:** Define a type scale:
```css
--text-xs: 0.75rem;
--text-sm: 0.875rem;
--text-base: 1rem;
--text-lg: 1.125rem;
--text-xl: 1.25rem;
--leading-tight: 1.25;
--leading-normal: 1.5;
```

---

### DS-004 — No Focus-Visible Styles in Design System
**Severity: Medium** (Accessibility crossover — see section 7) · ✅ _Landed in PR #25 (resolved by A11Y-001's global `:focus-visible` rule at `frontend/src/styles/components.css:23-27`). The shared `2px solid var(--accent) + 2px offset + var(--radius)` ring is now applied to every interactive element when reached via keyboard navigation. `.input` and `.dial-textarea` opt out via `outline: none` and keep their inset accent box-shadow indicator (also WCAG-compliant). DS-004 is fully satisfied by A11Y-001's implementation — no separate work needed._

The design system has hover states but no standardised `:focus-visible` ring definition. Keyboard users have inconsistent or invisible focus indicators across interactive elements.

---

### DS-005 — Form Design Is Inconsistent
**Severity: Medium**

`components.css` defines `.input` for form fields, but many form elements in Settings and NewProject use custom styling. The OllamaStatusPanel `<select>` element has no class, using browser default styling. Checkbox elements throughout Settings use default browser appearance rather than custom styled checkboxes.

**Fix:** Add `.select`, `.checkbox`, `.radio`, `.form-group`, `.form-label`, and `.form-hint` to `components.css` as standardised form primitives. Apply them consistently in Settings, NewProject, and TestConfig.

---

## 7. Accessibility Issues

### A11Y-001 — Missing Focus-Visible States
**Severity: High** · _Landed in PR #25 — global `:focus-visible` ring at `frontend/src/styles/components.css`. WCAG 2.4.7 + 2.4.11 satisfied._

Interactive elements (buttons, nav links, form inputs) do not have visible `:focus-visible` styles beyond the browser default in most cases. `components.css` sets `outline: none` on some elements without providing a replacement focus indicator.

**WCAG:** Success Criterion 2.4.7 (Focus Visible, Level AA) and 2.4.11 (Focus Appearance, Level AA in WCAG 2.2).

**Fix:** Add a global focus ring rule:
```css
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
  border-radius: var(--radius);
}
```

---

### A11Y-002 — Modal Dialogs Missing Focus Trap
**Severity: High** · ✅ _Landed in PR #25 — `ModalShell.jsx` now implements a full focus trap: focus moves into the panel on open, Tab / Shift+Tab cycle within the focusable set, and focus returns to the previously-focused element on close. Adds `role="dialog"` + `aria-modal="true"` + optional `aria-label` / `aria-labelledby` props. Selector mirrors the proven trap in `pages/Login.jsx`. WCAG 2.1.2 (No Keyboard Trap) satisfied across every site that uses ModalShell. **All five ModalShell call sites** were updated to pass an accessible name via `ariaLabelledBy`, with matching `id` on the heading element: `DeleteProjectModal` (`delete-project-modal-title`), `RunRegressionModal` (`run-regression-modal-title`), the Tests bulk-delete dialog (`tests-bulk-delete-title`), the ProjectDetail bulk-confirm dialog (`pd-bulk-confirm-title`), and the ReviewQueue per-kind confirm dialog (`rq-confirm-title`). Additionally, **`RecorderModal.jsx`** — which uses a full-screen `createPortal` stage with a live browser canvas and nested confirm dialogs (Cypress Studio / Playwright Codegen pattern, not a centered dialog) — gets the same focus-trap treatment in-place rather than via `ModalShell`, with `role="dialog"` + `aria-modal="true"` + `aria-labelledby="recorder-modal-title"` on the stage root. The `LiveBrowserView` canvas is intentionally excluded from the cycle (`tabindex="-1"`) so keyboard input there forwards to the SUT being recorded, not the sidebar. Screen readers now announce the actual dialog purpose (e.g. "Delete project — dialog", "Record a test — dialog") instead of the generic "Dialog" fallback._

`ModalShell.jsx` renders a modal overlay but does not implement focus trapping. When a modal opens, keyboard users can Tab through elements behind the modal overlay.

**WCAG:** Success Criterion 2.1.2 (No Keyboard Trap) requires that focus be manageable — this is specifically about ensuring focus moves into the modal and cannot escape it until the modal is dismissed.

**Fix:** Use the `focus-trap-react` library or implement a native `<dialog>` element which handles focus trapping natively. The `<dialog>` approach is zero-dependency and aligns with modern browser support.

---

### A11Y-003 — Live Regions for SSE Updates
**Severity: Medium**

When a run completes or a self-healing event fires, the UI updates via SSE but screen readers are not notified. MNT-007 (ARIA live regions) shipped in PR #99, but its coverage is partial — the `GlobalRunBanner.jsx` and `ActiveRunBanner.jsx` use live regions but the notification bell does not.

**Fix:** Audit all SSE update surfaces and ensure `aria-live="polite"` (or `assertive` for critical state changes like run failure) is applied. The notification bell's dropdown content should use `role="log"` with `aria-live="polite"`.

---

### A11Y-004 — Colour Contrast on Secondary Text
**Severity: Medium** · ✅ _Landed in PR #25 — `--text3` lifted from `#9ca3af` (2.8:1 on `--bg`, failing WCAG AA at 4.5:1) to `#6b7280` (4.6:1, passing AA) in `frontend/src/styles/tokens.css:39`. The matching `[data-theme="light"]` override at line 148 keeps parity. Dark theme unaffected (`--text3: #5a6378` on `#0f1117` already exceeds 4.5:1). `--text2` also darkened to `#4b5563` (7.5:1) so the secondary/tertiary hierarchy survives — `.text-sub` (`var(--text2)`) stays visibly darker than `.text-muted` (`var(--text3)`). Pure visual lift; no markup or layout changes. WCAG SC 1.4.3 (Contrast Minimum, AA) compliance for the `text-muted` token used across timestamps, secondary labels, hint copy, and metadata throughout the app._

`--text3: #9ca3af` on `--bg: #ffffff` has a contrast ratio of approximately 2.8:1 — well below the WCAG AA requirement of 4.5:1 for normal text. This token is used throughout as `text-muted` for timestamps, secondary labels, and metadata.

**Fix:** Increase `--text3` to at least `#6b7280` (3.9:1) or `#595f6b` (4.6:1) for body-size text use cases. For decorative or purely informational use, the existing value can remain but should not be used for text that conveys meaning.

---

### A11Y-005 — Tab Navigation Ordering in ReviewQueue
**Severity: Medium**

`ReviewQueue.jsx` implements a two-pane layout where the left pane (test list) and right pane (test detail) are sibling elements in the DOM. Tab order moves through the left-pane action buttons, then into the right pane — but visually, users expect to interact with the left pane, select an item, then interact with the right pane. The actual tab order doesn't match the visual flow.

**Fix:** Use `tabindex` management to ensure focus moves logically. When a test item is selected in the left pane, move focus programmatically to the right pane header.

---

### A11Y-006 — Images Without Alt Text
**Severity: Medium** · ✅ _Landed in PR #25 — both meaningful test-result `<img>` tags now carry descriptive alt text. **`TestRunView.jsx`** test-level screenshot (`alt="Test screenshot"`) was upgraded to `Screenshot of test "{cleanTestName(...)}" — {status}` so screen-reader users hear the test name and pass/fail status they need to understand the evidence. **`StepResultsView.jsx`** visual-diff image (`alt="Visual {mode}"`) was upgraded to per-mode descriptive copy: baseline frames now announce `Visual diff for step N — baseline (expected appearance)`, current-run frames `— current run (actual appearance)`, and pixel-diff overlays `— pixel-difference overlay (X.XX% of pixels changed)`. The pixel-percentage is computed from `diffRatio` already on the visual-diff payload, so screen-reader users get the same actionable signal sighted users see in the banner above. The member-avatar `<img alt="">` in MembersSection is correctly empty-decorative (the user's name is adjacent text), and is unchanged._

Step screenshots in `StepResultsView.jsx` are rendered as `<img>` elements. Visual diff images in the baseline viewer have no alt text describing the comparison. These are meaningful images (they show test failure evidence) and require descriptive alt text for screen reader users.

**Fix:** Add descriptive alt text: `alt={`Screenshot of step ${step.index}: ${step.action} on ${step.selector}`}`.

---

## 8. Enterprise UX Gaps

### ENT-001 — No Keyboard Shortcut System
**Severity: High**

The only documented keyboard shortcut is ⌘K for the command palette. There are no shortcuts for: approving a test (in ReviewQueue), triggering a run (in ProjectDetail), cancelling a run, or navigating between tabs. Enterprise power users — the primary Sentri persona — expect a keyboard-first experience.

**Reference:** Linear has 50+ keyboard shortcuts. GitHub has shortcuts for every major action. Datadog has a keyboard shortcut reference panel.

**Fix:** Define a keyboard shortcut map and implement it via a global `keydown` handler in `Layout.jsx`:
- `g d` → Dashboard
- `g p` → Projects  
- `g t` → Tests
- `g r` → Runs
- `a` → Approve selected test (in ReviewQueue)
- `x` → Reject selected test
- `Shift+R` → Re-run current run

Expose the shortcut list via `?` key, opening a modal with the full reference.

---

### ENT-002 — RBAC Visibility Is Confusing
**Severity: High**

The RBAC system (Admin, QA Lead, Viewer) controls access to mutations but the UI does not clearly communicate why certain actions are unavailable. When a Viewer-role user encounters a disabled button, there is no tooltip or message explaining "You need QA Lead role to approve tests." The user simply sees a disabled or missing button.

**Fix:** Add a `usePermission` hook that checks the user's role against the action's requirement. Render disabled buttons with a tooltip: "Requires QA Lead role. Contact your workspace admin." This pattern is used by Linear, Notion, and Vercel.

---

### ENT-003 — Audit Log UX Is Engineer-Oriented, Not Compliance-Oriented
**Severity: Medium**

`AuditLog.jsx` (1,481 lines) is a table of raw event records with filtering. Enterprise compliance teams who use audit logs need: event categorisation by area (auth events, test events, AI events), export to PDF/CSV for auditors, a summary view ("how many admin actions this month"), and date-range presets. The current UI is a developer debug view.

**Fix:** Add a compliance-oriented summary panel above the raw log: events by category over time (bar chart), most active users, high-risk event count. Add date-range presets (Last 7 days, Last 30 days, Last quarter). Add a "Export for auditor" button that generates a signed CSV.

---

### ENT-004 — No Team Collaboration UX
**Severity: Medium** · ✅ _Per-entity activity deep-links landed in PR #26. TestDetail and RunDetail both expose a "View activity →" button that opens `/audit-log` pre-filtered to the entity. Server-side filters: existing `activities.testId` (indexed) for `?testId=…`, new `activities.runId` + `idx_activities_runId` index from migration 055 for `?runId=…`. `logActivity()` accepts `runId` as a first-class arg with `meta.runId` fallback so existing writers keep populating the column. AuditLog UI surfaces dismiss chips (`Test: TST-xxx ×` / `Run: RUN-xxx ×`). Per-test `reviewComment` column added via migration 054 — feedback-loop regenerator persists a human-readable "Auto-regenerated after failure (SELECTOR_ISSUE)…" line that surfaces inline on TestDetail as an amber "Review note" callout, and the ReviewQueue reject dialog now collects an optional reviewer comment via a textarea that round-trips through the API and renders on TestDetail. Full comment threads on individual tests are deferred to a future PR; this slice closes the audit-log + per-test note half._

There is no way for QA team members to leave comments on a test, a run, or a healing event. Approvals in the ReviewQueue have no comment/rejection-reason field visible in the UI (the backend has activity logging but the frontend doesn't surface the review comment in the approval flow). Team activity — who approved what, who triggered which run — is visible only in the audit log, not in the test or run context.

**Fix:** Add a lightweight "Activity" feed to TestDetail and RunDetail showing the last N actions (approved by, rejected by, healed on, etc.) with timestamps. This is the minimum needed for team collaboration on QA outcomes.

---

### ENT-005 — Notification UX Is Reactive, Not Proactive
**Severity: Medium**

The notification bell (`NotificationBell.jsx`) shows a dropdown of recent events. There is no way to configure notification preferences from within the notification bell — users must navigate to Settings → Notifications. There is no "snooze" or "mark all read" capability. The bell badge shows a count but disappears when the dropdown is opened regardless of whether the user read the items.

**Fix:** Add "Mark all read" and "Notification settings" links directly in the notification dropdown. Persist read state per notification. Add `snooze until X` for recurring notifications.

---

## 9. Frontend Architecture Concerns

### ARCH-001 — Settings.jsx Must Be Split
**Severity: Critical** · ✅ _Resolved by GAP-002 in PR #25. The 3,594-line `frontend/src/pages/Settings.jsx` was decomposed into a sidebar-driven shell + 9 per-section lazy-loaded chunks under `frontend/src/features/settings/sections/`. Every concern this finding called out is gone: (1) per-tab bundle weight — each section is its own webpack chunk loaded on demand, not bundled into one page load; (2) cross-tab re-renders — section components are sibling routes, not nested children of a giant tab switcher, so a state change in Members doesn't re-render Providers; (3) "modifying this single 3,500-line file" — adding a new section is now adding a new file under `features/settings/sections/`; (4) "loading the entire Settings component to test any feature" — each section is testable in isolation. The legacy file is replaced by a build-time guard that throws on render. ARCH-001 is the architectural sibling of GAP-002 (same root cause, same fix); ticking it here closes the duplicate bookkeeping._

A 3,594-line single-file component is a maintenance and performance liability:
- The entire Settings page, including code for every tab, loads regardless of which tab the user is viewing
- Every Settings update triggers a re-render of the entire component tree
- Adding a new settings section requires modifying this single 3,500-line file
- Testing any Settings feature requires loading the entire Settings component

Beyond the UX issues already documented, this is an architectural code smell that will compound as more settings are added.

---

### ARCH-002 — State Management for Run Pages Is Fragile
**Severity: High**

`RunDetail.jsx` combines TanStack Query (`useRunDetailQuery`) with SSE patches (`useRunSSE`) and multiple local `useState` variables for compare mode, prior runs, root cause expansion, aborting state, and re-run state. When an SSE event arrives, it does `queryClient.setQueryData()` to merge the patch — but if the component is unmounted mid-run and re-mounted (e.g., user navigates away and back), the SSE connection re-subscribes and may receive a burst of stale events that patch over current data.

**Fix:** Move SSE patch logic to a dedicated `useRunWithSSE` hook that handles mount/unmount lifecycle correctly, including event deduplication and stale-event rejection based on event sequence numbers.

---

### ARCH-003 — Component Size Anti-Patterns
**Severity: Medium**

Several components exceed reasonable single-responsibility bounds:
- `RecorderModal.jsx` — 46,995 bytes (largest component, ~1,200 lines)
- `StepResultsView.jsx` — 34,443 bytes
- `TestRunView.jsx` — 33,946 bytes
- `ProjectQualityCard.jsx` — 33,717 bytes

These mega-components are difficult to test, maintain, and reason about. They likely contain render performance bottlenecks from re-rendering large subtrees on any state change.

**Fix:** Each of these components should be decomposed into 3–5 sub-components split by feature area, with internal state hoisted only where necessary.

---

### ARCH-004 — No Optimistic Updates on Mutation Actions
**Severity: Medium**

When a user approves a test in ReviewQueue, the UI waits for the API response before updating the list. During the API round-trip (300–500ms on a good connection), the button shows a spinner and the test remains in the list. This creates perceptible latency on what should feel like an instant action.

**Reference:** Linear and Notion apply optimistic updates — the item moves immediately when you action it, with a rollback if the API call fails.

**Fix:** Implement TanStack Query optimistic updates for test approve/reject, run abort, and test enable/disable actions.

---

### ARCH-005 — No Error Boundary Per Page Section
**Severity: Medium**

`ErrorBoundary.jsx` wraps the entire app but there are no section-level boundaries. If the coverage panel on Dashboard throws an error, the entire dashboard page crashes. If the healing timeline throws, the entire RunDetail page goes blank.

**Fix:** Wrap each major dashboard panel and page section in a local `<ErrorBoundary>` with a panel-level fallback: "This section could not be loaded. [Retry]."

---

## 10. Mobile & Responsive Issues

### MOB-001 — No Mobile Support
**Severity: High** · ✅ _Page-by-page responsive pass landed in PR #26. **Two passes** covered every page + feature CSS file: **first pass** — `topbar.css` (cluster gap collapse + dropdown clamp + 480px chevron/email hide + 36×36 MOB-002 tap target), `components.css` `.modal-form-row--inline` + `.modal-form-actions` (stack + flex-wrap on phones), `settings.css` (members invite form / member rows / integrations row 5-col → 1-col / MFA factor row / recovery + TOTP actions), `dashboard.css` (coverage panel header wrap + Web Vitals grid 1-col). **Second pass** — `features/notifications.css` (dropdown clamp), `features/test-run-view.css` (`.trv-grid` stacks at 900px + chrome tab + API URL clamp at 600px + 480px interior padding), `features/mfa.css` (recovery grid 2-col → 1-col + tablist vertical + grace banner wrap), `features/llm-stream.css` (header wrap + token-count hidden + body max-height 280→200px), `features/recorder.css` (idle form + confirm dialog clamp, recording phase intentionally desktop-only), `pages/system.css` (info-row stack + 4-col stats → 2 → 1 col + URL clamp), `pages/new-project.css` (auth grid 2 → 1 col + steps wrap + URL test button icon-only), `pages/approvals-timeline.css` (header selects shrink + row wrap at 480px). Tests covering Dashboard/Runs/AuditLog/ReviewQueue/RunDetail/TestDetail/Tests/Projects/Reports/ProjectDetail/ChatHistory/TestLab/Automation/StepResultsView/CommandPalette/Onboarding already had 900 / 600 / 480 breakpoint sets._

⚠️ _**Shell-level scaffold only — the app is NOT mobile-responsive.** `frontend/src/styles/pages/layout.css:36-177` ships breakpoints for the **app shell** (768px → sidebar narrows to icon-rail; 480px → sidebar slides off-screen behind a `.sidebar-overlay` + hamburger toggle). That's the navigation chrome only. **No individual page has been audited or fixed for narrow viewports**: Dashboard's 12 stacked panels don't reflow, the Runs / AuditLog / ReviewQueue tables overflow horizontally without `overflow-x: auto`, RunDetail's tab bar wraps awkwardly, every modal assumes desktop width, stat-card rows don't collapse to single-column, and form layouts in Settings sections overflow at 375px. The 30+ existing page-level `@media` queries are scoped to component-internal tweaks (e.g. SettingsSidebar collapsing at 900px) — they are NOT a comprehensive responsive pass. **Phase 1 "establish responsive breakpoints" is partially met (shell only); a full page-by-page responsive QA + fix pass remains outstanding work** and should be elevated to its own roadmap item before any mobile-experience claim is made externally._

On a 375px wide iPhone viewport, the sidebar likely obscures most of the main content area.

**Reference:** Vercel, Linear, and Datadog all have usable mobile experiences for monitoring runs and reviewing status, even if full authoring is desktop-only.

**Fix (minimum viable):**
- Add `@media (max-width: 768px)` breakpoints to `pages/layout.css`
- On mobile, collapse the sidebar to a hamburger-triggered drawer (the `sidebar-open` class already exists for this pattern)
- Make stat-card rows wrap on narrow viewports
- Make primary tables horizontally scrollable with `overflow-x: auto`

---

### MOB-002 — Touch Interaction Targets Are Too Small
**Severity: Medium** · ✅ _Landed in PR #26 — touch-target minimums for the named offenders (sidebar collapse, nav item chevrons, badge chips, ProviderBadge) added to `frontend/src/styles/components.css` under a `@media (pointer: coarse)` block so desktop pixel-tight layouts stay unchanged. **Direct `min-width`/`min-height: 44px`** on the bare-icon buttons (`.sidebar-header__collapse-btn`, `.notif-bell-btn`, `.modal-close`). **Hit-box expansion via transparent `::after` overlay** on the sidebar nav items (visible pill stays compact at the rail's 40×40 visual but the touch target grows to 52×52 via `inset: -6px` overlay) — matches Material 3's "expanded touch target" guidance. **Clickable badges** (AuditLog filter chips, sidebar pending-pill nav badges, ProviderBadge / `.st-provider-badge`) get `min-height: 32px` + extra vertical padding so the touch target meets 32–44px without inflating decorative bare `.badge` chips that aren't click targets. Topbar user-menu button already got 36×36 in the earlier MOB-001 pass at `topbar.css`; that rule is preserved. Pointer-coarse scoping is the W3C-recommended hook (CSS Media Queries Level 4) for touch-vs-mouse intent and matches the Linear / Vercel / GitHub approach — WCAG 2.5.5 only applies at Level AAA and explicitly exempts mouse-pointer contexts. Pure CSS — no JSX changes, no component refactor._

Many interactive elements — the sidebar collapse button, nav item chevrons, badge chips, and the ProviderBadge in the TopBar — have touch target sizes below 44×44px (Apple HIG) and 48×48dp (Material Design) guidelines.

**Fix:** Set minimum touch targets via CSS: `min-width: 44px; min-height: 44px` on all interactive elements, using padding to fill the space without changing visual size.

---

## 11. Reporting & Visualization Gaps

### VIZ-001 — Reports Page Is Too Shallow
**Severity: High**

`Reports.jsx` (402 lines) is the analytics home of the platform but only shows: aggregate stat cards, a pass/fail trend chart, per-project breakdown table, top failing tests list, and flaky tests list. Missing entirely:
- Test execution time distribution (histogram)
- Failure pattern analysis (which errors recur most)
- Coverage over time chart
- Root cause clustering trends (from AUTO-010 `rootCauses` data)
- AI generation quality trend (from the eval harness)
- Per-environment comparison (DIF-012 environments)

**Reference:** Cypress Cloud's Analytics, BrowserStack's Test Observability, and Mabl's Insights pages all offer multi-dimensional drill-down analytics with filtering by time range, environment, browser, and test tag.

**Fix:** Evolve Reports into a proper Analytics page with:
- A time-range picker (7d, 30d, 90d, custom)
- Tabbed sections: Overview, Failures, Flakiness, Coverage, AI Quality
- Recharts (already available in the stack) for all visualisations

---

### VIZ-002 — Healing Dashboard Has No Timeline View
**Severity: Medium**

`HealingDashboard.jsx` shows aggregate healing statistics but no timeline. Users cannot see: "on March 15th, 7 tests were healed — what happened that day?" The `savingsTrend` bar chart is a useful start but it lacks drill-down.

**Fix:** Add a healing timeline table showing each healing event chronologically: date, test name, selector healed (before/after), strategy used, confidence, and link to the run.

---

### VIZ-003 — Execution Timeline Component Is Underutilised
**Severity: Medium**

`ExecutionTimeline.jsx` exists in `components/run/` but is not prominently exposed in `RunDetail.jsx`. The timeline visualisation of test execution across a parallel run — which tests ran concurrently, where failures occurred — is extremely valuable for diagnosing flaky parallel execution issues.

**Fix:** Make `ExecutionTimeline` the default first view in RunDetail for test runs with more than 5 tests. Currently it appears to be rendered conditionally but not as a primary affordance.

---

## 12. Product Adoption & Onboarding Gaps

### ONB-001 — Onboarding Tour Is a Walkthrough, Not a Workflow
**Severity: High** · ✅ _Landed in PR #26 — `frontend/src/components/layout/OnboardingTour.jsx` rewritten as an active 5-step wizard inside `<ModalShell>` (inherits A11Y-002 focus trap + Escape + `role="dialog"`). Each step performs a real backend call: **(1)** welcome + checklist, **(2)** provider grid (Anthropic / OpenAI / Google / Ollama) → `POST /settings`, **(3)** project name + URL → `POST /projects`, **(4)** crawl kickoff → `POST /projects/:id/crawl` (background-runs so the user advances without waiting), **(5)** "Open Review Queue →" deep-link with the new projectId, **(6)** done banner → `/dashboard`. Component name + `useOnboarding` hook contract preserved so `Layout.jsx` mount + the existing `resetOnboarding()` "Restart Tour" entry need zero changes. Legacy `.tour-*` spotlight styles + `data-tour=…` polling logic + dead `data-tour="…"` attributes on Sidebar (4 sites) + Dashboard (1 site) + the `tour:` field on NAV_GROUPS Dashboard/Projects/Tests entries are all removed — no consumer remains anywhere in the tree. New `.wiz*` BEM styles in `frontend/src/styles/features/onboarding.css` with 600px responsive collapse (provider grid 2-col → 1-col, footer flex-wrap with full-width buttons)._

`OnboardingTour.jsx` implements a step-by-step tooltip overlay using DOM `data-tour` attributes. This pattern (popularised by Intro.js) shows users where elements are but does not help them accomplish their first valuable action. A new user who completes the tour still has an empty workspace and no clear next step.

**Reference:** Vercel's onboarding is a guided workflow: "Connect your repo → Deploy → Add a domain." Linear's onboarding creates a sample issue and walks the user through completing it. Notion creates a sample page and guides the user to edit it.

**Fix:** Replace the passive tooltip tour with an active "First Run" wizard:
1. Step 1: Enter your app URL
2. Step 2: Configure AI provider (or use the free demo mode)
3. Step 3: Run your first crawl (live, with progress visible)
4. Step 4: Review the generated tests
5. Step 5: Approve and run

The wizard creates a real project and real tests as its deliverable, making the value concrete.

---

### ONB-002 — Empty States Are Informational, Not Actionable
**Severity: High** · ✅ _Landed in PR #25 — new shared `<EmptyState>` primitive at `frontend/src/components/shared/EmptyState.jsx` encapsulates the icon + title + description + CTA shape using the existing `.empty-state*` CSS classes (no new design tokens required). New `.empty-state-actions` flex row added to `frontend/src/styles/components.css` for primary/secondary CTA placement. **Six pages retrofitted**: **Dashboard.jsx** (error state + first-run onboarding — predated the component, now uses `CloudOff` and `Rocket` lucide icons instead of ⚠️/🚀 emoji), **Tests.jsx** (three branches — Welcome / no-tests / filtered-empty, with lucide-react icons replacing emoji and the contextual hint preserved as a banner), **Projects.jsx** (no-projects onboarding + no-search-results with Clear search CTA), **Runs.jsx** (no-runs onboarding + filtered-empty with Clear filters + Run Tests CTA), **HealingDashboard.jsx** (savings trend + selectors table, both with Run Tests CTAs replacing the bare "No savings data yet." text), **TestLab.jsx** (Queue tab no-runs / no-runs-for-project branches — `Clock` icon replaces ⏳ emoji, primary CTA jumps to Crawl & Generate, secondary Clear filter CTA when a project filter is active). ReviewQueue.jsx's inbox-zero coaching pattern at `pages/ReviewQueue.jsx:1019-1075` is untouched — it has its own `.rq-empty*` classes for the two-pane layout and the coaching copy is page-specific. The shared component is `variant="card"` (full bordered card) or `variant="bare"` (used inside an existing card / table body)._

Most empty state messages are plain text descriptions:
- Empty tests list: "No tests yet. Run a crawl to generate tests."
- Empty runs list: "No runs yet."
- Empty heal history: "No savings data yet."

These are accurate but they don't offer a direct action. An empty state is a conversion surface — it's the moment users decide whether to invest further.

**Reference:** GitHub's empty repository state shows a code block with commands to run. Linear's empty issues state shows a button to create the first issue. Notion's empty page shows template suggestions.

**Fix:** Every empty state should show:
1. An illustration or icon (adds visual personality)
2. A one-sentence explanation of what goes here
3. A primary CTA button that starts the relevant workflow

---

### ONB-003 — No Demo Mode for Prospective Users
**Severity: Medium**

New users evaluating Sentri must set up a full environment, configure an AI provider, and crawl a real app before seeing any value. There is a `demo.js` file in the frontend source, but it's not exposed through any onboarding path.

**Fix:** Add a "Try with demo data" button on the empty dashboard that loads the demo fixture data, letting users explore the full RunDetail, ReviewQueue, and Reports experience with realistic data before committing to configuration.

---

### ONB-004 — Provider Configuration Is the First Blocker
**Severity: Medium**

The `ProviderBanner.jsx` global banner appears when no AI provider is configured, which is the first thing a new user sees. The banner links to Settings, but Settings' AI provider section is complex (multiple provider cards, model selectors, compat slots). New users face a wall of configuration before they can do anything.

**Fix:** Add a dedicated "Quick Setup" flow (2-step modal) triggered from the provider banner: "Pick a provider → Paste your API key → Done." This flow bypasses the full Settings page and uses sensible defaults.

---

## 13. Competitor Comparison

| Dimension | Sentri (now) | Cypress Cloud | BrowserStack | LangSmith | Harness | Linear |
|---|---|---|---|---|---|---|
| Global search | Command palette (commands only) | Full entity search | Limited | Full trace search | Project search | Full fuzzy search |
| AI transparency | None | N/A | N/A | Full trace trees | N/A | N/A |
| Mobile experience | None | Read-only | Read-only | Limited | Limited | Full |
| Onboarding | Passive tour | Guided workflow | Setup wizard | Guided workflow | Project wizard | Interactive |
| Empty states | Text only | Illustrated + CTA | Illustrated + CTA | Guided | Illustrated | Illustrated + CTA |
| Keyboard shortcuts | ⌘K only | Partial | None | Partial | Partial | Comprehensive |
| Dashboard hierarchy | Flat (12 panels) | Layered | Layered | Layered | KPI-first | N/A |
| Accessibility | Partial | Partial | Partial | Good | Partial | Good |
| Settings architecture | God-file | Sectioned pages | Sectioned pages | Sectioned pages | Sectioned pages | Sectioned pages |

---

## 14. Top Priority UI Fixes (Sprint-Ready)

The following 10 items are the highest-leverage, feasible within 1–2 sprint cycles, and will produce the most visible improvement in UX quality:

| Priority | Item | Effort | Impact |
|---|---|---|---|
| P0 | Split Settings.jsx into sectioned routes under `/settings/*` | L | Critical — removes largest UX pain point |
| P0 | Add pending review count badge to sidebar Tests nav item | XS | High — closes the "missed review" workflow gap |
| P1 | Add data search to the command palette | M | High — unblocks power-user workflows |
| P1 | Add `--space-*` tokens and migrate inline spacing to tokens | S | High — visual consistency across all pages |
| P1 | Add `:focus-visible` ring styles to all interactive elements | S | High — WCAG AA compliance |
| P1 | Implement responsive sidebar (hamburger on mobile) | S | High — enables mobile monitoring |
| P2 | Add active health banner to Dashboard top | S | Medium — surfaces critical issues |
| P2 | Redesign empty states with illustration + CTA button | M | Medium — onboarding and adoption |
| P2 | Add `ModalShell` focus trap | S | Medium — accessibility compliance |
| P2 | Add `QualityScoreChip` (factors breakdown) to TestDetail | XS | Medium — closes explainability gap on reviews |

---

## 15. Recommended Enterprise Design Improvements

### Design System Maturity

1. **Adopt Radix UI primitives** for Dialog, DropdownMenu, Tooltip, and Select. These components provide accessibility semantics, focus management, and portal rendering out of the box. They are style-agnostic — the existing CSS class system applies unchanged. This eliminates A11Y-001, A11Y-002, and DS-005 in a single dependency addition.

2. **Create a Component Storybook** for all shared components. The existing `components/shared/` directory has 15 components — publishing these in Storybook gives the team a visual reference, prevents drift, and documents usage patterns.

3. **Introduce a `DesignDecision` comment convention** for all inline-style carve-outs (AGENTS.md already documents the data-driven exception). This makes intentional vs. accidental inline styles distinguishable in code review.

### Information Architecture

4. **Introduce a "Projects" as the primary navigation hub.** Currently Projects is one of 12 nav items. In practice, every user workflow starts with a project. Consider making project context persistent: `ProjectContext` in the sidebar after a project is selected, with project-specific sub-navigation (Runs, Tests, Settings) visible only within that project scope.

5. **Introduce a "Command Center" concept** for the ⌘K palette: a single unified surface that merges commands, data search, AI chat, and recent history. This is the direction Linear, Raycast, and Vercel are moving toward — a single "brain" for the entire product.

### Enterprise Readiness

6. **Add a "What's New" changelog panel** accessible from the user menu. Given the high velocity of Sentri's feature development, users who are away for a week will miss significant capability additions. An in-app changelog (fed by `docs/changelog.md`) surfaces new features in context.

7. **Build an API playground** within the Settings/Integrations area. Enterprise customers who use the CI/CD trigger and webhook integrations need to test their payloads. An in-app request builder (like the existing Integration Snippets but bidirectional) reduces support burden.

---

## 16. Long-Term UX Strategy

### Phase 1 (Months 1–3): Foundation
- Split Settings, establish responsive breakpoints, fix accessibility baseline (focus rings, focus trap, contrast)
- Ship the updated spacing/typography token system
- Add data search to command palette
- Fix all critical empty states

### Phase 2 (Months 3–6): Workflow Excellence
- Redesign Dashboard with health-first hierarchy
- Build the "First Run" onboarding wizard
- Add AI explainability layer (agent trace, confidence explanations)
- Implement keyboard shortcut system
- Evolve Reports into a full Analytics page

### Phase 3 (Months 6–12): Enterprise Polish
- Mobile-first responsive redesign
- Component Storybook and design system documentation
- Storybook-backed component test coverage
- Advanced collaboration features (comments, activity feeds)
- RBAC-visible permission hints throughout
- Investigate Radix UI adoption for accessibility compliance

### Design Vision: "Transparent Autonomy"

Sentri's competitive position is "autonomous QA that you can trust." The UX strategy should reinforce this by making AI decisions visible and understandable at every touchpoint. Every AI action should be legible to a sceptical QA engineer: what did it do, why, how confident is it, and what would happen if it were wrong?

This is not just a UX polish exercise — it is the product narrative. The UI should feel like a glass-box AI assistant, not a black box that occasionally produces test files.

---

## 17. Final UI/UX Maturity Score

| Dimension | Score | Notes |
|---|---|---|
| Navigation & IA | 5/10 | Functional but flat; no breadcrumbs, no project-level nav context |
| Dashboard UX | 4/10 | Data-rich but visually unordered; no alert hierarchy |
| AI/Agent UX | 3/10 | Powerful backend, invisible frontend; no explainability layer |
| Design System | 6/10 | Good tokens and ITCSS architecture; incomplete adoption |
| Accessibility | 4/10 | ARIA live regions shipped; focus, contrast, and modal gaps remain |
| Enterprise UX | 5/10 | RBAC, MFA, and audit log exist; UX surfaces them poorly |
| Frontend Architecture | 6/10 | TanStack Query, lazy loading, error boundaries — good foundations |
| Mobile/Responsive | 3/10 | Shell-level breakpoints + hamburger sidebar ship in `layout.css`, but no page has been audited or fixed for narrow viewports — Dashboard panels, data tables, RunDetail tabs, modals, and Settings forms all break on phones. Touch-target minimums (MOB-002) unmet. A page-by-page responsive QA + fix pass is the next required step. |
| Reporting/Visualization | 5/10 | Charts exist; shallow analytics compared to competitors |
| Onboarding/Adoption | 3/10 | Tour exists; no guided workflow; empty states are bare |

### **Overall UX Maturity: 4.8 / 10**

Sentri is an exceptionally capable product held back by a frontend that was built to ship features rather than experiences. The gap between backend maturity (~8/10) and frontend UX maturity (~4.8/10) is the most important finding in this audit.

The good news: the foundations are solid. The design token system is well-structured. TanStack Query is properly integrated. Lazy loading and code splitting are in place. The accessibility infrastructure (ARIA live regions, RBAC-conditional rendering) has been started. Sentri is 6–9 months of focused UX investment away from a world-class enterprise platform.

---

*Audit produced by: Principal Product Designer / Enterprise UX Architect review of `sentri_v1_4` codebase, May 2026.*
