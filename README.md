# 🐻 Sentri — Autonomous QA Platform

> AI-powered test generation and execution for modern web applications. Crawl your app, generate Playwright tests, review them, and run regression — all in one place.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.58+-blue.svg)](https://playwright.dev)

---

## What is Sentri?

Sentri is an autonomous QA platform that removes the manual burden of writing and maintaining end-to-end tests. Point it at any web application and it will:

1. **Crawl** your app — mapping pages, forms, buttons, and interactive elements up to 3 levels deep
2. **Generate** meaningful Playwright test cases using your choice of AI provider (Anthropic Claude, Google Gemini, OpenAI GPT-4o-mini, or Ollama local models)
3. **Review** — all generated tests land in a **Draft** queue for human approval before they enter regression
4. **Execute** approved tests against your live app with one click, with per-step video, screenshots, network, and console capture
5. **Report** pass/fail results with live log streaming, browser view replays, and run history

---

## Features

| Feature | Description |
|---|---|
| 🕷️ **Autonomous Crawler** | Explores your app up to 3 levels deep, mapping all pages and interactive elements |
| 🤖 **Multi-AI Test Generation** | Anthropic Claude Sonnet, Google Gemini 2.5 Flash, OpenAI GPT-4o-mini, or Ollama local models — switch with one env var |
| 🦙 **Ollama (Local Models)** | Run models locally with Ollama — completely free and private, no API key needed |
| ✦ **Create Test from Description** | Describe a scenario in plain English; AI generates steps + a Playwright script in seconds |
| 🧬 **Self-Healing Tests** | Multi-strategy element finding with adaptive healing history — tests auto-recover when selectors change |
| 🔄 **Two-Phase AI Pipeline** | PLAN → GENERATE split avoids token truncation; AI-assisted intent classification for ambiguous pages |
| 📋 **Draft → Review → Regression** | All tests (crawled or manually created) start as Draft. Approve to promote to Regression Suite |
| ✏️ **Inline Test Editing** | Edit test steps, name, description, and priority in the UI — Playwright code auto-regenerates on save |
| ▶️ **One-Click Regression Run** | Execute all approved tests with video recording, screenshots, network logs, and DOM snapshots |
| 🎥 **Step Results View** | Per-test-case drill-down with browser-chrome screenshot replay and step-by-step status |
| 🔑 **Auth Support** | Login to your app before crawling using CSS selectors for username/password fields |
| ⚙️ **Runtime API Key Config** | Set or change your AI provider key in the Settings UI — no server restart needed |
| 📊 **Live Dashboard** | Real-time pass/fail metrics, run history, pass rate trends, and per-project analytics |
| 📝 **Activity Log** | Complete timeline of all user and system actions — crawls, runs, edits, approvals |
| 🌙 **Dark Mode** | Automatic dark mode via `prefers-color-scheme` — all UI components adapt seamlessly |
| ⌨️ **Keyboard Shortcuts** | `a` approve, `r` reject, `/` search, `Esc` clear — speed up test review workflows |
| 🔍 **Global Test Search** | Search across all tests from the sidebar; results open the `/tests` page with URL-synced filters |
| 🛡️ **Error Boundary & 404** | Graceful crash recovery and a proper 404 page for unknown routes |
| 🐳 **Docker Ready** | Full Docker Compose setup for instant deployment |

---

## Quick Start

### Prerequisites

- Node.js 20+
- An API key for at least one supported AI provider, **or** a local Ollama installation (see [AI Providers](#ai-providers))
- Docker & Docker Compose (for containerised deployment)

---

### Option A: Docker (Recommended)

```bash
# 1. Clone the repo
git clone https://github.com/RameshBabuPrudhvi/sentri.git
cd sentri

# 2. Configure environment
cp backend/.env.example backend/.env
# Edit backend/.env — add at least one AI provider key

# 3. Build and start
docker compose up --build

# Frontend → http://localhost:80
# Backend API → http://localhost:3001
```

---

### Option B: Local Development

**Backend:**

```bash
cd backend
npm install
npx playwright install chromium
cp .env.example .env        # Add at least one AI provider key
npm run dev                 # Starts on :3001
```

**Frontend:**

```bash
cd frontend
npm install
npm run dev                 # Starts on :3000, proxies /api to :3001
```

Open [http://localhost:3000](http://localhost:3000)

---

## Usage

### 1. Configure an AI Provider

Go to **Settings** and paste in an API key for Anthropic, OpenAI, or Google — or configure **Ollama** for free local inference (no API key needed). The active provider is shown in the top-right badge. You can also set it in `backend/.env` before starting.

### 2. Create a Project

- Click **New Project**
- Enter your app name and URL (e.g. `https://myapp.com`)
- Optionally configure login credentials (CSS selectors for username/password fields and their values)

### 3a. Crawl & Generate Tests (Automated)

- Open your project and click **Crawl & Generate Tests**
- Sentri visits your app, follows internal links, snapshots each page (including form structures, semantic sections, and heading hierarchy), and sends those snapshots through an 8-step pipeline:
  1. **Crawl** — discover pages up to 3 levels deep
  2. **Filter** — remove noise from interactive elements
  3. **Classify** — identify page intent (AUTH, CHECKOUT, SEARCH, etc.) with AI-assisted fallback for ambiguous pages
  4. **Generate** — two-phase PLAN → GENERATE pipeline produces focused Playwright tests per page
  5. **Deduplicate** — remove duplicate tests across the batch and existing project tests
  6. **Enhance** — strengthen assertions for better coverage
  7. **Validate** — reject malformed or placeholder tests before they enter the DB
  8. **Done** — store validated tests as Draft
- All generated tests appear in the **Generated Tests** tab as **Draft**

### 3b. Create a Test from Description (Manual)

- Click **Create Tests** from the Tests page
- Select your project (auto-populated), enter a test name and plain-English description
- AI generates detailed test steps and a Playwright script — review and edit the steps in a multi-phase wizard:
  - **Form** → describe what you want to test
  - **Generating** → AI analyses your description and writes steps + Playwright code
  - **Review** → edit, add, remove, or reorder steps before saving
  - **Done** → test saved as Draft
- The test is saved as **Draft** in your project's Generated Tests queue

### 4. Review & Approve Tests

- Open the **Generated Tests (Review Required)** tab in your project
- Use the **Approved / Draft / All Tests** toggle to filter by review status
- Inspect each Draft test — approve to promote it to Regression Suite, or reject to discard it
- Use **Approve All** / **Reject All** for bulk actions, or select individual tests

### 5. Edit Tests

- Open any test and click **Edit Test** to modify the name, description, steps, and priority
- Add, remove, or reorder steps inline
- On save, Playwright code is **automatically regenerated** from your updated steps via AI
- Export test data + run history as JSON from the test detail page

### 6. Run Regression

- Click **Run Regression** to execute all approved tests
- Tests run with **self-healing**: if a selector breaks, the runtime tries multiple fallback strategies (role, label, text, aria-label, title) and remembers which strategy won for future runs
- Watch live progress in the Run Detail view with per-step status
- Click any test case to drill into its **Step Results** — browser-chrome screenshot, network requests, console logs, and DOM snapshot
- After failures, an automatic **feedback loop** classifies each failure and auto-regenerates high-priority failing tests

### 7. Monitor

- The **Dashboard** shows aggregate pass rate, test counts, run history, and a first-time onboarding banner for new users
- The **Tests** page (`/tests`) provides a unified view of all tests across projects with sorting, pagination, bulk actions, and URL-synced filters
- The **Work** page lists all runs across all projects with search, status filters, and type filters
- The **Reports** page provides pass/fail trend charts, per-project breakdown, flaky test detection, and top failures with CSV export
- The **Projects** page shows per-project health at a glance with pass rate bars and test counts
- The **Context** page displays AI provider status and per-application environment details

---

## AI Providers

Sentri supports four AI providers for test generation. Auto-detection picks the first key that is set; you can force a specific provider with `AI_PROVIDER`.

| Provider | `AI_PROVIDER` value | Env Variable | Model |
|---|---|---|---|
| Anthropic Claude | `anthropic` | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 |
| OpenAI | `openai` | `OPENAI_API_KEY` | gpt-4o-mini |
| Google Gemini | `google` | `GOOGLE_API_KEY` | gemini-2.5-flash |
| Ollama (Local) | `ollama` | `OLLAMA_ENABLED=1` | Configurable (default: `llama3.1`) |

**Auto-detection priority:** Anthropic → OpenAI → Google → Ollama (first key/config present wins).

You can also set or change keys at runtime from the **Settings** page without restarting the server.

### Ollama Setup

[Ollama](https://ollama.com) lets you run AI models locally — completely free and private.

1. Install Ollama from [ollama.com](https://ollama.com)
2. Pull a model: `ollama pull llama3.1`
3. Enable in Sentri via **Settings** UI or set `OLLAMA_ENABLED=1` in `backend/.env`
4. Optionally configure `OLLAMA_BASE_URL` and `OLLAMA_MODEL` (defaults: `http://localhost:11434` and `llama3.1`)

Ollama must be running on the same machine as the Sentri backend.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AI_PROVIDER` | No | auto-detect | Force a specific provider: `anthropic`, `openai`, `google`, or `ollama` |
| `ANTHROPIC_API_KEY` | If using Anthropic | — | Get from [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | If using OpenAI | — | Get from [platform.openai.com](https://platform.openai.com/api-keys) |
| `GOOGLE_API_KEY` | If using Google | — | Get from [aistudio.google.com](https://aistudio.google.com/apikey) |
| `OLLAMA_ENABLED` | If using Ollama | — | Set to `1` to enable local Ollama models |
| `OLLAMA_BASE_URL` | No | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | No | `llama3.1` | Ollama model to use for generation |
| `PORT` | No | `3001` | Backend server port |

See [`backend/.env.example`](backend/.env.example) for the full template.

---

## Project Structure

```
sentri/
├── backend/
│   ├── src/
│   │   ├── index.js              # Express API server & all routes + activity logging
│   │   ├── aiProvider.js         # Multi-AI provider abstraction + retry + circuit breaker
│   │   ├── crawler.js            # 8-layer pipeline: crawl → filter → classify → generate → dedup → enhance → validate → store
│   │   ├── selfHealing.js        # Self-healing runtime: multi-strategy element finding, healing history, transform engine
│   │   ├── testRunner.js         # Playwright test executor with self-healing integration + feedback loop
│   │   ├── db.js                 # In-memory store with activities + healing history (swap for Postgres in production)
│   │   └── pipeline/
│   │       ├── smartCrawl.js     # Page discovery and snapshotting
│   │       ├── elementFilter.js  # Noise reduction on crawled elements
│   │       ├── intentClassifier.js  # Page intent classification with AI-assisted fallback
│   │       ├── journeyGenerator.js  # Two-phase PLAN → GENERATE test generation
│   │       ├── deduplicator.js   # Removes duplicate generated tests
│   │       ├── assertionEnhancer.js # Strengthens Playwright assertions
│   │       └── feedbackLoop.js   # Auto-regeneration of failing tests
│   ├── .env.example
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx               # Router setup + ErrorBoundary + 404 page
│   │   ├── api.js                # API client (fetch wrapper with AbortController timeouts)
│   │   ├── index.css             # Design system (CSS variables, components, dark mode)
│   │   ├── hooks/
│   │   │   └── useProjectData.js # Shared hook: fetches projects + tests + runs with 30s TTL cache
│   │   ├── utils/
│   │   │   └── formatters.js     # Shared date/time/duration formatters
│   │   ├── components/
│   │   │   ├── Layout.jsx        # Sidebar navigation shell
│   │   │   ├── CrawlView.jsx     # Live crawl pipeline progress (authoritative step tracking)
│   │   │   ├── GenerateView.jsx  # Compact pipeline progress for CreateTestModal
│   │   │   ├── TestRunView.jsx   # Test suite list → case preview
│   │   │   ├── StepResultsView.jsx  # Per-test-case step drill-down + browser view
│   │   │   ├── ProviderBadge.jsx # Active AI provider indicator
│   │   │   ├── StatCard.jsx      # Reusable stat card component
│   │   │   ├── StatusBadge.jsx   # Consistent status badge (completed/failed/running)
│   │   │   ├── PassFailChart.jsx # Recharts area chart for pass/fail trends
│   │   │   └── PassRateBar.jsx   # Horizontal pass-rate bar with percentage
│   │   └── pages/
│   │       ├── Dashboard.jsx     # Pass rate, metrics, recent runs
│   │       ├── Projects.jsx      # Test library + multi-phase Create Test wizard
│   │       ├── ProjectDetail.jsx # Draft/Regression/Runs tabs per project
│   │       ├── NewProject.jsx    # Project creation form
│   │       ├── TestDetail.jsx    # Individual test view + inline editing + export
│   │       ├── RunDetail.jsx     # Run detail orchestrator (crawl or test run)
│   │       ├── Work.jsx          # All runs with search, status & type filters
│   │       ├── Reports.jsx       # Analytics: trends, flaky tests, top failures, CSV export
│   │       ├── Applications.jsx  # Per-project health overview with pass rate bars
│   │       ├── Context.jsx       # AI provider status + per-app environment details
│   │       └── Settings.jsx      # AI keys, test execution config, data management, system info
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
├── docker-compose.yml
├── docker-compose.prod.yml
└── README.md
```

---

## API Reference

### Projects

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/projects` | Create a new project |
| `GET` | `/api/projects` | List all projects |
| `GET` | `/api/projects/:id` | Get a single project |

### Crawl & Run

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/projects/:id/crawl` | Start crawl + AI test generation |
| `POST` | `/api/projects/:id/run` | Execute all approved tests (regression run) |

### Tests

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/projects/:id/tests` | List all tests for a project |
| `GET` | `/api/tests/:testId` | Get a single test |
| `POST` | `/api/projects/:id/tests` | Create a manual test (saved as Draft) |
| `POST` | `/api/projects/:id/tests/generate` | **AI-generate** steps + Playwright script from title & description (saved as Draft) |
| `PATCH` | `/api/tests/:testId` | Update test steps, name, description, priority; optionally regenerate Playwright code |
| `DELETE` | `/api/projects/:id/tests/:testId` | Delete a test |
| `POST` | `/api/tests/:testId/run` | Run a single test |

### Test Review

| Method | Endpoint | Description |
|---|---|---|
| `PATCH` | `/api/projects/:id/tests/:testId/approve` | Promote Draft → Regression Suite |
| `PATCH` | `/api/projects/:id/tests/:testId/reject` | Mark as Rejected |
| `PATCH` | `/api/projects/:id/tests/:testId/restore` | Restore any test back to Draft |
| `POST` | `/api/projects/:id/tests/bulk` | Bulk approve / reject / restore (`{ testIds[], action }`) |

### Runs

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/projects/:id/runs` | List all runs for a project |
| `GET` | `/api/runs/:runId` | Get run detail (live-pollable while running) |

### Config & Settings

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/config` | Active AI provider info (name, model, color) |
| `GET` | `/api/settings` | Masked API key status per provider |
| `POST` | `/api/settings` | Set an API key at runtime (`{ provider, apiKey }`) |
| `DELETE` | `/api/settings/:provider` | Remove a provider key |
| `GET` | `/api/dashboard` | Summary stats (projects, tests, pass rate, recent runs) |

### Activities & System

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/activities` | Activity log (filterable by `?type=`, `?projectId=`, `?limit=`) |
| `GET` | `/api/system` | System info: uptime, Node/Playwright versions, heap memory, DB counts |
| `DELETE` | `/api/data/runs` | Clear all run history (keeps projects & tests) |
| `DELETE` | `/api/data/activities` | Clear activity log |
| `DELETE` | `/api/data/healing` | Clear self-healing history |

---

## Test Lifecycle

All tests — whether crawled automatically or created manually — follow the same lifecycle:

```
Created (AI crawl or manual)
        │
        ▼
    [ Draft ]  ← default state for every new test
        │
   ┌────┴────┐
   ▼         ▼
[Approved] [Rejected]
   │
   ▼
[Regression Suite]  ← only approved tests run here
   │
   ▼
[Run Results]  → passed / failed
```

- **Draft** — visible in the *Generated Tests* review tab; cannot be executed in regression
- **Approved** — promoted to the Regression Suite; included in every `Run Regression` execution
- **Rejected** — excluded from all runs; can be restored to Draft at any time
- Any test can be restored back to Draft using the Restore button or bulk action

---

## Self-Healing Test Runtime

Every test runs with an adaptive self-healing layer that makes tests resilient to UI changes:

1. **Multi-strategy element finding** — each `safeClick`, `safeFill`, and `safeExpect` call tries multiple selector strategies in a waterfall (role → label → text → aria-label → title)
2. **Healing history** — when a fallback strategy succeeds, the runtime records which strategy index won for that element. Future runs try the winning strategy first, reducing flakiness over time
3. **Transform engine** — AI-generated Playwright code is automatically rewritten at runtime to use self-healing helpers via regex-based transforms (e.g. `page.click('Sign in')` → `safeClick(page, 'Sign in')`)
4. **Feedback loop** — after test failures, the system classifies each failure (selector issue, navigation fail, etc.) and auto-regenerates high-priority failing tests via AI

### Runtime Defaults

| Setting | Value | Description |
|---|---|---|
| Element Timeout | 5000 ms | Max wait per element strategy in the waterfall |
| Retry Count | 3 | Retries per interaction (`safeClick` / `safeFill`) |
| Retry Delay | 400 ms | Pause between retries |
| Browser Mode | Headless | Chromium runs without a visible window |
| Viewport | 1280 × 720 | Default browser viewport size |

These values are compiled into the self-healing runtime. To customise, edit `backend/src/selfHealing.js`.

---

## Production Upgrades

Sentri is designed to grow. Recommended enhancements for production scale:

| Area | Recommendation |
|---|---|
| **Database** | Replace in-memory `db.js` with PostgreSQL + Prisma ORM |
| **Job Queue** | Add BullMQ + Redis for background crawl/run jobs with retries |
| **Auth** | Add user authentication (NextAuth, Clerk, or JWT middleware) |
| **File Storage** | Store videos and screenshots to S3/R2 instead of local disk |
| **Scheduling** | Add cron-based auto-runs via `node-cron` or a job scheduler |
| **Notifications** | Send Slack/email alerts on test failures |
| **Multi-tenancy** | Add workspace/organisation scoping to projects and tests |
| **CI/CD Integration** | Expose a run trigger webhook for GitHub Actions / GitLab CI |

---

## Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit your changes: `git commit -m 'Add my feature'`
4. Push to the branch: `git push origin feature/my-feature`
5. Open a Pull Request against `main`

---

## License

MIT — see [LICENSE](LICENSE) for details.
