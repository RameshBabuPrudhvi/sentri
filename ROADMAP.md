# Sentri — Engineering Roadmap

> **Last revised:** April 2026 · `sentri_v1_4`
> **Stack:** Node.js 20 (ESM) · Express 4 · SQLite → PostgreSQL · Playwright · React 18 · Vite 6
>
> This document is the single source of truth for all planned and in-progress engineering work.
> It is a full rewrite based on a comprehensive codebase audit, resolving numbering gaps, orphaned items,
> duplicate entries, and stale statuses present in prior versions.

---

## ⚡ Agent fast path

> **Working on the next PR? Read [`NEXT.md`](./NEXT.md) instead — it has the current item spec, files to change, and acceptance criteria. You do not need to read further in this file.**
>
> **AI-provider routes — ✅ shipped.** All 4 bundles landed (PR #22, #23). Plan at [`docs/roadmap/ai-provider-bundle.md`](./docs/roadmap/ai-provider-bundle.md) · operator guide at [`docs/guide/provider-routes.md`](./docs/guide/provider-routes.md).
>
> **Autonomous multi-agent collaboration — ✅ shipped.** All 5 bundles landed (PR #34–#38). Full plan + exit criteria at [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md).
>
> Come back here only to: look up a specific item by ID (Ctrl+F the ID e.g. `DIF-008`), check completed work history, or review phase/competitive context.
>
> **Current sprint:** MNT-015 (Browser pool reuse + per-tenant AI rate limiting) — promoted after INF-009 (Helm chart + K8s readiness/liveness + DR playbook) landed in PR #30. **AUTO-023 reframed** from a LangGraph-style DAG runner to a 5-bundle multi-agent collaboration plan (see [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md)) — the supervisor orchestrator (Bundle 4) supersedes the DAG runner; Bundle 1 is parallel-safe with MNT-015. Queue: AUTO-023 (multi-agent collaboration — scaffolding already shipped via migration 058 + Task 2/Task 3 conversation feed; the legacy `dagRunner.js` deliverable is **dropped**) slot 1, AUTO-022b (eval harness recording — deferred pending LLM API key + 4–8h maintainer session) slot 2, AUTO-014 (test dependency + execution ordering) slot 3, DIF-008 (Jira / Linear issue sync) slot 4. AI-provider routes Bundles 2 / 3 / 4 landed in PR #23 and are no longer queued.
>
> **Blockers:** none remaining · **Remaining:** ~12 planned items across Phases 2–5 + Maintenance. The **AI platform foundation** track (originally AI-002 → AI-007) shipped end-to-end across PR #20 + PR #22 + PR #23: AI-002 + AI-003 (provider modularization + cost tracking) ✅ PR #20, AI-005 + B1.x (multi-agent dispatch + per-workspace provider routes foundation) ✅ PR #22, B2 + B3 + B4 (migration to `routeId` + capability auto-probe + per-route pricing + per-request log with PII redaction + Settings UI + JSON import/export + key rotation + rate-limit & spend caps + response cache + audit log viewer + compat-slot migration + cleanup sweep + dashboards + load tests + route groups) ✅ PR #23. The legacy AI-004 / AI-006 / AI-007 IDs are subsumed: AI-004 (agent role config schema) shipped inline with AI-005 in PR #22 (see migration 037); AI-006 (per-role eval harness) + AI-007 (cost governance) folded into B2 (per-request log + per-route pricing) and B3 (rate-limit + spend caps) respectively in PR #23.
>
> **Recent ships** (newest first; full details in the Completed Work Summary table — never inline implementation prose here, that's what the table is for): INF-009 PR #30 · AI routes B2+B3+B4 PR #23 · B1.x routes foundation PR #22 · AI-005 PR #22 · AI-002 + AI-003 PR #20 · AUTO-009 PR #19 · MNT-001 + AUTO-022 PR #17 · INF-007 PR #14 · SEC-007 PR #12 · SEC-006 PR #11 · SEC-004 PR #10 · AUTO-008 PR #9 · DIF-015c Gaps 2/3/5/6 PR #8 · AUTO-010 PR #6 · DIF-012 PR #2 · CAP-001 PR #1 · CAP-002 PR #3 · AUTO-004 PR #18 · INT-002b PR #17 · AUTO-001 + INT-002 PR #15 · AI-001 PR #14 · CAP-003 + AUTO-002 + AUTO-002b + AUTO-015 + AUTO-015b PR #12 · DIF-015b Gap 3 + DIF-015c Gap 1 PR #11 · AUTO-003 + AUTO-003b + AUTO-019 PR #10 (legacy) · AUTO-017.3 + PROC-001 + DIF-005 PR #9 (legacy) · CAP-004 + MET-001 + AUTO-017 + UI-REFACTOR-001 PR #8 (legacy). PROC-002 + PROC-003 reverted in PR #10 (legacy).

---

## How to Read This Document

| Symbol | Meaning |
|--------|---------|
| 🔴 Blocker | Must ship before any team or production deployment |
| 🟡 High | Ship within the next two sprints |
| 🔵 Medium | Materially improves quality, DX, or coverage |
| 🟢 Differentiator | Builds competitive moat; schedule freely after blockers |
| ✅ Complete | Merged to `main`; included in summary only |
| 🔄 In Progress | Active branch or current sprint |
| 🔲 Planned | Scoped and ready to start |

**Effort sizing** (2-engineer team): `XS` < 1 day · `S` 1–2 days · `M` 3–5 days · `L` 1–2 weeks · `XL` 2–4 weeks

---

## Completed Work Summary

The following items have been verified complete against the codebase and are **not** repeated below.

> **Naming note:** Items numbered `MAINT-*` are legacy from prior roadmap versions. The current convention is `MNT-*`. Old IDs are preserved in PR descriptions and git history — do not rename them. Use `MNT-*` for all new maintenance items.

| ID | Title | PR / Commit                                                     |
|----|-------|-----------------------------------------------------------------|
| MNT-015 | Browser pool reuse + per-tenant cost-weighted AI rate limiting (warm Playwright pool, fresh-context-per-acquire, `RateLimit-*` headers, graceful-shutdown drain). | PR #1 |
| AUTO-023 | Autonomous multi-agent collaboration — 5-bundle plan (envelope schema → linear handoff → reviewer↔author loop → supervisor orchestrator → shared memory + tool calling). | PR #34, #35, #36, #37, #38 |
| INF-009 | Helm chart + Kubernetes readiness/liveness probes + disaster-recovery playbook (nightly `pg_dump -Fc` to S3, RTO < 4h / RPO < 24h). | PR #30 |
| S3-02 | Shadow DOM support in crawler | PR #55                                                          |
| S3-04 | DOM stability wait before snapshot | PR #55                                                          |
| S3-08 | Disposable email address filter | PR #55                                                          |
| ENH-004 | Persist AI provider keys encrypted in database | PR #80                                                          |
| ENH-005 | Global API rate limiting (three-tier) | PR #78                                                          |
| ENH-006 | Test scheduling engine (cron + timezone) | PR #86                                                          |
| ENH-007 | Signed URL tokens for artifact serving | PR #79                                                          |
| ENH-008 | Move `runs.logs` to append-only `run_logs` table | PR #86                                                          |
| ENH-010 | Pagination on all list API endpoints | PR #78                                                          |
| ENH-011 | CI/CD webhook receiver + GitHub Actions integration | PR #86                                                          |
| ENH-013 | Persist password reset tokens in the database | PR #78                                                          |
| ENH-020 | Soft-delete with recycle bin for tests, projects, runs | PR #81                                                          |
| ENH-021 | `userId` + `userName` on activities for full audit trail | PR #78                                                          |
| ENH-024 | Frontend code splitting (React.lazy + Suspense) | PR #78                                                          |
| ENH-027 | Global React Error Boundary with crash reporting | PR #79                                                          |
| ENH-029 | Diff view for AI-regenerated test code | PR #81                                                          |
| ENH-030 | Secrets scanning in CI pipeline (Gitleaks) | PR #79                                                          |
| ENH-034 | Empty crawl result `completed_empty` status | PR #86                                                          |
| ENH-035 | No-provider-configured global banner (ProviderBanner) | PR #85                                                          |
| MAINT-010 | Semantic deduplication via TF-IDF + fuzzy matching | PR #55                                                          |
| MAINT-011 | Feature-sliced frontend component architecture | PR #81                                                          |
| MAINT-012 | Deep test validation (locator, action, assertion) | PR #57                                                          |
| MAINT-013 | Graceful shutdown with in-flight run draining | PR #86                                                          |
| MAINT-016 | Renovate for automated dependency updates | Renovate                                                        |
| SEC-001 | Email verification on registration | PR #87                                                          |
| INF-001 | PostgreSQL support with SQLite fallback | PR #87                                                          |
| INF-002 | Redis for rate limiting, token revocation, and SSE pub/sub | PR #87                                                          |
| INF-003 | BullMQ job queue for durable run execution | PR #92                                                          |
| FEA-001 | Teams / email / webhook failure notifications | PR #92                                                          |
| SEC-002 | Nonce-based Content Security Policy | PR #92                                                          |
| SEC-003 | GDPR / CCPA account data export and deletion | PR #92                                                          |
| INF-005 | API versioning (`/api/v1/`) with 308 redirects | PR #94                                                          |
| FEA-003 | AI provider fallback chain + circuit breaker | PR #94                                                          |
| DIF-003 | Mobile viewport / device emulation | PR #94                                                          |
| DIF-011 | Coverage heatmap on site graph | PR #94                                                          |
| DIF-014 | Cursor overlay on live browser view | PR #94                                                          |
| DIF-016 | Step-level timing and per-step screenshots | PR #94                                                          |
| AUTO-013 | Stale test detection and cleanup | PR #99                                                          |
| MNT-007 | ARIA live regions for real-time updates | PR #99                                                          |
| DIF-004 | Flaky test detection and reporting | PR #99                                                          |
| MNT-009 | Tiered prompt system for local models (Ollama) | PR #100                                                         |
| MNT-010 | Re-run button on Run Detail page for crawl/generate runs | PR #100                                                         |
| FEA-002 | TanStack React Query data layer | PR #107                                                         |
| MNT-011 | Persist crawl/generate dialsConfig on run record | Verified in PR #107 (fix landed in an earlier untracked commit) |
| ACL-001 | Multi-tenancy: workspace ownership on all entities | PR #87                                                          |
| ACL-002 | Role-based access control (Admin / QA Lead / Viewer) | PR #87                                                          |
| INF-004 | OpenAPI specification and Swagger UI | PR #94                                                          |
| DIF-001 | Visual regression testing with baseline diffing | PR #94                                                          |
| DIF-002 | Cross-browser testing (Firefox, WebKit / Safari) | PR #94                                                          |
| DIF-002b | Cross-browser polish: browser-aware baselines, UI badges, CI coverage | PR #107, PR #110                                                |
| DIF-015 | Interactive browser recorder for test creation | PR #94                                                          |
| AUTO-007 | Geolocation / locale / timezone testing | PR #94                                                          |
| DIF-006 | Standalone Playwright export (zero vendor lock-in) | PR #1                                                           |
| AUTO-005 | Automatic test retry with flake isolation | PR #2                                                           |
| DIF-013 | Anonymous usage telemetry (PostHog + opt-out) | PR #3                                                           |
| AUTO-006 | Network condition simulation (slow 3G / offline) | PR #3                                                           |
| DIF-015b | Recorder selector quality: naming alignment, nth=N disambiguation, Playwright `InjectedScript` delegation with hand-rolled fallback, iframe `frameLocator` emission, shadow-DOM via InjectedScript delegation | PR #3, PR #120 (Gaps 1), PR #4 (Gap 2), PR #11 (Gap 3 — `frameLocator('iframe[src*=…]').first()` in `actionsToPlaywrightCode`; shadow-DOM covered by Playwright's InjectedScript on the primary path) |
| DIF-015c (Gap 1) | Recorder: paste action as single `fill` + opt-in keyboard shortcut capture — `paste` listener emits one `safeFill` (500-char truncated), `shortcutCaptureBudget` + `__sentriRecorderSetShortcutBudget` expose an N-keystroke arming window, frontend "Record keyboard shortcut" button in `RecorderModal`, backend accepts `shortcutCapture` in `/record/:sessionId/input` | PR #11 |
| DIF-015c (Gaps 2 + 3 + 5 + 6) | Recorder completion bundle — `assertCount` / `assertHasClass` actions, pick-by-click UX, pause/resume/undo, device profiles (launch + mid-session), opt-in stealth profile. | PR #8 |
| AUTO-016 (backend) | Accessibility testing — axe-core crawl scan + persistence (frontend `CrawlView` panel tracked as AUTO-016b) | PR #121                                                         |
| MNT-006 | Object storage abstraction — local-disk default + S3/R2 pre-signed URLs for screenshots, visual-diff baselines, and diffs (dual-write to local disk in s3 mode) | PR #122                                                         |
| DIF-007 | Conversational test editor connected to /chat (in-app "Edit with AI" panel on TestDetail with diff preview + one-click apply) | PR #123                                                         |
| AUTO-016b | Frontend CrawlView accessibility panel + dashboard "Top Accessibility Offenders" rollup | PR #1                                                           |
| ENH-036 | Project credential editing after creation (`PATCH /api/v1/projects/:id`) | PR #127                                                         |
| ENH-036b | Auto-detect login form fields — semantic-first locator waterfall removes need for hand-authored CSS selectors | PR #127                                                         |
| INF-006 | Persistent storage on hosted deployments (Render disk blueprint + ephemeral-storage warning) | PR #1                                                           |
| AUTO-012 | SLA / quality gate enforcement — per-project `qualityGates` config, run-time evaluator, `gateResult` on runs + trigger responses, `QualityGatesPanel` under ProjectDetail → Settings, per-run `<GateBadge>` on Runs list / RunDetail header, inline violation panel on RunDetail, GH Actions + GitLab CI consumer examples in `docs/guide/ci-cd-triggers.md` that exit non-zero on `gateResult.passed === false` | PR #2                                                           |
| AUTO-017 | Web Vitals performance budgets — per-project `webVitalsBudgets` config (`{ lcp, cls, inp, ttfb }`), CRUD endpoints under `/api/v1/projects/:id/web-vitals-budgets` (`qa_lead`+ on mutations, registered in `permissions.json`), `captureWebVitals(page)` injects the locally-bundled `web-vitals@4` IIFE (no CDN dependency) and records per-page LCP/CLS/INP/TTFB — runs on the success path independent of the `skipVisualArtifacts` gate so assertion-ending tests still contribute metrics. `evaluateWebVitalsBudgets()` in `testRunner.js` persists `webVitalsResult: { passed, violations }` on the run, surfaced in trigger response + callback payload and as a per-test-filtered violations card on RunDetail. Migration `015_web_vitals_budgets.sql` adds `projects.webVitalsBudgets` + `runs.webVitalsResult`. CI consumer docs in `docs/guide/ci-cd-triggers.md` include updated GH Actions + GitLab snippets and a new "Web Vitals Budgets" section. | PR #8                                                           |
| DIF-005 | Embedded Playwright trace viewer — install-time `postinstall` copier in `backend/scripts/copy-trace-viewer.js` resolves Playwright's prebuilt viewer (`playwright-core/lib/vite/traceViewer/` or `@playwright/test/lib/trace/viewer/`) and copies it to `backend/public/trace-viewer/`; `backend/src/middleware/appSetup.js` mounts it at `/trace-viewer/` with a viewer-scoped CSP (`script-src 'unsafe-inline' 'wasm-unsafe-eval'`, `worker-src 'self' blob:`, `connect-src 'self' <s3>`), `Service-Worker-Allowed: /trace-viewer/` on the Playwright service worker (matched by `TRACE_VIEWER_SW_PATTERN` to survive filename renames), and `no-cache` for the SW + 5-minute cache for the rest. Run Detail adds a "🔍 Open Trace" action that opens `/trace-viewer/?trace=<signed-url>` in a new tab; the Trace ZIP download is preserved as fallback. Smoke test in `backend/tests/trace-viewer-static.test.js` asserts 200 when the bundle is present and 404 when removed. `backend/Dockerfile` copies `scripts/` before `npm install` so the postinstall hook resolves. | PR #9                                                           |
| AUTO-019 | Run diffing: per-test comparison across runs — new `GET /api/v1/runs/:runId/compare/:otherRunId` (`backend/src/routes/runs.js`) validates both runs under workspace ACL and returns a summary `{ total, flipped, added, removed, unchanged }` plus per-test diff rows keyed by `testId`. Frontend `api.getRunCompare(runId, otherRunId)` + new `RunCompareView` (`frontend/src/components/run/RunCompareView.jsx`) wired into `RunDetail` via a **Compare** action that loads a prior-run picker over the project's test-run history. Integration test `backend/tests/run-compare.test.js` covers happy path (all four change types), 404 unknown run, 401 unauth, and cross-workspace ACL; registered in `backend/tests/run-tests.js`. | PR #10                                                          |
| UI-REFACTOR-001 | `ConfigurablePanel` abstraction extracted from `QualityGatesPanel` (AUTO-012) + `WebVitalsBudgetsPanel` (AUTO-017) — ~95% structural overlap eliminated; future SLO-style config UIs (SEC-005 SSO config, DIF-008 Jira integration) ship as one-file PRs. Shipped alongside an Automation page redesign: four top-level WAI-ARIA tabs (**Triggers & Schedules** · **Quality Gates** · **Integrations** · **Snippets**) with arrow-key + Home/End navigation, per-project accordions inside each tab with live status chips (`N tokens` / `Scheduled`, `Gates configured` / `Budgets set`), and a new `frontend/src/utils/automationStatus.js` parser + module-level promise cache + pub/sub invalidation bus pinning the backend response shapes (`data.schedule.enabled`, `data.qualityGates`, `data.webVitalsBudgets`) with regression coverage in `frontend/tests/automation-status.test.js`. The legacy ProjectDetail → Settings tab is removed; Quality Gates / Web Vitals Budgets now live exclusively at `/automation`. Frontend-only — no backend, schema, route, or `permissions.json` changes. _**Superseded** by the Project Settings restructure — see changelog `[Unreleased]`. The Quality Gates top-level tab on `/automation` was retired; Quality Gates + Web Vitals + Coverage + the four sibling project-scoped surfaces (Auto-Approval / Iterations / PII Firewall / Vision Healing) now live under `/projects/:id/settings/*` as a five-section sidebar mirroring the workspace Settings chrome. `ProjectQualityCard.jsx` is deleted; panels are extracted to `features/project-settings/sections/*/`. Legacy `?tab=quality` deep-links redirect to `/projects/:id/settings/quality-gates`._ | PR #6                                                           |
| AUTO-017.3 | Web Vitals trend charts on `ProjectQualityCard` (LCP / CLS / INP / TTFB) backed by per-run averages from `recordMetric()` in `testRunner.js` via new `GET /projects/:id/metrics` route + `useProjectMetricQuery` hook; threshold lines sourced from `project.webVitalsBudgets`. _Charts now live on `QualityGatesSection` at `features/project-settings/sections/quality-gates/QualityGatesSection.jsx` after the Project Settings restructure — same data path (`useProjectMetricQuery` + `project.webVitalsBudgets`); only the host component moved._ | PR #9 |
| PROC-001 | No-orphan-routes CI guard (`.github/workflows/no-orphan-routes.yml`) — fails PRs adding `router.<method>(…)` in `backend/src/routes/*.js` without touching `frontend/src/api.js` / pages / components; `[no-ui]` PR-title opt-out. Convention documented in REVIEW.md, AGENTS.md, CONTRIBUTING.md, and the PR template. | PR #9 |
| ~~PROC-002~~ + ~~PROC-003~~ | **Reverted in PR #10.** Sprint-promotion automation script (`scripts/promote-sprint-item.mjs` + smoke test) and its PROC-003 auto-prune extension. The regex-based transforms had too many edge cases (bundled-id `(bundled)` suffix leakage, queue-slot vs ROADMAP.md scope-text split, drifting title formats) to be reliably automated; the canonical hand-off is now the expanded manual checklist in `REVIEW.md § Sprint Tracker Hand-off`. | PR #8 (added) / PR #10 (reverted) |
| CAP-003 | Secret scanner gate on AI-generated Playwright tests — gitleaks-style detectors, redacted findings, `run.secretScanBlocked` flag for CI consumers. | PR #12 |
| AUTO-003 | Confidence scoring & auto-approval of low-risk tests | PR #10 |
| AUTO-003b | Auto-approval provenance & audit trail (two-tone badges, revoke endpoint, calibration line, sidebar `🤖 N today`, ApprovalsTimeline page) | PR #10 |
| AUTO-002 + AUTO-002b | Diff-aware crawling — `crawl_baselines` keyed on fingerprint; link-crawl skips unchanged pages, state-explorer uses composite `url#fp` keys; `pages_changed` SSE event surfaced in Test Lab. | PR #12 |
| INT-002b | GitHub integration polish — App install UX + App-level webhooks (install / uninstall / repo-removal), AES-encrypted `installationId` at rest. | PR #17 |
| INT-002 | Native GitHub PR Check Runs — installation-token cache + bounded retry; regressed-tests-only summary markdown; `X-GitHub-Delivery` idempotency. | PR #15 |
| AUTO-001 | Risk-based test selection / ordering — per-test scorer weighting pass-rate, recency, self-heal frequency, and changed pages; smoke-test pin + `budgetMinutes` truncation. | PR #15 |
| AUTO-004 | Test impact analysis from git diff / GitHub PR fetch — file→route heuristic with monorepo `routeMap` override; non-impacted tests recorded as `skipped_no_impact`. | PR #18 |
| CAP-001 | Data-driven test fixtures — CSV / JSON uploads per test, `{{column}}` substitution, per-project iteration cap with worker-pool guard. | PR #1 |
| CAP-002 | Distributed test sharding across runners — `shards: N` fans the run out across N BullMQ workers, single-finalizer guarantee, cross-replica abort via Redis pub/sub. | PR #3 |
| DIF-012 | Multi-environment support (staging vs. production) — per-environment `baseUrl` + AES-encrypted credentials, env-scoped runs without mutating the project row. | PR #2 |
| AUTO-015 + AUTO-015b | Continuous test discovery on deployment events — Vercel + Netlify HMAC-signed webhooks trigger diff-aware preview crawls; dual-auth (Bearer + HMAC). | PR #12 |
| AUTO-008 | Distributed runner across multiple machines — standalone `worker.js` entrypoint, BullMQ queue consumers, dashboard worker-pool metrics. | PR #9 |
| SEC-004 | Multi-factor authentication — TOTP + WebAuthn passkeys + recovery codes + per-workspace enforcement with grace period + JWT `amr` claim. | PR #10 |
| SEC-006 | PII firewall — redacts emails, phones, SSNs, credit cards, JWTs, and auth tokens from AI prompts with deterministic placeholders. | PR #11 |
| INF-007 | Production observability — OpenTelemetry auto-instrumentation, Prometheus `/metrics` (14 counters), Sentry crash reporting, 11 alert rules. | PR #14 |
| AUTO-010 | Root-cause failure clustering — groups failed tests by shared error fingerprint, URL, and selector in a collapsible Run Detail panel. | PR #6 |
| MNT-001 | Vision-based locator healing — host-side pixelmatch CV (stage 7) + LLM vision (stage 8) with per-project budget circuit-breaker. | PR #17 |
| AUTO-009 | Browser JS coverage mapping — V8 capture, source-map resolution, PR-scoped diff, 4 quality gates, sharded-run merge, server-side Istanbul support, regression alerting. | PR #19 |
| AI routes B2 + B3 + B4 | Per-workspace provider routes — migration to `routeId`, capability auto-probe, per-route pricing + caching, spend caps + rate limits, Settings UI, route groups. | PR #23 |
| AI-005 + B1.x | Multi-agent dispatch + per-workspace provider routes foundation — `agentRole`-keyed dispatch, AES-encrypted API keys, `protocolAdapter` route-driven entry point. | PR #22 |
| AI-002 + AI-003 | AI provider modularization (7-module decomposition) + per-call cost tracking via `MODEL_PRICING` catalog. | PR #20 |
| AUTO-022 | AI eval harness — deterministic scorer, golden-set baselines, CI regression gate, Dashboard trend panel (gate dormant until AUTO-022b). | PR #17 |

---

## Phase Summary

| Phase | Scope | Status                                                                                                                                                                                | Est. Duration |
|-------|-------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|---------------|
| Phase 1 — Production Hardening | Security, reliability, data integrity | ✅ Complete                                                                                                                                                                            | — |
| Phase 2 — Team & Enterprise Foundation | Auth hardening, multi-tenancy, RBAC, queues | ✅ Mostly complete — SEC-001/002/003/004, INF-001/002/003/004/005/006, ACL-001/002, FEA-001/002/003, ENH-036 + ENH-036b all ✅ (SEC-004 MFA shipped in PR #10 with TOTP + WebAuthn + per-workspace enforcement); SEC-005 (SSO) tracked as 🟢 Strategic under Phase 5 per AUDIT.md severity reconciliation | 8–10 weeks |
| Phase 3 — AI-Native Differentiation | Visual regression, cross-browser, competitive features | 🔄 In progress — most differentiators shipped (DIF-001/002/002b/003/004/005/006/007/011/012/013/014/015/016 ✅ — DIF-005 embedded trace viewer shipped in PR #9; **INT-002** GitHub PR check comments shipped in PR #15; **DIF-012** multi-environment support shipped in PR #2); remaining: DIF-008–010, DIF-015b/c sub-items | 10–12 weeks |
| Phase 4 — Autonomous Intelligence | Risk-based testing, change detection, quality gates | 🔄 In progress — AUTO-001/002/002b/003/003b/004/005/006/007/008/009/010/012/013/015/015b/016/016b/017/017.3/019 ✅ (AUTO-009 shipped in PR #19, AUTO-008 in PR #9, AUTO-010 in PR #6, AUTO-004 in PR #18, AUTO-001 in PR #15); remaining: AUTO-011, AUTO-014, AUTO-018, AUTO-021 (AUTO-020 superseded by AUTO-015) · Capabilities row: CAP-001 (data-driven) ✅ PR #1, CAP-002 (sharding) ✅ PR #3; CAP-002b (SaaS-readiness follow-ups) tracked separately in Summary | 14–18 weeks |
| Phase 5 — Industry Hardening (AUDIT.md) | OTel, Postgres-default, MFA, SSO, PII firewall, eval harness, Helm/DR, SDK, multi-agent collaboration (AUTO-023, supersedes DAG-runner framing — see [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md)), critic agent, **AI platform foundation (AI-002–007)** | 🔄 In progress — SEC-004 MFA ✅ (PR #10), SEC-006 PII firewall ✅ (PR #11), SEC-007 compliance audit log ✅ (PR #12), INF-007 OTel/Sentry observability ✅ (PR #14), AUTO-022 eval harness plumbing ✅ (PR #17 — gate dormant until AUTO-022b records real LLM cache, deferred), **AI-002 + AI-003 provider modularization + cost tracking ✅ (PR #20)**, **AI-004 (agent_configs schema, migration 037) + AI-005 (multi-agent dispatch) + B1.x provider routes foundation ✅ (PR #22)**; AI-006 (per-role eval harness) + AI-007 (cost governance) re-scoped into the multi-bundle plan at [`docs/roadmap/ai-provider-bundle.md`](./docs/roadmap/ai-provider-bundle.md) (B2 — per-request log + per-route pricing → covers AI-006 telemetry slice; B3 — rate-limit + spend caps + alerts → covers AI-007). Target: industry-readiness score 6.0/10 → 9.0/10. | 12–16 weeks |
| Ongoing — Maintenance & Platform Health | Healing AI, DX, exports, accessibility | 🔄 Continuous                                                                                                                                                                         | — |

---

## Phase 2 — Team & Enterprise Foundation

*Goal: Multi-user, secure, and durable enough for team deployment (5–50 users). Phase 2 is largely complete — only the two deferred enterprise-auth items remain.*

---

### SEC-004 — MFA (TOTP + WebAuthn passkeys + per-workspace enforcement)

**Status:** ✅ Complete (PR #10) — see Completed Work Summary above for the full implementation details. Shipped scope went beyond NEXT.md's original "TOTP first, passkey later" framing and now includes WebAuthn passkey support, per-workspace `mfaRequired` enforcement with configurable grace period, and the JWT `amr` claim per RFC 8176 — all in one PR.

---

### SEC-005 — SAML / OIDC SSO federation 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive (BearQ, enterprise) · AUDIT.md S2 (severity reclassified from 🔵 Medium to 🟢 Strategic — enterprise procurement requirement, schedule per pipeline demand rather than as a deferred medium)

**Problem:** Sentri supports email/password + GitHub/Google OAuth, and SEC-004 covers TOTP MFA, but there is no SAML 2.0 or OIDC federation support. Enterprise procurement teams require SSO integration with their identity provider (Okta, Azure AD, OneLogin, Ping). BearQ inherits SmartBear's enterprise SSO. This is a distinct requirement from MFA — SSO replaces the login flow entirely rather than adding a second factor.

**Fix:** Integrate `openid-client` for OIDC and `@node-saml/passport-saml` for SAML 2.0. Add a per-workspace SSO configuration (metadata URL, client ID, certificate). When SSO is enabled, redirect login to the IdP. Map IdP attributes to Sentri user fields. Auto-provision users on first SSO login. Add SSO configuration UI in Settings → Authentication.

**Files to change:**
- `backend/src/middleware/authenticate.js` — add `saml` and `oidc` auth strategies
- `backend/src/routes/auth.js` — SSO callback endpoints, IdP-initiated login
- `backend/src/database/migrations/` — `sso_configurations` table per workspace
- `frontend/src/pages/Settings.jsx` — SSO configuration panel
- `backend/package.json` — add `openid-client`, `@node-saml/passport-saml`

**Dependencies:** ACL-001 (workspaces must exist for per-workspace SSO configuration)

---

## Phase 3 — AI-Native Differentiation

*Goal: Pull ahead of Mabl, Testim, and SmartBear (including BearQ) with AI-powered capabilities and advanced testing features. These items build the competitive moat.*

---

### DIF-002c — Cross-browser crawl and recorder support 🔲 Backlog

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Follow-on from DIF-002

**Problem:** Crawler (`pipeline/crawlBrowser.js`, `pipeline/stateExplorer.js`), interactive recorder (`runner/recorder.js`), and the live CDP screencast (`runner/screencast.js`) are pinned to Chromium in DIF-002. They use Playwright's CDP APIs directly — `page.context().newCDPSession()`, `Page.startScreencast`, shadow-DOM tree walkers via CDP `DOM.getFlattenedDocument` — which Firefox has no equivalent for and WebKit implements only partially via WebDriver BiDi. Users who want to crawl/record a Safari-only issue or test a WebKit rendering quirk during authoring have no path.

**Fix (high-level; deliberately deferred until there is customer demand):**
- Replace CDP screencast with Playwright's cross-browser `page.screenshot()` polling at ~8-12 fps. Lower quality but engine-agnostic. Keep CDP path for chromium as a fast fallback.
- Replace the CDP-based shadow-DOM tree walker in `crawlBrowser.js` with Playwright's `page.locator()` + `{ strict: false }` serialisation. Slower but engine-agnostic.
- Add a browser param to `POST /projects/:id/record` and `POST /projects/:id/crawl` routes; pass through to the relevant pipeline modules.
- Accept that crawl quality will degrade for firefox/webkit relative to chromium until Playwright's BiDi API stabilises.

**Files to change:**
- `backend/src/pipeline/crawlBrowser.js`, `stateExplorer.js` — accept `browser` param, swap CDP calls for cross-engine equivalents
- `backend/src/runner/recorder.js` — accept `browser`, swap screencast impl
- `backend/src/runner/screencast.js` — dual-path (CDP for chromium, screenshot poll fallback)
- `frontend/src/components/run/RecorderModal.jsx`, `frontend/src/pages/TestLab.jsx` — browser selector (the legacy `CrawlProjectModal` was migrated into the Test Lab page)

**Dependencies:** DIF-002 ✅, DIF-002b (baselines must be browser-aware before crawler variability amplifies diff noise)

---

### DIF-015c — Recorder gaps backlog (action vocabulary, assertions, pause/undo, auth, mobile) 🔵 Medium

**Status:** ✅ Mostly complete (Gaps 1/2/3/5/6 shipped in PR #11 + PR #8; Gap 4 remains 🔲 Planned, blocked on DIF-010) | **Effort:** L (split into sub-items below) | **Source:** PR #115 dogfooding + competitive review (BearQ / Mabl / Testim)

**Problem:** PR #115 made the canvas interactive and aligned recorded steps with the AI-generated / manual format, but the recorder still has six distinct gaps that surface during real use against e-commerce, kanban, and admin-dashboard targets. Gaps 1/2/3/5/6 have been shipped — see the Completed Work Summary table for full implementation details. Only Gap 4 (auth / storageState integration) remains, blocked on DIF-010 (multi-auth profile support).

#### Gaps 1/2/3/5/6 — ✅ Shipped

See the Completed Work Summary table entries for `DIF-015c (Gap 1)` (PR #11) and `DIF-015c (Gaps 2 + 3 + 5 + 6)` (PR #8) for full implementation details. The detailed gap descriptions that were here previously have been pruned per ROADMAP.md convention — shipped items live in the summary table, not inline.

#### Gap 4 — Authentication / pre-logged-in state handling

The recorder starts at `startUrl` with a fresh browser context — no cookies, no localStorage, no logged-in state. Three flows have no good answer today:

1. **Recording a test against an authenticated app** — user must record the login flow as part of every test, even though the resulting test will execute under a different fixture in CI. Workaround is to record the full login each time.
2. **Recording behind SSO / OAuth** — login redirects through a third-party IdP (Google / Okta / Azure AD); the recorder captures the IdP form fields but those selectors are useless at replay (the IdP UI changes; tests cannot be rerun against a different env).
3. **MFA-protected logins** — every recording requires re-doing MFA, which is not deterministic.

Possible fix: integrate with project credential profiles (DIF-010) so the recorder browser context is seeded with `storageState` from a captured login, skipping login entirely. Pair with environment-aware credential profiles per `MNT-004` / `DIF-012`.

**Sub-item status:**

| Sub-item | Effort | Priority | Status |
|---|---|---|---|
| Gap 1 — Expanded action vocabulary | M | 🟡 High | ✅ Complete (PR #118 + PR #11 — paste + opt-in keyboard shortcuts) |
| Gap 2 — Inline assertion authoring | S | 🟢 Differentiator (parity with BearQ) | ✅ Complete (PR #118 backend + PR #8 — point-and-click hover-pick UX + `assertCount` / `assertHasClass` shipped) |
| Gap 3 — Pause / resume + undo | S | 🔵 Medium | ✅ Complete (PR #8) |
| Gap 4 — Auth / storageState integration | M | 🔵 Medium (depends on DIF-010) | 🔲 Planned |
| Gap 5 — Device profile during recording | S | 🔵 Medium | ✅ Complete (PR #8 — launch + mid-session switch with context rebuild) |
| Gap 6 — Stealth launch profile | S | 🔵 Medium | ✅ Complete (PR #8 — hand-rolled, no `playwright-extra` dep) |

**Remaining files to change** (Gap 4 only):
- `backend/src/runner/recorder.js` — seed `storageState` on context from selected credential profile
- `backend/src/routes/tests.js` — accept `authProfileId` on `POST /record`
- `frontend/src/components/run/RecorderModal.jsx` — auth profile picker in the idle form

**Dependencies:** DIF-010 (multi-auth profiles) is a hard prerequisite for Gap 4 — the credential-profile infrastructure must exist before the recorder can seed `storageState` from it.

---


### DIF-008 — Jira / Linear issue sync 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** The traceability data model already stores `linkedIssueKey` and `tags` per test, but there is no outbound sync. When a test fails, no ticket is automatically created. Engineers must manually correlate test failures to issues.

**Fix:** Add `POST /api/integrations/jira` and `POST /api/integrations/linear` settings endpoints to store OAuth tokens. On test run failure, auto-create a bug ticket (with screenshot, error message, and Playwright trace attached). Sync pass/fail status back to the linked issue's status field. Add an Integrations tab to Settings.

**Files to change:**
- New `backend/src/utils/integrations.js` — Jira and Linear API clients
- `backend/src/testRunner.js` — call `syncFailureToIssue(test, run)` on completion
- `backend/src/routes/settings.js` — integration config endpoints
- `frontend/src/pages/Settings.jsx` — Integrations tab

**Dependencies:** FEA-001 (notification infrastructure shares the dispatch pattern)

---

### INT-002 / INT-002b — GitHub PR checks + integration polish

**Status:** ✅ Complete (PR #15 / PR #17) — see Completed Work Summary above for the full implementation details.

---

### DIF-009 — Autonomous monitoring mode (always-on QA agent) 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Sentri is currently a triggered tool — it runs when instructed. The brand promise of "autonomous QA" implies it should also watch production continuously. No competitor outside enterprise tiers offers this for self-hosted deployments.

**Fix:** Add a monitoring mode per project: run a configurable set of smoke tests on a schedule against the production URL. On failure, auto-trigger a re-run to distinguish a regression from a transient flake (2 consecutive failures = confirmed). Fire notifications on confirmed failures. Show a "Monitor" badge on the dashboard for active monitoring projects.

> **Overlap resolution:** This feature builds on scheduling (ENH-006 ✅) and depends on notifications (FEA-001) for alerting. The 2-consecutive-failure confirmation logic is distinct from both and is not duplicated in either dependency — it is implemented here as monitoring-specific re-run orchestration in `scheduler.js`.

**Files to change:**
- `backend/src/scheduler.js` — add monitoring job type alongside scheduled runs
- `backend/src/routes/projects.js` — `PATCH /projects/:id/monitor`
- `frontend/src/pages/Dashboard.jsx` — monitoring status indicators
- `frontend/src/pages/ProjectDetail.jsx` — monitoring config panel

**Dependencies:** INF-003 (BullMQ — retry logic needs durable job execution), FEA-001 (failure notifications)

---

### DIF-010 — Multi-auth profile support per project 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive (unique to Sentri)

**Problem:** Sentri stores credentials per-project but supports only a single auth profile. Testing role-based access control — "admin sees this, viewer does not" — requires running the same test suite under different identities. The Test Dials already expose a `multi_role` perspective option that is not yet wired to actual credential profiles.

**Fix:** Add named credential profiles (e.g., "admin", "viewer", "guest") per project, each with a separate username/password or cookie payload. Wire the `multi_role` Test Dial to the profile selector. Surface per-profile result columns in the run detail view.

**Files to change:**
- `backend/src/utils/credentialEncryption.js` — extend to support multiple named profiles
- `backend/src/routes/projects.js` — profile CRUD endpoints
- `backend/src/pipeline/stateExplorer.js` — accept `profileId` param
- `frontend/src/pages/ProjectDetail.jsx` — credential profiles panel
- `frontend/src/components/test/TestConfig.jsx` — connect `multi_role` dial to profile selector (the legacy `TestDials.jsx` was migrated into the unified `TestConfig` surface used by the Test Lab page)

**Dependencies:** None

---

### DIF-012 — Multi-environment support (staging vs. production)

**Status:** ✅ Complete (PR #2) — see Completed Work Summary above for the full implementation details.

---

## Phase 4 — Autonomous Intelligence

*Goal: Advance Sentri beyond triggered QA into a genuinely autonomous system that makes intelligent decisions about what to test, when to test, and what failures mean. Items in this phase are post-Phase 3 and can be prioritised individually based on customer demand.*

> **Note:** Several Phase 4 items have already shipped opportunistically alongside other work and appear in the Completed Work Summary above — `AUTO-001` (risk-based test selection / ordering, PR #15), `AUTO-002` + `AUTO-002b` (diff-aware crawling for link-crawl and state-explorer modes, PR #12), `AUTO-003` + `AUTO-003b` (confidence-based auto-approval + provenance / audit trail, PR #10), `AUTO-004` (test impact analysis from git diff / GitHub PR files, PR #18 — `computeImpactedTests` + `getChangedFilesForPr` + `+10` file-affinity boost in `riskScorer` composing with AUTO-002's `changedPages[]` boost; `runs.changedFiles` + `runs.impactAnalysis` persisted; non-impacted approved tests pre-seeded as `skipped_no_impact` so every approved test has a resolution), `AUTO-005` (test retry, PR #2), `AUTO-006` (network conditions, PR #3), `AUTO-007` (geolocation/locale/timezone, PR #94), `AUTO-010` (root-cause failure clustering — deterministic `clusterFailures` helper grouping failed results by error fingerprint + URL origin prefix + selector edit-distance; `runs.rootCauses` persisted via migration 027; RunDetail "Root Cause Summary" panel; called from both the single-process tail in `testRunner.js` AND `finalizeShardedRun` in `runWorker.js` for CAP-002 parity, PR #6), `AUTO-012` (SLA / quality gate enforcement — full backend + UI + CI consumer docs, PR #2), `AUTO-013` (stale test detection, PR #99), `AUTO-015` + `AUTO-015b` (continuous test discovery on Vercel/Netlify deployment events + "Last deployment run" badge, PR #12), `AUTO-016` backend slice (axe-core scan + persistence, PR #121), `AUTO-016b` (frontend `CrawlView` accessibility panel + dashboard "Top Accessibility Offenders" rollup, PR #1), `AUTO-017` (Web Vitals performance budgets, PR #8), `AUTO-017.3` (Web Vitals trend charts, PR #9), `AUTO-019` (per-test run diffing, PR #10), and `CAP-001` (data-driven test fixtures — `test_fixtures` table + per-row iteration via `executeTestIterations` substituting `{{column}}` placeholders + per-project `iterationCap` with `[1, 100]` runtime clamp + `TestFixturePanel` on `TestDetail` + `iteration #N` badge in `StepResultsView`, PR #1). The remaining items are scoped here and ready to start; the immediate next sprint target is `DIF-015c` Gaps 2/3/5/6 (recorder gaps completion) tracked in `NEXT.md`, with `AUTO-008` (distributed runner across machines) holding queue slot 1.

---

### CAP-002 — Distributed test sharding across runners

**Status:** ✅ Complete (PR #3) — see Completed Work Summary above for the full implementation details. Per-shard wall-clock E2E + chaos integration tracked separately as `CAP-002b` below.

---


### CAP-002b — Sharding production hardening (chaos / load / SaaS-readiness) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L (split into sub-items below) | **Source:** PR #3 industry-standard audit — items NOT shipped in CAP-002's main scope but explicitly called out in the audit reply, recorded here per AGENTS.md "every finding produces an outcome (fix or ROADMAP entry), never a silent gap".

**Context:** CAP-002 (PR #3) shipped the cross-process sharding primitives end-to-end and is industry-standard for **self-hosted** deployments (7/10 against the self-hosted bar per the post-merge audit). This follow-up tracks the gaps that move us toward the **managed multi-tenant SaaS** bar (Cypress Cloud / BrowserStack / Sauce Labs / LambdaTest tier — currently scored 4/10). None of these are regressions from PR #3; they're scoped here so future reviewers don't re-discover them.

#### Gap 1 — End-to-end wall-clock proof (Tier-1 E2E)

The headline acceptance criterion ("`shards: 4` on a 40-test suite completes in ~1/4 the wall-clock time of `shards: 1`") needs a Tier-1 E2E spec running against a real BullMQ + Playwright harness. PR #3 ships the spec scaffolded at `tests/e2e/specs/run-sharding-wallclock.spec.mjs` gated behind `RUN_E2E_REAL_PLAYWRIGHT=true` so it skips by default; the harness itself (Redis + 4× worker containers + a deterministic test target) is the real work. Without this, we cannot point to a CI green build that proves the speedup empirically.

#### Gap 2 — BullMQ-kill chaos integration test

PR #3 verifies the storage-layer first-writer-wins primitive in isolation (`backend/tests/run-shard-crash.test.js`) but not the end-to-end "kill a BullMQ shard job mid-execution and observe sibling-shard drain" path. A real chaos harness would: enqueue 4 shard jobs, let them start, kill one worker process, assert (a) parent run reaches `failed`, (b) `shardsCompleted < shardCount` is preserved, (c) sibling shards drain within 2s of the `sentri:run-abort` publish, (d) no orphan `active` BullMQ jobs remain for the dead runId. Same harness reusable for: workers killed during finalization, Redis flap mid-run, network partition between coordinator and worker.

#### Gap 3 — BullMQ fan-out unit test (`run-sharding-coordinator.test.js`)

PR #3 ships `backend/tests/run-sharding.test.js` extended with `partitionTestIdsForShards` coverage (5 cases including the 40-IDs-÷-4-shards acceptance shape). What's missing is a route-level test that mocks `runQueue.add` and asserts the actual fan-out call shape: `POST /run` with `shards: 4` produces exactly 4 `runQueue.add("test_run_shard", ...)` invocations with `jobId: ${runId}:s0..s3`, each carrying a contiguous `testIds` slice. Equivalent shape coverage exists today via the helper unit tests but not as a route-integration test.

#### Gap 4 — Auto-scaling shard workers

`MAX_WORKERS` is a static env var. Industry SaaS platforms (Cypress Cloud, BrowserStack) auto-scale runner pools based on queue depth + per-customer quota. Sentri would need: a queue-depth metric exposed via OTel (depends on INF-007), a worker-pool autoscaler (Kubernetes HPA targeting the metric, or a homegrown controller for non-K8s deployments), and per-tenant fair scheduling so one customer's burst doesn't starve another (see Gap 6).

#### Gap 5 — Deadletter queue + replay UI

BullMQ's `attempts: 2` exhaustion drops the job. Industry standard is a deadletter queue with a manual replay UI for operators. A failed shard with all retries exhausted should land in a DLQ with the full job payload + error chain; the run row stays `failed` (don't retroactively flip terminal state) but operators can "replay this shard" from the UI to re-execute against a fresh worker.

#### Gap 6 — Per-tenant fair scheduling + finalization SLA

Today the queue is global FIFO. Two customers running 1000-test suites simultaneously share the worker pool with no fairness; whoever enqueued first finishes first. Per-tenant fairness needs: a per-`workspaceId` queue prefix (`sentri:runs:WS-<id>`), a round-robin or weighted-fair-queue dispatcher across workspace queues, and a documented SLA on finalization latency ("p99 within 60s of last shard completing"). This pairs with `FEA-004` (per-tenant resource quotas + token-cost dashboard) which is already in ROADMAP.md.

#### Gap 7 — Smart shard balancing (duration-aware)

Sentri uses Playwright's `--shard=N/M` even-partition algorithm. Cypress Cloud balances by historical test duration so each shard finishes at roughly the same wall-clock time — critical when test durations vary by 100×. Implementation: persist median per-test duration as a column on `tests` (or a sidecar `test_durations` table), and replace `partitionTestIdsForShards`'s even-split with a greedy bin-packing algorithm. Falls back to even-split when historical durations aren't yet available.

#### Gap 8 — Cross-region shard distribution

Single-region only. Industry SaaS platforms run shards in geographically distributed runner pools (Sauce Labs has runners in 5+ regions; BrowserStack in 30+). Out of scope for self-hosted but a real differentiator gap vs. SaaS competitors.

#### Gap 9 — Container-per-shard isolation

All shards on a replica share the same Node process pool. Industry isolation patterns spawn each shard in its own container/VM so a shard that mis-uses memory or holds a Playwright browser leaked-handle can't affect siblings. Out of scope for the typical self-hosted Render/Fly deployment but a SaaS-tier requirement.

#### Gap 10 — Redis HA enforcement

CAP-002's Redis dependency is a single point of failure. Production SaaS deployments require Redis Sentinel or Redis Cluster. Currently documented in `docs/api/projects.md` § Run sharding ("Redis running for the cross-process fan-out path") but NOT enforced — operators can deploy a single-node Redis and silently lose all sharded runs on a Redis flap. Hardening: detect non-HA Redis at boot and emit a one-shot WARN, document the requirement in `docs/guide/getting-started.md`, add a `/health/redis` endpoint that exposes the topology so monitoring can alert.

**Suggested split into PRs:**

| Sub-item | Effort | Priority | Dependency |
|---|---|---|---|
| Gap 1 — Wall-clock E2E harness | M | 🟡 High | Spec scaffolded in PR #3; harness wiring is the work |
| Gap 2 — BullMQ-kill chaos test | M | 🟡 High | Same harness as Gap 1 |
| Gap 3 — Coordinator route-mock test | S | 🔵 Medium | None — pure unit test |
| Gap 4 — Auto-scaling shard workers | XL | 🟢 Strategic | INF-007 (OTel metrics) |
| Gap 5 — Deadletter queue + replay UI | L | 🔵 Medium | None — pure BullMQ feature |
| Gap 6 — Per-tenant fair scheduling | XL | 🟢 Strategic | FEA-004 (per-tenant quotas) |
| Gap 7 — Duration-aware shard balancing | M | 🔵 Medium | None — historical data already on results rows |
| Gap 8 — Cross-region distribution | XL | 🟢 Strategic | INF-007 (multi-region observability) |
| Gap 9 — Container-per-shard isolation | XL | 🟢 Strategic | Helm/K8s deployment story (Phase 5) |
| Gap 10 — Redis HA enforcement | S | 🔵 Medium | None — boot-time check + docs |

**Dependencies:** CAP-002 ✅ (PR #3) — all sub-items build on the shipped sharding architecture. Gaps 4 + 6 + 8 also depend on Phase 5 items (INF-007 OTel, FEA-004 quotas, Helm/K8s deployment).

**Acceptance criteria (when each sub-item ships):**
- Gap 1: CI matrix includes a `wallclock` lane that passes against `RUN_E2E_REAL_PLAYWRIGHT=true` with the `shards: 4 ≤ 50% of shards: 1` assertion green.
- Gap 2: CI matrix includes a `chaos-shard-kill` lane that kills a BullMQ shard mid-execution and asserts (a)–(d) above.
- Gap 3: `backend/tests/run-sharding-coordinator.test.js` registered in `run-tests.js`; mocks `runQueue.add` and locks down the fan-out call shape.
- Gap 5: New `/runs/:runId/replay-shard/:shardIndex` endpoint (admin-only) re-enqueues a single shard against the same parent run; UI surfaces the replay button on the RunDetail header for failed runs with `shardsCompleted < shardCount`.
- Gap 7: `partitionTestIdsForShards` accepts an optional duration map; new `partitionTestIdsByDuration(testIds, durations, shardCount)` helper performs bin-packing; fallback to even-split when durations are missing.
- Gap 10: Boot-time `/health/redis` returns `{ topology: "single-node" | "sentinel" | "cluster" }`; one-shot WARN at boot when topology is `single-node`.

**Anti-patterns to reject in review:** retroactively flipping a `failed` run to `running` on DLQ replay (terminal state must stay terminal — replay creates a fresh shard that contributes to the same run row but doesn't transition the parent status); auto-retry sharded runs on Redis flap (would compound load on a degraded cluster); cross-tenant data exposure in fair scheduling (a per-workspace queue prefix is a security boundary, not just a perf knob); skipping the boot-time WARN on single-node Redis (operators rely on this signal).

---

### AUTO-008 — Distributed runner across multiple machines

**Status:** ✅ Complete (PR #9) — see Completed Work Summary above for the full implementation details.

---

### AUTO-009 — Browser code coverage mapping 🟢 Differentiator

**Status:** ✅ Complete (PR #19) | **Effort:** L | **Source:** Competitive Gap Analysis

> **Implementation note — AUTO-009b/c (shipped in PR #19):** Source-map resolution against `project.sourcemapBaseUrl` and statement / branch / function granularity ship together. `backend/src/pipeline/sourceMapResolver.js` uses `source-map@^0.7` behind an LRU cache (10MB / 1h TTL) with the SSRF guard from `utils/ssrfGuard.js`; `backend/src/pipeline/v8ToIstanbul.js` lifts V8 ranges into Istanbul `FileCoverage` so the aggregator reports `statementPct`, `branchPct`, `functionPct` independently of `coveragePct`. `sourceMapStatus` is computed dynamically (`resolved` ≥80%, `partial` >0%, `fallback` 0%); the Dashboard CoveragePanel renders the active metric via a tab toggle and badges `fallback mode` / `partial maps` when source-map resolution is incomplete. RunDetail per-test badges read `+47L · +12B · +3F`. Granularity keys are omitted from the persisted shape when the converter never produces data (byte-identical to pre-009c rows). Pre-existing executeTest.js / dashboard LEAN_COLS / source-map cache-miss bugs flagged by the lifeguard review are fixed in the same PR.

**Problem:** There is no way to know what percentage of application code is exercised by the test suite. Playwright supports V8 code coverage via `page.coverage.startJSCoverage()`. This would answer "what percentage of my app is actually tested?"

**Fix:** Optionally enable JS coverage collection per run via `page.coverage.startJSCoverage()` / `stopJSCoverage()`. Aggregate per-URL coverage into a project-level report. Surface on the dashboard as a "Code Coverage" metric alongside pass rate.

**Files to change:**
- `backend/src/runner/executeTest.js` — start/stop coverage collection
- New `backend/src/utils/coverageAggregator.js` — merge per-test coverage data
- `frontend/src/pages/Dashboard.jsx` — code coverage metric card

**Dependencies:** None

---

### AUTO-011 — Historical trend analysis and anomaly detection 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** The dashboard shows a pass/fail trend but never detects anomalies. An autonomous system should alert: "Pass rate dropped 20% in the last 3 runs — likely regression introduced." The only statistical logic is a simple `trendDelta` at `Dashboard.jsx:122-126`.

**Fix:** Implement a lightweight anomaly detector (rolling mean + standard deviation). Alert when pass rate drops more than a configurable threshold (default 15%) versus the prior 5-run baseline. Surface as a warning banner on the dashboard and include in run completion notifications.

**Files to change:**
- New `backend/src/utils/anomalyDetector.js` — rolling baseline analysis
- `backend/src/routes/dashboard.js` — add `anomalyAlert` to dashboard response
- `frontend/src/pages/Dashboard.jsx` — anomaly alert banner

**Dependencies:** FEA-001 (notifications — to fire alerts on detected anomalies)


### AUTO-014 — Test dependency and execution ordering 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive Gap Analysis

**Problem:** Some tests depend on others (login must pass before checkout can run). Sentri has no concept of test dependencies — tests run in arbitrary order within the parallel pool. A failed login test produces cascading failures with no indication that the root cause is an upstream dependency.

**Fix:** Add an optional `dependsOn: [testId]` field to tests. Before execution, topologically sort the test queue to respect dependencies. If a dependency fails, mark dependent tests as `skipped` rather than running them.

**Files to change:**
- `backend/src/database/migrations/` — add `dependsOn` array to `tests`
- `backend/src/testRunner.js` — topological sort and dependency-aware skip logic
- `frontend/src/pages/TestDetail.jsx` — dependency management UI

**Dependencies:** None

---

### AUTO-018 — Plugin and extension system 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Competitive Gap Analysis

**Problem:** There is no way to extend Sentri without forking the repository. An autonomous platform should expose hooks for custom assertions, custom healing strategies, custom report formats, and custom notification channels. All integration points are currently hardcoded.

**Fix:** Define a plugin interface: `beforeRun`, `afterStep`, `onFailure`, `onHealAttempt`, `onRunComplete`. Load plugins from a configurable `PLUGINS_DIR`. Ship three first-party plugins as reference implementations: custom Teams notification formatter, custom assertion library, custom HTML report.

**Files to change:**
- New `backend/src/plugins/pluginLoader.js` — discover and register plugins
- `backend/src/testRunner.js` — emit plugin lifecycle hooks
- `backend/src/selfHealing.js` — expose `onHealAttempt` hook
- `backend/.env.example` — document `PLUGINS_DIR`

**Dependencies:** All Phase 3 items (plugin system should wrap stable APIs, not moving targets)

---

### AUTO-021 — AI-generated test suite health insights 🔵 Medium

**Status:** 🔲 Planned | **Effort:** S | **Source:** Competitive (BearQ)

**Problem:** The dashboard shows pass rate, MTTR, and defect breakdown, but never explains *why* metrics changed. BearQ positions AI-driven analytics as a differentiator. AUTO-011 (anomaly detection) detects statistical drops but doesn't provide actionable explanations. The existing `feedbackLoop.js:buildQualityAnalytics()` produces rule-based `insights[]` strings (e.g., "N tests failed on URL assertions"), but these are static templates — not AI-generated contextual analysis.

**Fix:** After each run, feed the quality analytics summary (failure categories, flaky tests, healing events, pass rate delta) to the LLM and generate a 3–5 sentence natural-language insight: "Pass rate dropped 12% — 8 of 10 failures share the same login timeout. The auth endpoint may be degraded. Consider checking `/api/auth/login` response times." Surface as an "AI Insights" card on the dashboard and include in run completion notifications.

**Files to change:**
- `backend/src/routes/dashboard.js` — generate and cache AI insight on run completion
- `frontend/src/pages/Dashboard.jsx` — AI Insights card
- `backend/src/testRunner.js` — trigger insight generation after `applyFeedbackLoop()`

**Dependencies:** FEA-001 (notifications — to include insights in failure alerts)

---

## Phase 5 — Industry Hardening (from AUDIT.md May 2026)

*Goal: Bring Sentri to enterprise readiness (industry score 6.0/10 → 9.0/10). Items in this phase originate from `AUDIT.md` and were previously tracked in the retired `docs/AUDIT_IMPL.md`. Reconciled into ROADMAP.md ID conventions; old audit IDs preserved as cross-references.*

> **Severity reconciliation rule:** For items in this phase, AUDIT.md severity takes precedence over historical ROADMAP severity — these are compliance, security, and observability gaps that block paid-tier / enterprise adoption regardless of competitive narrative.

> **AUDIT.md findings cross-validated:** All 17 Critical/High findings in AUDIT.md were verified against the live codebase (no false positives). Findings include: SQLite default with second-class PostgreSQL adapter (A3), no OpenTelemetry / Prometheus / Sentry (B2, F7, O1), migration prefix collisions (B4), no Zod validation (B5), no TypeScript (F1), no Helm/K8s (D1), prompt-injection unmitigated (S11/S12), no AI eval harness (AI2), duplicate `activityTypes.js` (A4).

---

### AI-002 — AI provider modularization + adapter contract

**Status:** ✅ Complete (PR #20) — see Completed Work Summary above for the full implementation details. Shipped scope matches the original spec: 7 modules under `backend/src/aiProvider/` (`index` / `registry` / `retry` / `modelCatalog` / `providerInfo` / `dispatcher` / `vision`) + 4 adapters (`anthropic` / `openai` / `google` / `ollama`) behind a 1-line re-export shim at `backend/src/aiProvider.js`. Adapter contract locked at `generate / stream / generateVision` returning `{ text, usage }`. Zero behavior change — every existing export remains importable from `aiProvider.js`; detection priority, SSRF guard, demo-key fallback, circuit breaker semantics, vision support, and INF-007 token telemetry all preserved bit-for-bit. New `aiProvider-adapter-contract.test.js` pins the per-adapter return shape.

**Effort:** M | **Source:** Maintainability + multi-agent readiness (preparatory for `AI-004` agent config + `AI-005` multi-agent dispatch)

---
### AI-003 — Adapter capability hardening + cost tracking

**Status:** ✅ Complete (PR #20) — see Completed Work Summary above for the full implementation details. Shipped scope: `MODEL_PRICING` table in `backend/src/aiProvider/modelCatalog.js` covers Anthropic / OpenAI / Google / OpenRouter (auto null pricing) / canonical Ollama models (free) with `inputPer1k` / `outputPer1k` / `asOf` per entry; `CAPABILITIES` extended with `supportsVision` / `supportsJsonMode` / `supportsStreaming` / `contextWindow` / `maxOutputTokens`; new `computeCostUsd(model, usage)` helper returns `null` on catalog miss (no fake zeros), `0` for known-free Ollama models. Every adapter (`anthropic` / `openai` / `google` / `ollama`) attaches `usage.costUsd`; `app_ai_cost_usd_total{provider, operation}` now bumped on every generation + vision-heal call from the catalog-derived value. MNT-001 `$5/M + $15/M` midpoint preserved as a vision-heal fallback when the model isn't in the catalog. Bugfix landed alongside: `Number(null) === 0` no longer disables `visionHealMaxCostUsdPerMonth` for catalog-miss vision models (regression test pins the fix). Operator guide at `docs/guide/ai-cost-tracking.md` documents the one-file pricing-refresh workflow with a PR-template block.

**Effort:** S | **Source:** Follow-on from AI-002 · Prerequisite for AI-005 / AI-007 · Industry pattern (LangChain `BaseChatModel.cost`, LlamaIndex `LLMMetadata`)

---

### AI-004 — Agent role config schema (dormant) 🔵 Medium
**Status:** 🔲✅ Complete (PR #20) | **Effort:** M | **Source:** Multi-agent foundation · Prerequisite for AI-005 · Industry pattern (CrewAI `Agent` config, LangGraph `Node` definition, AutoGen `AgentConfig`)
**Problem:** Multi-agent dispatch (AI-005) needs a place to read "which provider, model, system prompt, and temperature should the planner agent use?" from. The pipeline today (`backend/src/pipeline/*`) hardcodes prompt templates and reads provider config from the workspace default. Without a config layer, the multi-agent dispatch PR will need to ship: DB schema + repo + settings UI + dispatch wiring all at once — too large for safe review. AI-004 ships the config plumbing in isolation, with the pipeline still calling the workspace default. The config is read but ignored — dormant until AI-005 lights it up.
**Fix:** New `agent_configs` table per workspace storing one row per role (`planner` / `codegen` / `critic` / `selfheal` / `crawl_classify` / `scenario_plan` / etc.). Settings UI under **Settings → AI → Agent Roles** lets admins define each role's `(provider, model, systemPromptOverride, temperature, maxTokens, fallbackRole)`. Backend exposes `agentConfigRepo.getByRole(workspaceId, role)` but no pipeline code reads it yet — that's AI-005's job.
```sql
-- migration NNN_agent_configs.sql
CREATE TABLE agent_configs (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  role TEXT NOT NULL,                  -- "planner" | "codegen" | "critic" | ...
  provider TEXT,                       -- null → use workspace default
  model TEXT,                          -- null → use provider default
  systemPromptOverride TEXT,           -- null → use pipeline default
  temperature REAL DEFAULT 0.2,
  maxTokens INTEGER,
  fallbackRole TEXT,                   -- name of role to delegate to on failure
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  UNIQUE(workspaceId, role)
);
```
**Zero-regression guarantees:**
- No pipeline code reads `agentConfigRepo` in AI-004. The config is dormant.
- Existing `generateText` / `streamText` calls behave identically — `options.agentRole` parameter is **not** added in this PR.
- Workspace default provider remains the source of truth.
- Settings UI is a new admin-only tab; viewers don't see it.
**Files to change:**
- `backend/src/database/migrations/NNN_agent_configs.sql` — new table
- `backend/src/database/repositories/agentConfigRepo.js` — `getByRole`, `listByWorkspace`, `upsert`, `remove`
- `backend/src/routes/settings.js` — `GET/POST/PATCH/DELETE /api/v1/settings/agent-roles[/:role]` (admin-only, registered in `permissions.json`)
- `backend/src/middleware/permissions.json` — register the new routes
- `frontend/src/pages/Settings.jsx` — new **AI → Agent Roles** tab (table + CRUD form, role-name dropdown sourced from a hardcoded `AGENT_ROLES` constant in `frontend/src/config.js`)
- `frontend/src/api.js` — `getAgentRoles`, `createAgentRole`, `updateAgentRole`, `deleteAgentRole`
- `backend/tests/agent-config-routes.test.js` (new) — CRUD round-trip, cross-workspace ACL, role-name allowlist, fallback-role cycle detection
- `docs/api/settings.md` — document the new endpoints
- `docs/guide/agent-roles.md` (new) — operator guide explaining the 8 canonical roles (even though only the workspace default is used today)
- `docs/changelog.md` — under `### Added`, note the dormant config layer
**Acceptance criteria:**
- Admins can create / edit / delete agent role configs via UI and API.
- Cross-workspace ACL enforced (workspace A admin cannot read workspace B's agent configs).
- Role-name allowlist enforced server-side (no free-form role names — must match the canonical 8 stage names).
- `fallbackRole` references validated server-side, cycle detection prevents `planner → critic → planner`.
- Pipeline behavior unchanged — verified by the existing eval harness golden set (AUTO-022) producing identical scores.
**Dependencies:** AI-002 (registry must expose `resolveProvider({ providerId })` so AI-005 can later override workspace default).
**Out of scope:** Pipeline integration. AI-004 ships config storage + UI; AI-005 ships the dispatch wiring.
---
### AI-005 — Multi-agent dispatch (agentRole-aware generation) 🟢 Differentiator
**Status:** ✅ Complete (PR #22) | **Effort:** L | **Source:** Strategic differentiator (Mabl / Testim / SmartBear ship single-LLM pipelines) · Industry pattern (CrewAI agent handoff, LangGraph stateful node dispatch, AutoGen `GroupChat`)
**Problem:** Single-agent mode uses one provider + model for all 8 pipeline stages (crawl classification → scenario planning → code generation → critic review → self-healing). This is the lowest-cost path but suboptimal: a customer might want Claude Sonnet for codegen (best at structured output), GPT-4o-mini for crawl classification (cheap + fast on simple JSON), Gemini Flash for the critic (different model gives independent second opinion), and Ollama for self-healing (low-stakes, on-prem). The agent-config table from AI-004 stores these preferences but is dormant — AI-005 lights it up.
**Fix:** Add `options.agentRole` parameter to `generateText` / `streamText` / `generateVision`. When provided, `registry.resolveProvider({ agentRole, workspaceId })` reads the agent config from `agentConfigRepo` and returns the resolved provider/model/systemPrompt/temperature, falling back to the workspace default when the role is unconfigured. Per-role circuit breakers via `breakerKey(providerId, agentRole)` so a rate-limited Claude planner does not trip Claude for the critic. Per-role token + cost telemetry via a new `agent_role` Prometheus label (bounded cardinality: 8 fixed role names).
```js
// New call signature
await generateText(prompt, {
  agentRole: "planner",           // ← NEW — looks up agent_configs row
  workspaceId: req.workspaceId,   // ← NEW — required when agentRole set
  maxTokens: 4000,
  signal: abortSignal,
});
```
**Detection priority extended:**
```
1. Sticky fallback (rate-limit recovery) — same as today
2. agentRole resolution (NEW) — if set, read agent_configs[role]
3. Quick-switch override (header dropdown) — same as today
4. AI_PROVIDER env — same as today
5. Auto-detect cloud → compat → Ollama — same as today
```
Sticky-fallback stays at the top so a rate-limited primary doesn't keep failing under an agent override. `agentRole` slots between sticky-fallback and quick-switch — agents win over operator UI selection when configured, but never bypass an active rate-limit recovery.
**Per-role circuit breakers:**
```js
// registry.js — extended breaker keying
function breakerKey(provider, agentRole) {
  return agentRole ? `${provider}::${agentRole}` : provider;
}
```
A rate-limited `anthropic::planner` does NOT trip `anthropic::critic` — each role gets its own breaker. Same-provider fallback inside a role still uses the agentRole-scoped breaker chain; cross-role fallback (planner → planner_cheap via `fallbackRole`) is a separate code path.
**Per-role telemetry:**
```
app_ai_provider_latency_seconds{provider, agent_role, outcome}
app_ai_provider_tokens_total{provider, agent_role, kind}
app_ai_provider_errors_total{provider, agent_role, reason}
app_ai_cost_usd_total{provider, agent_role, operation}
```
Cardinality bounded: 8 canonical roles × 5 provider labels × 3 outcomes = 120 series per metric (well under Prometheus's recommended 10k/metric limit).
**Pipeline integration:**
Every pipeline stage threads `agentRole` + `workspaceId` through to its `generateText` call:
| Pipeline stage          | Module                                      | agentRole   |
|-------------------------|---------------------------------------------|-------------|
| Crawl classification    | `crawler.js` → `classifyPage`               | `explorer`  |
| Scenario planning       | `pipeline/scenarioPlanner.js`               | `planner`   |
| Code generation         | `pipeline/testGenerator.js`                 | `author`    |
| Code refinement         | `pipeline/testRefiner.js`                   | `author`    |
| Assertion strengthening | `pipeline/testValidator.js` / oracle stage  | `oracle`    |
| Critic review           | `pipeline/testCritic.js`                    | `reviewer`  |
| Self-healing (DOM)      | `selfHealing.js` (stages 1–6)               | `healer`    |
| Vision healing          | `selfHealing.js` (stages 7–8, MNT-001)      | `healer`    |
| Failure triage          | `pipeline/failureClusterer.js` (+ AUTO-021) | `triager`   |
| Conversational editor   | `routes/chat.js`                            | `author` |
**Zero-regression guarantees:**
- `options.agentRole` is optional. Existing call sites that don't pass it behave identically to today (workspace default).
- Agent configs left empty by the admin → pipeline falls back to workspace default → byte-identical to single-agent mode.
- The eval harness (AUTO-022) golden set runs against the workspace default and continues to produce identical scores in single-agent mode.
- Sticky-fallback still wins over agentRole resolution — a rate-limited provider doesn't keep failing under an agent override.
- Per-role circuit breakers default to provider-only keying when `agentRole` is absent (zero new state for non-multi-agent workspaces).
**Files to change:**
- `backend/src/aiProvider/registry.js` — extend `resolveProvider` to read `agentConfigRepo`, extend `breakerKey` with agentRole, plumb new label through `recordAiTokens` / `recordAiCost`
- `backend/src/aiProvider/index.js` — thread `agentRole` + `workspaceId` through `generateText` / `streamText` / `generateVision`
- `backend/src/utils/metrics.js` — add `agent_role` label to the 4 AI counters (default `"default"` when unset to keep label cardinality stable)
- `backend/src/crawler.js`, `backend/src/pipeline/{scenarioPlanner,testGenerator,testRefiner,testCritic}.js`, `backend/src/selfHealing.js`, `backend/src/routes/chat.js` — pass `agentRole` + `workspaceId` to every `generateText` call
- `frontend/src/pages/Settings.jsx` — light up the dormant AI-004 settings tab with a "Test agent" button per role that runs a sample prompt against the configured agent and shows the response (validates the config end-to-end)
- `backend/tests/agent-dispatch.test.js` (new) — pins agentRole → provider resolution, fallback to workspace default when role unconfigured, per-role circuit breaker isolation (Claude planner rate-limited, Claude critic still works), per-role telemetry labels, `fallbackRole` cycle protection, sticky-fallback still wins over agentRole
- `backend/tests/agent-dispatch-pipeline.test.js` (new) — end-to-end: configure planner=claude + codegen=openai, run a generation, assert both providers were called for their respective stages
- `docs/guide/multi-agent-pipeline.md` (new) — operator guide: when to use single vs multi-agent mode, recommended role-provider matchups, cost implications
- `docs/changelog.md` — under `### Added`, note multi-agent dispatch with the "off by default, fully backwards compatible" callout
**Acceptance criteria:**
- Configuring an agent role redirects only that stage's LLM call — verified by `agent-dispatch-pipeline.test.js`.
- Unconfigured roles fall back to workspace default — eval harness scores unchanged.
- Per-role circuit breakers isolated — rate-limiting Claude planner does not affect Claude critic.
- Per-role telemetry labels visible in `/metrics` output and queryable in Grafana.
- `fallbackRole` cycle (planner → critic → planner) rejected at config-save time with a 400 error.
- Sticky-fallback still wins — a rate-limited provider under an agent override falls back to the same-tier alternate, not back to the agent's preferred provider.
- Eval harness (AUTO-022) re-run in multi-agent mode produces ≥ baseline scores (no regression from role specialisation).
**Pre-merge correctness tripwires** (surfaced during AI-002 + AI-003 review in PR #20 — these MUST be honoured by the AI-005 implementation, not deferred):

1. **Sticky fallback must become per-`(provider, role)`, not per-`provider`.** AI-002 ships with a single global `_stickyFallbackProvider` in `registry.js`. If the planner role is configured for Anthropic and rate-limits, today's sticky-fallback pins **all** AI calls to the fallback for `STICKY_FALLBACK_TTL_MS` — including the codegen role that may have a healthy OpenAI provider configured. AI-005 must extend `registry.js` with a sticky-fallback map keyed by `breakerKey(provider, role)` (the same key used for circuit breakers above) — not the bare provider id. Pin with a regression test: configure planner=anthropic + codegen=openai, force anthropic into sticky-fallback via a 429, assert the **next codegen call still goes to openai** (not the planner's fallback target). Severity: **Critical** — without this, multi-agent dispatch silently collapses to single-provider behaviour the moment any one role rate-limits.
2. **Static `systemPromptOverride` cannot carry planner→codegen handshake artifacts.** The current spec models per-role prompts as a static string read from `agent_configs.systemPromptOverride`. Real multi-agent pipelines pass dynamic context: the planner emits a step list, the codegen agent receives that list as part of its system prompt. AI-005 must add a `messages` array assembly stage in the dispatcher that lets upstream agent outputs flow into downstream agent context (LangGraph `Node` input pattern). Pin with an integration test where the planner outputs `["fill email", "click submit"]` and the codegen role's prompt contains those literal strings. Without this, the multi-agent pipeline can't actually share state — each agent runs in isolation.
3. **Distributed trace ID per run, threading through every agent call.** Without a single trace ID flowing through `planner → codegen → critic`, debugging a multi-agent failure is guesswork. LangSmith / LangFuse / Weights & Biases all model this as a `trace_id` (one per top-level invocation) + `span_id` (one per agent call) pair, written into every log line and OTel span. Sentri's INF-007 already has the request-context infrastructure (`utils/observability.js#requestContext`) — AI-005 must extend it with a `getCurrentTraceId()` helper and have `dispatcher.js#callProvider` attach it to every log line + OTel span. Pin with a test that asserts a single trace ID is shared across N agent calls inside one `runWithAbort` boundary.
4. **Pre-run agent health check before a multi-agent run starts.** Before kicking off a 10-minute pipeline, validate that every configured agent's provider is reachable and the API key works. Today a misconfigured critic key fails at minute 9, after the planner + codegen + executor have already burned spend. AI-005 must add a `validateAgentConfigs(workspace)` pre-flight that issues a 1-token throwaway call to each configured `(provider, role)` pair before the run starts, returning `{ ok: boolean, agentRoles: { planner: { ok, reason }, ... } }`. Pin with a test that simulates a bad key on the critic role and asserts the run rejects at the pre-flight stage with `ERR_AGENT_HEALTH_CHECK_FAILED`, not 9 minutes in.

**Dependencies:** AI-002 (adapter contract), AI-003 (cost tracking — telemetry layer), AI-004 (agent config storage), AUTO-023 (multi-agent collaboration — not a hard dep, but the `agent_messages` envelope thread from Bundle 1 of [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md) is where the "agent handshake" payload lives long-term).
**Out of scope:**
- Per-workspace × per-agent key resolution matrix — deferred to a follow-up `AI-005b` if multi-tenant SaaS customers want their own keys per agent role (today, agent_configs.provider points to a workspace-level key).
- Agent-to-agent handoff envelope (the structured `{ fromRole, toRole, artifact, traceId }` payload) — that belongs in AUTO-023 Bundle 1 (`agent_messages` schema + envelope validator, see [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md) § B1), not the AI provider layer.
- Streaming partial results between agents — AI-005 keeps the current "agent completes its stage, full result passes to next stage" model.
---
### AI-006 — Per-role eval harness extension 🔵 Medium
**Status:** 🔲 Planned | **Effort:** M | **Source:** Quality gate for AI-005 · Extends AUTO-022 eval harness · Industry pattern (Anthropic's eval-per-task, OpenAI Evals registry per skill)
**Problem:** AUTO-022's eval harness scores the end-to-end pipeline as one number (aggregate Levenshtein × 0.4 selectors + 0.3 actions + 0.3 assertions). When multi-agent mode lights up in AI-005, a regression in the planner won't be distinguishable from a regression in codegen — the aggregate score moves and the operator has no signal pointing at which agent role caused the drop. Without per-role goldens, swapping `codegen` from Claude Sonnet to GPT-4o-mini is unmeasurable: did codegen quality drop 5%? 15%? Unchanged? Today's harness can't say.
**Fix:** Extend the golden-set schema with per-role expected outputs and per-role scoring. A single golden case carries expected outputs for each agent role that participates in the pipeline; the harness runs the full pipeline AND records each agent's intermediate output, then scores each intermediate against its role's golden.
```json
// backend/tests/fixtures/eval-goldens/form-fill-001.json
{
  "id": "form-fill-001",
  "category": "form-fill",
  "input": {
    "url": "https://example.com/signup",
    "snapshot": { ... },
    "userIntent": "Sign up a new user"
  },
  "perRoleExpected": {
    "crawl_classify": { "type": "form", "purpose": "registration" },
    "scenario_plan": { "steps": ["fill email", "fill password", "click submit", "assert dashboard"] },
    "codegen": "test('signup flow', async ({ page }) => { ... })",
    "critic": { "issues": [], "approved": true }
  }
}
```
```bash
# CLI invocation extended
$ node backend/scripts/run-eval.mjs --per-role
# Output: per-role scores + aggregate
# planner:  0.92 (vs baseline 0.94, ΔP-0.02 — within tolerance)
# codegen:  0.87 (vs baseline 0.91, ΔP-0.04 — within tolerance)
# critic:   0.88 (vs baseline 0.90, ΔP-0.02 — within tolerance)
# aggregate: 0.89 (vs baseline 0.92, ΔP-0.03 — within tolerance)
```
**Per-role regression thresholds** (configurable in `eval-baseline.json`):
- Per-role drop > 8% → fail per role (tighter than aggregate's 10%)
- Aggregate drop > 5% → fail (unchanged from AUTO-022)
- Operators get a per-role diff that points at the regressing agent
**Zero-regression guarantees:**
- Single-agent mode (no agent_configs rows) runs the aggregate-only path — byte-identical to AUTO-022.
- Goldens missing `perRoleExpected` fall back to aggregate-only scoring (so the 5 canonical AUTO-022 goldens still work).
- The `--per-role` flag is opt-in; default CLI behavior matches AUTO-022.
**Files to change:**
- `backend/src/eval/pipelineEval.js` — extend scorer to optionally take `perRoleExpected` and return per-role scores alongside aggregate
- `backend/src/eval/pipelineAdapter.js` — capture per-stage intermediate outputs (planner output, codegen output, critic output) for scoring
- `backend/scripts/run-eval.mjs` — `--per-role` flag, per-role regression detection, per-role diff in the report
- `backend/tests/fixtures/eval-goldens/*.json` — extend the 5 canonical templates with `perRoleExpected` blocks; document the schema in `docs/guide/eval-harness-record-goldens.md`
- `backend/src/database/repositories/metricSamplesRepo.js` — accept per-role sample rows (`eval.role.planner`, `eval.role.codegen`, etc.) — schema unchanged, new sentinel metric names
- `frontend/src/pages/Dashboard.jsx` — extend the AI Eval Quality panel with a per-role breakdown tab (one sparkline per role)
- `backend/tests/eval-per-role.test.js` (new) — per-role score parity, missing perRoleExpected → aggregate-only fallback, per-role threshold enforcement, frontend panel data shape
- `docs/guide/eval-harness.md` — document the per-role surface
- `docs/changelog.md` — under `### Added`, note per-role eval scoring
**Acceptance criteria:**
- Running `node backend/scripts/run-eval.mjs --per-role` produces per-role scores in the report.
- A regression isolated to one role (e.g. swapping codegen from Claude → GPT-4o-mini) shows the drop on that role's
- - A regression isolated to one role (e.g. swapping codegen from Claude → GPT-4o-mini) shows the drop on that role's sparkline without polluting other roles' scores.
- Per-role thresholds fire independently of aggregate threshold — a 9% codegen drop with stable other roles fails the gate even when aggregate is within 5%.
- Goldens without `perRoleExpected` continue to work via aggregate-only scoring (zero churn on AUTO-022's canonical 5 templates).
- Dashboard AI Eval Quality panel renders per-role sparklines when per-role samples exist; falls back to the aggregate-only view otherwise.
- All existing AUTO-022 tests pass unchanged.

**Pre-merge correctness tripwire** (surfaced during AI-002 + AI-003 review in PR #20):

- **Levenshtein-on-raw-code is the wrong scorer for AST-shaped output.** AUTO-022's existing scorer is fine for selectors / actions / assertions parsed from generated Playwright code (already an AST-extracted tuple), but AI-006's per-role eval will need to score the planner agent's structured JSON output and the codegen agent's code separately. Levenshtein on a JSON object's string serialisation is sensitive to key-order and whitespace; AI-006 must use either (a) deep-equality on the parsed JSON for the planner role, or (b) AST-based diff (e.g. `recast` parser + tree-edit-distance) for the codegen role. Decision: spec AI-006 with two scorers, not one. Pin with a regression test where two semantically-equivalent JSON outputs differing only in key order score 1.0 (not <1.0), and two semantically-equivalent code outputs differing only in whitespace score 1.0 (not <1.0).

**Dependencies:** AUTO-022 (eval harness scorer + persistence), AI-005 (multi-agent dispatch — so the harness has distinct per-role outputs to score). AI-006 can ship before AI-005 with goldens covering only single-agent's aggregate, but the per-role panel stays dormant until AI-005 lights up real per-role calls.

**Out of scope:**
- Per-role baselines per provider/model pair (`claude-sonnet-codegen-baseline.json` vs `gpt-4o-mini-codegen-baseline.json`). A single baseline per role keeps the matrix manageable; operators wanting to A/B test models do that via the AI-005 settings UI and read the dashboard diff, not via parallel baseline files.
- Cross-role regression correlation (e.g. "planner drift caused codegen drift") — interesting but speculative without production data; revisit after multi-agent has been in production for a sprint.
---
### AI-007 — AI cost governance + budget enforcement 🟡 High
**Status:** 🔲 Planned | **Effort:** M | **Source:** Production hardening · SaaS unit-economics requirement · Industry pattern (OpenAI usage limits, Anthropic admin caps, Vercel AI Gateway budgets)
**Problem:** AI-003 emits per-call `costUsd`, AI-005 emits per-role costs, and the Dashboard renders a 30-day trend — but nothing stops a runaway agent loop. A misconfigured `fallbackRole` cycle, a self-healing storm against a SUT that keeps changing selectors, or a critic that keeps requesting refinements can burn through hundreds of dollars before an operator notices. Production AI platforms (Cursor, Vercel AI Gateway, OpenRouter) all ship per-workspace and per-key budgets with hard kill switches. Sentri ships nothing — the only protection today is the per-project `visionHealMaxCostUsdPerMonth` from MNT-001, which only covers vision healing.
**Fix:** Generalise MNT-001's budget counter pattern to cover every AI call. Three governance layers, each opt-in but stacked:
1. **Per-workspace daily + monthly ceilings** (`workspaces.aiCostDailyCapUsd`, `workspaces.aiCostMonthlyCapUsd`) — admin-configurable, defaults null (disabled).
2. **Per-role ceilings** (`agent_configs.costMonthlyCapUsd` extending AI-004's schema) — finer-grained, defaults null.
3. **Per-run kill switch** (`projects.aiCostPerRunCapUsd`) — caps a single run's AI spend; defaults null.
Counters live in a new `ai_cost_counters` table mirroring `vision_budget_counters`:
```sql
CREATE TABLE ai_cost_counters (
  id TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  scope TEXT NOT NULL,              -- "workspace" | "role" | "run"
  scopeKey TEXT NOT NULL,           -- role name | runId | "*" for workspace
  windowKind TEXT NOT NULL,         -- "day" | "month" | "run"
  windowStart TEXT NOT NULL,        -- UTC day boundary | UTC month boundary | run startedAt
  costUsd REAL NOT NULL DEFAULT 0,
  UNIQUE(workspaceId, scope, scopeKey, windowKind, windowStart)
);
```
Every adapter call passes through `aiBudget.record(workspaceId, role, runId, costUsd)` which atomically bumps all three scope counters in one transaction. Before each call, `aiBudget.checkAllowed(...)` reads the same counters and rejects with a structured error when any cap is hit. Self-echo across replicas (a worker on replica A racing one on replica B both incrementing the same counter) handled by the existing AES-GCM ordering pattern + row-level locks — same primitive as `vision_budget_counters` from MNT-001.
**Alert + UI surface:**
- New `app_ai_budget_exhausted_total{scope, scope_key, reason}` Prometheus counter, with corresponding `AIBudgetExhausted` alert in `monitoring/prometheus/alerts.yml`.
- New `ai.budget.exceeded` activity row (SEC-007 hash-chain compatible) — captures `{ scope, scopeKey, capUsd, actualUsd, blockedRunId }`.
- Settings → AI → **Budgets** tab (admin-only) lets operators set caps and shows current spend vs cap per scope with a colour-coded progress bar (green <50%, amber 50–80%, red >80%).
- Dashboard AI Eval Quality panel gains a "Cost vs Budget" row showing today's spend / today's cap and this month's spend / this month's cap.
- FEA-001 notification channel fires at 80% threshold (warning, once per window) and at 100% (hard block, once per window) — Teams adaptive card + email + webhook, same pattern as MNT-001's vision-budget-exhausted alert.
**Behaviour when a cap is hit:**
- **Workspace daily cap hit:** All AI calls in the workspace return a structured `AI_BUDGET_EXHAUSTED` error. Runs in flight finish their current AI call but pre-flight rejection blocks the next call. New runs can be enqueued but stall at the first AI call until the next UTC day boundary.
- **Per-role cap hit:** Only that role's calls are blocked. The pipeline either uses the role's `fallbackRole` (AI-004) if it has spare budget, or fails the stage with a clear error. Tests already generated don't retry against the rate-limited role.
- **Per-run cap hit:** That specific run's AI calls fail. The run is marked `completed_with_budget_exhausted` (new status, similar to `completed_empty`), persisted with `run.aiBudgetExhausted: { capUsd, actualUsd, blockingStage }` for forensics.
Crucially, **budget enforcement happens before the LLM call**, not after — a single 50¢ call that pushes us $0.49 over a $0.01-from-cap budget gets blocked rather than processed-and-then-flagged. This matches OpenRouter's pre-flight reject pattern; the alternative ("oh, we overspent by $0.49 but it's already done") is what makes Vercel AI Gateway's post-hoc model untenable for cost-conscious customers.
**Zero-regression guarantees:**
- All caps default to `null` (disabled). Existing deployments see no change.
- Workspaces without any caps configured don't touch `ai_cost_counters` (early return on the budget-check path).
- MNT-001's vision-healing budget remains in place and operates independently — vision is a separate counter scope (`scope: "vision_heal"`) so adding the new generic counters doesn't double-count vision spend.
- Eval harness (AUTO-022, AI-006) bypasses budgets — it runs against the `__eval_harness__` sentinel projectId which AI-007 explicitly excludes from counter increments. Otherwise running the eval harness would burn workspace budgets and skew unit-economics dashboards.
**Files to change:**
- `backend/src/database/migrations/NNN_ai_cost_governance.sql` — new `ai_cost_counters` table, `workspaces.aiCostDailyCapUsd` + `workspaces.aiCostMonthlyCapUsd`, `projects.aiCostPerRunCapUsd`, `agent_configs.costMonthlyCapUsd` (extends AI-004 schema)
- `backend/src/database/repositories/aiCostCounterRepo.js` (new) — atomic `record()` + `checkAllowed()` + `getCurrentSpend()` mirroring `visionBudgetRepo`
- `backend/src/aiProvider/registry.js` — call `aiCostCounterRepo.checkAllowed()` pre-flight, `aiCostCounterRepo.record()` post-flight (best-effort try/catch on record so a counter write failure doesn't fail the AI call, but checkAllowed failures DO fail the call)
- `backend/src/utils/metrics.js` — `app_ai_budget_exhausted_total{scope, scope_key, reason}` counter
- `monitoring/prometheus/alerts.yml` — `AIBudgetExhausted` alert at 80% threshold (warning) and 100% (page)
- `backend/src/utils/activityLogger.js` — register `ai.budget.exceeded` event type for SEC-007 hash chain
- `backend/src/pipeline/notifications.js` — fire FEA-001 webhook on 80% + 100% (once per window per scope, deduplicated via a `notified_at` column on `ai_cost_counters`)
- `backend/src/routes/settings.js` — `GET/POST /api/v1/settings/ai-budgets` (admin-only)
- `backend/src/routes/projects.js` — `aiCostPerRunCapUsd` in `SINGLE_FIELD_BYPASS` so PATCH from the project quality card skips name/url validation
- `frontend/src/pages/Settings.jsx` — new **AI → Budgets** tab with per-scope cap inputs + live spend-vs-cap progress bars
- `frontend/src/pages/Dashboard.jsx` — extend AI Eval Quality panel with "Cost vs Budget" rows
- `frontend/src/pages/RunDetail.jsx` — render `run.aiBudgetExhausted` panel when the run was budget-killed
- `backend/tests/ai-budget-governance.test.js` (new) — atomic counter bumps, pre-flight rejection on cap hit, fallback-role takes over when per-role cap exhausted, run kill-switch persists `aiBudgetExhausted` shape, eval harness bypass, vision-healing budget remains independent, notification dedup across multi-replica writes
- `backend/tests/ai-budget-routes.test.js` (new) — HTTP integration: cap CRUD, cross-workspace ACL, malformed cap rejection, GET spend-vs-cap shape
- `docs/guide/ai-cost-governance.md` (new) — operator guide: setting caps, reading spend dashboards, what happens at 80%/100%, distinguishing cap-blocked runs from rate-limit-blocked runs
- `docs/guide/env-vars.md` — document any new env vars (none expected; everything DB-driven)
- `docs/changelog.md` — under `### Added`, note budget enforcement with the "off by default" callout
- `QA.md` — § AI Cost Governance manual test plan: cap configuration, spend tracking, 80% notification, 100% block, fallback-role takeover, per-run kill switch
- `permissions.json` — register the new settings endpoints at `admin`
**Acceptance criteria:**
- Setting `aiCostDailyCapUsd: 1.00` on a workspace and running enough AI calls to exceed $1.00 in a UTC day blocks subsequent calls with a structured `AI_BUDGET_EXHAUSTED` error until UTC day boundary.
- Setting `agent_configs.costMonthlyCapUs
- - Setting `agent_configs.costMonthlyCapUsd: 5.00` on the `codegen` role blocks codegen calls past $5/month while other roles continue working.
- Setting `projects.aiCostPerRunCapUsd: 0.50` and triggering a run that would exceed $0.50 of AI spend marks the run `completed_with_budget_exhausted` and persists the forensics shape on `run.aiBudgetExhausted`.
- Pre-flight rejection — a single call that would push us over the cap is blocked, not processed-and-then-flagged.
- Reaching 80% of any cap fires a Teams/email/webhook notification once per window (verified by the dedup column).
- Reaching 100% fires a second notification + the `AIBudgetExhausted` Prometheus alert.
- `ai.budget.exceeded` activity row hash-chains correctly under SEC-007.
- Eval harness (AUTO-022, AI-006) does NOT increment workspace counters — verified by running the full eval suite against a workspace with `aiCostDailyCapUsd: 0.01` and confirming no exhaustion.
- Vision-healing budget (MNT-001) operates independently — exhausting the generic AI budget does not affect vision-heal spend, and vice versa.
- Multi-replica counter writes are atomic — `agent-budget-governance.test.js` simulates 8× concurrent `record()` calls and asserts no lost increments.
- Settings UI shows current spend vs cap per scope with colour-coded progress; admin can edit caps and see the change reflected on next AI call.

**Pre-merge correctness tripwires** (surfaced during AI-002 + AI-003 review in PR #20):

1. **Pre-flight budget check must be atomic with the call dispatch, not a read-then-call sequence.** Two requests passing `aiCostCounterRepo.checkAllowed()` simultaneously can both read "OK" and both succeed, overshooting the cap by up to `(N concurrent requests - 1) × max_call_cost`. The implementation must use the same first-writer-wins SQL predicate pattern CAP-002 used for `incrementShardsCompleted` (`UPDATE ... SET costUsd = costUsd + ? WHERE ... AND costUsd + ? <= cap`) — read-modify-write is wrong. Pin this with a regression test in `ai-budget-governance.test.js` that fires 10 concurrent calls against a workspace with `aiCostDailyCapUsd: 0.005` and asserts at most one passes when each call costs `0.003` (the read-then-call shape would let 2+ pass). Severity: **High** — without this, multi-replica deployments overshoot the cap by exactly the pattern AI-007 is supposed to prevent.
2. **In-flight streaming when budget hits mid-stream — abort, don't "finish".** The current spec says "runs in flight finish their current AI call" on budget exhaustion. Streaming calls are not atomic — `stream()` may yield 20 tokens, hit the cap on token 21, and decide to keep going for "another 30 seconds at most". A hung backend turns that into 5 minutes of overrun. AI-007 must abort the underlying SDK stream via the existing `signal` parameter (already plumbed end-to-end via `composeSignal()` in `retry.js`) the moment a token push would exceed the cap, and emit `{ status: "aborted_budget_exhausted" }` on the run record. Don't let mid-stream calls "finish" — they can run for minutes against a hung backend. Pin with a regression test that streams 100 tokens against a `costPerCall: 0.001` budget with `aiCostDailyCapUsd: 0.0005` and asserts the stream is aborted before token 50 (not after token 100).

**Dependencies:** AI-003 (per-call cost tracking — without `costUsd` in the adapter return shape, AI-007 has nothing to count), AI-004 (per-role caps need `agent_configs` schema), AI-005 (per-role enforcement requires the `agentRole` parameter to actually flow to AI calls). MNT-001 vision-budget pattern is the implementation template.
**Out of scope:**
- Predictive budget exhaustion ("at current rate you'll hit cap in 4 hours") — interesting but speculative; revisit after operators have a sprint of real spend data to calibrate against.
- Per-user (not per-workspace) caps — multi-tenant SaaS will want this eventually but it's a workspace-billing-model decision, not an AI infrastructure decision; defer until a customer asks.
- Cost prediction before the call (estimate token count from prompt + multiply by pricing) — the existing post-call counter is accurate; pre-call estimation adds complexity for marginal benefit. Pre-flight rejection works fine off the running counter (call is blocked when *cumulative* spend would exceed cap, regardless of the next call's exact cost).
- Auto-scaling caps based on historical usage — operator-driven only.
- Refund of partially-consumed run cost when budget hits mid-run — the run is marked `completed_with_budget_exhausted`, the spent cost stays counted. Refunding would require transaction-rollback semantics on Anthropic / OpenAI which they don't expose.
---

### INF-008 — Promote PostgreSQL to default; add dual-DB CI matrix 🔴 Blocker

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md A3, P1, B4 (formerly `ARCH-001` in AUDIT_IMPL.md)

**Problem:** SQLite is the `.env.example` default in 2026. The PostgreSQL adapter exists (INF-001 ✅) but is second-class — AUDIT.md confirmed `_COL_MAP` drift bugs broke 5+ features in PR #11. Single-writer SQLite cannot support horizontal scale. Migration prefix collisions (`007_*` × 2, `015_*` × 2) compound the risk.

**Fix:** Rename conflicting migration files (`007_run_pages.sql` → `007b_*`, `015_web_vitals_budgets.sql` → `015b_*`); update `migrationRunner.js` to sort numerically then alpha. Change `.env.example` and `docker-compose.yml` default to `DATABASE_URL=postgresql://...` with a bundled Postgres service. Add CI matrix job `db: [sqlite, postgres]` in `ci.yml` running the full `npm test` suite under both. Add a migration linter (`backend/scripts/lint-migrations.mjs`) that fails on duplicate numeric prefixes (overlaps with MNT-014 — coordinate). Add a nightly `pg_dump` CI job as DR baseline.

**Files to change:**
- Rename two migration files; `backend/src/database/migrationRunner.js` sort fix
- New `backend/scripts/lint-migrations.mjs`
- `backend/.env.example`, `docker-compose.yml`, `.github/workflows/ci.yml`
- New `.github/workflows/nightly-backup.yml`

**Acceptance criteria:**
- `npm test` passes with both `DATABASE_URL=postgres://...` and `DATABASE_URL=file:./...` in CI.
- Migration linter fails the build on a prefix collision.
- `docker compose up` works out-of-the-box with Postgres with zero extra steps.
- No existing migration files removed or reordered — only the two colliding files renamed.

**Dependencies:** None. **Recommended to land in same sprint as INF-007.** **Bundles naturally with:** MNT-014 (migration linter scope overlap).

---

### SEC-006 — Prompt-injection / PII firewall between crawler and LLM

**Status:** ✅ Complete (PR #11) — see Completed Work Summary above for the full implementation details. Shipped scope: PII-only redaction (emails, phones, SSNs, Luhn-checked cards, JWTs, Bearer/Basic headers, auth query-string params) wired in `backend/src/crawler.js` between crawl output and AI generation, with per-project `strictPiiFirewall` + `piiAllowlist` controls (default-on via migration `030_projects_pii_firewall.sql`) and a `pipeline.pii_redacted` structured audit log. The prompt-injection half of the original AUDIT.md S11 finding (hidden-text instruction stripping, `<script>` / `<style>` removal, prompt-preamble regex filtering) was **deferred** as a follow-up — captured separately as `SEC-006b` in the queue when scheduling permits.

---

### AUTO-022 — AI evaluation harness with golden-set regression

**Status:** ✅ Plumbing complete (PR #17) — see Completed Work Summary below for the full implementation details. The scorer (`backend/src/eval/pipelineEval.js`), record/replay adapters (`pipelineAdapter.js`), `metric_samples` persistence (`evalPersistence.js`), Dashboard `EvalPanel` + drill-down route, path-filtered `eval.yml` CI workflow, 5 canonical golden templates, and 32 unit + integration tests all shipped. The regression gate itself is **dormant** until a maintainer runs `EVAL_RECORD=1 ... --write-baseline` against the live LLM and commits the resulting `.cache/*.txt` recordings + first real `eval-baseline.json` — tracked separately as `AUTO-022b` below per the AGENT.md issue-handling rule.

---

### AUTO-022b — Eval harness: record real LLM cache + first real baseline 🔴 Blocker

**Status:** 🔄 Current sprint | **Effort:** M (4–8 hours of focused maintainer work with an LLM API key) | **Dependencies:** AUTO-022 ✅ (PR #17 plumbing) | **Source:** PR #17 follow-up — `docs/guide/eval-harness-record-goldens.md`

**Problem:** AUTO-022 (PR #17) shipped the eval harness wiring end-to-end — scorer, adapters, CI workflow, Dashboard panel, persistence layer — but the regression gate it's supposed to enforce is currently inert. Two gaps keep it dormant:

1. The 50 golden cases under `backend/tests/fixtures/eval-goldens/case-*.json` are synthetic 3-element HTML fragments, not real DOM captures from `tests/e2e/specs/`. The production pipeline (`generateAllTests`) is tuned for real-app DOM with hundreds of elements / ARIA / state machines; synthetic snippets produce either trivial output that scores high by accident or empty output that scores zero — neither measures real pipeline quality.
2. There are no `.cache/*.txt` recordings committed. The `.gitignore` is set up to allow `*.txt` entries in `backend/tests/fixtures/eval-goldens/.cache/`, but the directory is currently empty. The cold-start guard in `backend/scripts/run-eval.mjs:71-91` short-circuits CI to exit 0 in this state so the merge wasn't blocked — but until real recordings exist, every regression that would have been caught silently ships.
3. `eval-baseline.json` is a placeholder (every score is `1.0`). A real baseline gets generated by `--write-baseline` against the live LLM after real recordings exist.

**Fix:** A dedicated maintainer session with an LLM API key (Anthropic / OpenAI / Google / Ollama) walks the documented procedure in `docs/guide/eval-harness-record-goldens.md`:

1. Capture real DOM snapshots from the running Sentri app (or any candidate target) via a one-off Playwright `page.content()` script. Replace the synthetic `snapshot` field in each `case-NNN.json`; reference snapshots > 5 KB via `@file:snapshots/<id>.html`. Update each case's `description` from "Skeleton golden — Replace ..." to a real flow name.
2. Run `EVAL_RECORD=1 node backend/scripts/run-eval.mjs` to populate `.cache/<id>.<hash>.txt` against the live pipeline.
3. Iterate per-case until each case's score ≥ 0.7 (or consciously delete cases that can't reach 0.4 — 40 good cases beats 50 mediocre ones). Adjust `expected` to mirror the pipeline's actual phrasing, NOT idealised target code — the harness measures regression, not aspiration.
4. Run `EVAL_RECORD=1 node backend/scripts/run-eval.mjs --write-baseline` to regenerate `eval-baseline.json` with real `aggregate` / `byDimension` / `byCategory` / `perCase` keys.
5. Force-add the cache files: `git add -f backend/tests/fixtures/eval-goldens/.cache/*.txt`. Commit + push.
6. Verify CI: the `Eval — Golden-set regression check` job runs in replay mode, scores against the new baseline, exits 0 on the recording commit (aggregate equals baseline) and exits non-zero on any subsequent prompt / model / pipeline change that crosses the 5% aggregate or 10% per-dimension threshold.

**Files to change:**
- `backend/tests/fixtures/eval-goldens/case-*.json` — replace synthetic `snapshot` + `description` fields with real captures
- `backend/tests/fixtures/eval-goldens/snapshots/` (new directory) — large DOM captures referenced via `@file:` URIs
- `backend/tests/fixtures/eval-goldens/.cache/*.txt` — force-add recorded LLM responses (one per case, named `<id>.<32-char-hash>.txt`)
- `eval-baseline.json` — regenerate via `--write-baseline` after recordings exist; gains real `perCase` + `byDimension` + `byCategory` keys
- `docs/guide/eval-harness.md` — add a "What constitutes a real golden vs a skeleton" section per the maintainer brief (case must have non-skeleton `description`, snapshot from `page.content()`, matching cache entry, baseline `perCase` score ≥ 0.4)

**Acceptance criteria:**
- `node backend/scripts/run-eval.mjs` exits 0 on the current tree with a non-zero `aggregate` line (replay against committed `.cache/` rather than cold-start bypass).
- Modifying a prompt template file to deliberately lower selector quality on ≥ 3 cases re-records the cache for those cases, and the eval-workflow CI job exits non-zero with the named affected cases listed in stderr.
- Dashboard `EvalPanel` renders a non-placeholder sparkline after `--persist` writes the first 200 `metric_samples` rows under the `__eval_harness__` sentinel projectId.
- `eval-baseline.json` has a `perCase` block with one entry per committed case, each with a numeric score in `[0, 1]` (not all `1.0`).
- The cold-start guard at `backend/scripts/run-eval.mjs:71-91` is no longer triggered (cache directory non-empty).

**PR checklist (AUTO-022b):**
- [ ] PR title `chore(eval): AUTO-022b — record real LLM cache + first real baseline`
- [ ] 50 case JSON files updated with real DOM captures (or consciously trimmed to N < 50 with the rest deleted, not skeleton'd)
- [ ] `.cache/*.txt` recordings force-committed (`git add -f`), one per remaining case
- [ ] `eval-baseline.json` regenerated with real `perCase` + `byDimension` + `byCategory` + numeric `aggregate` ≠ 1.0
- [ ] CI `Eval — Golden-set regression check` exits 0 on the recording commit (verify the artifact `eval-report.json` has `bootstrap: false` and a non-null `aggregate`)
- [ ] `docs/guide/eval-harness.md` gains the "What constitutes a real golden" section
- [ ] `docs/changelog.md` updated under `## [Unreleased]` § Added (mark AUTO-022 fully active, not just plumbing)
- [ ] ROADMAP.md `### AUTO-022b` section flipped to `**Status:** ✅ Complete (PR #N)` and Completed Work Summary row added
- [ ] NEXT.md current-sprint slot rotated to the next queue item

**Why this is a separate PR:** Recording requires an LLM API key and 4–8 hours of focused per-case iteration. Bundling it into PR #17 (the plumbing PR) would have meant the plumbing couldn't ship until a maintainer with API access had time to do the recording — and recording itself can't happen until the plumbing is in `develop`. The cold-start guard exists exactly to break this chicken-and-egg deadlock: ship the harness inert, light it up later.

**Original AUDIT.md source:** AUDIT.md AI2, AI3, AI6 (formerly `AI-EVAL-001` in AUDIT_IMPL.md; supersedes the looser `MNT-003` prompt A/B testing item).

**Problem:** Prompt changes ship on intuition. There is no golden-set regression test, no LangSmith/Phoenix integration, and no automatic quality rollback. Silent regressions in AI-generated test quality are undetectable. Rated Critical for the "Autonomous QA" brand promise.

**Fix:** 50-case golden-set fixture (`backend/tests/fixtures/eval-golden-set.json`) with `{ url, pageSnapshot, expectedActions[], expectedAssertions[], minQualityScore }`. New `backend/src/eval/pipelineEval.js` runs the full 8-stage pipeline against each case, scores selectors/actions/assertions via Levenshtein similarity, emits pass/fail per case. CI job `eval.yml` runs on every PR touching `pipeline/`, `aiProvider.js`, or any prompt file — fails the build if >5% of cases regress. Persist eval results as `metric_samples` rows (`ai.eval.score`, labels `caseId`, `promptVersion`) so trend charts surface. Adds `promptVersion` to every pipeline run log so production regressions correlate to prompt changes.

**Files to change:**
- New `backend/src/eval/pipelineEval.js`, `backend/src/eval/scorers.js`
- New `backend/tests/fixtures/eval-golden-set.json` (50 cases)
- New `.github/workflows/eval.yml` (path-filtered)
- `backend/src/pipeline/pipelineOrchestrator.js` — emit `promptVersion` + `metric_samples`
- `backend/src/database/repositories/metricSampleRepo.js` — `bulkInsert()`
- `backend/.env.example` — `EVAL_PROVIDER` (defaults to cheapest configured model)

**Acceptance criteria:**
- `npm run eval` exits 0 with ≥95% of golden cases passing on the current codebase.
- CI `eval.yml` is green on main.
- Introducing a deliberately broken prompt into `pipeline/testGenerator.js` causes >5% regression and fails the build.
- Eval results appear in `metric_samples` and are queryable via `GET /projects/:id/metrics`.

**Dependencies:** INF-007 (`metric_samples` infrastructure / OTel context). Golden set can be authored in parallel with INF-007. **Supersedes:** `MNT-003` (prompt A/B testing) — see MNT-003 note.

---

### INF-009 — Helm chart + Kubernetes readiness/liveness + DR playbook ✅ Complete

**Status:** ✅ Complete (PR #30) | **Effort:** L | **Source:** AUDIT.md D1, D2, D3 (formerly `INFRA-001` in AUDIT_IMPL.md). **Superseded the K8s/worker-split portion of `AUTO-008`** (distributed runner) — AUTO-008 now narrows to "horizontal scaling beyond a single worker" only.

Full details: see Completed Work Summary table § INF-009 row.

**Dependencies:** INF-008 (Postgres-default), INF-007 (metrics endpoint for liveness). **Narrowed scope of:** AUTO-008.

---

### FEA-004 — Per-tenant resource quotas + token-cost dashboard 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md AI8, B8 (formerly `ENT-003` in AUDIT_IMPL.md)

**Problem:** No per-project AI token budget caps. No cost dashboard. A single runaway project can exhaust the platform's entire LLM budget. Enterprise customers expect per-tenant quota enforcement and ROI dashboards.

**Fix:** Add `tokenBudgetMonthly` and `tokenBudgetUsed` (reset monthly via cron) to the `workspaces` table. Before enqueuing an AI call in `aiProvider.js`, check remaining budget. Reject with 429 if exceeded; emit `ai.budget.exceeded` activity event. Add `GET /api/v1/workspaces/:id/usage` endpoint returning token spend by project / provider / model over a date range — backed by `metric_samples` from INF-007. New Usage dashboard page (`UsageDashboard.jsx`) with total token spend, per-provider cost estimate (configurable price table), spend-by-project chart, budget utilisation gauge.

**Files to change:**
- New migration — `tokenBudgetMonthly`, `tokenBudgetUsed` on `workspaces`
- `backend/src/aiProvider.js` — pre-call budget check; post-call `metric_samples` insert
- `backend/src/routes/workspaces.js` — `GET /usage` + `PATCH /budget`
- New `frontend/src/pages/UsageDashboard.jsx`
- `frontend/src/api.js` — `getWorkspaceUsage()`, `updateWorkspaceBudget()`

**Acceptance criteria:**
- A workspace with `tokenBudgetMonthly: 10000` rejects AI calls after 10,000 tokens consumed in the calendar month with a clear user-facing error.
- Usage dashboard shows token spend trend for the last 30 days broken down by project.
- Budget utilisation gauge turns amber at 80%, red at 95%.

**Dependencies:** INF-007 (`metric_samples` infrastructure).

---

### INF-010 — TypeScript/JavaScript public SDK + CLI 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md A6 (formerly `ENT-004` in AUDIT_IMPL.md)

**Problem:** Every CI consumer hand-rolls HTTP against the Sentri API. Competitors (Cypress Cloud, BrowserStack) ship official SDKs. INF-004 ✅ (OpenAPI spec) is already shipped — the SDK is a near-free derivation.

**Fix:** Add `packages/sdk-js/` to npm workspaces. Use `openapi-typescript-codegen` to generate a typed client from `backend/src/openapi.js` at build time. Publish as `@sentri/sdk` on npm. Ship `sentri-cli` binary (`packages/cli/`) wrapping the SDK: `sentri run <projectId>`, `sentri status <runId>`, `sentri export <testId>`. Update `docs/guide/ci-cd-triggers.md` with SDK-first examples.

**Files to change:**
- New `packages/sdk-js/` — generated + hand-authored overrides
- New `packages/cli/` — commander-based binary
- `package.json` (root) — add both packages to `workspaces`
- `.github/workflows/release.yml` — SDK + CLI publish steps

**Acceptance criteria:**
- `npm install @sentri/sdk` then `new SentriClient({ baseUrl, apiKey }).runs.trigger(projectId)` works against a local instance.
- All 50 public API endpoints have typed request/response interfaces.
- `sentri run <projectId>` exits 0 on success, 1 on quality gate failure, 2 on run error.

**Dependencies:** INF-004 ✅ (OpenAPI spec), MNT-012 (shared Zod schemas become SDK validation types).

---

### AUTO-023 — Autonomous multi-agent collaboration 🟢 Strategic ⚠️ Reframed

> **Reframed.** The legacy "LangGraph-style DAG pipeline runner" framing below is **superseded** by the 5-bundle multi-agent collaboration plan in [`docs/roadmap/autonomous-multi-agent.md`](./docs/roadmap/autonomous-multi-agent.md). The supervisor orchestrator (Bundle 4) replaces the DAG runner — flow control is decided by an LLM reading a structured `agent_messages` thread, not hardcoded if/else node graph. Migration 058's Oracle + Reviewer per-project flags + Task 2/3 conversation feed remain valid scaffolding for the new plan. The legacy prose below is kept inline for historical reference until a human prunes it.

### AUTO-023 (legacy framing — superseded) — LangGraph-style DAG pipeline runner

**Status:** 🔲 Planned | **Effort:** XL | **Source:** AUDIT.md AI1, A7 (formerly `AGENT-001` in AUDIT_IMPL.md)

**Problem:** `pipelineOrchestrator.js` directly imports each stage in a hardcoded sequence. No DAG runner, no retryable stage boundaries, no per-stage idempotency keys, no checkpoint/resume. Rated Critical for the "Autonomous QA" brand promise.

**Fix:** Introduce `backend/src/pipeline/dagRunner.js`: a lightweight DAG executor that takes a typed node graph, runs nodes in dependency order, handles per-node retry with exponential backoff, persists node state to Redis (checkpoint), and supports human-in-the-loop pause nodes. Refactor `pipelineOrchestrator.js` to define the pipeline as a declarative DAG spec. Each node has `run(input, context)`, `retry: { attempts, backoff }`, `idempotencyKey(input)`. The `approve` node is a pause node: emits an SSE event, suspends, waits for `POST /tests/:id/review`, resumes.

**Files to change:**
- New `backend/src/pipeline/dagRunner.js`, `backend/src/pipeline/pipelineDag.js`
- `backend/src/pipeline/pipelineOrchestrator.js` — refactor to delegate to `dagRunner`
- `backend/src/utils/redisClient.js` — `setCheckpoint`/`getCheckpoint`
- New `backend/tests/dag-runner.test.js`

**Acceptance criteria:**
- A simulated single-stage failure triggers retry up to configured `attempts` with exponential backoff.
- Killing the process mid-pipeline and restarting resumes from the last completed node.
- A pause node (approval step) suspends + resumes correctly.
- Existing E2E pipeline tests pass unchanged (drop-in replacement).

**Dependencies:** INF-007 (OTel spans per DAG node), MNT-015 (browser pool used by executor node).

---

### AUTO-024 — Critic agent: validate generator output against crawl graph 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md AI4, AI7 (formerly `AGENT-002` in AUDIT_IMPL.md)

**Problem:** The generator produces selectors and URLs that may not exist in the crawl graph. No validation occurs between generation and human review. Users waste time reviewing syntactically valid but semantically broken tests.

**Fix:** Add a `critic` DAG node (after `generate`, before `approve`) that checks every `page.goto(url)` URL against the crawl graph, every `locator(selector)` against the last crawl snapshot DOM, scores each test with a `criticScore` (0–100) separate from `qualityScore`, and flags tests with `criticScore < 60` as `needs_review`.

**Files to change:**
- New `backend/src/pipeline/criticAgent.js`
- `backend/src/pipeline/pipelineDag.js` — add `critic` node
- New migration — `criticScore`, `criticIssues` on `tests`
- `frontend/src/pages/TestDetail.jsx` — render `criticIssues` warning panel

**Acceptance criteria:**
- A test containing `page.goto('https://example.com/nonexistent')` receives `criticScore < 60`.
- A test with all URLs/selectors validated against the crawl graph receives `criticScore ≥ 80`.
- Auto-approval is blocked when `criticScore < 60` regardless of `qualityScore`.

**Dependencies:** AUTO-023 (Critic runs as a DAG node), AUTO-002 ✅ (crawl graph available).

---

### AUTO-025 — Healing telemetry feedback loop to generator 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md AI5 (formerly `AGENT-003` in AUDIT_IMPL.md). **Complements MNT-002** — MNT-002 reorders the healing waterfall; AUTO-025 feeds healed-selector patterns back into generation prompts.

**Problem:** Self-healing history is a goldmine of "what selectors break on this project" but is never fed back to the generator. Each new generation starts from zero context, producing the same fragile selectors that will heal again.

**Fix:** Before the `generate` DAG node runs, query the top-10 most-healed selectors for the project. Inject as negative-example block in the generator prompt. Track `promptEnrichmentApplied: true` on the run log. New `GET /api/v1/projects/:id/healing-insights` returning top-N healed patterns.

**Files to change:**
- `backend/src/pipeline/testGenerator.js` — `healingContext` injection
- New `backend/src/utils/healingInsights.js`
- `backend/src/database/repositories/healingRepo.js` — `getTopHealedSelectors`
- `backend/src/routes/projects.js` — `GET /:id/healing-insights`
- `frontend/src/pages/ProjectDetail.jsx` — Healing Insights panel

**Acceptance criteria:**
- After 5+ healing events on a project, the next generation prompt contains a negative-example block with the healed selectors.
- `GET /projects/:id/healing-insights` returns a ranked list of top-10 healed patterns with counts.

**Dependencies:** AUTO-023 (generator is a DAG node with access to context bag).

---

### FEA-005 — Collaboration: comments, mentions, assignments on tests and runs 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md Product Strategy §12 (formerly `UX-003` in AUDIT_IMPL.md)

**Problem:** Zero collaboration features. Users cannot comment on a test, mention a teammate, or assign a failing test to a developer. Linear/GitHub-grade collaboration is table stakes for team adoption.

**Fix:** Add `comments` table (`id`, `workspaceId`, `entityType` `test`|`run`, `entityId`, `authorId`, `body` Markdown, `mentions[]` userIds, `createdAt`). `GET`/`POST`/`DELETE /api/v1/:entityType/:entityId/comments`. `@mention` autocomplete in composer. Emit notifications (reuse FEA-001) on mention. Render threads on TestDetail and RunDetail.

**Files to change:**
- New migration — `comments` table
- New `backend/src/database/repositories/commentRepo.js`, `backend/src/routes/comments.js`
- `backend/src/middleware/permissions.json` — comment endpoints (all authenticated members)
- New `frontend/src/components/shared/CommentThread.jsx`
- `frontend/src/pages/TestDetail.jsx` + `RunDetail.jsx` — embed `<CommentThread />`
- `frontend/src/api.js` — `getComments`, `postComment`, `deleteComment`

**Acceptance criteria:**
- A user can post, edit, and delete comments on a test and a run.
- `@username` in a comment body triggers a notification to the mentioned user.
- Comment thread renders in real-time via SSE.

**Dependencies:** FEA-001 ✅ (notifications), ACL-001 ✅ (workspace members for mention autocomplete).

---

### FEA-006 — Template gallery + sample project first-run experience 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md U2, Product Strategy §12 (formerly `UX-004` in AUDIT_IMPL.md)

**Problem:** No onboarding, no template gallery, high first-run friction. A new user arriving at an empty project has no path to "wow" without configuring a live URL.

**Fix:** Ship 5 sample project templates (e-commerce checkout, login flow, dashboard CRUD, form validation, API mock) as seed data. "Start from template" button on the empty project state. Guided first-run tour (3 steps: Configure provider → Crawl → Review first test) via `Shepherd.js`. Public `GET /api/v1/templates` endpoint.

**Files to change:**
- New `backend/src/database/seed/templates.json`
- New `backend/src/routes/templates.js` — `GET /templates`, `POST /projects/from-template`
- `frontend/src/pages/ProjectsPage.jsx` — "Start from template" CTA on empty state
- New `frontend/src/components/onboarding/FirstRunTour.jsx`
- `frontend/package.json` — add `shepherd.js`

**Acceptance criteria:**
- A new user can create a project from the "e-commerce checkout" template and have 5 sample tests ready within 30 seconds (no crawl required).
- The first-run tour fires once per account, is dismissible, persists across sessions.
- `GET /api/v1/templates` returns the 5 templates with metadata (name, description, testCount, previewUrl).

**Dependencies:** FEA-004 (template instantiation respects workspace token budget).

---

## Ongoing Maintenance & Platform Health

*These items are not phase-bounded. Address them incrementally alongside feature work, prioritising MNT-006 (object storage) before any cloud deployment.*

---

### MNT-002 — Self-healing ML classifier 🟢 Differentiator

**Status:** 🔲 Planned | **Effort:** XL | **Source:** Audit

**Problem:** The healing waterfall is deterministic and rule-based. `STRATEGY_VERSION` invalidates all cached hints when strategies change. Healing history data in `healing_history` is collected but never fed back to improve the system. A lightweight classifier trained on healing events would predict the best strategy per element type, reducing waterfall traversal depth.

**Fix:** Train an offline classifier on `healing_history` events using feature vectors (element type, page URL pattern, last successful strategy, DOM depth). Export the model as a JSON lookup table. Load it at startup. Use it to reorder the waterfall per element rather than always starting at strategy 1.

**Files to change:**
- `backend/src/selfHealing.js` — accept strategy ordering hint from classifier
- New `backend/src/ml/healingClassifier.js` — model loader and inference
- New `scripts/train-healing-model.js` — offline training script from `healing_history` data

**See also:** MNT-001 — both items extend `selfHealing.js`. MNT-002 handles statistical strategy selection; MNT-001 handles visual DOM changes. They are complementary and can be developed independently on separate branches.

---

### MNT-004 — Test data management (fixtures and factories) 🔵 Medium

**Status:** 🔲 Planned | **Effort:** L | **Source:** Competitive

**Problem:** Tests that require specific data states (a logged-in user with specific records, a product at a specific price) have no supported setup/teardown mechanism. This limits the depth of user journeys Sentri can test autonomously.

**Fix:** Add a `fixtures` block to test config: a list of API calls or SQL statements to execute before the test and teardown statements to run after. Expose `beforeTest` / `afterTest` hooks in `executeTest.js`.

**Files to change:**
- New `backend/src/utils/testDataFactory.js` — fixture execution engine
- `backend/src/runner/executeTest.js` — call `beforeTest`/`afterTest` hooks
- `backend/src/pipeline/stateExplorer.js` — declare required state for generated tests

---

### MNT-005 — BDD / Gherkin export format 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Competitive

**Problem:** Enterprise teams using behaviour-driven development (Cucumber, SpecFlow) cannot use Sentri's output directly. SmartBear's BDD format is widely adopted in enterprise QA. Adding a Gherkin export alongside the existing Zephyr/TestRail CSV exports would broaden enterprise appeal.

**Fix:** Add `buildGherkinFeature(test)` to `exportFormats.js`. Map test steps to `Given` / `When` / `Then` blocks using the step intent classifier data already produced by the pipeline. Add a "Export as Gherkin" option to the Tests page export menu.

**Files to change:**
- `backend/src/utils/exportFormats.js` — add Gherkin builder
- `backend/src/routes/tests.js` — `GET /projects/:id/export/gherkin`
- `frontend/src/pages/Tests.jsx` — Gherkin export option

**See also:** DIF-006 (Playwright export) — both extend `exportFormats.js`. Develop in the same or consecutive sprints to share export ZIP packaging scaffolding.

---

### MNT-012 — `packages/shared/` workspace: TS bootstrap + Zod schemas 🟡 High

**Status:** 🔲 Planned | **Effort:** M | **Source:** AUDIT.md A4, F1, B5 (formerly `DEBT-001` in AUDIT_IMPL.md)

**Problem:** `activityTypes.js` lives in both `backend/src/constants/` and `frontend/src/constants/` — drift is inevitable. Root `package.json` declares npm workspaces but has no `packages/shared/` member. The entire codebase is plain JavaScript. The `isThresholdOnly` PATCH bypass at `routes/projects.js:153` is a real validator hole.

**Fix:** Create `packages/shared/` as a third npm workspace member. Migrate `activityTypes.js` into `packages/shared/src/activityTypes.ts` (first TS file in the repo). Migrate error-code constants. Add Zod schemas for the five highest-risk request payloads (`createProject`, `updateProject`, `createRun`, `triggerRun`, `updateReviewStatus`). Replace `isThresholdOnly` bypass with `updateProjectSchema.parse(req.body)`.

**Files to change:**
- New `packages/shared/` tree (package.json, tsconfig.json, src/activityTypes.ts, errorCodes.ts, schemas/index.ts)
- `package.json` (root) — add `packages/shared` to `workspaces`
- `backend/src/constants/activityTypes.js`, `frontend/src/constants/activityTypes.js` — re-export shims
- `backend/src/routes/{projects,runs,trigger,tests}.js` — replace ad-hoc validators with Zod schemas
- `backend/package.json` — add `zod`

**Acceptance criteria:**
- `packages/shared` builds with zero TS errors (`tsc --noEmit`).
- `activityTypes.js` exists in only one canonical location.
- The five Zod schemas reject invalid payloads with structured 400 errors.
- `isThresholdOnly` bypass removed; integration test confirms `PATCH /projects/:id` with unexpected keys returns 400.

**Dependencies:** INF-008. **Unblocks:** INF-010, MNT-017.

---

### MNT-013 — Request-ID propagation + structured log correlation 🟡 High

**Status:** 🔲 Planned | **Effort:** S | **Source:** AUDIT.md B1 (formerly `DEBT-002` in AUDIT_IMPL.md)

**Problem:** `formatLogLine()` produces structured logs with no `requestId`. A 10-minute debug session on a multi-tenant failure requires manually grep-ing `runId` across interleaved log lines from concurrent requests.

**Fix:** Generate a `requestId` (UUID v4) per request and store in `AsyncLocalStorage`. Update `formatLogLine()`, `logError()`, `logWarn()` to read `requestId` from the store automatically — no call-site changes needed. Expose in `X-Request-Id` response header. For BullMQ jobs, seed `requestId` from the job's `jobId`.

**Files to change:**
- New `backend/src/utils/requestContext.js` — `AsyncLocalStorage` singleton
- `backend/src/middleware/appSetup.js` — middleware before routes
- `backend/src/utils/logFormatter.js` — read `requestId` from context
- `backend/src/workers/runWorker.js` — seed context with `job.id`

**Acceptance criteria:**
- Every log line during a request carries `requestId` matching `X-Request-Id`.
- Two concurrent run logs are separable by their distinct `requestId` values.

**Dependencies:** INF-007 (OTel bootstrap shares the same `AsyncLocalStorage` store). **Bundle naturally with INF-007.**

---

### MNT-014 — Migration linter + down-migration stubs 🔵 Medium

**Status:** 🔲 Planned | **Effort:** XS | **Source:** AUDIT.md B4 (formerly `DEBT-003` in AUDIT_IMPL.md)

**Problem:** Duplicate numeric prefixes (`007_*` × 2, `015_*` × 2) confirmed. No migration linter prevents recurrence. No down migrations exist so rollbacks require manual SQL.

**Fix:** Ship `backend/scripts/lint-migrations.mjs` (overlaps with INF-008 — coordinate). Add `MIGRATION_TEMPLATE.sql` with required `-- ROLLBACK: <SQL or "manual">` header. Lint for header presence. Add minimal rollback stubs to the 5 most recent migrations.

**Files to change:**
- `backend/scripts/lint-migrations.mjs` — created in INF-008; this item adds rollback-header check
- New `backend/src/database/MIGRATION_TEMPLATE.sql`
- `backend/src/database/migrations/016_metric_samples.sql` through `020_run_changed_pages.sql` — rollback comment

**Acceptance criteria:**
- `npm run lint:migrations` passes on main.
- A migration without a rollback comment header fails the linter.
- A file with a duplicate numeric prefix fails the linter.

**Dependencies:** INF-008. **Recommended bundle:** ship together with INF-008.

---

### MNT-008 — ESLint + Prettier enforcement in CI 🔵 Medium

**Status:** 🔲 Planned | **Effort:** M | **Source:** Quality Review (PRD-04)

**Problem:** The codebase has no linting or formatting enforcement. Code style varies across files. New contributors receive no automated style feedback, increasing review friction and producing noisy diffs.

**Fix:** Add ESLint (flat config) with `@eslint/js` recommended + `eslint-plugin-react`. Add Prettier with a `.prettierrc` matching the existing dominant code style. Add `npm run lint` to the CI pipeline. Apply auto-fix formatting as a single dedicated commit.

**Files to change:**
- `backend/eslint.config.js`, `frontend/eslint.config.js` — ESLint configurations
- `.prettierrc` — Prettier config
- `.github/workflows/ci.yml` — add lint step
- `backend/package.json`, `frontend/package.json` — add dev dependencies

---

### MNT-015 — Browser pool reuse + per-tenant rate limiting

**Status:** ✅ Complete (PR #1) — see Completed Work Summary above for the full implementation details. Shipped scope: warm Playwright browser-process pool in `backend/src/runner/browserPool.js` (per-`browserType` bucket with FIFO waiter queue, `BROWSER_POOL_SIZE` env default `WORKER_CONCURRENCY` / `MAX_WORKERS`); `testRunner.js` + `runner/executeTest.js` switched to `browserPool.acquire()` / release. **Design deviation from original spec:** the pool keeps the *browser process* warm but creates a fresh `BrowserContext` per acquire (closed on release) to preserve per-tenant isolation of storage state, video, and tracing — the spec's "warm BrowserContext with `clearCookies()`/`clearPermissions()`" would have leaked storage across workspaces. Per-workspace AI cost-weighted limiter in `backend/src/middleware/aiRateLimit.js` (AI mutation = 10 units, regular = 1 unit) keyed on `workspaceId:ai` via new `incrWithExpiry()` Redis Lua helper in `backend/src/utils/redisClient.js`; mounted on `POST /chat`, `POST /projects/:id/crawl`, `POST /projects/:id/tests/generate`, `POST /tests/:testId/fix`, `POST /settings/agent-roles/:role/test` in `backend/src/index.js` (not `appSetup.js` as originally specified — route names also updated to match current routes: `/tests/:testId/fix` instead of legacy `/tests/:id/regenerate`). Graceful shutdown drains the pool before queue / Redis teardown in `backend/src/index.js` + `backend/src/worker.js`. Telemetry: `app_browser_pool_size{type}`, `app_browser_pool_in_use{type}`, `app_browser_pool_acquires_total{type,outcome}`, `app_ai_rate_limited_total{workspace_role}` in `backend/src/utils/metrics.js`. New env vars documented: `BROWSER_POOL_SIZE`, `AI_RATE_LIMIT_PER_MIN`, `AI_RATE_LIMIT_REGULAR_PER_MIN`, `AI_RATE_LIMIT_WINDOW_SEC`. New tests registered in `backend/tests/run-tests.js`: `browser-pool.test.js` (acquire/release, FIFO queue, drain), `ai-rate-limit.test.js` (cost-weighted increment, sibling-workspace isolation, `Retry-After` on 429, bypass without `workspaceId`).

**Effort:** M | **Source:** AUDIT.md P4, B8 (formerly `PERF-001` in AUDIT_IMPL.md)

---

### MNT-016 — Storybook + design tokens + accessibility CI gate 🟡 High

**Status:** 🔲 Planned | **Effort:** L | **Source:** AUDIT.md F2, F5, U3 (formerly `UX-001` in AUDIT_IMPL.md)

**Problem:** `components.css` + `utilities.css` are ad-hoc with no token system. Empty/Loading/Error states are inconsistent across 20+ pages. Sentri's own UI has no a11y CI gate (ironic for a QA tool). No Storybook means UI regressions are invisible.

**Fix:** Set up Storybook 8 with a `tokens.css` file. Stories for 10 core components (`Button`, `Input`, `Modal`, `Card`, `Badge`, `ChartCard`, `EmptyState`, `LoadingState`, `ErrorState`, `ConfirmDialog`). Add `@axe-core/storybook` addon (fails stories with WCAG AA violations). Add a Pa11y CI job running against the Sentri UI on 5 critical routes (Login, Projects, TestDetail, RunDetail, Settings). Require ≥1 story per new component in REVIEW.md checklist.

**Files to change:**
- New `frontend/.storybook/main.ts`, `preview.ts`
- New `frontend/src/styles/tokens.css`
- `frontend/src/styles/components.css` — replace magic values with token references
- New `frontend/src/stories/` — 10 component story files
- `frontend/package.json` — add `@storybook/react-vite`, `@axe-core/storybook`, `pa11y-ci`
- New `.github/workflows/axe.yml`
- `REVIEW.md` — add ≥1 Storybook story requirement

**Acceptance criteria:**
- `npm run storybook` starts; all 10 component stories render.
- Zero WCAG AA violations on the 10 core component stories.
- Pa11y CI is green on main for all 5 routes.

**Dependencies:** MNT-012 (TS in shared makes token types available to Storybook config).

---

### MNT-017 — TypeScript migration: frontend (incremental) 🟢 Strategic

**Status:** 🔲 Planned | **Effort:** XL | **Source:** AUDIT.md F1 (formerly `UX-002` in AUDIT_IMPL.md)

**Problem:** Zero TypeScript in the frontend. A 2026 SaaS product of this complexity without TS is a maintainability tax. AUDIT.md notes this is the #1 refactor risk driver.

**Fix:** Enable `allowJs: true` in `tsconfig.json` so `.js` and `.ts` coexist. Migrate in priority order: (1) `frontend/src/api.js` → `api.ts` (highest call density), (2) `frontend/src/utils/*.js` → `.ts`, (3) `frontend/src/hooks/**/*.js` → `.ts`, (4) page components (one per sprint, highest-complexity first: TestDetail, RunDetail, TestLab). Target: 30% TS coverage within this item; 100% within 18 months.

**Files to change (first sprint):**
- New `frontend/tsconfig.json` — `allowJs: true`, `strict: true`, `noEmit: true`
- `frontend/src/api.js` → `api.ts` — return types from `@sentri/shared` Zod schemas
- `frontend/src/utils/*.js` → `.ts` (all 8 utility files)
- `frontend/package.json` — add `typescript`; add `tsc --noEmit` to `npm test`
- `.github/workflows/ci.yml` — `tsc --noEmit` step for frontend

**Acceptance criteria:**
- `tsc --noEmit` passes with zero errors on the migrated files.
- Zero runtime regressions.
- `api.ts` export types are consumed by ≥3 component files via `import type`.

**Dependencies:** MNT-012 (shared types from `@sentri/shared` feed into `api.ts`).

---

### MNT-003 — Prompt A/B testing framework 🔵 Medium ⚠️ Superseded scope

**Status:** 🔲 Planned (narrowed) | **Effort:** L → S | **Source:** Audit. **Most of this item's scope is now covered by AUTO-022** (golden-set eval harness). What remains here is the experiment-tagging + per-variant promotion UI; the metric-computation half is folded into AUTO-022's `metric_samples` rows.

**Original problem (still valid for the residual scope):** `promptVersion` is stored on tests but there is no system to *promote* a winning variant — AUTO-022 measures regression but doesn't run experiments per variant.

**Reduced fix:** Add a `promptExperiments` table. Tag each generation with the active experiment + variant. Reuse AUTO-022's quality metrics per variant (validation pass rate, healing rate, approval rate). Add an Experiments view in Settings to review results and promote a winning variant.

**Dependencies:** AUTO-022 (eval harness produces the per-variant metrics this surfaces).

---

## Competitive Gap Analysis

> **Note:** The SmartBear column reflects both their legacy portfolio (TestComplete, ReadyAPI)
> and the new **BearQ** AI-native platform (early access — https://smartbear.com/product/bearq/early-access/).
> BearQ significantly changes SmartBear's competitive position; capabilities marked with † are BearQ-specific.

| Capability | Sentri | Mabl | Testim | SmartBear / BearQ | Playwright OSS |
|---|---|---|---|---|---|
| AI test generation | ✅ 8-stage pipeline | ✅ Auto-heal only | ✅ AI recorder | ✅ BearQ AI generation † | ❌ Manual |
| Interactive recorder | ✅ DIF-015 | ✅ | ✅ | ✅ BearQ recorder † | Via codegen |
| Self-healing selectors | ✅ Multi-strategy waterfall | ✅ ML-based | ✅ Smart locators | ✅ BearQ AI healing † | ❌ |
| AI auto-repair on failure | ✅ Feedback loop | ✅ | ✅ | ✅ BearQ † | ❌ |
| Human review queue | ✅ Draft → Approve flow | ❌ | ❌ | ❌ | ❌ |
| NL test editing | ✅ AI chat + fix | ❌ | ❌ | ✅ BearQ NL input † | ❌ |
| API test generation | ✅ HAR-based auto-gen | ✅ | ❌ | ✅ ReadyAPI | ✅ Manual |
| Scheduled runs | ✅ Cron + timezone | ✅ | ✅ | ✅ | Via CI cron |
| CI/CD integration | ✅ Webhook + token auth | ✅ Native | ✅ Native | ✅ Native | ✅ CLI |
| Self-hosted / private | ✅ Docker | ❌ SaaS only | ❌ SaaS only | Partial | ✅ |
| Multi-provider LLM | ✅ Anthropic/OpenAI/Google/OpenRouter/Ollama | ❌ | ❌ | ❌ | ❌ |
| Parallel execution | ✅ 1–10 workers | ✅ Cloud | ✅ Cloud | ✅ Cloud | ✅ CLI sharding |
| Visual regression | ✅ DIF-001 | ✅ Native | ✅ Native | ✅ VisualTest | Via plugins |
| Cross-browser | ✅ DIF-002 | ✅ Chrome+Firefox | ✅ Chrome+Firefox | ✅ All | ✅ All 3 |
| Mobile / device emulation | ✅ DIF-003 | ✅ | ✅ | ✅ | ✅ Native |
| Failure notifications | ✅ Teams/email/webhook | ✅ Slack/email | ✅ Slack/email | ✅ | N/A |
| Multi-tenancy / RBAC | ✅ ACL-001/ACL-002 | ✅ | ✅ | ✅ | N/A |
| Standalone export | ✅ DIF-006 | ❌ Lock-in | ❌ Lock-in | ❌ Lock-in | N/A |
| Flaky test detection | ✅ DIF-004 | ✅ | ✅ | ✅ | ❌ |
| Risk-based test selection | ✅ AUTO-001 (PR #15) — consumes AUTO-002's `changedPages` signal | ✅ | Partial | ✅ BearQ smart selection † | ❌ |
| Accessibility testing | ✅ (backend) / 🔄 AUTO-016b (UI) | ✅ | ❌ | Partial | Via plugins |
| Performance budgets | ❌ → AUTO-017 | ❌ | ❌ | Via Lighthouse | ❌ |
| Quality gate enforcement | ✅ AUTO-012 (PR #2) | ✅ | ✅ | ✅ | Via Playwright |

**Sentri's unique strengths:** Self-hosted + AI generation + human review queue + multi-provider LLM + standalone Playwright export (✅ DIF-006). No competitor offers all five together. BearQ narrows the AI generation gap but remains SaaS-only with no self-hosted option or LLM provider choice.

**Critical gaps to close next:** SEC-007 Phase 1 (compliance audit log immutability + auth events, current sprint) · INF-007 (OTel/Sentry) · INF-008 (Postgres-default) · AUTO-022 (AI eval harness). Prior critical gaps closed: SEC-006 ✅ PR #11 (PII firewall), SEC-004 ✅ PR #10 (MFA: TOTP + WebAuthn + per-workspace enforcement), AI-001 ✅ PR #14 (generic OpenAI-compatible provider adapter), AUTO-001 ✅ PR #15 (risk-based test selection), AUTO-004 ✅ PR #18 (test impact analysis from git diff / GitHub PR files), INT-002 ✅ PR #15 (GitHub PR check comments), CAP-001 ✅ PR #1 (data-driven test fixtures), DIF-012 ✅ PR #2 (multi-environment support), CAP-002 ✅ PR #3 (distributed test sharding), AUTO-010 ✅ PR #6 (root-cause failure clustering).

> **Previous priorities ✅ shipped:** DIF-001 · DIF-002/002b · DIF-003 · DIF-004 · DIF-005 · DIF-006 · DIF-007 · DIF-011 · DIF-013 · DIF-014 · DIF-015 · DIF-015b · DIF-016 · INT-002 (PR #15) · AUTO-001 (PR #15) · AUTO-002/002b/005/006/007/012/013/015/015b/016/016b/017/019 · AI-001 (PR #14) · CAP-003 · CAP-004 · MET-001 · UI-REFACTOR-001.

---

## Summary

| Category | Total | ✅ Done | 🔄 In Progress | 🔲 Pending | Remaining |
|----------|------:|--------:|---------------:|----------:|-----------|
| Security & Compliance | 7 | 6 | 0 | 1 | SEC-005 (SSO) planned |
| Infrastructure | 10 | 8 | 0 | 2 | INF-008 🔴 (Postgres default), INF-010 (SDK + CLI) |
| Access Control | 2 | 2 | 0 | 0 | — |
| Platform Features | 7 | 4 | 0 | 3 | FEA-004 (per-tenant quotas), FEA-005 (collaboration/comments), FEA-006 (template gallery) |
| Differentiators | 22 | 16 | 0 | 6 | DIF-002c, 008, 009, 010, 012, 015c (sub-gaps 2–6) |
| Autonomous Intelligence | 29 | 21 | 0 | 8 | AUTO-011/014/018/021/022 🔴 (eval harness)/023 (DAG runner)/024 (critic)/025 (healing loop) (AUTO-020 superseded by AUTO-015; AUTO-009 ✅ shipped in PR #19 incl. all follow-ups 009b/c/d/e/f/g/h/i/j/k) |
| Capabilities | 4 | 4 | 0 | 0 | — |
| Process automation | 1 | 1 | 0 | 0 | — |
| Maintenance | 17 | 5 | 0 | 12 | MNT-001/002/003 (narrowed)/004/005/008/012/013/014/015/016/017 |
| **Totals** | **99** | **66** | **0** | **32** | |


**Total tracked items:** 99 across 9 categories — **66 complete** (67%), **0 in current PR** (MNT-015 promoted in NEXT.md), **32 remaining**

**Blockers (must ship before paid tier / enterprise demo):**
- ✅ All Phase 1–4 blockers resolved.
- 🔴 **NEW from AUDIT.md Phase 5 — 3 items unresolved:** INF-008 (Postgres default + dual-DB CI matrix), AUTO-022 (AI eval harness). (SEC-004 MFA shipped in PR #10; SEC-006 PII firewall shipped in PR #11; SEC-005 SSO reclassified from Blocker to 🟢 Strategic per AUDIT.md S2.)

**Recommended PR order (next 8 sprints, interleaving Phase 4 feature delivery with Phase 5 audit hardening):**
1. `INF-008` (Postgres-default + dual-DB CI matrix — 🔴 Blocker per AUDIT.md; SQLite kept as dev fallback, Postgres becomes the canonical schema for production deployments)
2. `AUTO-022` (AI eval harness — 🔴 Blocker per AUDIT.md AI series; regression-safety net for prompt / model changes, gates AI-001 fallback-chain rollouts; depends on INF-007's `metric_samples` infra)
3. `SEC-007 Phase 2` (admin compliance surface + CSV/NDJSON export + retention sweep — completes the SOC 2 / ISO 27001 story started in Phase 1)

This rotation alternates between audit-driven hardening and feature delivery so neither narrative starves.

**Lowest effort / highest immediate value (excluding current PR):** `SEC-004` (MFA) — L effort, unblocks regulated-industry sales pipeline and resolves the longest-standing 🔴 Blocker on the board. Pair with `INF-007` (OTel/Sentry) for the next sprint pair: combined they move industry-readiness from 6.0/10 → ~7.5/10 per AUDIT.md targets.

---

## Contributing

Before starting any item:

1. Open a GitHub Issue referencing the item ID (e.g., `SEC-001`, `DIF-006`)
2. Assign yourself and add to the current sprint milestone
3. Create a branch named `feat/SEC-001-email-verification` or `fix/INF-002-redis-sse`
4. Reference the issue in your PR description
5. Update the item's **Status** in this file (`🔲 Planned` → `🔄 In Progress` → `✅ Complete`) in the same PR
6. Add an entry to `docs/changelog.md` under `## [Unreleased]` following the Keep a Changelog format

For items with explicit **See also** cross-references (MNT-001/MNT-002, DIF-006/MNT-005), coordinate branch timing in sprint planning to avoid merge conflicts on shared files (`selfHealing.js`, `exportFormats.js`).
