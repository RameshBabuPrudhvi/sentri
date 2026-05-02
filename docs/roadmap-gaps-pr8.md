# Roadmap Gaps — Identified during PR #8 review (AUTO-017)

> Living document. Each item is sized so it can be promoted to `NEXT.md` Current PR
> without further triage. Items are ordered by **product value ÷ effort**.
> Slack integration is intentionally excluded (deferred per product call).

## 1. AUTO-017 follow-ups (highest leverage — finishes a half-shipped feature)

### AUTO-017.1 — Inject web-vitals via `addInitScript` (correctness fix) ✅ bundled in PR #8
**Why it mattered:** The original `captureWebVitals()` ran *after* the test, so
LCP/CLS measurements were unreliable or `null` and budgets could silently pass
on slow pages — the feature gave false confidence.
**Shipped:** New `registerWebVitalsInitScript(context)` helper in
`backend/src/runner/pageCapture.js` installs the web-vitals IIFE + observer
bootstrap via `context.addInitScript()` at context creation, so LCP / CLS /
TTFB observers are active from the first byte of the navigation and accumulate
on `window.__sentriVitals`. `captureWebVitals(page)` now reads from that
global with an 800ms cap that early-exits as soon as LCP + TTFB + CLS are
populated (replacing the unconditional 1200ms wait — saves ~400ms × N tests
typical, up to 1s × N when metrics arrive quickly). Wired in
`backend/src/runner/executeTest.js` right after `browser.newContext()`.
INP continues to stay `null` for non-interactive tests — the evaluator's
`Number.isFinite()` guard already skips those silently.

### AUTO-017.2 — Web Vitals budgets configuration UI ✅ bundled in PR #8
**Why it mattered:** CRUD endpoints shipped without a React panel — users would
have had to `curl PATCH` to configure. Same backend-without-UI debt pattern as
AUTO-016 → AUTO-016b.
**Shipped:** New `frontend/src/components/project/WebVitalsBudgetsPanel.jsx`
mirrors `QualityGatesPanel` exactly: load via `api.getWebVitalsBudgets`, save
via `api.updateWebVitalsBudgets`, clear via `api.deleteWebVitalsBudgets`
(three new helpers added to `frontend/src/api.js`). Form has four inputs
(LCP / CLS / INP / TTFB) with inline Google "Good / Needs-Improvement"
reference values, a dirty-check that disables Save when nothing changed, and
read-only mode for Viewer roles. Wired into `frontend/src/pages/ProjectDetail.jsx`
Settings tab below the existing Quality Gates panel. Empty-form save calls
DELETE so users don't hit the server's "must include at least one of: lcp,
cls, inp, ttfb" 400.

### AUTO-017.3 — Web Vitals trend chart + per-page breakdown
**Why it matters:** Single-run violation cards are tactical; teams need
*"is our LCP getting worse week over week?"*. Calibre/SpeedCurve's core view.
**Fix:** New `GET /api/v1/projects/:id/web-vitals/trends?days=30` aggregating
`runs.webVitalsResult` + per-test `result.webVitals`. Render a `<TrendChart>` on
the dashboard with p75 lines per metric and Good/NI/Poor bands.
**Effort:** M · **Lays groundwork for §3 below.**

---

## 2. Process / authoring gaps

### PROC-001 — Bundle backend + UI in one PR
**Pattern observed:** AUTO-016 → AUTO-016b, AUTO-017 → (no UI yet). Backend ships,
UI lags, users can't discover the feature. Update `REVIEW.md` and `NEXT.md`
templates to require: *"if the PR adds an API endpoint, it must add the UI surface
that calls it — or explicitly justify the split with a follow-up issue ID."*
**Effort:** XS (docs only).

### PROC-002 — Automate sprint-tracker hand-off
**Pattern observed:** Lifeguard repeatedly catches `NEXT.md` / `ROADMAP.md`
mechanical violations (4 entries in Recently completed, count not decremented,
Current PR body not replaced). Add `scripts/promote-sprint-item.mjs` that takes a
shipped-item ID + PR number and: (a) moves the row in ROADMAP, (b) decrements
Remaining count, (c) trims NEXT.md Recently completed to 3 entries, (d) replaces
Current PR block from a queue item.
**Effort:** S · **Saves ~30min per PR + recurring review noise.**

