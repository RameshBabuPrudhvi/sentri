# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Autonomous agent orchestrator now threads `replyToId` across supervisor handoffs, tool_call, and tool_result envelopes so the run-detail conversation timeline reconstructs the multi-step thread as a connected chain instead of orphan roots.
- Vision healing now emits `vision_pixelmatch_failed` and `vision_llm_failed` healer→reviewer envelopes on declined heals (sub-threshold or provider outage), so the run timeline records every heal attempt rather than going silent between the failure and the next stage.
- New `app_reviewer_verdict_downgraded_total{reason}` Prometheus counter bumps on every reviewer-verdict downgrade so operators can alert on reviewer-prompt drift or hallucinated testIds.
- Reviewer↔author loop now honours envelope-shape `{ intent: "revise" }` as a request for revision (mirroring the existing `verdict: "revise"` remap). Pre-fix a reviewer returning the envelope-shape token silently normalised to `accept`, burning the requested revision round.
- Post-generation pipeline resets `run.secretScanBlocked` at entry, so a re-entry on the same run (multi-batch generation) no longer carries a stale `true` from an earlier batch. CI consumers reading the flag now see the canonical post-run value.
- Post-generation pipeline now re-scores test quality AFTER healing transforms (was before), so the Review Queue's "why was this drafted?" explainer and the auto-approval `confidenceScore` reflect the persisted code shape. Pre-fix tests rewritten from `page.getByRole(...).click()` to `safeClick(...)` carried a stale `selector.semantic` reward that no longer matched the saved code.
- Feedback-loop improvement prompt now caps the embedded element-snapshot JSON at 8 KB to prevent verbose page snapshots from blowing past the LLM's context window during auto-regeneration.
- Feedback-loop now surfaces non-abort regeneration failures via a structured warn log + new `app_feedback_loop_regeneration_failures_total{reason}` Prometheus counter (parse_error / provider_error / internal_error). Pre-fix the auto-regen catch path silently swallowed every non-abort error, making a sustained provider outage look like "regeneration just isn't helping".
- Flaky-test detection now scans only the most recent 50 runs per project (was: entire history). Long-lived projects with thousands of runs no longer pay an O(history) scan on every feedback-loop pass. Pass `{ maxRuns: 0 }` to opt back into the full-history scan.
- Deduplicator's fuzzy / semantic layers now respect the `scenario` field: positive and negative coverage of the same flow on the same URL (e.g. "Login with valid credentials" vs "Login with invalid credentials") are no longer falsely collapsed. Tests with missing `scenario` keep the prior dedup behaviour.
- Deduplicator's fuzzy / semantic comparison is now bucketed by `sourceUrl` before the O(n²) layer, so large multi-page test batches run faster (1000 tests across 10 URLs now dedupe in under 2 seconds). Pure perf — correctness is preserved.
- **UX-001** — Saving Auto-Approval, Quality Gates, Web Vitals, Coverage, and project/workspace settings now shows a visible confirmation toast on success and a red error toast on failure. Previously these mutations were silent or routed to the notification bell. (#40)
- **UX-001** — Approve / reject / restore / delete actions on Tests, Review Queue, Test Detail, and Project Detail now show success and error toasts. (#40)
- Bulk approve / reject on Review Queue now reports the actual number of tests affected (previously inflated when a multi-test project group failed). (#40)

### Added

- Workspace-wide save/update/delete confirmations via a global toast surface. Success toasts dismiss after 3.5 s, errors after 5 s, and toasts with an action button (e.g. Undo) linger 5 s. Toasts have a manual dismiss × button. (#40)
- **A11Y** — Toasts announce to screen readers via `role="alert"` (errors) and `role="status"` (success / info). (#40)
- **UX** — Bulk approve / reject on Review Queue now offers an inline **Undo** action on the success toast that restores affected tests to Draft. (#40)

### Changed

- **Refactor** — Test Lab page decomposed into smaller components, hooks, and utility modules. No behaviour change. (#40)

- **SEC / Perf** — Web fonts (Inter, JetBrains Mono) self-hosted instead of loaded from Google Fonts CDN — closes a GDPR exposure, unblocks CSP hardening, and removes a ~120 ms render-blocking external request on cold loads. (#40)

- **Security** — Defence-in-depth HTML sanitization on AI-generated markdown rendered in AI Chat, Chat History, and Step Results — guards against future grammar changes accidentally introducing an XSS sink. (#40)

- **UI** — Code preview on Review Queue now correctly labels generated Playwright code as "JavaScript" (was mislabelled "TypeScript"). (#40)

- **UX** — Empty states on Reports and on the Project Detail review tab now coach the user toward the next action (create a project, run regression, generate more tests, audit approvals, or clear filters) instead of showing bare text. (#40)

## [1.9.0] — 2026-05-26

### Added

- **AUTO-023 Bundle 5** — Thread-scoped shared blackboard (`get`/`setKey`/`casUpdate`) with optimistic concurrency and a 64 KB size cap (`AGENT_THREAD_STATE_MAX_BYTES`).
- **AUTO-023 Bundle 5** — Closed-set tool registry with five read-only tools and per-role visibility intersected with `agent_configs.allowedTools`. (#38)
- **AUTO-023 Bundle 5** — Server-side tool dispatch with 30 s timeout, per-tool rate limiting, `AbortSignal` propagation, and secret scrubbing. (#38)
- **AUTO-023 Bundle 5** — Peer Q&A (`thread.askPeer`/`answerPeer`) with 60 s timeout, self-ask guard, nesting cap, and cross-process Redis pub/sub. (#38)
- **AUTO-023 Bundle 5** — Author dedup calls `db.listExistingTests` before prompting; reviewer dispatches `playwright.dryRun` with fallback. (#38)
- **AUTO-023 Bundle 5** — Colour-coded tool-call timeline in the UI: `tool_call`/`tool_result` envelopes tagged with `_tool` payload; rendered as `.ac-tool-row` chips in `AgentConversation.jsx`.
- **AUTO-023 Bundle 4** — Per-workspace `agentMode` column (migration `062`, default `pipeline`) gates a supervisor LLM that decides role handoffs; fails open to the linear path on any error.
- **AUTO-023 Bundle 4** — Supervisor LLM bridge (`supervisorAgent.js`), role dispatcher (`autonomousDispatch.js`), and orchestrator (`agentOrchestrator.js`) with `MAX_AUTONOMOUS_STEPS=20` and a 10-minute wall-clock limit.
- **AUTO-023 Bundle 4** — Telemetry histograms: `app_agent_thread_steps`, `app_agent_supervisor_decisions_total`, `app_agent_thread_duration_seconds`, `app_agent_orchestrator_fallback_total`.
- **AUTO-023 Bundle 4** — Settings UI: admin-gated `GET`/`PATCH /api/v1/settings/agent-mode`; mode selector in the Agent Roles section.
- **AUTO-023 Bundle 3** — Reviewer↔author feedback loop (`agentLoop.js#runReviewerAuthorLoop`) bounded by `MAX_REVIEW_ROUNDS` (default 3) and `loopTimeoutMs` (default 5 min); five outcomes: `accept`, `max_rounds`, `timeout`, `quota_exhausted`, `reject_final`.
- **AUTO-023 Bundle 3** — Per-workspace `agent_configs.maxReviewRounds` override (migration `059`) clamped to `[1, 10]`.
- **AUTO-023 Bundle 3** — Per-round artifact diff badges in `AgentConversation` showing `+N added / ~N updated / -N removed`.
- **AUTO-023 Bundle 3** — Single-agent collapse warning (`maybeWarnSingleAgentCollapse`) when author and reviewer share the same `routeId`.
- **AUTO-023 Bundle 2** — Envelope-mediated pipeline handoffs controlled by `SENTRI_AGENT_MODE` env (`pipeline` | `envelope` | `autonomous`, default `pipeline`); writes fire in every mode, reads are gated.
- **AUTO-023 Bundle 2** — Eight pipeline call sites wrapped with `emitHandoffEnvelope`; `messagesToTurns` maps `agent_message` rows to conversation turns in `AgentConversation.jsx`.
- **AUTO-023 Bundle 1** — `agent_messages` table (migration `061`) with covering indexes; append-only, workspace-scoped, 90-day retention.
- **AUTO-023 Bundle 1** — Envelope schema (`agentEnvelope.js`) with frozen `ROLES`/`INTENTS` enums and Zod strict validation; `emitAgentMessage` persists and broadcasts via SSE.
- **INF-009** — Helm chart (`helm/sentri/`) deploying backend + worker Deployments, Postgres StatefulSet, Redis Deployment, Ingress, and a worker HPA driven by `app_queue_depth`.
- **INF-009** — `GET /api/v1/health` extended to verify Postgres and Redis reachability (503 when either is down); worker `/healthz` probe on `WORKER_HEALTH_PORT` (default 3002).
- **INF-009** — Nightly S3 `pg_dump -Fc` backup at 02:00 UTC via `.github/workflows/nightly-backup.yml`; daily + first-of-month snapshots.
- **INF-009** — Operator docs: `docs/guide/kubernetes-deployment.md` and `docs/guide/disaster-recovery.md` (RTO < 4h / RPO < 24h).
- AI Provider TopBar dropdown rewritten as a route-based switcher backed by `provider_routes` rows, with per-row cost tier, health dot, and a `POST /settings/ai-providers/:id/default` action.
- AI Provider Settings — read-only route groups panel showing strategy badges, member counts, healthy-count aggregates, and `usedByRoles` reverse references (Phase 2).
- AI Providers — per-route `probeTimeoutMs` column (migration `060`) with context-aware UI placeholder and `[1 s, 10 min]` clamp (Phase 1).
- Agent conversation narration rewritten in plain English; live per-page crawl progress narrated in real time as `run.pagesFound` ticks.
- Project Settings sidebar shell at `/projects/:id/settings/*` with five sections (Quality / Review / Execution / Security / Self-healing); shared `SidebarShell` component.
- Systems page scoped to infrastructure only; new admin-only AI dispatcher state panel showing open circuit breakers and active sticky fallbacks (`GET /api/v1/system/ai-state`, auto-refreshes every 30 s).
- AI Providers unified Settings surface (`/settings/ai_providers`) with workspace-default flag (`isWorkspaceDefault`, migration `059`), `resolveRoute` fallback layer, and a ⭐ Set as default action.
- Per-agent SSE events emitted at step boundaries in `crawler.js` (steps 1–2) and `pipelineOrchestrator.js` (steps 5–7).
- **GAP-001** — Global workspace search (`GET /api/v1/search?q=…`) over tests, projects, and runs; wired into the ⌘K command palette with keyboard navigation.
- **GAP-002** — Settings `3,595`-line god-file decomposed into 9 lazy-loaded section chunks under `frontend/src/features/settings/`.
- **GAP-003** — Dashboard prioritisation layer: Tier 1 health banner (failing projects / awaiting review / runs in progress), Tier 3 supporting-detail accordion with `localStorage`-persisted state.
- **GAP-004** — Pending-review badge (red pill / pip) on the sidebar Tests entry driven by `useReviewQueueCounts`.
- **GAP-005** — Pipeline stages now carry agent attribution badges and per-stage outcome counts in `PipelineCard.jsx`.
- **ONB-001** — First-Run Wizard (5 steps: welcome → provider → project → crawl kickoff → Review Queue link) replacing the passive tooltip tour; reuses the existing `useOnboarding` hook contract.
- **ONB-002** — Shared `<EmptyState>` primitive retrofitted across Dashboard, Tests, Projects, Runs, HealingDashboard, and TestLab.
- **NAV-001** — Sidebar restructured to 4 groups: Core / Work / Automation / Insights.
- **NAV-002** — Semantic breadcrumbs on RunDetail and TestDetail following the WAI-ARIA APG pattern.
- **AI-001** — Shared `<QualityScoreChip>` + `<QualityScoreExplainer>` with unified 75/50 tier thresholds on ReviewQueue and TestDetail.
- **AI-004** — Shared `LLMContextRow` component showing agent, stage label, and `Stage N/M` progress; wired into both `LLMStreamPanel` and TestLab pipeline view.
- **DASH-003** — Worker pool relocated to `/system`; Dashboard gets a single Platform Health `StatCard` (green/amber/red).
- **DS-001** — `TopBar.jsx` and `TestLab.jsx` inline styles migrated to `.topbar*` and `.tl-*` CSS classes; `NotFound` rebuilt on `.empty-state*` primitives.
- **DS-002 / DS-003** — Spacing (`--space-xs` → `--space-2xl`) and type scale (`--text-xs` → `--text-xl`) design tokens added to `tokens.css`.
- **A11Y-001** — Global `:focus-visible` 2 px outline on all interactive elements (WCAG 2.4.7 / 2.4.11).
- **A11Y-002** — `ModalShell` and `RecorderModal` focus traps with `role="dialog"`, `aria-modal`, and focus-return on close (WCAG 2.1.2).
- **A11Y-004** — `--text3` lifted from `#9ca3af` (2.8:1) to `#6b7280` (4.6:1) for WCAG AA contrast compliance.
- **A11Y-006** — Descriptive `alt` text on test-result screenshots and visual-diff images (WCAG 1.1.1).
- **MOB-002** — Touch targets on named offenders (icon buttons, sidebar nav items, filter chips) raised to 44 px minimum under `@media (pointer: coarse)`.
- **Task 3** — Multi-agent conversation feed (`<AgentConversation>`) replacing `NarrativeFeed` with streamed chat-style turns, per-agent colour palette, ARIA `role="log"`, and a synthesizer/event-driven adapter fallback.
- **Task 2** — `run_agent_events` table (migration `057`) with `emitAgentEvent` helper; SSE snapshot hydrates the full event history on reconnect.

### Changed

- AI Provider default probe timeout raised from 10 s to 30 s; configurable via `AI_PROBE_TIMEOUT_MS` (clamp `[1 s, 5 min]`).
- Settings IA: `providers` and `provider_routes` tabs merged into a single `ai_providers` section; old paths redirect for deep-link compatibility.

### Fixed

- `detectProvider` sticky-fallback role leak: roleless callers no longer match role-scoped sticky entries and vice versa.
- `toDisplayRoute` now uses a static `FAMILY_DISPLAY_LABEL` map instead of reading `process.env` model overrides.
- `PATCH /settings/ai-providers/:id` now emits an operator activity log entry on every provider update.
- Test Lab — switching projects no longer detaches an in-flight run; project sidebar and run view are now decoupled.
- Test Lab — keyboard activation (`Enter`/`Space`) and ARIA tablist pattern added to project sidebar and tab bar (WCAG 2.1.1).
- Test Lab — Retry button on failed/aborted runs re-uses persisted `dialsConfig` and `environmentId` without requiring form re-entry.
- Test Lab — completion banner now derives a per-outcome draft vs. auto-approved split and shows the correct CTA.
- AUTO-023 follow-up — `projectRepo` wires `oracleEnabled`/`reviewerEnabled`/`oracleMaxCostUsdPerRun`/`reviewerMaxCostUsdPerRun` through all CRUD paths (migration `058`).
- AUTO-023 follow-up — `PIPELINE_STEP_ROLES` corrected: step 6 → `oracle`, step 7 → `reviewer`.
- Task 2 / Task 3 — `AgentConversation` now consumes `agent_event` SSE pushes; SSE snapshot dedupes `agentEvents` hydration; per-event `model` field populated via lazy `resolveRoute`; account erasure and run-retry paths now cascade into `run_agent_events`.
- `stageStatus` recognises `interrupted` as a terminal state; no stage pulses indefinitely after a server restart.
- Feedback-loop regeneration now re-scores `playwrightCode`, writes a `reviewComment`, and clears stale approval provenance.
- Quality Insights — bot-blocked runs classified as `BOT_BLOCK` (not a selector failure) and excluded from auto-regeneration.
- Notification bell `[object Object]` display fixed; non-string `title`/`body` values coerced at write time.
- Audit Log — `audit.read` and `audit.export` rows hidden from the default view; opt-in via an "Audit reads" checkbox.
- MOB-001 — Page-level responsive polish for TestRunView grid, MFA enrollment, LLMStreamPanel, Recorder idle form, Systems page, NewProject form, and ApprovalsTimeline at 900/600/480 px breakpoints.
- ENT-004 — `activities.runId` column (migration `055`) enables per-run audit-log deep-links from RunDetail.
- ENT-004 — `tests.reviewComment` column (migration `054`) persists auto-regeneration explanations; surfaced as an amber callout on TestDetail.

---

## [1.8.0] — 2026-05-21
 
### Breaking
 
- **B2 — `agent_configs.provider` / `model` removed** (migration `048`). Dispatch now keys exclusively on `agent_configs.routeId`. Run `node backend/src/database/migrations/scripts/backfill-routes.js` (use `--dry-run` first) before deploying. `resolveProvider` is deleted; `resolveRoute` is the single dispatch path. The `AI_ROUTES_ENABLED` feature flag is removed.
### Added
 
- **B2.1** — Backfill script with `--dry-run`, `--workspace=<id>`, per-workspace transactions, API key encryption, and audit-log entries tagged `source: "backfill-routes"`.
- **B2.2** — Capability auto-probe (`POST /api/v1/settings/provider-routes/:id/probe`); fires automatically on every route upsert when routing-relevant fields change.
- **B2.3** — `resolveVisionModel` reads `route.capabilities.vision` from the probe; falls back to the `VISION_CAPABLE_MODELS` catalog when unset.
- **B2.4** — Per-route pricing: `computeCostForRoute(route, usage)` with 3-tier priority (`route.pricing` → `MODEL_PRICING` → null); `route_name` label on all AI Prometheus metrics.
- **B2.5** — Per-request AI log with PII redaction (migration `047`/`049`): three storage modes per workspace (`none` / `redacted` / `full`), built-in redactors, custom regex rules, and a replay endpoint.
- **B3.1** — Provider Routes Settings tab with per-row CRUD, inline `ProbeBadge`, Rotate key panel, fallback cycle preview, import/export bar, and workspace spend-caps panel.
- **B3.3** — `GET`/`POST`/`PATCH`/`DELETE /api/v1/settings/provider-routes` with admin gate; DELETE returns 409 when an `agent_configs.routeId` references the route.
- **B3.5** — JSON import/export for provider routes; schema at `docs/schema/provider-routes-v1.json`.
- **B3.6** — Key rotation endpoint; probe-before-persist gate; clears route circuit breakers on success.
- **B3.7** — Workspace rate limits and spend caps (migration `050`): token-bucket limiter (Redis-atomic + in-memory fallback), `checkAndReserve`/`reportActual`, rolling spend check; spend alert at configurable threshold.
- **B3.8** — Response caching (migration `051`): SHA-256 cache key, TTL, thundering-herd coalescing, and cache hit/miss/savings Prometheus metrics.
- **B3.9** — Provider route audit log viewer (`GET /api/v1/settings/provider-routes/audit`); 90-day retention sweep.
- **B3.10** — Compat-slot migration script (`compat-to-routes.js`) with `--dry-run` and `--delete-source`.
- **B4.1** — All dispatch paths route through `protocolAdapter.generate`/`.stream`/`.generateVision`; legacy `adapterFor` switch removed from production paths.
- **B4.2** — Observability pivoted to `sum by (provider, route_name)`; two new alerts: `AiSpendCapExceeded` and `AiQuotaRejectionRateHigh`.
- **B4.3** — Migration `053` drops deprecated `agent_configs.fallbackRole`; route-level `fallbackRouteId` is canonical.
- **B4.5** — Load tests for dispatch overhead (p99 < 5 ms) and cache throughput (10 k reads + 1 k writes < 5 s).
- **B4.6** — Route groups (migration `054`): `route_groups` + `route_group_members` tables; `routeGroupResolver.js` supports `weighted`, `latency`, and `cost` strategies; `resolveRoute` delegates transparently when `routeId` starts with `rg-`.
- **B1.x** — Per-workspace `provider_routes` + `provider_route_audit` tables (migrations `035`/`036`); AES-256-GCM encrypted API keys with a 5-minute plaintext cache; `protocolAdapter.js` route-driven entry point; `resolveRoute` four-step priority chain; `AI_ROUTES_ENABLED` feature flag (default off).
- **AI-005** — Multi-agent dispatch: `generateText`/`streamText` accept `agentRole`/`workspaceId`; circuit breakers and sticky fallbacks keyed per `(provider, agentRole)`; AI Prometheus metrics gain an `agent_role` label; vision-heal routed through `agentRole="healer"`.
- **AI-003** — Per-call AI cost tracking via `MODEL_PRICING` catalog; `computeCostUsd` returns `null` for catalog misses; `app_ai_cost_usd_total{provider, operation}` counter bumped on every generation and vision-heal call.
- **AUTO-009** — Browser JS coverage capture per run; `coverageSummary` aggregation; Dashboard Coverage panel; per-project `coverageEnabled`/`sourcemapBaseUrl` controls.
- **AUTO-009k** — Two-stage per-shard coverage merge (pre-aggregate per shard → set-union in finalizer); strips raw `jsCoverage` from `runs.results` after merge.
- **MNT-001** — Vision-based locator healing: stage 7 pixelmatch (sliding-window RGBA comparison) and stage 8 LLM vision (`callVisionModel`); per-project opt-in with daily call cap and monthly USD budget circuit-breaker.
- **AUTO-022** — AI eval harness: deterministic scorer (selector/action/assertion, Levenshtein), golden-set baselines, CI regression gate (>5% aggregate drop exits non-zero), Dashboard trend panel, and `--persist` flag for `metric_samples`.
- **INF-007** — Production observability: OpenTelemetry auto-instrumentation, `AsyncLocalStorage` request correlation (`X-Request-Id`/`traceId`/`spanId`), Prometheus `/metrics` (14 metrics), Sentry crash reporting, and 11 Prometheus alert rules.
### Changed
 
- **B1.x** — Per-workspace provider routes foundation established; `agent_configs.routeId` optional column (migration `037`); legacy `provider`-column shim kept active while `routeId` is null.
- **INF-007** — `app_ai_provider_tokens_total`, `app_ai_provider_latency_seconds`, and `app_ai_provider_errors_total` gain an `operation` label (default `"generation"`). Update Grafana queries to filter by `operation` to split generation vs. vision-heal series.
- **AI-002** — `backend/src/aiProvider.js` refactored into a module layout (`aiProvider/index`, `registry`, `retry`, `modelCatalog`, protocol adapters); thin re-export shim left in place.
### Fixed
 
- **AUTO-009j** — Retention sweep now nulls `shardCoverageSummaries` and `changedFileRanges` columns in addition to `coverageSummary`.
- **AUTO-009d** — Sharded PR-coverage gate now resolves `perSource` bundle URLs through the source-map resolver before intersecting with `changedFileRanges`.
- **AUTO-009d** — `sourceMapStatus` accuracy: resolver probe now runs for all sharded runs with `sourcemapBaseUrl` configured, not only PR-triggered runs.
- **AUTO-009d** — `QualityGatesPanel` `maxCoverageRegressionPct` help text corrected: `0` means "fail on any drop", blank disables.
### Security
 
- **AUTO-009h** — `file://` server-coverage paths validated for `..` traversal and optional prefix allowlist via `COVERAGE_FILE_PATH_PREFIX` env var; runtime re-validates for defence-in-depth.
---

## [1.7.3] — 2026-05-16
 
### Added
 
- **SEC-007** — Compliance audit log: `GET /api/v1/workspaces/:workspaceId/audit-log` with cursor pagination, CSV/NDJSON export, export rate limiter (10/15 min), and an optional SHA-256 prevHash tamper-verification endpoint.
- **SEC-007** — Eight new auth activity types (`auth.login`, `auth.login.failed`, `auth.logout`, `auth.password.reset`, `auth.role.change`, `auth.api_key.create`, `auth.api_key.revoke`, `auth.session.revoke`) capturing `ip` and `User-Agent`.
- **SEC-007** — Meta-audit: reading or exporting the audit log emits `audit.read` / `audit.export` rows (PCI-DSS 10.2.6 / SOC 2 CC7.2).
- **SEC-007** — Event dedup: consecutive identical read-shaped events within `AUDIT_DEDUP_WINDOW_SEC` (default 60 s) collapse into one row with `count++`/`lastAt`; disabled when `AUDIT_HASH_CHAIN=true` (migration `034`).
- **SEC-007 Part C** — SIEM forwarder: `dispatchSiemEvent` pushes each audit row as NDJSON with HMAC-SHA256 signature; 3× retry with backoff; 4xx responses written to `audit_dlq`; per-workspace config endpoint (`GET`/`PUT`/`DELETE /api/v1/workspaces/:workspaceId/siem-config`).
- **SEC-006** — PII firewall in the generation pipeline: emails, phones, SSNs, payment cards (Luhn-checked), JWTs, and auth tokens redacted before prompt construction; `pipeline.pii_redacted` audit rows emitted.
- **SEC-004** — Multi-factor authentication: TOTP enrollment (QR code, encrypted secret), 8-character recovery codes (SHA-256 hashed), WebAuthn/passkey support (Touch ID / Windows Hello / YubiKey), per-workspace MFA enforcement with 0–90 day grace period, and JWT `amr` claim.
- Scalable BullMQ worker pool with queue-depth, active/idle worker, and job-count dashboard metrics; falls back to single-process mode when Redis is unavailable.
- Recorder stealth mode (`stealth: true`) to bypass common headless-browser detection.
- Recorder device profiles (iPhone 14, Pixel 7, iPad Pro, etc.) selectable at session launch or mid-session.
- Recorder element picker: click any canvas element to auto-populate the selector field.
- Recorder `assertCount` and `assertHasClass` assertion kinds.
- Recorder pause, resume, and undo of the last captured step.
### Changed
 
- `POST /api/v1/auth/login` returns `{ mfaRequired: true, pendingToken, methods }` when MFA is enrolled; auth cookie issued only after a successful `/auth/mfa/verify` or WebAuthn exchange. (SEC-004)
- `PATCH /api/v1/workspaces/current` accepts `mfaRequired` and `mfaGracePeriodDays` fields. (SEC-004)
- Worker concurrency reads `WORKER_CONCURRENCY` env var (with `MAX_WORKERS` as fallback).
### Fixed
 
- `render.yaml` Dockerfile path corrected for Render deployments.
### Security
 
- **SEC-006** — Per-project `strictPiiFirewall` and `piiAllowlist` controls.
- **SEC-004** — TOTP secrets AES-256-GCM encrypted; recovery codes SHA-256 hashed, compared with `crypto.timingSafeEqual`; pending-MFA tokens are single-use with 5-minute TTL; per-IP rate limits on enroll/verify endpoints.
- **SEC-007** — Recorder credential redaction: password fields, OTP codes, card numbers, and `data-sentri-secret` fields redacted before storage; generated tests reference `process.env.SENTRI_SECRET_N`.
---

## [1.7.2] — 2026-05-15

### Added
- **AUTO-010** — Root cause clustering: Run Detail now groups failed tests by shared error fingerprint, URL, and selector in a collapsible "Root Cause Summary" panel to reduce triage overhead.
- **CAP-002** — Distributed test sharding: test runs can be split across multiple parallel workers with `shards: N`. Results, quality gates, Web Vitals evaluation, GitHub Check Runs, and CI callbacks are finalized exactly once when all shards complete.
- **DIF-012** — Multi-environment support: projects now support named environments (e.g. staging, production) each with their own base URL and optional credentials. Any run or CI trigger can target a specific environment without modifying the project.
- **CAP-001** — Data-driven test fixtures: upload CSV or JSON fixture files per test to execute one iteration per row. Each iteration result records its fixture row for precise failure attribution.

---

## [1.7.1] — 2026-05-13

### Added
- **AUTO-004** — Impact analysis: CI trigger runs can accept `changedFiles[]` (or auto-fetch changed files from a GitHub PR) to scope execution to only the affected tests; unaffected tests are recorded as `skipped_no_impact`.
- **INT-002b** — GitHub App integration: admins can launch the install flow from Settings; uninstall and repository-removal webhooks automatically disable stale PR check configurations.
- **INT-002** — GitHub Check Runs: projects can opt in to native GitHub PR Check Runs reporting test results, quality gates, and Web Vitals directly on pull requests.
- **AUTO-001** — Risk-based test ordering: tests are ordered by risk score (pass-rate history, recency, self-heal frequency, changed pages) before each run. An optional `budgetMinutes` cap truncates low-risk tests; smoke tests always run first.
- **AI-001** — OpenAI-compatible provider slots: any provider speaking the OpenAI API wire format (DeepSeek, Groq, Mistral, xAI, local LiteLLM, etc.) can be configured as a custom AI provider in Settings.
- AI provider config caching reduces database reads on high-volume pipeline runs; Redis pub/sub invalidates stale entries across instances.

### Security
- **INT-002b** — GitHub App installation IDs are now AES-256-GCM encrypted at rest for SOC 2 / ISO 27001 / HIPAA compliance.

---

## [1.7.0] — 2026-05-08

### Added
- **AUTO-002 / AUTO-015** — Diff-aware crawling: crawl runs compare against a stored baseline and scope test generation to changed pages only; no-change crawls complete without regenerating tests. Vercel and Netlify deployment webhooks trigger preview crawls automatically, with a "Last deployment run" badge in the project header.
- **AUTO-003b** — Confidence-based auto-approval: projects can set an `autoApproveThreshold` (0–1) so high-confidence AI-generated tests are approved without manual review. An `DISABLE_AUTO_APPROVAL` env var overrides all thresholds at runtime without a redeploy.
- **AUTO-017.3** — Web Vitals trend charts: Project Quality card now shows LCP, CLS, INP, and TTFB trend charts per run with threshold lines from project budgets.
- **CAP-004** — Healing Dashboard: new `/healing` page shows self-healing telemetry — per-strategy success rates, top healed selectors, and a savings trend chart.
- **MET-001** — Metric samples time-series: backend records and exposes time-series data for trend chart rendering.
- **PR-7** — Review Queue: new `/review-queue` page for approving and rejecting AI-generated tests across all projects. Two-pane layout with sort, search, category filter, multi-select, bulk actions, keyboard shortcuts (`a` approve, `r` reject, `j`/`k` navigate), and deep-linkable URL state.
- Review Queue accessibility: tab bar, checkboxes, list rows, and quality bar now meet WAI-ARIA authoring-practice requirements.
- Review Queue mobile layout: narrow viewports use a single-pane back-to-list pattern.
- Quality score factor breakdown: quality score chip and bar are now expandable to show the individual scoring factors (e.g. `+20 URL assertion`, `−30 No assertions`).
- Run comparison: `GET /api/v1/runs/:runId/compare/:otherRunId` and a Run Detail **Compare** action show a side-by-side diff of flipped, added, removed, and unchanged test outcomes across two runs. (#AUTO-019)
- Embedded Playwright trace viewer: Run Detail now has an **Open Trace** action that loads the Playwright trace viewer directly in the browser; ZIP download remains available as fallback. (#DIF-005)
- **AUTO-017** — Web Vitals budgets: per-project LCP / CLS / INP / TTFB budget configuration with evaluation on every run completion; gate results are included in CI trigger responses and callbacks.
- OpenRouter provider support: set `OPENROUTER_API_KEY` to route generation through OpenRouter's 200+ model gateway. Streaming, retries, circuit breaker, and rate-limit fallback all apply.
- Automation page restructured into four tabs — Triggers & Schedules, Quality Gates, Integrations, Snippets — with live status chips per project.
- **CAP-003** — AI-generated test code is now scanned for accidentally leaked secrets (AWS keys, JWTs, Bearer tokens) before persistence; flagged tests are rejected and the run is marked `secretScanBlocked`.
- XSS fix: AI-supplied attribute values in the DOM-tree renderer are now HTML-escaped before rendering.
- No-orphan-routes CI guard: PRs that add a backend route without a frontend consumer fail the build.

### Fixed
- `activityRepo.getFiltered` now correctly honours `limit: 0` instead of returning 200 rows.
- Review Queue search input debounced to 300ms — was firing a server request on every keystroke.
- Reject and delete actions in the Review Queue now require confirmation before executing.
- Rejected tests now restore to Draft (not directly to Approved) to re-enter the review queue.
- Journey category filter now filters server-side — pagination totals and tab counts previously reflected the unfiltered dataset.
- Sidebar draft-count badge now invalidates on approve/reject mutations — previously stayed stale for up to 60 seconds.
- Per-test video artifacts are now matched by path instead of directory index — prevents wrong-video attachments on filesystems that return files in non-creation order.

### Removed
- Sprint promotion scripts (`scripts/promote-sprint-item.mjs`) — the manual checklist in `REVIEW.md` is now the canonical hand-off process. (#PROC-002, #PROC-003)
- Dead code left over from the Review Queue migration removed from `Tests.jsx` and `ProjectDetail.jsx`.

---

## [1.6.10] — 2026-05-01

### Added
- **AUTO-016** — Accessibility scanning: every crawled page is scanned with axe-core and violations are persisted per run; CrawlView shows a per-page violation panel and the Dashboard includes a "Top Accessibility Offenders" rollup.
- **DIF-007** — "Edit with AI" panel on Test Detail: describe a change in plain language and receive a diff of the updated Playwright test code with one-click apply.
- **MNT-006** — Object storage abstraction: screenshots, videos, and traces can now be stored in any S3-compatible backend (AWS S3, Cloudflare R2, MinIO) by setting `STORAGE_BACKEND=s3`.
- **AUTO-006** — Network condition simulation: test runs accept `networkCondition: "fast" | "slow3g" | "offline"` to reproduce real-world network scenarios.
- **AUTO-005** — Automatic per-test retry with flake isolation: failed tests are retried up to `MAX_TEST_RETRIES` times (default 2) before recording a true failure. `retryCount` and `failedAfterRetry` are persisted per run for analytics.
- Standalone Playwright export: `GET /api/v1/projects/:id/export/playwright` returns a runnable Playwright project ZIP of all approved tests. (#DIF-006)
- **AUTO-012** — Quality gates: per-project pass-rate, flakiness, and failure-count thresholds; violations are included in run results and CI trigger responses.
- **ENH-036b** — Auto-detect login form fields during crawl: users supply only username and password — CSS selector configuration is no longer required.
- **INF-006** — Root `render.yaml` Blueprint for one-click Render deployment with persistent disk.
- Collapsible sidebar: toggle between full-width and icon-rail mode; state persists across reloads.
- **ENH-036** — Edit existing projects: `PATCH /api/v1/projects/:id` lets admins update name, URL, and credentials without re-entering saved secrets.
- DIF-013 — Anonymous opt-out telemetry via PostHog; disable with `SENTRI_TELEMETRY=0` or `DO_NOT_TRACK=1`.

### Fixed
- Playwright export no longer double-wraps spec files that already contain a complete `import` + `test()` structure. (#DIF-006)

### Security
- **CAP-003** — Secret scanner gate on AI-generated test code. (#12)
- XSS: attribute values in the DOM-tree renderer are now HTML-escaped. (#2)

---

## [1.6.9] — 2026-04-30

### Added
- Anonymous opt-out PostHog telemetry covering install, crawl, generate, run, review, and healing events; no PII collected. Disable with `SENTRI_TELEMETRY=0`. (#DIF-013)
- Per-run network condition simulation (`fast` / `slow3g` / `offline`) with selector in the Run Regression modal. (#AUTO-006)
- Automatic per-test retry and flake isolation; configurable via `MAX_TEST_RETRIES`. (#AUTO-005)
- Playwright project ZIP export for all approved tests. (#DIF-006)
- Conversational test editor — "Edit with AI" panel on Test Detail. (#DIF-007)
- S3-compatible object storage for screenshots, videos, and traces. (#MNT-006)
- Accessibility scanning on every crawled page with axe-core; violations visible in CrawlView and the Dashboard. (#AUTO-016)

---

## [1.6.8] — 2026-04-29

### Fixed
- Recorder canvas is now interactive — pointer, keyboard, and scroll events are forwarded to the headless browser; recording no longer returns "no actions captured". (#DIF-015)
- Recorder SSE screencast frames now paint reliably on the canvas. (#DIF-015)
- Re-recording a project after a crashed session no longer fails with a UNIQUE constraint error. (#DIF-015)
- Timed-out recorder sessions now close their stub run row, unblocking future runs on the project. (#DIF-015)
- Generated Playwright code and the human-readable Step list are now in sync after recording. (#DIF-015)
- Typing in the recorder canvas no longer produces doubled characters. (#DIF-015)
- Right- and middle-button mouse drags now forward the correct button to CDP. (#DIF-015)
- Scrolling inside the recorder canvas no longer scrolls the host page underneath. (#DIF-015)
- Step labels now use plain English (e.g. "User clicks the 'Sign in' button") instead of raw selectors. (#DIF-015)
- Adjacent navigations that differ only by query string are now collapsed into a single step. (#DIF-015)
- Recording sessions now support inline assertion steps (visible / text / value / URL), double-click, right-click, hover, and file-upload actions. (#DIF-015)

---

## [1.6.7] — 2026-04-26

### Changed
- Visual baselines are now browser-aware: baseline storage keys include the Playwright engine (chromium / firefox / webkit) so cross-browser runs no longer diff against Chromium goldens. (#DIF-002b)

---

## [1.6.x] — 2026-04-17 – 2026-04-25

### Added
- Recorder selector engine upgraded to delegate to Playwright's own `InjectedScript`-based generator for ancestor scoring, shadow-DOM traversal, and iframe locator chains. (#DIF-015b)
- `selectorGenerator` now appends `>> nth=N` when a CSS selector matches multiple elements. (#DIF-015b)
- UI login→dashboard and project-create E2E specs. (#QA)

### Fixed
- BullMQ worker no longer writes terminal state (failed status, activity log, SSE event) on non-final retry attempts. (#INF-003)
- Aborting a BullMQ-backed run now correctly signals the worker instead of only updating the database. (#INF-003)
- GDPR account export now includes run logs stored in the `run_logs` table. (#SEC-003)
- SPA CSP nonce injection now works in multi-container deployments via a shared Docker volume. (#SEC-002)
- State-explorer crawl fingerprinting now includes UI component inventory and SPA framework detection for better state discrimination. (#96)
- Per-URL state cap scales with structural diversity, allowing multi-step wizards to be fully explored. (#96)
- Link-crawl journey graph correctly resolves pages with significant query parameters. (#96)
- `notificationSettingsRepo` now returns boolean `enabled` instead of integer `0/1`. (#FEA-001)

### Security
- Content Security Policy: `'unsafe-inline'` replaced with per-request cryptographic nonce. (#SEC-002)
- Notification webhook URLs validated with full SSRF protection at write time and fetch time. (#FEA-001)
- Account export strips `passwordHash` from the payload. (#SEC-003)

---

## [1.5.0] — 2026-04-17

### Added
- **SEC-001** — Email verification on registration: new users must verify their address before signing in; verification emails sent via Resend, SMTP, or console fallback.
- **INF-001** — PostgreSQL support: set `DATABASE_URL=postgres://…` to use PostgreSQL instead of SQLite; all repositories work unchanged via a shared adapter interface.
- **INF-002** — Redis support for rate limiting, token revocation, and SSE pub/sub; falls back to in-memory stores when `REDIS_URL` is unset.
- Docker Compose profiles for optional PostgreSQL (`--profile postgres`) and Redis (`--profile redis`) services.

### Fixed
- OAuth login with a previously-registered unverified email now auto-verifies the account. (#SEC-001)
- Redis rate-limit store initialises after the connection event fires — fixes a startup race condition. (#INF-002)
- PostgreSQL adapter correctly handles string literals containing `@`, `?`, or `LIKE`/`like` — prevents false parameter substitution. (#INF-001)
- PostgreSQL adapter splits multi-statement DDL into individual statements. (#INF-001)
- PostgreSQL adapter uses `AsyncLocalStorage` for concurrency-safe transaction routing. (#INF-001)
- PostgreSQL adapter auto-reconnects on connection loss. (#INF-001)

### Security
- Login blocked for unverified email accounts — returns `403 EMAIL_NOT_VERIFIED`. (#SEC-001)

---

## [1.4.0] — 2026-04-16

### Added
- **ENH-008** — Dedicated `run_logs` table: log lines are single-row INSERTs with a monotonic sequence counter, replacing the previous O(n²) JSON read-modify-write on `runs.logs`.
- **ENH-011** — CI/CD webhook trigger: `POST /api/projects/:id/trigger` (Bearer token authenticated) returns `202 Accepted` with a `statusUrl` for polling and optional `callbackUrl` for push notification on completion.
- Per-project trigger token management: create (plaintext shown once), list, and revoke tokens via the API.
- Dedicated Automation page (`/automation`) with per-project CI/CD tokens, scheduled runs, integration snippets, and deep-link support.
- **ENH-006** — Cron-based test scheduling: configure automated regression runs per project with a 5-field cron expression and IANA timezone; schedules survive restarts and are hot-reloaded on save.
- **ENH-030** — Gitleaks secrets scanning CI job gates all PRs and pushes to `main` before any build proceeds.
- Client-side error reporting: `ErrorBoundary` reports crashes to `POST /api/system/client-error` for server-side logging.

### Changed
- Run log lines persisted to `run_logs` table instead of the `runs.logs` JSON column; `runRepo.getById()` hydrates `run.logs` automatically — no API change for callers.

### Fixed
- `callbackUrl` webhook now fires on any terminal state (completed, failed, aborted) — previously only fired on success, leaving CI pipelines unnotified on failure.
- Scheduler timezone conversion uses `Intl.DateTimeFormat.formatToParts()` — fixes DST transition edge cases.
- Scheduled runs now respect the `PARALLEL_WORKERS` env var.
- `waitFor` added to the valid page-action whitelist — prevents false rejection of tests using `locator.waitFor()`.
- `DeleteProjectModal` warns about permanently destroyed CI/CD tokens and schedules before confirming deletion.

### Security
- Artifact URLs (screenshots, videos, traces) are now HMAC-signed with a configurable TTL; requires `ARTIFACT_SECRET` in production. (#ENH-007)
- Secrets scanning gates the entire CI pipeline. (#ENH-030)

---

## [1.3.0] — 2026-04-14

### Added
- **ENH-020** — Soft delete & Recycle Bin: deleting tests, projects, or runs moves them to a recoverable Recycle Bin; items can be restored or permanently purged from Settings.
- **ENH-010** — Server-side pagination on `GET /api/projects/:id/tests`, `GET /api/tests`, and `GET /api/projects/:id/runs` via `?page=N&pageSize=N`.
- Lightweight `GET /api/projects/:id/tests/counts` endpoint returning per-status counts without fetching row data. (#ENH-010)
- **ENH-024** — Vendor bundle splitting (React, recharts, lucide-react, jspdf emitted as separate cacheable chunks) and animated page skeleton loader for lazily-loaded routes.
- Full-page AI Chat at `/chat` with persistent sessions — create, rename, delete, search, and export as Markdown or JSON. (#83)

### Changed
- `DELETE /api/projects/:id`, `DELETE /api/projects/:id/tests/:testId`, and bulk delete now soft-delete to the Recycle Bin instead of permanently destroying data. (#ENH-020)
- Chat session storage scoped by user ID to prevent cross-account data leakage. (#83)

### Fixed
- Admin "Clear all run history" permanently removes runs — does not soft-delete to the Recycle Bin. (#ENH-020)
- Project cascade-restore only recovers items deleted at the same time as the project; individually-deleted items remain in the Recycle Bin. (#ENH-020)
- Cascade soft-delete is now transactional so all child entities share the same `deletedAt` timestamp. (#ENH-020)
- Project Detail filter pills, tab badges, and Run button state now reflect server-side totals instead of the current page only. (#ENH-010)
- "Tests generated" count in the paginated runs listing no longer shows "—". (#ENH-010)

---

## [1.2.0] — 2026-04-13

### Added
- AI provider API keys are persisted to the database (AES-256-GCM encrypted at rest) and restored on startup — no longer lost on restart or redeployment. (#ENH-004)

### Security
- Artifact serving moved from public static files to HMAC-signed expiring URLs; requires `ARTIFACT_SECRET` env var in production. (#ENH-007)
- Gitleaks secrets scanning gates the entire CI pipeline. (#ENH-030)

---

## [1.1.0] — 2026-04-12

### Added
- Three-tier global rate limiting: general (300 req / 15 min), expensive operations (20 / hr), and AI generation (30 / hr). (#78)
- Password reset via `POST /api/auth/forgot-password` and `POST /api/auth/reset-password` with database-backed tokens that survive server restarts. (#78)
- Per-user audit trail: every activity log entry now records the acting user's identity. (#78)
- **S1-02** — Cookie-based auth: JWT moved from `localStorage` to HttpOnly, Secure, SameSite=Strict cookies; CSRF double-submit cookie on all mutating endpoints.
- Session refresh: `POST /api/auth/refresh` endpoint; frontend refreshes proactively 5 minutes before expiry.
- Responsive layout: sidebar collapses at 768px; off-screen drawer at 480px.
- Command Palette (`Cmd/Ctrl+K`): fuzzy-search commands (Mode 1) with AI chat fallback (Mode 2); prefix `>` for commands, `?` for AI.
- Confirm password field and frontend email validation on the registration form.
- OAuth CSRF protection via state parameter validation.
- VitePress documentation site and GitHub Pages SPA routing.

### Fixed
- Password reset tokens now persisted in the database — survive server restarts and multi-instance deployments. (#78)
- Atomic token claim prevents concurrent replay of the same password reset token. (#78)
- Single-test-run endpoint now uses the expensive-operations rate limiter instead of the AI-generation limiter. (#78)

### Removed
- `CodeEditorModal.jsx` — deprecated component with no consumers.

### Security
- Password reset tokens use a one-time atomic claim — concurrent requests cannot both succeed. (#78)
- Only the latest password reset token per user is valid; requesting a new one invalidates all prior unused tokens. (#78)
- JWT stored in HttpOnly cookies — never exposed to JavaScript, eliminating XSS-based token theft. (#S1-02)
- CSRF double-submit cookie (`_csrf`) on all POST / PATCH / PUT / DELETE endpoints. (#S1-02)
- OAuth state parameter validated before code exchange.
- JWT fallback secret replaced with random per-process generation.
- `verifyJwt` hardened with explicit buffer length check.
