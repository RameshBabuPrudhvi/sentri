<p align="center">
  <img src="docs/public/logo.svg" alt="Sentri" width="120" />
</p>

<h2 align="center">Sentri</h2>

<p align="center">
  AI-powered end-to-end test generation, execution, and self-healing for modern web applications.
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

Sentri is an autonomous QA platform that covers the full testing lifecycle in a single tool. Point it at a URL — it crawls your application, runs an 8-stage AI pipeline to generate a Playwright test suite, routes every test through a human approval queue, executes approved tests in real browsers across Chromium, Firefox, and WebKit, and automatically repairs broken selectors between runs.

```
Crawl → Generate → Deduplicate → Enhance → Validate → Review → Execute → Self-Heal
```

Most AI test generators stop at code generation. Sentri treats generation as step two of eight.

---

## Why Sentri?

| Problem | How Sentri addresses it |
|---|---|
| Writing E2E tests is slow | Point it at a URL — tests are generated in minutes |
| Selectors break every sprint | Adaptive selector waterfall records what works and tries it first next run |
| AI-generated tests are untrustworthy | Every test lands in a Draft queue — nothing executes without human approval |
| Tests fail and nobody knows why | AI feedback loop classifies every failure and auto-regenerates failing tests |
| No visibility into what the test is doing | Live browser screencast, real-time SSE log stream, per-step screenshots |
| Vendor lock-in on AI providers | Switch between Anthropic, OpenAI, Google, or Ollama with a single setting |

---

## Key Features

**Test Generation**
- Two discovery modes: Link Crawl maps `<a>` tags; State Exploration clicks, fills, and submits to discover multi-step flows
- 8-stage AI pipeline with intent classification, deduplication, assertion enhancement, and structural validation
- API test generation — captures fetch/XHR traffic during crawl and produces Playwright `request` contract tests alongside UI tests
- Natural-language test creation — describe a scenario and skip the crawl entirely

**Execution & Observability**
- Parallel execution across 1–10 isolated browser contexts
- Cross-browser support: Chromium, Firefox, and WebKit with per-run engine selection
- Live browser screencast at ~7 FPS via Chrome DevTools Protocol
- Real-time log and result streaming via Server-Sent Events

**Self-Healing**
- Multi-strategy selector waterfall: ARIA role → label → text → `aria-label` → title → CSS
- Adaptive memory — records the winning strategy per element and prioritises it on subsequent runs
- Failure classification by category (selector / timeout / assertion / navigation) with targeted regeneration

**Operations**
- Flaky test detection with 0–100 scoring based on run history
- Scheduled runs with timezone support
- CI/CD webhook trigger with per-project Bearer tokens
- Failure notifications via Microsoft Teams, email, and generic webhook
- Workspace isolation and role-based access control (Admin / QA Lead / Viewer)
- GDPR/CCPA account export and cascade deletion

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

| Provider | Environment Variable | Default Model |
|---|---|---|
| Anthropic Claude | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 |
| OpenAI | `OPENAI_API_KEY` | gpt-4o-mini |
| Google Gemini | `GOOGLE_API_KEY` | gemini-2.5-flash |
| Ollama (local, free) | `AI_PROVIDER=local` | mistral:7b |

Auto-detects in order: Anthropic → OpenAI → Google → Ollama. Switch at any time from the header dropdown or Settings page.

Full setup guide including Ollama: **[AI Providers →](https://rameshbabuprudhvi.github.io/sentri/docs/guide/ai-providers.html)**

---

## Documentation

| | |
|---|---|
| **Getting Started** | [Installation, first steps, optional services](https://rameshbabuprudhvi.github.io/sentri/docs/guide/getting-started.html) |
| **Architecture** | [Pipeline, data flow, design decisions](https://rameshbabuprudhvi.github.io/sentri/docs/guide/architecture.html) |
| **Self-Healing** | [Selector waterfall, healing history, failure classification](https://rameshbabuprudhvi.github.io/sentri/docs/guide/self-healing.html) |
| **Test Dials** | [Strategy, workflow, quality, format, language options](https://rameshbabuprudhvi.github.io/sentri/docs/guide/test-dials.html) |
| **API Reference** | [Full REST API with request/response examples](https://rameshbabuprudhvi.github.io/sentri/docs/api/) |
| **Production Checklist** | [Security, infrastructure, and deployment hardening](https://rameshbabuprudhvi.github.io/sentri/docs/guide/production.html) |
| **Environment Variables** | [Complete backend and frontend variable reference](https://rameshbabuprudhvi.github.io/sentri/docs/guide/env-vars.html) |
| **Manual QA Guide** | [End-to-end manual test plan, Golden E2E happy path, per-feature checks](QA.md) |

---

## Contributing

Contributions are welcome. Please read the guidelines below before opening a pull request.

**Before you start:**
- Check [open issues](https://github.com/RameshBabuPrudhvi/sentri/issues) and [ROADMAP.md](ROADMAP.md) to avoid duplicating in-progress work
- For significant changes, open an issue first to discuss the approach

**Workflow:**
1. Fork the repository and create a branch: `feature/<description>` or `fix/<description>`
2. Read [AGENT.md](AGENT.md) — it covers architecture, conventions, and what not to do
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
