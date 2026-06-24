<p align="center">
  <img src="docs/public/logo.svg" alt="Sentri" width="120" />
</p>

<h2 align="center">Sentri</h2>

<p align="center">
  The autonomous QA platform — multi-agent test generation, execution, and self-healing for modern web applications.
</p>

<p align="center">
  <em>Specialist AI agents collaborate to crawl your site, write Playwright tests, review each other's work, and self-heal broken selectors — with operators in the loop only when they want to be.</em>
</p>

<p align="center">
  <a href="https://github.com/RameshBabuPrudhvi/sentri/actions/workflows/ci.yml">
    <img src="https://github.com/RameshBabuPrudhvi/sentri/actions/workflows/ci.yml/badge.svg" alt="CI" />
  </a>
  <a href="https://github.com/RameshBabuPrudhvi/sentri/releases">
    <img src="https://img.shields.io/github/v/release/RameshBabuPrudhvi/sentri" alt="Latest Release" />
  </a>
  <a href="https://nodejs.org">
    <img src="https://img.shields.io/badge/Node.js-20+-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20+" />
  </a>
  <a href="https://playwright.dev">
    <img src="https://img.shields.io/badge/Playwright-1.58+-2EAD33?logo=playwright&logoColor=white" alt="Playwright" />
  </a>
  <a href="https://opensource.org/licenses/MIT">
    <img src="https://img.shields.io/badge/License-MIT-blue" alt="MIT License" />
  </a>
</p>

<p align="center">
  <a href="https://rameshbabuprudhvi.github.io/sentri/docs/guide/getting-started.html"><b>Get Started</b></a>
  &nbsp;·&nbsp;
  <a href="https://rameshbabuprudhvi.github.io/sentri/docs/">Documentation</a>
  &nbsp;·&nbsp;
  <a href="https://rameshbabuprudhvi.github.io/sentri/docs/api/">API Reference</a>
  &nbsp;·&nbsp;
  <a href="ROADMAP.md">Roadmap</a>
  &nbsp;·&nbsp;
  <a href="docs/changelog.md">Changelog</a>
</p>

---

## What is Sentri?

Sentri is an **autonomous QA platform** built on a multi-agent system. Eight specialist AI agents — Explorer, Planner, Author, Oracle, Reviewer, Healer, Triager, and Supervisor — collaborate on a shared thread to crawl your application, write Playwright tests, critique each other's work in real revision rounds, execute the approved suite in real browsers, and self-heal broken selectors between runs. A run completes end-to-end without operator intervention; humans are in the loop only when they want to be (review queues, auto-approval threshold, mode-flip per workspace).

```
            ┌─────────────────────────────────────────────────┐
Supervisor  │  decides who speaks next (autonomous mode)      │
            └─────────────────────────────────────────────────┘
                              ↓
Explorer → Planner → Author ⇄ Reviewer → Oracle → Healer → Triager
   🔍        🧭       ✍️        🛡️          🎯         🩹         ⚠️
   │         │        │         ↑                                  │
   └─ crawl  │        │         │  rejects + force revision         │
             └─ map   │         │                                   │
                      └─ writes / dedups / executes                 │
                                              │                     │
                                              └─ runtime healing ←──┘
```

**Industry-standard pattern, Sentri-specific scope.** The orchestration model matches LangGraph / AutoGen / CrewAI (supervisor + role-based dispatch + tool calling on a shared blackboard); the agents are domain-specialised to one job — generating, running, and maintaining a Playwright test suite. The result: zero "I generated code, now you figure out how to run it" handoff to the user. Generation, execution, and maintenance are one continuous loop.

Most AI test generators stop at code generation. Sentri's eight agents own the entire QA lifecycle.

---

## How the agents collaborate

| Agent | Role | When it speaks |
|---|---|---|
| 🔍 **Explorer** | Crawls the site (link or state-explore mode), filters DOM noise, classifies page intents | Step 1 of every run |
| 🧭 **Planner** | Composes classified pages into multi-step user journeys (signup, checkout, search) | After Explorer hands off |
| ✍️ **Author** | Writes Playwright tests for each journey + page; calls `db.listExistingTests` mid-generation to avoid duplicating the catalog | Step 4 onward |
| 🎯 **Oracle** | Strengthens weak assertions (real outcomes, not just "page loaded") | Step 6 |
| 🛡️ **Reviewer** | Runs `playwright.dryRun` (real `testValidator`) on every generated test; can reject + force the Author to revise up to N rounds | Step 7 |
| 🩹 **Healer** | Patches broken selectors at runtime using the adaptive selector waterfall + vision-based fallback (pixelmatch → LLM vision) | Per failing step |
| ⚠️ **Triager** | Classifies failures (selector / timeout / assertion / navigation / bot-block) and routes to feedback loop or skip-with-reason | Post-run |
| 🧠 **Supervisor** | In `autonomous` mode, decides which agent acts next based on thread state and routes the conversation; falls open to the linear DAG when capabilities are missing | Every step in autonomous mode |

