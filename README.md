# 🐻 Sentri — Your AI QA Engineer
> Give it a URL. Get a working Playwright test suite. Watch it heal itself when your UI changes.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.58+-blue.svg)](https://playwright.dev)

📖 **[Documentation](https://rameshbabuprudhvi.github.io/sentri/docs/)** · 🔧 **[API Reference](https://rameshbabuprudhvi.github.io/sentri/docs/api/)** · 📘 **[Code Docs (JSDoc)](https://rameshbabuprudhvi.github.io/sentri/docs/jsdoc/)**

---

## Why Sentri?

There are plenty of "AI test generator" repos. Most generate code and leave you to figure out the rest. Sentri is different — it's the **full lifecycle**: crawl → generate → review → execute → heal → report, in one tool.

| Problem | How Sentri solves it |
|---|---|
| Writing E2E tests is slow | Point it at a URL — tests are generated in minutes, not days |
| Selectors break every sprint | Self-healing runtime tries role → label → text → aria-label → title, **remembers** what worked, and tries that first next time |
| AI-generated tests are untrustworthy | Every test lands in a **Draft** queue. Nothing executes until a human approves it |
| You can't see what the test is doing | Live browser screencast, real-time SSE log stream, per-step screenshots with bounding-box overlays |
| Tests fail and nobody knows why | AI feedback loop classifies every failure (selector / timeout / assertion / navigation) and auto-regenerates the worst offenders |
| Vendor lock-in on AI providers | Swap between Anthropic, OpenAI, Google, or **Ollama (free, local, private)** with one setting — no code changes |
| Generated tests are shallow | 8-stage pipeline: classify page intent → plan → generate → deduplicate → enhance assertions → validate — not just "write a test for this HTML" |

---

## How It Works

### 1. Crawl — discover your app automatically
Sentri launches a real Chromium browser and explores your app up to 3 levels deep — following links, mapping forms, buttons, and interactive elements. A **D3 force-directed Site Graph** shows discovered pages in real time with colour-coded status (crawled / has tests / error / active). Click **Stop** to cancel at any point.

If your app requires login, configure credentials once — Sentri authenticates before crawling. A **SmartCrawlQueue** fingerprints page structure so it skips near-duplicate pages (e.g. `/products/1` vs `/products/2`) instead of wasting AI calls.

### 2. Generate — an 8-stage AI pipeline, not just "write a test"
Each page snapshot goes through a structured pipeline — not a single prompt:

1. **Crawl** — visit pages, capture DOM snapshots (forms, semantic sections, heading hierarchy)
2. **Filter** — remove noise from interactive elements
3. **Classify** — identify page intent (AUTH, CHECKOUT, SEARCH, CRUD, NAVIGATION, CONTENT) using weighted heuristic scoring with AI fallback for ambiguous pages
4. **Plan** — two-phase PLAN → GENERATE split avoids token truncation on large pages
5. **Generate** — writes focused Playwright tests per page's intent, not generic "click everything" tests
6. **Deduplicate** — removes redundant tests across the batch and existing project tests
7. **Enhance** — strengthens assertions for better coverage
8. **Validate** — rejects malformed or placeholder output before anything is saved

All tests land in a **Draft** queue. Nothing runs until you approve.

**Test Dials** let you configure generation: pick a strategy (happy path, edge cases, comprehensive, exploratory, regression), workflow perspective (E2E, component isolation, multi-role persona, first-time user, interruptions), quality checks (accessibility, security, performance, data integrity), output format (verbose, concise, Gherkin), test count, and language. Presets like "Smoke Test" and "BDD Blueprint" auto-fill multiple dials. Config is validated server-side to prevent prompt injection.

You choose which AI does the work: **Anthropic Claude**, **Google Gemini**, **OpenAI GPT-4o-mini**, or **Ollama** for completely free, private, local inference — no API key needed. Switch providers at any time from the Settings page without restarting.

### 3. Describe — or skip crawling entirely
Open **Create Tests**, write a plain-English scenario like *"User searches for a product and adds it to the cart"*, and Sentri generates the steps and Playwright code. Watch the AI output arrive token by token via **LLM token streaming**.

### 4. Review — human-in-the-loop before anything runs
Every generated test starts as **Draft**. Approve or reject one by one, or use **Approve All** for bulk actions. Keyboard shortcuts (`a` approve, `r` reject, `/` search, `Esc` clear) speed up the review queue. Only approved tests ever execute in regression.

Edit any test inline: change the name, reorder steps, adjust the description. On save, Sentri regenerates Playwright code from your updated steps and shows a **Myers line-by-line diff** of what changed.

### 5. Execute — one-click regression with full observability
Click **Run Regression** and Sentri executes every approved test. While it runs you get:

- **Live browser view** — CDP screencast frames rendered on a `<canvas>` at ~7 FPS with a LIVE badge
- **Live log stream** — SSE pushes every step result to the browser, no polling. Reconnects with exponential backoff; falls back to polling after 5 consecutive failures
- **Execution timeline** — a Gantt chart showing each test's start time and duration
- **Per-test drill-down** — screenshots with **OverlayCanvas** bounding-box highlights, network requests, console logs, and DOM snapshots
- **Healing Timeline** — visualises which selector strategies were tried and which one won

Click **Stop Task** to abort — `AbortSignal` is threaded through the entire pipeline so AI calls, browser operations, and feedback loops halt immediately.

### 6. Self-heal — tests that fix themselves
When a selector fails at runtime, the self-healing layer tries multiple fallback strategies in a waterfall:

```
getByRole('button', { name }) → getByRole('link', { name }) → getByText(exact)
→ getByText(partial) → locator([aria-label]) → locator([title])
```

When a fallback wins, Sentri **records which strategy index succeeded** for that element. On the next run, it tries the winner first — skipping strategies that previously failed. Over time, tests become more resilient automatically.

After failures, an AI **feedback loop** classifies each failure (SELECTOR_ISSUE, TIMEOUT, ASSERTION_FAIL, NAVIGATION_FAIL) and auto-regenerates the highest-priority failing tests with context-aware fix instructions.

### 7. Monitor — dashboard, reports, activity log
- **Dashboard** — pass rate, defect category breakdown (selector / navigation / timeout / assertion), flaky test detection, test growth sparkline, MTTR, run status distribution, test review pipeline, and self-healing stats
- **Reports** — pass/fail trend charts, per-project breakdown, top failures, and CSV export
- **Activity Log** — full timeline of every crawl, run, approval, edit, and abort
- **Browser notifications** — optional desktop alerts when a run completes, with favicon badge (⏳/✅/❌) while running

---

## Key Features

| Feature | What it actually does |
|---|---|
| 🧬 **Adaptive Self-Healing** | Not just "retry with a different selector" — records which strategy won per element and tries it first next run. Tests get more resilient over time |
| 🎛️ **Test Dials** | 6 strategies × 5 workflows × 8 quality checks × 3 formats × 8 languages. Presets auto-fill. Config validated server-side to block prompt injection |
| 🔄 **Two-Phase AI Pipeline** | PLAN → GENERATE split avoids token truncation. Intent classification (AUTH/CHECKOUT/SEARCH/CRUD/NAVIGATION/CONTENT) focuses each prompt |
| 📡 **Real-Time SSE** | No polling. Server-Sent Events push log, result, frame, and LLM token events to the browser with auto-reconnect and exponential backoff |
| 🖥️ **Live Browser View** | CDP screencast at ~7 FPS rendered on a `<canvas>` — watch the browser do what your test does |
| 🧠 **LLM Token Streaming** | Watch AI output arrive token-by-token in a collapsible panel with raw/JSON preview modes |
| 🗺️ **Site Graph** | D3 force-directed graph of crawled pages with live node status, edge inference, and colour-coded state |
| 🆔 **Human-Readable IDs** | `TC-1`, `RUN-2`, `PRJ-3` — not UUIDs. Counters persist in DB and rehydrate on startup |
| ⛔ **Abort Everything** | `AbortSignal` threaded through the entire pipeline — AI calls, browser ops, and feedback loops halt immediately |
| 🔀 **Code Diff View** | Built-in Myers line diff shows what changed when Playwright code is regenerated |
| 📦 **Smart Data Fetching** | `useProjectData` hook with 30s TTL cache + batch `/api/tests` endpoint eliminates N+1 fetches |
| 🦙 **Ollama Support** | Completely free, private, local inference. NDJSON response fallback, `OLLAMA_MAX_PREDICT` token cap, HTTP 500 retry |
| 🔐 **Built-in Auth** | Email/password + GitHub/Google OAuth. Scrypt hashing, JWT with HS256, rate limiting, CSRF protection |
| 📖 **Full Documentation** | VitePress guide, REST API reference, and auto-generated JSDoc — all deployed to GitHub Pages |
| 🌙 **Dark Mode** | Automatic via `prefers-color-scheme` — all UI components adapt |
| 🐳 **Docker Ready** | `docker compose up --build` and you're running. GitHub Pages + Render deployment supported |

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

## Authentication

Sentri includes built-in authentication with email/password sign-in and OAuth (GitHub, Google).

- **Passwords** hashed with scrypt (64-byte key, 16-byte random salt)
- **JWTs** signed with HS256, 8-hour expiry
- **Rate limiting** — 10 sign-in attempts per IP per 15 minutes
- **OAuth CSRF** — state parameter validated on the frontend
- **Production** — server refuses to start without `JWT_SECRET` when `NODE_ENV=production`

---

## Environment Variables

### Backend

| Variable | Default | Description |
|---|---|---|
| `AI_PROVIDER` | auto-detect | Force a provider: `anthropic`, `openai`, `google`, or `local` |
| `ANTHROPIC_API_KEY` | — | [console.anthropic.com](https://console.anthropic.com) |
| `OPENAI_API_KEY` | — | [platform.openai.com](https://platform.openai.com/api-keys) |
| `GOOGLE_API_KEY` | — | [aistudio.google.com](https://aistudio.google.com/apikey) |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama server URL |
| `OLLAMA_MODEL` | `llama3.2` | Model name for local inference |
| `OLLAMA_MAX_PREDICT` | `4096` | Max token output cap for Ollama |
| `OLLAMA_TIMEOUT_MS` | `120000` | Timeout (ms) for Ollama calls |
| `JWT_SECRET` | random (dev) | **Required in production.** 32+ char secret for signing JWTs |
| `NODE_ENV` | — | Set to `production` for production deployments |
| `PORT` | `3001` | Backend server port |
| `LOG_LEVEL` | `info` | Minimum severity: `debug`, `info`, `warn`, or `error` |
| `LOG_DATE_FORMAT` | `iso` | Timestamp format: `iso`, `utc`, `local`, or `epoch` |
| `LOG_TIMEZONE` | system | IANA timezone for `local` format (e.g. `America/New_York`) |
| `LOG_JSON` | `false` | Emit structured JSON lines on stdout |

### Frontend (build-time)

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | `""` (same origin) | Backend URL for cross-origin deploys (e.g. GitHub Pages → Render) |
| `GITHUB_PAGES` | — | Set to `true` to use `/sentri/` base path |
| `VITE_GITHUB_CLIENT_ID` | — | GitHub OAuth client ID |
| `VITE_GOOGLE_CLIENT_ID` | — | Google OAuth client ID |

### OAuth (backend)

| Variable | Description |
|---|---|
| `GITHUB_CLIENT_ID` | GitHub OAuth app client ID |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth app client secret |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret |
| `GOOGLE_REDIRECT_URI` | Override Google OAuth redirect URI |

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
| `GET` | `/api/tests` | List all tests across all projects |
| `GET` | `/api/tests/:testId` | Get a single test |
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
| `GET` | `/api/config` | Active AI provider info (name, model, color) |
| `GET` | `/api/settings` | AI provider key status (masked) |
| `POST` | `/api/settings` | Set an API key at runtime |
| `DELETE` | `/api/settings/:provider` | Remove a provider key or deactivate Ollama |
| `GET` | `/api/ollama/status` | Check Ollama connectivity and list available models |
| `POST` | `/api/test-connection` | Verify a URL is reachable before creating a project |
| `GET` | `/api/dashboard` | Analytics: pass rate, defects, flaky tests, MTTR |
| `GET` | `/api/activities` | Activity log (filterable by type, project, limit) |
| `GET` | `/api/system` | System info: uptime, Node/Playwright versions, memory, DB counts |
| `GET` | `/health` | Health check |

### Authentication

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/register` | Register with email/password |
| `POST` | `/api/auth/login` | Sign in — returns JWT + user profile |
| `POST` | `/api/auth/logout` | Revoke token server-side |
| `GET` | `/api/auth/me` | Get current user profile |
| `GET` | `/api/auth/github/callback` | GitHub OAuth token exchange |
| `GET` | `/api/auth/google/callback` | Google OAuth token exchange |

### Data Management

| Method | Endpoint | Description |
|---|---|---|
| `DELETE` | `/api/data/runs` | Clear all run history (keeps projects and tests) |
| `DELETE` | `/api/data/activities` | Clear activity log |
| `DELETE` | `/api/data/healing` | Clear self-healing history |

> 📖 Full API documentation with request/response examples: **[API Reference](https://rameshbabuprudhvi.github.io/sentri/docs/api/)**

---

## Documentation

Sentri ships with three layers of documentation:

| Layer | URL | Source |
|---|---|---|
| **Guide & API Reference** | [/sentri/docs/](https://rameshbabuprudhvi.github.io/sentri/docs/) | VitePress — `docs/` directory |
| **Code Docs (JSDoc)** | [/sentri/docs/jsdoc/](https://rameshbabuprudhvi.github.io/sentri/docs/jsdoc/) | Auto-generated from source code |
| **README** | This file | `README.md` |

### Running docs locally

```bash
# VitePress guide
cd docs && npm install && npm run dev

# JSDoc code docs
cd backend && npm run docs && open docs-api/index.html
```

### Adding JSDoc to remaining files

A script is included to add `@module` headers to any files that don't have one yet:

```bash
bash scripts/add-jsdoc-modules.sh
```

The CI pipeline auto-generates JSDoc and deploys it alongside the VitePress site on every push to `main`.

---

## Deployment

### GitHub Pages + Render

Deploy the frontend to GitHub Pages (free) and the backend to Render (free tier available):

```bash
# Frontend build for GitHub Pages
cd frontend
GITHUB_PAGES=true VITE_API_URL=https://your-app.onrender.com npm run build
```

Set on Render: `NODE_ENV=production`, `JWT_SECRET=<openssl rand -base64 48>`, plus your AI provider key.

See the [full deployment guide](https://rameshbabuprudhvi.github.io/sentri/docs/guide/github-pages-render.html) for details.

---

## Production Checklist

| Area | Status |
|---|---|
| **Authentication** | ✅ Built-in (email/password + GitHub/Google OAuth) |
| **JWT Security** | ✅ Throws in production without `JWT_SECRET` |
| **Rate Limiting** | ✅ 10 sign-in attempts per IP per 15 min |
| **OAuth CSRF** | ✅ State parameter validated |
| **SPA Routing** | ✅ GitHub Pages `404.html` redirect |
| **Database** | ⬜ Replace in-memory `db.js` with PostgreSQL + Prisma ORM |
| **Job Queue** | ⬜ Add BullMQ + Redis for background crawl/run jobs |
| **File Storage** | ⬜ Store videos/screenshots to S3/R2 instead of local disk |
| **CORS** | ⬜ Restrict origins in `backend/src/middleware/appSetup.js` |
| **Token Storage** | ⬜ Move JWT from localStorage to HttpOnly cookies |
| **Scheduling** | ⬜ Add cron-based auto-runs via `node-cron` |
| **Notifications** | ⬜ Send Slack/email alerts on test failures |
| **Multi-tenancy** | ⬜ Add workspace/organisation scoping |
| **CI/CD Integration** | ⬜ Expose a run trigger webhook for GitHub Actions / GitLab CI |

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