---

## 3. Cross-feature investments (compound returns)

### MET-001 — Shared time-series metrics table + `<TrendChart>` component
**Why it matters:** Web Vitals (AUTO-017), flaky-rate (DIF-004), a11y violations
(AUTO-016), pass-rate, MTTR — all want the same "value over time per project"
shape. Today each feature would build its own aggregation. Build it once.
**Fix:** Generic `metric_samples` table `(projectId, metricKey, ts, value, tags JSON)`,
a `recordMetric()` helper, and a reusable `<TrendChart metricKey=...>` React
component with band overlays + threshold lines.
**Effort:** M · **Unblocks AUTO-017.3, DIF-004 dashboard, future analytics.**

### AUTO-001 — Risk-based test selection (already on roadmap, re-prioritise)
**Why it matters:** This is the feature that substantiates Sentri's "autonomous"
positioning. Without it, the AI-generation pipeline produces tests that then run
in arbitrary order — same as any other Playwright runner. Highest *narrative*
value of any planned item.
**Effort:** L · **Existing entry:** `ROADMAP.md:988`.

---

## 4. Enterprise unlock (procurement blockers)

### DIF-008 — Jira / Linear bidirectional sync
Existing roadmap entry at `ROADMAP.md:854`. Reuse `FEA-001` notification
dispatcher pattern. Auto-create issue on failure, update status on subsequent
pass. Required by every enterprise QA buyer.
**Effort:** L

### SEC-005 — SAML 2.0 / OIDC SSO
Existing roadmap entry at `ROADMAP.md:450`. Hard procurement blocker for any
buyer with Okta/Azure AD. TOTP MFA (already shipped) is necessary but not
sufficient — SSO replaces login, not augments it.
**Effort:** L

### INT-002 — GitHub PR check comments
**Why it matters:** Every modern QA tool posts a GitHub Check on the PR with a
deep-link to the run. Today Sentri only sends a webhook callback — the PR author
never sees the result without leaving GitHub.
**Fix:** GitHub App-based check run posting, parameterised by the trigger token.
Status: queued → in_progress → success/failure with summary markdown.
**Effort:** M

---

## 5. Capabilities not yet tracked anywhere

### CAP-001 — Data-driven testing (parameterized iterations)
Industry standard (Cypress, Playwright, Mabl). Generated tests are single-shot;
add CSV/JSON fixture upload + iteration UI so one test runs against N rows.
**Effort:** M

### CAP-002 — Distributed test sharding across runners
Single-host parallelism (1–10 contexts) caps suite size. Industry tools (Cypress
Cloud, Playwright shard mode) split across runners. Requires BullMQ runner
pool extension (INF-003 foundation already shipped).
**Effort:** L

### CAP-003 — Secret scanner on generated tests
LLM-generated test code can embed credentials harvested during crawl
(Authorization headers, API keys). Add a `gitleaks`-style scanner in the
pipeline `validate` stage; reject + flag tests that fail.
**Effort:** S · **Real risk** given the AI-generation positioning.

### CAP-004 — Self-healing telemetry dashboard
Sentri claims self-healing as a differentiator but surfaces no win-rate metrics.
Add a `/healing` page: per-strategy success rate, top-healed selectors, savings
estimate (tests-that-would-have-failed). Closes the loop on the existing
`healingRepo` data.
**Effort:** S

---

## Suggested next 4 sprints

| Sprint | Item | Rationale |
|---|---|---|
| Now | **DIF-005** (already promoted) | Biggest single UX unlock |
| +1 | **AUTO-017.1 + .2 bundled** | Finishes the half-shipped feature; fixes a correctness bug before users rely on it |
| +2 | **MET-001 + AUTO-017.3** | One infra investment unlocks 3+ future dashboards |
| +3 | **CAP-003** (secret scanner) | Closes a real security gap intrinsic to LLM-generated code; small effort |

Then alternate enterprise unlocks (SEC-005, DIF-008, INT-002) with autonomous
features (AUTO-001, AUTO-002) based on customer signal.