**Three operating modes** (per-workspace, hot-swappable from Settings):
- **`pipeline`** (default, zero-regression) — the linear 8-stage DAG. Battle-tested, deterministic, lowest cost.
- **`envelope`** — same DAG, but every handoff is a structured `agent_message` envelope persisted to the audit trail. Operators see the conversation in the UI timeline; behaviour is byte-identical to `pipeline`.
- **`autonomous`** — the Supervisor LLM picks the next agent on each step. Reviewer can force the Author back to revise; the Author calls tools mid-generation. Fails OPEN to the linear path on any orchestrator hiccup so a misconfigured workspace never gets a worse outcome than `pipeline`.

**Agents have a closed-set tool registry.** `db.listExistingTests` (Author dedup), `db.getTest` (Reviewer inspection), `crawl.getPageHtml` (Explorer drill-down), `playwright.dryRun` (Reviewer/Author sanity check via the real `testValidator`), `thread.askPeer` (any agent can ask any other agent a structured question). Each tool is workspace-scoped at the repo layer, rate-limited per `(workspace, run, tool)`, secret-scrubbed before persistence, AbortSignal-aware, and bounded-retry on transient failures.

---

## Why Sentri?

| Problem | How Sentri's agents address it |
|---|---|
| Writing E2E tests is slow | Explorer + Planner + Author take a URL → Playwright suite in minutes — no manual scenario authoring |
| AI-generated tests are untrustworthy | Reviewer runs the real `testValidator` per test and can force the Author back to revise; tests still land in a Draft review queue (with opt-in confidence-based auto-approval) |
| LLMs duplicate scenarios | Author calls `db.listExistingTests` mid-generation and writes complementary tests instead of near-duplicates |
| Selectors break every sprint | Healer's adaptive selector waterfall records what works and tries it first next run; vision-based fallback (pixelmatch → LLM vision) recovers when DOM healing fails |
| Tests fail and nobody knows why | Triager classifies every failure; Author auto-regenerates the broken ones; Reviewer re-validates before they go back into the pool |
| Operators have no audit trail of why an agent did what it did | Every handoff is a persisted `agent_message` envelope — `fromRole → toRole`, intent (`handoff` / `request_revision` / `tool_call` / `accept` / `reject_final`), artifact, rationale, traceId. Visible in the UI timeline with colour-coded tool chips |
| Vendor lock-in on AI providers | Each agent role binds to its own AI provider — Sonnet for the Supervisor, GPT-4o-mini for the Author, Ollama for the Reviewer. Mix and match per role; switch any of them with one click |
| Cost can spiral with multi-agent loops | Per-workspace spend caps + per-tool rate limits (`AGENT_TOOL_RATE_LIMIT_PER_MIN`) + hard `MAX_AUTONOMOUS_STEPS=20` + wall-clock thread budget. Single-agent collapse (author + reviewer share a route) flags a warning instead of silently degrading |

---

## Key Features

**Multi-Agent Collaboration**
- 8 specialist agents with closed-set role vocabulary (Explorer / Planner / Author / Oracle / Reviewer / Healer / Triager / Supervisor) — no foreign agent names possible at any layer
- Structured `agent_message` envelope on every handoff (intent, artifact, rationale, traceId) — full audit trail per run
- Reviewer ↔ Author revision loop with `MAX_REVIEW_ROUNDS` (per-workspace configurable, hard cap 10) and `loopTimeoutMs` budget
- Closed-set tool registry — `db.listExistingTests`, `db.getTest`, `crawl.getPageHtml`, `playwright.dryRun`, `thread.askPeer`. Per-role allowlist + workspace-narrowed via `agent_configs.allowedTools`
- Thread-scoped blackboard with optimistic CAS (`agent_thread_state`, 64KB cap) — agents share working state without losing each other's writes
- Supervisor orchestration in `autonomous` mode — LLM picks the next role on each step; fails OPEN to linear DAG on any hiccup
- Cross-process peer Q&A via Redis pub/sub — `thread.askPeer` works across pods in multi-replica deployments
- Per-tool rate limit (`AGENT_TOOL_RATE_LIMIT_PER_MIN`) + per-workspace spend caps + per-step quota gate

