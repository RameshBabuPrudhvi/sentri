# 🐻 Sentri — Autonomous QA Platform

> AI-powered test generation and execution for modern web applications. Crawl your app, generate Playwright tests, and monitor quality — all on autopilot.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green.svg)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-1.50+-blue.svg)](https://playwright.dev)

---

## What is Sentri?

Sentri is an autonomous QA platform that removes the manual burden of writing and maintaining end-to-end tests. Point it at any web application, and it will:

1. **Crawl** your app — mapping pages, forms, buttons, and interactive elements up to 3 levels deep
2. **Generate** meaningful Playwright test cases using your choice of AI provider (Anthropic Claude, Google Gemini, or OpenAI GPT-4)
3. **Execute** those tests against your live app with one click
4. **Report** pass/fail results with live log streaming and trend charts

---

## Features

| Feature | Description |
|---|---|
| 🕷️ **Autonomous Crawler** | Explores your app up to 3 levels deep, mapping all pages and interactive elements |
| 🤖 **Multi-AI Test Generation** | Pluggable provider support — Anthropic Claude, Google Gemini, or OpenAI GPT-4 |
| ▶️ **One-Click Test Execution** | Run all generated tests against your live app instantly |
| 🔁 **Self-Healing Hints** | DOM snapshots captured to assist re-generation after app changes |
| 📊 **Live Dashboard** | Real-time pass/fail metrics, run history, and trend charts |
| 🔑 **Auth Support** | Login to your app before crawling using CSS selectors |
| 🐳 **Docker Ready** | Full Docker Compose setup for instant deployment |

---

## Quick Start

### Prerequisites

- Node.js 20+
- An API key for at least one supported AI provider (see [AI Providers](#ai-providers))
- Docker & Docker Compose (for containerized deployment)

---

### Option A: Docker (Recommended)

```bash
# 1. Clone the repo
git clone https://github.com/RameshBabuPrudhvi/sentri.git
cd sentri

# 2. Configure environment
cp .env.example .env
# Edit .env — set AI_PROVIDER and the corresponding API key

# 3. Build and start
docker compose up --build

# Frontend: http://localhost:80
# Backend API: http://localhost:3001
```

---

### Option B: Local Development

**Backend:**

```bash
cd backend
npm install
npx playwright install chromium
cp .env.example .env        # Set AI_PROVIDER and your API key
npm run dev                 # Starts on :3001
```

**Frontend:**

```bash
cd frontend
npm install
npm run dev                 # Starts on :3000, proxies API to :3001
```

Open [http://localhost:3000](http://localhost:3000)

---

## Usage

### 1. Create a Project

- Click **New Project**
- Enter your app name and URL (e.g. `https://myapp.com`)
- Optionally configure login credentials (CSS selectors for username/password fields)

### 2. Crawl & Generate Tests

- Click **Crawl & Generate Tests** on your project page
- Sentri will visit your app, follow internal links, snapshot each page, and send those snapshots to your chosen AI provider to generate 2–4 Playwright test cases per page

### 3. Run Tests

- Click **Run Tests** to execute all generated tests
- Watch live log streaming in the Run Detail view
- Review pass/fail results per test

### 4. Monitor

- The **Dashboard** shows aggregate pass rate, test counts, and run history trends

---

## AI Providers

Sentri supports multiple AI providers for test generation. Switch between them with a single environment variable — no code changes needed.

| Provider | `AI_PROVIDER` value | Required Key | Model Used |
|---|---|---|---|
| Anthropic Claude | `anthropic` | `ANTHROPIC_API_KEY` | claude-opus-4-6 |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | gemini-1.5-pro |
| OpenAI GPT-4 | `openai` | `OPENAI_API_KEY` | gpt-4o |

Set your provider in `.env`:

```env
AI_PROVIDER=anthropic   # or gemini, or openai
```

> **Note:** Only the API key for the selected provider needs to be set. The others can be left blank.

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `AI_PROVIDER` | No | `anthropic` | AI provider to use (`anthropic`, `gemini`, `openai`) |
| `ANTHROPIC_API_KEY` | If using Anthropic | — | Get from [console.anthropic.com](https://console.anthropic.com) |
| `GEMINI_API_KEY` | If using Gemini | — | Get from [aistudio.google.com](https://aistudio.google.com) |
| `OPENAI_API_KEY` | If using OpenAI | — | Get from [platform.openai.com](https://platform.openai.com) |
| `PORT` | No | `3001` | Backend server port |

See [`.env.example`](.env.example) for a full template.

---

## Project Structure

```
sentri/
├── backend/
│   ├── src/
│   │   ├── index.js          # Express API server
│   │   ├── aiProvider.js     # Multi-AI provider abstraction layer
│   │   ├── crawler.js        # Playwright crawler + AI test generator
│   │   ├── testRunner.js     # Playwright test executor
│   │   └── db.js             # In-memory store (swap for Postgres)
│   ├── Dockerfile
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── api.js            # API client
│   │   ├── index.css         # Design system
│   │   ├── components/
│   │   │   └── Layout.jsx    # Sidebar navigation
│   │   └── pages/
│   │       ├── Dashboard.jsx
│   │       ├── Projects.jsx
│   │       ├── ProjectDetail.jsx
│   │       ├── NewProject.jsx
│   │       └── RunDetail.jsx
│   ├── Dockerfile
│   ├── nginx.conf
│   └── package.json
├── docker-compose.yml
├── docker-compose.prod.yml
└── .env.example
```

---

## API Reference

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/projects` | Create a new project |
| `GET` | `/api/projects` | List all projects |
| `GET` | `/api/projects/:id` | Get a project |
| `POST` | `/api/projects/:id/crawl` | Start crawl + test generation |
| `POST` | `/api/projects/:id/run` | Execute all tests |
| `GET` | `/api/projects/:id/tests` | List generated tests |
| `DELETE` | `/api/projects/:id/tests/:testId` | Delete a test |
| `GET` | `/api/projects/:id/runs` | List runs |
| `GET` | `/api/runs/:runId` | Get run detail (with live logs) |
| `GET` | `/api/dashboard` | Summary stats |

---

## Production Upgrades

Sentri is production-ready out of the box, but here are recommended enhancements for scale:

| Area | Recommendation |
|---|---|
| **Database** | Replace in-memory `db.js` with PostgreSQL + Prisma |
| **Job Queue** | Add BullMQ + Redis for background crawl/run jobs |
| **Auth** | Add user authentication (NextAuth, Clerk, or JWT) |
| **Screenshots** | Store failure screenshots to S3/R2 |
| **Scheduling** | Add cron-based auto-runs via node-cron |
| **Notifications** | Send Slack/email alerts on failures |
| **Multi-tenant** | Add workspace/org scoping |

---

## Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes (`git commit -m 'Add my feature'`)
4. Push to the branch (`git push origin feature/my-feature`)
5. Open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE) for details.