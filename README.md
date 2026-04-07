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
| Crawlers only see links, not flows | State Exploration mode clicks, fills, and submits — discovers auth flows, checkout funnels, and multi-step wizards that link crawlers miss |
| Generated tests are shallow | 8-stage pipeline: classify page intent → plan → generate → deduplicate → enhance assertions → validate — not just "write a test for this HTML" |
| No API coverage | **API test generation** — during crawl, Sentri captures every fetch/XHR call your app makes, deduplicates endpoints, and auto-generates Playwright `request` API contract tests alongside UI tests |
| Large test suites are slow | **Parallel execution** — run 1–10 tests simultaneously in isolated browser contexts. Select ⚡ 4x from the UI and a 40-test suite finishes in ¼ the time |

---

## How It Works

1. **Discover** — Two modes: **Link Crawl** follows `<a>` tags to map pages, or **State Exploration** executes real UI actions (click, fill, submit) to discover multi-step flows. Pick the mode from Test Dials before each crawl
2. **Generate** — 8-stage AI pipeline: discover → filter → classify → plan → generate (UI + API tests from captured traffic) → deduplicate → enhance → validate
3. **Describe** — or skip discovery — write a plain-English scenario and AI generates the test
4. **Review** — every test lands in Draft. Approve/reject with keyboard shortcuts before anything runs
5. **Execute** — one-click regression with live browser view, SSE log stream, and per-step screenshots. Run up to 10 tests in parallel for 5–10x faster suites
6. **Self-heal** — multi-strategy selector waterfall that remembers what worked per element
7. **Monitor** — dashboard with pass rate, defect breakdown, flaky detection, MTTR, and growth trends

> 📖 Detailed walkthrough of each stage: **[What is Sentri? →](https://rameshbabuprudhvi.github.io/sentri/docs/guide/what-is-sentri.html)**

---

## Key Features

| Feature | What it actually does |
|---|---|
| ⚡ **Parallel Execution** | Run 1–10 tests simultaneously in isolated browser contexts within a single Chromium instance. Select parallelism from the UI or set `PARALLEL_WORKERS` env var. Each worker gets its own video, screenshots, and network logs — full isolation, no shared state |
| 🌐 **API Test Generation** | During crawl, captures every same-origin fetch/XHR call, deduplicates by endpoint pattern (e.g. `/api/users/:id`), and generates Playwright `request` API tests that verify status codes, JSON response shapes, and error handling. Zero config — works automatically alongside UI test generation |
| 🧬 **Adaptive Self-Healing** | Not just "retry with a different selector" — records which strategy won per element and tries it first next run. Tests get more resilient over time |
| 🎛️ **Test Dials** | 6 strategies × 5 workflows × 8 quality checks × 3 formats × 8 languages × 2 explore modes. Presets auto-fill. Config validated server-side to block prompt injection |
| 🧭 **State Exploration** | Goes beyond link crawling — clicks buttons, fills forms, submits, and tracks state transitions to discover real multi-step user flows. Tunable per-run: max states, depth, actions per state, action timeout |
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
cp .env.example .env        # Optional — defaults work for local dev
npm run dev                 # Starts on :3000, proxies /api to :3001
```

Open [http://localhost:3000](http://localhost:3000)

---

## AI Providers

| Provider | Env Variable | Model |
|---|---|---|
| Anthropic Claude | `ANTHROPIC_API_KEY` | claude-sonnet-4-20250514 |
| OpenAI | `OPENAI_API_KEY` | gpt-4o-mini |
| Google Gemini | `GOOGLE_API_KEY` | gemini-2.5-flash |
| Ollama (local, free) | `AI_PROVIDER=local` | llama3.2 (configurable) |

Auto-detects in order: Anthropic → OpenAI → Google → Ollama. Switch at any time from the Settings page.

> 📖 Full provider setup guide including Ollama: **[AI Providers →](https://rameshbabuprudhvi.github.io/sentri/docs/guide/ai-providers.html)**

---

## Configuration

Key environment variables (see [`backend/.env.example`](backend/.env.example) and [`frontend/.env.example`](frontend/.env.example) for the full lists):

```bash
# AI provider (pick one)
ANTHROPIC_API_KEY=sk-ant-...       # or OPENAI_API_KEY, GOOGLE_API_KEY, AI_PROVIDER=local

# Auth (required in production)
JWT_SECRET=<openssl rand -base64 48>
NODE_ENV=production

# Parallel test execution (1 = sequential, max 10)
PARALLEL_WORKERS=4

# Frontend (build-time, for cross-origin deploys)
VITE_API_URL=https://your-backend.onrender.com
```

> 📖 Complete environment variable reference: **[Environment Variables →](https://rameshbabuprudhvi.github.io/sentri/docs/guide/env-vars.html)**

---

## API Reference

The backend exposes a RESTful JSON API on port `3001`. Key endpoint groups:

| Group | Endpoints | Description |
|---|---|---|
| **Projects** | `POST/GET/DELETE /api/projects` | CRUD for web applications |
| **Crawl & Run** | `POST /api/projects/:id/crawl`, `/run` | Start crawl or execute tests |
| **Tests** | `GET/POST/PATCH/DELETE /api/tests` | CRUD, generate, review, bulk actions, export |
| **Runs** | `GET /api/runs/:id`, `/events`, `POST /abort` | Results, SSE stream, abort |
| **Auth** | `POST /api/auth/register`, `/login`, `/logout` | Email/password + OAuth |
| **Settings** | `GET/POST/DELETE /api/settings` | AI provider config, Ollama status |
| **System** | `GET /api/dashboard`, `/system`, `/activities` | Analytics, info, data management |

> 📖 Full API documentation with request/response examples and code samples: **[API Reference →](https://rameshbabuprudhvi.github.io/sentri/docs/api/)**

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
| **Parallel Execution** | ✅ 1–10 concurrent browser contexts per run (`PARALLEL_WORKERS` env or UI selector) |
| **API Test Generation** | ✅ HAR capture during crawl → auto-generated Playwright `request` API contract tests |
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