**Test Generation**
- Two discovery modes: Link Crawl maps `<a>` tags; State Exploration clicks, fills, and submits to discover multi-step flows
- 8-stage pipeline with intent classification, deduplication, assertion enhancement, and structural validation
- Author calls `db.listExistingTests` mid-generation so the LLM is dedup-aware (sees up to 30 existing test names + sourceUrls before writing)
- API test generation — captures fetch/XHR traffic during crawl and produces Playwright `request` contract tests alongside UI tests
- Natural-language test creation — describe a scenario and skip the crawl entirely
- Data-driven test fixtures (CSV / JSON) — one test, N iterations per row, per-test iteration cap

**Execution & Observability**
- Parallel execution across 1–10 isolated browser contexts; distributed sharding across N runner machines (BullMQ + Redis)
- Cross-browser support: Chromium, Firefox, and WebKit with per-run engine selection
- Live browser screencast at ~7 FPS via Chrome DevTools Protocol
- Real-time log and result streaming via Server-Sent Events
- Per-thread tool-call timeline in the UI — colour-coded chips (call / success / error) with concise summary ("12 results", "3 issues", error message)
- Multi-environment support (staging vs production) — per-environment baseUrl + AES-encrypted credentials, env-scoped runs without mutating the project row
- OpenTelemetry + Prometheus baseline — per-agent / per-tool / per-route metrics, Sentry error reporting, structured `traceId`-correlated logs

**Self-Healing**
- Multi-strategy selector waterfall: ARIA role → label → text → `aria-label` → title → CSS
- Adaptive memory — records the winning strategy per element and prioritises it on subsequent runs
- Vision-based healing fallback (pixelmatch → LLM vision) when DOM strategies all fail; budget-circuit-broken per workspace
- Failure classification by category (selector / timeout / assertion / URL / bot-block / navigation) with targeted regeneration
- Reviewer re-validates regenerated tests before they ship — broken-output bugs eliminated as a class

**Operations**
- Flaky test detection with 0–100 scoring based on run history; root-cause failure clustering across the run
- Scheduled runs with timezone support
- CI/CD webhook trigger with per-project Bearer tokens; GitHub PR check comments via the Sentri GitHub App
- Diff-aware crawling — only regenerates tests for pages whose DOM fingerprint changed since the last crawl; zero LLM calls when nothing changed
- Vercel + Netlify deployment webhooks — HMAC-signed payloads auto-launch a diff-aware crawl against the preview URL when a deployment is READY
- Test impact analysis from git diff — only runs tests whose routes were affected by the PR's changed files
- Failure notifications via Microsoft Teams, email, and generic webhook
- Workspace isolation and role-based access control (Admin / QA Lead / Viewer); GDPR/CCPA account export and cascade deletion
- Quality gates (pass-rate / coverage / Web Vitals / PR-scoped coverage) — fail the build when budgets regress

---

## Quick Start

