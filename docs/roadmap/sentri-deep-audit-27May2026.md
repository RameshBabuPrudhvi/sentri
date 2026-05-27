# Sentri — Deep Code-Level Platform Audit
### Principal Architect · Staff QA Engineer · Product Reviewer · UX Expert

> **Audit methodology:** Full source read across every critical module. Findings are cited to specific files, line patterns, and actual code constructs — not inferred from documentation.
>
> **Platform version:** 1.9.0 · Node 20 ESM · Express 4 · React 18 · SQLite → PostgreSQL · BullMQ · Redis

---

## 1. Executive Summary

Sentri is an earnestly ambitious platform with genuinely sophisticated engineering in some areas — particularly the multi-agent orchestration, AI provider abstraction, and self-healing waterfall. However, a set of structural defects, unfinished security mitigations, and architectural compromises are now load-bearing at production scale. The most serious are not documentation problems — they are coded into the production paths.

**The five most damaging verified defects in the actual codebase:**

1. **`deasync.loopWhile()` blocks the Node.js event loop on every PostgreSQL query** (`database/adapters/postgres-adapter.js:562` — `deasyncLib.loopWhile(() => !done)`). Under concurrent load, this is a hard event-loop stall. All HTTP request handling, SSE streaming, and BullMQ callbacks freeze while any query runs.

2. **AI-generated code executes inside a `vm` sandbox with documented escape vectors** (`runner/codeExecutor.js`). The file explicitly warns: *"Node.js docs explicitly warn: The vm module is not a security mechanism."* The `page` object injected into the sandbox exposes `page.constructor.constructor('return process')()`, giving malicious generated code access to `process.env` — including `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `JWT_SECRET`, and `ENCRYPTION_KEY`. The comment `"We do NOT strip process.env"` confirms this is an active, unmitigated exposure.

3. **Duplicate migration numbers** cause a non-deterministic, order-dependent schema — files `007`, `015`, `021`, `035`, `036`, `037`, `054`, `059` each have two sibling files with the same numeric prefix (e.g., `015_mfa_columns.sql` and `015_run_secret_scan_blocked.sql` and `015_web_vitals_budgets.sql`). The runner sorts alphabetically by full filename — so the application of these migrations depends on filesystem sort of the suffix, not any explicit ordering. A schema drift on a new installation vs. an upgraded one can silently produce different column presence.

4. **The supervisor prompt is 9 lines of system instruction** (`prompts/supervisorPrompt.js`). The entire routing intelligence of the autonomous multi-agent system — deciding which of 5 agents acts next, when to terminate, and what instruction to give — rests on: `"You are Sentri supervisor agent. Decide which role should act next or terminate the thread."`. This is insufficient for a production supervisor that must handle crawl data, test generation context, and multi-step QA flows without looping.

5. **`browserPool.js` does not exist.** Every test in every regression run launches a fresh Chromium process via `launchBrowser()` in `testRunner.js:510`. At ~800ms per launch, a 50-test suite wastes 40 seconds before a single line of test code runs. MNT-015 is the current sprint target but is unshipped.

**Overall score: 6.0 / 10.** Strong fundamentals in auth, observability, and agent architecture. Critically weak in execution isolation, DB layer, migration hygiene, and the autonomous agent's reasoning quality.

---

## 2. Overall Architecture Review

### 2.1 Verified Structural Observations

**The monolith boundary is intact.** `backend/src/index.js` imports directly from `routes/`, `crawler.js`, `testRunner.js`, `scheduler.js`, and `workers/runWorker.js` in a single process. Despite having separate `backend` and `worker` deployments in the Helm chart, the codebase has no module boundary enforcement — `routes/tests.js` imports `crawler.js` and `testRunner.js` inline, meaning a route handler that fires during a long-running generation task can starve on the same event loop.

**The repository layer is 30+ files, all synchronous.** Every repo call is: `db.prepare(sql).all()` / `.get()` / `.run()`. These are blocking SQLite calls on `better-sqlite3`, which is fine for SQLite. When the PostgreSQL adapter takes over, these same synchronous calls are routed through `deasyncLib.loopWhile` (see §4.1). This is the single highest-severity architectural debt item.

**Queue optionality creates a two-tier production model.** `queue.js` falls back to `runWithAbort` in-process execution when `REDIS_URL` is unset. This means BullMQ durability, retry, and cross-process abort are silently unavailable in minimal deployments. There is no boot-time warning for this degraded mode. An operator who forgets `REDIS_URL` is running with fire-and-forget execution and no job recovery.

---

## 3. Frontend Deep Review

### 3.1 Component Scale and Decomposition

The feature-sliced migration is real but incomplete. `features/settings/sections/` and `features/project-settings/sections/` show clean extraction — small focused components, one concern per file. But the four heaviest pages were never touched:

| File | Lines | State variables | Hooks | Verdict |
|---|---|---|---|---|
| `pages/TestLab.jsx` | 1,899 | 30+ | 8 custom hooks | Cannot safely add features |
| `pages/ReviewQueue.jsx` | 1,460 | 25+ | 6 custom hooks | Review UX tightly coupled |
| `pages/TestDetail.jsx` | 1,012 | 20+ | 5 custom hooks | Needs extraction |
| `pages/Dashboard.jsx` | 833 | 15+ | 3 custom hooks | Manageable but dense |

`TestLab.jsx` is especially concerning: it manages SSE state, multi-run state, session storage persistence, project selection, run config, pipeline visualization, recorder modal, queue display, and launch/cancel — all in one component tree. Adding any new generation feature requires a reviewer to load ~2,000 lines of context before making a safe change.

### 3.2 `dangerouslySetInnerHTML` Chain Analysis

Five confirmed usages. The actual risk varies:

- `AIChat.jsx` + `ChatHistory.jsx`: LLM-generated content → `renderMarkdown(msg.content)` → `dangerouslySetInnerHTML`. `markdown.js` uses a hand-rolled renderer. There is no DOMPurify pass. If the LLM generates markdown containing `<script>` or `<img onerror=...>`, it will execute in the reviewer's browser. **This is a stored XSS vector via the AI conversation history.**

- `ReviewQueue.jsx`: `highlightCode(code)` → `dangerouslySetInnerHTML`. `highlightCode.js` escapes HTML entities (`&`, `<`, `>`, `"`, `'`). Lower risk but relies on the correctness of a hand-rolled escaper.

