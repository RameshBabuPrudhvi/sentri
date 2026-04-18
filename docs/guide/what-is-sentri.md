# What is Sentri?

Sentri is an **autonomous QA platform** that crawls your web app, generates Playwright test suites using AI, and self-heals them when your UI changes.

## The Problem

| Problem | How Sentri solves it |
|---|---|
| Writing E2E tests is slow | Point it at a URL — tests are generated in minutes, not days |
| Selectors break every sprint | Self-healing runtime tries multiple strategies, **remembers** what worked |
| AI-generated tests are untrustworthy | Every test lands in a **Draft** queue. Nothing executes until a human approves |
| You can't see what the test is doing | Live browser screencast, real-time log stream, per-step screenshots |
| Tests fail and nobody knows why | AI classifies every failure and auto-regenerates the worst offenders |
| Vendor lock-in on AI providers | Swap between Anthropic, OpenAI, Google, or Ollama with one setting |

## How It Works

### 1. Crawl
Sentri launches a real Chromium browser and explores your app — following links, mapping forms, buttons, and interactive elements. A D3 force-directed Site Graph shows discovered pages in real time. While crawling, Sentri **captures every API call** (fetch/XHR) your app makes — building a map of backend endpoints automatically.

### 2. Generate
Each page goes through an 8-stage AI pipeline: crawl → filter → classify → plan → generate → deduplicate → enhance → validate. All tests land in a Draft queue.

In addition to UI tests, Sentri generates **API contract tests** in two ways:
- **Automatic:** During crawl, HAR capture records every fetch/XHR call and feeds endpoints to the AI
- **From description:** In the Generate Test modal, describe your API endpoints in plain English (e.g. `write API tests for https://reqres.in/api/register`), paste `GET /api/users` patterns with request/response examples, or attach an OpenAPI spec as a `.json` file

API tests use Playwright's `request` API context to call endpoints directly — no browser needed. See the [API Testing guide](/guide/api-testing) for example prompts and OpenAPI spec support.

### 3. Review
Approve or reject tests one by one or in bulk. Only approved tests execute in regression.

### 4. Execute
One-click regression with live browser view (CDP screencast), SSE log stream, execution timeline, and per-step screenshots with bounding-box overlays. Run up to **10 tests in parallel** — each in its own isolated browser context with independent video, screenshots, and network logs. Select ⚡ 4x from the project action bar or set `PARALLEL_WORKERS=4` in your `.env`.

### 5. Self-Heal
When a selector fails, the self-healing layer tries fallback strategies in a waterfall. When a fallback wins, it records which strategy succeeded — and tries it first next time.

### 6. Monitor
Dashboard with pass rate, defect categories, flaky test detection, test growth sparkline, and self-healing stats.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Frontend (React + Vite)                    │
│  ├── Pages: Dashboard, Projects, Tests, ... │
│  ├── SSE: real-time run events              │
│  └── CDP: live browser screencast           │
├─────────────────────────────────────────────┤
│  Backend (Express + Node.js)                │
│  ├── Routes: /api/v1/projects, /tests, /runs │
│  ├── Crawler: Playwright + SmartCrawlQueue  │
│  ├── HAR Capture: API traffic → endpoints   │
│  ├── AI Pipeline: 8-stage generation        │
│  ├── Self-Healing: multi-strategy waterfall │
│  ├── DB: SQLite (default) or PostgreSQL     │
│  └── Redis (optional): rate limits, SSE     │
├─────────────────────────────────────────────┤
│  AI Providers                               │
│  ├── Anthropic Claude                       │
│  ├── OpenAI GPT-4o-mini                     │
│  ├── Google Gemini                          │
│  └── Ollama (local, free)                   │
└─────────────────────────────────────────────┘
```