```bash
git clone https://github.com/RameshBabuPrudhvi/sentri.git
cd sentri

cp backend/.env.example backend/.env
# Add at least one AI provider key to backend/.env

docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000).

For local development setup, optional Redis/PostgreSQL profiles, and Windows instructions, see the **[Getting Started guide](https://rameshbabuprudhvi.github.io/sentri/docs/guide/getting-started.html)**.

---

## AI Providers

Sentri ships per-workspace **AI Providers** (formerly "Provider Routes") — each provider bundles protocol + endpoint + model + encrypted API key + pricing + capabilities + rate limits + cache config. Add providers from **Settings → AI Providers** and either pin one as the workspace default (the ⭐ Set as default action — every agent role inherits it) or assign per-role in **Settings → Agent Roles** for cost-tuned multi-agent dispatch. Operators can also add custom OpenAI-compatible vendors (self-hosted vLLM, on-prem proxies, niche providers) with zero code edits — pick `family: "custom"`, fill in your baseUrl + model + key, save.

| Provider | Environment Variable (single-tenant default) | Default Model |
|---|---|---|
| Anthropic Claude | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 |
| OpenAI | `OPENAI_API_KEY` | gpt-4o-mini |
| Google Gemini | `GOOGLE_API_KEY` | gemini-2.5-flash |
| OpenRouter | `OPENROUTER_API_KEY` | openrouter/auto |
| Ollama (local, free) | `AI_PROVIDER=local` | mistral:7b |
| Anything OpenAI-compatible | Settings → AI Providers → `family: "custom"` | operator-supplied |

Single-tenant deployments without managed AI Providers auto-detect env keys in order: Anthropic → OpenAI → Google → OpenRouter → Ollama. Multi-tenant deployments should add providers via the Settings UI and pin one as the workspace default.

Operator guides: **[AI Providers →](docs/guide/provider-routes.md)** · **[Quotas & caching →](docs/operations/quotas-and-caching.md)** · **[AI request log →](docs/operations/request-log.md)** · **[Setup guide →](https://rameshbabuprudhvi.github.io/sentri/docs/guide/ai-providers.html)**

---

## Production deployments (Render / Fly / Railway)

> ⚠️ **Important:** free-tier root filesystems are usually ephemeral. If your SQLite DB lives on ephemeral storage, every redeploy can wipe accounts, projects, tests, and runs.

Use the included [`render.yaml`](render.yaml) Blueprint on Render to mount a **1 GB Persistent Disk** at `/app/backend/data` and set `DB_PATH=/app/backend/data/sentri.db`.

If you plan to run multiple instances, prefer managed Postgres and set `DATABASE_URL=postgres://...` instead of SQLite.

---

## Documentation

| | |
|---|---|
| **Getting Started** | [Installation, first steps, optional services](https://rameshbabuprudhvi.github.io/sentri/docs/guide/getting-started.html) |
| **Architecture** | [Pipeline, data flow, design decisions](https://rameshbabuprudhvi.github.io/sentri/docs/guide/architecture.html) |
| **Multi-Agent Collaboration** | [AUTO-023 roadmap — envelope schema, reviewer↔author loop, supervisor orchestrator, tool calling](docs/roadmap/autonomous-multi-agent.md) |
| **Auto-Approval** | [Confidence-based auto-approval, threshold tuning, audit trail, kill-switch](https://rameshbabuprudhvi.github.io/sentri/docs/guide/auto-approval.html) |
| **Self-Healing** | [Selector waterfall, healing history, failure classification](https://rameshbabuprudhvi.github.io/sentri/docs/guide/self-healing.html) |
| **Test Dials** | [Strategy, workflow, quality, format, language options](https://rameshbabuprudhvi.github.io/sentri/docs/guide/test-dials.html) |
| **API Reference** | [Full REST API with request/response examples](https://rameshbabuprudhvi.github.io/sentri/docs/api/) |
| **Production Checklist** | [Security, infrastructure, and deployment hardening](https://rameshbabuprudhvi.github.io/sentri/docs/guide/production.html) |
| **Environment Variables** | [Complete backend and frontend variable reference](https://rameshbabuprudhvi.github.io/sentri/docs/guide/env-vars.html) |
| **Manual QA Guide** | [End-to-end manual test plan, Golden E2E happy path, per-feature checks](QA.md) |

---

## Contributing

Contributions are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

**Before you start:**
- Check [open issues](https://github.com/RameshBabuPrudhvi/sentri/issues) and [ROADMAP.md](ROADMAP.md) to avoid duplicating in-progress work
- For significant changes, open an issue first to discuss the approach

**Workflow:**
1. Fork the repository and create a branch: `feature/<description>` or `fix/<description>`
2. Read [AGENTS.md](AGENTS.md) — it covers architecture, conventions, and what not to do
3. Read [STANDARDS.md](STANDARDS.md) when writing new code
4. Run the test suite before submitting: `cd backend && npm test` and `cd frontend && npm run build`
   - For user-visible changes, also walk the affected sections of [QA.md](QA.md) — at minimum the Golden E2E Happy Path
5. Follow [Conventional Commits](https://www.conventionalcommits.org/) for commit and PR title format — the release pipeline uses this to determine version bumps automatically
6. Update `docs/changelog.md` under `## [Unreleased]` for any user-visible change
7. Read [REVIEW.md](REVIEW.md) before opening the PR

**Code quality:** every PR that adds or modifies backend logic must include tests. PRs without adequate coverage will not be merged. See [REVIEW.md](REVIEW.md) for the full requirements table.

---

## License

MIT — see [LICENSE](LICENSE) for details.
