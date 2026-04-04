# 🐻 Sentri — Autonomous QA Platform

> Stop writing tests manually. Point Sentri at your web app and it crawls, generates, and runs Playwright tests — all driven by AI.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.58+-blue.svg)](https://playwright.dev)

---

## What Sentri Does For You

Writing end-to-end tests is slow, brittle, and nobody's favourite job. Selectors break, tests rot, and the suite falls behind the product. Sentri fixes this by doing the work for you:

**You give it a URL. It gives you a working test suite.**

Sentri crawls your app, understands what each page does, generates meaningful Playwright tests, and runs them — with video, screenshots, and live streaming results. When tests break because the UI changed, it heals itself and tells you what happened.

---

## How It Works

### 1. Crawl your app automatically
Sentri launches a real browser and explores your app up to 3 levels deep — following links, mapping forms, buttons, and interactive elements. You watch it happen live on a **Site Graph** that shows discovered pages in real time. At any point you can click **Stop** to cancel.

If your app requires login, configure your credentials once and Sentri handles authentication before crawling.

### 2. AI generates your test suite
Every page snapshot is sent through an 8-step AI pipeline:

- **Classify** — understands what the page is for (checkout, auth, search, etc.)
- **Generate** — writes focused Playwright tests for that page's purpose
- **Deduplicate** — removes redundant tests across the batch
- **Enhance** — strengthens assertions for better coverage
- **Validate** — rejects malformed or placeholder output before anything is saved

All tests land in a **Draft** queue. Nothing runs until you say so.

You choose which AI does the work: **Anthropic Claude**, **Google Gemini**, **OpenAI GPT-4o-mini**, or **Ollama** for completely free, private, local inference — no API key needed.

### 3. Describe a test in plain English
Don't want to crawl? Open **Create Tests**, write a plain-English scenario like *"User searches for a product and adds it to the cart"*, and Sentri generates the steps and Playwright code. Watch the AI output appear token by token.

### 4. Review before anything runs
Every generated test starts as **Draft**. You approve or reject them one by one — or use **Approve All** for bulk actions. Keyboard shortcuts (`a` approve, `r` reject) speed up the review queue. Only approved tests ever run in regression.

You can also edit any test: change the name, reorder steps, adjust the description. On save, Sentri regenerates the Playwright code from your updated steps and shows you a **line-by-line diff** of what changed.

### 5. Run regression with one click
Click **Run Regression** and Sentri executes every approved test. While it runs you get:

- **Live browser view** — a real-time screencast of what the browser is doing
- **Live log stream** — every step result as it happens, no page refresh needed
- **Execution timeline** — a Gantt chart showing each test's start time and duration
- **Per-test drill-down** — screenshots with bounding-box highlights, network requests, and console logs for every test case

Click **Stop Task** at any time to abort — all browser operations and AI calls halt immediately.

### 6. Self-healing when selectors break
Tests break when UIs change. Sentri handles this automatically:

When a selector fails, the runtime tries multiple fallback strategies — by role, label, text, aria-label, title — in sequence. When a fallback wins, Sentri **remembers it** and tries that strategy first on the next run. Over time, tests become more resilient automatically.

After failures, an AI **feedback loop** classifies each failure (selector issue, timeout, assertion, navigation) and auto-regenerates the highest-priority failing tests.

### 7. Monitor everything
- **Dashboard** — pass rate, defect category breakdown, flaky test detection, run history, and self-healing stats
- **Reports** — pass/fail trend charts, per-project breakdown, and CSV export
- **Activity Log** — a full timeline of every crawl, run, approval, edit, and abort
- **Browser notifications** — optional desktop alerts when a run completes

---

## Quick Start

### Prerequisites

- Node.js 20+
- An API key for at least one AI provider — **or** a local [Ollama](https://ollama.com) installation (free, no key needed)
- Docker & Docker Compose (optional, for containerised deployment)

---

### Option A: Docker (Recommended)

```bash
git clone https://github.com/RameshBabuPrudhvi/sentri.git
cd sentri

cp backend/.env.example backend/.env
# Edit backend/.env — add at least one AI provider key

docker compose up --build
```

Open [http://localhost:80](http://localhost:80)

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

## AI Providers

Sentri auto-detects your provider from whichever key is set. You can switch at any time from the Settings page — no restart needed.

| Provider | Env Variable | Model |
|---|---|---|
| Anthropic Claude | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 |
| OpenAI | `OPENAI_API_KEY` | gpt-4o-mini |
| Google Gemini | `GOOGLE_API_KEY` | gemini-2.5-flash |
| Ollama (local, free) | `AI_PROVIDER=local` | llama3.2 (configurable) |

**Auto-detection order:** Anthropic → OpenAI → Google → Ollama

### Using Ollama (free local AI)

1. Install from [ollama.com](https://ollama.com)
2. Pull a model: `ollama pull llama3.2`
3. In Sentri Settings, select Ollama — or set `AI_PROVIDER=local` in `backend/.env`

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | auto-detect | Force a provider: `anthropic`, `openai`, `google`, or `local` |
| `ANTHROPIC_API_KEY` | — | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | — | [platform.openai.com](https://platform.openai.com/api-keys) |
| `GOOGLE_API_KEY` | — | [aistudio.google.com](https://aistudio.google.com/apikey) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Model name for local inference |
| `OLLAMA_TIMEOUT_MS` | `120000` | Timeout (ms) for Ollama calls — increase for slow machines |
| `PORT` | `3001` | Backend server port |

See [`backend/.env.example`](backend/.env.example) for the full template.

---

## Test Lifecycle

Every test — whether crawled automatically or written from a description — follows the same path:

```
Created (crawl or manual description)
        │
        ▼
    [ Draft ]  ← review required before anything runs
        │
   ┌────┴────┐
   ▼         ▼
[Approved] [Rejected]
   │
   ▼
[Regression Suite]  ← included in every Run Regression
   │
   ▼
[Run Results]  → passed / failed / healed
```

Any test can be restored to Draft at any time via the Restore button or bulk action.

---

## API Reference

### Projects

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/projects` | Create a project |
| `GET` | `/api/projects` | List all projects |
| `GET` | `/api/projects/:id` | Get a project |
| `DELETE` | `/api/projects/:id` | Delete project and all its tests, runs, and history |

### Crawl & Run

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/projects/:id/crawl` | Start crawl + AI test generation |
| `POST` | `/api/projects/:id/run` | Execute all approved tests |

### Tests

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/projects/:id/tests` | List tests for a project |
| `POST` | `/api/projects/:id/tests` | Create a manual test (saved as Draft) |
| `POST` | `/api/projects/:id/tests/generate` | Generate test from plain-English description |
| `PATCH` | `/api/tests/:testId` | Edit test steps, name, description, priority |
| `DELETE` | `/api/projects/:id/tests/:testId` | Delete a test |
| `POST` | `/api/tests/:testId/run` | Run a single test |

### Test Review

| Method | Endpoint | Description |
|---|---|---|
| `PATCH` | `/api/projects/:id/tests/:testId/approve` | Promote Draft → Regression Suite |
| `PATCH` | `/api/projects/:id/tests/:testId/reject` | Reject a test |
| `PATCH` | `/api/projects/:id/tests/:testId/restore` | Restore to Draft |
| `POST` | `/api/projects/:id/tests/bulk` | Bulk approve / reject / restore / delete |

### Runs

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/projects/:id/runs` | List runs for a project |
| `GET` | `/api/runs/:runId` | Get run detail |
| `GET` | `/api/runs/:runId/events` | SSE stream — live log, result, frame, and done events |
| `POST` | `/api/runs/:runId/abort` | Abort a running crawl or test run |

### Settings & System

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/settings` | AI provider key status |
| `POST` | `/api/settings` | Set an API key at runtime |
| `GET` | `/api/dashboard` | Analytics: pass rate, defects, flaky tests, MTTR |
| `GET` | `/api/activities` | Activity log (filterable by type, project, limit) |
| `GET` | `/health` | Health check |

---

## Contributing

Pull requests are welcome. For major changes, open an issue first.

1. Fork the repo
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Commit: `git commit -m 'Add my feature'`
4. Push: `git push origin feature/my-feature`
5. Open a Pull Request against `main`

---

## License

MIT — see [LICENSE](LICENSE) for details.
