# Sentri — Industry Readiness Audit
> Comprehensive technical, architectural, product, and UX review.
> Reviewed against AGENT.md, ROADMAP.md, full PR #11 surface (~164 files), and current codebase.
---
## 1. Executive Summary
Sentri is an ambitious **AI-native, self-hostable QA platform** with a credible feature set: 8-stage AI generation pipeline, multi-provider LLM (5 providers), self-healing waterfall, human review queue, Playwright export, visual regression, cross-browser, Web Vitals budgets, quality gates, secret scanner, and an embedded trace viewer. **65% of the planned roadmap (53/81 items) has shipped.**
However, Sentri is **not yet enterprise-grade**. The platform is a well-engineered **monolith** with solid feature breadth but shallow depth in the dimensions enterprise buyers scrutinize: multi-tenant isolation, observability, governance, compliance (SOC2/ISO/HIPAA), distributed execution, AI evaluation rigor, and design-system maturity. PR #11 also exhibits **scope-overload risk** — 164 files / ~15k lines across 8+ feature tracks in a single PR, which AGENT.md itself warns against.
**Industry Readiness Score: 6.0 / 10** — strong OSS posture, weak enterprise posture.
---
## 2. Overall Architecture Review
### Findings
| # | Finding | Severity |
|---|---|---|
| A1 | **Monolithic backend** — single Express process owns API, SSE, scheduler, BullMQ workers, browser orchestration, AI calls. INF-003 added BullMQ but workers run in-process by default. No service boundaries. | **High** |
| A2 | **No event bus / domain events** — state changes (test approved, run completed, healing event) are coupled via direct function calls. Plugin system (AUTO-018) is impossible without this. | High |
| A3 | **SQLite-as-default in 2026** — production deployments fall back to SQLite unless explicitly configured. Single-writer model caps horizontal scale at one node. PostgreSQL adapter exists (INF-001) but is the second-class citizen — PR #11 found `_COL_MAP` drift bugs that broke 5+ features on PG. | **Critical** |
| A4 | **Shared constants duplicated frontend/backend** (`constants/activityTypes.js` lives in both trees because Docker prevents cross-import). No `shared/` workspace package, no monorepo tooling (Nx, Turborepo, npm workspaces). Drift is inevitable. | High |
| A5 | **No API versioning beyond `/api/v1`** — breaking changes have no migration story. No deprecation headers, no sunset policy. | Medium |
| A6 | **No SDK** — every consumer (CI, third party) hand-rolls HTTP. Competitors (Cypress Cloud, BrowserStack) ship official SDKs in 4+ languages. | High |
| A7 | **Tight coupling of pipeline stages** — `pipelineOrchestrator.js` directly imports each stage. No DAG runner, no retryable stage boundaries, no per-stage idempotency keys. | High |
### Recommendations
- Extract `worker/` and `scheduler/` into separate runnable entrypoints sharing the same image (`node dist/worker.js`). docker-compose already hints at this; finish it.
- Introduce a `packages/shared/` workspace (npm workspaces — zero new tooling) for activity types, error codes, validation schemas (Zod).
- Promote PostgreSQL to default; relegate SQLite to dev-mode only. Add a CI job that runs the full backend test suite against **both** adapters.
- Adopt an **event bus** (Redis Streams — Redis is already a dep) with typed event contracts. Refactor activity logging, notifications, and PROC-001 to consume events.
- Ship an **OpenAPI-derived TypeScript SDK** (`openapi-typescript-codegen`) — INF-004 gives you the spec already.
---
## 3. Frontend Review
### Findings
| # | Finding | Severity |
|---|---|---|
| F1 | **Plain JS, not TypeScript.** A 2026 SaaS platform of this complexity without TS is a maintainability tax — refactor risk on the 164-file PR is exactly why TS exists. JSDoc-only is not equivalent. | **High** |
| F2 | **No design tokens / design system** — `components.css` + `utilities.css` are ad-hoc. No Storybook, no token JSON, no Figma sync. `ConfigurablePanel` extraction (PR #11) is the *first* shared form scaffold — at 53 shipped features. | High |
| F3 | **No component test infrastructure** — `frontend/tests/` exists but tests utilities, not components. No Vitest+Testing Library, no Playwright component tests, no visual regression on the UI itself (ironic). | High |
| F4 | **Inline-style migration is mid-flight** — `StepResultsView` migrated in PR #11, but the rest of the app still mixes inline styles + CSS classes. | Medium |
| F5 | **No accessibility CI gate** — axe-core runs against *user* sites (AUTO-016) but not against Sentri's own UI. Sidebar / Recorder / Review Queue all need an a11y audit. | High |
| F6 | **State management ad-hoc** — TanStack Query + `sessionStorage` + URL params + local component state. No Zustand/Jotai for cross-component non-server state. TestLab uses `sessionStorage` for SSE persistence — not durable across tabs. | Medium |
| F7 | **No error tracking** — global ErrorBoundary (ENH-027) exists, but there is no Sentry/Rollbar integration. Frontend crashes are invisible. | High |
| F8 | **Bundle size unobserved** — no size-limit CI, no per-route code-split budget. React.lazy is used (ENH-024) but unverified. | Medium |
| F9 | **Recorder is a modal** — modals don't compose with deep workflows. Competitors (Mabl, BearQ) use full-page recorders. | Low |
### Recommendations
- Migrate to TypeScript file-by-file (start with `api.js`, `utils/`). Allow `.js` + `.ts` coexistence via `allowJs`.
- Build a Storybook with at minimum: Buttons, Form fields, Modal, Card, Badge, ChartCard, Empty/Loading/Error states. Tie tokens to CSS custom properties.
- Add Vitest + Testing Library; require ≥1 test per new component as part of REVIEW.md.
- Add `@axe-core/react` in dev mode + Pa11y CI on critical routes.
---
## 4. Backend Review
### Findings
| # | Finding | Severity |
|---|---|---|
| B1 | **No request-scoped logger / trace context.** `formatLogLine()` is good but not correlated. No `requestId`, no `runId` propagation to downstream LLM/Playwright calls. | **High** |
| B2 | **No OpenTelemetry instrumentation.** No traces, no metrics, no spans. Datadog/Honeycomb/Grafana unreachable. | **Critical** for enterprise. |
| B3 | **Repository layer is procedural, not domain-modeled.** Nearly every repo exposes raw rows. No domain entities, no invariants enforced. `bulkUpdateReviewStatus` with `extraFields` is a code smell — the domain is leaking into SQL helpers. | High |
| B4 | **Migration system fragile** — duplicate `015_*` and `007_*` prefixes (resolved-by-devin marked it convention-only, but AGENT.md/STANDARDS.md prescribe NNN-unique). No down migrations. No migration linter. | Medium |
| B5 | **Validation inconsistent** — some routes use ad-hoc `validateProjectPayload`, some don't (`isThresholdOnly` PATCH bypass at projects.js:148 is risky). No Zod/Joi/io-ts. | High |
| B6 | **Secret scanner regex set is hardcoded and tiny** (3 rules + .gitleaks.toml). Real gitleaks ships ~150 detectors. | Medium |
| B7 | **No background-job dead-letter queue UI**, no retry visibility, no BullMQ Bull-Board mounted. Operators flying blind. | High |
| B8 | **Rate limiting is global tier-based** (ENH-005) — not per-tenant, not per-endpoint cost-aware. AI endpoints (expensive) share buckets with cheap GETs. | High |
| B9 | **Auto-approval kill-switch via env var** is a single global toggle — should be per-workspace, audited, and revertible from UI. | Medium |
---
## 5. AI / Agent Architecture Review
### Findings
| # | Finding | Severity |
|---|---|---|
| AI1 | **No agent orchestration framework.** The "8-stage pipeline" is a hardcoded sequence, not an agent loop. No planning, no reflection, no tool-use. Compared to OpenDevin / CrewAI / LangGraph, Sentri is a templated chain, not an agent. | **Critical** for "Autonomous QA" brand promise. |
| AI2 | **No AI evaluation framework.** No golden-set regression tests for the pipeline. No LangSmith/Braintrust/Phoenix integration. Prompt changes ship on intuition (MNT-003 acknowledges this). | **Critical** |
| AI3 | **No prompt versioning at runtime** — `promptVersion` stored on tests but no A/B mechanism, no shadow eval, no automatic rollback on quality drop. | High |
| AI4 | **No hallucination guardrails** — secret scanner exists (CAP-003), but no schema-validated tool-output, no JSON-mode enforcement consistent across providers, no "did the AI cite a real URL/selector that exists in the crawl graph?" check. | High |
| AI5 | **No memory / long-term context.** Each generation is stateless. No project-scoped memory of "we tried this selector pattern, it failed." Self-healing history is the closest thing — not exposed to the generator. | High |
| AI6 | **Confidence scoring is naive** (`quality / 100`). No per-step confidence, no uncertainty quantification, no calibration validation (the Reliability Diagram). PR #11 hardcodes thresholds with magic numbers. | High |
| AI7 | **No multi-agent collaboration.** Crawler, generator, healer, validator are independent functions. No shared blackboard, no negotiating agents. The roadmap's "AUTO" label oversells the autonomy. | High |
| AI8 | **No cost observability.** Token usage not tracked per project / per run / per provider. No budget caps, no cost dashboards. BYOK helps but doesn't replace this. | **High** |
| AI9 | **No fine-tuning / RAG over user's own codebase.** Generator can't see existing tests when adding new ones — hello, duplication. | High |
| AI10 | **No AI debugging assistant on failure.** AUTO-021 plans this but unshipped. AUTO-010 (root cause clustering) similarly unshipped. | High |
### Recommendations (AI)
- Adopt **LangGraph** or a homegrown DAG runner for the pipeline. Stages become typed nodes with retry, timeout, idempotency.
- Stand up **Phoenix** (Arize) or **LangSmith** for trace + eval. Define a 50-test golden set; CI fails on >5% regression.
- Add **per-project token budgets** with a circuit breaker. Emit `ai.tokens.consumed` metric samples (MET-001 infra exists).
- Implement **RAG over existing approved tests** before generation — drop into the prompt as "do not duplicate these patterns."
- Add a **Critic agent** that validates generator output against the crawl graph (selectors must exist, URLs must be reachable).
- Expose **healing history** to the generator so repeated selector failures shape future generations.

---

## 6. UI/UX Review

Findings against modern SaaS bar (Linear, Vercel, Datadog, Retool):
| U1 | IA sprawl — 5 new top-level pages in one PR, no IA doc | High |
| U2 | No onboarding / first-run tour / sample project | High |
| U3 | Empty/Loading/Error states inconsistent across pages | Medium |
| U4 | No command palette discoverability hints; shortcuts undocumented | Medium |
| U5 | Two-tone approval badges (🤖/👤) unfamiliar — needs legend | Low |
| U6 | Recorder modal can't be resized/popped-out | Medium |
| U7 | Dashboard data-viz is bar charts only — no percentile/heatmap | Medium |
| U8 | No dark/light theme toggle parity audit | Low |
| U9 | Approvals Timeline + Review Queue overlap — confusing mental model | High |
| U10 | Mobile responsiveness untested beyond breakpoints in StepResultsView | High |
## 7. Security Review
| S1 | **No MFA** (SEC-004 planned) — table stakes in 2026 | Critical |
| S2 | **No SSO/SAML** (SEC-005 planned) — enterprise blocker | Critical |
| S3 | Auto-approval kill-switch is global env var, not audited per-workspace | High |
| S4 | Secret scanner has 3 built-in rules vs gitleaks ~150 | High |
| S5 | Trace viewer CSP relaxes `unsafe-inline` + `wasm-unsafe-eval` — scoped but worth pen-test | Medium |
| S6 | Credentials encrypted at rest but no KMS / envelope encryption | High |
| S7 | No tenant data-isolation tests (cross-workspace ACL coverage thin) | High |
| S8 | No CSP report-uri / violation telemetry | Medium |
| S9 | No bug-bounty / responsible disclosure policy in repo | Medium |
| S10 | No SBOM / SLSA provenance / signed container images | High |
| S11 | LLM prompt-injection from crawled pages not mitigated (AI reads scraped DOM) | **Critical** |
| S12 | No PII redaction before sending DOM/screenshots to LLM | **Critical** |
## 8. Performance & Scalability
| P1 | SQLite default → single-writer ceiling | Critical |
| P2 | No read replicas, no caching layer (Redis used only for rate-limit/SSE) | High |
| P3 | `getByTestIds` chunked at 100 — fine; but no query-plan / slow-query log | Medium |
| P4 | No browser-pool reuse across runs; each run cold-starts Chromium | High |
| P5 | No CDN for artifacts; signed URLs hit origin | Medium |
| P6 | Frontend has no bundle-size budget in CI | Medium |
| P7 | No load tests (k6/Artillery) for SSE fan-out under 1k concurrent runs | High |
## 9. Enterprise Readiness
- ❌ SOC2 / ISO27001 / HIPAA controls absent
- ❌ Audit log export / SIEM integration absent
- ❌ Data residency / region pinning absent
- ❌ Customer-managed keys (CMK) absent
- ❌ Per-tenant resource quotas absent
- ❌ Org-level usage analytics + invoicing absent
- ❌ Service-account / machine-identity model absent (only user JWTs + trigger tokens)
- ❌ Legal: DPA, ToS, sub-processor list absent from repo
- **Verdict: Not enterprise-ready. ~12–18 months of work.**
## 10. DevOps & Infrastructure
| D1 | docker-compose only — no Helm chart / Terraform / K8s manifests | High |
| D2 | No blue-green / canary deploy story | High |
| D3 | No DR / backup playbook for SQLite or PG | Critical |
| D4 | CI matrix tests one Node version, one DB | Medium |
| D5 | No image scanning (Trivy/Grype) in CI | High |
| D6 | No Renovate group rules — noisy dep PRs | Low |
| D7 | `postinstall` copies trace-viewer — fragile vs Playwright internals | Medium |
## 11. Observability & Monitoring
| O1 | No metrics endpoint (Prometheus `/metrics`) | Critical |
| O2 | No distributed tracing (OTel) | Critical |
| O3 | No structured-log shipper docs (Loki/Datadog) | High |
| O4 | No SLO/SLI definitions | High |
| O5 | No synthetic monitoring of Sentri itself | Medium |
| O6 | `metric_samples` table is a primitive but only healing+vitals use it | Medium |
| O7 | No alerting rules / runbooks | High |
## 12. Product Strategy Gaps
1. **"Autonomous" brand vs reality** — pipeline is templated, not agentic. Either re-brand or invest in real agents.
2. **No pricing / packaging surface** in product (free vs team vs enterprise).
3. **No marketplace** for plugins, prompts, recipes (AUTO-018 planned).
4. **No mobile native app testing** (Appium / Detox) — only web.
5. **No API testing first-class** — bullet says "HAR-based" but no Postman-grade UX.
6. **No load/perf testing** (k6 / Locust integration).
7. **No collaboration features** — comments, mentions, assignments on tests/runs.
8. **No analytics on test ROI** (cost per test, defects caught, MTTR delta).
9. **No public template gallery** — first-run friction.
10. **Documentation lives in repo VitePress** — no in-app contextual help.
## 13. Critical Risks
1. **PR #11 size** — 164 files violates AGENT.md scope rules; review fatigue → bugs leak.
2. **PostgreSQL adapter drift** — caught once in PR #11, will recur.
3. **Prompt-injection / PII leak via crawled content → LLM**.
4. **No AI eval harness** — silent quality regressions.
5. **Migration numbering collisions** — convention violated twice in this PR.
6. **SQLite in prod** — data loss / corruption under concurrent load.
7. **No DR plan** — single-disk loss = customer data loss.
8. **Self-healing telemetry never feeds back into generator** (MNT-002).
9. **Trace viewer CSP relaxation** — supply-chain risk via Playwright internals.
10. **Recorder coupling to Playwright internals** (`InjectedScript`) — semver-uncovered.
## 14. Missing Industry-Standard Features
- TypeScript everywhere · OpenTelemetry · Prometheus metrics · Helm chart · Storybook + design tokens · Sentry/Rollbar · MFA/SSO · Audit log export · Mobile testing · API testing UX · Load testing · Public SDK (TS/Python/Go) · Marketplace · Test impact analysis · Code coverage · Distributed sharding · Agent eval/golden-set · Token-cost dashboards · Per-tenant quotas · CMK/BYOK encryption · SBOM/SLSA · Bug bounty · DPA · Status page · In-app docs · Slack app (not just webhook) · Jira/Linear bidirectional sync.
## 15. Technical Debt
1. Duplicated constants (backend/frontend `activityTypes.js`).
2. Migration prefix collisions (007, 015).
3. Inline styles still present outside StepResultsView.
4. JS over TS across 100% of frontend + 100% of backend.
5. Repos return raw rows — no domain entities.
6. Auto-approval thresholds hard-coded magic numbers in 3 places (`/100` normalization).
7. `bulkUpdateReviewStatus(extraFields)` API smell.
8. Recorder script uses `${fn.toString()}` and string-inlining tricks.
9. SSE persistence via `sessionStorage` — fragile.
10. PR #11 deletes 5 components and adds 1 monolithic TestLab — UX continuity untested.
11. `ConfigurablePanel` only just extracted — same pattern duplicated in 3+ other panels.
12. `_COL_MAP` in PG adapter requires manual sync per camelCase column.
13. No Zod/io-ts request validation.
14. No request-id propagation.
15. Plugin system absent → every integration is hardcoded.
## 16. Competitor Comparison (Sentri vs)
| Dim | Sentri | Mabl | BearQ | Cypress Cloud | Playwright OSS | LangSmith |
|---|---|---|---|---|---|---|
| Self-host | ✅ | ❌ | ❌ | ❌ | ✅ | ❌ |
| AI generation | ✅ templated | ✅ | ✅ | ❌ | ❌ | n/a |
| True agentic loop | ❌ | partial | ✅ | ❌ | ❌ | ✅ |
| Eval harness | ❌ | ✅ | ✅ | n/a | n/a | ✅ |
| Distributed shards | ❌ | ✅ | ✅ | ✅ | ✅ | n/a |
| Mobile native | ❌ | ✅ | ✅ | ❌ | partial | n/a |
| API testing | partial | ✅ | ✅ | ✅ | ✅ | n/a |
| Observability native | ❌ | ✅ | ✅ | ✅ | n/a | ✅ |
| Marketplace | ❌ | ✅ | ✅ | ✅ | ✅ | n/a |
| Enterprise SSO | ❌ planned | ✅ | ✅ | ✅ | n/a | ✅ |
## 17. Immediate High-Priority Fixes (next 4 sprints)
1. Split PR #11 into focused PRs going forward — enforce in REVIEW.md (max 25 files).
2. Promote PostgreSQL to default; add CI matrix `db: [sqlite, postgres]`.
3. Adopt **TypeScript** in `packages/shared/` first; consume from both apps; eliminate duplicated constants.
4. Add **OpenTelemetry** + `/metrics` Prometheus endpoint.
5. Add **Sentry** for frontend + backend crash reporting.
6. Stand up **AI eval harness** (Phoenix or homegrown) with a 50-case golden set.
7. **Prompt-injection mitigation** — strip scripts from crawled DOM, redact PII via `microsoft/presidio` before sending to LLM.
8. Add **Zod request validation** to all routes; remove `isThresholdOnly` PATCH bypass.
9. Add **Storybook** + design tokens; require stories for new components.
10. Add **Helm chart** + K8s readiness/liveness probes.
11. Add **bundle-size**, **Lighthouse**, **axe-core** CI gates against Sentri's own UI.
12. Add **per-tenant rate limiting** with cost weighting on AI endpoints.
13. Add **token-cost dashboard** + per-project budget caps.
14. Add **MFA (SEC-004)** before any paid tier launches.
15. Add **DR/backup playbook** + automated nightly DB dumps.
## 18. Long-Term Strategic Improvements (6–18 months)
- Migrate pipeline to **LangGraph-style DAG** with retries / checkpoints / human-in-loop nodes.
- Stand up **multi-agent system**: Planner, Crawler, Generator, Critic, Healer agents on a shared blackboard.
- Build a **plugin marketplace** + public SDK (TS/Python).
- Add **mobile native testing** via Appium driver.
- Add **API testing UX** parity with Postman/ReadyAPI.
  
- Add **distributed sharding** (CAP-002) + autoscaled K8s worker pool.
- Add **SOC2 Type II** controls: audit log export, CMK, data residency, sub-processor list, DPA.
- Add **SSO/SAML/SCIM** (SEC-005) with per-workspace IdP config.
- Add **org-level analytics**: token spend, defects-caught, MTTR delta, ROI dashboard.
- Add **collaboration**: comments/mentions/assignments on tests + runs (Linear-grade).
- Add **template gallery** + sample projects to kill empty-state friction.
- Add **in-app contextual docs** (à la Vercel) instead of repo VitePress only.
- Add **status page** + public SLA.
- Add **mobile-responsive shell** end-to-end (not just StepResultsView).
- Migrate frontend to **TypeScript** fully; introduce Storybook + Chromatic.
- Re-architect into **services**: api-gateway, orchestrator, worker-pool, ai-broker, scheduler.
- Adopt **Redis Streams** as event bus; refactor activity log + notifications + healing telemetry as event consumers.
- Build **AI eval pipeline** with nightly golden-set runs; auto-rollback on >5% regression.
- Build **prompt-injection / PII firewall** layer between crawler and LLM (presidio + content-security policies for DOM ingestion).
- Build **agent observability** (LangSmith / Phoenix self-hosted) with per-step traces, costs, latencies.
## 19. Recommended Architecture Changes

```
                  ┌────────────────────────┐
   browser ──────►│  api-gateway (Express) │──► OpenAPI + SDK
                  └────────────┬───────────┘
                               │ events (Redis Streams)
        ┌──────────────────────┼──────────────────────┐
        ▼                      ▼                      ▼
 ┌──────────────┐      ┌───────────────┐      ┌────────────────┐
 │ orchestrator │      │  ai-broker    │      │   scheduler    │
 │  (LangGraph) │◄────►│ (LLM + eval)  │      │ (BullMQ+cron)  │
 └──────┬───────┘      └───────┬───────┘      └────────┬───────┘
        │                      │                       │
        ▼                      ▼                       ▼
   ┌────────────────────────────────────────────────────────┐
   │  worker pool (stateless containers, K8s autoscaled)    │
   │   • crawler agent  • generator agent  • runner agent   │
   │   • healer agent   • critic agent                      │
   └────────────────────┬───────────────────────────────────┘
                        ▼
            ┌──────────────────────┐
            │  Postgres (primary)  │
            │  + Redis (cache/bus) │
            │  + S3 (artifacts)    │
            │  + OTel collector    │
            └──────────────────────┘
```

Key shifts:
1. **api-gateway** is thin; emits events; never blocks on AI/Playwright.
2. **orchestrator** runs the pipeline as a typed LangGraph DAG with checkpoint + resume.
3. **ai-broker** is the *only* process that talks to LLM SDKs; centralizes cost, eval, prompt-injection guard, PII redaction, fallback, circuit-breaker.
4. **worker pool** is K8s-autoscaled stateless containers; each agent is independent.
5. **Postgres + Redis + S3 + OTel** are the four shared infra primitives.
6. **`packages/shared/`** holds types, Zod schemas, activity constants, error codes — consumed by all services + frontend.
7. **Plugin host** lives inside orchestrator with a typed lifecycle (`beforeRun`, `afterStep`, `onHealAttempt`, `onRunComplete`).
## 20. Final Industry Readiness Score
| Dimension | Score | Notes |
|---|---:|---|
| Feature breadth | 8.0 | Wide and ambitious |
| Feature depth | 5.5 | Many features shipped shallow |
| Architecture | 5.0 | Monolith; PG second-class |
| Security | 4.5 | No MFA/SSO/CMK; prompt-injection unmitigated |
| Scalability | 5.0 | SQLite default; no sharding |
| Observability | 3.0 | No OTel/metrics/Sentry |
| AI rigor | 4.0 | No eval harness; templated, not agentic |
| UX maturity | 5.5 | No design system / Storybook / a11y CI |
| DevOps | 5.0 | docker-compose only; no Helm |
| Enterprise readiness | 3.0 | No SOC2/SSO/audit export |
| Documentation | 7.0 | Strong AGENT/ROADMAP/REVIEW culture |
| OSS posture | 8.5 | Self-host + multi-LLM + Playwright export = real moat |
**Overall: 6.0 / 10**
Sentri has a **defensible OSS niche** (self-host + multi-provider LLM + standalone export + human review queue — no competitor has all four). To cross into enterprise it must invest in: TypeScript, OTel, AI eval, MFA/SSO, K8s/Helm, prompt-injection guard, design system, distributed sharding, and a public SDK. Estimated **12–18 months of focused work** with the current 2-engineer team.
---
## Severity Legend
- **Critical** — block enterprise adoption / data-loss risk
- **High** — material credibility / scale risk
- **Medium** — quality / DX cost
- **Low** — polish
## Suggested Next Sprint Re-prioritization
Pause net-new differentiators. Land in order:
1. AI eval harness + prompt-injection/PII guard (AI-CRIT-1)
2. OpenTelemetry + Sentry + `/metrics` (OBS-CRIT-1)
3. PostgreSQL as default + CI matrix (ARCH-CRIT-1)
4. Zod validation across routes (SEC-HIGH-1)
5. `packages/shared/` workspace + TS migration kickoff (DEBT-HIGH-1)
6. SEC-004 MFA before any paid tier
7. Storybook + design tokens + a11y CI (UX-HIGH-1)
8. Helm chart + DR playbook (DEVOPS-CRIT-1)
   Then resume the remaining ROADMAP.md Phase 4 items (AUTO-008–011, AUTO-014, AUTO-018, AUTO-021) — AUTO-001 + INT-002 shipped in PR #15, AUTO-004 shipped in PR #18 (test impact analysis from git diff / GitHub PR files), AUTO-002 + AUTO-015 shipped in PR #12 (diff-aware crawling + Vercel/Netlify deployment webhooks). Current sprint is CAP-001 (data-driven testing — parameterized iterations); DIF-012, CAP-002, AUTO-010 hold queue slots 1–3. 