- `StepResultsView.jsx`: The comment explicitly notes: *"a malicious site under test could inject markup via dangerouslySetInnerHTML"* and the code proceeds. The attrs value comes from captured page content, which is attacker-controlled.

### 3.3 State Management

All 30+ repository hooks use TanStack Query (a strong choice). However, `TestLab.jsx` maintains a parallel local state tree (`activeRun`, `runData`, `logLines`) mirrored to `sessionStorage`. This creates two sources of truth for run state — the TanStack Query cache and the session storage mirror. The comment in the code acknowledges this: *"Today only mounts the drawer + maintains a parallel state shape; the single-run `useRunSSE` above still drives the live SSE connection. Follow-up PR migrates..."*. This dual-source pattern is a latent bug — a cache invalidation that updates TanStack Query but not `sessionStorage` will show stale data on re-mount.

### 3.4 Font CDN Dependency

`tokens.css` imports Google Fonts via `@import url('https://fonts.googleapis.com/css2?...')`. This fires on every page load, creates a render-blocking external HTTP request, violates GDPR for EU deployments that haven't consented to Google data processing, and would break CSP if `font-src` is tightened beyond `'self' data:`. The fix is a 30-minute `@fontsource` migration.

---

## 4. Backend Deep Review

### 4.1 The `deasync` Event-Loop Blocking Crisis

**File:** `backend/src/database/adapters/postgres-adapter.js:562`

The exact production code path when `pg-native` is unavailable (the more common case — `pg-native` requires native compilation):

```js
pool.query(sql, values)
  .then(r => { result = r; done = true; })
  .catch(e => { error = e; done = true; });

deasyncLib.loopWhile(() => !done);   // ← EVENT LOOP BLOCKED HERE
```

`deasyncLib.loopWhile` calls Node's `uv_run(UV_RUN_ONCE)` in a C-level spin loop until `done = true`. During this spin:
- All other I/O callbacks (incoming HTTP requests, SSE heartbeats, Redis pub/sub, BullMQ job processing) are frozen.
- Under 10 concurrent requests each making 3 DB queries: 30 sequential `loopWhile` spins, each blocking all other I/O for the duration of one Postgres round-trip (~2–10ms on LAN). At p99 this is 300ms of pure event-loop stall per request wave.
- Under BullMQ with 4 parallel workers each making DB queries: the workers' callbacks and the HTTP server share the same event loop. A long query during a high-concurrency run can stall the entire API.

There is also a concurrent transaction interleaving bug the code acknowledges: *"deasyncLib.loopWhile() interleaves event-loop turns from other requests"* — meaning while one transaction is holding `BEGIN`, another request's queries can execute between that transaction's statements if they happen to run during the `loopWhile` spin. The `AsyncLocalStorage` transaction-token mechanism mitigates but does not eliminate this — two concurrent `loopWhile` spins from different requests can process each other's event-loop callbacks.

**This is the single most severe architectural defect in the codebase.**

### 4.2 Migration Number Collisions

Running `ls migrations/*.sql | sed 's/.*\///' | cut -d_ -f1 | sort | uniq -d` on the actual migration directory yields: `007`, `015`, `021`, `035`, `036`, `037`, `054`, `059` — all with duplicate numeric prefixes. The `discoverMigrations()` function in `migrationRunner.js` does:

```js
return fs.readdirSync(MIGRATIONS_DIR)
  .filter(f => f.endsWith(".sql"))
  .sort()                              // ← alphabetical sort by full filename
  .map(f => ({ version: f.replace(/\.sql$/, ""), filePath: ... }))
```

Since `version` is the full filename (e.g. `015_mfa_columns`), each duplicate gets a distinct version key and both get applied. The issue is **ordering** — `015_mfa_columns.sql` sorts before `015_run_secret_scan_blocked.sql` which sorts before `015_web_vitals_budgets.sql`. This is currently coincidentally correct but brittle. Adding a new migration with a colliding number (e.g. `015_new_feature.sql`) would insert it alphabetically between existing applied migrations — the runner skips already-applied versions by key, so a new file with an entirely new name gets applied, but its position in the sequence depends on the alphabet. If `015_new_feature.sql` requires the `mfa_columns` migration to have run first and it sorts before it alphabetically, it will fail on a fresh install while passing on an upgraded one.

**The fix is trivially enforced** by a CI lint that counts numeric prefixes and fails on any duplicate. This is not done.

### 4.3 Route Files as God Objects

`backend/src/routes/tests.js` is 1,941 lines doing 8 distinct concerns (listed in its own header comment). This file:
- Contains inline CSV parsing (`parseCsvRows`, ~60 lines of hand-rolled RFC-4180 parser)
- Contains the `dedupeTestName` helper for recorder saves
- Contains the `resolveEnvOrThrow` utility
- Contains the `clampIterationCap` and `parseTags` helpers
- Contains all recorder start/stop/input/undo/pause routes
- Contains all test CRUD routes
- Contains AI generation trigger
- Contains bulk approve/reject/restore/delete

The REFACTOR-NOTE at the top of the file explicitly says this should be split — it has been noted but not actioned. Until it is, any authorization regression in one concern is invisible to a reviewer examining another concern in the same 1,941-line file.

### 4.4 Missing Input Validation Framework

`zod` is listed in `package.json` dependencies and is used in `agentTools/index.js` for tool argument validation. It is **not used for any route input validation**. Route handlers validate inputs with hand-rolled guards:

```js
// typical pattern in routes/tests.js
if (!req.body.name || typeof req.body.name !== "string") {
  return res.status(400).json({ error: "name is required" });
}
```

This means: no coercion, no consistent error shape, no schema export for documentation, and the OpenAPI spec (`openapi.js`) cannot be generated from the same source of truth as the validation. Errors like `{ error: "name is required" }` differ from `{ error: "invalid environmentId" }` differ from `{ error: "project not found" }` — no consistent problem+detail RFC 9457 shape.

### 4.5 BullMQ Queue: Single Global Queue, No Per-Tenant Fairness

`queue.js` creates one BullMQ queue: `sentri:runs`. All workspaces compete on a global FIFO. Workspace A firing a 1000-test suite blocks Workspace B's 5-test smoke test for the full duration of Workspace A's queue drain. There is no per-workspace queue, no priority tier, no fair-share scheduling. The only concurrency control is `MAX_WORKERS` (default: 2), which is a global ceiling — not per-tenant.

---

## 5. AI / Agent Architecture Deep Review

### 5.1 The Supervisor Prompt is Critically Thin

The entire autonomous routing intelligence reduces to this 9-line system prompt in `prompts/supervisorPrompt.js`:

```
You are Sentri supervisor agent. Decide which role should act next or terminate the thread.
Return STRICT JSON only with either:
{"nextRole":"explorer|planner|author|oracle|reviewer","instruction":"...","rationale":"..."}
OR {"terminate":true,"finalArtifact":{...},"rationale":"..."}
Policy: <policy JSON>
Last artifact: <truncated to 4000 chars>
Transcript: <last 10 messages, truncated to 8000 chars>
```

This prompt gives the supervisor zero task context, no examples of what good routing decisions look like, no termination heuristics (when is "done" done?), and no reasoning guidance. The supervisor must decide between 5 roles and "terminate" based on a truncated JSON dump of the last artifact and 10 messages — with no structured representation of the overall task goal or completion criteria.

In practice, on a 20-page site generating 40 tests, the supervisor will see a transcript that has scrolled past the initial crawl context by step 5. It makes routing decisions with no memory of what pages were crawled, what tests have been generated so far, or what the original user objective was. The `MAX_AUTONOMOUS_STEPS = 20` ceiling is a blunt safety net for what should be intelligent goal-directed planning.

Compare to: LangSmith's ReAct agents ship multi-page system prompts with examples, few-shot demonstrations, and explicit termination criteria. CrewAI supervisor prompts include task decomposition context.

### 5.2 Thread Memory is Not Maintained Across Step Truncation

`buildSupervisorPrompt` truncates the transcript to the **last 10 messages** and 8,000 characters. On a complex autonomous run:
- Steps 1–4: explorer crawls pages
- Steps 5–8: planner builds journey outlines
- Steps 9–14: author generates tests
- Steps 15–19: reviewer/oracle iterate

By step 15, the supervisor has lost all memory of the crawl results (they're beyond the 10-message window). It makes routing decisions with no knowledge of what pages exist, what tests have been approved or rejected, or why the author-reviewer loop started. This is a structural limitation — the agent has no persistent memory, only a sliding context window.

The `agent_thread_state` table (`migration 063`) stores compressed thread state, but it is not read into the supervisor prompt. The supervisor only gets the truncated in-process `thread[]` array.

### 5.3 VM Sandbox: Documented `process.env` Exposure

`runner/codeExecutor.js` explicitly acknowledges and accepts this risk:

```js
// NOTE: We intentionally do NOT strip or replace process.env. The previous
// implementation replaced process.env with {} during async sandbox execution,
// but this broke concurrent Express handlers...
```

The actual attack path: A malicious website under test returns a page that causes the AI to generate code like:
```js
const keys = page.constructor.constructor('return process.env')();
await page.fill('#input', JSON.stringify(keys));
```

This would execute during test execution, exfiltrating all environment variables (including AI API keys, JWT secret, encryption key) to the malicious site via form fill → network request from the browser page.

The comment references `NEXT_STEPS.md S1-02` as the mitigation (`worker_threads` with `env: {}`). This is not implemented. For an autonomous QA platform that crawls arbitrary websites and runs LLM-generated code against them, this is a critical security gap.

### 5.4 Eval Harness Has Synthetic Goldens — Regression Gate is Dormant

`backend/scripts/run-eval.mjs` implements the eval harness. The ROADMAP explicitly confirms: *"gate dormant until AUTO-022b records real LLM cache"*. The 50 golden fixtures are synthetic, not recorded from real LLM outputs. This means:

- There is no automated detection of prompt regressions.
- A model upgrade that degrades test quality from 8/10 to 5/10 passes CI.
- A prompt change that accidentally removes assertion generation passes CI.

The eval harness infrastructure (scorer, CI gate plumbing, dashboard panel) is correctly built. The absence of real goldens is not a "small gap" — it is the entire value proposition of the eval system being absent.

### 5.5 Healing Waterfall: No Escalation Policy

`selfHealing.js` implements an 8-stage selector waterfall (0–6 in-runtime, 7 pixelmatch, 8 LLM vision). When all 8 stages fail, `recordHealingFailure()` increments `failCount` and returns `null`. The test is marked as `failed`. There is no hook to:
- Route persistently-failing tests to the human review queue.
- Pause execution of dependent tests when a healing-resistant failure is detected.
- Notify the QA team that a test has failed healing more than N times.

The `healingEscalation` field does not exist in the `projects` schema. The review queue infrastructure exists and works — but healing failures are disconnected from it.

### 5.6 Agent Tool Set is Very Narrow for Autonomous QA

The agent tool registry (`agentTools/index.js`) exposes 5 tools:
- `db.listExistingTests` — list project tests
- `db.getTest` — get one test
- `crawl.getPageHtml` — fetch HTML of a URL
- `playwright.dryRun` — validate test code syntax
- `thread.askPeer` — ask another agent

This is the entirety of what autonomous agents can do. There is no tool to:
- Run a test and see its result
- Compare a test against a baseline
- Modify and persist a test
- Query run history
- Access accessibility violations from the last crawl
- Retrieve healing history for a test

The `playwright.dryRun` tool validates syntax but does **not execute against a real browser** — the browser pool (MNT-015) is its prerequisite and is unshipped. So the reviewer agent can only check that code compiles, not that it actually works on the live site.

---

## 6. UI / UX Deep Review

### 6.1 Review Queue: The Critical Workflow Has the Worst UX

The Review Queue is the most important user workflow in Sentri — human approval of AI tests before they run. Reading `ReviewQueue.jsx`:

- There is no keyboard shortcut to step through tests. The only keyboard-accessible path is Tab → button.
- There is no full-screen single-test focus mode. The two-pane layout at 1,460 lines mixes list management and review decision in one screen.
- The confidence score chip (`QualityScoreChip`) is rendered in the list pane but there is no tooltip or explanation of what the score means, how it was computed, or what "0.87" means as a review threshold.
- `highlightCode` is called in `useMemo` on every selected test change — correct — but the code is labeled "TypeScript" in the toolbar (`<span className="rq-code-lang">TypeScript</span>`) even though generated Playwright code is JavaScript. The syntax highlighter doesn't differentiate.
- Bulk approve works via `POST /projects/:id/tests/bulk` but there is no undo. A mis-click on "Approve All 47" has no recovery path.

### 6.2 TestLab: Over-Engineered Single Page

`TestLab.jsx` holds the following in one component tree:
- `sessionStorage` persistence logic (`persistRun`, `loadPersistedRun`, `clearPersistedRun`)
- Two SSE hooks (`useRunSSE` + `useMultiRunSSE`) — the comment says *"Today only mounts the drawer + maintains a parallel state shape; the single-run `useRunSSE` above still drives the live SSE connection. Follow-up PR migrates..."* — meaning two hooks are running for what is currently one purpose, one of which is partially wired.
- `REQ_EXAMPLES` constant with 4 example strings
- `ACCEPTED_EXTENSIONS`, `MAX_ATTACHMENT_SIZE`, `MAX_TOTAL_ATTACHMENT` constants
- `isTextMime` binary-detection logic
- `STORAGE_KEY`, `LOG_CAP` constants
- `isGenerationRun` function
- `avatarStyle` color mapping function
- The full state machine: idle → running → done

The component is the accumulation of 30+ PRs of additions with partial decomposition. At this size, cognitive load on any change risks regressions across the state machine branches.

### 6.3 Information Architecture: Navigation Overload

The sidebar exposes: Projects, Tests, Runs, Review Queue, TestLab, Automation, Reports, Chat History, Audit Log, Healing Dashboard, Systems. Eleven items. Miller's Law (7±2) is violated. The Healing Dashboard and Approvals Timeline are expert / operator tools surfaced at the same navigation weight as "Projects" — the primary entity. First-time users see eleven equally-weighted destinations with no clear entry point.

### 6.4 Empty States

Several pages lack meaningful empty states. The Tests page with no tests shows a generic empty illustration. The Review Queue with no drafts shows "No drafts" text. Neither page has a "What do I do next?" call-to-action. Compare to Linear (empty issue list: "Create your first issue") or GitHub Actions (empty workflows: "Set up a workflow").

---

## 7. Security Deep Review

### 7.1 VM Sandbox Process.env Exposure (Critical)

Detailed in §5.3. The exposure is acknowledged in code comments and unmitigated. The fix (`worker_threads` with `env: THREAD_NO_ENV`) is documented in `NEXT_STEPS.md` but not in the ROADMAP as a tracked item.

### 7.2 Helm Default Secrets

`helm/sentri/values.yaml`:
```yaml
secrets:
  JWT_SECRET: change-me
  ENCRYPTION_KEY: change-me
```

These are in the repository. An operator who runs `helm install sentri ./helm/sentri` without overriding secrets gets predictable JWT tokens and predictable AES encryption keys. All stored API keys (Anthropic, OpenAI, etc.) are encrypted with `ENCRYPTION_KEY`. With a known key, an attacker with database read access can decrypt all stored credentials.

### 7.3 SSRF Guard: DNS Rebinding Not Prevented

`utils/ssrfGuard.js` resolves DNS at validation time and blocks private IPs. The canonical DNS rebinding attack: (1) pass validation with a public IP, (2) between validation and `safeFetch`, the DNS record changes to `192.168.1.1`. The `safeFetch` function does re-resolve DNS — confirmed by `safeFetch` calling `validateUrl` again before each request. However, there is a TOCTOU window between the `validateUrl` pre-check and the actual TCP connection in the underlying `fetch`. Node's `undici` (used by `fetch`) resolves DNS internally and does not expose the resolved IP before connecting. The SSRF guard cannot intercept the actual DNS resolution that `fetch` uses — it validates the pre-resolution result, not the resolution at connection time.

### 7.4 Audit Log Atomicity Gap

`activityLogger.js` is called as a side-effect after the primary operation succeeds. There is no transaction wrapping both the business operation and the audit log write. Example from `routes/tests.js`:
```js
await testRepo.approve(testId, ...);          // business write
logActivity({ type: "test.approved", ... });  // audit write — separate call
```
If the process crashes between these two lines, the business operation is committed but the audit log entry is absent. For SOC 2 compliance, this is a material gap.

### 7.5 `styleSrc: "unsafe-inline"` in CSP

`middleware/appSetup.js` ships:
```js
styleSrc: ["'self'", "'unsafe-inline'"],
```
The comment: *"inline styles used throughout the SPA"*. CSS injection via `style` attribute can exfiltrate data via timing channels (CSS attribute selectors + background-image URL requests), create UI redressing overlays, and defeat visual integrity checks. This is accepted as a permanent posture rather than a migration target.

---

## 8. Performance & Scalability Review

### 8.1 Cold Chromium Start Per Test (Confirmed Unmitigated)

`browserPool.js` does not exist in `backend/src/runner/`. `testRunner.js:510` calls `launchBrowser()` directly for each test run. Confirmed by grep: the only browser launch pattern is `await launchBrowser({ browser: resolvedBrowser })` — one per run, inside a sequential loop over tests. Parallel workers share the same browser instance within a run (correct) but there is no warm-context pool across runs.

### 8.2 No Response Caching on Read-Heavy Aggregations

`routes/dashboard.js` aggregates across projects, runs, and tests on every `GET /dashboard` request. The dashboard is polled at component mount and on focus. There is no Redis TTL cache on this endpoint. For a workspace with 100 projects and 10,000 runs, this aggregation query runs on every dashboard visit.

`aiProvider/responseCache.js` implements per-route LLM response caching with SHA-256 keyed cache entries — well implemented. But there is no equivalent HTTP response cache for expensive read endpoints.

### 8.3 SSE Subscriber Memory Leak Risk

`routes/sse.js` maintains a `runListeners` Map. Each SSE connection registers a listener. The comment in `useRunSSE.js` shows the hook reconnects on visibility change. If a user opens 5 browser tabs on the same run detail, 5 listeners accumulate. More critically: if a connection closes abnormally (mobile sleep, network drop without proper cleanup), the listener may not be removed. There is no `MAX_LISTENERS_PER_RUN` cap visible in the code.

---

## 9. Enterprise Readiness Assessment

| Requirement | Status | Code Evidence |
|---|---|---|
| SAML/OIDC SSO | ❌ Not implemented | `authenticate.js` only handles 4 strategies: `jwt-cookie`, `jwt-bearer`, `jwt-query`, `trigger-token` |
| Custom RBAC roles | ❌ 3 hardcoded roles | `requireRole.js`: `ROLE_WEIGHT = { admin: 30, qa_lead: 20, viewer: 10 }` — no extensibility |
| Resource-level permissions | ❌ Missing | RBAC is workspace-level only; no project-level role assignment |
| IP allowlisting | ❌ Missing | No middleware or config for IP-based access restriction |
| Tenant compute isolation | ❌ Single queue | `queue.js`: single `sentri:runs` queue shared by all workspaces |
| Audit log atomicity | ⚠️ Gap | `logActivity` called outside transactions in route handlers |
| SOC 2 evidence tooling | ❌ Missing | No export pipeline for compliance evidence artifacts |
| GDPR data export | ✅ Implemented | `routes/auth.js` has data export endpoint per SEC-003 |
| MFA enforcement | ✅ Implemented | Per-workspace `mfaRequired` with grace period |
| API key management | ✅ Implemented | AES-encrypted keys in `provider_routes` table |

---

## 10. DevOps & Infrastructure Review

### 10.1 Single-Instance Postgres and Redis in Helm

`helm/sentri/templates/postgres-statefulset.yaml` deploys a single-replica PostgreSQL StatefulSet. `redis.cluster.enabled: false` by default deploys a single-node Redis Deployment (not even a StatefulSet — it uses a Deployment with no persistent volume). Data loss on Redis pod restart is guaranteed in the default config. On PostgreSQL node failure, the PVC must survive (depends on storage class). There is no replication, no automatic failover.

### 10.2 No Container Image Vulnerability Scanning

The CI pipeline (`ci.yml`) has: secrets scan (Gitleaks), backend tests, frontend build + tests, E2E smoke. It does not have: Trivy/Snyk/Grype image scan, SBOM generation, or dependency vulnerability check (Renovate handles updates but not current vulnerability status).

### 10.3 Migration Ordering CI Gap

There is no CI check that validates migration file numbering is unique. The 8 duplicate-prefix migrations described in §4.2 would be caught immediately by a simple lint step. This is not present in `ci.yml`.

### 10.4 `npm install` vs `npm ci` in CI

`ci.yml` comment: *"Use npm install (not npm ci) because there is no package-lock.json yet"*. This means CI does not use a lockfile for the backend — dependency versions are resolved fresh on every build. This defeats reproducible builds and can silently introduce breaking changes from `^`-pinned dependencies between runs.

---

## 11. Observability & Monitoring Review

### 11.1 Disconnected OTel Traces

`agentOrchestrator.js` calls `annotateThreadSpan()` which calls `annotateAiCallSpan()` from `utils/observability.js`. The trace is annotated with agent metadata but the thread's OTel span is a *peer* of the HTTP request span, not a child. The BullMQ job execution does not propagate W3C `traceparent` from the triggering HTTP request into the job payload. This means a Jaeger/Tempo trace for "why did this run take 4 minutes?" shows three disconnected trees: the HTTP trigger call, the BullMQ worker execution, and the AI provider calls — none linked.

### 11.2 No Grafana Dashboard Shipped

`monitoring/prometheus/alerts.yml` defines 11 alert rules with correct runbook URLs. There is no corresponding `monitoring/grafana/` directory. Operators must build their own dashboards to visualize the 14+ custom Prometheus metrics. For a platform targeting enterprise deployment, this is a significant operational gap.

### 11.3 Missing SSE Backpressure

`routes/sse.js` emits events to all registered listeners without backpressure. A slow SSE consumer (mobile browser on a throttled connection) buffers events in Node's stream layer. On a 20-minute run generating 500+ log events, the buffer grows without bound. There is no `highWaterMark` or listener drop policy.

---

## 12. Product Strategy Gaps

### 12.1 No SDK

There is no `@sentri/sdk` NPM package. Developers who want to integrate Sentri into their CI pipeline must craft raw HTTP requests against the REST API with manual cookie/CSRF handling. The only alternative is the trigger token mechanism (`Authorization: Bearer`), which is project-scoped and provides no programmatic access to test management, run results, or configuration.

Cypress, Playwright, and mabl all have rich CLI/SDK experiences that developers install locally. Sentri has none.

### 12.2 Autonomous Mode is Opt-In Per Workspace and Experimental

`workspaces.agentMode` defaults to `"pipeline"` (linear DAG). The autonomous supervisor mode is behind `agentMode === "autonomous"` in `crawler.js:355`. There is no UI to enable this. The ROADMAP describes it as the product's differentiator — yet it is invisible to users unless they directly mutate the workspace database row. There is no operator-facing toggle, no documentation in the settings UI, and no telemetry on how many workspaces have tried it.

### 12.3 No Pricing or Plan Tier Model

`workspaces` table has `dailySpendCapUsd` and `monthlySpendCapUsd` for AI cost governance. There is no `plan` field, no feature flag system, and no quota differentiation between workspaces. The infrastructure for a freemium or tiered pricing model is absent, leaving the commercial foundation of a SaaS deployment entirely undefined.

---

## 13. Critical Risks

| # | Risk | Evidence | Severity |
|---|---|---|---|
| CR-001 | `deasync.loopWhile` blocks event loop under concurrent PG load | `postgres-adapter.js:562` | Critical |
| CR-002 | VM sandbox escape exposes `process.env` (API keys, JWT secret) | `codeExecutor.js` comments + `runWithStrippedEnv` design | Critical |
| CR-003 | Default Helm secrets `change-me` shipped in-repo | `helm/sentri/values.yaml` | Critical |
| CR-004 | Duplicate migration prefixes cause non-deterministic schema | `migrations/` directory, 8 duplicate numbers | High |
| CR-005 | AI regression gate dormant — no quality gate on AI output | ROADMAP + `run-eval.mjs` synthetic fixtures | High |
| CR-006 | Stored XSS: LLM markdown in `AIChat.jsx` without DOMPurify | `AIChat.jsx` + `markdown.js` — no sanitization | High |
| CR-007 | BullMQ global queue — no per-tenant fairness or isolation | `queue.js` — single `sentri:runs` queue | Medium |
| CR-008 | Supervisor prompt too thin to reliably route 5+ agent roles | `prompts/supervisorPrompt.js` — 9 lines of instruction | High |
| CR-009 | SSE listener potential leak — no max-listeners-per-run cap | `routes/sse.js` `runListeners` Map | Medium |

---

## 14. Missing Industry-Standard Features (Code-Confirmed)

| Feature | Missing Evidence |
|---|---|
| `worker_threads` isolated test execution | `codeExecutor.js` comment: *"For true env isolation... use worker_threads"* — not implemented |
| Browser warm pool | `browserPool.js` does not exist |
| Supervisor memory across step window | `buildSupervisorPrompt` truncates to last 10 messages only |
| Agent tool: run a test | `agentTools/index.js` — no `runner.executeTest` tool |
| Real eval goldens | `run-eval.mjs` — synthetic fixtures, gate dormant |
| SAML/OIDC | `authenticate.js` — strategy list has no SAML/OIDC entry |
| Plugin/extension API | No `IReporter`, `IAIAdapter` interface exported anywhere |
| SDK package | No `packages/` directory, no NPM package definition |
| DOMPurify on AI content | `AIChat.jsx`, `ChatHistory.jsx` — no purify call |
| Per-tenant worker isolation | Single global BullMQ queue |
| Prometheus → Grafana dashboard | No `monitoring/grafana/` directory |
| Migration CI lint (no duplicate numbers) | Not in `ci.yml` |
| `npm ci` (lockfile-pinned builds) | `ci.yml` uses `npm install` |

---

## 15. Technical Debt Register

| ID | Location | Issue | Severity |
|---|---|---|---|
| TD-001 | `postgres-adapter.js:562` | `deasyncLib.loopWhile` event-loop stall | Critical |
| TD-002 | `codeExecutor.js` | `process.env` exposed through vm escape | Critical |
| TD-003 | `helm/values.yaml` | `change-me` default secrets | Critical |
| TD-004 | `migrations/` | 8 duplicate numeric prefixes | High |
| TD-005 | `supervisorPrompt.js` | 9-line supervisor prompt for 5-agent routing | High |
| TD-006 | `pages/TestLab.jsx` | 1,899 lines, dual SSE hooks, split state | High |
| TD-007 | `pages/ReviewQueue.jsx` | 1,460 lines, stored XSS via `dangerouslySetInnerHTML` | High |
| TD-008 | `AIChat.jsx`, `ChatHistory.jsx` | LLM markdown without DOMPurify | High |
| TD-009 | `run-eval.mjs` | Synthetic goldens, dormant regression gate | High |
| TD-010 | `runner/` directory | No `browserPool.js` — cold Chromium start | High |
| TD-011 | `queue.js` | Global FIFO queue, no per-tenant fairness | Medium |
| TD-012 | `routes/tests.js` | 1,941 lines, 8 concerns, no service layer | Medium |
| TD-013 | `agentTools/index.js` | Tool set too narrow for real autonomous QA | Medium |
| TD-014 | `selfHealing.js` | Healing failure has no escalation path | Medium |
| TD-015 | `tokens.css` | Google Fonts CDN dependency | Low |
| TD-016 | `ci.yml` | `npm install` instead of `npm ci` | Medium |
| TD-017 | `routes/tests.js`, `routes/projects.js` | No Zod validation on route inputs | Medium |
| TD-018 | `activityLogger.js` call sites | Audit log writes outside transactions | Medium |

---

## 16. Competitor Comparison

### Sentri vs Cypress Cloud

| Dimension | Sentri | Cypress Cloud |
|---|---|---|
| AI test generation | ✅ Full 8-stage LLM pipeline | ⚠️ Early beta |
| Vision-based self-healing | ✅ pixelmatch + LLM vision | ❌ |
| Multi-agent orchestration | ✅ Supervisor/author/reviewer | ❌ |
| Warm browser pool | ❌ Cold-start per run (MNT-015 unshipped) | ✅ Pre-warmed containers |
| Parallel execution SaaS | ❌ Single Helm instance | ✅ Cloud runner fleet |
| SDK / CLI | ❌ | ✅ `cypress` npm package |
| SSO (SAML/OIDC) | ❌ | ✅ |
| Plugin ecosystem | ❌ | ✅ 400+ plugins |
| AI regression gate | ❌ Dormant | N/A |

### Sentri vs mabl

Sentri wins on: customizability, self-hosting, autonomous agent architecture, open export (Playwright ZIP), and AI generation depth. Mabl wins on: SSO, mobile testing, mature onboarding, SDK, and production monitoring mode.

### Sentri vs LangSmith (AI observability angle)

Sentri's `agent_messages` table and SSE-driven conversation view are approaching LangSmith's trace UI quality. The gap: Sentri has no prompt versioning, no dataset management, no offline eval studio. Every AI quality investigation requires production data and a live backend.

---

## 17. Immediate High-Priority Fixes

**These must ship before any enterprise deployment or Series A demo:**

1. **[Critical] Remove `change-me` secrets from Helm.** Add a `_validate.yaml` pre-install hook that fails `helm install` when `JWT_SECRET` or `ENCRYPTION_KEY` equals `change-me` or is unset. (`helm/sentri/values.yaml`, 1 hour)

2. **[Critical] Add DOMPurify to `AIChat.jsx` and `ChatHistory.jsx`.** `npm install dompurify isomorphic-dompurify`. Wrap `renderMarkdown()` output with `DOMPurify.sanitize()`. (`AIChat.jsx`, `ChatHistory.jsx`, `markdown.js`, 2 hours)

3. **[Critical] Add migration CI lint.** Add a step to `ci.yml` that runs `ls migrations/*.sql | cut -d_ -f1 | sort | uniq -d` and exits non-zero on output. (`.github/workflows/ci.yml`, 30 minutes)

4. **[High] Switch `ci.yml` to `npm ci`.** Add `package-lock.json` to the backend. This makes CI reproducible. (`backend/package.json`, `ci.yml`, 1 hour)

5. **[High] Strengthen supervisor prompt.** The prompt needs: explicit task goal injection, few-shot routing examples, termination criteria (e.g., "terminate when author has produced N tests"), and role-selection rationale guidance. This is the biggest quality-of-life fix for autonomous mode. (`prompts/supervisorPrompt.js`, 2 days)

6. **[High] Activate eval harness.** Record real golden baselines via `EVAL_RECORD=1` against the live API. Enable the CI gate. This is AUTO-022b and is correctly understood as high-priority in the roadmap — it just has not been executed. (4–8 hours)

7. **[High] Add per-run SSE listener cap.** In `routes/sse.js`, add `MAX_LISTENERS_PER_RUN = 50` and reject new SSE connections when exceeded. (1 hour)

8. **[Medium] Add Trivy scan to `release.yml`.** Fail releases on critical CVEs in the built image. (1 hour)

---

## 18. Long-Term Strategic Improvements

1. **Async database layer (6–8 weeks).** Replace `deasync`/`pg-native` with native async `pg` queries. Introduce `db.queryAsync()` wrapper, migrate repositories one file at a time. This is the single highest-leverage technical investment.

2. **`worker_threads` code execution isolation (3 weeks).** Move AI-generated test code execution from `vm` in the main process to `worker_threads` with `env: THREAD_NO_ENV`. This is the documented fix for the `process.env` exposure.

3. **Browser pool (MNT-015) — in sprint, accelerate.** `browserPool.js` is the current sprint target. Ship it. The 40–60% run time improvement directly improves the review-to-result cycle for every user.

4. **Supervisor prompt engineering (2 weeks).** Build a proper supervisor prompt with: task decomposition context injection, explicit completion heuristics, few-shot routing examples, and structured termination criteria. Run against the eval harness to validate quality.

5. **SAML/OIDC SSO (3 weeks).** This is a procurement blocker for enterprise. `openid-client` + `@node-saml/passport-saml`, per-workspace configuration, auto-provisioning.

6. **`@sentri/sdk` NPM package (3 weeks).** Typed client wrapping the REST API. Required for developer ecosystem adoption.

7. **Per-tenant worker queues (4 weeks).** Namespace BullMQ queues by `workspaceId`. Implement fair-share scheduling. Required for multi-tenant SaaS.

8. **Autonomous monitoring mode — DIF-009 (3 weeks).** Always-on smoke test against production. The clearest product differentiator not yet shipped.

---

## 19. Recommended Architecture Changes

### 19.1 Async Repository Layer

```
Current:  db.prepare(sql).all(params)    → synchronous, blocks event loop on PG
Target:   await db.query(sql, params)    → async, event-loop safe
Path:     Introduce db.queryAsync() in sqlite.js / postgres-adapter.js
          Migrate repos one file at a time under test coverage
          Replace deasync + pg-native with plain pg async pool
```

### 19.2 Isolated Test Execution

```
Current:  AI code → vm.compileFunction → same Node.js process → process.env exposed
Target:   AI code → worker_threads.Worker({ env: THREAD_NO_ENV }) → isolated env
Path:     New runner/workerExecutor.js exports executeInWorker()
          codeExecutor.js delegates to it
          Playwright page proxy bridged via worker_threads.MessageChannel
```

### 19.3 Supervisor Prompt Architecture

```
Current:  9-line static prompt + truncated transcript
Target:   Structured supervisor context:
            - Original task goal (not truncated)
            - Completed steps summary (not raw transcript)
            - Remaining budget
            - Per-role progress markers (pages crawled, tests generated, reviews done)
            - Few-shot examples of good routing decisions
          + Prompt registry with versioning (compare quality across prompt versions)
```

### 19.4 Migration Hygiene

```
Current:  Files numbered ad-hoc, duplicates tolerated
Target:   CI lint: ls migrations/ | cut -d_ -f1 | uniq -d → exit 1
          Convention: one sequence number per migration, no sharing
          Doc: CONTRIBUTING.md § Adding a migration
```

### 19.5 Domain Event Bus

```
Current:  testRunner.js directly calls notifications, activityLogger, metricsRecorder
Target:   testRunner.js → emit("run.completed", payload)
          Each side-effect consumer subscribes independently
          New integrations = subscribe only, no testRunner.js changes
```

---

## 20. Final Industry Readiness Score

| Dimension | Score | Key Finding |
|---|---|---|
| Core QA Pipeline Quality | 7.5/10 | 8-stage pipeline is solid; cold browser start hurts |
| AI / Agent Architecture | 6.5/10 | Orchestration framework is good; supervisor prompt is dangerously thin |
| Test Execution Security | 4.0/10 | VM escape + `process.env` exposure is unmitigated |
| Database Layer | 4.5/10 | `deasync` event-loop blocking is a critical production defect |
| Migration Hygiene | 5.5/10 | 8 duplicate-prefix files, no CI enforcement |
| Frontend Architecture | 6.0/10 | Strong design system; monolithic page components; XSS in AI chat |
| Security Posture | 6.5/10 | Strong auth, CSP, PII firewall; Helm secrets, VM escape, XSS gaps |
| Enterprise Readiness | 4.5/10 | No SSO, no custom RBAC, no per-tenant isolation |
| Observability | 6.5/10 | OTel + Prometheus + Sentry correct; no Grafana, disconnected traces |
| DevOps / CI | 6.0/10 | Good pipeline; `npm install` not `npm ci`, no image scanning |
| Product Strategy | 6.0/10 | Right vision; autonomous mode invisible to users; no SDK |

### **Overall Industry Readiness: 5.9 / 10**

Sentri has real technical ambition and some genuinely advanced capabilities. But the gap between its documented capabilities and what is safely production-deployable at scale is large. The `deasync` DB layer, VM sandbox exposure, thin supervisor prompt, dormant eval harness, and missing browser pool are not roadmap items — they are production defects that affect every deployment today.

The path from 5.9 → 8.5 is clear and executable in 6–9 months: async DB migration, `worker_threads` isolation, MNT-015 browser pool, supervisor prompt engineering, DOMPurify on AI content, SSO, and activated eval harness. These seven items address the core structural and security gaps. The remaining 1.5 points (9.0+) require the ecosystem investments: SDK, plugin API, per-tenant compute isolation, and Grafana dashboards.

---

*Deep code audit performed May 2026. Findings cite actual source files and code patterns — not documentation inferences.*
